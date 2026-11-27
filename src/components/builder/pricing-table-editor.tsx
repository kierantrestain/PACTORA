"use client";

import { Plus, Trash2 } from "lucide-react";

import {
  calculatePricing,
  formatMoney,
  newBuilderId,
  parseMoneyInput,
  type PricingBlock,
} from "@/lib/document-builder/model";

type PricingTableEditorProps = {
  block: PricingBlock;
  onChange: (block: PricingBlock) => void;
};

function plainAmount(cents: number): string {
  return (cents / 100).toFixed(2);
}

function clampNumber(value: string, max: number): number | null {
  if (value.trim() === "") {
    return 0;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  return Math.min(max, Math.round(parsed * 100) / 100);
}

const cellInput =
  "w-full min-w-0 rounded-lg border border-transparent bg-transparent px-2 py-1.5 text-sm text-(--fg) outline-none hover:border-(--border-strong) focus-visible:border-(--accent) focus-visible:bg-(--paper)";

export function PricingTableEditor({
  block,
  onChange,
}: PricingTableEditorProps) {
  const totals = calculatePricing(block);
  const update = (patch: Partial<PricingBlock>) =>
    onChange({ ...block, ...patch });
  const updateRow = (
    rowId: string,
    patch: Partial<PricingBlock["rows"][number]>,
  ) =>
    update({
      rows: block.rows.map((row) =>
        row.id === rowId ? { ...row, ...patch } : row,
      ),
    });

  return (
    <div className="space-y-3">
      <div className="relative overflow-x-auto rounded-xl border border-(--border)">
        <table className="w-full min-w-[36rem] border-collapse text-sm">
          <thead className="bg-(--surface) text-left text-xs font-bold text-(--secondary)">
            <tr>
              <th className="px-3 py-2" scope="col">
                Description
              </th>
              <th className="w-20 px-3 py-2 text-right" scope="col">
                Qty
              </th>
              <th className="w-28 px-3 py-2 text-right" scope="col">
                Unit price
              </th>
              <th className="w-20 px-3 py-2 text-right" scope="col">
                Discount %
              </th>
              <th className="w-28 px-3 py-2 text-right" scope="col">
                Amount
              </th>
              <th className="w-10 px-1 py-2" scope="col">
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {totals.lines.map((line, index) => (
              <tr className="border-t border-(--border)" key={line.row.id}>
                <td className="px-1 py-1">
                  <input
                    aria-label={`Description, line ${index + 1}`}
                    className={cellInput}
                    maxLength={300}
                    onChange={(event) =>
                      updateRow(line.row.id, {
                        description: event.target.value,
                      })
                    }
                    placeholder="What is being sold"
                    value={line.row.description}
                  />
                </td>
                <td className="px-1 py-1">
                  <input
                    aria-label={`Quantity, line ${index + 1}`}
                    className={`${cellInput} text-right tabular-nums`}
                    defaultValue={String(line.row.quantity)}
                    inputMode="decimal"
                    onChange={(event) => {
                      const quantity = clampNumber(
                        event.target.value,
                        1_000_000,
                      );

                      if (quantity !== null) {
                        updateRow(line.row.id, { quantity });
                      }
                    }}
                  />
                </td>
                <td className="px-1 py-1">
                  <input
                    aria-label={`Unit price, line ${index + 1}`}
                    className={`${cellInput} text-right tabular-nums`}
                    defaultValue={plainAmount(line.row.unitPriceCents)}
                    inputMode="decimal"
                    onChange={(event) => {
                      const cents = parseMoneyInput(event.target.value || "0");

                      if (cents !== null && cents <= 100_000_000_000) {
                        updateRow(line.row.id, { unitPriceCents: cents });
                      }
                    }}
                  />
                </td>
                <td className="px-1 py-1">
                  <input
                    aria-label={`Discount percent, line ${index + 1}`}
                    className={`${cellInput} text-right tabular-nums`}
                    defaultValue={String(line.row.discountPercent)}
                    inputMode="decimal"
                    onChange={(event) => {
                      const discountPercent = clampNumber(
                        event.target.value,
                        100,
                      );

                      if (discountPercent !== null) {
                        updateRow(line.row.id, { discountPercent });
                      }
                    }}
                  />
                </td>
                <td className="px-3 py-1 text-right font-semibold tabular-nums text-(--fg)">
                  {formatMoney(line.amountCents, block.currency)}
                </td>
                <td className="px-1 py-1 text-center">
                  <button
                    aria-label={`Remove line ${index + 1}`}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-(--tertiary) hover:bg-(--danger-soft) hover:text-(--danger) disabled:opacity-30"
                    disabled={block.rows.length === 1}
                    onClick={() =>
                      update({
                        rows: block.rows.filter(
                          (row) => row.id !== line.row.id,
                        ),
                      })
                    }
                    type="button"
                  >
                    <Trash2 aria-hidden="true" className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-wrap items-end gap-3">
          <button
            className="btn-quiet"
            disabled={block.rows.length >= 100}
            onClick={() =>
              update({
                rows: [
                  ...block.rows,
                  {
                    description: "",
                    discountPercent: 0,
                    id: newBuilderId("r"),
                    quantity: 1,
                    unitPriceCents: 0,
                  },
                ],
              })
            }
            type="button"
          >
            <Plus aria-hidden="true" className="h-4 w-4" />
            Add line
          </button>
          <label className="space-y-1 text-xs font-semibold text-(--secondary)">
            <span className="block">Currency</span>
            <input
              className="field-input min-h-10 w-20 uppercase"
              maxLength={3}
              onChange={(event) => {
                const currency = event.target.value.toUpperCase();

                if (/^[A-Z]{3}$/.test(currency)) {
                  update({ currency });
                }
              }}
              defaultValue={block.currency}
            />
          </label>
          <label className="space-y-1 text-xs font-semibold text-(--secondary)">
            <span className="block">Tax label</span>
            <input
              className="field-input min-h-10 w-28"
              maxLength={40}
              onChange={(event) => update({ taxLabel: event.target.value })}
              value={block.taxLabel}
            />
          </label>
          <label className="space-y-1 text-xs font-semibold text-(--secondary)">
            <span className="block">Tax %</span>
            <input
              className="field-input min-h-10 w-20 text-right"
              defaultValue={String(block.taxPercent)}
              inputMode="decimal"
              onChange={(event) => {
                const taxPercent = clampNumber(event.target.value, 100);

                if (taxPercent !== null) {
                  update({ taxPercent });
                }
              }}
            />
          </label>
        </div>

        <dl className="min-w-56 space-y-1 text-sm tabular-nums">
          <div className="flex justify-between gap-6 text-(--secondary)">
            <dt>Subtotal</dt>
            <dd>{formatMoney(totals.subtotalCents, block.currency)}</dd>
          </div>
          {totals.discountCents > 0 ? (
            <div className="flex justify-between gap-6 text-(--secondary)">
              <dt>Discount</dt>
              <dd>−{formatMoney(totals.discountCents, block.currency)}</dd>
            </div>
          ) : null}
          {block.taxPercent > 0 ? (
            <div className="flex justify-between gap-6 text-(--secondary)">
              <dt>
                {block.taxLabel || "Tax"} ({block.taxPercent}%)
              </dt>
              <dd>{formatMoney(totals.taxCents, block.currency)}</dd>
            </div>
          ) : null}
          <div className="flex justify-between gap-6 border-t border-(--border) pt-1 font-extrabold text-(--fg)">
            <dt>Total</dt>
            <dd>{formatMoney(totals.totalCents, block.currency)}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
