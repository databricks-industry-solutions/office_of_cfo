import { Fragment, useEffect, useMemo, useState } from "react";
import {
  api, DriverDef, PlanListItem, ProjectResult, ScenarioPlan, StatementSet,
  fmtCompact, fmtSignedCompact,
} from "../api";
import { Card, ErrorNote, Skeleton } from "../components/ui";
import { OffLensAssumptions } from "../components/OffLensAssumptions";
import { CHART_AXIS_TEXT_PIXEL, CHART_COLORS } from "../lib/chartPalette";
import { useChartSize } from "../lib/useChartSize";
import { cn } from "../lib/cn";
import { defaultMinCash, liquidityOutlook, LiquidityOutlook } from "../lib/liquidity";
import type { PageId } from "../nav";

// What the forecast baseline is built from — shown so the CFO knows why the line bends.
const BASELINE_SOURCE_COPY: Record<NonNullable<ProjectResult["baseline_source"]>, string> = {
  ai: "AI forecast — trend × seasonality from the revenue history (ai_forecast); COGS at the actual margin",
  budget: "Budget plan",
  run_rate: "Run-rate — average of the actual months (no trend or seasonality)",
};

/** Strip zero-valued levers before sending — a scenario is defined by its non-zero
 *  assumptions; 0 means "no change" (baseline) for every driver. */
const nonZero = (a: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(a).filter(([, v]) => v !== 0));

// ── The cash-flow statement structure ───────────────────────────────────────
// Each row maps an engine line id to a display sign (its cash impact). Working-
// capital and outflow lines are stored as magnitudes/deltas, so the display sign
// converts them to the +/- they contribute to cash. Subtotals render as totals.
type Row = { id: string; label: string; sign?: 1 | -1; total?: boolean; indent?: boolean };
type SectionDef = { title: string; rows: Row[] };

const SECTIONS: SectionDef[] = [
  {
    title: "Operating activities",
    rows: [
      { id: "net_income", label: "Net income", indent: true },
      { id: "dna", label: "Depreciation & amortization", indent: true },
      { id: "delta_ar", label: "Change in receivables", sign: -1, indent: true },
      { id: "delta_inventory", label: "Change in inventory", sign: -1, indent: true },
      { id: "delta_ap", label: "Change in payables", indent: true },
      { id: "operating_cash", label: "Operating cash flow (CFO)", total: true },
    ],
  },
  {
    title: "Investing activities",
    rows: [
      { id: "capex", label: "Capital expenditure", sign: -1, indent: true },
      { id: "acquisitions", label: "Acquisitions", sign: -1, indent: true },
      { id: "asset_sales", label: "Asset disposals", indent: true },
      { id: "investing_cash", label: "Investing cash flow (CFI)", total: true },
    ],
  },
  {
    title: "Financing activities",
    rows: [
      { id: "debt_draw", label: "New debt drawn", indent: true },
      { id: "debt_repayment", label: "Debt repayment", sign: -1, indent: true },
      { id: "dividends", label: "Dividends paid", sign: -1, indent: true },
      { id: "financing_cash", label: "Financing cash flow (CFF)", total: true },
    ],
  },
];

// Actual months tie to posted cash; balance-sheet movements the model doesn't break
// out (accruals, prepaids, tax payable, …) land here, as on a published cash-flow
// statement. Shown only when non-zero (forecast months always carry 0).
const OTHER_CASH_ROW: Row = { id: "other_cash", label: "Other operating items, net" };
const hasOtherCash = (s: StatementSet) => (s.lines.other_cash ?? []).some((v) => Math.abs(v) >= 1);

const fy = (s: StatementSet, id: string) => (s.lines[id] ?? []).reduce((a, b) => a + b, 0);
const monthLabel = (p: string) => {
  const m = Number(p.slice(5, 7));
  return ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m] ?? p;
};

