import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import type pg from "pg";

import {
  eraseSignerData,
  exportSignerData,
  extractSignerWebhookPayload,
} from "./signer-data.ts";

type FakeEnvelope = {
  createdAt: number;
  evidenceKey: string | null;
  id: string;
  part11: boolean;
  signedPdfKey: string | null;
  sourcePdfKey: string;
  status: "completed" | "declined" | "draft" | "sent" | "voided";
  title: string;
  updatedAt: number;
  userId: string;
};

type FakeSigner = {
  declineReason: string | null;
  declinedAt: number | null;
  email: string;
  envelopeId: string;
  id: string;
  name: string;
  role: "approver" | "cc" | "signer";
  signedAt: number | null;
  status: string;
};

type FakeField = {
  checked: boolean | null;
  envelopeId: string;
  imageKey: string | null;
  inputMethod: string | null;
  label: string | null;
  signerId: string;
  submittedAt: number | null;
  type: string;
  value: string | null;
};

type FakeAuditEvent = {
  actorEmail: string | null;
  actorType: string;
  createdAt: number;
  envelopeId: string;
  event: string;
  ipAddress: string | null;
  metadata: Record<string, unknown> | null;
  userAgent: string | null;
};

type FakeWebhookDelivery = {
  createdAt: number;
  deliveredAt: number | null;
  endpointId: string;
  envelopeId: string | null;
  eventType: string;
  id: string;
  payload: string | null;
  status: "delivered" | "failed" | "pending";
};

type FakeDbState = {
  auditEvents: FakeAuditEvent[];
  envelopes: FakeEnvelope[];
  failNextWebhookDelete?: boolean;
  fields: FakeField[];
  missingWebhookDeliveriesTable?: boolean;
  signers: FakeSigner[];
  webhookDeliveries: FakeWebhookDelivery[];
};

function buildWebhookBody({
  copyRecipients = [],
  envelopeId = "env-1",
  envelopeStatus = "completed",
  envelopeTitle = "Service agreement",
  metadata = { invoice: "INV-42" },
  owner = { email: "owner@example.test", id: "u-owner", name: "Ops Admin" },
  reason,
  signer,
  signers = [],
  timestamp = "2026-11-18T09:14:03.000Z",
  type = "envelope.completed",
}: {
  copyRecipients?: Array<{ email: string; id: string; name: string }>;
  envelopeId?: string;
  envelopeStatus?: string;
  envelopeTitle?: string;
  metadata?: Record<string, unknown>;
  owner?: { email: string; id: string; name: string };
  reason?: string;
  signer?: Record<string, unknown> | null;
  signers?: Array<Record<string, unknown>>;
  timestamp?: string;
  type?: string;
}): string {
  const data: Record<string, unknown> = {
    envelope: {
      copyRecipients,
      id: envelopeId,
      metadata,
      object: "envelope",
      signers,
      status: envelopeStatus,
      title: envelopeTitle,
    },
    owner,
  };

  if (signer !== undefined) {
    data.signer = signer;
  }

  if (reason !== undefined) {
    data.reason = reason;
  }

  return JSON.stringify({ data, timestamp, type });
}

