import type { StatementLine } from "../api";
import type { Overlay } from "./industries";

export type DisplayKind = "line" | "subtotal" | "total" | "section";

export interface DisplayRow {
  key: string;
  label: string;
  amount: number | null;
  priorAmount?: number | null;
  kind: DisplayKind;
  indent?: boolean;
}

export interface EquityDisplayRow extends DisplayRow {
  equityClass: string;
  lineId: string;
}

const SECTION_TITLES: Record<string, string> = {
  assets_current: "Current Assets",
  assets_noncurrent: "Non-current Assets",
  liabilities_current: "Current Liabilities",
  liabilities_noncurrent: "Non-current Liabilities",
  equity: "Equity",
  operating: "Operating Activities",
  investing: "Investing Activities",
  financing: "Financing Activities",
};

const INCOME_IDS = [
  "revenue",
  "cogs",
  "opex",
  "interest_income",
  "interest_expense",
  "tax_expense",
] as const;

const EQUITY_CLASS_ORDER = ["common_stock", "retained_earnings", "total"] as const;
const EQUITY_LINE_ORDER = ["beginning", "net_income", "dividends", "ending"] as const;

const toNumber = (v: number | string | null | undefined) => (v == null ? 0 : Number(v) || 0);
const toPrior = (v: number | string | null | undefined): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const lineById = (rows: StatementLine[], id: string) => rows.find((r) => r.line_id === id);
const isHidden = (ov: Overlay, lineId: string) => (ov.hiddenStatementLines ?? []).includes(lineId);

function labelFor(ov: Overlay, lineId: string, fallback: string): string {
  const relabel = ov.statementLabels ?? {};
  if (relabel[lineId]) return relabel[lineId];
  if (lineId === "cogs") return ov.cogsLabel;
  return fallback;
}

function sumPriorStrict(values: Array<number | null>): number | null {
  if (values.some((v) => v == null)) return null;
  return values.reduce<number>((acc, v) => acc + (v ?? 0), 0);
}

function derivedPrior(
  rows: StatementLine[],
  deps: string[],
  compute: (vals: Record<string, number>) => number,
): number | null {
  const vals: Record<string, number> = {};
  for (const dep of deps) {
    const prior = toPrior(lineById(rows, dep)?.prior_amount);
    if (prior == null) return null;
    vals[dep] = prior;
  }
  return compute(vals);
}

export function buildIncome(rows: StatementLine[], ov: Overlay): DisplayRow[] {
  if (rows.length === 0) return [];

  const current = {
    revenue: toNumber(lineById(rows, "revenue")?.amount),
    cogs: toNumber(lineById(rows, "cogs")?.amount),
    opex: toNumber(lineById(rows, "opex")?.amount),
    interest_income: toNumber(lineById(rows, "interest_income")?.amount),
    interest_expense: toNumber(lineById(rows, "interest_expense")?.amount),
    tax_expense: toNumber(lineById(rows, "tax_expense")?.amount),
  };
  const grossProfit = current.revenue - current.cogs;
  const operatingIncome = grossProfit - current.opex;
  const profitBeforeTax =
    operatingIncome + current.interest_income - current.interest_expense;
  const netIncome = profitBeforeTax - current.tax_expense;

  const grossPrior = derivedPrior(rows, ["revenue", "cogs"], (v) => v.revenue - v.cogs);
  const opPrior = derivedPrior(rows, ["revenue", "cogs", "opex"], (v) => v.revenue - v.cogs - v.opex);
  const pbtPrior = derivedPrior(
    rows,
    ["revenue", "cogs", "opex", "interest_income", "interest_expense"],
    (v) => v.revenue - v.cogs - v.opex + v.interest_income - v.interest_expense,
  );
  const niPrior = derivedPrior(
    rows,
    [...INCOME_IDS],
    (v) =>
      v.revenue -
      v.cogs -
      v.opex +
      v.interest_income -
      v.interest_expense -
      v.tax_expense,
  );

  const out: DisplayRow[] = [
    {
      key: "revenue",
      label: labelFor(ov, "revenue", lineById(rows, "revenue")?.line_label ?? "Revenue"),
      amount: current.revenue,
      priorAmount: toPrior(lineById(rows, "revenue")?.prior_amount),
      kind: "line",
    },
    {
      key: "cogs",
      label: labelFor(ov, "cogs", lineById(rows, "cogs")?.line_label ?? "Cost of Goods Sold"),
      amount: -current.cogs,
      priorAmount: (() => {
        const p = toPrior(lineById(rows, "cogs")?.prior_amount);
        return p == null ? null : -p;
      })(),
      kind: "line",
    },
    {
      key: "gross_profit",
      label: labelFor(ov, "gross_profit", "Gross Profit"),
      amount: grossProfit,
      priorAmount: grossPrior,
      kind: "subtotal",
    },
    {
      key: "opex",
      label: labelFor(ov, "opex", lineById(rows, "opex")?.line_label ?? "Operating Expenses"),
      amount: -current.opex,
      priorAmount: (() => {
        const p = toPrior(lineById(rows, "opex")?.prior_amount);
        return p == null ? null : -p;
      })(),
      kind: "line",
    },
    {
      key: "operating_income",
      label: labelFor(ov, "operating_income", "Operating Income"),
      amount: operatingIncome,
      priorAmount: opPrior,
      kind: "subtotal",
    },
    {
      key: "interest_income",
      label: labelFor(
        ov,
        "interest_income",
        lineById(rows, "interest_income")?.line_label ?? "Interest Income",
      ),
      amount: current.interest_income,
      priorAmount: toPrior(lineById(rows, "interest_income")?.prior_amount),
      kind: "line",
    },
    {
      key: "interest_expense",
      label: labelFor(
        ov,
        "interest_expense",
        lineById(rows, "interest_expense")?.line_label ?? "Interest Expense",
      ),
      amount: -current.interest_expense,
      priorAmount: (() => {
        const p = toPrior(lineById(rows, "interest_expense")?.prior_amount);
        return p == null ? null : -p;
      })(),
      kind: "line",
    },
    {
      key: "profit_before_tax",
      label: labelFor(ov, "profit_before_tax", "Profit Before Tax"),
      amount: profitBeforeTax,
      priorAmount: pbtPrior,
      kind: "subtotal",
    },
    {
      key: "tax_expense",
      label: labelFor(
        ov,
        "tax_expense",
        lineById(rows, "tax_expense")?.line_label ?? "Tax Expense",
      ),
      amount: -current.tax_expense,
      priorAmount: (() => {
        const p = toPrior(lineById(rows, "tax_expense")?.prior_amount);
        return p == null ? null : -p;
      })(),
      kind: "line",
    },
    {
      key: "net_income",
      label: labelFor(ov, "net_income", "Net Income"),
      amount: netIncome,
      priorAmount: niPrior,
      kind: "total",
    },
  ];
  return out.filter((r) => !isHidden(ov, r.key));
}

