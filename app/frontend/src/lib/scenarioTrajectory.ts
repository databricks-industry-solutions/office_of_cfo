import { CHART_COLORS } from "./chartPalette";

export type TrajectoryMetricId = "revenue" | "operating_income" | "cash_balance";

export const TRAJECTORY_METRIC_ORDER: TrajectoryMetricId[] = [
  "revenue",
  "operating_income",
  "cash_balance",
];

export interface TrajectoryMetricDef {
  id: TrajectoryMetricId;
  label: string;
  lineKey: string;
  better: "higher" | "lower";
}

export const TRAJECTORY_METRICS: TrajectoryMetricDef[] = [
  { id: "revenue", label: "Revenue", lineKey: "revenue", better: "higher" },
  { id: "operating_income", label: "Operating Income", lineKey: "operating_income", better: "higher" },
  { id: "cash_balance", label: "Cash Balance", lineKey: "cash_balance", better: "higher" },
];

export function trajectoryMetricDef(id: TrajectoryMetricId): TrajectoryMetricDef {
  const def = TRAJECTORY_METRICS.find((m) => m.id === id);
  if (!def) throw new Error(`Unknown trajectory metric: ${id}`);
  return def;
}

export function otherTrajectoryMetrics(selected: TrajectoryMetricId): TrajectoryMetricId[] {
  return TRAJECTORY_METRIC_ORDER.filter((id) => id !== selected);
}

export function projectedTrajectoryTitle(selected: TrajectoryMetricId): string {
  return `Projected ${trajectoryMetricDef(selected).label}`;
}

export function projectionColor(diff: number, better: "higher" | "lower"): string {
  if (diff === 0) return CHART_COLORS.axis;
  const positive = better === "higher" ? diff >= 0 : diff <= 0;
  return positive ? CHART_COLORS.good : CHART_COLORS.bad;
}

export interface TrajectoryEndSummary {
  endBaseline: number;
  endProjection: number;
  delta: number;
  color: string;
}

export function trajectoryEndSummary(
  baseline: number[],
  projection: number[],
  better: "higher" | "lower" = "higher",
): TrajectoryEndSummary {
  const endBaseline = baseline.length ? (baseline[baseline.length - 1] ?? 0) : 0;
  const endProjection = projection.length ? (projection[projection.length - 1] ?? 0) : 0;
  const delta = endProjection - endBaseline;
  return {
    endBaseline,
    endProjection,
    delta,
    color: projectionColor(delta, better),
  };
}
