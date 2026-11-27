import { randomUUID } from "node:crypto";

import { PDFDocument, type PDFImage, type PDFPage, rgb } from "pdf-lib";

import {
  auditEventRecordSchema,
  type AuditEventRecord,
  type EnvelopeRecord,
} from "../schemas/envelope.ts";
import type { FieldRecord } from "../schemas/field.ts";
import type { SignerRecord } from "../schemas/signer.ts";
import { buildSignatureManifestation } from "../signature-meanings.ts";
import { hasSharedSigningStep, signingStepOf } from "../signing-steps.ts";
import { describeSignerCorrectedEvent } from "./audit.ts";
import { isCapturedMessageId } from "./captured-email.ts";
import { canonicalJson } from "../utils/canonical-json.ts";
import { normalizedRectToPdfRect } from "../utils/pdf-coords.ts";
import { embedTextFaces, type TextFace } from "./pdf-fonts.ts";
import {
  drawOnDisplayedPage,
  fieldOnDisplayedPage,
  getDisplayedPageGeometry,
  type DisplayedPageGeometry,
  type StoredPageSize,
} from "./pdf-page-geometry.ts";
import { sha256Hex } from "./pdf-seal.ts";
import { getBranding } from "../settings.ts";
import {
  finishSignerSignedPdf,
  getSealIdentity,
  saveInstallSealedPdf,
  type SealPurpose,
} from "./seal-identity.ts";
import {
  buildEnvelopeCertificateKey,
  buildEnvelopeSignedPdfKey,
} from "./storage-keys.ts";
import {
  createStorageService,
  type StorageObjectRef,
  type StorageService,
} from "./storage.ts";

const DEFAULT_AUDIT_PAGE_SIZE = {
  height: 792,
  width: 612,
} as const;

export type StoredSealedPdf = StorageObjectRef & {
  body: Uint8Array;
  sha256: string;
};

export type FinalizedEnvelopeArtifacts = {
  certificate: StoredSealedPdf;
  generatedAt: number;
  recipientCertificate: StoredSealedPdf;
  signedPdf: StoredSealedPdf;
};

/** Saves a finished PDF. The default seals it with the install's key. */
export type PdfSealer = (
  pdfDocument: PDFDocument,
  purpose: SealPurpose,
) => Promise<Uint8Array>;

const defaultSealer: PdfSealer = (pdfDocument, purpose) =>
  saveInstallSealedPdf(pdfDocument, purpose);

/**
 * The install's sealer, with what it reads from the database (the seal key
 * and the install's name) read now. Sealing with it then needs no database
 * connection, so a caller can seal while it holds one in a transaction
 * without waiting on a pool that its own concurrent requests have filled.
 */
export async function loadInstallSealer(): Promise<PdfSealer> {
  const identity = await getSealIdentity();
  const branding = await getBranding();

  return (pdfDocument, purpose) =>
    saveInstallSealedPdf(pdfDocument, purpose, { branding, identity });
}

const CERTIFICATE_FINGERPRINT_VERSION = 1;

/**
 * A SHA-256 over every audit event the certificate is built from, in order,
 * unredacted. Printed on both certificates, so the record held by the sender
 * can later be shown to be the one the certificate was made from.
 */
export function computeAuditFingerprint(
  auditEvents: readonly AuditEventRecord[],
): string {
  return sha256Hex(
    new TextEncoder().encode(
      canonicalJson({
        // One fixed order (time, then id by code unit), whatever order the
        // list was built or read back in.
        events: [...auditEvents]
          .sort(
            (left, right) =>
              (left.createdAt ?? 0) - (right.createdAt ?? 0) ||
              (String(left.id) < String(right.id)
                ? -1
                : String(left.id) > String(right.id)
                  ? 1
                  : 0),
          )
          .map((event) => [
            event.id,
            event.createdAt,
            event.event,
            event.actorType,
            event.actorEmail ?? null,
            event.ipAddress ?? null,
            event.userAgent ?? null,
            event.metadata ?? null,
          ]),
        version: CERTIFICATE_FINGERPRINT_VERSION,
      }),
    ),
  );
}

export class PdfFinalizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfFinalizeError";
  }
}

function redactAuditEventMetadataForRecipients(
  metadata: AuditEventRecord["metadata"],
): AuditEventRecord["metadata"] {
  if (!metadata) {
    return null;
  }

  const nextMetadata = { ...metadata };

  delete nextMetadata.signerEmail;
  // Who an email went to is another party's address.
  delete nextMetadata.recipient;
  // A correction's previous address is the same kind of third-party email.
  delete nextMetadata.previousEmail;

  return Object.keys(nextMetadata).length > 0 ? nextMetadata : null;
}

function redactAuditEventForRecipients(
  event: AuditEventRecord,
): AuditEventRecord {
  return auditEventRecordSchema.parse({
    ...event,
    actorEmail:
      event.actorType === "signer" ? null : (event.actorEmail ?? null),
    ipAddress: null,
    metadata: redactAuditEventMetadataForRecipients(event.metadata ?? null),
    userAgent: null,
  });
}

/**
 * Who did what an audit row records. An event's `signerName` and
 * `signerEmail` metadata name the signer it concerns, which is the actor
 * only on the signer's own events: a send or a reminder names the signer it
 * went to while the sender (or the system) did it, so the signer's name must
 * never be put in front of the sender's address (issue #52).
 */
export function describeAuditActor(event: AuditEventRecord): string {
  if (event.actorType !== "signer") {
    return event.actorEmail ?? event.actorType;
  }

  const actor =
    event.actorEmail ??
    (typeof event.metadata?.signerEmail === "string"
      ? event.metadata.signerEmail
      : event.actorType);
  const signerName =
    typeof event.metadata?.signerName === "string"
      ? event.metadata.signerName
      : null;

  return signerName && actor !== signerName
    ? `${signerName} <${actor}>`
    : actor;
}

type WrappedLine = {
  font: TextFace;
  size: number;
  text: string;
};

function formatAuditTimestamp(timestamp: number | null | undefined): string {
  if (typeof timestamp !== "number") {
    return "—";
  }

  const value = new Date(timestamp * 1000);

  return value.toISOString().replace(".000Z", " UTC");
}

function chunkLongWord(
  font: TextFace,
  size: number,
  maxWidth: number,
  word: string,
): string[] {
  if (font.widthOfTextAtSize(word, size) <= maxWidth) {
    return [word];
  }

  const chunks: string[] = [];
  let buffer = "";

  for (const character of word) {
    const candidate = `${buffer}${character}`;

    if (buffer && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      chunks.push(buffer);
      buffer = character;
      continue;
    }

    buffer = candidate;
  }

  if (buffer) {
    chunks.push(buffer);
  }

  return chunks;
}

function wrapText(
  font: TextFace,
  size: number,
  maxWidth: number,
  text: string,
): WrappedLine[] {
  const normalized = text.trim();

  if (!normalized) {
    return [];
  }

  const rawWords = normalized
    .split(/\s+/)
    .flatMap((word) => chunkLongWord(font, size, maxWidth, word));
  const lines: string[] = [];
  let currentLine = "";

  for (const word of rawWords) {
    const candidate = currentLine ? `${currentLine} ${word}` : word;

    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      currentLine = candidate;
      continue;
    }

    if (currentLine) {
      lines.push(currentLine);
    }

    currentLine = word;
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines.map((line) => ({
    font,
    size,
    text: line,
  }));
}

function fitTextSize(
  font: TextFace,
  text: string,
  maxWidth: number,
  maxHeight: number,
  preferredSize: number,
): number {
  let size = Math.min(preferredSize, maxHeight);

  while (size > 4 && font.widthOfTextAtSize(text, size) > maxWidth) {
    size -= 0.5;
  }

  return Math.max(4, size);
}

function getFieldPadding(widthPt: number, heightPt: number): number {
  return Math.max(2, Math.min(widthPt, heightPt) * 0.12);
}

/**
 * The smallest size an answer typed into a field is allowed to need. Signing
 * refuses an answer that only fits its box below this, so every answer on a
 * finished document can be read.
 */
export const MIN_FIELD_TEXT_SIZE = 4;

/** Below this, a value already accepted is still drawn whole, however small. */
const LAST_RESORT_FIELD_TEXT_SIZE = 0.5;

const FIELD_TEXT_LINE_HEIGHT = 1.15;

type FieldTextLayout = {
  /** From the top of the first line to the foot of the last, in points. */
  blockHeight: number;
  fits: boolean;
  lines: string[];
  size: number;
};

/**
 * Wraps a field value. Unlike wrapText, the spaces inside a line are kept as
 * the signer typed them; only those where a line breaks are dropped.
 */
