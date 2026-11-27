import { NextResponse } from "next/server";

import { updateAccount } from "@/lib/email/accounts";
import {
  actorOf,
  emailErrorResponse,
  readJson,
  requireEmailSession,
} from "@/lib/email/http";
import { disconnectAccount, settleConnectedAccount } from "@/lib/email/service";

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Context) {
  const session = await requireEmailSession(request, {
    json: true,
    mutating: true,
    rateLimit: { limit: 60, name: "account_update", windowMs: 60 * 60 * 1000 },
  });

  if (session instanceof Response) {
    return session;
  }

  const { id } = await context.params;

  try {
    const account = await updateAccount(
      actorOf(session),
      id,
      await readJson(request),
    );

    await settleConnectedAccount(actorOf(session), account.id);

    return NextResponse.json({ account });
  } catch (error) {
    return emailErrorResponse(error, request, {
      fallback: "The email account could not be saved.",
      userId: session.user.id,
    });
  }
}

export async function DELETE(request: Request, context: Context) {
  const session = await requireEmailSession(request, { mutating: true });

  if (session instanceof Response) {
    return session;
  }

  const { id } = await context.params;

  try {
    const result = await disconnectAccount(actorOf(session), id);

    return NextResponse.json(result);
  } catch (error) {
    return emailErrorResponse(error, request, {
      fallback: "The email account could not be disconnected.",
      userId: session.user.id,
    });
  }
}
