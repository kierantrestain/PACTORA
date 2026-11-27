import { NextResponse } from "next/server";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { getOnboardingState, setOnboardingDismissed } from "@/lib/onboarding";

// The Getting Started checklist for the signed-in person.

export async function GET(request: Request) {
  const session = await requireVerifiedSenderSession(request);

  if (session instanceof Response) {
    return session;
  }

  return NextResponse.json(await getOnboardingState(session.user.id));
}

export async function POST(request: Request) {
  const session = await requireVerifiedSenderSession(request);

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

  const body = (await request.json().catch(() => null)) as {
    dismissed?: unknown;
  } | null;

  if (typeof body?.dismissed !== "boolean") {
    return NextResponse.json(
      { error: "Say whether the checklist is dismissed." },
      { status: 400 },
    );
  }

  await setOnboardingDismissed(session.user.id, body.dismissed);

  return NextResponse.json(await getOnboardingState(session.user.id));
}
