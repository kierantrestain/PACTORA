import { NextResponse } from "next/server";

import { loadUsableAccount } from "@/lib/email/accounts";
import { EmailDeliveryQueuedError } from "@/lib/email/engine";
import {
  actorOf,
  emailErrorResponse,
  requireEmailSession,
} from "@/lib/email/http";
import { buildAccountTestMessage } from "@/lib/email/service";
import { EmailTransportError } from "@/lib/email/types";
import { createEmailService } from "@/lib/services/email";

// Sends a test message through one mailbox to the person asking. The
// answer is the provider's own: success only when it accepted the message.

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  const session = await requireEmailSession(request, {
    mutating: true,
    rateLimit: { limit: 10, name: "account_test", windowMs: 60 * 60 * 1000 },
  });

  if (session instanceof Response) {
    return session;
  }

  const { id } = await context.params;

  if (!(await loadUsableAccount(session.user.id, id))) {
    return NextResponse.json(
      { error: "That email account no longer exists." },
      { status: 404 },
    );
  }

  try {
    await createEmailService({ routed: true }).send(
      await buildAccountTestMessage(actorOf(session), id),
    );

    return NextResponse.json({ sent: true, to: session.user.email });
  } catch (error) {
    if (
      error instanceof EmailTransportError ||
      error instanceof EmailDeliveryQueuedError
    ) {
      return NextResponse.json(
        { error: error.message, sent: false },
        { status: 502 },
      );
    }

    return emailErrorResponse(error, request, {
      fallback: "The test email could not be sent.",
      userId: session.user.id,
    });
  }
}
