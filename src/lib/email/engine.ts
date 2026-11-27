import { randomUUID } from "node:crypto";

import {
  getDb,
  queryMany,
  queryOne,
  withTransaction,
  type DbPool,
} from "../db/connection.ts";
import { extractEmailAddress } from "../services/email-addresses.ts";
import { type EmailAddresses } from "../services/email-addresses.ts";
import { ServiceConfigurationError } from "../services/service-config.ts";
import { type EmailTemplateKind } from "../types/domain.ts";
import { readEnv, type EnvSource } from "../utils/env.ts";
import {
  loadAccount,
  loadDefaultAccount,
  loadUsableAccount,
  getPreferredAccountId,
  openCredentials,
  recordAccountOutcome,
  type EmailAccountRecord,
} from "./accounts.ts";
import {
  createCaptureTransport,
  isCaptureEmailDriverAllowed,
} from "./capture.ts";
import { toTransportError } from "./classify.ts";
import { openJson, sealJson } from "./crypto.ts";
import { createGmailTransport } from "./gmail.ts";
import { createMicrosoftTransport } from "./microsoft.ts";
import { getAccessToken, type OAuthOptions } from "./oauth.ts";
import { getPreset, reconnectRecovery } from "./presets.ts";
import {
  getTemplateCopy,
  isEditableTemplateKind,
  renderSubject,
  renderTemplateHtml,
  renderTemplateText,
} from "./templates.ts";
import { createResendTransport } from "./resend.ts";
import {
  createSmtpTransport,
  parseSmtpUrl,
  type SmtpTransportOptions,
} from "./smtp.ts";
import {
  EmailTransportError,
  type EmailDeliveryResult,
  type EmailSendOptions,
  type EmailStream,
  type EmailTransport,
  type MailboxAddress,
  type OutgoingMessage,
  type TransactionalEmailMessage,
  type TransportProvider,
} from "./types.ts";

// The universal delivery engine. Every message PACTORA sends goes through
// deliver():
//
// 1. Its stream is fixed by its template: platform mail (verification,
//    password reset, invitations to the workspace) or agreement mail
//    (everything about an envelope).
// 2. A delivery row is claimed first. With an idempotency key, a message
//    already sent is never sent again, and one being sent right now by
//    another request is not sent twice.
// 3. The mailbox is chosen by explicit authorisation only: an account the
//    sender owns or that is shared with them, then the organisation's
//    default where the sender may use it, then the operator's environment
//    configuration, then the development outbox. A mailbox that needs
//    reconnecting is never silently swapped for another one.
// 4. The outcome is written down. A failure worth trying again is kept,
//    encrypted, and tried again with backoff by processDueDeliveries();
//    the caller is still told the message did not go out. Nothing failed
//    or unverified is ever reported as sent.

export const PLATFORM_TEMPLATES: ReadonlySet<EmailTemplateKind> = new Set([
  "account_closure_request",
  "change_email_confirmation",
  "contact_form",
  "email_verification",
  "password_reset",
  "signing_lock_alert",
  "workspace_invitation",
]);

/**
 * Messages tried again in the background when a first try fails for a
 * reason that may clear. Others are what someone is waiting for on screen
 * (a code, a password reset, a first invitation, fresh download links), or
 * carry a signing link their caller withdraws when the send fails (the
 * reminders), and their caller reports the failure at once instead.
 */
export const BACKGROUND_RETRY_TEMPLATES: ReadonlySet<EmailTemplateKind> =
  new Set([
    "account_closure_request",
    "completion_notification",
    "contact_form",
    "decline_notification",
    "deletion_notice",
    "expiry_notice",
    "renewal_reminder",
    "retention_notice",
    "signing_lock_alert",
    "void_notification",
    "workspace_invitation",
  ]);

/** Messages that carry a signing link: a newer one makes an older retry stale. */
const SIGNING_LINK_TEMPLATES = [
  "signing_invitation",
  "manual_nudge",
  "automatic_reminder",
] as const;

/** Seconds to wait before each further try. */
export const RETRY_DELAYS_SECONDS = [60, 5 * 60, 30 * 60, 2 * 3600, 6 * 3600];
export const MAX_ATTEMPTS = RETRY_DELAYS_SECONDS.length + 1;
/** How long a claimed delivery is held before another worker may take it. */
const CLAIM_SECONDS = 120;
/** A retry's stored message is kept only up to this size. */
const MAX_STORED_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export type DeliveryStatus =
  "sending" | "sent" | "failed" | "retrying" | "deferred" | "superseded";

