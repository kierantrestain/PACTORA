import { NextResponse } from "next/server";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { getDb } from "@/lib/db/connection";
import {
  builderErrorResponse,
  readJson,
} from "@/lib/document-builder/route-helpers";
import { createEnvelopeFromBuilderDocument } from "@/lib/document-builder/store";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";

type RouteContext = { params: Promise<{ id: string }> };

// Turns the document into a draft envelope with its signers and fields in
// place. Sending still happens on the envelope's review step.
export async function POST(request: Request, context: RouteContext) {
  const session = await requireVerifiedSenderSession(request);

  if (session instanceof Response) {
    return session;
  }

  const limited = await applyRateLimit({
    category: "draft_envelope_create",
    key: buildRateLimitKey(["draft-create", session.user.id]),
    limit: 20,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (limited) {
    return limited;
  }

  const { id } = await context.params;

  try {
    const result = await createEnvelopeFromBuilderDocument(
      session.user.id,
      id,
      await readJson(request),
      { database: getDb() },
    );

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return builderErrorResponse(
      error,
      request,
      session.user.id,
      "prepare the envelope",
    );
  }
}