function createFakePool(state: FakeDbState): pg.Pool {
  let txSnapshot: Omit<
    FakeDbState,
    "failNextWebhookDelete" | "missingWebhookDeliveriesTable"
  > | null = null;

  const snapshotState = () => ({
    auditEvents: state.auditEvents.map((event) => ({ ...event })),
    envelopes: state.envelopes.map((envelope) => ({ ...envelope })),
    fields: state.fields.map((field) => ({ ...field })),
    signers: state.signers.map((signer) => ({ ...signer })),
    webhookDeliveries: state.webhookDeliveries.map((delivery) => ({
      ...delivery,
    })),
  });

  const query = async (
    text: string,
    values: unknown[] = [],
  ): Promise<{ rowCount: number; rows: Record<string, unknown>[] }> => {
    const normalized = text.replace(/\s+/g, " ").trim();

    if (normalized === "BEGIN") {
      txSnapshot = snapshotState();
      return { rowCount: 0, rows: [] };
    }

    if (normalized === "COMMIT") {
      txSnapshot = null;
      return { rowCount: 0, rows: [] };
    }

    if (normalized === "ROLLBACK") {
      if (txSnapshot) {
        state.auditEvents = txSnapshot.auditEvents;
        state.envelopes = txSnapshot.envelopes;
        state.fields = txSnapshot.fields;
        state.signers = txSnapshot.signers;
        state.webhookDeliveries = txSnapshot.webhookDeliveries;
        txSnapshot = null;
      }

      return { rowCount: 0, rows: [] };
    }

    if (
      normalized.startsWith("SAVEPOINT ") ||
      normalized.startsWith("RELEASE SAVEPOINT ") ||
      normalized.startsWith("ROLLBACK TO SAVEPOINT ")
    ) {
      return { rowCount: 0, rows: [] };
    }

    if (
      state.missingWebhookDeliveriesTable &&
      normalized.includes("webhook_deliveries")
    ) {
      const error = new Error(
        'relation "webhook_deliveries" does not exist',
      ) as Error & { code: string };

      error.code = "42P01";
      throw error;
    }

    if (normalized.includes("FROM signers s JOIN envelopes e")) {
      const email = String(values[0]).toLowerCase();
      const rows = state.signers
        .filter((signer) => signer.email.toLowerCase() === email)
        .flatMap((signer) => {
          const envelope = state.envelopes.find(
            (item) => item.id === signer.envelopeId,
          );

          return envelope
            ? [
                {
                  declineReason: signer.declineReason,
                  declinedAt: signer.declinedAt,
                  envelopeCreatedAt: envelope.createdAt,
                  envelopeId: envelope.id,
                  envelopeStatus: envelope.status,
                  envelopeTitle: envelope.title,
                  part11: envelope.part11,
                  role: signer.role,
                  signedAt: signer.signedAt,
                  signerEmail: signer.email,
                  signerId: signer.id,
                  signerName: signer.name,
                  signerStatus: signer.status,
                },
              ]
            : [];
        })
        .sort(
          (a, b) =>
            a.envelopeCreatedAt - b.envelopeCreatedAt ||
            a.envelopeId.localeCompare(b.envelopeId),
        );

      return { rowCount: rows.length, rows };
    }

    if (
      normalized.startsWith("SELECT") &&
      normalized.includes("FROM fields WHERE signer_id = ANY($1::text[])")
    ) {
      const signerIds = new Set(values[0] as string[]);
      const rows = state.fields
        .filter((field) => signerIds.has(field.signerId))
        .map((field) => ({
          checked: field.checked,
          envelopeId: field.envelopeId,
          hasImage: field.imageKey !== null,
          inputMethod: field.inputMethod,
          label: field.label,
          submittedAt: field.submittedAt,
          type: field.type,
          value: field.value,
        }));

      return { rowCount: rows.length, rows };
    }

    if (normalized.includes("FROM audit_events")) {
      const envelopeIds = new Set(values[0] as string[]);
      const email = String(values[1]).toLowerCase();
      const signerIds = new Set(values[2] as string[]);
      const rows = state.auditEvents
        .filter(
          (event) =>
            envelopeIds.has(event.envelopeId) &&
            (event.actorEmail?.toLowerCase() === email ||
              (typeof event.metadata?.signerId === "string" &&
                signerIds.has(event.metadata.signerId))),
        )
        .map((event) => ({ ...event }));

      return { rowCount: rows.length, rows };
    }

    if (
      normalized.includes("FROM webhook_deliveries") &&
      normalized.startsWith("SELECT")
    ) {
      if (normalized.includes("strpos(lower(payload), $2) > 0")) {
        const envelopeIds = new Set(values[0] as string[]);
        const email = String(values[1]).toLowerCase();
        const rows = state.webhookDeliveries
          .filter(
            (delivery) =>
              delivery.eventType !== "webhook.test" &&
              ((delivery.envelopeId !== null &&
                envelopeIds.has(delivery.envelopeId)) ||
                (delivery.payload !== null &&
                  delivery.payload.toLowerCase().includes(email))),
          )
          .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
          .map((delivery) => ({ ...delivery }));

        return { rowCount: rows.length, rows };
      }

      if (normalized.includes("strpos(lower(wd.payload), $1) > 0")) {
        const email = String(values[0]).toLowerCase();
        const rows = state.webhookDeliveries
          .filter((delivery) => {
            if (
              delivery.eventType === "webhook.test" ||
              delivery.payload === null ||
              !delivery.payload.toLowerCase().includes(email)
            ) {
              return false;
            }

            const envelope = state.envelopes.find(
              (item) => item.id === delivery.envelopeId,
            );

            if (envelope?.part11) {
              return false;
            }

            if (
              envelope &&
              state.signers.some(
                (signer) =>
                  signer.envelopeId === envelope.id &&
                  signer.email.toLowerCase() === email,
              )
            ) {
              return false;
            }

            return true;
          })
          .map((delivery) => ({ id: delivery.id, payload: delivery.payload }));

        return { rowCount: rows.length, rows };
      }
    }

    if (normalized.startsWith("DELETE FROM webhook_deliveries")) {
      if (state.failNextWebhookDelete) {
        state.failNextWebhookDelete = false;
        throw new Error("Simulated webhook deletion interruption");
      }

      const erasedEnvelopeIds = new Set(values[0] as string[]);
      const matchingPayloadIds = new Set(values[1] as string[]);
      const email = String(values[2]).toLowerCase();
      const beforeCount = state.webhookDeliveries.length;

      state.webhookDeliveries = state.webhookDeliveries.filter((delivery) => {
        const envelope = state.envelopes.find(
          (item) => item.id === delivery.envelopeId,
        );
        const matchesErasedEnvelope =
          delivery.envelopeId !== null &&
          erasedEnvelopeIds.has(delivery.envelopeId) &&
          !envelope;
        const matchesPayload =
          matchingPayloadIds.has(delivery.id) &&
          !envelope?.part11 &&
          !(
            envelope &&
            state.signers.some(
              (signer) =>
                signer.envelopeId === envelope.id &&
                signer.email.toLowerCase() === email,
            )
          );

        return !(matchesErasedEnvelope || matchesPayload);
      });

      return {
        rowCount: beforeCount - state.webhookDeliveries.length,
        rows: [],
      };
    }

    if (
      normalized.startsWith(
        "SELECT id FROM envelopes WHERE id = ANY($1::text[]) AND status = 'draft' FOR UPDATE",
      )
    ) {
      const ids = new Set(values[0] as string[]);
      const rows = state.envelopes
        .filter(
          (envelope) => ids.has(envelope.id) && envelope.status === "draft",
        )
        .map((envelope) => ({ id: envelope.id }));

      return { rowCount: rows.length, rows };
    }

    if (
      normalized.startsWith(
        "SELECT id FROM signers WHERE envelope_id = ANY($1::text[]) AND lower(email) = $2 FOR UPDATE",
      )
    ) {
      const ids = new Set(values[0] as string[]);
      const email = String(values[1]).toLowerCase();
      const rows = state.signers
        .filter(
          (signer) =>
            ids.has(signer.envelopeId) && signer.email.toLowerCase() === email,
        )
        .map((signer) => ({ id: signer.id }));

      return { rowCount: rows.length, rows };
    }

    if (normalized.startsWith("DELETE FROM fields WHERE signer_id")) {
      const signerIds = new Set(values[0] as string[]);
      const beforeCount = state.fields.length;

      state.fields = state.fields.filter(
        (field) => !signerIds.has(field.signerId),
      );

      return { rowCount: beforeCount - state.fields.length, rows: [] };
    }

    if (normalized.startsWith("DELETE FROM signers WHERE id")) {
      const signerIds = new Set(values[0] as string[]);
      const beforeCount = state.signers.length;

      state.signers = state.signers.filter(
        (signer) => !signerIds.has(signer.id),
      );

      return { rowCount: beforeCount - state.signers.length, rows: [] };
    }

    if (normalized.startsWith("UPDATE bulk_send_batch_rows")) {
      return { rowCount: 0, rows: [] };
    }

    if (
      normalized.includes('source_pdf_key AS "sourcePdfKey"') &&
      normalized.includes("FROM envelopes WHERE id = ANY($1::text[])")
    ) {
      const ids = new Set(values[0] as string[]);
      const rows = state.envelopes
        .filter((envelope) => ids.has(envelope.id))
        .map((envelope) => ({
          evidenceKey: envelope.evidenceKey,
          id: envelope.id,
          signedPdfKey: envelope.signedPdfKey,
          sourcePdfKey: envelope.sourcePdfKey,
          status: envelope.status,
          updatedAt: envelope.updatedAt,
          userId: envelope.userId,
        }));

      return { rowCount: rows.length, rows };
    }

    if (normalized.includes("FROM provider_signing_sessions")) {
      const ids = new Set(values as string[]);
      const rows = state.fields
        .filter((field) => ids.has(field.envelopeId) && field.imageKey !== null)
        .map((field) => ({
          envelopeId: field.envelopeId,
          imageKey: field.imageKey,
        }));

      return { rowCount: rows.length, rows };
    }

    if (
      normalized.startsWith("DELETE FROM envelopes WHERE id = ANY($1::text[])")
    ) {
      const ids = new Set(values[0] as string[]);
      const beforeCount = state.envelopes.length;

      state.envelopes = state.envelopes.filter(
        (envelope) => !ids.has(envelope.id),
      );
      state.signers = state.signers.filter(
        (signer) => !ids.has(signer.envelopeId),
      );
      state.fields = state.fields.filter((field) => !ids.has(field.envelopeId));
      state.auditEvents = state.auditEvents.filter(
        (event) => !ids.has(event.envelopeId),
      );

      return { rowCount: beforeCount - state.envelopes.length, rows: [] };
    }

    throw new Error(`Unexpected query in fake DB: ${normalized}`);
  };

  const client = { query, release: () => undefined };

  return {
    connect: async () => client,
    query,
    totalCount: 1,
  } as unknown as pg.Pool;
}

