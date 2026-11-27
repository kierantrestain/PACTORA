"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ShellButton } from "@/components/shared/form-shell";
import { PageHeader } from "@/components/shared/page-header";
import { StatusPanel } from "@/components/shared/status-panel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { BuilderDocumentSummary } from "@/lib/document-builder/store";

type StarterCard = {
  category: string;
  description: string;
  id: string;
  roleNames: string[];
  title: string;
};

type BuilderLibraryShellProps = {
  documents: readonly BuilderDocumentSummary[];
  initialState?: "error";
  starters: readonly StarterCard[];
};

const pageDescription =
  "Write an agreement here instead of uploading a PDF. Signature fields go where the signature blocks are, so it is ready to send.";

const envelopeStatusLabels: Record<string, string> = {
  completed: "Signed",
  declined: "Declined",
  draft: "Envelope drafted",
  expired: "Expired",
  sent: "Out for signature",
  voided: "Voided",
};

function statusPill(document: BuilderDocumentSummary) {
  if (document.isTemplate) {
    return <span className="pill pill-accent">Template</span>;
  }

  if (!document.envelopeStatus) {
    return <span className="pill pill-neutral">Draft</span>;
  }

  const tone =
    document.envelopeStatus === "completed"
      ? "pill-success"
      : document.envelopeStatus === "declined" ||
          document.envelopeStatus === "voided"
        ? "pill-danger"
        : "pill-warning";

  return (
    <span className={`pill ${tone}`}>
      {envelopeStatusLabels[document.envelopeStatus] ?? document.envelopeStatus}
    </span>
  );
}

