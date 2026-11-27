import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  getDb,
  queryOne,
  withTransaction,
  type DbPool,
} from "../db/connection.ts";
import { resolveAppUrl, type EnvSource } from "../utils/env.ts";
import {
  ACCOUNT_COLUMNS,
  canManageAccount,
  isAdministrator,
  loadAccount,
  openCredentials,
  recordAccountOutcome,
  saveAccountCredentials,
  sealCredentials,
  type AccountActor,
  type AccountScope,
  type EmailAccountRecord,
  type StoredCredentials,
} from "./accounts.ts";
import { fetchFailure } from "./classify.ts";
import { openSecret, sealSecret } from "./crypto.ts";
import {
  getPreset,
  isProviderPresetId,
  readOAuthClient,
  reconnectRecovery,
  unavailableReasonFor,
  type OAuthProviderName,
  type ProviderPresetId,
} from "./presets.ts";
import { EmailTransportError } from "./types.ts";

// Connecting a Gmail or Microsoft mailbox: the OAuth 2.0 authorization
// code flow with PKCE (S256) and a random state.
//
// The state is single use, lasts ten minutes, and belongs to the person
// who started the flow: a callback in anyone else's session is refused.
// Only its hash is stored; the PKCE verifier is stored encrypted. The
// mailbox's identity comes from the ID token the token endpoint returns
// directly over TLS (OpenID Connect Core 3.1.3.7), checked for audience and
// expiry. Reconnecting refuses a different mailbox from the one being
// reconnected.
//
// These flows have been exercised against local stand-ins for Google's and
// Microsoft's endpoints only (see oauth.test.ts); they use the endpoints
// and parameters both document.

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.send",
] as const;

export const MICROSOFT_SCOPES = [
  "openid",
  "email",
  "offline_access",
  "https://graph.microsoft.com/Mail.Send",
] as const;

const STATE_TTL_SECONDS = 10 * 60;
/** Refreshed this long before it runs out, so a send never races expiry. */
const EXPIRY_SKEW_SECONDS = 120;
/** Microsoft's tenant id for personal (Outlook.com) accounts. */
const MICROSOFT_CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";

export type OAuthEndpoints = {
  adminConsent: string | null;
  authorize: string;
  revoke: string | null;
  token: string;
  userinfo: string | null;
};

export function defaultEndpoints(
  provider: OAuthProviderName,
  tenant: string,
): OAuthEndpoints {
  if (provider === "google") {
    return {
      adminConsent: null,
      authorize: "https://accounts.google.com/o/oauth2/v2/auth",
      revoke: "https://oauth2.googleapis.com/revoke",
      token: "https://oauth2.googleapis.com/token",
      userinfo: "https://openidconnect.googleapis.com/v1/userinfo",
    };
  }

  const base = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}`;
  // Admin consent is given for a directory: with the multi-tenant
  // endpoints that means "the administrator's own organisation".
  const consentTenant =
    tenant === "common" || tenant === "consumers" ? "organizations" : tenant;

  return {
    adminConsent: `https://login.microsoftonline.com/${encodeURIComponent(consentTenant)}/v2.0/adminconsent`,
    authorize: `${base}/oauth2/v2.0/authorize`,
    // Microsoft has no endpoint that revokes one app's delegated grant.
    revoke: null,
    token: `${base}/oauth2/v2.0/token`,
    userinfo: null,
  };
}

export type OAuthOptions = {
  database?: DbPool;
  endpoints?: Partial<Record<OAuthProviderName, Partial<OAuthEndpoints>>>;
  env?: EnvSource;
  fetch?: typeof fetch;
  now?: () => number;
};

export class OAuthFlowError extends Error {
  readonly adminConsentUrl: string | null;
  readonly code: string;
  readonly statusCode: number;

  constructor(
    code: string,
    message: string,
    {
      adminConsentUrl = null,
      statusCode = 400,
    }: { adminConsentUrl?: string | null; statusCode?: number } = {},
  ) {
    super(message);
    this.name = "OAuthFlowError";
    this.code = code;
    this.adminConsentUrl = adminConsentUrl;
    this.statusCode = statusCode;
  }
}

