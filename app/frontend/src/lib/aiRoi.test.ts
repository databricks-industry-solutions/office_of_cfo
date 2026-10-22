import { describe, expect, it } from "vitest";
import { getOverlay, INDUSTRIES } from "./industries";
import { MODULES, MODULE_GROUPS, PAGES } from "../nav";

describe("AI ROI navigation and copy", () => {
  it("does not mark the AI ROI module tab as Beta", () => {
    expect(MODULES.find((m) => m.id === "ai-roi")?.badge).toBeUndefined();
    expect(MODULES.every((m) => !m.badge)).toBe(true);
  });

  it("places the five reference pages directly at level two", () => {
    const groups = MODULE_GROUPS["ai-roi"];
    expect(groups.map((g) => g.label)).toEqual([
      "Executive", "Spend", "ROI", "Org Explorer", "Efficiency",
    ]);
    expect(groups.every((group) => group.pages.length === 1)).toBe(true);
    const labels = new Map(PAGES.map((p) => [p.id, p.label]));
    expect(labels.get("ai-roi-spend")).toBe("Spend");
    expect(labels.get("ai-roi-roi")).toBe("ROI");
    expect(labels.has("ai-roi-revenue")).toBe(false);
    expect(labels.has("ai-roi-profitability")).toBe(false);
  });

  it("registers the complete five-page journey", () => {
    const ids = MODULE_GROUPS["ai-roi"].flatMap((group) => group.pages);
    expect(ids).toEqual([
      "ai-roi-executive", "ai-roi-spend", "ai-roi-roi", "ai-roi-org",
      "ai-roi-efficiency",
    ]);
    expect(ids.every((id) => PAGES.some((page) => page.id === id))).toBe(true);
  });

  it("defines revenue attribution dimensions for every industry", () => {
    for (const industry of INDUSTRIES) {
      const { revenueDimensions } = getOverlay(industry).aiRoi;
      expect(revenueDimensions.length).toBeGreaterThanOrEqual(3);
      expect(revenueDimensions.every((d) => d.id && d.label && d.noun)).toBe(true);
    }
  });
});
