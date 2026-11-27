"use client";

import { useEffect, useState } from "react";

import { ShellButton } from "@/components/shared/form-shell";
import type { EmailDnsRecord, EmailStatus } from "@/lib/email-status";

// Advanced Administration: the deployment-wide Resend sending domain, its
// DNS records and the environment it depends on. Most workspaces never need
// this: people connect their own mailbox under Email & Integrations.

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";
const RESEND_DOMAINS_URL = "https://resend.com/domains";
const RESEND_MARKETPLACE_URL = "https://vercel.com/marketplace/resend";

type Feedback = {
  message: string;
  tone: "error" | "success";
} | null;

type EmailResponse = {
  error?: string;
  status?: EmailStatus;
  test?: { sent: true; to: string } | { sent: false; message: string };
} | null;

type EmailAction = "add_domain" | "recheck" | "send_test";

async function fetchEmailStatus(
  signal: AbortSignal,
): Promise<{ error: string; status: null } | { status: EmailStatus }> {
  const response = await fetch("/api/admin/email", { signal });
  const payload = (await response.json().catch(() => null)) as EmailResponse;

  if (!response.ok || !payload?.status) {
    return { error: payload?.error ?? GENERIC_ERROR_MESSAGE, status: null };
  }

  return { status: payload.status };
}

