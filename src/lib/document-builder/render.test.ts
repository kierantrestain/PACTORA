import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { PDFDocument } from "pdf-lib";

import { findStarterDocument } from "./library.ts";
import {
  builderContentSchema,
  emptyBuilderContent,
  type BuilderContent,
} from "./model.ts";
import { renderBuilderDocument } from "./render.ts";

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

test("the same document renders to the same bytes", async () => {
  const starter = findStarterDocument("services-agreement")!;
  const content = builderContentSchema.parse(starter.content);
  const first = await renderBuilderDocument(starter.title, content);
  const second = await renderBuilderDocument(starter.title, content);

  assert.equal(sha256(first.pdf), sha256(second.pdf));
  assert.equal(first.pageCount, 2);
});

test("each signature block places a signature, a date and a name field for its role", async () => {
  const starter = findStarterDocument("mutual-nda")!;
  const rendered = await renderBuilderDocument(
    starter.title,
    builderContentSchema.parse(starter.content),
  );
  const byRole = Map.groupBy(rendered.fields, (field) => field.roleId);

  for (const role of starter.content.roles) {
    const types = (byRole.get(role.id) ?? []).map((field) => field.type).sort();

    assert.deepEqual(types, ["date", "name", "signature"]);
  }

  for (const field of rendered.fields) {
    assert.ok(field.page >= 1 && field.page <= rendered.pageCount);
    assert.ok(field.x >= 0 && field.x + field.width <= 1);
    assert.ok(field.y >= 0 && field.y + field.height <= 1);
  }

  const pdf = await PDFDocument.load(rendered.pdf);

  assert.equal(pdf.getPageCount(), rendered.pageCount);
  assert.equal(pdf.getTitle(), starter.title);
});

test("long text flows onto new pages and a signature block is never split", async () => {
  const paragraph =
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(40);
  const content: BuilderContent = {
    ...emptyBuilderContent(),
    blocks: [
      ...Array.from({ length: 6 }, (_, index) => ({
        id: `p${index}`,
        text: paragraph,
        type: "paragraph" as const,
      })),
      { id: "s", roleId: "role-1", type: "signature" as const },
    ],
  };
  const rendered = await renderBuilderDocument("Long", content);
  const signature = rendered.fields.filter(
    (field) => field.type !== "checkbox",
  );

  assert.ok(rendered.pageCount >= 3);
  assert.equal(new Set(signature.map((field) => field.page)).size, 1);
});

test("A4 pages, page breaks, CJK text and a word longer than the line all render", async () => {
  const content: BuilderContent = {
    ...emptyBuilderContent(),
    blocks: [
      { id: "h", level: 1, text: "契約書 — Vertrag", type: "heading" },
      { id: "w", text: "x".repeat(400), type: "paragraph" },
      { id: "b", type: "pageBreak" },
      {
        fieldType: "checkbox",
        id: "c",
        label: "I agree",
        required: true,
        roleId: "role-1",
        type: "field",
      },
    ],
    pageSize: "a4",
  };
  const rendered = await renderBuilderDocument("A4", content);
  const pdf = await PDFDocument.load(rendered.pdf);
  const { height, width } = pdf.getPage(0).getSize();

  assert.equal(rendered.pageCount, 2);
  assert.equal(Math.round(width), 595);
  assert.equal(Math.round(height), 842);
  assert.equal(rendered.fields[0]!.page, 2);
  assert.equal(rendered.fields[0]!.type, "checkbox");
});
