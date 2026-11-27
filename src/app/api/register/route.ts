import { APIError } from "better-auth";
import { NextResponse } from "next/server";

import { getAuth } from "@/lib/auth/server";
import { runAsSetup } from "@/lib/auth/setup-context";
import { resolveOwnerProvisioning } from "@/lib/owner-provisioning";
import { logRouteError, logSecurityEvent } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import { completeSetup, SetupError } from "@/lib/setup";

// Token-free registration of the first owner, on an empty database, where
// resolveOwnerProvisioning finds the deployment access-protected. Everything
// that decides who wins happens in completeSetup: one transaction, under an
// advisory lock, after the state has been read again. Everyone after the
// owner signs up through Better Auth as an ordinary user.

function isJsonRequest(request: Request): boolean {
  return (request.headers.get("content-type") ?? "")
    .toLowerCase()
    .startsWith("application/json");
}

async function createOwnerAccount(input: {
  email: string;
  name: string;
  password: string;
}) {
  try {
    const result = await runAsSetup(() =>
      getAuth().api.signUpEmail({
        body: {
          email: input.email,
          name: input.name,
          password: input.password,
        },
      }),
    );

    return { userId: result.user.id };
  } catch (error) {
    if (error instanceof APIError) {
      const code = String(error.body?.code ?? "");

      if (code === "PASSWORD_COMPROMISED") {
        throw new SetupError("Choose a different password.", 400, {
          password: "This password has appeared in a breach. Choose another.",
        });
      }

      throw new SetupError(
        error.body?.message ?? "The account could not be created.",
        400,
      );
    }

    throw error;
  }
}

export async function POST(request: Request) {
  const ipAddress = getClientIpAddress(request.headers);
  const rateLimitResponse = await applyRateLimit({
    category: "register_owner",
    key: buildRateLimitKey(["register-owner", ipAddress ?? "unknown"]),
    limit: 10,
    request,
    windowMs: 10 * 60 * 1000,
  });

  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  // A page on another site can make a browser post a form here, but not
  // JSON without this site's permission.
  if (!isJsonRequest(request)) {
    return NextResponse.json(
      { error: "Send this request as JSON." },
      { status: 415 },
    );
  }

  const provisioning = resolveOwnerProvisioning();

  if (provisioning.mode !== "first-owner-open") {
    logSecurityEvent("warn", {
      category: "owner_claim_refused",
      ipAddress,
      message:
        "Token-free owner registration was refused on a deployment that is not access-protected.",
      path: getRequestPathname(request),
    });

    return NextResponse.json(
      {
        code: "provisioning_required",
        error:
          "This workspace's owner account is created by its operator. Ask them for an invitation.",
      },
      { status: 403 },
    );
  }

  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const name = typeof body?.name === "string" ? body.name : body?.fullName;

  try {
    const result = await completeSetup(
      {
        email: body?.email,
        fullName: name,
        organizationName: body?.organizationName,
        password: body?.password,
      },
      { createAdminAccount: createOwnerAccount, setupToken: "waived" },
    );

    if (result.mode !== "create") {
      return NextResponse.json(
        { code: "owner_exists", error: "This workspace already has an owner." },
        { status: 409 },
      );
    }

    logSecurityEvent("info", {
      category: "owner_registered",
      ipAddress,
      message: `First owner registered (${provisioning.reason}).`,
      path: getRequestPathname(request),
      userId: result.userId,
    });

    try {
      await getAuth().api.signInEmail({
        body: { email: result.email, password: String(body?.password ?? "") },
        headers: request.headers,
      });
    } catch (error) {
      console.error(
        "Owner registered, but signing in afterwards failed:",
        error,
      );

      return NextResponse.json({ redirectTo: "/login" }, { status: 201 });
    }

    return NextResponse.json({ redirectTo: "/dashboard" }, { status: 201 });
  } catch (error) {
    if (error instanceof SetupError) {
      // Someone else won the claim, or the workspace was set up meanwhile:
      // the visitor carries on as an ordinary sign-up.
      if (error.statusCode === 409) {
        return NextResponse.json(
          {
            code: "owner_exists",
            error: "This workspace already has an owner.",
          },
          { status: 409 },
        );
      }

      if (error.statusCode === 403) {
        return NextResponse.json(
          {
            code: "owner_exists",
            error: "This workspace already has an owner.",
          },
          { status: 409 },
        );
      }

      return NextResponse.json(
        {
          error: error.message,
          fieldErrors: {
            ...(error.fieldErrors.fullName
              ? { name: error.fieldErrors.fullName }
              : {}),
            ...(error.fieldErrors.email
              ? { email: error.fieldErrors.email }
              : {}),
            ...(error.fieldErrors.password
              ? { password: error.fieldErrors.password }
              : {}),
          },
        },
        { status: error.statusCode },
      );
    }

    logRouteError(error, {
      category: "register_owner_failure",
      ipAddress,
      message: "Unexpected failure during owner registration.",
      path: getRequestPathname(request),
    });

    return NextResponse.json(
      { error: "Your account could not be created. Please try again." },
      { status: 500 },
    );
  }
}
