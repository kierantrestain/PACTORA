# Agreements

How completed envelopes are kept track of as agreements, and how renewal reminders work.

- [How it works](#how-it-works)
- [What is tracked](#what-is-tracked)
- [Renewal reminders](#renewal-reminders)
- [Who can do what](#who-can-do-what)
- [For developers](#for-developers)

## How it works

Once everyone has signed an envelope, it is listed under **Agreements**. Nothing has to be filled in for it to be there. Its sender opens **Edit details** to record who it is with, what it is worth and when it ends. The envelope's page links there too: **Agreement details**, on a completed envelope.

The list shows the agreement's title (a link to the envelope), counterparty, value, effective date, end date and state. It can be searched by title or counterparty, and narrowed by state and by tag. Above the list are three figures for the whole view: how many agreements are active, how many end in the next 30 days, and the total value of those that have not ended, for each currency. **Export CSV** downloads every agreement that matches the filters, up to 5,000.

Each agreement is in one state:

| State         | When                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------- |
| Active        | It ends further away than its reminder period (more than 30 days, unless changed).       |
| Expiring soon | It ends today or within its reminder period. The end date itself is still in this state. |
| Expired       | Its end date has passed, from the day after the end date.                                |
| No end date   | No end date has been recorded.                                                           |

"Expiring in 30 days" counts agreements ending today or in the next 30 days, whatever their own reminder period; its **Show them** link lists those.

Dates are calendar days with no time of day. "Today" is the date in UTC, as everywhere else in the app.

## What is tracked

For each completed envelope, all optional:

- **Counterparty**: the company or person on the other side, up to 200 characters.
- **Contract value** and **currency**: stored in hundredths of the currency's unit, up to 100 billion, with a three-letter currency code (USD unless changed).
- **Effective date** and **end date**. The end date can't be before the effective date. The first time details are edited, the effective date is filled in with the day the envelope was completed.
- **Renewal reminder**: how many days before the end date to be reminded, from 0 to 365. 30 unless changed.
- **Renews automatically**: shown in the list and changes the reminder's wording. It does not move the end date: once the agreement has renewed, set the new end date.
- **Tags**: up to 20, each up to 40 characters. Repeats, in any case, are dropped.
- **Notes**: up to 4,000 characters.

The details are kept with the envelope. If the envelope is deleted (by an administrator, or by the install's retention settings), its details go with it. They are not part of the signed document, its certificate or its audit trail.

## Renewal reminders

The daily job (`/api/internal/retention`, see [self-hosting](self-hosting.md)) emails the sender of each agreement whose reminder period has started and whose end date is today or later. With the defaults, that is 30 days before the end date. A reminder is sent once for each end date: changing the end date makes the new date due a reminder of its own, and setting the same end date again does not.

A reminder that cannot be sent (for example, because email is not set up) is tried again the next day. A failed reminder is logged and listed under `renewals` in the job's summary, but does not make the job's run count as failed. An agreement whose end date is entered after its reminder period has started gets its reminder on the next run. An end date in the past gets none.

## Who can do what

Who sees an agreement is who sees its envelope (see [teams](teams.md)): the sender, people on a team with the sender (**My team**), and an administrator (**Everyone's**). Only the sender edits the details.

## For developers

- Table: `agreement_records`, one row per described envelope (`db/migrations/20261127100000_agreements.sql`).
- Code: `src/lib/agreements.ts`, with the input and filter schemas in `src/lib/schemas/agreement.ts`.
- Session routes (not part of the `/api/v1` API):
  - `GET /api/agreements`: query parameters `q`, `tag`, `state` (`active`, `expiring`, `expired`, `no_end_date`), `within` (days, with `state=expiring`), `view` (`mine`, `team`, `all`), `envelope`, `cursor`, `limit` (up to 100). Answers `{ agreements, summary, tags, view, nextCursor? }`.
  - `PATCH /api/agreements/{envelopeId}`: any of `counterparty`, `contractValueCents`, `currency`, `effectiveDate`, `endDate` (YYYY-MM-DD), `renewalNoticeDays`, `autoRenews`, `tags`, `notes`. Fields left out keep their value; `null` or an empty string clears one. 404 when the envelope is not the caller's own, 409 when it is not completed, 400 for input that does not hold together.
  - `GET /api/agreements/export`: the same filters as the list, as `text/csv`. Cells that a spreadsheet would read as a formula start with an apostrophe.
