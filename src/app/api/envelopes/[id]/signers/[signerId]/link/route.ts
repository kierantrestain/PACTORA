import { NextResponse } from "next/server";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import {
  issueManualSigningLink,
  ManualLinkError,
} from "@/lib/manual-signing-link";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";

const noStore = { "cache-control": "private, no-store" };

// Issues a fresh signing link for the sender to copy and share themselves.
// The link is returned once and never logged.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; signerId: string }> },
) {
  const session = await requireVerifiedSenderSession(request);

  if (session instanceof Response) {
    return session;
  }

  const { id, signerId } = await params;
  const ipAddress = getClientIpAddress(request.headers);
  const limited = await applyRateLimit({
    category: "manual_signing_link",
    key: buildRateLimitKey(["manual-link", session.user.id]),
    limit: 30,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (limited) {
    return limited;
  }

  try {
    const link = await issueManualSigningLink({
      actor: { email: session.user.email, id: session.user.id },
      envelopeId: id,
      ipAddress,
      signerId,
      userAgent: request.headers.get("user-agent"),
    });

    return NextResponse.json(link, { headers: noStore });
  } catch (error) {
    if (error instanceof ManualLinkError) {
      return NextResponse.json(
        { error: error.message },
        { headers: noStore, status: error.statusCode },
      );
    }

    logRouteError(error, {
      category: "manual_signing_link_failure",
      ipAddress,
      message: "Unexpected failure while issuing a signing link to share.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "The signing link could not be created." },
      { headers: noStore, status: 500 },
    );
  }
}
