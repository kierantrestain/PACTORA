import { z } from "zod";

// What can be said about a completed envelope as an agreement, and the
// filters of the agreements list. Shared by the API routes and the edit
// dialog, so nothing here may reach for the server.

export const MAX_AGREEMENT_COUNTERPARTY_LENGTH = 200;
export const MAX_AGREEMENT_NOTES_LENGTH = 4000;
export const MAX_AGREEMENT_TAGS = 20;
export const MAX_AGREEMENT_TAG_LENGTH = 40;
export const MAX_RENEWAL_NOTICE_DAYS = 365;
export const DEFAULT_RENEWAL_NOTICE_DAYS = 30;
export const DEFAULT_AGREEMENT_CURRENCY = "USD";
/** 100 billion in hundredths: far past any real contract, well inside a JS number. */
export const MAX_CONTRACT_VALUE_CENTS = 10_000_000_000_000;
export const MAX_AGREEMENT_PAGE_SIZE = 100;
export const DEFAULT_AGREEMENT_PAGE_SIZE = 50;

/**
 * - active: ends after its renewal notice window opens, or later.
 * - expiring: ends within the notice window (or a window asked for), today
 *   included.
 * - expired: the end date has passed.
 * - no_end_date: no end date is known.
 */
export const agreementStates = [
  "active",
  "expiring",
  "expired",
  "no_end_date",
] as const;

export type AgreementState = (typeof agreementStates)[number];

/** Whose agreements a list shows, as on the dashboard. */
export const agreementViews = ["mine", "team", "all"] as const;

export type AgreementView = (typeof agreementViews)[number];

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * True for a real calendar date written YYYY-MM-DD, between the years 1900
 * and 2999. "2027-02-30" is not one.
 */