export function streamFor(template: EmailTemplateKind): EmailStream {
  return PLATFORM_TEMPLATES.has(template) ? "platform" : "agreement";
}

export const EMAIL_NOT_CONNECTED_TEXT =
  "Email is not set up yet, so this message could not be sent. Connect a mailbox in Settings, Email & Integrations, or copy the signing link from the envelope.";

/**
 * No mailbox may carry this message. Kept a ServiceConfigurationError whose
 * message starts "email service " so every existing caller that already
 * recognises a missing email setup keeps doing so.
 */
export class EmailNotConnectedError extends ServiceConfigurationError {
  constructor() {
    super("email", ["a connected mailbox (Settings, Email & Integrations)"]);
    this.name = "EmailNotConnectedError";
  }
}

/** A failure whose message has been kept to be tried again automatically. */
export class EmailDeliveryQueuedError extends Error {
  readonly deliveryId: string;
  readonly nextAttemptAt: number;

  constructor(cause: string, deliveryId: string, nextAttemptAt: number) {
    super(`${cause} It will be tried again automatically.`);
    this.name = "EmailDeliveryQueuedError";
    this.deliveryId = deliveryId;
    this.nextAttemptAt = nextAttemptAt;
  }
}

export class EmailDeliveryInProgressError extends Error {
  constructor() {
    super("This message is already being sent.");
    this.name = "EmailDeliveryInProgressError";
  }
}

export type EngineOptions = {
  database?: DbPool;
  env?: EnvSource;
  /** Where the operator's own sender address and support address come from. */
  resolveAddresses: () => Promise<EmailAddresses>;
  /** Organisation name, used as the display name of a mailbox without one. */
  resolveOrganizationName?: () => Promise<string | null>;
  oauth?: OAuthOptions;
  smtp?: SmtpTransportOptions;
  /** Replaced in tests. */
  now?: () => number;
};

type Route = {
  account: EmailAccountRecord | null;
  from: MailboxAddress;
  provider: TransportProvider;
  replyTo: string | null;
  transport: EmailTransport;
};

type DeliveryRow = {
  attempts: number;
  encryptedPayload: string | null;
  id: string;
  lockedUntil: number | null;
  providerMessageId: string | null;
  status: DeliveryStatus;
};

type StoredMessage = Omit<TransactionalEmailMessage, "attachments"> & {
  attachments?: { content: string; contentType: string; filename: string }[];
  retry?: boolean;
};

function currentTime(options: EngineOptions): number {
  return options.now ? options.now() : Math.floor(Date.now() / 1000);
}

function payloadContext(deliveryId: string): string {
  return `email-delivery:${deliveryId}`;
}

/** "Name <a@b>" or "a@b" as a mailbox. */
export function parseMailbox(value: string): MailboxAddress {
  const match = /^\s*"?([^"<]*?)"?\s*<([^<>]+)>\s*$/.exec(value);

  if (match) {
    return { address: match[2]!.trim(), name: match[1]!.trim() || null };
  }

  return { address: extractEmailAddress(value), name: null };
}

function attachmentBytes(message: TransactionalEmailMessage): number {
  return (message.attachments ?? []).reduce(
    (total, attachment) => total + attachment.content.byteLength,
    0,
  );
}

function sealMessage(
  deliveryId: string,
  message: TransactionalEmailMessage,
  retry: boolean,
  env: EnvSource,
): string | null {
  if (attachmentBytes(message) > MAX_STORED_ATTACHMENT_BYTES) {
    return null;
  }

  const stored: StoredMessage = {
    ...message,
    attachments: message.attachments?.map((attachment) => ({
      content: Buffer.from(attachment.content).toString("base64"),
      contentType: attachment.contentType,
      filename: attachment.filename,
    })),
    retry,
  };

  return sealJson(stored, { context: payloadContext(deliveryId), env });
}

function openMessage(
  deliveryId: string,
  sealed: string,
  env: EnvSource,
): { message: TransactionalEmailMessage; retry: boolean } {
  const stored = openJson<StoredMessage>(sealed, {
    context: payloadContext(deliveryId),
    env,
  });
  const { retry, ...rest } = stored;

  return {
    message: {
      ...rest,
      attachments: stored.attachments?.map((attachment) => ({
        content: new Uint8Array(Buffer.from(attachment.content, "base64")),
        contentType: attachment.contentType,
        filename: attachment.filename,
      })),
    },
    retry: retry !== false,
  };
}

