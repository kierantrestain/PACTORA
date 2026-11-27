import {
  getDb,
  queryMany,
  queryOne,
  type DbExecutor,
} from "../db/connection.ts";
import { escapeHtml } from "../utils/html.ts";

// An organisation's own wording for a few messages: the subject and the
// opening paragraph. Everything else in the message (the greeting, the
// links, the deadline, the legal footer) stays as PACTORA writes it, so a
// template can never drop a signing link or a required notice.
//
// Placeholders are filled in from what PACTORA knows about the message and
// HTML-escaped in the HTML part, so nothing typed into a document title or
// a name can add markup.

export const EDITABLE_TEMPLATE_KINDS = [
  "signing_invitation",
  "automatic_reminder",
  "manual_nudge",
  "completion_notification",
  "workspace_invitation",
] as const;

export type EditableTemplateKind = (typeof EDITABLE_TEMPLATE_KINDS)[number];

export const TEMPLATE_PLACEHOLDERS = [
  "sender_name",
  "document_title",
  "organization_name",
  "recipient_name",
] as const;

export type TemplatePlaceholder = (typeof TEMPLATE_PLACEHOLDERS)[number];
export type TemplateVariables = Partial<Record<TemplatePlaceholder, string>>;

export type TemplateCopy = { intro: string; subject: string };

/** Today's wording, written with placeholders. The signer's version. */
export const DEFAULT_TEMPLATE_COPY: Record<EditableTemplateKind, TemplateCopy> =
  {
    automatic_reminder: {
      intro:
        '{{sender_name}} is still waiting for your signature on "{{document_title}}", sent through {{organization_name}}.',
      subject:
        'Reminder: {{sender_name}} is waiting for your signature on "{{document_title}}"',
    },
    completion_notification: {
      intro:
        '"{{document_title}}" from {{sender_name}} has been fully signed in {{organization_name}}.',
      subject: '"{{document_title}}" is fully signed',
    },
    manual_nudge: {
      intro:
        '{{sender_name}} sent you a reminder to sign "{{document_title}}" through {{organization_name}}.',
      subject:
        '{{sender_name}} sent you a reminder to sign "{{document_title}}"',
    },
    signing_invitation: {
      intro:
        '{{sender_name}} sent you "{{document_title}}" through {{organization_name}}.',
      subject:
        '{{sender_name}} requested your signature on "{{document_title}}"',
    },
    workspace_invitation: {
      intro: "{{sender_name}} invited you to join {{organization_name}}.",
      subject: "{{sender_name}} invited you to {{organization_name}}",
    },
  };

export function isEditableTemplateKind(
  value: unknown,
): value is EditableTemplateKind {
  return (
    typeof value === "string" &&
    (EDITABLE_TEMPLATE_KINDS as readonly string[]).includes(value)
  );
}

const PLACEHOLDER_PATTERN = /\{\{\s*([a-z_]+)\s*\}\}/g;

/** The placeholders a text uses that PACTORA does not know. */
export function unknownPlaceholders(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER_PATTERN)]
    .map((match) => match[1]!)
    .filter(
      (name) => !(TEMPLATE_PLACEHOLDERS as readonly string[]).includes(name),
    );
}

function fill(
  text: string,
  variables: TemplateVariables,
  encode: (value: string) => string,
): string {
  let result = "";
  let last = 0;

  for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
    const value = variables[match[1] as TemplatePlaceholder];

    result += encode(text.slice(last, match.index));
    result += value === undefined ? encode(match[0]) : encode(value);
    last = match.index + match[0].length;
  }

  return result + encode(text.slice(last));
}

/** For a subject or a plain-text body. Line breaks are not allowed in a subject. */
export function renderTemplateText(
  text: string,
  variables: TemplateVariables,
): string {
  return fill(text, variables, (value) => value);
}

/** For the HTML part: the template's own text and every value escaped. */
export function renderTemplateHtml(
  text: string,
  variables: TemplateVariables,
): string {
  return fill(text, variables, escapeHtml);
}

export function renderSubject(
  text: string,
  variables: TemplateVariables,
): string {
  return renderTemplateText(text, variables)
    .replace(/[\r\n]+/g, " ")
    .trim();
}

