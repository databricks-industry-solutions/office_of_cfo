import { describe, expect, it } from "vitest";
import { projectRunway, bandPath, catmullRomPath, linePath } from "./runwayProjection";

const baseInput = {
  startCash: 10_000_000,
  monthlyBase: 200_000,
  wcRelease: 3_000_000,
  plDelta: 100_000,
};

describe("projectRunway", () => {
  it("returns 13 points (month 0..12) for every series", () => {
    const p = projectRunway(baseInput as any);
    expect(p.months).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(p.baseline).toHaveLength(13);
    expect(p.wcOnly).toHaveLength(13);
    expect(p.plOnly).toHaveLength(13);
    expect(p.combined).toHaveLength(13);
  });

  it("keeps all series identical when levers are zero", () => {
    const p = projectRunway({ ...baseInput, wcRelease: 0, plDelta: 0 } as any);
    expect(p.baseline).toEqual(p.wcOnly);
    expect(p.baseline).toEqual(p.plOnly);
    expect(p.baseline).toEqual(p.combined);
    expect(p.insights.endUplift).toBe(0);
    expect(p.insights.dominantDriver).toBe("none");
  });

  it("phases WC release over the first 3 months", () => {
    const p = projectRunway({ ...baseInput, plDelta: 0 } as any);
    expect(p.wcOnly[0]).toBe(p.baseline[0]);
    expect(p.wcOnly[1] - p.baseline[1]).toBeCloseTo(1_000_000, 5);
    expect(p.wcOnly[2] - p.baseline[2]).toBeCloseTo(2_000_000, 5);
    expect(p.wcOnly[3] - p.baseline[3]).toBeCloseTo(3_000_000, 5);
    expect(p.wcOnly[12] - p.baseline[12]).toBeCloseTo(3_000_000, 5);
  });

  it("ramps P&L rate over the first 3 months and compounds thereafter", () => {
    const p = projectRunway({ ...baseInput, wcRelease: 0 } as any);
    // plCum(1)=100k/3, plCum(2)=100k/3+200k/3, plCum(3)=100k, then +100k/mo
    expect(p.plOnly[1] - p.baseline[1]).toBeCloseTo(100_000 / 3, 5);
    expect(p.plOnly[2] - p.baseline[2]).toBeCloseTo(100_000 / 3 + 200_000 / 3, 5);
    expect(p.plOnly[3] - p.baseline[3]).toBeCloseTo(2 * 100_000, 5);
    // After full ramp: plCum(12) = plCum(3) + 9 * 100_000
    const pl12 = p.plOnly[12] - p.baseline[12];
    const pl3 = p.plOnly[3] - p.baseline[3];
    expect(pl12).toBeCloseTo(pl3 + 900_000, 5);
  });

  it("reconciles combined as base + WC cum + P&L cum", () => {
    const p = projectRunway(baseInput as any);
    for (let m = 0; m <= 12; m++) {
      const expected =
        p.baseline[m] + (p.wcOnly[m] - p.baseline[m]) + (p.plOnly[m] - p.baseline[m]);
      expect(p.combined[m]).toBeCloseTo(expected, 5);
    }
  });

  it("reports min cash and breach month when cash goes negative", () => {
    const p = projectRunway({
      startCash: 100_000,
      monthlyBase: -50_000,
      wcRelease: 0,
      plDelta: -40_000,
    } as any);
    expect(p.insights.minCash).toBeLessThan(0);
    expect(p.insights.breachMonth).not.toBeNull();
    expect(p.insights.breachMonth!).toBeGreaterThan(0);
  });

  it("picks dominant driver by absolute 12m uplift share", () => {
    const p = projectRunway(baseInput as any);
    expect(p.insights.dominantDriver).toBe("wc");
    expect(p.insights.dominantSharePct).toBeGreaterThan(50);
    expect(p.insights.endUplift).toBeCloseTo(p.combined[12] - p.baseline[12], 5);
  });
});

describe("path helpers", () => {
  it("builds an M/L polyline", () => {
    expect(linePath([0, 10], [5, 15])).toBe("M0.0,5.0 L10.0,15.0");
  });

  it("builds a Catmull-Rom path that starts at the first point", () => {
    const d = catmullRomPath([0, 10, 20], [0, 10, 5]);
    expect(d.startsWith("M0.0,0.0")).toBe(true);
    expect(d).toContain("C");
  });

  it("closes a band between two series", () => {
    const d = bandPath([0, 10], [2, 4], [0, 1]);
    expect(d.endsWith("Z")).toBe(true);
    expect(d.startsWith("M")).toBe(true);
  });
});