function currentTime(options: OAuthOptions): number {
  return options.now ? options.now() : Math.floor(Date.now() / 1000);
}

function endpointsFor(
  provider: OAuthProviderName,
  tenant: string,
  options: OAuthOptions,
): OAuthEndpoints {
  return {
    ...defaultEndpoints(provider, tenant),
    ...options.endpoints?.[provider],
  };
}

function requireClient(provider: OAuthProviderName, env: EnvSource) {
  const client = readOAuthClient(provider, env);

  if (!client) {
    throw new OAuthFlowError(
      "not_configured",
      unavailableReasonFor(
        getPreset(provider === "google" ? "gmail" : "microsoft365"),
        env,
      ) ?? "This provider is not configured.",
      { statusCode: 409 },
    );
  }

  return client;
}

export function oauthRedirectUri(env: EnvSource = process.env): string {
  const appUrl = resolveAppUrl(env);

  if (!appUrl) {
    throw new OAuthFlowError(
      "not_configured",
      "Set APP_URL so Google and Microsoft can send you back to PACTORA.",
      { statusCode: 409 },
    );
  }

  return new URL("/api/email/oauth/callback", appUrl).toString();
}

function hashState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

function stateContext(stateHash: string): string {
  return `email-oauth-state:${stateHash}`;
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function adminConsentUrl(
  provider: OAuthProviderName,
  options: OAuthOptions,
): string | null {
  const env = options.env ?? process.env;
  const client = readOAuthClient(provider, env);

  if (provider !== "microsoft" || !client) {
    return null;
  }

  const endpoint = endpointsFor(provider, client.tenant, options).adminConsent;

  if (!endpoint) {
    return null;
  }

  const url = new URL(endpoint);

  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("scope", "https://graph.microsoft.com/Mail.Send");
  url.searchParams.set("redirect_uri", oauthRedirectUri(env));

  return url.toString();
}

const ADMIN_CONSENT_PATTERN =
  /admin_consent_required|consent_required|AADSTS65001|AADSTS90094|AADSTS90008/i;

/** Microsoft's "an administrator has to approve this app first". */
export function isAdminConsentError(
  error: string | null | undefined,
  description: string | null | undefined,
): boolean {
  return ADMIN_CONSENT_PATTERN.test(`${error ?? ""} ${description ?? ""}`);
}

export type StartOAuthInput = {
  presetId: ProviderPresetId;
  reconnectAccountId?: string | null;
  scope: AccountScope;
};

/** Starts a connection: stores the state and returns where to send the browser. */
export async function startOAuth(
  actor: AccountActor,
  input: StartOAuthInput,
  options: OAuthOptions = {},
): Promise<{ authorizationUrl: string }> {
  const env = options.env ?? process.env;
  const database = options.database ?? getDb();

  if (!isProviderPresetId(input.presetId)) {
    throw new OAuthFlowError("unknown_provider", "Choose a provider.");
  }

  const preset = getPreset(input.presetId);

  if (!preset.oauth) {
    throw new OAuthFlowError(
      "not_oauth",
      `${preset.name} is connected with a password or API key, not a sign-in button.`,
    );
  }

  const client = requireClient(preset.oauth, env);
  let scope = input.scope;

  if (input.reconnectAccountId) {
    const account = await loadAccount(input.reconnectAccountId, database);

    if (
      !account ||
      !(await canManageAccount(actor.userId, account, database))
    ) {
      throw new OAuthFlowError(
        "not_found",
        "That email account no longer exists.",
        { statusCode: 404 },
      );
    }

    if (getPreset(account.presetId).oauth !== preset.oauth) {
      throw new OAuthFlowError(
        "different_provider",
        `That account is not a ${preset.oauth === "google" ? "Google" : "Microsoft"} account.`,
      );
    }

    scope = account.scope;
  }

  if (
    scope === "organization" &&
    !(await isAdministrator(actor.userId, database))
  ) {
    throw new OAuthFlowError(
      "forbidden",
      "Only an administrator can connect an organisation email account.",
      { statusCode: 403 },
    );
  }

  const timestamp = currentTime(options);
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const stateHash = hashState(state);

  // Old states are cleared as new ones are made.
  await database.query(`DELETE FROM email_oauth_states WHERE expires_at < $1`, [
    timestamp - 3600,
  ]);
  await database.query(
    `
      INSERT INTO email_oauth_states (
        state_hash, user_id, preset_id, scope, reconnect_account_id,
        encrypted_verifier, created_at, expires_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
    [
      stateHash,
      actor.userId,
      preset.id,
      scope,
      input.reconnectAccountId ?? null,
      sealSecret(verifier, { context: stateContext(stateHash), env }),
      timestamp,
      timestamp + STATE_TTL_SECONDS,
    ],
  );

  const endpoints = endpointsFor(preset.oauth, client.tenant, options);
  const url = new URL(endpoints.authorize);
  const params = url.searchParams;

  params.set("client_id", client.clientId);
  params.set("redirect_uri", oauthRedirectUri(env));
  params.set("response_type", "code");
  params.set("state", state);
  params.set("code_challenge", pkceChallenge(verifier));
  params.set("code_challenge_method", "S256");

  if (preset.oauth === "google") {
    params.set("scope", GOOGLE_SCOPES.join(" "));
    // A refresh token, every time, so the mailbox keeps working.
    params.set("access_type", "offline");
    params.set("prompt", "consent");
    params.set("include_granted_scopes", "false");
  } else {
    params.set("scope", MICROSOFT_SCOPES.join(" "));
    params.set("response_mode", "query");
    params.set("prompt", "select_account");
  }

  if (actor.email) {
    params.set("login_hint", actor.email);
  }

  return { authorizationUrl: url.toString() };
}

type ConsumedState = {
  encryptedVerifier: string;
  expiresAt: number;
  presetId: ProviderPresetId;
  reconnectAccountId: string | null;
  scope: AccountScope;
  stateHash: string;
  userId: string;
};

/** Takes the state, once. Anyone else's, a used one or an old one is refused. */
export async function consumeOAuthState(
  userId: string,
  state: string,
  options: OAuthOptions = {},
): Promise<ConsumedState & { verifier: string }> {
  const database = options.database ?? getDb();
  const timestamp = currentTime(options);
  const stateHash = hashState(state);
  const row = await queryOne<ConsumedState>(
    database,
    `
      UPDATE email_oauth_states
      SET consumed_at = $2
      WHERE state_hash = $1 AND consumed_at IS NULL
      RETURNING
        state_hash AS "stateHash",
        user_id AS "userId",
        preset_id AS "presetId",
        scope,
        reconnect_account_id AS "reconnectAccountId",
        encrypted_verifier AS "encryptedVerifier",
        expires_at AS "expiresAt"
    `,
    [stateHash, timestamp],
  );

  if (!row) {
    throw new OAuthFlowError(
      "invalid_state",
      "That sign-in link was already used or is not valid. Start again from Settings.",
    );
  }

  if (row.userId !== userId) {
    throw new OAuthFlowError(
      "invalid_state",
      "That sign-in was started by someone else. Start again from Settings.",
    );
  }

  if (row.expiresAt <= timestamp) {
    throw new OAuthFlowError(
      "expired_state",
      "That sign-in took longer than ten minutes. Start again from Settings.",
    );
  }

  return {
    ...row,
    verifier: openSecret(row.encryptedVerifier, {
      context: stateContext(stateHash),
      env: options.env,
    }),
  };
}

type TokenResponse = {
  access_token?: string;
  error?: string;
  error_description?: string;
  expires_in?: number;
  id_token?: string;
  refresh_token?: string;
  scope?: string;
};

async function postToken(
  provider: OAuthProviderName,
  body: Record<string, string>,
  options: OAuthOptions,
): Promise<{ body: TokenResponse; status: number }> {
  const env = options.env ?? process.env;
  const client = requireClient(provider, env);
  const endpoints = endpointsFor(provider, client.tenant, options);
  let response: Response;

  try {
    response = await (options.fetch ?? fetch)(endpoints.token, {
      body: new URLSearchParams({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        ...body,
      }),
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw fetchFailure(
      error,
      provider === "google"
        ? "Google's sign-in service"
        : "Microsoft's sign-in service",
    );
  }

  return {
    body: ((await response.json().catch(() => ({}))) ?? {}) as TokenResponse,
    status: response.status,
  };
}

type IdentityClaims = {
  aud?: string | string[];
  email?: string;
  email_verified?: boolean | string;
  exp?: number;
  hd?: string;
  oid?: string;
  preferred_username?: string;
  sub?: string;
  tid?: string;
};

/** The ID token's claims. Its signature is TLS's to vouch for: see above. */
export function decodeIdToken(idToken: string): IdentityClaims {
  const payload = idToken.split(".")[1];

  if (!payload) {
    throw new OAuthFlowError(
      "invalid_token",
      "The provider sent an unreadable identity.",
    );
  }

  try {
    return JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as IdentityClaims;
  } catch {
    throw new OAuthFlowError(
      "invalid_token",
      "The provider sent an unreadable identity.",
    );
  }
}

type MailboxIdentity = {
  emailAddress: string;
  presetId: ProviderPresetId;
  providerAccountId: string;
};

async function identify(
  provider: OAuthProviderName,
  requestedPreset: ProviderPresetId,
  tokens: TokenResponse,
  options: OAuthOptions,
): Promise<MailboxIdentity> {
  const env = options.env ?? process.env;
  const client = requireClient(provider, env);
  let claims: IdentityClaims | null = tokens.id_token
    ? decodeIdToken(tokens.id_token)
    : null;

  if (claims) {
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];

    if (!audiences.includes(client.clientId)) {
      throw new OAuthFlowError(
        "invalid_token",
        "The identity was issued for another app.",
      );
    }

    if (
      typeof claims.exp === "number" &&
      claims.exp < currentTime(options) - 300
    ) {
      throw new OAuthFlowError(
        "invalid_token",
        "The identity has expired. Try again.",
      );
    }
  } else if (provider === "google" && tokens.access_token) {
    const endpoint = endpointsFor(provider, client.tenant, options).userinfo;

    if (endpoint) {
      const response = await (options.fetch ?? fetch)(endpoint, {
        headers: { authorization: `Bearer ${tokens.access_token}` },
        signal: AbortSignal.timeout(20_000),
      }).catch((error: unknown) => {
        throw fetchFailure(error, "Google");
      });

      claims = response.ok ? ((await response.json()) as IdentityClaims) : null;
    }
  }

  if (!claims?.sub && !claims?.oid) {
    throw new OAuthFlowError(
      "invalid_token",
      "The provider did not say which mailbox this is.",
    );
  }

  if (provider === "google") {
    const verified =
      claims.email_verified === true || claims.email_verified === "true";

    if (!claims.email || !verified) {
      throw new OAuthFlowError(
        "unverified_email",
        "Google did not confirm this mailbox's address.",
      );
    }

    return {
      emailAddress: claims.email.toLowerCase(),
      // A hosted domain claim means a Google Workspace mailbox, whose
      // sending limit is higher than consumer Gmail's.
      presetId: claims.hd ? "google_workspace" : "gmail",
      providerAccountId: `google:${claims.sub!}`,
    };
  }

  const address = (
    claims.email ??
    claims.preferred_username ??
    ""
  ).toLowerCase();

  if (!address.includes("@")) {
    throw new OAuthFlowError(
      "unverified_email",
      "Microsoft did not say which mailbox this is.",
    );
  }

  return {
    emailAddress: address,
    presetId:
      claims.tid === MICROSOFT_CONSUMER_TENANT
        ? "outlook"
        : claims.tid
          ? "microsoft365"
          : requestedPreset,
    providerAccountId: `microsoft:${claims.tid ?? "unknown"}:${claims.oid ?? claims.sub!}`,
  };
}

function hasSendScope(
  provider: OAuthProviderName,
  granted: string | undefined,
): boolean {
  const scopes = (granted ?? "").toLowerCase().split(/\s+/);

  return provider === "google"
    ? scopes.includes("https://www.googleapis.com/auth/gmail.send")
    : scopes.some(
        (scope) => scope === "mail.send" || scope.endsWith("/mail.send"),
      );
}

export type CallbackParams = {
  code?: string | null;
  error?: string | null;
  errorDescription?: string | null;
  state?: string | null;
};

/**
 * Finishes a connection: checks the state, trades the code for tokens and
 * saves the account. Returns the account's id.
 */
export async function completeOAuth(
  actor: AccountActor,
  params: CallbackParams,
  options: OAuthOptions = {},
): Promise<{ accountId: string }> {
  const env = options.env ?? process.env;
  const database = options.database ?? getDb();

  if (!params.state) {
    throw new OAuthFlowError(
      "invalid_state",
      "The sign-in did not come back complete. Start again from Settings.",
    );
  }

  const state = await consumeOAuthState(actor.userId, params.state, options);
  const preset = getPreset(state.presetId);
  const provider = preset.oauth!;

  if (params.error || !params.code) {
    if (
      provider === "microsoft" &&
      isAdminConsentError(params.error, params.errorDescription)
    ) {
      throw new OAuthFlowError(
        "admin_consent_required",
        "Your Microsoft 365 administrator has to approve PACTORA before mailboxes can be connected.",
        { adminConsentUrl: adminConsentUrl(provider, options) },
      );
    }

    throw new OAuthFlowError(
      params.error === "access_denied" ? "access_denied" : "provider_error",
      params.error === "access_denied"
        ? "Access was not granted, so nothing was connected."
        : "The provider did not complete the sign-in.",
    );
  }

  const exchange = await postToken(
    provider,
    {
      code: params.code,
      code_verifier: state.verifier,
      grant_type: "authorization_code",
      redirect_uri: oauthRedirectUri(env),
      ...(provider === "microsoft"
        ? { scope: MICROSOFT_SCOPES.join(" ") }
        : {}),
    },
    options,
  );

  if (exchange.status !== 200 || !exchange.body.access_token) {
    if (
      provider === "microsoft" &&
      isAdminConsentError(exchange.body.error, exchange.body.error_description)
    ) {
      throw new OAuthFlowError(
        "admin_consent_required",
        "Your Microsoft 365 administrator has to approve PACTORA before mailboxes can be connected.",
        { adminConsentUrl: adminConsentUrl(provider, options) },
      );
    }

    throw new OAuthFlowError(
      "token_exchange_failed",
      "The sign-in could not be completed. Try again.",
    );
  }

  if (!hasSendScope(provider, exchange.body.scope)) {
    throw new OAuthFlowError(
      "scope_not_granted",
      "Permission to send email was not granted. Connect again and allow PACTORA to send email.",
    );
  }

  if (!exchange.body.refresh_token) {
    throw new OAuthFlowError(
      "no_refresh_token",
      "The provider did not allow PACTORA to stay connected. Connect again and accept every permission.",
    );
  }

  const identity = await identify(
    provider,
    state.presetId,
    exchange.body,
    options,
  );
  const timestamp = currentTime(options);
  const credentials: StoredCredentials = {
    accessToken: exchange.body.access_token,
    expiresAt: timestamp + Number(exchange.body.expires_in ?? 3600),
    refreshToken: exchange.body.refresh_token,
    scope: exchange.body.scope ?? "",
    type: "oauth",
  };

  return withTransaction(async (tx) => {
    let target: EmailAccountRecord | null = null;

    if (state.reconnectAccountId) {
      target = await loadAccount(state.reconnectAccountId, tx);

      if (!target || !(await canManageAccount(actor.userId, target, tx))) {
        throw new OAuthFlowError(
          "not_found",
          "That email account no longer exists.",
          { statusCode: 404 },
        );
      }

      if (
        (target.providerAccountId &&
          target.providerAccountId !== identity.providerAccountId) ||
        target.emailAddress.toLowerCase() !== identity.emailAddress
      ) {
        throw new OAuthFlowError(
          "different_mailbox",
          `You signed in as ${identity.emailAddress}, but this account is ${target.emailAddress}. Sign in with ${target.emailAddress} to reconnect it, or connect ${identity.emailAddress} as a new account.`,
        );
      }
    } else {
      if (
        state.scope === "organization" &&
        !(await isAdministrator(actor.userId, tx))
      ) {
        throw new OAuthFlowError(
          "forbidden",
          "Only an administrator can connect an organisation email account.",
          { statusCode: 403 },
        );
      }

      target = await queryOne<EmailAccountRecord>(
        tx,
        `
          SELECT ${ACCOUNT_COLUMNS}
          FROM email_accounts a
          WHERE a.scope = $1
            AND a.provider = $2
            AND lower(a.email_address) = $3
            AND (a.scope = 'organization' OR a.owner_user_id = $4)
          FOR UPDATE
        `,
        [state.scope, preset.provider, identity.emailAddress, actor.userId],
      );

      if (
        target?.providerAccountId &&
        target.providerAccountId !== identity.providerAccountId
      ) {
        throw new OAuthFlowError(
          "different_mailbox",
          `${identity.emailAddress} is already connected as a different ${preset.oauth === "google" ? "Google" : "Microsoft"} account.`,
        );
      }
    }

    if (target) {
      await saveAccountCredentials(target.id, credentials, {
        database: tx,
        env,
      });
      await tx.query(
        `
          UPDATE email_accounts
          SET status = 'connected',
              provider_account_id = $2,
              oauth_scope = $3,
              last_error = NULL,
              updated_at = $4
          WHERE id = $1
        `,
        [target.id, identity.providerAccountId, credentials.scope, timestamp],
      );

      return { accountId: target.id };
    }

    const id = randomUUID();

    await tx.query(
      `
        INSERT INTO email_accounts (
          id, scope, owner_user_id, created_by_user_id, provider, preset_id,
          email_address, status, encrypted_credentials, provider_account_id,
          oauth_scope, is_default, shared_with, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'connected', $8, $9, $10, false, 'nobody', $11, $11)
      `,
      [
        id,
        state.scope,
        state.scope === "personal" ? actor.userId : null,
        actor.userId,
        preset.provider,
        identity.presetId,
        identity.emailAddress,
        sealCredentials(id, credentials, env),
        identity.providerAccountId,
        credentials.scope,
        timestamp,
      ],
    );

    return { accountId: id };
  }, database);
}

/**
 * A current access token for an OAuth account, refreshed when it is about
 * to run out. A refresh the provider refuses for good (invalid_grant: the
 * grant was revoked, the password changed, the refresh token expired)
 * marks the account for reconnecting and fails as an auth error.
 */
export async function getAccessToken(
  account: EmailAccountRecord,
  options: OAuthOptions = {},
): Promise<string> {
  const env = options.env ?? process.env;
  const database = options.database ?? getDb();
  const preset = getPreset(account.presetId);
  const credentials = openCredentials(account, env);

  if (credentials.type !== "oauth" || !preset.oauth) {
    throw new EmailTransportError("This account does not sign in with OAuth.", {
      kind: "permanent",
    });
  }

  const timestamp = currentTime(options);

  if (credentials.expiresAt - EXPIRY_SKEW_SECONDS > timestamp) {
    return credentials.accessToken;
  }

  const reconnect = async (message: string): Promise<never> => {
    await recordAccountOutcome(
      account.id,
      { error: message, needsReconnect: true, ok: false },
      database,
    );
    throw new EmailTransportError(message, {
      code: "invalid_grant",
      kind: "auth",
    });
  };

  if (!credentials.refreshToken) {
    return reconnect(
      `${preset.name} access has run out. ${reconnectRecovery(preset)}`,
    );
  }

  const refreshed = await postToken(
    preset.oauth,
    {
      grant_type: "refresh_token",
      refresh_token: credentials.refreshToken,
      ...(preset.oauth === "microsoft"
        ? { scope: MICROSOFT_SCOPES.join(" ") }
        : {}),
    },
    options,
  );

  if (refreshed.status !== 200 || !refreshed.body.access_token) {
    if (
      refreshed.body.error === "invalid_grant" ||
      refreshed.body.error === "unauthorized_client" ||
      (refreshed.status === 400 &&
        refreshed.body.error === "interaction_required")
    ) {
      return reconnect(
        `${preset.name} no longer accepts PACTORA's access to ${account.emailAddress}. ${reconnectRecovery(preset)}`,
      );
    }

    throw new EmailTransportError(
      `${preset.name} could not renew access right now.`,
      {
        code: refreshed.body.error ?? null,
        kind:
          refreshed.status >= 500 || refreshed.status === 429
            ? "transient"
            : "auth",
        statusCode: refreshed.status,
      },
    );
  }

  const next: StoredCredentials = {
    accessToken: refreshed.body.access_token,
    expiresAt: timestamp + Number(refreshed.body.expires_in ?? 3600),
    // Google keeps the refresh token; Microsoft hands out a new one.
    refreshToken: refreshed.body.refresh_token ?? credentials.refreshToken,
    scope: refreshed.body.scope ?? credentials.scope,
    type: "oauth",
  };

  await saveAccountCredentials(account.id, next, { database, env });

  return next.accessToken;
}

