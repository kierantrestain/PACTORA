import { toCsv } from "./audit-export.ts";
import {
  type DbExecutor,
  type DbPool,
  getDb,
  queryMany,
  queryOne,
  withTransaction,
} from "./db/connection.ts";
import { formatEnvelopeOwner, sharesTeamCondition } from "./envelope-access.ts";
import {
  agreementListFiltersSchema,
  type AgreementListFilters,
  type AgreementListFiltersInput,
  type AgreementState,
  type AgreementUpdate,
  agreementUpdateSchema,
  type AgreementView,
  DEFAULT_AGREEMENT_CURRENCY,
  DEFAULT_RENEWAL_NOTICE_DAYS,
  formatContractAmountInput,
} from "./schemas/agreement.ts";
import { createEmailService, type EmailService } from "./services/email.ts";
import { resolveAppUrl } from "./utils/env.ts";

// Agreements: completed envelopes, looked at as the contracts they are.
//
// Every completed envelope someone may see is listed, whether or not its
// sender has said anything about it. What they say (who the other side is,
// what it is worth, when it starts and ends, how much notice a renewal
// needs) is kept in agreement_records. Who sees an agreement is who sees
// its envelope, exactly as on the dashboard: the sender, the sender's
// teammates, and an administrator in the "all" view (envelope-access.ts).
// Only the sender changes the details, as only the sender changes an
// envelope.
//
// Dates are calendar dates, YYYY-MM-DD, and "today" is the date in UTC,
// like every other date this app shows.
//
// The daily job (retention-job.ts) emails the sender once for each end
// date, when the end date's notice period opens. See docs/agreements.md.

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** The window of the "Expiring in 30 days" figure. */
export const SUMMARY_EXPIRING_WITHIN_DAYS = 30;
/** Rows in one CSV export. Past this, narrow the filters. */
export const MAX_AGREEMENT_EXPORT_ROWS = 5000;
const REMINDER_BATCH_SIZE = 200;
// Shares the daily job's function call with everything else it does.
const REMINDER_TIME_BUDGET_MS = 30_000;

export class AgreementError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "AgreementError";
    this.statusCode = statusCode;
  }
}

/** What is stored about an agreement, or its defaults when nothing is. */
export type AgreementDetails = {
  autoRenews: boolean;
  contractValueCents: number | null;
  counterparty: string | null;
  currency: string;
  effectiveDate: string | null;
  endDate: string | null;
  notes: string | null;
  renewalNoticeDays: number;
  tags: string[];
};

export type AgreementListItem = AgreementDetails & {
  /** Whether the viewer may change the details: only the sender may. */
  canEdit: boolean;
  completedAt: number | null;
  /** The day it was completed, in UTC. */
  completedDate: string | null;
  completedLabel: string | null;
  daysUntilEnd: number | null;
  effectiveLabel: string | null;
  endLabel: string | null;
  /** "In 12 days", "Today", "3 days ago". */
  endRelativeLabel: string | null;
  envelopeId: string;
  /** False until the sender has saved details for it. */
  hasDetails: boolean;
  /** Who sent it, in a team's list or an administrator's. */
  ownerLabel?: string;
  state: AgreementState;
  stateLabel: string;
  title: string;
  updatedAt: number | null;
  valueLabel: string | null;
};

export type AgreementSummary = {
  /** Ending after their notice period opens. */
  active: number;
  expired: number;
  /** Ending today or within the next 30 days. */
  expiringWithin30Days: number;
  noEndDate: number;
  total: number;
  /**
   * The value of every agreement that has not ended (no end date, or one
   * today or later), for each currency, by currency code.
   */
  valueByCurrency: { currency: string; label: string; totalCents: number }[];
};

export type AgreementListResult = {
  agreements: AgreementListItem[];
  /** Pass as `cursor` for the next page. Absent on the last one. */
  nextCursor?: string;
  summary: AgreementSummary;
  /** Every tag in use in this view, for the tag filter. */
  tags: string[];
  /** Today, in UTC, as the states were worked out. */
  today: string;
  view: AgreementView;
  /** The views this person can choose from. */
  views: AgreementView[];
};

// ---------------------------------------------------------------------------
// Calendar dates

