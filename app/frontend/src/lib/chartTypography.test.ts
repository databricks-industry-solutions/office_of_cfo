import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

const CHART_FILES = [
  "components/ExecutiveCharts.tsx",
  "pages/CashFlow.tsx",
  "pages/ScenarioPlanning.tsx",
  "pages/HistoricalInsights.tsx",
  "pages/MarketInsights.tsx",
  "pages/StressTest.tsx",
  "components/benchmarkCharts.tsx",
  "components/VarianceDashboard.tsx",
  "components/CogsBridgeView.tsx",
  "components/aiRoi/revenue/ValueBridge.tsx",
  "components/CloseBurndown.tsx",
  "components/aiRoi/charts.tsx",
] as const;

describe("custom SVG chart typography", () => {
  it.each(CHART_FILES)("%s opts SVG charts into the app sans stack", (path) => {
    expect(read(path)).toMatch(/<svg[^>]*className=["{`][^>]*font-sans/s);
  });

  it("uses pixel-mapped axis typography on the reported Historical Insights chart", () => {
    const src = read("pages/HistoricalInsights.tsx");
    expect(src).toContain("CHART_AXIS_TEXT_PIXEL");
    expect(src).toContain("{...CHART_AXIS_TEXT_PIXEL}");
    expect(src).toContain("useChartSize");
  });

  it("uses dense axis type on measured trajectories and pixel-mapped type on the bridge", () => {
    const src = read("pages/ScenarioPlanning.tsx");
    expect(src).toContain("CHART_AXIS_TEXT_DENSE");
    expect(src.match(/\{\.\.\.CHART_AXIS_TEXT_DENSE\}/g)?.length).toBeGreaterThanOrEqual(2);
    expect(src).toContain("CHART_AXIS_TEXT_PIXEL");
    expect(src.match(/\{\.\.\.CHART_AXIS_TEXT_PIXEL\}/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("removes the oversized AI ROI trend-axis outlier", () => {
    const src = read("components/aiRoi/charts.tsx");
    expect(src).not.toContain('fontSize: 14, fontWeight: 500');
  });
});
