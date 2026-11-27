import { NextResponse } from "next/server";

import { requireAdminSession } from "@/lib/auth/admin";
import { InvitationError, revokeInvitation } from "@/lib/invitations";

// Withdraws an invitation. Administrators only.
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireAdminSession(request);

  if (session instanceof Response) {
    return session;
  }

  try {
    await revokeInvitation((await params).id, session.user.id);

    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof InvitationError) {
      return NextResponse.json(
        { code: error.code, error: error.message },
        { status: error.statusCode },
      );
    }

    throw error;
  }
}
