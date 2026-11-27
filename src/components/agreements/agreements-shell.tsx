"use client";

import { DownloadIcon, SearchIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { AgreementDetailsDialog } from "@/components/agreements/agreement-details-dialog";
import { DocumentThumbnail } from "@/components/shared/document-thumbnail";
import { ShellButton } from "@/components/shared/form-shell";
import { PageHeader } from "@/components/shared/page-header";
import { StatusPanel } from "@/components/shared/status-panel";
import { Button } from "@/components/ui/button";
import type {
  AgreementListItem,
  AgreementListResult,
  AgreementSummary,
} from "@/lib/agreements";
import { cn } from "@/lib/cn";
import type {
  AgreementListFilters,
  AgreementState,
  AgreementView,
} from "@/lib/schemas/agreement";

type AgreementsShellProps = {
  filters: AgreementListFilters;
  initialState?: "error";
  result?: AgreementListResult;
};

/** What the list is narrowed to; the rest of the filters start afresh. */
type ListLocation = Pick<
  AgreementListFilters,
  "cursor" | "envelopeId" | "search" | "state" | "tag" | "view" | "withinDays"
>;

const pageDescription =
  "Signed envelopes as agreements: who they are with, what they are worth, and when they end.";

const stateOptions: readonly { label: string; state?: AgreementState }[] = [
  { label: "All" },
  { label: "Active", state: "active" },
  { label: "Expiring soon", state: "expiring" },
  { label: "Expired", state: "expired" },
  { label: "No end date", state: "no_end_date" },
];

const statePillClasses: Record<AgreementState, string> = {
  active: "pill-success",
  expired: "pill-danger",
  expiring: "pill-warning",
  no_end_date: "pill-neutral",
};

const viewLabels: Record<AgreementView, string> = {
  all: "Everyone's",
  mine: "Mine",
  team: "My team",
};

function buildQuery(location: ListLocation, path: string): string {
  const params = new URLSearchParams();

  if (location.view && location.view !== "mine") {
    params.set("view", location.view);
  }

  if (location.envelopeId) {
    params.set("envelope", location.envelopeId);
  }

  if (location.search) {
    params.set("q", location.search);
  }

  if (location.state) {
    params.set("state", location.state);
  }

  if (location.state === "expiring" && location.withinDays !== undefined) {
    params.set("within", String(location.withinDays));
  }

  if (location.tag) {
    params.set("tag", location.tag);
  }

  if (location.cursor) {
    params.set("cursor", String(location.cursor));
  }

  const query = params.toString();

  return query ? `${path}?${query}` : path;
}

function agreementsHref(location: ListLocation): string {
  return buildQuery(location, "/agreements");
}

export function AgreementsShell({
  filters,
  initialState,
  result,
}: AgreementsShellProps) {
  const router = useRouter();
  const agreements = result?.agreements ?? [];
  // A link from an envelope's page opens its details straight away.
  const [editing, setEditing] = useState<AgreementListItem | null>(() =>
    filters.envelopeId && agreements.length === 1 && agreements[0]?.canEdit
      ? agreements[0]
      : null,
  );
  const view = result?.view ?? "mine";
  const location: ListLocation = {
    search: filters.search,
    state: filters.state,
    tag: filters.tag,
    view,
    withinDays: filters.withinDays,
  };
  const hasFilters = Boolean(
    filters.search || filters.state || filters.tag || filters.envelopeId,
  );

  if (initialState === "error" || !result) {
    return (
      <div className="space-y-5">
        <PageHeader description={pageDescription} title="Agreements" />
        <StatusPanel
          action={{ href: "/agreements", label: "Retry" }}
          description="We couldn't load your agreements. Try again in a moment."
          title="Couldn't load agreements"
          tone="error"
        />
      </div>
    );
  }

  const exportHref = buildQuery(location, "/api/agreements/export");
  const views = result.views;
  const offset = filters.cursor ?? 0;
  const previousCursor = Math.max(0, offset - filters.limit);

  return (
    <div className="space-y-5">
      <PageHeader
        action={
          result.summary.total > 0 ? (
            <Button
              asChild
              className="min-h-12 px-5.5 text-[0.9375rem]"
              variant="outline"
            >
              <a download href={exportHref}>
                <DownloadIcon
                  aria-hidden="true"
                  className="size-[1.125rem]"
                  strokeWidth={2.2}
                />
                Export CSV
              </a>
            </Button>
          ) : null
        }
        description={pageDescription}
        title="Agreements"
      />

      {views.length > 1 ? (
        <nav aria-label="Whose agreements" className="segmented self-start">
          {views.map((option) => (
            <Link
              aria-current={view === option ? "page" : undefined}
              className="segmented-item"
              data-active={view === option}
              href={agreementsHref({ view: option })}
              key={option}
            >
              {viewLabels[option]}
            </Link>
          ))}
        </nav>
      ) : null}

      {result.summary.total === 0 ? (
        <EmptyAgreementsState view={view} />
      ) : (
        <>
          <SummaryFigures location={location} summary={result.summary} />

          <section
            className="space-y-4"
            data-animate="enter"
            data-animate-delay="2"
          >
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <nav
                aria-label="Filter by state"
                className="segmented self-start"
              >
                {stateOptions.map((option) => {
                  const isActive = filters.state === option.state;

                  return (
                    <Link
                      aria-current={isActive ? "page" : undefined}
                      className="segmented-item"
                      data-active={isActive}
                      href={agreementsHref({
                        ...location,
                        state: option.state,
                        withinDays: undefined,
                      })}
                      key={option.label}
                    >
                      {option.label}
                    </Link>
                  );
                })}
              </nav>

              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                {result.tags.length > 0 || filters.tag ? (
                  <label className="flex items-center gap-2">
                    <span className="text-[0.8125rem] font-semibold text-(--secondary)">
                      Tag
                    </span>
                    <select
                      className="field-input min-h-[2.625rem] py-2 sm:w-44"
                      onChange={(event) =>
                        router.push(
                          agreementsHref({
                            ...location,
                            tag: event.target.value || undefined,
                          }),
                        )
                      }
                      value={filters.tag ?? ""}
                    >
                      <option value="">All tags</option>
                      {filters.tag &&
                      !result.tags.some(
                        (tag) =>
                          tag.toLowerCase() === filters.tag?.toLowerCase(),
                      ) ? (
                        <option value={filters.tag}>{filters.tag}</option>
                      ) : null}
                      {result.tags.map((tag) => (
                        <option key={tag} value={tag}>
                          {tag}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}

                <form
                  action="/agreements"
                  className="w-full sm:w-[19rem]"
                  method="get"
                  role="search"
                >
                  {view !== "mine" ? (
                    <input name="view" type="hidden" value={view} />
                  ) : null}
                  {filters.state ? (
                    <input name="state" type="hidden" value={filters.state} />
                  ) : null}
                  {filters.state === "expiring" &&
                  filters.withinDays !== undefined ? (
                    <input
                      name="within"
                      type="hidden"
                      value={filters.withinDays}
                    />
                  ) : null}
                  {filters.tag ? (
                    <input name="tag" type="hidden" value={filters.tag} />
                  ) : null}
                  <label className="flex min-h-[2.625rem] w-full items-center gap-2.5 rounded-xl bg-white px-3.5 text-(--tertiary) transition focus-within:ring-3 focus-within:ring-ring/50">
                    <SearchIcon
                      aria-hidden="true"
                      className="size-4 shrink-0"
                    />
                    <input
                      aria-label="Search by title or counterparty"
                      className="min-w-0 flex-1 bg-transparent py-2 text-sm text-(--fg) outline-none placeholder:text-(--placeholder)"
                      defaultValue={filters.search ?? ""}
                      maxLength={160}
                      name="q"
                      placeholder="Search by title or counterparty"
                      type="search"
                    />
                  </label>
                </form>
              </div>
            </div>

            {filters.envelopeId ? (
              <p className="notice notice-accent flex flex-wrap items-center justify-between gap-2 font-normal">
                <span>Showing the agreement you opened.</span>
                <Link
                  className="font-semibold underline underline-offset-4"
                  href={agreementsHref({ view })}
                >
                  Show all agreements
                </Link>
              </p>
            ) : filters.state === "expiring" &&
              filters.withinDays !== undefined ? (
              <p className="px-1 text-[0.8125rem] text-(--secondary)">
                Ending within {filters.withinDays} days.{" "}
                <Link
                  className="font-semibold text-(--accent-ink) underline underline-offset-4"
                  href={agreementsHref({ ...location, withinDays: undefined })}
                >
                  Use each agreement&apos;s reminder period instead
                </Link>
              </p>
            ) : null}

            {agreements.length > 0 ? (
              <AgreementsTable
                agreements={agreements}
                onEdit={setEditing}
                showsOwner={view !== "mine"}
              />
            ) : (
              <div className="panel px-6 py-12 text-center">
                <div className="mx-auto max-w-md space-y-3">
                  <h2 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
                    No agreements match these filters
                  </h2>
                  <p className="text-sm leading-6 text-(--secondary)">
                    Try a different title, counterparty, tag or state.
                  </p>
                  {hasFilters ? (
                    <div className="flex justify-center pt-2">
                      <ShellButton
                        href={agreementsHref({ view })}
                        variant="secondary"
                      >
                        Reset filters
                      </ShellButton>
                    </div>
                  ) : null}
                </div>
              </div>
            )}

            {agreements.length > 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-3 px-1">
                <p className="text-[0.8125rem] text-(--tertiary)">
                  {offset > 0 || result.nextCursor
                    ? `Showing ${String(offset + 1)}–${String(offset + agreements.length)}`
                    : agreements.length === 1
                      ? "1 agreement"
                      : `${String(agreements.length)} agreements`}
                </p>
                {offset > 0 || result.nextCursor ? (
                  <nav aria-label="Pages" className="flex items-center gap-2">
                    {offset > 0 ? (
                      <ShellButton
                        href={agreementsHref({
                          ...location,
                          cursor: previousCursor || undefined,
                        })}
                        variant="secondary"
                      >
                        Previous
                      </ShellButton>
                    ) : null}
                    {result.nextCursor ? (
                      <ShellButton
                        href={agreementsHref({
                          ...location,
                          cursor: Number(result.nextCursor),
                        })}
                        variant="secondary"
                      >
                        Next
                      </ShellButton>
                    ) : null}
                  </nav>
                ) : null}
              </div>
            ) : null}
          </section>
        </>
      )}

      {editing ? (
        <AgreementDetailsDialog
          agreement={editing}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function SummaryFigures({
  location,
  summary,
}: {
  location: ListLocation;
  summary: AgreementSummary;
}) {
  const [firstValue, ...otherValues] = summary.valueByCurrency;

  return (
    <dl
      className="grid gap-4 sm:grid-cols-3"
      data-animate="enter"
      data-animate-delay="1"
    >
      <div className="panel flex flex-col gap-2 p-5 sm:p-6">
        <dt className="section-eyebrow">Active</dt>
        <dd className="text-[2rem] font-extrabold leading-none tracking-[-0.03em] text-(--fg) tabular-nums">
          {summary.active}
        </dd>
        <dd className="text-[0.8125rem] leading-5 text-(--tertiary)">
          Not yet due a renewal reminder
        </dd>
      </div>
      <div className="panel flex flex-col gap-2 p-5 sm:p-6">
        <dt className="section-eyebrow">Expiring in 30 days</dt>
        <dd className="text-[2rem] font-extrabold leading-none tracking-[-0.03em] text-(--fg) tabular-nums">
          {summary.expiringWithin30Days}
        </dd>
        <dd className="text-[0.8125rem] leading-5 text-(--tertiary)">
          {summary.expiringWithin30Days > 0 ? (
            <Link
              className="font-semibold text-(--accent-ink) underline underline-offset-4"
              href={agreementsHref({
                search: location.search,
                state: "expiring",
                tag: location.tag,
                view: location.view,
                withinDays: 30,
              })}
            >
              Show them
            </Link>
          ) : (
            "None in the next 30 days"
          )}
        </dd>
      </div>
      <div className="panel flex flex-col gap-2 p-5 sm:p-6">
        <dt className="section-eyebrow">Contract value</dt>
        {firstValue ? (
          <>
            <dd className="truncate text-[2rem] font-extrabold leading-none tracking-[-0.03em] text-(--fg) tabular-nums">
              {firstValue.label}
            </dd>
            {otherValues.map((value) => (
              <dd
                className="text-[0.9375rem] font-bold text-(--fg) tabular-nums"
                key={value.currency}
              >
                {value.label}
              </dd>
            ))}
            <dd className="text-[0.8125rem] leading-5 text-(--tertiary)">
              Agreements that have not ended
            </dd>
          </>
        ) : (
          <dd className="text-[0.9375rem] leading-6 text-(--secondary)">
            No values recorded yet
          </dd>
        )}
      </div>
    </dl>
  );
}

function NotSet() {
  return (
    <span className="text-(--tertiary)">
      <span aria-hidden="true">—</span>
      <span className="sr-only">Not set</span>
    </span>
  );
}

function AgreementsTable({
  agreements,
  onEdit,
  showsOwner,
}: {
  agreements: readonly AgreementListItem[];
  onEdit: (agreement: AgreementListItem) => void;
  showsOwner: boolean;
}) {
  return (
    <div className="panel overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] border-collapse text-left text-sm">
          <caption className="sr-only">Agreements</caption>
          <thead>
            <tr className="border-b border-(--border) bg-(--surface) text-xs text-(--tertiary)">
              <th className="px-5 py-3 font-semibold" scope="col">
                Agreement
              </th>
              <th className="px-4 py-3 font-semibold" scope="col">
                Counterparty
              </th>
              <th className="px-4 py-3 text-right font-semibold" scope="col">
                Value
              </th>
              <th className="px-4 py-3 font-semibold" scope="col">
                Effective
              </th>
              <th className="px-4 py-3 font-semibold" scope="col">
                Ends
              </th>
              <th className="px-4 py-3 font-semibold" scope="col">
                State
              </th>
              <th className="px-5 py-3 font-semibold" scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {agreements.map((agreement) => (
              <tr
                className="border-b border-(--border) align-top last:border-b-0"
                key={agreement.envelopeId}
              >
                <td className="max-w-[18rem] px-5 py-4">
                  <Link
                    className="block truncate font-bold text-(--fg) underline-offset-4 hover:underline"
                    href={`/envelopes/${agreement.envelopeId}`}
                  >
                    {agreement.title}
                  </Link>
                  {showsOwner && agreement.ownerLabel ? (
                    <span className="mt-0.5 block truncate text-[0.8125rem] text-(--secondary)">
                      <span className="sr-only">Sent by </span>
                      {agreement.ownerLabel}
                    </span>
                  ) : null}
                  {agreement.tags.length > 0 ? (
                    <ul
                      aria-label={`Tags of ${agreement.title}`}
                      className="mt-2 flex flex-wrap gap-1.5"
                    >
                      {agreement.tags.map((tag) => (
                        <li className="pill pill-neutral" key={tag}>
                          {tag}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </td>
                <td className="max-w-[14rem] px-4 py-4 text-(--fg)">
                  {agreement.counterparty ? (
                    <span className="block truncate">
                      {agreement.counterparty}
                    </span>
                  ) : (
                    <NotSet />
                  )}
                </td>
                <td className="px-4 py-4 text-right whitespace-nowrap text-(--fg) tabular-nums">
                  {agreement.valueLabel ?? <NotSet />}
                </td>
                <td className="px-4 py-4 whitespace-nowrap text-(--fg)">
                  {agreement.effectiveLabel ?? <NotSet />}
                </td>
                <td className="px-4 py-4 whitespace-nowrap">
                  {agreement.endLabel ? (
                    <>
                      <span className="block text-(--fg)">
                        {agreement.endLabel}
                      </span>
                      <span className="mt-0.5 block text-xs text-(--tertiary)">
                        {agreement.endRelativeLabel}
                        {agreement.autoRenews ? " · Renews automatically" : ""}
                      </span>
                    </>
                  ) : (
                    <NotSet />
                  )}
                </td>
                <td className="px-4 py-4">
                  <span
                    className={cn("pill", statePillClasses[agreement.state])}
                  >
                    {agreement.stateLabel}
                  </span>
                </td>
                <td className="px-5 py-4 text-right">
                  {agreement.canEdit ? (
                    <button
                      aria-label={`Edit details of ${agreement.title}`}
                      className="btn-quiet"
                      onClick={() => onEdit(agreement)}
                      type="button"
                    >
                      Edit details
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EmptyAgreementsState({ view }: { view: AgreementView }) {
  return (
    <section
      className="panel px-6 py-14 sm:py-16"
      data-animate="enter"
      data-animate-delay="1"
    >
      <div className="mx-auto flex max-w-lg flex-col items-center gap-5 text-center">
        <span className="flex h-28 items-center justify-center">
          <DocumentThumbnail title="" />
        </span>
        <div className="space-y-2">
          <h2 className="text-2xl font-extrabold tracking-[-0.03em] text-(--fg)">
            No agreements yet
          </h2>
          <p className="text-[0.9375rem] leading-6 text-(--secondary)">
            {view === "mine"
              ? "When everyone has signed one of your envelopes, it is listed here. Add who it is with, its value and its end date, and you get an email before it ends."
              : "Nobody here has a completed envelope yet."}
          </p>
        </div>
        <ShellButton href="/dashboard">Go to documents</ShellButton>
      </div>
    </section>
  );
}
