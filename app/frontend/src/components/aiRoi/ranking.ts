// Profitability-ranking helpers for the AI ROI pages. The business-unit noun
// comes from the overlay via `unitNoun`, so copy stays industry-agnostic.
//
// The profitability index is GROSS (realised value / fully loaded cost) and
// breaks even at 1.0. Return on Token Used is NET ((value - run cost) / run cost)
// and breaks even at 0. Only the profitability index is ranked here.

import type { AiRoiProfitabilityRow } from "../../api";
import type { AiRoiRevenueDimension } from "../../lib/industries";

/** Plural noun for business units from the overlay (e.g. "BUs", "desks"). */
export function unitNoun(dims: readonly AiRoiRevenueDimension[]): string {
  return dims.find((d) => d.id === "business_unit")?.noun ?? "units";
}

/** Lowest profitability index first; units with no index (no loaded cost) last. */
export function rankLowestFirst(rows: readonly AiRoiProfitabilityRow[]): AiRoiProfitabilityRow[] {
  return [...rows].sort((a, b) => {
    if (a.pi_all == null) return b.pi_all == null ? 0 : 1;
    if (b.pi_all == null) return -1;
    return a.pi_all - b.pi_all;
  });
}
