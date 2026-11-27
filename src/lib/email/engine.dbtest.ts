import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import { simpleParser } from "mailparser";
import forge from "node-forge";
import type pg from "pg";
import { SMTPServer } from "smtp-server";

import { replaceDbPoolForTests } from "../db/connection.ts";
import { openTestDatabase } from "../db/test-database.ts";
import {
  createAccount,
  getPreferredAccountId,
  loadAccount,
  sealCredentials,
  setPreferredAccount,
} from "./accounts.ts";
import {
  eraseDeliveriesFor,
  exportDeliveriesFor,
  listDeliveries,
} from "./deliveries.ts";
import {
  deliver,
  EmailDeliveryQueuedError,
  EmailNotConnectedError,
  processDueDeliveries,
  type EngineOptions,
} from "./engine.ts";
import { completeOAuth, startOAuth } from "./oauth.ts";
import { settleConnectedAccount } from "./service.ts";
import { checkSmtpEndpoint, resolveSmtpAddress } from "./smtp.ts";
import { saveTemplate } from "./templates.ts";

// The delivery engine against a real Postgres and a real SMTP server
// (smtp-server, STARTTLS with its own certificate, on 127.0.0.1:2525).
// Google's endpoints are local stand-ins: no real provider is reached.
// Run with `npm run test:db`.

const SMTP_PORT = 2525;
const SMTP_USER = "sender@pactora.test";
let smtpPassword = "app-password-1";
let smtpFailNext: { code: number; message: string } | null = null;
const received: {
  from: string;
  raw: string;
  subject: string;
  to: string;
  replyTo: string | null;
}[] = [];

const env = {
  APP_URL: "http://localhost:3000",
  BETTER_AUTH_SECRET: "test-secret-for-the-email-engine-0123456789",
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
  NODE_ENV: "development",
  SMTP_ALLOW_PRIVATE_HOSTS: "1",
};

let database: pg.Pool;
let server: SMTPServer;
let ca: string;
let alice: { email: string; id: string; name: string };
let bob: { email: string; id: string; name: string };
let admin: { email: string; id: string; name: string };

function makeCertificate(): { cert: string; key: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 86_400_000);

  const attrs = [{ name: "commonName", value: "localhost" }];

  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { cA: true, name: "basicConstraints" },
    {
      altNames: [
        { type: 2, value: "localhost" },
        { ip: "127.0.0.1", type: 7 },
      ],
      name: "subjectAltName",
    },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    cert: forge.pki.certificateToPem(cert),
    key: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

function engineOptions(overrides: Partial<EngineOptions> = {}): EngineOptions {
  return {
    database,
    env,
    resolveAddresses: async () => ({
      senderAddress: "PACTORA <noreply@pactora.test>",
      supportAddress: "help@pactora.test",
    }),
    resolveOrganizationName: async () => "Northwind Legal",
    smtp: { trustedCa: ca },
    ...overrides,
  };
}

async function addUser(name: string, email: string, role = "user") {
  const id = randomUUID();

  await database.query(
    `insert into public."user" (id, name, email, role, "emailVerified") values ($1, $2, $3, $4, true)`,
    [id, name, email, role],
  );

  return { email, id, name };
}

async function connectSmtp(
  owner: { email: string; id: string; name: string },
  scope: "personal" | "organization" = "personal",
) {
  const account = await createAccount(
    { email: owner.email, name: owner.name, userId: owner.id },
    {
      displayName: "Alice at Northwind",
      emailAddress: SMTP_USER,
      host: "localhost",
      password: smtpPassword,
      port: SMTP_PORT,
      presetId: "smtp",
      scope,
      security: "starttls",
      username: SMTP_USER,
    },
    { database, env, smtp: { trustedCa: ca } },
  );

  await settleConnectedAccount(
    { email: owner.email, name: owner.name, userId: owner.id },
    account.id,
    database,
  );

  return account;
}

function message(
  senderUserId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    htmlBody: "<p>Please sign.</p>",
    senderUserId,
    subject: "Please sign the services agreement",
    template: "completion_notification" as const,
    textBody: "Please sign.",
    to: "client@recipient.test",
    ...overrides,
  };
}

async function deliveryRows() {
  return (
    await database.query<{
      attempts: number;
      encrypted_payload: string | null;
      status: string;
      to_address: string;
    }>(
      `select status, attempts, encrypted_payload, to_address from email_deliveries order by created_at, id`,
    )
  ).rows;
}

