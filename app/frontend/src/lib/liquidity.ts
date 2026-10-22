import type { StatementSet } from "../api";

/** Forward-looking liquidity read of a projection against a minimum-cash level. */
export interface LiquidityOutlook {
  low: number;                     // lowest forecast-month cash balance
  lowIndex: number;                // its period index
  headroom: number;                // low − minimum (negative = shortfall)
  firstBreachIndex: number | null; // first forecast month below the minimum
}

/** Default minimum-cash policy: one month of cash operating costs (COGS + opex),
 *  averaged over the actual months, rounded to $0.1M. */
export function defaultMinCash(ss: StatementSet): number {
  const n = ss.hinge_index + 1;
  if (n <= 0) return 0;
  let total = 0;
  for (let i = 0; i < n; i++) total += (ss.lines.cogs?.[i] ?? 0) + (ss.lines.opex?.[i] ?? 0);
  return Math.round(total / n / 1e5) * 1e5;
}

/** Lowest forecast cash, headroom to `minCash`, and the first breach month.
 *  Null when the fiscal year has no forecast months left. */
export function liquidityOutlook(ss: StatementSet, minCash: number): LiquidityOutlook | null {
  const cash = ss.lines.cash_balance ?? [];
  let lowIndex = -1;
  let firstBreachIndex: number | null = null;
  for (let i = ss.hinge_index + 1; i < cash.length; i++) {
    if (lowIndex < 0 || cash[i] < cash[lowIndex]) lowIndex = i;
    if (firstBreachIndex === null && cash[i] < minCash) firstBreachIndex = i;
  }
  if (lowIndex < 0) return null;
  return { low: cash[lowIndex], lowIndex, headroom: cash[lowIndex] - minCash, firstBreachIndex };
}
