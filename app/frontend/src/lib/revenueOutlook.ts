/** Monthly revenue point from kpi trend / history. */
export interface MonthRevenue {
  period: string; // YYYY-MM
  revenue: number;
}

export interface RevenueOutlookInput {
  months: MonthRevenue[];
  /** Revenue lever: percent shock applied to the forward monthly run-rate. */
  revShockPct: number;
  /** Active close period (YYYY-MM). Defaults to the latest period in `months`. */
  closePeriod?: string;
}

/** One view of the outlook. Forecast arrays are `null` before the hinge and
 * share the hinge value with the actuals, so the paths join exactly. */
export interface OutlookSeries {
  actuals: (number | null)[];
  baseline: (number | null)[];
  stressed: (number | null)[];
  endBaseline: number;
  endStressed: number;
}

export type OutlookView = "monthly" | "cumulative";

export interface RevenueOutlook {
  /** Twelve FY months, Jan–Dec of the close year. */
  periods: string[];
  /** Short axis labels (e.g. "Jan", "Jul"). */
  labels: string[];
  /** Index of the last posted-actual month within `periods`. */
  hingeIndex: number;
  /** Last actual month's revenue (forward run-rate before shock). */
  runRate: number;
  /** Per-month revenue — the view where a level shock separates clearly. */
  monthly: OutlookSeries;
  /** Running FY total — the "where do we land" view. */
  cumulative: OutlookSeries;
}

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parsePeriod(period: string): { year: number; month: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (!year || month < 1 || month > 12) return null;
  return { year, month };
}

function periodKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/**
 * Build a FY revenue outlook: locked actuals through the close period, then
 * baseline + lever-stressed forecasts through December, in both a monthly and a
 * cumulative view off the same level-shock math.
 */
export function projectRevenueOutlook(input: RevenueOutlookInput): RevenueOutlook | null {
  const sorted = input.months.map((m) => m.period).sort();
  const closePeriod = input.closePeriod ?? sorted[sorted.length - 1];
  if (!closePeriod) return null;

  const close = parsePeriod(closePeriod);
  if (!close) return null;

  const fyYear = close.year;
  const byPeriod = new Map<string, number>();
  for (const row of input.months) {
    const p = parsePeriod(row.period);
    if (!p || p.year !== fyYear) continue;
    if (p.month > close.month) continue;
    byPeriod.set(row.period, row.revenue);
  }

  const periods = Array.from({ length: 12 }, (_, i) => periodKey(fyYear, i + 1));
  const labels = MONTH_LABELS.slice();
  const hingeIndex = close.month - 1;

  const posted: (number | null)[] = periods.map((period, i) => {
    if (i > hingeIndex) return null;
    const v = byPeriod.get(period);
    return v == null ? null : v;
  });

  // Need at least one posted month with revenue to anchor the forecast.
  if (posted.slice(0, hingeIndex + 1).every((v) => v == null)) {
    return null;
  }

  // Fill gaps before the hinge with 0 so cumulative stays defined; demo data
  // is contiguous, but partial scopes shouldn't crash the chart.
  const monthlyActuals: (number | null)[] = Array(12).fill(null);
  const cumActuals: (number | null)[] = Array(12).fill(null);
  let cum = 0;
  let lastMonthly = 0;
  for (let i = 0; i <= hingeIndex; i++) {
    const m = posted[i] ?? 0;
    if (posted[i] != null) lastMonthly = posted[i]!;
    cum += m;
    monthlyActuals[i] = m;
    cumActuals[i] = cum;
  }

  const runRate = lastMonthly;
  const stressedRate = runRate * (1 + input.revShockPct / 100);

  const monthlyBaseline: (number | null)[] = Array(12).fill(null);
  const monthlyStressed: (number | null)[] = Array(12).fill(null);
  const cumBaseline: (number | null)[] = Array(12).fill(null);
  const cumStressed: (number | null)[] = Array(12).fill(null);

  monthlyBaseline[hingeIndex] = monthlyActuals[hingeIndex];
  monthlyStressed[hingeIndex] = monthlyActuals[hingeIndex];
  cumBaseline[hingeIndex] = cum;
  cumStressed[hingeIndex] = cum;

  let baseCum = cum;
  let stressCum = cum;
  for (let i = hingeIndex + 1; i < 12; i++) {
    baseCum += runRate;
    stressCum += stressedRate;
    monthlyBaseline[i] = runRate;
    monthlyStressed[i] = stressedRate;
    cumBaseline[i] = baseCum;
    cumStressed[i] = stressCum;
  }

  return {
    periods,
    labels,
    hingeIndex,
    runRate,
    monthly: {
      actuals: monthlyActuals,
      baseline: monthlyBaseline,
      stressed: monthlyStressed,
      endBaseline: monthlyBaseline[11]!,
      endStressed: monthlyStressed[11]!,
    },
    cumulative: {
      actuals: cumActuals,
      baseline: cumBaseline,
      stressed: cumStressed,
      endBaseline: cumBaseline[11]!,
      endStressed: cumStressed[11]!,
    },
  };
}
