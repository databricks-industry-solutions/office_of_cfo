import { describe, expect, it } from "vitest";
import type { StatementLine } from "../api";
import type { Overlay } from "./industries";
import {
  buildBalance,
  buildCashFlow,
  buildEquity,
  buildIncome,
} from "./statementBuilders";

const baseOverlay = {
  id: "consumer",
  label: "Consumer Goods",
  navLabels: {},
  hiddenPages: [],
  pageCopy: {},
  kpiLabels: {},
  hiddenKpis: [],
  cogsLabel: "Cost of Goods Sold",
  statementLabels: {},
  hiddenStatementLines: [],
  genieChips: [],
  exposure: { noun: "customer", vendorNoun: "supplier", action: "account review" },
  stressHiddenLevers: [],
} as unknown as Overlay;

describe("buildIncome", () => {
  it("returns an empty display model when raw rows are absent", () => {
    expect(buildIncome([], baseOverlay)).toEqual([]);
  });

  it("derives current and prior amounts when all prior inputs exist", () => {
    const rows: StatementLine[] = [
      { line_id: "revenue", line_label: "Revenue", sort_order: 1, amount: 1000, prior_amount: 900 },
      { line_id: "cogs", line_label: "COGS", sort_order: 2, amount: 400, prior_amount: 350 },
      { line_id: "opex", line_label: "OpEx", sort_order: 3, amount: 200, prior_amount: 190 },
      { line_id: "interest_income", line_label: "Interest Income", sort_order: 6, amount: 10, prior_amount: 8 },
      { line_id: "interest_expense", line_label: "Interest Expense", sort_order: 7, amount: 30, prior_amount: 20 },
      { line_id: "tax_expense", line_label: "Tax Expense", sort_order: 9, amount: 84, prior_amount: 70 },
    ];

    const out = buildIncome(rows, baseOverlay);
    const pbt = out.find((r) => r.key === "profit_before_tax");
    const ni = out.find((r) => r.key === "net_income");

    expect(pbt?.amount).toBe(380);
    expect(pbt?.priorAmount).toBe(348);
    expect(ni?.amount).toBe(296);
    expect(ni?.priorAmount).toBe(278);
  });

  it("keeps derived priorAmount absent when any prior input is missing", () => {
    const rows: StatementLine[] = [
      { line_id: "revenue", line_label: "Revenue", sort_order: 1, amount: 1000, prior_amount: 900 },
      { line_id: "cogs", line_label: "COGS", sort_order: 2, amount: 400, prior_amount: 350 },
      { line_id: "opex", line_label: "OpEx", sort_order: 3, amount: 200, prior_amount: 190 },
      { line_id: "interest_income", line_label: "Interest Income", sort_order: 6, amount: 10 },
      { line_id: "interest_expense", line_label: "Interest Expense", sort_order: 7, amount: 30, prior_amount: 20 },
      { line_id: "tax_expense", line_label: "Tax Expense", sort_order: 9, amount: 84, prior_amount: 70 },
    ];

    const out = buildIncome(rows, baseOverlay);
    const pbt = out.find((r) => r.key === "profit_before_tax");
    const ni = out.find((r) => r.key === "net_income");

    expect(pbt?.priorAmount).toBeNull();
    expect(ni?.priorAmount).toBeNull();
  });

  it("applies overlay relabel/hide using stable ids", () => {
    const overlay = {
      ...baseOverlay,
      statementLabels: { cogs: "Cost of Revenue", income: "Statement of Operations" },
      hiddenStatementLines: ["cogs"],
    } as Overlay;
    const rows: StatementLine[] = [
      { line_id: "revenue", line_label: "Revenue", sort_order: 1, amount: 100 },
      { line_id: "cogs", line_label: "COGS", sort_order: 2, amount: 40 },
      { line_id: "opex", line_label: "OpEx", sort_order: 3, amount: 20 },
      { line_id: "interest_income", line_label: "Interest Income", sort_order: 6, amount: 0 },
      { line_id: "interest_expense", line_label: "Interest Expense", sort_order: 7, amount: 0 },
      { line_id: "tax_expense", line_label: "Tax Expense", sort_order: 9, amount: 0 },
    ];

    const out = buildIncome(rows, overlay);
    expect(out.some((r) => r.key === "cogs")).toBe(false);
    expect(out.find((r) => r.key === "revenue")?.label).toBe("Revenue");
  });
});

