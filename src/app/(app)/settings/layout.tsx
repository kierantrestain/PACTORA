import type { ReactNode } from "react";

import { SettingsFrame } from "@/components/settings/settings-frame";
import { isAdminUser } from "@/lib/auth/admin";
import { getAuthSession } from "@/lib/auth/server";
import { getSettings } from "@/lib/settings";

export default async function SettingsLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const session = await getAuthSession();
  const [isAdmin, settings] = await Promise.all([
    session ? isAdminUser(session.user.id) : false,
    getSettings(),
  ]);

  return (
    <SettingsFrame viewer={{ hosted: settings.hosted, isAdmin }}>
      {children}
    </SettingsFrame>
  );
}