// --- Choosing the mailbox -------------------------------------------------

async function senderOf(
  message: TransactionalEmailMessage,
  database: DbPool,
): Promise<string | null> {
  if (message.senderUserId) {
    return message.senderUserId;
  }

  if (!message.envelopeId) {
    return null;
  }

  const row = await queryOne<{ userId: string }>(
    database,
    `SELECT user_id AS "userId" FROM envelopes WHERE id = $1`,
    [message.envelopeId],
  );

  return row?.userId ?? null;
}

function accountTransport(
  account: EmailAccountRecord,
  options: EngineOptions,
): EmailTransport {
  const env = options.env ?? process.env;
  const database = options.database ?? getDb();

  if (account.provider === "gmail" || account.provider === "microsoft") {
    const oauth = { database, env, ...options.oauth };
    const getToken = () => getAccessToken(account, oauth);

    return account.provider === "gmail"
      ? createGmailTransport({ fetch: oauth.fetch, getAccessToken: getToken })
      : createMicrosoftTransport({
          fetch: oauth.fetch,
          getAccessToken: getToken,
        });
  }

  const credentials = openCredentials(account, env);

  if (account.provider === "resend") {
    if (credentials.type !== "api_key") {
      throw new EmailTransportError("The saved Resend key could not be read.", {
        kind: "auth",
      });
    }

    return createResendTransport({ apiKey: credentials.apiKey });
  }

  if (
    credentials.type !== "password" ||
    !account.smtpHost ||
    !account.smtpPort ||
    !account.smtpSecurity
  ) {
    throw new EmailTransportError("The saved SMTP settings are incomplete.", {
      kind: "auth",
    });
  }

  return createSmtpTransport(
    {
      host: account.smtpHost,
      password: credentials.password,
      port: account.smtpPort,
      security: account.smtpSecurity,
      username: account.smtpUsername ?? account.emailAddress,
    },
    { env, ...options.smtp },
  );
}

async function accountRoute(
  account: EmailAccountRecord,
  message: TransactionalEmailMessage,
  options: EngineOptions,
): Promise<Route> {
  if (account.status === "needs_reconnect") {
    throw new EmailTransportError(
      `${account.emailAddress} needs reconnecting. ${reconnectRecovery(getPreset(account.presetId))}`,
      { code: "needs_reconnect", kind: "auth" },
    );
  }

  const [addresses, organizationName] = await Promise.all([
    options.resolveAddresses(),
    options.resolveOrganizationName?.() ?? Promise.resolve(null),
  ]);

  return {
    account,
    from: {
      address: account.emailAddress,
      name: account.displayName ?? organizationName,
    },
    provider: account.provider,
    replyTo:
      message.replyTo ?? account.replyTo ?? addresses.supportAddress ?? null,
    transport: accountTransport(account, options),
  };
}

/** The operator's own configuration: PLATFORM_SMTP_URL, RESEND_API_KEY, the outbox. */
async function environmentRoute(
  message: TransactionalEmailMessage,
  options: EngineOptions,
): Promise<Route | null> {
  const env = options.env ?? process.env;
  const driver = readEnv(env, "EMAIL_DRIVER")?.toLowerCase();
  const addresses = await options.resolveAddresses();
  const from = parseMailbox(addresses.senderAddress);
  const replyTo = message.replyTo ?? addresses.supportAddress ?? null;

  if (driver === "capture" && isCaptureEmailDriverAllowed(env)) {
    return {
      account: null,
      from,
      provider: "capture",
      replyTo,
      transport: createCaptureTransport(env),
    };
  }

  const smtpUrl = readEnv(env, "PLATFORM_SMTP_URL");

  if (smtpUrl) {
    const settings = parseSmtpUrl(smtpUrl);
    const platformFrom = readEnv(env, "PLATFORM_EMAIL_FROM");

    return {
      account: null,
      from: platformFrom
        ? parseMailbox(platformFrom)
        : addresses.senderAddress.includes("@resend.dev")
          ? { address: settings.username, name: from.name }
          : from,
      provider: "smtp",
      replyTo,
      transport: createSmtpTransport(settings, { env, ...options.smtp }),
    };
  }

  const apiKey = readEnv(env, "RESEND_API_KEY");

  if (apiKey && !apiKey.toLowerCase().startsWith("replace-with-")) {
    return {
      account: null,
      from,
      provider: "resend",
      replyTo,
      transport: createResendTransport({ apiKey }),
    };
  }

  return null;
}

