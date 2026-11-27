import {
  eraseDeliveriesFor,
  exportDeliveriesFor,
  type DeliveryExportRecord,
} from "./email/deliveries.ts";
import {
  type DbExecutor,
  type DbPool,
  getDb,
  queryMany,
  withTransaction,
} from "./db/connection.ts";
import { deleteEnvelopesAndFiles } from "./retention.ts";
import { emailSchema } from "./schemas/common.ts";
import { isMissingSchemaError } from "./settings.ts";

// What an administrator needs to answer a signer who asks for their data
// (GDPR Articles 15 and 20) or for it to be erased (Article 17).
//
// A signed document holds every party's signature, and its seal breaks if
// any part is removed, so erasure works on whole envelopes. Envelopes still
// out for signature are never touched: void them first.

export class SignerDataError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "SignerDataError";
    this.statusCode = statusCode;
  }
}

type SignerEnvelopeRow = {
  declineReason: string | null;
  declinedAt: number | null;
  envelopeCreatedAt: number;
  envelopeId: string;
  envelopeStatus: string;
  envelopeTitle: string;
  /** Sent in Part 11 mode: never erased here. */
  part11: boolean;
  signedAt: number | null;
  signerEmail: string;
  signerId: string;
  signerName: string;
  signerStatus: string;
  /** "signer", "approver", or "cc" for someone who only received a copy. */
  role: string;
};

export type SignerWebhookPayload = {
  copyRecipients?: Record<string, unknown>[];
  envelopeStatus?: string;
  envelopeTitle?: string;
  reason?: string;
  signer?: Record<string, unknown>;
  signers?: Record<string, unknown>[];
  timestamp?: string;
  type?: string;
};

export type SignerWebhookDeliveryRow = {
  createdAt: number;
  deliveredAt: number | null;
  endpointId: string;
  envelopeId: string | null;
  eventType: string;
  id: string;
  /**
   * The parts of the stored JSON payload that belong to this signer, or null
   * when a pending delivery has not built its payload yet.
   */
  payload: SignerWebhookPayload | null;
  status: string;
};

