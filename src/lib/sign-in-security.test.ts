import assert from "node:assert/strict";
import { test } from "node:test";

import { isAPIError } from "better-auth/api";

import { signInEvents } from "./auth/sign-in-events.ts";
import {
  replaceDbPoolForTests,
  type DbExecutor,
  type DbPool,
} from "./db/connection.ts";
import {
  needsTwoFactorSetup,
  userHasPassword,
  usesTwoFactor,
} from "./sign-in-security.ts";
import { describeTwoFactorPanel } from "./two-factor-view.ts";

type AccountRow = {
  password: string | null;
  providerId: string;
  userId: string;
};

/**
 * Minimal DbExecutor stub that emulates the `account` password lookup SQL
 * used by `userHasPassword` and `needsTwoFactorSetup`.
 */
function mockAccountDb(accounts: readonly AccountRow[]) {
  const queries: Array<{ text: string; values: unknown[] }> = [];

  const database = {
    async query(text: string, values: unknown[] = []) {
      queries.push({ text, values });

      const userId = typeof values[0] === "string" ? values[0] : "";
      const requiresNonNullPassword = /password\s+is\s+not\s+null/i.test(text);
      const requiresNonEmptyPassword = /password\s*<>\s*''/i.test(text);

      const found = accounts.some((row) => {
        if (row.userId !== userId || row.providerId !== "credential") {
          return false;
        }

        if (requiresNonNullPassword && row.password === null) {
          return false;
        }

        if (requiresNonEmptyPassword && row.password === "") {
          return false;
        }

        return true;
      });

      return {
        command: "SELECT",
        fields: [],
        oid: 0,
        rowCount: found ? 1 : 0,
        rows: found ? [{ found: 1 }] : [],
      };
    },
  } as unknown as DbExecutor;

  return { database, queries };
}

test("usesTwoFactor recognizes only an explicit boolean true", () => {
  assert.equal(usesTwoFactor({ twoFactorEnabled: true }), true);
  assert.equal(usesTwoFactor({ twoFactorEnabled: false }), false);
  assert.equal(usesTwoFactor({ twoFactorEnabled: "true" }), false);
  assert.equal(usesTwoFactor({}), false);
});

test("userHasPassword distinguishes password-only, SSO-only, hybrid and null-password accounts", async () => {
  const { database } = mockAccountDb([
    { password: "hashed-password", providerId: "credential", userId: "pwd" },
    { password: null, providerId: "sso", userId: "sso-only" },
    { password: null, providerId: "sso", userId: "hybrid" },
    { password: "hashed-password", providerId: "credential", userId: "hybrid" },
    { password: null, providerId: "credential", userId: "null-pwd" },
    { password: "", providerId: "credential", userId: "empty-pwd" },
  ]);

  assert.equal(await userHasPassword("pwd", { database }), true);
  assert.equal(await userHasPassword("sso-only", { database }), false);
  assert.equal(await userHasPassword("hybrid", { database }), true);
  assert.equal(await userHasPassword("null-pwd", { database }), false);
  assert.equal(await userHasPassword("empty-pwd", { database }), false);
  assert.equal(await userHasPassword("missing", { database }), false);
});

test("needsTwoFactorSetup exempts SSO-only accounts but enforces on password and hybrid accounts", async () => {
  const { database, queries } = mockAccountDb([
    { password: "hashed-password", providerId: "credential", userId: "pwd" },
    { password: null, providerId: "sso", userId: "sso-only" },
    { password: null, providerId: "sso", userId: "hybrid" },
    { password: "hashed-password", providerId: "credential", userId: "hybrid" },
    { password: null, providerId: "credential", userId: "null-pwd" },
  ]);

  // Short-circuits without querying when requirement is off or 2FA is already on.
  assert.equal(
    await needsTwoFactorSetup(
      { requireTwoFactor: false },
      { id: "pwd", twoFactorEnabled: false },
      { database },
    ),
    false,
  );
  assert.equal(
    await needsTwoFactorSetup(
      { requireTwoFactor: true },
      { id: "pwd", twoFactorEnabled: true },
      { database },
    ),
    false,
  );
  assert.equal(queries.length, 0);

  // Requirement on, 2FA off: depends on whether a non-empty credential password exists.
  assert.equal(
    await needsTwoFactorSetup(
      { requireTwoFactor: true },
      { id: "sso-only", twoFactorEnabled: false },
      { database },
    ),
    false,
  );
  assert.equal(
    await needsTwoFactorSetup(
      { requireTwoFactor: true },
      { id: "null-pwd", twoFactorEnabled: false },
      { database },
    ),
    false,
  );
  assert.equal(
    await needsTwoFactorSetup(
      { requireTwoFactor: true },
      { id: "pwd", twoFactorEnabled: false },
      { database },
    ),
    true,
  );
  assert.equal(
    await needsTwoFactorSetup(
      { requireTwoFactor: true },
      { id: "hybrid", twoFactorEnabled: false },
      { database },
    ),
    true,
  );
  // Missing user id fails closed.
  assert.equal(
    await needsTwoFactorSetup({ requireTwoFactor: true }, {}, { database }),
    true,
  );
});

