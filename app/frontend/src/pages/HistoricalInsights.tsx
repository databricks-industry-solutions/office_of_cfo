import { useEffect, useId, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Sparkles } from "lucide-react";
import {
  api, HistArea, HistoricalInsights as HistData, HistPoint, HistNarrative, Scope,
} from "../api";
import { Card, CardSkeleton, ChartSkeleton, ErrorNote, Skeleton, SkeletonRegion, TableSkeleton, TextSkeleton } from "../components/ui";
import { CHART_AXIS_TEXT_PIXEL, CHART_COLORS } from "../lib/chartPalette";
import { useChartSize } from "../lib/useChartSize";
import { useOverlay } from "../lib/industry";

// Metric catalog. dso/dpo/dio/ccc labels are relabeled per industry via the
// overlay; revenue / net income are universal. `kind` drives the default chart
// shape — rate metrics read best as a line, currency amounts as columns.
type MetricDef = { id: keyof HistPoint; label: string; unit: string; lower: boolean; kind: "rate" | "money" };
const BASE_METRICS: MetricDef[] = [
  { id: "ccc", label: "Cash Conversion Cycle", unit: "days", lower: true, kind: "rate" },
  { id: "revenue", label: "Revenue", unit: "", lower: false, kind: "money" },
  { id: "net_income", label: "Net Income", unit: "", lower: false, kind: "money" },
  { id: "dso", label: "DSO", unit: "days", lower: true, kind: "rate" },
  { id: "dpo", label: "DPO", unit: "days", lower: false, kind: "rate" },
  { id: "dio", label: "DIO", unit: "days", lower: true, kind: "rate" },
];

const monthLabel = (p: string) => {
  const [y, m] = p.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleString("en-US", { month: "short", year: "2-digit" });
};

// Split the AI narrative prose into clean bullet highlights (handles both
// sentence-per-line prose and any "- " bullets the model might return).
function toBullets(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9£$])/)
    .map((s) => s.replace(/^\s*[-•*]\s*/, "").trim())
    .filter((s) => s.length > 1)
    .slice(0, 4);
}

function fmt(v: number | null | undefined, unit: string): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (unit === "days") return `${v.toFixed(1)}`;
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
}

// Straight segments only: curve interpolation would soften month-over-month
// shocks and imply values between periods that were never reported.
function polylinePath(pts: { x: number; y: number }[]): string {
  return pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
}

