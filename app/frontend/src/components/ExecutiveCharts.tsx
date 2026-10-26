import { useMemo, useState, type ReactNode } from "react";
import { useChartSize } from "../lib/useChartSize";
import {
  CashFlow, KpiTrendPoint, OperatingLeverageForecast, OpexVarianceRow, WorkingCapitalKpis,
} from "../api";
import { fmtPct0, fmtPeriodMoney, fmtPeriodMonth, PERIOD_MONEY_NOTE } from "../lib/executiveFormat";
import {
  attachGovernedForecastPath,
  buildDailyOperatingLeverage,
  buildOperatingLeverageSeries,
  OperatingLeverageTimeframe,
} from "../lib/operatingLeverage";
import { fmtDay, MT } from "../lib/trendChart";
import { CHART_AXIS_TEXT_PIXEL, CHART_COLORS as COLORS } from "../lib/chartPalette";
import { Card } from "./ui";

// Account names share long prefixes ("Operating Expense - Marketing"), which
// collapse to the same ellipsis in a narrow label column. Keep the trailing
// segment, which is what distinguishes the rows.
function shortAccount(name: string): string {
  const parts = name.split(/\s+-\s+/);
  return parts.length > 1 ? parts[parts.length - 1] : name;
}

/* ---------------------------------------------------------------------------
 * Profitability — margin bridge (scoped P&L for current close period)
 * ------------------------------------------------------------------------- */
export function ProfitabilityBridge({
  kpis, action, subtitle = PERIOD_MONEY_NOTE,
}: {
  kpis: WorkingCapitalKpis;
  action?: ReactNode;
  subtitle?: string;
}) {
  const c = kpis.components;
  const revenue = c.revenue;
  const grossProfit = revenue - c.cogs;
  const operatingIncome = revenue - c.cogs - c.operating_expense;
  const netIncome = c.net_income;
  const peak = Math.max(revenue, 1);
  const pct = (v: number) => `${Math.max(0, (v / peak) * 100)}%`;
  const margin = (v: number) => (revenue ? (v / revenue) * 100 : 0);

  const rows = [
    { label: "Revenue", value: revenue, color: COLORS.slate, sub: "top line" },
    { label: "Gross profit", value: grossProfit, color: COLORS.ink, sub: `${fmtPct0(margin(grossProfit))} gross margin` },
    { label: "Operating income", value: operatingIncome, color: COLORS.seriesB, sub: `${fmtPct0(margin(operatingIncome))} operating margin` },
    { label: "Net income", value: netIncome, color: COLORS.seriesC, sub: `${fmtPct0(margin(netIncome))} net margin` },
  ];

  return (
    <Card title="Profitability" subtitle={subtitle} action={action}>
      <div className="px-5 py-3 space-y-2.5">
        {rows.map((r) => (
          <div key={r.label}>
            <div className="flex items-baseline justify-between text-xs mb-1">
              <span className="font-medium text-fg">
                {r.label} <span className="text-fg-subtle font-normal">· {r.sub}</span>
              </span>
              <span className="font-semibold text-fg num">{fmtPeriodMoney(r.value)}</span>
            </div>
            <div className="relative h-3.5 rounded bg-black/[0.04]">
              <div
                className="absolute inset-y-0 left-0 rounded"
                style={{ width: pct(r.value), backgroundColor: r.color, opacity: 0.9 }}
              />
            </div>
          </div>
        ))}
        <p className="text-[11px] text-fg-subtle pt-0.5">
          Net margin <span className="font-semibold text-fg">{fmtPct0(margin(netIncome))}</span> on{" "}
          {fmtPeriodMoney(revenue)} revenue this period.
        </p>
      </div>
    </Card>
  );
}

/* ---------------------------------------------------------------------------
 * Budget variance — dumbbell: forecast vs actual per account, gap = variance
 * ------------------------------------------------------------------------- */