describe("buildBalance", () => {
  it("returns an empty display model when raw rows are absent", () => {
    expect(buildBalance([], baseOverlay)).toEqual([]);
  });

  it("still renders taxes_payable when present on the balance sheet", () => {
    const rows: StatementLine[] = [
      { section: "assets_current", line_id: "cash", line_label: "Cash", sort_order: 1, amount: 100 },
      {
        section: "liabilities_current",
        line_id: "taxes_payable",
        line_label: "Taxes Payable",
        sort_order: 2,
        amount: 20,
      },
      { section: "equity", line_id: "retained_earnings", line_label: "RE", sort_order: 3, amount: 80 },
    ];
    const out = buildBalance(rows, baseOverlay);
    expect(out.find((r) => r.key === "liabilities_current-taxes_payable")?.amount).toBe(20);
  });

  it("renders current/noncurrent sections and stable total keys", () => {
    const rows: StatementLine[] = [
      { section: "assets_current", line_id: "cash", line_label: "Cash", sort_order: 1, amount: 120 },
      { section: "assets_noncurrent", line_id: "ppe", line_label: "PPE", sort_order: 2, amount: 80 },
      { section: "liabilities_current", line_id: "ap", line_label: "AP", sort_order: 3, amount: 60 },
      { section: "liabilities_noncurrent", line_id: "debt_long", line_label: "Long-term Debt", sort_order: 4, amount: 40 },
      { section: "equity", line_id: "retained_earnings", line_label: "Retained Earnings", sort_order: 5, amount: 100 },
    ];

    const out = buildBalance(rows, baseOverlay);
    expect(out.find((r) => r.key === "sec-assets_current")).toBeTruthy();
    expect(out.find((r) => r.key === "sec-assets_noncurrent")).toBeTruthy();
    expect(out.find((r) => r.key === "total-assets")?.amount).toBe(200);
    expect(out.find((r) => r.key === "total-liabilities")?.amount).toBe(100);
    expect(out.find((r) => r.key === "total-equity")?.amount).toBe(100);
    expect(out.find((r) => r.key === "total-le")?.amount).toBe(200);
  });

  it("keeps totals unchanged when a source line is hidden", () => {
    const rows: StatementLine[] = [
      { section: "assets_current", line_id: "cash", line_label: "Cash", sort_order: 1, amount: 120, prior_amount: 110 },
      { section: "assets_noncurrent", line_id: "ppe", line_label: "PPE", sort_order: 2, amount: 80, prior_amount: 70 },
      { section: "liabilities_current", line_id: "ap", line_label: "AP", sort_order: 3, amount: 60, prior_amount: 55 },
      { section: "liabilities_noncurrent", line_id: "debt_long", line_label: "Long-term Debt", sort_order: 4, amount: 40, prior_amount: 35 },
      { section: "equity", line_id: "retained_earnings", line_label: "Retained Earnings", sort_order: 5, amount: 100, prior_amount: 90 },
    ];
    const overlay = { ...baseOverlay, hiddenStatementLines: ["ppe"] } as Overlay;

    const out = buildBalance(rows, overlay);
    expect(out.some((r) => r.key === "assets_noncurrent-ppe")).toBe(false);
    expect(out.find((r) => r.key === "total-assets")?.amount).toBe(200);
    expect(out.find((r) => r.key === "total-assets")?.priorAmount).toBe(180);
    expect(out.find((r) => r.key === "total-le")?.amount).toBe(200);
  });

  it("treats intentionally empty sections as zero in current and prior aggregates", () => {
    const rows: StatementLine[] = [
      { section: "assets_current", line_id: "cash", line_label: "Cash", sort_order: 1, amount: 120, prior_amount: 110 },
      { section: "assets_noncurrent", line_id: "ppe", line_label: "PPE", sort_order: 2, amount: 80, prior_amount: 70 },
      { section: "liabilities_current", line_id: "ap", line_label: "AP", sort_order: 3, amount: 100, prior_amount: 90 },
      // liabilities_noncurrent intentionally absent
      { section: "equity", line_id: "retained_earnings", line_label: "Retained Earnings", sort_order: 5, amount: 100, prior_amount: 90 },
    ];

    const out = buildBalance(rows, baseOverlay);
    expect(out.find((r) => r.key === "sec-liabilities_noncurrent")).toBeUndefined();
    expect(out.find((r) => r.key === "total-liabilities")?.amount).toBe(100);
    expect(out.find((r) => r.key === "total-liabilities")?.priorAmount).toBe(90);
    expect(out.find((r) => r.key === "total-le")?.priorAmount).toBe(180);
  });

  it("propagates null prior when an existing source line lacks prior_amount", () => {
    const rows: StatementLine[] = [
      { section: "assets_current", line_id: "cash", line_label: "Cash", sort_order: 1, amount: 120, prior_amount: 110 },
      { section: "assets_noncurrent", line_id: "ppe", line_label: "PPE", sort_order: 2, amount: 80 },
      { section: "liabilities_current", line_id: "ap", line_label: "AP", sort_order: 3, amount: 60, prior_amount: 55 },
      { section: "equity", line_id: "retained_earnings", line_label: "Retained Earnings", sort_order: 5, amount: 140, prior_amount: 130 },
    ];

    const out = buildBalance(rows, baseOverlay);
    expect(out.find((r) => r.key === "total-assets")?.priorAmount).toBeNull();
    expect(out.find((r) => r.key === "total-le")?.priorAmount).toBe(185);
  });

  it("relabels and hides generated balance total rows without changing math", () => {
    const rows: StatementLine[] = [
      { section: "assets_current", line_id: "cash", line_label: "Cash", sort_order: 1, amount: 50 },
      { section: "liabilities_current", line_id: "ap", line_label: "AP", sort_order: 2, amount: 20 },
      { section: "equity", line_id: "retained_earnings", line_label: "RE", sort_order: 3, amount: 30 },
    ];
    const overlay = {
      ...baseOverlay,
      statementLabels: { "total-assets": "Assets Total", "total-le": "Total L&E" },
      hiddenStatementLines: ["total-equity"],
    } as Overlay;

    const out = buildBalance(rows, overlay);
    expect(out.find((r) => r.key === "total-assets")?.label).toBe("Assets Total");
    expect(out.find((r) => r.key === "total-le")?.label).toBe("Total L&E");
    expect(out.some((r) => r.key === "total-equity")).toBe(false);
    expect(out.find((r) => r.key === "total-le")?.amount).toBe(50);
  });
});

