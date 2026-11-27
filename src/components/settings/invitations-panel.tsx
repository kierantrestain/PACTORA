"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { ShellButton } from "@/components/shared/form-shell";
import { SettingsCard } from "@/components/settings/settings-frame";
import { cn } from "@/lib/cn";

// Invitations to join the workspace, in Settings > Team & Permissions.
// An invitation always gives a link to copy, so inviting works with no
// email set up; when email is set up it is also sent.

type Invitation = {
  createdAt: number;
  email: string;
  expiresAt: number;
  id: string;
  invitedByName: string | null;
  role: "user" | "admin";
  status: "pending" | "accepted" | "expired" | "revoked";
};

type CreateResponse = {
  emailError?: string | null;
  emailed?: boolean;
  error?: string;
  fieldErrors?: Record<string, string> | null;
  invitation?: Invitation;
  link?: string;
};

function formatDate(seconds: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(seconds * 1000),
  );
}

async function fetchInvitations(): Promise<Invitation[] | string> {
  const response = await fetch("/api/workspace/invitations").catch(() => null);
  const payload = (await response?.json().catch(() => null)) as {
    error?: string;
    invitations?: Invitation[];
  } | null;

  return response?.ok && payload?.invitations
    ? payload.invitations
    : (payload?.error ?? "Invitations could not be loaded.");
}

export function InvitationsPanel() {
  const [invitations, setInvitations] = useState<Invitation[] | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");
  const [pending, setPending] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{
    email: string;
    emailError: string | null;
    emailed: boolean;
    link: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  const applyLoaded = useCallback((loaded: Invitation[] | string) => {
    if (typeof loaded === "string") {
      setError(loaded);
      return;
    }

    setInvitations(loaded);
  }, []);

  const load = useCallback(async () => {
    applyLoaded(await fetchInvitations());
  }, [applyLoaded]);

  useEffect(() => {
    let cancelled = false;

    void fetchInvitations().then((loaded) => {
      if (!cancelled) {
        applyLoaded(loaded);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [applyLoaded]);

  async function invite(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setFieldError(null);
    setCopied(false);

    const response = await fetch("/api/workspace/invitations", {
      body: JSON.stringify({ email: email.trim(), role }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }).catch(() => null);
    const payload = (await response
      ?.json()
      .catch(() => null)) as CreateResponse | null;

    setPending(false);

    if (!response?.ok || !payload?.link || !payload.invitation) {
      setFieldError(payload?.fieldErrors?.email ?? null);
      setError(
        payload?.fieldErrors?.email
          ? null
          : (payload?.error ?? "The invitation could not be created."),
      );
      return;
    }

    setCreated({
      email: payload.invitation.email,
      emailError: payload.emailError ?? null,
      emailed: Boolean(payload.emailed),
      link: payload.link,
    });
    setEmail("");
    setRole("user");
    await load();
  }

  async function revoke(invitation: Invitation) {
    setPending(true);

    const response = await fetch(
      `/api/workspace/invitations/${invitation.id}`,
      { method: "DELETE" },
    ).catch(() => null);

    setPending(false);

    if (!response?.ok) {
      setError("The invitation could not be withdrawn.");
    }

    await load();
  }

  async function copy(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <SettingsCard
      description="Invite colleagues by email address. Each invitation has a private link that works for 7 days."
      id="invitations"
      title="Invitations"
    >
      <form
        className="well grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_11rem_auto] sm:items-end"
        noValidate
        onSubmit={invite}
      >
        <label className="grid gap-1.5" htmlFor="invite-email">
          <span className="text-[0.8125rem] font-semibold text-(--secondary)">
            Email address
          </span>
          <input
            aria-describedby={fieldError ? "invite-email-error" : undefined}
            aria-invalid={fieldError ? true : undefined}
            autoComplete="off"
            className="field-input"
            disabled={pending}
            id="invite-email"
            onChange={(event) => setEmail(event.target.value)}
            type="email"
            value={email}
          />
          {fieldError ? (
            <span
              className="text-xs font-semibold text-(--danger)"
              id="invite-email-error"
            >
              {fieldError}
            </span>
          ) : null}
        </label>
        <label className="grid gap-1.5" htmlFor="invite-role">
          <span className="text-[0.8125rem] font-semibold text-(--secondary)">
            Role
          </span>
          <select
            className="field-input"
            disabled={pending}
            id="invite-role"
            onChange={(event) =>
              setRole(event.target.value as "user" | "admin")
            }
            value={role}
          >
            <option value="user">Member</option>
            <option value="admin">Administrator</option>
          </select>
        </label>
        <ShellButton
          disabled={email.trim().length === 0}
          loading={pending}
          type="submit"
        >
          Invite
        </ShellButton>
      </form>

      {error ? (
        <div className="notice notice-danger" role="alert">
          {error}
        </div>
      ) : null}

      {created ? (
        <div
          className={cn(
            "notice",
            created.emailed ? "notice-success" : "notice-warning",
          )}
          role="status"
        >
          <p className="font-semibold">
            {created.emailed
              ? `Invitation emailed to ${created.email}.`
              : `Invitation created for ${created.email}. It was not emailed${created.emailError ? `: ${created.emailError}` : "."} Copy the link and send it yourself.`}
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              aria-label="Invitation link"
              className="field-input min-w-0 flex-1 font-mono text-xs"
              onFocus={(event) => event.currentTarget.select()}
              readOnly
              value={created.link}
            />
            <button
              className="btn-quiet"
              onClick={() => void copy(created.link)}
              type="button"
            >
              {copied ? (
                <CheckIcon aria-hidden="true" className="size-4" />
              ) : (
                <CopyIcon aria-hidden="true" className="size-4" />
              )}
              {copied ? "Copied" : "Copy link"}
            </button>
          </div>
        </div>
      ) : null}

      {invitations === null && !error ? (
        <p className="text-sm text-(--secondary)">Loading invitations…</p>
      ) : null}
      {invitations && invitations.length === 0 ? (
        <p className="text-sm text-(--secondary)">No pending invitations.</p>
      ) : null}
      {invitations && invitations.length > 0 ? (
        <ul
          aria-label="Pending invitations"
          className="divide-y divide-(--border)"
        >
          {invitations.map((invitation) => (
            <li
              className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
              key={invitation.id}
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-(--fg)">
                  {invitation.email}
                </p>
                <p className="text-xs text-(--tertiary)">
                  {invitation.role === "admin" ? "Administrator" : "Member"} ·
                  invited{" "}
                  {invitation.invitedByName
                    ? `by ${invitation.invitedByName} `
                    : ""}
                  on {formatDate(invitation.createdAt)} ·{" "}
                  {invitation.status === "expired"
                    ? "expired"
                    : `expires ${formatDate(invitation.expiresAt)}`}
                </p>
              </div>
              <button
                className="btn-quiet btn-quiet-danger self-start sm:self-auto"
                disabled={pending}
                onClick={() => void revoke(invitation)}
                type="button"
              >
                Withdraw
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </SettingsCard>
  );
}
