import type { Metadata } from "next";

import { ForgotPasswordShell } from "@/components/auth/recovery-shells";

export const metadata: Metadata = { title: "Reset your password" };

export default function ForgotPasswordPage() {
  return <ForgotPasswordShell />;
}
