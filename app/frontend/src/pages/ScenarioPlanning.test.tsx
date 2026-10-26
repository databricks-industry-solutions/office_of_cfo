import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CompareResult, PlanListItem, StatementSet } from "../api";
import {
  comparisonBarGeometry,
  comparisonDomain,
  firstEnabledNonBaselineOptionIndex,
  MetricComparisonVisual,
  normalizeCompareSelection,
  scenarioComparisonColor,
  ScenarioComparePicker,
  toggleCompareSelection,
  orderComparePickerPlans,
} from "../components/ScenarioCompare";
import {
  bridgeRequestTransition,
  compareEffectiveSelectionKey,
  compareFailureRecoveryTransition,
  compareRequestTransition,
  failedCompareKeyForSelection,
  MetricComparisonToolbar,
  normalizeCompareSelectionForPlans,
  CompareSelectionPrompt,
  persistDraftAndCommit,
  ScenarioSummary,
  SecondaryTrajectoryChart,
  SECONDARY_TRAJECTORY_GRID_CLASS,
  scenarioErrorAfterPageClick,
  shouldStartCompareRequest,
  hasNonBaselineSelection,
} from "./ScenarioPlanning";

const plan = (
  scenario_id: string,
  name: string,
  status: PlanListItem["status"],
  is_baseline = false,
): PlanListItem => ({
  scenario_id,
  name,
  status,
  is_baseline,
  is_official: status === "published",
  scope_type: "global",
  scope_id: "GLOBAL",
  as_of_period: "2026-03",
  created_by: null,
  updated_ts: "2026-03-31T00:00:00Z",
});

const statement = (scale = 1): StatementSet => ({
  periods: ["2026-01", "2026-02", "2026-03", "2026-04"],
  hinge_index: 1,
  lines: {
    revenue: [10, 12, 14, 16].map((value) => value * scale),
    operating_income: [2, 3, 4, 5].map((value) => value * scale),
    free_cash_flow: [-1, 1, 2, 3].map((value) => value * scale),
    cash_balance: [6, 7, 8, 9].map((value) => value * scale),
  },
  kpis: {
    gross_margin_pct: [40, 41, 42, 43].map((value) => value * scale),
    operating_margin_pct: [15, 16, 17, 18].map((value) => value * scale),
  },
});

const statementWithRevenueOffset = (offsetPerPeriod: number): StatementSet => {
  const base = statement();
  return {
    ...base,
    lines: {
      ...base.lines,
      revenue: base.lines.revenue.map((value) => value + offsetPerPeriod),
    },
  };
};

describe("persistDraftAndCommit", () => {
  it("saves current lever values before freezing the scenario", async () => {
    const calls: string[] = [];
    const committed = { scenario_id: "scn-draft", status: "committed" };

    const result = await persistDraftAndCommit(
      "scn-draft",
      { name: "Growth case", assumptions: { revenue_growth: 4 } },
      async (scenarioId, body) => {
        calls.push(`patch:${scenarioId}`);
        expect(body).toEqual({
          name: "Growth case",
          assumptions: { revenue_growth: 4 },
        });
      },
      async (scenarioId) => {
        calls.push(`commit:${scenarioId}`);
        return committed;
      },
    );

    expect(calls).toEqual(["patch:scn-draft", "commit:scn-draft"]);
    expect(result).toBe(committed);
  });
});

describe("scenarioErrorAfterPageClick", () => {
  it("dismisses a duplicate-scenario warning on the next page click", () => {
    expect(
      scenarioErrorAfterPageClick(
        "This scenario matches Baseline. Change at least one driver.",
      ),
    ).toBeNull();
    expect(
      scenarioErrorAfterPageClick(
        'This scenario matches "Worst case". Change at least one driver.',
      ),
    ).toBeNull();
  });

  it("preserves unrelated errors", () => {
    expect(scenarioErrorAfterPageClick("Scenario store unavailable")).toBe(
      "Scenario store unavailable",
    );
    expect(scenarioErrorAfterPageClick(null)).toBeNull();
  });
});

