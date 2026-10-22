import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CHART_COLORS } from "./chartPalette";
import { GroupedBar } from "../components/aiRoi/charts";
import { Delta } from "../components/aiRoi/spend/Delta";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

const sampleRows = [
  { period: "2025-01", group: "Alpha", value: 100 },
  { period: "2025-01", group: "Beta", value: 50 },
  { period: "2025-02", group: "Alpha", value: 120 },
  { period: "2025-02", group: "Beta", value: 40 },
];

describe("spend UX corrections — GroupedBar", () => {
  it("uses saturated CHART_COLORS fills, not pastel stacked-area variables", () => {
    const html = renderToStaticMarkup(<GroupedBar rows={sampleRows} />);
    expect(html).toContain(`fill="${CHART_COLORS.series1}"`);
    expect(html).toContain(`fill="${CHART_COLORS.series2}"`);
    expect(html).not.toContain("--c-spend-area-brick");
    expect(html).toContain('fill-opacity="1"');
    expect(read("components/aiRoi/spend/SpendTrend.tsx")).toContain("GroupedBar");
    expect(read("components/aiRoi/spend/SpendTrend.tsx")).not.toContain("StackedArea");
  });

  it("styles axes with CHART_COLORS.axis and grid lines with CHART_COLORS.grid", () => {
    const chartsSrc = read("components/aiRoi/charts.tsx");
    const groupedBlock = chartsSrc.slice(
      chartsSrc.indexOf("export function GroupedBar"),
      chartsSrc.indexOf("export function BreakevenChart"),
    );
    expect(groupedBlock).toContain(`fill={CHART_COLORS.axis}`);
    expect(groupedBlock).toContain(`stroke={CHART_COLORS.grid}`);
    expect(CHART_COLORS.axis).toBeTruthy();
    expect(CHART_COLORS.grid).toBeTruthy();
  });

  it("uses app sans typography on SVG axis labels", () => {
    const html = renderToStaticMarkup(<GroupedBar rows={sampleRows} />);
    expect(html).toContain('role="img" aria-label="AI run cost in US dollars"');
    expect(html).toMatch(/font-sans/);
    expect(html).toContain('font-family="inherit"');
    expect(html).toContain('font-weight="400"');
    expect(html).toMatch(/\$|USD/);
    expect(html).toContain("Jan");
  });
});

describe("spend UX corrections — Spend scope control", () => {
  it("does not keep a spend-only back control", () => {
    const src = read("pages/aiRoi/Spend.tsx");
    expect(src).not.toContain("SpendScopeClearBar");
    expect(src).not.toContain("Back to all spend");
    expect(read("App.tsx")).not.toContain("AiRoiScopeFilterBar");
    expect(read("components/TopNav.tsx")).toContain("OrgExplorerTopic");
  });
});

describe("spend UX corrections — trend filters", () => {
  it("gives inactive filters a contrasting dark-mode surface and text", () => {
    const src = read("components/aiRoi/spend/SpendTrend.tsx");
    expect(src).toContain("dark:bg-ink-600");
    expect(src).toContain("dark:text-fg");
    expect(src).toContain("dark:hover:bg-ink-500");
  });
});

describe("spend UX corrections — Delta", () => {
  it("colors positive, negative, and zero deltas", () => {
    const pos = renderToStaticMarkup(<Delta value={1200} kind="currency" />);
    expect(pos).toContain("text-signal-good");
    expect(pos).not.toContain("text-signal-warn");
    expect(pos).toContain("+");

    const neg = renderToStaticMarkup(<Delta value={-0.12} kind="percent" />);
    expect(neg).toContain("text-signal-bad");
    expect(neg).not.toContain("text-signal-good");
    expect(neg).toContain("−");

    const zero = renderToStaticMarkup(<Delta value={0} kind="currency" />);
    expect(zero).toContain("text-fg-muted");
    expect(zero).not.toContain("text-signal-warn");
    expect(zero).toContain("—");
  });
});
