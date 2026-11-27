"use client";

import { useState, type FormEvent } from "react";

import { BrandingPanel } from "@/components/settings/branding-panel";
import { EmailSetupPanel } from "@/components/settings/email-domain-panel";
import {
  SaveRow,
  useOrganizationForm,
} from "@/components/settings/organization-form";
import { SettingsCard } from "@/components/settings/settings-frame";
import { FieldShell, ShellButton } from "@/components/shared/form-shell";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import {
  CUSTOM_DISCLOSURE_LEGAL_NOTE,
  CUSTOM_DISCLOSURE_NOTICE,
  tidyDisclosureText,
} from "@/lib/consent-disclosure-notice";
import type { OrganizationSettingsView } from "@/lib/organization-settings";
import type { SignupMode } from "@/lib/signup-policy";

// The workspace-wide settings, one section at a time. Each form saves the
// whole set (see organization-form.tsx) but shows only its own fields.

type SectionProps = { initialSettings: OrganizationSettingsView };

const signupModeOptions: Array<{
  description: string;
  label: string;
  value: SignupMode;
}> = [
  {
    description: "Only addresses at your email domains can create an account.",
    label: "People at my organisation",
    value: "domains",
  },
  {
    description: "Sign-up is closed. People join through an invitation.",
    label: "Only people I invite",
    value: "closed",
  },
  {
    description: "Anyone who finds this site can create an account.",
    label: "Anyone",
    value: "open",
  },
];

export function WorkspaceSettings({ initialSettings }: SectionProps) {
  const form = useOrganizationForm(initialSettings, "workspace");
  const { errors, saving, setValue, values } = form;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void form.save();
  }

  return (
    <form className="space-y-5" noValidate onSubmit={handleSubmit}>
      <SettingsCard id="workspace-name" title="Workspace">
        <div className="grid gap-4 sm:grid-cols-2">
          <FieldShell
            disabled={saving}
            error={errors.organizationName}
            helper="Shown in the header and in every email."
            label="Organization name"
            name="organization-name"
            onChange={(event) =>
              setValue("organizationName", event.target.value)
            }
            readOnly={false}
            value={values.organizationName}
          />
          <div className="scroll-mt-28" id="support-address">
            <FieldShell
              autoComplete="off"
              disabled={saving || values.supportAddressFromEnv}
              error={errors.supportAddress}
              helper={
                values.supportAddressFromEnv
                  ? "Set by the SUPPORT_EMAIL environment variable."
                  : "Where signers' questions and replies go."
              }
              ignorePasswordManagers
              label="Support address"
              name="support-address-input"
              onChange={(event) =>
                setValue("supportAddress", event.target.value)
              }
              readOnly={values.supportAddressFromEnv}
              type="email"
              value={values.supportAddress}
            />
          </div>
        </div>
      </SettingsCard>

      <SettingsCard
        description={
          values.part11Mode
            ? "Part 11 mode is on, so this covers signers too. A Part 11 envelope only goes to someone with a confirmed account here."
            : "This is about people who send documents. People who are sent a document to sign don't need an account."
        }
        id="signup-rule"
        title="Who can create an account"
      >
        <fieldset className="space-y-3">
          <legend className="sr-only">Who can create an account</legend>
          {signupModeOptions.map((option) => (
            <label
              className="flex cursor-pointer items-start gap-3 rounded-2xl bg-(--surface) px-4 py-3.5 ring-2 ring-transparent transition has-[:checked]:bg-(--accent-softer) has-[:checked]:ring-(--accent) has-[:focus-visible]:ring-(--accent)"
              key={option.value}
            >
              <input
                checked={values.signupMode === option.value}
                className="mt-1 size-4 accent-(--accent)"
                disabled={saving}
                name="signup-mode"
                onChange={() => setValue("signupMode", option.value)}
                type="radio"
                value={option.value}
              />
              <span className="space-y-0.5">
                <span className="block text-sm font-bold text-(--fg)">
                  {option.label}
                </span>
                <span className="block text-sm leading-6 text-(--secondary)">
                  {option.description}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        {values.signupMode === "domains" || errors.allowedEmailDomains ? (
          <div className="max-w-xl">
            <FieldShell
              disabled={saving}
              error={errors.allowedEmailDomains}
              helper="Separate several domains with commas."
              label="Email domains"
              name="allowed-email-domains"
              onChange={(event) =>
                setValue("allowedEmailDomains", event.target.value)
              }
              readOnly={false}
              value={values.allowedEmailDomains}
            />
          </div>
        ) : null}
      </SettingsCard>

      {!values.hosted ? (
        <SettingsCard
          description={
            <>
              Optional links to your own terms and privacy policy, shown in the
              footer of this site and its emails. Without a privacy link,
              signers see{" "}
              <a
                className="font-semibold text-(--accent-ink) underline underline-offset-4"
                href="/signer-privacy"
                rel="noreferrer"
                target="_blank"
              >
                a notice built from these settings
              </a>
              .
            </>
          }
          id="legal-links"
          title="Terms and privacy"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <FieldShell
              disabled={saving}
              error={errors.termsUrl}
              label="Terms link"
              name="terms-url"
              onChange={(event) => setValue("termsUrl", event.target.value)}
              readOnly={false}
              value={values.termsUrl}
            />
            <FieldShell
              disabled={saving}
              error={errors.privacyUrl}
              label="Privacy policy link"
              name="privacy-url"
              onChange={(event) => setValue("privacyUrl", event.target.value)}
              readOnly={false}
              value={values.privacyUrl}
            />
          </div>
        </SettingsCard>
      ) : null}

      <SaveRow form={form} />
    </form>
  );
}

export function BrandingSettings({ initialSettings }: SectionProps) {
  const form = useOrganizationForm(initialSettings, "branding");

  return (
    <form
      className="space-y-5"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void form.save();
      }}
    >
      <SettingsCard id="logo">
        <BrandingPanel
          brandColor={form.values.brandColor}
          brandColorError={form.errors.brandColor}
          disabled={form.saving}
          logoUrl={form.values.logoUrl}
          onBrandColorChange={(brandColor) =>
            form.setValue("brandColor", brandColor)
          }
          onLogoChange={(logoUrl) => form.setValue("logoUrl", logoUrl)}
        />
      </SettingsCard>
      <SaveRow form={form} />
    </form>
  );
}