function DeltaBadge({ value, lower, suffix }: { value: number | null; lower: boolean; suffix: string }) {
  if (value == null) return null;
  const good = value === 0 ? null : lower ? value < 0 : value > 0;
  const tone = good == null ? "text-fg-subtle bg-black/[0.04]"
    : good ? "text-signal-good bg-signal-good/10" : "text-signal-bad bg-signal-bad/10";
  const arrow = value === 0 ? "→" : value > 0 ? "▲" : "▼";
  return (
    <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${tone}`}>
      {arrow} {suffix}
    </span>
  );
}

// ---- Polished trend chart: gradient area / smooth line OR animated columns,
//      with an optional trailing-average control band + hover tooltip. ----------
function TrendChart({
  points, metric, band, mode,
}: {
  points: HistPoint[];
  metric: MetricDef;
  band?: { mean: number; std: number } | null;
  mode: "line" | "bars";
}) {
  const gid = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const { ref: wrapRef, size } = useChartSize({ width: 660, height: 250 });
  const [hover, setHover] = useState<number | null>(null);
  const W = size.width, H = size.height, padL = 44, padR = 16, padT = 18, padB = 28;

  const vals = points.map((p) => Number(p[metric.id]));
  if (vals.length < 2) return <div className="text-sm text-fg-subtle px-2 py-10 text-center">Not enough history yet.</div>;

  let min = Math.min(...vals), max = Math.max(...vals);
  if (band) { min = Math.min(min, band.mean - 2 * band.std); max = Math.max(max, band.mean + 2 * band.std); }
  if (mode === "bars") min = Math.min(min, 0);
  const rng = (max - min) || 1;
  min -= rng * 0.08; max += rng * 0.08;
  const span = (max - min) || 1;
  const iw = W - padL - padR, ih = H - padT - padB;
  const x = (i: number) => padL + (i / (vals.length - 1)) * iw;
  const y = (v: number) => padT + ih - ((v - min) / span) * ih;
  const baseY = y(Math.max(min, 0));

  const coords = vals.map((v, i) => ({ x: x(i), y: y(v) }));
  const linePath = polylinePath(coords);
  const areaPath = `${linePath} L ${coords[coords.length - 1].x.toFixed(1)},${baseY.toFixed(1)} L ${coords[0].x.toFixed(1)},${baseY.toFixed(1)} Z`;

  const ticks = 4;
  const yTicks = Array.from({ length: ticks + 1 }, (_, i) => min + (span * i) / ticks);
  const xEvery = Math.max(1, Math.floor(vals.length / 6));
  const bw = (iw / vals.length) * 0.6;
  const animKey = `${metric.id}-${points[0]?.period}-${vals.length}-${mode}`;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const vbx = ((e.clientX - rect.left) / rect.width) * W;
    const idx = Math.round(((vbx - padL) / iw) * (vals.length - 1));
    setHover(Math.max(0, Math.min(vals.length - 1, idx)));
  };

  return (
    <div ref={wrapRef} className="h-[250px] w-full">
    <svg ref={svgRef} width={W} height={H} viewBox={`0 0 ${W} ${H}`}
         className="block select-none font-sans"
         onMouseMove={onMove} onMouseLeave={() => setHover(null)}
         role="img" aria-label={`${metric.label} trend`}>
      <defs>
        <linearGradient id={`area-${gid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={CHART_COLORS.accent} stopOpacity="0.28" />
          <stop offset="100%" stopColor={CHART_COLORS.accent} stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* gridlines + y labels */}
      {yTicks.map((tv, i) => (
        <g key={i}>
          <line x1={padL} x2={W - padR} y1={y(tv)} y2={y(tv)} className="stroke-fg-subtle/12" strokeWidth={1} />
          <text x={padL - 6} y={y(tv) + 3} textAnchor="end"
                className="fill-fg-subtle" {...CHART_AXIS_TEXT_PIXEL}>
            {fmt(tv, metric.unit)}
          </text>
        </g>
      ))}

      {/* control band */}
      {band && (
        <g>
          <rect x={padL} y={y(band.mean + band.std)} width={iw}
                height={Math.max(1, y(band.mean - band.std) - y(band.mean + band.std))}
                className="fill-fg-subtle/10" rx={2} />
          <line x1={padL} x2={W - padR} y1={y(band.mean)} y2={y(band.mean)}
                className="stroke-fg-subtle/45" strokeDasharray="4 3" strokeWidth={1} />
        </g>
      )}

      {mode === "bars" ? (
        vals.map((v, i) => {
          const h = Math.abs(baseY - y(v));
          const top = Math.min(baseY, y(v));
          const active = hover === i;
          return (
            <motion.rect key={`${animKey}-${i}`} x={x(i) - bw / 2} width={bw} rx={2}
              className={active ? "fill-accent-500" : "fill-accent-500/70"}
              initial={{ height: 0, y: baseY }}
              animate={{ height: h, y: top }}
              transition={{ duration: 0.5, delay: 0.1 + i * 0.012, ease: "easeOut" }} />
          );
        })
      ) : (
        <>
          <motion.path key={`a-${animKey}`} d={areaPath} fill={`url(#area-${gid})`}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.7, delay: 0.25 }} />
          <motion.path key={`l-${animKey}`} d={linePath} fill="none"
            className="stroke-accent-500" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="miter"
            initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.9, ease: "easeInOut" }} />
          <motion.circle cx={coords[coords.length - 1].x} cy={coords[coords.length - 1].y} r={4}
            className="fill-accent-500"
            initial={{ scale: 0, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.9, type: "spring", stiffness: 300 }} />
        </>
      )}

      {/* x labels */}
      {points.map((p, i) => (i % xEvery === 0 || i === vals.length - 1) ? (
        <text key={p.period} x={x(i)} y={H - 8} textAnchor="middle"
              className="fill-fg-subtle" {...CHART_AXIS_TEXT_PIXEL}>
          {monthLabel(p.period)}
        </text>
      ) : null)}

      {/* hover crosshair + tooltip */}
      {hover != null && (
        <g>
          <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + ih} className="stroke-fg-subtle/35" strokeWidth={1} />
          <circle cx={x(hover)} cy={y(vals[hover])} r={4} className="fill-accent-500 stroke-ink-800" strokeWidth={1.5} />
          <g transform={`translate(${Math.min(Math.max(x(hover), padL + 46), W - padR - 46)}, ${padT + 4})`}>
            <rect x={-46} y={-2} width={92} height={30} rx={6} className="fill-ink-800 stroke-line" strokeWidth={1} />
            <text x={0} y={9} textAnchor="middle" className="fill-fg-subtle" style={{ fontSize: 8.5 }}>
              {monthLabel(points[hover].period)}
            </text>
            <text x={0} y={22} textAnchor="middle" className="fill-fg num" style={{ fontSize: 11, fontWeight: 600 }}>
              {fmt(vals[hover], metric.unit)}{metric.unit === "days" ? "d" : ""}
            </text>
          </g>
        </g>
      )}
    </svg>
    </div>
  );
}

