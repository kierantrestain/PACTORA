import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  getDb,
  queryMany,
  queryOne,
  type DbExecutor,
  type DbPool,
} from "../db/connection.ts";
import {
  createDraftEnvelope,
  deleteDraftEnvelope,
  replaceDraftEnvelopeFields,
  replaceDraftEnvelopeSigners,
} from "../envelopes.ts";
import { emailSchema, nameSchema } from "../schemas/common.ts";
import {
  createStorageService,
  type StorageService,
} from "../services/storage.ts";
import { findStarterDocument } from "./library.ts";
import {
  builderContentSchema,
  builderTitleSchema,
  emptyBuilderContent,
  findSendProblems,
  type BuilderContent,
} from "./model.ts";
import { renderBuilderDocument } from "./render.ts";

// Saving, listing and sending Document Builder documents. A document is
// private to the person who wrote it, like a template.

export const MAX_BUILDER_DOCUMENTS_PER_USER = 1000;

export class BuilderDocumentError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "BuilderDocumentError";
    this.statusCode = statusCode;
  }
}

export type BuilderDocumentSummary = {
  envelopeId: string | null;
  envelopeStatus: string | null;
  id: string;
  isTemplate: boolean;
  title: string;
  updatedAt: number;
};

export type BuilderDocument = BuilderDocumentSummary & {
  content: BuilderContent;
  createdAt: number;
  revision: number;
};

type BuilderDocumentRow = {
  content: unknown;
  createdAt: string | number;
  envelopeId: string | null;
  envelopeStatus: string | null;
  id: string;
  isTemplate: boolean;
  revision: number;
  title: string;
  updatedAt: string | number;
};

const SELECT_DOCUMENT = `
  SELECT
    d.id,
    d.title,
    d.content,
    d.is_template AS "isTemplate",
    d.envelope_id AS "envelopeId",
    e.status AS "envelopeStatus",
    d.revision,
    d.created_at AS "createdAt",
    d.updated_at AS "updatedAt"
  FROM builder_documents d
  LEFT JOIN envelopes e ON e.id = d.envelope_id
`;

function toDocument(row: BuilderDocumentRow): BuilderDocument {
  const parsed = builderContentSchema.safeParse(row.content);

  return {
    // Content saved by a later version that this one cannot read opens as
    // an empty document rather than failing the page.
    content: parsed.success ? parsed.data : emptyBuilderContent(),
    createdAt: Number(row.createdAt),
    envelopeId: row.envelopeId,
    envelopeStatus: row.envelopeStatus,
    id: row.id,
    isTemplate: row.isTemplate,
    revision: row.revision,
    title: row.title,
    updatedAt: Number(row.updatedAt),
  };
}

export async function listBuilderDocuments(
  userId: string,
  database: DbExecutor = getDb(),
): Promise<BuilderDocumentSummary[]> {
  const rows = await queryMany<BuilderDocumentRow>(
    database,
    `${SELECT_DOCUMENT}
      WHERE d.user_id = $1
      ORDER BY d.updated_at DESC, d.id
      LIMIT 500`,
    [userId],
  );

  return rows.map((row) => {
    const document = toDocument(row);

    return {
      envelopeId: document.envelopeId,
      envelopeStatus: document.envelopeStatus,
      id: document.id,
      isTemplate: document.isTemplate,
      title: document.title,
      updatedAt: document.updatedAt,
    };
  });
}

export async function getBuilderDocument(
  userId: string,
  documentId: string,
  database: DbExecutor = getDb(),
): Promise<BuilderDocument | null> {
  const row = await queryOne<BuilderDocumentRow>(
    database,
    `${SELECT_DOCUMENT} WHERE d.id = $1 AND d.user_id = $2`,
    [documentId, userId],
  );

  return row ? toDocument(row) : null;
}

async function requireDocument(
  userId: string,
  documentId: string,
  database: DbExecutor,
): Promise<BuilderDocument> {
  const document = await getBuilderDocument(userId, documentId, database);

  if (!document) {
    throw new BuilderDocumentError("Document not found.", 404);
  }

  return document;
}