/**
 * The organisation's wording for this kind of message, or null when it
 * uses PACTORA's own. A database without the table, or one that cannot be
 * read, means PACTORA's own: the wording is never a reason not to send.
 */
export async function getTemplateCopy(
  kind: EditableTemplateKind,
  database: DbExecutor | null = null,
): Promise<TemplateCopy | null> {
  try {
    return await queryOne<TemplateCopy>(
      database ?? getDb(),
      `SELECT subject, intro FROM email_templates WHERE kind = $1`,
      [kind],
    );
  } catch {
    return null;
  }
}

export type TemplateView = {
  defaultIntro: string;
  defaultSubject: string;
  intro: string;
  isCustomized: boolean;
  kind: EditableTemplateKind;
  placeholders: readonly TemplatePlaceholder[];
  subject: string;
  updatedAt: number | null;
};

export async function listTemplates(
  database: DbExecutor = getDb(),
): Promise<TemplateView[]> {
  const rows = await queryMany<
    TemplateCopy & { kind: EditableTemplateKind; updatedAt: number }
  >(
    database,
    `SELECT kind, subject, intro, updated_at AS "updatedAt" FROM email_templates`,
  );
  const stored = new Map(rows.map((row) => [row.kind, row]));

  return EDITABLE_TEMPLATE_KINDS.map((kind) => {
    const row = stored.get(kind);
    const defaults = DEFAULT_TEMPLATE_COPY[kind];

    return {
      defaultIntro: defaults.intro,
      defaultSubject: defaults.subject,
      intro: row?.intro ?? defaults.intro,
      isCustomized: Boolean(row),
      kind,
      placeholders: TEMPLATE_PLACEHOLDERS,
      subject: row?.subject ?? defaults.subject,
      updatedAt: row?.updatedAt ?? null,
    };
  });
}

export class TemplateValidationError extends Error {
  readonly fieldErrors: Record<string, string>;

  constructor(fieldErrors: Record<string, string>) {
    super(Object.values(fieldErrors)[0] ?? "Check the template.");
    this.name = "TemplateValidationError";
    this.fieldErrors = fieldErrors;
  }
}

/**
 * Saves the wording for one kind. Saving PACTORA's own wording, or empty
 * text, goes back to it.
 */
export async function saveTemplate(
  input: { intro: string; kind: EditableTemplateKind; subject: string },
  userId: string,
  database: DbExecutor = getDb(),
): Promise<void> {
  const subject = input.subject.trim();
  const intro = input.intro.trim();
  const defaults = DEFAULT_TEMPLATE_COPY[input.kind];
  const fieldErrors: Record<string, string> = {};

  if (subject.length > 200) {
    fieldErrors.subject = "Keep the subject to 200 characters.";
  } else if (/[\r\n]/.test(subject)) {
    fieldErrors.subject = "A subject is one line.";
  }

  if (intro.length > 2000) {
    fieldErrors.intro = "Keep the opening paragraph to 2,000 characters.";
  }

  for (const [field, text] of [
    ["subject", subject],
    ["intro", intro],
  ] as const) {
    const unknown = unknownPlaceholders(text);

    if (unknown.length > 0 && !fieldErrors[field]) {
      fieldErrors[field] =
        `Unknown placeholder {{${unknown[0]!}}}. Use ${TEMPLATE_PLACEHOLDERS.map((name) => `{{${name}}}`).join(", ")}.`;
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw new TemplateValidationError(fieldErrors);
  }

  if (
    (!subject && !intro) ||
    (subject === defaults.subject && intro === defaults.intro)
  ) {
    await database.query(`DELETE FROM email_templates WHERE kind = $1`, [
      input.kind,
    ]);
    return;
  }

  await database.query(
    `
      INSERT INTO email_templates (kind, subject, intro, updated_by_user_id, updated_at)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (kind) DO UPDATE
      SET subject = EXCLUDED.subject,
          intro = EXCLUDED.intro,
          updated_by_user_id = EXCLUDED.updated_by_user_id,
          updated_at = EXCLUDED.updated_at
    `,
    [
      input.kind,
      subject || defaults.subject,
      intro || defaults.intro,
      userId,
      Math.floor(Date.now() / 1000),
    ],
  );
}
