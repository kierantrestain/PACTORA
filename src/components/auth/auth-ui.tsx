"use client";

import Link from "next/link";
import {
  useId,
  useState,
  type ChangeEventHandler,
  type ReactNode,
} from "react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";

// The pieces every sign-in, sign-up and recovery page is built from, so they
// share one look: a single white card, visible labels, one primary action.

type AuthCardProps = {
  children: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  title: string;
};

export function AuthCard({
  children,
  description,
  footer,
  title,
}: AuthCardProps) {
  return (
    <section className="panel w-full max-w-[440px] px-6 py-8 sm:px-10 sm:py-10">
      <div className="space-y-7">
        <header className="space-y-2">
          <h1 className="text-[clamp(1.75rem,4vw,2.125rem)] leading-[1.1] font-extrabold tracking-[-0.035em] text-(--fg)">
            {title}
          </h1>
          {description ? (
            <div className="text-[0.9375rem] leading-6 text-(--secondary)">
              {description}
            </div>
          ) : null}
        </header>
        {children}
        {footer ? (
          <footer className="border-t border-(--border) pt-5 text-sm text-(--secondary)">
            {footer}
          </footer>
        ) : null}
      </div>
    </section>
  );
}

export function AuthNotice({
  children,
  tone = "danger",
}: {
  children: ReactNode;
  tone?: "accent" | "danger" | "success" | "warning";
}) {
  return (
    <div
      className={cn("notice", `notice-${tone}`)}
      role={tone === "danger" ? "alert" : "status"}
    >
      {children}
    </div>
  );
}

export function AuthLink({
  children,
  href,
}: {
  children: ReactNode;
  href: string;
}) {
  return (
    <Link
      className="font-bold text-(--accent-ink) underline-offset-4 hover:underline focus-visible:underline"
      href={href}
    >
      {children}
    </Link>
  );
}

export function AuthTextButton({
  children,
  disabled,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className="w-fit rounded-sm p-0 text-left text-sm font-bold text-(--accent-ink) underline-offset-4 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

export function AuthDivider() {
  return (
    <div
      aria-hidden="true"
      className="flex items-center gap-3 text-xs font-semibold text-(--tertiary)"
    >
      <span className="h-px flex-1 bg-(--border)" />
      or
      <span className="h-px flex-1 bg-(--border)" />
    </div>
  );
}

type TextFieldProps = {
  autoComplete?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  error?: string;
  hint?: ReactNode;
  inputMode?: "email" | "numeric" | "text";
  label: string;
  name: string;
  onChange?: ChangeEventHandler<HTMLInputElement>;
  readOnly?: boolean;
  type?: "email" | "text";
  value: string;
};

export function TextField({
  autoComplete,
  autoFocus,
  disabled,
  error,
  hint,
  inputMode,
  label,
  name,
  onChange,
  readOnly,
  type = "text",
  value,
}: TextFieldProps) {
  const id = useId();
  const messageId = `${id}-message`;

  return (
    <div className="grid gap-2">
      <label className="text-sm font-semibold text-(--fg)" htmlFor={id}>
        {label}
      </label>
      <Input
        aria-describedby={error || hint ? messageId : undefined}
        aria-invalid={error ? true : undefined}
        autoCapitalize={type === "email" ? "none" : undefined}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        className="read-only:bg-(--surface) read-only:text-(--secondary)"
        disabled={disabled}
        id={id}
        inputMode={inputMode}
        name={name}
        onChange={onChange}
        readOnly={readOnly}
        spellCheck={false}
        type={type}
        value={value}
      />
      <FieldMessage error={error} hint={hint} id={messageId} />
    </div>
  );
}

type PasswordFieldProps = {
  autoComplete: "current-password" | "new-password";
  disabled?: boolean;
  error?: string;
  hint?: ReactNode;
  label?: string;
  /** A link beside the label, such as "Forgot password?". */
  labelAction?: ReactNode;
  name?: string;
  onChange: ChangeEventHandler<HTMLInputElement>;
  value: string;
};

export function PasswordField({
  autoComplete,
  disabled,
  error,
  hint,
  label = "Password",
  labelAction,
  name = "password",
  onChange,
  value,
}: PasswordFieldProps) {
  const id = useId();
  const messageId = `${id}-message`;
  const [visible, setVisible] = useState(false);

  return (
    <div className="grid gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <label className="text-sm font-semibold text-(--fg)" htmlFor={id}>
          {label}
        </label>
        {labelAction}
      </div>
      <div className="relative">
        <Input
          aria-describedby={error || hint ? messageId : undefined}
          aria-invalid={error ? true : undefined}
          autoCapitalize="none"
          autoComplete={autoComplete}
          className="pr-20"
          disabled={disabled}
          id={id}
          maxLength={autoComplete === "new-password" ? 128 : undefined}
          minLength={autoComplete === "new-password" ? 15 : undefined}
          name={name}
          onChange={onChange}
          spellCheck={false}
          type={visible ? "text" : "password"}
          value={value}
          {...(autoComplete === "new-password"
            ? { passwordrules: "minlength: 15; maxlength: 128;" }
            : {})}
        />
        {/* Named by its text, not aria-label, so it is never mistaken for
            the field's own label. */}
        <button
          aria-controls={id}
          aria-pressed={visible}
          className="absolute top-1/2 right-2 inline-flex min-h-9 -translate-y-1/2 items-center rounded-lg px-3 text-[0.8125rem] font-bold text-(--secondary) transition hover:bg-(--hover) hover:text-(--fg) disabled:opacity-50"
          disabled={disabled}
          onClick={() => setVisible((current) => !current)}
          type="button"
        >
          {visible ? "Hide" : "Show"}
          <span className="sr-only"> password</span>
        </button>
      </div>
      <FieldMessage error={error} hint={hint} id={messageId} />
    </div>
  );
}

function FieldMessage({
  error,
  hint,
  id,
}: {
  error?: string;
  hint?: ReactNode;
  id: string;
}) {
  if (error) {
    return (
      <p className="text-[0.8125rem] font-semibold text-(--danger)" id={id}>
        {error}
      </p>
    );
  }

  if (hint) {
    return (
      <p className="text-[0.8125rem] leading-5 text-(--tertiary)" id={id}>
        {hint}
      </p>
    );
  }

  return null;
}

export function SubmitButton({
  busy,
  busyLabel,
  children,
  disabled,
}: {
  busy: boolean;
  busyLabel: string;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-[0.875rem] bg-(--accent) px-5 text-[0.9375rem] font-bold text-white transition hover:bg-(--accent-hover) focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none active:translate-y-px disabled:pointer-events-none disabled:opacity-60"
      disabled={busy || disabled}
      type="submit"
    >
      {busy ? (
        <span
          aria-hidden="true"
          className="inline-flex size-4 animate-spin rounded-full border-2 border-current border-r-transparent"
        />
      ) : null}
      {busy ? busyLabel : children}
    </button>
  );
}

export function AuthPrimaryLink({
  children,
  href,
}: {
  children: ReactNode;
  href: string;
}) {
  return (
    <Link
      className="inline-flex min-h-12 w-full items-center justify-center rounded-[0.875rem] bg-(--accent) px-5 text-[0.9375rem] font-bold text-white transition hover:bg-(--accent-hover) focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      href={href}
    >
      {children}
    </Link>
  );
}

/** A safe place to go after signing in: a path on this site, nothing else. */
export function safeNextPath(value: string | null | undefined): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return null;
  }

  if (value.startsWith("/\\") || value.includes("://")) {
    return null;
  }

  return value;
}
