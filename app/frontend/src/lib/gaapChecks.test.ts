import { describe, expect, it } from "vitest";
import type { DisplayRow } from "./statementBuilders";
import { runGaapChecks } from "./gaapChecks";

const row = (
  key: string,
  amount: number | null,
  kind: DisplayRow["kind"] = "line",
  priorAmount?: number | null,
): DisplayRow => ({
  key,
  label: key,
  amount,
  kind,
  priorAmount,
});

function healthyInput() {
  return {
    income: [
      row("revenue", 1000, "line", 950),
      row("tax_expense", -50, "line", -45),
      row("net_income", 130, "total", 120),
    ],
    balance: [
      row("assets_current-cash", 150, "line", 120),
      row("total-assets", 1000, "subtotal", 950),
      row("total-liabilities", 600, "subtotal", 580),
      row("total-le", 1000, "total", 950),
    ],
    cashflow: [
      row("ending_cash", 150, "total", 120),
    ],
    equity: [
      row("total-beginning", 840, "line", 790),
      row("total-net_income", 130, "line", 120),
      row("total-dividends", -20, "line", -15),
      row("total-ending", 950, "total", 895),
    ],
    period: "2026-06",
  };
}

describe("runGaapChecks", () => {
  it("returns all 10 GAAP principle ids exactly once", () => {
    const results = runGaapChecks(healthyInput());
    expect(results).toHaveLength(10);
    expect(results.map((r) => r.id)).toEqual([
      "regularity",
      "consistency",
      "sincerity",
      "permanence",
      "non_compensation",
      "prudence",
      "continuity",
      "periodicity",
      "materiality",
      "utmost_good_faith",
    ]);
  });

  it("passes consistency when prior-period values are present", () => {
    const results = runGaapChecks(healthyInput());
    expect(results.find((r) => r.id === "consistency")?.status).toBe("pass");
  });

  it("fails sincerity when assets != L+E", () => {
    const input = healthyInput();
    input.balance = input.balance.map((r) =>
      r.key === "total-le" ? { ...r, amount: 950 } : r,
    );

    const results = runGaapChecks(input);
    expect(results.find((r) => r.id === "sincerity")?.status).toBe("fail");
  });

  it("fails sincerity at exactly 0.5% BS imbalance using assets denominator", () => {
    const input = healthyInput();
    input.balance = input.balance.map((r) => {
      if (r.key === "total-assets") return { ...r, amount: 1000 };
      if (r.key === "total-le") return { ...r, amount: 995 }; // abs(5)/max(1000,1) = 0.5%
      return r;
    });

    const results = runGaapChecks(input);
    const sincerity = results.find((r) => r.id === "sincerity")!;
    expect(sincerity.status).toBe("fail");
    expect(sincerity.detail).toContain("0.50%");
  });

  it("passes sincerity just below 0.5% BS imbalance using assets denominator", () => {
    const input = healthyInput();
    // With assets denom: 4.99/1000 = 0.499% pass. With LE denom this would fail.
    input.balance = input.balance.map((r) => {
      if (r.key === "total-assets") return { ...r, amount: 1000 };
      if (r.key === "total-le") return { ...r, amount: 995.01 };
      return r;
    });

    const results = runGaapChecks(input);
    expect(results.find((r) => r.id === "sincerity")?.status).toBe("pass");
  });

  it("floors zero assets to 1 for BS sincerity denominator", () => {
    const input = healthyInput();
    input.balance = input.balance.map((r) => {
      if (r.key === "total-assets") return { ...r, amount: 0 };
      if (r.key === "total-le") return { ...r, amount: 10 }; // abs(10)/max(0,1) = 1000%
      return r;
    });

    const results = runGaapChecks(input);
    const sincerity = results.find((r) => r.id === "sincerity")!;
    expect(sincerity.status).toBe("fail");
    expect(sincerity.detail).toContain("1000.00%");
  });

  it("uses abs(totalAssets) as BS sincerity denominator for negative assets", () => {
    const input = healthyInput();
    // assets denom: abs(-200 - -100)/max(200,1)=50%. LE denom would report 100%.
    input.balance = input.balance.map((r) => {
      if (r.key === "total-assets") return { ...r, amount: -200 };
      if (r.key === "total-le") return { ...r, amount: -100 };
      return r;
    });

    const results = runGaapChecks(input);
    const sincerity = results.find((r) => r.id === "sincerity")!;
    expect(sincerity.status).toBe("fail");
    expect(sincerity.detail).toContain("50.00%");
  });

  it("fails sincerity when equity rollforward mismatches", () => {
    const input = healthyInput();
    input.equity = input.equity.map((r) =>
      r.key === "total-ending" ? { ...r, amount: 940 } : r,
    );

    const results = runGaapChecks(input);
    expect(results.find((r) => r.id === "sincerity")?.status).toBe("fail");
  });

  it("fails sincerity when ending cash does not tie to balance cash line", () => {
    const input = healthyInput();
    input.cashflow = input.cashflow.map((r) =>
      r.key === "ending_cash" ? { ...r, amount: 100 } : r,
    );

    const results = runGaapChecks(input);
    expect(results.find((r) => r.id === "sincerity")?.status).toBe("fail");
    expect(results.find((r) => r.id === "sincerity")?.detail).toContain("Cash tie delta");
  });

  it("fails periodicity for invalid period format", () => {
    const input = healthyInput();
    input.period = "2026/06";

    const results = runGaapChecks(input);
    expect(results.find((r) => r.id === "periodicity")?.status).toBe("fail");
  });

  it("fails prudence for negative tax expense at source", () => {
    const input = healthyInput();
    input.income = input.income.map((r) =>
      r.key === "tax_expense" ? { ...r, amount: 50 } : r,
    );

    const results = runGaapChecks(input);
    expect(results.find((r) => r.id === "prudence")?.status).toBe("fail");
  });

  it("fails regularity when any required statement payload is missing", () => {
    const input = healthyInput();
    input.equity = [];

    const results = runGaapChecks(input);
    expect(results.find((r) => r.id === "regularity")?.status).toBe("fail");
  });

  it("fails regularity for empty builder output from absent raw payloads", async () => {
    const { buildIncome, buildBalance, buildCashFlow, buildEquity } = await import(
      "./statementBuilders"
    );
    const { getOverlay } = await import("./industries");
    const ov = getOverlay("consumer");
    const results = runGaapChecks({
      income: buildIncome([], ov),
      balance: buildBalance([], ov),
      cashflow: buildCashFlow([], ov),
      equity: buildEquity([], ov),
      period: "2026-06",
    });
    expect(results.find((r) => r.id === "regularity")?.status).toBe("fail");
  });

  it("warns consistency when no prior-period values are present", () => {
    const input = healthyInput();
    input.income = input.income.map(({ priorAmount: _p, ...rest }) => rest);

    const results = runGaapChecks(input);
    expect(results.find((r) => r.id === "consistency")?.status).toBe("warn");
  });

  it("warns instead of crashing when required rows are missing", () => {
    const input = healthyInput();
    input.balance = input.balance.filter(
      (r) => !["total-assets", "total-le", "assets_current-cash"].includes(r.key),
    );
    input.cashflow = [];
    input.equity = input.equity.filter((r) => r.key !== "total-ending");
    input.income = input.income.filter((r) => r.key !== "tax_expense");

    const results = runGaapChecks(input);
    expect(results).toHaveLength(10);
    expect(results.find((r) => r.id === "sincerity")?.status).toBe("warn");
    expect(results.find((r) => r.id === "continuity")?.status).toBe("warn");
    expect(results.find((r) => r.id === "prudence")?.status).toBe("warn");
    expect(results.find((r) => r.id === "non_compensation")?.status).toBe("warn");
  });
});
