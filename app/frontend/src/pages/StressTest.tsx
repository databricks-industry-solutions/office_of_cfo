import { useEffect, useMemo, useState } from "react";
import {
  api, CashFlow, CashFlowTrendPoint, fmt, getActivePeriod, KpiTrendPoint, OrgTree, Scope,
  WorkingCapitalKpis,
} from "../api";
import { Card, ErrorNote, KpiCard } from "../components/ui";
import { projectCashOutlook } from "../lib/cashOutlook";
import {
  CHART_AXIS_TEXT_PIXEL,
  CHART_COLORS,
} from "../lib/chartPalette";
import { cn } from "../lib/cn";
import { useOverlay } from "../lib/industry";
import { OutlookView, projectRevenueOutlook } from "../lib/revenueOutlook";
import { bandPath, catmullRomPath } from "../lib/runwayProjection";
import { ChartSize, useChartSize } from "../lib/useChartSize";

interface Levers {
  arCollectPct: number;   // − = collect faster (lower AR)
  dpoExtraDays: number;   // extend payables by N days
  invReducePct: number;   // reduce inventory
  revShockPct: number;    // revenue up/down
  cogsShockPct: number;   // COGS up/down
}

type ScenarioMode = "liquidity" | "revenue";
type LiquidityView = "runway" | "heatmap";

const ZERO: Levers = { arCollectPct: 0, dpoExtraDays: 0, invReducePct: 0, revShockPct: 0, cogsShockPct: 0 };

interface Kpis { dso: number; dpo: number; dio: number; ccc: number; }

function computeKpis(ar: number, ap: number, inv: number, rev: number, cogs: number, days: number): Kpis {
  const dso = rev ? (ar / rev) * days : 0;
  const dpo = cogs ? (ap / cogs) * days : 0;
  const dio = cogs ? (inv / cogs) * days : 0;
  return { dso, dpo, dio, ccc: dso + dio - dpo };
}

// Day metrics are always shown as whole numbers (no decimals).
const roundDays = (v: number) => Math.round(v);

// Rounded-to-thousands currency for the tiles ($355k, $2.1M).
const fmtK = (v: number) => {
  const a = Math.abs(v);
  const s = v < 0 ? "−" : "";
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(1)}M`;
  return `${s}$${Math.round(a / 1e3)}k`;
};

// Compact currency for chart axes / labels ($1.2M, $840K, −$3.1M).
const fmtCompact = (v: number) => {
  const a = Math.abs(v);
  const s = v < 0 ? "−" : "";
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(0)}K`;
  return `${s}$${Math.round(a)}`;
};

// ── Shared chart geometry ────────────────────────────────────────────────────
// Both outlook charts draw the same way: an actuals series on the left, forecast
// series on the right of a hinge, on a y-axis zoomed to the plotted data so
// lever deltas use the full plot height.
const PAD = { L: 58, R: 112, T: 30, B: 24 };

interface Scales {
  plotW: number;
  plotH: number;
  right: number;
  bottom: number;
  X: (i: number) => number;
  Y: (v: number) => number;
  yTicks: { y: number; label: string }[];
  zeroY: number | null;
}

function makeScales(size: ChartSize, n: number, values: number[]): Scales {
  const plotW = Math.max(size.width - PAD.L - PAD.R, 40);
  const plotH = Math.max(size.height - PAD.T - PAD.B, 60);
  let yMin = Math.min(...values);
  let yMax = Math.max(...values);
  if (yMin < 0) yMax = Math.max(yMax, 0);
  const span = yMax - yMin || Math.abs(yMax) || 1;
  yMax += span * 0.12;
  yMin -= span * 0.12;

  const X = (i: number) => PAD.L + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const Y = (v: number) => PAD.T + (1 - (v - yMin) / (yMax - yMin || 1)) * plotH;
  const count = plotH < 150 ? 3 : plotH < 260 ? 4 : 5;
  const yTicks = Array.from({ length: count }, (_, i) => {
    const v = yMin + ((yMax - yMin) * i) / (count - 1);
    return { y: Y(v), label: fmtCompact(v) };
  });

  return {
    plotW, plotH,
    right: PAD.L + plotW,
    bottom: PAD.T + plotH,
    X, Y, yTicks,
    zeroY: yMin < 0 && yMax > 0 ? Y(0) : null,
  };
}

interface SeriesGeom {
  xs: number[];
  ys: number[];
  path: string;
  pts: { x: number; y: number }[];
}

// Drop the null gaps so a partially-defined series (actuals before the hinge,
// forecast after) plots as one continuous path.
function seriesGeom(series: (number | null)[], s: Scales): SeriesGeom {
  const idx = series.map((v, i) => (v == null ? -1 : i)).filter((i) => i >= 0);
  const xs = idx.map((i) => s.X(i));
  const ys = idx.map((i) => s.Y(series[i]!));
  return { xs, ys, path: catmullRomPath(xs, ys), pts: xs.map((x, k) => ({ x, y: ys[k] })) };
}

function definedValues(...series: (number | null)[][]): number[] {
  return series.flat().filter((v): v is number => v != null);
}

// Every ~nth label so ticks never collide, with the hinge and the last point kept.
function xTickIndexes(n: number, hingeIndex: number, plotW: number): number[] {
  const step = Math.max(1, Math.ceil(n / Math.max(3, Math.floor(plotW / 70))));
  const keep = new Set<number>([0, hingeIndex, n - 1]);
  for (let i = 0; i < n; i += step) keep.add(i);
  return Array.from(keep).sort((a, b) => a - b);
}