describe("SecondaryTrajectoryChart", () => {
  it("renders a complete promotable trajectory chart", () => {
    const html = renderToStaticMarkup(
      <SecondaryTrajectoryChart
        metricId="operating_income"
        baseline={[4.2, 4.4, 4.6, 4.8]}
        projection={[4.2, 4.1, 3.9, 4.0]}
        periods={["2026-04", "2026-05", "2026-06", "2026-07"]}
        hingeIndex={1}
        onSelect={() => {}}
      />,
    );

    expect(html).toContain('aria-label="Show Operating Income as primary chart"');
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Operating Income"');
    expect(html).toContain("NOW");
    expect(html).toContain("Baseline");
    expect(html).toContain("Scenario");

    // Tighten: specifically assert h-full min-h-0 on the button class
    expect(html).toMatch(/<button[^>]*class="[^"]*h-full min-h-0[^"]*"/);
  });
});

describe("SECONDARY_TRAJECTORY_GRID_CLASS", () => {
  it("stretches in desktop layouts only (explicit lg: prefix)", () => {
    // Approved class string: "grid grid-cols-1 sm:grid-cols-2 gap-3 lg:flex-1 lg:min-h-0"
    expect(SECONDARY_TRAJECTORY_GRID_CLASS).toBe("grid grid-cols-1 sm:grid-cols-2 gap-3 lg:flex-1 lg:min-h-0");

    // Explicitly require lg: prefix
    expect(SECONDARY_TRAJECTORY_GRID_CLASS).toContain("lg:flex-1");
    expect(SECONDARY_TRAJECTORY_GRID_CLASS).toContain("lg:min-h-0");

    // Ensure removal of desktop-only prefix fails (by checking they don't exist without prefix)
    const classes = SECONDARY_TRAJECTORY_GRID_CLASS.split(" ");
    expect(classes).not.toContain("flex-1");
    expect(classes).not.toContain("min-h-0");
  });
});

describe("ScenarioSummary", () => {
  it("offers a new scenario from the baseline reference", () => {
    const html = renderToStaticMarkup(
      <ScenarioSummary
        status="baseline"
        isBaseline
        changes={[]}
        creating={false}
        onCreate={() => {}}
        onClone={() => {}}
      />,
    );

    expect(html).toContain("Baseline reference");
    expect(html).toContain("Official reference case");
    expect(html).toContain("Create scenario from baseline");
  });

  it("shows active draft driver changes", () => {
    const html = renderToStaticMarkup(
      <ScenarioSummary
        status="draft"
        isBaseline={false}
        changes={[
          { id: "revenue_growth", label: "Revenue growth", value: "−4.0%" },
          { id: "gross_margin", label: "Gross margin", value: "−50bps" },
        ]}
        creating={false}
        onCreate={() => {}}
        onClone={() => {}}
      />,
    );

    expect(html).toContain("Active changes");
    expect(html).toContain("Revenue growth");
    expect(html).toContain("−4.0%");
    expect(html).toContain("Gross margin");
    expect(html).not.toContain("Create scenario from baseline");
  });

  it("explains that committed scenarios are frozen and clonable", () => {
    const html = renderToStaticMarkup(
      <ScenarioSummary
        status="committed"
        isBaseline={false}
        changes={[]}
        creating={false}
        onCreate={() => {}}
        onClone={() => {}}
      />,
    );

    expect(html).toContain("Committed scenario");
    expect(html).toContain("Frozen for comparison");
    expect(html).toContain("Clone to edit");
  });
});

