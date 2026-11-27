import { NextResponse } from "next/server";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { getDb } from "@/lib/db/connection";
import {
  builderErrorResponse,
  readJson,
} from "@/lib/document-builder/route-helpers";
import {
  BuilderDocumentError,
  deleteBuilderDocument,
  getBuilderDocument,
  saveBuilderDocument,
} from "@/lib/document-builder/store";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  const session = await requireVerifiedSenderSession(request);

  if (session instanceof Response) {
    return session;
  }

  const { id } = await context.params;

  try {
    const document = await getBuilderDocument(session.user.id, id, getDb());

    if (!document) {
      throw new BuilderDocumentError("Document not found.", 404);
    }

    return NextResponse.json({ document });
  } catch (error) {
    return builderErrorResponse(
      error,
      request,
      session.user.id,
      "open the document",
    );
  }
}

export async function PUT(request: Request, context: RouteContext) {
  const session = await requireVerifiedSenderSession(request);

  if (session instanceof Response) {
    return session;
  }

  // Autosave sends a save a second or so after typing stops.
  const limited = await applyRateLimit({
    category: "builder_document_save",
    key: buildRateLimitKey(["builder-save", session.user.id]),
    limit: 600,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (limited) {
    return limited;
  }

  const { id } = await context.params;

  try {
    return NextResponse.json(
      await saveBuilderDocument(
        session.user.id,
        id,
        await readJson(request),
        getDb(),
      ),
    );
  } catch (error) {
    return builderErrorResponse(
      error,
      request,
      session.user.id,
      "save the document",
    );
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const session = await requireVerifiedSenderSession(request);

  if (session instanceof Response) {
    return session;
  }

  const { id } = await context.params;

  try {
    await deleteBuilderDocument(session.user.id, id, getDb());

    return NextResponse.json({ deletedDocumentId: id });
  } catch (error) {
    return builderErrorResponse(
      error,
      request,
      session.user.id,
      "delete the document",
    );
  }
}