export const MICROSOFT_REVOCATION_NOTE =
  "Microsoft does not let apps withdraw their own access. To remove PACTORA from the mailbox, open https://myapps.microsoft.com (work or school accounts) or https://account.live.com/consent/Manage (Outlook.com and Hotmail).";

/**
 * Withdraws PACTORA's access to an OAuth mailbox where the provider allows
 * it. Google: the grant is revoked. Microsoft: nothing to call; the tokens
 * are deleted with the account and the person is told where to remove the
 * app themselves.
 */
export async function revokeAccountGrant(
  account: EmailAccountRecord,
  options: OAuthOptions = {},
): Promise<{ note: string | null; revoked: boolean }> {
  const env = options.env ?? process.env;
  const preset = getPreset(account.presetId);

  if (!preset.oauth) {
    return { note: null, revoked: false };
  }

  if (preset.oauth === "microsoft") {
    return { note: MICROSOFT_REVOCATION_NOTE, revoked: false };
  }

  let credentials: StoredCredentials;

  try {
    credentials = openCredentials(account, env);
  } catch {
    return {
      note: "The saved access could not be read, so it could not be withdrawn. Remove PACTORA at https://myaccount.google.com/permissions.",
      revoked: false,
    };
  }

  const token =
    credentials.type === "oauth"
      ? (credentials.refreshToken ?? credentials.accessToken)
      : null;
  const endpoint = endpointsFor("google", "", options).revoke;

  if (!token || !endpoint) {
    return { note: null, revoked: false };
  }

  try {
    const response = await (options.fetch ?? fetch)(endpoint, {
      body: new URLSearchParams({ token }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    });

    // 400 invalid_token: already revoked, which is what was wanted.
    if (response.ok || response.status === 400) {
      return { note: null, revoked: true };
    }
  } catch {
    // Fall through to the note.
  }

  return {
    note: "Google could not be reached to withdraw PACTORA's access. Remove it at https://myaccount.google.com/permissions.",
    revoked: false,
  };
}
