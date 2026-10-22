import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

describe("Operating Leverage forecast integration", () => {
  it("exposes a scope-aware forecast API call", () => {
    const api = read("api.ts");
    expect(api).toContain("operatingLeverageForecast:");
    expect(api).toContain("/kpis/operating-leverage/forecast");
    expect(api).toContain("scopeQS(s)");
  });

  it("loads forecast independently from actual KPI history", () => {
    const page = read("pages", "Executive.tsx");
    expect(page).toContain("api.operatingLeverageForecast(scope)");
    expect(page).toContain("setLeverageForecast");
    expect(page).toContain("setLeverageForecastLoading");
  });

  it("passes forecast data and partial loading state to the chart", () => {
    const page = read("pages", "Executive.tsx");
    expect(page).toContain("forecast={leverageForecast}");
    expect(page).toContain("forecastLoading={leverageForecastLoading}");
  });

  it("renders daily, 28-day, and 91-day average lines together with the governed forecast", () => {
    const chart = read("components", "ExecutiveCharts.tsx");
    expect(chart).toContain('label="Daily"');
    expect(chart).toContain('label="28-day avg"');
    expect(chart).toContain('label="91-day avg"');
    expect(chart).toContain('label="Governed forecast"');
    expect(chart).toContain("buildDailyOperatingLeverage");
    expect(chart).not.toMatch(/forecast\(daily\.ma28/);
  });
});
