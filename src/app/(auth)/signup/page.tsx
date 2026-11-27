import type { Metadata } from "next";

import { SignupShell } from "@/components/auth/signup-shell";
import { getOAuthLoginProviders } from "@/lib/auth/oauth-providers";
import { redirectIfSignedIn } from "@/lib/auth/server";
import { readPasswordSignInPolicy, readSsoConfig } from "@/lib/auth/sso";
import { getRegistrationView } from "@/lib/owner-provisioning";
import { canSendPlatformEmail } from "@/lib/services/email";

export const metadata: Metadata = { title: "Create account" };

export default async function SignupPage() {
  await redirectIfSignedIn();

  const registration = await getRegistrationView();
  const sso = readSsoConfig();

  return (
    <SignupShell
      emailConnected={await canSendPlatformEmail()}
      oauthProviders={getOAuthLoginProviders()}
      passwordSignIn={readPasswordSignInPolicy().enabled}
      registration={registration}
      sso={sso ? { name: sso.name } : null}
    />
  );
}
