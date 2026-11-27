import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { getDb } from "@/lib/db/connection";
import { builderErrorResponse } from "@/lib/document-builder/route-helpers";
import { renderBuilderDocumentPdf } from "@/lib/document-builder/store";
import { buildContentDisposition } from "@/lib/services/storage";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";

type RouteContext = { params: Promise<{ id: string }> };

// A preview of the document as it will be sent, opened in the browser's own
// PDF viewer. Variables without a value show as their name in brackets.
export async function GET(request: Request, context: RouteContext) {
  const session = await requireVerifiedSenderSession(request);

  if (session instanceof Response) {
    return session;
  }

  const limited = await applyRateLimit({
    category: "builder_document_preview",
    key: buildRateLimitKey(["builder-preview", session.user.id]),
    limit: 120,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (limited) {
    return limited;
  }

  const { id } = await context.params;

  try {
    const { pdf, title } = await renderBuilderDocumentPdf(
      session.user.id,
      id,
      getDb(),
    );

    return new Response(Buffer.from(pdf), {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": buildContentDisposition(
          `${title}.pdf`,
          "inline",
        ),
        "content-type": "application/pdf",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return builderErrorResponse(
      error,
      request,
      session.user.id,
      "preview the document",
    );
  }
}