export const createBuilderDocumentSchema = z.union([
  z.object({ starterId: z.string().trim().min(1).max(64) }).strict(),
  z
    .object({
      asTemplate: z.boolean().default(false),
      sourceId: z.string().trim().min(1).max(64),
    })
    .strict(),
  z.object({ title: builderTitleSchema.optional() }).strict(),
]);

/**
 * Starts a document: blank, from a starter in the library, or as a copy of
 * one of the person's own documents (which is how a saved template is used,
 * and how a document is saved as a template).
 */
export async function createBuilderDocument(
  userId: string,
  input: unknown,
  database: DbExecutor = getDb(),
): Promise<{ id: string }> {
  const parsed = createBuilderDocumentSchema.parse(input);
  let title = "Untitled document";
  let content: BuilderContent = emptyBuilderContent();
  let isTemplate = false;

  if ("starterId" in parsed) {
    const starter = findStarterDocument(parsed.starterId);

    if (!starter) {
      throw new BuilderDocumentError(
        "That starter document does not exist.",
        404,
      );
    }

    title = starter.title;
    content = builderContentSchema.parse(structuredClone(starter.content));
  } else if ("sourceId" in parsed) {
    const source = await requireDocument(userId, parsed.sourceId, database);

    title = parsed.asTemplate
      ? source.title
      : source.isTemplate
        ? source.title
        : `${source.title} (copy)`.slice(0, 160);
    content = source.content;
    isTemplate = parsed.asTemplate;
  } else if (parsed.title) {
    title = parsed.title;
  }

  const count = await queryOne<{ count: string }>(
    database,
    `SELECT count(*)::text AS count FROM builder_documents WHERE user_id = $1`,
    [userId],
  );

  if (Number(count?.count ?? 0) >= MAX_BUILDER_DOCUMENTS_PER_USER) {
    throw new BuilderDocumentError(
      `You have ${MAX_BUILDER_DOCUMENTS_PER_USER} documents. Delete some you no longer need to start another.`,
      409,
    );
  }

  const id = randomUUID();

  await database.query(
    `
      INSERT INTO builder_documents (id, user_id, title, content, is_template)
      VALUES ($1, $2, $3, $4::jsonb, $5)
    `,
    [id, userId, title, JSON.stringify(content), isTemplate],
  );

  return { id };
}

export const saveBuilderDocumentSchema = z.object({
  content: builderContentSchema,
  expectedRevision: z.number().int().min(0).optional(),
  title: builderTitleSchema,
});

export const STALE_DOCUMENT_MESSAGE =
  "This document was changed in another window. Reload to see the latest version.";

export async function saveBuilderDocument(
  userId: string,
  documentId: string,
  input: unknown,
  database: DbExecutor = getDb(),
): Promise<{ revision: number; updatedAt: number }> {
  const parsed = saveBuilderDocumentSchema.parse(input);
  const row = await queryOne<{ revision: number; updatedAt: string }>(
    database,
    `
      UPDATE builder_documents
      SET title = $3,
          content = $4::jsonb,
          revision = revision + 1,
          updated_at = extract(epoch from now())::bigint
      WHERE id = $1
        AND user_id = $2
        AND ($5::integer IS NULL OR revision = $5)
      RETURNING revision, updated_at AS "updatedAt"
    `,
    [
      documentId,
      userId,
      parsed.title,
      JSON.stringify(parsed.content),
      parsed.expectedRevision ?? null,
    ],
  );

  if (!row) {
    await requireDocument(userId, documentId, database);

    throw new BuilderDocumentError(STALE_DOCUMENT_MESSAGE, 409);
  }

  return { revision: row.revision, updatedAt: Number(row.updatedAt) };
}

export async function deleteBuilderDocument(
  userId: string,
  documentId: string,
  database: DbExecutor = getDb(),
): Promise<void> {
  const result = await database.query(
    `DELETE FROM builder_documents WHERE id = $1 AND user_id = $2`,
    [documentId, userId],
  );

  if (result.rowCount === 0) {
    throw new BuilderDocumentError("Document not found.", 404);
  }
}

