import { APIError } from "better-auth";
import { NextResponse } from "next/server";

import { getAuth, getAuthSessionFromHeaders } from "@/lib/auth/server";
import { runAsSetup } from "@/lib/auth/setup-context";
import { mayUsePassword, readPasswordSignInPolicy } from "@/lib/auth/sso";
import { acceptInvitation, InvitationError } from "@/lib/invitations";
import { logRouteError, logSecurityEvent } from "@/lib/security/logging";
import {
  applyPublicLinkRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import { recordSystemAuditEvent } from "@/lib/services/system-audit";

// Accepts an invitation: for the signed-in person whose address it names,
// or by creating their account. The invitation is the administrator's
// consent, so the sign-up rule does not apply, and the link proves the
// address, so no verification email is sent (runAsSetup covers both).

async function createInvitedAccount(input: {
  email: string;
  name: string;
  password: string;
}) {
  if (!mayUsePassword(readPasswordSignInPolicy(), input.email)) {
    throw new InvitationError(
      "This workspace uses single sign-on. Sign in with it, then open the link again.",
      403,
      "password_sign_in_off",
    );
  }

  try {
    const result = await runAsSetup(() =>
      getAuth().api.signUpEmail({ body: input }),
    );

    return { userId: result.user.id };
  } catch (error) {
    if (error instanceof APIError) {
      const code = String(error.body?.code ?? "");

      throw new InvitationError(
        code === "PASSWORD_COMPROMISED"
          ? "Choose a different password."
          : (error.body?.message ?? "Your account could not be created."),
        400,
        "invalid",
        code === "PASSWORD_COMPROMISED"
          ? {
              password:
                "This password has appeared in a breach. Choose another.",
            }
          : {},
      );
    }

    throw error;
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const ipAddress = getClientIpAddress(request.headers);
  const limited = await applyPublicLinkRateLimit({
    category: "invitation_accept",
    key: buildRateLimitKey(["invitation-accept", token.slice(0, 16)]),
    limit: 10,
    request,
    windowMs: 10 * 60 * 1000,
  });

  if (limited) {
    return limited;
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

  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;

  try {
    const session = await getAuthSessionFromHeaders(request.headers);
    const result = await acceptInvitation(token, body ?? {}, {
      createAccount: createInvitedAccount,
      sessionUser: session
        ? { email: session.user.email, id: session.user.id }
        : null,
    });

    await recordSystemAuditEvent({
      actorEmail: result.email,
      actorUserId: result.userId,
      event: "invitation_accepted",
      ipAddress,
      targetUserId: result.userId,
    }).catch(() => undefined);

    if (result.mode === "created") {
      try {
        await getAuth().api.signInEmail({
          body: { email: result.email, password: String(body?.password ?? "") },
          headers: request.headers,
        });
      } catch (error) {
        console.error("Invitation accepted, but signing in failed:", error);

        return NextResponse.json({ redirectTo: "/login" });
      }
    }

    return NextResponse.json({ redirectTo: "/dashboard" });
  } catch (error) {
    if (error instanceof InvitationError) {
      if (error.statusCode === 403) {
        logSecurityEvent("warn", {
          category: "invitation_refused",
          ipAddress,
          message: error.code,
          path: getRequestPathname(request),
        });
      }

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
      category: "invitation_accept_failure",
      ipAddress,
      message: "Unexpected failure while accepting an invitation.",
      path: getRequestPathname(request),
    });

    return NextResponse.json(
      { error: "The invitation could not be accepted. Please try again." },
      { status: 500 },
    );
  }
}