export function BudgetVariance({ variance }: { variance: OpexVarianceRow[] }) {
  const byAccount = new Map<string, { name: string; actual: number; forecast: number }>();
  for (const r of variance) {
    const key = r.account_name;
    const cur = byAccount.get(key) ?? { name: key, actual: 0, forecast: 0 };
    cur.actual += parseFloat(r.actual_amount) || 0;
    cur.forecast += parseFloat(r.forecast_amount) || 0;
    byAccount.set(key, cur);
  }
  const rows = [...byAccount.values()].map((a) => ({ ...a, variance: a.actual - a.forecast }));
  if (rows.length === 0) {
    return (
      <Card title="Budget variance" subtitle={`Opex actual vs forecast · ${PERIOD_MONEY_NOTE}`}>
        <div className="px-5 py-10 text-center text-sm text-fg-subtle">No variance data for this scope.</div>
      </Card>
    );
  }
  const totActual = rows.reduce((s, r) => s + r.actual, 0);
  const totForecast = rows.reduce((s, r) => s + r.forecast, 0);
  const totVar = totActual - totForecast;
  const accuracy = totForecast ? 100 - Math.abs(totVar) / totForecast * 100 : 0;
  const top = rows
    .sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance))
    .slice(0, 5);

  // Plot the gap as % variance from forecast rather than absolute spend, so a
  // small account's overrun stays visible next to a large one. Forecast anchors
  // every row at the centre line; actual sits at its deviation.
  const pctVar = (r: { variance: number; forecast: number }) =>
    r.forecast ? (r.variance / r.forecast) * 100 : 0;
  const domain = Math.max(...top.map((r) => Math.abs(pctVar(r))), 1) * 1.3;
  const pos = (p: number) => 50 + (p / domain) * 50;

  const legend = (
    <div className="flex items-center gap-3 text-[10px] text-fg-muted">
      <span className="flex items-center gap-1.5">
        <span className="w-2.5 h-2.5 rounded-full border-2" style={{ borderColor: COLORS.slate }} />
        Forecast
      </span>
      <span className="flex items-center gap-1.5">
        <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: COLORS.ink }} />
        Actual
      </span>
    </div>
  );

  return (
    <Card
      title="Budget variance"
      subtitle={`Opex vs forecast · gap = % variance · ${PERIOD_MONEY_NOTE}`}
      action={legend}
      className="h-full flex flex-col"
    >
      <div className="px-5 py-3 flex-1 flex flex-col">
        <div className="flex-1 flex flex-col justify-between gap-2.5">
          {top.map((r) => {
            const deviation = pctVar(r);
            const actualPos = pos(deviation);
            const over = r.variance > 0;
            const tone = over ? COLORS.bad : COLORS.good;
            const tooltip = `${r.name} — forecast ${fmtPeriodMoney(r.forecast)}, actual ${fmtPeriodMoney(r.actual)} (${over ? "+" : "−"}${Math.abs(deviation).toFixed(1)}%)`;
            return (
              <div key={r.name} className="flex items-center gap-3 text-xs">
                <span className="w-32 shrink-0 truncate text-fg-muted" title={r.name}>{shortAccount(r.name)}</span>
                <div className="relative flex-1 h-4" title={tooltip}>
                  <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-black/[0.06]" />
                  <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-black/[0.10]" />
                  <div
                    className="absolute top-1/2 h-[3px] -translate-y-1/2 rounded-full"
                    style={{
                      left: `${Math.min(50, actualPos)}%`,
                      width: `${Math.abs(actualPos - 50)}%`,
                      backgroundColor: tone,
                    }}
                  />
                  <span
                    className="absolute top-1/2 left-1/2 w-2.5 h-2.5 -translate-y-1/2 -translate-x-1/2 rounded-full border-2"
                    style={{ borderColor: COLORS.slate }}
                  />
                  <span
                    className="absolute top-1/2 w-2.5 h-2.5 -translate-y-1/2 -translate-x-1/2 rounded-full"
                    style={{ left: `${actualPos}%`, backgroundColor: tone }}
                  />
                </div>
                <span className={`w-16 text-right num ${over ? "text-signal-bad" : "text-signal-good"}`}>
                  {over ? "+" : "−"}{fmtPeriodMoney(Math.abs(r.variance))}
                </span>
              </div>
            );
          })}
        </div>
        <p className="text-[11px] text-fg-subtle pt-3">
          Actual opex is{" "}
          <span className={`font-semibold ${totVar > 0 ? "text-signal-bad" : "text-signal-good"}`}>
            {fmtPeriodMoney(Math.abs(totVar))} {totVar > 0 ? "over" : "under"} forecast
          </span>
          {" · "}forecast accuracy <span className="font-semibold text-fg">{fmtPct0(accuracy)}</span>
          {" · "}top {top.length} drivers by variance
        </p>
      </div>
    </Card>
  );
}

