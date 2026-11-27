import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import type pg from "pg";

import { openTestDatabase } from "../db/test-database.ts";
import {
  createStorageService,
  type StorageService,
} from "../services/storage.ts";
import {
  BuilderDocumentError,
  createBuilderDocument,
  createEnvelopeFromBuilderDocument,
  deleteBuilderDocument,
  getBuilderDocument,
  listBuilderDocuments,
  saveBuilderDocument,
} from "./store.ts";

// The Document Builder against a real Postgres: saving with revisions,
// keeping documents private, and turning one into a draft envelope with its
// signers and fields in place. Run with `npm run test:db`.

let database: pg.Pool;
let storageDir: string;
let storageService: StorageService;
const createdUsers: string[] = [];

before(async () => {
  database = await openTestDatabase();
  storageDir = await mkdtemp(path.join(tmpdir(), "pactora-builder-"));
  storageService = createStorageService({
    env: { STORAGE_DRIVER: "local", STORAGE_LOCAL_DIR: storageDir },
  });
});

after(async () => {
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();
  await rm(storageDir, { force: true, recursive: true });
});

async function createUser(): Promise<string> {
  const userId = randomUUID();

  createdUsers.push(userId);
  await database.query(
    `insert into public."user" (id, name, email, role, "emailVerified") values ($1, 'Sam Sender', $2, 'user', true)`,
    [userId, `${userId}@example.test`],
  );

  return userId;
}

async function fillAllVariables(userId: string, documentId: string) {
  const document = (await getBuilderDocument(userId, documentId, database))!;

  return saveBuilderDocument(
    userId,
    documentId,
    {
      content: {
        ...document.content,
        variables: document.content.variables.map((variable) => ({
          ...variable,
          value: variable.value || `Value of ${variable.key}`,
        })),
      },
      expectedRevision: document.revision,
      title: document.title,
    },
    database,
  );
}

test("a starter becomes a private document that saves with revisions", async () => {
  const owner = await createUser();
  const stranger = await createUser();
  const { id } = await createBuilderDocument(
    owner,
    { starterId: "mutual-nda" },
    database,
  );
  const document = (await getBuilderDocument(owner, id, database))!;

  assert.equal(document.title, "Mutual NDA");
  assert.equal(document.revision, 0);
  assert.equal(await getBuilderDocument(stranger, id, database), null);
  assert.deepEqual(await listBuilderDocuments(stranger, database), []);

  const saved = await saveBuilderDocument(
    owner,
    id,
    {
      content: document.content,
      expectedRevision: 0,
      title: "NDA with Acme",
    },
    database,
  );

  assert.equal(saved.revision, 1);

  // A second editor still on revision 0 is refused instead of overwriting.
  await assert.rejects(
    saveBuilderDocument(
      owner,
      id,
      { content: document.content, expectedRevision: 0, title: "Stale" },
      database,
    ),
    (error) =>
      error instanceof BuilderDocumentError && error.statusCode === 409,
  );

  await assert.rejects(
    saveBuilderDocument(
      stranger,
      id,
      { content: document.content, title: "Hijack" },
      database,
    ),
    (error) =>
      error instanceof BuilderDocumentError && error.statusCode === 404,
  );

  const [summary] = await listBuilderDocuments(owner, database);

  assert.equal(summary?.title, "NDA with Acme");
});

test("a document with empty variables cannot be sent", async () => {
  const owner = await createUser();
  const { id } = await createBuilderDocument(
    owner,
    { starterId: "sales-proposal" },
    database,
  );

  await assert.rejects(
    createEnvelopeFromBuilderDocument(
      owner,
      id,
      {
        recipients: [
          {
            email: "c@example.test",
            name: "Casey Client",
            roleId: "role-client",
          },
        ],
      },
      { database, storageService },
    ),
    (error) =>
      error instanceof BuilderDocumentError &&
      error.statusCode === 400 &&
      error.message.includes("{{client.name}}"),
  );
});

test("sending opens a draft envelope with each role's signer and every field placed", async () => {
  const owner = await createUser();
  const { id } = await createBuilderDocument(
    owner,
    { starterId: "contractor-agreement" },
    database,
  );

  await fillAllVariables(owner, id);

  // Every role must be named, once.
  await assert.rejects(
    createEnvelopeFromBuilderDocument(
      owner,
      id,
      {
        recipients: [
          { email: "a@example.test", name: "Ada", roleId: "role-company" },
        ],
      },
      { database, storageService },
    ),
    (error) =>
      error instanceof BuilderDocumentError && error.statusCode === 400,
  );

  const result = await createEnvelopeFromBuilderDocument(
    owner,
    id,
    {
      recipients: [
        {
          email: "ada@example.test",
          name: "Ada Owner",
          roleId: "role-company",
        },
        {
          email: "cy@example.test",
          name: "Cy Contractor",
          roleId: "role-contractor",
        },
      ],
    },
    { database, storageService },
  );

  assert.equal(result.redirectPath, `/envelopes/${result.envelopeId}/review`);

  const envelope = await database.query<{ status: string; title: string }>(
    `select status, title from envelopes where id = $1 and user_id = $2`,
    [result.envelopeId, owner],
  );

  assert.deepEqual(envelope.rows[0], {
    status: "draft",
    title: "Contractor agreement",
  });

  const fields = await database.query<{
    email: string;
    required: boolean;
    type: string;
  }>(
    `
      select s.email, f.type, f.required
      from fields f join signers s on s.id = f.signer_id
      where f.envelope_id = $1
      order by s.sign_order, f.type
    `,
    [result.envelopeId],
  );

  assert.deepEqual(
    fields.rows.map((row) => `${row.email}:${row.type}`),
    [
      "ada@example.test:date",
      "ada@example.test:name",
      "ada@example.test:signature",
      "cy@example.test:checkbox",
      "cy@example.test:date",
      "cy@example.test:name",
      "cy@example.test:signature",
    ],
  );
  assert.ok(fields.rows.every((row) => row.required));

  const document = (await getBuilderDocument(owner, id, database))!;

  assert.equal(document.envelopeId, result.envelopeId);
  assert.equal(document.envelopeStatus, "draft");
});

test("a template is kept apart, used by copying, and deleted on its own", async () => {
  const owner = await createUser();
  const { id } = await createBuilderDocument(
    owner,
    { starterId: "offer-letter" },
    database,
  );
  const template = await createBuilderDocument(
    owner,
    { asTemplate: true, sourceId: id },
    database,
  );
  const saved = (await getBuilderDocument(owner, template.id, database))!;

  assert.equal(saved.isTemplate, true);
  await assert.rejects(
    createEnvelopeFromBuilderDocument(
      owner,
      template.id,
      { recipients: [] },
      { database, storageService },
    ),
  );

  const copy = await createBuilderDocument(
    owner,
    { sourceId: template.id },
    database,
  );
  const copied = (await getBuilderDocument(owner, copy.id, database))!;

  assert.equal(copied.isTemplate, false);
  assert.equal(copied.title, "Offer letter");

  await deleteBuilderDocument(owner, template.id, database);
  assert.equal(await getBuilderDocument(owner, template.id, database), null);
  assert.ok(await getBuilderDocument(owner, copy.id, database));
  await assert.rejects(
    deleteBuilderDocument(owner, template.id, database),
    (error) =>
      error instanceof BuilderDocumentError && error.statusCode === 404,
  );
});
