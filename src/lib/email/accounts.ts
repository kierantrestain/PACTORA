import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  getDb,
  queryMany,
  queryOne,
  withTransaction,
  type DbExecutor,
  type DbPool,
} from "../db/connection.ts";
import { emailSchema } from "../schemas/common.ts";
import { type EnvSource } from "../utils/env.ts";
import { openJson, sealJson } from "./crypto.ts";
import {
  getPreset,
  PROVIDER_PRESET_IDS,
  type AccountProvider,
  type ProviderPresetId,
  type SmtpSecurity,
} from "./presets.ts";
import { verifyResendApiKey } from "./resend.ts";
import {
  checkSmtpEndpoint,
  normalizeSmtpHost,
  verifySmtpSettings,
  type SmtpSettings,
  type SmtpTransportOptions,
} from "./smtp.ts";
import { EmailTransportError } from "./types.ts";

// Connected mailboxes and who may do what with them.
//
// - A personal account is seen, used, changed and removed by its owner
//   only. Nobody else's resolution ever considers it, administrators
//   included.
// - An organisation account is created, changed and removed by
//   administrators only. It is used by the people it is shared with:
//   nobody (then it only carries platform mail, as the default), everyone,
//   or chosen teams.
// - A person may prefer only an account they own or one shared with them.
// - No view ever carries a password, API key or token.

export type AccountScope = "organization" | "personal";
export type AccountStatus = "connected" | "needs_reconnect" | "error";
export type SharedWith = "nobody" | "everyone" | "teams";

export type EmailAccountRecord = {
  createdAt: number;
  dailyLimit: number | null;
  displayName: string | null;
  emailAddress: string;
  encryptedCredentials: string;
  id: string;
  isDefault: boolean;
  lastError: string | null;
  lastErrorAt: number | null;
  lastSuccessAt: number | null;
  oauthScope: string | null;
  ownerUserId: string | null;
  presetId: ProviderPresetId;
  provider: AccountProvider;
  providerAccountId: string | null;
  replyTo: string | null;
  scope: AccountScope;
  sharedWith: SharedWith;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecurity: SmtpSecurity | null;
  smtpUsername: string | null;
  status: AccountStatus;
  updatedAt: number;
};

export type StoredCredentials =
  | { password: string; type: "password" }
  | { apiKey: string; type: "api_key" }
  | {
      accessToken: string;
      /** Unix seconds. */
      expiresAt: number;
      refreshToken: string | null;
      scope: string;
      type: "oauth";
    };

export type EmailAccountView = {
  createdAt: number;
  displayName: string | null;
  emailAddress: string;
  id: string;
  isDefault: boolean;
  lastError: string | null;
  lastErrorAt: number | null;
  lastSuccessAt: number | null;
  ownedByMe: boolean;
  presetId: ProviderPresetId;
  provider: AccountProvider;
  replyTo: string | null;
  scope: AccountScope;
  sharedWith: SharedWith;
  smtp: {
    host: string;
    port: number;
    security: SmtpSecurity;
    username: string;
  } | null;
  status: AccountStatus;
  teamIds: string[];
};

export class EmailAccountError extends Error {
  readonly code: string | null;
  readonly fieldErrors: Record<string, string> | null;
  readonly statusCode: number;

  constructor(
    message: string,
    statusCode: number,
    {
      code = null,
      fieldErrors = null,
    }: { code?: string | null; fieldErrors?: Record<string, string> | null } = {},
  ) {
    super(message);
    this.name = "EmailAccountError";
    this.code = code;
    this.fieldErrors = fieldErrors;
    this.statusCode = statusCode;
  }
}

export const ACCOUNT_COLUMNS = `
  a.id,
  a.scope,
  a.owner_user_id AS "ownerUserId",
  a.provider,
  a.preset_id AS "presetId",
  a.email_address AS "emailAddress",
  a.display_name AS "displayName",
  a.reply_to AS "replyTo",
  a.status,
  a.encrypted_credentials AS "encryptedCredentials",
  a.smtp_host AS "smtpHost",
  a.smtp_port AS "smtpPort",
  a.smtp_security AS "smtpSecurity",
  a.smtp_username AS "smtpUsername",
  a.provider_account_id AS "providerAccountId",
  a.oauth_scope AS "oauthScope",
  a.daily_limit AS "dailyLimit",
  a.is_default AS "isDefault",
  a.shared_with AS "sharedWith",
  a.last_success_at AS "lastSuccessAt",
  a.last_error AS "lastError",
  a.last_error_at AS "lastErrorAt",
  a.created_at AS "createdAt",
  a.updated_at AS "updatedAt"
`;