export function EmailSetupPanel() {
  const [status, setStatus] = useState<EmailStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<EmailAction | null>(null);
  const [testResult, setTestResult] = useState<Feedback>(null);

  useEffect(() => {
    const controller = new AbortController();

    fetchEmailStatus(controller.signal)
      .then((result) => {
        if (result.status) {
          setLoadError(null);
          setStatus(result.status);
        } else {
          setLoadError(result.error);
        }
      })
      .catch((error: unknown) => {
        // Leaving the page cancels the request; that is not a failure.
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setLoadError(GENERIC_ERROR_MESSAGE);
        }
      });

    return () => controller.abort();
  }, []);

  async function runAction(action: EmailAction) {
    if (pendingAction) {
      return;
    }

    setPendingAction(action);
    setTestResult(null);

    try {
      const response = await fetch("/api/admin/email", {
        body: JSON.stringify({ action }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response
        .json()
        .catch(() => null)) as EmailResponse;

      if (payload?.status) {
        setLoadError(null);
        setStatus(payload.status);
      }

      if (payload?.test) {
        setTestResult(
          payload.test.sent
            ? {
                message: `Test email sent to ${payload.test.to}. Check that inbox.`,
                tone: "success",
              }
            : { message: payload.test.message, tone: "error" },
        );
      } else if (!response.ok) {
        setLoadError(payload?.error ?? GENERIC_ERROR_MESSAGE);
      }
    } catch {
      setLoadError(GENERIC_ERROR_MESSAGE);
    } finally {
      setPendingAction(null);
    }
  }

  const summary = status ? describeEmailStatus(status) : null;
  const canSendTest =
    status !== null &&
    status.state !== "missing_key" &&
    status.state !== "capture" &&
    status.state !== "capture_refused";

  return (
    <div className="space-y-5">
      {loadError ? (
        <p className="notice notice-danger" role="alert">
          {loadError}
        </p>
      ) : null}

      {!summary ? (
        loadError ? null : (
          <p className="text-sm text-(--secondary)">Checking email…</p>
        )
      ) : (
        <div
          className={`space-y-2 rounded-2xl px-5 py-4 ${
            summary.ready ? "bg-(--success-soft)" : "bg-(--surface)"
          }`}
          data-email-state={status?.state}
        >
          <p className="text-sm font-bold text-(--fg)">{summary.title}</p>
          {summary.lines.map((line) => (
            <p className="text-sm leading-6 text-(--secondary)" key={line}>
              {line}
            </p>
          ))}
          {summary.steps ? (
            <ol className="list-decimal space-y-2 pl-5 text-sm leading-6 text-(--secondary) marker:font-semibold marker:text-(--fg)">
              {summary.steps.map((step) => (
                <li key={step.text}>
                  {step.text}
                  {step.link ? (
                    <>
                      {" "}
                      <a
                        className="font-semibold text-(--accent-ink) underline underline-offset-4"
                        href={step.link.href}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {step.link.label}
                      </a>
                    </>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      )}

      {status?.state === "domain_pending" ? (
        <DnsRecordsTable domain={status.domain} records={status.records} />
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
        {status?.state === "domain_missing" ? (
          <ShellButton
            disabled={pendingAction !== null}
            loading={pendingAction === "add_domain"}
            onClick={() => void runAction("add_domain")}
          >
            {pendingAction === "add_domain"
              ? "Adding..."
              : `Set up ${status.domain}`}
          </ShellButton>
        ) : null}
        {status?.state === "domain_pending" ? (
          <ShellButton
            disabled={pendingAction !== null}
            loading={pendingAction === "recheck"}
            onClick={() => void runAction("recheck")}
          >
            {pendingAction === "recheck" ? "Checking..." : "Check DNS records"}
          </ShellButton>
        ) : null}
        {canSendTest ? (
          <ShellButton
            disabled={pendingAction !== null}
            loading={pendingAction === "send_test"}
            onClick={() => void runAction("send_test")}
            variant="secondary"
          >
            {pendingAction === "send_test"
              ? "Sending..."
              : "Send me a test email"}
          </ShellButton>
        ) : null}
        {status?.state === "restricted_key" ||
        status?.state === "error" ||
        status?.state === "test_sender" ? (
          <ShellButton href={RESEND_DOMAINS_URL} variant="ghost">
            Open Resend
          </ShellButton>
        ) : null}
      </div>

      {testResult ? (
        <p
          className={`notice ${
            testResult.tone === "success" ? "notice-success" : "notice-danger"
          }`}
          role={testResult.tone === "error" ? "alert" : "status"}
        >
          {testResult.message}
        </p>
      ) : null}
    </div>
  );
}

type EmailStep = {
  link?: { href: string; label: string };
  text: string;
};

function describeEmailStatus(status: EmailStatus): {
  lines: string[];
  ready: boolean;
  steps?: EmailStep[];
  title: string;
} {
  switch (status.state) {
    case "capture":
      return {
        lines: [
          "This is a development setup. Emails are saved to a folder on this machine instead of being sent.",
        ],
        ready: true,
        title: "Emails are being captured, not sent",
      };
    case "capture_refused":
      return status.onVercel
        ? {
            lines: [
              "EMAIL_DRIVER=capture drops every email and cannot be used in production, so this site refuses to send anything: no sign-up confirmations and no signing invitations.",
            ],
            ready: false,
            steps: [
              {
                text: "In this project on Vercel, open Settings, then Environment Variables, and remove EMAIL_DRIVER (or set it to resend).",
              },
              {
                link: {
                  href: RESEND_MARKETPLACE_URL,
                  label: "Resend on the Vercel Marketplace",
                },
                text: "Connect Resend and check that RESEND_API_KEY is listed for Production.",
              },
              {
                text: "Open Deployments, open the ••• menu on the latest Production deployment and choose Redeploy, then reload this page.",
              },
            ],
            title: "Email cannot be sent with EMAIL_DRIVER=capture",
          }
        : {
            lines: [
              "EMAIL_DRIVER=capture drops every email and cannot be used in production, so this site refuses to send anything: no sign-up confirmations and no signing invitations.",
            ],
            ready: false,
            steps: [
              {
                text: "Remove EMAIL_DRIVER=capture from the environment variables where this site runs (or set EMAIL_DRIVER=resend).",
              },
              {
                link: {
                  href: "https://resend.com/api-keys",
                  label: "Resend API keys",
                },
                text: "Configure a delivery provider by setting RESEND_API_KEY if it is not set already.",
              },
              { text: "Restart the app, then reload this page." },
            ],
            title: "Email cannot be sent with EMAIL_DRIVER=capture",
          };
    case "missing_key":
      return status.onVercel
        ? {
            lines: [
              "This site has no Resend API key, so it cannot send anything: no sign-up confirmations and no signing invitations.",
            ],
            ready: false,
            steps: [
              {
                link: {
                  href: RESEND_MARKETPLACE_URL,
                  label: "Resend on the Vercel Marketplace",
                },
                text: "Open Resend on the Vercel Marketplace. Choose Install (or Connect Project if your team already has Resend) and connect it to this project.",
              },
              {
                text: "In this project on Vercel, open Settings, then Environment Variables, and check that RESEND_API_KEY is listed for Production.",
              },
              {
                text: "Open Deployments, open the ••• menu on the latest Production deployment and choose Redeploy. Environment variables only reach deployments made after they were added, so a site deployed before Resend was connected still has no key until it is redeployed.",
              },
              {
                text: "When the new deployment is ready, reload this page.",
              },
            ],
            title: "Email is not connected",
          }
        : {
            lines: [
              "This site has no Resend API key, so it cannot send anything: no sign-up confirmations and no signing invitations.",
            ],
            ready: false,
            steps: [
              {
                link: {
                  href: "https://resend.com/api-keys",
                  label: "Resend API keys",
                },
                text: "Create an API key in Resend with full access, so this page can add your domain and check its DNS records.",
              },
              {
                text: "Set it as the RESEND_API_KEY environment variable where this site runs.",
              },
              { text: "Restart the app, then reload this page." },
            ],
            title: "Email is not connected",
          };
    case "test_sender":
      return {
        lines: [
          `Emails are going out from Resend's shared test address (${status.senderAddress}). Resend only delivers those to the owner of the Resend account, so signers and new users will not receive anything yet.`,
          'Enter an address at your own domain in "Send email from" above and save. The DNS records to add will appear here.',
        ],
        ready: false,
        title: "Email only reaches you so far",
      };
    case "domain_missing":
      return {
        lines: [
          `${status.domain} has not been added to your Resend account yet. Set it up here to get the DNS records that prove you own it.`,
        ],
        ready: false,
        title: `${status.domain} needs to be set up`,
      };
    case "domain_pending":
      return {
        lines: [
          `Add these records where ${status.domain}'s DNS is managed, then check them. DNS changes can take a few minutes to be seen, and sometimes longer.`,
          ...(status.mayAlreadySend
            ? [
                "Resend has verified part of this domain, so sending may already work. Send yourself a test email to find out. If it arrives, email is working.",
              ]
            : []),
        ],
        ready: false,
        title: `Waiting for ${status.domain}'s DNS records`,
      };
    case "restricted_key":
      return {
        lines: [
          `This site's Resend key is only allowed to send email, so it cannot check ${status.domain} from here. Open Resend to add the domain and see its DNS records.`,
          "When that is done, send yourself a test email. If it arrives, email is working.",
        ],
        ready: false,
        title: "Finish the domain in Resend",
      };
    case "ready":
      return {
        lines: [
          `Emails are sent from ${status.senderAddress}, and ${status.domain} is verified.`,
        ],
        ready: true,
        title: "Email is working",
      };
    case "error":
      return {
        lines: [
          `Resend could not be asked about this site's email: ${status.message}`,
        ],
        ready: false,
        title: "Email could not be checked",
      };
  }
}

function DnsRecordsTable({
  domain,
  records,
}: {
  domain: string;
  records: readonly EmailDnsRecord[];
}) {
  if (records.length === 0) {
    return (
      <p className="text-sm leading-6 text-(--secondary)">
        Resend did not list any records for {domain}. Open Resend to see them.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-2xl border border-(--border)">
      <table className="w-full min-w-[640px] border-collapse text-left text-sm">
        <caption className="sr-only">DNS records to add for {domain}</caption>
        <thead>
          <tr className="border-b border-(--border) bg-(--surface) text-xs text-(--tertiary)">
            <th className="px-4 py-3 font-semibold" scope="col">
              Type
            </th>
            <th className="px-4 py-3 font-semibold" scope="col">
              Name
            </th>
            <th className="px-4 py-3 font-semibold" scope="col">
              Value
            </th>
            <th className="px-4 py-3 font-semibold" scope="col">
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {records.map((record) => (
            <tr
              className="border-b border-(--border) align-top last:border-b-0"
              key={`${record.type}-${record.name}-${record.value}`}
            >
              <td className="px-4 py-3 font-semibold text-(--fg)">
                {record.type}
                {record.priority !== null ? (
                  <span className="block text-xs font-normal text-(--tertiary)">
                    Priority {record.priority}
                  </span>
                ) : null}
              </td>
              <td className="px-4 py-3 font-mono text-[0.8rem] break-all text-(--fg)">
                {record.name}
              </td>
              <td className="px-4 py-3 font-mono text-[0.8rem] break-all text-(--fg)">
                {record.value}
              </td>
              <td className="px-4 py-3 text-(--secondary)">
                {record.status === "verified" ? "Found" : "Not found yet"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
