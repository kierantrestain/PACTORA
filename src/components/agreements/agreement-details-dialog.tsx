"use client";

import { useId, useState, type FormEvent } from "react";

import { ShellButton } from "@/components/shared/form-shell";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { AgreementListItem } from "@/lib/agreements";
import {
  formatContractAmountInput,
  MAX_AGREEMENT_COUNTERPARTY_LENGTH,
  MAX_AGREEMENT_NOTES_LENGTH,
  MAX_RENEWAL_NOTICE_DAYS,
  parseContractAmount,
} from "@/lib/schemas/agreement";

type AgreementDetailsDialogProps = {
  agreement: AgreementListItem;
  onCancel: () => void;
  onSaved: () => void;
};

type FormErrors = Partial<
  Record<"amount" | "currency" | "endDate" | "noticeDays", string>
>;

const genericError = "Something went wrong. Please try again.";
const labelClassName = "text-[0.8125rem] font-semibold text-(--secondary)";
const helperClassName = "text-xs leading-5 text-(--tertiary)";
const errorClassName = "text-xs font-semibold text-(--danger)";

/** Tags typed as one line, separated by commas. */
function splitTags(value: string): string[] {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

/**
 * The details of one agreement: who it is with, what it is worth, when it
 * starts and ends, and how early to be reminded. Saved for its sender.
 */
export function AgreementDetailsDialog({
  agreement,
  onCancel,
  onSaved,
}: AgreementDetailsDialogProps) {
  const formId = useId();
  // An agreement described for the first time starts on the day it was
  // completed, which is usually right.
  const prefillsEffectiveDate =
    !agreement.hasDetails && agreement.completedDate !== null;
  const [counterparty, setCounterparty] = useState(
    agreement.counterparty ?? "",
  );
  const [amount, setAmount] = useState(
    formatContractAmountInput(agreement.contractValueCents),
  );
  const [currency, setCurrency] = useState(agreement.currency);
  const [effectiveDate, setEffectiveDate] = useState(
    agreement.effectiveDate ??
      (prefillsEffectiveDate ? (agreement.completedDate ?? "") : ""),
  );
  const [endDate, setEndDate] = useState(agreement.endDate ?? "");
  const [noticeDays, setNoticeDays] = useState(
    String(agreement.renewalNoticeDays),
  );
  const [autoRenews, setAutoRenews] = useState(agreement.autoRenews);
  const [tags, setTags] = useState(agreement.tags.join(", "));
  const [notes, setNotes] = useState(agreement.notes ?? "");
  const [errors, setErrors] = useState<FormErrors>({});
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  function validate(): FormErrors {
    const next: FormErrors = {};

    if (parseContractAmount(amount) === undefined) {
      next.amount = "Enter an amount such as 12500 or 12,500.50.";
    }

    if (!/^[A-Za-z]{3}$/.test(currency.trim())) {
      next.currency = "Use a three-letter code, such as USD.";
    }

    const days = Number(noticeDays);

    if (
      noticeDays.trim() === "" ||
      !Number.isInteger(days) ||
      days < 0 ||
      days > MAX_RENEWAL_NOTICE_DAYS
    ) {
      next.noticeDays = `Enter a whole number of days from 0 to ${String(MAX_RENEWAL_NOTICE_DAYS)}.`;
    }

    if (effectiveDate && endDate && endDate < effectiveDate) {
      next.endDate = "The end date can't be before the effective date.";
    }

    return next;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (isSaving) {
      return;
    }

    const nextErrors = validate();

    setErrors(nextErrors);
    setErrorMessage(null);

    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    setIsSaving(true);

    try {
      const response = await fetch(
        `/api/agreements/${encodeURIComponent(agreement.envelopeId)}`,
        {
          body: JSON.stringify({
            autoRenews,
            contractValueCents: parseContractAmount(amount) ?? null,
            counterparty,
            currency: currency.trim().toUpperCase(),
            effectiveDate,
            endDate,
            notes,
            renewalNoticeDays: Number(noticeDays),
            tags: splitTags(tags),
          }),
          headers: { "content-type": "application/json" },
          method: "PATCH",
        },
      );

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;

        setErrorMessage(payload?.error ?? genericError);
        return;
      }

      onSaved();
    } catch {
      setErrorMessage(genericError);
    } finally {
      setIsSaving(false);
    }
  }

  function fieldId(name: string): string {
    return `${formId}-${name}`;
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !isSaving) {
          onCancel();
        }
      }}
    >
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] max-w-xl overflow-y-auto sm:max-w-xl sm:p-8"
        showCloseButton={false}
      >
        <form className="space-y-5" noValidate onSubmit={handleSubmit}>
          <DialogHeader className="space-y-2">
            <DialogTitle>Agreement details</DialogTitle>
            <DialogDescription className="text-sm leading-6 text-(--secondary)">
              {agreement.title}
            </DialogDescription>
          </DialogHeader>

          <Field className="gap-2 text-sm">
            <FieldLabel className={labelClassName} htmlFor={fieldId("party")}>
              Counterparty
            </FieldLabel>
            <Input
              autoFocus
              disabled={isSaving}
              id={fieldId("party")}
              maxLength={MAX_AGREEMENT_COUNTERPARTY_LENGTH}
              onChange={(event) => setCounterparty(event.target.value)}
              placeholder="The company or person on the other side"
              value={counterparty}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_7rem]">
            <Field className="gap-2 text-sm">
              <FieldLabel
                className={labelClassName}
                htmlFor={fieldId("amount")}
              >
                Contract value
              </FieldLabel>
              <Input
                aria-describedby={
                  errors.amount ? fieldId("amount-error") : undefined
                }
                aria-invalid={errors.amount ? true : undefined}
                disabled={isSaving}
                id={fieldId("amount")}
                inputMode="decimal"
                onChange={(event) => setAmount(event.target.value)}
                placeholder="12,500.00"
                value={amount}
              />
              {errors.amount ? (
                <FieldError
                  className={errorClassName}
                  id={fieldId("amount-error")}
                >
                  {errors.amount}
                </FieldError>
              ) : null}
            </Field>
            <Field className="gap-2 text-sm">
              <FieldLabel
                className={labelClassName}
                htmlFor={fieldId("currency")}
              >
                Currency
              </FieldLabel>
              <Input
                aria-describedby={
                  errors.currency ? fieldId("currency-error") : undefined
                }
                aria-invalid={errors.currency ? true : undefined}
                autoCapitalize="characters"
                className="uppercase"
                disabled={isSaving}
                id={fieldId("currency")}
                maxLength={3}
                onChange={(event) => setCurrency(event.target.value)}
                value={currency}
              />
              {errors.currency ? (
                <FieldError
                  className={errorClassName}
                  id={fieldId("currency-error")}
                >
                  {errors.currency}
                </FieldError>
              ) : null}
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field className="gap-2 text-sm">
              <FieldLabel
                className={labelClassName}
                htmlFor={fieldId("effective")}
              >
                Effective date
              </FieldLabel>
              <Input
                aria-describedby={
                  prefillsEffectiveDate
                    ? fieldId("effective-description")
                    : undefined
                }
                disabled={isSaving}
                id={fieldId("effective")}
                onChange={(event) => setEffectiveDate(event.target.value)}
                type="date"
                value={effectiveDate}
              />
              {prefillsEffectiveDate ? (
                <FieldDescription
                  className={helperClassName}
                  id={fieldId("effective-description")}
                >
                  Set to the day everyone signed. Change it if the agreement
                  says otherwise.
                </FieldDescription>
              ) : null}
            </Field>
            <Field className="gap-2 text-sm">
              <FieldLabel className={labelClassName} htmlFor={fieldId("end")}>
                End date
              </FieldLabel>
              <Input
                aria-describedby={
                  errors.endDate ? fieldId("end-error") : undefined
                }
                aria-invalid={errors.endDate ? true : undefined}
                disabled={isSaving}
                id={fieldId("end")}
                min={effectiveDate || undefined}
                onChange={(event) => setEndDate(event.target.value)}
                type="date"
                value={endDate}
              />
              {errors.endDate ? (
                <FieldError
                  className={errorClassName}
                  id={fieldId("end-error")}
                >
                  {errors.endDate}
                </FieldError>
              ) : null}
            </Field>
          </div>

          <Field className="gap-2 text-sm">
            <FieldLabel className={labelClassName} htmlFor={fieldId("notice")}>
              Renewal reminder, in days before the end date
            </FieldLabel>
            <Input
              aria-describedby={
                errors.noticeDays
                  ? fieldId("notice-error")
                  : fieldId("notice-description")
              }
              aria-invalid={errors.noticeDays ? true : undefined}
              className="sm:max-w-40"
              disabled={isSaving}
              id={fieldId("notice")}
              inputMode="numeric"
              max={MAX_RENEWAL_NOTICE_DAYS}
              min={0}
              onChange={(event) => setNoticeDays(event.target.value)}
              type="number"
              value={noticeDays}
            />
            {errors.noticeDays ? (
              <FieldError
                className={errorClassName}
                id={fieldId("notice-error")}
              >
                {errors.noticeDays}
              </FieldError>
            ) : (
              <FieldDescription
                className={helperClassName}
                id={fieldId("notice-description")}
              >
                You get one email when this many days are left. It is marked as
                expiring soon from then on.
              </FieldDescription>
            )}
          </Field>

          <Field className="gap-3" orientation="horizontal">
            <Checkbox
              checked={autoRenews}
              disabled={isSaving}
              id={fieldId("auto-renews")}
              onCheckedChange={(checked) => setAutoRenews(checked === true)}
            />
            <FieldLabel
              className="text-sm font-semibold text-(--fg)"
              htmlFor={fieldId("auto-renews")}
            >
              Renews automatically unless cancelled
            </FieldLabel>
          </Field>

          <Field className="gap-2 text-sm">
            <FieldLabel className={labelClassName} htmlFor={fieldId("tags")}>
              Tags
            </FieldLabel>
            <Input
              aria-describedby={fieldId("tags-description")}
              disabled={isSaving}
              id={fieldId("tags")}
              onChange={(event) => setTags(event.target.value)}
              placeholder="NDA, Supplier"
              value={tags}
            />
            <FieldDescription
              className={helperClassName}
              id={fieldId("tags-description")}
            >
              Separate tags with commas.
            </FieldDescription>
          </Field>

          <Field className="gap-2 text-sm">
            <FieldLabel className={labelClassName} htmlFor={fieldId("notes")}>
              Notes
            </FieldLabel>
            <Textarea
              className="min-h-24"
              disabled={isSaving}
              id={fieldId("notes")}
              maxLength={MAX_AGREEMENT_NOTES_LENGTH}
              onChange={(event) => setNotes(event.target.value)}
              value={notes}
            />
          </Field>

          {errorMessage ? (
            <div className="notice notice-danger" role="alert">
              <p>{errorMessage}</p>
            </div>
          ) : null}

          <div className="flex flex-col-reverse gap-3 pt-1 sm:flex-row sm:justify-end">
            <ShellButton
              disabled={isSaving}
              onClick={onCancel}
              variant="secondary"
            >
              Cancel
            </ShellButton>
            <ShellButton loading={isSaving} type="submit">
              {isSaving ? "Saving..." : "Save details"}
            </ShellButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
