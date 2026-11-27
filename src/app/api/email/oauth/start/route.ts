import { NextResponse } from "next/server";
import { z } from "zod";

import {
  actorOf,
  emailErrorResponse,
  readJson,
  requireEmailSession,
} from "@/lib/email/http";
import { startOAuth } from "@/lib/email/oauth";
import { PROVIDER_PRESET_IDS } from "@/lib/email/presets";

// Starts connecting a Google or Microsoft mailbox: returns the provider's
// consent page. Only send permission is asked for, never mailbox reading.

const startSchema = z.object({
  presetId: z.enum(PROVIDER_PRESET_IDS),
  reconnectAccountId: z.string().min(1).max(100).nullish(),
  scope: z.enum(["organization", "personal"]),
});

export async function POST(request: Request) {
  const session = await requireEmailSession(request, {
    json: true,
    mutating: true,
    rateLimit: { limit: 30, name: "oauth_start", windowMs: 60 * 60 * 1000 },
  });

  if (session instanceof Response) {
    return session;
  }

  const parsed = startSchema.safeParse(await readJson(request));

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Choose a provider to connect." },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(await startOAuth(actorOf(session), parsed.data));
  } catch (error) {
    return emailErrorResponse(error, request, {
      fallback: "The connection could not be started.",
      userId: session.user.id,
    });
  }
}
