import { readEnv, type EnvSource } from "../utils/env.ts";

// The mailboxes PACTORA can send through, and what each one needs.
//
// Google and Microsoft mailboxes are connected with OAuth only: PACTORA
// never asks for a Google or Microsoft password. Yahoo and iCloud take an
// app password over SMTP, because their normal passwords do not work for
// SMTP once two-step sign-in is on. A new provider implements
// EmailTransport and adds a preset here.

export const PROVIDER_PRESET_IDS = [
  "gmail",
  "google_workspace",
  "microsoft365",
  "outlook",
  "zoho",
  "yahoo",
  "icloud",
  "smtp",
  "resend",
] as const;

export type ProviderPresetId = (typeof PROVIDER_PRESET_IDS)[number];
export type AccountProvider = "gmail" | "microsoft" | "smtp" | "resend";
export type SmtpSecurity = "tls" | "starttls";
export type OAuthProviderName = "google" | "microsoft";

export type ProviderPreset = {
  appPasswordRequired: boolean;
  /**
   * Conservative messages per rolling 24 hours, from the provider's
   * published limits. Null where the provider sets none that applies, or
   * the administrator sets it (custom SMTP).
   */
  dailyLimit: number | null;
  helpUrl: string | null;
  id: ProviderPresetId;
  method: "oauth" | "smtp" | "api";
  name: string;
  oauth: OAuthProviderName | null;
  perMinuteLimit: number | null;
  provider: AccountProvider;
  /** The hosts that may be chosen for this preset, the first the default. */
  smtpHosts: readonly string[];
  smtpDefaults: { host: string; port: number; security: SmtpSecurity } | null;
  /** The SMTP user name is always the full email address. */
  usernameIsAddress: boolean;
};

export const PROVIDER_PRESETS: Record<ProviderPresetId, ProviderPreset> = {
  gmail: {
    appPasswordRequired: false,
    // https://support.google.com/mail/answer/22839
    dailyLimit: 500,
    helpUrl: "https://support.google.com/accounts/answer/3466521",
    id: "gmail",
    method: "oauth",
    name: "Gmail",
    oauth: "google",
    perMinuteLimit: null,
    provider: "gmail",
    smtpDefaults: null,
    smtpHosts: [],
    usernameIsAddress: false,
  },
  google_workspace: {
    appPasswordRequired: false,
    // https://support.google.com/a/answer/166852
    dailyLimit: 2000,
    helpUrl: "https://support.google.com/a/answer/7281227",
    id: "google_workspace",
    method: "oauth",
    name: "Google Workspace",
    oauth: "google",
    perMinuteLimit: null,
    provider: "gmail",
    smtpDefaults: null,
    smtpHosts: [],
    usernameIsAddress: false,
  },
  microsoft365: {
    appPasswordRequired: false,
    // https://learn.microsoft.com/office365/servicedescriptions/exchange-online-service-description/exchange-online-limits#sending-limits
    dailyLimit: 10000,
    helpUrl:
      "https://learn.microsoft.com/entra/identity/enterprise-apps/grant-admin-consent",
    id: "microsoft365",
    method: "oauth",
    name: "Microsoft 365",
    oauth: "microsoft",
    perMinuteLimit: 30,
    provider: "microsoft",
    smtpDefaults: null,
    smtpHosts: [],
    usernameIsAddress: false,
  },
  outlook: {
    appPasswordRequired: false,
    // Outlook.com limits new and personal accounts well below Microsoft 365.
    dailyLimit: 300,
    helpUrl: "https://account.live.com/consent/Manage",
    id: "outlook",
    method: "oauth",
    name: "Outlook.com / Hotmail",
    oauth: "microsoft",
    perMinuteLimit: 30,
    provider: "microsoft",
    smtpDefaults: null,
    smtpHosts: [],
    usernameIsAddress: false,
  },
  zoho: {
    appPasswordRequired: false,
    // Zoho's free and lite plans are limited; this stays well inside them.
    dailyLimit: 250,
    helpUrl: "https://www.zoho.com/mail/help/zoho-smtp.html",
    id: "zoho",
    method: "smtp",
    name: "Zoho Mail",
    oauth: null,
    perMinuteLimit: null,
    provider: "smtp",
    smtpDefaults: { host: "smtp.zoho.com", port: 465, security: "tls" },
    // Accounts in Zoho's EU and India data centres use their own hosts.
    smtpHosts: ["smtp.zoho.com", "smtp.zoho.eu", "smtp.zoho.in"],
    usernameIsAddress: true,
  },
  yahoo: {
    appPasswordRequired: true,
    dailyLimit: 500,
    helpUrl: "https://help.yahoo.com/kb/SLN15241.html",
    id: "yahoo",
    method: "smtp",
    name: "Yahoo Mail",
    oauth: null,
    perMinuteLimit: null,
    provider: "smtp",
    smtpDefaults: { host: "smtp.mail.yahoo.com", port: 465, security: "tls" },
    smtpHosts: ["smtp.mail.yahoo.com"],
    usernameIsAddress: true,
  },
  icloud: {
    appPasswordRequired: true,
    // https://support.apple.com/en-us/102198
    dailyLimit: 1000,
    helpUrl: "https://support.apple.com/en-us/102654",
    id: "icloud",
    method: "smtp",
    name: "iCloud Mail",
    oauth: null,
    perMinuteLimit: null,
    provider: "smtp",
    smtpDefaults: { host: "smtp.mail.me.com", port: 587, security: "starttls" },
    smtpHosts: ["smtp.mail.me.com"],
    usernameIsAddress: true,
  },
  smtp: {
    appPasswordRequired: false,
    dailyLimit: null,
    helpUrl: null,
    id: "smtp",
    method: "smtp",
    name: "Other (SMTP)",
    oauth: null,
    perMinuteLimit: null,
    provider: "smtp",
    smtpDefaults: null,
    smtpHosts: [],
    usernameIsAddress: false,
  },
  resend: {
    appPasswordRequired: false,
    // Resend enforces its own quotas and says so when one is used up.
    dailyLimit: null,
    helpUrl: "https://resend.com/docs/dashboard/api-keys/introduction",
    id: "resend",
    method: "api",
    name: "Resend",
    oauth: null,
    perMinuteLimit: null,
    provider: "resend",
    smtpDefaults: null,
    smtpHosts: [],
    usernameIsAddress: false,
  },
};

