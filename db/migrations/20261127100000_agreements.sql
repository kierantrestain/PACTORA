-- Agreements: what the sender knows about a completed envelope as a
-- contract, so finished envelopes can be found, exported and renewed on
-- time. See src/lib/agreements.ts and docs/agreements.md.
--
-- * agreement_records: one row for each completed envelope its sender has
--   described. An envelope with no row is still listed as an agreement,
--   with nothing filled in. The row goes when the envelope does.
--
--   Dates are calendar dates, with no time of day or time zone: the day an
--   agreement takes effect and the day it ends, as written in it. The app
--   counts days in UTC.
--
--   contract_value_cents is the value in hundredths of the currency's unit,
--   whatever the currency.
--
--   renewal_reminded_for is the end date a renewal reminder has been sent
--   for. A reminder goes out once for each end date: a new end date is due
--   a reminder of its own.
--
--   created_at, updated_at: Unix seconds, like every other table here.

-- True when every tag is 1 to 40 characters with no space at either end.
-- A check constraint cannot look inside an array by itself.
create or replace function public.signudoc_agreement_tags_valid(tags text[])
returns boolean
language sql
immutable
as $$
  select coalesce(
    bool_and(length(tag) between 1 and 40 and tag = btrim(tag)),
    true
  )
  from unnest(tags) as tag
$$;

create table if not exists public.agreement_records (
  envelope_id text primary key
    references public.envelopes(id) on delete cascade,
  counterparty text
    check (counterparty is null or length(btrim(counterparty)) between 1 and 200),
  contract_value_cents bigint
    check (
      contract_value_cents is null
      or contract_value_cents between 0 and 10000000000000
    ),
  currency text not null default 'USD'
    check (currency ~ '^[A-Z]{3}$'),
  effective_date date,
  end_date date,
  renewal_notice_days integer not null default 30
    check (renewal_notice_days between 0 and 365),
  auto_renews boolean not null default false,
  tags text[] not null default '{}'
    check (
      cardinality(tags) <= 20
      and array_position(tags, null) is null
      and public.signudoc_agreement_tags_valid(tags)
    ),
  notes text
    check (notes is null or length(notes) <= 4000),
  renewal_reminded_for date,
  created_at bigint not null default (extract(epoch from now())::bigint),
  updated_at bigint not null default (extract(epoch from now())::bigint),
  updated_by text references public."user"(id) on delete set null,
  constraint agreement_records_end_after_effective
    check (
      effective_date is null
      or end_date is null
      or end_date >= effective_date
    )
);

-- The agreements list is ordered by end date, and the daily job looks for
-- end dates coming up that have not had their reminder.
create index if not exists agreement_records_end_date_idx
  on public.agreement_records (end_date, envelope_id)
  where end_date is not null;

create index if not exists agreement_records_reminder_due_idx
  on public.agreement_records (end_date)
  where end_date is not null
    and renewal_reminded_for is distinct from end_date;