describe("buildCashFlow", () => {
  it("returns an empty display model when raw rows are absent", () => {
    expect(buildCashFlow([], baseOverlay)).toEqual([]);
  });

  it("computes net change including negative dividends", () => {
    const rows: StatementLine[] = [
      { section: "operating", line_id: "collections", line_label: "Collections", sort_order: 1, amount: 300 },
      { section: "operating", line_id: "operating_disbursements", line_label: "Operating Disbursements", sort_order: 2, amount: -200 },
      { section: "investing", line_id: "capex", line_label: "CapEx", sort_order: 3, amount: -40 },
      { section: "financing", line_id: "dividends_paid", line_label: "Dividends Paid", sort_order: 4, amount: -25 },
      { section: "financing", line_id: "financing_other", line_label: "Financing Other", sort_order: 5, amount: 15 },
      { line_id: "beginning_cash", line_label: "Beginning Cash", sort_order: 6, amount: 500 },
      { line_id: "ending_cash", line_label: "Ending Cash", sort_order: 7, amount: 550 },
    ];

    const out = buildCashFlow(rows, baseOverlay);
    expect(out.find((r) => r.key === "net_change")?.amount).toBe(50);
  });

  it("keeps net_change including hidden source lines", () => {
    const rows: StatementLine[] = [
      { section: "operating", line_id: "collections", line_label: "Collections", sort_order: 1, amount: 300 },
      { section: "operating", line_id: "operating_disbursements", line_label: "Operating Disbursements", sort_order: 2, amount: -200 },
      { section: "investing", line_id: "capex", line_label: "CapEx", sort_order: 3, amount: -40 },
      { section: "financing", line_id: "dividends_paid", line_label: "Dividends Paid", sort_order: 4, amount: -25 },
      { section: "financing", line_id: "financing_other", line_label: "Financing Other", sort_order: 5, amount: 15 },
      { line_id: "beginning_cash", line_label: "Beginning Cash", sort_order: 6, amount: 500 },
      { line_id: "ending_cash", line_label: "Ending Cash", sort_order: 7, amount: 550 },
    ];
    const overlay = { ...baseOverlay, hiddenStatementLines: ["dividends_paid"] } as Overlay;

    const out = buildCashFlow(rows, overlay);
    expect(out.some((r) => r.key === "financing-dividends_paid")).toBe(false);
    expect(out.find((r) => r.key === "total-financing")?.amount).toBe(-10);
    expect(out.find((r) => r.key === "net_change")?.amount).toBe(50);
  });

  it("relabels and hides generated cash summary rows without changing net_change", () => {
    const rows: StatementLine[] = [
      { section: "operating", line_id: "collections", line_label: "Collections", sort_order: 1, amount: 100 },
      { section: "financing", line_id: "dividends_paid", line_label: "Dividends Paid", sort_order: 2, amount: -20 },
      { line_id: "beginning_cash", line_label: "Beginning Cash", sort_order: 3, amount: 200 },
      { line_id: "ending_cash", line_label: "Ending Cash", sort_order: 4, amount: 280 },
    ];
    const overlay = {
      ...baseOverlay,
      statementLabels: {
        "total-operating": "Cash from Ops",
        net_change: "Cash Movement",
        beginning_cash: "Opening Cash",
        ending_cash: "Closing Cash",
      },
      hiddenStatementLines: ["total-financing"],
    } as Overlay;

    const out = buildCashFlow(rows, overlay);
    expect(out.find((r) => r.key === "total-operating")?.label).toBe("Cash from Ops");
    expect(out.find((r) => r.key === "net_change")?.label).toBe("Cash Movement");
    expect(out.find((r) => r.key === "beginning_cash")?.label).toBe("Opening Cash");
    expect(out.find((r) => r.key === "ending_cash")?.label).toBe("Closing Cash");
    expect(out.some((r) => r.key === "total-financing")).toBe(false);
    expect(out.find((r) => r.key === "net_change")?.amount).toBe(80);
  });
});