function isoDateToUtcMs(date: string): number {
  const [year, month, day] = date.split("-").map(Number) as [
    number,
    number,
    number,
  ];

  return Date.UTC(year, month - 1, day);
}

/** The UTC calendar date of a Unix time in seconds, YYYY-MM-DD. */
export function utcDateFromUnix(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`: positive when `to` is later. */
export function daysBetween(from: string, to: string): number {
  return Math.round((isoDateToUtcMs(to) - isoDateToUtcMs(from)) / MS_PER_DAY);
}

/** Days from today to the end date: 0 on the day, negative once past. */
export function daysUntilEnd(
  endDate: string | null,
  today: string,
): number | null {
  return endDate ? daysBetween(today, endDate) : null;
}

/**
 * Where an agreement stands today. It is expiring from the day its notice
 * period opens up to and including its end date, and expired the day after.
 * `withinDays` replaces the agreement's own notice period, as the
 * "Expiring in 30 days" figure does.
 */
export function classifyAgreement(
  record: { endDate: string | null; renewalNoticeDays?: number | null },
  today: string,
  withinDays?: number,
): AgreementState {
  const days = daysUntilEnd(record.endDate, today);

  if (days === null) {
    return "no_end_date";
  }

  if (days < 0) {
    return "expired";
  }

  const window =
    withinDays ?? record.renewalNoticeDays ?? DEFAULT_RENEWAL_NOTICE_DAYS;

  return days <= window ? "expiring" : "active";
}

/**
 * The figures above the list. Counts are by each agreement's own state,
 * except the 30-day figure, which uses a fixed window.
 */
export function summarizeAgreements(
  records: readonly Pick<
    AgreementDetails,
    "contractValueCents" | "currency" | "endDate" | "renewalNoticeDays"
  >[],
  today: string,
): AgreementSummary {
  const summary: AgreementSummary = {
    active: 0,
    expired: 0,
    expiringWithin30Days: 0,
    noEndDate: 0,
    total: records.length,
    valueByCurrency: [],
  };
  const totals = new Map<string, number>();

  for (const record of records) {
    const state = classifyAgreement(record, today);

    if (state === "active") {
      summary.active += 1;
    } else if (state === "expired") {
      summary.expired += 1;
    } else if (state === "no_end_date") {
      summary.noEndDate += 1;
    }

    if (
      classifyAgreement(record, today, SUMMARY_EXPIRING_WITHIN_DAYS) ===
      "expiring"
    ) {
      summary.expiringWithin30Days += 1;
    }

    if (state !== "expired" && record.contractValueCents !== null) {
      totals.set(
        record.currency,
        (totals.get(record.currency) ?? 0) + record.contractValueCents,
      );
    }
  }

  summary.valueByCurrency = [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, totalCents]) => ({
      currency,
      label: formatContractValue(totalCents, currency),
      totalCents,
    }));

  return summary;
}

// ---------------------------------------------------------------------------
// Labels

const calendarDateFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
  year: "numeric",
});

const longCalendarDateFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "long",
  timeZone: "UTC",
  year: "numeric",
});

export function formatCalendarDate(date: string): string {
  return calendarDateFormatter.format(new Date(isoDateToUtcMs(date)));
}

function formatLongCalendarDate(date: string): string {
  return longCalendarDateFormatter.format(new Date(isoDateToUtcMs(date)));
}

const currencyFormatters = new Map<string, Intl.NumberFormat>();

/** Hundredths of a currency, such as "$12,500.00" or "¥12,500". */
export function formatContractValue(cents: number, currency: string): string {
  let formatter = currencyFormatters.get(currency);

  if (!formatter) {
    formatter = new Intl.NumberFormat("en-US", { currency, style: "currency" });
    currencyFormatters.set(currency, formatter);
  }

  return formatter.format(cents / 100);
}

export const agreementStateLabels: Record<AgreementState, string> = {
  active: "Active",
  expired: "Expired",
  expiring: "Expiring soon",
  no_end_date: "No end date",
};

function formatRelativeDays(days: number): string {
  if (days === 0) {
    return "Today";
  }

  if (days === 1) {
    return "Tomorrow";
  }

  if (days === -1) {
    return "Yesterday";
  }

  return days > 0 ? `In ${String(days)} days` : `${String(-days)} days ago`;
}

// ---------------------------------------------------------------------------
// Listing

type AgreementRow = {
  autoRenews: boolean | null;
  completedAt: number | null;
  contractValueCents: number | null;
  counterparty: string | null;
  currency: string | null;
  effectiveDate: string | null;
  endDate: string | null;
  envelopeId: string;
  hasDetails: boolean;
  notes: string | null;
  ownerEmail: string;
  ownerName: string | null;
  ownerUserId: string;
  renewalNoticeDays: number | null;
  tags: string[] | null;
  title: string;
  updatedAt: number | null;
};

function escapeLike(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

/** The same envelopes as the dashboard's view of the same name. */
function viewClause(view: AgreementView): string {
  switch (view) {
    case "mine":
      return "e.user_id = $1";
    case "team":
      return `(e.user_id = $1 OR ${sharesTeamCondition("$1", "e")})`;
    case "all":
      // resolveView only gives this view to an administrator; checked here
      // as well, so no other caller can list everyone's by mistake.
      return `(e.user_id = $1 OR EXISTS (
        SELECT 1 FROM public."user" viewer
        WHERE viewer.id = $1 AND viewer.role = 'admin'
      ))`;
  }
}

/** The views someone has, as the dashboard offers them. */
export async function resolveAgreementViews(
  userId: string,
  database: DbExecutor = getDb(),
): Promise<AgreementView[]> {
  const row = await queryOne<{ isAdmin: boolean; onTeam: boolean }>(
    database,
    `
      SELECT
        (role = 'admin') AS "isAdmin",
        EXISTS (SELECT 1 FROM team_members WHERE user_id = $1) AS "onTeam"
      FROM public."user"
      WHERE id = $1
    `,
    [userId],
  );

  return [
    "mine",
    ...(row?.onTeam ? (["team"] as const) : []),
    ...(row?.isAdmin ? (["all"] as const) : []),
  ];
}

const agreementColumns = `
  e.id AS "envelopeId",
  e.title,
  e.user_id AS "ownerUserId",
  owner.email AS "ownerEmail",
  owner.name AS "ownerName",
  e.completed_at AS "completedAt",
  a.envelope_id IS NOT NULL AS "hasDetails",
  a.counterparty,
  a.contract_value_cents AS "contractValueCents",
  a.currency,
  to_char(a.effective_date, 'YYYY-MM-DD') AS "effectiveDate",
  to_char(a.end_date, 'YYYY-MM-DD') AS "endDate",
  a.renewal_notice_days AS "renewalNoticeDays",
  a.auto_renews AS "autoRenews",
  a.tags,
  a.notes,
  a.updated_at AS "updatedAt"
`;

const agreementFrom = `
  FROM envelopes e
  JOIN public."user" owner ON owner.id = e.user_id
  LEFT JOIN agreement_records a ON a.envelope_id = e.id
`;

/**
 * SQL true for agreements in `state`, as classifyAgreement decides it.
 * `today` is a parameter; `window` a parameter or NULL, for each
 * agreement's own notice period.
 */
function stateCondition(
  state: AgreementState,
  today: string,
  window: string,
): string {
  const windowEnd = `(${today}::date + COALESCE(${window}::integer, a.renewal_notice_days, ${String(DEFAULT_RENEWAL_NOTICE_DAYS)}))`;

  switch (state) {
    case "no_end_date":
      return "a.end_date IS NULL";
    case "expired":
      return `a.end_date < ${today}::date`;
    case "expiring":
      return `(a.end_date >= ${today}::date AND a.end_date <= ${windowEnd})`;
    case "active":
      return `a.end_date > ${windowEnd}`;
  }
}

function mapAgreementRow(
  row: AgreementRow,
  viewerUserId: string,
  today: string,
  showsOwner: boolean,
): AgreementListItem {
  const details: AgreementDetails = {
    autoRenews: row.autoRenews ?? false,
    contractValueCents: row.contractValueCents,
    counterparty: row.counterparty,
    currency: row.currency ?? DEFAULT_AGREEMENT_CURRENCY,
    effectiveDate: row.effectiveDate,
    endDate: row.endDate,
    notes: row.notes,
    renewalNoticeDays: row.renewalNoticeDays ?? DEFAULT_RENEWAL_NOTICE_DAYS,
    tags: row.tags ?? [],
  };
  const state = classifyAgreement(details, today);
  const days = daysUntilEnd(details.endDate, today);
  const completedDate =
    row.completedAt === null ? null : utcDateFromUnix(row.completedAt);

  return {
    ...details,
    canEdit: row.ownerUserId === viewerUserId,
    completedAt: row.completedAt,
    completedDate,
    completedLabel: completedDate ? formatCalendarDate(completedDate) : null,
    daysUntilEnd: days,
    effectiveLabel: details.effectiveDate
      ? formatCalendarDate(details.effectiveDate)
      : null,
    endLabel: details.endDate ? formatCalendarDate(details.endDate) : null,
    endRelativeLabel: days === null ? null : formatRelativeDays(days),
    envelopeId: row.envelopeId,
    hasDetails: row.hasDetails,
    ...(showsOwner
      ? {
          ownerLabel: formatEnvelopeOwner({
            ownerEmail: row.ownerEmail,
            ownerName: row.ownerName,
          }),
        }
      : {}),
    state,
    stateLabel: agreementStateLabels[state],
    title: row.title,
    updatedAt: row.updatedAt,
    valueLabel:
      details.contractValueCents === null
        ? null
        : formatContractValue(details.contractValueCents, details.currency),
  };
}

async function queryAgreements(
  viewerUserId: string,
  view: AgreementView,
  filters: AgreementListFilters,
  today: string,
  { limit, offset }: { limit: number; offset: number },
  database: DbExecutor,
): Promise<AgreementListItem[]> {
  const values: unknown[] = [viewerUserId, today];
  const clauses = ["e.status = 'completed'", viewClause(view)];
  const parameter = (value: unknown) => {
    values.push(value);
    return `$${String(values.length)}`;
  };

  if (filters.envelopeId) {
    clauses.push(`e.id = ${parameter(filters.envelopeId)}`);
  }

  if (filters.search) {
    const search = parameter(`%${escapeLike(filters.search.toLowerCase())}%`);

    clauses.push(
      `(lower(e.title) LIKE ${search} ESCAPE '\\' OR lower(COALESCE(a.counterparty, '')) LIKE ${search} ESCAPE '\\')`,
    );
  }

  if (filters.tag) {
    clauses.push(
      `EXISTS (SELECT 1 FROM unnest(a.tags) AS t(tag) WHERE lower(t.tag) = lower(${parameter(filters.tag)}))`,
    );
  }

  if (filters.state) {
    clauses.push(
      stateCondition(
        filters.state,
        "$2",
        // Only "expiring" takes a window of its own; a parameter that the
        // statement does not use would leave Postgres unable to type it.
        filters.state === "expiring" && filters.withinDays !== undefined
          ? parameter(filters.withinDays)
          : "NULL",
      ),
    );
  }

  const limitPlaceholder = parameter(limit);
  const offsetPlaceholder = parameter(offset);
  const rows = await queryMany<AgreementRow>(
    database,
    `
      SELECT ${agreementColumns}
      ${agreementFrom}
      WHERE ${clauses.join(" AND ")}
      ORDER BY
        -- Coming up first, soonest first; then the ended ones, latest
        -- first; then those with no end date, latest completed first.
        CASE
          WHEN a.end_date IS NULL THEN 2
          WHEN a.end_date < $2::date THEN 1
          ELSE 0
        END,
        CASE WHEN a.end_date >= $2::date THEN a.end_date END ASC,
        a.end_date DESC,
        e.completed_at DESC NULLS LAST,
        e.id ASC
      LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}
    `,
    values,
  );

  return rows.map((row) =>
    mapAgreementRow(row, viewerUserId, today, view !== "mine"),
  );
}

type SummaryRow = {
  contractValueCents: number | null;
  currency: string | null;
  endDate: string | null;
  renewalNoticeDays: number | null;
  tags: string[] | null;
};

async function summarizeView(
  viewerUserId: string,
  view: AgreementView,
  today: string,
  database: DbExecutor,
): Promise<{ summary: AgreementSummary; tags: string[] }> {
  const rows = await queryMany<SummaryRow>(
    database,
    `
      SELECT
        a.contract_value_cents AS "contractValueCents",
        a.currency,
        to_char(a.end_date, 'YYYY-MM-DD') AS "endDate",
        a.renewal_notice_days AS "renewalNoticeDays",
        a.tags
      ${agreementFrom}
      WHERE e.status = 'completed' AND ${viewClause(view)}
    `,
    [viewerUserId],
  );
  const tags = new Map<string, string>();

  for (const row of rows) {
    for (const tag of row.tags ?? []) {
      if (!tags.has(tag.toLowerCase())) {
        tags.set(tag.toLowerCase(), tag);
      }
    }
  }

  return {
    summary: summarizeAgreements(
      rows.map((row) => ({
        contractValueCents: row.contractValueCents,
        currency: row.currency ?? DEFAULT_AGREEMENT_CURRENCY,
        endDate: row.endDate,
        renewalNoticeDays: row.renewalNoticeDays ?? DEFAULT_RENEWAL_NOTICE_DAYS,
      })),
      today,
    ),
    tags: [...tags.values()].sort((a, b) =>
      a.localeCompare(b, "en", { sensitivity: "base" }),
    ),
  };
}

/**
 * The view asked for when this person has it, else their own. A link to
 * one envelope's agreement looks in the widest view they have, so that it
 * finds a teammate's too.
 */
async function resolveView(
  userId: string,
  filters: AgreementListFilters,
  database: DbExecutor,
): Promise<{ view: AgreementView; views: AgreementView[] }> {
  const views = await resolveAgreementViews(userId, database);
  const requested =
    filters.view ?? (filters.envelopeId ? views.at(-1) : undefined);

  return {
    view: requested && views.includes(requested) ? requested : "mine",
    views,
  };
}

/**
 * One page of the completed envelopes this person may see in a view, with
 * their agreement details, and the figures for the whole view. A view they
 * do not have falls back to their own.
 */
export async function listAgreementsForUser(
  userId: string,
  filters: AgreementListFiltersInput = {},
  database: DbExecutor = getDb(),
  { now = Math.floor(Date.now() / 1000) }: { now?: number } = {},
): Promise<AgreementListResult> {
  const parsed = agreementListFiltersSchema.parse(filters);
  const today = utcDateFromUnix(now);
  const { view, views } = await resolveView(userId, parsed, database);
  const offset = parsed.cursor ?? 0;
  const [rows, { summary, tags }] = await Promise.all([
    // One more than a page, to tell whether there is a next one.
    queryAgreements(
      userId,
      view,
      parsed,
      today,
      { limit: parsed.limit + 1, offset },
      database,
    ),
    summarizeView(userId, view, today, database),
  ]);
  const hasMore = rows.length > parsed.limit;

  return {
    agreements: rows.slice(0, parsed.limit),
    ...(hasMore ? { nextCursor: String(offset + parsed.limit) } : {}),
    summary,
    tags,
    today,
    view,
    views,
  };
}

/** Every agreement that matches the filters, for a CSV export. */
export async function listAgreementsForExport(
  userId: string,
  filters: AgreementListFiltersInput = {},
  database: DbExecutor = getDb(),
  { now = Math.floor(Date.now() / 1000) }: { now?: number } = {},
): Promise<{ agreements: AgreementListItem[]; view: AgreementView }> {
  const parsed = agreementListFiltersSchema.parse(filters);
  const today = utcDateFromUnix(now);
  const { view } = await resolveView(userId, parsed, database);
  const agreements = await queryAgreements(
    userId,
    view,
    parsed,
    today,
    { limit: MAX_AGREEMENT_EXPORT_ROWS, offset: 0 },
    database,
  );

  return { agreements, view };
}

// ---------------------------------------------------------------------------
// Changing the details

type StoredDetailsRow = Omit<AgreementDetails, "tags"> & { tags: string[] };

/**
 * Saves the details of a completed envelope's agreement, for its sender.
 * Fields left out of `input` keep what they were. Returns the agreement as
 * the list shows it.
 *
 * 404 when the envelope is not there or not the viewer's own, 409 when it
 * is not completed, 400 when the input does not hold together.
 */
export async function updateAgreementRecord(
  userId: string,
  envelopeId: string,
  input: unknown,
  database: DbPool = getDb(),
  { now = Math.floor(Date.now() / 1000) }: { now?: number } = {},
): Promise<AgreementListItem> {
  const parsed = agreementUpdateSchema.safeParse(input);

  if (!parsed.success) {
    throw new AgreementError(
      parsed.error.issues[0]?.message ?? "Check the agreement details.",
      400,
    );
  }

  await withTransaction(async (tx) => {
    // Held until the save is done, so two saves of the same agreement
    // take turns instead of each merging into what the other replaced.
    const envelope = await queryOne<{ status: string }>(
      tx,
      `
        SELECT status
        FROM envelopes
        WHERE id = $1 AND user_id = $2
        FOR NO KEY UPDATE
      `,
      [envelopeId, userId],
    );

    if (!envelope) {
      throw new AgreementError("Agreement not found.", 404);
    }

    if (envelope.status !== "completed") {
      throw new AgreementError(
        "Only a completed envelope can be tracked as an agreement.",
        409,
      );
    }

    const current = await queryOne<StoredDetailsRow>(
      tx,
      `
        SELECT
          counterparty,
          contract_value_cents AS "contractValueCents",
          currency,
          to_char(effective_date, 'YYYY-MM-DD') AS "effectiveDate",
          to_char(end_date, 'YYYY-MM-DD') AS "endDate",
          renewal_notice_days AS "renewalNoticeDays",
          auto_renews AS "autoRenews",
          tags,
          notes
        FROM agreement_records
        WHERE envelope_id = $1
      `,
      [envelopeId],
    );
    const next = mergeAgreementDetails(current, parsed.data);

    if (
      next.effectiveDate &&
      next.endDate &&
      next.endDate < next.effectiveDate
    ) {
      throw new AgreementError(
        "The end date can't be before the effective date.",
        400,
      );
    }

    await tx.query(
      `
        INSERT INTO agreement_records (
          envelope_id, counterparty, contract_value_cents, currency,
          effective_date, end_date, renewal_notice_days, auto_renews, tags,
          notes, created_at, updated_at, updated_by
        ) VALUES (
          $1, $2, $3, $4, $5::date, $6::date, $7, $8, $9::text[], $10, $11,
          $11, $12
        )
        ON CONFLICT (envelope_id) DO UPDATE SET
          counterparty = EXCLUDED.counterparty,
          contract_value_cents = EXCLUDED.contract_value_cents,
          currency = EXCLUDED.currency,
          effective_date = EXCLUDED.effective_date,
          end_date = EXCLUDED.end_date,
          renewal_notice_days = EXCLUDED.renewal_notice_days,
          auto_renews = EXCLUDED.auto_renews,
          tags = EXCLUDED.tags,
          notes = EXCLUDED.notes,
          updated_at = EXCLUDED.updated_at,
          updated_by = EXCLUDED.updated_by
      `,
      [
        envelopeId,
        next.counterparty,
        next.contractValueCents,
        next.currency,
        next.effectiveDate,
        next.endDate,
        next.renewalNoticeDays,
        next.autoRenews,
        next.tags,
        next.notes,
        now,
        userId,
      ],
    );
  }, database);

  const [saved] = await queryAgreements(
    userId,
    "mine",
    agreementListFiltersSchema.parse({ envelopeId }),
    utcDateFromUnix(now),
    { limit: 1, offset: 0 },
    database,
  );

  if (!saved) {
    // Deleted between the save and the read.
    throw new AgreementError("Agreement not found.", 404);
  }

  return saved;
}

/** What is stored, or the defaults, with every field the change names. */
export function mergeAgreementDetails(
  current: AgreementDetails | null,
  change: AgreementUpdate,
): AgreementDetails {
  const base: AgreementDetails = current ?? {
    autoRenews: false,
    contractValueCents: null,
    counterparty: null,
    currency: DEFAULT_AGREEMENT_CURRENCY,
    effectiveDate: null,
    endDate: null,
    notes: null,
    renewalNoticeDays: DEFAULT_RENEWAL_NOTICE_DAYS,
    tags: [],
  };
  const keep = <T>(value: T | undefined, fallback: T): T =>
    value === undefined ? fallback : value;

  return {
    autoRenews: keep(change.autoRenews, base.autoRenews),
    contractValueCents: keep(
      change.contractValueCents,
      base.contractValueCents,
    ),
    counterparty: keep(change.counterparty, base.counterparty),
    currency: keep(change.currency, base.currency),
    effectiveDate: keep(change.effectiveDate, base.effectiveDate),
    endDate: keep(change.endDate, base.endDate),
    notes: keep(change.notes, base.notes),
    renewalNoticeDays: keep(change.renewalNoticeDays, base.renewalNoticeDays),
    tags: keep(change.tags, base.tags),
  };
}

// ---------------------------------------------------------------------------
// CSV

/**
 * The agreements as CSV. Cells a spreadsheet would run as a formula start
 * with an apostrophe (see toCsv). The contract value is a plain number in
 * the currency's unit, so a spreadsheet can add it up.
 */
export function buildAgreementsCsv(rows: readonly AgreementListItem[]): string {
  const showsOwner = rows.some((row) => row.ownerLabel !== undefined);

  return toCsv([
    [
      "Agreement",
      "Envelope ID",
      ...(showsOwner ? ["Sender"] : []),
      "Counterparty",
      "Contract value",
      "Currency",
      "Effective date",
      "End date",
      "Renewal notice (days)",
      "Auto-renews",
      "State",
      "Tags",
      "Notes",
      "Completed",
    ],
    ...rows.map((row) => [
      row.title,
      row.envelopeId,
      ...(showsOwner ? [row.ownerLabel ?? ""] : []),
      row.counterparty,
      row.contractValueCents === null
        ? ""
        : formatContractAmountInput(row.contractValueCents),
      row.contractValueCents === null ? "" : row.currency,
      row.effectiveDate,
      row.endDate,
      row.renewalNoticeDays,
      row.autoRenews ? "Yes" : "No",
      row.stateLabel,
      row.tags.join("; "),
      row.notes,
      row.completedDate,
    ]),
  ]);
}

/** The export's file name, with today's date. */
export function agreementsCsvFileName(today: string): string {
  return `agreements-${today}.csv`;
}

// ---------------------------------------------------------------------------
// Renewal reminders

export type RenewalReminderSummary = {
  /** Envelope ids whose reminder could not be sent; tried again next run. */
  failures: string[];
  remindersSent: number;
  /** True when the time ran out and some reminders wait for the next run. */
  stoppedEarly: boolean;
};

type DueRenewalRow = {
  autoRenews: boolean;
  counterparty: string | null;
  endDate: string;
  envelopeId: string;
  ownerEmail: string;
  ownerName: string | null;
  renewalNoticeDays: number;
  title: string;
};

/**
 * Agreements whose notice period has opened and whose end date has not
 * passed, which have not had a reminder for this end date.
 */
async function listDueRenewals(
  today: string,
  database: DbExecutor,
): Promise<DueRenewalRow[]> {
  return queryMany<DueRenewalRow>(
    database,
    `
      SELECT
        e.id AS "envelopeId",
        e.title,
        u.email AS "ownerEmail",
        u.name AS "ownerName",
        a.counterparty,
        to_char(a.end_date, 'YYYY-MM-DD') AS "endDate",
        a.renewal_notice_days AS "renewalNoticeDays",
        a.auto_renews AS "autoRenews"
      FROM envelopes e
      JOIN agreement_records a ON a.envelope_id = e.id
      JOIN public."user" u ON u.id = e.user_id
      WHERE e.status = 'completed'
        AND a.end_date IS NOT NULL
        AND a.end_date >= $1::date
        AND a.end_date - a.renewal_notice_days <= $1::date
        AND a.renewal_reminded_for IS DISTINCT FROM a.end_date
      ORDER BY a.end_date ASC, e.id ASC
      LIMIT ${String(REMINDER_BATCH_SIZE)}
    `,
    [today],
  );
}

export function buildRenewalReminder(
  agreement: DueRenewalRow,
  today: string,
  appUrl: string | undefined,
) {
  const days = daysBetween(today, agreement.endDate);
  const endsOn = formatLongCalendarDate(agreement.endDate);
  const when =
    days === 0
      ? "today"
      : days === 1
        ? `tomorrow, ${endsOn}`
        : `on ${endsOn}, in ${String(days)} days`;
  const withWhom = agreement.counterparty
    ? ` with ${agreement.counterparty}`
    : "";
  const link = appUrl
    ? `${appUrl}/agreements?envelope=${encodeURIComponent(agreement.envelopeId)}`
    : null;

  return {
    subject: agreement.autoRenews
      ? `"${agreement.title}" renews ${days === 0 ? "today" : `on ${formatCalendarDate(agreement.endDate)}`}`
      : `"${agreement.title}" ends ${days === 0 ? "today" : `on ${formatCalendarDate(agreement.endDate)}`}`,
    template: "renewal_reminder" as const,
    textBody: [
      `Hello ${agreement.ownerName?.trim() || agreement.ownerEmail},`,
      "",
      agreement.autoRenews
        ? `"${agreement.title}"${withWhom} renews automatically ${when}. If you mean to cancel or change it, check how much notice it needs and give it now.`
        : `"${agreement.title}"${withWhom} ends ${when}. If it should go on, now is the time to agree a renewal.`,
      "",
      `This reminder was set for ${String(agreement.renewalNoticeDays)} ${agreement.renewalNoticeDays === 1 ? "day" : "days"} before the end date. You can change the dates and the notice period on the Agreements page.`,
      ...(link ? ["", link] : []),
    ].join("\n"),
    to: agreement.ownerEmail,
  };
}

/**
 * Emails the sender of each agreement whose renewal notice period has
 * opened: once for each end date, from the day the period opens until the
 * end date itself. Run by the daily job.
 *
 * The email is sent first and noted afterwards, as expiry notices are
 * (envelope-schedule.ts): a reminder that fails is still due on the next
 * run, and the mail provider drops a repeat within its idempotency window.
 * A failure is counted and logged, and never stops the run.
 */
export async function sendDueRenewalReminders(
  database: DbPool,
  now: number = Math.floor(Date.now() / 1000),
  {
    appUrl,
    emailService,
    timeBudgetMs = REMINDER_TIME_BUDGET_MS,
  }: {
    appUrl?: string;
    emailService?: EmailService;
    timeBudgetMs?: number;
  } = {},
): Promise<RenewalReminderSummary> {
  const summary: RenewalReminderSummary = {
    failures: [],
    remindersSent: 0,
    stoppedEarly: false,
  };
  const today = utcDateFromUnix(now);
  const stopAt = Date.now() + timeBudgetMs;
  const due = await listDueRenewals(today, database);
  const link = due.length > 0 ? (appUrl ?? resolveAppUrl()) : undefined;
  let service = emailService;
  // Made only when there is something to send.
  const getEmailService = () => (service ??= createEmailService());

  for (const agreement of due) {
    if (Date.now() >= stopAt) {
      summary.stoppedEarly = true;
      break;
    }

    try {
      // The sender may have changed the end date since the list was read.
      const stillDue = await queryOne<{ envelopeId: string }>(
        database,
        `
          SELECT envelope_id AS "envelopeId"
          FROM agreement_records
          WHERE envelope_id = $1
            AND end_date = $2::date
            AND renewal_reminded_for IS DISTINCT FROM end_date
        `,
        [agreement.envelopeId, agreement.endDate],
      );

      if (!stillDue) {
        continue;
      }

      await getEmailService().send(
        buildRenewalReminder(agreement, today, link),
        {
          idempotencyKey: `agreement-renewal/${agreement.envelopeId}/${agreement.endDate}`,
        },
      );
      await database.query(
        `
          UPDATE agreement_records
          SET renewal_reminded_for = end_date
          WHERE envelope_id = $1 AND end_date = $2::date
        `,
        [agreement.envelopeId, agreement.endDate],
      );

      summary.remindersSent += 1;
    } catch (error) {
      summary.failures.push(agreement.envelopeId);
      console.error(
        `Renewal reminder failed for envelope ${agreement.envelopeId}:`,
        error,
      );
    }
  }

  return summary;
}