type StoredWebhookDeliveryRow = {
  createdAt: number;
  deliveredAt: number | null;
  endpointId: string;
  envelopeId: string | null;
  eventType: string;
  id: string;
  payload: string | null;
  status: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordMatchesEmail(
  record: Record<string, unknown>,
  normalizedEmail: string,
): boolean {
  return (
    typeof record.email === "string" &&
    record.email.trim().toLowerCase() === normalizedEmail
  );
}

/**
 * Checks whether a stored webhook delivery payload names `rawEmail` as a
 * signer, approver or copy recipient, and returns only that person's own
 * portions of the payload (leaving out other parties, owner details and
 * internal envelope metadata).
 */
export function extractSignerWebhookPayload(
  rawPayload: string | null,
  rawEmail: string,
): { matched: boolean; payload: SignerWebhookPayload | null } {
  if (rawPayload === null) {
    return { matched: false, payload: null };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(rawPayload);
  } catch {
    return { matched: false, payload: null };
  }

  if (!isRecord(parsed) || !isRecord(parsed.data)) {
    return { matched: false, payload: null };
  }

  const normalizedEmail = rawEmail.trim().toLowerCase();
  const data = parsed.data;
  const envelope = isRecord(data.envelope) ? data.envelope : null;
  const matchingSigners = Array.isArray(envelope?.signers)
    ? envelope.signers.filter(
        (entry): entry is Record<string, unknown> =>
          isRecord(entry) && recordMatchesEmail(entry, normalizedEmail),
      )
    : [];
  const matchingCopyRecipients = Array.isArray(envelope?.copyRecipients)
    ? envelope.copyRecipients.filter(
        (entry): entry is Record<string, unknown> =>
          isRecord(entry) && recordMatchesEmail(entry, normalizedEmail),
      )
    : [];
  const matchingSigner =
    isRecord(data.signer) && recordMatchesEmail(data.signer, normalizedEmail)
      ? data.signer
      : undefined;

  if (
    matchingSigners.length === 0 &&
    matchingCopyRecipients.length === 0 &&
    !matchingSigner
  ) {
    return { matched: false, payload: null };
  }

  const payload: SignerWebhookPayload = {};

  if (typeof parsed.type === "string") {
    payload.type = parsed.type;
  }

  if (typeof parsed.timestamp === "string") {
    payload.timestamp = parsed.timestamp;
  }

  if (typeof envelope?.title === "string") {
    payload.envelopeTitle = envelope.title;
  }

  if (typeof envelope?.status === "string") {
    payload.envelopeStatus = envelope.status;
  }

  if (matchingSigners.length > 0) {
    payload.signers = matchingSigners;
  }

  if (matchingCopyRecipients.length > 0) {
    payload.copyRecipients = matchingCopyRecipients;
  }

  if (matchingSigner) {
    payload.signer = matchingSigner;
  }

  if (
    parsed.type === "envelope.declined" &&
    matchingSigner &&
    typeof data.reason === "string" &&
    data.reason.length > 0
  ) {
    payload.reason = data.reason;
  }

  return { matched: true, payload };
}

function parseEmail(email: unknown): string {
  const parsed = emailSchema.safeParse(email);

  if (!parsed.success) {
    throw new SignerDataError("Enter the signer's email address.");
  }

  return parsed.data.toLowerCase();
}

async function listSignerEnvelopes(
  email: string,
  database: DbExecutor,
): Promise<SignerEnvelopeRow[]> {
  return queryMany<SignerEnvelopeRow>(
    database,
    `
      SELECT
        s.id AS "signerId",
        s.name AS "signerName",
        s.email AS "signerEmail",
        s.status AS "signerStatus",
        s.role AS "role",
        s.signed_at AS "signedAt",
        s.declined_at AS "declinedAt",
        s.decline_reason AS "declineReason",
        e.id AS "envelopeId",
        e.title AS "envelopeTitle",
        e.status AS "envelopeStatus",
        e.part11,
        e.created_at AS "envelopeCreatedAt"
      FROM signers s
      JOIN envelopes e ON e.id = s.envelope_id
      WHERE lower(s.email) = $1
      ORDER BY e.created_at ASC, e.id ASC
    `,
    [email],
  );
}

/**
 * Stored webhook deliveries the install holds for this signer: pending ones
 * queued for their envelopes, and any delivery whose stored JSON payload names
 * them (including deliveries whose envelope was deleted earlier).
 */
async function listSignerWebhookDeliveries(
  email: string,
  envelopeIds: readonly string[],
  database: DbExecutor,
): Promise<SignerWebhookDeliveryRow[]> {
  let rows: StoredWebhookDeliveryRow[];

  try {
    rows = await queryMany<StoredWebhookDeliveryRow>(
      database,
      `
        SELECT
          id,
          endpoint_id AS "endpointId",
          envelope_id AS "envelopeId",
          event_type AS "eventType",
          status,
          payload,
          created_at AS "createdAt",
          delivered_at AS "deliveredAt"
        FROM webhook_deliveries
        WHERE event_type <> 'webhook.test'
          AND (
            envelope_id = ANY($1::text[])
            OR (payload IS NOT NULL AND strpos(lower(payload), $2) > 0)
          )
        ORDER BY created_at ASC, id ASC
      `,
      [envelopeIds, email],
    );
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return [];
    }

    throw error;
  }

  const signerEnvelopeIds = new Set(envelopeIds);
  const deliveries: SignerWebhookDeliveryRow[] = [];

  for (const row of rows) {
    if (row.payload === null) {
      if (row.envelopeId !== null && signerEnvelopeIds.has(row.envelopeId)) {
        deliveries.push({
          createdAt: row.createdAt,
          deliveredAt: row.deliveredAt,
          endpointId: row.endpointId,
          envelopeId: row.envelopeId,
          eventType: row.eventType,
          id: row.id,
          payload: null,
          status: row.status,
        });
      }

      continue;
    }

    const extracted = extractSignerWebhookPayload(row.payload, email);

    if (extracted.matched) {
      deliveries.push({
        createdAt: row.createdAt,
        deliveredAt: row.deliveredAt,
        endpointId: row.endpointId,
        envelopeId: row.envelopeId,
        eventType: row.eventType,
        id: row.id,
        payload: extracted.payload,
        status: row.status,
      });
    }
  }

  return deliveries;
}

