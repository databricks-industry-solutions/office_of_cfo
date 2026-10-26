import type { CashConfidence, TreasuryForecast, TreasuryItem, TreasuryRow } from "../api";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-01" → "1 Nov". */
export function dayMonth(iso: string): string {
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  return m >= 1 && m <= 12 && d ? `${d} ${MONTHS[m - 1]}` : iso;
}

/** "2026-11" → "Nov 2026". */
export function monthYear(period: string): string {
  const m = Number(period.slice(5, 7));
  return m >= 1 && m <= 12 ? `${MONTHS[m - 1]} ${period.slice(0, 4)}` : period;
}

/** The open invoices behind one AI cell (row × week), biggest first. */
export function cellItems(f: TreasuryForecast, row: TreasuryRow, week: number): TreasuryItem[] {
  const ledger = row.id === "receipts_open" ? "ar" : row.id === "suppliers_open" ? "ap" : null;
  if (!ledger) return [];
  return f.items
    .filter((i) => i.ledger === ledger && i.week === week)
    .sort((a, b) => b.amount - a.amount);
}

/** Minimum-cash read of the weekly closing balances. */
export interface WeeklyOutlook {
  low: number;
  lowIndex: number;
  headroom: number;                 // low − minimum (negative = shortfall)
  firstBreachIndex: number | null;  // first week closing below the minimum
}

export function weeklyOutlook(closing: number[], minCash: number): WeeklyOutlook | null {
  if (!closing.length) return null;
  let lowIndex = 0;
  let firstBreachIndex: number | null = null;
  closing.forEach((c, i) => {
    if (c < closing[lowIndex]) lowIndex = i;
    if (firstBreachIndex === null && c < minCash) firstBreachIndex = i;
  });
  return { low: closing[lowIndex], lowIndex, headroom: closing[lowIndex] - minCash, firstBreachIndex };
}

/** Share of open-invoice value (in the 13 weeks) at each confidence level. */
export function confidenceMix(items: TreasuryItem[], ledger: "ar" | "ap"): Record<CashConfidence, number> {
  const mix: Record<CashConfidence, number> = { high: 0, medium: 0, low: 0 };
  let total = 0;
  for (const i of items) {
    if (i.ledger !== ledger || i.week === null) continue;
    mix[i.confidence] += i.amount;
    total += i.amount;
  }
  if (total) (Object.keys(mix) as CashConfidence[]).forEach((k) => { mix[k] /= total; });
  return mix;
}

/** Default minimum cash rounded to $0.1M (the API's one month of COGS + opex). */
export function roundedMinCash(v: number | null | undefined): number {
  return v ? Math.round(v / 1e5) * 1e5 : 0;
}