export default function StressTest({
  scope, refreshKey,
}: {
  scope: Scope;
  org: OrgTree | null;
  refreshKey: number;
}) {
  const ov = useOverlay();
  const hideInventory = ov.stressHiddenLevers.includes("inventory");
  const hideDio = ov.hiddenKpis.includes("dio");
  const invLabel = ov.stressLeverLabels?.inventory ?? "Inventory";
  const [base, setBase] = useState<WorkingCapitalKpis | null>(null);
  const [cash, setCash] = useState<CashFlow | null>(null);
  const [trend, setTrend] = useState<KpiTrendPoint[] | null>(null);
  const [cashTrend, setCashTrend] = useState<CashFlowTrendPoint[] | null>(null);
  const [levers, setLevers] = useState<Levers>(ZERO);
  const [scenarioMode, setScenarioMode] = useState<ScenarioMode>("liquidity");
  const [liquidityView, setLiquidityView] = useState<LiquidityView>("runway");
  const [revenueView, setRevenueView] = useState<OutlookView>("monthly");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setCash(null);
    setTrend(null);
    setCashTrend(null);
    // Cash-flow and trend are best-effort: runway / revenue outlook degrade
    // gracefully when either is missing; KPI levers still work from /kpis.
    Promise.all([
      api.kpis(scope),
      api.cashFlow(scope).catch(() => null),
      api.kpiTrend(scope).catch(() => null),
      api.cashFlowTrend(scope).catch(() => null),
    ])
      .then(([k, cf, tr, cft]) => {
        if (!cancelled) {
          setBase(k);
          setCash(cf);
          setTrend(tr);
          setCashTrend(cft);
          setError(null);
        }
      })
      .catch((e) => { if (!cancelled) setError(e?.message || "Couldn’t load KPI baseline."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [scope, refreshKey]);

  const revenueClosePeriod = base?.period || getActivePeriod();
  const revenueHasForecastMonths = useMemo(() => {
    if (!trend?.length) return true;
    const months = trend.map((p) => ({
      period: p.period,
      revenue: Number(p.revenue) || 0,
    }));
    const outlook = projectRevenueOutlook({ months, revShockPct: 0, closePeriod: revenueClosePeriod });
    if (!outlook) return true;
    return outlook.hingeIndex < 11;
  }, [trend, revenueClosePeriod]);

  const activeLevers = useMemo<Levers>(() => {
    if (scenarioMode === "revenue") {
      return {
        arCollectPct: 0,
        dpoExtraDays: 0,
        invReducePct: 0,
        revShockPct: revenueHasForecastMonths ? levers.revShockPct : 0,
        cogsShockPct: 0,
      };
    }
    return {
      arCollectPct: levers.arCollectPct,
      dpoExtraDays: levers.dpoExtraDays,
      invReducePct: hideInventory ? 0 : levers.invReducePct,
      revShockPct: 0,
      cogsShockPct: levers.cogsShockPct,
    };
  }, [scenarioMode, levers, hideInventory, revenueHasForecastMonths]);

  const model = useMemo(() => {
    if (!base) return null;
    const c = base.components;
    const days = base.days_in_period || 30;
    const ar = c.ar_balance, ap = c.ap_balance, inv = c.inventory_balance, rev = c.revenue, cogs = c.cogs;

    const sAR = ar * (1 + activeLevers.arCollectPct / 100);
    const sRev = rev * (1 + activeLevers.revShockPct / 100);
    const sCOGS = cogs * (1 + activeLevers.cogsShockPct / 100);
    const invPct = hideInventory ? 0 : activeLevers.invReducePct;
    const sInv = inv * (1 - invPct / 100);
    const sAP = ap + activeLevers.dpoExtraDays * (cogs / days); // N extra days of payables

    const baseK = computeKpis(ar, ap, inv, rev, cogs, days);
    const scenK = computeKpis(sAR, sAP, sInv, sRev, sCOGS, days);
    // Translate the CCC change into cash using baseline daily sales.
    const cashFreed = (baseK.ccc - scenK.ccc) * (rev / days);

    // Runway decomposition:
    //  • wcRelease — one-time cash released by the working-capital levers
    //    (collect AR sooner, hold inventory less, pay suppliers later).
    //  • plDelta — recurring per-period operating-cash change from the P&L
    //    shocks (extra gross margin each month).
    const wcRelease = (ar - sAR) + (inv - sInv) + (sAP - ap);
    const plDelta = (sRev - rev) - (sCOGS - cogs);

    const components = {
      ar: { base: ar, scen: sAR },
      inv: { base: inv, scen: sInv },
      ap: { base: ap, scen: sAP },
      rev: { base: rev, scen: sRev },
      cogs: { base: cogs, scen: sCOGS },
    };

    return { days, baseK, scenK, cashFreed, wcRelease, plDelta, components };
  }, [base, activeLevers, hideInventory]);

  // Anchor for the runway projection: current cash position + baseline monthly
  // cash build. The slope comes from the trailing year of posted ending cash —
  // extrapolating a single month's build would quadruple cash over the horizon
  // and bury the lever effects. Falls back to the close period's own build, then
  // to net income, when history / cash-flow is absent.
  const cashAnchor = useMemo(() => {
    const window = (cashTrend ?? []).slice(-13).map((p) => Number(p.ending_cash) || 0);
    const trendSlope = window.length > 1
      ? (window[window.length - 1] - window[0]) / (window.length - 1)
      : null;
    if (cash) {
      return {
        start: cash.ending_cash,
        monthly: trendSlope ?? cash.ending_cash - cash.beginning_cash,
      };
    }
    if (base) return { start: base.components.net_income, monthly: trendSlope ?? base.components.net_income };
    return { start: 0, monthly: 0 };
  }, [cash, base, cashTrend]);

  const set = (k: keyof Levers) => (v: number) => setLevers((prev) => ({ ...prev, [k]: v }));
  const liquidityDirty = useMemo(() => {
    const invDirty = !hideInventory && levers.invReducePct !== 0;
    return levers.arCollectPct !== 0 || levers.dpoExtraDays !== 0 || invDirty || levers.cogsShockPct !== 0;
  }, [levers, hideInventory]);
  const activeModeDirty = useMemo(() => {
    if (scenarioMode === "revenue") return revenueHasForecastMonths && levers.revShockPct !== 0;
    return liquidityDirty;
  }, [scenarioMode, levers, liquidityDirty, revenueHasForecastMonths]);
  const impactTitle = scenarioMode === "revenue"
    ? "Revenue outlook"
    : liquidityView === "runway"
      ? "Cash runway"
      : "Cash impact heatmap";
  const impactSubtitle = scenarioMode === "revenue"
    ? `${revenueView === "monthly" ? "Monthly" : "FY cumulative"} revenue · actuals locked through ${revenueClosePeriod}`
    : liquidityView === "runway"
      ? `Posted cash through ${revenueClosePeriod}, then 12 forecast months at the trailing cash build`
      : "Cash freed by combined lever settings";

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-4 pb-2">
      {error && <ErrorNote message={error} />}

      {loading || !model || !base ? (
        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-5 gap-6 items-stretch">
          <Card className="lg:col-span-2 min-h-[24rem]"><div className="h-full" /></Card>
          <Card className="lg:col-span-3 min-h-[24rem]"><div className="h-full" /></Card>
        </div>
      ) : (
        <>
          <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-5 gap-6 items-stretch">
            {/* Left: scenario levers */}
            <Card
              className="lg:col-span-2"
              title="Scenario levers"
              action={<button onClick={() => setLevers((prev) => (
                scenarioMode === "revenue"
                  ? { ...prev, revShockPct: 0 }
                  : { ...prev, arCollectPct: 0, dpoExtraDays: 0, invReducePct: 0, cogsShockPct: 0 }
              ))} disabled={!activeModeDirty}
                              className="text-xs text-fg-muted hover:text-fg underline underline-offset-2 disabled:opacity-40 disabled:no-underline">
                Reset to baseline
              </button>}
            >
              <div className="px-5 py-4 space-y-4">
                <div
                  role="group"
                  aria-label="Scenario mode"
                  className="inline-flex items-center gap-0.5 rounded-lg bg-black/[0.05] p-0.5"
                >
                  <button
                    type="button"
                    aria-pressed={scenarioMode === "liquidity"}
                    onClick={() => setScenarioMode("liquidity")}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                      scenarioMode === "liquidity" ? "bg-ink-800 text-fg shadow-sm ring-1 ring-line" : "text-fg-muted hover:text-fg"
                    }`}
                  >
                    Liquidity
                  </button>
                  <button
                    type="button"
                    aria-pressed={scenarioMode === "revenue"}
                    onClick={() => setScenarioMode("revenue")}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                      scenarioMode === "revenue" ? "bg-ink-800 text-fg shadow-sm ring-1 ring-line" : "text-fg-muted hover:text-fg"
                    }`}
                  >
                    Revenue
                  </button>
                </div>

                {scenarioMode === "liquidity" ? (
                  <>
                    <SliderGroup label="Receivables">
                      <Slider label="AR collections" value={levers.arCollectPct} min={-40} max={40} step={1}
                              onChange={set("arCollectPct")}
                              readout={(v) => v === 0 ? "at baseline" : v < 0 ? `${-v}% faster` : `${v}% slower`} />
                    </SliderGroup>
                    <SliderGroup label="Payables">
                      <Slider label="Extend DPO" value={levers.dpoExtraDays} min={0} max={60} step={1}
                              onChange={set("dpoExtraDays")}
                              readout={(v) => v === 0 ? "at baseline" : `+${v} days`} />
                    </SliderGroup>
                    {!hideInventory && (
                      <SliderGroup label={invLabel}>
                        <Slider label={`Reduce ${invLabel.toLowerCase()}`} value={levers.invReducePct} min={0} max={60} step={1}
                                onChange={set("invReducePct")}
                                readout={(v) => v === 0 ? "at baseline" : `−${v}%`} />
                      </SliderGroup>
                    )}
                    <SliderGroup label="P&L shock">
                      <Slider label={ov.cogsLabel} value={levers.cogsShockPct} min={-30} max={30} step={1}
                              onChange={set("cogsShockPct")}
                              readout={(v) => v === 0 ? "at baseline" : `${v > 0 ? "+" : ""}${v}%`} />
                    </SliderGroup>
                  </>
                ) : (
                  <SliderGroup label="P&L shock">
                    <Slider label="Revenue" value={levers.revShockPct} min={-30} max={30} step={1}
                            onChange={set("revShockPct")}
                            disabled={!revenueHasForecastMonths}
                            readout={(v) => v === 0 ? "at baseline" : `${v > 0 ? "+" : ""}${v}%`} />
                    {!revenueHasForecastMonths && (
                      <p className="text-[11px] text-fg-subtle">FY complete — no forecast months remain.</p>
                    )}
                  </SliderGroup>
                )}
              </div>
            </Card>

            {/* Right: KPI strip + one impact card */}
            <div className="lg:col-span-3 flex flex-col gap-6 h-full">
              <section className={`grid gap-4 ${hideDio ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-2 xl:grid-cols-5"}`}>
                <KpiCard label={ov.kpiLabels.dso ?? "DSO"} value={roundDays(model.scenK.dso)} unit="days" better="lower"
                         delta={roundDays(model.scenK.dso - model.baseK.dso)} deltaSuffix="vs baseline" />
                {!hideDio && (
                  <KpiCard label={ov.kpiLabels.dio ?? "DIO"} value={roundDays(model.scenK.dio)} unit="days" better="lower"
                           delta={roundDays(model.scenK.dio - model.baseK.dio)} deltaSuffix="vs baseline" />
                )}
                <KpiCard label={ov.kpiLabels.dpo ?? "DPO"} value={roundDays(model.scenK.dpo)} unit="days" better="higher"
                         delta={roundDays(model.scenK.dpo - model.baseK.dpo)} deltaSuffix="vs baseline" />
                <KpiCard label={ov.kpiLabels.ccc ?? "CCC"} value={roundDays(model.scenK.ccc)} unit="days" better="lower"
                         delta={roundDays(model.scenK.ccc - model.baseK.ccc)} deltaSuffix="vs baseline" />
                {scenarioMode === "revenue" ? (
                  <RevenueDeltaTile
                    baselineRevenue={model.components.rev.base}
                    scenarioRevenue={model.components.rev.scen}
                  />
                ) : (
                  <CashFreedTile cashFreed={model.cashFreed} />
                )}
              </section>

              <Card
                className="flex-1 min-h-0"
                fill
                title={impactTitle}
                subtitle={impactSubtitle}
                action={scenarioMode === "revenue" ? (
                  <label className="flex items-center gap-1.5 text-[11px] text-fg-subtle">
                    View
                    <select
                      value={revenueView}
                      onChange={(e) => setRevenueView(e.target.value as OutlookView)}
                      aria-label="Revenue outlook view"
                      className="text-[11px] bg-transparent text-fg-muted rounded px-1.5 py-0.5 ring-1 ring-line hover:text-fg focus:outline-none cursor-pointer"
                    >
                      <option value="monthly">Monthly</option>
                      <option value="cumulative">Cumulative</option>
                    </select>
                  </label>
                ) : (
                  <div
                    role="group"
                    aria-label="Liquidity impact view"
                    className="inline-flex items-center gap-0.5 rounded-lg bg-black/[0.05] p-0.5"
                  >
                    <button
                      type="button"
                      aria-pressed={liquidityView === "runway"}
                      onClick={() => setLiquidityView("runway")}
                      className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                        liquidityView === "runway" ? "bg-ink-800 text-fg shadow-sm ring-1 ring-line" : "text-fg-muted hover:text-fg"
                      }`}
                    >
                      Cash runway
                    </button>
                    <button
                      type="button"
                      aria-pressed={liquidityView === "heatmap"}
                      onClick={() => setLiquidityView("heatmap")}
                      className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                        liquidityView === "heatmap" ? "bg-ink-800 text-fg shadow-sm ring-1 ring-line" : "text-fg-muted hover:text-fg"
                      }`}
                    >
                      Heatmap
                    </button>
                  </div>
                )}
              >
                <div className="px-3 pt-2 pb-3 flex-1 min-h-[19rem] flex flex-col">
                  {scenarioMode === "revenue" ? (
                    <RevenueOutlookChart
                      trend={trend}
                      closePeriod={revenueClosePeriod}
                      revShockPct={activeLevers.revShockPct}
                      view={revenueView}
                      className="flex-1 min-h-0"
                    />
                  ) : liquidityView === "runway" ? (
                    <CashRunwayChart
                      cashTrend={cashTrend}
                      closePeriod={revenueClosePeriod}
                      startCash={cashAnchor.start}
                      monthlyBase={cashAnchor.monthly}
                      wcRelease={model.wcRelease}
                      plDelta={model.plDelta}
                      dirty={liquidityDirty}
                      className="flex-1 min-h-0"
                    />
                  ) : (
                    <CashImpactHeatmap
                      base={base}
                      levers={activeLevers}
                      hideInventory={hideInventory}
                      className="flex-1 min-h-0"
                    />
                  )}
                </div>
              </Card>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// Cash-outcome tile styled to sit in the KPI row (matches KpiCard height).
function CashFreedTile({ cashFreed, className = "" }: { cashFreed: number; className?: string }) {
  const freed = cashFreed >= 0;
  return (
    <div className={cn("tile tile-hover ring-1 ring-line p-5 flex flex-col", className)}>
      <div className="text-[11px] uppercase tracking-wide text-fg-subtle">
        Cash {freed ? "freed" : "consumed"}
      </div>
      <div className="flex items-end gap-2 mt-1">
        <div className={cn("text-3xl font-bold num transition-colors", freed ? "text-signal-good" : "text-signal-bad")}>
          {fmtK(Math.abs(cashFreed))}
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2 text-xs">
        <span className="text-fg-subtle">one-time WC release</span>
      </div>
    </div>
  );
}

function RevenueDeltaTile({
  baselineRevenue,
  scenarioRevenue,
  className = "",
}: {
  baselineRevenue: number;
  scenarioRevenue: number;
  className?: string;
}) {
  const delta = scenarioRevenue - baselineRevenue;
  const positive = delta >= 0;
  return (
    <div className={cn("tile tile-hover ring-1 ring-line p-5 flex flex-col", className)}>
      <div className="text-[11px] uppercase tracking-wide text-fg-subtle">
        Revenue change
      </div>
      <div className="flex items-end gap-2 mt-1">
        <div className={cn("text-3xl font-bold num transition-colors", positive ? "text-signal-good" : "text-signal-bad")}>
          {positive ? "+" : "−"}{fmtK(Math.abs(delta))}
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2 text-xs">
        <span className="text-fg-subtle">per month vs baseline</span>
      </div>
    </div>
  );
}

// Cash runway with a hinge: posted monthly ending cash on the left, then the
// projection on the right — baseline, WC-only, P&L-only and the combined
// scenario, which lifts off by the one-time working-capital release (phased over
// 3 months) and bends by the recurring P&L delta. The shaded band between
// combined and baseline is the cash the scenario buys.
function CashRunwayChart({
  cashTrend, closePeriod, startCash, monthlyBase, wcRelease, plDelta, dirty, className = "",
}: {
  cashTrend: CashFlowTrendPoint[] | null;
  closePeriod: string;
  startCash: number; monthlyBase: number; wcRelease: number; plDelta: number;
  dirty: boolean; className?: string;
}) {
  const { ref, size } = useChartSize();

  const outlook = useMemo(() => projectCashOutlook({
    months: (cashTrend ?? []).map((p) => ({
      period: p.period,
      ending_cash: Number(p.ending_cash) || 0,
    })),
    closePeriod,
    startCash,
    monthlyBase,
    wcRelease,
    plDelta,
  }), [cashTrend, closePeriod, startCash, monthlyBase, wcRelease, plDelta]);

  const geom = useMemo(() => {
    const n = outlook.periods.length;
    const s = makeScales(size, n, definedValues(
      outlook.actuals, outlook.baseline, outlook.combined,
      dirty ? outlook.wcOnly : [], dirty ? outlook.plOnly : [],
    ));
    const actual = seriesGeom(outlook.actuals, s);
    const base = seriesGeom(outlook.baseline, s);
    const comb = seriesGeom(outlook.combined, s);
    const endBaseY = s.Y(outlook.endBaseline);
    const endCombY = s.Y(outlook.endCombined);

    return {
      s,
      actual,
      base,
      comb,
      wc: seriesGeom(outlook.wcOnly, s),
      pl: seriesGeom(outlook.plOnly, s),
      band: bandPath(comb.xs, comb.ys, base.ys),
      hingeX: s.X(outlook.hingeIndex),
      hingeY: s.Y(outlook.actuals[outlook.hingeIndex] ?? outlook.endBaseline),
      endBaseY,
      endCombY,
      labelBaseY: Math.abs(endCombY - endBaseY) < 14
        ? (endCombY <= endBaseY ? endCombY + 16 : endCombY - 16)
        : endBaseY,
      xTicks: xTickIndexes(n, outlook.hingeIndex, s.plotW)
        .map((i) => ({ x: s.X(i), label: outlook.labels[i] })),
      xEnd: s.X(n - 1),
    };
  }, [outlook, size, dirty]);

  const positive = outlook.insights.endUplift >= 0;
  const scenColor = positive ? CHART_COLORS.good : CHART_COLORS.bad;
  const actualColor = CHART_COLORS.accent;

  const insights = outlook.insights;

  return (
    <div className={cn("h-full flex flex-col", className)}>
      <div ref={ref} className="flex-1 min-h-0">
        <svg width={size.width} height={size.height} viewBox={`0 0 ${size.width} ${size.height}`}
             className="font-sans"
             role="img"
             aria-label="Posted monthly cash then a 12-month projection, baseline vs scenario">
          <defs>
            <linearGradient id="runway-band" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={scenColor} stopOpacity="0.22" />
              <stop offset="100%" stopColor={scenColor} stopOpacity="0.02" />
            </linearGradient>
          </defs>

          {/* Forecast-side tint */}
          <rect x={geom.hingeX} y={PAD.T} width={Math.max(geom.s.right - geom.hingeX, 0)}
                height={geom.s.plotH} fill={CHART_COLORS.seriesA} opacity="0.06" />

          {geom.s.yTicks.map((t, i) => (
            <g key={i}>
              <line x1={PAD.L} x2={geom.s.right} y1={t.y} y2={t.y} stroke="rgba(23,25,32,0.07)" strokeWidth="1" />
              <text x={PAD.L - 6} y={t.y + 3} {...CHART_AXIS_TEXT_PIXEL}
                    fill={CHART_COLORS.axis} textAnchor="end">{t.label}</text>
            </g>
          ))}

          {geom.s.zeroY != null && (
            <line x1={PAD.L} x2={geom.s.right} y1={geom.s.zeroY} y2={geom.s.zeroY}
                  stroke={CHART_COLORS.bad} strokeOpacity="0.35" strokeWidth="1" strokeDasharray="4 3" />
          )}

          {/* Hinge divider */}
          <line x1={geom.hingeX} x2={geom.hingeX} y1={PAD.T} y2={geom.s.bottom}
                stroke={CHART_COLORS.slate} strokeWidth="1.25" strokeDasharray="4 4" />

          <ChartPills
            hingeX={geom.hingeX}
            left="Posted cash · locked"
            right={dirty ? "Forecast · 4 paths" : "Forecast · at baseline"}
            rightEdge={geom.s.right}
          />

          <path d={geom.band} fill="url(#runway-band)" className="transition-all duration-300 ease-out" />

          {/* posted actuals */}
          <path d={geom.actual.path} fill="none" stroke={actualColor} strokeWidth="2.25"
                strokeLinejoin="round" strokeLinecap="round" />
          {/* baseline (dashed reference) */}
          <path d={geom.base.path} fill="none" stroke={CHART_COLORS.axis} strokeWidth="1.75"
                strokeDasharray="5 4" strokeLinejoin="round" strokeLinecap="round" />
          {dirty && (
            <>
              <path d={geom.wc.path} fill="none" stroke={CHART_COLORS.seriesA} strokeWidth="1.5"
                    strokeDasharray="2 3" strokeLinejoin="round" strokeLinecap="round"
                    className="transition-all duration-300 ease-out" />
              <path d={geom.pl.path} fill="none" stroke={CHART_COLORS.seriesB} strokeWidth="1.5"
                    strokeLinejoin="round" strokeLinecap="round" opacity="0.85"
                    className="transition-all duration-300 ease-out" />
            </>
          )}
          {/* combined (solid, coloured by direction) */}
          <path d={geom.comb.path} fill="none" stroke={scenColor} strokeWidth="2.5"
                strokeLinejoin="round" strokeLinecap="round" className="transition-all duration-300 ease-out" />

          {geom.actual.pts.map((p, i) => (
            <circle key={`a${i}`} cx={p.x} cy={p.y} r="3.25" fill="#fff" stroke={actualColor} strokeWidth="1.75" />
          ))}
          <circle cx={geom.hingeX} cy={geom.hingeY} r="4.5" fill="#fff" stroke={CHART_COLORS.accent} strokeWidth="2" />

          {/* endpoints */}
          <circle cx={geom.xEnd} cy={geom.endBaseY} r="3" fill="#fff" stroke={CHART_COLORS.axis} strokeWidth="1.75" />
          <circle cx={geom.xEnd} cy={geom.endCombY} r="4" fill="#fff" stroke={scenColor} strokeWidth="2"
                  className="transition-all duration-300 ease-out" />
          <text x={geom.xEnd + 8} y={geom.endCombY + 3} fontSize="11" fontWeight="700" fill={scenColor}>
            Combined {fmtCompact(outlook.endCombined)}
          </text>
          <text x={geom.xEnd + 8} y={geom.labelBaseY + 3} fontSize="9" fill={CHART_COLORS.axis}>
            Baseline {fmtCompact(outlook.endBaseline)}
          </text>

          {geom.xTicks.map((t, i) => (
            <text key={i} x={t.x} y={geom.s.bottom + 16} {...CHART_AXIS_TEXT_PIXEL}
                  fill={CHART_COLORS.axis} textAnchor="middle">
              {t.label}
            </text>
          ))}
        </svg>
      </div>

      <div className="flex items-center gap-3 flex-wrap px-2 pt-1.5">
        <LegendDot color={actualColor} label="Posted cash" />
        <LegendDot color={CHART_COLORS.axis} label="Baseline" />
        <LegendDot color={CHART_COLORS.seriesA} label="WC only" />
        <LegendDot color={CHART_COLORS.seriesB} label="P&L only" />
        <LegendDot color={scenColor} label="Combined" />
      </div>

      <div className="flex items-center gap-x-4 gap-y-1 flex-wrap px-2 pt-1 text-[11px] text-fg-subtle">
        <span>
          12m uplift{" "}
          <span className={cn("font-semibold num", positive ? "text-signal-good" : "text-signal-bad")}>
            {positive ? "+" : "−"}{fmtCompact(Math.abs(insights.endUplift))}
          </span>
        </span>
        <span>
          Lowest cash{" "}
          <span className={cn("font-semibold num", insights.breachMonth == null ? "text-fg" : "text-signal-bad")}>
            {fmtCompact(insights.minCash)}
          </span>
          {insights.breachMonth != null && ` · breach +${insights.breachMonth}m`}
        </span>
        <span>
          Main driver{" "}
          <span className="font-semibold text-fg">
            {insights.dominantDriver === "none"
              ? "at baseline"
              : insights.dominantDriver === "wc"
                ? `working capital · ${insights.dominantSharePct}%`
                : `P&L · ${insights.dominantSharePct}%`}
          </span>
        </span>
      </div>
    </div>
  );
}

// "actuals · locked" / "forecast" pills straddling the hinge.
function ChartPills({
  hingeX, left, right, rightEdge,
}: {
  hingeX: number; left: string; right: string; rightEdge: number;
}) {
  const leftW = left.length * 5.4 + 18;
  const rightW = right.length * 5.4 + 18;
  const showRight = rightEdge - hingeX > rightW + 12;
  return (
    <g>
      {hingeX - PAD.L > leftW + 12 && (
        <>
          <rect x={PAD.L + 8} y={8} width={leftW} height={18} rx="9" fill="#eef0f3" />
          <text x={PAD.L + 8 + leftW / 2} y={20} fontSize="9" fill={CHART_COLORS.ink} textAnchor="middle" fontWeight="600">
            {left}
          </text>
        </>
      )}
      {showRight && (
        <>
          <rect x={hingeX + 10} y={8} width={rightW} height={18} rx="9" fill="#dbeafe" />
          <text x={hingeX + 10 + rightW / 2} y={20} fontSize="9" fill={CHART_COLORS.seriesA} textAnchor="middle" fontWeight="600">
            {right}
          </text>
        </>
      )}
    </g>
  );
}

// Revenue outlook: posted actuals through the active close on the left; baseline
// + Revenue-lever stressed forecasts on the right. Monthly is the default view
// because a level shock separates clearly there; cumulative answers "where do we
// land for the FY". Visual cues mirror a typical FP&A outlook (hinge divider,
// forecast tint, dual paths).
function RevenueOutlookChart({
  trend, closePeriod, revShockPct, view, className = "",
}: {
  trend: KpiTrendPoint[] | null;
  closePeriod: string;
  revShockPct: number;
  view: OutlookView;
  className?: string;
}) {
  const { ref, size } = useChartSize();

  const outlook = useMemo(() => {
    if (!trend?.length || !closePeriod) return null;
    const months = trend.map((p) => ({
      period: p.period,
      revenue: Number(p.revenue) || 0,
    }));
    return projectRevenueOutlook({ months, revShockPct, closePeriod });
  }, [trend, closePeriod, revShockPct]);

  const series = outlook ? outlook[view] : null;

  const geom = useMemo(() => {
    if (!outlook || !series) return null;
    const n = outlook.periods.length;
    const s = makeScales(size, n, definedValues(series.actuals, series.baseline, series.stressed));
    const actual = seriesGeom(series.actuals, s);
    const base = seriesGeom(series.baseline, s);
    const stress = seriesGeom(series.stressed, s);
    const endBaseY = s.Y(series.endBaseline);
    const endStressY = s.Y(series.endStressed);

    return {
      s,
      actual,
      base,
      stress,
      band: bandPath(base.xs, stress.ys, base.ys),
      hingeX: s.X(outlook.hingeIndex),
      hingeY: s.Y(series.actuals[outlook.hingeIndex] ?? series.endBaseline),
      endBaseY,
      endStressY,
      labelBaseY: Math.abs(endBaseY - endStressY) < 14
        ? (endStressY <= endBaseY ? endStressY + 16 : endStressY - 16)
        : endBaseY,
      xTicks: xTickIndexes(n, outlook.hingeIndex, s.plotW)
        .map((i) => ({ x: s.X(i), label: outlook.labels[i] })),
      xEnd: s.X(n - 1),
    };
  }, [outlook, series, size]);

  if (!outlook || !series || !geom) {
    return (
      <div className={cn("h-full flex items-center px-2 text-sm text-fg-subtle", className)}>
        Revenue trend unavailable for this scope — outlook chart needs monthly history.
      </div>
    );
  }

  const forecastExists = outlook.hingeIndex < 11;
  const shocked = revShockPct !== 0;
  const stressColor = revShockPct >= 0 ? CHART_COLORS.good : CHART_COLORS.bad;
  const baseColor = CHART_COLORS.seriesB;
  const actualColor = CHART_COLORS.accent;
  const viewLabel = view === "monthly" ? "Monthly" : "Cumulative";
  const forecastFrom = outlook.labels[Math.min(outlook.hingeIndex + 1, 11)] ?? "forecast";
  const chartAriaLabel = forecastExists
    ? `${viewLabel} revenue outlook. Shock ${revShockPct > 0 ? "+" : ""}${revShockPct} percent. Baseline endpoint ${fmtCompact(series.endBaseline)} and stressed endpoint ${fmtCompact(series.endStressed)}.`
    : `${viewLabel} revenue outlook. FY complete with no forecast months remaining.`;

  if (!forecastExists) {
    return (
      <div className={cn("h-full flex items-center justify-center px-2", className)}>
        <div className="text-center">
          <div className="text-sm font-medium text-fg">FY complete</div>
          <div className="mt-1 text-xs text-fg-subtle">No forecast months remain.</div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("h-full flex flex-col", className)}>
      <div ref={ref} className="flex-1 min-h-0">
        <svg width={size.width} height={size.height} viewBox={`0 0 ${size.width} ${size.height}`}
             className="font-sans"
             role="img" aria-label={chartAriaLabel}>
          <defs>
            <linearGradient id="rev-outlook-band" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stressColor} stopOpacity="0.18" />
              <stop offset="100%" stopColor={stressColor} stopOpacity="0.02" />
            </linearGradient>
          </defs>

          {/* Forecast-side tint */}
          <rect x={geom.hingeX} y={PAD.T} width={Math.max(geom.s.right - geom.hingeX, 0)}
                height={geom.s.plotH} fill={CHART_COLORS.seriesA} opacity="0.06" />

          {geom.s.yTicks.map((t, i) => (
            <g key={i}>
              <line x1={PAD.L} x2={geom.s.right} y1={t.y} y2={t.y} stroke="rgba(23,25,32,0.07)" strokeWidth="1" />
              <text x={PAD.L - 6} y={t.y + 3} {...CHART_AXIS_TEXT_PIXEL}
                    fill={CHART_COLORS.axis} textAnchor="end">{t.label}</text>
            </g>
          ))}

          {/* Hinge divider */}
          <line x1={geom.hingeX} x2={geom.hingeX} y1={PAD.T} y2={geom.s.bottom}
                stroke={CHART_COLORS.slate} strokeWidth="1.25" strokeDasharray="4 4" />

          <ChartPills
            hingeX={geom.hingeX}
            left="Posted actuals · locked"
            right={`Forecast from ${forecastFrom} · 2 paths`}
            rightEdge={geom.s.right}
          />

          {shocked && (
            <path d={geom.band} fill="url(#rev-outlook-band)" className="transition-all duration-300 ease-out" />
          )}

          <path d={geom.actual.path} fill="none" stroke={actualColor} strokeWidth="2.25"
                strokeLinejoin="round" strokeLinecap="round" />
          <path d={geom.base.path} fill="none" stroke={baseColor} strokeWidth="2"
                strokeLinejoin="round" strokeLinecap="round"
                className="transition-all duration-300 ease-out" />
          <path d={geom.stress.path} fill="none" stroke={stressColor} strokeWidth="2.5"
                strokeLinejoin="round" strokeLinecap="round"
                className="transition-all duration-300 ease-out" />

          {geom.actual.pts.map((p, i) => (
            <circle key={`a${i}`} cx={p.x} cy={p.y} r="3.5" fill="#fff" stroke={actualColor} strokeWidth="1.75" />
          ))}
          {geom.base.pts.map((p, i) => (
            <rect
              key={`b${i}`}
              x={p.x - 3.5} y={p.y - 3.5} width="7" height="7"
              fill="#fff" stroke={baseColor} strokeWidth="1.75"
              transform={`rotate(45 ${p.x} ${p.y})`}
              className="transition-all duration-300 ease-out"
            />
          ))}
          {geom.stress.pts.map((p, i) => (
            <circle
              key={`s${i}`}
              cx={p.x} cy={p.y} r={i === geom.stress.pts.length - 1 ? 5 : 3.5}
              fill="#fff" stroke={stressColor} strokeWidth="2"
              className="transition-all duration-300 ease-out"
            />
          ))}
          <circle cx={geom.hingeX} cy={geom.hingeY} r="4.5" fill="#fff" stroke={actualColor} strokeWidth="2" />

          <text x={geom.xEnd + 8} y={geom.endStressY + 3} fontSize="11" fontWeight="700" fill={stressColor}
                className="transition-all duration-300 ease-out">
            Stressed {fmtCompact(series.endStressed)}
          </text>
          <text x={geom.xEnd + 8} y={geom.labelBaseY + 3} fontSize="9" fill={baseColor}
                className="transition-all duration-300 ease-out">
            Baseline {fmtCompact(series.endBaseline)}
          </text>

          {geom.xTicks.map((t, i) => (
            <text key={i} x={t.x} y={geom.s.bottom + 16} {...CHART_AXIS_TEXT_PIXEL}
                  fill={CHART_COLORS.axis} textAnchor="middle">
              {t.label}
            </text>
          ))}
        </svg>
      </div>

      <div className="flex items-center gap-3 flex-wrap px-2 pt-1.5">
        <LegendDot color={actualColor} label={view === "monthly" ? "Posted revenue" : "Posted actuals (cumulative)"} />
        <LegendDot color={baseColor} label="Baseline forecast" />
        <LegendDot color={stressColor} label={shocked ? `Stressed (${revShockPct > 0 ? "+" : ""}${revShockPct}%)` : "Stressed (at baseline)"} />
      </div>
    </div>
  );
}

