import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import type pg from "pg";

import { openTestDatabase } from "./db/test-database.ts";
import {
  acceptInvitation,
  createInvitation,
  InvitationError,
  listInvitations,
  readInvitation,
  revokeInvitation,
} from "./invitations.ts";
import { getOnboardingState, setOnboardingDismissed } from "./onboarding.ts";
import type {
  EmailService,
  TransactionalEmailMessage,
} from "./services/email.ts";
import { invalidateSettingsCache } from "./settings.ts";

// Workspace invitations and the Getting Started checklist against a real
// Postgres. Run with `npm run test:db`.

const env = { APP_URL: "http://localhost:3000", NODE_ENV: "development" };
let database: pg.Pool;
let owner: { id: string; name: string };

function recordingEmail(sent: TransactionalEmailMessage[]): EmailService {
  return {
    send: async (message) => {
      sent.push(message);

      return { accepted: [message.to], messageId: "m1", rejected: [] };
    },
    sendBatch: async () => [],
  };
}

const failingEmail: EmailService = {
  send: async () => {
    throw new Error("Email is not set up yet.");
  },
  sendBatch: async () => [],
};

function accountCreator() {
  return async (input: { email: string; name: string }) => {
    const id = randomUUID();

    await database.query(
      `insert into public."user" (id, name, email) values ($1, $2, $3)`,
      [id, input.name, input.email],
    );

    return { userId: id };
  };
}

function tokenOf(link: string): string {
  return new URL(link).pathname.split("/").pop()!;
}

before(async () => {
  database = await openTestDatabase();
});

beforeEach(async () => {
  await database.query(`truncate public."user" cascade`);
  await database.query("delete from public.workspace_invitations");
  await database.query("delete from public.app_settings");
  invalidateSettingsCache();
  owner = { id: randomUUID(), name: "Workspace Owner" };
  await database.query(
    `insert into public."user" (id, name, email, role, "emailVerified")
     values ($1, $2, 'owner@pactora.test', 'admin', true)`,
    [owner.id, owner.name],
  );
});

after(async () => {
  await database.query(`truncate public."user" cascade`);
  await database.query("delete from public.workspace_invitations");
  await database.end();
});

test("an invitation is emailed and its link creates a verified ordinary account", async () => {
  const sent: TransactionalEmailMessage[] = [];
  const result = await createInvitation(
    owner,
    { email: "New.Person@Pactora.test" },
    { database, emailService: recordingEmail(sent), env },
  );

  assert.equal(result.emailed, true);
  assert.equal(result.emailError, null);
  assert.equal(result.invitation.email, "new.person@pactora.test");
  assert.equal(result.invitation.status, "pending");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.template, "workspace_invitation");
  assert.ok(sent[0]!.textBody.includes(result.link));

  // Only the hash of the token is stored.
  const stored = await database.query<{ token_hash: string }>(
    "select token_hash from public.workspace_invitations",
  );
  assert.ok(!stored.rows[0]!.token_hash.includes(tokenOf(result.link)));

  const view = await readInvitation(tokenOf(result.link), { database, env });
  assert.equal(view?.email, "new.person@pactora.test");
  assert.equal(view?.inviterName, "Workspace Owner");
  assert.equal(view?.accountExists, false);

  const accepted = await acceptInvitation(
    tokenOf(result.link),
    { name: "New Person", password: "a long enough passphrase" },
    { createAccount: accountCreator(), database },
  );

  assert.equal(accepted.mode, "created");

  const user = await database.query<{ emailVerified: boolean; role: string }>(
    `select "emailVerified", role from public."user" where id = $1`,
    [accepted.userId],
  );
  assert.deepEqual(user.rows[0], { emailVerified: true, role: "user" });

  // One link, one account.
  await assert.rejects(
    acceptInvitation(
      tokenOf(result.link),
      { name: "Again", password: "a long enough passphrase" },
      { createAccount: accountCreator(), database },
    ),
    (error: unknown) =>
      error instanceof InvitationError && error.code === "accepted",
  );
});

test("without email the invitation still stands and the link is returned to copy", async () => {
  const result = await createInvitation(
    owner,
    { email: "colleague@pactora.test" },
    { database, emailService: failingEmail, env },
  );

  assert.equal(result.emailed, false);
  assert.equal(result.emailError, "Email is not set up yet.");
  assert.match(
    result.link,
    /^http:\/\/localhost:3000\/invite\/[A-Za-z0-9_-]+$/,
  );
  assert.equal((await listInvitations(database)).length, 1);
});

test("concurrent acceptances of one link make exactly one account", async () => {
  const { link } = await createInvitation(
    owner,
    { email: "race@pactora.test" },
    { database, emailService: failingEmail, env },
  );
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () =>
      acceptInvitation(
        tokenOf(link),
        { name: "Racer", password: "a long enough passphrase" },
        { createAccount: accountCreator(), database },
      ),
    ),
  );

  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);

  const count = await database.query<{ total: number }>(
    `select count(*)::int as total from public."user" where email = 'race@pactora.test'`,
  );
  assert.equal(count.rows[0]!.total, 1);
});

