import { NextResponse } from "next/server";

import {
  agreementsCsvFileName,
  buildAgreementsCsv,
  listAgreementsForExport,
  utcDateFromUnix,
} from "@/lib/agreements";
import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { getDb } from "@/lib/db/connection";
import { parseAgreementListFilters } from "@/lib/schemas/agreement";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import { buildContentDisposition } from "@/lib/services/storage";

// The agreements that match the same filters as the list, as a CSV file.
// The list's page and limit do not apply: every match is in the file, up to
// MAX_AGREEMENT_EXPORT_ROWS.
export async function GET(request: Request) {
  const sessionResult = await requireVerifiedSenderSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const session = sessionResult;
  const rateLimitResponse = await applyRateLimit({
    category: "agreement_export",
    key: buildRateLimitKey(["agreement-export", session.user.id]),
    limit: 20,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (rateLimitResponse) {
    rateLimitResponse.headers.set("cache-control", "private, no-store");
    return rateLimitResponse;
  }

  try {
    const now = Math.floor(Date.now() / 1000);
    const { agreements } = await listAgreementsForExport(
      session.user.id,
      parseAgreementListFilters(new URL(request.url).searchParams),
      getDb(),
      { now },
    );

    return new Response(buildAgreementsCsv(agreements), {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": buildContentDisposition(
          agreementsCsvFileName(utcDateFromUnix(now)),
        ),
        "content-type": "text/csv; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    logRouteError(error, {
      category: "agreement_export_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while exporting agreements.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "The agreements could not be exported." },
      { status: 500 },
    );
  }
}