let storageDir: string;
const previousStorageDriver = process.env.STORAGE_DRIVER;
const previousStorageLocalDir = process.env.STORAGE_LOCAL_DIR;

before(async () => {
  storageDir = await mkdtemp(path.join(tmpdir(), "signudoc-signer-data-test-"));
  process.env.STORAGE_DRIVER = "local";
  process.env.STORAGE_LOCAL_DIR = storageDir;
});

after(async () => {
  if (previousStorageDriver === undefined) {
    delete process.env.STORAGE_DRIVER;
  } else {
    process.env.STORAGE_DRIVER = previousStorageDriver;
  }

  if (previousStorageLocalDir === undefined) {
    delete process.env.STORAGE_LOCAL_DIR;
  } else {
    process.env.STORAGE_LOCAL_DIR = previousStorageLocalDir;
  }

  await rm(storageDir, { force: true, recursive: true });
});

test("extractSignerWebhookPayload extracts only the requested signer and omits other parties and owner data", () => {
  const alice = {
    declineReason: null,
    declinedAt: null,
    email: "Alice@Example.TEST",
    id: "s-alice",
    name: "Alice Signer",
    order: 1,
    ref: "alice",
    role: "signer",
    signedAt: "2026-11-18T09:10:00.000Z",
    status: "signed",
    step: 1,
    viewedAt: "2026-11-18T09:05:00.000Z",
  };
  const bob = {
    declineReason: "Wrong amount",
    declinedAt: "2026-11-18T09:12:00.000Z",
    email: "bob@example.test",
    id: "s-bob",
    name: "Bob Approver",
    order: 2,
    ref: "bob",
    role: "approver",
    signedAt: null,
    status: "declined",
    step: 2,
    viewedAt: "2026-11-18T09:11:00.000Z",
  };
  const carol = {
    email: "carol@example.test",
    id: "s-carol",
    name: "Carol Copy",
  };
  const raw = buildWebhookBody({
    copyRecipients: [carol],
    envelopeStatus: "declined",
    envelopeTitle: "Vendor MSA",
    owner: { email: "owner@example.test", id: "u-1", name: "Ops Owner" },
    reason: "Wrong amount",
    signer: bob,
    signers: [alice, bob],
    type: "envelope.declined",
  });

  const aliceExtracted = extractSignerWebhookPayload(raw, "alice@example.test");

  assert.equal(aliceExtracted.matched, true);
  assert.deepEqual(aliceExtracted.payload, {
    envelopeStatus: "declined",
    envelopeTitle: "Vendor MSA",
    signers: [alice],
    timestamp: "2026-11-18T09:14:03.000Z",
    type: "envelope.declined",
  });
  assert.equal(
    JSON.stringify(aliceExtracted.payload).includes("bob@example.test"),
    false,
  );
  assert.equal(
    JSON.stringify(aliceExtracted.payload).includes("carol@example.test"),
    false,
  );
  assert.equal(
    JSON.stringify(aliceExtracted.payload).includes("owner@example.test"),
    false,
  );
  assert.equal(
    JSON.stringify(aliceExtracted.payload).includes("INV-42"),
    false,
  );

  // Bob is the declining approver, so his decline reason is included.
  const bobExtracted = extractSignerWebhookPayload(raw, "BOB@example.test");

  assert.equal(bobExtracted.matched, true);
  assert.deepEqual(bobExtracted.payload, {
    envelopeStatus: "declined",
    envelopeTitle: "Vendor MSA",
    reason: "Wrong amount",
    signer: bob,
    signers: [bob],
    timestamp: "2026-11-18T09:14:03.000Z",
    type: "envelope.declined",
  });

  // Carol is a copy recipient.
  const carolExtracted = extractSignerWebhookPayload(raw, "carol@example.test");

  assert.equal(carolExtracted.matched, true);
  assert.deepEqual(carolExtracted.payload, {
    copyRecipients: [carol],
    envelopeStatus: "declined",
    envelopeTitle: "Vendor MSA",
    timestamp: "2026-11-18T09:14:03.000Z",
    type: "envelope.declined",
  });

  // Owner-only email, substring email, null, test event, and invalid JSON do not match.
  assert.deepEqual(extractSignerWebhookPayload(raw, "owner@example.test"), {
    matched: false,
    payload: null,
  });
  assert.deepEqual(extractSignerWebhookPayload(raw, "lice@example.test"), {
    matched: false,
    payload: null,
  });
  assert.deepEqual(extractSignerWebhookPayload(null, "alice@example.test"), {
    matched: false,
    payload: null,
  });
  assert.deepEqual(
    extractSignerWebhookPayload("not-json", "alice@example.test"),
    { matched: false, payload: null },
  );
  assert.deepEqual(
    extractSignerWebhookPayload(
      JSON.stringify({
        data: { message: "A test event from PACTORA. No envelope changed." },
        timestamp: "2026-11-18T09:14:03.000Z",
        type: "webhook.test",
      }),
      "alice@example.test",
    ),
    { matched: false, payload: null },
  );
});

