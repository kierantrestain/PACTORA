import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  getDb,
  queryMany,
  queryOne,
  withTransaction,
  type DbPool,
} from "./db/connection.ts";
import { emailSchema, nameSchema } from "./schemas/common.ts";
import { createEmailService, type EmailService } from "./services/email.ts";
import { withUserEmailLegalFooter } from "./services/email-legal-footer.ts";
import { hashOpaqueToken, issueOpaqueToken } from "./services/opaque-tokens.ts";
import { recordSystemAuditEvent } from "./services/system-audit.ts";
import { readStoredSettings, resolveSettings } from "./settings.ts";
import { buildBranding } from "./branding.ts";
import { getEnv, type EnvSource } from "./utils/env.ts";
import { escapeHtml } from "./utils/html.ts";

// Invitations to join the workspace. An administrator invites an address;
// the link in the invitation proves that the person who opens it reads that
// mailbox, so the account it creates starts verified, whatever the sign-up
// rule says. Only a hash of the link's token is stored.
//
// The administrator always gets the link back, so a workspace with no email
// connected can still invite people: copy the link and send it yourself.

export const INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_LISTED_INVITATIONS = 200;

export type InvitationRole = "user" | "admin";
export type InvitationStatus = "pending" | "accepted" | "expired" | "revoked";

export type InvitationView = {
  createdAt: number;
  email: string;
  expiresAt: number;
  id: string;
  invitedByName: string | null;
  role: InvitationRole;
  status: InvitationStatus;
};

export type PublicInvitation = {
  accountExists: boolean;
  email: string;
  expiresAt: number;
  inviterName: string | null;
  organizationName: string;
  role: InvitationRole;
  status: InvitationStatus;
};

export class InvitationError extends Error {
  readonly code: string;
  readonly fieldErrors: Record<string, string>;
  readonly statusCode: number;

  constructor(
    message: string,
    statusCode: number,
    code: string,
    fieldErrors: Record<string, string> = {},
  ) {
    super(message);
    this.name = "InvitationError";
    this.code = code;
    this.fieldErrors = fieldErrors;
    this.statusCode = statusCode;
  }
}

type InvitationRow = {
  accepted_at: number | null;
  created_at: number;
  email: string;
  expires_at: number;
  id: string;
  invited_by_name: string | null;
  revoked_at: number | null;
  role: InvitationRole;
};