before(async () => {
  database = await openTestDatabase();
  replaceDbPoolForTests(database);
  Object.assign(process.env, { BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET });

  const { cert, key } = makeCertificate();

  ca = cert;
  server = new SMTPServer({
    authMethods: ["PLAIN", "LOGIN"],
    cert,
    key,
    logger: false,
    onAuth(auth, _session, callback) {
      if (auth.username === SMTP_USER && auth.password === smtpPassword) {
        callback(null, { user: auth.username });
      } else {
        callback(new Error("Invalid credentials"));
      }
    },
    onData(stream, _session, callback) {
      const chunks: Buffer[] = [];

      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        if (smtpFailNext) {
          const failure = smtpFailNext;

          smtpFailNext = null;

          const error = new Error(failure.message) as Error & {
            responseCode: number;
          };

          error.responseCode = failure.code;
          callback(error);
          return;
        }

        const raw = Buffer.concat(chunks).toString("utf8");

        void simpleParser(raw).then((parsed) => {
          received.push({
            from: parsed.from?.text ?? "",
            raw,
            replyTo: parsed.replyTo?.text ?? null,
            subject: parsed.subject ?? "",
            to: Array.isArray(parsed.to)
              ? parsed.to[0]!.text
              : (parsed.to?.text ?? ""),
          });
          callback();
        });
      });
    },
    secure: false,
  });
  await new Promise<void>((resolve) =>
    server.listen(SMTP_PORT, "127.0.0.1", resolve),
  );
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await database.end();
});

beforeEach(async () => {
  await database.query(`truncate public."user" cascade`);
  await database.query(`delete from email_deliveries`);
  await database.query(`delete from email_accounts`);
  received.length = 0;
  smtpPassword = "app-password-1";
  smtpFailNext = null;
  admin = await addUser("Avery Admin", "admin@pactora.test", "admin");
  alice = await addUser("Alice Sender", "alice@pactora.test");
  bob = await addUser("Bob Sender", "bob@pactora.test");
});

test("agreement mail goes out through the sender's own SMTP mailbox, and the delivery is logged as sent", async () => {
  const account = await connectSmtp(alice);

  assert.equal(await getPreferredAccountId(alice.id, database), account.id);

  const result = await deliver(message(alice.id), undefined, engineOptions());

  assert.equal(received.length, 1);
  assert.match(received[0]!.from, /Alice at Northwind/);
  assert.match(received[0]!.from, /sender@pactora\.test/);
  assert.equal(received[0]!.to, "client@recipient.test");
  assert.equal(received[0]!.subject, "Please sign the services agreement");
  assert.equal(received[0]!.replyTo, "help@pactora.test");
  assert.ok(result.messageId);

  const rows = await deliveryRows();

  assert.deepEqual(
    rows.map((row) => row.status),
    ["sent"],
  );
  assert.equal(rows[0]!.encrypted_payload, null);
  assert.ok((await loadAccount(account.id, database))!.lastSuccessAt);
});

test("an idempotency key sends a message once, however often it is asked for", async () => {
  await connectSmtp(alice);

  const first = await deliver(
    message(alice.id),
    { idempotencyKey: "completion/e1/0" },
    engineOptions(),
  );
  const second = await deliver(
    message(alice.id),
    { idempotencyKey: "completion/e1/0" },
    engineOptions(),
  );

  assert.equal(received.length, 1);
  assert.equal(second.messageId, first.messageId);
  assert.equal((await deliveryRows()).length, 1);
});

test("one person's mailbox is never used for another person's mail, and nothing is reported as sent", async () => {
  const account = await connectSmtp(alice);

  await assert.rejects(
    deliver(message(bob.id), undefined, engineOptions()),
    EmailNotConnectedError,
  );
  await assert.rejects(
    deliver(
      message(bob.id, { accountId: account.id, template: "test_email" }),
      undefined,
      engineOptions(),
    ),
    /only send through a mailbox you connected/,
  );
  assert.equal(received.length, 0);
  assert.deepEqual(
    (await deliveryRows()).map((row) => row.status),
    ["failed", "failed"],
  );
  // Bob cannot choose Alice's mailbox as his own either.
  await assert.rejects(
    setPreferredAccount(bob.id, account.id, database),
    /only choose an account/,
  );
});

