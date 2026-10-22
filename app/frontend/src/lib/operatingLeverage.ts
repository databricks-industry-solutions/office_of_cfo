import type { KpiTrendPoint, OperatingLeverageForecastPoint } from "../api";
import { hashNoise, sma } from "./trendChart";

export type OperatingLeverageTimeframe = "3M" | "6M" | "12M" | "YTD";

export interface OperatingLeveragePoint {
  period: string;
  margin: number;
  revenue: number;
  opex: number;
  netIncome: number;
  forecast: boolean;
}

export interface OperatingLeverageSeries {
  actual: OperatingLeveragePoint[];
  /** Forecast path includes the final actual as its hinge. */
  forecast: OperatingLeveragePoint[];
}

const windowSize: Record<Exclude<OperatingLeverageTimeframe, "YTD">, number> = {
  "3M": 3,
  "6M": 6,
  "12M": 12,
};

export function buildOperatingLeverageSeries(
  trend: KpiTrendPoint[],
  forecastPoints: OperatingLeverageForecastPoint[],
  timeframe: OperatingLeverageTimeframe,
): OperatingLeverageSeries {
  const allActual = trend
    .map((point): OperatingLeveragePoint | null => {
      const revenue = Number(point.revenue);
      const netIncome = Number(point.net_income);
      if (!Number.isFinite(revenue) || revenue <= 0 || !Number.isFinite(netIncome)) return null;
      return {
        period: point.period,
        margin: (netIncome / revenue) * 100,
        revenue,
        opex: Number(point.opex) || 0,
        netIncome,
        forecast: false,
      };
    })
    .filter((point): point is OperatingLeveragePoint => point != null)
    .sort((a, b) => a.period.localeCompare(b.period));

  if (allActual.length === 0) return { actual: [], forecast: [] };
  const latestPeriod = allActual[allActual.length - 1].period;
  const actual = timeframe === "YTD"
    ? allActual.filter((point) => point.period.slice(0, 4) === latestPeriod.slice(0, 4))
    : allActual.slice(-windowSize[timeframe]);

  const future = forecastPoints
    .filter((point) => point.period > latestPeriod && Number.isFinite(point.net_margin_pct))
    .sort((a, b) => a.period.localeCompare(b.period))
    .map((point): OperatingLeveragePoint => ({
      period: point.period,
      margin: point.net_margin_pct,
      revenue: point.revenue,
      opex: point.opex,
      netIncome: point.net_income,
      forecast: true,
    }));

  return {
    actual,
    forecast: future.length > 0 ? [actual[actual.length - 1], ...future] : [],
  };
}

export interface DailyOperatingLeverage {
  dates: Date[];
  margin: number[];
  ma7: number[];
  ma28: number[];
  ma91: number[];
  ytdStart: number;
}

const DAY_MS = 86400000;

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function dayIndex(start: Date, date: Date): number {
  const from = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const to = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((to - from) / DAY_MS);
}

function validMonths(trend: KpiTrendPoint[]) {
  return trend
    .map((point) => {
      const revenue = Number(point.revenue);
      const netIncome = Number(point.net_income);
      if (!Number.isFinite(revenue) || revenue <= 0 || !Number.isFinite(netIncome)) return null;
      return {
        y: parseInt(point.period.slice(0, 4), 10),
        m: parseInt(point.period.slice(5, 7), 10),
        margin: (netIncome / revenue) * 100,
      };
    })
    .filter((month): month is { y: number; m: number; margin: number } => month != null)
    .sort((a, b) => a.y - b.y || a.m - b.m);
}

export function buildDailyOperatingLeverage(trend: KpiTrendPoint[]): DailyOperatingLeverage | null {
  const months = validMonths(trend);
  if (months.length < 2) return null;

  const start = new Date(months[0].y, months[0].m - 1, 1);
  const last = months[months.length - 1];
  const end = new Date(last.y, last.m, 0);
  const count = dayIndex(start, end) + 1;
  const anchors = months.map((month) => ({
    idx: dayIndex(start, new Date(month.y, month.m - 1, 15)),
    margin: month.margin,
  }));

  const seed = Math.abs(Math.round(months.reduce((sum, month) => sum + month.margin * 7.3, 0))) % 997;
  const twoPi = 2 * Math.PI;
  const phase = (offset: number) => hashNoise(seed + offset) * twoPi;
  const p1 = phase(1), p2 = phase(2), p3 = phase(3), p4 = phase(4);

  const dates: Date[] = [];
  const margin: number[] = [];
  for (let i = 0; i < count; i++) {
    dates.push(addDays(start, i));
    let base: number;
    if (i <= anchors[0].idx) base = anchors[0].margin;
    else if (i >= anchors[anchors.length - 1].idx) base = anchors[anchors.length - 1].margin;
    else {
      let j = 0;
      while (j < anchors.length - 1 && anchors[j + 1].idx <= i) j++;
      const a = anchors[j], b = anchors[j + 1];
      const t = (i - a.idx) / Math.max(1, b.idx - a.idx);
      base = a.margin + (b.margin - a.margin) * t;
    }
    const noise = 0.55 * Math.sin(i / 5.5 + p1) + 0.5 * Math.sin(i / 12.3 + p2)
      + 0.75 * Math.sin(i / 26 + p3) + 0.55 * Math.sin(i / 61 + p4)
      + 0.5 * (hashNoise(i + seed) - 0.5);
    margin.push(base + 1.35 * noise);
  }

  const jan1 = new Date(last.y, 0, 1).getTime();
  let ytdStart = 0;
  while (ytdStart < count - 1 && dates[ytdStart].getTime() < jan1) ytdStart++;
  return { dates, margin, ma7: sma(margin, 7), ma28: sma(margin, 28), ma91: sma(margin, 91), ytdStart };
}

export function attachGovernedForecastPath(
  daily: DailyOperatingLeverage,
  lastActualPeriod: string,
  lastActualMargin: number,
  forecastPoints: OperatingLeverageForecastPoint[],
): { dates: Date[]; margins: number[] } {
  const future = forecastPoints
    .filter((point) => point.period > lastActualPeriod && Number.isFinite(point.net_margin_pct))
    .sort((a, b) => a.period.localeCompare(b.period));
  if (future.length === 0) return { dates: [], margins: [] };

  const lastDate = daily.dates[daily.dates.length - 1];
  const anchors = [
    { idx: 0, margin: lastActualMargin },
    ...future.map((point) => {
      const y = parseInt(point.period.slice(0, 4), 10);
      const m = parseInt(point.period.slice(5, 7), 10);
      return { idx: dayIndex(lastDate, new Date(y, m - 1, 15)), margin: point.net_margin_pct };
    }),
  ];
  const count = anchors[anchors.length - 1].idx + 1;
  const dates: Date[] = [];
  const margins: number[] = [];
  for (let i = 0; i < count; i++) {
    dates.push(addDays(lastDate, i));
    let j = 0;
    while (j < anchors.length - 1 && anchors[j + 1].idx <= i) j++;
    if (j >= anchors.length - 1) {
      margins.push(anchors[anchors.length - 1].margin);
      continue;
    }
    const a = anchors[j], b = anchors[j + 1];
    const frac = (i - a.idx) / Math.max(1, b.idx - a.idx);
    margins.push(a.margin + (b.margin - a.margin) * frac);
  }
  return { dates, margins };
}
