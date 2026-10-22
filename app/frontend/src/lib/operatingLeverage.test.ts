import { describe, expect, it } from "vitest";
import type { KpiTrendPoint, OperatingLeverageForecastPoint } from "../api";
import {
  attachGovernedForecastPath,
  buildDailyOperatingLeverage,
  buildOperatingLeverageSeries,
} from "./operatingLeverage";

const actuals: KpiTrendPoint[] = [
  { period: "2025-12", dso: "1", dpo: "1", dio: "1", ccc: "1", revenue: "100", opex: "30", net_income: "10" },
  { period: "2026-01", dso: "1", dpo: "1", dio: "1", ccc: "1", revenue: "100", opex: "30", net_income: "12" },
  { period: "2026-02", dso: "1", dpo: "1", dio: "1", ccc: "1", revenue: "100", opex: "30", net_income: "11" },
  { period: "2026-03", dso: "1", dpo: "1", dio: "1", ccc: "1", revenue: "100", opex: "30", net_income: "15" },
  { period: "2026-04", dso: "1", dpo: "1", dio: "1", ccc: "1", revenue: "100", opex: "30", net_income: "14" },
  { period: "2026-05", dso: "1", dpo: "1", dio: "1", ccc: "1", revenue: "100", opex: "30", net_income: "16" },
  { period: "2026-06", dso: "1", dpo: "1", dio: "1", ccc: "1", revenue: "100", opex: "30", net_income: "18" },
];

const forecast: OperatingLeverageForecastPoint[] = [
  { period: "2026-07", revenue: 120, opex: 30, net_income: 24, net_margin_pct: 20 },
  { period: "2026-08", revenue: 110, opex: 30, net_income: 16.5, net_margin_pct: 15 },
  { period: "2026-09", revenue: 130, opex: 30, net_income: 28.6, net_margin_pct: 22 },
];

describe("buildOperatingLeverageSeries", () => {
  it("shows three actual months and all three forecast months in the 3M view", () => {
    const series = buildOperatingLeverageSeries(actuals, forecast, "3M");

    expect(series.actual.map((p) => p.period)).toEqual(["2026-04", "2026-05", "2026-06"]);
    expect(series.forecast.map((p) => p.period)).toEqual([
      "2026-06", "2026-07", "2026-08", "2026-09",
    ]);
  });

  it("joins forecast exactly to the final actual margin", () => {
    const series = buildOperatingLeverageSeries(actuals, forecast, "12M");
    const finalActual = series.actual.at(-1)!;
    const hinge = series.forecast[0];

    expect(hinge.period).toBe(finalActual.period);
    expect(hinge.margin).toBe(finalActual.margin);
    expect(hinge.forecast).toBe(false);
  });

  it("preserves the governed forecast pattern instead of fitting a straight line", () => {
    const series = buildOperatingLeverageSeries(actuals, forecast, "6M");

    expect(series.forecast.slice(1).map((p) => p.margin)).toEqual([20, 15, 22]);
  });

  it("uses current-year actuals for YTD while keeping the forecast visible", () => {
    const series = buildOperatingLeverageSeries(actuals, forecast, "YTD");

    expect(series.actual[0].period).toBe("2026-01");
    expect(series.forecast.at(-1)?.period).toBe("2026-09");
  });

  it("keeps actuals usable when forecast is unavailable", () => {
    const series = buildOperatingLeverageSeries(actuals, [], "3M");

    expect(series.actual).toHaveLength(3);
    expect(series.forecast).toEqual([]);
  });

  it("drops invalid actual rows rather than inventing a margin", () => {
    const invalid = [
      ...actuals,
      { ...actuals.at(-1)!, period: "2026-07", revenue: "0", net_income: "5" },
    ];
    const series = buildOperatingLeverageSeries(invalid, [], "12M");

    expect(series.actual.at(-1)?.period).toBe("2026-06");
  });
});

describe("buildDailyOperatingLeverage", () => {
  it("interpolates every calendar day from the first month through the last", () => {
    const daily = buildDailyOperatingLeverage(actuals);
    expect(daily).not.toBeNull();
    expect(daily!.dates[0]).toEqual(new Date(2025, 11, 1));
    expect(daily!.dates.at(-1)).toEqual(new Date(2026, 5, 30));
    expect(daily!.margin).toHaveLength(daily!.dates.length);
    expect(daily!.ma28).toHaveLength(daily!.dates.length);
    expect(daily!.ma91).toHaveLength(daily!.dates.length);
  });

  it("keeps moving averages defined on day one instead of leaving a gap", () => {
    const daily = buildDailyOperatingLeverage(actuals)!;
    expect(Number.isFinite(daily.ma28[0])).toBe(true);
    expect(Number.isFinite(daily.ma91[0])).toBe(true);
    expect(daily.ma7[0]).toBe(daily.margin[0]);
  });
});

describe("attachGovernedForecastPath", () => {
  it("extends past the last actual day with the three governed months, not a straight line", () => {
    const daily = buildDailyOperatingLeverage(actuals)!;
    const lastActual = buildOperatingLeverageSeries(actuals, forecast, "12M").actual.at(-1)!;
    const path = attachGovernedForecastPath(daily, lastActual.period, lastActual.margin, forecast);

    expect(path.dates[0]).toEqual(daily.dates.at(-1));
    expect(path.margins[0]).toBe(lastActual.margin);
    expect(path.margins.at(-1)).toBe(22);
    expect(path.dates.at(-1)).toEqual(new Date(2026, 8, 15));
    expect(path.margins).not.toEqual(
      path.margins.map((_, i) => path.margins[0] + (i / (path.margins.length - 1)) * (path.margins.at(-1)! - path.margins[0])),
    );
  });

  it("returns an empty path when forecast is unavailable", () => {
    const daily = buildDailyOperatingLeverage(actuals)!;
    expect(attachGovernedForecastPath(daily, "2026-06", 18, [])).toEqual({ dates: [], margins: [] });
  });
});
