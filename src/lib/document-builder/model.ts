import { z } from "zod";

// The Document Builder's content model: an agreement written in PACTORA
// instead of uploaded as a PDF. A document is an ordered list of blocks,
// the roles who sign it, and variables that fill in the details that change
// from one copy to the next ({{client.name}}, {{start_date}}).
//
// Everything here is plain data and pure functions, so the same document
// always renders the same PDF and the same totals.

export const BUILDER_DOCUMENT_VERSION = 1;
export const MAX_BUILDER_BLOCKS = 300;
export const MAX_BUILDER_ROLES = 10;
export const MAX_BUILDER_VARIABLES = 50;
export const MAX_PRICING_ROWS = 100;
export const MAX_PARAGRAPH_LENGTH = 5000;
export const MAX_TITLE_LENGTH = 160;

const blockIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "Invalid block id");

const roleIdSchema = blockIdSchema;

export const builderRoleSchema = z.object({
  id: roleIdSchema,
  name: z.string().trim().min(1, "Name each signer role").max(60),
});

export const VARIABLE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.]{0,39}$/;

export const builderVariableSchema = z.object({
  key: z
    .string()
    .trim()
    .regex(
      VARIABLE_KEY_PATTERN,
      "A variable name starts with a letter and uses letters, digits, dots and underscores",
    ),
  label: z.string().trim().max(80).default(""),
  value: z.string().max(500).default(""),
});

const headingBlockSchema = z.object({
  id: blockIdSchema,
  type: z.literal("heading"),
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  text: z.string().max(300),
});

const paragraphBlockSchema = z.object({
  id: blockIdSchema,
  type: z.literal("paragraph"),
  text: z.string().max(MAX_PARAGRAPH_LENGTH),
});

const listBlockSchema = z.object({
  id: blockIdSchema,
  type: z.literal("list"),
  style: z.enum(["bullet", "number"]),
  items: z.array(z.string().max(1000)).min(1).max(100),
});

export const pricingRowSchema = z.object({
  id: blockIdSchema,
  description: z.string().max(300),
  // Up to two decimal places: 1.5 hours, 0.25 days.
  quantity: z.number().finite().min(0).max(1_000_000),
  // Minor units (cents), so totals never pick up floating-point error.
  unitPriceCents: z.number().int().min(0).max(100_000_000_000),
  discountPercent: z.number().finite().min(0).max(100).default(0),
});

const pricingBlockSchema = z.object({
  id: blockIdSchema,
  type: z.literal("pricing"),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/, "Use a three-letter currency code such as USD"),
  rows: z.array(pricingRowSchema).min(1).max(MAX_PRICING_ROWS),
  taxPercent: z.number().finite().min(0).max(100).default(0),
  taxLabel: z.string().trim().max(40).default("Tax"),
});

const signatureBlockSchema = z.object({
  id: blockIdSchema,
  type: z.literal("signature"),
  roleId: roleIdSchema,
});

export const inlineFieldTypes = [
  "text",
  "date",
  "number",
  "checkbox",
  "initials",
] as const;

const fieldBlockSchema = z.object({
  id: blockIdSchema,
  type: z.literal("field"),
  fieldType: z.enum(inlineFieldTypes),
  roleId: roleIdSchema,
  label: z.string().trim().max(120).default(""),
  required: z.boolean().default(true),
});

const dividerBlockSchema = z.object({
  id: blockIdSchema,
  type: z.literal("divider"),
});

const pageBreakBlockSchema = z.object({
  id: blockIdSchema,
  type: z.literal("pageBreak"),
});

export const builderBlockSchema = z.discriminatedUnion("type", [
  headingBlockSchema,
  paragraphBlockSchema,
  listBlockSchema,
  pricingBlockSchema,
  signatureBlockSchema,
  fieldBlockSchema,
  dividerBlockSchema,
  pageBreakBlockSchema,
]);

export const pageSizes = {
  a4: { heightPt: 841.89, label: "A4", widthPt: 595.28 },
  letter: { heightPt: 792, label: "US Letter", widthPt: 612 },
} as const;

export type PageSize = keyof typeof pageSizes;

