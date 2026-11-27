// The map of Settings: its sections, who sees each one, a static index of
// the individual settings for the search box, and where the anchors of the
// single-page Settings that came before now live.

export const SETTINGS_SECTION_IDS = [
  "profile",
  "workspace",
  "team",
  "email",
  "branding",
  "documents",
  "notifications",
  "security",
  "data",
  "advanced",
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

export type SettingsSection = {
  /** Who may open it. "admin" sections are hidden from everyone else. */
  access: "admin" | "everyone";
  description: string;
  /** Not shown on the hosted service, which has no organization to manage. */
  hiddenWhenHosted?: boolean;
  id: SettingsSectionId;
  label: string;
};

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    access: "everyone",
    description: "Your name, email address and password.",
    id: "profile",
    label: "Profile",
  },
  {
    access: "admin",
    description: "Your workspace's name, contact address and who can join.",
    id: "workspace",
    label: "Workspace",
  },
  {
    access: "admin",
    description: "Invite people, manage roles and organise teams.",
    hiddenWhenHosted: true,
    id: "team",
    label: "Team & Permissions",
  },
  {
    access: "everyone",
    description: "Send documents from your own mailbox and see what was sent.",
    id: "email",
    label: "Email & Integrations",
  },
  {
    access: "admin",
    description: "Your logo and colour on every page and email.",
    hiddenWhenHosted: true,
    id: "branding",
    label: "Branding",
  },
  {
    access: "admin",
    description: "What signers read and agree to before they sign.",
    hiddenWhenHosted: true,
    id: "documents",
    label: "Document Defaults",
  },
  {
    access: "everyone",
    description: "The emails this workspace sends, and when.",
    id: "notifications",
    label: "Notifications",
  },
  {
    access: "everyone",
    description: "Two-step sign-in, signed-in devices and sign-in rules.",
    id: "security",
    label: "Security",
  },
  {
    access: "admin",
    description: "How long records are kept, signer requests and backups.",
    id: "data",
    label: "Data & Backups",
  },
  {
    access: "admin",
    description: "Sending domains, API keys, webhooks, embedding and updates.",
    id: "advanced",
    label: "Advanced Administration",
  },
];

export function isSettingsSectionId(value: string): value is SettingsSectionId {
  return (SETTINGS_SECTION_IDS as readonly string[]).includes(value);
}

export type SettingsViewer = { hosted: boolean; isAdmin: boolean };

export function canOpenSection(
  section: SettingsSection,
  viewer: SettingsViewer,
): boolean {
  if (section.access === "admin" && !viewer.isAdmin) {
    return false;
  }

  return !(section.hiddenWhenHosted && viewer.hosted);
}

export function visibleSections(
  viewer: SettingsViewer,
): readonly SettingsSection[] {
  return SETTINGS_SECTIONS.filter((section) => canOpenSection(section, viewer));
}

export function findSection(id: SettingsSectionId): SettingsSection {
  return SETTINGS_SECTIONS.find((section) => section.id === id)!;
}

export function settingsHref(section: SettingsSectionId, anchor?: string) {
  return anchor ? `/settings/${section}#${anchor}` : `/settings/${section}`;
}

export type SettingsSearchItem = {
  /** Only administrators see it, in a section everyone can open. */
  adminOnly?: true;
  anchor: string;
  /** Other words people may search with. */
  keywords: string;
  label: string;
  section: SettingsSectionId;
};

