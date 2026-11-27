"use client";

import { useRouter } from "next/navigation";
import { useState, type ChangeEvent, type FormEvent } from "react";

import {
  AuthCard,
  AuthDivider,
  AuthLink,
  AuthNotice,
  AuthTextButton,
  PasswordField,
  SubmitButton,
  TextField,
} from "@/components/auth/auth-ui";
import {
  hasOAuthProviders,
  OAuthButtons,
  type OAuthProviders,
} from "@/components/auth/oauth-buttons";
import { SsoButton, type SsoOption } from "@/components/auth/sso-button";
import { authClient } from "@/lib/auth/client";
import type { RegistrationView } from "@/lib/owner-provisioning";
import {
  describePasswordRefusal,
  newPasswordLengthError,
  PASSWORD_MIN_LENGTH,
} from "@/lib/password-messages";
import { signUpSchema } from "@/lib/schemas/auth";

// Codes Better Auth answers with when this workspace's sign-up rule turns an
// address away. The message that comes with them says what the rule is.
const SIGNUP_RULE_ERROR_CODES = new Set([
  "setup_required",
  "signup_closed",
  "signup_domain_not_allowed",
]);

const GENERIC_ERROR = "Something went wrong. Please try again.";

type SignupShellProps = {
  /** False when this deployment cannot send the confirmation email. */
  emailConnected?: boolean;
  oauthProviders?: OAuthProviders | null;
  /** False when password sign-in is off, so accounts come from SSO. */
  passwordSignIn?: boolean;
  registration: RegistrationView;
  sso?: SsoOption | null;
};

type Values = { email: string; name: string; password: string };
type Errors = Partial<Record<keyof Values, string>>;

export function SignupShell({
  emailConnected = true,
  oauthProviders = null,
  passwordSignIn = true,
  registration,
  sso = null,
}: SignupShellProps) {
  switch (registration.view) {
    case "invitation-only":
      return (
        <AuthCard
          description="New accounts are by invitation. Ask your workspace administrator to invite you, then open the link in your email."
          footer={
            <p>
              Already have an account? <AuthLink href="/login">Sign in</AuthLink>
            </p>
          }
          title="This workspace is invitation-only"
        >
          <p className="text-sm leading-6 text-(--secondary)">
            Were you sent a document to sign? Use the link in that email. You
            don&apos;t need an account.
          </p>
        </AuthCard>
      );
    case "provisioning-required":
      return (
        <AuthCard
          description="This deployment's owner account is created by the person who operates it, not from this page."
          footer={
            <p>
              Already have an account? <AuthLink href="/login">Sign in</AuthLink>
            </p>
          }
          title="Owner account not set up yet"
        >
          <p className="text-sm leading-6 text-(--secondary)">
            If you run this deployment, provision the owner account as
            described in the self-hosting guide, then sign in here.
          </p>
        </AuthCard>
      );
    case "unavailable":
      return (
        <AuthCard
          description={
            registration.reason === "unmigrated"
              ? "This deployment's database needs its latest updates before accounts can be created."
              : "This deployment isn't connected to a database yet, so accounts can't be created."
          }
          title="Sign-up is unavailable"
        >
          <p className="text-sm leading-6 text-(--secondary)">
            Please try again later, or contact the person who runs this
            deployment.
          </p>
        </AuthCard>
      );
    case "first-owner":
    case "standard":
      return (
        <SignupForm
          emailConnected={emailConnected}
          firstOwner={registration.view === "first-owner"}
          oauthProviders={oauthProviders}
          passwordSignIn={passwordSignIn || !sso}
          signupRule={
            registration.view === "standard" ? registration.signupRule : null
          }
          sso={sso}
        />
      );
  }
}

