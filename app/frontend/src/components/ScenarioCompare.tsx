import { useEffect, useRef, useState } from "react";
import {
  CompareResult,
  PlanListItem,
  StatementSet,
  fmtCompact,
} from "../api";
import { CHART_COLORS } from "../lib/chartPalette";
import { cn } from "../lib/cn";

export type MetricKey =
  | "rev_fy" | "oi_fy" | "fcf_fy"
  | "cash_end" | "gm_pct" | "om_pct";

export const METRIC_DEFS: {
  key: MetricKey;
  label: string;
  unit?: string;
  better: "higher" | "lower";
}[] = [
  { key: "rev_fy", label: "Revenue (FY)", better: "higher" },
  { key: "oi_fy", label: "Op. Income (FY)", better: "higher" },
  { key: "fcf_fy", label: "Free Cash Flow (FY)", better: "higher" },
  { key: "cash_end", label: "Cash Balance (end)", better: "higher" },
  { key: "gm_pct", label: "Gross Margin %", unit: "%", better: "higher" },
  { key: "om_pct", label: "Op. Margin %", unit: "%", better: "higher" },
];

export function fySum(arr: number[] | undefined): number {
  if (!arr) return 0;
  return arr.reduce((s, v) => s + v, 0);
}

export function forecastAvg(arr: number[] | undefined, hingeIndex: number): number {
  if (!arr || arr.length === 0) return 0;
  const forecast = arr.slice(hingeIndex + 1);
  if (forecast.length === 0) return arr[arr.length - 1] ?? 0;
  return forecast.reduce((s, v) => s + v, 0) / forecast.length;
}

export function extractMetric(ss: StatementSet, key: MetricKey): number {
  const h = ss.hinge_index;
  switch (key) {
    case "rev_fy": return fySum(ss.lines["revenue"]);
    case "oi_fy": return fySum(ss.lines["operating_income"]);
    case "fcf_fy": return fySum(ss.lines["free_cash_flow"]);
    case "cash_end": {
      const cb = ss.lines["cash_balance"];
      return cb && cb.length ? cb[cb.length - 1]! : 0;
    }
    case "gm_pct": return forecastAvg(ss.kpis["gross_margin_pct"], h);
    case "om_pct": return forecastAvg(ss.kpis["operating_margin_pct"], h);
    default: return 0;
  }
}

export function fmtMetric(value: number, unit?: string): string {
  if (unit === "%") return `${value.toFixed(1)}%`;
  return fmtCompact(value);
}

const MAX_COMPARE_SCENARIOS = 4;
const COMPARISON_COLORS = [
  CHART_COLORS.seriesA,
  CHART_COLORS.seriesB,
  CHART_COLORS.seriesC,
  CHART_COLORS.accent,
  CHART_COLORS.slate,
  CHART_COLORS.ink,
] as const;

const MAX_NON_BASELINE_SCENARIOS = MAX_COMPARE_SCENARIOS - 1;

export function normalizeCompareSelection(
  selectedIds: ReadonlySet<string>,
  baselineId: string,
): Set<string> {
  const normalized = new Set<string>();
  if (baselineId) normalized.add(baselineId);
  for (const selectedId of selectedIds) {
    if (!selectedId || selectedId === baselineId) continue;
    const nonBaselineCount = baselineId ? normalized.size - 1 : normalized.size;
    if (nonBaselineCount >= MAX_NON_BASELINE_SCENARIOS) break;
    normalized.add(selectedId);
  }
  return normalized;
}

export function orderComparePickerPlans(
  plans: readonly PlanListItem[],
): PlanListItem[] {
  const baseline: PlanListItem[] = [];
  const selectable: PlanListItem[] = [];
  const ineligible: PlanListItem[] = [];

  for (const plan of plans) {
    if (plan.is_baseline) baseline.push(plan);
    else if (plan.compare_eligible === false) ineligible.push(plan);
    else selectable.push(plan);
  }

  return [...baseline, ...selectable, ...ineligible];
}

export function firstEnabledNonBaselineOptionIndex(
  plans: readonly PlanListItem[],
  selectedIds: ReadonlySet<string>,
  baselineId: string,
): number {
  const normalizedSelected = normalizeCompareSelection(selectedIds, baselineId);
  const atLimit = normalizedSelected.size >= MAX_COMPARE_SCENARIOS;
  return plans.findIndex((plan) => {
    if (plan.is_baseline) return false;
    if (plan.compare_eligible === false) return false;
    const checked = normalizedSelected.has(plan.scenario_id);
    return !(atLimit && !checked);
  });
}

