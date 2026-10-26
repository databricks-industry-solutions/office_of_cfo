/** Shared money / period labeling for the FP&A Overview page. */

export const PERIOD_MONEY_NOTE = "Current close period · USD";

/** Compact USD display for period-scoped charts ($8.4M, $355K). */
export function fmtPeriodMoney(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

export function fmtPct0(v: number): string {
  return `${Math.round(v)}%`;
}

export function fmtPct1(v: number): string {
  return `${v.toFixed(1)}%`;
}

/** Month label from API period string (YYYY-MM). */
export function fmtPeriodMonth(period: string): string {
  const y = parseInt(period.slice(0, 4), 10);
  const m = parseInt(period.slice(5, 7), 10);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return period;
  return new Date(y, m - 1, 1).toLocaleString("en-US", { month: "short", year: "2-digit" });
}
