import { PDFDocument, rgb, type PDFPage } from "pdf-lib";

import { embedTextFaces, type TextFace } from "../services/pdf-fonts.ts";
import {
  calculatePricing,
  fillVariables,
  formatMoney,
  formatQuantity,
  pageSizes,
  parseInlineMarks,
  type BuilderBlock,
  type BuilderContent,
  type TextSegment,
} from "./model.ts";

// Lays a Document Builder document out as a PDF, and works out where its
// signature and form fields sit, so the envelope made from it has every
// field in place before the sender opens it.
//
// The layout is deterministic: the same document always gives the same
// bytes. It draws with the same Noto fonts the signed PDF and certificate
// use, so text in any script the rest of PACTORA supports comes out right.

export type BuilderFieldType =
  "checkbox" | "date" | "initials" | "name" | "number" | "signature" | "text";

/** A field on the rendered PDF, in the editor's normalized coordinates. */
export type BuilderFieldPlacement = {
  height: number;
  label?: string;
  page: number;
  required: boolean;
  roleId: string;
  type: BuilderFieldType;
  width: number;
  x: number;
  y: number;
};

export type RenderedBuilderDocument = {
  fields: BuilderFieldPlacement[];
  pageCount: number;
  pdf: Uint8Array;
};

const MARGIN_X = 64;
const MARGIN_TOP = 72;
const MARGIN_BOTTOM = 72;
const FOOTER_BASELINE = 36;
const BODY_SIZE = 10.5;
const LINE_HEIGHT = 1.45;

const INK = rgb(0.11, 0.12, 0.14);
const MUTED = rgb(0.42, 0.44, 0.48);
const RULE = rgb(0.82, 0.83, 0.86);
const TABLE_FILL = rgb(0.955, 0.96, 0.968);

const HEADING_SIZES = { 1: 20, 2: 15, 3: 12 } as const;

const LABELS = {
  amount: "Amount",
  date: "Date",
  dateSigned: "Date signed",
  description: "Description",
  discount: "Discount",
  fullName: "Full name",
  initials: "Initials",
  quantity: "Qty",
  signature: "Signature",
  subtotal: "Subtotal",
  total: "Total",
  unitPrice: "Unit price",
} as const;

type Faces = { bold: TextFace; regular: TextFace };

type Run = { bold: boolean; text: string; width: number };
type Line = { runs: Run[]; width: number };

// Characters that may break a line on either side even without a space:
// CJK ideographs, kana, hangul and full-width forms.
const BREAK_ANYWHERE = /[⺀-⿿　-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/u;

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let word = "";

  for (const character of text) {
    if (character === "\n" || /\s/u.test(character)) {
      if (word) {
        tokens.push(word);
        word = "";
      }
      tokens.push(character === "\n" ? "\n" : " ");
    } else if (BREAK_ANYWHERE.test(character)) {
      if (word) {
        tokens.push(word);
        word = "";
      }
      tokens.push(character);
    } else {
      word += character;
    }
  }

  if (word) {
    tokens.push(word);
  }

  return tokens;
}

class PdfLayout {
  readonly fields: BuilderFieldPlacement[] = [];
  readonly pages: PDFPage[] = [];
  page!: PDFPage;
  /** Distance from the top of the page to the next free line. */
  y = MARGIN_TOP;

  readonly pdf: PDFDocument;
  readonly faces: Faces;
  readonly widthPt: number;
  readonly heightPt: number;

  constructor(
    pdf: PDFDocument,
    faces: Faces,
    widthPt: number,
    heightPt: number,
  ) {
    this.pdf = pdf;
    this.faces = faces;
    this.widthPt = widthPt;
    this.heightPt = heightPt;
    this.addPage();
  }

  get contentWidth(): number {
    return this.widthPt - MARGIN_X * 2;
  }

  get bottom(): number {
    return this.heightPt - MARGIN_BOTTOM;
  }

  get atTopOfPage(): boolean {
    return this.y <= MARGIN_TOP + 0.01;
  }

  addPage(): void {
    this.page = this.pdf.addPage([this.widthPt, this.heightPt]);
    this.pages.push(this.page);
    this.y = MARGIN_TOP;
  }

  /** Starts a new page unless `height` more points fit on this one. */
  ensure(height: number): void {
    if (this.y + height > this.bottom && !this.atTopOfPage) {
      this.addPage();
    }
  }

  face(bold: boolean): TextFace {
    return bold ? this.faces.bold : this.faces.regular;
  }

  measure(text: string, size: number, bold = false): number {
    return this.face(bold).widthOfTextAtSize(text, size);
  }