export function toggleCompareSelection(
  selectedIds: ReadonlySet<string>,
  scenarioId: string,
  baselineId: string,
): Set<string> {
  const next = normalizeCompareSelection(selectedIds, baselineId);
  if (!scenarioId || scenarioId === baselineId) return next;
  if (next.has(scenarioId)) {
    next.delete(scenarioId);
  } else {
    const nonBaselineCount = baselineId ? next.size - 1 : next.size;
    if (nonBaselineCount >= MAX_NON_BASELINE_SCENARIOS) return next;
    next.add(scenarioId);
  }
  return next;
}

export function comparisonDomain(values: number[]): { min: number; max: number } {
  if (!values.length) return { min: 0, max: 1 };
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  return min === max ? { min: 0, max: 1 } : { min, max };
}

export function comparisonBarGeometry(
  value: number,
  min: number,
  max: number,
): { leftPct: number; widthPct: number; zeroPct: number } {
  const span = max - min || 1;
  const zeroPct = ((0 - min) / span) * 100;
  const valuePct = ((value - min) / span) * 100;
  return {
    leftPct: Math.min(zeroPct, valuePct),
    widthPct: Math.abs(valuePct - zeroPct),
    zeroPct,
  };
}

export function scenarioComparisonColor(scenarioId: string): string {
  const hash = Array.from(scenarioId).reduce((sum, character) => sum + character.charCodeAt(0), 0);
  return COMPARISON_COLORS[hash % COMPARISON_COLORS.length]!;
}

type ScenarioStatus = "baseline" | "draft" | "committed" | "published" | "archived";

function statusLabel(s: ScenarioStatus): string {
  return s === "baseline" ? "baseline" : s === "published" ? "published"
    : s === "committed" ? "committed" : s === "draft" ? "draft" : s;
}

function statusCls(s: ScenarioStatus): string {
  if (s === "baseline") return "bg-fg-muted/10 text-fg-muted ring-1 ring-fg-muted/30";
  if (s === "published") return "bg-signal-good/10 text-signal-good ring-1 ring-signal-good/30";
  if (s === "committed") return "bg-blue-500/10 text-blue-600 ring-1 ring-blue-500/30";
  return "bg-black/[0.05] text-fg-muted ring-1 ring-line";
}

export interface ScenarioComparePickerProps {
  plans: PlanListItem[];
  selectedIds: ReadonlySet<string>;
  onChange: (selected: Set<string>) => void;
  onRequestPublish: (
    plan: PlanListItem,
    action: "publish" | "revoke",
  ) => void;
  defaultOpen?: boolean;
}

