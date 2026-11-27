import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import { verifyPassword } from "better-auth/crypto";
import type pg from "pg";

import { openTestDatabase } from "./db/test-database.ts";
import {
  OwnerProvisioningError,
  promoteOwner,
  provisionOwner,
} from "./owner-cli.ts";
import { evaluateSignupRequest, invalidateSettingsCache } from "./settings.ts";
import { completeSetup, SetupError } from "./setup.ts";

// Owner provisioning against a real Postgres: one winner under concurrent
// registration, no web claim on a public deployment, and the CLI path.
// Run with `npm run test:db`.

const LOCAL_ENV = { NODE_ENV: "development" };
const PUBLIC_ENV = {
  NODE_ENV: "production",
  VERCEL: "1",
  VERCEL_ENV: "production",
  VERCEL_PROJECT_PRODUCTION_URL: "pactora.example.app",
};

let database: pg.Pool;

function accountCreator(created: string[]) {
  return async (input: { email: string; name: string }) => {
    const id = randomUUID();

    created.push(input.email);
    await database.query(
      `insert into public."user" (id, name, email) values ($1, $2, $3)`,
      [id, input.name, input.email],
    );

    return { userId: id };
  };
}

async function roles(): Promise<Array<{ email: string; role: string }>> {
  const result = await database.query<{ email: string; role: string }>(
    `select email, role from public."user" order by email`,
  );

  return result.rows;
}

before(async () => {
  database = await openTestDatabase();
});

beforeEach(async () => {
  await database.query(`truncate public."user" cascade`);
  await database.query("delete from public.app_settings");
  invalidateSettingsCache();
});

after(async () => {
  await database.query(`truncate public."user" cascade`);
  await database.query("delete from public.app_settings");
  await database.end();
});

test("concurrent first-owner registrations produce exactly one owner", async () => {
  const created: string[] = [];
  const attempts = Array.from({ length: 6 }, (_, index) =>
    completeSetup(
      {
        email: `tester${String(index)}@pactora.test`,
        fullName: `Tester ${String(index)}`,
        password: "a long enough passphrase",
      },
      {
        createAdminAccount: accountCreator(created),
        database,
        env: LOCAL_ENV,
        setupToken: "waived",
      },
    ),
  );
  const results = await Promise.allSettled(attempts);
  const winners = results.filter((result) => result.status === "fulfilled");
  const losers = results.filter((result) => result.status === "rejected");

  assert.equal(winners.length, 1);
  assert.equal(losers.length, 5);

  for (const loser of losers) {
    assert.ok(loser.reason instanceof SetupError);
    assert.equal(loser.reason.statusCode, 409);
  }

  // Losers are turned away before an account is made for them.
  assert.equal(created.length, 1);
  assert.deepEqual(await roles(), [{ email: created[0], role: "admin" }]);
});

test("the owner is verified and later sign-ups follow the rule as ordinary users", async () => {
  await completeSetup(
    {
      email: "owner@pactora.test",
      fullName: "Workspace Owner",
      password: "a long enough passphrase",
    },
    {
      createAdminAccount: accountCreator([]),
      database,
      env: LOCAL_ENV,
      setupToken: "waived",
    },
  );

  const owner = await database.query<{ emailVerified: boolean; role: string }>(
    `select "emailVerified", role from public."user" where email = 'owner@pactora.test'`,
  );

  assert.deepEqual(owner.rows[0], { emailVerified: true, role: "admin" });

  // The owner's own domain may join; nobody else.
  assert.deepEqual(
    await evaluateSignupRequest("colleague@pactora.test", LOCAL_ENV, database),
    { allowed: true },
  );
  assert.equal(
    (
      await evaluateSignupRequest(
        "stranger@elsewhere.test",
        LOCAL_ENV,
        database,
      )
    ).allowed,
    false,
  );

  // A second registration attempt never becomes an owner.
  await assert.rejects(
    completeSetup(
      {
        email: "colleague@pactora.test",
        fullName: "Colleague",
        password: "a long enough passphrase",
      },
      {
        createAdminAccount: accountCreator([]),
        database,
        env: LOCAL_ENV,
        setupToken: "waived",
      },
    ),
    (error: unknown) => error instanceof SetupError && error.statusCode === 409,
  );
  assert.equal((await roles()).filter((row) => row.role === "admin").length, 1);
});

test("an unauthorised visitor cannot claim a public deployment", async () => {
  const created: string[] = [];

  for (const setupToken of ["waived", "required-when-set"] as const) {
    await assert.rejects(
      completeSetup(
        {
          email: "intruder@pactora.test",
          fullName: "Intruder",
          password: "a long enough passphrase",
        },
        {
          createAdminAccount: accountCreator(created),
          database,
          env: PUBLIC_ENV,
          setupToken,
        },
      ),
      (error: unknown) =>
        error instanceof SetupError && error.statusCode === 403,
    );
  }

  assert.deepEqual(created, []);
  assert.deepEqual(await roles(), []);
});

test("the operator provisions the owner from the command line", async () => {
  const result = await provisionOwner(
    {
      email: "Owner@Pactora.test",
      name: "Workspace Owner",
      password: "a long enough passphrase",
    },
    database,
  );

  assert.equal(result.email, "owner@pactora.test");
  assert.deepEqual(await roles(), [
    { email: "owner@pactora.test", role: "admin" },
  ]);

  const credential = await database.query<{ password: string }>(
    `select password from public.account where "userId" = $1 and "providerId" = 'credential'`,
    [result.userId],
  );

  assert.equal(
    await verifyPassword({
      hash: credential.rows[0]!.password,
      password: "a long enough passphrase",
    }),
    true,
  );

  await assert.rejects(
    provisionOwner(
      {
        email: "second@pactora.test",
        name: "Second",
        password: "a long enough passphrase",
      },
      database,
    ),
    OwnerProvisioningError,
  );
});

test("an install with accounts but no owner is claimed by promoting a verified account", async () => {
  await database.query(
    `insert into public."user" (id, name, email, "emailVerified") values
      ('u1', 'Verified', 'verified@pactora.test', true),
      ('u2', 'Unverified', 'unverified@pactora.test', false)`,
  );

  await assert.rejects(
    promoteOwner("unverified@pactora.test", database),
    OwnerProvisioningError,
  );
  await promoteOwner("verified@pactora.test", database);
  assert.deepEqual(await roles(), [
    { email: "unverified@pactora.test", role: "user" },
    { email: "verified@pactora.test", role: "admin" },
  ]);
  await assert.rejects(
    promoteOwner("unverified@pactora.test", database),
    OwnerProvisioningError,
  );
});