/**
 * The accounts a person may send through: their own, and organisation
 * accounts shared with everyone or with a team they are on. $1 is the
 * person's id. Nothing else is ever a candidate.
 */
export const USABLE_BY_USER = `
  (
    (a.scope = 'personal' AND a.owner_user_id = $1)
    OR (
      a.scope = 'organization'
      AND (
        a.shared_with = 'everyone'
        OR (
          a.shared_with = 'teams'
          AND EXISTS (
            SELECT 1
            FROM email_account_teams t
            JOIN team_members m ON m.team_id = t.team_id
            WHERE t.account_id = a.id AND m.user_id = $1
          )
        )
      )
    )
  )
`;

function now(): number {
  return Math.floor(Date.now() / 1000);
}

export function credentialsContext(accountId: string): string {
  return `email-account:${accountId}`;
}

export function sealCredentials(
  accountId: string,
  credentials: StoredCredentials,
  env: EnvSource = process.env,
): string {
  return sealJson(credentials, { context: credentialsContext(accountId), env });
}

export function openCredentials(
  account: Pick<EmailAccountRecord, "encryptedCredentials" | "id">,
  env: EnvSource = process.env,
): StoredCredentials {
  return openJson<StoredCredentials>(account.encryptedCredentials, {
    context: credentialsContext(account.id),
    env,
  });
}

export async function isAdministrator(
  userId: string,
  database: DbExecutor = getDb(),
): Promise<boolean> {
  const row = await queryOne<{ role: string | null }>(
    database,
    `SELECT role FROM public."user" WHERE id = $1`,
    [userId],
  );

  return row?.role === "admin";
}

export async function loadAccount(
  accountId: string,
  database: DbExecutor = getDb(),
): Promise<EmailAccountRecord | null> {
  return queryOne<EmailAccountRecord>(
    database,
    `SELECT ${ACCOUNT_COLUMNS} FROM email_accounts a WHERE a.id = $1`,
    [accountId],
  );
}

/** The account, when this person may send through it. */
export async function loadUsableAccount(
  userId: string,
  accountId: string,
  database: DbExecutor = getDb(),
): Promise<EmailAccountRecord | null> {
  return queryOne<EmailAccountRecord>(
    database,
    `SELECT ${ACCOUNT_COLUMNS} FROM email_accounts a WHERE a.id = $2 AND ${USABLE_BY_USER}`,
    [userId, accountId],
  );
}

export async function canUseAccount(
  userId: string,
  accountId: string,
  database: DbExecutor = getDb(),
): Promise<boolean> {
  return (await loadUsableAccount(userId, accountId, database)) !== null;
}

/** Personal accounts: their owner. Organisation accounts: administrators. */
export async function canManageAccount(
  userId: string,
  account: Pick<EmailAccountRecord, "ownerUserId" | "scope">,
  database: DbExecutor = getDb(),
): Promise<boolean> {
  return account.scope === "personal"
    ? account.ownerUserId === userId
    : isAdministrator(userId, database);
}

/**
 * The account for someone who wants to change it or look at it closely.
 * One they may not see is reported as missing, not as forbidden, so its
 * existence is not given away.
 */
async function loadManagedAccount(
  userId: string,
  accountId: string,
  database: DbExecutor,
): Promise<EmailAccountRecord> {
  const account = await loadAccount(accountId, database);

  if (!account || !(await canManageAccount(userId, account, database))) {
    if (account?.scope === "organization") {
      throw new EmailAccountError(
        "Only an administrator can change organisation email accounts.",
        403,
      );
    }

    throw new EmailAccountError("That email account no longer exists.", 404);
  }

  return account;
}

