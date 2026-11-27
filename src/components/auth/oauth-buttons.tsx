"use client";

import { useState } from "react";

import { authClient } from "@/lib/auth/client";

// "Continue with Google" and "Continue with Microsoft". Each is shown only
// when the deployment has that provider configured (getOAuthLoginProviders),
// so there is never a button that cannot work. Signing in this way asks for
// the person's name and address only, never access to their mailbox.

export type OAuthProviders = { google: boolean; microsoft: boolean };

type Provider = "google" | "microsoft";

const PROVIDER_LABELS: Record<Provider, string> = {
  google: "Google",
  microsoft: "Microsoft",
};

/** What the sign-in page says for an ?error= a provider sent back. */
export function describeOAuthError(code: string): string {
  switch (code) {
    case "signup_closed":
    case "signup_domain_not_allowed":
      return "That address doesn't have an account here, and this workspace's sign-up rule doesn't allow a new one. Ask your administrator for an invitation.";
    case "access_denied":
      return "Sign-in was cancelled.";
    case "email_not_found":
      return "Your provider didn't share an email address, so you couldn't be signed in.";
    case "unable_to_link_account":
    case "email_not_verified":
      return "An account with this address already exists. Sign in with your password once, then try again.";
    case "account_already_linked_to_different_user":
      return "This sign-in is already linked to a different account here.";
    default:
      return "Sign-in didn't finish. Please try again.";
  }
}

export function hasOAuthProviders(providers: OAuthProviders | null): boolean {
  return Boolean(providers && (providers.google || providers.microsoft));
}

export function OAuthButtons({
  callbackURL = "/dashboard",
  disabled = false,
  onError,
  providers,
}: {
  callbackURL?: string;
  disabled?: boolean;
  onError: (message: string) => void;
  providers: OAuthProviders | null;
}) {
  const [busy, setBusy] = useState<Provider | null>(null);

  if (!providers || !hasOAuthProviders(providers)) {
    return null;
  }

  async function start(provider: Provider) {
    if (busy) {
      return;
    }

    setBusy(provider);

    try {
      const result = await authClient.signIn.social({
        callbackURL,
        errorCallbackURL: "/login",
        newUserCallbackURL: "/dashboard",
        provider,
      });

      if (result.error) {
        onError(describeOAuthError(result.error.code ?? ""));
        setBusy(null);
      }
      // On success the browser is already on its way to the provider.
    } catch {
      onError(describeOAuthError(""));
      setBusy(null);
    }
  }

  const enabled = (["google", "microsoft"] as const).filter(
    (provider) => providers[provider],
  );

  return (
    <div className="grid gap-3">
      {enabled.map((provider) => (
        <button
          className="inline-flex min-h-12 w-full items-center justify-center gap-3 rounded-[0.875rem] border-[1.5px] border-(--border-strong) bg-(--paper) px-5 text-[0.9375rem] font-bold text-(--fg) transition hover:border-(--border-hover) hover:bg-(--surface) focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-60"
          disabled={disabled || busy !== null}
          key={provider}
          onClick={() => void start(provider)}
          type="button"
        >
          {busy === provider ? (
            <span
              aria-hidden="true"
              className="inline-flex size-4 animate-spin rounded-full border-2 border-current border-r-transparent"
            />
          ) : provider === "google" ? (
            <GoogleMark />
          ) : (
            <MicrosoftMark />
          )}
          Continue with {PROVIDER_LABELS[provider]}
        </button>
      ))}
    </div>
  );
}

function GoogleMark() {
  return (
    <svg aria-hidden="true" className="size-[1.125rem]" viewBox="0 0 48 48">
      <path
        d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"
        fill="#FFC107"
      />
      <path
        d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
        fill="#FF3D00"
      />
      <path
        d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"
        fill="#4CAF50"
      />
      <path
        d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 38.2 44 33 44 24c0-1.3-.1-2.4-.4-3.5z"
        fill="#1976D2"
      />
    </svg>
  );
}

function MicrosoftMark() {
  return (
    <svg aria-hidden="true" className="size-4" viewBox="0 0 21 21">
      <rect fill="#F25022" height="10" width="10" x="0" y="0" />
      <rect fill="#7FBA00" height="10" width="10" x="11" y="0" />
      <rect fill="#00A4EF" height="10" width="10" x="0" y="11" />
      <rect fill="#FFB900" height="10" width="10" x="11" y="11" />
    </svg>
  );
}
