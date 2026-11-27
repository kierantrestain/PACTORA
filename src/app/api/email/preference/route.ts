import { NextResponse } from "next/server";
import { z } from "zod";

import { setPreferredAccount } from "@/lib/email/accounts";
import {
  emailErrorResponse,
  readJson,
  requireEmailSession,
} from "@/lib/email/http";

// The mailbox this person's agreements go out through.

const preferenceSchema = z.object({
  accountId: z.string().min(1).max(100).nullable(),
});

export async function PUT(request: Request) {
  const session = await requireEmailSession(request, {
    json: true,
    mutating: true,
  });

  if (session instanceof Response) {
    return session;
  }

  const parsed = preferenceSchema.safeParse(await readJson(request));

  if (!parsed.success) {
    return NextResponse.json({ error: "Choose a mailbox." }, { status: 400 });
  }

  try {
    await setPreferredAccount(session.user.id, parsed.data.accountId);

    return NextResponse.json({ preferredAccountId: parsed.data.accountId });
  } catch (error) {
    return emailErrorResponse(error, request, {
      fallback: "The mailbox choice could not be saved.",
      userId: session.user.id,
    });
  }
}
