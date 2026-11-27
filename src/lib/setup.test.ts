import assert from "node:assert/strict";
import { test } from "node:test";

import type { DbPool } from "./db/connection.ts";
import { completeSetup, resolveSetupView, SetupError } from "./setup.ts";

const signedIn = {
  email: "jane@acme.com",
  emailVerified: true,
  id: "user_1",
};

test("a set-up install has nothing to show on the setup page", () => {
  assert.deepEqual(resolveSetupView({ status: "complete" }, { env: {} }), {
    view: "complete",
  });
});

test("a database without this version's tables says so", () => {
  assert.deepEqual(resolveSetupView({ status: "unmigrated" }, { env: {} }), {
    view: "unmigrated",
  });
});

test("the first visitor to a fresh install creates the administrator", () => {
  assert.deepEqual(resolveSetupView({ status: "fresh" }, { env: {} }), {
    asksForSupportAddress: false,
    requiresToken: false,
    senderAddressFromEnv: false,
    view: "create",
  });
});

test("a fresh install with SETUP_TOKEN asks for it", () => {
  assert.deepEqual(
    resolveSetupView(
      { status: "fresh" },
      {
        env: {
          RESEND_FROM_EMAIL: "sign@acme.com",
          SETUP_TOKEN: "a-secret-of-the-owner",
        },
      },
    ),
    {
      asksForSupportAddress: false,
      requiresToken: true,
      senderAddressFromEnv: true,
      view: "create",
    },
  );
});

test("an install with accounts but no administrator is claimed by someone signed in", () => {
  assert.deepEqual(
    resolveSetupView(
      { status: "unclaimed" },
      { env: { SETUP_TOKEN: "a-secret-of-the-owner" }, sessionUser: signedIn },
    ),
    {
      asksForSupportAddress: false,
      signedInEmail: "jane@acme.com",
      tokenConfigured: true,
      view: "claim",
    },
  );
  assert.deepEqual(resolveSetupView({ status: "unclaimed" }, { env: {} }), {
    asksForSupportAddress: false,
    signedInEmail: null,
    tokenConfigured: false,
    view: "claim",
  });
});

test("setup never asks for a support address: it is optional since 1.1", () => {
  for (const status of ["fresh", "unclaimed"] as const) {
    const view = resolveSetupView({ status }, { env: {} });

    assert.ok(view.view === "create" || view.view === "claim");
    assert.equal(view.asksForSupportAddress, false);
  }
});

test("setup refuses input it cannot use before touching the database", async () => {
  // Any use of this stand-in database would throw.
  const database = {} as DbPool;
  const createAdminAccount = async () => {
    throw new Error("must not be reached");
  };

  await assert.rejects(
    completeSetup(
      {
        organizationName: "   ",
        senderAddress: "not an address",
        supportAddress: "nor is this",
      },
      { createAdminAccount, database, env: {} },
    ),
    (error: unknown) => {
      assert.ok(error instanceof SetupError);
      assert.equal(error.statusCode, 400);
      // A blank workspace name is simply not given: it is optional.
      assert.deepEqual(error.fieldErrors, {
        senderAddress: "Enter a valid email address, or leave this empty",
        supportAddress: "Enter an email address people can write to for help",
      });

      return true;
    },
  );
});

test("a new install's form is told about every field at once, the account's included", async () => {
  const database = {} as DbPool;
  const createAdminAccount = async () => {
    throw new Error("must not be reached");
  };
  const refusedFields = async (input: Record<string, string>) => {
    try {
      await completeSetup(input, { createAdminAccount, database, env: {} });
    } catch (error) {
      assert.ok(error instanceof SetupError);
      assert.equal(error.statusCode, 400);

      return Object.keys(error.fieldErrors).sort();
    }

    return assert.fail("setup accepted input it should have refused");
  };

  // A support address that is not one, next to a password that is too
  // short: both are named in the same answer.
  assert.deepEqual(
    await refusedFields({
      email: "owner@acme.com",
      fullName: "Olive Owner",
      organizationName: "Acme Corp",
      password: "too short",
      supportAddress: "not an address",
    }),
    ["password", "supportAddress"],
  );

  // Claiming an older install sends no account fields, so none are judged.
  assert.deepEqual(
    await refusedFields({
      organizationName: "Acme Corp",
      setupToken: "a-secret-of-the-owner",
      supportAddress: "not an address",
    }),
    ["supportAddress"],
  );
});
