import { NextResponse } from "next/server";

import { getAuthSessionFromHeaders } from "@/lib/auth/server";
import { completeOAuth, OAuthFlowError } from "@/lib/email/oauth";
import { settleConnectedAccount } from "@/lib/email/service";
import { logRouteError } from "@/lib/security/logging";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";

// Where Google and Microsoft send the browser back. The state must be one
// this same signed-in person started in the last ten minutes, and is used
// once. The answer is always a redirect to Settings: nothing secret is put
// in the address bar, only an outcome code.

function back(request: Request, query: Record<string, string>): Response {
  const url = new URL("/settings/email", request.url);

  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }

  return NextResponse.redirect(url, { status: 303 });
}

export async function GET(request: Request) {
  const session = await getAuthSessionFromHeaders(request.headers);

  if (!session) {
    return back(request, { error: "signed_out" });
  }

  const params = new URL(request.url).searchParams;
  const actor = {
    email: session.user.email,
    name: session.user.name,
    userId: session.user.id,
  };

  try {
    const { accountId } = await completeOAuth(actor, {
      code: params.get("code"),
      error: params.get("error"),
      errorDescription: params.get("error_description"),
      state: params.get("state"),
    });

    await settleConnectedAccount(actor, accountId);

    return back(request, { connected: accountId });
  } catch (error) {
    if (error instanceof OAuthFlowError) {
      return back(request, { error: error.code });
    }

    logRouteError(error, {
      category: "email_oauth_callback_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Finishing a mailbox connection failed.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return back(request, { error: "failed" });
  }
}