const CCC_DRIVER_COLORS = {
  dso: CHART_COLORS.seriesA,
  dio: CHART_COLORS.seriesB,
  dpo: CHART_COLORS.seriesC,
} as const;

// ---- CCC decomposition: DSO + DIO - DPO columns with the CCC line overlaid ----
function CccCombo({ points }: { points: HistPoint[] }) {
  const W = 660, H = 240, padT = 14, padB = 26, padR = 14, padL = 14;
  if (points.length < 2) return <div className="text-sm text-fg-subtle px-2 py-10 text-center">Not enough history yet.</div>;
  const iw = W - padL - padR, ih = H - padT - padB;
  const maxUp = Math.max(...points.map((p) => p.dso + p.dio), 1);
  const maxDown = Math.max(...points.map((p) => p.dpo), 1);
  const total = maxUp + maxDown;
  const zeroY = padT + (maxUp / total) * ih;
  const step = iw / points.length;
  const bw = step * 0.6;
  const scale = (v: number) => (v / total) * ih;
  const cccVals = points.map((p) => p.ccc);
  const cmin = Math.min(...cccVals, 0), cmax = Math.max(...cccVals);
  const cspan = (cmax - cmin) || 1;
  const cx = (i: number) => padL + step * i + step / 2;
  const cy = (v: number) => padT + ih - ((v - cmin) / cspan) * ih;
  const cccPath = polylinePath(points.map((p, i) => ({ x: cx(i), y: cy(p.ccc) })));
  const animKey = `${points[0]?.period}-${points.length}`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full font-sans" role="img" aria-label="CCC decomposition">
      <line x1={padL} x2={W - padR} y1={zeroY} y2={zeroY} className="stroke-line" strokeWidth={1} />
      {points.map((p, i) => {
        const dsoH = scale(p.dso), dioH = scale(p.dio), dpoH = scale(p.dpo);
        return (
          <g key={p.period}>
            <motion.rect x={cx(i) - bw / 2} width={bw} fill={CCC_DRIVER_COLORS.dio} fillOpacity={0.7}
              initial={{ height: 0, y: zeroY }} animate={{ height: dioH, y: zeroY - dsoH - dioH }}
              transition={{ duration: 0.5, delay: 0.05 + i * 0.01, ease: "easeOut" }} />
            <motion.rect x={cx(i) - bw / 2} width={bw} fill={CCC_DRIVER_COLORS.dso} fillOpacity={0.6}
              initial={{ height: 0, y: zeroY }} animate={{ height: dsoH, y: zeroY - dsoH }}
              transition={{ duration: 0.5, delay: 0.05 + i * 0.01, ease: "easeOut" }} />
            <motion.rect x={cx(i) - bw / 2} width={bw} fill={CCC_DRIVER_COLORS.dpo} fillOpacity={0.55}
              initial={{ height: 0, y: zeroY }} animate={{ height: dpoH, y: zeroY }}
              transition={{ duration: 0.5, delay: 0.05 + i * 0.01, ease: "easeOut" }} />
          </g>
        );
      })}
      <motion.path key={`ccc-${animKey}`} d={cccPath} fill="none" className="stroke-fg" strokeWidth={2}
        strokeLinecap="round" strokeLinejoin="miter"
        initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.9, ease: "easeInOut" }} />
      {points.map((p, i) => (
        <motion.circle key={`cccpt-${p.period}`} cx={cx(i)} cy={cy(p.ccc)} r={2.5} className="fill-fg"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.6 + i * 0.01 }} />
      ))}
    </svg>
  );
}