export function ScenarioComparePicker({
  plans,
  selectedIds,
  onChange,
  onRequestPublish,
  defaultOpen = false,
}: ScenarioComparePickerProps) {
  const [open, setOpen] = useState(defaultOpen);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstOptionRef = useRef<HTMLButtonElement>(null);
  const baseline = plans.find((plan) => plan.is_baseline);
  const baselineId = baseline?.scenario_id ?? "";
  const normalizedSelected = normalizeCompareSelection(selectedIds, baselineId);
  const orderedPlans = orderComparePickerPlans(plans);
  const selectedPlans = plans.filter(
    (plan) => !plan.is_baseline && normalizedSelected.has(plan.scenario_id),
  );
  const atLimit = normalizedSelected.size >= MAX_COMPARE_SCENARIOS;
  const firstSelectableIndex = firstEnabledNonBaselineOptionIndex(
    orderedPlans,
    normalizedSelected,
    baselineId,
  );

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (open && !defaultOpen) firstOptionRef.current?.focus();
  }, [defaultOpen, open]);

  return (
    <div ref={rootRef} className="relative flex min-w-0 flex-wrap items-center gap-1.5">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex min-w-[10.5rem] items-center justify-between gap-2 rounded-lg bg-black/[0.025] px-3 py-2 text-left ring-1 ring-line"
      >
        <span className="truncate text-xs font-medium text-fg">
          {selectedPlans.length
            ? `Base + ${selectedPlans.length} scenario${selectedPlans.length === 1 ? "" : "s"}`
            : "Base only"}
        </span>
        <svg
          className={cn("h-4 w-4 text-fg-subtle transition-transform", open && "rotate-180")}
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M4 6l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {selectedPlans.length > 0 && (
        <div
          className="flex min-w-0 flex-wrap items-center gap-1.5"
          aria-label="Selected comparison scenarios"
        >
          {selectedPlans.map((plan) => (
            <span
              key={plan.scenario_id}
              className="inline-flex items-center gap-1 rounded-lg bg-accent/[0.06] px-2 py-1 text-[11px] text-fg ring-1 ring-accent/15"
            >
              {plan.name}
              <button
                type="button"
                aria-label={`Remove ${plan.name} from comparison`}
                onClick={() => onChange(toggleCompareSelection(
                  normalizedSelected,
                  plan.scenario_id,
                  baselineId,
                ))}
                className="text-fg-subtle transition hover:text-accent"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {open && (
        <div
          className={cn(
            "absolute left-0 top-full z-30 mt-2 overflow-hidden rounded-xl bg-[#f9f8f6] shadow-xl ring-1 ring-line dark:bg-[#1e232b]",
            "w-[min(22rem,calc(100vw-2rem))]",
          )}
        >
          <div
            role="listbox"
            aria-multiselectable="true"
            aria-label="Scenarios to compare"
            className="max-h-72 overflow-y-auto p-1.5"
          >
            {orderedPlans.map((plan, index) => {
              const checked = normalizedSelected.has(plan.scenario_id);
              const locked = plan.is_baseline;
              const ineligible = plan.compare_eligible === false;
              const selectionBlocked = atLimit && !checked;
              const hardDisabled = locked || selectionBlocked;
              const disabled = hardDisabled || ineligible;
              const compareBlockReason = plan.compare_block_reason?.trim() ?? "";
              const reasonId = compareBlockReason
                ? `compare-block-reason-${plan.scenario_id}`
                : undefined;
              const canPublish = !locked && (plan.status === "committed" || plan.status === "published");
              return (
                <div
                  key={plan.scenario_id}
                  className="flex items-center gap-1 rounded-lg hover:bg-black/[0.035]"
                >
                  <button
                    ref={index === firstSelectableIndex ? firstOptionRef : undefined}
                    type="button"
                    role="option"
                    aria-selected={checked}
                    aria-disabled={disabled}
                    aria-describedby={ineligible && reasonId ? reasonId : undefined}
                    disabled={hardDisabled}
                    onClick={() => {
                      if (disabled) return;
                      onChange(toggleCompareSelection(
                        normalizedSelected, plan.scenario_id, baselineId,
                      ));
                    }}
                    className={cn(
                      "flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition focus:outline-none focus:ring-2 focus:ring-inset focus:ring-accent/30",
                      disabled && !locked && "cursor-not-allowed opacity-40",
                    )}
                  >
                    <span
                      className={cn(
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                        checked ? "border-accent bg-accent text-white" : "border-line bg-transparent",
                      )}
                    >
                      {checked && (
                        <svg viewBox="0 0 12 12" fill="none" className="h-3 w-3" aria-hidden="true">
                          <path
                            d="M2 6l2.5 2.5L10 4"
                            stroke="currentColor"
                            strokeWidth="1.75"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-fg">{plan.name}</span>
                      {locked && <span className="block text-[10px] text-fg-subtle">Baseline · locked</span>}
                      {!locked && ineligible && compareBlockReason && (
                        <span id={reasonId} className="block text-[10px] text-fg-subtle">
                          {compareBlockReason}
                        </span>
                      )}
                    </span>
                    <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[10px]", statusCls(plan.status as ScenarioStatus))}>
                      {statusLabel(plan.status as ScenarioStatus)}
                    </span>
                  </button>
                  {canPublish && (
                    <button
                      type="button"
                      onClick={() => onRequestPublish(
                        plan, plan.status === "published" ? "revoke" : "publish",
                      )}
                      className={cn(
                        "mr-2 shrink-0 px-1 py-2 text-[10px] font-medium transition",
                        plan.status === "published"
                          ? "text-signal-good hover:opacity-70"
                          : "text-fg-muted hover:text-accent",
                      )}
                    >
                      {plan.status === "published" ? "Revoke" : "Publish"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <div className="border-t border-line px-3 py-2 text-[10px] text-fg-subtle">
            {atLimit
              ? "Maximum selected: Baseline plus 3 scenarios."
              : `Select up to ${MAX_COMPARE_SCENARIOS - normalizedSelected.size} more scenario${MAX_COMPARE_SCENARIOS - normalizedSelected.size === 1 ? "" : "s"}.`}
          </div>
        </div>
      )}
    </div>
  );
}

export function MetricComparisonVisual({
  result,
  metric,
}: {
  result: CompareResult;
  metric?: MetricKey;
}) {
  const [selectedKey, setSelectedKey] = useState<MetricKey>(metric ?? METRIC_DEFS[0]!.key);
  const selected = METRIC_DEFS.find((def) => def.key === (metric ?? selectedKey)) ?? METRIC_DEFS[0]!;
  const scenarios = result.scenarios.filter((scenario) => !scenario.is_baseline);
  const baseValue = extractMetric(result.base, selected.key);
  const rows = scenarios.map((scenario) => {
    const value = extractMetric(scenario.projection, selected.key);
    return {
      id: scenario.scenario_id,
      name: scenario.name,
      value,
      diff: value - baseValue,
      color: scenarioComparisonColor(scenario.scenario_id),
    };
  });
  const { min, max } = comparisonDomain(rows.map((row) => row.diff));
  const zeroPct = comparisonBarGeometry(0, min, max).zeroPct;

  return (
    <div data-comparison-chart="delta-vs-baseline">
      <div
        role="tablist"
        aria-label="Comparison metric"
        className="flex flex-wrap gap-1 border-b border-line/70 px-4 py-2"
      >
        {METRIC_DEFS.map((def) => {
          const active = def.key === selected.key;
          return (
            <button
              key={def.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setSelectedKey(def.key)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                active
                  ? "bg-ink-800 text-fg shadow-sm ring-1 ring-line"
                  : "text-fg-muted hover:bg-black/[0.04] hover:text-fg",
              )}
            >
              {def.label}
            </button>
          );
        })}
      </div>
      <div className="border-b border-line/70 px-4 py-2 text-[10px] text-fg-subtle">
        Bars show change vs Baseline · values are the metric total
      </div>
      <section data-metric-panel={selected.key} className="px-4 py-5">
        <div className="mb-4 flex items-baseline justify-between gap-3">
          <h3 className="text-sm font-semibold text-fg">{selected.label}</h3>
          <p className="text-xs text-fg-muted">
            Baseline <span className="num font-semibold text-fg">{fmtMetric(baseValue, selected.unit)}</span>
          </p>
        </div>
        <div className="space-y-4">
          {rows.map((row) => {
            const nearZeroDiff = Math.abs(row.diff) < 0.01;
            const positive = selected.better === "higher" ? row.diff >= 0 : row.diff <= 0;
            const geometry = comparisonBarGeometry(row.diff, min, max);
            return (
              <div key={row.id}>
                <div className="mb-1.5 flex items-baseline justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate font-medium text-fg">{row.name}</span>
                  <span className="shrink-0 text-right num font-semibold text-fg">
                    {fmtMetric(row.value, selected.unit)}
                    <span
                      className={cn(
                        "ml-1.5 text-xs font-medium",
                        nearZeroDiff
                          ? "text-fg-subtle"
                          : positive
                            ? "text-signal-good"
                            : "text-signal-bad",
                      )}
                    >
                      {nearZeroDiff
                        ? `±${fmtMetric(0, selected.unit)}`
                        : `${row.diff >= 0 ? "+" : ""}${fmtMetric(row.diff, selected.unit)}`}
                    </span>
                  </span>
                </div>
                <div className="relative h-5 overflow-hidden rounded-md bg-black/[0.06]">
                  <span
                    data-zero-line
                    className="absolute inset-y-0 z-10 w-px bg-fg-subtle/80"
                    style={{ left: `${Math.min(99.5, Math.max(0.5, zeroPct))}%` }}
                    aria-hidden="true"
                  />
                  <span
                    className="absolute inset-y-1 rounded-sm"
                    style={{
                      left: `${geometry.leftPct}%`,
                      width: `${Math.max(geometry.widthPct, nearZeroDiff ? 0 : 1.5)}%`,
                      backgroundColor: row.color,
                    }}
                    aria-hidden="true"
                  />
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
