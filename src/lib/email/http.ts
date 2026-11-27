import { NextResponse } from "next/server";

import { requireVerifiedSenderSession } from "../auth/route-session.ts";
import { logRouteError } from "../security/logging.ts";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "../security/route-controls.ts";
import { getClientIpAddress, getRequestPathname } from "../security/request.ts";
import { EmailAccountError } from "./accounts.ts";
import { OAuthFlowError } from "./oauth.ts";
import { TemplateValidationError } from "./templates.ts";

// What every /api/email route shares: a verified session, a same-origin
// check on anything that changes state, JSON bodies, a rate limit, and
// errors turned into answers that never carry a credential.

type Session = Exclude<
  Awaited<ReturnType<typeof requireVerifiedSenderSession>>,
  Response
>;

export async function requireEmailSession(
  request: Request,
  {
    json = false,
    mutating = false,
    rateLimit,
  }: {
    json?: boolean;
    mutating?: boolean;
    rateLimit?: { limit: number; name: string; windowMs: number };
  } = {},
): Promise<Session | Response> {
  if (mutating) {
    // Browsers say where a request came from. One started by another site
    // is refused outright, whatever cookies it carries.
    const site = request.headers.get("sec-fetch-site");

    if (site && site !== "same-origin" && site !== "none") {
      return NextResponse.json(
        { error: "Cross-site request refused." },
        { status: 403 },
      );
    }

    const origin = request.headers.get("origin");

    if (origin && origin !== new URL(request.url).origin) {
      const appUrl = process.env.APP_URL ?? process.env.BETTER_AUTH_URL;

      if (!appUrl || new URL(appUrl).origin !== origin) {
        return NextResponse.json(
          { error: "Cross-site request refused." },
          { status: 403 },
        );
      }
    }
  }

  if (
    json &&
    !(request.headers.get("content-type") ?? "")
      .toLowerCase()
      .startsWith("application/json")
  ) {
    return NextResponse.json(
      { error: "Send this request as JSON." },
      { status: 415 },
    );
  }

  const session = await requireVerifiedSenderSession(request);

  if (session instanceof Response) {
    return session;
  }

  if (rateLimit) {
    const limited = await applyRateLimit({
      category: `email_${rateLimit.name}`,
      key: buildRateLimitKey(["email", rateLimit.name, session.user.id]),
      limit: rateLimit.limit,
      request,
      windowMs: rateLimit.windowMs,
    });

    if (limited) {
      return limited;
    }
  }

  return session;
}

export function actorOf(session: Session) {
  return {
    email: session.user.email,
    name: session.user.name,
    userId: session.user.id,
  };
}

export function emailErrorResponse(
  error: unknown,
  request: Request,
  { fallback, userId }: { fallback: string; userId?: string },
): Response {
  if (error instanceof EmailAccountError) {
    return NextResponse.json(
      {
        code: error.code,
        error: error.message,
        fieldErrors: error.fieldErrors,
      },
      { status: error.statusCode },
    );
  }

  if (error instanceof OAuthFlowError) {
    return NextResponse.json(
      {
        adminConsentUrl: error.adminConsentUrl,
        code: error.code,
        error: error.message,
      },
      { status: error.statusCode },
    );
  }

  if (error instanceof TemplateValidationError) {
    return NextResponse.json(
      { error: error.message, fieldErrors: error.fieldErrors },
      { status: 400 },
    );
  }

  logRouteError(error, {
    category: "email_route_failure",
    ipAddress: getClientIpAddress(request.headers),
    message: fallback,
    path: getRequestPathname(request),
    userId,
  });

  return NextResponse.json({ error: fallback }, { status: 500 });
}

export async function readJson(request: Request): Promise<unknown> {
  return request.json().catch(() => null);
}
