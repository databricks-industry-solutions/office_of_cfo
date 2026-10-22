import { useId, useState } from "react";
import { useChartSize } from "../lib/useChartSize";
import { SearchTrendRow } from "../api";
import { Card } from "./ui";
import { CHART_AXIS_TEXT_PIXEL, CHART_COLORS } from "../lib/chartPalette";
import { useIndustry } from "../lib/industry";
import { MT, fmtDay, hashNoise } from "../lib/trendChart";
import {
  DEFAULT_METRIC_CATALOG,
  MetricCatalog,
  chartableShared,
  clipUsToPeerHistory,
  metaFor,
  sharedMetrics,
} from "../lib/benchmarkCoverage";
import {
  Domain,
  LabelSide,
  axisDomain,
  captionSide,
  clampToDomain,
  spreadLabels,
} from "../lib/scatterScale";

// Shared benchmark visuals used by both the Close Support / IDP tab and the
// company-search "Competitors benchmarking" tab. Kept source-agnostic via a
// minimal row shape (competitor x metric), so both uploaded-filing extraction
// (CompetitorBenchmark) and public-filing search (SearchBenchmark) feed the
// same charts without coupling to a specific API type.
export interface BenchmarkRow {
  competitor: string;
  metric: string;
  their_value: number | null;
  our_value: number | null;
}

// Shared palette + helpers for the benchmark visuals.
const CHART = {
  cogs: CHART_COLORS.ink, opex: CHART_COLORS.seriesB, margin: CHART_COLORS.seriesC,
  dso: CHART_COLORS.seriesA, dio: CHART_COLORS.seriesB, dpo: CHART_COLORS.seriesC,
  us: CHART_COLORS.accent,
};

type EntityMetrics = { name: string; m: Record<string, number>; isUs: boolean };

// Pivot the flat benchmark rows into per-entity metric maps ("Us" from our_value,
// each competitor from their_value).
export function pivotBenchmarks(benchmarks: BenchmarkRow[]): EntityMetrics[] {
  const comps: Record<string, Record<string, number>> = {};
  const us: Record<string, number> = {};
  for (const b of benchmarks) {
    if (b.their_value != null) (comps[b.competitor] ||= {})[b.metric] = b.their_value;
    if (b.our_value != null) us[b.metric] = b.our_value;
  }
  return [
    { name: "Us", m: us, isUs: true },
    ...Object.entries(comps).map(([name, m]) => ({ name, m, isUs: false })),
  ];
}

// Filings visual #1 — growth (y) vs operating margin (x). Industry-aware: for
// Software & SaaS it draws the classic Rule-of-40 diagonal (growth + margin = 40);
// for every other vertical (where Rule of 40 doesn't apply) it draws a peer-median
// quadrant instead — up-and-to-the-right leads. Competitor growth is extracted
// from the filings; our growth comes from the KPI trend.
type R40Point = { name: string; isUs: boolean; margin: number; growth: number; r40: number };