test("exportSignerData and eraseSignerData clean up finished, retrying, pending and orphaned webhook deliveries while preserving active, Part 11 and unrelated records", async () => {
  const alice = "alice@example.test";
  const bob = "bob@example.test";
  const carol = "carol@example.test";

  const alicePayloadEntry = {
    email: "Alice@Example.test",
    id: "s-fin-alice",
    name: "Alice Erased",
    role: "signer",
    status: "signed",
  };
  const bobSharedEntry = {
    email: bob,
    id: "s-fin-bob",
    name: "Bob Co-Signer",
    role: "approver",
    status: "signed",
  };
  const carolEntry = {
    email: carol,
    id: "s-ctrl-carol",
    name: "Carol Control",
    role: "signer",
    status: "signed",
  };

  const state: FakeDbState = {
    auditEvents: [],
    envelopes: [
      {
        createdAt: 100,
        evidenceKey: null,
        id: "env-finished-shared",
        part11: false,
        signedPdfKey: null,
        sourcePdfKey: "test/env-finished-shared.pdf",
        status: "completed",
        title: "Shared completed NDA",
        updatedAt: 101,
        userId: "u-owner",
      },
      {
        createdAt: 110,
        evidenceKey: null,
        id: "env-active",
        part11: false,
        signedPdfKey: null,
        sourcePdfKey: "test/env-active.pdf",
        status: "sent",
        title: "In-flight agreement",
        updatedAt: 111,
        userId: "u-owner",
      },
      {
        createdAt: 120,
        evidenceKey: null,
        id: "env-part11",
        part11: true,
        signedPdfKey: null,
        sourcePdfKey: "test/env-part11.pdf",
        status: "completed",
        title: "Part 11 batch record",
        updatedAt: 121,
        userId: "u-owner",
      },
      {
        createdAt: 130,
        evidenceKey: null,
        id: "env-bob-only",
        part11: false,
        signedPdfKey: null,
        sourcePdfKey: "test/env-bob-only.pdf",
        status: "completed",
        title: "Bob separate contract",
        updatedAt: 131,
        userId: "u-owner",
      },
      {
        createdAt: 140,
        evidenceKey: null,
        id: "env-carol",
        part11: false,
        signedPdfKey: null,
        sourcePdfKey: "test/env-carol.pdf",
        status: "completed",
        title: "Carol unrelated agreement",
        updatedAt: 141,
        userId: "u-owner",
      },
    ],
    fields: [],
    signers: [
      {
        declineReason: null,
        declinedAt: null,
        email: "Alice@Example.test",
        envelopeId: "env-finished-shared",
        id: "s-fin-alice",
        name: "Alice Erased",
        role: "signer",
        signedAt: 101,
        status: "signed",
      },
      {
        declineReason: null,
        declinedAt: null,
        email: bob,
        envelopeId: "env-finished-shared",
        id: "s-fin-bob",
        name: "Bob Co-Signer",
        role: "approver",
        signedAt: 101,
        status: "signed",
      },
      {
        declineReason: null,
        declinedAt: null,
        email: alice,
        envelopeId: "env-active",
        id: "s-active-alice",
        name: "Alice Erased",
        role: "signer",
        signedAt: null,
        status: "notified",
      },
      {
        declineReason: null,
        declinedAt: null,
        email: alice,
        envelopeId: "env-part11",
        id: "s-p11-alice",
        name: "Alice Erased",
        role: "signer",
        signedAt: 121,
        status: "signed",
      },
      {
        declineReason: null,
        declinedAt: null,
        email: bob,
        envelopeId: "env-bob-only",
        id: "s-bob-only",
        name: "Bob Co-Signer",
        role: "signer",
        signedAt: 131,
        status: "signed",
      },
      {
        declineReason: null,
        declinedAt: null,
        email: carol,
        envelopeId: "env-carol",
        id: "s-ctrl-carol",
        name: "Carol Control",
        role: "signer",
        signedAt: 141,
        status: "signed",
      },
    ],
    webhookDeliveries: [
      // Finished shared envelope: delivered, retrying (pending with payload), and untried (pending with null payload).
      {
        createdAt: 102,
        deliveredAt: 103,
        endpointId: "we-1",
        envelopeId: "env-finished-shared",
        eventType: "envelope.completed",
        id: "msg_fin_delivered",
        payload: buildWebhookBody({
          envelopeId: "env-finished-shared",
          envelopeTitle: "Shared completed NDA",
          signers: [alicePayloadEntry, bobSharedEntry],
          type: "envelope.completed",
        }),
        status: "delivered",
      },
      {
        createdAt: 104,
        deliveredAt: null,
        endpointId: "we-1",
        envelopeId: "env-finished-shared",
        eventType: "signer.signed",
        id: "msg_fin_retrying",
        payload: buildWebhookBody({
          envelopeId: "env-finished-shared",
          envelopeTitle: "Shared completed NDA",
          signer: bobSharedEntry,
          signers: [alicePayloadEntry, bobSharedEntry],
          type: "signer.signed",
        }),
        status: "pending",
      },
      {
        createdAt: 105,
        deliveredAt: null,
        endpointId: "we-1",
        envelopeId: "env-finished-shared",
        eventType: "envelope.completed",
        id: "msg_fin_untried",
        payload: null,
        status: "pending",
      },
      // Active envelope delivery for Alice (must be kept).
      {
        createdAt: 112,
        deliveredAt: 113,
        endpointId: "we-1",
        envelopeId: "env-active",
        eventType: "envelope.sent",
        id: "msg_active",
        payload: buildWebhookBody({
          envelopeId: "env-active",
          envelopeStatus: "sent",
          envelopeTitle: "In-flight agreement",
          signers: [
            {
              email: alice,
              id: "s-active-alice",
              name: "Alice Erased",
              role: "signer",
              status: "notified",
            },
          ],
          type: "envelope.sent",
        }),
        status: "delivered",
      },
      // Part 11 envelope delivery for Alice (must be kept).
      {
        createdAt: 122,
        deliveredAt: 123,
        endpointId: "we-1",
        envelopeId: "env-part11",
        eventType: "envelope.completed",
        id: "msg_part11",
        payload: buildWebhookBody({
          envelopeId: "env-part11",
          envelopeTitle: "Part 11 batch record",
          signers: [
            {
              email: alice,
              id: "s-p11-alice",
              name: "Alice Erased",
              role: "signer",
              status: "signed",
            },
          ],
          type: "envelope.completed",
        }),
        status: "delivered",
      },
      // Already-deleted envelope with orphaned payload naming Alice as copy recipient.
      {
        createdAt: 90,
        deliveredAt: 91,
        endpointId: "we-1",
        envelopeId: "env-already-deleted",
        eventType: "envelope.completed",
        id: "msg_orphaned_alice",
        payload: buildWebhookBody({
          copyRecipients: [
            { email: alice, id: "s-cc-alice", name: "Alice Erased" },
          ],
          envelopeId: "env-already-deleted",
          envelopeTitle: "Old deleted agreement",
          signers: [carolEntry],
          type: "envelope.completed",
        }),
        status: "delivered",
      },
      // Bob's separate envelope delivery (must stay untouched).
      {
        createdAt: 132,
        deliveredAt: 133,
        endpointId: "we-1",
        envelopeId: "env-bob-only",
        eventType: "envelope.completed",
        id: "msg_bob_only",
        payload: buildWebhookBody({
          envelopeId: "env-bob-only",
          envelopeTitle: "Bob separate contract",
          owner: { email: alice, id: "u-alice", name: "Alice Owner" },
          signers: [
            {
              email: bob,
              id: "s-bob-only",
              name: "Bob Co-Signer",
              role: "signer",
              status: "signed",
            },
          ],
          type: "envelope.completed",
        }),
        status: "delivered",
      },
      // Carol's unrelated envelope delivery (must stay untouched).
      {
        createdAt: 142,
        deliveredAt: 143,
        endpointId: "we-1",
        envelopeId: "env-carol",
        eventType: "envelope.completed",
        id: "msg_carol",
        payload: buildWebhookBody({
          envelopeId: "env-carol",
          envelopeTitle: "Carol unrelated agreement",
          signers: [carolEntry],
          type: "envelope.completed",
        }),
        status: "delivered",
      },
      // Already-deleted envelope for Carol only (must stay untouched).
      {
        createdAt: 95,
        deliveredAt: 96,
        endpointId: "we-1",
        envelopeId: "env-carol-deleted",
        eventType: "envelope.completed",
        id: "msg_orphaned_carol",
        payload: buildWebhookBody({
          envelopeId: "env-carol-deleted",
          envelopeTitle: "Carol old agreement",
          signers: [carolEntry],
          type: "envelope.completed",
        }),
        status: "delivered",
      },
      // Test webhook delivery (must stay untouched).
      {
        createdAt: 150,
        deliveredAt: 151,
        endpointId: "we-1",
        envelopeId: null,
        eventType: "webhook.test",
        id: "msg_test",
        payload: JSON.stringify({
          data: { message: "A test event from PACTORA. No envelope changed." },
          timestamp: "2026-11-18T09:14:03.000Z",
          type: "webhook.test",
        }),
        status: "delivered",
      },
    ],
  };

  const db = createFakePool(state);

  // Before erasure: Alice's export includes finished, retrying, untried,
  // active, Part 11, and orphaned deliveries — never Bob's/Carol's or owner-only ones.
  const beforeExport = await exportSignerData(alice.toUpperCase(), db);

  assert.deepEqual(
    beforeExport.webhookDeliveries.map((delivery) => delivery.id),
    [
      "msg_orphaned_alice",
      "msg_fin_delivered",
      "msg_fin_retrying",
      "msg_fin_untried",
      "msg_active",
      "msg_part11",
    ],
  );
  assert.equal(
    JSON.stringify(beforeExport.webhookDeliveries).includes(bob),
    false,
  );
  assert.equal(
    JSON.stringify(beforeExport.webhookDeliveries).includes(carol),
    false,
  );
  assert.equal(
    beforeExport.webhookDeliveries.find((d) => d.id === "msg_fin_untried")
      ?.payload,
    null,
  );

  // Erase Alice.
  const result = await eraseSignerData(alice, alice, db);

  assert.deepEqual(result, {
    deletedEnvelopes: 1,
    deletedWebhookDeliveries: 4,
    keptPart11: [{ id: "env-part11", title: "Part 11 batch record" }],
    removedFromDrafts: 0,
    skippedInProgress: [{ id: "env-active", title: "In-flight agreement" }],
  });

  // Remaining webhook_deliveries: active, Part 11, Bob's own, Carol's live &
  // orphaned, and webhook.test — zero deliveries for erased or orphaned Alice envelopes.
  assert.deepEqual(
    state.webhookDeliveries.map((delivery) => delivery.id),
    [
      "msg_active",
      "msg_part11",
      "msg_bob_only",
      "msg_carol",
      "msg_orphaned_carol",
      "msg_test",
    ],
  );

  // After erasure: Alice's export has ONLY the retained active & Part 11 deliveries.
  const afterExport = await exportSignerData(alice, db);

  assert.deepEqual(
    afterExport.envelopes.map((row) => row.envelopeId),
    ["env-active", "env-part11"],
  );
  assert.deepEqual(
    afterExport.webhookDeliveries.map((delivery) => delivery.id),
    ["msg_active", "msg_part11"],
  );

  // Bob's and Carol's separate deliveries are completely intact.
  const bobExport = await exportSignerData(bob, db);

  assert.deepEqual(
    bobExport.webhookDeliveries.map((delivery) => delivery.id),
    ["msg_bob_only"],
  );

  const carolExport = await exportSignerData(carol, db);

  assert.deepEqual(
    carolExport.webhookDeliveries.map((delivery) => delivery.id),
    ["msg_orphaned_carol", "msg_carol"],
  );
});