function updatedLabel(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function BuilderLibraryShell({
  documents,
  initialState,
  starters,
}: BuilderLibraryShellProps) {
  const router = useRouter();
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] =
    useState<BuilderDocumentSummary | null>(null);
  const templates = documents.filter((document) => document.isTemplate);
  const drafts = documents.filter((document) => !document.isTemplate);

  async function create(key: string, body: Record<string, unknown>) {
    if (pendingKey) {
      return;
    }

    setPendingKey(key);
    setError(null);

    try {
      const response = await fetch("/api/builder/documents", {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        redirectPath?: string;
      } | null;

      if (!response.ok || !payload?.redirectPath) {
        setError(payload?.error ?? "The document could not be created.");
        setPendingKey(null);

        return;
      }

      router.push(payload.redirectPath);
    } catch {
      setError("The document could not be created. Check your connection.");
      setPendingKey(null);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) {
      return;
    }

    setPendingKey(`delete-${pendingDelete.id}`);

    try {
      const response = await fetch(
        `/api/builder/documents/${pendingDelete.id}`,
        { method: "DELETE" },
      );

      if (!response.ok && response.status !== 404) {
        setError("The document could not be deleted.");
      }
    } catch {
      setError("The document could not be deleted.");
    } finally {
      setPendingKey(null);
      setPendingDelete(null);
      router.refresh();
    }
  }

  if (initialState === "error") {
    return (
      <div className="space-y-5">
        <PageHeader description={pageDescription} title="Create a document" />
        <StatusPanel
          action={{ href: "/builder", label: "Retry" }}
          description="We couldn't load your documents. Try again in a moment."
          title="Couldn't load documents"
          tone="error"
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader description={pageDescription} title="Create a document" />

      {error ? (
        <p
          className="rounded-xl bg-(--danger-soft) px-4 py-3 text-sm font-semibold text-(--danger)"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      <section
        aria-labelledby="builder-start-heading"
        className="panel p-5 sm:p-7"
        data-animate="enter"
        data-animate-delay="1"
      >
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div className="space-y-1">
            <h2
              className="text-lg font-extrabold text-(--fg)"
              id="builder-start-heading"
            >
              Start from
            </h2>
            <p className="text-sm leading-6 text-(--secondary)">
              Starting points to edit, not legal advice. Have your own counsel
              review terms before you rely on them.
            </p>
          </div>
        </div>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <li className="well flex flex-col gap-3 p-4 sm:p-5">
            <div className="space-y-1.5">
              <p className="section-eyebrow">Blank</p>
              <h3 className="text-[1.0625rem] font-extrabold text-(--fg)">
                Empty document
              </h3>
              <p className="text-sm leading-6 text-(--secondary)">
                A title, one signer role and nothing else.
              </p>
            </div>
            <div className="mt-auto">
              <ShellButton
                className="min-h-11"
                loading={pendingKey === "blank"}
                onClick={() => void create("blank", {})}
                variant="secondary"
              >
                Start blank
              </ShellButton>
            </div>
          </li>
          {starters.map((starter) => (
            <li
              className="well flex flex-col gap-3 p-4 sm:p-5"
              key={starter.id}
            >
              <div className="space-y-1.5">
                <p className="section-eyebrow">{starter.category}</p>
                <h3 className="text-[1.0625rem] font-extrabold text-(--fg)">
                  {starter.title}
                </h3>
                <p className="text-sm leading-6 text-(--secondary)">
                  {starter.description}
                </p>
                <p className="text-xs font-semibold text-(--tertiary)">
                  Signed by {starter.roleNames.join(" and ")}
                </p>
              </div>
              <div className="mt-auto">
                <ShellButton
                  className="min-h-11"
                  loading={pendingKey === starter.id}
                  onClick={() =>
                    void create(starter.id, { starterId: starter.id })
                  }
                  variant="secondary"
                >
                  Use this
                </ShellButton>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {templates.length > 0 ? (
        <section
          aria-labelledby="builder-templates-heading"
          className="panel p-5 sm:p-7"
        >
          <h2
            className="mb-4 text-lg font-extrabold text-(--fg)"
            id="builder-templates-heading"
          >
            Your templates
          </h2>
          <DocumentList
            documents={templates}
            onDelete={setPendingDelete}
            onUse={(document) =>
              void create(`use-${document.id}`, { sourceId: document.id })
            }
            pendingKey={pendingKey}
          />
        </section>
      ) : null}

      <section
        aria-labelledby="builder-documents-heading"
        className="panel p-5 sm:p-7"
      >
        <h2
          className="mb-4 text-lg font-extrabold text-(--fg)"
          id="builder-documents-heading"
        >
          Your documents
        </h2>
        {drafts.length === 0 ? (
          <p className="text-sm leading-6 text-(--secondary)">
            Documents you create appear here. Each one keeps its own history of
            envelopes.
          </p>
        ) : (
          <DocumentList
            documents={drafts}
            onDelete={setPendingDelete}
            pendingKey={pendingKey}
          />
        )}
      </section>

      {pendingDelete ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setPendingDelete(null);
            }
          }}
        >
          <DialogContent className="max-w-md sm:p-8" showCloseButton={false}>
            <div className="space-y-4">
              <DialogHeader className="space-y-3">
                <DialogTitle>Delete this document?</DialogTitle>
                <DialogDescription asChild>
                  <div className="space-y-2 text-sm leading-6 text-(--secondary)">
                    <p>
                      &ldquo;{pendingDelete.title}&rdquo; will be removed for
                      good.
                    </p>
                    <p>Envelopes already made from it are not affected.</p>
                  </div>
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-wrap justify-end gap-2">
                <ShellButton
                  onClick={() => setPendingDelete(null)}
                  variant="secondary"
                >
                  Keep it
                </ShellButton>
                <ShellButton
                  loading={pendingKey === `delete-${pendingDelete.id}`}
                  onClick={() => void confirmDelete()}
                  variant="danger"
                >
                  Delete
                </ShellButton>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

function DocumentList({
  documents,
  onDelete,
  onUse,
  pendingKey,
}: {
  documents: readonly BuilderDocumentSummary[];
  onDelete: (document: BuilderDocumentSummary) => void;
  onUse?: (document: BuilderDocumentSummary) => void;
  pendingKey: string | null;
}) {
  return (
    <ul className="space-y-3">
      {documents.map((document) => (
        <li
          className="well flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5"
          key={document.id}
        >
          <div className="min-w-0 space-y-1.5">
            <h3 className="truncate text-[1.0625rem] font-extrabold text-(--fg)">
              {document.title}
            </h3>
            <div className="flex flex-wrap items-center gap-2 text-sm text-(--secondary)">
              {statusPill(document)}
              <span>Edited {updatedLabel(document.updatedAt)}</span>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <button
              aria-label={`Delete ${document.title}`}
              className="btn-quiet btn-quiet-danger min-h-11 px-4"
              onClick={() => onDelete(document)}
              type="button"
            >
              Delete
            </button>
            {document.envelopeId ? (
              <ShellButton
                className="min-h-11"
                href={`/envelopes/${document.envelopeId}`}
                variant="secondary"
              >
                View envelope
              </ShellButton>
            ) : null}
            <ShellButton
              className="min-h-11"
              href={`/builder/${document.id}`}
              variant={onUse ? "secondary" : "primary"}
            >
              Edit
            </ShellButton>
            {onUse ? (
              <ShellButton
                className="min-h-11"
                loading={pendingKey === `use-${document.id}`}
                onClick={() => onUse(document)}
              >
                Use template
              </ShellButton>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
