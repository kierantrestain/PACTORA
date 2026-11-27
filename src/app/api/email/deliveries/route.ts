import { NextResponse } from "next/server";

import { listDeliveries } from "@/lib/email/deliveries";
import { emailErrorResponse, requireEmailSession } from "@/lib/email/http";

// Delivery history: administrators see everything, others what was sent
// for them. Subjects, recipients and outcomes only, never message bodies.

export async function GET(request: Request) {
  const session = await requireEmailSession(request);

  if (session instanceof Response) {
    return session;
  }

  const params = new URL(request.url).searchParams;

  try {
    return NextResponse.json(
      await listDeliveries(session.user.id, {
        cursor: params.get("cursor"),
        search: params.get("q"),
        status: params.get("status"),
      }),
    );
  } catch (error) {
    return emailErrorResponse(error, request, {
      fallback: "The delivery history could not be loaded.",
      userId: session.user.id,
    });
  }
}