/**
 * The mailbox this message goes out through. Throws EmailNotConnectedError
 * when there is none, and an auth EmailTransportError when the one that
 * should carry it cannot (it is never swapped for a mailbox the sender did
 * not choose).
 */
export async function resolveRoute(
  message: TransactionalEmailMessage,
  options: EngineOptions,
): Promise<Route> {
  const database = options.database ?? getDb();
  const stream = streamFor(message.template);
  const senderUserId = await senderOf(message, database);

  // An explicit mailbox (a test email): only one the person may use.
  if (message.accountId) {
    const account = senderUserId
      ? await loadUsableAccount(senderUserId, message.accountId, database)
      : null;

    if (!account) {
      throw new EmailTransportError(
        "You can only send through a mailbox you connected or one shared with you.",
        { code: "forbidden_account", kind: "permanent" },
      );
    }

    return accountRoute(account, message, options);
  }

  if (stream === "agreement" && senderUserId) {
    const preferredId = await getPreferredAccountId(senderUserId, database);

    if (preferredId) {
      const preferred = await loadAccount(preferredId, database);

      if (preferred) {
        return accountRoute(preferred, message, options);
      }
    }

    const organizationDefault = await loadDefaultAccount(database);

    if (
      organizationDefault &&
      (await loadUsableAccount(senderUserId, organizationDefault.id, database))
    ) {
      return accountRoute(organizationDefault, message, options);
    }
  }

  const fromEnvironment = await environmentRoute(message, options);

  if (fromEnvironment) {
    return fromEnvironment;
  }

  // Platform mail with no operator configuration goes through the
  // organisation's default mailbox: the administrator connected it for
  // the workspace, and these messages are the workspace's own.
  if (stream === "platform") {
    const organizationDefault = await loadDefaultAccount(database);

    if (organizationDefault) {
      return accountRoute(organizationDefault, message, options);
    }
  }

  throw new EmailNotConnectedError();
}

/**
 * The message in the organisation's own wording, where it has saved some
 * for this kind of message and the message says where its opening
 * paragraph is. Only the subject and that paragraph change; values are
 * escaped in the HTML part.
 */
export async function applyCustomWording(
  message: TransactionalEmailMessage,
  database: DbPool,
): Promise<TransactionalEmailMessage> {
  if (!message.customization || !isEditableTemplateKind(message.template)) {
    return message;
  }

  const copy = await getTemplateCopy(message.template, database);

  if (!copy) {
    return message;
  }

  const { introHtml, introText, variables } = message.customization;
  const text = renderTemplateText(copy.intro, variables);
  const html = `<p>${renderTemplateHtml(copy.intro, variables).replace(/\r?\n/g, "<br />")}</p>`;

  return {
    ...message,
    htmlBody:
      message.htmlBody && introHtml && message.htmlBody.includes(introHtml)
        ? message.htmlBody.replace(introHtml, () => html)
        : message.htmlBody,
    subject: renderSubject(copy.subject, variables) || message.subject,
    textBody: message.textBody.includes(introText)
      ? message.textBody.replace(introText, () => text)
      : message.textBody,
  };
}

// --- The delivery log -----------------------------------------------------

const DELIVERY_COLUMNS = `
  id,
  status,
  attempts,
  locked_until AS "lockedUntil",
  provider_message_id AS "providerMessageId",
  encrypted_payload AS "encryptedPayload"
`;

/**
 * Takes the delivery row for this message. Returns the existing result
 * when an idempotency key says it was already sent.
 */
async function claimDelivery(
  message: TransactionalEmailMessage,
  idempotencyKey: string | null,
  options: EngineOptions,
): Promise<
  { deliveryId: string; attempts: number } | { duplicate: EmailDeliveryResult }