/**
 * Deletes stored webhook deliveries for erased envelopes (including pending
 * retries so stale signer data is never sent later) as well as deliveries whose
 * stored payload names this signer for already-deleted envelopes or non-Part-11
 * envelopes they are no longer on. Active and Part 11 envelopes stay intact.
 */
async function deleteSignerWebhookDeliveries(
  email: string,
  erasedEnvelopeIds: readonly string[],
  database: DbExecutor,
  options?: { inTransaction?: boolean },
): Promise<number> {
  const useSavepoint = options?.inTransaction === true;

  if (useSavepoint) {
    await database.query("SAVEPOINT signer_webhook_cleanup");
  }

  try {
    const candidates = await queryMany<{ id: string; payload: string }>(
      database,
      `
        SELECT wd.id, wd.payload
        FROM webhook_deliveries wd
        WHERE wd.event_type <> 'webhook.test'
          AND wd.payload IS NOT NULL
          AND strpos(lower(wd.payload), $1) > 0
          AND NOT EXISTS (
            SELECT 1 FROM envelopes e
            WHERE e.id = wd.envelope_id AND e.part11
          )
          AND NOT EXISTS (
            SELECT 1 FROM envelopes e
            JOIN signers s ON s.envelope_id = e.id
            WHERE e.id = wd.envelope_id AND lower(s.email) = $1
          )
      `,
      [email],
    );
    const matchingPayloadIds = candidates
      .filter((row) => extractSignerWebhookPayload(row.payload, email).matched)
      .map((row) => row.id);

    if (erasedEnvelopeIds.length === 0 && matchingPayloadIds.length === 0) {
      if (useSavepoint) {
        await database.query("RELEASE SAVEPOINT signer_webhook_cleanup");
      }

      return 0;
    }

    const deleted = await database.query(
      `
        DELETE FROM webhook_deliveries
        WHERE (
          webhook_deliveries.envelope_id = ANY($1::text[])
          AND NOT EXISTS (
            SELECT 1 FROM envelopes e
            WHERE e.id = webhook_deliveries.envelope_id
          )
        )
        OR (
          webhook_deliveries.id = ANY($2::text[])
          AND NOT EXISTS (
            SELECT 1 FROM envelopes e
            WHERE e.id = webhook_deliveries.envelope_id AND e.part11
          )
          AND NOT EXISTS (
            SELECT 1 FROM envelopes e
            JOIN signers s ON s.envelope_id = e.id
            WHERE e.id = webhook_deliveries.envelope_id AND lower(s.email) = $3
          )
        )
      `,
      [erasedEnvelopeIds, matchingPayloadIds, email],
    );

    if (useSavepoint) {
      await database.query("RELEASE SAVEPOINT signer_webhook_cleanup");
    }

    return deleted.rowCount ?? 0;
  } catch (error) {
    if (isMissingSchemaError(error)) {
      if (useSavepoint) {
        await database.query("ROLLBACK TO SAVEPOINT signer_webhook_cleanup");
        await database.query("RELEASE SAVEPOINT signer_webhook_cleanup");
      }

      return 0;
    }

    throw error;
  }
}

export type SignerDataExport = {
  auditEvents: Record<string, unknown>[];
  email: string;
  /** The delivery log's records of mail sent to this address (no message bodies). */
  emailDeliveries: DeliveryExportRecord[];
  envelopes: SignerEnvelopeRow[];
  exportedAt: string;
  fields: Record<string, unknown>[];
  note: string;
  webhookDeliveries: SignerWebhookDeliveryRow[];
};