test("TwoFactorPanel view for SSO-only accounts hides password setup and org requirement notice", () => {
  const optionalDefault = describeTwoFactorPanel({
    enabled: false,
    hasPassword: false,
    productName: "PACTORA",
    required: false,
    ssoProviderName: "single sign-on",
  });

  assert.equal(optionalDefault.mode, "sso-only");
  assert.equal(optionalDefault.canManage, false);
  assert.equal(optionalDefault.canDisable, false);
  assert.equal(optionalDefault.statusLabel, "Managed by identity provider");
  assert.equal(optionalDefault.statusTone, "neutral");
  assert.match(optionalDefault.description, /signs in with single sign-on and/);
  assert.match(optionalDefault.description, /no PACTORA password/);
  assert.match(
    optionalDefault.description,
    /managed by your identity provider/,
  );
  assert.doesNotMatch(optionalDefault.description, /After your password/);
  assert.doesNotMatch(
    optionalDefault.description,
    /Your organization requires/,
  );
  assert.doesNotMatch(optionalDefault.description, /\(single sign-on\)/i);

  const requiredNamed = describeTwoFactorPanel({
    enabled: false,
    hasPassword: false,
    productName: "Acme Corp",
    required: true,
    ssoProviderName: "Okta",
  });

  assert.equal(requiredNamed.mode, "sso-only");
  assert.equal(requiredNamed.canManage, false);
  assert.equal(requiredNamed.statusLabel, "Managed by identity provider");
  assert.match(requiredNamed.description, /single sign-on \(Okta\)/);
  assert.match(requiredNamed.description, /no Acme Corp password/);
  assert.match(
    requiredNamed.description,
    /applies only to accounts with a password, so it does not apply to this account/,
  );
  assert.doesNotMatch(requiredNamed.description, /After your password/);
  assert.doesNotMatch(requiredNamed.description, /Your organization requires/);

  const noConfiguredProvider = describeTwoFactorPanel({
    enabled: false,
    hasPassword: false,
    productName: "PACTORA",
    required: true,
    ssoProviderName: null,
  });

  assert.equal(noConfiguredProvider.mode, "sso-only");
  assert.equal(noConfiguredProvider.canManage, false);
  assert.match(
    noConfiguredProvider.description,
    /signs in with single sign-on and has no PACTORA password/,
  );

  // Even in a degenerate state where twoFactorEnabled was true without a
  // credential password, password-gated actions stay hidden.
  const degenerate = describeTwoFactorPanel({
    enabled: true,
    hasPassword: false,
    productName: "PACTORA",
    required: false,
    ssoProviderName: "Okta",
  });

  assert.equal(degenerate.mode, "sso-only");
  assert.equal(degenerate.canManage, false);
  assert.equal(degenerate.canDisable, false);
});

