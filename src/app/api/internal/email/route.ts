import { NextResponse } from "next/server";

import { processDueDeliveries } from "@/lib/email/engine";
import { identifyRetentionCaller } from "@/lib/retention-job";
import { logRouteError } from "@/lib/security/logging";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import { resolveEmailAddresses } from "@/lib/services/email";
import { getSettings } from "@/lib/settings";

// Tries again the email deliveries that are due (see engine.ts). Called by
// Vercel's cron (vercel.json) and by any scheduler a self-hosted install
// uses. Same secret as the other jobs; without it, an anonymous caller may
// run it once a minute and learns nothing: it only sends what was due.

async function handle(request: Request) {
  const caller = identifyRetentionCaller(request.headers.get("authorization"));

  if (caller === "denied") {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    if (caller === "anonymous") {
      const ration = await consumeRateLimit({
        key: "job:email",
        limit: 1,
        windowMs: 60 * 1000,
      });

      if (!ration.allowed) {
        return new NextResponse(null, { status: 204 });
      }
    }

    const summary = await processDueDeliveries({
      limit: 50,
      resolveAddresses: () => resolveEmailAddresses(),
      resolveOrganizationName: async () =>
        (await getSettings()).organizationName,
    });

    return caller === "authorized"
      ? NextResponse.json(summary)
      : new NextResponse(null, { status: 204 });
  } catch (error) {
    logRouteError(error, {
      category: "email_retry_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Retrying email deliveries failed.",
      path: getRequestPathname(request),
    });

    return new NextResponse(null, { status: 500 });
  }
}

export function GET(request: Request) {
  return handle(request);
}

export function POST(request: Request) {
  return handle(request);
}
