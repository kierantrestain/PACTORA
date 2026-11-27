import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { EnvelopeMutationError } from "../envelopes.ts";
import { logRouteError } from "../security/logging.ts";
import { getClientIpAddress, getRequestPathname } from "../security/request.ts";
import { DocumentImportError } from "../services/document-import.ts";
import { BuilderDocumentError } from "./store.ts";

/** The JSON error a Document Builder route answers with for `error`. */
export function builderErrorResponse(
  error: unknown,
  request: Request,
  userId: string,
  action: string,
): Response {
  if (error instanceof BuilderDocumentError) {
    return NextResponse.json(
      { error: error.message },
      { status: error.statusCode },
    );
  }

  if (error instanceof EnvelopeMutationError) {
    return NextResponse.json(
      { error: error.message },
      { status: error.statusCode },
    );
  }

  if (error instanceof DocumentImportError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  if (error instanceof ZodError) {
    return NextResponse.json(
      {
        error: error.issues[0]?.message ?? "Invalid document.",
        issues: error.issues.slice(0, 20).map((issue) => ({
          message: issue.message,
          path: issue.path,
        })),
      },
      { status: 400 },
    );
  }

  logRouteError(error, {
    category: "builder_document_failure",
    ipAddress: getClientIpAddress(request.headers),
    message: `Unexpected failure while trying to ${action}.`,
    path: getRequestPathname(request),
    userId,
  });

  return NextResponse.json(
    { error: `Unable to ${action}. Try again.` },
    { status: 500 },
  );
}

export async function readJson(request: Request): Promise<unknown> {
  return request.json().catch(() => null);
}
