"use client";

import { useEffect, useState, type FormEvent } from "react";

import {
  AuthCard,
  AuthLink,
  AuthNotice,
  AuthPrimaryLink,
  PasswordField,
  SubmitButton,
  TextField,
} from "@/components/auth/auth-ui";
import { authClient } from "@/lib/auth/client";
import {
  describePasswordRefusal,
  newPasswordLengthError,
  PASSWORD_MIN_LENGTH,
} from "@/lib/password-messages";

// Accepting a workspace invitation: GET /api/invitations/[token] says who
// was invited and by whom; POST .../accept creates the account (the link
// proves the address) or, for someone already signed in as that address,
// just joins.

type Invitation = {
  accountExists: boolean;
  email: string;
  expiresAt: number;
  inviterName: string | null;
  organizationName: string | null;
  role: "admin" | "user";
};

type LoadState =
  | { state: "loading" }
  | { state: "ready"; invitation: Invitation }
  | { state: "expired" }
  | { state: "revoked" }
  | { state: "accepted" }
  | { state: "invalid" }
  | { state: "error" };

function classifyFailure(status: number, code: string | undefined): LoadState {
  const normalized = (code ?? "").toLowerCase();

  if (normalized.includes("expired")) return { state: "expired" };
  if (normalized.includes("revoked")) return { state: "revoked" };
  if (normalized.includes("accepted") || normalized.includes("used")) {
    return { state: "accepted" };
  }
  if (status === 410) return { state: "expired" };
  if (status === 404 || status === 400) return { state: "invalid" };

  return { state: "error" };
}

async function fetchInvitation(token: string): Promise<LoadState> {
  try {
    const response = await fetch(
      `/api/invitations/${encodeURIComponent(token)}`,
      { cache: "no-store" },
    );
    const payload = (await response.json().catch(() => null)) as
      | (Partial<Invitation> & { code?: string; status?: string })
      | null;

    if (!response.ok || !payload?.email) {
      return classifyFailure(response.status, payload?.code ?? payload?.status);
    }

    if (payload.status && payload.status !== "pending") {
      return classifyFailure(response.status, payload.status);
    }

    if (typeof payload.expiresAt === "number" && payload.expiresAt < Date.now()) {
      return { state: "expired" };
    }

    return {
      invitation: {
        accountExists: payload.accountExists === true,
        email: payload.email,
        expiresAt: payload.expiresAt ?? 0,
        inviterName: payload.inviterName ?? null,
        organizationName: payload.organizationName ?? null,
        role: payload.role === "admin" ? "admin" : "user",
      },
      state: "ready",
    };
  } catch {
    return { state: "error" };
  }
}

