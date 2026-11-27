import { getDb, queryOne, type DbPool } from "../db/connection.ts";
import { getBranding } from "../settings.ts";
import { type EnvSource } from "../utils/env.ts";
import { escapeHtml } from "../utils/html.ts";
import {
  deleteAccountRow,
  getPreferredAccountId,
  loadAccount,
  requireManagedAccount,
  setPreferredAccount,
  type AccountActor,
} from "./accounts.ts";
import { wakeDeferredDeliveries } from "./engine.ts";
import { revokeAccountGrant, type OAuthOptions } from "./oauth.ts";

// The account actions Settings > Email & Integrations offers, on top of
// accounts.ts and oauth.ts.

/** Disconnects a mailbox: withdraws PACTORA's access where the provider allows, then forgets it. */
export async function disconnectAccount(
  actor: AccountActor,
  accountId: string,
  options: OAuthOptions & { database?: DbPool } = {},
): Promise<{ note: string | null; revoked: boolean }> {
  const database = options.database ?? getDb();
  const account = await requireManagedAccount(
    actor.userId,
    accountId,
    database,
  );
  const revocation = await revokeAccountGrant(account, options);

  await deleteAccountRow(actor, account.id, database);

  return revocation;
}

/**
 * After a mailbox is connected or reconnected: a person's first mailbox
 * becomes the one their agreements go out through, the workspace's first
 * organisation mailbox becomes its default (shared with everyone), and
 * messages that were waiting for it are tried again now.
 */
export async function settleConnectedAccount(
  actor: AccountActor,
  accountId: string,
  database: DbPool = getDb(),
): Promise<void> {
  const account = await loadAccount(accountId, database);

  if (!account) {
    return;
  }

  if (account.scope === "personal" && account.ownerUserId === actor.userId) {
    if (!(await getPreferredAccountId(actor.userId, database))) {
      await setPreferredAccount(actor.userId, account.id, database);
    }
  } else if (account.scope === "organization") {
    const existingDefault = await queryOne<{ id: string }>(
      database,
      `SELECT id FROM email_accounts WHERE is_default`,
    );

    if (!existingDefault) {
      await database.query(
        `UPDATE email_accounts SET is_default = true, shared_with = 'everyone', updated_at = $2 WHERE id = $1`,
        [account.id, Math.floor(Date.now() / 1000)],
      );
    }
  }

  await wakeDeferredDeliveries(account.id, database);
}

/** The test message sent through one mailbox to the person asking. */
export async function buildAccountTestMessage(
  actor: AccountActor,
  accountId: string,
  env: EnvSource = process.env,
) {
  const branding = await getBranding(env);
  const account = await loadAccount(accountId);
  const mailbox = account?.emailAddress ?? "your mailbox";

  return {
    accountId,
    htmlBody: [
      `<p>Hi ${escapeHtml(actor.name)},</p>`,
      `<p>This test message was sent by ${escapeHtml(branding.productName)} through ${escapeHtml(mailbox)}. If you are reading it, this mailbox can send your agreements.</p>`,
    ].join(""),
    senderUserId: actor.userId,
    subject: `Test email from ${branding.productName}`,
    template: "test_email" as const,
    textBody: [
      `Hi ${actor.name},`,
      "",
      `This test message was sent by ${branding.productName} through ${mailbox}. If you are reading it, this mailbox can send your agreements.`,
    ].join("\n"),
    to: actor.email,
  };
}
