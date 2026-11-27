"use client";

import { EyeIcon, EyeOffIcon, MailIcon, RefreshCwIcon } from "lucide-react";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";

import { ShellButton } from "@/components/shared/form-shell";
import { SettingsCard } from "@/components/settings/settings-frame";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/cn";

// Settings > Email & Integrations. Everything here goes through
// /api/email/*. Google and Microsoft connect through their own consent
// pages (send permission only); every other provider through a verified
// SMTP sign-in. Nothing here ever shows a stored password, key or token.

type ProviderId =
  | "gmail"
  | "google_workspace"
  | "microsoft365"
  | "outlook"
  | "zoho"
  | "yahoo"
  | "icloud"
  | "smtp"
  | "resend";

type ProviderOption = {
  appPasswordRequired: boolean;
  available: boolean;
  helpUrl: string | null;
  id: ProviderId;
  method: "oauth" | "smtp" | "api";
  name: string;
  smtpDefaults: {
    host: string;
    port: number;
    security: "tls" | "starttls";
  } | null;
  unavailableReason: string | null;
};

type AccountView = {
  createdAt: number;
  displayName: string | null;
  emailAddress: string;
  id: string;
  isDefault: boolean;
  lastError: string | null;
  lastErrorAt: number | null;
  lastSuccessAt: number | null;
  ownedByMe: boolean;
  presetId: ProviderId;
  provider: "gmail" | "microsoft" | "smtp" | "resend";
  replyTo: string | null;
  scope: "organization" | "personal";
  sharedWith: "nobody" | "everyone" | "teams";
  smtp: {
    host: string;
    port: number;
    security: string;
    username: string;
  } | null;
  status: "connected" | "needs_reconnect" | "error";
  teamIds: string[];
};

type AccountsResponse = {
  accounts: AccountView[];
  canManageOrganization: boolean;
  platformSender: { accountId: string | null; description: string };
  preferredAccountId: string | null;
};

type DeliveryView = {
  accountEmail: string | null;
  attempts: number;
  createdAt: number;
  id: string;
  lastError: string | null;
  nextAttemptAt: number | null;
  provider: string | null;
  recovery: string | null;
  retryable: boolean;
  sentAt: number | null;
  status:
    "sending" | "sent" | "failed" | "retrying" | "deferred" | "superseded";
  subject: string;
  template: string;
  toAddress: string;
};

type TemplateView = {
  defaultIntro: string;
  defaultSubject: string;
  intro: string;
  isCustomized: boolean;
  kind: string;
  placeholders: readonly string[];
  subject: string;
};

type ApiError = {
  code?: string;
  error?: string;
  fieldErrors?: Record<string, string> | null;
};

const PROVIDER_BLURBS: Record<ProviderId, string> = {
  gmail: "Personal Gmail address",
  google_workspace: "Company address on Google",
  icloud: "iCloud, me.com or mac.com",
  microsoft365: "Work or school Microsoft account",
  outlook: "Outlook.com, Hotmail or Live",
  resend: "Resend API key and verified domain",
  smtp: "Any mail server that supports SMTP",
  yahoo: "Yahoo Mail address",
  zoho: "Zoho Mail address",
};

const PRIMARY_PROVIDERS: ProviderId[] = [
  "gmail",
  "google_workspace",
  "microsoft365",
  "outlook",
  "zoho",
  "yahoo",
  "icloud",
];

const OAUTH_ERRORS: Record<string, string> = {
  access_denied: "Access was not granted, so nothing was connected.",
  admin_consent_required:
    "Your Microsoft 365 administrator has to approve PACTORA before mailboxes can be connected.",
  different_mailbox:
    "That mailbox is already connected as a different account.",
  expired_state: "The sign-in took too long. Start again.",
  failed: "The mailbox could not be connected. Try again.",
  invalid_state: "The sign-in did not come back complete. Start again.",
  missing_scope:
    "Permission to send was not granted. Connect again and allow sending.",
  signed_out:
    "You were signed out during the connection. Sign in and try again.",
  unverified_email: "The provider did not confirm this mailbox's address.",
};

const TEMPLATE_LABELS: Record<string, string> = {
  automatic_reminder: "Automatic reminder",
  completion_notification: "Agreement completed",
  manual_nudge: "Reminder you send",
  signing_invitation: "Signing invitation",
  workspace_invitation: "Workspace invitation",
};

const STATUS_PILLS: Record<
  DeliveryView["status"],
  { className: string; label: string }
> = {
  deferred: { className: "pill-warning", label: "Waiting for mailbox" },
  failed: { className: "pill-danger", label: "Failed" },
  retrying: { className: "pill-warning", label: "Retrying" },
  sending: { className: "pill-neutral", label: "Sending" },
  sent: { className: "pill-success", label: "Sent" },
  superseded: { className: "pill-neutral", label: "Replaced" },
};

function formatTime(seconds: number | null): string {
  if (!seconds) {
    return "Never";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(seconds * 1000));
}

async function call<T>(
  path: string,
  init?: RequestInit,
): Promise<{ data: (T & ApiError) | null; ok: boolean }> {
  try {
    const response = await fetch(path, {
      ...init,
      headers: init?.body
        ? { "content-type": "application/json", ...init.headers }
        : init?.headers,
    });
    const data = (await response.json().catch(() => null)) as
      (T & ApiError) | null;

    return { data, ok: response.ok };
  } catch {
    return {
      data: {
        error: "PACTORA could not be reached. Check your connection.",
      } as T & ApiError,
      ok: false,
    };
  }
}

