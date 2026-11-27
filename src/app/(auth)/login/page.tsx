import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { LoginShell } from "@/components/auth/login-shell";
import { getOAuthLoginProviders } from "@/lib/auth/oauth-providers";
import { redirectIfSignedIn } from "@/lib/auth/server";
import { readPasswordSignInPolicy, readSsoConfig } from "@/lib/auth/sso";
import { redirectToSetupIfNeeded } from "@/lib/install";

export const metadata: Metadata = { title: "Sign in" };

type LoginPageProps = {
  searchParams: Promise<{
    error?: string;
    next?: string;
    token?: string;
  }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;

  // Reset links sent before the reset page had its own address came back
  // here with the token, or with the error for one that had expired.
  if (params.token) {
    redirect(`/reset-password?token=${encodeURIComponent(params.token)}`);
  }

  if (params.error === "INVALID_TOKEN") {
    redirect("/reset-password?error=INVALID_TOKEN");
  }

  await redirectToSetupIfNeeded();

  if (!params.error) {
    await redirectIfSignedIn();
  }

  const sso = readSsoConfig();
  const passwordPolicy = readPasswordSignInPolicy();

  return (
    <LoginShell
      // Anything else is a provider coming back without a session.
      callbackError={params.error ? params.error.slice(0, 80) : null}
      next={params.next ?? null}
      oauthProviders={getOAuthLoginProviders()}
      passwordSignIn={
        passwordPolicy.enabled
          ? "on"
          : passwordPolicy.allowedEmails.length > 0
            ? "fallback"
            : "off"
      }
      sso={sso ? { name: sso.name } : null}
    />
  );
}
