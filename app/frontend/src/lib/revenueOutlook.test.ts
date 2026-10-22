import { describe, expect, it } from "vitest";
import { projectRevenueOutlook, RevenueOutlook } from "./revenueOutlook";

const fy26Actuals = [
  { period: "2026-01", revenue: 8_000_000 },
  { period: "2026-02", revenue: 8_500_000 },
  { period: "2026-03", revenue: 9_000_000 },
  { period: "2026-04", revenue: 9_200_000 },
  { period: "2026-05", revenue: 9_500_000 },
  { period: "2026-06", revenue: 10_000_000 },
];

function must(o: RevenueOutlook | null): RevenueOutlook {
  expect(o).not.toBeNull();
  return o as RevenueOutlook;
}

describe("projectRevenueOutlook", () => {
  it("builds a 12-month FY series with hinge at the last actual month", () => {
    const o = must(projectRevenueOutlook({
      months: fy26Actuals,
      revShockPct: 0,
      closePeriod: "2026-06",
    }));
    expect(o.periods).toEqual([
      "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06",
      "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12",
    ]);
    expect(o.hingeIndex).toBe(5);
    const c = o.cumulative;
    expect(c.actuals.filter((v) => v != null)).toHaveLength(6);
    expect(c.actuals[5]).toBe(c.baseline[5]);
    expect(c.actuals[5]).toBe(c.stressed[5]);
    expect(c.actuals[6]).toBeNull();
    expect(o.monthly.actuals[5]).toBe(o.monthly.baseline[5]);
    expect(o.monthly.actuals[6]).toBeNull();
  });

  it("cumulates actuals through the hinge", () => {
    const o = must(projectRevenueOutlook({
      months: fy26Actuals,
      revShockPct: 0,
      closePeriod: "2026-06",
    }));
    expect(o.cumulative.actuals[0]).toBe(8_000_000);
    expect(o.cumulative.actuals[1]).toBe(8_000_000 + 8_500_000);
    expect(o.cumulative.actuals[5]).toBe(
      8_000_000 + 8_500_000 + 9_000_000 + 9_200_000 + 9_500_000 + 10_000_000
    );
  });

  it("keeps monthly actuals as posted (not cumulated)", () => {
    const o = must(projectRevenueOutlook({
      months: fy26Actuals,
      revShockPct: 0,
      closePeriod: "2026-06",
    }));
    expect(o.monthly.actuals.slice(0, 6)).toEqual([
      8_000_000, 8_500_000, 9_000_000, 9_200_000, 9_500_000, 10_000_000,
    ]);
  });

  it("continues baseline from last monthly run-rate with no shock", () => {
    const o = must(projectRevenueOutlook({
      months: fy26Actuals,
      revShockPct: 0,
      closePeriod: "2026-06",
    }));
    const hingeCum = o.cumulative.actuals[5]!;
    const runRate = 10_000_000;
    expect(o.runRate).toBe(runRate);
    expect(o.cumulative.baseline[6]).toBe(hingeCum + runRate);
    expect(o.cumulative.baseline[11]).toBe(hingeCum + runRate * 6);
    expect(o.cumulative.stressed).toEqual(o.cumulative.baseline);
    expect(o.cumulative.endBaseline).toBe(o.cumulative.baseline[11]);
    expect(o.cumulative.endStressed).toBe(o.cumulative.stressed[11]);
  });

  it("holds the monthly baseline flat at the run-rate", () => {
    const o = must(projectRevenueOutlook({
      months: fy26Actuals,
      revShockPct: 0,
      closePeriod: "2026-06",
    }));
    expect(o.monthly.baseline.slice(6)).toEqual(Array(6).fill(10_000_000));
    expect(o.monthly.endBaseline).toBe(10_000_000);
  });

  it("moves the monthly stressed path by the shock", () => {
    const o = must(projectRevenueOutlook({
      months: fy26Actuals,
      revShockPct: 25,
      closePeriod: "2026-06",
    }));
    expect(o.monthly.stressed[6]).toBe(10_000_000 * 1.25);
    expect(o.monthly.endStressed).toBe(10_000_000 * 1.25);
    expect(o.monthly.stressed[5]).toBe(o.monthly.actuals[5]);
  });

  it("diverges stressed from baseline when revShockPct is non-zero", () => {
    const o = must(projectRevenueOutlook({
      months: fy26Actuals,
      revShockPct: 10,
      closePeriod: "2026-06",
    }));
    const c = o.cumulative;
    const hingeCum = c.actuals[5]!;
    const stressedRate = 10_000_000 * 1.1;
    expect(c.baseline[5]).toBe(hingeCum);
    expect(c.stressed[5]).toBe(hingeCum);
    expect(c.baseline[6]).toBe(hingeCum + 10_000_000);
    expect(c.stressed[6]).toBe(hingeCum + stressedRate);
    expect(c.endStressed).toBe(hingeCum + stressedRate * 6);
    expect(c.endBaseline).toBe(hingeCum + 10_000_000 * 6);
    expect(c.endStressed).toBeGreaterThan(c.endBaseline);
  });

  it("applies a negative revenue shock below baseline", () => {
    const o = must(projectRevenueOutlook({
      months: fy26Actuals,
      revShockPct: -15,
      closePeriod: "2026-06",
    }));
    expect(o.cumulative.endStressed).toBeLessThan(o.cumulative.endBaseline);
    expect(o.cumulative.stressed[5]).toBe(o.cumulative.actuals[5]);
    expect(o.monthly.endStressed).toBeLessThan(o.monthly.endBaseline);
  });

  it("ignores months outside the close FY and after the close period", () => {
    const o = must(projectRevenueOutlook({
      months: [
        { period: "2025-12", revenue: 1 },
        ...fy26Actuals,
        { period: "2026-07", revenue: 99_000_000 }, // not yet closed — ignore as actual
        { period: "2027-01", revenue: 1 },
      ],
      revShockPct: 0,
      closePeriod: "2026-06",
    }));
    expect(o.hingeIndex).toBe(5);
    expect(o.cumulative.actuals[5]).toBe(
      8_000_000 + 8_500_000 + 9_000_000 + 9_200_000 + 9_500_000 + 10_000_000
    );
    expect(o.runRate).toBe(10_000_000);
  });

  it("stays defined at a December close with no forecast months", () => {
    const dec = Array.from({ length: 12 }, (_, i) => ({
      period: `2026-${String(i + 1).padStart(2, "0")}`,
      revenue: 1_000_000,
    }));
    const o = must(projectRevenueOutlook({
      months: dec,
      revShockPct: 20,
      closePeriod: "2026-12",
    }));
    expect(o.hingeIndex).toBe(11);
    expect(o.monthly.endBaseline).toBe(1_000_000);
    expect(o.monthly.endStressed).toBe(1_000_000);
    expect(o.cumulative.endBaseline).toBe(12_000_000);
  });

  it("returns null when there are no actuals for the FY", () => {
    expect(
      projectRevenueOutlook({
        months: [{ period: "2025-01", revenue: 1 }],
        revShockPct: 0,
        closePeriod: "2026-06",
      })
    ).toBeNull();
  });
});