// Compute the working-capital KPIs and freed cash for a given lever setting.
function scenarioKpis(base: WorkingCapitalKpis, l: Levers, hideInventory: boolean): { k: Kpis; cashFreed: number } {
  const c = base.components;
  const days = base.days_in_period || 30;
  const sAR = c.ar_balance * (1 + l.arCollectPct / 100);
  const sRev = c.revenue * (1 + l.revShockPct / 100);
  const sCOGS = c.cogs * (1 + l.cogsShockPct / 100);
  const invPct = hideInventory ? 0 : l.invReducePct;
  const sInv = c.inventory_balance * (1 - invPct / 100);
  const sAP = c.ap_balance + l.dpoExtraDays * (c.cogs / days);
  const k = computeKpis(sAR, sAP, sInv, sRev, sCOGS, days);
  const baseCcc = computeKpis(c.ar_balance, c.ap_balance, c.inventory_balance, c.revenue, c.cogs, days).ccc;
  return { k, cashFreed: (baseCcc - k.ccc) * (c.revenue / days) };
}

// KPI lines plotted on the Scenarios chart (CCC is the emphasized line).
const SCEN_LINES: { key: keyof Kpis; label: string; color: string }[] = [
  { key: "dso", label: "DSO", color: CHART_COLORS.seriesA },
  { key: "dio", label: "DIO", color: CHART_COLORS.seriesB },
  { key: "dpo", label: "DPO", color: CHART_COLORS.seriesC },
  { key: "ccc", label: "CCC", color: CHART_COLORS.accent },
];