describe("buildEquity", () => {
  it("returns an empty display model when raw rows are absent", () => {
    expect(buildEquity([], baseOverlay)).toEqual([]);
  });

  it("orders classes and line ids as common_stock, retained_earnings, total", () => {
    const rows: StatementLine[] = [
      { equity_class: "retained_earnings", line_id: "ending", line_label: "Ending", sort_order: 40, amount: 610 },
      { equity_class: "common_stock", line_id: "ending", line_label: "Ending", sort_order: 40, amount: 150 },
      { equity_class: "total", line_id: "ending", line_label: "Ending", sort_order: 40, amount: 760 },
      { equity_class: "retained_earnings", line_id: "beginning", line_label: "Beginning", sort_order: 10, amount: 500 },
      { equity_class: "retained_earnings", line_id: "net_income", line_label: "Net income", sort_order: 20, amount: 130 },
      { equity_class: "retained_earnings", line_id: "dividends", line_label: "Dividends", sort_order: 30, amount: -20 },
      { equity_class: "common_stock", line_id: "beginning", line_label: "Beginning", sort_order: 10, amount: 150 },
      { equity_class: "common_stock", line_id: "net_income", line_label: "Net income", sort_order: 20, amount: 0 },
      { equity_class: "common_stock", line_id: "dividends", line_label: "Dividends", sort_order: 30, amount: 0 },
      { equity_class: "total", line_id: "beginning", line_label: "Beginning", sort_order: 10, amount: 650 },
      { equity_class: "total", line_id: "net_income", line_label: "Net income", sort_order: 20, amount: 130 },
      { equity_class: "total", line_id: "dividends", line_label: "Dividends", sort_order: 30, amount: -20 },
    ];

    const out = buildEquity(rows, baseOverlay);
    expect(out.map((r) => r.key)).toEqual([
      "common_stock-beginning",
      "common_stock-net_income",
      "common_stock-dividends",
      "common_stock-ending",
      "retained_earnings-beginning",
      "retained_earnings-net_income",
      "retained_earnings-dividends",
      "retained_earnings-ending",
      "total-beginning",
      "total-net_income",
      "total-dividends",
      "total-ending",
    ]);
  });
});
