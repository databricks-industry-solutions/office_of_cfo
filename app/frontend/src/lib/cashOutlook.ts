import { RUNWAY_MONTHS, projectRunway } from "./runwayProjection";

/** Monthly ending-cash point from /kpis/cashflow/trend. */
export interface MonthCash {
  period: string; // YYYY-MM
  ending_cash: number;
}

export interface CashOutlookInput {
  /** Posted monthly ending cash. Anything after `closePeriod` is ignored. */
  months: MonthCash[];
  /** Active close period (YYYY-MM). Defaults to the latest posted month. */
  closePeriod?: string;
  /** Cash position at the close — the forecast anchor when no actuals exist. */
  startCash: number;
  /** Baseline monthly operating-cash change. */
  monthlyBase: number;
  /** One-time working-capital release from the levers. */
  wcRelease: number;
  /** Recurring per-month P&L cash delta from the levers. */
  plDelta: number;
  /** Trailing actual months to plot on the left. */
  actualMonths?: number;
}

export interface CashOutlook {
  /** Actual periods (YYYY-MM) then forecast periods, in order. */
  periods: string[];
  /** Short axis labels: month, with the year on January and the first tick. */
  labels: string[];
  /** Index of the close period — the hinge the forecast paths start from. */
  hingeIndex: number;
  /** Posted ending cash through the hinge; `null` afterward. */
  actuals: (number | null)[];
  /** Forecast paths: `null` before the hinge, joined to the actual at the hinge. */
  baseline: (number | null)[];
  wcOnly: (number | null)[];
  plOnly: (number | null)[];
  combined: (number | null)[];
  endBaseline: number;
  endCombined: number;
  insights: ReturnType<typeof projectRunway>["insights"];
}

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const CASH_ACTUAL_MONTHS = 6;

function parsePeriod(period: string): { year: number; month: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (!year || month < 1 || month > 12) return null;
  return { year, month };
}

function addMonths(period: string, n: number): string {
  const p = parsePeriod(period);
  if (!p) return period;
  const zero = p.year * 12 + (p.month - 1) + n;
  const year = Math.floor(zero / 12);
  const month = (zero % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

function label(period: string, isFirst: boolean): string {
  const p = parsePeriod(period);
  if (!p) return period;
  const m = MONTH_LABELS[p.month - 1];
  return p.month === 1 || isFirst ? `${m} ’${String(p.year).slice(2)}` : m;
}

/**
 * Actuals-left / forecast-right cash series: trailing posted ending cash through
 * the close, then the runway projection's baseline / WC-only / P&L-only /
 * combined paths, all anchored on the last actual so the hinge joins exactly.
 */
export function projectCashOutlook(input: CashOutlookInput): CashOutlook {
  const actualMonths = input.actualMonths ?? CASH_ACTUAL_MONTHS;
  const posted = input.months
    .filter((m) => parsePeriod(m.period) != null)
    .sort((a, b) => a.period.localeCompare(b.period));
  const closePeriod = input.closePeriod ?? posted[posted.length - 1]?.period;
  const upToClose = closePeriod ? posted.filter((m) => m.period <= closePeriod) : [];
  const actualsSlice = upToClose.slice(-actualMonths);

  const anchor = actualsSlice.length
    ? actualsSlice[actualsSlice.length - 1].ending_cash
    : input.startCash;
  const proj = projectRunway({
    startCash: anchor,
    monthlyBase: input.monthlyBase,
    wcRelease: input.wcRelease,
    plDelta: input.plDelta,
  });

  // With no posted history the hinge is a single "Now" point at the anchor.
  const hingePeriod = actualsSlice.length
    ? actualsSlice[actualsSlice.length - 1].period
    : closePeriod ?? "";
  const actualPeriods = actualsSlice.length ? actualsSlice.map((m) => m.period) : [hingePeriod];
  const hingeIndex = actualPeriods.length - 1;
  const forecastPeriods = Array.from({ length: RUNWAY_MONTHS }, (_, i) =>
    hingePeriod ? addMonths(hingePeriod, i + 1) : `+${i + 1}m`
  );
  const periods = [...actualPeriods, ...forecastPeriods];
  const labels = periods.map((p, i) => (parsePeriod(p) ? label(p, i === 0) : p));

  const n = periods.length;
  const actuals: (number | null)[] = Array(n).fill(null);
  for (let i = 0; i < actualPeriods.length; i++) {
    actuals[i] = actualsSlice.length ? actualsSlice[i].ending_cash : anchor;
  }

  const forecast = (series: number[]): (number | null)[] => {
    const out: (number | null)[] = Array(n).fill(null);
    for (let m = 0; m <= RUNWAY_MONTHS; m++) out[hingeIndex + m] = series[m];
    return out;
  };

  const baseline = forecast(proj.baseline);
  const combined = forecast(proj.combined);

  return {
    periods,
    labels,
    hingeIndex,
    actuals,
    baseline,
    wcOnly: forecast(proj.wcOnly),
    plOnly: forecast(proj.plOnly),
    combined,
    endBaseline: proj.baseline[RUNWAY_MONTHS],
    endCombined: proj.combined[RUNWAY_MONTHS],
    insights: proj.insights,
  };
}
