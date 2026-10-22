// The profitability ranking render and helpers, and the shared shell's "About
// this data" control. Ranking copy must stay true for every industry's noun and
// must only judge the GROSS profitability index against 1.0.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AiRoiProfitabilityRow } from "../../api";
import { getOverlay, INDUSTRIES } from "../../lib/industries";
import { rankLowestFirst, unitNoun } from "./ranking";
import { AI_ROI_LIMITATIONS } from "./provenance/limitations";
import { ProfitabilityBars } from "./revenue/ProfitabilityRanking";
import { AiRoiPage } from "./shared";

function row(key: string, pi_all: number | null, pi_proven: number | null): AiRoiProfitabilityRow {
  return {
    key, label: `Unit ${key}`, run_cost: 10, amortised_build: 2, allocated_build: 3,
    fully_loaded_cost: 15, realised_value_all: 15 * (pi_all ?? 0),
    realised_value_proven: 15 * (pi_proven ?? 0), pi_all, pi_proven,
    revenue_per_mtok: null, loaded_cost_per_mtok: null, total_tokens: 1,
  };
}

const five = [row("A", 0.79, 0.6), row("B", 0.95, 0.7), row("C", 1.3, 0.9), row("D", 2.1, 1.5), row("E", 1.6, 1.2)];

describe("profitability ranking helpers", () => {
  it("reads the business-unit noun from every industry overlay", () => {
    for (const industry of INDUSTRIES) {
      const dims = getOverlay(industry).aiRoi.revenueDimensions;
      expect(unitNoun(dims)).toBe(dims.find((d) => d.id === "business_unit")!.noun);
    }
  });

  it("ranks lowest index first with unrated units last", () => {
    expect(rankLowestFirst([row("C", 1.3, 1), row("Z", null, null), row("A", 0.79, 0.6)]).map((r) => r.key))
      .toEqual(["A", "C", "Z"]);
  });
});

describe("profitability ranking render", () => {
  const html = renderToStaticMarkup(<ProfitabilityBars data={{ rows: five, break_even_at: 1 }} noun="BUs" />);

  it("ranks lowest first and marks below-1.0 units in text", () => {
    const order = ["Unit A", "Unit B", "Unit C", "Unit E", "Unit D"].map((label) => html.indexOf(`>${label}<`));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html.match(/>below 1\.0</g)).toHaveLength(2);
    expect(html).toContain("proven 0.60×");
  });

  it("draws an explicit dashed 1.0 break-even line and never mentions the NET ratio", () => {
    expect(html).toContain("1.0 break-even");
    expect(html).toContain("border-dashed");
    expect(html).not.toContain("return less than they cost");
    expect(html).not.toContain("Return on Token Used");
    expect(html).not.toMatch(/gradient/i);
  });
});

describe("AI ROI page shell", () => {
  it("always offers the data disclosure, closed, below the page content", () => {
    const html = renderToStaticMarkup(<AiRoiPage><p>body</p></AiRoiPage>);
    expect(html).toContain("About this data");
    expect(html).toMatch(/<details data-testid="ai-roi-about-toggle">/);
    expect(html.indexOf("<p>body</p>")).toBeLessThan(html.indexOf("ai-roi-about-toggle"));
    expect(html).not.toContain("ai-roi-headline");
    expect(html).not.toContain("<h1");
  });

  it("discloses synthetic data from the shared list, with industry-agnostic copy", () => {
    expect(AI_ROI_LIMITATIONS.some((item) => item.title === "All scenario data is synthetic")).toBe(true);
    for (const item of AI_ROI_LIMITATIONS) {
      expect(`${item.title} ${item.body}`).not.toMatch(/\bdesks?\b|\bBUs?\b/);
    }
  });
});