describe("compare selection", () => {
  it("keeps baseline locked and enforces three additional scenarios", () => {
    const selected = new Set(["base", "a", "b", "c"]);

    expect(Array.from(toggleCompareSelection(selected, "base", "base"))).toEqual([
      "base", "a", "b", "c",
    ]);
    expect(Array.from(toggleCompareSelection(selected, "d", "base"))).toEqual([
      "base", "a", "b", "c",
    ]);
    expect(Array.from(toggleCompareSelection(selected, "a", "base"))).toEqual([
      "base", "b", "c",
    ]);
  });

  it("normalizes malformed input before applying toggles", () => {
    const selected = new Set(["a", "b", "c", "d"]);

    expect(Array.from(toggleCompareSelection(selected, "e", "base"))).toEqual([
      "base", "a", "b", "c",
    ]);
  });

  it("caps normalized selection to baseline plus three scenarios", () => {
    const selected = new Set(["base", "a", "b", "c", "d", "e"]);

    expect(Array.from(normalizeCompareSelection(selected, "base"))).toEqual([
      "base", "a", "b", "c",
    ]);
  });

  it("treats baseline-only compare as no selection", () => {
    expect(hasNonBaselineSelection(new Set(["base"]), "base")).toBe(false);
    expect(hasNonBaselineSelection(new Set(["base", "case-a"]), "base")).toBe(true);
    expect(hasNonBaselineSelection(new Set(), "base")).toBe(false);
  });

  it("focuses the first enabled non-baseline option at max selection", () => {
    const plans = [
      plan("base", "Base", "baseline", true),
      plan("a", "Case A", "draft"),
      plan("b", "Case B", "draft"),
      plan("c", "Case C", "draft"),
      plan("d", "Case D", "draft"),
    ];
    const selected = new Set(["base", "b", "c", "d"]);

    expect(firstEnabledNonBaselineOptionIndex(plans, selected, "base")).toBe(2);
  });

  it("orders baseline, selectable scenarios, then ineligible scenarios", () => {
    const ineligible = {
      ...plan("new", "New scenario", "draft"),
      compare_eligible: false,
    };
    const eligibleDraft = {
      ...plan("growth", "Growth", "draft"),
      compare_eligible: true,
    };
    const eligibleCommitted = {
      ...plan("approved", "Approved", "committed"),
      compare_eligible: true,
    };
    const baseline = plan("base", "Base", "baseline", true);

    expect(
      orderComparePickerPlans([
        ineligible,
        eligibleDraft,
        baseline,
        eligibleCommitted,
      ]).map((item) => item.scenario_id),
    ).toEqual(["base", "growth", "approved", "new"]);
  });

  it("renders dropdown labels, statuses, locked baseline, and selected chips", () => {
    const plans = [
      plan("base", "Base", "baseline", true),
      plan("draft", "Growth case", "draft"),
      plan("published", "Board forecast", "published"),
    ];
    const html = renderToStaticMarkup(
      <ScenarioComparePicker
        plans={plans}
        selectedIds={new Set(["base", "draft"])}
        onChange={() => {}}
        onRequestPublish={() => {}}
        defaultOpen
      />,
    );

    expect(html).toContain("Base + 1 scenario");
    expect(html).toContain("Baseline · locked");
    expect(html).toContain("Growth case");
    expect(html).toContain("Board forecast");
    expect(html).toContain("draft");
    expect(html).toContain("published");
    expect(html).toContain('aria-label="Remove Growth case from comparison"');
  });

  it("disables ineligible scenarios and shows backend reason", () => {
    const plans = [
      plan("base", "Base", "baseline", true),
      {
        ...plan("draft-copy", "Working draft copy", "draft"),
        compare_eligible: false,
        compare_block_reason: "Duplicate draft. Commit or publish to compare.",
      },
      plan("published", "Board forecast", "published"),
    ];
    const html = renderToStaticMarkup(
      <ScenarioComparePicker
        plans={plans}
        selectedIds={new Set(["base"])}
        onChange={() => {}}
        onRequestPublish={() => {}}
        defaultOpen
      />,
    );

    expect(html).toContain('aria-disabled="true" aria-describedby="compare-block-reason-draft-copy"');
    expect(html).toContain('id="compare-block-reason-draft-copy"');
    expect(html).toContain("Duplicate draft. Commit or publish to compare.");
    expect(html).toContain("Working draft copy");
    expect(html).not.toContain('aria-describedby="compare-block-reason-base"');
  });

  it("renders comparison trigger copy and removal chip action", () => {
    const plans = [
      plan("base", "Base", "baseline", true),
      plan("draft", "Growth case", "draft"),
      plan("published", "Board forecast", "published"),
    ];
    const html = renderToStaticMarkup(
      <ScenarioComparePicker
        plans={plans}
        selectedIds={new Set(["base", "draft"])}
        onChange={() => {}}
        onRequestPublish={() => {}}
        defaultOpen
      />,
    );

    expect(html).toContain("Base + 1 scenario");
    expect(html).toContain("w-[min(22rem,calc(100vw-2rem))]");
    expect(html).toContain('aria-label="Remove Growth case from comparison"');
  });

  it("caps malformed selectedIds in rendered chips and trigger copy", () => {
    const plans = [
      plan("base", "Base", "baseline", true),
      plan("a", "Case A", "draft"),
      plan("b", "Case B", "draft"),
      plan("c", "Case C", "draft"),
      plan("d", "Case D", "draft"),
    ];
    const html = renderToStaticMarkup(
      <ScenarioComparePicker
        plans={plans}
        selectedIds={new Set(["base", "a", "b", "c", "d"])}
        onChange={() => {}}
        onRequestPublish={() => {}}
        defaultOpen
      />,
    );

    expect(html).toContain("Base + 3 scenarios");
    expect(html).toContain("Case A");
    expect(html).toContain("Case B");
    expect(html).toContain("Case C");
    expect(html).not.toContain('aria-label="Remove Case D from comparison"');
  });
});