test("a signed-in person can only accept an invitation for their own address", async () => {
  const { link } = await createInvitation(
    owner,
    { email: "invitee@pactora.test", role: "admin" },
    { database, emailService: failingEmail, env },
  );
  const otherId = randomUUID();

  await database.query(
    `insert into public."user" (id, name, email) values ($1, 'Other', 'other@pactora.test')`,
    [otherId],
  );

  await assert.rejects(
    acceptInvitation(
      tokenOf(link),
      {},
      {
        createAccount: accountCreator(),
        database,
        sessionUser: { email: "other@pactora.test", id: otherId },
      },
    ),
    (error: unknown) =>
      error instanceof InvitationError && error.code === "wrong_account",
  );

  // Not promoted by someone else's invitation.
  const other = await database.query<{ role: string }>(
    `select role from public."user" where id = $1`,
    [otherId],
  );
  assert.equal(other.rows[0]!.role, "user");
});

test("an administrator invitation promotes the invited person", async () => {
  const { link } = await createInvitation(
    owner,
    { email: "second.admin@pactora.test", role: "admin" },
    { database, emailService: failingEmail, env },
  );
  const accepted = await acceptInvitation(
    tokenOf(link),
    { name: "Second Admin", password: "a long enough passphrase" },
    { createAccount: accountCreator(), database },
  );
  const row = await database.query<{ role: string }>(
    `select role from public."user" where id = $1`,
    [accepted.userId],
  );

  assert.equal(row.rows[0]!.role, "admin");
});

test("expired, withdrawn and replaced invitations do not work", async () => {
  const first = await createInvitation(
    owner,
    { email: "late@pactora.test" },
    { database, emailService: failingEmail, env },
  );
  const second = await createInvitation(
    owner,
    { email: "late@pactora.test" },
    { database, emailService: failingEmail, env },
  );

  // Inviting again replaces the first link.
  await assert.rejects(
    acceptInvitation(
      tokenOf(first.link),
      {},
      {
        createAccount: accountCreator(),
        database,
      },
    ),
    (error: unknown) =>
      error instanceof InvitationError && error.code === "revoked",
  );

  await database.query(
    "update public.workspace_invitations set expires_at = 1 where id = $1",
    [second.invitation.id],
  );
  await assert.rejects(
    acceptInvitation(
      tokenOf(second.link),
      {},
      {
        createAccount: accountCreator(),
        database,
      },
    ),
    (error: unknown) =>
      error instanceof InvitationError && error.code === "expired",
  );

  const third = await createInvitation(
    owner,
    { email: "withdrawn@pactora.test" },
    { database, emailService: failingEmail, env },
  );
  await revokeInvitation(third.invitation.id, owner.id, database);
  assert.equal(
    (await readInvitation(tokenOf(third.link), { database, env }))?.status,
    "revoked",
  );
  assert.equal(
    await readInvitation("not-a-real-token-at-all-xx", { database, env }),
    null,
  );
});

test("someone who already has an account cannot be invited again", async () => {
  await assert.rejects(
    createInvitation(
      owner,
      { email: "OWNER@pactora.test" },
      { database, emailService: failingEmail, env },
    ),
    (error: unknown) =>
      error instanceof InvitationError && error.code === "account_exists",
  );
});

test("the checklist reflects the workspace and can be dismissed", async () => {
  const initial = await getOnboardingState(owner.id, { database });

  assert.equal(initial.isAdmin, true);
  assert.equal(initial.dismissed, false);
  assert.deepEqual(initial.steps, {
    brandingAdded: false,
    emailConnected: false,
    firstDocumentCreated: false,
    teamInvited: false,
    workspaceNamed: false,
  });

  await database.query(
    `insert into public.app_settings (id, organization_name, brand_color, created_at, updated_at)
     values (true, 'Pactora Test Co', '#123456', 1, 1)`,
  );
  await createInvitation(
    owner,
    { email: "teammate@pactora.test" },
    { database, emailService: failingEmail, env },
  );

  const progressed = await getOnboardingState(owner.id, { database });

  assert.equal(progressed.steps.workspaceNamed, true);
  assert.equal(progressed.steps.brandingAdded, true);
  assert.equal(progressed.steps.teamInvited, true);

  await setOnboardingDismissed(owner.id, true, { database });
  assert.equal(
    (await getOnboardingState(owner.id, { database })).dismissed,
    true,
  );
  await setOnboardingDismissed(owner.id, false, { database });
  assert.equal(
    (await getOnboardingState(owner.id, { database })).dismissed,
    false,
  );
});
