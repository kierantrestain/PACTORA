"use client";

import { useState, type FormEvent } from "react";

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
import { forgotPasswordSchema } from "@/lib/schemas/auth";

// Password recovery and the page Better Auth's email confirmation link
// lands on. Each says only what the person needs to do next.

const backToSignIn = (
  <p>
    Remembered it? <AuthLink href="/login">Back to sign in</AuthLink>
  </p>
);

export function ForgotPasswordShell() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (busy) {
      return;
    }

    const parsed = forgotPasswordSchema.safeParse({ email: email.trim() });

    if (!parsed.success) {
      setError("Enter a valid email address");
      return;
    }

    setBusy(true);
    setFailed(false);

    try {
      const result = await authClient.requestPasswordReset({
        email: parsed.data.email,
        redirectTo: `${window.location.origin}/reset-password`,
      });

      if (result.error) {
        setFailed(true);
      } else {
        setSentTo(parsed.data.email);
      }
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  if (sentTo) {
    return (
      <AuthCard
        description={
          <>
            If <strong className="font-bold text-(--fg)">{sentTo}</strong> has
            an account, a link to choose a new password is on its way. It works
            for one hour.
          </>
        }
        footer={
          <p>
            <AuthLink href="/login">Back to sign in</AuthLink>
          </p>
        }
        title="Check your inbox"
      >
        <button
          className="w-fit text-sm font-bold text-(--accent-ink) underline-offset-4 hover:underline"
          onClick={() => setSentTo(null)}
          type="button"
        >
          Use a different email address
        </button>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      description="Enter the email address you sign in with and we'll send you a link to choose a new password."
      footer={backToSignIn}
      title="Reset your password"
    >
      {failed ? (
        <AuthNotice>
          We couldn&apos;t send the link. Please try again.
        </AuthNotice>
      ) : null}
      <form className="space-y-5" noValidate onSubmit={handleSubmit}>
        <TextField
          autoComplete="email"
          disabled={busy}
          error={error ?? undefined}
          inputMode="email"
          label="Email address"
          name="email"
          onChange={(event) => {
            setEmail(event.target.value);
            setError(null);
          }}
          type="email"
          value={email}
        />
        <SubmitButton busy={busy} busyLabel="Sending…">
          Send reset link
        </SubmitButton>
      </form>
    </AuthCard>
  );
}

export function ResetPasswordShell({ token }: { token: string | null }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(token === null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (busy || !token) {
      return;
    }

    const lengthProblem = newPasswordLengthError(password);

    if (lengthProblem) {
      setError(lengthProblem);
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const result = await authClient.resetPassword({
        newPassword: password,
        token,
      });

      if (result.error) {
        const message = result.error.message?.toLowerCase() ?? "";

        if (message.includes("invalid token") || message.includes("expired")) {
          setExpired(true);
        } else {
          setError(
            describePasswordRefusal(result.error) ??
              "Something went wrong. Please try again.",
          );
        }

        return;
      }

      setDone(true);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (expired) {
    return (
      <AuthCard
        description="Reset links work once, for one hour. Ask for a new one and use the latest email."
        footer={backToSignIn}
        title="This link has expired"
      >
        <AuthPrimaryLink href="/forgot-password">
          Send a new link
        </AuthPrimaryLink>
      </AuthCard>
    );
  }

  if (done) {
    return (
      <AuthCard
        description="Your password has been changed and you've been signed out everywhere else."
        title="Password updated"
      >
        <AuthPrimaryLink href="/login">Sign in</AuthPrimaryLink>
      </AuthCard>
    );
  }

  return (
    <AuthCard footer={backToSignIn} title="Choose a new password">
      <form className="space-y-5" noValidate onSubmit={handleSubmit}>
        <PasswordField
          autoComplete="new-password"
          disabled={busy}
          error={error ?? undefined}
          hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
          label="New password"
          onChange={(event) => {
            setPassword(event.target.value);
            setError(null);
          }}
          value={password}
        />
        <SubmitButton busy={busy} busyLabel="Saving…">
          Update password
        </SubmitButton>
      </form>
    </AuthCard>
  );
}

export function VerifyEmailShell({
  error,
  signedIn,
}: {
  error: string | null;
  signedIn: boolean;
}) {
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">(
    "idle",
  );

  async function resend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const parsed = forgotPasswordSchema.safeParse({ email: email.trim() });

    if (!parsed.success) {
      setFieldError("Enter a valid email address");
      return;
    }

    setState("sending");

    try {
      const response = await fetch("/api/auth/send-verification-email", {
        body: JSON.stringify({
          callbackURL: `${window.location.origin}/verify-email`,
          email: parsed.data.email,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

      setState(response.ok ? "sent" : "failed");
    } catch {
      setState("failed");
    }
  }

  if (!error) {
    return (
      <AuthCard
        description="Your email address is confirmed and your account is ready."
        title="You're all set"
      >
        <AuthPrimaryLink href={signedIn ? "/dashboard" : "/login"}>
          {signedIn ? "Go to your documents" : "Sign in"}
        </AuthPrimaryLink>
      </AuthCard>
    );
  }

  const expired = error.toLowerCase().includes("expired");

  return (
    <AuthCard
      description={
        expired
          ? "Confirmation links work for a limited time. Enter your email address and we'll send a new one."
          : "This confirmation link isn't valid. It may have been used already. Enter your email address for a new one."
      }
      footer={
        <p>
          Already confirmed? <AuthLink href="/login">Sign in</AuthLink>
        </p>
      }
      title={expired ? "This link has expired" : "This link didn't work"}
    >
      {state === "sent" ? (
        <AuthNotice tone="success">
          If that address has an account waiting, a new link is on its way.
        </AuthNotice>
      ) : null}
      {state === "failed" ? (
        <AuthNotice>
          We couldn&apos;t send a new link. Please try again.
        </AuthNotice>
      ) : null}
      <form className="space-y-5" noValidate onSubmit={resend}>
        <TextField
          autoComplete="email"
          disabled={state === "sending"}
          error={fieldError ?? undefined}
          inputMode="email"
          label="Email address"
          name="email"
          onChange={(event) => {
            setEmail(event.target.value);
            setFieldError(null);
          }}
          type="email"
          value={email}
        />
        <SubmitButton busy={state === "sending"} busyLabel="Sending…">
          Send a new link
        </SubmitButton>
      </form>
    </AuthCard>
  );
}