test("an organisation mailbox shared with everyone carries everyone's agreements; unshared, it carries only platform mail", async () => {
  const account = await connectSmtp(admin, "organization");

  // The first organisation mailbox became the default, shared with everyone.
  await deliver(message(bob.id), undefined, engineOptions());
  assert.equal(received.length, 1);

  await database.query(
    `update email_accounts set shared_with = 'nobody' where id = $1`,
    [account.id],
  );
  await assert.rejects(
    deliver(message(bob.id), undefined, engineOptions()),
    EmailNotConnectedError,
  );

  await deliver(
    {
      subject: "Verify your email",
      template: "email_verification",
      textBody: "Code",
      to: "new@pactora.test",
    },
    undefined,
    engineOptions(),
  );
  assert.equal(received.length, 2);
});

test("a temporary refusal is kept, encrypted, and sent by the retry job; the caller is told it did not go out", async () => {
  await connectSmtp(alice);
  smtpFailNext = { code: 451, message: "Try again later" };

  await assert.rejects(
    deliver(message(alice.id), undefined, engineOptions()),
    EmailDeliveryQueuedError,
  );

  let [row] = await deliveryRows();

  assert.equal(row!.status, "retrying");
  assert.ok(row!.encrypted_payload);
  assert.doesNotMatch(row!.encrypted_payload!, /Please sign/);

  // Not due yet: nothing happens.
  assert.deepEqual(await processDueDeliveries(engineOptions()), {
    failed: 0,
    retried: 0,
    sent: 0,
  });

  const later = Math.floor(Date.now() / 1000) + 120;
  const summary = await processDueDeliveries(
    engineOptions({ now: () => later }),
  );

  assert.equal(summary.sent, 1);
  assert.equal(received.length, 1);
  [row] = await deliveryRows();
  assert.equal(row!.status, "sent");
  assert.equal(row!.attempts, 2);
  assert.equal(row!.encrypted_payload, null);
});

test("a signing invitation that fails is not retried in the background: its caller reverts the envelope", async () => {
  await connectSmtp(alice);
  smtpFailNext = { code: 451, message: "Try again later" };

  await assert.rejects(
    deliver(
      message(alice.id, { template: "signing_invitation" }),
      undefined,
      engineOptions(),
    ),
    (error: Error) =>
      !(error instanceof EmailDeliveryQueuedError) &&
      /Try again later/.test(error.message),
  );
  assert.deepEqual(
    (await deliveryRows()).map((row) => [row.status, row.encrypted_payload]),
    [["failed", null]],
  );
});

test("a mailbox whose password stops working is marked for reconnecting, its mail waits, and it is never swapped for another", async () => {
  const account = await connectSmtp(alice);

  await connectSmtp(admin, "organization").catch(() => undefined);
  smtpPassword = "changed-on-the-server";

  await assert.rejects(
    deliver(message(alice.id), undefined, engineOptions()),
    EmailDeliveryQueuedError,
  );

  const stored = await loadAccount(account.id, database);

  assert.equal(stored!.status, "needs_reconnect");
  assert.deepEqual(
    (await deliveryRows()).map((row) => row.status),
    ["deferred"],
  );

  // While it needs reconnecting, Alice's mail does not go out through
  // anything else, the organisation's mailbox included.
  await assert.rejects(
    deliver(message(alice.id), undefined, engineOptions()),
    /needs reconnecting/,
  );
  assert.equal(received.length, 0);
});

test("a newer signing link supersedes an older one still waiting to be retried", async () => {
  await connectSmtp(alice);
  await database.query(
    `insert into email_deliveries (id, stream, template, to_address, subject, envelope_id, sender_user_id, status, attempts, next_attempt_at, encrypted_payload, created_at, updated_at)
     values ('old', 'agreement', 'manual_nudge', 'client@recipient.test', 'old', 'env-1', $1, 'retrying', 1, 0, 'x', 1, 1)`,
    [alice.id],
  );

  await deliver(
    message(alice.id, { envelopeId: "env-1", template: "manual_nudge" }),
    undefined,
    engineOptions(),
  );

  const old = await database.query(
    `select status, encrypted_payload from email_deliveries where id = 'old'`,
  );

  assert.deepEqual(old.rows[0], {
    encrypted_payload: null,
    status: "superseded",
  });
});

