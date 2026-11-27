import { BuilderLibraryShell } from "@/components/builder/builder-library-shell";
import { getAuthSession } from "@/lib/auth/server";
import { getDb } from "@/lib/db/connection";
import { starterDocuments } from "@/lib/document-builder/library";
import {
  listBuilderDocuments,
  type BuilderDocumentSummary,
} from "@/lib/document-builder/store";

export default async function BuilderPage() {
  let documents: BuilderDocumentSummary[] = [];
  let initialState: "error" | undefined;

  try {
    const session = await getAuthSession();

    documents = session
      ? await listBuilderDocuments(session.user.id, getDb())
      : [];
  } catch {
    initialState = "error";
  }

  return (
    <BuilderLibraryShell
      documents={documents}
      initialState={initialState}
      starters={starterDocuments.map((starter) => ({
        category: starter.category,
        description: starter.description,
        id: starter.id,
        roleNames: starter.content.roles.map((role) => role.name),
        title: starter.title,
      }))}
    />
  );
}
