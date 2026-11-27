import { Resend } from "resend";

import { kindForHttpStatus, retryAfterMs } from "./classify.ts";
import {
  EmailTransportError,
  type EmailTransport,
  type MailboxAddress,
  type OutgoingMessage,
} from "./types.ts";

// Resend, with its API key: either the install's RESEND_API_KEY or an
// account connected in Settings > Email & Integrations.

/**
 * Resend accepts up to 40 MB per message once attachments are base64
 * encoded, which makes them a third larger.
 */
export const RESEND_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** How often a message Resend turned away for rate is tried again. */
const RATE_LIMIT_RETRIES = 3;
const DEFAULT_RATE_LIMIT_WAIT_MS = 1_000;
const MAX_RATE_LIMIT_WAIT_MS = 5_000;

type ResendError = {
  message?: string;
  name?: string;
  statusCode?: number | null;
};

type ResendResult = {
  error: ResendError | null;
  headers: Record<string, string> | null;
};

export type ResendClient = Pick<Resend, "batch" | "emails">;

function rateLimitWaitMs(headers: Record<string, string> | null): number {
  const seconds = Number(headers?.["retry-after"]);

  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds * 1000, MAX_RATE_LIMIT_WAIT_MS)
    : DEFAULT_RATE_LIMIT_WAIT_MS;
}

/**
 * Resend allows a team so many requests a second, across everything that
 * uses its key. A request over that is refused, not queued, so it is tried
 * again after the wait Resend names. A used-up daily or monthly quota is
 * also a 429, and is not retried here: a second's wait does not bring it
 * back.
 */
async function sendWithinRateLimit<T extends ResendResult>(
  request: () => Promise<T>,
  wait: (milliseconds: number) => Promise<void>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const result = await request();

    if (
      result.error?.name !== "rate_limit_exceeded" ||
      attempt >= RATE_LIMIT_RETRIES
    ) {
      return result;
    }

    await wait(rateLimitWaitMs(result.headers));
  }
}

export function waitFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

const AUTH_ERRORS = new Set([
  "invalid_api_key",
  "missing_api_key",
  "restricted_api_key",
  "invalid_access",
]);

/** Resend's error as an EmailTransportError of the right kind. */
export function toResendError(
  error: ResendError,
  headers: Record<string, string> | null = null,
): EmailTransportError {
  const status = typeof error.statusCode === "number" ? error.statusCode : null;
  const name = error.name ?? null;
  let kind = status === null ? "transient" : kindForHttpStatus(status);

  if (name && AUTH_ERRORS.has(name)) {
    kind = "auth";
  } else if (
    name === "rate_limit_exceeded" ||
    name === "daily_quota_exceeded" ||
    name === "monthly_quota_exceeded" ||
    name === "application_error" ||
    name === "internal_server_error"
  ) {
    kind = "transient";
  } else if (name === "validation_error" || name === "invalid_from_address") {
    // An unverified domain, a malformed address: the message will not go
    // out like this, however often it is tried.
    kind = "permanent";
  }

  return new EmailTransportError(error.message || "Email delivery failed.", {
    code: name,
    kind: kind as EmailTransportError["kind"],
    retryAfterMs: retryAfterMs(headers?.["retry-after"]),
    statusCode: status,
  });
}

/** "Name <address>", quoting the name when it needs it. */
export function formatMailbox({ address, name }: MailboxAddress): string {
  if (!name) {
    return address;
  }

  const quoted = /[",.;:<>@()[\]\\]/.test(name)
    ? `"${name.replace(/["\\]/g, "\\$&")}"`
    : name;

  return `${quoted} <${address}>`;
}

export function buildResendPayload(message: OutgoingMessage) {
  return {
    ...(message.attachments.length
      ? {
          attachments: message.attachments.map((attachment) => ({
            content: Buffer.from(attachment.content),
            contentType: attachment.contentType,
            filename: attachment.filename,
          })),
        }
      : {}),
    from: formatMailbox(message.from),
    html: message.htmlBody,
    replyTo: message.replyTo ?? undefined,
    subject: message.subject,
    tags: [{ name: "category", value: message.template }],
    text: message.textBody,
    to: [message.to],
  };
}

export type ResendTransport = EmailTransport & {
  sendBatch(
    messages: readonly OutgoingMessage[],
    idempotencyKey?: string,
  ): Promise<{ providerMessageId?: string }[]>;
};

export function createResendTransport({
  apiKey,
  client,
  wait = waitFor,
}: {
  apiKey?: string;
  client?: ResendClient;
  wait?: (milliseconds: number) => Promise<void>;
}): ResendTransport {
  const resend = client ?? new Resend(apiKey);

  return {
    maxAttachmentBytes: RESEND_MAX_ATTACHMENT_BYTES,
    provider: "resend",
    async send(message) {
      const result = await sendWithinRateLimit(
        () =>
          resend.emails.send(
            buildResendPayload(message),
            message.idempotencyKey
              ? { idempotencyKey: message.idempotencyKey }
              : undefined,
          ) as Promise<ResendResult & { data: { id: string } | null }>,
        wait,
      );

      if (result.error) {
        throw toResendError(result.error, result.headers);
      }

      return { providerMessageId: result.data?.id };
    },
    async sendBatch(messages, idempotencyKey) {
      if (messages.length === 0) {
        return [];
      }

      const result = await sendWithinRateLimit(
        () =>
          resend.batch.send(
            messages.map((message) => buildResendPayload(message)),
            idempotencyKey ? { idempotencyKey } : undefined,
          ) as Promise<
            ResendResult & { data: { data: { id: string }[] } | null }
          >,
        wait,
      );

      if (result.error) {
        throw toResendError(result.error, result.headers);
      }

      return messages.map((_, index) => ({
        providerMessageId: result.data?.data[index]?.id,
      }));
    },
  };
}

/**
 * Whether this API key belongs to a Resend account. A key that may only
 * send cannot list domains, and says so: that still proves the key is real.
 */
export async function verifyResendApiKey(
  apiKey: string,
  client: Pick<Resend, "domains"> = new Resend(apiKey),
): Promise<void> {
  const result = await client.domains.list();

  // Resend uses this name twice: with 401 for a key that may only send,
  // and with 403 for a key that has been switched off.
  const sendOnly =
    result.error?.name === "restricted_api_key" &&
    (result.error as ResendError).statusCode !== 403;

  if (result.error && !sendOnly) {
    throw toResendError(result.error as ResendError);
  }
}