test("TwoFactorPanel view for password and hybrid SSO+password accounts keeps normal setup and org requirement", () => {
  const passwordOptional = describeTwoFactorPanel({
    enabled: false,
    hasPassword: true,
    productName: "PACTORA",
    required: false,
    ssoProviderName: null,
  });

  assert.equal(passwordOptional.mode, "password");
  assert.equal(passwordOptional.canManage, true);
  assert.equal(passwordOptional.canDisable, false);
  assert.equal(passwordOptional.statusLabel, "Off");
  assert.equal(passwordOptional.statusTone, "neutral");
  assert.match(passwordOptional.description, /^After your password, PACTORA/);
  assert.doesNotMatch(
    passwordOptional.description,
    /Your organization requires it\./,
  );

  const hybridRequired = describeTwoFactorPanel({
    enabled: false,
    hasPassword: true,
    productName: "PACTORA",
    required: true,
    ssoProviderName: "Okta",
  });

  assert.equal(hybridRequired.mode, "password");
  assert.equal(hybridRequired.canManage, true);
  assert.equal(hybridRequired.statusLabel, "Off");
  assert.match(hybridRequired.description, /^After your password, PACTORA/);
  assert.match(hybridRequired.description, /Your organization requires it\.$/);

  const enabledOptional = describeTwoFactorPanel({
    enabled: true,
    hasPassword: true,
    productName: "Acme Corp",
    required: false,
  });

  assert.equal(enabledOptional.mode, "password");
  assert.equal(enabledOptional.canManage, true);
  assert.equal(enabledOptional.canDisable, true);
  assert.equal(enabledOptional.statusLabel, "On");
  assert.equal(enabledOptional.statusTone, "success");

  const enabledRequired = describeTwoFactorPanel({
    enabled: true,
    hasPassword: true,
    productName: "Acme Corp",
    required: true,
  });

  assert.equal(enabledRequired.mode, "password");
  assert.equal(enabledRequired.canManage, true);
  assert.equal(enabledRequired.canDisable, false);
  assert.equal(enabledRequired.statusLabel, "On");
  assert.equal(enabledRequired.statusTone, "success");
  assert.match(enabledRequired.description, /Your organization requires it\.$/);
});

test("signInEvents refuses password-based two-factor routes for SSO-only accounts with a clear error", async () => {
  const plugin = signInEvents();
  const guard = plugin.hooks.before.find(
    (hook) =>
      hook.matcher({ path: "/two-factor/enable" } as never) &&
      !hook.matcher({ path: "/change-password" } as never),
  );

  assert.ok(guard, "expected password-required two-factor guard hook");

  for (const path of [
    "/two-factor/enable",
    "/two-factor/disable",
    "/two-factor/generate-backup-codes",
    "/two-factor/get-totp-uri",
  ]) {
    assert.equal(guard.matcher({ path } as never), true, path);
  }

  assert.equal(
    guard.matcher({ path: "/two-factor/verify-totp" } as never),
    false,
  );

  const { database } = mockAccountDb([
    { password: "hashed-password", providerId: "credential", userId: "pwd" },
    { password: null, providerId: "sso", userId: "sso-only" },
    { password: null, providerId: "sso", userId: "hybrid" },
    { password: "hashed-password", providerId: "credential", userId: "hybrid" },
    { password: null, providerId: "credential", userId: "null-pwd" },
  ]);
  const previous = replaceDbPoolForTests(database as unknown as DbPool);

  try {
    for (const userId of ["sso-only", "null-pwd"]) {
      await assert.rejects(
        () =>
          guard.handler({
            context: {
              session: {
                session: { token: "tok" },
                user: { email: `${userId}@acme.com`, id: userId },
              },
            },
            path: "/two-factor/enable",
          } as never),
        (error: unknown) =>
          isAPIError(error) &&
          error.statusCode === 400 &&
          (error.body as { code?: string } | null)?.code ===
            "PASSWORD_REQUIRED_FOR_TWO_FACTOR",
      );
    }

    // Password-only and hybrid accounts pass through to Better Auth.
    for (const userId of ["pwd", "hybrid"]) {
      await guard.handler({
        context: {
          session: {
            session: { token: "tok" },
            user: { email: `${userId}@acme.com`, id: userId },
          },
        },
        path: "/two-factor/enable",
      } as never);
    }

    // Unauthenticated callers pass through so Better Auth returns 401.
    await guard.handler({
      context: {},
      path: "/two-factor/enable",
    } as never);
  } finally {
    replaceDbPoolForTests(previous as DbPool);
  }
});
