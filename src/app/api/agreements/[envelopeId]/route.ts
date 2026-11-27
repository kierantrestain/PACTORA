import { NextResponse } from "next/server";

import { AgreementError, updateAgreementRecord } from "@/lib/agreements";
import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { getDb } from "@/lib/db/connection";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";

type AgreementRouteContext = {
  params: Promise<{
    envelopeId: string;
  }>;
};

const noStore = { "cache-control": "private, no-store" };
/** Notes are the longest field, at 4,000 characters. */
const MAX_BODY_BYTES = 32 * 1024;

// Saves the agreement details of a completed envelope, for its sender.
// Fields left out keep their value; an empty text or date, or null, clears
// it. Answers with the agreement as the list shows it.
export async function PATCH(request: Request, context: AgreementRouteContext) {
  const sessionResult = await requireVerifiedSenderSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const session = sessionResult;
  const { envelopeId } = await context.params;
  const ipAddress = getClientIpAddress(request.headers);
  const rateLimitResponse = await applyRateLimit({
    category: "agreement_update",
    key: buildRateLimitKey(["agreement-update", session.user.id]),
    limit: 60,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (rateLimitResponse) {
    rateLimitResponse.headers.set("cache-control", "private, no-store");
    return rateLimitResponse;
  }

  const body = await request.text().catch(() => null);
  let input: unknown = null;

  try {
    input =
      body !== null && body.length <= MAX_BODY_BYTES
        ? (JSON.parse(body) as unknown)
        : null;
  } catch {
    input = null;
  }

  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return NextResponse.json(
      { error: "Send the agreement details as a JSON object." },
      { headers: noStore, status: 400 },
    );
  }

  try {
    const agreement = await updateAgreementRecord(
      session.user.id,
      envelopeId,
      input,
      getDb(),
    );

    return NextResponse.json({ agreement }, { headers: noStore, status: 200 });
  } catch (error) {
    if (error instanceof AgreementError) {
      return NextResponse.json(
        { error: error.message },
        { headers: noStore, status: error.statusCode },
      );
    }

    logRouteError(error, {
      category: "agreement_update_failure",
      ipAddress,
      message: "Unexpected failure while saving agreement details.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "Unable to save the agreement details." },
      { headers: noStore, status: 500 },
    );
  }
}
