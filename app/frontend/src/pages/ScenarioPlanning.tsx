import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api, BridgeResult, CompareResult, DriverDef, PlanListItem, ProjectResult,
  ScenarioPlan, fmtCompact, fmtSignedCompact,
} from "../api";
import {
  forecastAvg,
  METRIC_DEFS,
  extractMetric,
  fmtMetric,
  fySum,
  MetricComparisonVisual,
  normalizeCompareSelection,
  ScenarioComparePicker,
} from "../components/ScenarioCompare";
import { BarChartSkeleton, Card, CardSkeleton, ChartSkeleton, ErrorNote, Section, Skeleton, SkeletonRegion, TableSkeleton } from "../components/ui";
import { OffLensAssumptions } from "../components/OffLensAssumptions";
import { CHART_AXIS_TEXT_DENSE, CHART_AXIS_TEXT_PIXEL, CHART_COLORS } from "../lib/chartPalette";
import { cn } from "../lib/cn";
import { catmullRomPath } from "../lib/runwayProjection";
import {
  otherTrajectoryMetrics, projectedTrajectoryTitle, projectionColor, trajectoryEndSummary,
  trajectoryMetricDef, TRAJECTORY_METRIC_ORDER, TrajectoryMetricId,
} from "../lib/scenarioTrajectory";
import { useChartSize } from "../lib/useChartSize";

// ── Driver slider config (ranges not in the catalog) ────────────────────────
interface DriverSliderCfg {
  id: string; min: number; max: number; step: number;
}
const SLIDER_CFG: DriverSliderCfg[] = [
  { id: "revenue_growth", min: -20, max: 20, step: 0.5 },
  { id: "gross_margin",   min: -300, max: 300, step: 10 },
  { id: "opex_growth",    min: -20, max: 20, step: 0.5 },
  { id: "dso",            min: -15, max: 15, step: 1 },
  { id: "dpo",            min: -15, max: 15, step: 1 },
  { id: "dio",            min: -15, max: 15, step: 1 },
  { id: "capex_pct",      min: 0, max: 15, step: 0.5 },
];

// The levers this lens edits. Financing/investing drivers (dividends, debt, M&A)
// live on the Cash Flow lens; a scenario may carry them, so we surface any that are
// set as read-only chips rather than dropping them on save.
const SLIDER_IDS = new Set(SLIDER_CFG.map((c) => c.id));

// Which direction is "better" for each driver.
// "positive" = a higher value improves outcomes (revenue up, margin up, DPO up).
// "negative" = a lower value improves outcomes (opex down, DSO down, DIO down, capex down).
const DRIVER_BETTER: Record<string, "positive" | "negative"> = {
  revenue_growth: "positive",
  gross_margin:   "positive",
  opex_growth:    "negative",
  dso:            "negative",
  dpo:            "positive",
  dio:            "negative",
  capex_pct:      "negative",
};

export const SECONDARY_TRAJECTORY_GRID_CLASS =
  "grid grid-cols-1 sm:grid-cols-2 gap-3 lg:flex-1 lg:min-h-0";

function zeroPaddedAssumptions(): Record<string, number> {
  const r: Record<string, number> = {};
  SLIDER_CFG.forEach((c) => { r[c.id] = 0; });
  return r;
}

// Strip zero-valued assumptions before sending to the API. For growth/shift/delta
// drivers, 0 == absent (no change). For capex_pct (a ratio driver), absent means
// "use baseline capex" while 0 means "override to 0% capex" — so stripping zeros
// is the correct semantic for all current drivers.
function nonZero(a: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(a).filter(([, v]) => v !== 0));
}

function periodLabel(p: string): string {
  const m = p.match(/^(\d{4})-(\d{2})$/);
  if (!m) return p;
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return months[parseInt(m[2], 10) - 1] ?? p;
}

