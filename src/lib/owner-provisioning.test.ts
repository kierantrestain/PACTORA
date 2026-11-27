import assert from "node:assert/strict";
import { test } from "node:test";

import type { DbPool } from "./db/connection.ts";
import {
  allowsTokenFreeFirstOwner,
  readOwnerProvisioningToken,
  resolveOwnerProvisioning,
} from "./owner-provisioning.ts";
import { completeSetup, SetupError } from "./setup.ts";

const PUBLIC_VERCEL_PRODUCTION = {
  NODE_ENV: "production",
  VERCEL: "1",
  VERCEL_ENV: "production",
  VERCEL_PROJECT_PRODUCTION_URL: "pactora.example.app",
};

test("local development allows the token-free first owner", () => {
  assert.deepEqual(resolveOwnerProvisioning({ NODE_ENV: "development" }), {
    mode: "first-owner-open",
    reason: "local",
  });
  // A production build served from localhost, as the end-to-end test does.
  assert.deepEqual(
    resolveOwnerProvisioning({
      APP_URL: "http://localhost:3000",
      NODE_ENV: "production",
    }),
    { mode: "first-owner-open", reason: "local" },
  );
});

test("a public Vercel deployment never allows an open owner claim", () => {
  assert.deepEqual(resolveOwnerProvisioning(PUBLIC_VERCEL_PRODUCTION), {
    mode: "provisioning-required",
    tokenAccepted: false,
  });
  assert.equal(allowsTokenFreeFirstOwner(PUBLIC_VERCEL_PRODUCTION), false);
});

test("a Vercel deployment is never treated as local, even in development mode", () => {
  assert.equal(
    allowsTokenFreeFirstOwner({ NODE_ENV: "development", VERCEL: "1" }),
    false,
  );
});

test("a public self-hosted production server needs provisioning", () => {
  assert.equal(
    allowsTokenFreeFirstOwner({
      APP_URL: "https://sign.example.org",
      NODE_ENV: "production",
    }),
    false,
  );
});

test("an operator-asserted access gate allows the token-free first owner", () => {
  for (const value of ["1", "true", "TRUE", "yes"]) {
    assert.deepEqual(
      resolveOwnerProvisioning({
        ...PUBLIC_VERCEL_PRODUCTION,
        PACTORA_ACCESS_PROTECTED: value,
      }),
      { mode: "first-owner-open", reason: "access-protected" },
    );
  }

  for (const value of ["0", "false", "", "replace-with-1"]) {
    assert.equal(
      allowsTokenFreeFirstOwner({
        ...PUBLIC_VERCEL_PRODUCTION,
        PACTORA_ACCESS_PROTECTED: value,
      }),
      false,
    );
  }
});

test("hosted mode is a public service and never allows the open claim", () => {
  assert.deepEqual(
    resolveOwnerProvisioning({
      HOSTED_MODE: "1",
      NODE_ENV: "development",
      PACTORA_ACCESS_PROTECTED: "1",
    }),
    { mode: "provisioning-required", tokenAccepted: false },
  );
});

test("the provisioning token is read under its new name or SETUP_TOKEN", () => {
  assert.equal(
    readOwnerProvisioningToken({ OWNER_PROVISIONING_TOKEN: "new-token" }),
    "new-token",
  );
  assert.equal(
    readOwnerProvisioningToken({ SETUP_TOKEN: "older-token" }),
    "older-token",
  );
  assert.equal(readOwnerProvisioningToken({}), undefined);
  assert.deepEqual(
    resolveOwnerProvisioning({
      ...PUBLIC_VERCEL_PRODUCTION,
      OWNER_PROVISIONING_TOKEN: "new-token",
    }),
    { mode: "provisioning-required", tokenAccepted: true },
  );
});

// completeSetup reads the state inside its transaction. This stand-in
// answers just enough for a fresh install, so the policy check can be seen
// refusing before any account is created.
function freshDatabase(): { database: DbPool; created: string[] } {
  const created: string[] = [];
  const client = {
    query: async (sql: string) => {
      if (sql.includes("pg_try_advisory_xact_lock")) {
        return { rows: [{ locked: true }] };
      }

      if (sql.includes("has_admin")) {
        return {
          rows: [
            { has_admin: false, has_users: false, setup_completed_at: null },
          ],
        };
      }

      return { rowCount: 0, rows: [] };
    },
    release: () => undefined,
  };

  return {
    created,
    database: { connect: async () => client } as unknown as DbPool,
  };
}

const OWNER_INPUT = {
  email: "owner@pactora.test",
  fullName: "Workspace Owner",
  password: "a-long-enough-password",
};

test("on a public deployment the waived token is refused before any account exists", async () => {
  const { database, created } = freshDatabase();

  await assert.rejects(
    completeSetup(OWNER_INPUT, {
      createAdminAccount: async (input) => {
        created.push(input.email);

        return { userId: "user_x" };
      },
      database,
      env: PUBLIC_VERCEL_PRODUCTION,
      setupToken: "waived",
    }),
    (error: unknown) => error instanceof SetupError && error.statusCode === 403,
  );
  assert.deepEqual(created, []);
});

test("on a public deployment without a token the legacy setup path is closed too", async () => {
  const { database, created } = freshDatabase();

  await assert.rejects(
    completeSetup(OWNER_INPUT, {
      createAdminAccount: async (input) => {
        created.push(input.email);

        return { userId: "user_x" };
      },
      database,
      env: PUBLIC_VERCEL_PRODUCTION,
    }),
    (error: unknown) => error instanceof SetupError && error.statusCode === 403,
  );
  assert.deepEqual(created, []);
});

test("a wrong provisioning token is refused on a public deployment", async () => {
  const { database, created } = freshDatabase();

  await assert.rejects(
    completeSetup(
      { ...OWNER_INPUT, setupToken: "guess" },
      {
        createAdminAccount: async (input) => {
          created.push(input.email);

          return { userId: "user_x" };
        },
        database,
        env: { ...PUBLIC_VERCEL_PRODUCTION, OWNER_PROVISIONING_TOKEN: "real" },
      },
    ),
    (error: unknown) => error instanceof SetupError && error.statusCode === 403,
  );
  assert.deepEqual(created, []);
});
