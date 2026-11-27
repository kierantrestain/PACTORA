"use client";

import { CheckCircle2Icon, CircleIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { cn } from "@/lib/cn";

// The optional Getting Started checklist on the dashboard. Every step is
// worked out from what the workspace already has (src/lib/onboarding.ts),
// every step can be skipped, and the whole list can be dismissed.

type Steps = {
  brandingAdded: boolean;
  emailConnected: boolean;
  firstDocumentCreated: boolean;
  teamInvited: boolean;
  workspaceNamed: boolean;
};

type Step = {
  description: string;
  done: boolean;
  href: string;
  key: string;
  label: string;
};

export function GettingStarted({
  isAdmin,
  steps,
}: {
  isAdmin: boolean;
  steps: Steps;
}) {
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list: Step[] = [
    ...(isAdmin
      ? [
          {
            description: "Shown to signers and on every email.",
            done: steps.workspaceNamed,
            href: "/settings/workspace#workspace-name",
            key: "workspace",
            label: "Name your workspace",
          },
          {
            description: "Your logo and colour on signing pages.",
            done: steps.brandingAdded,
            href: "/settings/branding",
            key: "branding",
            label: "Add your branding",
          },
        ]
      : []),
    {
      description:
        "Optional. Until then, copy signing links from each envelope.",
      done: steps.emailConnected,
      href: "/settings/email#providers",
      key: "email",
      label: "Connect a mailbox",
    },
    {
      description: "Write one in PACTORA or upload a PDF.",
      done: steps.firstDocumentCreated,
      href: "/builder",
      key: "document",
      label: "Create your first document",
    },
    ...(isAdmin
      ? [
          {
            description: "Colleagues get their own sign-in.",
            done: steps.teamInvited,
            href: "/settings/team#invitations",
            key: "team",
            label: "Invite your team",
          },
        ]
      : []),
  ];
  const completed = list.filter((step) => step.done).length;

  if (dismissed || completed === list.length) {
    return null;
  }

  async function dismiss() {
    setDismissed(true);

    const response = await fetch("/api/onboarding", {
      body: JSON.stringify({ dismissed: true }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }).catch(() => null);

    if (!response?.ok) {
      setDismissed(false);
      setError("The checklist could not be hidden. Try again.");
    }
  }

  return (
    <section
      aria-labelledby="getting-started-title"
      className="panel mb-6 space-y-4 p-5 sm:p-6"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2
            className="text-lg font-extrabold tracking-[-0.02em] text-(--fg)"
            id="getting-started-title"
          >
            Getting started
          </h2>
          <p className="text-sm text-(--secondary)">
            {completed} of {list.length} done. Every step is optional.
          </p>
        </div>
        <button
          aria-label="Hide the Getting started checklist"
          className="btn-quiet"
          onClick={() => void dismiss()}
          type="button"
        >
          <XIcon aria-hidden="true" className="size-4" />
          <span className="hidden sm:inline">Hide</span>
        </button>
      </div>
      {error ? (
        <p className="notice notice-danger" role="alert">
          {error}
        </p>
      ) : null}
      <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {list.map((step) => (
          <li key={step.key}>
            <Link
              className={cn(
                "flex h-full gap-3 rounded-2xl border border-(--border) p-3.5 transition hover:border-(--accent) focus-visible:ring-2 focus-visible:ring-(--accent) focus-visible:outline-none",
                step.done ? "bg-(--accent-softer)" : "bg-(--paper)",
              )}
              href={step.href}
            >
              {step.done ? (
                <CheckCircle2Icon
                  aria-hidden="true"
                  className="mt-0.5 size-5 shrink-0 text-(--accent)"
                />
              ) : (
                <CircleIcon
                  aria-hidden="true"
                  className="mt-0.5 size-5 shrink-0 text-(--tertiary)"
                />
              )}
              <span className="min-w-0">
                <span
                  className={cn(
                    "block text-sm font-bold",
                    step.done
                      ? "text-(--secondary) line-through"
                      : "text-(--fg)",
                  )}
                >
                  {step.label}
                  <span className="sr-only">{step.done ? " (done)" : ""}</span>
                </span>
                <span className="block text-xs leading-5 text-(--secondary)">
                  {step.description}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