export type ProviderOption = {
  appPasswordRequired: boolean;
  available: boolean;
  helpUrl: string | null;
  id: ProviderPresetId;
  method: "oauth" | "smtp" | "api";
  name: string;
  smtpDefaults: ProviderPreset["smtpDefaults"];
  unavailableReason: string | null;
};

export function isProviderPresetId(value: unknown): value is ProviderPresetId {
  return (
    typeof value === "string" &&
    (PROVIDER_PRESET_IDS as readonly string[]).includes(value)
  );
}

export function getPreset(id: ProviderPresetId): ProviderPreset {
  return PROVIDER_PRESETS[id];
}

export type OAuthClientConfig = {
  clientId: string;
  clientSecret: string;
  /** Microsoft only: the tenant to sign in against. */
  tenant: string;
};

const OAUTH_ENV = {
  google: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  microsoft: ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"],
} as const;

/** The OAuth app's credentials, or null when the administrator has set none. */
export function readOAuthClient(
  provider: OAuthProviderName,
  env: EnvSource = process.env,
): OAuthClientConfig | null {
  const [idName, secretName] = OAUTH_ENV[provider];
  const clientId = readEnv(env, idName);
  const clientSecret = readEnv(env, secretName);

  if (!clientId || !clientSecret) {
    return null;
  }

  return {
    clientId,
    clientSecret,
    tenant:
      provider === "microsoft"
        ? (readEnv(env, "MICROSOFT_TENANT_ID") ?? "common")
        : "",
  };
}

export function unavailableReasonFor(
  preset: ProviderPreset,
  env: EnvSource = process.env,
): string | null {
  if (!preset.oauth || readOAuthClient(preset.oauth, env)) {
    return null;
  }

  const [idName, secretName] = OAUTH_ENV[preset.oauth];

  return `Awaiting administrator configuration: set ${idName} and ${secretName}`;
}

export function listProviderOptions(
  env: EnvSource = process.env,
): ProviderOption[] {
  return PROVIDER_PRESET_IDS.map((id) => {
    const preset = PROVIDER_PRESETS[id];
    const unavailableReason = unavailableReasonFor(preset, env);

    return {
      appPasswordRequired: preset.appPasswordRequired,
      available: unavailableReason === null,
      helpUrl: preset.helpUrl,
      id,
      method: preset.method,
      name: preset.name,
      smtpDefaults: preset.smtpDefaults,
      unavailableReason,
    };
  });
}

/** What a provider calls the place its mailbox is reconnected. */
export function reconnectRecovery(preset: ProviderPreset): string {
  return `Reconnect the ${preset.name} account in Settings > Email & Integrations.`;
}