function median(arr: number[]): number {
  const s = [...arr].sort((a, b) => a - b);
  const n = s.length;
  return n === 0 ? 0 : n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

const shortName = (p: R40Point) => (p.isUs ? "Us" : p.name.split(" ")[0]);

// Caret rotations, from a triangle drawn pointing up.
const CARET_ROT = { up: 0, right: 90, down: 180, left: 270 };
type Caret = keyof typeof CARET_ROT;

const fmtOff = (v: number) => {
  const r = Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
  return `${r > 0 ? "+" : ""}${r.toLocaleString("en-US")}`;
};

export function RuleOf40Visual({ benchmarks, usGrowth }: { benchmarks: BenchmarkRow[]; usGrowth: number | null }) {
  const { ref, size } = useChartSize({ width: 360, height: 260 });
  const { industry } = useIndustry();
  const isSoftware = industry === "software";
  const clipId = useId();

  const pts: R40Point[] = pivotBenchmarks(benchmarks).map((e) => {
    const margin = e.m["Operating margin"];
    const growth = e.isUs ? usGrowth : e.m["Revenue growth"];
    if (margin == null || growth == null) return null;
    return { name: e.name, isUs: e.isUs, margin, growth, r40: growth + margin };
  }).filter((p): p is R40Point => p != null);

  if (pts.length === 0) {
    return (
      <Card title="Growth vs profitability" subtitle="benchmark position">
        <div className="px-5 py-10 text-center text-sm text-fg-subtle max-w-sm mx-auto leading-relaxed">
          Need <span className="text-fg-muted">Revenue growth</span> and{" "}
          <span className="text-fg-muted">Operating margin</span> on at least one
          peer to plot position. Other overlapping metrics still compare below.
        </div>
      </Card>
    );
  }

  // Peer medians define the quadrant crosshair (non-software industries).
  const peers = pts.filter((p) => !p.isUs);
  const base = peers.length ? peers : pts;
  const medMargin = median(base.map((p) => p.margin));
  const medGrowth = median(base.map((p) => p.growth));

  // "Leader" = clears Rule of 40 (software) or top-right quadrant vs peer medians.
  const isLeader = (p: R40Point) =>
    isSoftware ? p.r40 >= 40 : p.margin >= medMargin && p.growth >= medGrowth;
  const leaders = pts.filter(isLeader).length;

  const W = size.width, H = size.height, padL = 42, padR = 18, padT = 16, padB = 34;
  // Scale to the sensible core of the data rather than the raw min/max: one
  // pre-revenue peer (Joby Aviation files +39,183% growth on a -1,347% margin)
  // otherwise makes the x-axis 1,400 points wide and stacks every real peer in a
  // single corner. Anything left outside is pinned to the edge as a caret below.
  const xDom = axisDomain(pts.map((p) => p.margin), { include: isSoftware ? [40] : [] });
  // Software Rule-of-40: force the y-domain to hold the diagonal (growth +
  // margin = 40) right across the box — 40 - xDom.hi at the bottom right up to
  // 40 - xDom.lo at the top left — so it doesn't clip when a high-margin point
  // (e.g. "Us") stretches the x-axis past 40.
  const yDom = axisDomain(pts.map((p) => p.growth), {
    include: isSoftware ? [40 - xDom.lo, 40 - xDom.hi] : [],
  });
  const X = (m: number) => padL + ((m - xDom.lo) / (xDom.hi - xDom.lo || 1)) * (W - padL - padR);
  const Y = (g: number) => H - padB - ((g - yDom.lo) / (yDom.hi - yDom.lo || 1)) * (H - padT - padB);

  // Off-scale points keep their colour coding but draw as a caret at the edge
  // they left through, inset by their own size so the clip box doesn't halve them.
  const CARET = 5;
  const overshoot = (raw: number, c: { v: number; off: number }, d: Domain) =>
    c.off === 0 ? 0 : Math.abs(raw - c.v) / (d.hi - d.lo || 1);
  const marks = pts.map((p) => {
    const cx = clampToDomain(p.margin, xDom);
    const cy = clampToDomain(p.growth, yDom);
    const dir: Caret = overshoot(p.margin, cx, xDom) >= overshoot(p.growth, cy, yDom)
      ? (cx.off > 0 ? "right" : "left")
      : (cy.off > 0 ? "up" : "down");
    const off = cx.off !== 0 || cy.off !== 0;
    return {
      p, dir, off, offX: cx.off, offY: cy.off,
      x: X(cx.v) - cx.off * (CARET + 1),
      y: Y(cy.v) + cy.off * (CARET + 1),
    };
  });
  const offScale = marks.filter((m) => m.off);
  const offNote = (m: (typeof marks)[number]) => {
    const bits: string[] = [];
    if (m.offY !== 0) bits.push(`${fmtOff(m.p.growth)}% growth`);
    if (m.offX !== 0) bits.push(`${fmtOff(m.p.margin)}% margin`);
    return `${shortName(m.p)} ${bits.join(", ")}`;
  };

  // Labels take the anchor side from the marker's x, then get pushed apart so
  // near-coincident peers don't stack their names.
  const labelSlots = marks.map((m) => ({
    y: m.y + 3,
    side: (m.x > padL + (W - padL - padR) * 0.62 ? "end" : "start") as LabelSide,
  }));
  const labelYs = spreadLabels(labelSlots, 10, { top: padT + 7, bottom: H - padB - 2 });
  const placed = labelSlots.map((s, i) => ({ y: labelYs[i], side: s.side }));
  const capY = Y(medGrowth) - 4;
  const medInScale = medGrowth > yDom.lo && medGrowth < yDom.hi;
  const capSide = medInScale ? captionSide(capY, placed, 9) : null;

  // Software: clip the g = 40 - m diagonal to the plot box.
  const mLo = Math.max(xDom.lo, 40 - yDom.hi);
  const mHi = Math.min(xDom.hi, 40 - yDom.lo);
  const showLine = isSoftware && mLo < mHi;
  // Its caption goes at whichever end of the line has clearance from the point
  // labels; with both ends crowded the diagonal reads better unlabelled.
  const r40Cap = showLine
    ? [
        { x: X(mLo) + 4, y: Y(40 - mLo) - 4, side: "start" as LabelSide },
        { x: X(mHi) - 4, y: Y(40 - mHi) - 4, side: "end" as LabelSide },
      ].find((end) => placed.every((l) => l.side !== end.side || Math.abs(l.y - end.y) >= 10))
    : undefined;

  return (
    <Card
      title="Growth vs profitability"
      subtitle={isSoftware ? "Rule of 40 · growth + margin ≥ 40" : "vs peer median · up-and-right leads"}
    >
      <div className="px-5 py-4">
        <div ref={ref} className="w-full" style={{ height: 260 }}>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block font-sans" role="img" aria-label="Growth vs profitability scatter">
          <defs>
            <clipPath id={clipId}>
              <rect x={padL} y={padT} width={W - padL - padR} height={H - padT - padB} />
            </clipPath>
          </defs>
          <line x1={padL} y1={padT} x2={padL} y2={H - padB} stroke="rgba(23,25,32,0.18)" />
          <line x1={padL} y1={H - padB} x2={W - padR} y2={H - padB} stroke="rgba(23,25,32,0.18)" />
          <g clipPath={`url(#${clipId})`}>
            {showLine && (
              <line x1={X(mLo)} y1={Y(40 - mLo)} x2={X(mHi)} y2={Y(40 - mHi)}
                    stroke={CHART_COLORS.good} strokeWidth="1" strokeDasharray="2 6"
                    strokeLinecap="round" opacity="0.35" />
            )}
            {!isSoftware && (
              <>
                <line x1={X(medMargin)} y1={padT} x2={X(medMargin)} y2={H - padB}
                      stroke="rgba(23,25,32,0.16)" strokeWidth="1" strokeDasharray="4 4" />
                <line x1={padL} y1={Y(medGrowth)} x2={W - padR} y2={Y(medGrowth)}
                      stroke="rgba(23,25,32,0.16)" strokeWidth="1" strokeDasharray="4 4" />
              </>
            )}
            {marks.map((m) => {
              const fill = m.p.isUs ? CHART.us : isLeader(m.p) ? CHART_COLORS.good : CHART_COLORS.slate;
              return m.off ? (
                <path key={m.p.name} d={`M 0 ${-CARET} L ${CARET * 0.9} ${CARET * 0.7} L ${-CARET * 0.9} ${CARET * 0.7} Z`}
                      transform={`translate(${m.x} ${m.y}) rotate(${CARET_ROT[m.dir]})`}
                      fill={fill} stroke="rgba(23,25,32,0.20)" strokeWidth="1" />
              ) : (
                <circle key={m.p.name} cx={m.x} cy={m.y} r={m.p.isUs ? 6 : 4.5}
                        fill={fill} stroke="rgba(23,25,32,0.20)" strokeWidth="1" />
              );
            })}
          </g>
          {r40Cap && (
            <text x={r40Cap.x} y={r40Cap.y} fontSize="9" fill={CHART_COLORS.good} opacity="0.6"
                  textAnchor={r40Cap.side}>Rule of 40</text>
          )}
          {!isSoftware && capSide && (
            <text x={capSide === "end" ? W - padR : padL + 2} y={capY} fontSize="8" fill={CHART_COLORS.axis}
                  textAnchor={capSide === "end" ? "end" : "start"}>peer median</text>
          )}
          {marks.map((m, i) => (
            <text key={m.p.name} x={m.x + (placed[i].side === "end" ? -1 : 1) * (m.p.isUs ? 9 : 7)}
                  y={placed[i].y} fontSize="9" textAnchor={placed[i].side}
                  fill={m.p.isUs ? CHART_COLORS.accent : CHART_COLORS.axis} fontWeight={m.p.isUs ? 700 : 400}>
              {shortName(m.p)}
            </text>
          ))}
          <text x={(padL + W - padR) / 2} y={H - 4} {...CHART_AXIS_TEXT_PIXEL}
                fill={CHART_COLORS.axis} textAnchor="middle">Operating margin (%)</text>
          <text x={12} y={(padT + H - padB) / 2} {...CHART_AXIS_TEXT_PIXEL}
                fill={CHART_COLORS.axis} textAnchor="middle"
                transform={`rotate(-90 12 ${(padT + H - padB) / 2})`}>Revenue growth (%)</text>
        </svg>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] pt-1 text-fg-subtle">
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block w-0 h-0 border-l-[5px] border-r-[5px] border-b-[9px] border-l-transparent border-r-transparent"
              style={{ borderBottomColor: CHART.us }}
              aria-hidden
            />
            Us
          </span>
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: CHART_COLORS.good }} />{isSoftware ? "clears 40" : "leader"}</span>
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: CHART_COLORS.slate }} />{isSoftware ? "below 40" : "trailing"}</span>
          <span className="ml-auto">
            {isSoftware
              ? `${leaders} of ${pts.length} clear the Rule of 40`
              : `${leaders} of ${pts.length} lead on growth & margin`}
          </span>
        </div>
        {offScale.length > 0 && (
          <p className="text-[11px] text-fg-subtle pt-1">
            Pinned to the edge, off scale: {offScale.slice(0, 2).map(offNote).join("; ")}
            {offScale.length > 2 ? ` · +${offScale.length - 2} more` : ""}
          </p>
        )}
      </div>
    </Card>
  );
}