// Levers that can be swept along the x-axis; ranges mirror the sliders.
const SCEN_SWEEPS: { key: keyof Levers; short: string; label: string; min: number; max: number; unit: "%" | "d" }[] = [
  { key: "arCollectPct", short: "AR", label: "AR collections", min: -40, max: 40, unit: "%" },
  { key: "dpoExtraDays", short: "DPO", label: "Extend DPO", min: 0, max: 60, unit: "d" },
  { key: "invReducePct", short: "Inventory", label: "Reduce inventory", min: 0, max: 60, unit: "%" },
  { key: "cogsShockPct", short: "COGS", label: "Cost of revenue", min: -30, max: 30, unit: "%" },
];

const hexRgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

// Diverging heat colour: pale neutral near $0, good as cash is freed, bad as consumed.
function heatColor(c: number, maxAbs: number): string {
  const t = maxAbs ? Math.max(-1, Math.min(1, c / maxAbs)) : 0;
  const a = Math.abs(t);
  const target = hexRgb(t >= 0 ? CHART_COLORS.good : CHART_COLORS.bad);
  const pale = [237, 240, 244];
  const mix = (i: number) => Math.round(pale[i] + (target[i] - pale[i]) * a);
  return `rgb(${mix(0)},${mix(1)},${mix(2)})`;
}

