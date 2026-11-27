import assert from "node:assert/strict";
import { test } from "node:test";

import { starterDocuments } from "./library.ts";
import {
  builderContentSchema,
  calculatePricing,
  collectVariableUsage,
  emptyBuilderContent,
  fillVariables,
  findSendProblems,
  formatMoney,
  parseInlineMarks,
  parseMoneyInput,
  type BuilderContent,
  type PricingBlock,
} from "./model.ts";

function pricing(
  rows: Partial<PricingBlock["rows"][number]>[],
  taxPercent = 0,
): PricingBlock {
  return {
    currency: "USD",
    id: "p",
    rows: rows.map((row, index) => ({
      description: "",
      discountPercent: 0,
      id: `r${index}`,
      quantity: 1,
      unitPriceCents: 0,
      ...row,
    })),
    taxLabel: "Tax",
    taxPercent,
    type: "pricing",
  };
}

test("every starter document is valid content and ready apart from its variables", () => {
  for (const starter of starterDocuments) {
    const content = builderContentSchema.parse(starter.content);
    const problems = findSendProblems(content);

    assert.ok(
      problems.every((problem) => problem.startsWith("Fill in")),
      `${starter.id}: ${problems.join(" ")}`,
    );
    assert.deepEqual(collectVariableUsage(content).undefinedKeys, []);
  }
});

test("pricing works in minor units with line discounts and tax on the discounted total", () => {
  const totals = calculatePricing(
    pricing(
      [
        { quantity: 1, unitPriceCents: 1_200_000, discountPercent: 15 },
        { quantity: 1, unitPriceCents: 250_000 },
      ],
      8,
    ),
  );

  assert.equal(totals.subtotalCents, 1_450_000);
  assert.equal(totals.discountCents, 180_000);
  assert.equal(totals.taxCents, 101_600);
  assert.equal(totals.totalCents, 1_371_600);
});

test("fractional quantities and half cents round once per line, half away from zero", () => {
  const totals = calculatePricing(
    pricing([{ quantity: 1.5, unitPriceCents: 333 }], 10),
  );

  // 1.5 × 3.33 = 4.995 → 5.00; tax 0.50.
  assert.equal(totals.lines[0]!.amountCents, 500);
  assert.equal(totals.taxCents, 50);
  assert.equal(totals.totalCents, 550);

  // 0.1 + 0.2 style float error never reaches the total.
  const many = calculatePricing(
    pricing(
      Array.from({ length: 10 }, () => ({
        quantity: 0.1,
        unitPriceCents: 100,
      })),
    ),
  );

  assert.equal(many.totalCents, 100);
});

test("money formats for known and unknown currencies", () => {
  assert.equal(formatMoney(1_234_500, "USD"), "$12,345.00");
  assert.equal(formatMoney(99, "EUR"), "€0.99");
  assert.match(formatMoney(100, "ZZZ"), /ZZZ\s?1\.00/);
});

test("money input accepts what people type and refuses the rest", () => {
  assert.equal(parseMoneyInput("1,250.5"), 125_050);
  assert.equal(parseMoneyInput("$99"), 9_900);
  assert.equal(parseMoneyInput("0.07"), 7);
  assert.equal(parseMoneyInput("12.345"), null);
  assert.equal(parseMoneyInput("abc"), null);
  assert.equal(parseMoneyInput("-5"), null);
});

test("variables fill case-insensitively and an empty one shows its name", () => {
  const variables = [
    { key: "client.name", label: "", value: "Acme Ltd" },
    { key: "start", label: "", value: "  " },
  ];

  assert.equal(
    fillVariables(
      "Between {{Client.Name}} and us, from {{ start }}.",
      variables,
    ),
    "Between Acme Ltd and us, from [start].",
  );
  assert.equal(fillVariables("{{unknown}}", variables), "[unknown]");
  assert.equal(fillVariables("{{1bad}} stays", variables), "{{1bad}} stays");
});

test("bold marks split into segments and an unmatched marker is kept", () => {
  assert.deepEqual(parseInlineMarks("a **b** c"), [
    { bold: false, text: "a " },
    { bold: true, text: "b" },
    { bold: false, text: " c" },
  ]);
  assert.deepEqual(parseInlineMarks("2 ** 3"), [
    { bold: false, text: "2 ** 3" },
  ]);
  assert.deepEqual(parseInlineMarks("**line\nbreak**"), [
    { bold: true, text: "line\nbreak" },
  ]);
});

test("send problems name each gap in words the sender can act on", () => {
  const content: BuilderContent = {
    ...emptyBuilderContent(),
    blocks: [{ id: "a", text: "Hi {{who}} and {{what}}", type: "paragraph" }],
    roles: [
      { id: "r1", name: "Client" },
      { id: "r2", name: "Witness" },
    ],
    variables: [{ key: "who", label: "", value: "" }],
  };
  const problems = findSendProblems(content);

  assert.equal(problems.length, 4);
  assert.match(problems[0]!, /Define \{\{what\}\}/);
  assert.match(problems[1]!, /Fill in \{\{who\}\}/);
  assert.match(problems[2]!, /Client has nothing to sign/);
  assert.match(problems[3]!, /Witness has nothing to sign/);
});

test("content refuses blocks for missing roles, duplicate ids and duplicate variables", () => {
  const base = emptyBuilderContent();
  const result = builderContentSchema.safeParse({
    ...base,
    blocks: [
      { id: "x", roleId: "nobody", type: "signature" },
      { id: "x", type: "divider" },
    ],
    variables: [
      { key: "a", label: "", value: "" },
      { key: "A", label: "", value: "" },
    ],
  });

  assert.equal(result.success, false);
  const messages = result.error!.issues.map((issue) => issue.message);

  assert.ok(messages.some((message) => message.includes("no longer exists")));
  assert.ok(messages.some((message) => message.includes("own id")));
  assert.ok(messages.some((message) => message.includes("defined twice")));
});
