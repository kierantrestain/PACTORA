import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { QueryResult, QueryResultRow } from "pg";

import type { DbPool } from "./db/connection.ts";
import {
  identifyRetentionCaller,
  isCronLockedOutByOlderSecret,
  retentionJobFailed,
  retentionSweepFailed,
  runRetentionJob,
} from "./retention-job.ts";
import {
  runRetentionSweep,
  STALE_DRAFT_RETENTION_DAYS,
  type RetentionSweepSummary,
} from "./retention.ts";
import {
  createStorageService,
  type StorageService,
} from "./services/storage.ts";
import {
  buildEnvelopeCertificateKey,
  buildEnvelopeOriginalPdfKey,
  buildEnvelopeSignedPdfKey,
  buildEnvelopeThumbnailKey,
  buildSignatureImageKey,
  buildTemplatePdfKey,
  getRecipientCertificateKey,
} from "./services/storage-keys.ts";

// Running the job itself, with its lock and its hourly ration, is checked
// against a real Postgres in retention-job.dbtest.ts. The tests below also
// exercise the retry queue and failure reporting end-to-end with an in-memory
// transactional pool and local file storage.

type FakeUserRow = {
  email: string;
  id: string;
  role: "admin" | "user";
};

type FakeClosureRow = {
  exportExpiresAt: number;
  purgeAfterAt: number;
  requestedAt: number;
  updatedAt: number;
  userId: string;
};

type FakeEnvelopeRow = {
  evidenceKey: string | null;
  id: string;
  part11: boolean;
  signedPdfKey: string | null;
  sourcePdfKey: string;
  status: "completed" | "declined" | "draft" | "sent" | "voided";
  updatedAt: number;
  userId: string;
};

type FakeTemplateRow = {
  id: string;
  sourcePdfKey: string;
  userId: string;
};

type FakePendingDeletionRow = {
  envelopeId: string;
  lastTriedAt: number | null;
  queuedAt: number;
  storageKey: string;
};

type FakeFieldImageRow = {
  envelopeId: string;
  imageKey: string;
};

type FakeState = {
  closures: FakeClosureRow[];
  envelopes: FakeEnvelopeRow[];
  fieldImages: FakeFieldImageRow[];
  pendingFileDeletions: FakePendingDeletionRow[];
  templates: FakeTemplateRow[];
  users: FakeUserRow[];
};

function cloneState(state: FakeState): FakeState {
  return {
    closures: state.closures.map((row) => ({ ...row })),
    envelopes: state.envelopes.map((row) => ({ ...row })),
    fieldImages: state.fieldImages.map((row) => ({ ...row })),
    pendingFileDeletions: state.pendingFileDeletions.map((row) => ({ ...row })),
    templates: state.templates.map((row) => ({ ...row })),
    users: state.users.map((row) => ({ ...row })),
  };
}

function queryResult<T extends QueryResultRow>(
  rows: T[],
  rowCount = rows.length,
): QueryResult<T> {
  return {
    command: "",
    fields: [],
    oid: 0,
    rowCount,
    rows,
  };
}

type FakeDatabaseHooks = {
  beforeQuery?: (
    sql: string,
    values: readonly unknown[],
    state: FakeState,
  ) => void;
};

