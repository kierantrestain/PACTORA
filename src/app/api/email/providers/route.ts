import { NextResponse } from "next/server";

import { requireEmailSession } from "@/lib/email/http";
import { listProviderOptions } from "@/lib/email/presets";

// The mailbox providers Settings offers, and which are ready to use. An
// OAuth provider whose app credentials the administrator has not set says
// so instead of pretending to connect.

export async function GET(request: Request) {
  const session = await requireEmailSession(request);

  if (session instanceof Response) {
    return session;
  }

  return NextResponse.json({ providers: listProviderOptions() });
}
