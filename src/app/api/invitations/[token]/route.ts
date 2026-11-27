import { NextResponse } from "next/server";

import { readInvitation } from "@/lib/invitations";
import {
  applyPublicLinkRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";

// What an invitation link is for, so its page can greet the person.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const limited = await applyPublicLinkRateLimit({
    category: "invitation_read",
    key: buildRateLimitKey(["invitation-read", token.slice(0, 16)]),
    limit: 60,
    request,
    windowMs: 10 * 60 * 1000,
  });

  if (limited) {
    return limited;
  }

  const invitation = await readInvitation(token);

  if (!invitation) {
    return NextResponse.json(
      { error: "This invitation link is not valid." },
      { status: 404 },
    );
  }

  return NextResponse.json(invitation, {
    headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}