describe("CompareSelectionPrompt", () => {
  it("shows the exact compare prompt copy", () => {
    const html = renderToStaticMarkup(<CompareSelectionPrompt />);
    expect(html).toContain("Please select at least one scenario to compare.");
  });
});

describe("compare request transitions", () => {
  it("blocks compare and clears stale state for baseline-only selection", () => {
    expect(compareRequestTransition("compare", false)).toEqual({
      shouldRequest: false,
      clearCompareResult: true,
      clearBridgeState: true,
    });
  });

  it("clears compare result before each valid request", () => {
    expect(compareRequestTransition("compare", true)).toEqual({
      shouldRequest: true,
      clearCompareResult: true,
      clearBridgeState: false,
    });
  });

  it("skips compare transitions outside compare mode", () => {
    expect(compareRequestTransition("plan", true)).toEqual({
      shouldRequest: false,
      clearCompareResult: false,
      clearBridgeState: false,
    });
  });

  it("clears bridge result before each bridge request", () => {
    expect(bridgeRequestTransition("case-a")).toEqual({
      shouldRequest: true,
      clearBridgeResult: true,
    });
    expect(bridgeRequestTransition("")).toEqual({
      shouldRequest: false,
      clearBridgeResult: false,
    });
  });

  it("normalizes selection against refreshed plan eligibility", () => {
    const plans = [
      plan("base", "Base", "baseline", true),
      { ...plan("eligible", "Eligible", "committed"), compare_eligible: true },
      {
        ...plan("ineligible", "Ineligible", "draft"),
        compare_eligible: false,
        compare_block_reason: "Duplicate",
      },
    ];

    const normalized = normalizeCompareSelectionForPlans(
      new Set(["base", "eligible", "ineligible", "missing"]),
      plans,
      "base",
    );

    expect(Array.from(normalized)).toEqual(["base", "eligible"]);
  });

  it("keeps baseline locked when refresh removes all eligible non-baselines", () => {
    const plans = [
      plan("base", "Base", "baseline", true),
      { ...plan("ineligible", "Ineligible", "draft"), compare_eligible: false },
    ];
    const normalized = normalizeCompareSelectionForPlans(
      new Set(["base", "ineligible"]),
      plans,
      "base",
    );

    expect(Array.from(normalized)).toEqual(["base"]);
    expect(hasNonBaselineSelection(normalized, "base")).toBe(false);
  });

  it("requires refresh and error surfacing on compare failure", () => {
    expect(compareFailureRecoveryTransition("compare", false)).toEqual({
      clearCompareResult: true,
      refreshPlans: true,
      clearBridgeState: true,
      surfaceError: true,
    });
    expect(compareFailureRecoveryTransition("compare", true)).toEqual({
      clearCompareResult: true,
      refreshPlans: true,
      clearBridgeState: false,
      surfaceError: true,
    });
  });

  it("serializes effective selection key stably across set identity/order", () => {
    const keyA = compareEffectiveSelectionKey(new Set(["base", "b", "a"]), "base");
    const keyB = compareEffectiveSelectionKey(new Set(["a", "base", "b"]), "base");
    expect(keyA).toBe("base|a|b");
    expect(keyB).toBe(keyA);
  });

  it("does not request compare again after generic failure when key is unchanged", () => {
    expect(shouldStartCompareRequest("compare", true, "base|case-a", "base|case-a")).toBe(false);
    expect(shouldStartCompareRequest("compare", true, "base|case-b", "base|case-a")).toBe(true);
  });

  it("resets retry guard after baseline-only transition", () => {
    const failedKey = "base|case-a";
    const unchangedRefreshShouldRetry = shouldStartCompareRequest("compare", true, failedKey, failedKey);
    expect(unchangedRefreshShouldRetry).toBe(false);

    const resetFailedKey = failedCompareKeyForSelection(false, failedKey);
    expect(resetFailedKey).toBeNull();

    const reselectedShouldRetry = shouldStartCompareRequest("compare", true, failedKey, resetFailedKey);
    expect(reselectedShouldRetry).toBe(true);
  });
});

