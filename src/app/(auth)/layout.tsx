import type { Metadata } from "next";
import type { ReactNode } from "react";
import { connection } from "next/server";

import { AuthShell } from "@/components/layout/auth-shell";
import { BrandingProvider } from "@/components/layout/branding-provider";
import { getInstallMetadata } from "@/lib/install";
import { buildBranding, type Branding } from "@/lib/branding";
import { ServiceConfigurationError } from "@/lib/services/service-config";
import { getBranding, resolveSettings } from "@/lib/settings";

async function loadBranding(): Promise<Branding> {
  try {
    return await getBranding();
  } catch (error) {
    // No database connected: the sign-up page says so, under the
    // product's own name.
    if (error instanceof ServiceConfigurationError) {
      return buildBranding(resolveSettings(null));
    }

    throw error;
  }
}

export async function generateMetadata(): Promise<Metadata> {
  await connection();

  return getInstallMetadata();
}

export default async function UnauthenticatedLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  await connection();

  // A fresh install's front doors (/ and /login) lead to /signup, which
  // lives under this layout, so the redirect is made by those pages rather
  // than here.
  return (
    <BrandingProvider branding={await loadBranding()}>
      <AuthShell>{children}</AuthShell>
    </BrandingProvider>
  );
}