  /** Draws text whose top edge is `top` points from the top of the page. */
  text(
    value: string,
    x: number,
    top: number,
    size: number,
    { bold = false, color = INK }: { bold?: boolean; color?: typeof INK } = {},
  ): void {
    if (!value) {
      return;
    }

    this.face(bold).drawText(this.page, value, {
      color,
      size,
      x,
      y: this.heightPt - top - size,
    });
  }

  rule(x: number, top: number, width: number, thickness = 0.6): void {
    this.page.drawLine({
      color: RULE,
      end: { x: x + width, y: this.heightPt - top },
      start: { x, y: this.heightPt - top },
      thickness,
    });
  }

  fill(x: number, top: number, width: number, height: number): void {
    this.page.drawRectangle({
      color: TABLE_FILL,
      height,
      width,
      x,
      y: this.heightPt - top - height,
    });
  }

  field(
    placement: Omit<
      BuilderFieldPlacement,
      "height" | "page" | "width" | "x" | "y"
    > & { height: number; top: number; width: number; x: number },
  ): void {
    const { height, top, width, x, ...rest } = placement;

    this.fields.push({
      ...rest,
      height: height / this.heightPt,
      page: this.pages.length,
      width: width / this.widthPt,
      x: x / this.widthPt,
      y: top / this.heightPt,
    });
  }

  /** Breaks styled text into lines no wider than `maxWidth`. */
  wrap(segments: TextSegment[], size: number, maxWidth: number): Line[] {
    const lines: Line[] = [];
    let current: Line = { runs: [], width: 0 };
    let pendingSpace: { bold: boolean } | null = null;

    const pushLine = () => {
      lines.push(current);
      current = { runs: [], width: 0 };
      pendingSpace = null;
    };

    const append = (text: string, bold: boolean, width: number) => {
      const last = current.runs.at(-1);

      if (last && last.bold === bold) {
        last.text += text;
        last.width += width;
      } else {
        current.runs.push({ bold, text, width });
      }
      current.width += width;
    };

    for (const segment of segments) {
      for (const token of tokenize(segment.text)) {
        if (token === "\n") {
          pushLine();
          continue;
        }

        if (token === " ") {
          if (current.runs.length > 0) {
            pendingSpace = { bold: segment.bold };
          }
          continue;
        }

        const width = this.measure(token, size, segment.bold);
        const spaceWidth = pendingSpace
          ? this.measure(" ", size, pendingSpace.bold)
          : 0;

        if (
          current.runs.length > 0 &&
          current.width + spaceWidth + width > maxWidth
        ) {
          pushLine();
        } else if (pendingSpace) {
          append(" ", pendingSpace.bold, spaceWidth);
        }
        pendingSpace = null;

        if (width <= maxWidth) {
          append(token, segment.bold, width);
          continue;
        }

        // A single word wider than the line: break it between characters.
        for (const character of token) {
          const characterWidth = this.measure(character, size, segment.bold);

          if (
            current.runs.length > 0 &&
            current.width + characterWidth > maxWidth
          ) {
            pushLine();
          }
          append(character, segment.bold, characterWidth);
        }
      }
    }

    if (current.runs.length > 0 || lines.length === 0) {
      lines.push(current);
    }

    return lines;
  }

  drawLine(
    line: Line,
    x: number,
    top: number,
    size: number,
    color = INK,
  ): void {
    let cursor = x;

    for (const run of line.runs) {
      this.text(run.text, cursor, top, size, { bold: run.bold, color });
      cursor += run.width;
    }
  }

  /** Flows wrapped text from the cursor, starting new pages as needed. */
  flow(
    segments: TextSegment[],
    {
      bold = false,
      color = INK,
      indent = 0,
      size = BODY_SIZE,
    }: {
      bold?: boolean;
      color?: typeof INK;
      indent?: number;
      size?: number;
    } = {},
  ): void {
    const styled = bold
      ? segments.map((segment) => ({ ...segment, bold: true }))
      : segments;
    const lineHeight = size * LINE_HEIGHT;

    for (const line of this.wrap(styled, size, this.contentWidth - indent)) {
      this.ensure(lineHeight);
      this.drawLine(line, MARGIN_X + indent, this.y, size, color);
      this.y += lineHeight;
    }
  }
}

function fill(text: string, content: BuilderContent): TextSegment[] {
  return parseInlineMarks(fillVariables(text, content.variables));
}

function roleName(content: BuilderContent, roleId: string): string {
  return content.roles.find((role) => role.id === roleId)?.name ?? "Signer";
}