async function listTeamIds(
  accountIds: readonly string[],
  database: DbExecutor,
): Promise<Map<string, string[]>> {
  const rows =
    accountIds.length === 0
      ? []
      : await queryMany<{ accountId: string; teamId: string }>(
          database,
          `
            SELECT account_id AS "accountId", team_id AS "teamId"
            FROM email_account_teams
            WHERE account_id = ANY($1::text[])
            ORDER BY team_id
          `,
          [accountIds],
        );
  const byAccount = new Map<string, string[]>();

  for (const row of rows) {
    byAccount.set(row.accountId, [
      ...(byAccount.get(row.accountId) ?? []),
      row.teamId,
    ]);
  }

  return byAccount;
}

export function toAccountView(
  account: EmailAccountRecord,
  userId: string,
  teamIds: string[] = [],
): EmailAccountView {
  return {
    createdAt: account.createdAt,
    displayName: account.displayName,
    emailAddress: account.emailAddress,
    id: account.id,
    isDefault: account.isDefault,
    lastError: account.lastError,
    lastErrorAt: account.lastErrorAt,
    lastSuccessAt: account.lastSuccessAt,
    ownedByMe: account.scope === "personal" && account.ownerUserId === userId,
    presetId: account.presetId,
    provider: account.provider,
    replyTo: account.replyTo,
    scope: account.scope,
    sharedWith: account.sharedWith,
    smtp:
      account.provider === "smtp" &&
      account.smtpHost &&
      account.smtpPort &&
      account.smtpSecurity
        ? {
            host: account.smtpHost,
            port: account.smtpPort,
            security: account.smtpSecurity,
            username: account.smtpUsername ?? "",
          }
        : null,
    status: account.status,
    teamIds,
  };
}

/**
 * What a person sees in Settings > Email & Integrations: their own
 * accounts, and the organisation's (all of them for an administrator, the
 * ones shared with them otherwise).
 */
export async function listVisibleAccounts(
  userId: string,
  database: DbExecutor = getDb(),
): Promise<{
  accounts: EmailAccountView[];
  canManageOrganization: boolean;
  preferredAccountId: string | null;
}> {
  const admin = await isAdministrator(userId, database);
  const rows = await queryMany<EmailAccountRecord>(
    database,
    `
      SELECT ${ACCOUNT_COLUMNS}
      FROM email_accounts a
      WHERE ${admin ? `(a.scope = 'organization' OR (a.scope = 'personal' AND a.owner_user_id = $1))` : USABLE_BY_USER}
      ORDER BY a.scope, a.is_default DESC, lower(a.email_address), a.id
    `,
    [userId],
  );
  const teamIds = await listTeamIds(
    rows.map((row) => row.id),
    database,
  );

  return {
    accounts: rows.map((row) =>
      toAccountView(row, userId, teamIds.get(row.id) ?? []),
    ),
    canManageOrganization: admin,
    preferredAccountId: await getPreferredAccountId(userId, database),
  };
}

/** The account a person prefers, while they may still use it. */
export async function getPreferredAccountId(
  userId: string,
  database: DbExecutor = getDb(),
): Promise<string | null> {
  const row = await queryOne<{ accountId: string }>(
    database,
    `
      SELECT p.account_id AS "accountId"
      FROM email_account_preferences p
      JOIN email_accounts a ON a.id = p.account_id
      WHERE p.user_id = $1 AND ${USABLE_BY_USER}
    `,
    [userId],
  );

  return row?.accountId ?? null;
}

export async function setPreferredAccount(
  userId: string,
  accountId: string | null,
  database: DbExecutor = getDb(),
): Promise<void> {
  if (accountId === null) {
    await database.query(
      `DELETE FROM email_account_preferences WHERE user_id = $1`,
      [userId],
    );
    return;
  }

  if (!(await canUseAccount(userId, accountId, database))) {
    throw new EmailAccountError(
      "You can only choose an account you connected or one shared with you.",
      404,
    );
  }

  await database.query(
    `
      INSERT INTO email_account_preferences (user_id, account_id, updated_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id) DO UPDATE
      SET account_id = EXCLUDED.account_id, updated_at = EXCLUDED.updated_at
    `,
    [userId, accountId, now()],
  );
}