// ── Mini delta tile ──────────────────────────────────────────────────────────
function DeltaTile({
  label, value, delta, unit = "", better = "higher",
}: {
  label: string; value: number; delta: number; unit?: string; better?: "higher" | "lower";
}) {
  const positive = better === "higher" ? delta >= 0 : delta <= 0;
  const tone = delta === 0 ? "text-fg-subtle" : positive ? "text-signal-good" : "text-signal-bad";
  const isPercent = unit === "%";
  const isDays = unit === "days";
  const fmt = isPercent
    ? (v: number) => `${v.toFixed(1)}%`
    : isDays
    ? (v: number) => `${Math.round(v)}d`
    : fmtCompact;
  const fmtDelta = isPercent
    ? (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}pp`
    : isDays
    ? (v: number) => `${v >= 0 ? "+" : ""}${Math.round(v)}d`
    : fmtSignedCompact;
  return (
    <div className="tile ring-1 ring-line p-3 flex flex-col">
      <div className="text-[10px] uppercase tracking-wide text-fg-subtle">{label}</div>
      <div className="text-xl font-bold num text-fg mt-1">{fmt(value)}</div>
      <div className={cn("text-xs font-medium num mt-1", tone)}>
        {delta === 0 ? <span className="text-fg-subtle">→</span> : <span>{delta > 0 ? "▲" : "▼"}</span>} {fmtDelta(delta)}
      </div>
    </div>
  );
}

// ── Trajectory chart workspace ───────────────────────────────────────────────
const CHART_PAD = { L: 54, R: 16, T: 22, B: 26 };

function TrajectoryMetricSelector({
  selected, onSelect,
}: {
  selected: TrajectoryMetricId;
  onSelect: (id: TrajectoryMetricId) => void;
}) {
  return (
    <div role="group" aria-label="Primary trajectory metric"
         className="inline-flex flex-wrap items-center gap-0.5 rounded-lg bg-black/[0.05] p-0.5">
      {TRAJECTORY_METRIC_ORDER.map((id) => {
        const def = trajectoryMetricDef(id);
        return (
          <button
            key={id}
            type="button"
            aria-pressed={selected === id}
            onClick={() => onSelect(id)}
            className={cn(
              "px-2.5 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap",
              selected === id
                ? "bg-ink-800 text-fg shadow-sm ring-1 ring-line"
                : "text-fg-muted hover:text-fg",
            )}
          >
            {def.label}
          </button>
        );
      })}
    </div>
  );
}

export function SecondaryTrajectoryChart({
  metricId, baseline, projection, periods, hingeIndex, onSelect,
}: {
  metricId: TrajectoryMetricId;
  baseline: number[];
  projection: number[];
  periods: string[];
  hingeIndex: number;
  onSelect: () => void;
}) {
  const def = trajectoryMetricDef(metricId);
  const summary = trajectoryEndSummary(baseline, projection, def.better);
  const positive = def.better === "higher" ? summary.delta >= 0 : summary.delta <= 0;
  const tone = summary.delta === 0 ? "text-fg-subtle" : positive ? "text-signal-good" : "text-signal-bad";

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={`Show ${def.label} as primary chart`}
      className="tile ring-1 ring-line rounded-xl p-3 text-left hover:ring-accent/35 hover:shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 flex flex-col min-w-0 h-full min-h-0"
    >
      <div className="text-[10px] uppercase tracking-wide text-fg-subtle">{def.label}</div>
      <div className="flex items-baseline justify-between gap-2 mt-1">
        <span className="text-lg font-bold num text-fg">{fmtCompact(summary.endProjection)}</span>
        <span className={cn("text-xs font-medium num", tone)}>
          <span className="text-fg-subtle" aria-hidden="true">→</span> {fmtSignedCompact(summary.delta)}
        </span>
      </div>
      <TrajectoryChart
        fill
        compact
        className="mt-2 w-full"
        label={def.label}
        baseline={baseline}
        projection={projection}
        periods={periods}
        hingeIndex={hingeIndex}
        better={def.better}
      />
    </button>
  );
}

function TrajectoryChart({
  label, baseline, projection, periods, hingeIndex, better = "higher",
  className = "", fill = false, compact = false,
}: {
  label: string;
  baseline: number[];
  projection: number[];
  periods: string[];
  hingeIndex: number;
  better?: "higher" | "lower";
  className?: string;
  /** Stretch to the measured container height (primary workspace chart). */
  fill?: boolean;
  /** Use a shorter complete chart for the two secondary trajectories. */
  compact?: boolean;
}) {
  const fallbackSize = compact
    ? { width: 400, height: 110 }
    : fill
      ? { width: 800, height: 190 }
      : { width: 300, height: 180 };
  const { ref, size } = useChartSize(fallbackSize);
  const [hoverI, setHoverI] = useState<number | null>(null);
  const n = periods.length;

  const geom = useMemo(() => {
    const W = size.width, H = size.height;
    const plotW = Math.max(W - CHART_PAD.L - CHART_PAD.R, 20);
    const plotH = Math.max(H - CHART_PAD.T - CHART_PAD.B, 40);

    const all = [...baseline, ...projection].filter(Number.isFinite);
    let yMin = Math.min(...all), yMax = Math.max(...all);
    const span = yMax - yMin || Math.abs(yMax) || 1;
    yMax += span * 0.1; yMin -= span * 0.1;

    const X = (i: number) => CHART_PAD.L + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const Y = (v: number) => CHART_PAD.T + (1 - (v - yMin) / (yMax - yMin || 1)) * plotH;

    const xs = Array.from({ length: n }, (_, i) => X(i));
    const bys = baseline.map(Y);
    const pys = projection.map(Y);

    const count = 3;
    const yTicks = Array.from({ length: count }, (_, i) => {
      const v = yMin + ((yMax - yMin) * i) / (count - 1);
      return { y: Y(v), label: fmtCompact(v) };
    });
    const hingeX = X(hingeIndex);

    const endBase = baseline[n - 1] ?? 0;
    const endProj = projection[n - 1] ?? 0;
    const diff = endProj - endBase;
    const projColor = projectionColor(diff, better);

    const xTickIdxs: number[] = [];
    for (let i = 0; i < n; i += 2) xTickIdxs.push(i);
    if (!xTickIdxs.includes(n - 1)) xTickIdxs.push(n - 1);

    return {
      plotW, plotH, xs, bys, pys, yTicks, hingeX,
      basePath: catmullRomPath(xs, bys),
      projPath: catmullRomPath(xs, pys),
      projColor,
      right: CHART_PAD.L + plotW,
      bottom: CHART_PAD.T + plotH,
      xTicks: xTickIdxs.map((i) => ({ x: X(i), label: periodLabel(periods[i] ?? "") })),
    };
  }, [baseline, projection, periods, hingeIndex, n, size, better]);

  return (
    <div className={cn(
      "flex flex-col",
      fill && (compact ? "flex-1 min-h-0" : "flex-none"),
      className,
    )}>
      {!fill && (
        <div className="text-[11px] text-fg-muted font-medium uppercase tracking-wide px-1 mb-1">{label}</div>
      )}
      <div ref={ref} className={cn(
        fill ? "flex-1" : "min-h-[180px]",
        compact ? "min-h-[110px]" : fill && "min-h-[190px]",
      )}>
        <svg width={size.width} height={size.height} viewBox={`0 0 ${size.width} ${size.height}`}
             className="font-sans"
             role="img" aria-label={label}>
          {/* Forecast tint */}
          <rect x={geom.hingeX} y={CHART_PAD.T}
                width={Math.max(geom.right - geom.hingeX, 0)} height={geom.plotH}
                fill={CHART_COLORS.seriesA} opacity="0.05" />

          {/* Grid + Y ticks */}
          {geom.yTicks.map((t, i) => (
            <g key={i}>
              <line x1={CHART_PAD.L} x2={geom.right} y1={t.y} y2={t.y}
                    stroke="rgba(23,25,32,0.07)" strokeWidth="1" />
              <text x={CHART_PAD.L - 5} y={t.y + 3} {...CHART_AXIS_TEXT_DENSE}
                    fill={CHART_COLORS.axis} textAnchor="end">
                {t.label}
              </text>
            </g>
          ))}

          {/* Now line — solid charcoal, clearly distinct from dashed baseline */}
          <line x1={geom.hingeX} x2={geom.hingeX} y1={CHART_PAD.T} y2={geom.bottom}
                stroke={CHART_COLORS.accent} strokeWidth="1.5" />
          <text x={geom.hingeX} y={CHART_PAD.T - 4} fontSize="9" fill={CHART_COLORS.accent}
                textAnchor="middle" fontWeight="600" letterSpacing="0.04em">NOW</text>

          {/* Baseline (dashed gray) */}
          <path d={geom.basePath} fill="none" stroke={CHART_COLORS.slate} strokeWidth="1.5"
                strokeDasharray="4 3" strokeLinejoin="round" strokeLinecap="round" />

          {/* Projection */}
          <path d={geom.projPath} fill="none" stroke={geom.projColor} strokeWidth="2"
                strokeLinejoin="round" strokeLinecap="round"
                className="transition-all duration-300 ease-out" />

          {/* X ticks */}
          {geom.xTicks.map((t, i) => (
            <text key={i} x={t.x} y={geom.bottom + 16} {...CHART_AXIS_TEXT_DENSE}
                  fill={CHART_COLORS.axis} textAnchor="middle">
              {t.label}
            </text>
          ))}

          {/* Hover target */}
          <rect
            x={CHART_PAD.L} y={CHART_PAD.T}
            width={geom.plotW} height={geom.plotH}
            fill="transparent"
            style={{ cursor: "crosshair" }}
            onMouseMove={(e) => {
              const svgEl = (e.currentTarget as Element).closest("svg") as SVGSVGElement;
              const rect = svgEl.getBoundingClientRect();
              const svgX = (e.clientX - rect.left) * (size.width / rect.width);
              const t = Math.max(0, Math.min(1, (svgX - CHART_PAD.L) / geom.plotW));
              setHoverI(Math.round(t * (n - 1)));
            }}
            onMouseLeave={() => setHoverI(null)}
          />

          {hoverI !== null && hoverI < n && (
            <g>
              <line
                x1={geom.xs[hoverI]} x2={geom.xs[hoverI]}
                y1={CHART_PAD.T} y2={geom.bottom}
                stroke={CHART_COLORS.ink} strokeWidth="1" strokeDasharray="2 2" opacity="0.5"
              />
              <circle cx={geom.xs[hoverI]} cy={geom.bys[hoverI]} r="2.5"
                      fill="#fff" stroke={CHART_COLORS.slate} strokeWidth="1.5" />
              <circle cx={geom.xs[hoverI]} cy={geom.pys[hoverI]} r="3"
                      fill="#fff" stroke={geom.projColor} strokeWidth="2" />
              {(() => {
                const tipW = 100, tipH = 52;
                const tipX = (geom.xs[hoverI] ?? 0) + 8 + tipW > geom.right
                  ? (geom.xs[hoverI] ?? 0) - tipW - 8
                  : (geom.xs[hoverI] ?? 0) + 8;
                const tipY = CHART_PAD.T + 4;
                const bv = baseline[hoverI] ?? 0;
                const pv = projection[hoverI] ?? 0;
                return (
                  <g>
                    <rect x={tipX} y={tipY} width={tipW} height={tipH} rx="5"
                          fill={CHART_COLORS.accent} opacity="0.9" />
                    <text x={tipX + 8} y={tipY + 14} fontSize="9" fill={CHART_COLORS.slate} fontWeight="600">
                      {periodLabel(periods[hoverI] ?? "")}
                    </text>
                    <text x={tipX + 8} y={tipY + 27} fontSize="9" fill={CHART_COLORS.slate}>
                      Base: {fmtCompact(bv)}
                    </text>
                    <text x={tipX + 8} y={tipY + 40} fontSize="9" fill={geom.projColor} fontWeight="600">
                      Scen: {fmtCompact(pv)}
                    </text>
                  </g>
                );
              })()}
            </g>
          )}
        </svg>
      </div>
      <div className="flex items-center gap-3 px-1 mt-1">
        <span className="flex items-center gap-1.5 text-[11px] text-fg-subtle">
          <span className="inline-block w-5 border-t border-dashed border-gray-400" />
          Baseline
        </span>
        <span className="flex items-center gap-1.5 text-[11px] text-fg-subtle">
          <span className="inline-block w-5 border-t-2" style={{ borderColor: geom.projColor }} />
          Scenario
        </span>
      </div>
    </div>
  );
}

// ── Slider primitives ────────────────────────────────────────────────────────
function SliderGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-fg-subtle mb-2">{label}</div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Slider({
  label, value, min, max, step, onChange, readout, disabled = false, direction = "positive",
}: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; readout: (v: number) => string;
  disabled?: boolean; direction?: "positive" | "negative";
}) {
  const better = direction === "positive" ? value > 0 : value < 0;
  const tone = value === 0 ? "text-fg-muted" : better ? "text-signal-good" : "text-signal-bad";
  const accentCls = value === 0 ? "accent-accent" : better ? "accent-signal-good" : "accent-signal-bad";
  return (
    <label className={cn("block", disabled && "opacity-50")}>
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-sm text-fg">{label}</span>
        <span className={cn("text-xs font-medium tabular-nums", tone)}>
          {readout(value)}
        </span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
             aria-label={label} disabled={disabled}
             onChange={(e) => onChange(parseFloat(e.target.value))}
             className={cn("w-full", accentCls, disabled ? "cursor-not-allowed" : "cursor-pointer")} />
    </label>
  );
}

function readout(id: string, v: number): string {
  if (v === 0) return "at baseline";
  if (id === "gross_margin") return `${v > 0 ? "+" : ""}${v}bps`;
  if (id === "capex_pct") return `${v.toFixed(1)}% of rev`;
  if (["dso","dpo","dio"].includes(id)) return `${v > 0 ? "+" : ""}${v}d`;
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
}

// ── Bridge waterfall chart ───────────────────────────────────────────────────
function BridgeChart({ result }: { result: BridgeResult }) {
  const { ref, size } = useChartSize({ width: 600, height: 220 });
  const { base, scenario, steps, residual, target } = result;

  // Build floating step (delta) bars
  const stepItems = [
    ...steps.map((s) => ({ label: s.label, value: s.value })),
    ...(Math.abs(residual) > 0.5 ? [{ label: "Interaction", value: residual }] : []),
  ];
  let running = base;
  const stepBars = stepItems.map((item) => {
    const start = running;
    running += item.value;
    return { ...item, start, end: running, isTotal: false,
             color: item.value >= 0 ? CHART_COLORS.good : CHART_COLORS.bad };
  });

  // Scale zoomed to actual data range — Base and Scenario bars anchor to paddedMin
  const allVals = [base, scenario, ...stepBars.flatMap((b) => [b.start, b.end])];
  const dataMin = Math.min(...allVals);
  const dataMax = Math.max(...allVals);
  const span = dataMax - dataMin || Math.abs(dataMax) || 1;
  const paddedMin = dataMin - span * 0.15;
  const paddedMax = dataMax + span * 0.08;

  const W = size.width, H = size.height;
  const padL = 70, padR = 12, padT = 20, padB = 32;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const Y = (v: number) => padT + (1 - (v - paddedMin) / (paddedMax - paddedMin)) * plotH;

  const allBars = [
    { label: "Base", value: base, start: paddedMin, end: base, isTotal: true, color: CHART_COLORS.ink },
    ...stepBars,
    { label: target === "cash" ? "End Cash" : "Op. Income",
      value: scenario, start: paddedMin, end: scenario,
      isTotal: true, color: scenario >= base ? CHART_COLORS.good : CHART_COLORS.bad },
  ];

  const gap = plotW / allBars.length;
  const barW = Math.max(10, gap * 0.55);

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const v = paddedMin + (paddedMax - paddedMin) * f;
    return { y: Y(v), label: fmtCompact(v) };
  });

  return (
    <div ref={ref} className="w-full" style={{ height: 220 }}>
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block font-sans" role="img" aria-label="Bridge waterfall">
      {yTicks.map((t, i) => (
        <g key={i}>
          <line x1={padL} x2={W - padR} y1={t.y} y2={t.y} stroke="rgba(23,25,32,0.07)" strokeWidth="1" />
          <text x={padL - 5} y={t.y + 3} {...CHART_AXIS_TEXT_PIXEL}
                fill={CHART_COLORS.axis} textAnchor="end">{t.label}</text>
        </g>
      ))}
      {allBars.map((bar, i) => {
        const cx = padL + i * gap + gap / 2;
        const y1 = Y(Math.max(bar.start, bar.end));
        const y2 = Y(Math.min(bar.start, bar.end));
        const bh = Math.max(2, y2 - y1);
        return (
          <g key={i}>
            <rect x={cx - barW / 2} y={y1} width={barW} height={bh}
                  fill={bar.color} rx="2" opacity={bar.isTotal ? 1 : 0.88} />
            {!bar.isTotal && i < allBars.length - 2 && (
              <line x1={cx + barW / 2} x2={cx + gap - barW / 2}
                    y1={Y(bar.end)} y2={Y(bar.end)}
                    stroke={CHART_COLORS.slate} strokeWidth="1" strokeDasharray="2 2" />
            )}
            {!bar.isTotal && (
              <text x={cx} y={y1 - 4} fontSize="8.5" fill={bar.color}
                    textAnchor="middle" fontWeight="600">
                {fmtSignedCompact(bar.value)}
              </text>
            )}
            <text x={cx} y={H - padB + 14} {...CHART_AXIS_TEXT_PIXEL}
                  fill={CHART_COLORS.ink} textAnchor="middle">
              {bar.label.length > 10 ? bar.label.slice(0, 9) + "…" : bar.label}
            </text>
          </g>
        );
      })}
    </svg>
    </div>
  );
}

// ── Status badge helpers ─────────────────────────────────────────────────────
type ScenarioStatus = "baseline" | "draft" | "committed" | "published" | "archived";

function statusLabel(s: ScenarioStatus): string {
  return s === "baseline" ? "baseline" : s === "published" ? "published"
    : s === "committed" ? "committed" : s === "draft" ? "draft" : s;
}

interface DriverChangeSummary {
  id: string;
  label: string;
  value: string;
}

export function ScenarioSummary({
  status, isBaseline, changes, creating, onCreate, onClone,
}: {
  status: ScenarioStatus;
  isBaseline: boolean;
  changes: DriverChangeSummary[];
  creating: boolean;
  onCreate: () => void;
  onClone: () => void;
}) {
  if (isBaseline) {
    return (
      <div className="space-y-2">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-fg-subtle">Scenario summary</div>
          <div className="text-sm font-semibold text-fg mt-1">Baseline reference</div>
          <p className="text-[11px] leading-relaxed text-fg-muted mt-1">
            Official reference case with no driver overrides.
          </p>
        </div>
        <button
          type="button"
          onClick={onCreate}
          disabled={creating}
          className="w-full rounded-xl text-sm font-semibold py-2.5 bg-accent text-white hover:bg-accent-600 disabled:opacity-50 transition ring-1 ring-accent/40"
        >
          {creating ? "Creating…" : "Create scenario from baseline"}
        </button>
      </div>
    );
  }

  if (status === "draft") {
    return (
      <div>
        <div className="text-[10px] uppercase tracking-wider text-fg-subtle">
          {changes.length ? "Active changes" : "Scenario summary"}
        </div>
        {changes.length ? (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {changes.map((change) => (
              <span key={change.id}
                    className="inline-flex items-center gap-1 rounded-lg bg-accent/[0.06] ring-1 ring-accent/15 px-2 py-1 text-[10px] text-fg-muted">
                <span>{change.label}</span>
                <span className="font-semibold num text-accent">{change.value}</span>
              </span>
            ))}
          </div>
        ) : (
          <p className="text-[11px] leading-relaxed text-fg-muted mt-1">
            No driver changes yet. Adjust an assumption to model a new outcome.
          </p>
        )}
      </div>
    );
  }

  const published = status === "published";
  return (
    <div className="space-y-2">
      <div>
        <div className="text-[10px] uppercase tracking-wider text-fg-subtle">Scenario summary</div>
        <div className="text-sm font-semibold text-fg mt-1">
          {published ? "Published scenario" : "Committed scenario"}
        </div>
        <p className="text-[11px] leading-relaxed text-fg-muted mt-1">
          {published
            ? "Official forecast. Clone it to explore another set of assumptions."
            : "Frozen for comparison. Clone it to continue planning."}
        </p>
      </div>
      <button
        type="button"
        onClick={onClone}
        className="w-full rounded-lg text-sm font-medium py-2 bg-black/[0.06] text-fg ring-1 ring-line hover:bg-black/[0.09] transition"
      >
        Clone to edit
      </button>
    </div>
  );
}

function statusCls(s: ScenarioStatus): string {
  if (s === "baseline")  return "bg-fg-muted/10 text-fg-muted ring-1 ring-fg-muted/30";
  if (s === "published") return "bg-signal-good/10 text-signal-good ring-1 ring-signal-good/30";
  if (s === "committed") return "bg-blue-500/10 text-blue-600 ring-1 ring-blue-500/30";
  return "bg-black/[0.05] text-fg-muted ring-1 ring-line"; // draft
}

function statusDotCls(s: ScenarioStatus, isBaseline = false): string {
  if (isBaseline || s === "baseline") return "bg-gray-400";
  if (s === "draft") return "bg-accent";
  if (s === "committed") return "bg-signal-good";
  return "bg-blue-500"; // published
}

// ── Commit confirmation modal ────────────────────────────────────────────────
function CommitModal({
  scenarioName, kpiTiles, onConfirm, onCancel, committing,
}: {
  scenarioName: string;
  kpiTiles: { label: string; value: number; delta: number; unit?: string; better?: "higher" | "lower" }[] | null;
  onConfirm: () => void;
  onCancel: () => void;
  committing: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
         onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div className="relative bg-[#f9f8f6] dark:bg-[#1e232b] rounded-2xl ring-1 ring-line shadow-xl w-full max-w-md p-6">
        <h2 className="text-base font-semibold text-fg mb-1">Commit scenario</h2>
        <p className="text-sm text-fg-muted mb-4">
          <span className="font-medium text-fg">"{scenarioName}"</span> will be frozen.
          Committed scenarios can't be edited — clone to make further changes.
        </p>

        {kpiTiles && (
          <div className="grid grid-cols-2 gap-2 mb-5">
            {kpiTiles.map((t) => (
              <DeltaTile key={t.label} label={t.label} value={t.value}
                         delta={t.delta} unit={t.unit} better={t.better} />
            ))}
          </div>
        )}

        <div className="flex gap-2">
          <button onClick={onCancel} disabled={committing}
                  className="flex-1 rounded-xl py-2.5 text-sm font-medium bg-black/[0.06] text-fg ring-1 ring-line hover:bg-black/[0.09] disabled:opacity-40 transition">
            Cancel
          </button>
          <button onClick={onConfirm} disabled={committing}
                  className="flex-1 rounded-xl py-2.5 text-sm font-medium bg-accent text-white hover:bg-accent-600 disabled:opacity-50 transition">
            {committing ? "Committing…" : "Commit & freeze"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Publish / Revoke confirmation modal ─────────────────────────────────────
function PublishModal({
  scenarioName, action, onConfirm, onCancel, pending,
}: {
  scenarioName: string;
  action: "publish" | "revoke";
  onConfirm: () => void;
  onCancel: () => void;
  pending: boolean;
}) {
  const isPublish = action === "publish";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
         onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div className="relative bg-[#f9f8f6] dark:bg-[#1e232b] rounded-2xl ring-1 ring-line shadow-xl w-full max-w-sm p-6">
        <h2 className="text-base font-semibold text-fg mb-2">
          {isPublish ? "Publish as official forecast" : "Revoke official forecast"}
        </h2>
        <p className="text-sm text-fg-muted mb-6">
          {isPublish ? (
            <>
              <span className="font-medium text-fg">"{scenarioName}"</span>
              {" "}will become the official forecast for this period.
              Any previously published scenario will be demoted back to committed.
            </>
          ) : (
            <>
              Remove <span className="font-medium text-fg">"{scenarioName}"</span> as
              the official forecast. The scenario stays committed and can be re-published later.
            </>
          )}
        </p>
        <div className="flex gap-2">
          <button onClick={onCancel} disabled={pending}
                  className="flex-1 rounded-xl py-2.5 text-sm font-medium bg-black/[0.06] text-fg ring-1 ring-line hover:bg-black/[0.09] disabled:opacity-40 transition">
            Cancel
          </button>
          <button onClick={onConfirm} disabled={pending}
                  className={cn(
                    "flex-1 rounded-xl py-2.5 text-sm font-semibold disabled:opacity-50 transition",
                    isPublish
                      ? "bg-accent text-white hover:bg-accent-600"
                      : "bg-signal-bad/10 text-signal-bad ring-1 ring-signal-bad/30 hover:bg-signal-bad/20"
                  )}>
            {pending ? (isPublish ? "Publishing…" : "Revoking…")
              : isPublish ? "Publish" : "Revoke"}
          </button>
        </div>
      </div>
    </div>
  );
}

function pendingPlanListItem(p: ScenarioPlan): PlanListItem {
  return {
    scenario_id: p.scenario_id, name: p.name, status: p.status,
    is_baseline: p.is_baseline, is_official: p.is_official,
    scope_type: p.scope_type, scope_id: p.scope_id,
    as_of_period: p.as_of_period, created_by: p.created_by, updated_ts: "",
    compare_eligible: false,
    compare_block_reason: "Checking comparison eligibility...",
  };
}

export function hasNonBaselineSelection(
  selectedIds: ReadonlySet<string>,
  baselineId: string,
): boolean {
  for (const scenarioId of selectedIds) {
    if (scenarioId && scenarioId !== baselineId) return true;
  }
  return false;
}

export function compareRequestTransition(
  mode: "plan" | "compare",
  hasCompareSelection: boolean,
): { shouldRequest: boolean; clearCompareResult: boolean; clearBridgeState: boolean } {
  if (mode !== "compare") {
    return { shouldRequest: false, clearCompareResult: false, clearBridgeState: false };
  }
  if (!hasCompareSelection) {
    return { shouldRequest: false, clearCompareResult: true, clearBridgeState: true };
  }
  return { shouldRequest: true, clearCompareResult: true, clearBridgeState: false };
}

export function compareFailureRecoveryTransition(
  mode: "plan" | "compare",
  hadCompareSelection: boolean,
): {
  clearCompareResult: boolean;
  refreshPlans: boolean;
  clearBridgeState: boolean;
  surfaceError: boolean;
} {
  if (mode !== "compare") {
    return {
      clearCompareResult: false,
      refreshPlans: false,
      clearBridgeState: false,
      surfaceError: false,
    };
  }
  return {
    clearCompareResult: true,
    refreshPlans: true,
    clearBridgeState: !hadCompareSelection,
    surfaceError: true,
  };
}

export function bridgeRequestTransition(
  bridgeScenarioId: string,
): { shouldRequest: boolean; clearBridgeResult: boolean } {
  if (!bridgeScenarioId) return { shouldRequest: false, clearBridgeResult: false };
  return { shouldRequest: true, clearBridgeResult: true };
}

export function normalizeCompareSelectionForPlans(
  selectedIds: ReadonlySet<string>,
  plans: readonly PlanListItem[],
  baselineId: string,
): Set<string> {
  const byId = new Map(plans.map((plan) => [plan.scenario_id, plan]));
  const filtered = new Set<string>();
  for (const scenarioId of selectedIds) {
    if (scenarioId === baselineId) {
      filtered.add(scenarioId);
      continue;
    }
    const plan = byId.get(scenarioId);
    if (!plan) continue;
    if (plan.is_baseline) continue;
    if (plan.compare_eligible === false) continue;
    filtered.add(scenarioId);
  }
  return normalizeCompareSelection(filtered, baselineId);
}

export function compareEffectiveSelectionKey(
  selectedIds: ReadonlySet<string>,
  baselineId: string,
): string {
  const normalized = normalizeCompareSelection(selectedIds, baselineId);
  const nonBaseline = Array.from(normalized)
    .filter((scenarioId) => scenarioId !== baselineId)
    .sort();
  return baselineId ? [baselineId, ...nonBaseline].join("|") : nonBaseline.join("|");
}

export function shouldStartCompareRequest(
  mode: "plan" | "compare",
  hasCompareSelection: boolean,
  effectiveSelectionKey: string,
  lastFailedSelectionKey: string | null,
): boolean {
  if (mode !== "compare" || !hasCompareSelection || !effectiveSelectionKey) return false;
  if (lastFailedSelectionKey && lastFailedSelectionKey === effectiveSelectionKey) return false;
  return true;
}

export function failedCompareKeyForSelection(
  hasCompareSelection: boolean,
  lastFailedSelectionKey: string | null,
): string | null {
  if (!hasCompareSelection) return null;
  return lastFailedSelectionKey;
}

export async function persistDraftAndCommit<T>(
  scenarioId: string,
  draft: { name: string; assumptions: Record<string, number> },
  patchDraft: (
    scenarioId: string,
    body: { name?: string; assumptions?: Record<string, number> },
  ) => Promise<unknown>,
  commitDraft: (scenarioId: string) => Promise<T>,
): Promise<T> {
  await patchDraft(scenarioId, draft);
  return commitDraft(scenarioId);
}

export function scenarioErrorAfterPageClick(error: string | null): string | null {
  if (
    error?.startsWith("This scenario matches ")
    && error.endsWith(". Change at least one driver.")
  ) {
    return null;
  }
  return error;
}

export function CompareSelectionPrompt(): JSX.Element {
  return (
    <div className="px-4 py-6 text-sm text-fg-subtle">
      Please select at least one scenario to compare.
    </div>
  );
}

export function MetricComparisonToolbar({
  plans,
  selectedIds,
  compareView,
  onChange,
  onSetCompareView,
  onRequestPublish,
}: {
  plans: PlanListItem[];
  selectedIds: Set<string>;
  compareView: "table" | "visual";
  onChange: (selected: Set<string>) => void;
  onSetCompareView: (view: "table" | "visual") => void;
  onRequestPublish: (plan: PlanListItem, action: "publish" | "revoke") => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
      <h2 className="mr-1 text-base font-semibold text-fg">
        Metric comparison
      </h2>
      <ScenarioComparePicker
        plans={plans}
        selectedIds={selectedIds}
        onChange={onChange}
        onRequestPublish={onRequestPublish}
      />
      <div
        role="group"
        aria-label="Metric comparison view"
        className="ml-auto inline-flex items-center gap-0.5 rounded-lg bg-black/[0.05] p-0.5"
      >
        {(["table", "visual"] as const).map((view) => (
          <button
            key={view}
            type="button"
            aria-pressed={compareView === view}
            onClick={() => onSetCompareView(view)}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors",
              compareView === view
                ? "bg-accent text-white shadow-sm"
                : "text-fg-muted hover:text-fg",
            )}
          >
            {view}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────
export default function ScenarioPlanning({ refreshKey, persona }: { refreshKey: number; persona: import("../api").Persona | null }) {
  const [mode, setMode] = useState<"plan" | "compare">("plan");

  // Catalog + plans list
  const [drivers, setDrivers] = useState<DriverDef[]>([]);
  const [plans, setPlans] = useState<PlanListItem[]>([]);
  const [loadingInit, setLoadingInit] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Plan mode state
  const [selectedId, setSelectedId] = useState<string>("");
  const [loadedPlan, setLoadedPlan] = useState<ScenarioPlan | null>(null);
  const [nameInput, setNameInput] = useState<string>("");
  const [assumptions, setAssumptions] = useState<Record<string, number>>(zeroPaddedAssumptions);
  const [projectResult, setProjectResult] = useState<ProjectResult | null>(null);
  const [projecting, setProjecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [commitModalOpen, setCommitModalOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishConfirm, setPublishConfirm] = useState<{
    scenarioId: string; scenarioName: string; action: "publish" | "revoke";
  } | null>(null);

  // Compare mode state
  const [compareChecked, setCompareChecked] = useState<Set<string>>(new Set());
  const [compareResult, setCompareResult] = useState<CompareResult | null>(null);
  const [compareView, setCompareView] = useState<"table" | "visual">("table");
  const [bridgeScenId, setBridgeScenId] = useState<string>("");
  const [bridgePickerOpen, setBridgePickerOpen] = useState(false);
  const [bridgeTarget, setBridgeTarget] = useState<"operating_income" | "cash">("operating_income");
  const [bridgeResult, setBridgeResult] = useState<BridgeResult | null>(null);
  const [loadingCompare, setLoadingCompare] = useState(false);
  const [loadingBridge, setLoadingBridge] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedTrajectoryMetric, setSelectedTrajectoryMetric] = useState<TrajectoryMetricId>("revenue");
  const baselineCompareId = useMemo(
    () => plans.find((plan) => plan.is_baseline)?.scenario_id ?? "",
    [plans],
  );
  const normalizedCompareChecked = useMemo(
    () => normalizeCompareSelection(compareChecked, baselineCompareId),
    [compareChecked, baselineCompareId],
  );
  const eligibleCompareChecked = useMemo(() => {
    const eligibleById = new Map(
      plans.map((plan) => [plan.scenario_id, plan.compare_eligible !== false]),
    );
    return new Set(
      Array.from(normalizedCompareChecked).filter(
        (scenarioId) => scenarioId === baselineCompareId || eligibleById.get(scenarioId) === true,
      ),
    );
  }, [plans, normalizedCompareChecked, baselineCompareId]);
  const hasCompareSelection = useMemo(
    () => hasNonBaselineSelection(eligibleCompareChecked, baselineCompareId),
    [eligibleCompareChecked, baselineCompareId],
  );
  const effectiveCompareKey = useMemo(
    () => compareEffectiveSelectionKey(eligibleCompareChecked, baselineCompareId),
    [eligibleCompareChecked, baselineCompareId],
  );
  const effectiveCompareIds = useMemo(
    () => (effectiveCompareKey ? effectiveCompareKey.split("|").filter(Boolean) : []),
    [effectiveCompareKey],
  );
  const lastFailedCompareKeyRef = useRef<string | null>(null);
  const refreshPlansFromServer = useCallback(
    async (preferredSelectedId?: string, shouldApply?: () => boolean) => {
      const pl = await api.scenarioPlans();
      if (shouldApply && !shouldApply()) return;
      setPlans(pl.plans);
      setUnavailable(pl.unavailable === true || pl.plans.length === 0);

      const baseline = pl.plans.find((p) => p.is_baseline);
      const availableIds = new Set(pl.plans.map((p) => p.scenario_id));
      setSelectedId((prev) => {
        const nextSelected = [preferredSelectedId, prev, baseline?.scenario_id, pl.plans[0]?.scenario_id]
          .find((id): id is string => !!id && availableIds.has(id));
        return nextSelected ?? "";
      });

      const baselineId = baseline?.scenario_id ?? "";
      setCompareChecked((prev) => {
        const keptExisting = new Set(
          Array.from(prev).filter((scenarioId) => scenarioId === baselineId || availableIds.has(scenarioId)),
        );
        return normalizeCompareSelectionForPlans(keptExisting, pl.plans, baselineId);
      });
    },
    [],
  );

  // Load drivers + plans
  useEffect(() => {
    let cancelled = false;
    setLoadingInit(true);
    setError(null);
    Promise.all([api.scenarioDrivers(), api.scenarioPlans()])
      .then(([dr, pl]) => {
        if (cancelled) return;
        setDrivers(dr.drivers);
        setPlans(pl.plans);
        // A healthy store always seeds Base/Worst/Best for the current period, so an
        // empty list (or the backend's explicit flag) means the scenario store is
        // unreachable — not a normal empty. Flag it so we show an unavailable state
        // rather than a phantom, un-committable draft.
        setUnavailable(pl.unavailable === true || pl.plans.length === 0);
        const baseline = pl.plans.find((p) => p.is_baseline);
        const first = baseline ?? pl.plans[0];
        if (first) setSelectedId(first.scenario_id);
        // Compare starts from a locked baseline only; users select scenarios manually.
        const defaultIds = baseline ? [baseline.scenario_id] : [];
        setCompareChecked(new Set(defaultIds));
      })
      .catch((e: Error) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoadingInit(false); });
    return () => { cancelled = true; };
  }, [refreshKey, reloadTick]);

  // Load the selected plan when selection changes
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    api.scenarioPlan(selectedId).then((plan) => {
      if (cancelled) return;
      setLoadedPlan(plan);
      setNameInput(plan.name);
      const a = zeroPaddedAssumptions();
      Object.entries(plan.assumptions).forEach(([k, v]) => { a[k] = v.value; });
      setAssumptions(a);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [selectedId]);

  // Debounced projection on assumption changes
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setProjecting(true);
      api.scenarioProject(nonZero(assumptions))
        .then(setProjectResult)
        .catch(() => {})
        .finally(() => setProjecting(false));
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [assumptions]);

  const setDriver = useCallback((id: string, v: number) => {
    setAssumptions((prev) => ({ ...prev, [id]: v }));
  }, []);

  const resetAssumptions = useCallback(() => {
    setAssumptions(zeroPaddedAssumptions());
  }, []);

  const allZero = useMemo(() => Object.values(assumptions).every((v) => v === 0), [assumptions]);

  // Dirty check: differs from loaded plan
  const isDirty = useMemo(() => {
    if (!loadedPlan) return false;
    return SLIDER_CFG.some((c) => {
      const loaded = loadedPlan.assumptions[c.id]?.value ?? 0;
      return assumptions[c.id] !== loaded;
    });
  }, [assumptions, loadedPlan]);

  // Derive from the lightweight plans list so the disabled state applies immediately
  // on selection, without waiting for the full plan detail to load.
  const selectedMeta = plans.find((p) => p.scenario_id === selectedId);
  const isCommitted = selectedMeta?.status === "committed";
  const isPublished = selectedMeta?.status === "published";
  const isReadOnly = isCommitted || isPublished;
  const isBaseline = selectedMeta?.is_baseline ?? false;
  const activeDriverChanges = useMemo<DriverChangeSummary[]>(() => (
    SLIDER_CFG
      .filter((cfg) => (assumptions[cfg.id] ?? 0) !== 0)
      .map((cfg) => ({
        id: cfg.id,
        label: drivers.find((driver) => driver.id === cfg.id)?.label ?? cfg.id,
        value: readout(cfg.id, assumptions[cfg.id] ?? 0),
      }))
  ), [assumptions, drivers]);

  const handleSave = useCallback(async () => {
    if (isReadOnly || isBaseline) return;
    if (!selectedId) {
      setError("No scenario selected — the scenario store may be unavailable. Refresh and try again.");
      return;
    }
    setSaving(true);
    try {
      const updated = await api.scenarioPatch(selectedId, {
        name: nameInput || "Untitled",
        assumptions: nonZero(assumptions),
      });
      setLoadedPlan(updated);
      setNameInput(updated.name);
      await refreshPlansFromServer(updated.scenario_id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }, [selectedId, nameInput, assumptions, isReadOnly, isBaseline, refreshPlansFromServer]);

  const handleCommit = useCallback(async () => {
    if (isReadOnly || isBaseline) return;
    if (!selectedId) {
      setError("No scenario selected — the scenario store may be unavailable. Refresh and try again.");
      return;
    }
    setCommitting(true);
    try {
      const updated = await persistDraftAndCommit(
        selectedId,
        {
          name: nameInput || "Untitled",
          assumptions: nonZero(assumptions),
        },
        api.scenarioPatch,
        api.scenarioCommit,
      );
      setLoadedPlan(updated);
      setNameInput(updated.name);
      await refreshPlansFromServer(updated.scenario_id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Commit failed");
    } finally {
      setCommitting(false);
    }
  }, [selectedId, nameInput, assumptions, isReadOnly, isBaseline, refreshPlansFromServer]);

  const handleCreate = useCallback(async () => {
    setCreating(true);
    try {
      const created = await api.scenarioCreate({ name: "New scenario" });
      setPlans((prev) => [pendingPlanListItem(created), ...prev]);
      setSelectedId(created.scenario_id);
      await refreshPlansFromServer(created.scenario_id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Create failed");
    } finally {
      setCreating(false);
    }
  }, [refreshPlansFromServer]);

  const handleArchive = useCallback(async () => {
    if (!selectedId || isBaseline) return;
    setArchiving(true);
    try {
      await api.scenarioArchive(selectedId);
      const remaining = plans.filter((p) => p.scenario_id !== selectedId);
      setPlans(remaining);
      const fallback = remaining.find((p) => p.is_baseline) ?? remaining[0];
      setSelectedId(fallback?.scenario_id ?? "");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Archive failed");
    } finally {
      setArchiving(false);
    }
  }, [selectedId, isBaseline, plans]);

  const handlePublish = useCallback(async (scenarioId: string, doPublish: boolean) => {
    setPublishing(true);
    try {
      const updated = doPublish
        ? await api.scenarioPublish(scenarioId)
        : await api.scenarioUnpublish(scenarioId);
      setPlans((prev) => prev.map((p) => ({
        ...p,
        status: doPublish
          ? (p.scenario_id === updated.scenario_id ? "published" : p.status === "published" ? "committed" : p.status)
          : (p.scenario_id === updated.scenario_id ? "committed" : p.status),
        is_official: doPublish ? p.scenario_id === updated.scenario_id
          : (p.scenario_id === updated.scenario_id ? false : p.is_official),
      })));
      if (selectedId === scenarioId) setLoadedPlan(updated);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setPublishing(false);
    }
  }, [selectedId]);

  const handleClone = useCallback(async () => {
    if (!selectedId) return;
    try {
      const cloned = await api.scenarioClone(selectedId);
      setPlans((prev) => [pendingPlanListItem(cloned), ...prev]);
      setSelectedId(cloned.scenario_id);
      await refreshPlansFromServer(cloned.scenario_id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Clone failed");
    }
  }, [selectedId, refreshPlansFromServer]);

  // Compare: load when checked set or mode changes
  useEffect(() => {
    const transition = compareRequestTransition(mode, hasCompareSelection);
    if (mode !== "compare") {
      lastFailedCompareKeyRef.current = null;
    }
    lastFailedCompareKeyRef.current = failedCompareKeyForSelection(
      hasCompareSelection,
      lastFailedCompareKeyRef.current,
    );
    if (!transition.shouldRequest && !transition.clearCompareResult && !transition.clearBridgeState) {
      return;
    }
    if (transition.clearCompareResult) setCompareResult(null);
    if (!transition.shouldRequest) {
      setLoadingCompare(false);
      if (transition.clearBridgeState) {
        setBridgeScenId("");
        setBridgeResult(null);
      }
      return;
    }
    if (!shouldStartCompareRequest(
      mode,
      hasCompareSelection,
      effectiveCompareKey,
      lastFailedCompareKeyRef.current,
    )) {
      setLoadingCompare(false);
      return;
    }
    let cancelled = false;
    const ids = effectiveCompareIds;
    setLoadingCompare(true);
    api.scenarioCompare(ids)
      .then((r) => {
        if (!cancelled) {
          lastFailedCompareKeyRef.current = null;
          setCompareResult(r);
        }
      })
      .catch(async (e: unknown) => {
        if (cancelled) return;
        lastFailedCompareKeyRef.current = effectiveCompareKey;
        const recovery = compareFailureRecoveryTransition(mode, hasCompareSelection);
        if (recovery.clearCompareResult) setCompareResult(null);
        if (recovery.clearBridgeState) {
          setBridgeScenId("");
          setBridgeResult(null);
        }
        if (recovery.surfaceError) {
          setError(e instanceof Error ? e.message : "Scenario comparison failed");
        }
        if (recovery.refreshPlans) {
          await refreshPlansFromServer(undefined, () => !cancelled);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingCompare(false);
      });
    return () => { cancelled = true; };
  }, [mode, effectiveCompareIds, effectiveCompareKey, hasCompareSelection, refreshPlansFromServer]);

  // Bridge
  useEffect(() => {
    const transition = bridgeRequestTransition(bridgeScenId);
    if (!transition.shouldRequest) return;
    if (transition.clearBridgeResult) setBridgeResult(null);
    let cancelled = false;
    setLoadingBridge(true);
    api.scenarioBridge({ scenario_id: bridgeScenId, target: bridgeTarget })
      .then((r) => {
        if (!cancelled) setBridgeResult(r);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setBridgeResult(null);
          setError(e instanceof Error ? e.message : "Bridge analysis failed");
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingBridge(false);
      });
    return () => { cancelled = true; };
  }, [bridgeScenId, bridgeTarget]);

  // ── KPI tiles from project result ─────────────────────────────────────────
  const kpiTiles = useMemo(() => {
    if (!projectResult) return null;
    const { baseline: bl, projection: pr } = projectResult;
    const h = bl.hinge_index;

    const blRevenue = fySum(bl.lines["revenue"]);
    const prRevenue = fySum(pr.lines["revenue"]);
    const blOI = fySum(bl.lines["operating_income"]);
    const prOI = fySum(pr.lines["operating_income"]);
    const blOM = forecastAvg(bl.kpis["operating_margin_pct"], h);
    const prOM = forecastAvg(pr.kpis["operating_margin_pct"], h);
    const blFCF = fySum(bl.lines["free_cash_flow"]);
    const prFCF = fySum(pr.lines["free_cash_flow"]);
    const blCashArr = bl.lines["cash_balance"] ?? [];
    const prCashArr = pr.lines["cash_balance"] ?? [];
    const blCashEnd = blCashArr.length ? blCashArr[blCashArr.length - 1]! : 0;
    const prCashEnd = prCashArr.length ? prCashArr[prCashArr.length - 1]! : 0;

    const tiles: { label: string; value: number; delta: number; unit?: string; better: "higher" | "lower" }[] = [
      { label: "Revenue",          value: prRevenue, delta: prRevenue - blRevenue, better: "higher" },
      { label: "Operating Income", value: prOI,      delta: prOI - blOI,           better: "higher" },
      { label: "Operating Margin", value: prOM,      delta: prOM - blOM, unit: "%", better: "higher" },
      { label: "Free Cash Flow",   value: prFCF,     delta: prFCF - blFCF,         better: "higher" },
      { label: "Cash (End)",       value: prCashEnd, delta: prCashEnd - blCashEnd, better: "higher" },
    ];

    // Cash conversion = DSO + DIO - DPO (days); only shown when working-capital kpis are present
    const blDSO = forecastAvg(bl.kpis["dso"], h);
    const blDIO = forecastAvg(bl.kpis["dio"], h);
    const blDPO = forecastAvg(bl.kpis["dpo"], h);
    if (blDSO || blDIO || blDPO) {
      const prDSO = forecastAvg(pr.kpis["dso"], h);
      const prDIO = forecastAvg(pr.kpis["dio"], h);
      const prDPO = forecastAvg(pr.kpis["dpo"], h);
      tiles.push({ label: "Cash Conversion", value: prDSO + prDIO - prDPO,
        delta: (prDSO + prDIO - prDPO) - (blDSO + blDIO - blDPO), unit: "days", better: "lower" });
    }

    return tiles;
  }, [projectResult]);

  // ── Non-baseline scenarios for the bridge picker ──────────────────────────
  const bridgeCandidates = useMemo(() => {
    return Array.from(eligibleCompareChecked)
      .map((id) => plans.find((p) => p.scenario_id === id))
      .filter((p): p is PlanListItem => !!p && !p.is_baseline);
  }, [eligibleCompareChecked, plans]);

  useEffect(() => {
    if (bridgeCandidates.length > 0 && !bridgeScenId) {
      setBridgeScenId(bridgeCandidates[0].scenario_id);
    }
    if (bridgeScenId && !bridgeCandidates.find((c) => c.scenario_id === bridgeScenId)) {
      setBridgeScenId(bridgeCandidates[0]?.scenario_id ?? "");
    }
  }, [bridgeCandidates, bridgeScenId]);

  const groupedPlans = useMemo(() => ({
    base:      plans.filter((p) => p.is_baseline),
    drafts:    plans.filter((p) => !p.is_baseline && p.status === "draft"),
    committed: plans.filter((p) => p.status === "committed"),
    published: plans.filter((p) => p.status === "published"),
  }), [plans]);

  const horizonLabel = useMemo(() => {
    if (!projectResult) return null;
    const { periods, hinge_index } = projectResult.baseline;
    const forecast = periods.slice(hinge_index + 1);
    if (!forecast.length) return null;
    const first = periodLabel(forecast[0]!);
    const last  = periodLabel(forecast[forecast.length - 1]!);
    return first === last ? first : `${first}-${last}`;
  }, [projectResult]);

  const asOfFormatted = useMemo(() => {
    const p = selectedMeta?.as_of_period;
    if (!p) return null;
    const [year, month] = p.split("-");
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return `${months[parseInt(month!, 10) - 1]} ${year}`;
  }, [selectedMeta?.as_of_period]);

  // ── Render ────────────────────────────────────────────────────────────────
  if (loadingInit) {
    return (
      <SkeletonRegion className="flex-1 min-h-0 flex flex-col gap-4 pb-2">
        <Skeleton className="h-9 w-36 rounded-xl" />
        <div className="grid grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)] gap-4 flex-1 items-stretch">
          <div className="order-1 lg:order-2 flex flex-col gap-4 min-h-[280px]">
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
              {[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-20 rounded-xl" />)}
            </div>
            <CardSkeleton action className="flex-1"><ChartSkeleton height={260} /></CardSkeleton>
          </div>
          <div className="order-2 lg:order-1 tile ring-1 ring-line p-4 space-y-4 min-h-[320px] lg:max-w-[320px]">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="space-y-2">
                <div className="flex justify-between"><Skeleton className="h-3 w-28" /><Skeleton className="h-3 w-10" /></div>
                <Skeleton className="h-1.5 w-full rounded-full" />
              </div>
            ))}
          </div>
        </div>
      </SkeletonRegion>
    );
  }

  // No scenarios loaded. A healthy store always seeds Base/Worst/Best for the
  // current period, so this only happens when the scenario store (Lakebase) is
  // unreachable. Show an honest unavailable state with a retry — never a phantom,
  // editable draft whose Save/Commit would silently no-op (no scenario_id to write).
  if (unavailable || plans.length === 0) {
    return (
      <div className="flex-1 min-h-0 flex flex-col gap-4 pb-2">
        <Card className="flex-1">
          <div className="h-full flex flex-col items-center justify-center text-center px-6 py-16 gap-3">
            <div className="w-10 h-10 rounded-full bg-black/[0.05] flex items-center justify-center text-fg-subtle">
              <svg className="w-5 h-5" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M10 6.5v4M10 13.5h.01M3.5 10a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z"
                      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <div className="text-sm font-semibold text-fg">Scenario library unavailable</div>
            <p className="text-xs text-fg-muted max-w-sm">
              The scenario store couldn&apos;t be reached, so no scenarios could be loaded.
              Planning is disabled until it&apos;s back — try again in a moment.
            </p>
            <button type="button" onClick={() => setReloadTick((t) => t + 1)}
                    className="mt-1 rounded-lg text-sm font-medium py-2 px-4 bg-black/[0.06] text-fg ring-1 ring-line hover:bg-black/[0.09] transition">
              Retry
            </button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div
      className="flex-1 min-h-0 flex flex-col gap-4 pb-2"
      onClickCapture={() => setError((current) => scenarioErrorAfterPageClick(current))}
    >
      {/* ── Context bar: view mode + scenario picker + horizon on one row ── */}
      <div className="flex flex-wrap items-center gap-3 px-1">
        <div role="group" aria-label="View mode" className="inline-flex gap-1 shrink-0">
          {(["plan", "compare"] as const).map((m) => (
            <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}
                    className={cn(
                      "px-4 py-2 rounded-xl text-sm font-medium transition-colors ring-1",
                      mode === m
                        ? "bg-ink-800 text-fg ring-line shadow-sm"
                        : "ring-line text-fg-muted bg-transparent hover:text-fg hover:bg-black/[0.04]"
                    )}>
              {m === "plan" ? "Plan" : "Compare"}
            </button>
          ))}
        </div>

        {mode === "plan" && (
          <>
            <span className="h-6 w-px bg-line shrink-0" aria-hidden="true" />
            <div className="relative">
              {pickerOpen && <div className="fixed inset-0 z-10" onClick={() => setPickerOpen(false)} />}
              <button type="button" onClick={() => setPickerOpen((o) => !o)}
                      className="relative z-20 flex items-center gap-2 rounded-2xl ring-2 ring-accent/25 px-3 py-2 text-fg hover:ring-accent/50 transition focus:outline-none"
                      style={{ background: "var(--color-surface, #fff)" }}>
                <span className={cn("w-2 h-2 rounded-full shrink-0",
                  statusDotCls((selectedMeta?.status ?? "draft") as ScenarioStatus, selectedMeta?.is_baseline))} />
                <span className="text-sm font-semibold">{selectedMeta?.name ?? "Select scenario"}</span>
                <span className={cn("text-[10px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wide leading-none",
                  statusCls((selectedMeta?.status ?? "draft") as ScenarioStatus))}>
                  {selectedMeta?.is_baseline ? "BASE" : statusLabel((selectedMeta?.status ?? "draft") as ScenarioStatus).toUpperCase()}
                </span>
                <svg className={cn("w-4 h-4 text-fg-subtle shrink-0 transition-transform", pickerOpen && "rotate-180")}
                     viewBox="0 0 16 16" fill="none">
                  <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>

              {pickerOpen && (
                <div className="absolute top-full left-0 mt-1 z-20 w-72 rounded-xl ring-1 ring-line shadow-lg overflow-hidden"
                     style={{ background: "var(--color-surface, #fff)" }}>
                  {selectedMeta?.as_of_period && (
                    <div className="px-3 pt-3 pb-1 text-[10px] uppercase tracking-wider text-fg-subtle font-semibold">
                      {selectedMeta.as_of_period} · FY{selectedMeta.as_of_period.slice(2, 4)} FORECAST
                    </div>
                  )}
                  {(["base", "drafts", "committed", "published"] as const).map((group) => {
                    const items = groupedPlans[group];
                    if (!items.length) return null;
                    const groupLabel = group === "base" ? "Base" : group.charAt(0).toUpperCase() + group.slice(1);
                    return (
                      <div key={group}>
                        <div className="px-3 pt-2 pb-0.5 text-[9px] uppercase tracking-wider text-fg-subtle">{groupLabel}</div>
                        {items.map((p) => (
                          <button key={p.scenario_id} type="button"
                                  onClick={() => { setSelectedId(p.scenario_id); setPickerOpen(false); }}
                                  className={cn("w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left hover:bg-black/[0.04] transition",
                                    p.scenario_id === selectedId && "bg-black/[0.04]")}>
                            <span className={cn("w-2 h-2 rounded-full shrink-0", statusDotCls(p.status as ScenarioStatus, p.is_baseline))} />
                            <span className="flex-1 truncate text-fg">{p.name}</span>
                            <span className={cn("text-[10px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wide leading-none shrink-0",
                              statusCls(p.status as ScenarioStatus))}>
                              {p.is_baseline ? "BASE" : p.status.toUpperCase()}
                            </span>
                            <span className={cn("shrink-0 w-3.5 h-3.5", p.scenario_id !== selectedId && "invisible")}>
                              <svg viewBox="0 0 12 12" fill="none" className="w-3.5 h-3.5 text-accent">
                                <path d="M2 6l2.5 2.5L10 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                              </svg>
                            </span>
                          </button>
                        ))}
                      </div>
                    );
                  })}
                  <div className="border-t border-line/50 mt-1">
                    <button type="button" onClick={() => { void handleCreate(); setPickerOpen(false); }} disabled={creating}
                            className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-fg-muted hover:text-fg hover:bg-black/[0.04] disabled:opacity-40 transition">
                      <svg viewBox="0 0 12 12" fill="none" className="w-3 h-3 shrink-0">
                        <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"/>
                      </svg>
                      {creating ? "Creating…" : "New scenario"}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {(selectedMeta?.as_of_period || horizonLabel) && (
              <span className="text-sm text-fg-subtle">
                {selectedMeta?.as_of_period && `as of ${selectedMeta.as_of_period}`}
                {horizonLabel && ` · horizon ${horizonLabel}`}
              </span>
            )}
          </>
        )}

        <div className="flex-1" />
      </div>

      {error && <ErrorNote message={error} />}

      {mode === "plan" ? (
        <div className="flex-1 min-h-0 flex flex-col gap-4">

          {/* ── Main content grid: analysis first on narrow, driver rail first on lg+ ── */}
          <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)] gap-4 items-stretch">

          {/* ── Analysis panel ── */}
          <div className="order-1 lg:order-2 flex flex-col gap-4 min-w-0 min-h-0">
            {/* KPI tiles — up to 6 across */}
            {projectResult && kpiTiles ? (
              <div className={cn("grid gap-3", kpiTiles.length >= 6 ? "grid-cols-3 sm:grid-cols-6" : "grid-cols-2 sm:grid-cols-5")}>
                {kpiTiles.map((t) => (
                  <DeltaTile key={t.label} label={t.label} value={t.value}
                             delta={t.delta} unit={t.unit} better={t.better} />
                ))}
              </div>
            ) : (
              <SkeletonRegion className="grid grid-cols-3 sm:grid-cols-6 gap-3">
                {[0,1,2,3,4,5].map((i) => (
                  <div key={i} className="tile ring-1 ring-line rounded-xl h-20 p-3 flex flex-col gap-2">
                    <Skeleton className="h-2.5 w-16" />
                    <Skeleton className="h-5 w-14" />
                    <Skeleton className="mt-auto h-2.5 w-10" />
                  </div>
                ))}
              </SkeletonRegion>
            )}

            {/* Primary trajectory + secondary metric cards */}
            <Card
              fill
              className="flex-1 min-h-0"
              title={projectedTrajectoryTitle(selectedTrajectoryMetric)}
              subtitle={projecting ? "Updating…" : `${selectedMeta?.as_of_period ? `FY${selectedMeta.as_of_period.slice(0, 4)}` : "FY"} · scenario vs baseline`}
              action={projectResult ? (
                <TrajectoryMetricSelector
                  selected={selectedTrajectoryMetric}
                  onSelect={setSelectedTrajectoryMetric}
                />
              ) : undefined}
            >
              {projectResult ? (() => {
                const metricDef = trajectoryMetricDef(selectedTrajectoryMetric);
                const baseline = projectResult.baseline.lines[metricDef.lineKey] ?? [];
                const projection = projectResult.projection.lines[metricDef.lineKey] ?? [];
                const secondaryIds = otherTrajectoryMetrics(selectedTrajectoryMetric);
                return (
                  <div className="px-4 pb-4 pt-2 flex-1 min-h-0 flex flex-col gap-3">
                    <TrajectoryChart
                      fill
                      label={metricDef.label}
                      baseline={baseline}
                      projection={projection}
                      periods={projectResult.baseline.periods}
                      hingeIndex={projectResult.baseline.hinge_index}
                      better={metricDef.better}
                    />
                    <div className={SECONDARY_TRAJECTORY_GRID_CLASS}>
                      {secondaryIds.map((id) => {
                        const secDef = trajectoryMetricDef(id);
                        return (
                          <SecondaryTrajectoryChart
                            key={id}
                            metricId={id}
                            baseline={projectResult.baseline.lines[secDef.lineKey] ?? []}
                            projection={projectResult.projection.lines[secDef.lineKey] ?? []}
                            periods={projectResult.baseline.periods}
                            hingeIndex={projectResult.baseline.hinge_index}
                            onSelect={() => setSelectedTrajectoryMetric(id)}
                          />
                        );
                      })}
                    </div>
                  </div>
                );
              })() : (
                <div className="px-4 pb-4 pt-2 flex-1 min-h-0 flex flex-col gap-3">
                  <Skeleton className="flex-1 min-h-[260px] rounded-lg" />
                  <div className={SECONDARY_TRAJECTORY_GRID_CLASS}>
                    {[0, 1].map((i) => (
                      <Skeleton key={i} className="h-[188px] rounded-xl" />
                    ))}
                  </div>
                </div>
              )}
            </Card>
          </div>

          {/* ── Driver rail: equal-height desktop card + pinned scenario summary ── */}
          <Card
            fill
            className="order-2 lg:order-1 min-h-0 w-full lg:self-stretch lg:h-full"
          >
            <div className="flex-1 min-h-0 overflow-y-auto">
              <div className="px-4 py-4 space-y-4">
                {/* Name editor (draft only) */}
                {!isReadOnly && !isBaseline && (
                  <div>
                    <label className="block text-[11px] uppercase tracking-wider text-fg-subtle mb-1.5">
                      Scenario name
                    </label>
                    <input type="text" value={nameInput} onChange={(e) => setNameInput(e.target.value)}
                           className="w-full text-sm bg-transparent ring-1 ring-line rounded-lg px-3 py-2 text-fg focus:outline-none focus:ring-accent"
                           placeholder="Untitled" />
                  </div>
                )}

                <SliderGroup label="P&L drivers">
                  {SLIDER_CFG.filter((c) => ["revenue_growth","gross_margin","opex_growth","capex_pct"].includes(c.id)).map((cfg) => {
                    const def = drivers.find((d) => d.id === cfg.id);
                    return (
                      <Slider key={cfg.id}
                              label={def?.label ?? cfg.id}
                              value={assumptions[cfg.id] ?? 0}
                              min={cfg.min} max={cfg.max} step={cfg.step}
                              onChange={(v) => setDriver(cfg.id, v)}
                              readout={(v) => readout(cfg.id, v)}
                              direction={DRIVER_BETTER[cfg.id]}
                              disabled={isReadOnly || isBaseline} />
                    );
                  })}
                </SliderGroup>

                <Section title="Working capital" defaultOpen={false} collapsible tone="quiet">
                  <div className="px-4 py-3 space-y-3">
                    {SLIDER_CFG.filter((c) => ["dso","dpo","dio"].includes(c.id)).map((cfg) => {
                      const def = drivers.find((d) => d.id === cfg.id);
                      return (
                        <Slider key={cfg.id}
                                label={def?.label ?? cfg.id}
                                value={assumptions[cfg.id] ?? 0}
                                min={cfg.min} max={cfg.max} step={cfg.step}
                                onChange={(v) => setDriver(cfg.id, v)}
                                readout={(v) => readout(cfg.id, v)}
                                direction={DRIVER_BETTER[cfg.id]}
                                disabled={isReadOnly || isBaseline} />
                      );
                    })}
                  </div>
                </Section>

                <OffLensAssumptions drivers={drivers} assumptions={assumptions} editableIds={SLIDER_IDS} />
              </div>
            </div>

            <div className="shrink-0 border-t border-line px-4 py-3 flex flex-col gap-3">
              <ScenarioSummary
                status={(selectedMeta?.status ?? "draft") as ScenarioStatus}
                isBaseline={isBaseline}
                changes={activeDriverChanges}
                creating={creating}
                onCreate={() => { void handleCreate(); }}
                onClone={() => { void handleClone(); }}
              />

              {!isBaseline && !isReadOnly && (
                <>
                  <div className="flex gap-2">
                    <button onClick={resetAssumptions} disabled={allZero}
                            className="flex-1 rounded-lg text-sm font-medium py-2 bg-black/[0.06] text-fg ring-1 ring-line disabled:opacity-40 hover:bg-black/[0.09] transition">
                      Reset
                    </button>
                    <button onClick={handleSave} disabled={!isDirty || saving}
                            className="flex-1 rounded-lg text-sm font-medium py-2 bg-black/[0.06] text-fg ring-1 ring-line disabled:opacity-40 hover:bg-black/[0.09] transition">
                      {saving ? "Saving…" : "Save draft"}
                    </button>
                  </div>
                  <button onClick={() => setCommitModalOpen(true)}
                          className="w-full rounded-xl text-sm font-semibold py-2.5 bg-accent text-white hover:bg-accent-600 transition ring-1 ring-accent/40">
                    Commit &amp; freeze
                  </button>
                  <p className="text-[10px] text-fg-subtle text-center">
                    Frozen scenarios can be compared and published as the official forecast
                  </p>
                </>
              )}

              {!isBaseline && (
                <button type="button" onClick={handleArchive} disabled={archiving}
                        className="w-full text-[11px] text-fg-subtle hover:text-signal-bad disabled:opacity-40 transition py-1">
                  {archiving ? "Archiving…" : "Archive scenario"}
                </button>
              )}
            </div>
          </Card>
        </div>
        </div>
      ) : (
        /* ── Compare mode ── */
        <div className="flex-1 min-h-0 flex flex-col gap-4">
          {/* Metric matrix */}
          <Card>
            <MetricComparisonToolbar
              plans={plans}
              selectedIds={eligibleCompareChecked}
              compareView={compareView}
              onChange={(selected) => setCompareChecked(normalizeCompareSelection(selected, baselineCompareId))}
              onSetCompareView={setCompareView}
              onRequestPublish={(plan, action) => setPublishConfirm({
                scenarioId: plan.scenario_id,
                scenarioName: plan.name,
                action,
              })}
            />
            {loadingCompare ? (
              <SkeletonRegion><TableSkeleton rows={5} cols={4} /></SkeletonRegion>
            ) : compareResult ? (
              compareView === "visual" ? (
                <MetricComparisonVisual result={compareResult} />
              ) : (
                <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line">
                      <th className="px-4 py-2 text-left text-[11px] uppercase tracking-wide text-fg-subtle font-medium w-36">
                        Metric
                      </th>
                      <th className="px-3 py-2 text-right text-[11px] uppercase tracking-wide text-fg-subtle font-medium">
                        Baseline
                      </th>
                      {compareResult.scenarios.filter((s) => !s.is_baseline).map((s) => (
                        <th key={s.scenario_id}
                            className="px-3 py-2 text-right text-[11px] uppercase tracking-wide text-fg-subtle font-medium">
                          {s.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {METRIC_DEFS.map((m) => {
                      const baseVal = extractMetric(compareResult.base, m.key);
                      return (
                        <tr key={m.key} className="border-b border-line/50 record-row-hover">
                          <td className="px-4 py-2 text-fg-muted text-[12px]">{m.label}</td>
                          <td className="px-3 py-2 text-right num text-fg font-medium text-[12px]">
                            {fmtMetric(baseVal, m.unit)}
                          </td>
                          {compareResult.scenarios.filter((s) => !s.is_baseline).map((s) => {
                            const val = extractMetric(s.projection, m.key);
                            const diff = val - baseVal;
                            const positive = m.better === "higher" ? diff >= 0 : diff <= 0;
                            const tone = Math.abs(diff) < 0.01 ? ""
                              : positive ? "text-signal-good" : "text-signal-bad";
                            return (
                              <td key={s.scenario_id}
                                  className={cn("px-3 py-2 text-right num text-[12px]", tone)}>
                                {fmtMetric(val, m.unit)}
                                {Math.abs(diff) >= 0.01 && (
                                  <span className="ml-1 text-[10px] opacity-70">
                                    ({diff >= 0 ? "+" : ""}{fmtMetric(diff, m.unit)})
                                  </span>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              )
            ) : <CompareSelectionPrompt />}
          </Card>

          {/* Bridge */}
          {bridgeCandidates.length > 0 && (
            <Card title="Bridge analysis">
              <div className="px-4 py-3 flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2 text-sm text-fg-muted">
                  Bridge to
                  <div className="relative">
                    {bridgePickerOpen && (
                      <div className="fixed inset-0 z-10" onClick={() => setBridgePickerOpen(false)} />
                    )}
                    <button type="button" onClick={() => setBridgePickerOpen((o) => !o)}
                            className="relative z-20 flex items-center gap-1.5 text-sm text-fg ring-1 ring-line rounded-xl px-3 py-1.5 hover:ring-accent/50 transition focus:outline-none">
                      <span>{bridgeCandidates.find((c) => c.scenario_id === bridgeScenId)?.name ?? "Select"}</span>
                      <svg className={cn("w-3.5 h-3.5 text-fg-subtle transition-transform", bridgePickerOpen && "rotate-180")}
                           viewBox="0 0 16 16" fill="none">
                        <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </button>
                    {bridgePickerOpen && (
                      <div className="absolute top-full left-0 mt-1 z-20 min-w-[140px] rounded-xl ring-1 ring-line shadow-lg overflow-hidden bg-[#f9f8f6] dark:bg-[#1e232b]">
                        {bridgeCandidates.map((c) => (
                          <button key={c.scenario_id} type="button"
                                  onClick={() => { setBridgeScenId(c.scenario_id); setBridgePickerOpen(false); }}
                                  className={cn(
                                    "w-full flex items-center gap-2 px-3 py-2.5 text-sm text-left transition hover:bg-black/[0.04]",
                                    c.scenario_id === bridgeScenId && "bg-black/[0.04]"
                                  )}>
                            <span className={cn("w-3.5 h-3.5 shrink-0", c.scenario_id !== bridgeScenId && "invisible")}>
                              <svg viewBox="0 0 12 12" fill="none" className="w-3 h-3 text-accent">
                                <path d="M2 6l2.5 2.5L10 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                              </svg>
                            </span>
                            <span className="text-fg">{c.name}</span>
                            <span className={cn("ml-auto text-[10px] px-1.5 py-0.5 rounded-full shrink-0",
                              statusCls(c.status as ScenarioStatus))}>
                              {c.status}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div role="group" aria-label="Bridge target"
                     className="inline-flex items-center gap-0.5 rounded-lg bg-black/[0.05] p-0.5">
                  {(["operating_income", "cash"] as const).map((t) => (
                    <button key={t} type="button" aria-pressed={bridgeTarget === t}
                            onClick={() => setBridgeTarget(t)}
                            className={cn("px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
                              bridgeTarget === t
                                ? "bg-ink-800 text-fg shadow-sm ring-1 ring-line"
                                : "text-fg-muted hover:text-fg")}>
                      {t === "operating_income" ? "Operating Income" : "Cash"}
                    </button>
                  ))}
                </div>
              </div>
              {loadingBridge ? (
                <SkeletonRegion><BarChartSkeleton bars={7} height={140} /></SkeletonRegion>
              ) : bridgeResult ? (
                <div className="px-4 pb-4">
                  <div className="flex items-center gap-4 mb-2 text-xs text-fg-subtle">
                    <span>Base <span className="font-semibold text-fg num">{fmtCompact(bridgeResult.base)}</span></span>
                    <span>→</span>
                    <span>Scenario <span className="font-semibold text-fg num">{fmtCompact(bridgeResult.scenario)}</span></span>
                    <span className={cn("font-semibold num",
                      bridgeResult.total >= 0 ? "text-signal-good" : "text-signal-bad")}>
                      {fmtSignedCompact(bridgeResult.total)}
                    </span>
                  </div>
                  <BridgeChart result={bridgeResult} />
                </div>
              ) : (
                <div className="px-4 pb-4 text-sm text-fg-subtle">Select a scenario above.</div>
              )}
            </Card>
          )}
        </div>
      )}

      {/* Publish / Revoke confirmation modal */}
      {publishConfirm && (
        <PublishModal
          scenarioName={publishConfirm.scenarioName}
          action={publishConfirm.action}
          pending={publishing}
          onConfirm={() => {
            handlePublish(publishConfirm.scenarioId, publishConfirm.action === "publish");
            setPublishConfirm(null);
          }}
          onCancel={() => setPublishConfirm(null)}
        />
      )}

      {/* Commit confirmation modal */}
      {commitModalOpen && (
        <CommitModal
          scenarioName={nameInput || loadedPlan?.name || ""}
          kpiTiles={kpiTiles}
          onConfirm={() => { setCommitModalOpen(false); handleCommit(); }}
          onCancel={() => setCommitModalOpen(false)}
          committing={committing}
        />
      )}
    </div>
  );
}