test("signer correction: historical webhook payload for the previous email is exported and erasable without deleting the live envelope", async () => {
  const previousEmail = "old@example.test";
  const currentEmail = "new@example.test";
  const state: FakeDbState = {
    auditEvents: [],
    envelopes: [
      {
        createdAt: 200,
        evidenceKey: null,
        id: "env-corrected",
        part11: false,
        signedPdfKey: null,
        sourcePdfKey: "test/env-corrected.pdf",
        status: "sent",
        title: "Corrected agreement",
        updatedAt: 201,
        userId: "u-owner",
      },
      {
        createdAt: 210,
        evidenceKey: null,
        id: "env-corrected-p11",
        part11: true,
        signedPdfKey: null,
        sourcePdfKey: "test/env-corrected-p11.pdf",
        status: "sent",
        title: "Corrected Part 11 agreement",
        updatedAt: 211,
        userId: "u-owner",
      },
    ],
    fields: [],
    signers: [
      {
        declineReason: null,
        declinedAt: null,
        email: currentEmail,
        envelopeId: "env-corrected",
        id: "s-1",
        name: "New Signer",
        role: "signer",
        signedAt: null,
        status: "notified",
      },
      {
        declineReason: null,
        declinedAt: null,
        email: currentEmail,
        envelopeId: "env-corrected-p11",
        id: "s-2",
        name: "New Signer",
        role: "signer",
        signedAt: null,
        status: "notified",
      },
    ],
    webhookDeliveries: [
      {
        createdAt: 201,
        deliveredAt: 202,
        endpointId: "we-1",
        envelopeId: "env-corrected",
        eventType: "envelope.sent",
        id: "msg_old_sent",
        payload: buildWebhookBody({
          envelopeId: "env-corrected",
          envelopeStatus: "sent",
          envelopeTitle: "Corrected agreement",
          signers: [
            {
              email: previousEmail,
              id: "s-1",
              name: "Old Signer",
              role: "signer",
              status: "notified",
            },
          ],
          type: "envelope.sent",
        }),
        status: "delivered",
      },
      {
        createdAt: 205,
        deliveredAt: 206,
        endpointId: "we-1",
        envelopeId: "env-corrected",
        eventType: "signer.viewed",
        id: "msg_new_viewed",
        payload: buildWebhookBody({
          envelopeId: "env-corrected",
          envelopeStatus: "sent",
          envelopeTitle: "Corrected agreement",
          signer: {
            email: currentEmail,
            id: "s-1",
            name: "New Signer",
            role: "signer",
            status: "notified",
          },
          signers: [
            {
              email: currentEmail,
              id: "s-1",
              name: "New Signer",
              role: "signer",
              status: "notified",
            },
          ],
          type: "signer.viewed",
        }),
        status: "delivered",
      },
      {
        createdAt: 211,
        deliveredAt: 212,
        endpointId: "we-1",
        envelopeId: "env-corrected-p11",
        eventType: "envelope.sent",
        id: "msg_old_p11",
        payload: buildWebhookBody({
          envelopeId: "env-corrected-p11",
          envelopeStatus: "sent",
          envelopeTitle: "Corrected Part 11 agreement",
          signers: [
            {
              email: previousEmail,
              id: "s-2",
              name: "Old Signer",
              role: "signer",
              status: "notified",
            },
          ],
          type: "envelope.sent",
        }),
        status: "delivered",
      },
    ],
  };

  const db = createFakePool(state);

  // The new signer does not receive the historical delivery carrying only the old email.
  const newExport = await exportSignerData(currentEmail, db);

  assert.deepEqual(
    newExport.webhookDeliveries.map((delivery) => delivery.id),
    ["msg_new_viewed"],
  );

  // The old signer sees both historical deliveries that carry their email.
  const oldBefore = await exportSignerData(previousEmail, db);

  assert.deepEqual(
    oldBefore.webhookDeliveries.map((delivery) => delivery.id),
    ["msg_old_sent", "msg_old_p11"],
  );

  // Erasing the old email removes the non-Part-11 historical delivery only,
  // leaving the live envelope, the new signer's delivery, and the Part 11 delivery intact.
  const erased = await eraseSignerData(previousEmail, previousEmail, db);

  assert.deepEqual(erased, {
    deletedEnvelopes: 0,
    deletedWebhookDeliveries: 1,
    keptPart11: [],
    removedFromDrafts: 0,
    skippedInProgress: [],
  });
  assert.equal(state.envelopes.length, 2);
  assert.deepEqual(
    state.webhookDeliveries.map((delivery) => delivery.id),
    ["msg_new_viewed", "msg_old_p11"],
  );
});

