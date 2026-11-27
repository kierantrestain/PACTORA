import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type pg from "pg";

import {
  AgreementError,
  classifyAgreement,
  listAgreementsForExport,
  listAgreementsForUser,
  sendDueRenewalReminders,
  updateAgreementRecord,
} from "./agreements.ts";
import { openTestDatabase } from "./db/test-database.ts";
import { agreementStates } from "./schemas/agreement.ts";
import type {
  EmailService,
  TransactionalEmailMessage,
} from "./services/email.ts";
import { addTeamMember, createTeam } from "./teams.ts";

// Agreements against a real Postgres: who sees which completed envelopes,
// who may change their details, and that a renewal reminder goes out once
// for each end date. Run with `npm run test:db`.

// Reminders link to the agreement, which is how the tests below pick their
// own out of everything a run sends.
process.env.APP_URL ??= "https://sign.example.test";

const DAY = 24 * 60 * 60;
// 2026-11-27T12:00:00Z: the "today" of the listing tests.
const NOW = 1_795_780_800;
const TODAY = "2026-11-27";

let database: pg.Pool;
const createdUsers: string[] = [];
const createdTeams: string[] = [];
// A word only these envelopes have in their titles, so that lists that
// reach beyond these accounts can be narrowed to them.
const marker = `agr${randomUUID().slice(0, 8)}`;

type Account = { email: string; id: string };

let owner: Account;
let teammate: Account;
let outsider: Account;
let admin: Account;
const envelopes = { completed: "", completedOther: "", draft: "", sent: "" };

async function createAccount(role: "admin" | "user"): Promise<Account> {
  const id = randomUUID();
  const email = `${id}@example.test`;

  createdUsers.push(id);
  await database.query(
    `
      insert into public."user" (id, name, email, "emailVerified", role)
      values ($1, $2, $3, true, $4)
    `,
    [id, `Person ${id.slice(0, 6)}`, email, role],
  );

  return { email, id };
}