function createFakeRetentionPool(
  initial: Partial<FakeState> = {},
  hooks: FakeDatabaseHooks = {},
) {
  let committed: FakeState = {
    closures: [],
    envelopes: [],
    fieldImages: [],
    pendingFileDeletions: [],
    templates: [],
    users: [],
    ...initial,
  };
  const executedTransactions: string[][] = [];

  function runQuery(
    state: FakeState,
    text: string,
    values: readonly unknown[] = [],
  ): QueryResult<QueryResultRow> {
    const sql = text.replace(/\s+/g, " ").trim();

    hooks.beforeQuery?.(sql, values, state);

    if (sql.toLowerCase().startsWith("select pg_try_advisory_xact_lock")) {
      return queryResult([{ locked: true }]);
    }

    if (sql.toLowerCase().startsWith("select pg_advisory_xact_lock")) {
      return queryResult([]);
    }

    if (
      sql.startsWith("SELECT ") &&
      sql.includes("FROM pending_file_deletions")
    ) {
      const limit = Number(values[0] ?? 500);
      const ordered = [...state.pendingFileDeletions]
        .sort((a, b) => {
          if (a.lastTriedAt === null && b.lastTriedAt !== null) {
            return -1;
          }

          if (a.lastTriedAt !== null && b.lastTriedAt === null) {
            return 1;
          }

          if (
            a.lastTriedAt !== null &&
            b.lastTriedAt !== null &&
            a.lastTriedAt !== b.lastTriedAt
          ) {
            return a.lastTriedAt - b.lastTriedAt;
          }

          if (a.queuedAt !== b.queuedAt) {
            return a.queuedAt - b.queuedAt;
          }

          return a.storageKey.localeCompare(b.storageKey);
        })
        .slice(0, limit)
        .map((row) => ({ storageKey: row.storageKey }));

      return queryResult(ordered);
    }

    if (sql.startsWith("INSERT INTO pending_file_deletions")) {
      if (sql.includes("unnest($1::text[], $2::text[])")) {
        const keys = values[0] as string[];
        const envelopeIds = values[1] as string[];
        const queuedAt = Number(values[2]);

        for (let i = 0; i < keys.length; i += 1) {
          const storageKey = keys[i]!;
          const envelopeId = envelopeIds[i]!;

          if (
            !state.pendingFileDeletions.some(
              (row) => row.storageKey === storageKey,
            )
          ) {
            state.pendingFileDeletions.push({
              envelopeId,
              lastTriedAt: null,
              queuedAt,
              storageKey,
            });
          }
        }

        return queryResult([], keys.length);
      }

      const keys = values[0] as string[];
      const envelopeId = String(values[1]);
      const queuedAt = Number(values[2]);

      for (const storageKey of keys) {
        if (
          !state.pendingFileDeletions.some(
            (row) => row.storageKey === storageKey,
          )
        ) {
          state.pendingFileDeletions.push({
            envelopeId,
            lastTriedAt: null,
            queuedAt,
            storageKey,
          });
        }
      }

      return queryResult([], keys.length);
    }

    if (sql.startsWith("DELETE FROM pending_file_deletions")) {
      const storageKey = String(values[0]);
      const before = state.pendingFileDeletions.length;

      state.pendingFileDeletions = state.pendingFileDeletions.filter(
        (row) => row.storageKey !== storageKey,
      );

      return queryResult([], before - state.pendingFileDeletions.length);
    }

    if (sql.startsWith("UPDATE pending_file_deletions SET last_tried_at")) {
      const storageKey = String(values[0]);
      const triedAt = Number(values[1]);
      let updated = 0;

      for (const row of state.pendingFileDeletions) {
        if (row.storageKey === storageKey) {
          row.lastTriedAt = triedAt;
          updated += 1;
        }
      }

      return queryResult([], updated);
    }

    if (
      sql.includes("FROM envelopes WHERE status = 'draft' AND updated_at < $1")
    ) {
      const staleBefore = Number(values[0]);
      const rows = state.envelopes
        .filter((row) => row.status === "draft" && row.updatedAt < staleBefore)
        .map((row) => ({ ...row }));

      return queryResult(rows);
    }

    if (sql.includes("FROM fields WHERE envelope_id IN")) {
      const ids = new Set(values.map(String));
      const rows = state.fieldImages
        .filter((row) => ids.has(row.envelopeId))
        .map((row) => ({ ...row }));

      return queryResult(rows);
    }

    if (sql.includes("FROM \"user\" u WHERE u.id <> $1 AND u.role = 'admin'")) {
      const exceptUserId = String(values[0]);
      const closingIds = new Set(state.closures.map((row) => row.userId));
      const keeper = state.users.find(
        (row) =>
          row.id !== exceptUserId &&
          row.role === "admin" &&
          !closingIds.has(row.id),
      );

      return queryResult(keeper ? [{ id: keeper.id }] : []);
    }

    if (sql.startsWith("UPDATE envelopes e SET user_id = k.id")) {
      const keeperId = String(values[0]);
      const userId = String(values[1]);
      const finishedStatuses = values[2] as string[];
      const closingIds = new Set(state.closures.map((row) => row.userId));
      const keeper = state.users.find(
        (row) =>
          row.id === keeperId &&
          row.role === "admin" &&
          !closingIds.has(row.id),
      );

      if (!keeper) {
        return queryResult([], 0);
      }

      let moved = 0;

      for (const envelope of state.envelopes) {
        if (
          envelope.userId === userId &&
          (finishedStatuses.includes(envelope.status) ||
            (envelope.part11 && envelope.status !== "draft"))
        ) {
          envelope.userId = keeper.id;
          moved += 1;
        }
      }

      return queryResult([], moved);
    }

    if (
      sql.includes("FROM account_closure_requests WHERE purge_after_at <= $1")
    ) {
      const now = Number(values[0]);
      const rows = state.closures
        .filter((row) => row.purgeAfterAt <= now)
        .map((row) => ({ ...row }));

      return queryResult(rows);
    }

    if (
      sql ===
      "SELECT 1 FROM envelopes WHERE id = $1 AND user_id = $2 AND status = 'draft' AND updated_at = $3 FOR UPDATE"
    ) {
      const [id, userId, updatedAt] = values;
      const found = state.envelopes.some(
        (row) =>
          row.id === id &&
          row.userId === userId &&
          row.status === "draft" &&
          row.updatedAt === updatedAt,
      );

      return queryResult(found ? [{ "?column?": 1 }] : []);
    }

    if (
      sql ===
      "DELETE FROM envelopes WHERE id = $1 AND user_id = $2 AND status = 'draft' AND updated_at = $3"
    ) {
      const [id, userId, updatedAt] = values;
      const before = state.envelopes.length;

      state.envelopes = state.envelopes.filter(
        (row) =>
          !(
            row.id === id &&
            row.userId === userId &&
            row.status === "draft" &&
            row.updatedAt === updatedAt
          ),
      );

      return queryResult([], before - state.envelopes.length);
    }

    if (sql === 'SELECT id FROM "user" WHERE id = $1 FOR UPDATE') {
      const user = state.users.find((row) => row.id === values[0]);

      return queryResult(user ? [{ id: user.id }] : []);
    }

    if (
      sql === "SELECT id FROM envelopes WHERE user_id = $1 FOR NO KEY UPDATE"
    ) {
      const rows = state.envelopes
        .filter((row) => row.userId === values[0])
        .map((row) => ({ id: row.id }));

      return queryResult(rows);
    }

    if (
      sql.includes(
        "SELECT count(*)::text AS count FROM envelopes WHERE user_id = $1",
      )
    ) {
      const userId = String(values[0]);
      const finishedStatuses = values[1] as string[];
      const count = state.envelopes.filter(
        (row) =>
          row.userId === userId &&
          (finishedStatuses.includes(row.status) ||
            (row.part11 && row.status !== "draft")),
      ).length;

      return queryResult([{ count: String(count) }]);
    }

    if (sql.includes("FROM envelopes WHERE user_id = $1 ORDER BY")) {
      const rows = state.envelopes
        .filter((row) => row.userId === values[0])
        .map((row) => ({ ...row }));

      return queryResult(rows);
    }

    if (
      sql ===
      'SELECT id, source_pdf_key AS "sourcePdfKey" FROM templates WHERE user_id = $1'
    ) {
      const rows = state.templates
        .filter((row) => row.userId === values[0])
        .map((row) => ({ id: row.id, sourcePdfKey: row.sourcePdfKey }));

      return queryResult(rows);
    }

    if (sql === 'SELECT email FROM "user" WHERE id = $1') {
      const user = state.users.find((row) => row.id === values[0]);

      return queryResult(user ? [{ email: user.email }] : []);
    }

    if (sql === "SELECT id FROM api_keys WHERE user_id = $1 FOR UPDATE") {
      return queryResult([]);
    }

    if (sql.includes("FROM system_audit_events")) {
      return queryResult([]);
    }

    if (sql.startsWith("INSERT INTO system_audit_events")) {
      return queryResult([], 1);
    }

    if (sql === 'DELETE FROM "user" WHERE id = $1') {
      const userId = String(values[0]);
      const before = state.users.length;

      state.users = state.users.filter((row) => row.id !== userId);
      state.closures = state.closures.filter((row) => row.userId !== userId);
      state.envelopes = state.envelopes.filter((row) => row.userId !== userId);
      state.templates = state.templates.filter((row) => row.userId !== userId);

      return queryResult([], before - state.users.length);
    }

    // Read-only / no-op tables touched by the rest of runRetentionJob.
    if (
      sql.includes("recipient_download_tokens") ||
      sql.includes("provider_signing_sessions") ||
      sql.includes("app_settings") ||
      sql.includes("rate_limits") ||
      sql.includes("api_idempotency_keys") ||
      sql.includes("webhook_deliveries") ||
      // The email delivery log (1.1): nothing in it for these accounts.
      sql.includes("email_deliveries") ||
      sql.includes("scheduled_envelope_deletions") ||
      sql.includes("FROM envelopes e")
    ) {
      return queryResult([], 0);
    }

    throw new Error(`Unexpected SQL in fake retention pool: ${sql}`);
  }

  const pool = {
    totalCount: 1,
    async connect() {
      let inTx = false;
      let txState: FakeState | null = null;
      let txStatements: string[] = [];

      return {
        async query(text: string, values?: readonly unknown[]) {
          const normalized = text.trim().toUpperCase();

          if (normalized === "BEGIN") {
            inTx = true;
            txState = cloneState(committed);
            txStatements = [];
            return queryResult([]);
          }

          if (normalized === "COMMIT") {
            if (txState) {
              committed = txState;
              executedTransactions.push(txStatements);
            }

            inTx = false;
            txState = null;
            txStatements = [];
            return queryResult([]);
          }

          if (normalized === "ROLLBACK") {
            inTx = false;
            txState = null;
            txStatements = [];
            return queryResult([]);
          }

          if (inTx && txState) {
            txStatements.push(text.replace(/\s+/g, " ").trim());
            return runQuery(txState, text, values);
          }

          return runQuery(committed, text, values);
        },
        release() {
          inTx = false;
          txState = null;
        },
      };
    },
    async query(text: string, values?: readonly unknown[]) {
      return runQuery(committed, text, values);
    },
  };

  return {
    executedTransactions,
    getState: () => committed,
    pool: pool as unknown as DbPool,
  };
}