test("eraseSignerData omits deletedWebhookDeliveries when none are deleted and tolerates a missing webhook_deliveries table", async () => {
  const emptyState: FakeDbState = {
    auditEvents: [],
    envelopes: [],
    fields: [],
    signers: [],
    webhookDeliveries: [],
  };

  assert.deepEqual(
    await eraseSignerData(
      "nobody@example.test",
      "nobody@example.test",
      createFakePool(emptyState),
    ),
    {
      deletedEnvelopes: 0,
      keptPart11: [],
      removedFromDrafts: 0,
      skippedInProgress: [],
    },
  );

  const unmigratedDb = createFakePool({
    ...emptyState,
    missingWebhookDeliveriesTable: true,
  });
  const exported = await exportSignerData("nobody@example.test", unmigratedDb);

  assert.deepEqual(exported.webhookDeliveries, []);
  assert.deepEqual(
    await eraseSignerData(
      "nobody@example.test",
      "nobody@example.test",
      unmigratedDb,
    ),
    {
      deletedEnvelopes: 0,
      keptPart11: [],
      removedFromDrafts: 0,
      skippedInProgress: [],
    },
  );
});

test("eraseSignerData deletes webhook deliveries for declined and voided envelopes and removes the signer from drafts", async () => {
  const signerEmail = "decliner@example.test";
  const state: FakeDbState = {
    auditEvents: [],
    envelopes: [
      {
        createdAt: 300,
        evidenceKey: null,
        id: "env-declined",
        part11: false,
        signedPdfKey: null,
        sourcePdfKey: "test/env-declined.pdf",
        status: "declined",
        title: "Declined quote",
        updatedAt: 301,
        userId: "u-owner",
      },
      {
        createdAt: 310,
        evidenceKey: null,
        id: "env-voided",
        part11: false,
        signedPdfKey: null,
        sourcePdfKey: "test/env-voided.pdf",
        status: "voided",
        title: "Voided quote",
        updatedAt: 311,
        userId: "u-owner",
      },
      {
        createdAt: 320,
        evidenceKey: null,
        id: "env-draft",
        part11: false,
        signedPdfKey: null,
        sourcePdfKey: "test/env-draft.pdf",
        status: "draft",
        title: "Draft quote",
        updatedAt: 321,
        userId: "u-owner",
      },
    ],
    fields: [
      {
        checked: null,
        envelopeId: "env-draft",
        imageKey: null,
        inputMethod: null,
        label: null,
        signerId: "s-draft",
        submittedAt: null,
        type: "signature",
        value: null,
      },
    ],
    signers: [
      {
        declineReason: "Not needed",
        declinedAt: 301,
        email: signerEmail,
        envelopeId: "env-declined",
        id: "s-declined",
        name: "Dana Decliner",
        role: "approver",
        signedAt: null,
        status: "declined",
      },
      {
        declineReason: null,
        declinedAt: null,
        email: signerEmail,
        envelopeId: "env-voided",
        id: "s-voided",
        name: "Dana Decliner",
        role: "signer",
        signedAt: null,
        status: "notified",
      },
      {
        declineReason: null,
        declinedAt: null,
        email: signerEmail,
        envelopeId: "env-draft",
        id: "s-draft",
        name: "Dana Decliner",
        role: "signer",
        signedAt: null,
        status: "pending",
      },
    ],
    webhookDeliveries: [
      {
        createdAt: 302,
        deliveredAt: 303,
        endpointId: "we-1",
        envelopeId: "env-declined",
        eventType: "envelope.declined",
        id: "msg_declined",
        payload: buildWebhookBody({
          envelopeId: "env-declined",
          envelopeStatus: "declined",
          envelopeTitle: "Declined quote",
          reason: "Not needed",
          signer: {
            declineReason: "Not needed",
            email: signerEmail,
            id: "s-declined",
            name: "Dana Decliner",
            role: "approver",
            status: "declined",
          },
          signers: [
            {
              declineReason: "Not needed",
              email: signerEmail,
              id: "s-declined",
              name: "Dana Decliner",
              role: "approver",
              status: "declined",
            },
          ],
          type: "envelope.declined",
        }),
        status: "delivered",
      },
      {
        createdAt: 312,
        deliveredAt: null,
        endpointId: "we-1",
        envelopeId: "env-voided",
        eventType: "envelope.voided",
        id: "msg_voided",
        payload: buildWebhookBody({
          envelopeId: "env-voided",
          envelopeStatus: "voided",
          envelopeTitle: "Voided quote",
          reason: "Cancelled by sender",
          signers: [
            {
              email: signerEmail,
              id: "s-voided",
              name: "Dana Decliner",
              role: "signer",
              status: "notified",
            },
          ],
          type: "envelope.voided",
        }),
        status: "failed",
      },
    ],
  };

  const db = createFakePool(state);
  const beforeExport = await exportSignerData(signerEmail, db);

  assert.equal(beforeExport.webhookDeliveries.length, 2);
  assert.equal(
    beforeExport.webhookDeliveries[0]?.payload?.reason,
    "Not needed",
  );
  // Sender's void reason is not copied into the signer's payload extract.
  assert.equal(beforeExport.webhookDeliveries[1]?.payload?.reason, undefined);

  const erased = await eraseSignerData(signerEmail, signerEmail, db);

  assert.deepEqual(erased, {
    deletedEnvelopes: 2,
    deletedWebhookDeliveries: 2,
    keptPart11: [],
    removedFromDrafts: 1,
    skippedInProgress: [],
  });
  assert.equal(state.webhookDeliveries.length, 0);
  assert.deepEqual(
    state.envelopes.map((envelope) => envelope.id),
    ["env-draft"],
  );
  assert.equal(state.signers.length, 0);
  assert.equal(state.fields.length, 0);
  assert.deepEqual(
    (await exportSignerData(signerEmail, db)).webhookDeliveries,
    [],
  );
});