export function buildBalance(rows: StatementLine[], ov: Overlay): DisplayRow[] {
  if (rows.length === 0) return [];

  const sectionOrder = [
    "assets_current",
    "assets_noncurrent",
    "liabilities_current",
    "liabilities_noncurrent",
    "equity",
  ] as const;

  const out: DisplayRow[] = [];
  // Empty sections contribute 0 (not null) so aggregate prior math stays valid.
  const sectionTotals: Record<string, number> = Object.fromEntries(
    sectionOrder.map((s) => [s, 0]),
  );
  const sectionPriorTotals: Record<string, number | null> = Object.fromEntries(
    sectionOrder.map((s) => [s, 0]),
  );

  for (const section of sectionOrder) {
    // Aggregate from every source line; hide is presentation-only.
    const lines = rows
      .filter((r) => r.section === section)
      .sort((a, b) => a.sort_order - b.sort_order);

    if (lines.length === 0) {
      sectionTotals[section] = 0;
      sectionPriorTotals[section] = 0;
      continue;
    }

    const currentAmounts = lines.map((line) => toNumber(line.amount));
    const priorAmounts = lines.map((line) => toPrior(line.prior_amount));
    sectionTotals[section] = currentAmounts.reduce((acc, v) => acc + v, 0);
    sectionPriorTotals[section] = sumPriorStrict(priorAmounts);

    const visible = lines.filter((line) => !isHidden(ov, line.line_id));
    if (visible.length === 0) continue;

    out.push({
      key: `sec-${section}`,
      label: SECTION_TITLES[section],
      amount: null,
      kind: "section",
    });
    for (const line of visible) {
      out.push({
        key: `${section}-${line.line_id}`,
        label: labelFor(ov, line.line_id, line.line_label),
        amount: toNumber(line.amount),
        priorAmount: toPrior(line.prior_amount),
        kind: "line",
        indent: true,
      });
    }
  }

  const totalAssets =
    sectionTotals.assets_current + sectionTotals.assets_noncurrent;
  const totalLiabilities =
    sectionTotals.liabilities_current + sectionTotals.liabilities_noncurrent;
  const totalEquity = sectionTotals.equity;
  const totalLE = totalLiabilities + totalEquity;

  const assetsPrior = sumPriorStrict([
    sectionPriorTotals.assets_current,
    sectionPriorTotals.assets_noncurrent,
  ]);
  const liabilitiesPrior = sumPriorStrict([
    sectionPriorTotals.liabilities_current,
    sectionPriorTotals.liabilities_noncurrent,
  ]);
  const equityPrior = sectionPriorTotals.equity;
  const lePrior = sumPriorStrict([liabilitiesPrior, equityPrior]);

  const generated: DisplayRow[] = [
    {
      key: "total-assets",
      label: labelFor(ov, "total-assets", "Total Assets"),
      amount: totalAssets,
      priorAmount: assetsPrior,
      kind: "subtotal",
    },
    {
      key: "total-liabilities",
      label: labelFor(ov, "total-liabilities", "Total Liabilities"),
      amount: totalLiabilities,
      priorAmount: liabilitiesPrior,
      kind: "subtotal",
    },
    {
      key: "total-equity",
      label: labelFor(ov, "total-equity", "Total Equity"),
      amount: totalEquity,
      priorAmount: equityPrior,
      kind: "subtotal",
    },
    {
      key: "total-le",
      label: labelFor(ov, "total-le", "Total Liabilities & Equity"),
      amount: totalLE,
      priorAmount: lePrior,
      kind: "total",
    },
  ];
  for (const row of generated) {
    if (!isHidden(ov, row.key)) out.push(row);
  }
  return out;
}

