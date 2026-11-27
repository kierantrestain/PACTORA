import { notFound } from "next/navigation";

import { DocumentEditor } from "@/components/builder/document-editor";
import { getAuthSession } from "@/lib/auth/server";
import { getDb } from "@/lib/db/connection";
import { getBuilderDocument } from "@/lib/document-builder/store";

export default async function BuilderDocumentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getAuthSession();
  const document = session
    ? await getBuilderDocument(session.user.id, id, getDb())
    : null;

  if (!document) {
    notFound();
  }

  return (
    <DocumentEditor
      currentUser={{ email: session!.user.email, name: session!.user.name }}
      document={document}
    />
  );
}
