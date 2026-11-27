import type { Metadata } from "next";

import { ResetPasswordShell } from "@/components/auth/recovery-shells";

export const metadata: Metadata = { title: "Choose a new password" };

type ResetPasswordPageProps = {
  searchParams: Promise<{ error?: string; token?: string }>;
};

// Better Auth's reset link lands here with ?token=, or with
// ?error=INVALID_TOKEN when the link has expired or was used.
export default async function ResetPasswordPage({
  searchParams,
}: ResetPasswordPageProps) {
  const { error, token } = await searchParams;

  return <ResetPasswordShell token={error || !token ? null : token} />;
}
