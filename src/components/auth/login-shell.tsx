"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ChangeEvent, type FormEvent } from "react";

import {
  AuthCard,
  AuthDivider,
  AuthLink,
  AuthNotice,
  AuthTextButton,
  PasswordField,
  safeNextPath,
  SubmitButton,
  TextField,
} from "@/components/auth/auth-ui";
import {
  describeOAuthError,
  hasOAuthProviders,
  OAuthButtons,
  type OAuthProviders,
} from "@/components/auth/oauth-buttons";
import { useBranding } from "@/components/layout/branding-provider";
import { SsoButton, type SsoOption } from "@/components/auth/sso-button";
import { authClient } from "@/lib/auth/client";
import {
  describePasswordRefusal,
  PASSWORD_TOO_LONG_MESSAGE,
} from "@/lib/password-messages";
import { loginSchema } from "@/lib/schemas/auth";

type AuthErrorLike = { code?: string; message?: string };

type LoginShellProps = {
  /** The ?error= a provider (SSO, Google, Microsoft) came back with. */
  callbackError?: string | null;
  /** Where to go after signing in, when it is a path on this site. */
  next?: string | null;
  oauthProviders?: OAuthProviders | null;
  /** "on", "off", or "fallback": off, but a few addresses may still use one. */
  passwordSignIn?: "fallback" | "off" | "on";
  sso?: SsoOption | null;
};

type Values = { email: string; password: string };
type Errors = Partial<Record<keyof Values, string>>;
type Banner = { text: string; tone: "danger" | "success" } | null;

