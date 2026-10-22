import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MODULE_GROUPS } from "../nav";
import { getOverlay, INDUSTRIES } from "./industries";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

const REFERENCE_PAGES = [
  "ai-roi-executive", "ai-roi-spend", "ai-roi-roi",
  "ai-roi-org", "ai-roi-efficiency",
] as const;

describe("AI ROI tab and reference page inventory", () => {
  it("keeps the five-page journey directly under the AI ROI module", () => {
    expect(MODULE_GROUPS["ai-roi"].flatMap((g) => g.pages)).toEqual([...REFERENCE_PAGES]);
    expect(MODULE_GROUPS["ai-roi"].every((g) => g.pages.length === 1)).toBe(true);
    expect(read("components/TopNav.tsx")).toContain("{m.badge && (");
    expect(read("App.tsx")).not.toContain("AiRoiScopeFilterBar");
    expect(read("components/TopNav.tsx")).toContain("OrgExplorerTopic");
    expect(MODULE_GROUPS["ai-roi"].map((g) => g.label)).not.toContain("The argument");
    expect(MODULE_GROUPS["ai-roi"].map((g) => g.label)).not.toContain("Drill down");
    expect(MODULE_GROUPS["ai-roi"].map((g) => g.label)).not.toContain("Provenance");
  });

  it("removes page-level AI ROI titles and uses regular typography", () => {
    const shared = read("components/aiRoi/shared.tsx");
    const css = read("index.css");
    expect(shared).not.toContain("<PageHeading");
    expect(css).toContain(".ai-roi-surface .num");
    expect(css).toContain(".ai-roi-surface .font-mono");
    expect(read("components/aiRoi/revenue/RevenueAttribution.tsx")).not.toContain("<header");
  });

  it("executive source includes league, breakeven, and what-changed surfaces", () => {
    const page = read("pages/aiRoi/Executive.tsx");
    const src = [
      page,
      read("components/aiRoi/executive/LeagueTable.tsx"),
      read("components/aiRoi/executive/BreakevenPanel.tsx"),
      read("components/aiRoi/executive/WhatChanged.tsx"),
    ].join("\n");
    for (const token of [
      "data-testid=\"ai-roi-league\"",
      "data-testid=\"ai-roi-breakeven\"",
      "Filter by region",
      "showRoiLink",
      "data-testid=\"ai-roi-what-changed\"",
      "cash_breakeven_days",
      "run_rate_rodt",
      "Return on Token Used",
    ]) {
      expect(src).toContain(token);
    }
    expect(src).not.toContain("Cost and attributed value trend");
    expect(page.indexOf("<ExecutiveKpiGrid")).toBeLessThan(page.indexOf("<ExecutiveLeagueTable"));
    expect(page.indexOf("<ExecutiveLeagueTable")).toBeLessThan(page.indexOf("<ExecutiveBreakevenPanel"));
  });

  it("executive league reproduces the reference columns and interactions", () => {
    const src = read("components/aiRoi/executive/LeagueTable.tsx");
    for (const label of [
      "Use case", "Run cost", "Realised value", "Return on Token Used", "Revenue per Mtok",
      "Break-even (days)", "Variance (days)", "Trend",
    ]) {
      expect(src).toContain(label);
    }
    expect(src).toContain("setSort");
    expect(src).toContain("onNavigate");
    expect(src).toContain("cash_breakeven_days");
    // The column is gross revenue per million tokens; the field key stays `vpmt`.
    expect(src).not.toContain('"VPMT"');
    expect(src).toContain('key: "vpmt"');
    // Return on Token Used is NET: never judged against the 1.0 index threshold.
    expect(src).not.toMatch(/run_rate_rodt\s*<\s*1\b/);
  });

  it("spend source includes the full reference widget set", () => {
    const src = [
      read("pages/aiRoi/Spend.tsx"),
      read("components/aiRoi/spend/SpendTrend.tsx"),
      read("components/aiRoi/spend/BreakdownTable.tsx"),
      read("components/aiRoi/spend/SidePanels.tsx"),
      read("components/aiRoi/spend/InvocationsTable.tsx"),
      read("components/aiRoi/spend/GatewayTelemetry.tsx"),
      read("components/aiRoi/charts.tsx"),
    ].join("\n");
    for (const token of [
      "data-testid=\"ai-roi-spend-trend\"",
      "data-testid=\"ai-roi-spend-breakdown\"",
      "data-testid=\"ai-roi-concentration\"",
      "data-testid=\"ai-roi-budget\"",
      "data-testid=\"ai-roi-anomalies\"",
      "data-testid=\"ai-roi-invocations\"",
      "data-testid=\"ai-roi-gateway\"",
      "group_by",
      "|z| &gt; 3",
      "MoM",
      "aria-expanded",
    ]) {
      expect(src).toContain(token);
    }
    expect(read("pages/aiRoi/Spend.tsx")).not.toContain("<RoiMetric");
    expect(src).toContain('aria-label="AI run cost in US dollars"');
    expect(src).toContain('fillOpacity="1"');
    expect(src).toContain("GroupedBar");
  });

  it("revenue source includes ranking, league, detail, bridge, and policy", () => {
    const src = [
      read("pages/aiRoi/Revenue.tsx"),
      read("components/aiRoi/revenue/RevenueAttribution.tsx"),
      read("components/aiRoi/revenue/ValueBridge.tsx"),
      read("components/aiRoi/revenue/AttributionPolicyCard.tsx"),
      read("components/aiRoi/executive/LeagueTable.tsx"),
      read("components/aiRoi/revenue/ProfitabilityRanking.tsx"),
    ].join("\n");
    for (const token of [
      "data-testid=\"ai-roi-attribution\"",
      "data-testid=\"ai-roi-profitability\"",
      "break_even_at",
      "pi_proven",
      "data-testid=\"ai-roi-league\"",
      "data-testid=\"ai-roi-value-bridge\"",
      "data-testid=\"ai-roi-policy\"",
      "useCase",
      "ExecutiveLeagueTable",
      "ExecutiveBreakevenPanel",
    ]) {
      expect(src).toContain(token);
    }
    const revenue = read("pages/aiRoi/Revenue.tsx");
    expect(revenue).toContain("showRoiLink={false}");
    // Attribution, then the profitability ranking, then the league table.
    expect(revenue.indexOf("<RevenueAttributionBlock")).toBeLessThan(revenue.indexOf("<ProfitabilityRanking"));
    expect(revenue.indexOf("<ProfitabilityRanking")).toBeLessThan(revenue.indexOf("<ExecutiveLeagueTable"));
    expect(read("components/aiRoi/charts.tsx")).toContain('className="block font-sans"');
  });

  it("covers every industry's overlay without hiding AI ROI pages", () => {
    for (const industry of INDUSTRIES) {
      const ov = getOverlay(industry);
      expect(ov.hiddenPages.some((p) => String(p).startsWith("ai-roi"))).toBe(false);
      // The dimension ids are the contract and must match everywhere.
      expect(ov.aiRoi.revenueDimensions.map((d) => d.id)).toEqual([
        "business_unit", "use_case", "market",
      ]);
      // Labels are relabelled per industry through the Overlay (Capital Markets
      // calls its business units desks), so only require that they exist.
      for (const d of ov.aiRoi.revenueDimensions) {
        expect(d.label.trim()).not.toBe("");
        expect(d.noun.trim()).not.toBe("");
      }
    }
    // The original four keep the shared base copy.
    for (const industry of ["consumer", "software", "fsi", "energy"] as const) {
      expect(getOverlay(industry).aiRoi.revenueDimensions[0].label).toBe("BU");
    }
  });

  it("AI ROI pages load with layout-matched skeletons, never loading text", () => {
    expect(read("components/aiRoi/shared.tsx")).not.toContain("Loading AI ROI");
    for (const [page, skeleton] of [
      ["Executive", "ExecutiveSkeleton"], ["Spend", "SpendSkeleton"], ["Org", "OrgSkeleton"],
      ["Efficiency", "EfficiencySkeleton"], ["Provenance", "ProvenanceSkeleton"], ["Revenue", "UseCaseDetailSkeleton"],
    ]) {
      expect(read(`pages/aiRoi/${page}.tsx`)).toContain(`skeleton={<${skeleton} />}`);
    }
  });

  it("org and efficiency include remaining reference beats", () => {
    const org = [
      read("pages/aiRoi/Org.tsx"),
      read("components/aiRoi/org/OrgTree.tsx"),
      read("components/aiRoi/org/NodeDetail.tsx"),
    ].join("\n");
    expect(org).toContain("Org tree — as of period end");
    expect(org).toContain('role="tree"');
    expect(org).toContain("Breakdown - ${");
    expect(org).not.toContain("Loading...");
    expect(org).toContain("SkeletonRegion");
    expect(org).toContain("loading={fetching}");
    expect(org).toContain("flattenRootUnits");
    expect(org).toContain("Trend MoM");
    expect(org).toContain("TrendLine");
    expect(org).not.toContain("GroupedBar");
    expect(org).not.toContain("Top consumers by spend");
    const efficiency = [
      read("pages/aiRoi/Efficiency.tsx"),
      read("components/aiRoi/efficiency/SubstitutionSimulator.tsx"),
      read("components/aiRoi/efficiency/EfficiencyPanels.tsx"),
    ].join("\n");
    expect(efficiency).toContain("Blended cost per Mtok");
    expect(efficiency).toContain("Table view");
    expect(efficiency).not.toContain("Accessible table view");
    expect(read("pages/aiRoi/Efficiency.tsx")).not.toContain("<details");
    expect(read("pages/aiRoi/Efficiency.tsx")).toContain("asTable={tableView}");
    expect(efficiency).toContain("USD per million tokens");
    expect(efficiency).toContain("Unit-cost trend");
    expect(efficiency).toContain("Class move");
    expect(efficiency).toContain("Model move");
    expect(efficiency).toContain("Projected blended $/Mtok");
    expect(efficiency).toContain("text-2xl");
    expect(efficiency).toContain("Waste & savings");
    expect(efficiency).toContain("data-testid=\"ai-roi-simulator\"");
    expect(efficiency).toContain('aria-label="Percentage of source traffic moved"');
    const simulator = read("components/aiRoi/efficiency/SubstitutionSimulator.tsx");
    expect(simulator).not.toContain('type="range"');
    expect(simulator).not.toContain("shareSlider");
    expect(simulator.indexOf("{modeTabs}")).toBeLessThan(simulator.indexOf("{resetButton}"));
    expect(simulator.indexOf("{resetButton}")).toBeLessThan(simulator.indexOf('id="simulator-flow-panel"'));
    expect(read("pages/aiRoi/Efficiency.tsx")).toContain("peer-hover:visible");
    expect(read("pages/aiRoi/Efficiency.tsx")).not.toContain("onClick={() => setOpen");
    expect(efficiency.indexOf("SubstitutionSimulator")).toBeLessThan(
      efficiency.indexOf("Per-model unit economics"),
    );
  });
});