export function DocumentSettings({ initialSettings }: SectionProps) {
  const form = useOrganizationForm(initialSettings, "documents");
  const { errors, saving, setValue, values } = form;
  const [noticeOpen, setNoticeOpen] = useState(false);

  /**
   * Whether saving puts the administrator's own words in place of what
   * signers read now, which needs them to agree to the notice first.
   */
  function changesToOwnDisclosure(): boolean {
    const next = tidyDisclosureText(values.consentDisclosure);

    return (
      next.length > 0 &&
      next !== tidyDisclosureText(values.defaultConsentDisclosure) &&
      next !== tidyDisclosureText(form.saved.consentDisclosure)
    );
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (changesToOwnDisclosure()) {
      setNoticeOpen(true);
      return;
    }

    void form.save();
  }

  return (
    <form className="space-y-5" noValidate onSubmit={handleSubmit}>
      <SettingsCard
        description="Signers read this and tick a box to agree to electronic records and signatures before they sign. Leave it empty to use the standard text. The words each signer saw are kept with their record."
        id="disclosure"
        title="Consent disclosure"
      >
        <Field className="gap-2 text-sm">
          <FieldLabel
            className="text-[0.8125rem] font-semibold text-(--secondary)"
            htmlFor="consent-disclosure"
          >
            Disclosure text
          </FieldLabel>
          <Textarea
            aria-describedby="consent-disclosure-description"
            aria-invalid={errors.consentDisclosure ? true : undefined}
            className={
              errors.consentDisclosure
                ? "min-h-48 border-(--danger)"
                : "min-h-48"
            }
            disabled={saving}
            id="consent-disclosure"
            maxLength={6000}
            name="consent-disclosure"
            onChange={(event) =>
              setValue("consentDisclosure", event.target.value)
            }
            placeholder="Standard text"
            value={values.consentDisclosure}
          />
          {errors.consentDisclosure ? (
            <FieldError
              className="text-xs font-semibold text-(--danger)"
              id="consent-disclosure-description"
            >
              {errors.consentDisclosure}
            </FieldError>
          ) : (
            <FieldDescription
              className="text-xs leading-5 text-(--tertiary)"
              id="consent-disclosure-description"
            >
              Separate paragraphs with a blank line. Start a line with ## and a
              space for a heading. {"{sender}"} is replaced by the sender&apos;s
              name and {"{contact}"} by the address to write to.
            </FieldDescription>
          )}
          <p className="text-xs leading-5 text-(--secondary)">
            {CUSTOM_DISCLOSURE_LEGAL_NOTE}
          </p>
        </Field>
        <div className="flex flex-wrap gap-3">
          <ShellButton
            disabled={saving}
            onClick={() =>
              setValue("consentDisclosure", values.defaultConsentDisclosure)
            }
            variant="secondary"
          >
            Start from the standard text
          </ShellButton>
          {values.consentDisclosure.length > 0 ? (
            <ShellButton
              disabled={saving}
              onClick={() => setValue("consentDisclosure", "")}
              variant="ghost"
            >
              Use the standard text
            </ShellButton>
          ) : null}
        </div>
      </SettingsCard>

      <SaveRow form={form} />

      <Dialog onOpenChange={setNoticeOpen} open={noticeOpen}>
        <DialogContent
          className="max-h-[calc(100dvh-2rem)] max-w-lg overflow-y-auto sm:p-8"
          showCloseButton={false}
        >
          <DialogHeader className="space-y-3">
            <DialogTitle>{CUSTOM_DISCLOSURE_NOTICE.title}</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-3 text-sm leading-6 text-(--secondary)">
                {CUSTOM_DISCLOSURE_NOTICE.paragraphs.map((paragraph) => (
                  <p key={paragraph.text}>
                    {paragraph.lead ? (
                      <strong className="font-bold text-(--fg)">
                        {paragraph.lead}{" "}
                      </strong>
                    ) : null}
                    {paragraph.text}
                  </p>
                ))}
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-3 sm:justify-end">
            <ShellButton
              onClick={() => setNoticeOpen(false)}
              variant="secondary"
            >
              Cancel
            </ShellButton>
            <ShellButton
              onClick={() => {
                setNoticeOpen(false);
                void form.save(true);
              }}
            >
              {CUSTOM_DISCLOSURE_NOTICE.agree}
            </ShellButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </form>
  );
}

