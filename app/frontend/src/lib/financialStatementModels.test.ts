import { describe, expect, it } from "vitest";
import type { DisplayRow, EquityDisplayRow } from "./statementBuilders";
import {
  buildComparativeTable,
  buildEquityMatrix,
  buildEquityExportTable,
  priorPeriod,
} from "./financialStatementModels";

describe("priorPeriod", () => {
  it("moves to the immediately preceding calendar month", () => {
    expect(priorPeriod("2026-06")).toBe("2026-05");
    expect(priorPeriod("2026-01")).toBe("2025-12");
  });
});

describe("buildComparativeTable", () => {
  const rows: DisplayRow[] = [
    { key: "revenue", label: "Revenue", amount: 120, priorAmount: 100, kind: "line" },
    { key: "net_income", label: "Net Income", amount: 30, priorAmount: null, kind: "total" },
  ];

  it("uses current and prior period columns when any prior value exists", () => {
    expect(buildComparativeTable(rows, "2026-06")).toEqual({
      headers: ["Line", "2026-06", "2026-05"],
      rows: [
        { kind: "line", cells: ["Revenue", 120, 100] },
        { kind: "total", cells: ["Net Income", 30, null] },
      ],
    });
  });

  it("uses a single Amount column when no prior value exists", () => {
    expect(buildComparativeTable(
      rows.map((row) => ({ ...row, priorAmount: null })),
      "2026-06",
    )).toEqual({
      headers: ["Line", "Amount"],
      rows: [
        { kind: "line", cells: ["Revenue", 120] },
        { kind: "total", cells: ["Net Income", 30] },
      ],
    });
  });
});

describe("equity matrix models", () => {
  const rows: EquityDisplayRow[] = [
    { key: "common_stock-beginning", label: "Beginning balance", amount: 100, priorAmount: 90, kind: "line", equityClass: "common_stock", lineId: "beginning" },
    { key: "retained_earnings-beginning", label: "Beginning balance", amount: 400, priorAmount: 350, kind: "line", equityClass: "retained_earnings", lineId: "beginning" },
    { key: "total-beginning", label: "Beginning balance", amount: 500, priorAmount: 440, kind: "line", equityClass: "total", lineId: "beginning" },
    { key: "common_stock-net_income", label: "Net income", amount: 0, priorAmount: 0, kind: "line", equityClass: "common_stock", lineId: "net_income" },
    { key: "retained_earnings-net_income", label: "Net income", amount: 80, priorAmount: 65, kind: "line", equityClass: "retained_earnings", lineId: "net_income" },
    { key: "total-net_income", label: "Net income", amount: 80, priorAmount: 65, kind: "line", equityClass: "total", lineId: "net_income" },
    { key: "common_stock-dividends", label: "Dividends", amount: 0, priorAmount: 0, kind: "line", equityClass: "common_stock", lineId: "dividends" },
    { key: "retained_earnings-dividends", label: "Dividends", amount: -20, priorAmount: -15, kind: "line", equityClass: "retained_earnings", lineId: "dividends" },
    { key: "total-dividends", label: "Dividends", amount: -20, priorAmount: -15, kind: "line", equityClass: "total", lineId: "dividends" },
    { key: "common_stock-ending", label: "Ending balance", amount: 100, priorAmount: 90, kind: "line", equityClass: "common_stock", lineId: "ending" },
    { key: "retained_earnings-ending", label: "Ending balance", amount: 460, priorAmount: 400, kind: "line", equityClass: "retained_earnings", lineId: "ending" },
    { key: "total-ending", label: "Ending balance", amount: 560, priorAmount: 490, kind: "total", equityClass: "total", lineId: "ending" },
  ];

  it("pivots builder rows into a readable current-period matrix", () => {
    expect(buildEquityMatrix(rows, "amount")).toEqual({
      headers: ["Movement", "Common Stock", "Retained Earnings", "Total"],
      rows: [
        { kind: "line", cells: ["Beginning balance", 100, 400, 500] },
        { kind: "line", cells: ["Net income", 0, 80, 80] },
        { kind: "line", cells: ["Dividends", 0, -20, -20] },
        { kind: "total", cells: ["Ending balance", 100, 460, 560] },
      ],
    });
  });

  it("preserves both periods in the equity export table", () => {
    const table = buildEquityExportTable(rows, "2026-06");
    expect(table.headers).toEqual(["Movement", "Common Stock", "Retained Earnings", "Total"]);
    expect(table.rows[0]).toEqual({ kind: "section", cells: ["2026-06", null, null, null] });
    expect(table.rows[6]).toEqual({ kind: "section", cells: ["2026-05", null, null, null] });
    expect(table.rows[table.rows.length - 1]).toEqual({
      kind: "total",
      cells: ["Ending balance", 90, 400, 490],
    });
  });
});