// Axis tick label for a swept lever value.
function leverTick(cfg: { unit: "%" | "d" }, t: number): string {
  if (t === 0) return "base";
  if (cfg.unit === "d") return `+${Math.round(t)}d`;
  return `${t > 0 ? "+" : "−"}${Math.abs(Math.round(t))}%`;
}

function nearestIndex(vals: number[], v: number): number {
  let bi = 0, bd = Infinity;
  vals.forEach((x, i) => { const d = Math.abs(x - v); if (d < bd) { bd = d; bi = i; } });
  return bi;
}

// Two-lever cash-impact heatmap: every cell is the cash freed when the X and Y
// levers are set to that combination while the other levers hold their current
// value. The current scenario is outlined ("you are here"); moving a non-axis
// lever recolours the whole surface. Fills the height of its card.
function CashImpactHeatmap({
  base, levers, hideInventory, className = "",
}: {
  base: WorkingCapitalKpis; levers: Levers; hideInventory: boolean; className?: string;
}) {
  const sweeps = SCEN_SWEEPS.filter((s) => !(s.key === "invReducePct" && hideInventory));
  const [xKey, setXKey] = useState<keyof Levers>("arCollectPct");
  const [yKey, setYKey] = useState<keyof Levers>("dpoExtraDays");
  const cfgX = sweeps.find((s) => s.key === xKey) ?? sweeps[0];
  const cfgY = sweeps.find((s) => s.key === yKey) ?? sweeps[1] ?? sweeps[0];

  const pickX = (k: keyof Levers) => { setXKey(k); if (k === yKey) setYKey((sweeps.find((s) => s.key !== k) ?? sweeps[0]).key); };
  const pickY = (k: keyof Levers) => { setYKey(k); if (k === xKey) setXKey((sweeps.find((s) => s.key !== k) ?? sweeps[0]).key); };

  const COLS = 9, ROWS = 7;

  const geom = useMemo(() => {
    const xs = Array.from({ length: COLS }, (_, i) => cfgX.min + ((cfgX.max - cfgX.min) * i) / (COLS - 1));
    const ys = Array.from({ length: ROWS }, (_, j) => cfgY.min + ((cfgY.max - cfgY.min) * j) / (ROWS - 1));
    let maxAbs = 0;
    const cash: number[][] = ys.map((yv) => xs.map((xv) => {
      const c = scenarioKpis(base, { ...levers, [cfgX.key]: xv, [cfgY.key]: yv }, hideInventory).cashFreed;
      if (Math.abs(c) > maxAbs) maxAbs = Math.abs(c);
      return c;
    }));
    const curXi = nearestIndex(xs, levers[cfgX.key]);
    const curYi = nearestIndex(ys, levers[cfgY.key]);
    // Render top-to-bottom as high Y down to low Y.
    const cells: { key: string; color: string; current: boolean; label: string }[] = [];
    for (let j = ROWS - 1; j >= 0; j--) {
      for (let i = 0; i < COLS; i++) {
        cells.push({
          key: `${i}-${j}`,
          color: heatColor(cash[j][i], maxAbs),
          current: i === curXi && j === curYi,
          label: `${cfgX.short} ${leverTick(cfgX, xs[i])}, ${cfgY.short} ${leverTick(cfgY, ys[j])}: ${fmtCompact(cash[j][i])}`,
        });
      }
    }
    return {
      cells,
      xLabels: [leverTick(cfgX, cfgX.min), leverTick(cfgX, (cfgX.min + cfgX.max) / 2), leverTick(cfgX, cfgX.max)],
      yLabels: [leverTick(cfgY, cfgY.max), leverTick(cfgY, (cfgY.min + cfgY.max) / 2), leverTick(cfgY, cfgY.min)],
    };
  }, [base, levers, cfgX, cfgY]);

  const selectCls = "text-[11px] bg-transparent text-fg-muted rounded px-1 py-0.5 ring-1 ring-line hover:text-fg focus:outline-none cursor-pointer";

  return (
    <div className={cn("h-full flex flex-col", className)}>
      <div className="flex items-center gap-2 text-[10px] text-fg-subtle mb-2 px-1">
        <label className="flex items-center gap-1">X
          <select value={xKey} onChange={(e) => pickX(e.target.value as keyof Levers)} className={selectCls}>
            {sweeps.map((s) => <option key={s.key} value={s.key}>{s.short}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1">Y
          <select value={yKey} onChange={(e) => pickY(e.target.value as keyof Levers)} className={selectCls}>
            {sweeps.map((s) => <option key={s.key} value={s.key}>{s.short}</option>)}
          </select>
        </label>
      </div>
      <div className="px-1 pb-1 flex-1 min-h-0 flex flex-col">
        <div className="flex-1 min-h-0 flex gap-2">
          <div className="flex flex-col justify-between text-[9px] text-fg-subtle py-0.5 w-9 text-right shrink-0">
            {geom.yLabels.map((l, i) => <span key={i}>{l}</span>)}
          </div>
          <div className="relative flex-1 min-h-0">
            <div className="absolute inset-0 grid gap-px rounded-md overflow-hidden ring-1 ring-line"
                 style={{ gridTemplateColumns: `repeat(${COLS}, 1fr)`, gridTemplateRows: `repeat(${ROWS}, 1fr)` }}>
              {geom.cells.map((cell) => (
                <div key={cell.key} title={cell.label}
                     className={cn("transition-colors duration-300", cell.current && "ring-2 ring-inset ring-fg z-10")}
                     style={{ backgroundColor: cell.color }} />
              ))}
            </div>
          </div>
        </div>
        <div className="flex justify-between text-[9px] text-fg-subtle mt-1 pl-11">
          {geom.xLabels.map((l, i) => <span key={i}>{l}</span>)}
        </div>
        <div className="flex items-center gap-2 mt-2 text-[10px] text-fg-subtle pl-11">
          <span>consumes</span>
          <div className="h-2 flex-1 rounded"
               style={{ background: `linear-gradient(90deg, ${CHART_COLORS.bad}, rgb(237,240,244), ${CHART_COLORS.good})` }} />
          <span>frees</span>
        </div>
        <p className="text-[10px] text-fg-subtle mt-1.5 px-0.5">
          Cash freed by combining <span className="text-fg-muted font-medium">{cfgX.label.toLowerCase()}</span> and{" "}
          <span className="text-fg-muted font-medium">{cfgY.label.toLowerCase()}</span> — the outlined cell is your current scenario.
        </p>
      </div>
    </div>
  );
}

// Smooth, gradient-styled line graph (same visual language as the CCC bars) that
// sweeps one lever across its full range and plots the working-capital day KPIs,
// with a live "you are here" marker at the current scenario.
function ScenariosChart({
  base, levers, hideInventory, hideDio, className = "",
}: {
  base: WorkingCapitalKpis; levers: Levers; hideInventory: boolean;
  hideDio: boolean; className?: string;
}) {
  const sweeps = SCEN_SWEEPS.filter((s) => !(s.key === "invReducePct" && hideInventory));
  const [sweptKey, setSweptKey] = useState<keyof Levers>("arCollectPct");
  const cfg = sweeps.find((s) => s.key === sweptKey) ?? sweeps[0];
  const lines = SCEN_LINES.filter((l) => !(l.key === "dio" && hideDio));

  const { ref, size } = useChartSize({ width: 1000, height: 300 });
  const W = size.width, H = size.height;
  const padL = 50, padR = 18, padT = 22, padB = 34;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  const geom = useMemo(() => {
    const steps = 60;
    const pts = Array.from({ length: steps + 1 }, (_, i) => {
      const t = cfg.min + ((cfg.max - cfg.min) * i) / steps;
      const { k } = scenarioKpis(base, { ...levers, [cfg.key]: t }, hideInventory);
      return { t, dso: k.dso, dio: k.dio, dpo: k.dpo, ccc: k.ccc };
    });
    const vals = pts.flatMap((p) => lines.map((l) => p[l.key]));
    const yMax = Math.max(...vals, 1) * 1.1;
    const yMin = Math.min(0, ...vals);
    const X = (i: number) => padL + (i / steps) * plotW;
    const Y = (v: number) => padT + (1 - (v - yMin) / (yMax - yMin || 1)) * plotH;

    const path = (key: keyof Kpis) =>
      pts.map((p, i) => `${i === 0 ? "M" : "L"}${X(i).toFixed(1)},${Y(p[key]).toFixed(1)}`).join(" ");
    const cccArea = `${path("ccc")} L${X(steps).toFixed(1)},${Y(yMin).toFixed(1)} L${X(0).toFixed(1)},${Y(yMin).toFixed(1)} Z`;

    const cur = levers[cfg.key];
    const markX = padL + ((cur - cfg.min) / (cfg.max - cfg.min)) * plotW;
    const { k: curK, cashFreed } = scenarioKpis(base, levers, hideInventory);

    const yTicks = [0, 0.5, 1].map((f) => { const v = yMin + (yMax - yMin) * f; return { y: Y(v), label: `${roundDays(v)}d` }; });
    const xTicks = [cfg.min, (cfg.min + cfg.max) / 2, cfg.max].map((t) => ({
      x: padL + ((t - cfg.min) / (cfg.max - cfg.min)) * plotW,
      label: t === 0 ? "baseline"
        : cfg.unit === "d" ? `+${Math.round(t)}d`
        : `${t > 0 ? "+" : "−"}${Math.abs(Math.round(t))}%`,
    }));

    return { path, cccArea, markX, markCccY: Y(curK.ccc), curK, cashFreed, yTicks, xTicks };
  }, [base, levers, cfg, hideDio, hideInventory]);

  return (
    <Card
      className={className}
      title="Scenarios"
      action={
        <div className="flex items-center gap-0.5 rounded-lg bg-black/[0.05] p-0.5">
          {sweeps.map((s) => (
            <button key={s.key} onClick={() => setSweptKey(s.key)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                sweptKey === s.key ? "bg-ink-800 text-fg shadow-sm ring-1 ring-line" : "text-fg-muted hover:text-fg"}`}>
              {s.short}
            </button>
          ))}
        </div>
      }
    >
      <div className="px-3 pt-3 pb-3">
        <div className="px-2 text-[10px] uppercase tracking-wider text-fg-subtle mb-1">
          Cash-conversion-cycle days · sweeping {cfg.label.toLowerCase()}
        </div>
        <div ref={ref} className="w-full" style={{ height: 300 }}>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block font-sans" role="img"
             aria-label={`Working-capital day metrics as ${cfg.label} varies`}>
          <defs>
            <linearGradient id="scn-ccc" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CHART_COLORS.accent} stopOpacity="0.13" />
              <stop offset="100%" stopColor={CHART_COLORS.accent} stopOpacity="0" />
            </linearGradient>
          </defs>

          {geom.yTicks.map((t, i) => (
            <g key={i}>
              <line x1={padL} x2={W - padR} y1={t.y} y2={t.y} stroke="rgba(23,25,32,0.07)" strokeWidth="1" />
              <text x={padL - 6} y={t.y + 3} {...CHART_AXIS_TEXT_PIXEL}
                    fill={CHART_COLORS.axis} textAnchor="end">{t.label}</text>
            </g>
          ))}

          <path d={geom.cccArea} fill="url(#scn-ccc)" />

          {lines.map((l) => (
            <path key={l.key} d={geom.path(l.key)} fill="none" stroke={l.color}
                  strokeWidth={l.key === "ccc" ? 2.5 : 1.75} strokeLinejoin="round" strokeLinecap="round"
                  opacity={l.key === "ccc" ? 1 : 0.9} />
          ))}

          <line x1={geom.markX} x2={geom.markX} y1={padT} y2={H - padB}
                stroke="rgba(23,25,32,0.35)" strokeWidth="1" strokeDasharray="2 3" />
          <circle cx={geom.markX} cy={geom.markCccY} r="3.5" fill="#fff" stroke={CHART_COLORS.accent} strokeWidth="2" />
          <text x={geom.markX} y={padT - 5} fontSize="9" fill={CHART_COLORS.ink} textAnchor="middle" fontWeight="600">you are here</text>

          {geom.xTicks.map((t, i) => (
            <text key={i} x={t.x} y={H - 10} {...CHART_AXIS_TEXT_PIXEL}
                  fill={CHART_COLORS.axis} textAnchor="middle">{t.label}</text>
          ))}
        </svg>
        </div>

        <div className="flex items-center justify-between gap-3 flex-wrap px-2 pt-1">
          <div className="flex items-center gap-3 flex-wrap">
            {lines.map((l) => <LegendDot key={l.key} color={l.color} label={l.label} />)}
          </div>
          <p className="text-[11px] text-fg-subtle">
            CCC now <span className="font-semibold text-fg num">{roundDays(geom.curK.ccc)}d</span>
            {" · "}{geom.cashFreed >= 0 ? "frees" : "consumes"}{" "}
            <span className="font-semibold text-fg num">{fmt(Math.abs(geom.cashFreed))}</span>
          </p>
        </div>
      </div>
    </Card>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-fg-muted">
      <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}

function SliderGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-fg-subtle mb-2">{label}</div>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

function Slider({
  label, value, min, max, step, onChange, readout, disabled = false,
}: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; readout: (v: number) => string; disabled?: boolean;
}) {
  return (
    <label className={cn("block", disabled && "opacity-60")}>
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-sm text-fg">{label}</span>
        <span className={`text-xs font-medium tabular-nums ${value === 0 ? "text-fg-subtle" : "text-accent"}`}>{readout(value)}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
             aria-label={label}
             disabled={disabled}
             onChange={(e) => onChange(parseFloat(e.target.value))}
             className={cn("w-full accent-accent", disabled ? "cursor-not-allowed" : "cursor-pointer")} />
    </label>
  );
}