export function RetentionSettings({ initialSettings }: SectionProps) {
  const form = useOrganizationForm(initialSettings, "data");
  const { errors, saving, setValue, values } = form;

  return (
    <form
      className="contents"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void form.save();
      }}
    >
      <SettingsCard
        description="After this many days a completed, declined or voided envelope is deleted with its audit trail; its sender is emailed 30 days before. Leave empty to keep them until someone deletes them. Check how long your records must be kept first."
        id="retention"
        title="How long to keep finished documents"
      >
        <div className="max-w-xs">
          <FieldShell
            disabled={saving || values.part11Mode}
            error={errors.retentionDays}
            helper={
              values.part11Mode
                ? "Off while Part 11 mode is on: those records are deleted by hand only."
                : "30 days or more."
            }
            label="Days to keep"
            name="retention-days"
            onChange={(event) => setValue("retentionDays", event.target.value)}
            placeholder="Keep until deleted"
            readOnly={false}
            value={values.retentionDays}
          />
        </div>
        <SaveRow disabled={values.part11Mode} form={form} />
      </SettingsCard>
    </form>
  );
}

export function SendingDomainSettings({ initialSettings }: SectionProps) {
  const form = useOrganizationForm(initialSettings, "advanced");
  const [revision, setRevision] = useState(0);
  const { errors, saving, setValue, values } = form;

  return (
    <SettingsCard
      description="For deployments that send through Resend from their own domain. Most workspaces connect a mailbox under Email & Integrations instead."
      id="email-setup"
      title="Sending domain"
    >
      <form
        className="space-y-4"
        noValidate
        onSubmit={async (event) => {
          event.preventDefault();

          if (await form.save()) {
            // A new sender address means a different domain to check.
            setRevision((current) => current + 1);
          }
        }}
      >
        <div className="max-w-md">
          <FieldShell
            disabled={saving || values.senderAddressFromEnv}
            error={errors.senderAddress}
            helper={
              values.senderAddressFromEnv
                ? "Set by the RESEND_FROM_EMAIL environment variable."
                : "An address at a domain you own, such as a notifications subdomain."
            }
            ignorePasswordManagers
            label="Send email from"
            name="sender-address"
            onChange={(event) => setValue("senderAddress", event.target.value)}
            readOnly={values.senderAddressFromEnv}
            type="email"
            value={values.senderAddress}
          />
        </div>
        {values.senderAddressFromEnv ? null : <SaveRow form={form} />}
      </form>
      <div className="border-t border-(--border) pt-5">
        <EmailSetupPanel key={revision} />
      </div>
    </SettingsCard>
  );
}
