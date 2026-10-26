import { describe, expect, it } from "vitest";
import { projectCashOutlook } from "./cashOutlook";
import { RUNWAY_MONTHS } from "./runwayProjection";

const trend = [
  { period: "2026-01", ending_cash: 40_000_000 },
  { period: "2026-02", ending_cash: 41_000_000 },
  { period: "2026-03", ending_cash: 42_500_000 },
  { period: "2026-04", ending_cash: 43_000_000 },
  { period: "2026-05", ending_cash: 44_000_000 },
  { period: "2026-06", ending_cash: 45_000_000 },
  { period: "2026-07", ending_cash: 99_000_000 }, // after close — must be ignored
];

const flat = { startCash: 45_000_000, monthlyBase: 1_000_000, wcRelease: 0, plDelta: 0 };

describe("projectCashOutlook", () => {
  it("plots trailing actuals then a 12-month forecast", () => {
    const o = projectCashOutlook({ months: trend, closePeriod: "2026-06", ...flat });
    expect(o.periods.slice(0, 7)).toEqual([
      "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07",
    ]);
    expect(o.periods).toHaveLength(6 + RUNWAY_MONTHS);
    expect(o.periods[o.periods.length - 1]).toBe("2027-06");
    expect(o.hingeIndex).toBe(5);
  });

  it("caps the actuals window to actualMonths", () => {
    const o = projectCashOutlook({ months: trend, closePeriod: "2026-06", actualMonths: 3, ...flat });
    expect(o.periods.slice(0, 3)).toEqual(["2026-04", "2026-05", "2026-06"]);
    expect(o.hingeIndex).toBe(2);
  });

  it("joins every forecast path to the last actual at the hinge", () => {
    const o = projectCashOutlook({
      months: trend, closePeriod: "2026-06",
      startCash: 45_000_000, monthlyBase: 1_000_000, wcRelease: 5_000_000, plDelta: 250_000,
    });
    const hinge = o.hingeIndex;
    expect(o.actuals[hinge]).toBe(45_000_000);
    expect(o.baseline[hinge]).toBe(45_000_000);
    expect(o.combined[hinge]).toBe(45_000_000);
    expect(o.wcOnly[hinge]).toBe(45_000_000);
    expect(o.plOnly[hinge]).toBe(45_000_000);
    expect(o.baseline[hinge - 1]).toBeNull();
    expect(o.actuals[hinge + 1]).toBeNull();
  });

  it("ignores periods after the close period", () => {
    const o = projectCashOutlook({ months: trend, closePeriod: "2026-06", ...flat });
    expect(o.actuals.filter((v) => v != null)).toEqual([
      40_000_000, 41_000_000, 42_500_000, 43_000_000, 44_000_000, 45_000_000,
    ]);
  });

  it("separates combined from baseline when levers move", () => {
    const base = projectCashOutlook({ months: trend, closePeriod: "2026-06", ...flat });
    const stressed = projectCashOutlook({
      months: trend, closePeriod: "2026-06",
      startCash: 45_000_000, monthlyBase: 1_000_000, wcRelease: 8_000_000, plDelta: 500_000,
    });
    expect(base.endCombined).toBe(base.endBaseline);
    expect(stressed.endCombined).toBeGreaterThan(stressed.endBaseline);
    expect(stressed.endBaseline).toBe(base.endBaseline);
    expect(stressed.insights.endUplift).toBeGreaterThan(0);
  });

  it("falls back to a single Now point when no history is available", () => {
    const o = projectCashOutlook({ months: [], closePeriod: "2026-06", ...flat });
    expect(o.hingeIndex).toBe(0);
    expect(o.actuals[0]).toBe(45_000_000);
    expect(o.baseline[0]).toBe(45_000_000);
    expect(o.periods).toHaveLength(1 + RUNWAY_MONTHS);
  });
});
