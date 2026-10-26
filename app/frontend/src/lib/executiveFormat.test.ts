import { describe, expect, it } from "vitest";
import { fmtPeriodMoney, fmtPeriodMonth, fmtPct0 } from "./executiveFormat";

describe("executiveFormat", () => {
  it("formats period money at M scale", () => {
    expect(fmtPeriodMoney(8_400_000)).toBe("$8.4M");
    expect(fmtPeriodMoney(-2_500_000)).toBe("−$2.5M");
  });

  it("formats period money at K scale", () => {
    expect(fmtPeriodMoney(355_000)).toBe("$355K");
  });

  it("formats month labels from period strings", () => {
    expect(fmtPeriodMonth("2026-06")).toMatch(/Jun/);
  });

  it("formats whole-percent margins", () => {
    expect(fmtPct0(57.9)).toBe("58%");
  });
});