// --- Creating and changing accounts ---------------------------------------

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value ? value : null));

const optionalEmail = z
  .union([emailSchema, z.literal("")])
  .nullish()
  .transform((value) => (value ? value.toLowerCase() : null));

export const createAccountSchema = z.object({
  apiKey: z.string().trim().min(1).max(512).optional(),
  dailyLimit: z.number().int().positive().max(1_000_000).nullish(),
  displayName: optionalText(120),
  emailAddress: emailSchema.transform((value) => value.toLowerCase()),
  host: z.string().trim().max(253).optional(),
  isDefault: z.boolean().optional(),
  password: z.string().min(1).max(1024).optional(),
  port: z.number().int().optional(),
  presetId: z.enum(PROVIDER_PRESET_IDS),
  replyTo: optionalEmail,
  scope: z.enum(["organization", "personal"]),
  security: z.enum(["tls", "starttls"]).optional(),
  sharedWith: z.enum(["nobody", "everyone", "teams"]).optional(),
  teamIds: z.array(z.string().min(1).max(100)).max(200).optional(),
  username: z.string().trim().max(320).optional(),
});

export type CreateAccountInput = z.input<typeof createAccountSchema>;

export const updateAccountSchema = z.object({
  dailyLimit: z.number().int().positive().max(1_000_000).nullish(),
  displayName: optionalText(120).optional(),
  isDefault: z.boolean().optional(),
  password: z.string().min(1).max(1024).optional(),
  replyTo: optionalEmail.optional(),
  sharedWith: z.enum(["nobody", "everyone", "teams"]).optional(),
  teamIds: z.array(z.string().min(1).max(100)).max(200).optional(),
});

export type UpdateAccountInput = z.input<typeof updateAccountSchema>;

export function fieldErrorsOf(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};

  for (const issue of error.issues) {
    const field = issue.path.join(".") || "body";

    fieldErrors[field] ??= issue.message;
  }

  return fieldErrors;
}

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);

  if (!parsed.success) {
    const fieldErrors = fieldErrorsOf(parsed.error);

    throw new EmailAccountError("Check the highlighted fields.", 400, {
      fieldErrors,
    });
  }

  return parsed.data;
}

export type AccountOptions = {
  database?: DbPool;
  env?: EnvSource;
  /** Passed to the SMTP check, so a test can trust its own server. */
  smtp?: SmtpTransportOptions;
  /** Replaced in tests that must not reach Resend. */
  verifyResendKey?: (apiKey: string) => Promise<void>;
};

function verificationFailed(error: unknown, field: string): EmailAccountError {
  const message =
    error instanceof Error && error.message
      ? error.message
      : "The account could not be verified.";

  return new EmailAccountError(message, 422, {
    code:
      error instanceof EmailTransportError && error.kind === "auth"
        ? "authentication_failed"
        : "verification_failed",
    fieldErrors: { [field]: message },
  });
}

async function assertTeamsExist(
  teamIds: readonly string[],
  database: DbExecutor,
): Promise<void> {
  if (teamIds.length === 0) {
    throw new EmailAccountError("Choose at least one team.", 400, {
      fieldErrors: { teamIds: "Choose at least one team." },
    });
  }

  const found = await queryMany<{ id: string }>(
    database,
    `SELECT id FROM teams WHERE id = ANY($1::text[])`,
    [teamIds],
  );

  if (found.length !== new Set(teamIds).size) {
    throw new EmailAccountError("One of those teams no longer exists.", 400, {
      fieldErrors: { teamIds: "One of those teams no longer exists." },
    });
  }
}

async function replaceTeams(
  accountId: string,
  teamIds: readonly string[],
  database: DbExecutor,
): Promise<void> {
  await database.query(`DELETE FROM email_account_teams WHERE account_id = $1`, [
    accountId,
  ]);

  for (const teamId of new Set(teamIds)) {
    await database.query(
      `INSERT INTO email_account_teams (account_id, team_id) VALUES ($1, $2)`,
      [accountId, teamId],
    );
  }
}