> {
  const database = options.database ?? getDb();
  const timestamp = currentTime(options);
  const senderUserId = await senderOf(message, database).catch(() => null);
  const id = randomUUID();
  const inserted = await queryOne<{ id: string }>(
    database,
    `
      INSERT INTO email_deliveries (
        id, idempotency_key, stream, template, to_address, subject,
        envelope_id, sender_user_id, status, attempts, locked_until,
        created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'sending', 0, $9, $10, $10)
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
      DO NOTHING
      RETURNING id
    `,
    [
      id,
      idempotencyKey,
      streamFor(message.template),
      message.template,
      message.to.slice(0, 320),
      message.subject.slice(0, 500),
      message.envelopeId ?? null,
      senderUserId,
      timestamp + CLAIM_SECONDS,
      timestamp,
    ],
  );

  if (inserted) {
    return { attempts: 0, deliveryId: inserted.id };
  }

  return withTransaction(async (tx) => {
    const existing = await queryOne<DeliveryRow>(
      tx,
      `SELECT ${DELIVERY_COLUMNS} FROM email_deliveries WHERE idempotency_key = $1 FOR UPDATE`,
      [idempotencyKey],
    );

    if (!existing) {
      throw new EmailDeliveryInProgressError();
    }

    if (existing.status === "sent") {
      return {
        duplicate: {
          accepted: [message.to],
          messageId: existing.providerMessageId ?? undefined,
          rejected: [],
        },
      };
    }

    if (
      existing.status === "sending" &&
      existing.lockedUntil !== null &&
      existing.lockedUntil > timestamp
    ) {
      throw new EmailDeliveryInProgressError();
    }

    await tx.query(
      `
        UPDATE email_deliveries
        SET status = 'sending', locked_until = $2, next_attempt_at = NULL,
            subject = $3, to_address = $4, updated_at = $5
        WHERE id = $1
      `,
      [
        existing.id,
        timestamp + CLAIM_SECONDS,
        message.subject.slice(0, 500),
        message.to.slice(0, 320),
        timestamp,
      ],
    );

    return { attempts: existing.attempts, deliveryId: existing.id };
  }, database);
}

function recoveryFor(error: EmailTransportError, route: Route | null): string {
  if (error.code === "forbidden_account") {
    return "Choose a mailbox you connected or one shared with you.";
  }

  if (error.kind === "auth") {
    return route?.account
      ? `Reconnect ${route.account.emailAddress} in Settings, Email & Integrations.`
      : "Check the email provider credentials in the server configuration.";
  }

  if (error.kind === "transient") {
    return "The provider could not take the message right now.";
  }

  return "Check the recipient's address, or send it again from the envelope.";
}

async function finishSent(
  deliveryId: string,
  attempts: number,
  route: Route,
  providerMessageId: string | undefined,
  message: TransactionalEmailMessage,
  options: EngineOptions,
): Promise<void> {
  const database = options.database ?? getDb();
  const timestamp = currentTime(options);

  await database.query(
    `
      UPDATE email_deliveries
      SET status = 'sent', attempts = $2, account_id = $3, account_email = $4,
          provider = $5, provider_message_id = $6, sent_at = $7,
          locked_until = NULL, next_attempt_at = NULL, encrypted_payload = NULL,
          last_error = NULL, recovery = NULL, updated_at = $7
      WHERE id = $1
    `,
    [
      deliveryId,
      attempts,
      route.account?.id ?? null,
      route.account?.emailAddress ?? route.from.address,
      route.provider,
      providerMessageId ?? null,
      timestamp,
    ],
  );

  if (route.account) {
    await recordAccountOutcome(route.account.id, { ok: true }, database);
  }

  // A signer who has just been sent a link does not also need the older
  // one that is still waiting to be tried again.
  if (
    message.envelopeId &&
    (SIGNING_LINK_TEMPLATES as readonly string[]).includes(message.template)
  ) {
    await database.query(
      `
        UPDATE email_deliveries
        SET status = 'superseded', encrypted_payload = NULL,
            next_attempt_at = NULL, updated_at = $4
        WHERE envelope_id = $1 AND lower(to_address) = lower($2)
          AND template = ANY($3::text[]) AND id <> $5
          AND status IN ('retrying', 'deferred')
      `,
      [
        message.envelopeId,
        message.to,
        SIGNING_LINK_TEMPLATES,
        timestamp,
        deliveryId,
      ],
    );
  }
}

