import { describe, expect, it } from "vitest";
import {
  activeSegmentCount,
  allSegments,
  applySegmentFilter,
  segmentFilterActive,
  segmentFilterSummary,
} from "./segmentFilter";

const rows = [
  { region: "EMEA", business_line: "Ice Cream", legal_entity_id: "LE-1", revenue: 10 },
  { region: "AMER", business_line: "Ice Cream", legal_entity_id: "LE-2", revenue: 20 },
  { region: "EMEA", business_line: "Beauty", legal_entity_id: "LE-1", revenue: 30 },
];

describe("segmentFilter", () => {
  it("leaves rows unchanged when every dimension is All", () => {
    expect(applySegmentFilter(rows, allSegments())).toEqual(rows);
    expect(segmentFilterActive(allSegments())).toBe(false);
  });

  it("slices the same rows independently for two selections", () => {
    const profitability = applySegmentFilter(rows, {
      ...allSegments(),
      region: new Set(["EMEA"]),
    });
    const workingCapital = applySegmentFilter(rows, {
      ...allSegments(),
      businessLine: new Set(["Ice Cream"]),
    });
    expect(profitability.map((r) => r.revenue)).toEqual([10, 30]);
    expect(workingCapital.map((r) => r.revenue)).toEqual([10, 20]);
    expect(profitability).not.toEqual(workingCapital);
  });

  it("intersects dimensions within one panel only", () => {
    const both = applySegmentFilter(rows, {
      region: new Set(["EMEA"]),
      businessLine: new Set(["Ice Cream"]),
      legalEntity: null,
    });
    expect(both).toEqual([rows[0]]);
  });

  it("reports an active count and unit summary", () => {
    const sel = { region: new Set(["EMEA"]), businessLine: null, legalEntity: null };
    expect(activeSegmentCount(sel)).toBe(1);
    expect(segmentFilterSummary(2, 3, true)).toBe("2 of 3 units");
    expect(segmentFilterSummary(3, 3, false)).toBe("All units in scope");
  });
});
