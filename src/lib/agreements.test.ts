import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type AgreementListItem,
  buildAgreementsCsv,
  buildRenewalReminder,
  classifyAgreement,
  daysBetween,
  daysUntilEnd,
  formatContractValue,
  mergeAgreementDetails,
  summarizeAgreements,
  utcDateFromUnix,
} from "./agreements.ts";
import {
  agreementUpdateSchema,
  formatContractAmountInput,
  isIsoDate,
  parseAgreementListFilters,
  parseContractAmount,
} from "./schemas/agreement.ts";

const today = "2026-11-27";

function agreement(
  overrides: Partial<AgreementListItem> = {},
): AgreementListItem {
  return {
    autoRenews: false,
    canEdit: true,
    completedAt: 1_790_000_000,
    completedDate: "2026-09-21",
    completedLabel: "Sep 21, 2026",
    contractValueCents: null,
    counterparty: null,
    currency: "USD",
    daysUntilEnd: null,
    effectiveDate: null,
    effectiveLabel: null,
    endDate: null,
    endLabel: null,
    endRelativeLabel: null,
    envelopeId: "env-1",
    hasDetails: false,
    notes: null,
    renewalNoticeDays: 30,
    state: "no_end_date",
    stateLabel: "No end date",
    tags: [],
    title: "Master services agreement",
    updatedAt: null,
    valueLabel: null,
    ...overrides,
  };
}

test("an agreement is expiring from the day its notice period opens to its end date", () => {
  const record = { endDate: "2026-12-27", renewalNoticeDays: 30 };

  // 31 days out: the notice period has not opened.
  assert.equal(classifyAgreement(record, "2026-11-26"), "active");
  // 30 days out: it opens today.
  assert.equal(classifyAgreement(record, "2026-11-27"), "expiring");
  assert.equal(classifyAgreement(record, "2026-12-26"), "expiring");
  // The end date itself is still in force.
  assert.equal(classifyAgreement(record, "2026-12-27"), "expiring");
  // The day after, it has ended.
  assert.equal(classifyAgreement(record, "2026-12-28"), "expired");
});

test("a notice period of 0 days makes only the end date itself expiring", () => {
  const record = { endDate: today, renewalNoticeDays: 0 };

  assert.equal(classifyAgreement(record, "2026-11-26"), "active");
  assert.equal(classifyAgreement(record, today), "expiring");
  assert.equal(classifyAgreement(record, "2026-11-28"), "expired");
});

test("an agreement with no end date is in its own state", () => {
  assert.equal(
    classifyAgreement({ endDate: null, renewalNoticeDays: 30 }, today),
    "no_end_date",
  );
  assert.equal(daysUntilEnd(null, today), null);
});

test("a window given to classifyAgreement replaces the agreement's own notice period", () => {
  const record = { endDate: "2027-01-26", renewalNoticeDays: 90 };

  assert.equal(classifyAgreement(record, today), "expiring");
  assert.equal(classifyAgreement(record, today, 30), "active");
  assert.equal(classifyAgreement(record, today, 60), "expiring");
});

test("days are counted between calendar dates, not clock times", () => {
  assert.equal(daysUntilEnd(today, today), 0);
  assert.equal(daysUntilEnd("2026-11-28", today), 1);
  assert.equal(daysUntilEnd("2026-11-20", today), -7);
  // Across the turn of a year and a leap day.
  assert.equal(daysBetween("2027-12-31", "2028-03-01"), 61);
  // Across a daylight saving change in most of the world, which a count
  // in local time would get wrong by an hour and round away.
  assert.equal(daysBetween("2027-03-01", "2027-04-01"), 31);
  assert.equal(daysBetween("2027-10-01", "2027-11-01"), 31);
});

test("today is the UTC date, whatever the time of day", () => {
  // 2026-11-27T00:00:00Z and one second before.
  assert.equal(utcDateFromUnix(1_795_737_600), "2026-11-27");
  assert.equal(utcDateFromUnix(1_795_737_599), "2026-11-26");
  assert.equal(utcDateFromUnix(1_795_823_999), "2026-11-27");
});

test("the summary counts states and totals the value of agreements still in force, per currency", () => {
  const summary = summarizeAgreements(
    [
      // Active, far off.
      {
        contractValueCents: 1_000_000,
        currency: "USD",
        endDate: "2027-11-27",
        renewalNoticeDays: 30,
      },
      // Ends in 10 days: expiring, and within the 30-day figure.
      {
        contractValueCents: 250_050,
        currency: "USD",
        endDate: "2026-12-07",
        renewalNoticeDays: 30,
      },
      // Ends in 20 days with a 10-day notice period: active, but still in
      // the 30-day figure.
      {
        contractValueCents: 500_000,
        currency: "EUR",
        endDate: "2026-12-17",
        renewalNoticeDays: 10,
      },
      // Ends today.
      {
        contractValueCents: null,
        currency: "USD",
        endDate: today,
        renewalNoticeDays: 30,
      },
      // Ended: counted, but its value is not.
      {
        contractValueCents: 9_999_900,
        currency: "USD",
        endDate: "2026-11-26",
        renewalNoticeDays: 30,
      },
      // No end date: its value counts.
      {
        contractValueCents: 100,
        currency: "GBP",
        endDate: null,
        renewalNoticeDays: 30,
      },
    ],
    today,
  );

  assert.equal(summary.total, 6);
  assert.equal(summary.active, 2);
  assert.equal(summary.expiringWithin30Days, 3);
  assert.equal(summary.expired, 1);
  assert.equal(summary.noEndDate, 1);
  assert.deepEqual(
    summary.valueByCurrency.map(({ currency, totalCents }) => [
      currency,
      totalCents,
    ]),
    [
      ["EUR", 500_000],
      ["GBP", 100],
      ["USD", 1_250_050],
    ],
  );
  assert.deepEqual(
    summary.valueByCurrency.map((value) => value.label),
    ["€5,000.00", "£1.00", "$12,500.50"],
  );
});