function layoutPricing(
  layout: PdfLayout,
  block: Extract<BuilderBlock, { type: "pricing" }>,
  content: BuilderContent,
): void {
  const totals = calculatePricing(block);
  const showDiscount = totals.discountCents > 0;
  const size = 9.5;
  const lineHeight = size * LINE_HEIGHT;
  const padding = 6;
  const width = layout.contentWidth;
  const amountWidth = 92;
  const unitWidth = 84;
  const quantityWidth = 44;
  const discountWidth = showDiscount ? 58 : 0;
  const descriptionWidth =
    width - amountWidth - unitWidth - quantityWidth - discountWidth;
  const columns = {
    amount: MARGIN_X + width - padding,
    description: MARGIN_X + padding,
    discount:
      MARGIN_X +
      descriptionWidth +
      quantityWidth +
      unitWidth +
      discountWidth -
      padding,
    quantity: MARGIN_X + descriptionWidth + quantityWidth - padding,
    unit: MARGIN_X + descriptionWidth + quantityWidth + unitWidth - padding,
  };
  const rightText = (
    value: string,
    right: number,
    top: number,
    bold = false,
    color = INK,
  ) => {
    layout.text(value, right - layout.measure(value, size, bold), top, size, {
      bold,
      color,
    });
  };
  const header = () => {
    const height = lineHeight + padding * 2;

    layout.fill(MARGIN_X, layout.y, width, height);
    const top = layout.y + padding;

    layout.text(LABELS.description, columns.description, top, size, {
      bold: true,
    });
    rightText(LABELS.quantity, columns.quantity, top, true);
    rightText(LABELS.unitPrice, columns.unit, top, true);
    if (showDiscount) {
      rightText(LABELS.discount, columns.discount, top, true);
    }
    rightText(LABELS.amount, columns.amount, top, true);
    layout.y += height;
  };

  layout.ensure(lineHeight * 3 + padding * 6);
  header();

  for (const line of totals.lines) {
    const descriptionLines = layout.wrap(
      fill(line.row.description, content),
      size,
      descriptionWidth - padding * 2,
    );
    const height = descriptionLines.length * lineHeight + padding * 2;

    if (layout.y + height > layout.bottom) {
      layout.addPage();
      header();
    }

    const top = layout.y + padding;

    descriptionLines.forEach((descriptionLine, index) => {
      layout.drawLine(
        descriptionLine,
        columns.description,
        top + index * lineHeight,
        size,
      );
    });
    rightText(formatQuantity(line.row.quantity), columns.quantity, top);
    rightText(
      formatMoney(line.row.unitPriceCents, block.currency),
      columns.unit,
      top,
    );
    if (showDiscount) {
      rightText(
        line.row.discountPercent > 0
          ? `${formatQuantity(line.row.discountPercent)}%`
          : "",
        columns.discount,
        top,
        false,
        MUTED,
      );
    }
    rightText(
      formatMoney(line.amountCents, block.currency),
      columns.amount,
      top,
    );
    layout.y += height;
    layout.rule(MARGIN_X, layout.y, width);
  }

  const summary: [string, string, boolean][] = [
    [LABELS.subtotal, formatMoney(totals.subtotalCents, block.currency), false],
  ];

  if (showDiscount) {
    summary.push([
      LABELS.discount,
      `−${formatMoney(totals.discountCents, block.currency)}`,
      false,
    ]);
  }

  if (block.taxPercent > 0) {
    summary.push([
      `${block.taxLabel || "Tax"} (${formatQuantity(block.taxPercent)}%)`,
      formatMoney(totals.taxCents, block.currency),
      false,
    ]);
  }

  summary.push([
    LABELS.total,
    formatMoney(totals.totalCents, block.currency),
    true,
  ]);

  layout.ensure(summary.length * (lineHeight + 2) + padding * 2);
  layout.y += padding;

  for (const [label, value, bold] of summary) {
    rightText(label, columns.unit, layout.y, bold, bold ? INK : MUTED);
    rightText(value, columns.amount, layout.y, bold);
    layout.y += lineHeight + 2;
  }
}