async function createEnvelope(
  ownerId: string,
  status: "completed" | "draft" | "sent",
  title: string,
  completedAt = NOW - 30 * DAY,
): Promise<string> {
  const envelopeId = randomUUID();

  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash, sent_at,
        completed_at, created_at, updated_at
      ) values ($1, $2, $3, $4, $5, 'contract.pdf', 4, 1, $6, $7, $8, $9, $9)
    `,
    [
      envelopeId,
      ownerId,
      `${title} ${marker}`,
      status,
      `test/${envelopeId}.pdf`,
      "a".repeat(64),
      status === "draft" ? null : completedAt - DAY,
      status === "completed" ? completedAt : null,
      completedAt - 2 * DAY,
    ],
  );

  return envelopeId;
}

function capturingEmailService({
  failFor,
}: { failFor?: string } = {}): EmailService & {
  sent: TransactionalEmailMessage[];
} {
  const sent: TransactionalEmailMessage[] = [];

  return {
    sent,
    async send(message) {
      if (failFor && message.textBody.includes(failFor)) {
        throw new Error("The mail provider is down.");
      }

      sent.push(message);
      return { accepted: [message.to], rejected: [] };
    },
    async sendBatch() {
      throw new Error("Renewal reminders are sent one at a time.");
    },
  };
}

function isAgreementError(statusCode: number) {
  return (error: unknown) =>
    error instanceof AgreementError && error.statusCode === statusCode;
}

before(async () => {
  database = await openTestDatabase();

  owner = await createAccount("user");
  teammate = await createAccount("user");
  outsider = await createAccount("user");
  admin = await createAccount("admin");

  envelopes.draft = await createEnvelope(owner.id, "draft", "Draft lease");
  envelopes.sent = await createEnvelope(owner.id, "sent", "Sent lease");
  envelopes.completed = await createEnvelope(
    owner.id,
    "completed",
    "Supply agreement",
  );
  envelopes.completedOther = await createEnvelope(
    owner.id,
    "completed",
    "Hosting contract",
    NOW - 10 * DAY,
  );

  const actor = { email: admin.email, userId: admin.id };
  const team = await createTeam(actor, { name: `Legal ${marker}` }, database);

  createdTeams.push(team.id);
  await addTeamMember(actor, team.id, { email: owner.email }, database);
  await addTeamMember(actor, team.id, { email: teammate.email }, database);
});

after(async () => {
  await database.query(`delete from teams where id = any($1)`, [createdTeams]);
  // The envelopes and their agreement records go with their sender.
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();
});

test("a sender sees their own completed envelopes as agreements, and nothing else", async () => {
  const result = await listAgreementsForUser(owner.id, {}, database, {
    now: NOW,
  });
  const ids = result.agreements.map((agreement) => agreement.envelopeId);

  assert.deepEqual(
    new Set(ids),
    new Set([envelopes.completed, envelopes.completedOther]),
  );
  assert.ok(!ids.includes(envelopes.draft));
  assert.ok(!ids.includes(envelopes.sent));
  assert.equal(result.view, "mine");
  assert.deepEqual(result.views, ["mine", "team"]);
  assert.equal(result.today, TODAY);
  assert.equal(result.summary.total, 2);
  assert.equal(result.summary.noEndDate, 2);

  // Nothing filled in yet: listed all the same, with the defaults.
  const supply = result.agreements.find(
    (agreement) => agreement.envelopeId === envelopes.completed,
  );

  assert.equal(supply?.hasDetails, false);
  assert.equal(supply?.canEdit, true);
  assert.equal(supply?.state, "no_end_date");
  assert.equal(supply?.renewalNoticeDays, 30);
  assert.equal(supply?.currency, "USD");
  assert.equal(supply?.ownerLabel, undefined);
  // Without an end date, the latest completed comes first.
  assert.deepEqual(ids, [envelopes.completedOther, envelopes.completed]);
});

test("someone not on the sender's team sees none of their agreements", async () => {
  for (const view of ["mine", "team", "all"] as const) {
    const result = await listAgreementsForUser(
      outsider.id,
      { search: marker, view },
      database,
      { now: NOW },
    );

    assert.deepEqual(result.agreements, [], view);
    assert.equal(result.summary.total, 0, view);
    assert.equal(result.view, "mine", view);
  }

  // Not even by naming the envelope.
  const linked = await listAgreementsForUser(
    outsider.id,
    { envelopeId: envelopes.completed },
    database,
    { now: NOW },
  );

  assert.deepEqual(linked.agreements, []);
});

test("a teammate and an administrator see the sender's agreements, and cannot change them", async () => {
  const teamView = await listAgreementsForUser(
    teammate.id,
    { view: "team" },
    database,
    { now: NOW },
  );
  const seen = teamView.agreements.find(
    (agreement) => agreement.envelopeId === envelopes.completed,
  );

  assert.equal(teamView.view, "team");
  assert.equal(seen?.canEdit, false);
  assert.match(seen?.ownerLabel ?? "", new RegExp(owner.email));
  assert.ok(
    !teamView.agreements.some(
      (agreement) =>
        agreement.envelopeId === envelopes.sent ||
        agreement.envelopeId === envelopes.draft,
    ),
  );

  // A teammate's own view holds only their own.
  const mine = await listAgreementsForUser(teammate.id, {}, database, {
    now: NOW,
  });

  assert.deepEqual(mine.agreements, []);

  // A link to the envelope's agreement finds it in the widest view.
  const linked = await listAgreementsForUser(
    teammate.id,
    { envelopeId: envelopes.completed },
    database,
    { now: NOW },
  );

  assert.equal(linked.view, "team");
  assert.deepEqual(
    linked.agreements.map((agreement) => agreement.envelopeId),
    [envelopes.completed],
  );

  const everyone = await listAgreementsForUser(
    admin.id,
    { search: marker, view: "all" },
    database,
    { now: NOW },
  );

  assert.equal(everyone.view, "all");
  assert.deepEqual(
    new Set(everyone.agreements.map((agreement) => agreement.envelopeId)),
    new Set([envelopes.completed, envelopes.completedOther]),
  );
  assert.ok(everyone.agreements.every((agreement) => !agreement.canEdit));

  for (const viewer of [teammate, admin, outsider]) {
    await assert.rejects(
      updateAgreementRecord(
        viewer.id,
        envelopes.completed,
        { counterparty: "Not theirs" },
        database,
      ),
      isAgreementError(404),
    );
  }
});

test("a view someone does not have falls back to their own", async () => {
  const result = await listAgreementsForUser(
    owner.id,
    { search: marker, view: "all" },
    database,
    { now: NOW },
  );

  assert.equal(result.view, "mine");
  assert.equal(result.agreements.length, 2);
});

test("only the sender of a completed envelope saves its details", async () => {
  await assert.rejects(
    updateAgreementRecord(owner.id, envelopes.sent, { notes: "x" }, database),
    isAgreementError(409),
  );
  await assert.rejects(
    updateAgreementRecord(owner.id, envelopes.draft, { notes: "x" }, database),
    isAgreementError(409),
  );
  await assert.rejects(
    updateAgreementRecord(owner.id, randomUUID(), { notes: "x" }, database),
    isAgreementError(404),
  );
  await assert.rejects(
    updateAgreementRecord(
      owner.id,
      envelopes.completed,
      { renewalNoticeDays: 400 },
      database,
    ),
    isAgreementError(400),
  );

  const saved = await updateAgreementRecord(
    owner.id,
    envelopes.completed,
    {
      contractValueCents: 1_250_050,
      counterparty: "Acme Ltd",
      currency: "eur",
      effectiveDate: "2026-01-01",
      endDate: "2026-12-17",
      renewalNoticeDays: 30,
      tags: ["Supplier", "NDA"],
    },
    database,
    { now: NOW },
  );

  assert.equal(saved.hasDetails, true);
  assert.equal(saved.counterparty, "Acme Ltd");
  assert.equal(saved.currency, "EUR");
  assert.equal(saved.valueLabel, "€12,500.50");
  assert.equal(saved.effectiveDate, "2026-01-01");
  assert.equal(saved.endDate, "2026-12-17");
  assert.equal(saved.daysUntilEnd, 20);
  assert.equal(saved.state, "expiring");
  assert.deepEqual(saved.tags, ["Supplier", "NDA"]);
  assert.equal(saved.updatedAt, NOW);

  const stored = await database.query<{ updatedBy: string }>(
    `select updated_by as "updatedBy" from agreement_records where envelope_id = $1`,
    [envelopes.completed],
  );

  assert.equal(stored.rows[0]?.updatedBy, owner.id);

  // A change that leaves fields out keeps them.
  const changed = await updateAgreementRecord(
    owner.id,
    envelopes.completed,
    { notes: "Renegotiate the volume discount." },
    database,
    { now: NOW },
  );

  assert.equal(changed.counterparty, "Acme Ltd");
  assert.equal(changed.endDate, "2026-12-17");
  assert.equal(changed.notes, "Renegotiate the volume discount.");

  // An end date before the stored effective date does not hold together.
  await assert.rejects(
    updateAgreementRecord(
      owner.id,
      envelopes.completed,
      { endDate: "2025-12-31" },
      database,
    ),
    (error: unknown) =>
      isAgreementError(400)(error) &&
      /before the effective date/.test((error as Error).message),
  );
});

test("the list filters by state, search, tag and window, and pages", async () => {
  await updateAgreementRecord(
    owner.id,
    envelopes.completedOther,
    {
      contractValueCents: 50_000,
      counterparty: "Northwind Hosting",
      endDate: "2027-06-30",
      renewalNoticeDays: 60,
      tags: ["nda"],
    },
    database,
    { now: NOW },
  );

  const list = async (filters: Parameters<typeof listAgreementsForUser>[1]) =>
    (
      await listAgreementsForUser(owner.id, filters, database, { now: NOW })
    ).agreements.map((agreement) => agreement.envelopeId);

  // Ending soonest first.
  assert.deepEqual(await list({}), [
    envelopes.completed,
    envelopes.completedOther,
  ]);
  assert.deepEqual(await list({ state: "expiring" }), [envelopes.completed]);
  assert.deepEqual(await list({ state: "active" }), [envelopes.completedOther]);
  assert.deepEqual(await list({ state: "expired" }), []);
  assert.deepEqual(await list({ state: "no_end_date" }), []);
  // Within 10 days, the agreement ending in 20 is not expiring.
  assert.deepEqual(await list({ state: "expiring", withinDays: 10 }), []);
  assert.deepEqual(await list({ state: "expiring", withinDays: 365 }), [
    envelopes.completed,
    envelopes.completedOther,
  ]);
  assert.deepEqual(await list({ search: "northwind" }), [
    envelopes.completedOther,
  ]);
  assert.deepEqual(await list({ search: "SUPPLY AGREEMENT" }), [
    envelopes.completed,
  ]);
  // A search for a LIKE wildcard matches only the character.
  assert.deepEqual(await list({ search: "%" }), []);
  // Tags match whatever their case.
  assert.deepEqual(await list({ tag: "NDA" }), [
    envelopes.completed,
    envelopes.completedOther,
  ]);
  assert.deepEqual(await list({ tag: "supplier" }), [envelopes.completed]);

  const firstPage = await listAgreementsForUser(
    owner.id,
    { limit: 1 },
    database,
    { now: NOW },
  );

  assert.equal(firstPage.agreements.length, 1);
  assert.equal(firstPage.nextCursor, "1");

  const secondPage = await listAgreementsForUser(
    owner.id,
    { cursor: Number(firstPage.nextCursor), limit: 1 },
    database,
    { now: NOW },
  );

  assert.deepEqual(
    secondPage.agreements.map((agreement) => agreement.envelopeId),
    [envelopes.completedOther],
  );
  assert.equal(secondPage.nextCursor, undefined);

  // The figures are for the whole view, whatever the filters.
  assert.equal(firstPage.summary.total, 2);
  assert.equal(firstPage.summary.active, 1);
  assert.equal(firstPage.summary.expiringWithin30Days, 1);
  assert.deepEqual(
    firstPage.summary.valueByCurrency.map((value) => [
      value.currency,
      value.totalCents,
    ]),
    [
      ["EUR", 1_250_050],
      ["USD", 50_000],
    ],
  );
  // One of each, in whichever case was seen first.
  assert.deepEqual(
    firstPage.tags.map((tag) => tag.toLowerCase()),
    ["nda", "supplier"],
  );

  // On the day after its end date, the first has expired.
  const later = await listAgreementsForUser(
    owner.id,
    { state: "expired" },
    database,
    { now: NOW + 21 * DAY },
  );

  assert.deepEqual(
    later.agreements.map((agreement) => agreement.envelopeId),
    [envelopes.completed],
  );

  const exported = await listAgreementsForExport(
    owner.id,
    { limit: 1, tag: "nda" },
    database,
    { now: NOW },
  );

  // The export is not paged.
  assert.equal(exported.agreements.length, 2);
});

test("the list's state filter agrees with classifyAgreement at the edges", async () => {
  const viewer = await createAccount("user");
  const cases = [
    { endDate: "2026-11-26", renewalNoticeDays: 30 }, // ended yesterday
    { endDate: TODAY, renewalNoticeDays: 0 }, // ends today
    { endDate: "2026-12-27", renewalNoticeDays: 30 }, // notice opens today
    { endDate: "2026-12-28", renewalNoticeDays: 30 }, // opens tomorrow
    { endDate: null, renewalNoticeDays: 30 },
  ];
  const ids: string[] = [];

  for (const [index, details] of cases.entries()) {
    const envelopeId = await createEnvelope(
      viewer.id,
      "completed",
      `Edge ${String(index)}`,
    );

    ids.push(envelopeId);
    await updateAgreementRecord(viewer.id, envelopeId, details, database, {
      now: NOW,
    });
  }

  assert.deepEqual(
    cases.map((details) => classifyAgreement(details, TODAY)),
    ["expired", "expiring", "expiring", "active", "no_end_date"],
  );

  for (const state of agreementStates) {
    const listed = (
      await listAgreementsForUser(viewer.id, { state }, database, {
        now: NOW,
      })
    ).agreements.map((agreement) => agreement.envelopeId);

    assert.deepEqual(
      new Set(listed),
      new Set(
        ids.filter(
          (_, index) => classifyAgreement(cases[index]!, TODAY) === state,
        ),
      ),
      state,
    );
  }
});

test("a renewal reminder goes to the sender once for each end date", async () => {
  // Far from every other agreement in the shared database, so only these
  // are due.
  const now = 20_000_000_000; // 2603-10-11T11:33:20Z
  const envelopeId = await createEnvelope(
    owner.id,
    "completed",
    "Renewal reminder",
    now - 400 * DAY,
  );

  await updateAgreementRecord(
    owner.id,
    envelopeId,
    {
      counterparty: "Contoso",
      endDate: "2603-11-10", // 30 days on
      renewalNoticeDays: 31,
    },
    database,
    { now },
  );

  const mine = (service: { sent: TransactionalEmailMessage[] }) =>
    service.sent.filter((message) => message.textBody.includes(envelopeId));

  // Not due the day before its notice period opens.
  const early = capturingEmailService();

  await sendDueRenewalReminders(database, now - 2 * DAY, {
    appUrl: "https://sign.example.test",
    emailService: early,
  });
  assert.deepEqual(mine(early), []);

  const first = capturingEmailService();
  const firstRun = await sendDueRenewalReminders(database, now, {
    appUrl: "https://sign.example.test",
    emailService: first,
  });

  assert.equal(mine(first).length, 1);
  assert.equal(mine(first)[0]?.to, owner.email);
  assert.equal(mine(first)[0]?.template, "renewal_reminder");
  assert.match(mine(first)[0]?.textBody ?? "", /with Contoso ends on/);
  assert.ok(firstRun.remindersSent >= 1);

  const stored = await database.query<{ remindedFor: string }>(
    `
      select to_char(renewal_reminded_for, 'YYYY-MM-DD') as "remindedFor"
      from agreement_records where envelope_id = $1
    `,
    [envelopeId],
  );

  assert.equal(stored.rows[0]?.remindedFor, "2603-11-10");

  // Not again for the same end date, on the same day or later.
  const second = capturingEmailService();

  await sendDueRenewalReminders(database, now, { emailService: second });
  await sendDueRenewalReminders(database, now + 5 * DAY, {
    emailService: second,
  });
  assert.deepEqual(mine(second), []);

  // A new end date is due a reminder of its own.
  await updateAgreementRecord(
    owner.id,
    envelopeId,
    { endDate: "2603-10-20" },
    database,
    { now },
  );

  const third = capturingEmailService();

  await sendDueRenewalReminders(database, now, { emailService: third });
  assert.equal(mine(third).length, 1);
  assert.match(mine(third)[0]?.subject ?? "", /ends on Oct 20, 2603/);
});

test("a reminder that fails is tried again on the next run, and no reminder goes out for a past end date", async () => {
  const now = 20_100_000_000;
  const envelopeId = await createEnvelope(
    owner.id,
    "completed",
    "Failing reminder",
    now - 400 * DAY,
  );
  const pastId = await createEnvelope(
    owner.id,
    "completed",
    "Already ended",
    now - 400 * DAY,
  );
  const today = new Date(now * 1000).toISOString().slice(0, 10);
  const yesterday = new Date((now - DAY) * 1000).toISOString().slice(0, 10);

  await updateAgreementRecord(
    owner.id,
    envelopeId,
    { endDate: today, renewalNoticeDays: 0 },
    database,
    { now },
  );
  await updateAgreementRecord(
    owner.id,
    pastId,
    { endDate: yesterday, renewalNoticeDays: 30 },
    database,
    { now },
  );

  const failing = capturingEmailService({ failFor: envelopeId });
  const originalError = console.error;
  let failed: Awaited<ReturnType<typeof sendDueRenewalReminders>>;

  console.error = () => undefined;

  try {
    failed = await sendDueRenewalReminders(database, now, {
      emailService: failing,
    });
  } finally {
    console.error = originalError;
  }

  assert.ok(failed.failures.includes(envelopeId));
  assert.ok(!failing.sent.some((message) => message.textBody.includes(pastId)));

  const retry = capturingEmailService();

  await sendDueRenewalReminders(database, now, { emailService: retry });
  assert.equal(
    retry.sent.filter((message) => message.textBody.includes(envelopeId))
      .length,
    1,
  );
  assert.match(
    retry.sent.find((message) => message.textBody.includes(envelopeId))
      ?.subject ?? "",
    /ends today/,
  );
  assert.ok(!retry.sent.some((message) => message.textBody.includes(pastId)));
});

test("an agreement's details go when its envelope does", async () => {
  const envelopeId = await createEnvelope(
    owner.id,
    "completed",
    "Deleted later",
  );

  await updateAgreementRecord(
    owner.id,
    envelopeId,
    { counterparty: "Gone Ltd" },
    database,
  );
  await database.query(`delete from envelopes where id = $1`, [envelopeId]);

  const left = await database.query(
    `select 1 from agreement_records where envelope_id = $1`,
    [envelopeId],
  );

  assert.equal(left.rowCount, 0);
});

test("the database refuses details the schema would", async () => {
  const envelopeId = await createEnvelope(owner.id, "completed", "Checks");

  for (const [column, value] of [
    ["currency", "usd"],
    ["contract_value_cents", -1],
    ["renewal_notice_days", 366],
    ["tags", ["x".repeat(41)]],
    ["tags", [" padded"]],
    ["tags", Array.from({ length: 21 }, (_, i) => `t${String(i)}`)],
  ] as const) {
    await assert.rejects(
      database.query(
        `insert into agreement_records (envelope_id, ${column}) values ($1, $2)`,
        [envelopeId, value],
      ),
      /violates check constraint/,
      column,
    );
  }

  await assert.rejects(
    database.query(
      `
        insert into agreement_records (envelope_id, effective_date, end_date)
        values ($1, '2027-01-02', '2027-01-01')
      `,
      [envelopeId],
    ),
    /agreement_records_end_after_effective/,
  );
});