export const builderContentSchema = z
  .object({
    version: z.literal(BUILDER_DOCUMENT_VERSION),
    pageSize: z.enum(["letter", "a4"]).default("letter"),
    roles: z.array(builderRoleSchema).min(1).max(MAX_BUILDER_ROLES),
    variables: z.array(builderVariableSchema).max(MAX_BUILDER_VARIABLES),
    blocks: z.array(builderBlockSchema).max(MAX_BUILDER_BLOCKS),
  })
  .superRefine((content, ctx) => {
    const roleIds = new Set<string>();

    content.roles.forEach((role, index) => {
      if (roleIds.has(role.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Each signer role needs its own id",
          path: ["roles", index, "id"],
        });
      }
      roleIds.add(role.id);
    });

    const keys = new Set<string>();

    content.variables.forEach((variable, index) => {
      const key = variable.key.toLowerCase();

      if (keys.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `The variable {{${variable.key}}} is defined twice`,
          path: ["variables", index, "key"],
        });
      }
      keys.add(key);
    });

    const blockIds = new Set<string>();

    content.blocks.forEach((block, index) => {
      if (blockIds.has(block.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Each block needs its own id",
          path: ["blocks", index, "id"],
        });
      }
      blockIds.add(block.id);

      if (
        (block.type === "signature" || block.type === "field") &&
        !roleIds.has(block.roleId)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "This block belongs to a signer role that no longer exists",
          path: ["blocks", index, "roleId"],
        });
      }
    });
  });

export const builderTitleSchema = z
  .string()
  .trim()
  .min(1, "Give the document a title")
  .max(MAX_TITLE_LENGTH, `Keep the title to ${MAX_TITLE_LENGTH} characters`);

export type BuilderRole = z.infer<typeof builderRoleSchema>;
export type BuilderVariable = z.infer<typeof builderVariableSchema>;
export type BuilderBlock = z.infer<typeof builderBlockSchema>;
export type BuilderContent = z.infer<typeof builderContentSchema>;
export type PricingBlock = Extract<BuilderBlock, { type: "pricing" }>;
export type PricingRow = z.infer<typeof pricingRowSchema>;
export type InlineFieldType = (typeof inlineFieldTypes)[number];

export function emptyBuilderContent(): BuilderContent {
  return {
    blocks: [],
    pageSize: "letter",
    roles: [{ id: "role-1", name: "Client" }],
    variables: [],
    version: BUILDER_DOCUMENT_VERSION,
  };
}

// --- Variables --------------------------------------------------------------

const VARIABLE_REFERENCE = /\{\{\s*([A-Za-z][A-Za-z0-9_.]{0,39})\s*\}\}/g;

/** Every variable name a piece of text refers to, in order of appearance. */
export function findVariableReferences(text: string): string[] {
  return [...text.matchAll(VARIABLE_REFERENCE)].map((match) => match[1]!);
}

function blockTexts(block: BuilderBlock): string[] {
  switch (block.type) {
    case "heading":
    case "paragraph":
      return [block.text];
    case "list":
      return block.items;
    case "pricing":
      return block.rows.map((row) => row.description);
    case "field":
      return [block.label];
    default:
      return [];
  }
}

/** Variables used in the document, with whether each has a value. */
export function collectVariableUsage(content: BuilderContent): {
  missing: string[];
  undefinedKeys: string[];
  used: string[];
} {
  const values = variableValueMap(content.variables);
  const used = new Set<string>();

  for (const block of content.blocks) {
    for (const text of blockTexts(block)) {
      for (const key of findVariableReferences(text)) {
        used.add(key);
      }
    }
  }

  const usedList = [...used];

  return {
    missing: usedList.filter((key) => {
      const value = values.get(key.toLowerCase());

      return value !== undefined && value.trim() === "";
    }),
    undefinedKeys: usedList.filter((key) => !values.has(key.toLowerCase())),
    used: usedList,
  };
}

function variableValueMap(variables: BuilderVariable[]): Map<string, string> {
  return new Map(
    variables.map((variable) => [variable.key.toLowerCase(), variable.value]),
  );
}

/**
 * Text with every {{variable}} filled in. A variable with no value is shown
 * as its name in brackets, so a preview makes the gap obvious instead of
 * leaving a silent blank in an agreement.
 */
export function fillVariables(
  text: string,
  variables: BuilderVariable[],
): string {
  const values = variableValueMap(variables);

  return text.replace(VARIABLE_REFERENCE, (_, key: string) => {
    const value = values.get(key.toLowerCase());

    return value !== undefined && value.trim() !== "" ? value : `[${key}]`;
  });
}

/**
 * What stops a document from being sent as it stands, in words the sender
 * can act on. Empty when it is ready.
 */