async function finishFailed(
  deliveryId: string,
  attempts: number,
  route: Route | null,
  error: EmailTransportError,
  message: TransactionalEmailMessage,
  retry: boolean,
  options: EngineOptions,
): Promise<Error> {
  const database = options.database ?? getDb();
  const env = options.env ?? process.env;
  const timestamp = currentTime(options);
  const delay =
    error.retryAfterMs !== null
      ? Math.max(Math.ceil(error.retryAfterMs / 1000), RETRY_DELAYS_SECONDS[0]!)
      : RETRY_DELAYS_SECONDS[
          Math.min(attempts - 1, RETRY_DELAYS_SECONDS.length - 1)
        ]!;
  // An auth failure waits for the mailbox to be reconnected; a transient
  // one for the provider to recover. A permanent one is final.
  const willRetry =
    retry && error.kind !== "permanent" && attempts < MAX_ATTEMPTS;
  const sealed = willRetry
    ? sealMessage(deliveryId, message, retry, env)
    : null;
  const status: DeliveryStatus = sealed
    ? error.kind === "auth"
      ? "deferred"
      : "retrying"
    : "failed";
  const nextAttemptAt = sealed ? timestamp + delay : null;
  const recovery = sealed
    ? `${recoveryFor(error, route)} It will be tried again automatically.`
    : recoveryFor(error, route);

  await database.query(
    `
      UPDATE email_deliveries
      SET status = $2, attempts = $3, account_id = $4, account_email = $5,
          provider = $6, last_error = $7, recovery = $8, next_attempt_at = $9,
          encrypted_payload = $10, locked_until = NULL, updated_at = $11
      WHERE id = $1
    `,
    [
      deliveryId,
      status,
      attempts,
      route?.account?.id ?? null,
      route?.account?.emailAddress ?? route?.from.address ?? null,
      route?.provider ?? null,
      error.message.slice(0, 1000),
      recovery,
      nextAttemptAt,
      sealed,
      timestamp,
    ],
  );

  if (route?.account) {
    await recordAccountOutcome(
      route.account.id,
      {
        error: error.message,
        needsReconnect: error.kind === "auth",
        ok: false,
      },
      database,
    );
  }

  return sealed && nextAttemptAt
    ? new EmailDeliveryQueuedError(error.message, deliveryId, nextAttemptAt)
    : error;
}

async function attempt(
  deliveryId: string,
  previousAttempts: number,
  message: TransactionalEmailMessage,
  retry: boolean,
  idempotencyKey: string | null,
  options: EngineOptions,
): Promise<EmailDeliveryResult> {
  let route: Route | null = null;
  const attempts = previousAttempts + 1;

  try {
    route = await resolveRoute(message, options);

    if (route.account?.dailyLimit) {
      const database = options.database ?? getDb();
      const sentToday = await queryOne<{ count: string }>(
        database,
        `SELECT count(*) AS count FROM email_deliveries
         WHERE account_id = $1 AND status = 'sent' AND sent_at > $2`,
        [route.account.id, currentTime(options) - 86_400],
      );

      if (Number(sentToday?.count ?? 0) >= route.account.dailyLimit) {
        throw new EmailTransportError(
          `${route.account.emailAddress} has reached its daily sending limit of ${String(route.account.dailyLimit)}.`,
          { code: "daily_limit", kind: "transient", retryAfterMs: 3600 * 1000 },
        );
      }
    }

    if (attachmentBytes(message) > route.transport.maxAttachmentBytes) {
      throw new EmailTransportError(
        `The attachments are too large for ${route.provider === "microsoft" ? "Microsoft 365" : "this mailbox"}. The signed documents can be downloaded from the envelope instead.`,
        { code: "attachments_too_large", kind: "permanent" },
      );
    }

    const worded = await applyCustomWording(
      message,
      options.database ?? getDb(),
    );
    const outgoing: OutgoingMessage = {
      attachments: message.attachments ?? [],
      from: route.from,
      htmlBody: worded.htmlBody,
      idempotencyKey: idempotencyKey ?? undefined,
      replyTo: route.replyTo,
      subject: worded.subject,
      template: message.template,
      textBody: worded.textBody,
      to: message.to,
    };
    const { providerMessageId } = await route.transport.send(outgoing);

    await finishSent(
      deliveryId,
      attempts,
      route,
      providerMessageId,
      message,
      options,
    );

    return {
      accepted: [message.to],
      messageId: providerMessageId,
      rejected: [],
    };
  } catch (error) {
    if (error instanceof EmailNotConnectedError) {
      await finishFailed(
        deliveryId,
        attempts,
        null,
        new EmailTransportError(EMAIL_NOT_CONNECTED_TEXT, {
          code: "not_connected",
          kind: "permanent",
        }),
        message,
        false,
        options,
      );
      throw error;
    }

    throw await finishFailed(
      deliveryId,
      attempts,
      route,
      toTransportError(error),
      message,
      retry,
      options,
    );
  }
}