// Filings visual #2 — "how we rank vs peers": tracks derived from shared metrics
// in the current run (catalog order). RIGHT is always better when better≠neutral.
const fmtVal = (v: number, unit: string) => {
  if (unit === "%" || unit.endsWith("%")) return `${Math.round(v * 10) / 10}%`;
  if (unit === "days" || unit === "d") return `${Math.round(v)} d`;
  return `${Math.round(v * 10) / 10}`;
};

export function PeerRankVisual({
  benchmarks,
  catalog = DEFAULT_METRIC_CATALOG,
}: {
  benchmarks: BenchmarkRow[];
  catalog?: MetricCatalog;
}) {
  const entities = pivotBenchmarks(benchmarks);
  const us = entities.find((e) => e.isUs);
  const peers = entities.filter((e) => !e.isUs);

  const candidates = chartableShared(benchmarks, catalog).filter((metric) => {
    const meta = metaFor(metric, catalog);
    if (meta.better === "neutral") return false;
    const usVal = us?.m[metric];
    const peerVals = peers.map((p) => p.m[metric]).filter((v): v is number => v != null);
    return usVal != null && peerVals.length >= 1;
  });

  const rows = candidates.map((metric) => {
    const meta = metaFor(metric, catalog);
    const better = meta.better === "low" ? "low" as const : "high" as const;
    const unit = meta.unit === "days" ? "d" : meta.unit;
    const usVal = us!.m[metric];
    const peerVals = peers.map((p) => p.m[metric]).filter((v): v is number => v != null);
    const all = [usVal, ...peerVals];
    const lo = Math.min(...all);
    const hi = Math.max(...all);
    const span = hi - lo || 1;
    const orient = (v: number) => {
      const raw = (v - lo) / span;
      return (better === "high" ? raw : 1 - raw) * 100;
    };
    const peerAvg = peerVals.reduce((s, v) => s + v, 0) / peerVals.length;
    const peerLo = Math.min(...peerVals), peerHi = Math.max(...peerVals);
    const isBetter = (v: number) => (better === "high" ? v > usVal : v < usVal);
    const rank = 1 + all.filter(isBetter).length;
    const aheadOfAvg = better === "high" ? usVal >= peerAvg : usVal <= peerAvg;
    const a = orient(peerLo), b = orient(peerHi);
    return {
      metric, unit, better, usVal, peerAvg, rank, n: all.length, aheadOfAvg,
      usPos: orient(usVal), avgPos: orient(peerAvg),
      rangeLo: Math.min(a, b), rangeHi: Math.max(a, b),
    };
  });

  if (rows.length === 0) {
    return (
      <Card title="How we rank vs peers" subtitle="benchmark position">
        <div className="px-5 py-10 text-center text-sm text-fg-subtle max-w-sm mx-auto leading-relaxed">
          No overlapping metrics with Us and at least one peer yet. The compare
          table below still shows every metric that was found.
        </div>
      </Card>
    );
  }

  const wins = rows.filter((r) => r.aheadOfAvg).length;

  return (
    <Card title="How we rank vs peers" subtitle="latest reported figures · shared metrics only · right is better">
      <div className="px-5 py-4 space-y-3">
        {rows.map((r) => (
          <div key={r.metric} className="flex items-center gap-3 text-xs">
            <div className="w-28 shrink-0">
              <div className="text-fg-muted">{r.metric}</div>
              <div className="text-[10px] text-fg-subtle num">#{r.rank} of {r.n}</div>
            </div>
            <div className="relative h-5 flex-1">
              <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1 rounded-full bg-black/[0.06]" />
              <div
                className="absolute top-1/2 -translate-y-1/2 h-1 rounded-full bg-black/[0.08]"
                style={{ left: `${r.rangeLo}%`, width: `${Math.max(2, r.rangeHi - r.rangeLo)}%` }}
                title="peer range"
              />
              <div
                className="absolute top-1/2 -translate-y-1/2 w-px h-3 bg-fg-muted"
                style={{ left: `${r.avgPos}%` }}
                title={`peer average ${fmtVal(r.peerAvg, r.unit)}`}
              />
              <div
                className="absolute top-1/2 w-3 h-3 rounded-full ring-2 ring-black/40 shadow"
                style={{
                  left: `${r.usPos}%`,
                  transform: "translate(-50%, -50%)",
                  backgroundColor: r.aheadOfAvg ? CHART_COLORS.good : CHART_COLORS.bad,
                }}
                title={`Us ${fmtVal(r.usVal, r.unit)}`}
              />
            </div>
            <div className="w-24 shrink-0 text-right num tabular-nums">
              <span className="text-fg font-semibold">{fmtVal(r.usVal, r.unit)}</span>
              <span className="text-fg-subtle"> vs {fmtVal(r.peerAvg, r.unit)}</span>
            </div>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] pt-1 text-fg-subtle">
          <span className="flex items-center gap-1.5"><span className="w-px h-3 bg-fg-muted" />peer avg</span>
          <span className="flex items-center gap-1.5"><span className="w-4 h-1 rounded-full bg-black/[0.08]" />peer range</span>
        </div>
        <p className="text-[11px] text-fg-subtle">
          Ahead of the peer average on <span className="font-semibold text-signal-good">{wins}</span> of {rows.length} metrics.
        </p>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// PRIMARY visual — metric trend over time. Selector lists shared chartable
// metrics only (absolute Revenue is excluded via chartable: false).
// ---------------------------------------------------------------------------
const PEER_COLORS = [
  CHART_COLORS.seriesA,
  CHART_COLORS.seriesB,
  CHART_COLORS.seriesC,
  CHART_COLORS.ink,
  CHART_COLORS.slate,
];
const TWO_PI = 2 * Math.PI;

type TrendPt = { t: number; v: number };

const fmtTrendVal = (v: number, unit: string): string => {
  if (unit === "%") return `${Math.round(v * 10) / 10}%`;
  if (unit === "days" || unit === "d") return `${Math.round(v)}d`;
  return `${Math.round(v * 10) / 10}`;
};

const seedOf = (name: string): number => {
  let s = 0;
  for (let i = 0; i < name.length; i++) s = (s * 31 + name.charCodeAt(i)) >>> 0;
  return s % 997;
};

export function BenchmarkTrendChart({
  trends,
  catalog = DEFAULT_METRIC_CATALOG,
}: {
  trends: SearchTrendRow[];
  catalog?: MetricCatalog;
}) {
  const { ref, size } = useChartSize({ width: 860, height: 260 });
  const clipId = useId();
  const [metric, setMetric] = useState<string>("Operating margin");

  const asCoverage = trends
    .filter((t) => t.value != null)
    .map((t) => ({
      competitor: t.competitor,
      metric: t.metric,
      their_value: t.competitor === "Us" ? null : t.value,
      our_value: t.competitor === "Us" ? t.value : null,
    }));
  const sharedNames = new Set(sharedMetrics(asCoverage, catalog));
  const byMetric = new Map<string, Set<string>>();
  for (const t of trends) {
    if (t.value == null) continue;
    if (!metaFor(t.metric, catalog).chartable) continue;
    const set = byMetric.get(t.metric) ?? new Set();
    set.add(t.competitor);
    byMetric.set(t.metric, set);
  }
  const available = catalog.metrics
    .map((m) => m.name)
    .filter((name) => {
      if (!metaFor(name, catalog).chartable) return false;
      const comps = byMetric.get(name);
      if (!comps || comps.size < 2) return false;
      const withSeries = [...comps].some((c) =>
        trends.filter((t) => t.metric === name && t.competitor === c && t.value != null).length >= 2);
      return withSeries && (sharedNames.has(name) || comps.size >= 2);
    });
  const sel = available.includes(metric) ? metric : (available[0] ?? "Operating margin");

  const rawGroups = new Map<string, TrendPt[]>();
  let unit = "";
  for (const r of trends) {
    if (r.metric !== sel || r.value == null) continue;
    const t = Date.parse(r.period_end);
    if (!Number.isFinite(t)) continue;
    unit = unit || r.unit;
    const arr = rawGroups.get(r.competitor) ?? [];
    arr.push({ t, v: r.value });
    rawGroups.set(r.competitor, arr);
  }
  for (const arr of rawGroups.values()) arr.sort((a, b) => a.t - b.t);
  // Our own series is synthesized well past what the filings cover, so the chart
  // used to open on years only "Us" reached. Start at the oldest peer point for
  // the selected metric instead.
  const groups = clipUsToPeerHistory(rawGroups);
  const companies = [...groups.entries()].filter(([, a]) => a.length >= 2);

  const selectEl = (
    <select
      value={sel}
      onChange={(e) => setMetric(e.target.value)}
      disabled={available.length === 0}
      className="text-[11px] rounded-md ring-1 ring-line bg-black/[0.04] px-2 py-1 text-fg-muted
                 focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:opacity-50"
    >
      {(available.length ? available : ["Operating margin"]).map((m) => (
        <option key={m} value={m}>{m}</option>
      ))}
    </select>
  );

  if (companies.length === 0) {
    return (
      <Card title="Benchmark trend" subtitle="shared metrics over time vs peers" action={selectEl}>
        <div className="px-5 py-10 text-center text-sm text-fg-subtle max-w-sm mx-auto leading-relaxed">
          {available.length === 0
            ? "No shared chartable metric with enough history yet — see the compare table for what was found."
            : "No trend data yet — run an analysis."}
        </div>
      </Card>
    );
  }

  const allPts = companies.flatMap(([, a]) => a);
  const tMin = Math.min(...allPts.map((p) => p.t));
  const tMax = Math.max(...allPts.map((p) => p.t));
  const us = groups.get("Us") ?? [];

  const vals = allPts.map((p) => p.v);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const range = (hi - lo) || 1;
  const padV = range * 0.12 || 1;
  const yMin = lo - padV, yMax = hi + padV;

  const W = size.width, H = size.height, padL = 46, padR = 16, padT = 16, padB = 28;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const x = (t: number) => padL + ((t - tMin) / (tMax - tMin || 1)) * plotW;
  const y = (v: number) => padT + (1 - (v - yMin) / (yMax - yMin || 1)) * plotH;

  const N = 200;
  const texture = (seed: number, i: number) => {
    const p1 = hashNoise(seed + 1) * TWO_PI, p2 = hashNoise(seed + 2) * TWO_PI, p3 = hashNoise(seed + 3) * TWO_PI;
    return 0.42 * Math.sin(i / 9 + p1) + 0.5 * Math.sin(i / 19 + p2) + 0.4 * Math.sin(i / 41 + p3);
  };
  const interp = (pts: TrendPt[], t: number): number => {
    if (t <= pts[0].t) return pts[0].v;
    const last = pts[pts.length - 1];
    if (t >= last.t) return last.v;
    let j = 0;
    while (j < pts.length - 1 && pts[j + 1].t <= t) j++;
    const p1 = pts[j], p2 = pts[j + 1];
    const p0 = pts[j - 1] ?? p1, p3 = pts[j + 2] ?? p2;
    const u = (t - p1.t) / Math.max(1, p2.t - p1.t), u2 = u * u, u3 = u2 * u;
    return 0.5 * (2 * p1.v + (-p0.v + p2.v) * u
      + (2 * p0.v - 5 * p1.v + 4 * p2.v - p3.v) * u2
      + (-p0.v + 3 * p1.v - 3 * p2.v + p3.v) * u3);
  };
  const smoothPath = (sp: { x: number; y: number }[]): string => {
    if (sp.length === 0) return "";
    let d = `M${sp[0].x.toFixed(1)},${sp[0].y.toFixed(1)}`;
    for (let i = 0; i < sp.length - 1; i++) {
      const q0 = sp[i - 1] ?? sp[i], q1 = sp[i], q2 = sp[i + 1], q3 = sp[i + 2] ?? sp[i + 1];
      const c1x = q1.x + (q2.x - q0.x) / 6, c1y = q1.y + (q2.y - q0.y) / 6;
      const c2x = q2.x - (q3.x - q1.x) / 6, c2y = q2.y - (q3.y - q1.y) / 6;
      d += `C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${q2.x.toFixed(1)},${q2.y.toFixed(1)}`;
    }
    return d;
  };
  const linePath = (pts: TrendPt[], seed: number, ampFrac: number): string => {
    const first = pts[0].t, lastT = pts[pts.length - 1].t;
    const sp: { x: number; y: number }[] = [];
    for (let i = 0; i < N; i++) {
      const t = first + (i / (N - 1)) * (lastT - first);
      sp.push({ x: x(t), y: y(interp(pts, t) + texture(seed, i) * ampFrac * range) });
    }
    return smoothPath(sp);
  };
  const markPts = (pts: TrendPt[], seed: number, ampFrac: number) => {
    const first = pts[0].t, lastT = pts[pts.length - 1].t;
    const span = lastT - first || 1;
    return pts.map((p) => {
      const i = ((p.t - first) / span) * (N - 1);
      return { cx: x(p.t), cy: y(p.v + texture(seed, i) * ampFrac * range) };
    });
  };

  const peers = companies.filter(([name]) => name !== "Us");
  const peerColor = new Map(peers.map(([name], i) => [name, PEER_COLORS[i % PEER_COLORS.length]]));

  const tickCount = 6;
  const ticks = Array.from({ length: tickCount }, (_, k) => tMin + (k / (tickCount - 1)) * (tMax - tMin));

  return (
    <Card title="Benchmark trend" subtitle={`${sel} over time · us vs peers`} action={selectEl}>
      <div className="px-3 pt-3 pb-2">
        <div ref={ref} className="w-full" style={{ height: 260 }}>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block font-sans" role="img"
             aria-label={`${sel} trend over time for us versus peers`}>
          <defs>
            <clipPath id={clipId}>
              <rect x={padL} y={padT} width={plotW} height={plotH} />
            </clipPath>
          </defs>

          {[0, 0.5, 1].map((f) => {
            const v = yMin + f * (yMax - yMin);
            return (
              <g key={f}>
                <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke={MT.grid} strokeWidth="1" />
                <text x={padL - 6} y={y(v) + 3} {...CHART_AXIS_TEXT_PIXEL}
                      fill={CHART_COLORS.axis} textAnchor="end">{fmtTrendVal(v, unit)}</text>
              </g>
            );
          })}

          <g clipPath={`url(#${clipId})`}>
            {peers.map(([name, pts]) => (
              <path key={name} d={linePath(pts, seedOf(name), 0.03)} fill="none"
                    stroke={peerColor.get(name)} strokeWidth="1.5" strokeLinejoin="round"
                    strokeLinecap="round" opacity="0.8" />
            ))}

            {us.length >= 2 && (
              <path d={linePath(us, seedOf("Us"), 0.02)} fill="none" stroke={CHART_COLORS.accent}
                    strokeWidth="2.75" strokeLinejoin="round" strokeLinecap="round" />
            )}

            {peers.map(([name, pts]) =>
              markPts(pts, seedOf(name), 0.03).map((mk, i) => (
                <circle key={`${name}-${i}`} cx={mk.cx} cy={mk.cy} r={2.6}
                        fill={peerColor.get(name)} stroke="#fff" strokeWidth="1" opacity="0.9" />
              )),
            )}
            {us.length >= 2 && markPts(us, seedOf("Us"), 0.02).map((mk, i) => (
              <circle key={`us-${i}`} cx={mk.cx} cy={mk.cy} r={3}
                      fill={CHART_COLORS.accent} stroke="#fff" strokeWidth="1" />
            ))}
          </g>

          {ticks.map((t, i) => (
            <text key={i} x={x(t)} y={H - 8} {...CHART_AXIS_TEXT_PIXEL}
                  fill={CHART_COLORS.axis}
                  textAnchor={i === 0 ? "start" : i === tickCount - 1 ? "end" : "middle"}>
              {fmtDay(new Date(t))}
            </text>
          ))}
        </svg>
        </div>

        <div className="flex items-center gap-x-4 gap-y-1 flex-wrap px-2 pt-1">
          {us.length >= 2 && (
            <span className="flex items-center gap-1.5 text-[11px] text-fg-muted">
              <svg width="16" height="6" aria-hidden="true"><line x1="0" y1="3" x2="16" y2="3" stroke={CHART_COLORS.accent} strokeWidth="2.75" strokeLinecap="round" /></svg>
              Us
            </span>
          )}
          {peers.map(([name]) => (
            <span key={name} className="flex items-center gap-1.5 text-[11px] text-fg-muted">
              <svg width="16" height="6" aria-hidden="true"><line x1="0" y1="3" x2="16" y2="3" stroke={peerColor.get(name)} strokeWidth="2" strokeLinecap="round" /></svg>
              {name.split(" ")[0]}
            </span>
          ))}
        </div>
      </div>
    </Card>
  );
}
