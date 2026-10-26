import { describe, expect, it } from "vitest";
import {
  closeDayIndex,
  comparisonDisplayLabels,
  localIsoDate,
  monthsBetween,
  shiftDateTokens,
  shiftIsoDate,
  shiftPeriod,
  withDisplayPeriod,
  toDisplayPayload,
  toSeedPayload,
  toSeedPeriod,
} from "./demoCalendar";

describe("demoCalendar", () => {
  it("builds a local ISO date without UTC conversion", () => {
    const late = new Date(2026, 7, 26, 23, 30, 0); // 26 Aug local
    expect(localIsoDate(late)).toBe("2026-08-26");
    const utcWouldFlip = new Date(Date.UTC(2026, 7, 27, 0, 30));
    // Constructor with Y,M,D is local; getFullYear/Month/Date must match those args.
    const localMorning = new Date(2026, 0, 1, 0, 15, 0);
    expect(localIsoDate(localMorning)).toBe("2026-01-01");
    expect(utcWouldFlip).toBeInstanceOf(Date);
  });

  it("computes June to August/September offsets", () => {
    expect(monthsBetween("2026-06", "2026-08")).toBe(2);
    expect(monthsBetween("2026-06", "2026-09")).toBe(3);
    expect(monthsBetween("2026-06", "2026-06")).toBe(0);
  });

  it("shifts periods across year rollover", () => {
    expect(shiftPeriod("2026-06", 7)).toBe("2027-01");
    expect(shiftPeriod("2026-01", -1)).toBe("2025-12");
  });

  it("clamps month-end and leap day", () => {
    expect(shiftIsoDate("2026-06-30", 2)).toBe("2026-08-31");
    expect(shiftIsoDate("2024-02-29", 12)).toBe("2025-02-28");
    expect(shiftIsoDate("2026-07-15T12:00:00Z", 2)).toBe("2026-09-15T12:00:00Z");
  });

  it("maps current/prior/prior-year display periods back to seed", () => {
    const offset = 2;
    expect(toSeedPeriod("2026-08", offset)).toBe("2026-06");
    expect(toSeedPeriod("2026-07", offset)).toBe("2026-05");
    expect(toSeedPeriod("2025-08", offset)).toBe("2025-06");
  });

  it("builds variance labels from the selected display period", () => {
    expect(comparisonDisplayLabels("2026-08", "mtd", "prior")).toEqual({
      actual: "2026-08",
      compare: "2026-07",
    });
    expect(comparisonDisplayLabels("2026-08", "qtd", "prior")).toEqual({
      actual: "2026-Q3",
      compare: "2026-Q2",
    });
    expect(comparisonDisplayLabels("2026-08", "ytd", "prior_year")).toEqual({
      actual: "2026 YTD",
      compare: "2025 YTD",
    });
  });

  it("locates burn-down today by close-day stage, not relabelled date", () => {
    expect(closeDayIndex([{ t: -2 }, { t: 0 }, { t: 11 }], 11)).toBe(2);
  });

  it("relabels a generated follow-up with the selected display period", () => {
    expect(withDisplayPeriod(
      "Which business unit drove the opex variance month over month in 2026-06?",
      "2026-08",
    )).toBe("Which business unit drove the opex variance month over month in 2026-08?");
  });

  it("shifts response payloads and round-trips writes", () => {
    const offset = 2;
    const seed = {
      period: "2026-06",
      today: "2026-07-15",
      due_date: "2026-07-10",
      month_label: "Jun 2026",
      year: 2026,
      month: 6,
      task_id: "TASK-2026-06-R-20000-BU-100",
      fiscal: "FY2025",
      period_end: "2025-12-31",
    };
    const display = toDisplayPayload(seed, offset) as Record<string, unknown>;
    expect(display.period).toBe("2026-08");
    expect(display.due_date).toBe("2026-09-10");
    expect(display.today).toBe(localIsoDate());
    expect(display.task_id).toBe("TASK-2026-06-R-20000-BU-100");
    expect(display.fiscal).toBe("FY2025");
    expect(display.period_end).toBe("2025-12-31");
    expect(String(display.month_label)).toMatch(/Aug/);
    expect(display.month).toBe(8);
    const body = { due_date: display.due_date as string, period: display.period as string };
    const seeded = toSeedPayload(body, offset) as Record<string, string>;
    expect(seeded.period).toBe("2026-08");
    expect(seeded.due_date).toBe("2026-07-10");
  });

  it("shifts /periods lists to a contiguous current-month series", () => {
    const offset = 2;
    const resp = toDisplayPayload({
      active: "2026-06",
      periods: [
        { period: "2026-06", month_label: "Jun 2026", is_active_close: true },
        { period: "2026-05", month_label: "May 2026", is_active_close: false },
      ],
    }, offset) as { active: string; periods: { period: string }[] };
    expect(resp.active).toBe("2026-08");
    expect(resp.periods.map((p) => p.period)).toEqual(["2026-08", "2026-07"]);
  });

  it("shifts Genie date tokens but not FY labels", () => {
    const text = shiftDateTokens("Revenue in 2026-06 vs 2025-06; paid 2026-06-30", 2);
    expect(text).toBe("Revenue in 2026-08 vs 2025-08; paid 2026-08-31");
    expect(shiftDateTokens("FY2025 filing", 2)).toBe("FY2025 filing");
    expect(shiftDateTokens("See TASK-2026-06-R-20000", 2)).toBe("See TASK-2026-06-R-20000");
  });

  it("shifts generated commentary text and leaves competitor period_end", () => {
    const display = toDisplayPayload({
      period: "2026-06",
      seed_question: "Which BU drove opex in 2026-06?",
      comments: ["Revenue rose in 2026-06 versus 2026-05."],
      period_end: "2025-12-31",
    }, 2) as Record<string, unknown>;
    expect(display.period).toBe("2026-08");
    expect(display.seed_question).toBe("Which BU drove opex in 2026-08?");
    expect(display.comments).toEqual(["Revenue rose in 2026-08 versus 2026-07."]);
    expect(display.period_end).toBe("2025-12-31");
  });
});