export type DeliverOptions = EmailSendOptions & {
  /** Overrides the template's own choice of background retries. */
  retry?: boolean;
};

/** Sends one message through the engine. See the top of this file. */
export async function deliver(
  message: TransactionalEmailMessage,
  sendOptions: DeliverOptions | undefined,
  options: EngineOptions,
): Promise<EmailDeliveryResult> {
  const idempotencyKey = sendOptions?.idempotencyKey ?? null;
  const retry =
    sendOptions?.retry ?? BACKGROUND_RETRY_TEMPLATES.has(message.template);
  const claimed = await claimDelivery(message, idempotencyKey, options);

  if ("duplicate" in claimed) {
    return claimed.duplicate;
  }

  return attempt(
    claimed.deliveryId,
    claimed.attempts,
    message,
    retry,
    idempotencyKey,
    options,
  );
}

/**
 * Tries again the deliveries that are due. Each is taken under a lock, so
 * two workers never send the same one. Returns what happened.
 */
export async function processDueDeliveries(
  options: EngineOptions & { limit?: number; onlyIds?: string[] },
): Promise<{ failed: number; retried: number; sent: number }> {
  const database = options.database ?? getDb();
  const env = options.env ?? process.env;
  const timestamp = currentTime(options);
  const summary = { failed: 0, retried: 0, sent: 0 };
  const due = await withTransaction(async (tx) => {
    const rows = await queryMany<
      DeliveryRow & { idempotencyKey: string | null }
    >(
      tx,
      `
        SELECT ${DELIVERY_COLUMNS}, idempotency_key AS "idempotencyKey"
        FROM email_deliveries
        WHERE status IN ('retrying', 'deferred')
          AND encrypted_payload IS NOT NULL
          AND ${options.onlyIds ? "id = ANY($3::text[])" : "next_attempt_at <= $1"}
          AND (locked_until IS NULL OR locked_until < $1)
        ORDER BY next_attempt_at, id
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      `,
      options.onlyIds
        ? [timestamp, options.limit ?? 25, options.onlyIds]
        : [timestamp, options.limit ?? 25],
    );

    for (const row of rows) {
      await tx.query(
        `UPDATE email_deliveries SET status = 'sending', locked_until = $2, updated_at = $3 WHERE id = $1`,
        [row.id, timestamp + CLAIM_SECONDS, timestamp],
      );
    }

    return rows;
  }, database);

  for (const row of due) {
    let opened: { message: TransactionalEmailMessage; retry: boolean };

    try {
      opened = openMessage(row.id, row.encryptedPayload!, env);
    } catch {
      await database.query(
        `
          UPDATE email_deliveries
          SET status = 'failed', encrypted_payload = NULL, locked_until = NULL,
              next_attempt_at = NULL, last_error = $2, recovery = $3, updated_at = $4
          WHERE id = $1
        `,
        [
          row.id,
          "The stored message could not be read with the current encryption key.",
          "Send it again from the envelope.",
          timestamp,
        ],
      );
      summary.failed += 1;
      continue;
    }

    try {
      await attempt(
        row.id,
        row.attempts,
        opened.message,
        opened.retry,
        row.idempotencyKey,
        options,
      );
      summary.sent += 1;
    } catch (error) {
      if (error instanceof EmailDeliveryQueuedError) {
        summary.retried += 1;
      } else {
        summary.failed += 1;
      }
    }
  }

  return summary;
}

/** Brings deferred deliveries forward once their mailbox works again. */
export async function wakeDeferredDeliveries(
  accountId: string,
  database: DbPool = getDb(),
): Promise<void> {
  await database.query(
    `
      UPDATE email_deliveries
      SET status = 'retrying', next_attempt_at = $2, updated_at = $2
      WHERE account_id = $1 AND status = 'deferred'
    `,
    [accountId, Math.floor(Date.now() / 1000)],
  );
}