// ── FY cash bridge (beginning → levers → ending) ─────────────────────────────
function CashBridge({ ss }: { ss: StatementSet }) {
  const { ref, size } = useChartSize({ width: 900, height: 300 });
  const periods = ss.lines.beginning_cash ?? [];
  const begin = periods[0] ?? 0;
  const end = (ss.lines.cash_balance ?? [])[(ss.lines.cash_balance ?? []).length - 1] ?? 0;

  const steps = [
    { label: "Net income", v: fy(ss, "net_income") },
    { label: "D&A", v: fy(ss, "dna") },
    { label: "Working capital", v: -fy(ss, "delta_ar") - fy(ss, "delta_inventory") + fy(ss, "delta_ap") },
    { label: "Capex", v: -fy(ss, "capex") },
    { label: "Acquisitions", v: -fy(ss, "acquisitions") },
    { label: "Asset disposals", v: fy(ss, "asset_sales") },
    { label: "Net debt", v: fy(ss, "debt_draw") - fy(ss, "debt_repayment") },
    { label: "Dividends", v: -fy(ss, "dividends") },
    { label: "Other, net", v: fy(ss, "other_cash") },
  ].filter((s) => Math.abs(s.v) >= 1);

  // Bars: Beginning + each step (floating) + Ending. Compute running tops.
  const bars: { label: string; from: number; to: number; anchor?: boolean; up?: boolean }[] = [];
  bars.push({ label: "Beginning", from: 0, to: begin, anchor: true });
  let run = begin;
  for (const s of steps) {
    bars.push({ label: s.label, from: run, to: run + s.v, up: s.v >= 0 });
    run += s.v;
  }
  bars.push({ label: "Ending", from: 0, to: end, anchor: true });

  const lo = Math.min(0, ...bars.map((b) => Math.min(b.from, b.to)));
  const hi = Math.max(...bars.map((b) => Math.max(b.from, b.to)), 1);
  const W = size.width, H = size.height, padT = 16, padB = 54, padL = 8, padR = 8;
  const plotH = H - padT - padB;
  const n = bars.length;
  const slot = (W - padL - padR) / n;
  const barW = Math.min(64, slot * 0.62);
  const Y = (v: number) => padT + plotH * (1 - (v - lo) / (hi - lo || 1));

  return (
    <div ref={ref} className="w-full" style={{ height: 300 }}>
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block font-sans" role="img"
         aria-label="Full-year cash bridge from beginning to ending cash">
      <line x1={padL} y1={Y(0)} x2={W - padR} y2={Y(0)} stroke={CHART_COLORS.grid} strokeWidth="1" />
      {bars.map((b, i) => {
        const cx = padL + slot * i + slot / 2;
        const x = cx - barW / 2;
        const yTop = Y(Math.max(b.from, b.to));
        const h = Math.max(2, Math.abs(Y(b.from) - Y(b.to)));
        const fill = b.anchor ? CHART_COLORS.accent : b.up ? CHART_COLORS.good : CHART_COLORS.bad;
        const delta = b.to - b.from;
        return (
          <g key={i}>
            {i > 0 && (
              <line x1={padL + slot * (i - 1) + slot / 2 + barW / 2} y1={Y(bars[i - 1].to)}
                    x2={x} y2={Y(bars[i - 1].to)}
                    stroke={CHART_COLORS.slate} strokeWidth="1" strokeDasharray="2 2" opacity="0.6" />
            )}
            <rect x={x} y={yTop} width={barW} height={h} rx="2" fill={fill}
                  opacity={b.anchor ? 1 : 0.9} />
            <text x={cx} y={yTop - 5} fontSize="10" fill={CHART_COLORS.ink} textAnchor="middle"
                  fontWeight={b.anchor ? 700 : 500}>
              {b.anchor ? fmtCompact(b.to) : fmtSignedCompact(delta)}
            </text>
            <text x={cx} y={H - padB + 16} {...CHART_AXIS_TEXT_PIXEL}
                  fill={CHART_COLORS.axis} textAnchor="middle">
              {b.label.length > 10 ? b.label.slice(0, 9) + "…" : b.label}
            </text>
          </g>
        );
      })}
    </svg>
    </div>
  );
}