export function LoginShell({
  callbackError = null,
  next = null,
  oauthProviders = null,
  passwordSignIn = "on",
  sso = null,
}: LoginShellProps) {
  const router = useRouter();
  const { signupAvailable } = useBranding();
  const destination = safeNextPath(next) ?? "/dashboard";
  const [values, setValues] = useState<Values>({ email: "", password: "" });
  const [errors, setErrors] = useState<Errors>({});
  const [banner, setBanner] = useState<Banner>(
    callbackError
      ? { text: describeOAuthError(callbackError), tone: "danger" }
      : null,
  );
  // With password sign-in off, the form is only shown on request, for the
  // few addresses that keep a password for when single sign-on is down.
  const [showPasswordForm, setShowPasswordForm] = useState(
    passwordSignIn === "on",
  );
  const [busy, setBusy] = useState(false);
  const [needsVerification, setNeedsVerification] = useState(false);
  const [resending, setResending] = useState(false);
  // The password was right and the account uses two-step sign-in.
  const [needsSecondStep, setNeedsSecondStep] = useState(false);

  function update(field: keyof Values) {
    return (event: ChangeEvent<HTMLInputElement>) => {
      const nextValue = event.target.value;

      setValues((current) => ({ ...current, [field]: nextValue }));
      setErrors((current) => ({ ...current, [field]: undefined }));
      setBanner(null);
      setNeedsVerification(false);
    };
  }

  function showError(text: string) {
    setBanner({ text, tone: "danger" });
  }

  function finishSignIn() {
    router.replace(destination);
    router.refresh();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (busy) {
      return;
    }

    const input = { email: values.email.trim(), password: values.password };
    const parsed = loginSchema.safeParse(input);

    setValues(input);

    if (!parsed.success) {
      const nextErrors: Errors = {};

      for (const issue of parsed.error.issues) {
        if (issue.path[0] === "email") {
          nextErrors.email = "Enter a valid email address";
        }

        if (issue.path[0] === "password") {
          nextErrors.password = "Enter your password";
        }
      }

      setErrors(nextErrors);
      setBanner(null);
      return;
    }

    setErrors({});
    setBanner(null);
    setNeedsVerification(false);
    setBusy(true);

    try {
      const result = await authClient.signIn.email(parsed.data);

      if (result.error) {
        const code = (result.error as AuthErrorLike).code;
        const message = result.error.message?.trim().toLowerCase() ?? "";

        if (code === "SIGN_IN_LOCKED" || code === "PASSWORD_SIGN_IN_OFF") {
          showError(
            result.error.message ??
              "Too many wrong passwords. Try again in 15 minutes.",
          );
        } else if (message.includes("email not verified")) {
          setBanner({
            text: "Confirm your email address first. We've sent a fresh link to your inbox.",
            tone: "danger",
          });
          setNeedsVerification(true);
        } else if (
          describePasswordRefusal(result.error) === PASSWORD_TOO_LONG_MESSAGE
        ) {
          // No account has a password this long, so it cannot be right.
          setErrors({ password: PASSWORD_TOO_LONG_MESSAGE });
        } else if (message.includes("invalid email or password")) {
          showError("That email and password don't match. Try again.");
        } else {
          showError("Something went wrong. Please try again.");
        }

        return;
      }

      if (
        result.data &&
        typeof result.data === "object" &&
        "twoFactorRedirect" in result.data
      ) {
        setNeedsSecondStep(true);
        return;
      }

      finishSignIn();
    } catch {
      showError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function resendVerification() {
    const email = values.email.trim();

    if (!email || resending) {
      return;
    }

    setResending(true);

    try {
      const response = await fetch("/api/auth/send-verification-email", {
        body: JSON.stringify({
          callbackURL: `${window.location.origin}/verify-email`,
          email,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

      setBanner(
        response.ok
          ? { text: "Confirmation email sent. Check your inbox.", tone: "success" }
          : {
              text: "We couldn't send the confirmation email.",
              tone: "danger",
            },
      );
    } catch {
      showError("We couldn't send the confirmation email.");
    } finally {
      setResending(false);
    }
  }

  if (needsSecondStep) {
    return (
      <SecondStepCard
        onRestart={(message) => {
          setNeedsSecondStep(false);
          setValues((current) => ({ ...current, password: "" }));
          showError(message);
        }}
        onSignedIn={finishSignIn}
      />
    );
  }

  const showOAuth = hasOAuthProviders(oauthProviders);
  const hasAlternatives = showOAuth || sso !== null;

  return (
    <AuthCard
      footer={
        signupAvailable ? (
          <p>
            New here? <AuthLink href="/signup">Create an account</AuthLink>
          </p>
        ) : undefined
      }
      title="Sign in"
    >
      {banner ? <AuthNotice tone={banner.tone}>{banner.text}</AuthNotice> : null}

      {sso ? (
        <SsoButton
          onError={showError}
          sso={sso}
          variant={showPasswordForm ? "secondary" : "primary"}
        />
      ) : null}

      {showOAuth ? (
        <OAuthButtons
          callbackURL={destination}
          disabled={busy}
          onError={showError}
          providers={oauthProviders}
        />
      ) : null}

      {hasAlternatives && showPasswordForm ? <AuthDivider /> : null}

      {showPasswordForm ? (
        <form className="space-y-5" noValidate onSubmit={handleSubmit}>
          <TextField
            autoComplete="username"
            disabled={busy}
            error={errors.email}
            inputMode="email"
            label="Email address"
            name="email"
            onChange={update("email")}
            type="email"
            value={values.email}
          />
          <PasswordField
            autoComplete="current-password"
            disabled={busy}
            error={errors.password}
            labelAction={
              <Link
                className="text-[0.8125rem] font-bold text-(--accent-ink) underline-offset-4 hover:underline"
                href="/forgot-password"
              >
                Forgot password?
              </Link>
            }
            onChange={update("password")}
            value={values.password}
          />
          <SubmitButton busy={busy} busyLabel="Signing in…">
            Sign in
          </SubmitButton>
          {needsVerification ? (
            <AuthTextButton
              disabled={resending}
              onClick={() => void resendVerification()}
            >
              {resending ? "Sending…" : "Send the confirmation email again"}
            </AuthTextButton>
          ) : null}
        </form>
      ) : passwordSignIn === "fallback" ? (
        <AuthTextButton onClick={() => setShowPasswordForm(true)}>
          Sign in with a password instead
        </AuthTextButton>
      ) : null}
    </AuthCard>
  );
}

type SecondStepCardProps = {
  /** Back to the password, with a reason to show there. */
  onRestart: (message: string) => void;
  onSignedIn: () => void;
};

function SecondStepCard({ onRestart, onSignedIn }: SecondStepCardProps) {
  const [code, setCode] = useState("");
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (busy) {
      return;
    }

    const trimmed = code.replace(/\s+/g, "");

    if (!useBackupCode && !/^\d{6}$/.test(trimmed)) {
      setError("Enter the 6-digit code your authenticator app shows.");
      return;
    }

    if (useBackupCode && trimmed.length === 0) {
      setError("Enter one of your backup codes.");
      return;
    }

    setError(null);
    setBusy(true);

    try {
      const response = await fetch(
        useBackupCode
          ? "/api/auth/two-factor/verify-backup-code"
          : "/api/auth/two-factor/verify-totp",
        {
          body: JSON.stringify({ code: trimmed }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );

      if (response.ok) {
        onSignedIn();
        return;
      }

      const payload = (await response.json().catch(() => null)) as {
        code?: string;
      } | null;

      switch (payload?.code) {
        case "INVALID_CODE":
          setError(
            "That code isn't right. Check the time on your phone and try the newest code.",
          );
          break;
        case "INVALID_BACKUP_CODE":
          setError("That backup code isn't right, or it was used before.");
          break;
        case "ACCOUNT_TEMPORARILY_LOCKED":
          setError(
            "Too many wrong codes. Two-step sign-in is locked for 15 minutes.",
          );
          break;
        case "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE":
          onRestart("Too many wrong codes. Sign in again to get a new try.");
          return;
        case "INVALID_TWO_FACTOR_COOKIE":
          onRestart("That took too long. Sign in again.");
          return;
        default:
          setError("Something went wrong. Please try again.");
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard
      description={
        useBackupCode
          ? "Each backup code works once."
          : "Open your authenticator app and enter the 6-digit code it shows."
      }
      footer={
        <AuthTextButton
          onClick={() => {
            setUseBackupCode((current) => !current);
            setCode("");
            setError(null);
          }}
        >
          {useBackupCode
            ? "Use a code from your app instead"
            : "Lost your phone? Use a backup code"}
        </AuthTextButton>
      }
      title={useBackupCode ? "Enter a backup code" : "Enter your code"}
    >
      {error ? <AuthNotice>{error}</AuthNotice> : null}
      <form className="space-y-5" noValidate onSubmit={handleSubmit}>
        <TextField
          autoComplete="one-time-code"
          autoFocus
          disabled={busy}
          inputMode={useBackupCode ? "text" : "numeric"}
          label={useBackupCode ? "Backup code" : "6-digit code"}
          name="code"
          onChange={(event) => {
            setCode(event.target.value);
            setError(null);
          }}
          value={code}
        />
        <SubmitButton busy={busy} busyLabel="Checking…">
          Continue
        </SubmitButton>
      </form>
    </AuthCard>
  );
}
