import { NextResponse } from "next/server";

import { listAgreementsForUser } from "@/lib/agreements";
import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { getDb } from "@/lib/db/connection";
import { parseAgreementListFilters } from "@/lib/schemas/agreement";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";

const noStore = { "cache-control": "private, no-store" };

// The completed envelopes this person may see, as agreements, one page at
// a time, with the figures for the whole view. Query parameters: q, tag,
// state (active, expiring, expired, no_end_date), within (days, with
// state=expiring), view (mine, team, all), envelope, cursor, limit.
export async function GET(request: Request) {
  const sessionResult = await requireVerifiedSenderSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const session = sessionResult;
  const rateLimitResponse = await applyRateLimit({
    category: "agreement_list",
    key: buildRateLimitKey(["agreement-list", session.user.id]),
    limit: 120,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (rateLimitResponse) {
    rateLimitResponse.headers.set("cache-control", "private, no-store");
    return rateLimitResponse;
  }

  try {
    const result = await listAgreementsForUser(
      session.user.id,
      parseAgreementListFilters(new URL(request.url).searchParams),
      getDb(),
    );

    return NextResponse.json(
      {
        agreements: result.agreements,
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        summary: result.summary,
        tags: result.tags,
        view: result.view,
      },
      { headers: noStore, status: 200 },
    );
  } catch (error) {
    logRouteError(error, {
      category: "agreement_list_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while listing agreements.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "Unable to load agreements." },
      { headers: noStore, status: 500 },
    );
  }
}
