import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type pg from "pg";

import { openTestDatabase } from "./db/test-database.ts";
import {
  issueManualSigningLink,
  ManualLinkError,
} from "./manual-signing-link.ts";
import { hashOpaqueToken } from "./services/opaque-tokens.ts";

// The sender's copy-a-signing-link fallback against a real Postgres.
// Run with `npm run test:db`.

const env = { APP_URL: "http://localhost:3000" };
const NOW = Math.floor(Date.now() / 1000);
let database: pg.Pool;
const users: string[] = [];

async function createUser(): Promise<{ email: string; id: string }> {
  const id = randomUUID();
  const email = `${id}@pactora.test`;

  users.push(id);
  await database.query(
    `insert into public."user" (id, name, email, "emailVerified") values ($1, 'Sender', $2, true)`,
    [id, email],
  );

  return { email, id };
}

async function createSentEnvelope(
  ownerId: string,
  { expiresAt = NOW + 86_400 }: { expiresAt?: number } = {},
) {
  const envelopeId = randomUUID();

  await database.query(
    `insert into envelopes (
       id, user_id, title, status, source_pdf_key, source_pdf_filename,
       source_pdf_size_bytes, page_count, source_pdf_hash, sent_at,
       expires_at, created_at, updated_at
     ) values ($1, $2, 'Contract', 'sent', $3, 'c.pdf', 4, 1, $4, $5, $6, $5, $5)`,
    [
      envelopeId,
      ownerId,
      `t/${envelopeId}.pdf`,
      "a".repeat(64),
      NOW - 60,
      expiresAt,
    ],
  );

  const current = randomUUID();
  const waiting = randomUUID();

  await database.query(
    `insert into signers (id, envelope_id, name, email, sign_order, status, signing_token_hash, signing_token_expires_at)
     values ($1, $3, 'First Signer', 'first@pactora.test', 1, 'notified', $4, $5),
            ($2, $3, 'Second Signer', 'second@pactora.test', 2, 'pending', null, null)`,
    [current, waiting, envelopeId, hashOpaqueToken(randomUUID()), NOW + 3600],
  );

  return { current, envelopeId, waiting };
}

before(async () => {
  database = await openTestDatabase();
});

after(async () => {
  await database.query(`delete from public."user" where id = any($1)`, [users]);
  await database.end();
});

test("the sender gets a fresh link that replaces the old one and is audited", async () => {
  const sender = await createUser();
  const { current, envelopeId } = await createSentEnvelope(sender.id);
  const link = await issueManualSigningLink(
    { actor: sender, envelopeId, signerId: current },
    { database, env, now: NOW },
  );

  assert.match(link.url, /^http:\/\/localhost:3000\/sign\/[A-Za-z0-9_-]+$/);

  const token = link.url.split("/").pop()!;
  const signer = await database.query<{ signing_token_hash: string }>(
    "select signing_token_hash from signers where id = $1",
    [current],
  );

  // The old link no longer works: only the new one's hash is stored.
  assert.equal(signer.rows[0]!.signing_token_hash, hashOpaqueToken(token));

  const audit = await database.query<{ actor_type: string; event: string }>(
    "select event, actor_type from audit_events where envelope_id = $1",
    [envelopeId],
  );

  assert.deepEqual(audit.rows, [
    { actor_type: "sender", event: "link_shared" },
  ]);
});

test("nobody but the sender, and nobody whose turn it isn't, gets a link", async () => {
  const sender = await createUser();
  const stranger = await createUser();
  const { current, envelopeId, waiting } = await createSentEnvelope(sender.id);
  const isStatus = (code: number) => (error: unknown) =>
    error instanceof ManualLinkError && error.statusCode === code;

  await assert.rejects(
    issueManualSigningLink(
      { actor: stranger, envelopeId, signerId: current },
      { database, env, now: NOW },
    ),
    isStatus(404),
  );
  await assert.rejects(
    issueManualSigningLink(
      { actor: sender, envelopeId, signerId: waiting },
      { database, env, now: NOW },
    ),
    isStatus(409),
  );
});

test("no link is issued after the deadline", async () => {
  const sender = await createUser();
  const { current, envelopeId } = await createSentEnvelope(sender.id, {
    expiresAt: NOW - 10,
  });

  await assert.rejects(
    issueManualSigningLink(
      { actor: sender, envelopeId, signerId: current },
      { database, env, now: NOW },
    ),
    (error: unknown) =>
      error instanceof ManualLinkError && error.statusCode === 409,
  );
});
