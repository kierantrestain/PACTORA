import assert from "node:assert/strict";
import { test } from "node:test";

import {
  getOAuthLoginProviders,
  isOAuthEmailVerified,
  readMicrosoftLoginConfig,
} from "./oauth-providers.ts";

test("sign-in buttons are offered only for providers with credentials", () => {
  assert.deepEqual(getOAuthLoginProviders({}), {
    google: false,
    microsoft: false,
  });
  assert.deepEqual(
    getOAuthLoginProviders({
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
      MICROSOFT_CLIENT_ID: "id",
    }),
    { google: true, microsoft: false },
  );
  assert.equal(
    readMicrosoftLoginConfig({
      MICROSOFT_CLIENT_ID: "id",
      MICROSOFT_CLIENT_SECRET: "secret",
    })?.tenantId,
    "common",
  );
});

test("a Google address counts only when Google says it is verified", () => {
  assert.equal(
    isOAuthEmailVerified("google", { email: "a@b.test", email_verified: true }),
    true,
  );
  assert.equal(
    isOAuthEmailVerified("google", {
      email: "a@b.test",
      email_verified: false,
    }),
    false,
  );
  assert.equal(isOAuthEmailVerified("google", { email: "a@b.test" }), false);
  assert.equal(isOAuthEmailVerified("google", undefined), false);
});

test("a Microsoft work account's unverified email claim is refused (nOAuth)", () => {
  // A tenant administrator can put any address in the email claim.
  assert.equal(
    isOAuthEmailVerified("microsoft", {
      email: "victim@pactora.test",
      tid: "11111111-2222-3333-4444-555555555555",
    }),
    false,
  );
  assert.equal(
    isOAuthEmailVerified("microsoft", {
      email: "owner@pactora.test",
      tid: "11111111-2222-3333-4444-555555555555",
      xms_edov: true,
    }),
    true,
  );
  assert.equal(
    isOAuthEmailVerified("microsoft", {
      email: "owner@pactora.test",
      verified_primary_email: ["OWNER@pactora.test"],
    }),
    true,
  );
});

test("a personal Microsoft account's sign-in address is trusted", () => {
  assert.equal(
    isOAuthEmailVerified("microsoft", {
      email: "someone@outlook.com",
      tid: "9188040d-6c67-4c5b-b112-36a304b66dad",
    }),
    true,
  );
});

test("unknown providers are never trusted", () => {
  assert.equal(
    isOAuthEmailVerified("github", { email: "a@b.test", email_verified: true }),
    false,
  );
});