// ── Cash balance vs minimum (monthly) ────────────────────────────────────────
function CashBalanceChart({ ss, base, showBase, minCash, outlook }: {
  ss: StatementSet; base?: StatementSet; showBase: boolean; minCash: number; outlook: LiquidityOutlook | null;
}) {
  const { ref, size } = useChartSize({ width: 900, height: 260 });
  const [hover, setHover] = useState<number | null>(null);
  const cash = ss.lines.cash_balance ?? [];
  const baseCash = base?.lines.cash_balance ?? [];
  const n = cash.length;
  const hinge = ss.hinge_index;
  if (n < 2) return null;

  const W = size.width, H = size.height, padT = 14, padB = 26, padL = 56, padR = 16;
  const all = [...cash, ...(showBase ? baseCash : []), minCash];
  // Round axis: ~4 steps of 1/2/2.5/5 × 10^k, from 0 (or the lowest value) to the top.
  const rawStep = (Math.max(...all) - Math.min(0, ...all)) / 4 || 1;
  const mag = 10 ** Math.floor(Math.log10(rawStep));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= rawStep) ?? 10) * mag;
  const lo = Math.floor(Math.min(0, ...all) / step) * step;
  const hi = Math.ceil(Math.max(...all) / step) * step;
  const X = (i: number) => padL + ((W - padL - padR) * i) / (n - 1);
  const Y = (v: number) => padT + (H - padT - padB) * (1 - (v - lo) / (hi - lo || 1));
  const path = (vals: number[]) => vals.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join("");
  const ticks = Array.from({ length: Math.round((hi - lo) / step) + 1 }, (_, k) => lo + k * step);
  const zoneX = hinge + 1 < n ? (X(hinge) + X(hinge + 1)) / 2 : null;
  const slot = (W - padL - padR) / (n - 1);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-4 text-[11px] text-fg-muted mb-2" aria-hidden="true">
        <span className="flex items-center gap-1.5">
          <svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke={CHART_COLORS.seriesA} strokeWidth="2" /></svg>
          Cash balance
        </span>
        {showBase && (
          <span className="flex items-center gap-1.5">
            <svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke={CHART_COLORS.slate} strokeWidth="2" strokeDasharray="4 3" /></svg>
            Baseline
          </span>
        )}
        <span className="flex items-center gap-1.5">
          <svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke={CHART_COLORS.warn} strokeWidth="1.5" strokeDasharray="2 2" /></svg>
          Minimum cash
        </span>
      </div>
      <div className="relative" onMouseLeave={() => setHover(null)}>
        <div ref={ref} className="w-full" style={{ height: 260 }}>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block font-sans" role="img"
             aria-label={`Monthly cash balance against a minimum of ${fmtCompact(minCash)}`}>
          {zoneX !== null && (
            <rect x={zoneX} y={padT} width={W - padR - zoneX} height={H - padT - padB}
                  fill={CHART_COLORS.accent} opacity="0.05" />
          )}
          {ticks.map((t) => (
            <g key={t}>
              <line x1={padL} y1={Y(t)} x2={W - padR} y2={Y(t)} stroke={CHART_COLORS.grid} strokeWidth="1" />
              <text x={padL - 6} y={Y(t) + 3} {...CHART_AXIS_TEXT_PIXEL}
                    fill={CHART_COLORS.axis} textAnchor="end">{fmtCompact(t)}</text>
            </g>
          ))}
          {/* Below-minimum band: the zone a forecast must stay out of. */}
          <rect x={padL} y={Y(minCash)} width={W - padL - padR} height={Math.max(0, Y(lo) - Y(minCash))}
                fill={CHART_COLORS.bad} opacity="0.05" />
          <line x1={padL} y1={Y(minCash)} x2={W - padR} y2={Y(minCash)}
                stroke={CHART_COLORS.warn} strokeWidth="1.5" strokeDasharray="2 2" />
          {showBase && (
            <path d={path(baseCash)} fill="none" stroke={CHART_COLORS.slate} strokeWidth="2" strokeDasharray="4 3" />
          )}
          <path d={path(cash)} fill="none" stroke={CHART_COLORS.seriesA} strokeWidth="2" strokeLinejoin="round" />
          {outlook && (
            <g>
              <circle cx={X(outlook.lowIndex)} cy={Y(outlook.low)} r="4.5" fill={CHART_COLORS.seriesA}
                      stroke="white" strokeWidth="2" />
              <text x={X(outlook.lowIndex)} y={Y(outlook.low) + 16} fontSize="10" fontWeight="600"
                    fill={CHART_COLORS.ink} textAnchor="middle">
                Low {fmtCompact(outlook.low)}
              </text>
            </g>
          )}
          {hover !== null && (
            <line x1={X(hover)} y1={padT} x2={X(hover)} y2={H - padB} stroke={CHART_COLORS.slate} strokeWidth="1" />
          )}
          {ss.periods.map((p, i) => (
            <g key={p}>
              <text x={X(i)} y={H - 8} {...CHART_AXIS_TEXT_PIXEL}
                    fill={i > hinge ? CHART_COLORS.ink : CHART_COLORS.axis}
                    textAnchor="middle">{monthLabel(p)}</text>
              <rect x={X(i) - slot / 2} y={padT} width={slot} height={H - padT - padB} fill="transparent"
                    onMouseEnter={() => setHover(i)} />
            </g>
          ))}
        </svg>
        </div>
        {hover !== null && (
          <div className="pointer-events-none absolute top-1 z-10 rounded-md bg-ink-800 ring-1 ring-line shadow-md px-3 py-2 text-[11px] text-fg"
               style={{ left: `${(X(hover) / W) * 100}%`,
                        transform: hover > n / 2 ? "translateX(calc(-100% - 10px))" : "translateX(10px)" }}>
            <div className="font-semibold mb-1">
              {monthLabel(ss.periods[hover])} {ss.periods[hover].slice(0, 4)} · {hover > hinge ? "forecast" : "actual"}
            </div>
            <div className="num tabular-nums">Cash {fmtCompact(cash[hover])}</div>
            {showBase && <div className="num tabular-nums text-fg-muted">Baseline {fmtCompact(baseCash[hover] ?? 0)}</div>}
            <div className="num tabular-nums text-fg-muted">
              {cash[hover] >= minCash ? "Headroom " : "Shortfall "}{fmtCompact(Math.abs(cash[hover] - minCash))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Statement table ──────────────────────────────────────────────────────────
function StatementTable({ ss }: { ss: StatementSet }) {
  const periods = ss.periods;
  const hinge = ss.hinge_index;
  const cell = (id: string, sign: 1 | -1, i: number) => (ss.lines[id]?.[i] ?? 0) * sign;

  const renderRow = (r: Row) => {
    const sign = r.sign ?? 1;
    const total = fy(ss, r.id) * sign;
    return (
      <tr key={r.id} className={cn(r.total && "font-semibold text-fg border-t border-line bg-ink-700/40")}>
        <td className={cn("py-1.5 pr-3 text-fg whitespace-nowrap", r.indent && "pl-6 text-fg-muted")}>
          {r.label}
        </td>
        {periods.map((p, i) => (
          <td key={p} className={cn("py-1.5 px-2 text-right num tabular-nums",
                                    i === hinge && "border-r border-line-strong")}>
            {fmtCompact(cell(r.id, sign, i))}
          </td>
        ))}
        <td className="py-1.5 pl-3 text-right num tabular-nums font-semibold">{fmtCompact(total)}</td>
      </tr>
    );
  };

  const bridgeRow = (id: string, label: string, bold: boolean) => (
    <tr className={cn(bold ? "font-bold text-fg border-t-2 border-line" : "font-semibold text-fg border-t border-line")}>
      <td className="py-2 pr-3 whitespace-nowrap">{label}</td>
      {periods.map((p, i) => (
        <td key={p} className={cn("py-2 px-2 text-right num tabular-nums", i === hinge && "border-r border-line-strong")}>
          {fmtCompact(ss.lines[id]?.[i] ?? 0)}
        </td>
      ))}
      <td className="py-2 pl-3 text-right num tabular-nums">
        {id === "beginning_cash"
          ? fmtCompact(ss.lines[id]?.[0] ?? 0)
          : id === "net_change_in_cash"
            ? fmtCompact(fy(ss, id))
            : fmtCompact(ss.lines[id]?.[periods.length - 1] ?? 0)}
      </td>
    </tr>
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        {/* Forecast columns get a faint zone tint so actuals vs forecast read as
            two blocks; the tint sits behind cells (incl. total-row fills). */}
        <colgroup>
          <col />
          {periods.map((p, i) => (
            <col key={p} className={cn(i > hinge && "bg-accent/[0.05]")} />
          ))}
          <col className="bg-ink-700/30" />
        </colgroup>
        <thead>
          <tr className="text-fg-subtle border-b border-line">
            <th className="py-2 pr-3 text-left font-medium">
              Line <span className="text-fg-muted font-normal">· actuals</span>
            </th>
            {periods.map((p, i) => (
              <th key={p} className={cn("py-2 px-2 text-right font-medium whitespace-nowrap",
                                        i === hinge && "border-r border-line-strong",
                                        i === hinge + 1 && "text-accent",
                                        i > hinge && "text-accent")}>
                {i === hinge + 1 && <span className="block text-[9px] uppercase tracking-wide text-accent/70">forecast</span>}
                {monthLabel(p)}
              </th>
            ))}
            <th className="py-2 pl-3 text-right font-semibold">FY</th>
          </tr>
        </thead>
        <tbody>
          {bridgeRow("beginning_cash", "Beginning cash", false)}
          {SECTIONS.map((sec) => (
            <Fragment key={sec.title}>
              <tr className="text-fg-subtle">
                <td colSpan={periods.length + 2} className="pt-3 pb-1 text-[11px] uppercase tracking-wide font-semibold">
                  {sec.title}
                </td>
              </tr>
              {sec.rows.map(renderRow)}
            </Fragment>
          ))}
          {hasOtherCash(ss) && renderRow(OTHER_CASH_ROW)}
          {bridgeRow("net_change_in_cash", "Net change in cash", false)}
          {bridgeRow("cash_balance", "Ending cash", true)}
        </tbody>
      </table>
      <p className="text-[11px] text-fg-subtle mt-2">
        Columns left of the divider are locked actuals, tied to posted cash; the shaded columns are the
        forecast the scenario flexes, rolling on from the last posted balance.
        Ending cash = beginning cash + net change (CFO + CFI + CFF{hasOtherCash(ss) ? " + other operating items" : ""}), tied out every period.
        {hasOtherCash(ss) && " Other operating items, net = posted cash movements from balance-sheet lines the model doesn't break out."}
      </p>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────
/** `scenario=<id>` from the page's hash query (deep link from Scenario Planning). */
export function scenarioFromQuery(query: string | undefined): string | null {
  return new URLSearchParams(query ?? "").get("scenario") || null;
}

/** A saved scenario's assumption values (the store keeps `{ value, unit, … }`). */
export function planValues(plan: ScenarioPlan | null): Record<string, number> {
  const a: Record<string, number> = {};
  if (plan) Object.entries(plan.assumptions).forEach(([k, v]) => { a[k] = v.value; });
  return a;
}

// Cash Flow is a read-only lens: the levers live on Scenario Planning (the one place
// planning assumptions are edited); this page reads a saved scenario — or the
// baseline — and shows its cash. Minimum cash stays here until it becomes a policy.
const NO_EDITABLE = new Set<string>();

export default function CashFlow({ refreshKey, query, onNavigate }: {
  refreshKey: number;
  /** Hash query, e.g. `scenario=<id>` to open a specific scenario. */
  query?: string;
  onNavigate?: (page: PageId, query?: string) => void;
}) {
  const [drivers, setDrivers] = useState<DriverDef[]>([]);
  const [result, setResult] = useState<ProjectResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Minimum cash in $M; null = the default policy (one month of operating costs).
  const [minCashM, setMinCashM] = useState<number | null>(null);
  useEffect(() => { setMinCashM(null); }, [refreshKey]);

  // Shared scenario library (same store as Scenario Planning).
  const [plans, setPlans] = useState<PlanListItem[]>([]);
  const [plan, setPlan] = useState<ScenarioPlan | null>(null);
  const [selectedId, setSelectedId] = useState<string>(() => scenarioFromQuery(query) ?? "");
  useEffect(() => { setSelectedId(scenarioFromQuery(query) ?? ""); }, [query]);

  useEffect(() => {
    let live = true;
    api.scenarioDrivers()
      .then((d) => { if (live) setDrivers(d.drivers); })
      .catch((e) => { if (live) setError(String(e.message ?? e)); });
    api.scenarioPlans()
      .then((r) => { if (live) setPlans(r.plans ?? []); })
      .catch(() => { if (live) setPlans([]); });
    return () => { live = false; };
  }, [refreshKey]);

  // Load the selected scenario ("" = baseline).
  useEffect(() => {
    let live = true;
    if (!selectedId) { setPlan(null); return; }
    api.scenarioPlan(selectedId)
      .then((p) => { if (live) setPlan(p); })
      .catch((e) => { if (live) { setPlan(null); setError(String(e.message ?? e)); } });
    return () => { live = false; };
  }, [selectedId, refreshKey]);

  const assumptions = useMemo(() => planValues(plan), [plan]);
  const anyLever = Object.values(assumptions).some((v) => v !== 0);

  // Project whenever the scenario changes.
  useEffect(() => {
    let live = true;
    setLoading(true);
    api.scenarioProject(nonZero(assumptions))
      .then((r) => { if (live) { setResult(r); setError(null); } })
      .catch((e) => { if (live) setError(String(e.message ?? e)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [assumptions, refreshKey]);

  const ss = result?.projection;
  const base = result?.baseline;

  const defaultMin = base ? defaultMinCash(base) : 0;
  const minCash = minCashM !== null ? minCashM * 1e6 : defaultMin;
  const outlook = useMemo(() => (ss ? liquidityOutlook(ss, minCash) : null), [ss, minCash]);

  const kpis = useMemo(() => {
    if (!ss) return null;
    const endCash = ss.lines.cash_balance?.[ss.periods.length - 1] ?? 0;
    const baseEnd = base?.lines.cash_balance?.[base.periods.length - 1] ?? endCash;
    const begin = ss.lines.beginning_cash?.[0] ?? 0;
    return { endCash, delta: endCash - baseEnd, begin, netChange: fy(ss, "net_change_in_cash") };
  }, [ss, base]);

  // Semantic KPI tiles — colour only where there's polarity to read; magnitude
  // facts (beginning cash) stay neutral. Colour is paired with ▲/▼ (never alone).
  type Note = { tone: "good" | "bad"; text: string } | null;
  const kpiTiles: { k: string; v: number | undefined; note: Note; valueBad: boolean }[] = [
    { k: "Beginning cash", v: kpis?.begin, note: null, valueBad: false },
    { k: "Ending cash", v: kpis?.endCash, valueBad: false,
      note: kpis && anyLever && Math.abs(kpis.delta) >= 1
        ? { tone: kpis.delta >= 0 ? "good" : "bad",
            text: `${kpis.delta >= 0 ? "▲" : "▼"} ${fmtSignedCompact(kpis.delta)} vs baseline` }
        : null },
    { k: "FY net change", v: kpis?.netChange, valueBad: false,
      note: kpis
        ? { tone: kpis.netChange >= 0 ? "good" : "bad",
            text: kpis.netChange >= 0 ? "▲ building cash" : "▼ burning cash" }
        : null },
    { k: "Lowest forecast cash", v: outlook?.low, valueBad: !!outlook && outlook.firstBreachIndex !== null,
      note: !outlook || !ss ? null
        : outlook.firstBreachIndex !== null
          ? { tone: "bad", text: `▼ below minimum from ${monthLabel(ss.periods[outlook.firstBreachIndex])}` }
          : { tone: "good", text: `▲ ${fmtCompact(outlook.headroom)} above minimum · ${monthLabel(ss.periods[outlook.lowIndex])}` } },
  ];

  const editLink = () => onNavigate?.("scenario-planning", selectedId ? `scenario=${encodeURIComponent(selectedId)}` : "");

  return (
    <div className="space-y-5">
      {/* Scenario bar — reads the shared library; edits happen on Scenario Planning */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-fg-subtle">Scenario</span>
        <select
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          className="rounded-md ring-1 ring-line bg-ink-800 text-fg text-sm px-2 py-1 max-w-[16rem]"
          aria-label="Scenario">
          <option value="">Baseline (no changes)</option>
          {plans.filter((p) => !p.is_baseline).map((p) => (
            <option key={p.scenario_id} value={p.scenario_id}>
              {p.name}{p.status !== "draft" ? ` · ${p.status}` : ""}
            </option>
          ))}
        </select>
        {onNavigate && (
          <button type="button" onClick={editLink} className="text-xs text-accent hover:underline">
            {selectedId ? "Edit assumptions in Scenario Planning →" : "Build a scenario in Scenario Planning →"}
          </button>
        )}
      </div>

      {anyLever && (
        <OffLensAssumptions drivers={drivers} assumptions={assumptions} editableIds={NO_EDITABLE}
                            title="Scenario assumptions" note="(edit on Scenario Planning)" />
      )}

      {error && <ErrorNote message={error} />}

      {/* KPI strip — same typography as the FP&A Overview headline strip */}
      <section className="rounded-2xl tile ring-1 ring-line overflow-hidden">
        <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-line">
          {kpiTiles.map((c) => (
            <div key={c.k} className="px-3 py-2.5 min-w-0">
              <div className="text-[10px] text-fg-muted leading-tight truncate">{c.k}</div>
              <div className={cn("text-base font-semibold tabular-nums leading-tight mt-0.5",
                                 c.valueBad ? "text-signal-bad" : "text-fg")}>
                {kpis ? fmtCompact(c.v ?? 0) : <Skeleton className="h-5 w-20" />}
              </div>
              {c.note && (
                <div className={cn("text-[10px] font-medium",
                                   c.note.tone === "good" ? "text-signal-good" : "text-signal-bad")}>
                  {c.note.text}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      <Card title="Cash balance vs minimum" subtitle="Monthly; actuals tie to posted cash, shaded months are forecast"
            action={
              <div className="flex flex-col items-end gap-1 text-xs text-fg-subtle shrink-0">
                <div className="flex items-center gap-2">
                  <label htmlFor="min-cash">Minimum cash ($M)</label>
                  <input id="min-cash" type="number" step="0.1" min="0"
                         value={minCashM ?? Number((defaultMin / 1e6).toFixed(1))}
                         onChange={(e) => setMinCashM(e.target.value === "" ? null : Number(e.target.value))}
                         className="w-20 rounded-md ring-1 ring-line bg-ink-800 text-fg text-xs px-2 py-1 num tabular-nums" />
                </div>
                {minCashM === null
                  ? <span className="text-[11px]">default: one month of operating costs (COGS + opex)</span>
                  : <button type="button" onClick={() => setMinCashM(null)} className="text-[11px] text-accent hover:underline">
                      reset to one month of operating costs
                    </button>}
              </div>
            }>
        <div className="px-4 py-4">
          {ss ? <CashBalanceChart ss={ss} base={base} showBase={anyLever} minCash={minCash} outlook={outlook} />
              : <Skeleton className="h-56 w-full" />}
          {result?.baseline_source && (
            <p className="text-[11px] text-fg-subtle mt-2">
              <span className="font-semibold text-fg-muted">Forecast baseline:</span>{" "}
              {BASELINE_SOURCE_COPY[result.baseline_source]}
            </p>
          )}
        </div>
      </Card>
      <Card title="Cash bridge" subtitle="Full year: beginning cash → drivers → ending cash">
        <div className="px-4 py-4">
          {ss ? <CashBridge ss={ss} /> : <Skeleton className="h-64 w-full" />}
        </div>
      </Card>
      <Card title="Cash flow statement" subtitle="Operating · investing · financing, tied out to the cash balance">
        <div className="px-5 py-4">
          {ss ? <StatementTable ss={ss} /> : (
            <div className="space-y-2">
              {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-5 w-full" />)}
            </div>
          )}
        </div>
      </Card>
      {loading && !ss && <p className="text-xs text-fg-subtle">Loading projection…</p>}
    </div>
  );
}