/* ---------------------------------------------------------------------------
 * Cash-flow reconciliation — waterfall
 * ------------------------------------------------------------------------- */
export function CashFlowWaterfall({ cf }: { cf: CashFlow }) {
  const { ref, size } = useChartSize({ width: 520, height: 200 });
  const steps = [
    { label: "Beginning", value: cf.beginning_cash, type: "total" as const },
    { label: "Collections", value: cf.collections, type: "in" as const },
    { label: "Operating", value: -cf.operating_disbursements, type: "out" as const },
    { label: "Capex", value: -cf.capex, type: "out" as const },
    { label: "Ending", value: cf.ending_cash, type: "total" as const },
  ];
  let run = 0;
  const bars = steps.map((s) => {
    if (s.type === "total") { run = s.value; return { ...s, base: 0, top: s.value }; }
    const base = run; run += s.value; return { ...s, base, top: run };
  });
  const W = size.width, H = size.height, padL = 40, padR = 14, padT = 16, padB = 28;
  const maxV = Math.max(...bars.map((b) => Math.max(b.base, b.top)), 1) * 1.12;
  const step = (W - padL - padR) / steps.length;
  const bw = step * 0.58;
  const xc = (i: number) => padL + (i + 0.5) * step;
  const y = (v: number) => padT + (1 - v / maxV) * (H - padT - padB);
  const color = (t: string) => (t === "in" ? COLORS.seriesA : t === "out" ? COLORS.seriesB : COLORS.slate);
  const netChange = cf.ending_cash - cf.beginning_cash;

  return (
    <Card title="Cash flow reconciliation" subtitle={PERIOD_MONEY_NOTE}>
      <div className="px-3 py-2">
        <div ref={ref} className="w-full" style={{ height: 200 }}>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block font-sans" role="img" aria-label="Cash flow reconciliation waterfall">
          {bars.map((b, i) => {
            const yTop = y(Math.max(b.base, b.top));
            const h = Math.max(Math.abs(y(b.base) - y(b.top)), 1);
            const magnitude = Math.abs(b.top - b.base);
            return (
              <g key={b.label}>
                {i > 0 && (
                  <line
                    x1={xc(i - 1) + bw / 2} x2={xc(i) - bw / 2}
                    y1={y(bars[i - 1].top)} y2={y(bars[i - 1].top)}
                    stroke={COLORS.grid} strokeWidth="1" strokeDasharray="3 3"
                  />
                )}
                <rect x={xc(i) - bw / 2} y={yTop} width={bw} height={h} rx="2" fill={color(b.type)} opacity={0.9} />
                <text x={xc(i)} y={yTop - 4} fontSize="9" fill={COLORS.accent} textAnchor="middle">
                  {b.type === "out" ? "−" : ""}{fmtPeriodMoney(magnitude)}
                </text>
                <text x={xc(i)} y={H - 6} {...CHART_AXIS_TEXT_PIXEL}
                      fill={COLORS.axis} textAnchor="middle">{b.label}</text>
              </g>
            );
          })}
        </svg>
        </div>
        <p className="text-[11px] text-fg-subtle px-2 pt-0.5">
          Ending cash <span className="font-semibold text-fg">{fmtPeriodMoney(cf.ending_cash)}</span> · net change{" "}
          <span className={`font-semibold ${netChange >= 0 ? "text-signal-good" : "text-signal-bad"}`}>
            {netChange >= 0 ? "▲" : "▼"} {fmtPeriodMoney(Math.abs(netChange))}
          </span>
        </p>
      </div>
    </Card>
  );
}

/* ---------------------------------------------------------------------------
 * Net margin trend — honest monthly actuals (+ simple forecast tail)
 * ------------------------------------------------------------------------- */
