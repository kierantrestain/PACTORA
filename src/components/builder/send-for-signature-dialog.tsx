"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { ShellButton } from "@/components/shared/form-shell";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { BuilderRole } from "@/lib/document-builder/model";

type Recipient = { email: string; name: string };

export function SendForSignatureDialog({
  currentUser,
  documentId,
  flush,
  onClose,
  problems,
  roles,
}: {
  currentUser: { email: string; name: string };
  documentId: string;
  flush: () => Promise<boolean>;
  onClose: () => void;
  problems: string[];
  roles: BuilderRole[];
}) {
  const router = useRouter();
  const [recipients, setRecipients] = useState<Record<string, Recipient>>(() =>
    Object.fromEntries(roles.map((role) => [role.id, { email: "", name: "" }])),
  );
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (isSubmitting) {
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      await flush();

      const response = await fetch(
        `/api/builder/documents/${documentId}/envelope`,
        {
          body: JSON.stringify({
            recipients: roles.map((role) => ({
              email: recipients[role.id]?.email.trim() ?? "",
              name: recipients[role.id]?.name.trim() ?? "",
              roleId: role.id,
            })),
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        redirectPath?: string;
      } | null;

      if (!response.ok || !payload?.redirectPath) {
        setError(payload?.error ?? "The envelope could not be prepared.");
        setIsSubmitting(false);

        return;
      }

      router.push(payload.redirectPath);
    } catch {
      setError("The envelope could not be prepared. Check your connection.");
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !isSubmitting) {
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-lg sm:p-8">
        <form
          className="space-y-5"
          onSubmit={(event) => void handleSubmit(event)}
        >
          <DialogHeader className="space-y-2">
            <DialogTitle>Who signs?</DialogTitle>
            <DialogDescription>
              PACTORA makes a PDF of this document and a draft envelope with
              every field in place. You check it and send it on the next screen.
            </DialogDescription>
          </DialogHeader>

          {problems.length > 0 ? (
            <div
              className="rounded-xl bg-(--warning-soft) px-4 py-3 text-sm leading-6 text-(--warning)"
              role="alert"
            >
              <p className="font-bold">Fix these first:</p>
              <ul className="list-disc pl-5">
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <ol className="space-y-4">
            {roles.map((role, index) => (
              <li className="well space-y-3 p-4" key={role.id}>
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-extrabold text-(--fg)">
                    {index + 1}. {role.name}
                  </p>
                  <button
                    className="text-sm font-semibold text-(--accent-ink) hover:underline"
                    onClick={() =>
                      setRecipients((current) => ({
                        ...current,
                        [role.id]: {
                          email: currentUser.email,
                          name: currentUser.name,
                        },
                      }))
                    }
                    type="button"
                  >
                    That&rsquo;s me
                  </button>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1 text-xs font-semibold text-(--secondary)">
                    <span className="block">Full name</span>
                    <input
                      autoComplete="off"
                      className="field-input min-h-11"
                      maxLength={120}
                      onChange={(event) =>
                        setRecipients((current) => ({
                          ...current,
                          [role.id]: {
                            ...current[role.id]!,
                            name: event.target.value,
                          },
                        }))
                      }
                      required
                      value={recipients[role.id]?.name ?? ""}
                    />
                  </label>
                  <label className="space-y-1 text-xs font-semibold text-(--secondary)">
                    <span className="block">Email</span>
                    <input
                      autoComplete="off"
                      className="field-input min-h-11"
                      maxLength={320}
                      onChange={(event) =>
                        setRecipients((current) => ({
                          ...current,
                          [role.id]: {
                            ...current[role.id]!,
                            email: event.target.value,
                          },
                        }))
                      }
                      required
                      type="email"
                      value={recipients[role.id]?.email ?? ""}
                    />
                  </label>
                </div>
              </li>
            ))}
          </ol>

          {error ? (
            <p
              className="rounded-xl bg-(--danger-soft) px-4 py-3 text-sm font-semibold text-(--danger)"
              role="alert"
            >
              {error}
            </p>
          ) : null}

          <div className="flex flex-wrap justify-end gap-2">
            <ShellButton
              disabled={isSubmitting}
              onClick={onClose}
              variant="secondary"
            >
              Cancel
            </ShellButton>
            <ShellButton
              disabled={problems.length > 0}
              loading={isSubmitting}
              type="submit"
            >
              Prepare envelope
            </ShellButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