export function wrapFieldText(
  font: TextFace,
  size: number,
  maxWidth: number,
  text: string,
): string[] {
  const parts = text.trim().split(/(\s+)/);
  const lines: string[] = [];
  let currentLine = "";
  let pendingSpace = "";

  for (let index = 0; index < parts.length; index += 2) {
    const word = parts[index] ?? "";

    if (!word) {
      continue;
    }

    for (const chunk of chunkLongWord(font, size, maxWidth, word)) {
      const candidate = currentLine
        ? `${currentLine}${pendingSpace}${chunk}`
        : chunk;

      if (!currentLine || font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        currentLine = candidate;
      } else {
        lines.push(currentLine);
        currentLine = chunk;
      }

      pendingSpace = "";
    }

    pendingSpace = parts[index + 1] ?? "";
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines;
}

function layoutAtSize(
  font: TextFace,
  text: string,
  maxWidth: number,
  maxHeight: number,
  size: number,
): FieldTextLayout {
  const lines = wrapFieldText(font, size, maxWidth, text);
  const blockHeight =
    lines.length === 0
      ? 0
      : (lines.length - 1) * size * FIELD_TEXT_LINE_HEIGHT + size;

  // A line can be wider than the box only when one character is.
  const fits =
    blockHeight <= maxHeight &&
    lines.every((line) => font.widthOfTextAtSize(line, size) <= maxWidth);

  return { blockHeight, fits, lines, size };
}

/**
 * Lays a value out in its box: one line at the preferred size when it fits,
 * otherwise wrapped onto as many lines as it needs, at the largest size, no
 * smaller than minSize, at which every line fits. When even minSize is too
 * big, the layout at minSize is returned with fits false.
 */
function layoutFieldText(
  font: TextFace,
  text: string,
  maxWidth: number,
  maxHeight: number,
  preferredSize: number,
  minSize: number,
): FieldTextLayout {
  const largest = Math.max(minSize, Math.min(preferredSize, maxHeight));
  const atLargest = layoutAtSize(font, text, maxWidth, maxHeight, largest);

  if (atLargest.fits) {
    return atLargest;
  }

  const atSmallest = layoutAtSize(font, text, maxWidth, maxHeight, minSize);

  if (!atSmallest.fits) {
    return atSmallest;
  }

  // A smaller size never needs more room, so the size is found by halving.
  let best = atSmallest;
  let low = minSize;
  let high = largest;

  while (high - low > 0.1) {
    const middle = (low + high) / 2;
    const layout = layoutAtSize(font, text, maxWidth, maxHeight, middle);

    if (layout.fits) {
      best = layout;
      low = middle;
    } else {
      high = middle;
    }
  }

  return best;
}

/** The room a text value has inside its field, as the stamp lays it out. */
function getTextFieldBox(rect: { heightPt: number; widthPt: number }) {
  const padding = getFieldPadding(rect.widthPt, rect.heightPt);

  // A box too small even for one line at the readable size still takes
  // one line at it, as it always has, but never a second.
  const maxHeight = Math.max(MIN_FIELD_TEXT_SIZE, rect.heightPt - padding * 2);

  return {
    maxHeight,
    maxWidth: Math.max(MIN_FIELD_TEXT_SIZE, rect.widthPt - padding * 2),
    padding,
    preferredSize: Math.min(maxHeight, rect.heightPt * 0.64),
  };
}

/**
 * Whether a value typed into a field fits its box at a readable size on the
 * page it is placed on. When it does not, also the most of its characters
 * that would.
 */
export function measureFieldTextFit(
  font: TextFace,
  field: Pick<FieldRecord, "height" | "width" | "x" | "y">,
  page: Pick<StoredPageSize, "heightPt" | "widthPt">,
  value: string,
): { fits: true } | { fits: false; maxCharacters: number } {
  const text = value.trim();
  const box = getTextFieldBox(normalizedRectToPdfRect(field, page));
  const fitsText = (candidate: string) =>
    layoutFieldText(
      font,
      candidate,
      box.maxWidth,
      box.maxHeight,
      box.preferredSize,
      MIN_FIELD_TEXT_SIZE,
    ).fits;

  if (fitsText(text)) {
    return { fits: true };
  }

  const characters = Array.from(text);
  let low = 0;
  let high = characters.length - 1;

  while (low < high) {
    const middle = Math.ceil((low + high) / 2);

    if (fitsText(characters.slice(0, middle).join(""))) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  return { fits: false, maxCharacters: low };
}

/**
 * The first value a signer typed that would not fit its box at a readable
 * size, with the most of its characters that would, or null when all fit.
 * Measured with the fonts the finished document is drawn with.
 */
export async function findTypedValueTooLongForField(
  entries: ReadonlyArray<{
    field: Pick<FieldRecord, "height" | "page" | "width" | "x" | "y">;
    value: string;
  }>,
  pages: readonly StoredPageSize[],
): Promise<{ maxCharacters: number; page: number } | null> {
  const measurable = entries.flatMap((entry) => {
    const page = pages.find((stored) => stored.pageNumber === entry.field.page);

    return page && entry.value.trim() ? [{ ...entry, pageSize: page }] : [];
  });

  if (measurable.length === 0) {
    return null;
  }

  const faces = await embedTextFaces(
    await PDFDocument.create(),
    measurable.map((entry) => entry.value),
  );

  for (const entry of measurable) {
    const fit = measureFieldTextFit(
      faces.regular,
      entry.field,
      entry.pageSize,
      entry.value,
    );

    if (!fit.fits) {
      return { maxCharacters: fit.maxCharacters, page: entry.field.page };
    }
  }

  return null;
}

export function shouldStampField(field: FieldRecord): boolean {
  if (field.type === "checkbox" || field.type === "radio") {
    return typeof field.checked === "boolean";
  }

  return typeof field.submittedAt === "number";
}

function buildCompletedAuditEvent(
  envelopeId: string,
  generatedAt: number,
): AuditEventRecord {
  return {
    actorEmail: null,
    actorType: "system",
    createdAt: generatedAt,
    envelopeId,
    event: "completed",
    id: randomUUID(),
    ipAddress: null,
    metadata: null,
    userAgent: null,
  };
}

async function getEmbeddedPng(
  imageKey: string,
  imageCache: Map<string, PDFImage>,
  pdfDocument: PDFDocument,
  storageService: StorageService,
): Promise<PDFImage> {
  const cachedImage = imageCache.get(imageKey);

  if (cachedImage) {
    return cachedImage;
  }

  const imageObject = await storageService.getObject(imageKey);
  const embeddedImage = await pdfDocument.embedPng(imageObject.body);

  imageCache.set(imageKey, embeddedImage);

  return embeddedImage;
}

function stripCompletedAuditEvents(
  auditEvents: readonly AuditEventRecord[],
): AuditEventRecord[] {
  return auditEvents.filter((event) => event.event !== "completed");
}

function getEnvelopeStatusLabel(status: EnvelopeRecord["status"]): string {
  switch (status) {
    case "completed":
      return "Completed";
    case "declined":
      return "Declined";
    case "voided":
      return "Voided";
    case "sent":
      return "Sent";
    case "draft":
      return "Draft";
    default:
      return status;
  }
}

function getCertificateTitle(envelope: EnvelopeRecord): string {
  return envelope.status === "completed"
    ? "PACTORA Certificate of Completion"
    : "PACTORA Audit Certificate";
}

function getTerminalTimestampLabel(envelope: EnvelopeRecord): string {
  switch (envelope.status) {
    case "completed":
      return "Completed at";
    case "declined":
      return "Declined at";
    case "voided":
      return "Voided at";
    default:
      return "Recorded at";
  }
}

function resolveTerminalTimestamp(
  envelope: EnvelopeRecord,
  fallbackTimestamp: number,
): number {
  switch (envelope.status) {
    case "completed":
      return envelope.completedAt ?? fallbackTimestamp;
    case "declined":
      return envelope.declinedAt ?? fallbackTimestamp;
    case "voided":
      return envelope.voidedAt ?? fallbackTimestamp;
    default:
      return fallbackTimestamp;
  }
}

function buildCertificateAuditEvents(input: {
  auditEvents: AuditEventRecord[];
  envelope: EnvelopeRecord;
  terminalTimestamp: number;
}): AuditEventRecord[] {
  // The rows come in the order they were recorded: the audit query reads
  // them by the chain's sequence, and a caller adds the event it is about to
  // record at the end. They are printed in that order and never re-sorted.
  // created_at is in whole seconds and ids are random, so sorting by time and
  // then id would shuffle events from the same second (issue #97).
  if (input.envelope.status !== "completed") {
    return [...input.auditEvents];
  }

  // A completed envelope shows one completed row. A recorded one keeps its
  // place, so events recorded after it stay after it. Before it is recorded,
  // as when the last signature seals the envelope, it goes last.
  const recordedCompletion = input.auditEvents.find(
    (event) => event.event === "completed",
  );

  if (recordedCompletion) {
    return input.auditEvents.filter(
      (event) => event.event !== "completed" || event === recordedCompletion,
    );
  }

  return [
    ...input.auditEvents,
    buildCompletedAuditEvent(input.envelope.id, input.terminalTimestamp),
  ];
}

export async function stampFieldValue(
  field: FieldRecord,
  page: PDFPage,
  fonts: {
    auditRegular: TextFace;
    signature: TextFace;
  },
  imageCache: Map<string, PDFImage>,
  pdfDocument: PDFDocument,
  storageService: StorageService,
  // A field's place is given on the page as it is shown, so the value is
  // drawn in those coordinates. On a rotated page it comes out turned with
  // the page, and so reads upright. A caller that draws on another page
  // than the one the field is on passes that page's geometry.
  geometry: DisplayedPageGeometry = getDisplayedPageGeometry(page),
): Promise<void> {
  if (!shouldStampField(field)) {
    return;
  }

  await drawOnDisplayedPage(page, geometry, () =>
    drawFieldValue(
      field,
      page,
      geometry,
      fonts,
      imageCache,
      pdfDocument,
      storageService,
    ),
  );
}

async function drawFieldValue(
  field: FieldRecord,
  page: PDFPage,
  geometry: DisplayedPageGeometry,
  fonts: {
    auditRegular: TextFace;
    signature: TextFace;
  },
  imageCache: Map<string, PDFImage>,
  pdfDocument: PDFDocument,
  storageService: StorageService,
): Promise<void> {
  const rect = normalizedRectToPdfRect(field, geometry);
  const padding = getFieldPadding(rect.widthPt, rect.heightPt);

  switch (field.type) {
    case "signature":
    case "initials": {
      if (field.inputMethod === "drawn" && field.imageKey) {
        const image = await getEmbeddedPng(
          field.imageKey,
          imageCache,
          pdfDocument,
          storageService,
        );
        const maxWidth = Math.max(4, rect.widthPt - padding * 2);
        const maxHeight = Math.max(4, rect.heightPt - padding * 2);
        const scaled = image.scaleToFit(maxWidth, maxHeight);
        const x = rect.xPt + (rect.widthPt - scaled.width) / 2;
        const y = rect.yPt + (rect.heightPt - scaled.height) / 2;

        page.drawImage(image, {
          height: scaled.height,
          width: scaled.width,
          x,
          y,
        });

        return;
      }

      const signatureValue = field.value?.trim();

      if (!signatureValue) {
        return;
      }

      const maxWidth = Math.max(12, rect.widthPt - padding * 2);
      const maxHeight = Math.max(10, rect.heightPt - padding * 2);
      const fontSize = fitTextSize(
        fonts.signature,
        signatureValue,
        maxWidth,
        maxHeight,
        Math.min(maxHeight, rect.heightPt * 0.9),
      );

      fonts.signature.drawText(page, signatureValue, {
        color: rgb(0.12, 0.12, 0.12),
        size: fontSize,
        x: rect.xPt + padding,
        y: rect.yPt + (rect.heightPt - fontSize) / 2 + fontSize * 0.1,
      });

      return;
    }
    case "date":
    case "name":
    case "text":
    case "number":
    case "dropdown": {
      const textValue = field.value?.trim();

      if (!textValue) {
        return;
      }

      // Wrapped and made smaller until the whole value is inside the box.
      // Signing refuses a typed value that would only fit below a readable
      // size, but a dropdown choice, or a value accepted earlier, is still
      // drawn whole, never cut off.
      const box = getTextFieldBox(rect);
      let layout = layoutFieldText(
        fonts.auditRegular,
        textValue,
        box.maxWidth,
        box.maxHeight,
        box.preferredSize,
        MIN_FIELD_TEXT_SIZE,
      );

      for (
        let floor = LAST_RESORT_FIELD_TEXT_SIZE;
        !layout.fits && floor >= 0.01;
        floor /= 2
      ) {
        layout = layoutFieldText(
          fonts.auditRegular,
          textValue,
          box.maxWidth,
          box.maxHeight,
          layout.size,
          floor,
        );
      }

      const { size } = layout;
      const top = rect.yPt + (rect.heightPt + layout.blockHeight) / 2;

      layout.lines.forEach((line, index) => {
        fonts.auditRegular.drawText(page, line, {
          color: rgb(0.12, 0.12, 0.12),
          size,
          x: rect.xPt + box.padding,
          y: top - size * 0.8 - index * size * FIELD_TEXT_LINE_HEIGHT,
        });
      });

      return;
    }
    case "checkbox": {
      const boxSize = Math.min(rect.widthPt, rect.heightPt, 14);
      const x = rect.xPt + padding / 2;
      const y = rect.yPt + (rect.heightPt - boxSize) / 2;

      page.drawRectangle({
        borderColor: rgb(0.18, 0.18, 0.18),
        borderWidth: 1.1,
        height: boxSize,
        width: boxSize,
        x,
        y,
      });

      if (field.checked) {
        page.drawLine({
          color: rgb(0.08, 0.08, 0.08),
          end: { x: x + boxSize * 0.42, y: y + boxSize * 0.2 },
          start: { x: x + boxSize * 0.16, y: y + boxSize * 0.5 },
          thickness: 1.4,
        });
        page.drawLine({
          color: rgb(0.08, 0.08, 0.08),
          end: { x: x + boxSize * 0.84, y: y + boxSize * 0.82 },
          start: { x: x + boxSize * 0.4, y: y + boxSize * 0.18 },
          thickness: 1.4,
        });
      }

      return;
    }
    case "radio": {
      // A ring for every button, and a dot in the one that was chosen.
      const diameter = Math.min(rect.widthPt, rect.heightPt, 14);
      const center = {
        x: rect.xPt + padding / 2 + diameter / 2,
        y: rect.yPt + rect.heightPt / 2,
      };

      page.drawCircle({
        borderColor: rgb(0.18, 0.18, 0.18),
        borderWidth: 1.1,
        size: diameter / 2,
        ...center,
      });

      if (field.checked) {
        page.drawCircle({
          color: rgb(0.08, 0.08, 0.08),
          size: diameter * 0.24,
          ...center,
        });
      }

      return;
    }
    default:
      return;
  }
}

const MANIFESTATION_MARGIN_PT = 2;
const MANIFESTATION_GUTTER_PT = 8;
const MANIFESTATION_VERTICAL_CLEARANCE_PT = 2;
const MANIFESTATION_PREFERRED_SIZE_PT = 6.5;
const MANIFESTATION_MIN_READABLE_SIZE_PT = 5;
const MANIFESTATION_LAST_RESORT_SIZE_PT = 0.5;
const MANIFESTATION_LINE_GAP_PT = 1.5;

type PageBox = {
  bottom: number;
  left: number;
  right: number;
  top: number;
};

type ManifestationTextLayout = {
  fitsHeight: boolean;
  fitsWidth: boolean;
  lineHeight: number;
  lines: string[];
  maxLineWidth: number;
  size: number;
};

type PlacedManifestation = {
  box: PageBox;
  collidesWithManifestation: boolean;
  fitsOnPage: boolean;
  hasCollision: boolean;
  hasDirectOverlap: boolean;
  lineHeight: number;
  lines: string[];
  size: number;
  topBaseline: number;
  x: number;
};

type PageManifestationTarget = {
  field: FieldRecord;
  rect: { heightPt: number; widthPt: number; xPt: number; yPt: number };
  text: string;
};

function rectToPageBox(rect: {
  heightPt: number;
  widthPt: number;
  xPt: number;
  yPt: number;
}): PageBox {
  return {
    bottom: rect.yPt,
    left: rect.xPt,
    right: rect.xPt + rect.widthPt,
    top: rect.yPt + rect.heightPt,
  };
}

function boxesOverlap(
  left: PageBox,
  right: PageBox,
  padX = 0,
  padY = 0,
): boolean {
  return (
    left.left < right.right + padX &&
    left.right + padX > right.left &&
    left.bottom < right.top + padY &&
    left.top + padY > right.bottom
  );
}

function manifestationLineHeight(size: number): number {
  return size + Math.min(MANIFESTATION_LINE_GAP_PT, size * 0.3);
}

function manifestationRequiredHeight(lineCount: number, size: number): number {
  return lineCount * manifestationLineHeight(size) + size * 0.25;
}

function measureManifestationLayout(
  font: TextFace,
  lines: string[],
  size: number,
  maxWidth: number,
  maxHeight: number,
): ManifestationTextLayout {
  const lineHeight = manifestationLineHeight(size);
  const maxLineWidth = lines.reduce(
    (widest, line) => Math.max(widest, font.widthOfTextAtSize(line, size)),
    0,
  );

  return {
    fitsHeight: manifestationRequiredHeight(lines.length, size) <= maxHeight,
    fitsWidth: maxLineWidth <= maxWidth,
    lineHeight,
    lines,
    maxLineWidth,
    size,
  };
}

function layoutManifestationText(
  font: TextFace,
  text: string,
  maxWidth: number,
  maxHeight: number,
  options: { allowVerticalShrink?: boolean } = {},
): ManifestationTextLayout {
  const allowVerticalShrink = options.allowVerticalShrink ?? false;
  const parts = text.split(" | ");

  // One line when it fits at a readable size, preserving the single-line
  // manifestation whenever there is horizontal (and when constrained,
  // vertical) room.
  for (
    let size = MANIFESTATION_PREFERRED_SIZE_PT;
    size >= MANIFESTATION_MIN_READABLE_SIZE_PT;
    size -= 0.5
  ) {
    const candidate = measureManifestationLayout(
      font,
      [text],
      size,
      maxWidth,
      maxHeight,
    );

    if (candidate.fitsWidth && (!allowVerticalShrink || candidate.fitsHeight)) {
      return candidate;
    }
  }

  // One line per part (name, UTC time, meaning) when every part fits whole
  // inside maxWidth at a readable size.
  for (
    let size = MANIFESTATION_PREFERRED_SIZE_PT;
    size >= MANIFESTATION_MIN_READABLE_SIZE_PT;
    size -= 0.5
  ) {
    const candidate = measureManifestationLayout(
      font,
      parts,
      size,
      maxWidth,
      maxHeight,
    );

    if (candidate.fitsWidth && (!allowVerticalShrink || candidate.fitsHeight)) {
      return candidate;
    }
  }

  // Wrap each part independently inside maxWidth at the largest readable
  // size that fits, so long names or narrow columns never overflow or lose
  // text.
  let firstWidthFit: ManifestationTextLayout | null = null;

  for (
    let size = MANIFESTATION_PREFERRED_SIZE_PT;
    size >= MANIFESTATION_MIN_READABLE_SIZE_PT;
    size -= 0.5
  ) {
    const wrapped = parts.flatMap((part) =>
      wrapFieldText(font, size, maxWidth, part),
    );
    const candidate = measureManifestationLayout(
      font,
      wrapped,
      size,
      maxWidth,
      maxHeight,
    );

    if (candidate.fitsWidth) {
      if (!firstWidthFit) {
        firstWidthFit = candidate;
      }

      if (candidate.fitsHeight) {
        return candidate;
      }
    }
  }

  if (firstWidthFit && !allowVerticalShrink) {
    return firstWidthFit;
  }

  // Last resort: shrink below the readable floor only when a single glyph
  // exceeds maxWidth or neither side of the field can fit the wrapped block
  // at a readable size, so nothing is ever clipped or truncated.
  let fallback =
    firstWidthFit ??
    measureManifestationLayout(
      font,
      parts.flatMap((part) =>
        wrapFieldText(font, MANIFESTATION_MIN_READABLE_SIZE_PT, maxWidth, part),
      ),
      MANIFESTATION_MIN_READABLE_SIZE_PT,
      maxWidth,
      maxHeight,
    );

  for (
    let size = MANIFESTATION_MIN_READABLE_SIZE_PT - 0.5;
    size >= 0.01;
    size = size > MANIFESTATION_LAST_RESORT_SIZE_PT ? size - 0.5 : size / 2
  ) {
    const singleLine = measureManifestationLayout(
      font,
      [text],
      size,
      maxWidth,
      maxHeight,
    );

    if (
      singleLine.fitsWidth &&
      (!allowVerticalShrink || singleLine.fitsHeight)
    ) {
      return singleLine;
    }

    const wrapped = parts.flatMap((part) =>
      wrapFieldText(font, size, maxWidth, part),
    );
    const candidate = measureManifestationLayout(
      font,
      wrapped,
      size,
      maxWidth,
      maxHeight,
    );

    fallback = candidate;

    if (candidate.fitsWidth && (!allowVerticalShrink || candidate.fitsHeight)) {
      return candidate;
    }
  }

  return fallback;
}

function pickLargestFittingCandidate(
  candidates: ReadonlyArray<PlacedManifestation | null>,
  predicate: (candidate: PlacedManifestation) => boolean,
): PlacedManifestation | null {
  let best: PlacedManifestation | null = null;

  for (const candidate of candidates) {
    if (!candidate || !predicate(candidate)) {
      continue;
    }

    if (!best || candidate.size > best.size) {
      best = candidate;
    }
  }

  return best;
}

/**
 * Lays out every Part 11 signature manifestation on one page so neighboring
 * fields and side-by-side manifestations never overlap each other or run past
 * the page edge (issue #220).
 */
function layoutPageManifestations(
  targets: readonly PageManifestationTarget[],
  allFieldBoxes: readonly { box: PageBox; field: FieldRecord }[],
  geometry: DisplayedPageGeometry,
  font: TextFace,
): Map<FieldRecord, PlacedManifestation> {
  const margin = Math.min(
    MANIFESTATION_MARGIN_PT,
    geometry.widthPt / 4,
    geometry.heightPt / 4,
  );
  const pageRight = geometry.widthPt - margin;
  const pageTop = geometry.heightPt - margin;

  // Rightmost signatures go first so every manifestation to the right has its
  // final bounding box before a signature to its left computes its available
  // horizontal width. Ties at the same x run bottom-to-top so a signature
  // forced above at the foot of the page claims its space before one above it.
  const ordered = [...targets].sort(
    (left, right) =>
      right.rect.xPt - left.rect.xPt ||
      left.rect.yPt - right.rect.yPt ||
      (left.field.id ?? "").localeCompare(right.field.id ?? ""),
  );
  const placed = new Map<FieldRecord, PlacedManifestation>();
  const placedBoxes: PageBox[] = [];

  for (const target of ordered) {
    const { field, rect, text } = target;
    const ownBox = rectToPageBox(rect);
    const otherFieldBoxes = allFieldBoxes
      .filter((entry) => entry.field !== field)
      .map((entry) => entry.box);
    const blockers = [...otherFieldBoxes, ...placedBoxes];
    const xAnchor = Math.max(
      margin,
      Math.min(rect.xPt, Math.max(margin, pageRight - 4)),
    );
    const spaceBelow = Math.max(0, rect.yPt - margin);
    const spaceAbove = Math.max(0, pageTop - (rect.yPt + rect.heightPt));

    const buildPlacement = (
      x: number,
      topBaseline: number,
      layout: ManifestationTextLayout,
      fitsVertically: boolean,
    ): PlacedManifestation => {
      const descender = layout.size * 0.25;
      const finalBottomBaseline =
        topBaseline - (layout.lines.length - 1) * layout.lineHeight;
      const box: PageBox = {
        bottom: finalBottomBaseline - descender,
        left: x,
        right: x + layout.maxLineWidth,
        top: topBaseline + layout.size,
      };
      const collidesWithManifestation = placedBoxes.some((blocker) =>
        boxesOverlap(box, blocker, 0, MANIFESTATION_VERTICAL_CLEARANCE_PT),
      );
      const collidesWithField = otherFieldBoxes.some((blocker) =>
        boxesOverlap(box, blocker, 0, MANIFESTATION_VERTICAL_CLEARANCE_PT),
      );
      const collidesWithOwnField = boxesOverlap(box, ownBox, 0, 0);
      const hasCollision =
        collidesWithManifestation || collidesWithField || collidesWithOwnField;
      const hasDirectOverlap =
        collidesWithOwnField ||
        placedBoxes.some((blocker) => boxesOverlap(box, blocker, 0, 0)) ||
        otherFieldBoxes.some((blocker) => boxesOverlap(box, blocker, 0, 0));

      return {
        box,
        collidesWithManifestation,
        fitsOnPage:
          fitsVertically &&
          box.left >= margin - 0.01 &&
          box.right <= pageRight + 0.01 &&
          box.bottom >= margin - 0.01 &&
          box.top <= pageTop + 0.01,
        hasCollision,
        hasDirectOverlap,
        lineHeight: layout.lineHeight,
        lines: layout.lines,
        size: layout.size,
        topBaseline,
        x,
      };
    };

    const layoutAtSide = (
      side: "below" | "above",
      options: {
        allowVerticalShrink: boolean;
        constrainToVerticalBlockers?: boolean;
        shiftLeft?: boolean;
        verticalClearance?: number;
      },
    ): PlacedManifestation => {
      const { allowVerticalShrink } = options;
      const constrainToVerticalBlockers =
        options.constrainToVerticalBlockers ?? false;
      const shiftLeft = options.shiftLeft ?? false;
      const verticalClearance =
        options.verticalClearance ?? MANIFESTATION_VERTICAL_CLEARANCE_PT;
      let leftBound = shiftLeft ? margin : xAnchor;
      let rightBound = pageRight;
      let verticalLimit = side === "below" ? spaceBelow : spaceAbove;
      let current!: PlacedManifestation;
      const maxPasses = blockers.length * 3 + 2;

      // Each pass strictly tightens at least one horizontal or vertical bound
      // against a finite blocker edge, so this always reaches a fixed point.
      for (let pass = 0; pass < maxPasses; pass += 1) {
        const maxWidth = Math.max(0.5, rightBound - leftBound);
        const layout = layoutManifestationText(
          font,
          text,
          maxWidth,
          Math.max(0, verticalLimit),
          { allowVerticalShrink },
        );
        const x = shiftLeft
          ? Math.max(
              leftBound,
              Math.min(xAnchor, rightBound - layout.maxLineWidth),
            )
          : xAnchor;
        const descender = layout.size * 0.25;
        const gap = layout.lineHeight - layout.size;
        let topBaseline: number;
        let fitsVertically: boolean;

        if (side === "below") {
          topBaseline = rect.yPt - layout.lineHeight;
          const bottomBaseline =
            topBaseline - (layout.lines.length - 1) * layout.lineHeight;

          fitsVertically = bottomBaseline - descender >= margin;
          if (
            !fitsVertically &&
            allowVerticalShrink &&
            !constrainToVerticalBlockers
          ) {
            const shiftUp = margin - (bottomBaseline - descender);

            topBaseline = Math.min(
              topBaseline + shiftUp,
              pageTop - layout.size,
            );
          }
        } else {
          const bottomBaseline = rect.yPt + rect.heightPt + gap + descender;

          topBaseline =
            bottomBaseline + (layout.lines.length - 1) * layout.lineHeight;
          fitsVertically = topBaseline + layout.size <= pageTop;

          if (!fitsVertically && !constrainToVerticalBlockers) {
            topBaseline = Math.min(topBaseline, pageTop - layout.size);
          }
        }

        current = buildPlacement(x, topBaseline, layout, fitsVertically);

        let nextLeftBound = leftBound;
        let nextRightBound = rightBound;
        let nextVerticalLimit = verticalLimit;

        for (const blocker of blockers) {
          const isRightSideBlocker =
            blocker.left > xAnchor &&
            (blocker.left >= rect.xPt + rect.widthPt - 1 ||
              blocker.left - xAnchor >= 24);

          if (
            isRightSideBlocker &&
            boxesOverlap(
              current.box,
              blocker,
              MANIFESTATION_GUTTER_PT,
              verticalClearance,
            )
          ) {
            const gutter = Math.min(
              MANIFESTATION_GUTTER_PT,
              (blocker.left - xAnchor) * 0.25,
            );
            const candidateBound = blocker.left - gutter;

            if (candidateBound < nextRightBound) {
              nextRightBound = candidateBound;
            }
            continue;
          }

          if (
            shiftLeft &&
            blocker.right <= xAnchor + 0.01 &&
            boxesOverlap(
              current.box,
              blocker,
              MANIFESTATION_GUTTER_PT,
              verticalClearance,
            )
          ) {
            const gutter = Math.min(
              MANIFESTATION_GUTTER_PT,
              (xAnchor - blocker.right) * 0.25,
            );
            const candidateLeft = Math.min(xAnchor, blocker.right + gutter);

            if (candidateLeft > nextLeftBound) {
              nextLeftBound = candidateLeft;
            }
            continue;
          }

          if (
            constrainToVerticalBlockers &&
            boxesOverlap(current.box, blocker, 0, verticalClearance)
          ) {
            if (side === "below" && blocker.top <= rect.yPt + 0.01) {
              const candidateHeight = Math.max(
                0,
                rect.yPt - (blocker.top + verticalClearance),
              );

              if (candidateHeight < nextVerticalLimit) {
                nextVerticalLimit = candidateHeight;
              }
            } else if (
              side === "above" &&
              blocker.bottom >= rect.yPt + rect.heightPt - 0.01
            ) {
              const candidateHeight = Math.max(
                0,
                blocker.bottom - verticalClearance - (rect.yPt + rect.heightPt),
              );

              if (candidateHeight < nextVerticalLimit) {
                nextVerticalLimit = candidateHeight;
              }
            }
          }
        }

        const changed =
          nextRightBound < rightBound - 0.01 ||
          nextLeftBound > leftBound + 0.01 ||
          nextVerticalLimit < verticalLimit - 0.01;

        if (!changed) {
          break;
        }

        leftBound = nextLeftBound;
        rightBound = nextRightBound;
        verticalLimit = nextVerticalLimit;
      }

      return current;
    };

    const layoutBeside = (
      side: "left" | "right",
      options: {
        allowVerticalShrink: boolean;
        verticalClearance?: number;
      },
    ): PlacedManifestation | null => {
      const { allowVerticalShrink } = options;
      const verticalClearance =
        options.verticalClearance ?? MANIFESTATION_VERTICAL_CLEARANCE_PT;
      let leftBound =
        side === "right"
          ? rect.xPt + rect.widthPt + MANIFESTATION_GUTTER_PT
          : margin;
      let rightBound =
        side === "right" ? pageRight : rect.xPt - MANIFESTATION_GUTTER_PT;

      if (rightBound - leftBound < 12) {
        return null;
      }

      const verticalInset =
        rect.heightPt > verticalClearance * 3 ? verticalClearance : 0;
      const bandBottom = Math.max(margin, rect.yPt + verticalInset);
      const bandTop = Math.min(
        pageTop,
        rect.yPt + rect.heightPt - verticalInset,
      );
      const availableHeight = bandTop - bandBottom;

      if (availableHeight <= 0) {
        return null;
      }

      let current: PlacedManifestation | null = null;
      const maxPasses = blockers.length + 2;

      for (let pass = 0; pass < maxPasses; pass += 1) {
        const maxWidth = Math.max(0.5, rightBound - leftBound);
        const layout = layoutManifestationText(
          font,
          text,
          maxWidth,
          availableHeight,
          { allowVerticalShrink },
        );
        const descender = layout.size * 0.25;
        const x =
          side === "right"
            ? leftBound
            : Math.max(leftBound, rightBound - layout.maxLineWidth);
        const bottomBaseline = bandBottom + descender;
        const topBaseline =
          bottomBaseline + (layout.lines.length - 1) * layout.lineHeight;
        const fitsVertically = topBaseline + layout.size <= bandTop + 0.01;

        current = buildPlacement(x, topBaseline, layout, fitsVertically);

        let nextLeftBound = leftBound;
        let nextRightBound = rightBound;

        for (const blocker of blockers) {
          if (
            !boxesOverlap(
              current.box,
              blocker,
              MANIFESTATION_GUTTER_PT,
              verticalClearance,
            )
          ) {
            continue;
          }

          if (side === "right" && blocker.left > leftBound) {
            const gutter = Math.min(
              MANIFESTATION_GUTTER_PT,
              (blocker.left - leftBound) * 0.25,
            );
            const candidateRight = blocker.left - gutter;

            if (candidateRight < nextRightBound) {
              nextRightBound = candidateRight;
            }
          } else if (side === "left" && blocker.right < rightBound) {
            const gutter = Math.min(
              MANIFESTATION_GUTTER_PT,
              (rightBound - blocker.right) * 0.25,
            );
            const candidateLeft = blocker.right + gutter;

            if (candidateLeft > nextLeftBound) {
              nextLeftBound = candidateLeft;
            }
          }
        }

        const changed =
          nextRightBound < rightBound - 0.01 ||
          nextLeftBound > leftBound + 0.01;

        if (!changed || nextRightBound - nextLeftBound < 4) {
          break;
        }

        leftBound = nextLeftBound;
        rightBound = nextRightBound;
      }

      return current;
    };

    const below = layoutAtSide("below", { allowVerticalShrink: false });
    let chosen: PlacedManifestation;

    if (below.fitsOnPage && !below.hasCollision) {
      chosen = below;
    } else {
      const above = layoutAtSide("above", { allowVerticalShrink: false });

      if (above.fitsOnPage && !above.hasCollision) {
        chosen = above;
      } else {
        const belowShifted = layoutAtSide("below", {
          allowVerticalShrink: false,
          shiftLeft: true,
        });
        const aboveShifted = layoutAtSide("above", {
          allowVerticalShrink: false,
          shiftLeft: true,
        });

        if (belowShifted.fitsOnPage && !belowShifted.hasCollision) {
          chosen = belowShifted;
        } else if (aboveShifted.fitsOnPage && !aboveShifted.hasCollision) {
          chosen = aboveShifted;
        } else {
          const verticalFitCandidates = [
            layoutAtSide("below", {
              allowVerticalShrink: true,
              constrainToVerticalBlockers: true,
            }),
            layoutAtSide("above", {
              allowVerticalShrink: true,
              constrainToVerticalBlockers: true,
            }),
            layoutAtSide("below", {
              allowVerticalShrink: true,
              constrainToVerticalBlockers: true,
              shiftLeft: true,
            }),
            layoutAtSide("above", {
              allowVerticalShrink: true,
              constrainToVerticalBlockers: true,
              shiftLeft: true,
            }),
          ];
          const besideCandidates = [
            layoutBeside("right", { allowVerticalShrink: true }),
            layoutBeside("left", { allowVerticalShrink: true }),
          ];
          const readableVertical = pickLargestFittingCandidate(
            verticalFitCandidates,
            (candidate) =>
              candidate.fitsOnPage &&
              !candidate.hasCollision &&
              candidate.size >= MANIFESTATION_MIN_READABLE_SIZE_PT,
          );
          const readableBeside = readableVertical
            ? null
            : pickLargestFittingCandidate(
                besideCandidates,
                (candidate) =>
                  candidate.fitsOnPage &&
                  !candidate.hasCollision &&
                  candidate.size >= MANIFESTATION_MIN_READABLE_SIZE_PT,
              );
          const anyClear =
            readableVertical ??
            readableBeside ??
            pickLargestFittingCandidate(
              [...verticalFitCandidates, ...besideCandidates],
              (candidate) => candidate.fitsOnPage && !candidate.hasCollision,
            );

          if (anyClear) {
            chosen = anyClear;
          } else {
            const tightCandidates = [
              layoutAtSide("below", {
                allowVerticalShrink: true,
                constrainToVerticalBlockers: true,
                verticalClearance: 0,
              }),
              layoutAtSide("above", {
                allowVerticalShrink: true,
                constrainToVerticalBlockers: true,
                verticalClearance: 0,
              }),
              layoutAtSide("below", {
                allowVerticalShrink: true,
                constrainToVerticalBlockers: true,
                shiftLeft: true,
                verticalClearance: 0,
              }),
              layoutAtSide("above", {
                allowVerticalShrink: true,
                constrainToVerticalBlockers: true,
                shiftLeft: true,
                verticalClearance: 0,
              }),
              layoutBeside("right", {
                allowVerticalShrink: true,
                verticalClearance: 0,
              }),
              layoutBeside("left", {
                allowVerticalShrink: true,
                verticalClearance: 0,
              }),
            ];
            const noDirectOverlap = pickLargestFittingCandidate(
              tightCandidates,
              (candidate) =>
                candidate.fitsOnPage && !candidate.hasDirectOverlap,
            );

            if (noDirectOverlap) {
              chosen = noDirectOverlap;
            } else if (below.fitsOnPage && !below.collidesWithManifestation) {
              chosen = below;
            } else if (above.fitsOnPage && !above.collidesWithManifestation) {
              chosen = above;
            } else if (below.fitsOnPage) {
              chosen = below;
            } else if (above.fitsOnPage) {
              chosen = above;
            } else {
              chosen = layoutAtSide(
                spaceBelow >= spaceAbove ? "below" : "above",
                { allowVerticalShrink: true },
              );
            }
          }
        }
      }
    }

    placed.set(field, chosen);
    placedBoxes.push(chosen.box);
  }

  return placed;
}

/**
 * Prints a Part 11 signature's manifestation just under the signature, or
 * just above it when there is no room below.
 */
async function stampSignatureManifestation(
  page: PDFPage,
  geometry: DisplayedPageGeometry,
  font: TextFace,
  placement: PlacedManifestation,
): Promise<void> {
  await drawOnDisplayedPage(page, geometry, () =>
    drawSignatureManifestation(page, font, placement),
  );
}

function drawSignatureManifestation(
  page: PDFPage,
  font: TextFace,
  placement: PlacedManifestation,
): void {
  placement.lines.forEach((line, index) => {
    font.drawText(page, line, {
      color: rgb(0.2, 0.2, 0.24),
      size: placement.size,
      x: placement.x,
      y: placement.topBaseline - index * placement.lineHeight,
    });
  });
}

function buildAuditLines(input: {
  auditEvents: AuditEventRecord[];
  auditFingerprint?: string | null;
  completedAt: number;
  copyRecipients?: readonly CertificateCopyRecipient[];
  envelope: EnvelopeRecord;
  fonts: {
    bold: TextFace;
    regular: TextFace;
  };
  maxWidth: number;
  redactForRecipients?: boolean;
  signedPdfSha256?: string | null;
  signers: SignerRecord[];
}) {
  const titleFontSize = 18;
  const sectionFontSize = 11;
  const bodyFontSize = 9.25;
  const lines: Array<WrappedLine & { gapAfter?: number; gapBefore?: number }> =
    [];

  const pushParagraph = (
    text: string,
    font: TextFace,
    size: number,
    options: { gapAfter?: number; gapBefore?: number } = {},
  ) => {
    const wrapped = wrapText(font, size, input.maxWidth, text);

    if (wrapped.length === 0) {
      return;
    }

    wrapped.forEach((line, index) => {
      lines.push({
        ...line,
        gapAfter: index === wrapped.length - 1 ? options.gapAfter : undefined,
        gapBefore: index === 0 ? options.gapBefore : undefined,
      });
    });
  };

  const terminalTimestamp = resolveTerminalTimestamp(
    input.envelope,
    input.completedAt,
  );
  const auditEvents = buildCertificateAuditEvents({
    auditEvents: input.auditEvents,
    envelope: input.envelope,
    terminalTimestamp,
  });

  pushParagraph(
    getCertificateTitle(input.envelope),
    input.fonts.bold,
    titleFontSize,
    {
      gapAfter: 8,
    },
  );
  pushParagraph(
    `Envelope ID: ${input.envelope.id}`,
    input.fonts.regular,
    bodyFontSize,
  );
  pushParagraph(
    `Document title: ${input.envelope.title}`,
    input.fonts.regular,
    bodyFontSize,
  );
  pushParagraph(
    `Source PDF: ${input.envelope.sourcePdfFilename}`,
    input.fonts.regular,
    bodyFontSize,
  );
  pushParagraph(
    `Source document hash: ${input.envelope.sourcePdfHash}`,
    input.fonts.regular,
    bodyFontSize,
  );
  if (input.signedPdfSha256) {
    pushParagraph(
      `Signed document SHA-256: ${input.signedPdfSha256}`,
      input.fonts.regular,
      bodyFontSize,
    );
  }

  if (input.auditFingerprint) {
    pushParagraph(
      `Audit trail fingerprint (SHA-256): ${input.auditFingerprint}`,
      input.fonts.regular,
      bodyFontSize,
    );
  }

  pushParagraph(
    `Status: ${getEnvelopeStatusLabel(input.envelope.status)}`,
    input.fonts.regular,
    bodyFontSize,
  );
  pushParagraph(
    `${getTerminalTimestampLabel(input.envelope)}: ${formatAuditTimestamp(terminalTimestamp)}`,
    input.fonts.regular,
    bodyFontSize,
    {
      gapAfter: 10,
    },
  );

  const approvers = input.signers.filter(
    (signer) => signer.role === "approver",
  );

  pushParagraph(
    approvers.length > 0 ? "Signers and approvers" : "Signers",
    input.fonts.bold,
    sectionFontSize,
    {
      gapAfter: 4,
    },
  );

  if (approvers.length > 0) {
    pushParagraph(
      "Approvers reviewed the document and approved or rejected it. They placed no signature and nothing of theirs is stamped on the document.",
      input.fonts.regular,
      bodyFontSize,
    );
  }

  // Each signer is numbered by their step of the signing order. With every
  // signer in a step of their own that is their place in the list; signers
  // who share a number were asked to sign at the same time, and the line
  // below says so.
  if (hasSharedSigningStep(input.signers)) {
    pushParagraph(
      "Signers with the same number were asked to sign at the same time. Each number started once everyone with the number before it had signed.",
      input.fonts.regular,
      bodyFontSize,
    );
  }

  for (const signer of input.signers) {
    const actionLabel = getSignerCertificateActionLabel(input.envelope, signer);
    const step = signingStepOf(signer);
    const roleLabel = signer.role === "approver" ? " | Approver" : "";
    const signerLabel = input.redactForRecipients
      ? `${step}. ${signer.name}${roleLabel} | ${actionLabel}`
      : `${step}. ${signer.name} <${signer.email}>${roleLabel} | ${actionLabel}`;

    pushParagraph(signerLabel, input.fonts.regular, bodyFontSize);

    for (const detail of describeSignerEvidence(
      signer,
      input.auditEvents,
      Boolean(input.redactForRecipients),
    )) {
      pushParagraph(`   ${detail}`, input.fonts.regular, bodyFontSize);
    }
  }

  // Approvals on their own, so they are never read as signatures.
  const decided = approvers.filter(
    (signer) => signer.status === "signed" || signer.status === "declined",
  );

  if (decided.length > 0) {
    pushParagraph("Approvals", input.fonts.bold, sectionFontSize, {
      gapAfter: 4,
      gapBefore: 10,
    });

    for (const approver of decided) {
      const who = input.redactForRecipients
        ? approver.name
        : `${approver.name} <${approver.email}>`;

      pushParagraph(
        approver.status === "signed"
          ? `Approved by ${who} at ${formatAuditTimestamp(approver.signedAt)}`
          : `Rejected by ${who} at ${formatAuditTimestamp(approver.declinedAt)}${
              approver.declineReason ? `: ${approver.declineReason}` : ""
            }`,
        input.fonts.regular,
        bodyFontSize,
      );
    }
  }

  if (input.copyRecipients && input.copyRecipients.length > 0) {
    pushParagraph("Copy recipients", input.fonts.bold, sectionFontSize, {
      gapAfter: 4,
      gapBefore: 10,
    });
    pushParagraph(
      "Sent a copy of the finished document. They did not sign it.",
      input.fonts.regular,
      bodyFontSize,
    );

    for (const recipient of input.copyRecipients) {
      pushParagraph(
        input.redactForRecipients
          ? recipient.name
          : `${recipient.name} <${recipient.email}>`,
        input.fonts.regular,
        bodyFontSize,
      );
    }
  }

  pushParagraph("Audit events", input.fonts.bold, sectionFontSize, {
    gapAfter: 4,
    gapBefore: 10,
  });

  for (const event of auditEvents) {
    const actorLabel = describeAuditActor(event);
    const eventLabel =
      event.event === "signer_corrected" ? "Signer corrected" : event.event;

    pushParagraph(
      `${formatAuditTimestamp(event.createdAt)} | ${eventLabel} | ${actorLabel}`,
      input.fonts.regular,
      bodyFontSize,
    );

    for (const detail of describeEventEvidence(event)) {
      pushParagraph(`   ${detail}`, input.fonts.regular, bodyFontSize);
    }
  }

  pushParagraph("How to check this record", input.fonts.bold, sectionFontSize, {
    gapAfter: 4,
    gapBefore: 10,
  });
  pushParagraph(
    "The signed document and this certificate are each sealed with a digital signature. A PDF reader shows the seal as valid only if the file has not changed since it was sealed. The SHA-256 values above can also be checked on this site's Verify page.",
    input.fonts.regular,
    bodyFontSize,
  );

  return lines;
}

const AUTHENTICATION_LABELS: Record<string, string> = {
  access_code: "access code from the sender",
  account: "own account, with email address and password to open it",
  email_code: "one-time code sent by email",
};

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * A signature the signer made with their own certificate through the
 * install's signing provider: its level, the provider, and the certificate.
 */
function describeProviderSignatureEvidence(
  signed: AuditEventRecord | undefined,
  redacted: boolean,
): string[] {
  const value = signed?.metadata?.providerSignature;

  if (!value || typeof value !== "object") {
    return [];
  }

  const signature = value as Record<string, unknown>;
  const level =
    signature.level === "qualified"
      ? "a qualified electronic signature"
      : signature.level === "advanced"
        ? "an advanced electronic signature"
        : null;

  if (!level) {
    return [];
  }

  const provider =
    typeof signature.provider === "string"
      ? ` through ${signature.provider}`
      : "";
  const method =
    typeof signature.method === "string" ? ` (${signature.method})` : "";
  const details = [
    `Signed with ${level}${provider}${method}; the signature is in the signed PDF`,
  ];

  if (!redacted && typeof signature.certificateSubject === "string") {
    const issuer =
      typeof signature.certificateIssuer === "string"
        ? `, issued by ${signature.certificateIssuer}`
        : "";
    const serial =
      typeof signature.certificateSerialNumber === "string"
        ? `, serial ${signature.certificateSerialNumber}`
        : "";
    const validTo =
      typeof signature.certificateValidTo === "number"
        ? `, valid to ${formatAuditTimestamp(signature.certificateValidTo)}`
        : "";

    details.push(
      `Signing certificate: ${signature.certificateSubject}${issuer}${serial}${validTo}`,
    );
  }

  if (signature.timestamped === true) {
    details.push(
      "The signature carries a timestamp from a time-stamping service",
    );
  }

  return details;
}

function isRevertedSignerCorrection(event: AuditEventRecord): boolean {
  return (
    event.event === "signer_corrected" && event.metadata?.reverted === true
  );
}

/**
 * Index at which this signer's current identity begins. A correction that
 * was later reversed restores the previous identity, so earlier consent
 * still counts.
 */
function currentSignerIdentityStart(
  events: readonly AuditEventRecord[],
): number {
  const starts = [0];

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];

    if (event?.event !== "signer_corrected") {
      continue;
    }

    if (isRevertedSignerCorrection(event)) {
      if (starts.length > 1) {
        starts.pop();
      }
    } else {
      starts.push(index + 1);
    }
  }

  return starts[starts.length - 1] ?? 0;
}