/** Everything stored about one signer email, as JSON. */
export async function exportSignerData(
  rawEmail: unknown,
  database: DbExecutor = getDb(),
): Promise<SignerDataExport> {
  const email = parseEmail(rawEmail);
  const envelopes = await listSignerEnvelopes(email, database);
  const signerIds = envelopes.map((row) => row.signerId);
  const envelopeIds = envelopes.map((row) => row.envelopeId);
  const [fields, auditEvents, webhookDeliveries, emailDeliveries] = await Promise.all([
    queryMany<Record<string, unknown>>(
      database,
      `
        SELECT
          envelope_id AS "envelopeId",
          type,
          label,
          input_method AS "inputMethod",
          value,
          checked,
          image_key IS NOT NULL AS "hasImage",
          submitted_at AS "submittedAt"
        FROM fields
        WHERE signer_id = ANY($1::text[])
        ORDER BY envelope_id, page, y, x
      `,
      [signerIds],
    ),
    queryMany<Record<string, unknown>>(
      database,
      `
        SELECT
          envelope_id AS "envelopeId",
          event,
          actor_type AS "actorType",
          actor_email AS "actorEmail",
          ip_address AS "ipAddress",
          user_agent AS "userAgent",
          metadata,
          created_at AS "createdAt"
        FROM audit_events
        WHERE envelope_id = ANY($1::text[])
          AND (lower(actor_email) = $2 OR metadata->>'signerId' = ANY($3::text[]))
        ORDER BY created_at, sequence NULLS LAST
      `,
      [envelopeIds, email, signerIds],
    ),
    listSignerWebhookDeliveries(email, envelopeIds, database),
    exportDeliveriesFor({ email }, database).catch((error: unknown) => {
      if (isMissingSchemaError(error)) {
        return [];
      }

      throw error;
    }),
  ]);

  return {
    auditEvents,
    email,
    emailDeliveries,
    envelopes,
    exportedAt: new Date().toISOString(),
    fields,
    note: "Signed PDFs and audit certificates are not included here. Download them from each envelope, or ask the sender.",
    webhookDeliveries,
  };
}

export type SignerErasureResult = {
  deletedEnvelopes: number;
  /** Delivery log records whose address and subject were erased. */
  erasedEmailDeliveries?: number;
  /** Stored webhook deliveries deleted for this signer, when any were removed. */
  deletedWebhookDeliveries?: number;
  /** Part 11 records, which an erasure request does not delete. */
  keptPart11: { id: string; title: string }[];
  removedFromDrafts: number;
  skippedInProgress: { id: string; title: string }[];
};

/**
 * Erases one signer email: drops them from drafts and deletes every
 * finished envelope they took part in, with its files, audit trail and
 * stored webhook deliveries. The caller must have confirmed that no law
 * requires those records kept.
 */
