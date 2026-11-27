"use client";

import { CheckIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { ShellButton } from "@/components/shared/form-shell";
import {
  findSection,
  settingsHref,
  type SettingsSectionId,
} from "@/components/settings/settings-index";
import type {
  OrganizationSettingsField,
  OrganizationSettingsView,
} from "@/lib/organization-settings";

// The workspace-wide settings are saved together by PUT /api/admin/settings,
// which takes the whole set. Each section edits only its own fields and
// sends the rest back exactly as loaded, so nothing it does not show can
// change.

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

/** Where each field is edited, to point at it when a save is refused. */
const FIELD_SECTIONS: Record<
  OrganizationSettingsField,
  { anchor: string; section: SettingsSectionId }
> = {
  allowedEmailDomains: { anchor: "signup-rule", section: "workspace" },
  brandColor: { anchor: "brand-color", section: "branding" },
  consentDisclosure: { anchor: "disclosure", section: "documents" },
  organizationName: { anchor: "workspace-name", section: "workspace" },
  privacyUrl: { anchor: "legal-links", section: "workspace" },
  retentionDays: { anchor: "retention", section: "data" },
  senderAddress: { anchor: "email-setup", section: "advanced" },
  signupMode: { anchor: "signup-rule", section: "workspace" },
  supportAddress: { anchor: "support-address", section: "workspace" },
  termsUrl: { anchor: "legal-links", section: "workspace" },
};

type Errors = Partial<Record<OrganizationSettingsField, string>>;

type SettingsResponse = {
  error?: string;
  fieldErrors?: Errors;
  settings?: OrganizationSettingsView;
} | null;

export function useOrganizationForm(
  initial: OrganizationSettingsView,
  section: SettingsSectionId,
) {
  const router = useRouter();
  const [values, setValues] = useState(initial);
  const [saved, setSavedValues] = useState(initial);
  const [errors, setErrors] = useState<Errors>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  function setValue<K extends keyof OrganizationSettingsView>(
    field: K,
    value: OrganizationSettingsView[K],
  ) {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setError(null);
    setJustSaved(false);
  }

  async function save(disclosureNoticeAgreed = false): Promise<boolean> {
    if (saving) {
      return false;
    }

    setSaving(true);
    setErrors({});
    setError(null);
    setJustSaved(false);

    try {
      const response = await fetch("/api/admin/settings", {
        body: JSON.stringify({
          allowedEmailDomains: values.allowedEmailDomains,
          brandColor: values.brandColor,
          consentDisclosure: values.consentDisclosure,
          consentDisclosureAcknowledged: disclosureNoticeAgreed,
          organizationName: values.organizationName,
          privacyUrl: values.privacyUrl,
          retentionDays: values.retentionDays,
          senderAddress: values.senderAddress,
          signupMode: values.signupMode,
          supportAddress: values.supportAddress,
          termsUrl: values.termsUrl,
        }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      const payload = (await response
        .json()
        .catch(() => null)) as SettingsResponse;

      if (!response.ok || !payload?.settings) {
        setErrors(payload?.fieldErrors ?? {});
        setError(
          payload?.fieldErrors && Object.keys(payload.fieldErrors).length > 0
            ? null
            : (payload?.error ?? GENERIC_ERROR_MESSAGE),
        );
        return false;
      }

      setValues(payload.settings);
      setSavedValues(payload.settings);
      setJustSaved(true);
      // The header, accent colour and logo come from the layout around this
      // page, which only reads them again when asked to.
      router.refresh();
      return true;
    } catch {
      setError(GENERIC_ERROR_MESSAGE);
      return false;
    } finally {
      setSaving(false);
    }
  }

  // Refusals about fields another section edits, with a link to them.
  const elsewhere = (Object.keys(errors) as OrganizationSettingsField[])
    .filter(
      (field) => errors[field] && FIELD_SECTIONS[field].section !== section,
    )
    .map((field) => ({
      href: settingsHref(
        FIELD_SECTIONS[field].section,
        FIELD_SECTIONS[field].anchor,
      ),
      message: errors[field]!,
      sectionLabel: findSection(FIELD_SECTIONS[field].section).label,
    }));

  return {
    elsewhere,
    error,
    errors,
    justSaved,
    save,
    saved,
    saving,
    setValue,
    values,
  };
}

export type OrganizationForm = ReturnType<typeof useOrganizationForm>;

/** The save button of a section, with its outcome beside it. */
export function SaveRow({
  disabled,
  form,
  label = "Save changes",
  onSave,
}: {
  disabled?: boolean;
  form: OrganizationForm;
  label?: string;
  onSave?: () => void;
}) {
  return (
    <div className="space-y-3">
      <FormProblems form={form} />
      <div className="flex flex-wrap items-center gap-4">
        <ShellButton
          disabled={disabled}
          loading={form.saving}
          onClick={onSave}
          type={onSave ? "button" : "submit"}
        >
          {form.saving ? "Saving…" : label}
        </ShellButton>
        <SavedIndicator show={form.justSaved} />
      </div>
    </div>
  );
}

export function SavedIndicator({
  children = "Changes saved.",
  show,
}: {
  children?: ReactNode;
  show: boolean;
}) {
  return (
    <span
      aria-live="polite"
      className="inline-flex items-center gap-1.5 text-sm font-semibold text-(--success)"
      role="status"
    >
      {show ? (
        <>
          <CheckIcon aria-hidden="true" className="size-4" strokeWidth={2.6} />
          {children}
        </>
      ) : null}
    </span>
  );
}

function FormProblems({ form }: { form: OrganizationForm }) {
  if (!form.error && form.elsewhere.length === 0) {
    return null;
  }

  return (
    <div className="notice notice-danger space-y-1" role="alert">
      {form.error ? <p>{form.error}</p> : null}
      {form.elsewhere.map((problem) => (
        <p key={problem.href}>
          {problem.message}.{" "}
          <Link className="underline underline-offset-4" href={problem.href}>
            Fix it in {problem.sectionLabel}
          </Link>
        </p>
      ))}
    </div>
  );
}