export function InviteShell({
  signedInAs,
  token,
}: {
  signedInAs: { email: string; name: string } | null;
  token: string;
}) {
  const [load, setLoad] = useState<LoadState>({ state: "loading" });

  useEffect(() => {
    let cancelled = false;

    void fetchInvitation(token).then((result) => {
      if (!cancelled) {
        setLoad(result);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [token]);

  switch (load.state) {
    case "loading":
      return (
        <AuthCard title="Opening your invitation…">
          <div aria-hidden="true" className="space-y-3">
            <div className="h-3 w-3/4 animate-pulse rounded-full bg-(--surface-strong)" />
            <div className="h-3 w-1/2 animate-pulse rounded-full bg-(--surface-strong)" />
          </div>
        </AuthCard>
      );
    case "expired":
      return (
        <EndState
          description="Invitations last a limited time. Ask the person who invited you to send a new one."
          title="This invitation has expired"
        />
      );
    case "revoked":
      return (
        <EndState
          description="An administrator withdrew this invitation. Ask them if you still need access."
          title="This invitation is no longer valid"
        />
      );
    case "accepted":
      return (
        <EndState
          description="This invitation has already been used. Sign in with the account it created."
          title="Invitation already accepted"
        />
      );
    case "invalid":
      return (
        <EndState
          description="Check that you opened the whole link from your invitation email."
          title="This invitation link isn't valid"
        />
      );
    case "error":
      return (
        <EndState
          description="We couldn't open this invitation just now. Reload the page to try again."
          title="Something went wrong"
        />
      );
    case "ready":
      return (
        <ReadyInvitation
          invitation={load.invitation}
          signedInAs={signedInAs}
          token={token}
        />
      );
  }
}

function EndState({
  description,
  title,
}: {
  description: string;
  title: string;
}) {
  return (
    <AuthCard
      description={description}
      footer={
        <p>
          Have an account? <AuthLink href="/login">Sign in</AuthLink>
        </p>
      }
      title={title}
    >
      {null}
    </AuthCard>
  );
}

async function accept(
  token: string,
  body: Record<string, string>,
): Promise<{ error: string | null; field?: "name" | "password" }> {
  try {
    const response = await fetch(
      `/api/invitations/${encodeURIComponent(token)}/accept`,
      {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    const payload = (await response.json().catch(() => null)) as {
      code?: string;
      error?: string;
      message?: string;
      redirectTo?: string;
    } | null;

    if (response.ok) {
      window.location.assign(payload?.redirectTo ?? "/dashboard");
      return { error: null };
    }

    const passwordProblem = describePasswordRefusal({
      code: payload?.code,
      message: payload?.message ?? payload?.error,
    });

    if (passwordProblem) {
      return { error: passwordProblem, field: "password" };
    }

    return {
      error:
        payload?.error ??
        payload?.message ??
        "The invitation couldn't be accepted. Please try again.",
    };
  } catch {
    return { error: "The invitation couldn't be accepted. Please try again." };
  }
}

function ReadyInvitation({
  invitation,
  signedInAs,
  token,
}: {
  invitation: Invitation;
  signedInAs: { email: string; name: string } | null;
  token: string;
}) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<{ name?: string; password?: string }>(
    {},
  );
  const [banner, setBanner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const workspace = invitation.organizationName ?? "this workspace";
  const description = (
    <>
      {invitation.inviterName ? (
        <>
          <strong className="font-bold text-(--fg)">
            {invitation.inviterName}
          </strong>{" "}
          invited{" "}
        </>
      ) : (
        "You were invited as "
      )}
      <strong className="font-bold text-(--fg)">{invitation.email}</strong>
      {invitation.role === "admin" ? " as an administrator" : ""}.
    </>
  );
  const sameAccount =
    signedInAs?.email.toLowerCase() === invitation.email.toLowerCase();

  async function acceptSignedIn() {
    setBusy(true);
    setBanner(null);

    const result = await accept(token, {});

    if (result.error) {
      setBanner(result.error);
      setBusy(false);
    }
  }

  async function createAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (busy) {
      return;
    }

    const nextErrors: typeof errors = {};

    if (name.trim().length === 0) {
      nextErrors.name = "Enter your full name";
    }

    const lengthProblem = newPasswordLengthError(password);

    if (lengthProblem) {
      nextErrors.password = lengthProblem;
    }

    setErrors(nextErrors);
    setBanner(null);

    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    setBusy(true);

    const result = await accept(token, { name: name.trim(), password });

    if (result.error) {
      if (result.field) {
        setErrors({ [result.field]: result.error });
      } else {
        setBanner(result.error);
      }

      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    await authClient.signOut().catch(() => null);
    window.location.reload();
  }

  if (signedInAs && sameAccount) {
    return (
      <AuthCard description={description} title={`Join ${workspace}`}>
        {banner ? <AuthNotice>{banner}</AuthNotice> : null}
        <button
          className="inline-flex min-h-12 w-full items-center justify-center rounded-[0.875rem] bg-(--accent) px-5 text-[0.9375rem] font-bold text-white transition hover:bg-(--accent-hover) disabled:opacity-60"
          disabled={busy}
          onClick={() => void acceptSignedIn()}
          type="button"
        >
          {busy ? "Joining…" : "Accept invitation"}
        </button>
      </AuthCard>
    );
  }

  if (signedInAs) {
    return (
      <AuthCard description={description} title={`Join ${workspace}`}>
        <p className="text-sm leading-6 text-(--secondary)">
          You&apos;re signed in as{" "}
          <strong className="text-(--fg)">{signedInAs.email}</strong>. Sign
          out to accept this invitation for {invitation.email}.
        </p>
        <button
          className="inline-flex min-h-12 w-full items-center justify-center rounded-[0.875rem] border-[1.5px] border-(--border-strong) bg-(--paper) px-5 text-[0.9375rem] font-bold text-(--fg) transition hover:bg-(--surface) disabled:opacity-60"
          disabled={busy}
          onClick={() => void signOut()}
          type="button"
        >
          Sign out and continue
        </button>
      </AuthCard>
    );
  }

  if (invitation.accountExists) {
    return (
      <AuthCard description={description} title={`Join ${workspace}`}>
        <p className="text-sm leading-6 text-(--secondary)">
          There&apos;s already an account for this address. Sign in to accept.
        </p>
        <AuthPrimaryLink
          href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}
        >
          Sign in to accept
        </AuthPrimaryLink>
      </AuthCard>
    );
  }

  return (
    <AuthCard description={description} title={`Join ${workspace}`}>
      {banner ? <AuthNotice>{banner}</AuthNotice> : null}
      <form className="space-y-5" noValidate onSubmit={createAccount}>
        <TextField
          autoComplete="email"
          label="Email address"
          name="email"
          readOnly
          type="email"
          value={invitation.email}
        />
        <TextField
          autoComplete="name"
          disabled={busy}
          error={errors.name}
          label="Full name"
          name="name"
          onChange={(event) => {
            setName(event.target.value);
            setErrors((current) => ({ ...current, name: undefined }));
          }}
          value={name}
        />
        <PasswordField
          autoComplete="new-password"
          disabled={busy}
          error={errors.password}
          hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
          onChange={(event) => {
            setPassword(event.target.value);
            setErrors((current) => ({ ...current, password: undefined }));
          }}
          value={password}
        />
        <SubmitButton busy={busy} busyLabel="Joining…">
          Accept and create account
        </SubmitButton>
      </form>
    </AuthCard>
  );
}