/**
 * For a signature made inside another app: identity then rests on that app
 * having signed the person in. The record shows only where the link was
 * given, not that the app checked who opened it, so the certificate says
 * the check was left to the app rather than that it happened.
 */
function describeEmbeddedDelivery(embedded: Record<string, unknown>): string {
  const origin =
    typeof embedded.origin === "string" ? embedded.origin : "another site";
  const key =
    typeof embedded.apiKeyName === "string"
      ? ` through the API key "${embedded.apiKeyName}"`
      : "";

  return `a signing link given to the app at ${origin}${key} (embedded signing; identifying the signer was left to that app)`;
}

/** What the record shows about how one signer was identified and agreed. */
function describeSignerEvidence(
  signer: SignerRecord,
  auditEvents: readonly AuditEventRecord[],
  redacted: boolean,
): string[] {
  const forSigner = auditEvents.filter(
    (event) => event.metadata?.signerId === signer.id,
  );
  const details: string[] = [];
  const approver = signer.role === "approver";
  // The signature, or an approver's approval.
  const signed = forSigner.find(
    (event) => event.event === (approver ? "approved" : "signed"),
  );
  // A decline or a rejection, which also say which checks the person had
  // passed.
  const ended = forSigner.find(
    (event) => event.event === "declined" || event.event === "rejected",
  );
  // A correction clears the row's consent. The first consented event for
  // this signer id can still be the previous person's, so only agreement
  // recorded after the latest standing correction counts as this
  // recipient's. A reversal restores the earlier identity, including that
  // earlier agreement.
  const identityStart = currentSignerIdentityStart(forSigner);
  let consented: AuditEventRecord | undefined;

  for (let index = forSigner.length - 1; index >= identityStart; index -= 1) {
    const event = forSigner[index];

    if (event?.event === "consented") {
      consented = event;
      break;
    }
  }

  // A signer who declined, or an approver who rejected, in another app has
  // no signed event; the declined or rejected event carries the same record
  // of where it happened.
  const declined =
    signed === undefined && signer.status === "declined"
      ? forSigner.findLast(
          (event) => event.event === "declined" || event.event === "rejected",
        )
      : undefined;
  const embeddedSource = signed ?? declined;
  const embedded =
    embeddedSource?.metadata?.embedded &&
    typeof embeddedSource.metadata.embedded === "object"
      ? (embeddedSource.metadata.embedded as Record<string, unknown>)
      : null;
  const checks = [
    embedded
      ? describeEmbeddedDelivery(embedded)
      : "possession of the emailed signing link",
    ...readStringArray((signed ?? ended)?.metadata?.authMethods).map(
      (method) => AUTHENTICATION_LABELS[method] ?? method,
    ),
  ];

  const part11 =
    signed?.metadata?.part11 && typeof signed.metadata.part11 === "object"
      ? (signed.metadata.part11 as Record<string, unknown>)
      : null;

  if (part11) {
    checks.push("email address and password given again to sign");
  }

  if (signed || signer.status === "declined") {
    details.push(`Identified by: ${checks.join(", ")}`);
  }

  const manifestation = buildSignatureManifestation(signer);

  if (part11 && manifestation) {
    details.push(manifestation);

    if (typeof part11.meaningStatement === "string") {
      details.push(
        `Meaning confirmed by the signer: "${part11.meaningStatement}"`,
      );
    }
  }

  if (consented) {
    details.push(
      `Agreed to use electronic records and signatures at ${formatAuditTimestamp(consented.createdAt)}${
        typeof consented.metadata?.disclosureVersion === "string"
          ? ` (disclosure ${consented.metadata.disclosureVersion})`
          : ""
      }`,
    );
  }

  const methods = readStringArray(signed?.metadata?.signatureMethods);

  if (methods.length > 0) {
    details.push(`Signature adopted by: ${methods.join(", ")}`);
  }

  details.push(...describeProviderSignatureEvidence(signed, redacted));

  if (!redacted && signed?.ipAddress) {
    details.push(
      `${approver ? "Approved" : "Signed"} from IP ${signed.ipAddress}`,
    );
  }

  return details;
}