function wrapStorage(
  base: StorageService,
  shouldFail: (key: string) => boolean,
) {
  const deleteAttempts: string[] = [];
  const storageService: StorageService = {
    ...base,
    async deleteObject(key) {
      deleteAttempts.push(key);

      if (shouldFail(key)) {
        throw new Error(`Storage outage while deleting ${key}`);
      }

      return base.deleteObject(key);
    },
  };

  return { deleteAttempts, storageService };
}

async function withSilentConsole<T>(run: () => Promise<T>): Promise<T> {
  const originalError = console.error;
  const originalInfo = console.info;

  console.error = () => {};
  console.info = () => {};

  try {
    return await run();
  } finally {
    console.error = originalError;
    console.info = originalInfo;
  }
}

async function withTempStorage<T>(
  run: (storage: StorageService) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "signudoc-retention-unit-"));

  try {
    const storage = createStorageService({
      env: { STORAGE_DRIVER: "local", STORAGE_LOCAL_DIR: dir },
    });

    return await run(storage);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

function emptySummary(): RetentionSweepSummary {
  return {
    accountPurgeFailures: [],
    accountsPurged: 0,
    draftDeletionFailures: [],
    draftsDeleted: 0,
    expiredRecipientDownloadTokensDeleted: 0,
    finishedEnvelopeDeletionFailures: [],
    finishedEnvelopesDeleted: 0,
    finishedEnvelopeWarningsSent: 0,
    pendingFileDeletionFailures: [],
    pendingFileDeletionsDone: 0,
    providerSigningSessionsEnded: 0,
    ranAt: 1,
  };
}

test("with no secret configured, anyone may ask and nobody is trusted", () => {
  assert.equal(identifyRetentionCaller(null, {}), "anonymous");
  assert.equal(identifyRetentionCaller("Bearer guess", {}), "anonymous");
});

test("with CRON_SECRET set, only a caller that presents it gets in", () => {
  const env = { CRON_SECRET: "cron-secret-value" };

  assert.equal(
    identifyRetentionCaller("Bearer cron-secret-value", env),
    "authorized",
  );
  assert.equal(identifyRetentionCaller(null, env), "denied");
  assert.equal(identifyRetentionCaller("Bearer wrong", env), "denied");
  assert.equal(identifyRetentionCaller("cron-secret-value", env), "denied");
  assert.equal(identifyRetentionCaller("Bearer ", env), "denied");
});

test("RETENTION_JOB_SECRET closes the route the same way, as it always did", () => {
  const env = { RETENTION_JOB_SECRET: "older-secret-value" };

  assert.equal(
    identifyRetentionCaller("Bearer older-secret-value", env),
    "authorized",
  );
  assert.equal(identifyRetentionCaller(null, env), "denied");
  assert.equal(identifyRetentionCaller("Bearer wrong", env), "denied");
});

test("Vercel's cron being refused for want of CRON_SECRET is recognized", () => {
  const olderOnly = { RETENTION_JOB_SECRET: "older-secret-value" };

  assert.equal(
    isCronLockedOutByOlderSecret("vercel-cron/1.0", olderOnly),
    true,
  );
  assert.equal(isCronLockedOutByOlderSecret("curl/8.0", olderOnly), false);
  assert.equal(isCronLockedOutByOlderSecret(null, olderOnly), false);
  assert.equal(
    isCronLockedOutByOlderSecret("vercel-cron/1.0", {
      ...olderOnly,
      CRON_SECRET: "cron-secret-value",
    }),
    false,
  );
  assert.equal(isCronLockedOutByOlderSecret("vercel-cron/1.0", {}), false);
});

test("with both set, either secret works", () => {
  const env = {
    CRON_SECRET: "cron-secret-value",
    RETENTION_JOB_SECRET: "older-secret-value",
  };

  assert.equal(
    identifyRetentionCaller("Bearer cron-secret-value", env),
    "authorized",
  );
  assert.equal(
    identifyRetentionCaller("Bearer older-secret-value", env),
    "authorized",
  );
  assert.equal(identifyRetentionCaller("Bearer wrong", env), "denied");
});

test("retentionSweepFailed flags account, draft, finished envelope, and pending file retry failures", () => {
  assert.equal(retentionSweepFailed(emptySummary()), false);
  assert.equal(
    retentionSweepFailed({ ...emptySummary(), accountPurgeFailures: ["u1"] }),
    true,
  );
  assert.equal(
    retentionSweepFailed({ ...emptySummary(), draftDeletionFailures: ["e1"] }),
    true,
  );
  assert.equal(
    retentionSweepFailed({
      ...emptySummary(),
      finishedEnvelopeDeletionFailures: ["e2"],
    }),
    true,
  );
  assert.equal(
    retentionSweepFailed({
      ...emptySummary(),
      pendingFileDeletionFailures: ["users/u1/envelopes/e1/original.pdf"],
    }),
    true,
  );
});

test("closed-account purge with working storage removes files on the first run and leaves no pending rows", async () => {
  await withTempStorage(async (storage) => {
    const now = Math.floor(Date.now() / 1000);
    const userId = "user-account-control";
    const envelopeId = "env-account-control";
    const templateId = "tpl-account-control";
    const sourcePdfKey = buildEnvelopeOriginalPdfKey({ envelopeId, userId });
    const thumbnailKey = buildEnvelopeThumbnailKey({
      envelopeId,
      sourcePdfKey,
      userId,
    });
    const templateKey = buildTemplatePdfKey({ templateId, userId });

    for (const key of [sourcePdfKey, thumbnailKey, templateKey]) {
      await storage.putObject({
        body: new Uint8Array([37, 80, 68, 70]),
        contentType: "application/pdf",
        key,
      });
    }

    const db = createFakeRetentionPool({
      closures: [
        {
          exportExpiresAt: 1,
          purgeAfterAt: 1,
          requestedAt: 1,
          updatedAt: 1,
          userId,
        },
      ],
      envelopes: [
        {
          evidenceKey: null,
          id: envelopeId,
          part11: false,
          signedPdfKey: null,
          sourcePdfKey,
          status: "draft",
          updatedAt: now,
          userId,
        },
      ],
      templates: [{ id: templateId, sourcePdfKey: templateKey, userId }],
      users: [{ email: "leaver@example.test", id: userId, role: "user" }],
    });

    const outcome = await withSilentConsole(() =>
      runRetentionJob({
        caller: "authorized",
        database: db.pool,
        storageService: storage,
      }),
    );

    assert.equal(outcome.status, "ran");
    assert.equal(retentionJobFailed(outcome), false);
    // The renewal reminders ran last and found nothing due.
    assert.deepEqual(outcome.renewals, {
      failures: [],
      remindersSent: 0,
      stoppedEarly: false,
    });
    // Had they failed, the run would still count as a success.
    assert.equal(retentionJobFailed({ ...outcome, renewals: null }), false);
    assert.equal(
      retentionJobFailed({
        ...outcome,
        renewals: { failures: ["env-1"], remindersSent: 0, stoppedEarly: true },
      }),
      false,
    );
    assert.equal(outcome.summary.accountsPurged, 1);
    assert.deepEqual(outcome.summary.accountPurgeFailures, []);
    assert.deepEqual(outcome.summary.pendingFileDeletionFailures, []);
    assert.equal(db.getState().users.length, 0);
    assert.equal(db.getState().envelopes.length, 0);
    assert.equal(db.getState().templates.length, 0);
    assert.deepEqual(db.getState().pendingFileDeletions, []);

    for (const key of [sourcePdfKey, thumbnailKey, templateKey]) {
      assert.equal((await storage.headObject(key)).exists, false);
    }
  });
});

test("closed-account purge queues files transactionally on outage, reports incomplete, and retries on recovery", async () => {
  await withTempStorage(async (storage) => {
    const now = Math.floor(Date.now() / 1000);
    const userId = "user-account-outage";
    const envelopeId = "env-account-outage";
    const templateId = "tpl-account-outage";
    const sourcePdfKey = buildEnvelopeOriginalPdfKey({ envelopeId, userId });
    const thumbnailKey = buildEnvelopeThumbnailKey({
      envelopeId,
      sourcePdfKey,
      userId,
    });
    const templateKey = buildTemplatePdfKey({ templateId, userId });
    const allKeys = [sourcePdfKey, thumbnailKey, templateKey];

    for (const key of allKeys) {
      await storage.putObject({
        body: new Uint8Array([37, 80, 68, 70]),
        contentType: "application/pdf",
        key,
      });
    }

    const db = createFakeRetentionPool({
      closures: [
        {
          exportExpiresAt: 1,
          purgeAfterAt: 1,
          requestedAt: 1,
          updatedAt: 1,
          userId,
        },
      ],
      envelopes: [
        {
          evidenceKey: null,
          id: envelopeId,
          part11: false,
          signedPdfKey: null,
          sourcePdfKey,
          status: "draft",
          updatedAt: now,
          userId,
        },
      ],
      templates: [{ id: templateId, sourcePdfKey: templateKey, userId }],
      users: [{ email: "outage@example.test", id: userId, role: "user" }],
    });

    const failing = wrapStorage(storage, () => true);

    const first = await withSilentConsole(() =>
      runRetentionJob({
        caller: "authorized",
        database: db.pool,
        storageService: failing.storageService,
      }),
    );

    assert.equal(first.status, "ran");
    assert.equal(first.summary.accountsPurged, 1);
    assert.deepEqual(first.summary.accountPurgeFailures, [userId]);
    assert.equal(retentionJobFailed(first), true);

    // Queueing and user removal committed in the same transaction.
    const accountTx = db.executedTransactions.find((tx) =>
      tx.some((sql) => sql === 'DELETE FROM "user" WHERE id = $1'),
    );

    assert.ok(accountTx, "expected a transaction deleting the account");
    assert.ok(
      accountTx.some((sql) =>
        sql.startsWith("INSERT INTO pending_file_deletions"),
      ),
      "expected pending_file_deletions insert in the same transaction",
    );

    // Each file was tried once (not double-attempted) and stayed queued.
    assert.deepEqual([...failing.deleteAttempts].sort(), [...allKeys].sort());
    assert.equal(db.getState().users.length, 0);
    assert.deepEqual(
      db
        .getState()
        .pendingFileDeletions.map((row) => ({
          envelopeId: row.envelopeId,
          storageKey: row.storageKey,
          tried: row.lastTriedAt !== null,
        }))
        .sort((a, b) => a.storageKey.localeCompare(b.storageKey)),
      [
        { envelopeId, storageKey: sourcePdfKey, tried: true },
        { envelopeId, storageKey: thumbnailKey, tried: true },
        {
          envelopeId: `template:${templateId}`,
          storageKey: templateKey,
          tried: true,
        },
      ].sort((a, b) => a.storageKey.localeCompare(b.storageKey)),
    );

    for (const key of allKeys) {
      assert.equal((await storage.headObject(key)).exists, true);
    }

    // A second run while storage is still down still reports failure.
    const stillDown = await withSilentConsole(() =>
      runRetentionJob({
        caller: "authorized",
        database: db.pool,
        storageService: failing.storageService,
      }),
    );

    assert.equal(stillDown.status, "ran");
    assert.equal(stillDown.summary.pendingFileDeletionsDone, 0);
    assert.deepEqual(
      [...stillDown.summary.pendingFileDeletionFailures].sort(),
      [...allKeys].sort(),
    );
    assert.equal(retentionJobFailed(stillDown), true);

    // Storage recovers: the next run deletes all queued files and clears rows.
    const recovered = await withSilentConsole(() =>
      runRetentionJob({
        caller: "authorized",
        database: db.pool,
        storageService: storage,
      }),
    );

    assert.equal(recovered.status, "ran");
    assert.equal(recovered.summary.pendingFileDeletionsDone, allKeys.length);
    assert.deepEqual(recovered.summary.pendingFileDeletionFailures, []);
    assert.deepEqual(recovered.summary.accountPurgeFailures, []);
    assert.equal(retentionJobFailed(recovered), false);
    assert.deepEqual(db.getState().pendingFileDeletions, []);

    for (const key of allKeys) {
      assert.equal((await storage.headObject(key)).exists, false);
    }
  });
});

test("closed-account purge under partial storage outage deletes healthy files and retries only the failed key", async () => {
  await withTempStorage(async (storage) => {
    const now = Math.floor(Date.now() / 1000);
    const userId = "user-partial";
    const envelopeId = "env-partial";
    const templateId = "tpl-partial";
    const sourcePdfKey = buildEnvelopeOriginalPdfKey({ envelopeId, userId });
    const thumbnailKey = buildEnvelopeThumbnailKey({
      envelopeId,
      sourcePdfKey,
      userId,
    });
    const templateKey = buildTemplatePdfKey({ templateId, userId });

    for (const key of [sourcePdfKey, thumbnailKey, templateKey]) {
      await storage.putObject({
        body: new Uint8Array([37, 80, 68, 70]),
        contentType: "application/pdf",
        key,
      });
    }

    const db = createFakeRetentionPool({
      closures: [
        {
          exportExpiresAt: 1,
          purgeAfterAt: 1,
          requestedAt: 1,
          updatedAt: 1,
          userId,
        },
      ],
      envelopes: [
        {
          evidenceKey: null,
          id: envelopeId,
          part11: false,
          signedPdfKey: null,
          sourcePdfKey,
          status: "draft",
          updatedAt: now,
          userId,
        },
      ],
      templates: [{ id: templateId, sourcePdfKey: templateKey, userId }],
      users: [{ email: "partial@example.test", id: userId, role: "user" }],
    });

    const partialStorage = wrapStorage(storage, (key) => key === sourcePdfKey);
    const first = await withSilentConsole(() =>
      runRetentionJob({
        caller: "authorized",
        database: db.pool,
        storageService: partialStorage.storageService,
      }),
    );

    assert.equal(first.status, "ran");
    assert.equal(retentionJobFailed(first), true);
    assert.deepEqual(first.summary.accountPurgeFailures, [userId]);
    assert.equal((await storage.headObject(sourcePdfKey)).exists, true);
    assert.equal((await storage.headObject(thumbnailKey)).exists, false);
    assert.equal((await storage.headObject(templateKey)).exists, false);
    assert.deepEqual(
      db.getState().pendingFileDeletions.map((row) => row.storageKey),
      [sourcePdfKey],
    );

    const recovered = await withSilentConsole(() =>
      runRetentionJob({
        caller: "authorized",
        database: db.pool,
        storageService: storage,
      }),
    );

    assert.equal(recovered.status, "ran");
    assert.equal(recovered.summary.pendingFileDeletionsDone, 1);
    assert.equal(retentionJobFailed(recovered), false);
    assert.equal((await storage.headObject(sourcePdfKey)).exists, false);
    assert.deepEqual(db.getState().pendingFileDeletions, []);
  });
});

test("stale-draft purge with working storage removes files on the first run and leaves no pending rows", async () => {
  await withTempStorage(async (storage) => {
    const userId = "user-draft-control";
    const envelopeId = "env-draft-control";
    const sourcePdfKey = buildEnvelopeOriginalPdfKey({ envelopeId, userId });
    const thumbnailKey = buildEnvelopeThumbnailKey({
      envelopeId,
      sourcePdfKey,
      userId,
    });

    for (const key of [sourcePdfKey, thumbnailKey]) {
      await storage.putObject({
        body: new Uint8Array([37, 80, 68, 70]),
        contentType: "application/pdf",
        key,
      });
    }

    const db = createFakeRetentionPool({
      envelopes: [
        {
          evidenceKey: null,
          id: envelopeId,
          part11: false,
          signedPdfKey: null,
          sourcePdfKey,
          status: "draft",
          updatedAt: 1,
          userId,
        },
      ],
      users: [
        { email: "draft-control@example.test", id: userId, role: "user" },
      ],
    });

    const outcome = await withSilentConsole(() =>
      runRetentionJob({
        caller: "authorized",
        database: db.pool,
        storageService: storage,
      }),
    );

    assert.equal(outcome.status, "ran");
    assert.equal(retentionJobFailed(outcome), false);
    assert.equal(outcome.summary.draftsDeleted, 1);
    assert.deepEqual(outcome.summary.draftDeletionFailures, []);
    assert.equal(db.getState().envelopes.length, 0);
    assert.deepEqual(db.getState().pendingFileDeletions, []);
    assert.equal((await storage.headObject(sourcePdfKey)).exists, false);
    assert.equal((await storage.headObject(thumbnailKey)).exists, false);
  });
});

test("stale-draft purge queues files transactionally on outage, reports incomplete, and retries on recovery", async () => {
  await withTempStorage(async (storage) => {
    const userId = "user-draft-outage";
    const envelopeId = "env-draft-outage";
    const sourcePdfKey = buildEnvelopeOriginalPdfKey({ envelopeId, userId });
    const thumbnailKey = buildEnvelopeThumbnailKey({
      envelopeId,
      sourcePdfKey,
      userId,
    });
    const allKeys = [sourcePdfKey, thumbnailKey];

    for (const key of allKeys) {
      await storage.putObject({
        body: new Uint8Array([37, 80, 68, 70]),
        contentType: "application/pdf",
        key,
      });
    }

    const db = createFakeRetentionPool({
      envelopes: [
        {
          evidenceKey: null,
          id: envelopeId,
          part11: false,
          signedPdfKey: null,
          sourcePdfKey,
          status: "draft",
          updatedAt: 1,
          userId,
        },
      ],
      users: [{ email: "draft-outage@example.test", id: userId, role: "user" }],
    });

    const failing = wrapStorage(storage, () => true);

    const first = await withSilentConsole(() =>
      runRetentionJob({
        caller: "authorized",
        database: db.pool,
        storageService: failing.storageService,
      }),
    );

    assert.equal(first.status, "ran");
    assert.equal(first.summary.draftsDeleted, 1);
    assert.deepEqual(first.summary.draftDeletionFailures, [envelopeId]);
    assert.equal(retentionJobFailed(first), true);

    const draftTx = db.executedTransactions.find((tx) =>
      tx.some((sql) => sql.startsWith("DELETE FROM envelopes WHERE id = $1")),
    );

    assert.ok(draftTx, "expected a transaction deleting the stale draft");
    assert.ok(
      draftTx.some((sql) =>
        sql.startsWith("INSERT INTO pending_file_deletions"),
      ),
      "expected pending_file_deletions insert in the same transaction",
    );

    // Each file was tried once and remains queued with last_tried_at set.
    assert.deepEqual([...failing.deleteAttempts].sort(), [...allKeys].sort());
    assert.equal(db.getState().envelopes.length, 0);
    assert.deepEqual(
      db
        .getState()
        .pendingFileDeletions.map((row) => ({
          envelopeId: row.envelopeId,
          storageKey: row.storageKey,
          tried: row.lastTriedAt !== null,
        }))
        .sort((a, b) => a.storageKey.localeCompare(b.storageKey)),
      allKeys
        .map((storageKey) => ({ envelopeId, storageKey, tried: true }))
        .sort((a, b) => a.storageKey.localeCompare(b.storageKey)),
    );

    for (const key of allKeys) {
      assert.equal((await storage.headObject(key)).exists, true);
    }

    // Continued outage still fails the run via pendingFileDeletionFailures.
    const stillDown = await withSilentConsole(() =>
      runRetentionJob({
        caller: "authorized",
        database: db.pool,
        storageService: failing.storageService,
      }),
    );

    assert.equal(stillDown.status, "ran");
    assert.equal(stillDown.summary.pendingFileDeletionsDone, 0);
    assert.deepEqual(
      [...stillDown.summary.pendingFileDeletionFailures].sort(),
      [...allKeys].sort(),
    );
    assert.equal(retentionJobFailed(stillDown), true);

    // Recovery run deletes queued files and returns clean success.
    const recovered = await withSilentConsole(() =>
      runRetentionJob({
        caller: "authorized",
        database: db.pool,
        storageService: storage,
      }),
    );

    assert.equal(recovered.status, "ran");
    assert.equal(recovered.summary.pendingFileDeletionsDone, allKeys.length);
    assert.deepEqual(recovered.summary.pendingFileDeletionFailures, []);
    assert.deepEqual(recovered.summary.draftDeletionFailures, []);
    assert.equal(retentionJobFailed(recovered), false);
    assert.deepEqual(db.getState().pendingFileDeletions, []);

    for (const key of allKeys) {
      assert.equal((await storage.headObject(key)).exists, false);
    }
  });
});

test("a stale draft edited before its transaction locks it is neither queued nor deleted", async () => {
  await withTempStorage(async (storage) => {
    const now = 2_000_000_000;
    const staleAt = now - (STALE_DRAFT_RETENTION_DAYS + 5) * 24 * 60 * 60;
    const userId = "user-draft-raced";
    const envelopeId = "env-draft-raced";
    const sourcePdfKey = buildEnvelopeOriginalPdfKey({ envelopeId, userId });

    await storage.putObject({
      body: new Uint8Array([37, 80, 68, 70]),
      contentType: "application/pdf",
      key: sourcePdfKey,
    });

    const db = createFakeRetentionPool(
      {
        envelopes: [
          {
            evidenceKey: null,
            id: envelopeId,
            part11: false,
            signedPdfKey: null,
            sourcePdfKey,
            status: "draft",
            updatedAt: staleAt,
            userId,
          },
        ],
        users: [{ email: "raced@example.test", id: userId, role: "user" }],
      },
      {
        beforeQuery(sql, _values, state) {
          if (sql.includes("SELECT 1 FROM envelopes WHERE id = $1")) {
            const target = state.envelopes.find((row) => row.id === envelopeId);

            if (target) {
              target.updatedAt = now;
            }
          }
        },
      },
    );

    const summary = await withSilentConsole(() =>
      runRetentionSweep({ database: db.pool, now, storageService: storage }),
    );

    assert.equal(summary.draftsDeleted, 0);
    assert.deepEqual(summary.draftDeletionFailures, []);
    assert.equal(retentionSweepFailed(summary), false);
    assert.equal(db.getState().envelopes.length, 1);
    assert.deepEqual(db.getState().pendingFileDeletions, []);
    assert.equal((await storage.headObject(sourcePdfKey)).exists, true);
  });
});

test("a rolled-back account deletion leaves no pending_file_deletions rows behind", async () => {
  await withTempStorage(async (storage) => {
    const now = 2_000_000_000;
    const userId = "user-rollback";
    const envelopeId = "env-rollback";
    const sourcePdfKey = buildEnvelopeOriginalPdfKey({ envelopeId, userId });

    await storage.putObject({
      body: new Uint8Array([37, 80, 68, 70]),
      contentType: "application/pdf",
      key: sourcePdfKey,
    });

    const db = createFakeRetentionPool(
      {
        closures: [
          {
            exportExpiresAt: 1,
            purgeAfterAt: 1,
            requestedAt: 1,
            updatedAt: 1,
            userId,
          },
        ],
        envelopes: [
          {
            evidenceKey: null,
            id: envelopeId,
            part11: false,
            signedPdfKey: null,
            sourcePdfKey,
            status: "draft",
            updatedAt: now,
            userId,
          },
        ],
        users: [{ email: "rollback@example.test", id: userId, role: "user" }],
      },
      {
        beforeQuery(sql) {
          if (sql === 'DELETE FROM "user" WHERE id = $1') {
            throw new Error("Simulated DB failure on delete");
          }
        },
      },
    );

    const summary = await withSilentConsole(() =>
      runRetentionSweep({ database: db.pool, now, storageService: storage }),
    );

    assert.equal(summary.accountsPurged, 0);
    assert.deepEqual(summary.accountPurgeFailures, [userId]);
    assert.equal(retentionSweepFailed(summary), true);
    assert.equal(db.getState().users.length, 1);
    assert.deepEqual(db.getState().pendingFileDeletions, []);
    assert.equal((await storage.headObject(sourcePdfKey)).exists, true);
  });
});

test("self-hosted account purge hands over finished envelopes without queueing their files, while queueing draft files", async () => {
  await withTempStorage(async (storage) => {
    const now = 2_000_000_000;
    const adminId = "admin-keeper";
    const leaverId = "user-with-finished";
    const finishedId = "env-finished-kept";
    const draftId = "env-draft-removed";
    const finishedPdfKey = buildEnvelopeOriginalPdfKey({
      envelopeId: finishedId,
      userId: leaverId,
    });
    const draftPdfKey = buildEnvelopeOriginalPdfKey({
      envelopeId: draftId,
      userId: leaverId,
    });
    const draftThumbKey = buildEnvelopeThumbnailKey({
      envelopeId: draftId,
      sourcePdfKey: draftPdfKey,
      userId: leaverId,
    });

    for (const key of [finishedPdfKey, draftPdfKey, draftThumbKey]) {
      await storage.putObject({
        body: new Uint8Array([37, 80, 68, 70]),
        contentType: "application/pdf",
        key,
      });
    }

    const db = createFakeRetentionPool({
      closures: [
        {
          exportExpiresAt: 1,
          purgeAfterAt: 1,
          requestedAt: 1,
          updatedAt: 1,
          userId: leaverId,
        },
      ],
      envelopes: [
        {
          evidenceKey: null,
          id: finishedId,
          part11: false,
          signedPdfKey: null,
          sourcePdfKey: finishedPdfKey,
          status: "completed",
          updatedAt: now,
          userId: leaverId,
        },
        {
          evidenceKey: null,
          id: draftId,
          part11: false,
          signedPdfKey: null,
          sourcePdfKey: draftPdfKey,
          status: "draft",
          updatedAt: now,
          userId: leaverId,
        },
      ],
      users: [
        { email: "admin@example.test", id: adminId, role: "admin" },
        { email: "leaver@example.test", id: leaverId, role: "user" },
      ],
    });

    const failing = wrapStorage(storage, () => true);
    const first = await withSilentConsole(() =>
      runRetentionSweep({
        database: db.pool,
        now,
        storageService: failing.storageService,
      }),
    );

    assert.equal(first.accountsPurged, 1);
    assert.deepEqual(first.accountPurgeFailures, [leaverId]);
    assert.equal(retentionSweepFailed(first), true);

    // Completed envelope moved to the admin and its file was never queued.
    const handedOver = db
      .getState()
      .envelopes.find((row) => row.id === finishedId);

    assert.equal(handedOver?.userId, adminId);
    assert.deepEqual(
      db
        .getState()
        .pendingFileDeletions.map((row) => row.storageKey)
        .sort(),
      [draftPdfKey, draftThumbKey].sort(),
    );

    // Recovery deletes the draft files while preserving the handed-over file.
    const recovered = await withSilentConsole(() =>
      runRetentionSweep({
        database: db.pool,
        now: now + 86_400,
        storageService: storage,
      }),
    );

    assert.equal(recovered.pendingFileDeletionsDone, 2);
    assert.equal(retentionSweepFailed(recovered), false);
    assert.equal((await storage.headObject(finishedPdfKey)).exists, true);
    assert.equal((await storage.headObject(draftPdfKey)).exists, false);
    assert.equal((await storage.headObject(draftThumbKey)).exists, false);
  });
});

test("hosted-mode account purge queues all envelope artifacts including signed PDF, certificates, and drawn signatures", async () => {
  const previousHostedMode = process.env.HOSTED_MODE;

  process.env.HOSTED_MODE = "1";

  try {
    await withTempStorage(async (storage) => {
      const now = 2_000_000_000;
      const userId = "user-hosted-outage";
      const envelopeId = "env-hosted-completed";
      const sourcePdfKey = buildEnvelopeOriginalPdfKey({ envelopeId, userId });
      const thumbnailKey = buildEnvelopeThumbnailKey({
        envelopeId,
        sourcePdfKey,
        userId,
      });
      const signedPdfKey = buildEnvelopeSignedPdfKey({ envelopeId, userId });
      const evidenceKey = buildEnvelopeCertificateKey({
        audience: "internal",
        envelopeId,
        userId,
      });
      const recipientCertKey = getRecipientCertificateKey(evidenceKey);
      const signatureImageKey = buildSignatureImageKey({
        envelopeId,
        fieldId: "field-1",
        submissionId: "sub-1",
        userId,
      });
      const allKeys = [
        sourcePdfKey,
        thumbnailKey,
        signedPdfKey,
        evidenceKey,
        recipientCertKey,
        signatureImageKey,
      ];

      for (const key of allKeys) {
        await storage.putObject({
          body: new Uint8Array([37, 80, 68, 70]),
          contentType: "application/pdf",
          key,
        });
      }

      const db = createFakeRetentionPool({
        closures: [
          {
            exportExpiresAt: 1,
            purgeAfterAt: 1,
            requestedAt: 1,
            updatedAt: 1,
            userId,
          },
        ],
        envelopes: [
          {
            evidenceKey,
            id: envelopeId,
            part11: false,
            signedPdfKey,
            sourcePdfKey,
            status: "completed",
            updatedAt: now,
            userId,
          },
        ],
        fieldImages: [{ envelopeId, imageKey: signatureImageKey }],
        users: [{ email: "hosted@example.test", id: userId, role: "user" }],
      });

      const failing = wrapStorage(storage, () => true);
      const first = await withSilentConsole(() =>
        runRetentionSweep({
          database: db.pool,
          now,
          storageService: failing.storageService,
        }),
      );

      assert.equal(first.accountsPurged, 1);
      assert.deepEqual(first.accountPurgeFailures, [userId]);
      assert.equal(retentionSweepFailed(first), true);
      assert.deepEqual(
        db
          .getState()
          .pendingFileDeletions.map((row) => row.storageKey)
          .sort(),
        [...allKeys].sort(),
      );

      const recovered = await withSilentConsole(() =>
        runRetentionSweep({
          database: db.pool,
          now: now + 86_400,
          storageService: storage,
        }),
      );

      assert.equal(recovered.pendingFileDeletionsDone, allKeys.length);
      assert.equal(retentionSweepFailed(recovered), false);
      assert.deepEqual(db.getState().pendingFileDeletions, []);

      for (const key of allKeys) {
        assert.equal((await storage.headObject(key)).exists, false);
      }
    });
  } finally {
    if (previousHostedMode === undefined) {
      delete process.env.HOSTED_MODE;
    } else {
      process.env.HOSTED_MODE = previousHostedMode;
    }
  }
});