export function findSendProblems(content: BuilderContent): string[] {
  const problems: string[] = [];
  const usage = collectVariableUsage(content);

  if (usage.undefinedKeys.length > 0) {
    problems.push(
      `Define ${usage.undefinedKeys.map((key) => `{{${key}}}`).join(", ")} under Variables, or remove ${usage.undefinedKeys.length === 1 ? "it" : "them"} from the text.`,
    );
  }

  if (usage.missing.length > 0) {
    problems.push(
      `Fill in ${usage.missing.map((key) => `{{${key}}}`).join(", ")} under Variables.`,
    );
  }

  const rolesWithFields = new Set(
    content.blocks.flatMap((block) =>
      block.type === "signature" || block.type === "field"
        ? [block.roleId]
        : [],
    ),
  );

  for (const role of content.roles) {
    if (!rolesWithFields.has(role.id)) {
      problems.push(
        `${role.name} has nothing to sign. Add a signature block for ${role.name}, or remove the role.`,
      );
    }
  }

  return problems;
}

// --- Inline marks -----------------------------------------------------------

export type TextSegment = { bold: boolean; text: string };

/**
 * Splits text on **bold** markers. An unmatched marker is kept as typed, so
 * nothing the author wrote disappears.
 */
export function parseInlineMarks(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  const pattern = /\*\*([^]+?)\*\*/g;
  let last = 0;

  for (const match of text.matchAll(pattern)) {
    if (match.index > last) {
      segments.push({ bold: false, text: text.slice(last, match.index) });
    }
    segments.push({ bold: true, text: match[1]! });
    last = match.index + match[0].length;
  }

  if (last < text.length) {
    segments.push({ bold: false, text: text.slice(last) });
  }

  return segments.filter((segment) => segment.text.length > 0);
}

// --- Pricing ----------------------------------------------------------------

export type PricingLine = {
  amountCents: number;
  discountCents: number;
  row: PricingRow;
  subtotalCents: number;
};

export type PricingTotals = {
  discountCents: number;
  lines: PricingLine[];
  subtotalCents: number;
  taxCents: number;
  taxableCents: number;
  totalCents: number;
};

/** Rounds half away from zero, the way an invoice is expected to round. */
function roundHalfAway(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

/**
 * The amounts of a pricing table, in minor units. Quantities count to two
 * decimal places; each line's discount and the tax are rounded to the
 * nearest minor unit once, at the line and at the total.
 */
export function calculatePricing(block: PricingBlock): PricingTotals {
  const lines = block.rows.map((row) => {
    const hundredths = Math.round(row.quantity * 100);
    const subtotalCents = roundHalfAway(
      (hundredths * row.unitPriceCents) / 100,
    );
    const discountCents = roundHalfAway(
      (subtotalCents * row.discountPercent) / 100,
    );

    return {
      amountCents: subtotalCents - discountCents,
      discountCents,
      row,
      subtotalCents,
    };
  });
  const subtotalCents = lines.reduce(
    (sum, line) => sum + line.subtotalCents,
    0,
  );
  const discountCents = lines.reduce(
    (sum, line) => sum + line.discountCents,
    0,
  );
  const taxableCents = subtotalCents - discountCents;
  const taxCents = roundHalfAway((taxableCents * block.taxPercent) / 100);

  return {
    discountCents,
    lines,
    subtotalCents,
    taxCents,
    taxableCents,
    totalCents: taxableCents + taxCents,
  };
}

const currencyFormatters = new Map<string, Intl.NumberFormat | null>();
const plainNumber = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
});

/**
 * An amount in hundredths of the currency unit as money, for example
 * 1234500 USD → $12,345.00. A code Intl does not know is written before a
 * plain number instead of failing.
 */
export function formatMoney(cents: number, currency: string): string {
  if (!currencyFormatters.has(currency)) {
    let formatter: Intl.NumberFormat | null = null;

    try {
      formatter = new Intl.NumberFormat("en-US", {
        currency,
        style: "currency",
      });
    } catch {
      formatter = null;
    }
    currencyFormatters.set(currency, formatter);
  }

  const formatter = currencyFormatters.get(currency);

  return formatter
    ? formatter.format(cents / 100)
    : `${currency} ${plainNumber.format(cents / 100)}`;
}

export function formatQuantity(quantity: number): string {
  return Number.isInteger(quantity)
    ? String(quantity)
    : quantity.toFixed(2).replace(/0$/, "");
}

/** Parses "1,250.50" or "1250.5" to minor units; null when it is not money. */
export function parseMoneyInput(value: string): number | null {
  const cleaned = value.replace(/[,\s]/g, "").replace(/^[^\d.-]+/, "");

  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) {
    return null;
  }

  const [whole, fraction = ""] = cleaned.split(".");

  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

// --- Ids --------------------------------------------------------------------

/** A short random id for a new block, row or role. */
export function newBuilderId(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
      : Math.random().toString(36).slice(2, 14);

  return `${prefix}-${random}`;
}