/** The SMTP settings to use for a preset, from what was entered. */
export function resolveSmtpInput(
  presetId: ProviderPresetId,
  input: {
    emailAddress: string;
    host?: string;
    password?: string;
    port?: number;
    security?: SmtpSecurity;
    username?: string;
  },
): SmtpSettings {
  const preset = getPreset(presetId);
  const fieldErrors: Record<string, string> = {};
  let host: string;
  let port: number;
  let security: SmtpSecurity;

  if (preset.smtpDefaults) {
    const chosenHost = input.host ? normalizeSmtpHost(input.host) : null;

    if (chosenHost && !preset.smtpHosts.includes(chosenHost)) {
      fieldErrors.host = `${preset.name} uses ${preset.smtpHosts.join(" or ")}.`;
    }

    host = chosenHost ?? preset.smtpDefaults.host;
    port = preset.smtpDefaults.port;
    security = preset.smtpDefaults.security;
  } else {
    host = normalizeSmtpHost(input.host ?? "");
    port = input.port ?? 587;
    security = input.security ?? (port === 465 ? "tls" : "starttls");
    Object.assign(fieldErrors, checkSmtpEndpoint({ host, port, security }));
  }

  const username = preset.usernameIsAddress
    ? input.emailAddress
    : (input.username?.trim() || input.emailAddress);

  if (!input.password) {
    fieldErrors.password = preset.appPasswordRequired
      ? `Enter an app password for ${preset.name}. Your normal password does not work here.`
      : "Enter the password.";
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw new EmailAccountError("Check the highlighted fields.", 400, {
      fieldErrors,
    });
  }

  return { host, password: input.password!, port, security, username };
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "23505";
}

export type AccountActor = { email: string; name: string; userId: string };

/**
 * Connects an SMTP or Resend account. The credentials are tried first, for
 * real: nothing is saved that does not sign in.
 */
export async function createAccount(
  actor: AccountActor,
  rawInput: unknown,
  {
    database = getDb(),
    env = process.env,
    smtp,
    verifyResendKey = (apiKey) => verifyResendApiKey(apiKey),
  }: AccountOptions = {},
): Promise<EmailAccountView> {
  const input = parse(createAccountSchema, rawInput);
  const preset = getPreset(input.presetId);

  if (preset.method === "oauth") {
    throw new EmailAccountError(
      `Connect ${preset.name} with the "Connect with ${preset.oauth === "google" ? "Google" : "Microsoft"}" button. PACTORA never asks for a ${preset.oauth === "google" ? "Google" : "Microsoft"} password.`,
      400,
      { code: "oauth_required", fieldErrors: { presetId: "Use the sign-in button for this provider." } },
    );
  }

  const admin = await isAdministrator(actor.userId, database);

  if (input.scope === "organization" && !admin) {
    throw new EmailAccountError(
      "Only an administrator can connect an organisation email account.",
      403,
    );
  }

  if (input.scope === "personal" && (input.isDefault || (input.sharedWith && input.sharedWith !== "nobody"))) {
    throw new EmailAccountError(
      "A personal account is only ever yours: it cannot be shared or be the organisation's default.",
      400,
      { fieldErrors: { sharedWith: "Personal accounts are not shared." } },
    );
  }

  const sharedWith = input.scope === "organization" ? (input.sharedWith ?? "nobody") : "nobody";

  if (sharedWith === "teams") {
    await assertTeamsExist(input.teamIds ?? [], database);
  }

  const id = randomUUID();
  let credentials: StoredCredentials;
  let smtpSettings: SmtpSettings | null = null;

  if (preset.provider === "resend") {
    if (!input.apiKey) {
      throw new EmailAccountError("Enter the Resend API key.", 400, {
        fieldErrors: { apiKey: "Enter the Resend API key." },
      });
    }

    try {
      await verifyResendKey(input.apiKey);
    } catch (error) {
      throw verificationFailed(error, "apiKey");
    }

    credentials = { apiKey: input.apiKey, type: "api_key" };
  } else {
    smtpSettings = resolveSmtpInput(input.presetId, {
      emailAddress: input.emailAddress,
      host: input.host,
      password: input.password,
      port: input.port,
      security: input.security,
      username: input.username,
    });

    try {
      await verifySmtpSettings(smtpSettings, { env, ...smtp });
    } catch (error) {
      throw verificationFailed(error, "password");
    }

    credentials = { password: smtpSettings.password, type: "password" };
  }

  const timestamp = now();

  try {
    await withTransaction(async (tx) => {
      if (input.isDefault) {
        await tx.query(
          `UPDATE email_accounts SET is_default = false, updated_at = $1 WHERE is_default`,
          [timestamp],
        );
      }

      await tx.query(
        `
          INSERT INTO email_accounts (
            id, scope, owner_user_id, created_by_user_id, provider, preset_id,
            email_address, display_name, reply_to, status,
            encrypted_credentials, smtp_host, smtp_port, smtp_security,
            smtp_username, daily_limit, is_default, shared_with,
            last_success_at, created_at, updated_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, 'connected', $10, $11, $12,
            $13, $14, $15, $16, $17, $18, $18, $18
          )
        `,
        [
          id,
          input.scope,
          input.scope === "personal" ? actor.userId : null,
          actor.userId,
          preset.provider,
          preset.id,
          input.emailAddress,
          input.displayName,
          input.replyTo,
          sealCredentials(id, credentials, env),
          smtpSettings?.host ?? null,
          smtpSettings?.port ?? null,
          smtpSettings?.security ?? null,
          smtpSettings?.username ?? null,
          input.dailyLimit ?? null,
          input.scope === "organization" && Boolean(input.isDefault),
          sharedWith,
          timestamp,
        ],
      );

      if (sharedWith === "teams") {
        await replaceTeams(id, input.teamIds ?? [], tx);
      }
    }, database);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new EmailAccountError(
        `${input.emailAddress} is already connected.`,
        409,
        { code: "already_connected", fieldErrors: { emailAddress: "Already connected." } },
      );
    }

    throw error;
  }

  const created = (await loadAccount(id, database))!;

  return toAccountView(created, actor.userId, sharedWith === "teams" ? [...new Set(input.teamIds)].sort() : []);
}