test("an empty summary has no values", () => {
  const summary = summarizeAgreements([], today);

  assert.equal(summary.total, 0);
  assert.deepEqual(summary.valueByCurrency, []);
});

test("contract values are shown in each currency's own way", () => {
  assert.equal(formatContractValue(1_250_050, "USD"), "$12,500.50");
  assert.equal(formatContractValue(1_250_000, "JPY"), "¥12,500");
  assert.equal(formatContractValue(0, "CAD"), "CA$0.00");
});

test("typed amounts become hundredths", () => {
  assert.equal(parseContractAmount(""), null);
  assert.equal(parseContractAmount("  "), null);
  assert.equal(parseContractAmount("12500"), 1_250_000);
  assert.equal(parseContractAmount("12,500.5"), 1_250_050);
  assert.equal(parseContractAmount("12 500.05"), 1_250_005);
  assert.equal(parseContractAmount("0.10"), 10);
  assert.equal(parseContractAmount("-5"), undefined);
  assert.equal(parseContractAmount("12.345"), undefined);
  assert.equal(parseContractAmount("1e5"), undefined);
  assert.equal(parseContractAmount("$100"), undefined);
  assert.equal(parseContractAmount("100000000001"), undefined);
  assert.equal(formatContractAmountInput(1_250_050), "12500.50");
  assert.equal(formatContractAmountInput(1_250_000), "12500");
  assert.equal(formatContractAmountInput(5), "0.05");
  assert.equal(formatContractAmountInput(null), "");
});

test("only real calendar dates are dates", () => {
  assert.equal(isIsoDate("2028-02-29"), true);
  assert.equal(isIsoDate("2027-02-29"), false);
  assert.equal(isIsoDate("2027-13-01"), false);
  assert.equal(isIsoDate("2027-1-01"), false);
  assert.equal(isIsoDate("2027-01-01T00:00:00Z"), false);
  assert.equal(isIsoDate("1899-12-31"), false);
});

test("the update schema cleans up what it is given", () => {
  const parsed = agreementUpdateSchema.parse({
    counterparty: "  Acme Ltd  ",
    currency: " eur ",
    effectiveDate: "",
    notes: "   ",
    tags: [" NDA ", "nda", "Supplier   terms", "Supplier terms"],
  });

  assert.deepEqual(parsed, {
    counterparty: "Acme Ltd",
    currency: "EUR",
    effectiveDate: null,
    notes: null,
    tags: ["NDA", "Supplier terms"],
  });
});

test("the update schema turns away what does not hold together", () => {
  const rejects = (input: unknown, message: RegExp) => {
    const parsed = agreementUpdateSchema.safeParse(input);

    assert.equal(parsed.success, false, JSON.stringify(input));
    assert.match(parsed.error?.issues[0]?.message ?? "", message);
  };

  rejects({ contractValueCents: -1 }, /negative/);
  rejects({ contractValueCents: 1.5 }, /whole/);
  rejects({ contractValueCents: 10_000_000_000_001 }, /too large/);
  rejects({ currency: "US" }, /three-letter/);
  rejects({ currency: "US1" }, /three-letter/);
  rejects({ endDate: "2027-02-30" }, /YYYY-MM-DD/);
  rejects({ endDate: "next year" }, /YYYY-MM-DD/);
  rejects({ renewalNoticeDays: 366 }, /365/);
  rejects({ renewalNoticeDays: -1 }, /negative/);
  rejects({ tags: ["x".repeat(41)] }, /40 characters/);
  rejects(
    { tags: Array.from({ length: 21 }, (_, i) => `t${String(i)}`) },
    /20/,
  );
  rejects({ notes: "x".repeat(4001) }, /4000/);
  rejects({ counterparty: "x".repeat(201) }, /200/);
  rejects({ envelopeId: "someone-else" }, /Unrecognized/);
  // Twenty distinct tags, given twice over, are fine.
  assert.equal(
    agreementUpdateSchema.safeParse({
      tags: Array.from({ length: 40 }, (_, i) => `T${String(i % 20)}`),
    }).success,
    true,
  );
});