async function loadBranding(database: DbPool, env: EnvSource) {
  return buildBranding(
    resolveSettings(await readStoredSettings(database), env),
  );
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function statusOf(row: InvitationRow, now = nowSeconds()): InvitationStatus {
  if (row.accepted_at !== null) {
    return "accepted";
  }

  if (row.revoked_at !== null) {
    return "revoked";
  }

  return row.expires_at <= now ? "expired" : "pending";
}

function toView(row: InvitationRow): InvitationView {
  return {
    createdAt: Number(row.created_at),
    email: row.email,
    expiresAt: Number(row.expires_at),
    id: row.id,
    invitedByName: row.invited_by_name,
    role: row.role,
    status: statusOf(row),
  };
}

const SELECT_INVITATION = `
  select i.id, i.email, i.role, i.created_at, i.expires_at, i.accepted_at,
    i.revoked_at, u.name as invited_by_name
  from public.workspace_invitations i
  left join public."user" u on u.id = i.invited_by_user_id
`;

export const createInvitationSchema = z.object({
  email: emailSchema,
  role: z.enum(["user", "admin"]).default("user"),
});

export function buildInvitationLink(
  token: string,
  env: EnvSource = process.env,
): string {
  const appUrl = getEnv(env).appUrl ?? "http://localhost:3000";

  return new URL(`/invite/${token}`, appUrl).toString();
}

export function buildInvitationEmail(input: {
  inviterName: string;
  link: string;
  organizationName: string;
}) {
  const subject = `${input.inviterName} invited you to ${input.organizationName}`;
  const textBody = [
    `${input.inviterName} invited you to join ${input.organizationName} to prepare, send and sign documents.`,
    "",
    "Accept the invitation:",
    input.link,
    "",
    "The link works for 7 days. If you weren't expecting this, you can ignore it.",
  ].join("\n");
  const htmlBody = [
    `<p>${escapeHtml(input.inviterName)} invited you to join ${escapeHtml(input.organizationName)} to prepare, send and sign documents.</p>`,
    `<p><a href="${escapeHtml(input.link)}">Accept the invitation</a></p>`,
    "<p>The link works for 7 days. If you weren't expecting this, you can ignore it.</p>",
  ].join("");

  return { htmlBody, subject, textBody };
}

export async function listInvitations(
  database: DbPool = getDb(),
): Promise<InvitationView[]> {
  const rows = await queryMany<InvitationRow>(
    database,
    `${SELECT_INVITATION}
     where i.accepted_at is null and i.revoked_at is null
     order by i.created_at desc
     limit ${String(MAX_LISTED_INVITATIONS)}`,
  );

  return rows.map(toView);
}

export async function createInvitation(
  actor: { id: string; name: string },
  rawInput: unknown,
  {
    database = getDb(),
    emailService,
    env = process.env,
  }: {
    database?: DbPool;
    emailService?: EmailService;
    env?: EnvSource;
  } = {},
): Promise<{
  emailError: string | null;
  emailed: boolean;
  invitation: InvitationView;
  link: string;
}> {
  const parsed = createInvitationSchema.safeParse(rawInput);

  if (!parsed.success) {
    throw new InvitationError("Check the highlighted fields.", 400, "invalid", {
      email: "Enter a valid email address",
    });
  }

  const email = parsed.data.email.toLowerCase();
  const issued = issueOpaqueToken({ expiresInSeconds: INVITATION_TTL_SECONDS });
  const id = randomUUID();

  const invitation = await withTransaction(async (tx) => {
    const existing = await queryOne<{ id: string }>(
      tx,
      `select id from public."user" where lower(email) = $1`,
      [email],
    );

    if (existing) {
      throw new InvitationError(
        "This person already has an account in this workspace.",
        409,
        "account_exists",
        { email: "This address already has an account" },
      );
    }

    // Inviting again replaces the open invitation, so only the newest link
    // works.
    await tx.query(
      `update public.workspace_invitations set revoked_at = $2
       where lower(email) = $1 and accepted_at is null and revoked_at is null`,
      [email, issued.iat],
    );
    await tx.query(
      `insert into public.workspace_invitations
        (id, email, role, token_hash, invited_by_user_id, created_at, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        email,
        parsed.data.role,
        issued.tokenHash,
        actor.id,
        issued.iat,
        issued.exp,
      ],
    );

    const row = await queryOne<InvitationRow>(
      tx,
      `${SELECT_INVITATION} where i.id = $1`,
      [id],
    );

    return toView(row!);
  }, database);

  await recordSystemAuditEvent(
    {
      actorUserId: actor.id,
      event: "invitation_created",
      metadata: { email, role: parsed.data.role },
    },
    database,
  ).catch((error: unknown) => {
    console.error("[invitations] Could not record the invitation:", error);
  });

  const link = buildInvitationLink(issued.token, env);
  let emailed = false;
  let emailError: string | null = null;

  try {
    const branding = await loadBranding(database, env);
    const content = buildInvitationEmail({
      inviterName: actor.name,
      link,
      organizationName: branding.productName,
    });
    const withFooter = withUserEmailLegalFooter(content, branding, env);

    const introText = content.textBody.split("\n")[0]!;
    const introHtml = content.htmlBody.slice(0, content.htmlBody.indexOf("</p>") + 4);

    await (emailService ?? createEmailService({ env })).send(
      {
        customization: {
          introHtml,
          introText,
          variables: {
            organization_name: branding.productName,
            recipient_name: email,
            sender_name: actor.name,
          },
        },
        htmlBody: withFooter.htmlBody,
        senderUserId: actor.id,
        subject: content.subject,
        template: "workspace_invitation",
        textBody: withFooter.textBody,
        to: email,
      },
      { idempotencyKey: `workspace-invitation/${id}` },
    );
    emailed = true;
  } catch (error) {
    // The invitation stands; the administrator copies the link instead.
    emailError =
      error instanceof Error && error.message
        ? error.message
        : "The invitation email could not be sent.";
  }

  return { emailError, emailed, invitation, link };
}

export async function revokeInvitation(
  id: string,
  actorUserId: string,
  database: DbPool = getDb(),
): Promise<void> {
  const result = await database.query(
    `update public.workspace_invitations set revoked_at = $2
     where id = $1 and accepted_at is null and revoked_at is null`,
    [id, nowSeconds()],
  );

  if (result.rowCount !== 1) {
    throw new InvitationError(
      "This invitation was not found, or it has already been used.",
      404,
      "not_found",
    );
  }

  await recordSystemAuditEvent(
    {
      actorUserId,
      event: "invitation_revoked",
      metadata: { invitationId: id },
    },
    database,
  ).catch(() => undefined);
}

type TokenRow = InvitationRow & { token_hash: string };

async function findByToken(
  token: string,
  database: DbPool,
): Promise<TokenRow | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) {
    return null;
  }

  return queryOne<TokenRow>(
    database,
    `${SELECT_INVITATION.replace("i.revoked_at,", "i.revoked_at, i.token_hash,")}
     where i.token_hash = $1`,
    [hashOpaqueToken(token)],
  );
}

export async function readInvitation(
  token: string,
  {
    database = getDb(),
    env = process.env,
  }: { database?: DbPool; env?: EnvSource } = {},
): Promise<PublicInvitation | null> {
  const row = await findByToken(token, database);

  if (!row) {
    return null;
  }

  const account = await queryOne<{ id: string }>(
    database,
    `select id from public."user" where lower(email) = lower($1)`,
    [row.email],
  );
  const branding = await loadBranding(database, env);

  return {
    accountExists: account !== null,
    email: row.email,
    expiresAt: Number(row.expires_at),
    inviterName: row.invited_by_name,
    organizationName: branding.productName,
    role: row.role,
    status: statusOf(row),
  };
}

const newAccountSchema = z.object({
  name: nameSchema,
  password: z.string().min(15).max(128),
});

type CreateAccount = (input: {
  email: string;
  name: string;
  password: string;
}) => Promise<{ userId: string }>;

/**
 * Accepts an invitation, either for the signed-in person (whose address must
 * be the invited one) or by creating their account. Locked on the
 * invitation's row, so one link makes one account.
 */
export async function acceptInvitation(
  token: string,
  input: unknown,
  {
    createAccount,
    database = getDb(),
    sessionUser = null,
  }: {
    createAccount: CreateAccount;
    database?: DbPool;
    sessionUser?: { email: string; id: string } | null;
  },
): Promise<{ email: string; mode: "existing" | "created"; userId: string }> {
  const created: { userId: string | null } = { userId: null };

  try {
    return await withTransaction(async (tx) => {
      const row = await queryOne<TokenRow>(
        tx,
        `select id, email, role, created_at, expires_at, accepted_at,
           revoked_at, token_hash, null as invited_by_name
         from public.workspace_invitations
         where token_hash = $1
         for update`,
        [/^[A-Za-z0-9_-]{20,100}$/.test(token) ? hashOpaqueToken(token) : ""],
      );

      if (!row) {
        throw new InvitationError(
          "This invitation link is not valid.",
          404,
          "not_found",
        );
      }

      const status = statusOf(row);

      if (status !== "pending") {
        throw new InvitationError(
          status === "accepted"
            ? "This invitation has already been used. Sign in instead."
            : status === "expired"
              ? "This invitation has expired. Ask for a new one."
              : "This invitation was withdrawn.",
          410,
          status,
        );
      }

      const email = row.email.toLowerCase();
      let userId: string;
      let mode: "existing" | "created";

      if (sessionUser) {
        if (sessionUser.email.toLowerCase() !== email) {
          throw new InvitationError(
            `This invitation is for ${row.email}. Sign out and open the link again.`,
            403,
            "wrong_account",
          );
        }

        userId = sessionUser.id;
        mode = "existing";
      } else {
        const existing = await queryOne<{ id: string }>(
          tx,
          `select id from public."user" where lower(email) = $1`,
          [email],
        );

        if (existing) {
          throw new InvitationError(
            "You already have an account. Sign in, then open the link again.",
            409,
            "account_exists",
          );
        }

        const parsed = newAccountSchema.safeParse(input);

        if (!parsed.success) {
          const fieldErrors: Record<string, string> = {};

          for (const issue of parsed.error.issues) {
            const field = String(issue.path[0] ?? "");

            fieldErrors[field] ??=
              field === "password"
                ? "Password must be 15 to 128 characters"
                : "Enter your full name";
          }

          throw new InvitationError(
            "Check the highlighted fields.",
            400,
            "invalid",
            fieldErrors,
          );
        }

        ({ userId } = await createAccount({
          email,
          name: parsed.data.name,
          password: parsed.data.password,
        }));
        created.userId = userId;
        mode = "created";
      }

      // The link proves the address. An administrator invitation promotes;
      // nothing here ever demotes.
      await tx.query(
        `update public."user"
         set "emailVerified" = true,
             role = case when $2 = 'admin' then 'admin' else role end,
             "updatedAt" = now()
         where id = $1`,
        [userId, row.role],
      );
      await tx.query(
        `update public.workspace_invitations
         set accepted_at = $2, accepted_user_id = $3
         where id = $1`,
        [row.id, nowSeconds(), userId],
      );

      return { email, mode, userId };
    }, database);
  } catch (error) {
    // Made on its own connection, so it survives the rollback.
    if (created.userId) {
      await database
        .query(`delete from public."user" where id = $1 and role <> 'admin'`, [
          created.userId,
        ])
        .catch(() => undefined);
    }

    throw error;
  }
}
