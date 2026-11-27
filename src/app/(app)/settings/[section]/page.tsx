import { notFound, redirect } from "next/navigation";

import { EmailIntegrationsPanel } from "@/components/settings/email-integrations-panel";
import { InvitationsPanel } from "@/components/settings/invitations-panel";
import { NotificationsPanel } from "@/components/settings/notifications-panel";
import {
  BrandingSettings,
  DocumentSettings,
  RetentionSettings,
  SendingDomainSettings,
  WorkspaceSettings,
} from "@/components/settings/organization-sections";
import { ApiKeysPanel } from "@/components/settings/api-keys-panel";
import { BackupsPanel } from "@/components/settings/backups-panel";
import { EmbeddingPanel } from "@/components/settings/embedding-panel";
import { Part11Panel } from "@/components/settings/part11-panel";
import { PeoplePanel } from "@/components/settings/people-panel";
import { SecurityPanel } from "@/components/settings/security-panel";
import { SettingsPageHeader } from "@/components/settings/settings-frame";
import {
  canOpenSection,
  findSection,
  isSettingsSectionId,
} from "@/components/settings/settings-index";
import { SettingsShell } from "@/components/settings/settings-shell";
import { SignerDataPanel } from "@/components/settings/signer-data-panel";
import { TeamsPanel } from "@/components/settings/teams-panel";
import { UpdatesPanel } from "@/components/settings/updates-panel";
import { WebhooksPanel } from "@/components/settings/webhooks-panel";
import { accountClosureBlock } from "@/lib/account";
import { isAdminUser } from "@/lib/auth/admin";
import { getAuthSession } from "@/lib/auth/server";
import { readSsoConfig } from "@/lib/auth/sso";
import { toOrganizationSettingsView } from "@/lib/organization-settings";
import {
  getSettings,
  readStoredSettings,
  resolveSettings,
} from "@/lib/settings";
import { userHasPassword, usesTwoFactor } from "@/lib/sign-in-security";
import { getUpdateStatus } from "@/lib/software-update";

type Props = {
  params: Promise<{ section: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function SettingsSectionPage({
  params,
  searchParams,
}: Props) {
  const { section: sectionId } = await params;
  const query = await searchParams;

  if (!isSettingsSectionId(sectionId)) {
    notFound();
  }

  const session = await getAuthSession();

  if (!session) {
    redirect("/login");
  }

  const [isAdmin, settings] = await Promise.all([
    isAdminUser(session.user.id),
    getSettings(),
  ]);
  const section = findSection(sectionId);

  if (!canOpenSection(section, { hosted: settings.hosted, isAdmin })) {
    redirect("/settings/profile");
  }

  // Read fresh, not from the short-lived cache, so a form never shows a
  // value that was just replaced.
  const organization = isAdmin
    ? toOrganizationSettingsView(resolveSettings(await readStoredSettings()))
    : null;
  const header = (
    <SettingsPageHeader
      description={section.description}
      title={section.label}
    />
  );

  switch (sectionId) {
    case "profile": {
      const [closureBlockedReason, hasPassword] = await Promise.all([
        accountClosureBlock(session.user).catch(() => null),
        userHasPassword(session.user.id),
      ]);

      return (
        <div className="space-y-5">
          {header}
          <SettingsShell
            closureBlockedReason={closureBlockedReason}
            initialProfile={{
              email: session.user.email,
              fullName: session.user.name,
            }}
            part="account"
            twoFactor={{
              enabled: usesTwoFactor(session.user),
              hasPassword,
              required: settings.requireTwoFactor,
              ssoProviderName: readSsoConfig()?.name ?? null,
            }}
          />
        </div>
      );
    }
    case "security": {
      const hasPassword = await userHasPassword(session.user.id);

      return (
        <div className="space-y-5">
          {header}
          <SettingsShell
            initialProfile={{
              email: session.user.email,
              fullName: session.user.name,
            }}
            part="security"
            twoFactor={{
              enabled: usesTwoFactor(session.user),
              hasPassword,
              required: settings.requireTwoFactor,
              ssoProviderName: readSsoConfig()?.name ?? null,
            }}
          />
          {organization && !organization.hosted ? (
            <>
              <SecurityPanel
                initialRequireTwoFactor={organization.requireTwoFactor}
                initialSessionIdleMinutes={organization.sessionIdleMinutes}
                initialSessionMaxHours={organization.sessionMaxHours}
              />
              <Part11Panel initialEnabled={organization.part11Mode} />
            </>
          ) : null}
        </div>
      );
    }
    case "workspace":
      return (
        <div className="space-y-5">
          {header}
          <WorkspaceSettings initialSettings={organization!} />
        </div>
      );
    case "team":
      return (
        <div className="space-y-5">
          {header}
          <InvitationsPanel />
          <PeoplePanel part11Mode={organization!.part11Mode} />
          <TeamsPanel />
        </div>
      );
    case "email":
      return (
        <div className="space-y-5">
          {header}
          <EmailIntegrationsPanel
            currentUser={{ email: session.user.email, name: session.user.name }}
            initialOutcome={{
              connected:
                typeof query.connected === "string"
                  ? query.connected
                  : undefined,
              error:
                typeof query.error === "string"
                  ? query.error.slice(0, 64)
                  : undefined,
            }}
            isAdmin={isAdmin}
          />
        </div>
      );
    case "branding":
      return (
        <div className="space-y-5">
          {header}
          <BrandingSettings initialSettings={organization!} />
        </div>
      );
    case "documents":
      return (
        <div className="space-y-5">
          {header}
          <DocumentSettings initialSettings={organization!} />
        </div>
      );
    case "notifications":
      return (
        <div className="space-y-5">
          {header}
          <NotificationsPanel isAdmin={isAdmin} />
        </div>
      );
    case "data":
      return (
        <div className="space-y-5">
          {header}
          <RetentionSettings initialSettings={organization!} />
          <SignerDataPanel />
          <BackupsPanel />
        </div>
      );
    case "advanced":
      return (
        <div className="space-y-5">
          {header}
          <SendingDomainSettings initialSettings={organization!} />
          {!organization!.hosted ? (
            <>
              <ApiKeysPanel />
              <WebhooksPanel />
              <EmbeddingPanel />
            </>
          ) : null}
          <div className="scroll-mt-28" id="updates">
            <UpdatesPanel initialStatus={getUpdateStatus(null)} />
          </div>
        </div>
      );
  }
}