describe("ScenarioPlanning compare layout", () => {
  it("wires compact picker into metric comparison toolbar", () => {
    const plans = [
      plan("base", "Base", "baseline", true),
      plan("draft", "Growth case", "draft"),
      plan("published", "Board forecast", "published"),
    ];
    const html = renderToStaticMarkup(
      <MetricComparisonToolbar
        plans={plans}
        selectedIds={new Set(["base", "draft"])}
        compareView="table"
        onChange={() => {}}
        onSetCompareView={() => {}}
        onRequestPublish={() => {}}
      />,
    );

    expect(html).toContain("Metric comparison");
    expect(html).toContain("Base + 1 scenario");
    expect(html).not.toContain("Choose scenarios");
    expect(html).toContain('aria-label="Metric comparison view"');
  });
});

describe("metric comparison visual", () => {
  it("uses zero-inclusive domains and diverging bar geometry", () => {
    expect(comparisonDomain([4, 10])).toEqual({ min: 0, max: 10 });
    expect(comparisonDomain([-8, -2])).toEqual({ min: -8, max: 0 });
    expect(comparisonDomain([-5, 15])).toEqual({ min: -5, max: 15 });

    expect(comparisonBarGeometry(-5, -10, 20)).toEqual({
      leftPct: 16.666666666666664,
      widthPct: 16.666666666666664,
      zeroPct: 33.33333333333333,
    });
    expect(comparisonBarGeometry(10, -10, 20)).toEqual({
      leftPct: 33.33333333333333,
      widthPct: 33.33333333333333,
      zeroPct: 33.33333333333333,
    });
  });

  it("assigns stable scenario colors", () => {
    expect(scenarioComparisonColor("growth")).toBe(scenarioComparisonColor("growth"));
    expect(scenarioComparisonColor("growth")).not.toBe(scenarioComparisonColor("downside"));
  });

  it("renders one delta-vs-baseline chart for the selected metric", () => {
    const result: CompareResult = {
      periods: statement().periods,
      hinge_index: 1,
      base: statement(),
      scenarios: [
        { scenario_id: "base", name: "Base", is_baseline: true, projection: statement() },
        { scenario_id: "growth", name: "Growth case", is_baseline: false, projection: statement(1.1) },
        {
          scenario_id: "flat",
          name: "Flat case",
          is_baseline: false,
          projection: statementWithRevenueOffset(0.001),
        },
        { scenario_id: "downside", name: "Downside case", is_baseline: false, projection: statement(-1) },
      ],
    };

    const html = renderToStaticMarkup(<MetricComparisonVisual result={result} />);

    expect(html.match(/data-metric-panel=/g)).toHaveLength(1);
    expect(html).toContain('data-metric-panel="rev_fy"');
    expect(html).toContain('data-comparison-chart="delta-vs-baseline"');
    expect(html).toContain('role="tablist"');
    expect(html).toContain("Revenue (FY)");
    expect(html).toContain("Op. Margin %");
    expect(html).toContain("Baseline");
    expect(html).toContain("Growth case");
    expect(html).toContain("$52");
    expect(html).toContain("$57");
    expect(html).toContain("+$5");
    expect(html).toContain("text-signal-good");
    expect(html).toContain("text-signal-bad");
    expect(html).toContain("±$0");
    expect(html).toContain("data-zero-line");
    expect(html).toContain("Bars show change vs Baseline");
    expect(html).not.toContain("Each metric uses its own scale");
    expect(html).not.toContain('data-comparison-chart="grouped-horizontal"');
  });

  it("can render a non-default metric when selected", () => {
    const result: CompareResult = {
      periods: statement().periods,
      hinge_index: 1,
      base: statement(),
      scenarios: [
        { scenario_id: "growth", name: "Growth case", is_baseline: false, projection: statement(1.1) },
      ],
    };

    const html = renderToStaticMarkup(
      <MetricComparisonVisual result={result} metric="om_pct" />,
    );

    expect(html).toContain('data-metric-panel="om_pct"');
    expect(html).toContain("Op. Margin %");
    expect(html.match(/data-metric-panel=/g)).toHaveLength(1);
  });
});
