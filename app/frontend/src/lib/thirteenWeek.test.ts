import { describe, expect, it } from "vitest";
import type { TreasuryForecast, TreasuryItem, TreasuryRow } from "../api";
import { cellItems, confidenceMix, dayMonth, monthYear, roundedMinCash, weeklyOutlook } from "./thirteenWeek";

const item = (ledger: "ar" | "ap", amount: number, week: number | null,
              confidence: TreasuryItem["confidence"] = "high"): TreasuryItem => ({
  ledger, invoice_id: `${ledger}-${amount}`, counterparty: "A", amount,
  due_date: "2026-07-01", expected_date: "2026-07-03",
  display_due_date: "2026-11-01", display_expected_date: "2026-11-03",
  week, confidence, past_habit: false,
});

const row = (id: string): TreasuryRow => ({
  id, label: id, direction: "in", method: "ai", values: [], total: 0,
});

describe("labels", () => {
  it("formats day-month and month-year", () => {
    expect(dayMonth("2026-11-01")).toBe("1 Nov");
    expect(monthYear("2027-01")).toBe("Jan 2027");
  });
});

describe("cellItems", () => {
  const f = { items: [item("ar", 5, 0), item("ar", 9, 0), item("ar", 7, 1), item("ap", 3, 0)] } as TreasuryForecast;
  it("returns the ledger's invoices in that week, biggest first", () => {
    expect(cellItems(f, row("receipts_open"), 0).map((i) => i.amount)).toEqual([9, 5]);
    expect(cellItems(f, row("suppliers_open"), 0).map((i) => i.amount)).toEqual([3]);
  });
  it("is empty for non-invoice rows", () => {
    expect(cellItems(f, row("payroll"), 0)).toEqual([]);
  });
});

describe("weeklyOutlook", () => {
  it("finds the low week and the first breach", () => {
    const o = weeklyOutlook([10, 6, 4, 8], 5)!;
    expect(o).toEqual({ low: 4, lowIndex: 2, headroom: -1, firstBreachIndex: 2 });
  });
  it("reports headroom when never below the minimum", () => {
    expect(weeklyOutlook([10, 9], 5)).toEqual({ low: 9, lowIndex: 1, headroom: 4, firstBreachIndex: null });
  });
});

describe("confidenceMix", () => {
  it("weights by amount and skips invoices beyond 13 weeks", () => {
    const mix = confidenceMix([item("ar", 30, 0, "high"), item("ar", 10, 2, "low"), item("ar", 99, null, "low")], "ar");
    expect(mix.high).toBeCloseTo(0.75);
    expect(mix.low).toBeCloseTo(0.25);
    expect(mix.medium).toBe(0);
  });
});

describe("roundedMinCash", () => {
  it("rounds to $0.1M", () => {
    expect(roundedMinCash(3_517_000)).toBe(3_500_000);
    expect(roundedMinCash(null)).toBe(0);
  });
});