function layoutSignature(
  layout: PdfLayout,
  block: Extract<BuilderBlock, { type: "signature" }>,
  content: BuilderContent,
): void {
  const height = 128;
  const x = MARGIN_X;
  const signatureWidth = 230;
  const dateX = x + signatureWidth + 36;
  const dateWidth = Math.min(150, layout.contentWidth - signatureWidth - 36);

  layout.ensure(height);

  const top = layout.y;

  layout.text(roleName(content, block.roleId), x, top, BODY_SIZE, {
    bold: true,
  });

  const signatureTop = top + 20;
  const signatureHeight = 40;
  const signatureLine = signatureTop + signatureHeight + 2;

  layout.field({
    height: signatureHeight,
    required: true,
    roleId: block.roleId,
    top: signatureTop,
    type: "signature",
    width: signatureWidth,
    x,
  });
  layout.rule(x, signatureLine, signatureWidth, 0.8);
  layout.text(LABELS.signature, x, signatureLine + 4, 8.5, { color: MUTED });

  layout.field({
    height: 20,
    required: true,
    roleId: block.roleId,
    top: signatureLine - 22,
    type: "date",
    width: dateWidth,
    x: dateX,
  });
  layout.rule(dateX, signatureLine, dateWidth, 0.8);
  layout.text(LABELS.dateSigned, dateX, signatureLine + 4, 8.5, {
    color: MUTED,
  });

  const nameLine = signatureLine + 44;

  layout.field({
    height: 20,
    required: true,
    roleId: block.roleId,
    top: nameLine - 22,
    type: "name",
    width: signatureWidth,
    x,
  });
  layout.rule(x, nameLine, signatureWidth, 0.8);
  layout.text(LABELS.fullName, x, nameLine + 4, 8.5, { color: MUTED });

  layout.y = top + height;
}

function layoutInlineField(
  layout: PdfLayout,
  block: Extract<BuilderBlock, { type: "field" }>,
  content: BuilderContent,
): void {
  const label = fillVariables(block.label, content.variables);
  const owner = roleName(content, block.roleId);
  const x = MARGIN_X;

  if (block.fieldType === "checkbox") {
    const box = 13;
    const lines = layout.wrap(
      parseInlineMarks(label || owner),
      BODY_SIZE,
      layout.contentWidth - box - 10,
    );
    const height = Math.max(box, lines.length * BODY_SIZE * LINE_HEIGHT) + 8;

    layout.ensure(height);
    layout.page.drawRectangle({
      borderColor: MUTED,
      borderWidth: 0.8,
      height: box,
      width: box,
      x,
      y: layout.heightPt - layout.y - box - 1,
    });
    layout.field({
      height: box,
      label: label || undefined,
      required: block.required,
      roleId: block.roleId,
      top: layout.y + 1,
      type: "checkbox",
      width: box,
      x,
    });
    lines.forEach((line, index) => {
      layout.drawLine(
        line,
        x + box + 10,
        layout.y + index * BODY_SIZE * LINE_HEIGHT,
        BODY_SIZE,
      );
    });
    layout.y += height;

    return;
  }

  const sizes: Record<
    Exclude<typeof block.fieldType, "checkbox">,
    [number, number]
  > = {
    date: [150, 20],
    initials: [72, 30],
    number: [150, 20],
    text: [280, 20],
  };
  const [width, fieldHeight] = sizes[block.fieldType];
  const caption =
    label ||
    (block.fieldType === "date"
      ? LABELS.dateSigned
      : block.fieldType === "initials"
        ? LABELS.initials
        : "");
  const height = fieldHeight + 26;

  layout.ensure(height);

  const lineTop = layout.y + fieldHeight + 2;

  layout.field({
    height: fieldHeight,
    label: label || undefined,
    required: block.required,
    roleId: block.roleId,
    top: layout.y,
    type: block.fieldType,
    width: Math.min(width, layout.contentWidth),
    x,
  });
  layout.rule(x, lineTop, Math.min(width, layout.contentWidth), 0.8);
  layout.text(caption ? `${caption} · ${owner}` : owner, x, lineTop + 4, 8.5, {
    color: MUTED,
  });
  layout.y += height;
}

