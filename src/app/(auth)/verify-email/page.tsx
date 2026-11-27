import type { Metadata } from "next";

import { VerifyEmailShell } from "@/components/auth/recovery-shells";
import { getAuthSession } from "@/lib/auth/server";

export const metadata: Metadata = { title: "Confirm your email" };

type VerifyEmailPageProps = {
  searchParams: Promise<{ error?: string }>;
};

// Where the confirmation link in a sign-up email ends up: Better Auth
// verifies the token, then redirects here, adding ?error= when it could not.
export default async function VerifyEmailPage({
  searchParams,
}: VerifyEmailPageProps) {
  const { error } = await searchParams;
  const session = await getAuthSession().catch(() => null);

  return (
    <VerifyEmailShell
      error={error ? error.slice(0, 80) : null}
      signedIn={session !== null}
    />
  );
}
