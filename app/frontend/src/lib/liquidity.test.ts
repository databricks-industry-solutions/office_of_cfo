import { describe, expect, it } from "vitest";
import type { StatementSet } from "../api";
import { defaultMinCash, liquidityOutlook } from "./liquidity";

const ss = (cash: number[], hinge: number): StatementSet => ({
  periods: cash.map((_, i) => `2026-${String(i + 1).padStart(2, "0")}`),
  hinge_index: hinge,
  lines: { cash_balance: cash, cogs: cash.map(() => 1_000_000), opex: cash.map(() => 2_840_000) },
  kpis: {},
});

describe("defaultMinCash", () => {
  it("is one month of COGS + opex over the actuals, rounded to $0.1M", () => {
    expect(defaultMinCash(ss([10e6, 11e6, 12e6], 1))).toBe(3_800_000);
  });
});

describe("liquidityOutlook", () => {
  it("reads only forecast months and reports headroom", () => {
    const o = liquidityOutlook(ss([1e6, 9e6, 8e6, 7e6, 9e6], 1), 5e6)!;
    expect(o.low).toBe(7e6);
    expect(o.lowIndex).toBe(3);
    expect(o.headroom).toBe(2e6);
    expect(o.firstBreachIndex).toBeNull(); // the $1M actual month is history, not a breach
  });

  it("flags the first forecast month below the minimum", () => {
    const o = liquidityOutlook(ss([9e6, 6e6, 4e6, 3e6, 6e6], 1), 5e6)!;
    expect(o.firstBreachIndex).toBe(2);
    expect(o.headroom).toBe(-2e6);
  });

  it("is null when the year has no forecast months", () => {
    expect(liquidityOutlook(ss([9e6, 8e6], 1), 5e6)).toBeNull();
  });
});
