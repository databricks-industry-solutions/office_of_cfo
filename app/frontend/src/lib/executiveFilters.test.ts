import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getOverlay } from "./industries";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

describe("FP&A panel filters stay on the graphs they affect", () => {
  it("keeps independent filter state for profitability and working capital", () => {
    const page = read("pages", "Executive.tsx");
    expect(page).toContain("profitFilter");
    expect(page).toContain("wcFilter");
    expect(page).toContain('ariaLabel="Filter profitability"');
    expect(page).toContain('ariaLabel="Filter working capital"');
    expect(page).toContain("Applies only to this panel.");
    expect(page).not.toContain("leadingAction");
    expect(page).not.toContain("stay at org scope");
    expect(page).not.toContain("Segment filters apply to working capital and profitability only.");
  });

  it("does not put the page filter on headline, budget, cash, or leverage", () => {
    const page = read("pages", "Executive.tsx");
    expect(page).toContain("<HeadlineKpiStrip tiles={headlineTiles} segments={headlineSegs} />");
    expect(page).toContain("<BudgetVariance variance={variance} />");
    expect(page).toContain("<CashFlowWaterfall cf={cashFlow} />");
    expect(page).toContain("forecast={leverageForecast}");
    expect(page).toContain("action={profitFilters}");
    expect(page).toContain("action={wcFilters}");
  });

  it("keeps energy headline tiles to one row via overlay hide-list", () => {
    const energy = getOverlay("energy");
    expect(energy.hiddenKpis).toEqual([
      "adjusted_operating_cash_flow",
      "net_generation_output",
    ]);
    const page = read("pages", "Executive.tsx");
    expect(page).toContain("headline.filter((t) => !ov.hiddenKpis.includes(t.kpi_id))");
  });

  it("lets the profitability card render a header action", () => {
    const chart = read("components", "ExecutiveCharts.tsx");
    expect(chart).toContain("export function ProfitabilityBridge({");
    expect(chart).toContain("action?: ReactNode");
    expect(chart).toContain("<Card title=\"Profitability\" subtitle={subtitle} action={action}>");
  });
});