export async function updateAccount(
  actor: AccountActor,
  accountId: string,
  rawInput: unknown,
  { database = getDb(), env = process.env, smtp }: AccountOptions = {},
): Promise<EmailAccountView> {
  const input = parse(updateAccountSchema, rawInput);
  const account = await loadManagedAccount(actor.userId, accountId, database);
  const timestamp = now();

  if (
    account.scope === "personal" &&
    (input.isDefault || (input.sharedWith && input.sharedWith !== "nobody") || input.teamIds)
  ) {
    throw new EmailAccountError(
      "A personal account is only ever yours: it cannot be shared or be the organisation's default.",
      400,
      { fieldErrors: { sharedWith: "Personal accounts are not shared." } },
    );
  }

  const sharedWith = input.sharedWith ?? account.sharedWith;

  if (sharedWith === "teams" && (input.sharedWith === "teams" || input.teamIds)) {
    await assertTeamsExist(input.teamIds ?? (await listTeamIds([account.id], database)).get(account.id) ?? [], database);
  }

  let encryptedCredentials = account.encryptedCredentials;
  let status = account.status;

  if (input.password !== undefined) {
    if (account.provider !== "smtp") {
      throw new EmailAccountError(
        "Only an SMTP account has a password. Reconnect this account instead.",
        400,
        { fieldErrors: { password: "This account does not use a password." } },
      );
    }

    const settings: SmtpSettings = {
      host: account.smtpHost ?? "",
      password: input.password,
      port: account.smtpPort ?? 0,
      security: account.smtpSecurity ?? "starttls",
      username: account.smtpUsername ?? account.emailAddress,
    };

    try {
      await verifySmtpSettings(settings, { env, ...smtp });
    } catch (error) {
      throw verificationFailed(error, "password");
    }

    encryptedCredentials = sealCredentials(
      account.id,
      { password: input.password, type: "password" },
      env,
    );
    status = "connected";
  }

  await withTransaction(async (tx) => {
    if (input.isDefault === true) {
      await tx.query(
        `UPDATE email_accounts SET is_default = false, updated_at = $1 WHERE is_default AND id <> $2`,
        [timestamp, account.id],
      );
    }

    await tx.query(
      `
        UPDATE email_accounts
        SET display_name = $2,
            reply_to = $3,
            is_default = $4,
            shared_with = $5,
            encrypted_credentials = $6,
            status = $7,
            daily_limit = $8,
            last_error = CASE WHEN $7 = 'connected' AND status <> 'connected' THEN NULL ELSE last_error END,
            updated_at = $9
        WHERE id = $1
      `,
      [
        account.id,
        input.displayName === undefined ? account.displayName : input.displayName,
        input.replyTo === undefined ? account.replyTo : input.replyTo,
        input.isDefault ?? account.isDefault,
        sharedWith,
        encryptedCredentials,
        status,
        input.dailyLimit === undefined ? account.dailyLimit : input.dailyLimit,
        timestamp,
      ],
    );

    if (sharedWith !== "teams") {
      await tx.query(`DELETE FROM email_account_teams WHERE account_id = $1`, [
        account.id,
      ]);
    } else if (input.teamIds) {
      await replaceTeams(account.id, input.teamIds, tx);
    }

    // Shared more narrowly: whoever can no longer use it stops preferring it.
    await tx.query(
      `
        DELETE FROM email_account_preferences p
        USING email_accounts a
        WHERE p.account_id = $1 AND a.id = p.account_id
          AND NOT ${USABLE_BY_USER.replaceAll("$1", "p.user_id")}
      `,
      [account.id],
    );
  }, database);

  const updated = (await loadAccount(account.id, database))!;
  const teamIds = await listTeamIds([account.id], database);

  return toAccountView(updated, actor.userId, teamIds.get(account.id) ?? []);
}

