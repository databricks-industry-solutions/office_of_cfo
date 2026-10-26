import { describe, expect, it } from "vitest";
import {
  axisDomain,
  captionSide,
  clampToDomain,
  coreWindow,
  spreadLabels,
} from "./scatterScale";

// The peer set that motivated this module: Joby Aviation alongside four normal
// filers, from the consumer industry's staged benchmark run.
const JOBY_MARGINS = [-1346.9, 30.6, 36.6, 45.6, 60];
const JOBY_GROWTHS = [39183.1, 15.7, 8.6, 10.8, 12];

const inside = (v: number, d: { lo: number; hi: number }) => v > d.lo && v < d.hi;

describe("coreWindow", () => {
  it("cuts the pre-revenue filer out of the margin window", () => {
    expect(coreWindow(JOBY_MARGINS)).toEqual({ lo: 30.6, hi: 60 });
  });

  it("keeps an unusual-but-real value in scale", () => {
    // Retail margins: "Us" at 60 is far above the peers but not garbage.
    expect(coreWindow([2.7, 3.8, 5, 60])).toEqual({ lo: 2.7, hi: 60 });
  });

  it("returns the full range when there is nothing to judge", () => {
    expect(coreWindow([4])).toEqual({ lo: 4, hi: 4 });
    expect(coreWindow([4, 900])).toEqual({ lo: 4, hi: 900 });
    expect(coreWindow([5, 5, 5, 5])).toEqual({ lo: 5, hi: 5 });
  });

  it("falls back to the full range rather than pin more than a third", () => {
    // k = 0 collapses the fence onto the quartiles, which would exclude 4 of 9.
    expect(coreWindow([1, 2, 3, 4, 5, 6, 7, 8, 9], 0)).toEqual({ lo: 1, hi: 9 });
  });
});

describe("axisDomain", () => {
  it("gives the cluster most of the axis when one peer is off scale", () => {
    const d = axisDomain(JOBY_MARGINS);
    const share = (60 - 30.6) / (d.hi - d.lo);
    expect(share).toBeGreaterThan(0.7);
    expect(clampToDomain(-1346.9, d).off).toBe(-1);
    for (const v of [30.6, 36.6, 45.6, 60]) expect(inside(v, d)).toBe(true);
  });

  it("keeps the best point in view when every value is negative", () => {
    // The old `max * 1.08` padding inverted here and clipped the top grower.
    const d = axisDomain([-3.8, -0.9, -0.7]);
    expect(d.hi).toBeGreaterThan(-0.7);
    expect(d.lo).toBeLessThan(-3.8);
    for (const v of [-3.8, -0.9, -0.7]) expect(inside(v, d)).toBe(true);
  });

  it("does not pin a high but plausible value", () => {
    expect(clampToDomain(60, axisDomain([2.7, 3.8, 5, 60])).off).toBe(0);
  });

  it("contains forced reference values", () => {
    const d = axisDomain([12, 14, 16, 18], { include: [40] });
    expect(inside(40, d)).toBe(true);
  });

  it("stays finite and non-degenerate on thin input", () => {
    for (const vals of [[] as number[], [7], [5, 5, 5], [0, 0]]) {
      const d = axisDomain(vals);
      expect(Number.isFinite(d.lo) && Number.isFinite(d.hi)).toBe(true);
      expect(d.hi).toBeGreaterThan(d.lo);
    }
  });

  it("ignores non-finite values", () => {
    const d = axisDomain([10, 20, NaN, Infinity, 30]);
    expect(Number.isFinite(d.lo) && Number.isFinite(d.hi)).toBe(true);
    expect(inside(30, d)).toBe(true);
  });

  it("maps every in-scale growth value strictly inside the plot band", () => {
    const d = axisDomain(JOBY_GROWTHS);
    for (const v of [15.7, 8.6, 10.8, 12]) expect(inside(v, d)).toBe(true);
    expect(clampToDomain(39183.1, d).off).toBe(1);
  });
});

describe("clampToDomain", () => {
  const d = { lo: 0, hi: 10 };

  it("passes in-scale values through", () => {
    expect(clampToDomain(4, d)).toEqual({ v: 4, off: 0 });
  });

  it("pins to the overflowed edge", () => {
    expect(clampToDomain(-3, d)).toEqual({ v: 0, off: -1 });
    expect(clampToDomain(99, d)).toEqual({ v: 10, off: 1 });
  });
});

describe("spreadLabels", () => {
  const bounds = { top: 0, bottom: 200 };

  it("pushes coincident labels apart", () => {
    const ys = spreadLabels(
      [{ y: 100, side: "start" }, { y: 100, side: "start" }, { y: 103, side: "start" }],
      10,
      bounds,
    );
    expect(ys).toEqual([100, 110, 120]);
  });

  it("leaves the input order intact", () => {
    const ys = spreadLabels([{ y: 150, side: "start" }, { y: 20, side: "start" }], 10, bounds);
    expect(ys).toEqual([150, 20]);
  });

  it("does not push labels on opposite sides", () => {
    const ys = spreadLabels([{ y: 50, side: "start" }, { y: 50, side: "end" }], 10, bounds);
    expect(ys).toEqual([50, 50]);
  });

  it("shifts a crowded group back inside the bounds", () => {
    const ys = spreadLabels(
      [{ y: 195, side: "end" }, { y: 196, side: "end" }, { y: 197, side: "end" }],
      10,
      bounds,
    );
    expect(Math.max(...ys)).toBeLessThanOrEqual(200);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(ys[1] - ys[0]).toBe(10);
    expect(ys[2] - ys[1]).toBe(10);
  });
});

describe("captionSide", () => {
  it("picks the side with more clearance", () => {
    const labels = [{ y: 100, side: "end" as const }, { y: 40, side: "start" as const }];
    expect(captionSide(98, labels, 9)).toBe("start");
    expect(captionSide(42, labels, 9)).toBe("end");
  });

  it("prefers the empty side", () => {
    expect(captionSide(100, [{ y: 100, side: "start" }], 9)).toBe("end");
  });

  it("drops the caption when both sides are crowded", () => {
    const labels = [{ y: 100, side: "end" as const }, { y: 102, side: "start" as const }];
    expect(captionSide(100, labels, 9)).toBeNull();
  });
});
