import { NextResponse } from "next/server";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { getDb } from "@/lib/db/connection";
import {
  builderErrorResponse,
  readJson,
} from "@/lib/document-builder/route-helpers";
import {
  createBuilderDocument,
  listBuilderDocuments,
} from "@/lib/document-builder/store";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";

export async function GET(request: Request) {
  const session = await requireVerifiedSenderSession(request);

  if (session instanceof Response) {
    return session;
  }

  try {
    return NextResponse.json({
      documents: await listBuilderDocuments(session.user.id, getDb()),
    });
  } catch (error) {
    return builderErrorResponse(
      error,
      request,
      session.user.id,
      "list your documents",
    );
  }
}

export async function POST(request: Request) {
  const session = await requireVerifiedSenderSession(request);

  if (session instanceof Response) {
    return session;
  }

  const limited = await applyRateLimit({
    category: "builder_document_create",
    key: buildRateLimitKey(["builder-create", session.user.id]),
    limit: 60,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (limited) {
    return limited;
  }

  try {
    const created = await createBuilderDocument(
      session.user.id,
      (await readJson(request)) ?? {},
      getDb(),
    );

    return NextResponse.json(
      { id: created.id, redirectPath: `/builder/${created.id}` },
      { status: 201 },
    );
  } catch (error) {
    return builderErrorResponse(
      error,
      request,
      session.user.id,
      "create the document",
    );
  }
}