/** Removes the account. Revoking an OAuth grant is the caller's (oauth.ts). */
export async function deleteAccountRow(
  actor: AccountActor,
  accountId: string,
  database: DbPool = getDb(),
): Promise<EmailAccountRecord> {
  const account = await loadManagedAccount(actor.userId, accountId, database);

  await database.query(`DELETE FROM email_accounts WHERE id = $1`, [account.id]);

  return account;
}

/** The account for someone who may manage it, or an EmailAccountError. */
export async function requireManagedAccount(
  userId: string,
  accountId: string,
  database: DbExecutor = getDb(),
): Promise<EmailAccountRecord> {
  return loadManagedAccount(userId, accountId, database);
}

/** Notes how the account's last send went, for Settings. */
export async function recordAccountOutcome(
  accountId: string,
  outcome:
    | { ok: true }
    | { error: string; needsReconnect?: boolean; ok: false },
  database: DbExecutor = getDb(),
): Promise<void> {
  const timestamp = now();

  if (outcome.ok) {
    await database.query(
      `
        UPDATE email_accounts
        SET last_success_at = $2,
            status = CASE WHEN status = 'error' THEN 'connected' ELSE status END,
            updated_at = $2
        WHERE id = $1
      `,
      [accountId, timestamp],
    );
    return;
  }

  await database.query(
    `
      UPDATE email_accounts
      SET last_error = $2,
          last_error_at = $3,
          status = CASE WHEN $4 THEN 'needs_reconnect' ELSE status END,
          updated_at = $3
      WHERE id = $1
    `,
    [accountId, outcome.error.slice(0, 1000), timestamp, Boolean(outcome.needsReconnect)],
  );
}

export async function saveAccountCredentials(
  accountId: string,
  credentials: StoredCredentials,
  {
    database = getDb(),
    env = process.env,
  }: { database?: DbExecutor; env?: EnvSource } = {},
): Promise<void> {
  await database.query(
    `UPDATE email_accounts SET encrypted_credentials = $2, updated_at = $3 WHERE id = $1`,
    [accountId, sealCredentials(accountId, credentials, env), now()],
  );
}

/** The workspace's default organisation account, if there is one. */
export async function loadDefaultAccount(
  database: DbExecutor = getDb(),
): Promise<EmailAccountRecord | null> {
  return queryOne<EmailAccountRecord>(
    database,
    `SELECT ${ACCOUNT_COLUMNS} FROM email_accounts a WHERE a.is_default AND a.scope = 'organization'`,
  );
}
