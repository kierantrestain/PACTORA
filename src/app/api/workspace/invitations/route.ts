import { NextResponse } from "next/server";

import { requireAdminSession } from "@/lib/auth/admin";
import {
  createInvitation,
  InvitationError,
  listInvitations,
} from "@/lib/invitations";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";

// Invitations to join the workspace. Administrators only.

export async function GET(request: Request) {
  const session = await requireAdminSession(request);

  if (session instanceof Response) {
    return session;
  }

  return NextResponse.json({ invitations: await listInvitations() });
}

export async function POST(request: Request) {
  const session = await requireAdminSession(request);

  if (session instanceof Response) {
    return session;
  }

  if (
    !(request.headers.get("content-type") ?? "")
      .toLowerCase()
      .startsWith("application/json")
  ) {
    return NextResponse.json(
      { error: "Send this request as JSON." },
      { status: 415 },
    );
  }

  const limited = await applyRateLimit({
    category: "invitation_create",
    key: buildRateLimitKey(["invitation", session.user.id]),
    limit: 50,
    request,
    windowMs: 60 * 60 * 1000,
  });

  if (limited) {
    return limited;
  }

  try {
    const result = await createInvitation(
      { id: session.user.id, name: session.user.name },
      await request.json().catch(() => null),
    );

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof InvitationError) {
      return NextResponse.json(
        {
          code: error.code,
          error: error.message,
          fieldErrors: error.fieldErrors,
        },
        { status: error.statusCode },
      );
    }

    logRouteError(error, {
      category: "invitation_create_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while creating an invitation.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "The invitation could not be created." },
      { status: 500 },
    );
  }
}