function layoutBlock(
  layout: PdfLayout,
  block: BuilderBlock,
  content: BuilderContent,
  previous: BuilderBlock | undefined,
): void {
  switch (block.type) {
    case "heading": {
      const size = HEADING_SIZES[block.level];
      const before =
        layout.atTopOfPage || !previous ? 0 : block.level === 1 ? 20 : 14;

      // Keep a heading with at least two lines of what follows it.
      layout.ensure(before + size * LINE_HEIGHT + BODY_SIZE * LINE_HEIGHT * 2);
      layout.y += layout.atTopOfPage ? 0 : before;
      layout.flow(fill(block.text, content), { bold: true, size });
      layout.y += block.level === 1 ? 8 : 4;

      return;
    }
    case "paragraph": {
      if (!block.text.trim()) {
        layout.y += BODY_SIZE * LINE_HEIGHT;

        return;
      }

      layout.flow(fill(block.text, content));
      layout.y += 8;

      return;
    }
    case "list": {
      const indent = 18;
      const lineHeight = BODY_SIZE * LINE_HEIGHT;

      // An empty line in the editor is not an item.
      const items = block.items.filter((item) => item.trim() !== "");

      items.forEach((item, index) => {
        const marker = block.style === "number" ? `${index + 1}.` : "•";
        const lines = layout.wrap(
          fill(item, content),
          BODY_SIZE,
          layout.contentWidth - indent,
        );

        lines.forEach((line, lineIndex) => {
          layout.ensure(lineHeight);
          if (lineIndex === 0) {
            layout.text(marker, MARGIN_X, layout.y, BODY_SIZE, {
              color: block.style === "number" ? INK : MUTED,
            });
          }
          layout.drawLine(line, MARGIN_X + indent, layout.y, BODY_SIZE);
          layout.y += lineHeight;
        });
        layout.y += 3;
      });
      layout.y += 5;

      return;
    }
    case "pricing":
      layout.y += layout.atTopOfPage ? 0 : 4;
      layoutPricing(layout, block, content);
      layout.y += 12;

      return;
    case "signature":
      layout.y += layout.atTopOfPage ? 0 : 8;
      layoutSignature(layout, block, content);

      return;
    case "field":
      layoutInlineField(layout, block, content);

      return;
    case "divider":
      layout.ensure(24);
      layout.y += 10;
      layout.rule(MARGIN_X, layout.y, layout.contentWidth);
      layout.y += 14;

      return;
    case "pageBreak":
      if (!layout.atTopOfPage) {
        layout.addPage();
      }

      return;
  }
}

function truncateToWidth(
  layout: PdfLayout,
  value: string,
  size: number,
  maxWidth: number,
): string {
  if (layout.measure(value, size) <= maxWidth) {
    return value;
  }

  let result = "";

  for (const character of value) {
    if (layout.measure(`${result}${character}…`, size) > maxWidth) {
      break;
    }
    result += character;
  }

  return `${result}…`;
}

/** Every string the PDF will draw, so the fonts embedded cover all of it. */
function drawnText(title: string, content: BuilderContent): unknown {
  const strings: string[] = [
    title,
    ...Object.values(LABELS),
    "0123456789.,%−-–()$€£¥•… Page of",
  ];

  for (const role of content.roles) {
    strings.push(role.name);
  }

  for (const block of content.blocks) {
    switch (block.type) {
      case "heading":
      case "paragraph":
        strings.push(fillVariables(block.text, content.variables));
        break;
      case "list":
        strings.push(
          ...block.items.map((item) => fillVariables(item, content.variables)),
        );
        break;
      case "pricing": {
        const totals = calculatePricing(block);

        strings.push(block.taxLabel);
        for (const line of totals.lines) {
          strings.push(
            fillVariables(line.row.description, content.variables),
            formatMoney(line.amountCents, block.currency),
            formatMoney(line.row.unitPriceCents, block.currency),
          );
        }
        strings.push(
          formatMoney(totals.totalCents, block.currency),
          formatMoney(totals.taxCents, block.currency),
        );
        break;
      }
      case "field":
        strings.push(fillVariables(block.label, content.variables));
        break;
      default:
        break;
    }
  }

  return strings;
}

export async function renderBuilderDocument(
  title: string,
  content: BuilderContent,
): Promise<RenderedBuilderDocument> {
  // No creation or modification date: the same document gives the same
  // bytes, so a re-render can be checked against an earlier one.
  const pdf = await PDFDocument.create({ updateMetadata: false });

  pdf.setTitle(title);
  pdf.setCreator("PACTORA");
  pdf.setProducer("PACTORA Document Builder");

  const faces = await embedTextFaces(pdf, drawnText(title, content), {
    bold: true,
  });
  const size = pageSizes[content.pageSize];
  const layout = new PdfLayout(pdf, faces, size.widthPt, size.heightPt);

  content.blocks.forEach((block, index) => {
    layoutBlock(layout, block, content, content.blocks[index - 1]);
  });

  const pageCount = layout.pages.length;

  layout.pages.forEach((page, index) => {
    layout.page = page;

    const pageLabel = `Page ${index + 1} of ${pageCount}`;
    const labelWidth = layout.measure(pageLabel, 8);
    const top = size.heightPt - FOOTER_BASELINE - 8;

    layout.text(
      truncateToWidth(layout, title, 8, layout.contentWidth - labelWidth - 24),
      MARGIN_X,
      top,
      8,
      { color: MUTED },
    );
    layout.text(pageLabel, size.widthPt - MARGIN_X - labelWidth, top, 8, {
      color: MUTED,
    });
  });

  return {
    fields: layout.fields,
    pageCount,
    pdf: await pdf.save({ useObjectStreams: true }),
  };
}
