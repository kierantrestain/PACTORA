import { NextResponse } from "next/server";

import { createAccount, listVisibleAccounts } from "@/lib/email/accounts";
import {
  actorOf,
  emailErrorResponse,
  readJson,
  requireEmailSession,
} from "@/lib/email/http";
import { settleConnectedAccount } from "@/lib/email/service";
import { canSendEmail } from "@/lib/services/email";
import { readEnv } from "@/lib/utils/env";

// The mailboxes this person can see, and connecting an SMTP or Resend one.
// Google and Microsoft connect through /api/email/oauth/start instead.

function platformSenderDescription(): string {
  if (
    readEnv(process.env, "EMAIL_DRIVER")?.toLowerCase() === "capture" &&
    canSendEmail()
  ) {
    return "Development outbox: messages are saved to .data/outbox, not sent.";
  }

  if (readEnv(process.env, "PLATFORM_SMTP_URL")) {
    return "The server's own SMTP relay (PLATFORM_SMTP_URL).";
  }

  if (readEnv(process.env, "RESEND_API_KEY")) {
    return "The server's Resend account (RESEND_API_KEY).";
  }

  return "The organisation's default mailbox, when one is connected.";
}

export async function GET(request: Request) {
  const session = await requireEmailSession(request);

  if (session instanceof Response) {
    return session;
  }

  try {
    const visible = await listVisibleAccounts(session.user.id);
    const defaultAccount =
      visible.accounts.find((account) => account.isDefault) ?? null;

    return NextResponse.json({
      ...visible,
      platformSender: {
        accountId: defaultAccount?.id ?? null,
        description: platformSenderDescription(),
      },
    });
  } catch (error) {
    return emailErrorResponse(error, request, {
      fallback: "The email accounts could not be loaded.",
      userId: session.user.id,
    });
  }
}

export async function POST(request: Request) {
  const session = await requireEmailSession(request, {
    json: true,
    mutating: true,
    rateLimit: { limit: 20, name: "account_create", windowMs: 60 * 60 * 1000 },
  });

  if (session instanceof Response) {
    return session;
  }

  try {
    const account = await createAccount(
      actorOf(session),
      await readJson(request),
    );

    await settleConnectedAccount(actorOf(session), account.id);

    return NextResponse.json({ account }, { status: 201 });
  } catch (error) {
    return emailErrorResponse(error, request, {
      fallback: "The email account could not be connected.",
      userId: session.user.id,
    });
  }
}
