import {
  getDb,
  queryMany,
  queryOne,
  type DbExecutor,
  type DbPool,
} from "../db/connection.ts";
import { isAdministrator } from "./accounts.ts";
import { type DeliveryStatus } from "./engine.ts";

// The delivery history shown in Settings, and the delivery records a
// person's data export and erasure cover.
//
// Who sees what: an administrator sees every delivery; anyone else sees the
// ones sent on their behalf (their envelopes, their test emails). Nobody
// sees the message itself: the subject, the recipient and the outcome only.

export type DeliveryView = {
  accountEmail: string | null;
  attempts: number;
  createdAt: number;
  envelopeId: string | null;
  id: string;
  lastError: string | null;
  nextAttemptAt: number | null;
  provider: string | null;
  recovery: string | null;
  retryable: boolean;
  sentAt: number | null;
  status: DeliveryStatus;
  stream: "platform" | "agreement";
  subject: string;
  template: string;
  toAddress: string;
};

const VIEW_COLUMNS = `
  id,
  template,
  stream,
  to_address AS "toAddress",
  subject,
  envelope_id AS "envelopeId",
  status,
  attempts,
  last_error AS "lastError",
  recovery,
  account_email AS "accountEmail",
  provider,
  next_attempt_at AS "nextAttemptAt",
  created_at AS "createdAt",
  sent_at AS "sentAt",
  (encrypted_payload IS NOT NULL AND status IN ('retrying', 'deferred')) AS retryable
`;

const PAGE_SIZE = 50;

function encodeCursor(row: { createdAt: number; id: string }): string {
  return Buffer.from(`${String(row.createdAt)}:${row.id}`).toString(
    "base64url",
  );
}

function decodeCursor(
  cursor: string | null | undefined,
): { createdAt: number; id: string } | null {
  if (!cursor) {
    return null;
  }

  const [createdAt, ...rest] = Buffer.from(cursor, "base64url")
    .toString("utf8")
    .split(":");
  const id = rest.join(":");

  return Number.isFinite(Number(createdAt)) && id
    ? { createdAt: Number(createdAt), id }
    : null;
}

export async function listDeliveries(
  userId: string,
  {
    cursor,
    database = getDb(),
    search,
    status,
  }: {
    cursor?: string | null;
    database?: DbExecutor;
    search?: string | null;
    status?: string | null;
  } = {},
): Promise<{ deliveries: DeliveryView[]; nextCursor: string | null }> {
  const admin = await isAdministrator(userId, database);
  const after = decodeCursor(cursor);
  const parameters: unknown[] = [];
  const where: string[] = [];

  if (!admin) {
    parameters.push(userId);
    where.push(`sender_user_id = $${String(parameters.length)}`);
  }

  if (after) {
    parameters.push(after.createdAt, after.id);
    where.push(
      `(created_at, id) < ($${String(parameters.length - 1)}, $${String(parameters.length)})`,
    );
  }

  if (
    status &&
    [
      "sent",
      "failed",
      "retrying",
      "deferred",
      "superseded",
      "sending",
    ].includes(status)
  ) {
    parameters.push(status);
    where.push(`status = $${String(parameters.length)}`);
  }

  const term = search?.trim().slice(0, 200);

  if (term) {
    parameters.push(`%${term.replace(/[\\%_]/g, (match) => `\\${match}`)}%`);
    where.push(
      `(to_address ILIKE $${String(parameters.length)} OR subject ILIKE $${String(parameters.length)})`,
    );
  }

  parameters.push(PAGE_SIZE + 1);

  const rows = await queryMany<DeliveryView>(
    database,
    `
      SELECT ${VIEW_COLUMNS}
      FROM email_deliveries
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC, id DESC
      LIMIT $${String(parameters.length)}
    `,
    parameters,
  );
  const page = rows.slice(0, PAGE_SIZE).map((row) => ({
    ...row,
    attempts: Number(row.attempts),
    createdAt: Number(row.createdAt),
    nextAttemptAt:
      row.nextAttemptAt === null ? null : Number(row.nextAttemptAt),
    sentAt: row.sentAt === null ? null : Number(row.sentAt),
  }));

  return {
    deliveries: page,
    nextCursor:
      rows.length > PAGE_SIZE ? encodeCursor(page[page.length - 1]!) : null,
  };
}