type Notice = { text: string; tone: "danger" | "success" } | null;

async function fetchEmailSettings(): Promise<
  | { accounts: AccountsResponse; providers: ProviderOption[] }
  | { error: string }
> {
  const [providerResult, accountResult] = await Promise.all([
    call<{ providers: ProviderOption[] }>("/api/email/providers"),
    call<AccountsResponse>("/api/email/accounts"),
  ]);

  if (
    !providerResult.ok ||
    !accountResult.ok ||
    !providerResult.data ||
    !accountResult.data
  ) {
    return {
      error:
        accountResult.data?.error ??
        providerResult.data?.error ??
        "Email settings could not be loaded.",
    };
  }

  return {
    accounts: accountResult.data,
    providers: providerResult.data.providers,
  };
}

export function EmailIntegrationsPanel({
  currentUser,
  initialOutcome = {},
  isAdmin,
}: {
  currentUser: { email: string; name: string };
  /** ?connected= or ?error= from the OAuth callback's redirect. */
  initialOutcome?: { connected?: string; error?: string };
  isAdmin: boolean;
}) {
  const [providers, setProviders] = useState<ProviderOption[] | null>(null);
  const [state, setState] = useState<AccountsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(() =>
    initialOutcome.connected
      ? {
          text: "Mailbox connected. Send a test email to check it.",
          tone: "success",
        }
      : initialOutcome.error
        ? {
            text: OAUTH_ERRORS[initialOutcome.error] ?? OAUTH_ERRORS.failed!,
            tone: "danger",
          }
        : null,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<ProviderOption | null>(null);
  const [editing, setEditing] = useState<AccountView | null>(null);
  const [disconnecting, setDisconnecting] = useState<AccountView | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);

  const applyLoaded = useCallback(
    (loaded: Awaited<ReturnType<typeof fetchEmailSettings>>) => {
      if ("error" in loaded) {
        setLoadError(loaded.error);
        return;
      }

      setProviders(loaded.providers);
      setState(loaded.accounts);
      setLoadError(null);
    },
    [],
  );

  const reload = useCallback(async () => {
    applyLoaded(await fetchEmailSettings());
  }, [applyLoaded]);

  useEffect(() => {
    let cancelled = false;

    void fetchEmailSettings().then((loaded) => {
      if (!cancelled) {
        applyLoaded(loaded);
      }
    });

    if (initialOutcome.connected || initialOutcome.error) {
      // The provider sent the browser back here with an outcome code; it
      // is shown once and taken out of the address bar.
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.hash,
      );
    }

    return () => {
      cancelled = true;
    };
  }, [applyLoaded, initialOutcome]);

  const providerById = useMemo(
    () => new Map((providers ?? []).map((provider) => [provider.id, provider])),
    [providers],
  );

  async function startOAuth(
    provider: ProviderOption,
    scope: "personal" | "organization",
    reconnectAccountId?: string,
  ) {
    setBusy(`oauth-${provider.id}`);

    const { data, ok } = await call<{
      adminConsentUrl?: string;
      authorizationUrl?: string;
    }>("/api/email/oauth/start", {
      body: JSON.stringify({
        presetId: provider.id,
        reconnectAccountId,
        scope,
      }),
      method: "POST",
    });

    if (ok && data?.authorizationUrl) {
      window.location.assign(data.authorizationUrl);
      return;
    }

    setBusy(null);
    setNotice({
      text: data?.error ?? "The connection could not be started.",
      tone: "danger",
    });
  }

  async function sendTest(account: AccountView) {
    setBusy(`test-${account.id}`);

    const { data, ok } = await call<{ sent?: boolean; to?: string }>(
      `/api/email/accounts/${account.id}/test`,
      { method: "POST" },
    );

    setBusy(null);
    setNotice(
      ok && data?.sent
        ? {
            text: `Test email sent to ${data.to ?? currentUser.email} through ${account.emailAddress}.`,
            tone: "success",
          }
        : {
            text: data?.error ?? "The test email could not be sent.",
            tone: "danger",
          },
    );
    setHistoryVersion((version) => version + 1);
    await reload();
  }

  async function choosePreference(accountId: string | null) {
    setBusy("preference");

    const { data, ok } = await call("/api/email/preference", {
      body: JSON.stringify({ accountId }),
      method: "PUT",
    });

    setBusy(null);
    setNotice(
      ok
        ? { text: "Saved.", tone: "success" }
        : { text: data?.error ?? "Not saved.", tone: "danger" },
    );
    await reload();
  }

  async function disconnect(account: AccountView) {
    setBusy(`disconnect-${account.id}`);

    const { data, ok } = await call<{ note?: string | null }>(
      `/api/email/accounts/${account.id}`,
      {
        method: "DELETE",
      },
    );

    setBusy(null);
    setDisconnecting(null);
    setNotice(
      ok
        ? {
            text: data?.note
              ? `${account.emailAddress} disconnected. ${data.note}`
              : `${account.emailAddress} disconnected.`,
            tone: "success",
          }
        : {
            text: data?.error ?? "The mailbox could not be disconnected.",
            tone: "danger",
          },
    );
    await reload();
  }

  if (loadError) {
    return (
      <div className="notice notice-danger" role="alert">
        {loadError}
      </div>
    );
  }

  if (!state || !providers) {
    return (
      <p className="px-1 text-sm text-(--secondary)">Loading email settings…</p>
    );
  }

  const usable = state.accounts.filter(
    (account) =>
      account.ownedByMe ||
      account.sharedWith !== "nobody" ||
      account.scope === "personal",
  );
  const sendable = usable.filter(
    (account) =>
      account.ownedByMe ||
      (account.scope === "organization" && account.sharedWith !== "nobody"),
  );
  const defaultAccount =
    state.accounts.find((account) => account.isDefault) ?? null;
  const effective =
    sendable.find((account) => account.id === state.preferredAccountId) ??
    (defaultAccount && defaultAccount.sharedWith !== "nobody"
      ? defaultAccount
      : null);

  return (
    <div className="space-y-5">
      {notice ? (
        <div
          className={cn(
            "notice",
            notice.tone === "success" ? "notice-success" : "notice-danger",
          )}
          role={notice.tone === "danger" ? "alert" : "status"}
        >
          {notice.text}
        </div>
      ) : null}

      <SettingsCard
        description="The mailbox your signing invitations, reminders and completed agreements are sent from."
        id="send-from"
        title="Send my documents from"
      >
        {sendable.length === 0 ? (
          <div className="well space-y-2 p-4 text-sm leading-6 text-(--secondary)">
            <p className="font-semibold text-(--fg)">
              No mailbox connected yet.
            </p>
            <p>
              You can still prepare and send documents: when email is
              unavailable, copy each signer&apos;s secure link from the envelope
              page and share it yourself. Connect a mailbox below to have
              PACTORA send for you.
            </p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <label className="grid gap-1.5">
              <span className="text-[0.8125rem] font-semibold text-(--secondary)">
                Mailbox
              </span>
              <select
                className="field-input"
                disabled={busy !== null}
                onChange={(event) =>
                  void choosePreference(event.target.value || null)
                }
                value={state.preferredAccountId ?? ""}
              >
                <option value="">
                  {defaultAccount && defaultAccount.sharedWith !== "nobody"
                    ? `Workspace default (${defaultAccount.emailAddress})`
                    : "Workspace default (none set)"}
                </option>
                {sendable.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.displayName
                      ? `${account.displayName} <${account.emailAddress}>`
                      : account.emailAddress}
                    {account.scope === "organization" ? " · organisation" : ""}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-sm text-(--secondary) sm:pb-3">
              {effective ? (
                <>
                  Sending as{" "}
                  <span className="font-semibold text-(--fg)">
                    {effective.emailAddress}
                  </span>
                </>
              ) : (
                "Nothing will be sent until a mailbox is chosen."
              )}
            </p>
          </div>
        )}
      </SettingsCard>

      <SettingsCard
        description="Mailboxes PACTORA can send through. Personal mailboxes are visible only to you."
        id="accounts"
        title="Connected email accounts"
      >
        {state.accounts.length === 0 ? (
          <p className="text-sm text-(--secondary)">No mailboxes connected.</p>
        ) : (
          <ul aria-label="Connected email accounts" className="space-y-3">
            {state.accounts.map((account) => {
              const provider = providerById.get(account.presetId);
              const canManage =
                account.ownedByMe ||
                (account.scope === "organization" &&
                  state.canManageOrganization);
              const canTest =
                account.ownedByMe ||
                (account.scope === "organization" &&
                  (state.canManageOrganization ||
                    account.sharedWith !== "nobody"));

              return (
                <li className="well space-y-3 p-4" key={account.id}>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <MailIcon
                          aria-hidden="true"
                          className="size-4 text-(--tertiary)"
                        />
                        <p className="truncate text-[0.9375rem] font-bold text-(--fg)">
                          {account.emailAddress}
                        </p>
                        <span
                          className={cn(
                            "pill",
                            account.status === "connected"
                              ? "pill-success"
                              : account.status === "needs_reconnect"
                                ? "pill-warning"
                                : "pill-danger",
                          )}
                        >
                          {account.status === "connected"
                            ? "Connected"
                            : account.status === "needs_reconnect"
                              ? "Needs reconnecting"
                              : "Error"}
                        </span>
                        {account.isDefault ? (
                          <span className="pill pill-accent">
                            Workspace default
                          </span>
                        ) : null}
                      </div>
                      <p className="text-sm text-(--secondary)">
                        {provider?.name ?? account.provider}
                        {account.displayName
                          ? ` · sends as “${account.displayName}”`
                          : ""}
                        {account.scope === "organization"
                          ? account.sharedWith === "everyone"
                            ? " · shared with everyone"
                            : account.sharedWith === "teams"
                              ? " · shared with selected teams"
                              : " · sign-in and invitation emails only"
                          : " · personal"}
                      </p>
                      <p className="text-xs text-(--tertiary)">
                        Last successful delivery:{" "}
                        {formatTime(account.lastSuccessAt)}
                        {account.replyTo
                          ? ` · replies go to ${account.replyTo}`
                          : ""}
                      </p>
                      {account.lastError && account.status !== "connected" ? (
                        <p className="text-xs font-semibold text-(--danger)">
                          {account.lastError}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {canTest ? (
                        <button
                          className="btn-quiet"
                          disabled={busy !== null}
                          onClick={() => void sendTest(account)}
                          type="button"
                        >
                          {busy === `test-${account.id}`
                            ? "Sending…"
                            : "Send test email"}
                        </button>
                      ) : null}
                      {canManage && provider?.method === "oauth" ? (
                        <button
                          className="btn-quiet"
                          disabled={busy !== null || !provider.available}
                          onClick={() =>
                            void startOAuth(provider, account.scope, account.id)
                          }
                          type="button"
                        >
                          Reconnect
                        </button>
                      ) : null}
                      {canManage ? (
                        <button
                          className="btn-quiet"
                          disabled={busy !== null}
                          onClick={() => setEditing(account)}
                          type="button"
                        >
                          Edit
                        </button>
                      ) : null}
                      {canManage ? (
                        <button
                          className="btn-quiet btn-quiet-danger"
                          disabled={busy !== null}
                          onClick={() => setDisconnecting(account)}
                          type="button"
                        >
                          Disconnect
                        </button>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {isAdmin ? (
          <p className="text-xs leading-5 text-(--tertiary)">
            Sign-in, password and invitation emails:{" "}
            {state.platformSender.description}
          </p>
        ) : null}
      </SettingsCard>

      <SettingsCard
        description="Google and Microsoft open their own sign-in page and grant permission to send only. PACTORA never sees your password and cannot read your mailbox."
        id="providers"
        title="Connect an email account"
      >
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {PRIMARY_PROVIDERS.map((id) => providerById.get(id))
            .filter(Boolean)
            .map((provider) => (
              <ProviderTile
                busy={busy === `oauth-${provider!.id}`}
                disabled={busy !== null}
                key={provider!.id}
                onChoose={() => setConnecting(provider!)}
                provider={provider!}
              />
            ))}
        </ul>
        <details className="group rounded-2xl border border-(--border) p-4">
          <summary className="cursor-pointer text-sm font-bold text-(--fg)">
            Advanced: custom mail server or Resend
          </summary>
          <ul className="mt-4 grid gap-3 sm:grid-cols-2">
            {(["smtp", "resend"] as const)
              .map((id) => providerById.get(id))
              .filter(Boolean)
              .map((provider) => (
                <ProviderTile
                  busy={false}
                  disabled={busy !== null}
                  key={provider!.id}
                  onChoose={() => setConnecting(provider!)}
                  provider={provider!}
                />
              ))}
          </ul>
          {isAdmin ? (
            <p className="mt-3 text-xs leading-5 text-(--tertiary)">
              Sending domains and DNS records for the server&apos;s own Resend
              account are under{" "}
              <Link className="link" href="/settings/advanced#email-setup">
                Advanced Administration
              </Link>
              .
            </p>
          ) : null}
        </details>
      </SettingsCard>

      <DeliveryHistory key={historyVersion} onChanged={reload} />

      <TemplatesCard />

      {connecting ? (
        <ConnectDialog
          canManageOrganization={state.canManageOrganization}
          onClose={() => setConnecting(null)}
          onConnected={async (message) => {
            setConnecting(null);
            setNotice({ text: message, tone: "success" });
            await reload();
          }}
          onOAuth={(scope) => void startOAuth(connecting, scope)}
          provider={connecting}
        />
      ) : null}

      {editing ? (
        <EditAccountDialog
          account={editing}
          canManageOrganization={state.canManageOrganization}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            setNotice({ text: "Saved.", tone: "success" });
            await reload();
          }}
        />
      ) : null}

      <Dialog
        open={disconnecting !== null}
        onOpenChange={(open) => (!open ? setDisconnecting(null) : null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect {disconnecting?.emailAddress}?</DialogTitle>
            <DialogDescription>
              PACTORA stops sending through this mailbox and deletes its saved
              access. Messages waiting for it will not be sent.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <ShellButton
              onClick={() => setDisconnecting(null)}
              variant="secondary"
            >
              Cancel
            </ShellButton>
            <ShellButton
              loading={busy === `disconnect-${disconnecting?.id ?? ""}`}
              onClick={() => disconnecting && void disconnect(disconnecting)}
              variant="danger"
            >
              Disconnect
            </ShellButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ProviderTile({
  busy,
  disabled,
  onChoose,
  provider,
}: {
  busy: boolean;
  disabled: boolean;
  onChoose: () => void;
  provider: ProviderOption;
}) {
  return (
    <li>
      <button
        aria-describedby={
          provider.unavailableReason ? `${provider.id}-unavailable` : undefined
        }
        className="flex h-full w-full flex-col items-start gap-1 rounded-2xl border border-(--border) bg-(--paper) p-4 text-left transition hover:border-(--accent) focus-visible:ring-2 focus-visible:ring-(--accent) focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
        disabled={disabled}
        onClick={onChoose}
        type="button"
      >
        <span className="text-[0.9375rem] font-bold text-(--fg)">
          {busy ? "Opening…" : provider.name}
        </span>
        <span className="text-sm text-(--secondary)">
          {PROVIDER_BLURBS[provider.id]}
        </span>
        {provider.unavailableReason ? (
          <span
            className="text-xs font-semibold text-(--warning,#a15c07)"
            id={`${provider.id}-unavailable`}
          >
            Not available yet
          </span>
        ) : provider.method === "oauth" ? (
          <span className="text-xs text-(--tertiary)">Secure sign-in</span>
        ) : provider.appPasswordRequired ? (
          <span className="text-xs text-(--tertiary)">
            Uses an app password
          </span>
        ) : null}
      </button>
    </li>
  );
}

function ScopeChoice({
  onChange,
  value,
}: {
  onChange: (value: "personal" | "organization") => void;
  value: "personal" | "organization";
}) {
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-[0.8125rem] font-semibold text-(--secondary)">
        Who uses this mailbox
      </legend>
      {(
        [
          ["personal", "Just me", "Your documents go out from this mailbox."],
          [
            "organization",
            "The organisation",
            "Administrators manage it and choose who may send from it.",
          ],
        ] as const
      ).map(([option, label, description]) => (
        <label
          className="flex cursor-pointer gap-3 rounded-xl border border-(--border) p-3"
          key={option}
        >
          <input
            checked={value === option}
            name="scope"
            onChange={() => onChange(option)}
            type="radio"
          />
          <span>
            <span className="block text-sm font-semibold text-(--fg)">
              {label}
            </span>
            <span className="block text-xs text-(--secondary)">
              {description}
            </span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function TextField({
  autoComplete,
  error,
  helper,
  label,
  name,
  onChange,
  type = "text",
  value,
}: {
  autoComplete?: string;
  error?: string;
  helper?: string;
  label: string;
  name: string;
  onChange: (value: string) => void;
  type?: string;
  value: string;
}) {
  return (
    <label className="grid gap-1.5" htmlFor={`connect-${name}`}>
      <span className="text-[0.8125rem] font-semibold text-(--secondary)">
        {label}
      </span>
      <input
        aria-describedby={error || helper ? `connect-${name}-note` : undefined}
        aria-invalid={error ? true : undefined}
        autoComplete={autoComplete}
        className="field-input"
        id={`connect-${name}`}
        name={name}
        onChange={(event) => onChange(event.target.value)}
        type={type}
        value={value}
      />
      {error ? (
        <span
          className="text-xs font-semibold text-(--danger)"
          id={`connect-${name}-note`}
        >
          {error}
        </span>
      ) : helper ? (
        <span className="text-xs text-(--tertiary)" id={`connect-${name}-note`}>
          {helper}
        </span>
      ) : null}
    </label>
  );
}

function SecretField({
  error,
  helper,
  label,
  name,
  onChange,
  value,
}: {
  error?: string;
  helper?: string;
  label: string;
  name: string;
  onChange: (value: string) => void;
  value: string;
}) {
  const [visible, setVisible] = useState(false);

  return (
    <label className="grid gap-1.5" htmlFor={`connect-${name}`}>
      <span className="text-[0.8125rem] font-semibold text-(--secondary)">
        {label}
      </span>
      <span className="relative">
        <input
          aria-describedby={
            error || helper ? `connect-${name}-note` : undefined
          }
          aria-invalid={error ? true : undefined}
          autoComplete="off"
          className="field-input pr-12"
          data-1p-ignore="true"
          data-lpignore="true"
          id={`connect-${name}`}
          name={name}
          onChange={(event) => onChange(event.target.value)}
          type={visible ? "text" : "password"}
          value={value}
        />
        <button
          aria-label={visible ? "Hide" : "Show"}
          className="absolute top-1/2 right-2 -translate-y-1/2 rounded-lg p-2 text-(--tertiary) hover:text-(--fg)"
          onClick={() => setVisible((current) => !current)}
          type="button"
        >
          {visible ? (
            <EyeOffIcon className="size-4" />
          ) : (
            <EyeIcon className="size-4" />
          )}
        </button>
      </span>
      {error ? (
        <span
          className="text-xs font-semibold text-(--danger)"
          id={`connect-${name}-note`}
        >
          {error}
        </span>
      ) : helper ? (
        <span className="text-xs text-(--tertiary)" id={`connect-${name}-note`}>
          {helper}
        </span>
      ) : null}
    </label>
  );
}

function ConnectDialog({
  canManageOrganization,
  onClose,
  onConnected,
  onOAuth,
  provider,
}: {
  canManageOrganization: boolean;
  onClose: () => void;
  onConnected: (message: string) => Promise<void>;
  onOAuth: (scope: "personal" | "organization") => void;
  provider: ProviderOption;
}) {
  const [scope, setScope] = useState<"personal" | "organization">("personal");
  const [values, setValues] = useState({
    apiKey: "",
    displayName: "",
    emailAddress: "",
    host: provider.smtpDefaults?.host ?? "",
    password: "",
    port: String(provider.smtpDefaults?.port ?? 587),
    security: provider.smtpDefaults?.security ?? "starttls",
    username: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const set = (field: keyof typeof values) => (value: string) =>
    setValues((current) => ({ ...current, [field]: value }));
  const custom = provider.id === "smtp";

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setErrors({});

    const { data, ok } = await call<{ account?: AccountView }>(
      "/api/email/accounts",
      {
        body: JSON.stringify({
          apiKey: provider.id === "resend" ? values.apiKey : undefined,
          displayName: values.displayName || null,
          emailAddress: values.emailAddress,
          host: custom ? values.host : undefined,
          password: provider.id === "resend" ? undefined : values.password,
          port: custom ? Number(values.port) : undefined,
          presetId: provider.id,
          scope,
          security: custom ? values.security : undefined,
          username: custom && values.username ? values.username : undefined,
        }),
        method: "POST",
      },
    );

    setPending(false);

    if (ok && data?.account) {
      await onConnected(
        `${data.account.emailAddress} is connected and verified.`,
      );
      return;
    }

    setErrors(data?.fieldErrors ?? {});
    setError(data?.error ?? "The mailbox could not be connected.");
  }

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : null)}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Connect {provider.name}</DialogTitle>
          <DialogDescription>
            {provider.method === "oauth"
              ? `You'll sign in on ${provider.name.startsWith("Google") || provider.id === "gmail" ? "Google's" : "Microsoft's"} own page and allow PACTORA to send email for you. It cannot read your mail.`
              : provider.appPasswordRequired
                ? `${provider.name} needs an app password, created in your ${provider.name} account security settings. Your normal password will not work.`
                : provider.id === "resend"
                  ? "Enter a Resend API key and an address on a domain verified in Resend."
                  : "Enter your mail server's details. PACTORA signs in to check them before saving."}
          </DialogDescription>
        </DialogHeader>

        {provider.unavailableReason ? (
          <div className="notice notice-warning" role="status">
            <p className="font-semibold">Not available yet.</p>
            <p className="text-sm">
              {provider.unavailableReason}. An administrator adds these to the
              server configuration, and registers{" "}
              <code className="text-xs">/api/email/oauth/callback</code> as the
              redirect address.
            </p>
          </div>
        ) : provider.method === "oauth" ? (
          <div className="space-y-4">
            {canManageOrganization ? (
              <ScopeChoice onChange={setScope} value={scope} />
            ) : null}
            <DialogFooter>
              <ShellButton onClick={onClose} variant="secondary">
                Cancel
              </ShellButton>
              <ShellButton onClick={() => onOAuth(scope)}>
                Continue with{" "}
                {provider.id === "gmail" || provider.id === "google_workspace"
                  ? "Google"
                  : "Microsoft"}
              </ShellButton>
            </DialogFooter>
          </div>
        ) : (
          <form className="space-y-4" noValidate onSubmit={submit}>
            {error ? (
              <div className="notice notice-danger" role="alert">
                {error}
              </div>
            ) : null}
            <TextField
              autoComplete="email"
              error={errors.emailAddress}
              label="Email address"
              name="emailAddress"
              onChange={set("emailAddress")}
              type="email"
              value={values.emailAddress}
            />
            <TextField
              error={errors.displayName}
              helper="Shown to recipients as the sender. Optional."
              label="Display name"
              name="displayName"
              onChange={set("displayName")}
              value={values.displayName}
            />
            {provider.id === "resend" ? (
              <SecretField
                error={errors.apiKey}
                label="API key"
                name="apiKey"
                onChange={set("apiKey")}
                value={values.apiKey}
              />
            ) : (
              <SecretField
                error={errors.password}
                helper={
                  provider.appPasswordRequired && provider.helpUrl
                    ? "Create one in your account's security settings."
                    : undefined
                }
                label={
                  provider.appPasswordRequired ? "App password" : "Password"
                }
                name="password"
                onChange={set("password")}
                value={values.password}
              />
            )}
            {provider.appPasswordRequired && provider.helpUrl ? (
              <a
                className="link text-sm"
                href={provider.helpUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                How to create an app password for {provider.name}
              </a>
            ) : null}
            {custom ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  error={errors.host}
                  label="SMTP server"
                  name="host"
                  onChange={set("host")}
                  value={values.host}
                />
                <label className="grid gap-1.5">
                  <span className="text-[0.8125rem] font-semibold text-(--secondary)">
                    Port and security
                  </span>
                  <select
                    className="field-input"
                    onChange={(event) => {
                      const port = event.target.value;

                      setValues((current) => ({
                        ...current,
                        port,
                        security: port === "465" ? "tls" : "starttls",
                      }));
                    }}
                    value={values.port}
                  >
                    <option value="587">587 · STARTTLS</option>
                    <option value="465">465 · TLS</option>
                    <option value="2525">2525 · STARTTLS</option>
                    <option value="25">25 · STARTTLS</option>
                  </select>
                  {errors.port || errors.security ? (
                    <span className="text-xs font-semibold text-(--danger)">
                      {errors.port ?? errors.security}
                    </span>
                  ) : null}
                </label>
                <TextField
                  helper="Leave empty to use the email address."
                  label="User name"
                  name="username"
                  onChange={set("username")}
                  value={values.username}
                />
              </div>
            ) : provider.smtpDefaults ? (
              <p className="text-xs text-(--tertiary)">
                Server: {provider.smtpDefaults.host}, port{" "}
                {provider.smtpDefaults.port} (
                {provider.smtpDefaults.security === "tls" ? "TLS" : "STARTTLS"}
                ).
              </p>
            ) : null}
            {canManageOrganization ? (
              <ScopeChoice onChange={setScope} value={scope} />
            ) : null}
            <DialogFooter>
              <ShellButton onClick={onClose} variant="secondary">
                Cancel
              </ShellButton>
              <ShellButton loading={pending} type="submit">
                {pending ? "Checking…" : "Connect"}
              </ShellButton>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function EditAccountDialog({
  account,
  canManageOrganization,
  onClose,
  onSaved,
}: {
  account: AccountView;
  canManageOrganization: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [values, setValues] = useState({
    displayName: account.displayName ?? "",
    isDefault: account.isDefault,
    password: "",
    replyTo: account.replyTo ?? "",
    sharedWith: account.sharedWith,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const organization =
    account.scope === "organization" && canManageOrganization;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const { data, ok } = await call(`/api/email/accounts/${account.id}`, {
      body: JSON.stringify({
        displayName: values.displayName || null,
        replyTo: values.replyTo || null,
        ...(values.password ? { password: values.password } : {}),
        ...(organization
          ? {
              isDefault: values.isDefault,
              // Sharing with chosen teams is kept as it is unless changed.
              ...(values.sharedWith !== account.sharedWith
                ? { sharedWith: values.sharedWith }
                : {}),
            }
          : {}),
      }),
      method: "PATCH",
    });

    setPending(false);

    if (ok) {
      await onSaved();
      return;
    }

    setErrors(data?.fieldErrors ?? {});
    setError(data?.error ?? "Not saved.");
  }

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : null)}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{account.emailAddress}</DialogTitle>
          <DialogDescription>
            How messages from this mailbox look to recipients.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" noValidate onSubmit={submit}>
          {error ? (
            <div className="notice notice-danger" role="alert">
              {error}
            </div>
          ) : null}
          <TextField
            error={errors.displayName}
            label="Display name"
            name="edit-displayName"
            onChange={(value) =>
              setValues((current) => ({ ...current, displayName: value }))
            }
            value={values.displayName}
          />
          <TextField
            error={errors.replyTo}
            helper="Where replies go. Leave empty to use this address."
            label="Reply-to address"
            name="edit-replyTo"
            onChange={(value) =>
              setValues((current) => ({ ...current, replyTo: value }))
            }
            type="email"
            value={values.replyTo}
          />
          {account.provider === "smtp" ? (
            <SecretField
              error={errors.password}
              helper="Only to replace the saved password. It is checked before it is saved."
              label="New password"
              name="edit-password"
              onChange={(value) =>
                setValues((current) => ({ ...current, password: value }))
              }
              value={values.password}
            />
          ) : null}
          {organization ? (
            <>
              <label className="grid gap-1.5">
                <span className="text-[0.8125rem] font-semibold text-(--secondary)">
                  Who may send from it
                </span>
                <select
                  className="field-input"
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      sharedWith: event.target
                        .value as AccountView["sharedWith"],
                    }))
                  }
                  value={values.sharedWith}
                >
                  <option value="everyone">Everyone in the workspace</option>
                  {account.sharedWith === "teams" ? (
                    <option value="teams">
                      The teams it is shared with now
                    </option>
                  ) : null}
                  <option value="nobody">
                    Nobody: sign-in and invitation emails only
                  </option>
                </select>
              </label>
              <label className="flex items-center gap-3 text-sm font-semibold text-(--fg)">
                <input
                  checked={values.isDefault}
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      isDefault: event.target.checked,
                    }))
                  }
                  type="checkbox"
                />
                Workspace default mailbox
              </label>
            </>
          ) : null}
          <DialogFooter>
            <ShellButton onClick={onClose} variant="secondary">
              Cancel
            </ShellButton>
            <ShellButton loading={pending} type="submit">
              Save
            </ShellButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeliveryHistory({ onChanged }: { onChanged: () => Promise<void> }) {
  const [rows, setRows] = useState<DeliveryView[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);

  const load = useCallback(
    async (cursor: string | null) => {
      const params = new URLSearchParams();

      if (cursor) params.set("cursor", cursor);
      if (query.trim()) params.set("q", query.trim());
      if (status) params.set("status", status);

      const { data, ok } = await call<{
        deliveries: DeliveryView[];
        nextCursor: string | null;
      }>(`/api/email/deliveries?${params.toString()}`);

      if (!ok || !data?.deliveries) {
        setError(data?.error ?? "The delivery history could not be loaded.");
        return;
      }

      setError(null);
      setRows((current) =>
        cursor && current ? [...current, ...data.deliveries] : data.deliveries,
      );
      setNextCursor(data.nextCursor);
    },
    [query, status],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void load(null), 250);

    return () => window.clearTimeout(timer);
  }, [load]);

  async function retry(delivery: DeliveryView) {
    setRetrying(delivery.id);

    const { data, ok } = await call<{ sent?: boolean }>(
      `/api/email/deliveries/${delivery.id}/retry`,
      { method: "POST" },
    );

    setRetrying(null);

    if (!ok) {
      setError(data?.error ?? "The delivery could not be retried.");
    }

    await load(null);
    await onChanged();
  }

  return (
    <SettingsCard
      action={
        <button
          aria-label="Refresh delivery history"
          className="btn-quiet"
          onClick={() => void load(null)}
          type="button"
        >
          <RefreshCwIcon aria-hidden="true" className="size-4" />
        </button>
      }
      description="Every message PACTORA tried to send, and what happened. Message contents are never stored."
      id="deliveries"
      title="Delivery history"
    >
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
        <label className="grid gap-1.5">
          <span className="sr-only">Search deliveries</span>
          <input
            className="field-input"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by recipient or subject"
            type="search"
            value={query}
          />
        </label>
        <label className="grid gap-1.5">
          <span className="sr-only">Status</span>
          <select
            className="field-input"
            onChange={(event) => setStatus(event.target.value)}
            value={status}
          >
            <option value="">All statuses</option>
            <option value="sent">Sent</option>
            <option value="failed">Failed</option>
            <option value="retrying">Retrying</option>
            <option value="deferred">Waiting for mailbox</option>
          </select>
        </label>
      </div>

      {error ? (
        <div className="notice notice-danger" role="alert">
          {error}
        </div>
      ) : null}

      {rows === null ? (
        <p className="text-sm text-(--secondary)">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-(--secondary)">
          {query || status
            ? "No deliveries match."
            : "Nothing has been sent yet. Messages appear here as they go out."}
        </p>
      ) : (
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead className="text-xs text-(--tertiary)">
              <tr>
                <th className="px-1 py-2 font-semibold" scope="col">
                  To
                </th>
                <th className="px-1 py-2 font-semibold" scope="col">
                  Subject
                </th>
                <th className="px-1 py-2 font-semibold" scope="col">
                  Status
                </th>
                <th className="px-1 py-2 font-semibold" scope="col">
                  When
                </th>
                <th className="px-1 py-2" scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((delivery) => (
                <tr
                  className="border-t border-(--border) align-top"
                  key={delivery.id}
                >
                  <td className="max-w-[12rem] truncate px-1 py-2.5 font-semibold text-(--fg)">
                    {delivery.toAddress}
                  </td>
                  <td className="px-1 py-2.5 text-(--secondary)">
                    <span className="line-clamp-2">{delivery.subject}</span>
                    {delivery.accountEmail ? (
                      <span className="block text-xs text-(--tertiary)">
                        via {delivery.accountEmail}
                      </span>
                    ) : null}
                    {delivery.status !== "sent" && delivery.lastError ? (
                      <span className="block text-xs text-(--danger)">
                        {delivery.lastError}
                      </span>
                    ) : null}
                    {delivery.status !== "sent" && delivery.recovery ? (
                      <span className="block text-xs text-(--tertiary)">
                        {delivery.recovery}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-1 py-2.5">
                    <span
                      className={cn(
                        "pill whitespace-nowrap",
                        STATUS_PILLS[delivery.status].className,
                      )}
                    >
                      {STATUS_PILLS[delivery.status].label}
                    </span>
                  </td>
                  <td className="px-1 py-2.5 whitespace-nowrap text-(--secondary)">
                    {formatTime(delivery.sentAt ?? delivery.createdAt)}
                  </td>
                  <td className="px-1 py-2.5 text-right">
                    {delivery.retryable ? (
                      <button
                        className="btn-quiet"
                        disabled={retrying !== null}
                        onClick={() => void retry(delivery)}
                        type="button"
                      >
                        {retrying === delivery.id ? "Retrying…" : "Retry now"}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {nextCursor ? (
        <ShellButton onClick={() => void load(nextCursor)} variant="secondary">
          Load more
        </ShellButton>
      ) : null}
    </SettingsCard>
  );
}

function TemplatesCard() {
  const [templates, setTemplates] = useState<TemplateView[] | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({ intro: "", subject: "" });
  const [notice, setNotice] = useState<Notice>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    void call<{ canEdit: boolean; templates: TemplateView[] }>(
      "/api/email/templates",
    ).then(({ data, ok }) => {
      if (ok && data?.templates) {
        setTemplates(data.templates);
        setCanEdit(data.canEdit);
      }
    });
  }, []);

  async function save(
    kind: string,
    values: { intro: string; subject: string },
  ) {
    setPending(true);

    const { data, ok } = await call<{ templates: TemplateView[] }>(
      "/api/email/templates",
      {
        body: JSON.stringify({ kind, ...values }),
        method: "PUT",
      },
    );

    setPending(false);

    if (ok && data?.templates) {
      setTemplates(data.templates);
      setEditing(null);
      setNotice({ text: "Template saved.", tone: "success" });
    } else {
      setNotice({ text: data?.error ?? "Not saved.", tone: "danger" });
    }
  }

  if (!templates) {
    return null;
  }

  return (
    <SettingsCard
      description="The subject and opening paragraph of the main messages. Signing links, deadlines and legal notices are always added by PACTORA."
      id="templates"
      title="Email wording"
    >
      {notice ? (
        <div
          className={cn(
            "notice",
            notice.tone === "success" ? "notice-success" : "notice-danger",
          )}
          role="status"
        >
          {notice.text}
        </div>
      ) : null}
      <ul className="space-y-3">
        {templates.map((template) => (
          <li className="well space-y-3 p-4" key={template.kind}>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 space-y-1">
                <p className="text-[0.9375rem] font-bold text-(--fg)">
                  {TEMPLATE_LABELS[template.kind] ?? template.kind}
                  {template.isCustomized ? (
                    <span className="pill pill-accent ml-2">Customised</span>
                  ) : null}
                </p>
                {editing !== template.kind ? (
                  <>
                    <p className="text-sm text-(--secondary)">
                      {template.subject}
                    </p>
                    <p className="text-xs text-(--tertiary)">
                      {template.intro}
                    </p>
                  </>
                ) : null}
              </div>
              {canEdit && editing !== template.kind ? (
                <div className="flex gap-2">
                  <button
                    className="btn-quiet"
                    onClick={() => {
                      setEditing(template.kind);
                      setDraft({
                        intro: template.intro,
                        subject: template.subject,
                      });
                    }}
                    type="button"
                  >
                    Edit
                  </button>
                  {template.isCustomized ? (
                    <button
                      className="btn-quiet"
                      disabled={pending}
                      onClick={() =>
                        void save(template.kind, { intro: "", subject: "" })
                      }
                      type="button"
                    >
                      Reset
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
            {editing === template.kind ? (
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void save(template.kind, draft);
                }}
              >
                <label className="grid gap-1.5">
                  <span className="text-[0.8125rem] font-semibold text-(--secondary)">
                    Subject
                  </span>
                  <input
                    className="field-input"
                    maxLength={200}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        subject: event.target.value,
                      }))
                    }
                    value={draft.subject}
                  />
                </label>
                <label className="grid gap-1.5">
                  <span className="text-[0.8125rem] font-semibold text-(--secondary)">
                    Opening paragraph
                  </span>
                  <textarea
                    className="field-input min-h-24"
                    maxLength={2000}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        intro: event.target.value,
                      }))
                    }
                    value={draft.intro}
                  />
                </label>
                <p className="text-xs text-(--tertiary)">
                  Placeholders:{" "}
                  {template.placeholders
                    .map((name) => `{{${name}}}`)
                    .join(", ")}
                </p>
                <div className="flex gap-2">
                  <ShellButton loading={pending} type="submit">
                    Save
                  </ShellButton>
                  <ShellButton
                    onClick={() => setEditing(null)}
                    variant="secondary"
                  >
                    Cancel
                  </ShellButton>
                </div>
              </form>
            ) : null}
          </li>
        ))}
      </ul>
    </SettingsCard>
  );
}
