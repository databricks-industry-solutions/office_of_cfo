import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

describe("redundant nav-duplicating page headings removed", () => {
  it("Dashboard drops Close / Month-End Close hero", () => {
    const src = read("pages/Dashboard.tsx");
    expect(src).not.toContain("<PageHeading");
    expect(src).not.toContain("Month-End Close");
    expect(src).not.toContain('eyebrow="Close"');
    expect(src).toContain("CloseStatusStrip");
    expect(src).toContain("GateTile");
  });

  it("Tasks drops Tasks title but keeps actions and filters", () => {
    const src = read("pages/Tasks.tsx");
    expect(src).not.toContain("<PageHeading");
    expect(src).not.toContain('title="Tasks"');
    expect(src).toContain("+ New task");
    expect(src).toContain("FilterBar");
  });

  it("Approvals drops Governance hero but keeps queue surfaces", () => {
    const src = read("pages/Approvals.tsx");
    expect(src).not.toContain("<PageHeading");
    expect(src).not.toContain('eyebrow="Governance"');
    expect(src).not.toContain("Approvals — Adjustment Sign-off");
    expect(src).toContain("PolicyBreakdown");
    expect(src).toContain("Approval queue");
  });

  it("Executive drops FP&A executive hero but keeps scope filters and charts", () => {
    const src = read("pages/Executive.tsx");
    expect(src).not.toContain("<PageHeading");
    expect(src).not.toContain("Executive KPIs — Working Capital");
    expect(src).toContain("FiltersPopover");
    expect(src).toContain("profitFilter");
    expect(src).toContain("wcFilter");
    expect(src).not.toContain("leadingAction");
    expect(src).not.toContain("<span>Scope</span>");
    expect(src).toContain("BudgetVariance");
  });

  it("Trial Balance drops page H1 but keeps status badge and table card", () => {
    const src = read("pages/TrialBalance.tsx");
    expect(src).not.toContain("<PageHeading");
    expect(src).not.toContain("Real-Time Trial Balance");
    expect(src).toContain("Data-quality badge");
    expect(src).toContain('title="Trial balance"');
  });

  it("Reconciliation drops page H1 but keeps breaks card", () => {
    const src = read("pages/Reconciliation.tsx");
    expect(src).not.toContain("<PageHeading");
    expect(src).not.toContain("Reconciliation Breaks & Adjustments");
    expect(src).toContain("Breaks requiring review");
  });

  it("Data Sources drops page H1 but keeps lineage card and summary tiles", () => {
    const src = read("pages/DataSources.tsx");
    expect(src).not.toContain("<PageHeading");
    expect(src).toContain("SummaryTiles");
    expect(src).toContain('title="Lineage & data quality"');
  });

  it("Settings drops page H1 but keeps autosave status and section cards", () => {
    const src = read("pages/Settings.tsx");
    expect(src).not.toContain("<PageHeading");
    expect(src).not.toContain('title="Settings"');
    expect(src).not.toContain("Save changes");
    expect(src).toContain("createConfigAutosave");
    expect(src).toContain("All changes saved");
    expect(src).toContain('title="Appearance"');
  });

  it("Market Insights drops nav title but keeps descriptive lead", () => {
    const src = read("pages/MarketInsights.tsx");
    expect(src).not.toContain("<PageHeading");
    expect(src).not.toContain("FP&A · Market Insights");
    expect(src).toContain("Current market signals mapped");
  });

  it("Ad-hoc Analysis drops FP&A hero and period subtitle but keeps upload and clear", () => {
    const src = read("pages/AdhocAnalysis.tsx");
    expect(src).not.toContain("<h1 className=\"text-2xl font-bold tracking-tight text-fg\"");
    expect(src).not.toContain("text-[11px] uppercase tracking-wider text-brick-500");
    expect(src).not.toContain("compare a last-mile finance file to governed books");
    expect(src).toContain("Clear analysis");
    expect(src).toContain("Use sample workbook");
  });

  it("Historical Insights drops custom eyebrow/H1 but keeps period context and narrative", () => {
    const src = read("pages/HistoricalInsights.tsx");
    expect(src).not.toContain("<h1 className=\"text-2xl font-bold tracking-tight text-fg\"");
    expect(src).not.toContain("text-[11px] uppercase tracking-wider text-brick-500");
    expect(src).toContain("trailing history");
    expect(src).toContain("What changed this month");
  });

  it("Payment Behaviour drops custom eyebrow/H1 but keeps as-of context and ledger toggle", () => {
    const src = read("pages/PaymentBehavior.tsx");
    expect(src).not.toContain("<h1 className=\"text-2xl font-bold tracking-tight text-fg\"");
    expect(src).not.toContain("text-[11px] uppercase tracking-wider text-brick-500");
    expect(src).toContain("vs their own historical norm");
    expect(src).toContain("arLabel");
  });

  it("Stress Test drops duplicate H1 but keeps scenario levers card", () => {
    const src = read("pages/StressTest.tsx");
    expect(src).not.toContain("stressTitle &&");
    expect(src).not.toContain("<h1 className=\"text-lg font-semibold text-fg");
    expect(src).toContain('title="Scenario levers"');
  });
});