test("delivery history: administrators see everything, others only their own; export and erasure cover the log", async () => {
  await connectSmtp(admin, "organization");
  await deliver(
    message(alice.id, { to: "carol@recipient.test" }),
    undefined,
    engineOptions(),
  );
  await deliver(message(bob.id), undefined, engineOptions());

  assert.equal(
    (await listDeliveries(admin.id, { database })).deliveries.length,
    2,
  );
  assert.deepEqual(
    (await listDeliveries(alice.id, { database })).deliveries.map(
      (delivery) => delivery.toAddress,
    ),
    ["carol@recipient.test"],
  );
  assert.equal(
    (await listDeliveries(bob.id, { database, search: "carol" })).deliveries
      .length,
    0,
  );

  const exported = await exportDeliveriesFor(
    { email: "carol@recipient.test" },
    database,
  );

  assert.equal(exported.length, 1);
  assert.equal(exported[0]!.direction, "sent_to_you");
  assert.equal(
    (
      await exportDeliveriesFor(
        { email: alice.email, userId: alice.id },
        database,
      )
    )[0]!.direction,
    "sent_for_you",
  );

  assert.equal(
    await eraseDeliveriesFor("carol@recipient.test", { database }),
    1,
  );
  assert.equal(
    (await exportDeliveriesFor({ email: "carol@recipient.test" }, database))
      .length,
    0,
  );
});

test("SMTP to a private or loopback address is refused unless the operator allows it, including after DNS answers", async () => {
  const publicEnv = { ...env, SMTP_ALLOW_PRIVATE_HOSTS: "0" };

  await assert.rejects(
    resolveSmtpAddress("127.0.0.1", { env: publicEnv }),
    /private network|local address/,
  );
  await assert.rejects(
    resolveSmtpAddress("localhost", { env: publicEnv }),
    /local address/,
  );
  await assert.rejects(
    resolveSmtpAddress("mail.attacker.test", {
      env: publicEnv,
      lookup: async () => [{ address: "169.254.169.254", family: 4 }],
    }),
    /private network/,
  );
  assert.equal(
    await resolveSmtpAddress("mail.example.test", {
      env: publicEnv,
      lookup: async () => [{ address: "203.0.113.10", family: 4 }],
    }),
    "203.0.113.10",
  );
  assert.ok(
    checkSmtpEndpoint({
      host: "smtp.example.com",
      port: 6379,
      security: "starttls",
    }).port,
  );
});