test("fields left out of a change keep their value; null clears one", () => {
  const current = mergeAgreementDetails(null, {
    contractValueCents: 100,
    counterparty: "Acme",
    endDate: "2027-01-01",
    tags: ["NDA"],
  });

  assert.equal(current.currency, "USD");
  assert.equal(current.renewalNoticeDays, 30);

  const next = mergeAgreementDetails(
    current,
    agreementUpdateSchema.parse({ counterparty: null, renewalNoticeDays: 7 }),
  );

  assert.deepEqual(next, {
    ...current,
    counterparty: null,
    renewalNoticeDays: 7,
  });
});

test("list filters from an address ignore what they cannot read", () => {
  assert.deepEqual(
    parseAgreementListFilters(
      new URLSearchParams(
        "q=%20acme%20&state=soon&tag=NDA&view=everyone&cursor=-4&limit=1000&within=900",
      ),
    ),
    {
      cursor: undefined,
      envelopeId: undefined,
      limit: 100,
      search: "acme",
      state: undefined,
      tag: "NDA",
      view: undefined,
      withinDays: undefined,
    },
  );
  assert.deepEqual(
    parseAgreementListFilters({
      cursor: "50",
      envelope: "env-1",
      state: ["expiring", "expired"],
      within: "30",
    }),
    {
      cursor: 50,
      envelopeId: "env-1",
      limit: 50,
      search: undefined,
      state: "expiring",
      tag: undefined,
      view: undefined,
      withinDays: 30,
    },
  );
});

test("the CSV export cannot carry a spreadsheet formula", () => {
  const csv = buildAgreementsCsv([
    agreement({
      contractValueCents: 1_250_050,
      counterparty: '=HYPERLINK("https://example.test","click")',
      effectiveDate: "2026-01-01",
      endDate: "2027-01-01",
      notes: "@SUM(A1:A9)\nsecond line",
      stateLabel: "Active",
      tags: ["+tag", "-tag"],
      title: "\tTabbed title",
    }),
    agreement({
      envelopeId: "env-2",
      notes: "\rcarriage return",
      title: "-1+1",
    }),
  ]);
  const lines = csv.split("\r\n");

  assert.equal(
    lines[0],
    "Agreement,Envelope ID,Counterparty,Contract value,Currency,Effective date,End date,Renewal notice (days),Auto-renews,State,Tags,Notes,Completed",
  );
  assert.ok(lines[1]?.startsWith("'\tTabbed title,env-1,"));
  assert.ok(
    lines[1]?.includes(
      `"'=HYPERLINK(""https://example.test"",""click"")",12500.50,USD,2026-01-01,2027-01-01,30,No,Active,'+tag; -tag,"'@SUM(A1:A9)`,
    ),
    lines[1],
  );
  assert.ok(csv.includes("'-1+1,env-2,"), csv);
  assert.ok(csv.includes(`"'\rcarriage return"`), csv);
  // A value-less agreement leaves the value and currency empty.
  assert.ok(csv.includes(",,,,,30,No,No end date,,"), csv);
  assert.ok(csv.endsWith("\r\n"));
});

test("the CSV export names the sender when the rows have one", () => {
  const csv = buildAgreementsCsv([
    agreement({ ownerLabel: "Sam Sender (sam@example.test)" }),
  ]);

  assert.match(csv, /^Agreement,Envelope ID,Sender,Counterparty,/);
  assert.match(csv, /,env-1,Sam Sender \(sam@example\.test\),/);
});

test("a renewal reminder says when the agreement ends and links to it", () => {
  const reminder = buildRenewalReminder(
    {
      autoRenews: false,
      counterparty: "Acme Ltd",
      endDate: "2026-12-27",
      envelopeId: "env 1",
      ownerEmail: "sam@example.test",
      ownerName: "Sam Sender",
      renewalNoticeDays: 30,
      title: "Supply agreement",
    },
    today,
    "https://sign.example.test",
  );

  assert.equal(reminder.to, "sam@example.test");
  assert.equal(reminder.template, "renewal_reminder");
  assert.equal(reminder.subject, '"Supply agreement" ends on Dec 27, 2026');
  assert.match(
    reminder.textBody,
    /"Supply agreement" with Acme Ltd ends on December 27, 2026, in 30 days\./,
  );
  assert.match(reminder.textBody, /set for 30 days before the end date/);
  assert.match(
    reminder.textBody,
    /https:\/\/sign\.example\.test\/agreements\?envelope=env%201/,
  );

  const renewing = buildRenewalReminder(
    {
      autoRenews: true,
      counterparty: null,
      endDate: today,
      envelopeId: "env-2",
      ownerEmail: "sam@example.test",
      ownerName: null,
      renewalNoticeDays: 1,
      title: "Hosting",
    },
    today,
    undefined,
  );

  assert.equal(renewing.subject, '"Hosting" renews today');
  assert.match(renewing.textBody, /^Hello sam@example\.test,/);
  assert.match(renewing.textBody, /renews automatically today\./);
  assert.match(renewing.textBody, /set for 1 day before/);
  assert.doesNotMatch(renewing.textBody, /https?:/);
});