/**
 * The delivery, when this person may retry it: an administrator, or the
 * person it was sent for. Anything else reads as missing.
 */
export async function loadRetryableDelivery(
  userId: string,
  deliveryId: string,
  database: DbExecutor = getDb(),
): Promise<{ id: string; retryable: boolean } | null> {
  const admin = await isAdministrator(userId, database);
  const row = await queryOne<{
    id: string;
    retryable: boolean;
    senderUserId: string | null;
  }>(
    database,
    `
      SELECT id, sender_user_id AS "senderUserId",
        (encrypted_payload IS NOT NULL AND status IN ('retrying', 'deferred')) AS retryable
      FROM email_deliveries WHERE id = $1
    `,
    [deliveryId],
  );

  if (!row || (!admin && row.senderUserId !== userId)) {
    return null;
  }

  return { id: row.id, retryable: row.retryable };
}

// --- Personal data --------------------------------------------------------

export type DeliveryExportRecord = {
  createdAt: number;
  direction: "sent_to_you" | "sent_for_you";
  id: string;
  sentAt: number | null;
  status: string;
  subject: string;
  template: string;
  toAddress: string;
};

/**
 * The delivery records about a person, for their data export: the mail
 * sent to their address, and the mail sent on their behalf. Never the
 * stored message of a pending retry.
 */
export async function exportDeliveriesFor(
  person: { email: string; userId?: string | null },
  database: DbExecutor = getDb(),
): Promise<DeliveryExportRecord[]> {
  const rows = await queryMany<DeliveryExportRecord & { forYou: boolean }>(
    database,
    `
      SELECT id, template, subject, to_address AS "toAddress", status,
        created_at AS "createdAt", sent_at AS "sentAt",
        (sender_user_id IS NOT NULL AND sender_user_id = $2) AS "forYou"
      FROM email_deliveries
      WHERE lower(to_address) = lower($1) OR ($2::text IS NOT NULL AND sender_user_id = $2)
      ORDER BY created_at, id
    `,
    [person.email, person.userId ?? null],
  );

  return rows.map(({ forYou, ...row }) => ({
    ...row,
    createdAt: Number(row.createdAt),
    direction:
      forYou && row.toAddress.toLowerCase() !== person.email.toLowerCase()
        ? "sent_for_you"
        : "sent_to_you",
    sentAt: row.sentAt === null ? null : Number(row.sentAt),
  }));
}

/**
 * Erases an address from the delivery log: the address and subject are
 * replaced, any stored retry is dropped, and the row stays only as a count
 * of what happened. Deliveries about envelopes under a legal hold keep the
 * address, which is part of that envelope's record; the caller decides on
 * those through the envelope's own erasure rules.
 */
export async function eraseDeliveriesFor(
  email: string,
  {
    database = getDb(),
    keepEnvelopeIds = [],
  }: {
    database?: DbPool | DbExecutor;
    keepEnvelopeIds?: readonly string[];
  } = {},
): Promise<number> {
  const result = await database.query(
    `
      UPDATE email_deliveries
      SET to_address = 'erased', subject = 'erased', encrypted_payload = NULL,
          last_error = NULL, recovery = NULL, provider_message_id = NULL,
          status = CASE WHEN status IN ('retrying', 'deferred', 'sending') THEN 'superseded' ELSE status END,
          next_attempt_at = NULL,
          updated_at = $2
      WHERE lower(to_address) = lower($1)
        AND (envelope_id IS NULL OR NOT (envelope_id = ANY($3::text[])))
    `,
    [email, Math.floor(Date.now() / 1000), keepEnvelopeIds],
  );

  return result.rowCount ?? 0;
}

/** Drops delivery history older than the retention window. */
export async function pruneDeliveries(
  olderThanSeconds: number,
  database: DbExecutor = getDb(),
): Promise<number> {
  const result = await database.query(
    `
      DELETE FROM email_deliveries
      WHERE created_at < $1 AND status IN ('sent', 'failed', 'superseded')
    `,
    [Math.floor(Date.now() / 1000) - olderThanSeconds],
  );

  return result.rowCount ?? 0;
}