test("Gmail: connecting asks for send permission only, with PKCE; an expired token is refreshed; a revoked grant asks for reconnecting", async () => {
  const actor = { email: alice.email, name: alice.name, userId: alice.id };
  const calls: string[] = [];
  let refreshAnswer: { body: Record<string, unknown>; status: number } = {
    body: { access_token: "fresh-token", expires_in: 3600 },
    status: 200,
  };
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);

    calls.push(url);

    if (url === "https://token.test/token") {
      const body = new URLSearchParams(String(init?.body));

      if (body.get("grant_type") === "authorization_code") {
        assert.ok(body.get("code_verifier"));

        const idToken = [
          "e30",
          Buffer.from(
            JSON.stringify({
              aud: env.GOOGLE_CLIENT_ID,
              email: "alice.mail@gmail.test",
              email_verified: true,
              exp: Math.floor(Date.now() / 1000) + 600,
              sub: "g-123",
            }),
          ).toString("base64url"),
          "sig",
        ].join(".");

        return Response.json({
          access_token: "first-token",
          expires_in: 1,
          id_token: idToken,
          refresh_token: "refresh-1",
          scope: "openid email https://www.googleapis.com/auth/gmail.send",
        });
      }

      return Response.json(refreshAnswer.body, {
        status: refreshAnswer.status,
      });
    }

    if (url.startsWith("https://gmail.test/")) {
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer fresh-token",
      );

      return Response.json({ id: "gmail-message-1" });
    }

    throw new Error(`Unexpected request to ${url}`);
  };
  const oauth = {
    database,
    endpoints: {
      google: {
        authorize: "https://accounts.test/auth",
        token: "https://token.test/token",
      },
    },
    env,
    fetch: fakeFetch,
  };
  const { authorizationUrl } = await startOAuth(
    actor,
    { presetId: "gmail", scope: "personal" },
    oauth,
  );
  const params = new URL(authorizationUrl).searchParams;

  assert.equal(
    params.get("scope"),
    "openid email https://www.googleapis.com/auth/gmail.send",
  );
  assert.equal(params.get("code_challenge_method"), "S256");
  assert.doesNotMatch(
    authorizationUrl,
    /gmail\.readonly|mail\.google\.com|gmail\.modify/,
  );

  // Someone else's session cannot finish Alice's connection.
  await assert.rejects(
    completeOAuth(
      { email: bob.email, name: bob.name, userId: bob.id },
      { code: "c", state: params.get("state") },
      oauth,
    ),
  );

  const { accountId } = await completeOAuth(
    actor,
    { code: "c", state: params.get("state") },
    oauth,
  ).catch(async () => {
    // The state was spent by the refused attempt above: start again.
    const again = new URL(
      (await startOAuth(actor, { presetId: "gmail", scope: "personal" }, oauth))
        .authorizationUrl,
    );

    return completeOAuth(
      actor,
      { code: "c", state: again.searchParams.get("state") },
      oauth,
    );
  });

  await settleConnectedAccount(actor, accountId, database);

  // A state is single use.
  await assert.rejects(
    completeOAuth(actor, { code: "c", state: params.get("state") }, oauth),
  );

  // Stored tokens are encrypted, never in the clear.
  const raw = await database.query(
    `select encrypted_credentials from email_accounts where id = $1`,
    [accountId],
  );

  assert.doesNotMatch(
    raw.rows[0].encrypted_credentials,
    /refresh-1|first-token/,
  );

  // Patch the Gmail API base onto the transport through the fetch: the
  // engine's Gmail transport calls gmail.googleapis.com, mapped here.
  const routedFetch: typeof fetch = (input, init) =>
    fakeFetch(
      String(input).replace(
        "https://gmail.googleapis.com/",
        "https://gmail.test/",
      ),
      init,
    );

  await deliver(
    message(alice.id),
    undefined,
    engineOptions({ oauth: { ...oauth, fetch: routedFetch } }),
  );
  assert.ok(
    calls.includes("https://gmail.test/gmail/v1/users/me/messages/send"),
  );

  // The grant is withdrawn at Google: the next refresh is refused for good.
  await database.query(
    `update email_accounts set encrypted_credentials = $2 where id = $1`,
    [
      accountId,
      sealCredentials(
        accountId,
        {
          accessToken: "old",
          expiresAt: 0,
          refreshToken: "refresh-1",
          scope: "x",
          type: "oauth",
        },
        env,
      ),
    ],
  );
  refreshAnswer = { body: { error: "invalid_grant" }, status: 400 };
  await assert.rejects(
    deliver(
      message(alice.id),
      undefined,
      engineOptions({ oauth: { ...oauth, fetch: routedFetch } }),
    ),
    EmailDeliveryQueuedError,
  );
  assert.equal(
    (await loadAccount(accountId, database))!.status,
    "needs_reconnect",
  );
});

test("the organisation's saved wording replaces the subject and opening paragraph, escaped, and nothing else", async () => {
  await connectSmtp(alice);
  await saveTemplate(
    {
      intro: "{{sender_name}} needs your signature on {{document_title}}.",
      kind: "signing_invitation",
      subject: "Action needed: {{document_title}}",
    },
    admin.id,
    database,
  );

  await deliver(
    message(alice.id, {
      customization: {
        introHtml: "<p>Default intro.</p>",
        introText: "Default intro.",
        variables: { document_title: "<b>NDA</b>", sender_name: "Alice" },
      },
      htmlBody:
        '<p>Hi,</p><p>Default intro.</p><p><a href="https://sign.test/x">Sign</a></p>',
      template: "signing_invitation",
      textBody: "Hi,\n\nDefault intro.\n\nhttps://sign.test/x",
    }),
    undefined,
    engineOptions(),
  );

  assert.equal(received[0]!.subject, "Action needed: <b>NDA</b>");
  assert.match(received[0]!.raw, /Alice needs your signature on <b>NDA<\/b>\./);
  assert.match(received[0]!.raw, /&lt;b&gt;NDA&lt;\/b&gt;/);
  assert.match(received[0]!.raw, /https:\/\/sign\.test\/x/);
  await database.query(`delete from email_templates`);
});