function SignupForm({
  emailConnected,
  firstOwner: initiallyFirstOwner,
  oauthProviders,
  passwordSignIn,
  signupRule,
  sso,
}: {
  emailConnected: boolean;
  firstOwner: boolean;
  oauthProviders: OAuthProviders | null;
  passwordSignIn: boolean;
  signupRule: string | null;
  sso: SsoOption | null;
}) {
  const router = useRouter();
  const [firstOwner, setFirstOwner] = useState(initiallyFirstOwner);
  const [values, setValues] = useState<Values>({
    email: "",
    name: "",
    password: "",
  });
  const [errors, setErrors] = useState<Errors>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<"provisioning" | null>(null);

  function update(field: keyof Values) {
    return (event: ChangeEvent<HTMLInputElement>) => {
      const next = event.target.value;

      setValues((current) => ({ ...current, [field]: next }));
      setErrors((current) => ({ ...current, [field]: undefined }));
      setBanner(null);
    };
  }

  function validate(input: Values): Errors {
    const result = signUpSchema.safeParse({
      email: input.email,
      fullName: input.name,
      password: input.password,
    });
    const next: Errors = {};

    if (result.success) {
      return next;
    }

    for (const issue of result.error.issues) {
      const field = issue.path[0];

      if (field === "fullName") next.name = "Enter your full name";
      if (field === "email") next.email = "Enter a valid email address";
      if (field === "password") {
        next.password =
          newPasswordLengthError(input.password) ??
          `Use at least ${PASSWORD_MIN_LENGTH} characters`;
      }
    }

    return next;
  }

  async function registerFirstOwner(input: Values): Promise<"done" | "fall"> {
    let response: Response;

    try {
      response = await fetch("/api/register", {
        body: JSON.stringify({
          email: input.email,
          name: input.name,
          password: input.password,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
    } catch {
      setBanner(GENERIC_ERROR);
      return "done";
    }

    const payload = (await response.json().catch(() => null)) as {
      code?: string;
      error?: string;
      fieldErrors?: Partial<Record<string, string>>;
      message?: string;
      redirectTo?: string;
    } | null;

    if (response.status === 201) {
      router.replace(payload?.redirectTo ?? "/dashboard");
      router.refresh();
      return "done";
    }

    // Someone else became the owner first: carry on as an ordinary sign-up.
    if (response.status === 409 && payload?.code === "owner_exists") {
      setFirstOwner(false);
      return "fall";
    }

    if (payload?.code === "provisioning_required") {
      setBlocked("provisioning");
      return "done";
    }

    const passwordProblem = describePasswordRefusal({
      code: payload?.code,
      message: payload?.message ?? payload?.error,
    });

    if (passwordProblem) {
      setErrors({ password: passwordProblem });
    } else if (payload?.fieldErrors) {
      setErrors({
        email: payload.fieldErrors.email,
        name: payload.fieldErrors.name,
        password: payload.fieldErrors.password,
      });
    } else {
      setBanner(payload?.error ?? payload?.message ?? GENERIC_ERROR);
    }

    return "done";
  }

  async function signUpStandard(input: Values) {
    const result = await authClient.signUp.email({
      callbackURL: `${window.location.origin}/verify-email`,
      email: input.email,
      name: input.name,
      password: input.password,
    });

    if (!result.error) {
      setSentTo(input.email);
      return;
    }

    const message = result.error.message?.toLowerCase() ?? "";

    if (SIGNUP_RULE_ERROR_CODES.has(result.error.code ?? "")) {
      setBanner(result.error.message ?? "New accounts aren't being accepted.");
    } else if (
      message.includes("user already exists") ||
      message.includes("use another email")
    ) {
      setErrors({ email: "This email is already registered" });
    } else if (describePasswordRefusal(result.error)) {
      setErrors({ password: describePasswordRefusal(result.error)! });
    } else {
      setBanner(GENERIC_ERROR);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (busy) {
      return;
    }

    const input: Values = {
      email: values.email.trim(),
      name: values.name.trim(),
      password: values.password,
    };
    const nextErrors = validate(input);

    setValues(input);
    setErrors(nextErrors);
    setBanner(null);

    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    setBusy(true);

    try {
      if (firstOwner && (await registerFirstOwner(input)) === "done") {
        return;
      }

      await signUpStandard(input);
    } catch {
      setBanner(GENERIC_ERROR);
    } finally {
      setBusy(false);
    }
  }

  if (blocked === "provisioning") {
    return (
      <SignupShell registration={{ view: "provisioning-required" }} />
    );
  }

  if (sentTo) {
    return (
      <CheckInbox
        email={sentTo}
        emailConnected={emailConnected}
        onStartOver={() => {
          setSentTo(null);
          setValues((current) => ({ ...current, password: "" }));
        }}
      />
    );
  }

  const showOAuth = !firstOwner && hasOAuthProviders(oauthProviders);
  const showSso = !firstOwner && sso !== null;

  return (
    <AuthCard
      description={
        firstOwner
          ? "You're the first one here, so this account will own the workspace."
          : (signupRule ?? undefined)
      }
      footer={
        <p>
          Already have an account? <AuthLink href="/login">Sign in</AuthLink>
        </p>
      }
      title={firstOwner ? "Create your workspace" : "Create your account"}
    >
      {banner ? <AuthNotice>{banner}</AuthNotice> : null}

      {showSso ? (
        <SsoButton
          onError={setBanner}
          sso={sso}
          variant={passwordSignIn ? "secondary" : "primary"}
        />
      ) : null}

      {showOAuth ? (
        <OAuthButtons
          disabled={busy}
          onError={setBanner}
          providers={oauthProviders}
        />
      ) : null}

      {(showSso || showOAuth) && passwordSignIn ? <AuthDivider /> : null}

      {passwordSignIn || firstOwner ? (
        <form className="space-y-5" noValidate onSubmit={handleSubmit}>
          <TextField
            autoComplete="name"
            disabled={busy}
            error={errors.name}
            label="Full name"
            name="name"
            onChange={update("name")}
            value={values.name}
          />
          <TextField
            autoComplete="email"
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
            autoComplete="new-password"
            disabled={busy}
            error={errors.password}
            hint={`At least ${PASSWORD_MIN_LENGTH} characters. A passphrase works well.`}
            onChange={update("password")}
            value={values.password}
          />
          <SubmitButton busy={busy} busyLabel="Creating account…">
            Create account
          </SubmitButton>
        </form>
      ) : null}
    </AuthCard>
  );
}

function CheckInbox({
  email,
  emailConnected,
  onStartOver,
}: {
  email: string;
  emailConnected: boolean;
  onStartOver: () => void;
}) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">(
    "idle",
  );

  async function resend() {
    if (state === "sending") {
      return;
    }

    setState("sending");

    try {
      const response = await fetch("/api/auth/send-verification-email", {
        body: JSON.stringify({
          callbackURL: `${window.location.origin}/verify-email`,
          email,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

      setState(response.ok ? "sent" : "failed");
    } catch {
      setState("failed");
    }
  }

  if (!emailConnected) {
    return (
      <AuthCard
        description="Your account is ready, but this workspace can't send email yet, so the confirmation link couldn't be sent."
        footer={
          <p>
            <AuthLink href="/login">Back to sign in</AuthLink>
          </p>
        }
        title="Almost there"
      >
        <p className="text-sm leading-6 text-(--secondary)">
          Ask your workspace administrator to connect email. Once they have,
          sign in and a new confirmation link is sent to{" "}
          <strong className="text-(--fg)">{email}</strong>.
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      description={
        <>
          We sent a confirmation link to{" "}
          <strong className="font-bold text-(--fg)">{email}</strong>. Open it to
          finish creating your account.
        </>
      }
      footer={
        <p>
          Confirmed already? <AuthLink href="/login">Sign in</AuthLink>
        </p>
      }
      title="Check your inbox"
    >
      {state === "sent" ? (
        <AuthNotice tone="success">A new link is on its way.</AuthNotice>
      ) : null}
      {state === "failed" ? (
        <AuthNotice>We couldn&apos;t send another link. Try again.</AuthNotice>
      ) : null}
      <div className="flex flex-col gap-3 text-sm text-(--secondary)">
        <p>
          Nothing after a few minutes? Check your spam folder, or{" "}
          <button
            className="font-bold text-(--accent-ink) underline-offset-4 hover:underline disabled:opacity-50"
            disabled={state === "sending"}
            onClick={() => void resend()}
            type="button"
          >
            {state === "sending" ? "sending…" : "send it again"}
          </button>
          .
        </p>
        <AuthTextButton onClick={onStartOver}>
          Use a different email address
        </AuthTextButton>
      </div>
    </AuthCard>
  );
}