export function isIsoDate(value: string): boolean {
  const match = ISO_DATE_PATTERN.exec(value);

  if (!match) {
    return false;
  }

  const [year, month, day] = [match[1], match[2], match[3]].map(Number) as [
    number,
    number,
    number,
  ];

  if (year < 1900 || year > 2999) {
    return false;
  }

  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function blankToNull(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : null;
}

const optionalDateSchema = z.preprocess(
  blankToNull,
  z
    .string()
    .refine(isIsoDate, { message: "Enter dates as YYYY-MM-DD." })
    .nullable()
    .optional(),
);

/** Trimmed, inner runs of space made one, repeats (in any case) dropped. */
const tagsSchema = z
  .array(
    z
      .string()
      .transform((tag) => tag.trim().replace(/\s+/g, " "))
      .pipe(
        z
          .string()
          .min(1, { message: "A tag can't be empty." })
          .max(MAX_AGREEMENT_TAG_LENGTH, {
            message: `Keep each tag to ${String(MAX_AGREEMENT_TAG_LENGTH)} characters.`,
          }),
      ),
  )
  .transform((tags) => {
    const seen = new Set<string>();

    return tags.filter((tag) => {
      const key = tag.toLowerCase();

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
  })
  .pipe(
    z.array(z.string()).max(MAX_AGREEMENT_TAGS, {
      message: `Use at most ${String(MAX_AGREEMENT_TAGS)} tags.`,
    }),
  );

/**
 * A change to an agreement's details. Every field is optional: what is left
 * out keeps its current value, or its default for an agreement described
 * for the first time. An empty text or date clears it.
 */
export const agreementUpdateSchema = z
  .object({
    autoRenews: z.boolean().optional(),
    contractValueCents: z
      .number()
      .int({ message: "Enter the value in whole hundredths." })
      .min(0, { message: "The contract value can't be negative." })
      .max(MAX_CONTRACT_VALUE_CENTS, {
        message: "That contract value is too large.",
      })
      .nullable()
      .optional(),
    counterparty: z.preprocess(
      blankToNull,
      z
        .string()
        .max(MAX_AGREEMENT_COUNTERPARTY_LENGTH, {
          message: `Keep the counterparty to ${String(MAX_AGREEMENT_COUNTERPARTY_LENGTH)} characters.`,
        })
        .nullable()
        .optional(),
    ),
    currency: z.preprocess(
      (value) =>
        typeof value === "string" ? value.trim().toUpperCase() : value,
      z
        .string()
        .regex(/^[A-Z]{3}$/, {
          message: "Use a three-letter currency code, such as USD or EUR.",
        })
        .optional(),
    ),
    effectiveDate: optionalDateSchema,
    endDate: optionalDateSchema,
    notes: z.preprocess(
      (value) =>
        typeof value === "string" && value.trim().length === 0 ? null : value,
      z
        .string()
        .max(MAX_AGREEMENT_NOTES_LENGTH, {
          message: `Keep notes to ${String(MAX_AGREEMENT_NOTES_LENGTH)} characters.`,
        })
        .nullable()
        .optional(),
    ),
    renewalNoticeDays: z
      .number()
      .int({ message: "Give the notice period in whole days." })
      .min(0, { message: "The notice period can't be negative." })
      .max(MAX_RENEWAL_NOTICE_DAYS, {
        message: `Keep the notice period to ${String(MAX_RENEWAL_NOTICE_DAYS)} days or fewer.`,
      })
      .optional(),
    tags: tagsSchema.optional(),
  })
  .strict();

export type AgreementUpdateInput = z.input<typeof agreementUpdateSchema>;
export type AgreementUpdate = z.output<typeof agreementUpdateSchema>;

function firstString(value: unknown): unknown {
  return Array.isArray(value) ? (value[0] as unknown) : value;
}

/** An unknown or empty value is no filter at all, rather than an error. */
function lenientEnum<T extends readonly [string, ...string[]]>(values: T) {
  return z.preprocess((value) => {
    const first = firstString(value);

    return typeof first === "string" &&
      (values as readonly string[]).includes(first)
      ? first
      : undefined;
  }, z.enum(values).optional());
}

/**
 * The filters of the agreements list, from a query string or the page's
 * address. What cannot be read is ignored, the way the dashboard does.
 */
export const agreementListFiltersSchema = z.object({
  /** An opaque place in the list, from a previous page's nextCursor. */
  cursor: z.preprocess((value) => {
    const first = firstString(value);

    if (typeof first === "number") {
      return Number.isSafeInteger(first) && first >= 0 ? first : undefined;
    }

    return typeof first === "string" && /^\d{1,9}$/.test(first)
      ? Number(first)
      : undefined;
  }, z.number().int().nonnegative().optional()),
  /** Only this envelope's agreement, for a link from the envelope's page. */
  envelopeId: z.preprocess(
    (value) => blankToNull(firstString(value)) ?? undefined,
    z.string().max(200).optional(),
  ),
  limit: z.preprocess((value) => {
    const number = Number(firstString(value));

    return Number.isInteger(number) && number > 0
      ? Math.min(number, MAX_AGREEMENT_PAGE_SIZE)
      : undefined;
  }, z.number().int().positive().max(MAX_AGREEMENT_PAGE_SIZE).default(DEFAULT_AGREEMENT_PAGE_SIZE)),
  search: z.preprocess(
    (value) => blankToNull(firstString(value)) ?? undefined,
    z
      .string()
      .transform((search) => search.slice(0, 160))
      .optional(),
  ),
  state: lenientEnum(agreementStates),
  tag: z.preprocess(
    (value) => blankToNull(firstString(value)) ?? undefined,
    z.string().max(MAX_AGREEMENT_TAG_LENGTH).optional(),
  ),
  view: lenientEnum(agreementViews),
  /**
   * With state "expiring": ending within this many days, instead of within
   * each agreement's own notice period.
   */
  withinDays: z.preprocess((value) => {
    const number = Number(firstString(value));

    return Number.isInteger(number) &&
      number >= 0 &&
      number <= MAX_RENEWAL_NOTICE_DAYS
      ? number
      : undefined;
  }, z.number().int().nonnegative().max(MAX_RENEWAL_NOTICE_DAYS).optional()),
});

export type AgreementListFilters = z.output<typeof agreementListFiltersSchema>;
export type AgreementListFiltersInput = Partial<AgreementListFilters>;

/** Reads search parameters (a URLSearchParams or a page's searchParams). */
export function parseAgreementListFilters(
  params:
    URLSearchParams | Record<string, string | string[] | undefined> | undefined,
): AgreementListFilters {
  const record =
    params instanceof URLSearchParams
      ? Object.fromEntries(params.entries())
      : (params ?? {});

  return agreementListFiltersSchema.parse({
    cursor: record.cursor,
    envelopeId: record.envelope,
    limit: record.limit,
    search: record.q,
    state: record.state,
    tag: record.tag,
    view: record.view,
    withinDays: record.within,
  });
}

/**
 * A typed amount such as "12,500.50" as hundredths, null for an empty box,
 * or undefined when it is not an amount.
 */
export function parseContractAmount(value: string): number | null | undefined {
  const cleaned = value.trim().replace(/[\s,]/g, "");

  if (cleaned.length === 0) {
    return null;
  }

  const match = /^(\d+)(?:\.(\d{0,2}))?$/.exec(cleaned);

  if (!match) {
    return undefined;
  }

  const cents =
    Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));

  return Number.isSafeInteger(cents) && cents <= MAX_CONTRACT_VALUE_CENTS
    ? cents
    : undefined;
}

/** Hundredths as an amount to edit, such as "12500.50". */
export function formatContractAmountInput(cents: number | null): string {
  if (cents === null) {
    return "";
  }

  const whole = Math.floor(cents / 100);
  const fraction = cents % 100;

  return fraction === 0
    ? String(whole)
    : `${String(whole)}.${String(fraction).padStart(2, "0")}`;
}