function describeEventEvidence(event: AuditEventRecord): string[] {
  const details: string[] = [];
  const metadata = event.metadata ?? {};

  if (event.ipAddress || event.userAgent) {
    details.push(
      [
        event.ipAddress ? `IP ${event.ipAddress}` : null,
        event.userAgent ? `browser ${event.userAgent.slice(0, 160)}` : null,
      ]
        .filter(Boolean)
        .join(" | "),
    );
  }

  if (typeof metadata.timezoneOffsetMinutes === "number") {
    const offset = -metadata.timezoneOffsetMinutes;
    const sign = offset >= 0 ? "+" : "-";
    const hours = Math.floor(Math.abs(offset) / 60);
    const minutes = Math.abs(offset) % 60;

    details.push(
      `signer's clock: UTC${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`,
    );
  }

  if (event.event === "email_sent") {
    const recipient =
      typeof metadata.recipient === "string" ? metadata.recipient : null;
    const kind =
      typeof metadata.template === "string" ? metadata.template : null;
    const messageId =
      typeof metadata.messageId === "string" ? metadata.messageId : null;

    details.push(
      [
        kind ? `email ${kind.replaceAll("_", " ")}` : "email",
        recipient ? `to ${recipient}` : null,
        messageId
          ? isCapturedMessageId(messageId)
            ? // The capture driver only wrote it to the local outbox.
              `captured locally as ${messageId}, not sent`
            : `accepted by the mail provider as ${messageId}`
          : null,
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  if (event.event === "signer_corrected") {
    details.push(describeSignerCorrectedEvent(metadata));
  }

  if (event.event === "verified" && typeof metadata.method === "string") {
    details.push(
      `passed: ${AUTHENTICATION_LABELS[metadata.method] ?? metadata.method}`,
    );
  }

  if (
    event.event === "verification_failed" &&
    typeof metadata.method === "string"
  ) {
    details.push(
      `wrong ${AUTHENTICATION_LABELS[metadata.method] ?? metadata.method}`,
    );
  }

  return details;
}

function getSignerCertificateActionLabel(
  envelope: EnvelopeRecord,
  signer: SignerRecord,
): string {
  // An approver's turn done is an approval, and their decline a rejection.
  const approver = signer.role === "approver";
  const awaiting = approver ? "Awaiting approval" : "Awaiting signature";

  switch (signer.status) {
    case "signed":
      return `${approver ? "Approved" : "Signed"} at ${formatAuditTimestamp(signer.signedAt)}`;
    case "declined":
      return `${approver ? "Rejected" : "Declined"} at ${formatAuditTimestamp(signer.declinedAt)}`;
    case "notified":
      if (envelope.status === "voided") {
        return `${awaiting} when envelope was voided`;
      }

      if (envelope.status === "declined") {
        return `${awaiting} when envelope was declined`;
      }

      return awaiting;
    case "pending":
      return "Not reached";
    default: {
      const exhaustiveStatus: never = signer.status;
      return exhaustiveStatus;
    }
  }
}

function appendAuditTrailPages(input: {
  auditEvents: AuditEventRecord[];
  auditFingerprint?: string | null;
  completedAt: number;
  copyRecipients?: readonly CertificateCopyRecipient[];
  envelope: EnvelopeRecord;
  fonts: {
    bold: TextFace;
    regular: TextFace;
  };
  pdfDocument: PDFDocument;
  redactForRecipients?: boolean;
  signedPdfSha256?: string | null;
  signers: SignerRecord[];
}) {
  const templatePage = input.pdfDocument.getPageCount()
    ? input.pdfDocument.getPage(0)
    : null;
  const pageSize = templatePage
    ? {
        height: templatePage.getHeight(),
        width: templatePage.getWidth(),
      }
    : DEFAULT_AUDIT_PAGE_SIZE;
  const margin = 48;
  const maxWidth = pageSize.width - margin * 2;
  const lineHeightMultiplier = 1.24;
  const lines = buildAuditLines({
    auditEvents: input.auditEvents,
    auditFingerprint: input.auditFingerprint,
    completedAt: input.completedAt,
    copyRecipients: input.copyRecipients,
    envelope: input.envelope,
    fonts: input.fonts,
    maxWidth,
    redactForRecipients: input.redactForRecipients,
    signedPdfSha256: input.signedPdfSha256,
    signers: input.signers,
  });

  let page = input.pdfDocument.addPage([pageSize.width, pageSize.height]);
  let cursorY = pageSize.height - margin;

  for (const line of lines) {
    cursorY -= line.gapBefore ?? 0;

    const lineHeight = line.size * lineHeightMultiplier;

    if (cursorY - lineHeight < margin) {
      page = input.pdfDocument.addPage([pageSize.width, pageSize.height]);
      cursorY = pageSize.height - margin;
    }

    line.font.drawText(page, line.text, {
      color: rgb(0.14, 0.14, 0.14),
      size: line.size,
      x: margin,
      y: cursorY - line.size,
    });

    cursorY -= lineHeight;
    cursorY -= line.gapAfter ?? 0;
  }
}

/** Someone sent a copy of the finished document who did not sign it. */
export type CertificateCopyRecipient = { email: string; name: string };

type CertificateInput = {
  auditEvents: AuditEventRecord[];
  copyRecipients?: readonly CertificateCopyRecipient[];
  envelope: EnvelopeRecord;
  redactForRecipients?: boolean;
  /** The finished signed PDF's SHA-256, printed when there is one. */
  signedPdfSha256?: string | null;
  signers: SignerRecord[];
};

type SealOption = {
  seal?: PdfSealer;
};

function assertTerminalEnvelope(envelope: EnvelopeRecord, noun: string) {
  if (
    envelope.status !== "completed" &&
    envelope.status !== "declined" &&
    envelope.status !== "voided"
  ) {
    throw new PdfFinalizeError(
      `${noun} can only be generated for terminal envelopes.`,
    );
  }
}

export async function storeEnvelopeCertificatePdf(
  input: CertificateInput & { certificate: StorageObjectRef },
  {
    seal,
    storageService = createStorageService(),
  }: SealOption & {
    storageService?: StorageService;
  } = {},
): Promise<StoredSealedPdf> {
  assertTerminalEnvelope(input.envelope, "Certificates");

  const body = await renderEnvelopeCertificatePdf(input, { seal });
  const stored = await storageService.putObject({
    body,
    contentType: "application/pdf",
    key: input.certificate.key,
  });

  return { ...stored, body, sha256: sha256Hex(body) };
}

export async function storeRecipientEnvelopeCertificatePdf(
  input: Omit<CertificateInput, "redactForRecipients"> & {
    certificate: StorageObjectRef;
  },
  {
    seal,
    storageService = createStorageService(),
  }: SealOption & {
    storageService?: StorageService;
  } = {},
): Promise<StoredSealedPdf> {
  assertTerminalEnvelope(input.envelope, "Evidence bundles");

  return storeEnvelopeCertificatePdf(
    {
      ...input,
      redactForRecipients: true,
    },
    {
      seal,
      storageService,
    },
  );
}

export async function renderEnvelopeCertificatePdf(
  input: CertificateInput,
  { seal = defaultSealer }: SealOption = {},
): Promise<Uint8Array> {
  assertTerminalEnvelope(input.envelope, "Certificates");

  const pdfDocument = await PDFDocument.create();
  const faces = await embedTextFaces(
    pdfDocument,
    [
      input.envelope,
      input.signers,
      input.auditEvents,
      input.copyRecipients ?? [],
    ],
    { bold: true, certificate: true },
  );
  const terminalTimestamp = resolveTerminalTimestamp(
    input.envelope,
    Math.floor(Date.now() / 1000),
  );

  appendAuditTrailPages({
    auditEvents: input.redactForRecipients
      ? input.auditEvents.map(redactAuditEventForRecipients)
      : input.auditEvents,
    auditFingerprint: computeAuditFingerprint(
      stripCompletedAuditEvents(input.auditEvents),
    ),
    completedAt: terminalTimestamp,
    copyRecipients: input.copyRecipients,
    envelope: input.envelope,
    fonts: faces,
    pdfDocument,
    redactForRecipients: input.redactForRecipients,
    signedPdfSha256: input.signedPdfSha256,
    signers: input.signers,
  });
  pdfDocument.setTitle(`Audit certificate: ${input.envelope.title}`);
  pdfDocument.setProducer("PACTORA");

  return seal(pdfDocument, "certificate");
}

export class SourceDocumentChangedError extends PdfFinalizeError {
  constructor() {
    super(
      "The stored source document no longer matches the one that was sent for signing.",
    );
    this.name = "SourceDocumentChangedError";
  }
}

export async function renderFinalizedEnvelopePdf(
  input: {
    auditEvents: AuditEventRecord[];
    completedAt: number;
    copyRecipients?: readonly CertificateCopyRecipient[];
    envelope: EnvelopeRecord;
    fields: FieldRecord[];
    includeAuditTrail?: boolean;
    /** The envelope's stored page sizes, which fields were placed against. */
    pages: readonly StoredPageSize[];
    signers: SignerRecord[];
    sourcePdfKey: string;
  },
  {
    seal = defaultSealer,
    storageService = createStorageService(),
  }: SealOption & {
    storageService?: StorageService;
  } = {},
): Promise<Uint8Array> {
  const sourcePdfObject = await storageService.getObject(input.sourcePdfKey);

  // The certificate states the source document's hash, so the stamped copy
  // must be made from exactly that file.
  if (sha256Hex(sourcePdfObject.body) !== input.envelope.sourcePdfHash) {
    throw new SourceDocumentChangedError();
  }

  const pdfDocument = await PDFDocument.load(sourcePdfObject.body);

  const stampedFields = input.fields
    .filter(shouldStampField)
    .sort((left, right) => left.page - right.page || left.y - right.y);
  // Part 11: the signer's name, the time and the meaning, printed beside
  // each of their signatures (21 CFR 11.50).
  const manifestations = new Map<string, string>();

  if (input.envelope.part11) {
    for (const signer of input.signers) {
      const text = signer.id ? buildSignatureManifestation(signer) : null;

      if (text && signer.id) {
        manifestations.set(signer.id, text);
      }
    }
  }
  // The signed document embeds glyphs for the stamped values only. The
  // certificate's wording is added when the audit trail is appended to it.
  const faces = await embedTextFaces(
    pdfDocument,
    [
      stampedFields.map((field) => field.value),
      [...manifestations.values()],
      input.includeAuditTrail
        ? [
            input.envelope,
            input.signers,
            input.auditEvents,
            input.copyRecipients ?? [],
          ]
        : [],
    ],
    {
      bold: Boolean(input.includeAuditTrail),
      certificate: Boolean(input.includeAuditTrail),
      signature: stampedFields.some(
        (field) =>
          (field.type === "signature" || field.type === "initials") &&
          field.inputMethod !== "drawn",
      ),
    },
  );
  const imageCache = new Map<string, PDFImage>();
  const storedPages = new Map(
    input.pages.map((page) => [page.pageNumber, page]),
  );
  const pageManifestations = new Map<
    number,
    {
      allFieldBoxes: Array<{ box: PageBox; field: FieldRecord }>;
      geometry: DisplayedPageGeometry;
      page: PDFPage;
      targets: PageManifestationTarget[];
    }
  >();

  for (const placedField of stampedFields) {
    const page = pdfDocument.getPage(placedField.page - 1);

    if (!page) {
      throw new PdfFinalizeError(
        `Field ${placedField.id} references missing page ${placedField.page}.`,
      );
    }

    const geometry = getDisplayedPageGeometry(page);
    const field = fieldOnDisplayedPage(
      placedField,
      storedPages.get(placedField.page),
      geometry,
    );

    await stampFieldValue(
      field,
      page,
      { auditRegular: faces.regular, signature: faces.signature },
      imageCache,
      pdfDocument,
      storageService,
      geometry,
    );

    if (manifestations.size > 0) {
      let pageContext = pageManifestations.get(placedField.page);

      if (!pageContext) {
        pageContext = {
          allFieldBoxes: [],
          geometry,
          page,
          targets: [],
        };
        pageManifestations.set(placedField.page, pageContext);
      }

      const rect = normalizedRectToPdfRect(field, geometry);

      pageContext.allFieldBoxes.push({
        box: rectToPageBox(rect),
        field,
      });

      const manifestation =
        field.type === "signature" ? manifestations.get(field.signerId) : null;

      if (manifestation) {
        pageContext.targets.push({ field, rect, text: manifestation });
      }
    }
  }

  for (const pageContext of pageManifestations.values()) {
    if (pageContext.targets.length === 0) {
      continue;
    }

    const placed = layoutPageManifestations(
      pageContext.targets,
      pageContext.allFieldBoxes,
      pageContext.geometry,
      faces.regular,
    );

    for (const target of pageContext.targets) {
      const placement = placed.get(target.field);

      if (placement) {
        await stampSignatureManifestation(
          pageContext.page,
          pageContext.geometry,
          faces.regular,
          placement,
        );
      }
    }
  }

  try {
    pdfDocument.getForm().flatten();
  } catch {
    // Many source PDFs have no AcroForm. Stamping still produces the final locked view.
  }

  if (input.includeAuditTrail) {
    appendAuditTrailPages({
      auditEvents: stripCompletedAuditEvents(input.auditEvents),
      completedAt: input.completedAt,
      copyRecipients: input.copyRecipients,
      envelope: input.envelope,
      fonts: faces,
      pdfDocument,
      signers: input.signers,
    });
  }

  return seal(pdfDocument, "signed-document");
}

export async function finalizeEnvelope(
  input: {
    auditEvents: AuditEventRecord[];
    copyRecipients?: readonly CertificateCopyRecipient[];
    envelope: EnvelopeRecord;
    fields: FieldRecord[];
    pages: readonly StoredPageSize[];
    signers: SignerRecord[];
    sourcePdf: StorageObjectRef;
  },
  {
    seal,
    signedRevision,
    storageService = createStorageService(),
  }: SealOption & {
    /**
     * The last signer's revision, when the signers signed with their own
     * certificates: it is the signed document, and gets validation data.
     */
    signedRevision?: Uint8Array;
    storageService?: StorageService;
  } = {},
): Promise<FinalizedEnvelopeArtifacts> {
  const generatedAt = Math.floor(Date.now() / 1000);
  const storageIdentity = {
    envelopeId: input.envelope.id,
    userId: input.envelope.userId,
  };
  const signedPdfBytes = signedRevision
    ? await finishSignerSignedPdf(signedRevision)
    : await renderFinalizedEnvelopePdf(
        {
          auditEvents: input.auditEvents,
          completedAt: generatedAt,
          copyRecipients: input.copyRecipients,
          envelope: input.envelope,
          fields: input.fields,
          pages: input.pages,
          signers: input.signers,
          sourcePdfKey: input.sourcePdf.key,
        },
        {
          seal,
          storageService,
        },
      );
  const signedPdfSha256 = sha256Hex(signedPdfBytes);
  const completedEnvelope = {
    ...input.envelope,
    completedAt: generatedAt,
    status: "completed" as const,
    updatedAt: generatedAt,
  };
  let signedPdf: StoredSealedPdf | null = null;
  let certificate: StoredSealedPdf | null = null;
  let recipientCertificate: StoredSealedPdf | null = null;

  try {
    signedPdf = {
      ...(await storageService.putObject({
        body: signedPdfBytes,
        contentType: "application/pdf",
        key: buildEnvelopeSignedPdfKey(storageIdentity),
      })),
      body: signedPdfBytes,
      sha256: signedPdfSha256,
    };

    certificate = await storeEnvelopeCertificatePdf(
      {
        auditEvents: input.auditEvents,
        certificate: {
          bucketName: input.sourcePdf.bucketName,
          key: buildEnvelopeCertificateKey({
            ...storageIdentity,
            audience: "internal",
          }),
        },
        copyRecipients: input.copyRecipients,
        envelope: completedEnvelope,
        signedPdfSha256,
        signers: input.signers,
      },
      {
        seal,
        storageService,
      },
    );
    recipientCertificate = await storeRecipientEnvelopeCertificatePdf(
      {
        auditEvents: input.auditEvents,
        certificate: {
          bucketName: input.sourcePdf.bucketName,
          key: buildEnvelopeCertificateKey({
            ...storageIdentity,
            audience: "recipient",
          }),
        },
        copyRecipients: input.copyRecipients,
        envelope: completedEnvelope,
        signedPdfSha256,
        signers: input.signers,
      },
      {
        seal,
        storageService,
      },
    );

    return {
      certificate,
      generatedAt,
      recipientCertificate,
      signedPdf,
    };
  } catch (error) {
    await Promise.all([
      ...(signedPdf
        ? [storageService.deleteObject(signedPdf.key).catch(() => undefined)]
        : []),
      ...(certificate
        ? [storageService.deleteObject(certificate.key).catch(() => undefined)]
        : []),
      ...(recipientCertificate
        ? [
            storageService
              .deleteObject(recipientCertificate.key)
              .catch(() => undefined),
          ]
        : []),
    ]);
    throw error;
  }
}
