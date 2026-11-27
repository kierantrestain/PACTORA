import { readEnv, type EnvSource } from "../utils/env.ts";

// Sign-in with Google and Microsoft accounts: personal Gmail and Google
// Workspace, Outlook.com/Hotmail and Microsoft 365.
//
// Signing in asks for `openid email profile` and nothing else. Permission
// to send mail from a mailbox is a separate grant, asked for only when
// someone connects that mailbox under Settings, Email & Integrations
// (src/lib/email). Logging in never gives this app access to a mailbox.

export type OAuthLoginProviders = { google: boolean; microsoft: boolean };

export type GoogleLoginConfig = { clientId: string; clientSecret: string };
export type MicrosoftLoginConfig = {
  clientId: string;
  clientSecret: string;
  tenantId: string;
};

export function readGoogleLoginConfig(
  env: EnvSource = process.env,
): GoogleLoginConfig | null {
  const clientId = readEnv(env, "GOOGLE_CLIENT_ID");
  const clientSecret = readEnv(env, "GOOGLE_CLIENT_SECRET");

  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function readMicrosoftLoginConfig(
  env: EnvSource = process.env,
): MicrosoftLoginConfig | null {
  const clientId = readEnv(env, "MICROSOFT_CLIENT_ID");
  const clientSecret = readEnv(env, "MICROSOFT_CLIENT_SECRET");

  return clientId && clientSecret
    ? {
        clientId,
        clientSecret,
        // "common" accepts both work or school and personal accounts.
        tenantId: readEnv(env, "MICROSOFT_TENANT_ID") ?? "common",
      }
    : null;
}

/** Which sign-in buttons work on this deployment. Never a dead button. */
export function getOAuthLoginProviders(
  env: EnvSource = process.env,
): OAuthLoginProviders {
  return {
    google: readGoogleLoginConfig(env) !== null,
    microsoft: readMicrosoftLoginConfig(env) !== null,
  };
}

// The tenant every personal Microsoft account (Outlook.com, Hotmail, Live)
// signs in through. Its email claim is the account's own sign-in address,
// which Microsoft has verified.
const MICROSOFT_CONSUMER_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";

function isTrue(value: unknown): boolean {
  return value === true || value === "true" || value === 1;
}

/**
 * Whether the provider vouches for the email address it sent. An account is
 * only created, or tied to an existing account with that address, when it
 * does: otherwise anyone able to put someone else's address on a provider
 * account could take over that person's PACTORA account.
 *
 * Microsoft work and school accounts carry an email claim the tenant's own
 * administrators can set to anything (the "nOAuth" problem), so it counts
 * only when Microsoft marks the domain owner as verified (xms_edov) or the
 * address is verified on the account.
 */
export function isOAuthEmailVerified(
  providerId: string,
  profile: Record<string, unknown> | undefined,
): boolean {
  if (!profile) {
    return false;
  }

  const email = typeof profile.email === "string" ? profile.email : "";

  if (providerId === "google") {
    return email.length > 0 && isTrue(profile.email_verified);
  }

  if (providerId === "microsoft") {
    if (!email) {
      return false;
    }

    if (isTrue(profile.email_verified) || isTrue(profile.xms_edov)) {
      return true;
    }

    const verified = [
      ...(Array.isArray(profile.verified_primary_email)
        ? profile.verified_primary_email
        : []),
      ...(Array.isArray(profile.verified_secondary_email)
        ? profile.verified_secondary_email
        : []),
    ].map((value) => String(value).toLowerCase());

    if (verified.includes(email.toLowerCase())) {
      return true;
    }

    return profile.tid === MICROSOFT_CONSUMER_TENANT_ID;
  }

  return false;
}

export const OAUTH_EMAIL_NOT_VERIFIED_MESSAGE =
  "Your account provider has not verified this email address, so it can't be used to sign in here. Sign up with your email and a password instead.";