test("eraseSignerData rolls back envelope deletion if webhook delivery cleanup fails", async () => {
  const signerEmail = "atomic@example.test";
  const state: FakeDbState = {
    auditEvents: [],
    envelopes: [
      {
        createdAt: 400,
        evidenceKey: null,
        id: "env-atomic",
        part11: false,
        signedPdfKey: null,
        sourcePdfKey: "missing/atomic.pdf",
        status: "voided",
        title: "Atomic check",
        updatedAt: 401,
        userId: "u-owner",
      },
    ],
    failNextWebhookDelete: true,
    fields: [],
    signers: [
      {
        declineReason: null,
        declinedAt: null,
        email: signerEmail,
        envelopeId: "env-atomic",
        id: "s-atomic",
        name: "Atomic Signer",
        role: "signer",
        signedAt: null,
        status: "notified",
      },
    ],
    webhookDeliveries: [
      {
        createdAt: 402,
        deliveredAt: 403,
        endpointId: "we-1",
        envelopeId: "env-atomic",
        eventType: "envelope.voided",
        id: "msg_atomic",
        payload: buildWebhookBody({
          envelopeId: "env-atomic",
          envelopeStatus: "voided",
          envelopeTitle: "Atomic check",
          signers: [
            {
              email: signerEmail,
              id: "s-atomic",
              name: "Atomic Signer",
              role: "signer",
              status: "notified",
            },
          ],
          type: "envelope.voided",
        }),
        status: "delivered",
      },
    ],
  };

  const db = createFakePool(state);

  await assert.rejects(
    eraseSignerData(signerEmail, signerEmail, db),
    /Simulated webhook deletion interruption/,
  );

  // Envelope row and webhook delivery both remain intact after rollback so the
  // next attempt erases both cleanly.
  assert.deepEqual(
    state.envelopes.map((envelope) => envelope.id),
    ["env-atomic"],
  );
  assert.deepEqual(
    state.webhookDeliveries.map((delivery) => delivery.id),
    ["msg_atomic"],
  );

  const retried = await eraseSignerData(signerEmail, signerEmail, db);

  assert.deepEqual(retried, {
    deletedEnvelopes: 1,
    deletedWebhookDeliveries: 1,
    keptPart11: [],
    removedFromDrafts: 0,
    skippedInProgress: [],
  });
  assert.equal(state.envelopes.length, 0);
  assert.equal(state.webhookDeliveries.length, 0);
});