const TF_OPTS = ["3M", "6M", "12M", "YTD"] as const;
type Timeframe = typeof TF_OPTS[number];

const numT = (s: string) => { const n = parseFloat(s); return Number.isFinite(n) ? n : NaN; };

interface MonthPoint {
  period: string;
  label: string;
  margin: number;
  forecast?: boolean;
}

function buildMonthly(trend: KpiTrendPoint[]): MonthPoint[] {
  return trend
    .map((p) => {
      const r = numT(p.revenue);
      const margin = r ? (numT(p.net_income) / r) * 100 : NaN;
      return { period: p.period, label: fmtPeriodMonth(p.period), margin };
    })
    .filter((p) => Number.isFinite(p.margin));
}

function sliceWindow(points: MonthPoint[], tf: Timeframe): MonthPoint[] {
  if (points.length === 0) return [];
  if (tf === "12M") return points.slice(-12);
  if (tf === "6M") return points.slice(-6);
  if (tf === "3M") return points.slice(-3);
  const lastYear = points[points.length - 1].period.slice(0, 4);
  return points.filter((p) => p.period.startsWith(lastYear));
}

export function MarginTrend({ trend }: { trend: KpiTrendPoint[] }) {
  const { ref, size } = useChartSize({ width: 860, height: 200 });
  const [tf, setTf] = useState<Timeframe>("12M");
  const monthly = useMemo(() => buildMonthly(trend), [trend]);
  const windowPts = useMemo(() => sliceWindow(monthly, tf), [monthly, tf]);

  const tfPills = (
    <div className="flex rounded-md ring-1 ring-line overflow-hidden text-[11px]">
      {TF_OPTS.map((o) => (
        <button
          key={o}
          type="button"
          onClick={() => setTf(o)}
          className={`px-2 py-1 transition ${tf === o ? "bg-accent/15 text-accent-400 dark:text-fg font-medium" : "text-fg-muted hover:bg-black/[0.04]"}`}
        >
          {o}
        </button>
      ))}
    </div>
  );

  if (windowPts.length < 2) {
    return (
      <Card title="Net margin trend" subtitle="Monthly actual · scope-level" action={tfPills}>
        <div className="px-5 py-10 text-center text-sm text-fg-subtle">No trend history yet.</div>
      </Card>
    );
  }

  const last = windowPts[windowPts.length - 1];
  const prior = windowPts[windowPts.length - 2];
  const delta = last.margin - prior.margin;

  const W = size.width, H = size.height, padL = 44, padR = 16, padT = 14, padB = 28;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const lo = Math.min(...windowPts.map((p) => p.margin));
  const hi = Math.max(...windowPts.map((p) => p.margin));
  const padY = (hi - lo) * 0.15 || 2;
  const yMin = lo - padY;
  const yMax = hi + padY;
  const x = (i: number) => padL + (windowPts.length <= 1 ? plotW / 2 : (i / (windowPts.length - 1)) * plotW);
  const y = (v: number) => padT + (1 - (v - yMin) / (yMax - yMin || 1)) * plotH;

  const path = windowPts.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.margin).toFixed(1)}`).join(" ");

  return (
    <Card title="Net margin trend" subtitle="Monthly actual · scope-level" action={tfPills}>
      <div className="px-3 pt-2 pb-2">
        <div ref={ref} className="w-full" style={{ height: 200 }}>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block font-sans" role="img" aria-label="Monthly net margin trend">
          {[0, 0.5, 1].map((f) => {
            const v = yMin + f * (yMax - yMin);
            return (
              <g key={f}>
                <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke={COLORS.grid} strokeWidth="1" />
                <text x={padL - 6} y={y(v) + 3} {...CHART_AXIS_TEXT_PIXEL}
                      fill={COLORS.axis} textAnchor="end">{fmtPct0(v)}</text>
              </g>
            );
          })}
          <path d={path} fill="none" stroke={COLORS.accent} strokeWidth="2.25" strokeLinejoin="round" strokeLinecap="round" />
          {windowPts.map((p, i) => (
            <g key={p.period}>
              <circle cx={x(i)} cy={y(p.margin)} r="3.5" fill={COLORS.accent} stroke="#fff" strokeWidth="1.5" />
              <text x={x(i)} y={H - 6} {...CHART_AXIS_TEXT_PIXEL}
                    fill={COLORS.axis} textAnchor="middle">{p.label}</text>
            </g>
          ))}
        </svg>
        </div>
        <p className="text-[11px] text-fg-subtle px-2 pt-0.5">
          Latest <span className="font-semibold text-fg">{fmtPct0(last.margin)}</span>
          {" · "}
          <span className={`font-semibold ${delta >= 0 ? "text-signal-good" : "text-signal-bad"}`}>
            {delta >= 0 ? "▲" : "▼"} {Math.abs(delta).toFixed(1)} pp vs prior month
          </span>
          {" · "}{tf} window
        </p>
      </div>
    </Card>
  );
}

/* ---------------------------------------------------------------------------
 * Operating leverage — daily actuals with 28 / 91-day averages plus
 * a three-month governed forecast.
 * ------------------------------------------------------------------------- */
const pctLabel = (v: number) => `${v.toFixed(0)}%`;

export function OperatingLeverage({
  trend,
  forecast,
  forecastLoading = false,
}: {
  trend: KpiTrendPoint[];
  forecast?: OperatingLeverageForecast | null;
  forecastLoading?: boolean;
}) {
  const { ref, size } = useChartSize({ width: 860, height: 240 });
  const [tf, setTf] = useState<OperatingLeverageTimeframe>("12M");
  const [hover, setHover] = useState<number | null>(null);
  const daily = useMemo(() => buildDailyOperatingLeverage(trend), [trend]);
  const monthly = useMemo(
    () => buildOperatingLeverageSeries(trend, forecast?.points ?? [], tf),
    [trend, forecast, tf],
  );
  const forecastPathSeries = useMemo(() => {
    if (!daily || monthly.actual.length === 0) return { dates: [] as Date[], margins: [] as number[] };
    const lastActual = monthly.actual[monthly.actual.length - 1];
    return attachGovernedForecastPath(daily, lastActual.period, lastActual.margin, forecast?.points ?? []);
  }, [daily, monthly, forecast]);

  const tfPills = (
    <div className="flex rounded-md ring-1 ring-line overflow-hidden text-[11px]">
      {TF_OPTS.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => setTf(option)}
          className={`px-2 py-1 transition ${tf === option ? "bg-accent/15 text-accent-400 dark:text-fg font-medium" : "text-fg-muted hover:bg-black/[0.04]"}`}
        >
          {option}
        </button>
      ))}
    </div>
  );

  if (!daily) {
    return (
      <Card title="Operating leverage" subtitle="net margin trend" action={tfPills}>
        <div className="px-5 py-10 text-center text-sm text-fg-subtle">No trend history yet.</div>
      </Card>
    );
  }

  const count = daily.margin.length;
  const startIdx = tf === "3M" ? Math.max(0, count - 91)
    : tf === "6M" ? Math.max(0, count - 182)
    : tf === "YTD" ? daily.ytdStart : 0;
  const displayedCount = count - startIdx;
  const extraForecast = Math.max(0, forecastPathSeries.dates.length - 1);
  const totalCount = displayedCount + extraForecast;

  const W = size.width, H = size.height, padL = 44, padR = 16, padT = 16, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const x = (index: number) => padL + (totalCount <= 1 ? plotW / 2 : (index / (totalCount - 1)) * plotW);

  const values: number[] = [];
  for (let i = startIdx; i < count; i++) values.push(daily.margin[i], daily.ma91[i]);
  forecastPathSeries.margins.forEach((margin) => values.push(margin));
  const low = Math.min(...values), high = Math.max(...values);
  const padY = (high - low) * 0.12 || 2;
  const yMin = low - padY, yMax = high + padY;
  const y = (value: number) => padT + (1 - (value - yMin) / (yMax - yMin || 1)) * plotH;

  const pathOf = (series: number[]) => {
    let path = "";
    for (let i = startIdx; i < count; i++) {
      path += `${i === startIdx ? "M" : "L"}${x(i - startIdx).toFixed(1)},${y(series[i]).toFixed(1)}`;
    }
    return path;
  };
  const rawPath = pathOf(daily.margin);
  const ma28Path = pathOf(daily.ma28);
  const ma91Path = pathOf(daily.ma91);

  let forecastPath = "";
  if (forecastPathSeries.margins.length > 1) {
    const k0 = displayedCount - 1;
    const segment = forecastPathSeries.margins.map((margin, j) =>
      `${j === 0 ? "M" : "L"}${x(k0 + j).toFixed(1)},${y(margin).toFixed(1)}`,
    );
    forecastPath = segment.join(" ");
  }

  const tickCount = 7;
  const ticks = Array.from(
    { length: tickCount },
    (_, tick) => startIdx + Math.round((tick / (tickCount - 1)) * (displayedCount - 1)),
  );
  const windowStart = daily.dates[startIdx];
  const windowMonths = trend.filter(
    (point) => new Date(+point.period.slice(0, 4), +point.period.slice(5, 7) - 1, 28) >= windowStart,
  );
  const comparisonMonths = windowMonths.length >= 2 ? windowMonths : trend;
  const rev0 = numT(comparisonMonths[0].revenue);
  const rev1 = numT(comparisonMonths[comparisonMonths.length - 1].revenue);
  const opex0 = numT(comparisonMonths[0].opex);
  const opex1 = numT(comparisonMonths[comparisonMonths.length - 1].opex);
  const revenueGrowth = rev0 ? (rev1 / rev0 - 1) * 100 : 0;
  const opexGrowth = opex0 ? (opex1 / opex0 - 1) * 100 : 0;
  const marginDelta = daily.ma91[count - 1] - daily.ma91[startIdx];
  const positiveLeverage = revenueGrowth > opexGrowth;
  const pct1 = (value: number) => `${value.toFixed(1)}%`;
  const hoverIndex = hover != null && hover < displayedCount ? startIdx + hover : null;
  const forecastHoverIndex = hover != null && hover >= displayedCount ? hover - displayedCount + 1 : null;

  return (
    <Card title="Operating leverage" subtitle="net margin · daily with 28 / 91-day average + 3-month governed forecast" action={tfPills}>
      <div className="px-3 pt-3 pb-2">
        <div ref={ref} className="w-full" style={{ height: 240 }}>
        <svg
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          className="block font-sans"
          role="img"
          aria-label="Daily net margin with 28- and 91-day moving averages and governed forecast"
          onMouseLeave={() => setHover(null)}
          onMouseMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const svgX = ((event.clientX - rect.left) / rect.width) * W;
            const index = Math.round(((svgX - padL) / plotW) * (totalCount - 1));
            setHover(Math.max(0, Math.min(totalCount - 1, index)));
          }}
        >
          {[0, 0.5, 1].map((fraction) => {
            const value = yMin + fraction * (yMax - yMin);
            return (
              <g key={fraction}>
                <line x1={padL} x2={W - padR} y1={y(value)} y2={y(value)} stroke={COLORS.grid} strokeWidth="1" />
                <text x={padL - 6} y={y(value) + 3} {...CHART_AXIS_TEXT_PIXEL}
                      fill={COLORS.axis} textAnchor="end">{pctLabel(value)}</text>
              </g>
            );
          })}

          {forecastPath && (
            <line
              x1={x(displayedCount - 1)}
              x2={x(displayedCount - 1)}
              y1={padT}
              y2={H - padB}
              stroke={MT.now}
              strokeWidth="1"
              strokeDasharray="1 3"
            />
          )}

          <path d={rawPath} fill="none" stroke={MT.raw} strokeWidth="1" strokeLinejoin="round" strokeLinecap="round" opacity="0.85" />
          <path d={ma28Path} fill="none" stroke={MT.band} strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" />
          <path d={ma91Path} fill="none" stroke={MT.trend} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
          {forecastPath && (
            <path
              d={forecastPath}
              fill="none"
              stroke={MT.trend}
              strokeWidth="2"
              strokeDasharray="5 4"
              strokeLinejoin="round"
              strokeLinecap="round"
              opacity="0.85"
            />
          )}

          {ticks.map((index, tick) => (
            <text key={tick} x={x(index - startIdx)} y={H - 8} {...CHART_AXIS_TEXT_PIXEL}
                  fill={COLORS.axis} textAnchor="middle">
              {fmtDay(daily.dates[index])}
            </text>
          ))}
          {forecastPath && (
            <text x={x(displayedCount - 1) + 4} y={padT + 9} fontSize="9" fill={COLORS.axis}>forecast →</text>
          )}

          {hover != null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={padT} y2={H - padB} stroke={MT.now} strokeWidth="1" />
              {hoverIndex != null && (
                <circle cx={x(hover)} cy={y(daily.ma28[hoverIndex])} r="3" fill={MT.trend} stroke="#fff" strokeWidth="1.5" />
              )}
              {forecastHoverIndex != null && forecastPathSeries.margins[forecastHoverIndex] != null && (
                <circle
                  cx={x(hover)}
                  cy={y(forecastPathSeries.margins[forecastHoverIndex])}
                  r="3"
                  fill={MT.trend}
                  stroke="#fff"
                  strokeWidth="1.5"
                />
              )}
            </g>
          )}
        </svg>
        </div>

        <div className="flex items-center justify-between gap-4 flex-wrap px-2 pt-1">
          <div className="flex items-center gap-3 flex-wrap">
            <LegendLine color={MT.raw} label="Daily" />
            <LegendLine color={MT.band} label="28-day avg" />
            <LegendLine color={MT.trend} label="91-day avg" />
            <LegendLine color={MT.trend} label="Governed forecast" dashed />
          </div>
          <p className="text-[11px] text-fg-subtle">
            {hoverIndex != null ? (
              <>
                <span className="font-medium text-fg">{fmtDay(daily.dates[hoverIndex])}</span>
                {" · 7d "}<span className="font-semibold text-fg num">{pct1(daily.ma7[hoverIndex])}</span>
                {" · 28d "}<span className="num">{pct1(daily.ma28[hoverIndex])}</span>
                {" · 91d "}<span className="num">{pct1(daily.ma91[hoverIndex])}</span>
              </>
            ) : forecastHoverIndex != null && forecastPathSeries.margins[forecastHoverIndex] != null ? (
              <>
                forecast · net margin{" "}
                <span className="font-semibold num" style={{ color: MT.trend }}>
                  {pct1(forecastPathSeries.margins[forecastHoverIndex])}
                </span>
              </>
            ) : (
              <>
                Revenue{" "}
                <span className={`font-semibold ${revenueGrowth >= 0 ? "text-signal-good" : "text-signal-bad"}`}>
                  {revenueGrowth >= 0 ? "+" : ""}{revenueGrowth.toFixed(1)}%
                </span>
                {" vs opex "}
                <span className={`font-semibold ${opexGrowth <= revenueGrowth ? "text-signal-good" : "text-signal-bad"}`}>
                  {opexGrowth >= 0 ? "+" : ""}{opexGrowth.toFixed(1)}%
                </span>
                {" → net margin "}
                <span className={`font-semibold ${marginDelta >= 0 ? "text-signal-good" : "text-signal-bad"}`}>
                  {marginDelta >= 0 ? "▲" : "▼"} {Math.abs(marginDelta).toFixed(1)} pp
                </span>
                {" over "}{tf}{positiveLeverage ? " · positive operating leverage" : ""}
              </>
            )}
          </p>
        </div>
        <p className="px-2 pt-1 text-[10px] text-fg-subtle">
          {forecastLoading
            ? "Loading governed forecast…"
            : forecast?.status === "available"
              ? "Forecast basis: AI-seasonal revenue · trailing cost ratio · trailing opex run rate."
              : "Forecast unavailable; daily actuals and moving averages remain shown."}
        </p>
      </div>
    </Card>
  );
}

function LegendLine({ color, label, dashed = false }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-fg-muted">
      <svg width="16" height="6" aria-hidden="true">
        <line
          x1="0"
          y1="3"
          x2="16"
          y2="3"
          stroke={color}
          strokeWidth="2.5"
          strokeDasharray={dashed ? "3 3" : undefined}
          strokeLinecap="round"
        />
      </svg>
      {label}
    </span>
  );
}