// ---- Seasonality heatmap: month x year --------------------------------------
function Seasonality({ points, metric }: { points: HistPoint[]; metric: MetricDef }) {
  const years = Array.from(new Set(points.map((p) => Number(p.period.slice(0, 4))))).sort();
  const byKey = new Map(points.map((p) => [p.period, Number(p[metric.id])]));
  const vals = points.map((p) => Number(p[metric.id]));
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const cell = (v: number | undefined) => {
    if (v == null) return { background: "transparent" };
    const t = (v - min) / span;
    const bad = metric.lower ? t : 1 - t;
    const r = Math.round(60 + bad * 170), g = Math.round(175 - bad * 130);
    return { backgroundColor: `rgba(${r}, ${g}, 90, ${0.18 + bad * 0.58})` };
  };
  return (
    <div className="px-4 pb-4">
      <table className="w-full table-fixed text-[11px] num">
        <colgroup>
          <col style={{ width: "40px" }} />
          {Array.from({ length: 12 }).map((_, m) => <col key={m} />)}
        </colgroup>
        <thead>
          <tr>
            <th className="text-left text-fg-subtle font-normal"></th>
            {Array.from({ length: 12 }).map((_, m) => (
              <th key={m} className="px-1 pb-1 text-fg-subtle font-normal">
                {new Date(2020, m, 1).toLocaleString("en-US", { month: "narrow" })}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {years.map((yr) => (
            <tr key={yr}>
              <td className="pr-2 text-fg-subtle">{yr}</td>
              {Array.from({ length: 12 }).map((_, m) => {
                const key = `${yr}-${String(m + 1).padStart(2, "0")}`;
                const v = byKey.get(key);
                return (
                  <td key={m} className="p-0.5">
                    <div className="w-full h-8 rounded-md flex items-center justify-center text-fg/80"
                         style={cell(v)} title={v != null ? `${key}: ${fmt(v, metric.unit)}` : key}>
                      {v != null ? fmt(v, metric.unit) : ""}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- Area leaderboard (animated diverging bars) -----------------------------
function Leaderboard({ areas, metric }: { areas: HistArea[]; metric: MetricDef }) {
  if (!areas.length) return <div className="text-sm text-fg-subtle px-5 py-6">No areas to rank.</div>;
  const maxAbs = Math.max(...areas.map((a) => Math.abs(a.mom ?? 0)), 1);
  return (
    <div className="px-5 py-3 space-y-2">
      {areas.map((a, i) => {
        const mom = a.mom ?? 0;
        const worse = metric.lower ? mom > 0 : mom < 0;
        const w = (Math.abs(mom) / maxAbs) * 100;
        return (
          <div key={a.scope_id} className="flex items-center gap-3">
            <div className="w-32 truncate text-sm text-fg" title={a.scope_label}>{a.scope_label}</div>
            <div className="flex-1 h-4 rounded bg-black/[0.03] relative overflow-hidden">
              <motion.div className={`h-full rounded ${worse ? "bg-signal-bad/60" : "bg-signal-good/60"}`}
                initial={{ width: 0 }} animate={{ width: `${w}%` }}
                transition={{ duration: 0.5, delay: i * 0.04, ease: "easeOut" }} />
            </div>
            <div className={`w-20 text-right text-xs num ${worse ? "text-signal-bad" : "text-signal-good"}`}>
              {mom > 0 ? "+" : ""}{fmt(mom, metric.unit)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function HistoricalInsights({
  scope, period, refreshKey,
}: {
  scope: Scope;
  period: string;
  refreshKey: number;
}) {
  const ov = useOverlay();
  const [metricId, setMetricId] = useState<keyof HistPoint>("ccc");
  const [showBand, setShowBand] = useState(true);
  const [data, setData] = useState<HistData | null>(null);
  const [narr, setNarr] = useState<HistNarrative | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const metrics = useMemo(() => BASE_METRICS
    .filter((m) => !(["dso", "dpo", "dio", "ccc"].includes(m.id as string) && ov.hiddenKpis.includes(m.id as string)))
    .map((m) => ({ ...m, label: ov.kpiLabels[m.id as string] ?? m.label })), [ov]);
  const metric = metrics.find((m) => m.id === metricId) ?? metrics[0];
  const chartMode: "line" | "bars" = metric.kind === "money" ? "bars" : "line";

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.historicalInsights(scope, metric.id as string, "region")
      .then((d) => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) setError("Could not load historical insights."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refreshKey, scope, metric.id]);

  useEffect(() => {
    let cancelled = false;
    setNarr(null);
    api.historicalNarrative({
      scope_type: scope.scope_type, scope_id: scope.scope_id,
      metric: metric.id as string, period,
    }).then((n) => { if (!cancelled) setNarr(n); }).catch(() => {});
    return () => { cancelled = true; };
  }, [refreshKey, scope, metric.id, period]);

  const series = data?.series ?? [];
  const c = data?.callouts;
  const band = showBand && c && c.trailing_std ? { mean: c.trailing_avg, std: c.trailing_std } : null;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="text-sm text-fg-subtle">Period {period} · trailing history</div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {metrics.map((m) => (
            <button key={m.id as string} onClick={() => setMetricId(m.id)}
              className={`px-2.5 py-1 text-[12px] rounded-full ring-1 transition ${
                m.id === metric.id ? "bg-accent text-white ring-accent"
                  : "text-fg-muted ring-line hover:bg-black/[0.04]"}`}>
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {error && <ErrorNote message={error} />}
      {loading && !data ? (
        <SkeletonRegion className="space-y-5">
          <div className="tile ring-1 ring-line p-5 flex items-start gap-3">
            <Skeleton className="w-9 h-9 rounded-xl shrink-0" />
            <div className="flex-1 space-y-3"><Skeleton className="h-4 w-48" /><TextSkeleton lines={3} /></div>
          </div>
          <CardSkeleton action><ChartSkeleton height={260} /></CardSkeleton>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            <CardSkeleton><TableSkeleton rows={6} cols={3} /></CardSkeleton>
            <CardSkeleton><ChartSkeleton height={200} /></CardSkeleton>
          </div>
          <CardSkeleton><TableSkeleton rows={4} cols={12} /></CardSkeleton>
        </SkeletonRegion>
      ) : (
        <>
          {/* H — AI narrative */}
          <Card className="p-5">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-xl bg-accent/10 grid place-items-center shrink-0">
                <Sparkles className="w-5 h-5 text-accent-400 dark:text-fg-muted" />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-semibold text-fg">What changed this month</div>
                {narr ? (
                  <ul className="mt-2 space-y-1.5">
                    {toBullets(narr.narrative).map((s, i) => (
                      <li key={i} className="flex gap-2.5 text-sm text-fg-muted leading-relaxed">
                        <span className="mt-[7px] w-1.5 h-1.5 rounded-full bg-accent-500 shrink-0" />
                        <span>{s}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <SkeletonRegion className="mt-2"><TextSkeleton lines={3} /></SkeletonRegion>
                )}
                {c && (
                  <div className="flex flex-wrap gap-1.5 mt-3">
                    <span className={`text-[11px] px-2 py-0.5 rounded-full ${
                      (metric.lower ? (c.mom ?? 0) > 0 : (c.mom ?? 0) < 0)
                        ? "bg-signal-bad/10 text-signal-bad" : "bg-signal-good/10 text-signal-good"}`}>
                      {metric.label} {c.mom != null && c.mom > 0 ? "+" : ""}{fmt(c.mom, metric.unit)} MoM
                    </span>
                    <span className={`text-[11px] px-2 py-0.5 rounded-full ${
                      c.outlier ? "bg-signal-warn/10 text-signal-warn" : "bg-black/[0.04] text-fg-muted"}`}>
                      z = {c.zscore} ({c.above_normal ? "above" : "below"} normal)
                    </span>
                    {c.yoy != null && (
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-black/[0.04] text-fg-muted">
                        {c.yoy > 0 ? "+" : ""}{fmt(c.yoy, metric.unit)} YoY
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          </Card>

          {/* A+B merged — trend with optional normal-range band + hover tooltip */}
          <Card
            title={`${metric.label} — Trend`}
            action={
              <div className="flex items-center gap-2">
                {c && <DeltaBadgeRow c={c} metric={metric} />}
                <button
                  onClick={() => setShowBand((b) => !b)}
                  className={`text-[11px] px-2 py-1 rounded-lg ring-1 transition ${
                    showBand ? "bg-accent/10 text-accent-400 dark:text-fg ring-accent/25" : "text-fg-muted ring-line hover:bg-black/[0.04]"}`}>
                  Normal range
                </button>
              </div>
            }
            className="p-4">
            <TrendChart points={series} metric={metric} band={band} mode={chartMode} />
            {showBand && c && (
              <div className="px-1 pt-1 text-xs text-fg-muted">
                Current <span className="num text-fg">{fmt(c.current, metric.unit)}</span> vs
                {" "}12-mo avg <span className="num text-fg">{fmt(c.trailing_avg, metric.unit)}</span>
                {" "}· <span className={c.outlier ? "text-signal-warn" : "text-fg-subtle"}>z = {c.zscore}</span>
                {" "}({c.above_normal ? "above" : "below"} normal)
              </div>
            )}
          </Card>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            <Card title="Worst / best area vs last month" className="pb-2">
              <Leaderboard areas={data?.leaderboard.areas ?? []} metric={metric} />
            </Card>
            <Card title="Cash Conversion Cycle — drivers" className="p-4">
              <CccCombo points={series} />
              <div className="flex items-center gap-4 text-[11px] text-fg-subtle px-1 pt-1">
                <span className="flex items-center gap-1"><i className="w-2.5 h-2.5 rounded-sm inline-block" style={{ backgroundColor: CCC_DRIVER_COLORS.dso, opacity: 0.6 }} /> DSO</span>
                <span className="flex items-center gap-1"><i className="w-2.5 h-2.5 rounded-sm inline-block" style={{ backgroundColor: CCC_DRIVER_COLORS.dio, opacity: 0.7 }} /> DIO</span>
                <span className="flex items-center gap-1"><i className="w-2.5 h-2.5 rounded-sm inline-block" style={{ backgroundColor: CCC_DRIVER_COLORS.dpo, opacity: 0.55 }} /> DPO (offset)</span>
                <span className="flex items-center gap-1"><i className="w-3 h-0.5 bg-fg inline-block" /> CCC</span>
              </div>
            </Card>
          </div>

          {/* F — seasonality */}
          <Card title={`Seasonality — ${metric.label} by month & year`}>
            <Seasonality points={series} metric={metric} />
          </Card>
        </>
      )}
    </div>
  );
}

function DeltaBadgeRow({ c, metric }: { c: HistData["callouts"]; metric: MetricDef }) {
  return (
    <div className="flex items-center gap-1.5">
      <DeltaBadge value={c.mom_pct} lower={metric.lower} suffix={`${c.mom_pct ?? 0}% MoM`} />
      {c.yoy != null && <DeltaBadge value={c.yoy} lower={metric.lower} suffix={`${fmt(c.yoy, metric.unit)} YoY`} />}
    </div>
  );
}
