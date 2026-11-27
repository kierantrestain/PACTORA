import { ServiceConfigurationError } from "./services/service-config.ts";
import { getSetupState, getSettings } from "./settings.ts";
import { describeSignupPolicy } from "./signup-policy.ts";
import {
  getEnv,
  isHostedMode,
  isLocalDeployment,
  readEnv,
  type EnvSource,
} from "./utils/env.ts";

// Who may become the owner of an empty install, and how.
//
// The owner is the first administrator. Whoever holds that role controls
// every document, signer and key on the install, so claiming it must never
// be open to whoever happens to find a public URL first.
//
// - first-owner-open: the first person to register on an empty database
//   becomes the owner, with no token. Allowed only where every request
//   already passes an access gate: local development, or a deployment whose
//   operator has put it behind one (Vercel Authentication, a VPN, an SSO
//   proxy) and says so with PACTORA_ACCESS_PROTECTED=1.
// - provisioning-required: anything else. The web cannot claim the install.
//   The operator creates the owner with `npm run owner:provision`, which
//   needs the database credentials, or with OWNER_PROVISIONING_TOKEN (the
//   older SETUP_TOKEN is still read) through the provisioning API.
//
// HOSTED_MODE is a public service by definition, so it never allows the
// open claim, whatever else is set.

export type OwnerProvisioningMode =
  | { mode: "first-owner-open"; reason: "local" | "access-protected" }
  | { mode: "provisioning-required"; tokenAccepted: boolean };

function isTruthy(value: string | undefined): boolean {
  const normalized = value?.toLowerCase();

  return normalized === "1" || normalized === "true" || normalized === "yes";
}

/** The provisioning token, under its 1.1 name or the older SETUP_TOKEN. */
export function readOwnerProvisioningToken(
  env: EnvSource = process.env,
): string | undefined {
  return readEnv(env, "OWNER_PROVISIONING_TOKEN") ?? getEnv(env).setup.token;
}

function isLocalDevelopment(env: EnvSource): boolean {
  // Never on Vercel: a Vercel deployment is reachable from the internet
  // unless its operator has protected it, which is the other branch.
  if (readEnv(env, "VERCEL") === "1") {
    return false;
  }

  if (env.NODE_ENV !== "production") {
    return true;
  }

  try {
    return isLocalDeployment(env);
  } catch {
    return false;
  }
}

export function resolveOwnerProvisioning(
  env: EnvSource = process.env,
): OwnerProvisioningMode {
  const tokenAccepted = readOwnerProvisioningToken(env) !== undefined;

  if (isHostedMode(env)) {
    return { mode: "provisioning-required", tokenAccepted };
  }

  if (isTruthy(readEnv(env, "PACTORA_ACCESS_PROTECTED"))) {
    return { mode: "first-owner-open", reason: "access-protected" };
  }

  if (isLocalDevelopment(env)) {
    return { mode: "first-owner-open", reason: "local" };
  }

  return { mode: "provisioning-required", tokenAccepted };
}

export function allowsTokenFreeFirstOwner(
  env: EnvSource = process.env,
): boolean {
  return resolveOwnerProvisioning(env).mode === "first-owner-open";
}

export type RegistrationView =
  | { view: "first-owner" }
  | { view: "provisioning-required" }
  | { view: "standard"; signupRule: string | null }
  | { view: "invitation-only" }
  | { view: "unavailable"; reason: "no_database" | "unmigrated" };

/** What the sign-up page should offer right now. */
export async function getRegistrationView(
  env: EnvSource = process.env,
): Promise<RegistrationView> {
  try {
    const state = await getSetupState();

    if (state.status === "unmigrated") {
      return { reason: "unmigrated", view: "unavailable" };
    }

    if (state.status === "fresh") {
      return allowsTokenFreeFirstOwner(env)
        ? { view: "first-owner" }
        : { view: "provisioning-required" };
    }

    const settings = await getSettings(env);

    if (settings.signupMode === "closed") {
      return { view: "invitation-only" };
    }

    return {
      signupRule:
        settings.signupMode === "open" ? null : describeSignupPolicy(settings),
      view: "standard",
    };
  } catch (error) {
    if (error instanceof ServiceConfigurationError) {
      return { reason: "no_database", view: "unavailable" };
    }

    throw error;
  }
}