export const SETTINGS_SEARCH_INDEX: readonly SettingsSearchItem[] = [
  { anchor: "profile", keywords: "name email address", label: "Name and email", section: "profile" },
  { anchor: "password", keywords: "change password reset", label: "Password", section: "profile" },
  { anchor: "close-account", keywords: "delete close account danger", label: "Close your account", section: "profile" },
  { anchor: "workspace-name", keywords: "organization organisation company name", label: "Workspace name", section: "workspace" },
  { anchor: "support-address", keywords: "support contact help reply email", label: "Support address", section: "workspace" },
  { anchor: "signup-rule", keywords: "sign-up signup register domains who can join open closed", label: "Who can create an account", section: "workspace" },
  { anchor: "legal-links", keywords: "terms privacy policy links legal", label: "Terms and privacy links", section: "workspace" },
  { anchor: "invitations", keywords: "invite invitation add people member link", label: "Invitations", section: "team" },
  { anchor: "people", keywords: "people users members roles admin administrator identity", label: "People and roles", section: "team" },
  { anchor: "teams", keywords: "teams groups departments", label: "Teams", section: "team" },
  { anchor: "providers", keywords: "connect gmail google workspace microsoft 365 outlook hotmail zoho yahoo icloud smtp resend mailbox", label: "Connect an email account", section: "email" },
  { anchor: "accounts", keywords: "connected accounts mailbox default sharing reconnect disconnect test", label: "Connected email accounts", section: "email" },
  { anchor: "send-from", keywords: "send from preferred account sender", label: "Send my documents from", section: "email" },
  { anchor: "deliveries", keywords: "delivery history sent failed retry bounce log", label: "Delivery history", section: "email" },
  { adminOnly: true, anchor: "templates", keywords: "email templates wording subject message invitation reminder completed", label: "Email wording", section: "email" },
  { anchor: "logo", keywords: "logo image brand", label: "Logo", section: "branding" },
  { anchor: "brand-color", keywords: "colour color accent theme brand", label: "Brand colour", section: "branding" },
  { anchor: "disclosure", keywords: "consent disclosure electronic records esign agree", label: "Consent disclosure", section: "documents" },
  { anchor: "emails", keywords: "notifications emails reminders completion invitation", label: "Emails people receive", section: "notifications" },
  { anchor: "two-step-sign-in", keywords: "two-factor 2fa mfa authenticator totp backup codes", label: "Two-step sign-in", section: "security" },
  { anchor: "sessions", keywords: "sign out everywhere devices sessions", label: "Signed-in devices", section: "security" },
  { adminOnly: true, anchor: "security", keywords: "require two-step session limits idle timeout audit log", label: "Sign-in rules and audit trail", section: "security" },
  { adminOnly: true, anchor: "part11", keywords: "part 11 fda compliance cfr regulated", label: "Part 11 mode", section: "security" },
  { anchor: "retention", keywords: "retention delete keep days records", label: "How long to keep documents", section: "data" },
  { anchor: "signer-data", keywords: "signer data request export erase gdpr privacy", label: "Signer data requests", section: "data" },
  { anchor: "backups", keywords: "backup restore", label: "Backups", section: "data" },
  { anchor: "email-setup", keywords: "dns domain resend sending domain spf dkim custom domain sender address", label: "Sending domain and DNS", section: "advanced" },
  { anchor: "api-keys", keywords: "api keys token developer", label: "API keys", section: "advanced" },
  { anchor: "webhooks", keywords: "webhooks events endpoint", label: "Webhooks", section: "advanced" },
  { anchor: "embedding", keywords: "embed iframe embedded signing allowed sites", label: "Embedded signing", section: "advanced" },
  { anchor: "updates", keywords: "version update upgrade release", label: "Software updates", section: "advanced" },
];

/**
 * Anchors of the single-page Settings, and where each one is now. Links to
 * them (in old emails, bookmarks and docs) keep working.
 */
export const LEGACY_SETTINGS_ANCHORS: Readonly<
  Record<string, { anchor?: string; section: SettingsSectionId }>
> = {
  "api-keys": { anchor: "api-keys", section: "advanced" },
  "email-setup": { anchor: "email-setup", section: "advanced" },
  embedding: { anchor: "embedding", section: "advanced" },
  organization: { section: "workspace" },
  part11: { anchor: "part11", section: "security" },
  people: { anchor: "people", section: "team" },
  security: { anchor: "security", section: "security" },
  "signer-data": { anchor: "signer-data", section: "data" },
  signudoc: { anchor: "updates", section: "advanced" },
  teams: { anchor: "teams", section: "team" },
  "two-step-sign-in": { anchor: "two-step-sign-in", section: "security" },
  webhooks: { anchor: "webhooks", section: "advanced" },
};

export function searchSettings(
  query: string,
  viewer: SettingsViewer,
): SettingsSearchItem[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);

  if (words.length === 0) {
    return [];
  }

  const allowed = new Set(visibleSections(viewer).map((section) => section.id));

  return SETTINGS_SEARCH_INDEX.filter((item) => {
    if (!allowed.has(item.section) || (item.adminOnly && !viewer.isAdmin)) {
      return false;
    }

    const haystack =
      `${item.label} ${item.keywords} ${findSection(item.section).label}`.toLowerCase();

    return words.every((word) => haystack.includes(word));
  }).slice(0, 8);
}