export function buildCashFlow(rows: StatementLine[], ov: Overlay): DisplayRow[] {
  if (rows.length === 0) return [];

  const out: DisplayRow[] = [];
  const sections = ["operating", "investing", "financing"] as const;
  let netChange = 0;
  const sectionPriors: Array<number | null> = [];

  for (const section of sections) {
    // Aggregate from every source line; hide is presentation-only.
    const lines = rows
      .filter((r) => r.section === section)
      .sort((a, b) => a.sort_order - b.sort_order);
    if (lines.length === 0) continue;

    let subtotal = 0;
    const priors: Array<number | null> = [];
    for (const line of lines) {
      subtotal += toNumber(line.amount);
      priors.push(toPrior(line.prior_amount));
    }
    netChange += subtotal;
    const sectionPrior = sumPriorStrict(priors);
    sectionPriors.push(sectionPrior);

    const visible = lines.filter((line) => !isHidden(ov, line.line_id));
    const subtotalKey = `total-${section}`;
    const showSection = visible.length > 0 || !isHidden(ov, subtotalKey);
    if (showSection) {
      out.push({
        key: `sec-${section}`,
        label: SECTION_TITLES[section],
        amount: null,
        kind: "section",
      });
    }
    for (const line of visible) {
      out.push({
        key: `${section}-${line.line_id}`,
        label: labelFor(ov, line.line_id, line.line_label),
        amount: toNumber(line.amount),
        priorAmount: toPrior(line.prior_amount),
        kind: "line",
        indent: true,
      });
    }
    if (!isHidden(ov, subtotalKey)) {
      out.push({
        key: subtotalKey,
        label: labelFor(ov, subtotalKey, `Net Cash from ${SECTION_TITLES[section]}`),
        amount: subtotal,
        priorAmount: sectionPrior,
        kind: "subtotal",
      });
    }
  }

  const summary: DisplayRow[] = [
    {
      key: "net_change",
      label: labelFor(ov, "net_change", "Net Change in Cash"),
      amount: netChange,
      priorAmount: sumPriorStrict(sectionPriors),
      kind: "total",
    },
    {
      key: "beginning_cash",
      label: labelFor(
        ov,
        "beginning_cash",
        lineById(rows, "beginning_cash")?.line_label ?? "Beginning Cash",
      ),
      amount: toNumber(lineById(rows, "beginning_cash")?.amount),
      priorAmount: toPrior(lineById(rows, "beginning_cash")?.prior_amount),
      kind: "line",
    },
    {
      key: "ending_cash",
      label: labelFor(
        ov,
        "ending_cash",
        lineById(rows, "ending_cash")?.line_label ?? "Ending Cash",
      ),
      amount: toNumber(lineById(rows, "ending_cash")?.amount),
      priorAmount: toPrior(lineById(rows, "ending_cash")?.prior_amount),
      kind: "total",
    },
  ];
  for (const row of summary) {
    if (!isHidden(ov, row.key)) out.push(row);
  }
  return out;
}

export function buildEquity(rows: StatementLine[], ov: Overlay): EquityDisplayRow[] {
  if (rows.length === 0) return [];

  const classRank = (cls: string) => {
    const idx = EQUITY_CLASS_ORDER.indexOf(cls as (typeof EQUITY_CLASS_ORDER)[number]);
    return idx >= 0 ? idx : EQUITY_CLASS_ORDER.length + 1;
  };
  const lineRank = (lineId: string) => {
    const idx = EQUITY_LINE_ORDER.indexOf(lineId as (typeof EQUITY_LINE_ORDER)[number]);
    return idx >= 0 ? idx : EQUITY_LINE_ORDER.length + 1;
  };

  return rows
    .filter((row) => !!row.equity_class && !isHidden(ov, row.line_id))
    .sort((a, b) => {
      const classDiff = classRank(a.equity_class ?? "") - classRank(b.equity_class ?? "");
      if (classDiff !== 0) return classDiff;
      const lineDiff = lineRank(a.line_id) - lineRank(b.line_id);
      if (lineDiff !== 0) return lineDiff;
      return a.sort_order - b.sort_order;
    })
    .map((row) => {
      const key = `${row.equity_class}-${row.line_id}`;
      return {
        key,
        label: labelFor(ov, row.line_id, row.line_label),
        amount: toNumber(row.amount),
        priorAmount: toPrior(row.prior_amount),
        kind: row.equity_class === "total" && row.line_id === "ending" ? "total" : "line",
        equityClass: row.equity_class ?? "unknown",
        lineId: row.line_id,
      };
    });
}