export async function eraseSignerData(
  rawEmail: unknown,
  confirmation: unknown,
  database: DbPool = getDb(),
): Promise<SignerErasureResult> {
  const email = parseEmail(rawEmail);

  if (
    typeof confirmation !== "string" ||
    confirmation.trim().toLowerCase() !== email
  ) {
    throw new SignerDataError(
      "Type the signer's email address again to confirm.",
    );
  }

  const envelopes = await listSignerEnvelopes(email, database);
  const drafts = envelopes.filter((row) => row.envelopeStatus === "draft");
  const allFinished = envelopes.filter((row) =>
    ["completed", "declined", "voided"].includes(row.envelopeStatus),
  );
  // Part 11 records are kept for as long as their own rules require, which
  // an erasure request does not override. They are reported instead.
  const keptPart11 = allFinished.filter((row) => row.part11);
  const finished = allFinished.filter((row) => !row.part11);
  const inProgress = envelopes.filter((row) => row.envelopeStatus === "sent");

  // Lock the drafts and look again, at their status and at who is on them.
  // The list above was read a moment ago: a draft that was sent since is
  // skipped, not stripped of a signer mid-signing, and a signer's row that
  // was given someone else's address since is left alone. Saving a draft's
  // signers takes the same lock on the envelope first, so no save is half
  // done while the rows are read here.
  const draftEnvelopeIds = [...new Set(drafts.map((row) => row.envelopeId))];
  const erasedFromDrafts =
    draftEnvelopeIds.length === 0
      ? { removed: 0, stillDrafts: new Set<string>() }
      : await withTransaction(async (tx) => {
          const stillDrafts = await tx.query<{ id: string }>(
            `
              SELECT id FROM envelopes
              WHERE id = ANY($1::text[]) AND status = 'draft'
              FOR UPDATE
            `,
            [draftEnvelopeIds],
          );
          const draftIds = stillDrafts.rows.map((row) => row.id);
          const signers = await tx.query<{ id: string }>(
            `
              SELECT id FROM signers
              WHERE envelope_id = ANY($1::text[]) AND lower(email) = $2
              FOR UPDATE
            `,
            [draftIds, email],
          );
          const signerIds = signers.rows.map((row) => row.id);

          await tx.query(
            `DELETE FROM fields WHERE signer_id = ANY($1::text[])`,
            [signerIds],
          );
          await tx.query(`DELETE FROM signers WHERE id = ANY($1::text[])`, [
            signerIds,
          ]);

          return { removed: signerIds.length, stillDrafts: new Set(draftIds) };
        }, database);
  const raced = drafts.filter(
    (row) => !erasedFromDrafts.stillDrafts.has(row.envelopeId),
  );

  // A send-to-many batch keeps why a row failed, and that reason can name
  // the signer (a Part 11 account problem does). Clear it for every
  // envelope they are on, before finished ones are deleted and the row
  // loses its link to them.
  await database.query(
    `
      UPDATE bulk_send_batch_rows
      SET reason = NULL
      WHERE reason IS NOT NULL AND envelope_id = ANY($1::text[])
    `,
    [[...new Set(envelopes.map((row) => row.envelopeId))]],
  );

  const finishedEnvelopeIds = [
    ...new Set(finished.map((row) => row.envelopeId)),
  ];
  let deletedWebhookDeliveries = 0;
  // webhook_deliveries has no foreign key to envelopes, so delete both in the
  // same transaction when removing finished envelopes. An interruption or DB
  // error therefore rolls back both deletions instead of leaving webhook
  // payloads orphaned behind already-deleted envelopes.
  const deletedEnvelopes =
    finishedEnvelopeIds.length > 0
      ? await deleteEnvelopesAndFiles(
          finishedEnvelopeIds,
          database,
          undefined,
          {
            afterDeleteRows: async (tx) => {
              deletedWebhookDeliveries = await deleteSignerWebhookDeliveries(
                email,
                finishedEnvelopeIds,
                tx,
                { inTransaction: true },
              );
            },
          },
        )
      : 0;

  if (finishedEnvelopeIds.length === 0) {
    deletedWebhookDeliveries = await deleteSignerWebhookDeliveries(
      email,
      [],
      database,
    );
  }

  // The delivery log names the address too. Records about envelopes that
  // are kept (in progress, or Part 11) keep it with them; every other
  // record keeps only that a message was sent.
  const erasedEmailDeliveries = await eraseDeliveriesFor(email, {
    database,
    keepEnvelopeIds: [
      ...keptPart11.map((row) => row.envelopeId),
      ...inProgress.map((row) => row.envelopeId),
      ...raced.map((row) => row.envelopeId),
    ],
  }).catch((error: unknown) => {
    if (isMissingSchemaError(error)) {
      return 0;
    }

    throw error;
  });

  return {
    deletedEnvelopes,
    ...(deletedWebhookDeliveries > 0 ? { deletedWebhookDeliveries } : {}),
    ...(erasedEmailDeliveries > 0 ? { erasedEmailDeliveries } : {}),
    keptPart11: keptPart11.map((row) => ({
      id: row.envelopeId,
      title: row.envelopeTitle,
    })),
    removedFromDrafts: erasedFromDrafts.removed,
    skippedInProgress: [...inProgress, ...raced].map((row) => ({
      id: row.envelopeId,
      title: row.envelopeTitle,
    })),
  };
}
