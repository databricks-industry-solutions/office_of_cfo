import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CHART_COLORS } from "./chartPalette";
import {
  otherTrajectoryMetrics,
  projectedTrajectoryTitle,
  projectionColor,
  trajectoryEndSummary,
  trajectoryMetricDef,
  TRAJECTORY_METRIC_ORDER,
} from "./scenarioTrajectory";

describe("otherTrajectoryMetrics", () => {
  it("returns the two metrics that are not selected", () => {
    expect(otherTrajectoryMetrics("revenue")).toEqual(["operating_income", "cash_balance"]);
    expect(otherTrajectoryMetrics("operating_income")).toEqual(["revenue", "cash_balance"]);
    expect(otherTrajectoryMetrics("cash_balance")).toEqual(["revenue", "operating_income"]);
  });

  it("covers every metric exactly once across selections", () => {
    for (const selected of TRAJECTORY_METRIC_ORDER) {
      const others = otherTrajectoryMetrics(selected);
      expect(others).toHaveLength(2);
      expect(others).not.toContain(selected);
      expect([selected, ...others].sort()).toEqual([...TRAJECTORY_METRIC_ORDER].sort());
    }
  });
});

describe("projectionColor", () => {
  it("returns neutral gray when delta is zero", () => {
    expect(projectionColor(0, "higher")).toBe(CHART_COLORS.axis);
  });

  it("returns the good token when higher-is-better and delta is positive", () => {
    expect(projectionColor(100, "higher")).toBe(CHART_COLORS.good);
  });

  it("returns the bad token when higher-is-better and delta is negative", () => {
    expect(projectionColor(-50, "higher")).toBe(CHART_COLORS.bad);
  });

  it("returns the good token when lower-is-better and delta is negative", () => {
    expect(projectionColor(-50, "lower")).toBe(CHART_COLORS.good);
  });

  it("returns the bad token when lower-is-better and delta is positive", () => {
    expect(projectionColor(50, "lower")).toBe(CHART_COLORS.bad);
  });
});

describe("trajectoryEndSummary", () => {
  it("reads end-period values and signed delta from the last index", () => {
    const summary = trajectoryEndSummary([10, 20, 30], [10, 25, 40], "higher");
    expect(summary.endBaseline).toBe(30);
    expect(summary.endProjection).toBe(40);
    expect(summary.delta).toBe(10);
    expect(summary.color).toBe(CHART_COLORS.good);
  });

  it("handles empty series as zero", () => {
    const summary = trajectoryEndSummary([], [], "higher");
    expect(summary.endBaseline).toBe(0);
    expect(summary.endProjection).toBe(0);
    expect(summary.delta).toBe(0);
    expect(summary.color).toBe(CHART_COLORS.axis);
  });
});

describe("projectedTrajectoryTitle", () => {
  it("names the card after the selected trajectory metric", () => {
    expect(projectedTrajectoryTitle("revenue")).toBe("Projected Revenue");
    expect(projectedTrajectoryTitle("operating_income")).toBe("Projected Operating Income");
    expect(projectedTrajectoryTitle("cash_balance")).toBe("Projected Cash Balance");
  });

  it("is wired to the Scenario Planning primary chart card", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../pages/ScenarioPlanning.tsx"),
      "utf8",
    );
    expect(src).toContain("title={projectedTrajectoryTitle(selectedTrajectoryMetric)}");
    expect(src).not.toContain('title="Projected P&L & Cash"');
  });
});

describe("trajectoryMetricDef", () => {
  it("maps ids to line keys used by projectResult", () => {
    expect(trajectoryMetricDef("revenue").lineKey).toBe("revenue");
    expect(trajectoryMetricDef("operating_income").lineKey).toBe("operating_income");
    expect(trajectoryMetricDef("cash_balance").lineKey).toBe("cash_balance");
  });
});