export async function renderBuilderDocumentPdf(
  userId: string,
  documentId: string,
  database: DbExecutor = getDb(),
): Promise<{ pdf: Uint8Array; title: string }> {
  const document = await requireDocument(userId, documentId, database);
  const rendered = await renderBuilderDocument(
    document.title,
    document.content,
  );

  return { pdf: rendered.pdf, title: document.title };
}

export const sendBuilderDocumentSchema = z.object({
  recipients: z
    .array(
      z.object({
        email: emailSchema,
        name: nameSchema,
        roleId: z.string().trim().min(1).max(64),
      }),
    )
    .min(1)
    .max(10),
});

type SendOptions = {
  database?: DbPool;
  storageService?: StorageService;
};

/**
 * Renders the document and opens a draft envelope from it, with a person
 * named for each role and every field already placed. The sender lands on
 * the review step, one click from sending.
 */
export async function createEnvelopeFromBuilderDocument(
  userId: string,
  documentId: string,
  input: unknown,
  {
    database = getDb(),
    storageService = createStorageService(),
  }: SendOptions = {},
): Promise<{ envelopeId: string; redirectPath: string }> {
  const parsed = sendBuilderDocumentSchema.parse(input);
  const document = await requireDocument(userId, documentId, database);

  if (document.isTemplate) {
    throw new BuilderDocumentError(
      "Templates are not sent directly. Use the template to start a document, then send that.",
      409,
    );
  }

  const problems = findSendProblems(document.content);

  if (problems.length > 0) {
    throw new BuilderDocumentError(problems.join(" "), 400);
  }

  const recipientByRole = new Map(
    parsed.recipients.map((recipient) => [recipient.roleId, recipient]),
  );
  const roles = document.content.roles;

  if (
    recipientByRole.size !== parsed.recipients.length ||
    roles.some((role) => !recipientByRole.has(role.id)) ||
    parsed.recipients.length !== roles.length
  ) {
    throw new BuilderDocumentError(
      "Name one person for each signer role in this document.",
      400,
    );
  }

  const rendered = await renderBuilderDocument(
    document.title,
    document.content,
  );
  const draft = await createDraftEnvelope(
    userId,
    {
      sourcePdf: {
        body: rendered.pdf,
        contentType: "application/pdf",
        filename: `${document.title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "Document"}.pdf`,
      },
      title: document.title,
    },
    { database, storageService },
  );
  const envelopeId = draft.envelope.id;

  try {
    const saved = await replaceDraftEnvelopeSigners(
      userId,
      envelopeId,
      {
        signers: roles.map((role) => {
          const recipient = recipientByRole.get(role.id)!;

          return { email: recipient.email, name: recipient.name };
        }),
      },
      database,
    );
    const signerIdByOrder = new Map(
      saved.signers.map((signer) => [signer.signOrder, signer.id] as const),
    );
    const signerIdByRole = new Map(
      roles.map(
        (role, index) => [role.id, signerIdByOrder.get(index + 1)] as const,
      ),
    );

    await replaceDraftEnvelopeFields(
      userId,
      envelopeId,
      {
        fields: rendered.fields.map((field) => ({
          height: field.height,
          label: field.label,
          page: field.page,
          required: field.required,
          signerId: signerIdByRole.get(field.roleId),
          type: field.type,
          width: field.width,
          x: field.x,
          y: field.y,
        })),
      },
      database,
    );
    await database.query(
      `
        UPDATE builder_documents
        SET envelope_id = $3, updated_at = extract(epoch from now())::bigint
        WHERE id = $1 AND user_id = $2
      `,
      [documentId, userId, envelopeId],
    );
  } catch (error) {
    // Half a draft is worse than none.
    await deleteDraftEnvelope(userId, envelopeId, {
      database,
      storageService,
    }).catch(() => undefined);
    throw error;
  }

  return { envelopeId, redirectPath: `/envelopes/${envelopeId}/review` };
}
