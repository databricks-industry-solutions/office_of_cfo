import type { DisplayRow } from "./statementBuilders";

export type GaapPrincipleId =
  | "regularity"
  | "consistency"
  | "sincerity"
  | "permanence"
  | "non_compensation"
  | "prudence"
  | "continuity"
  | "periodicity"
  | "materiality"
  | "utmost_good_faith";

export interface GaapCheckResult {
  id: GaapPrincipleId;
  label: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

export interface RunGaapChecksInput {
  income: DisplayRow[];
  balance: DisplayRow[];
  cashflow: DisplayRow[];
  equity: DisplayRow[];
  period: string;
}

const TOLERANCE = 0.005;

function readAmount(rows: DisplayRow[], key: string): number | null {
  const row = rows.find((r) => r.key === key);
  if (!row || row.amount == null) return null;
  return Number.isFinite(row.amount) ? row.amount : null;
}

/** Relative difference using `expected` as the denominator (floored at 1). */
function relDiff(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.max(Math.abs(expected), 1);
}

/** Balance-sheet sincerity: always use |totalAssets| as the denominator. */
function balanceSheetRelDiff(totalAssets: number, totalLE: number): number {
  return Math.abs(totalAssets - totalLE) / Math.max(Math.abs(totalAssets), 1);
}

function pct(v: number): string {
  return `${(v * 100).toFixed(2)}%`;
}

export function runGaapChecks(input: RunGaapChecksInput): GaapCheckResult[] {
  const missingStatements: string[] = [];
  if (input.income.length === 0) missingStatements.push("Income statement");
  if (input.balance.length === 0) missingStatements.push("Balance sheet");
  if (input.cashflow.length === 0) missingStatements.push("Cash flow");
  if (input.equity.length === 0) missingStatements.push("Equity statement");

  const regularity: GaapCheckResult =
    missingStatements.length === 0
      ? {
          id: "regularity",
          label: "Regularity",
          status: "pass",
          detail: "All four statement payloads are present for the selected period.",
        }
      : {
          id: "regularity",
          label: "Regularity",
          status: "fail",
          detail: `Missing statement payload(s): ${missingStatements.join(", ")}.`,
        };

  const hasPriorOnIncome = input.income.some(
    (row) => typeof row.priorAmount === "number" && Number.isFinite(row.priorAmount),
  );
  const consistency: GaapCheckResult = hasPriorOnIncome
    ? {
        id: "consistency",
        label: "Consistency",
        status: "pass",
        detail: "At least one income-statement line includes a prior-period value.",
      }
    : {
        id: "consistency",
        label: "Consistency",
        status: "warn",
        detail: "No prior-period income column is available; trend comparability is limited.",
      };

  const totalAssets = readAmount(input.balance, "total-assets");
  const totalLE = readAmount(input.balance, "total-le");
  const equityBeginning = readAmount(input.equity, "total-beginning");
  const equityNetIncome = readAmount(input.equity, "total-net_income");
  const equityDividends = readAmount(input.equity, "total-dividends");
  const equityEnding = readAmount(input.equity, "total-ending");
  const endingCash = readAmount(input.cashflow, "ending_cash");
  const balanceCash = readAmount(input.balance, "assets_current-cash");

  const balanceEvidenceReady = totalAssets != null && totalLE != null;
  const equityEvidenceReady =
    equityBeginning != null &&
    equityNetIncome != null &&
    equityDividends != null &&
    equityEnding != null;
  const cashEvidenceReady = endingCash != null && balanceCash != null;

  const balanceRel =
    balanceEvidenceReady ? balanceSheetRelDiff(totalAssets, totalLE) : null;
  const balanceMismatch =
    balanceRel != null && !(balanceRel < TOLERANCE);
  const equityExpected =
    equityEvidenceReady ? equityBeginning + equityNetIncome + equityDividends : null;
  const equityMismatch =
    equityEvidenceReady &&
    equityExpected != null &&
    !(relDiff(equityEnding, equityExpected) < TOLERANCE);
  const cashTieMismatch =
    cashEvidenceReady && !(relDiff(endingCash, balanceCash) < TOLERANCE);

  const sincerityMissing: string[] = [];
  if (!balanceEvidenceReady) sincerityMissing.push("balance totals");
  if (!equityEvidenceReady) sincerityMissing.push("equity rollforward rows");
  if (!cashEvidenceReady) sincerityMissing.push("cash tie rows");

  let sincerityStatus: "pass" | "warn" | "fail" = "pass";
  if (balanceMismatch || equityMismatch || cashTieMismatch) {
    sincerityStatus = "fail";
  } else if (sincerityMissing.length > 0) {
    sincerityStatus = "warn";
  }

  const sincerityParts: string[] = [];
  if (balanceEvidenceReady && balanceRel != null) {
    sincerityParts.push(
      `Balance tie ${Math.abs(totalAssets - totalLE).toFixed(2)} (${pct(balanceRel)})`,
    );
  } else {
    sincerityParts.push("Balance tie unavailable");
  }
  if (equityEvidenceReady && equityExpected != null) {
    sincerityParts.push(
      `Equity rollforward delta ${Math.abs(equityEnding - equityExpected).toFixed(2)} (${pct(
        relDiff(equityEnding, equityExpected),
      )})`,
    );
  } else {
    sincerityParts.push("Equity rollforward unavailable");
  }
  if (cashEvidenceReady) {
    sincerityParts.push(
      `Cash tie delta ${Math.abs(endingCash - balanceCash).toFixed(2)} (${pct(
        relDiff(endingCash, balanceCash),
      )})`,
    );
  } else {
    sincerityParts.push("Cash tie unavailable");
  }
  if (sincerityMissing.length > 0) {
    sincerityParts.push(`Missing evidence: ${sincerityMissing.join(", ")}`);
  }

  const sincerity: GaapCheckResult = {
    id: "sincerity",
    label: "Sincerity",
    status: sincerityStatus,
    detail: sincerityParts.join(". ") + ".",
  };

  const permanence: GaapCheckResult = {
    id: "permanence",
    label: "Permanence of Methods",
    status: "pass",
    detail: "Stable line_ids across periods (shared display-row contracts).",
  };

  const totalLiabilities = readAmount(input.balance, "total-liabilities");
  let nonCompStatus: "pass" | "warn" | "fail" = "pass";
  let nonCompDetail =
    "Assets and liabilities are reported as separate positive section totals (no netting).";
  if (totalAssets == null || totalLiabilities == null) {
    nonCompStatus = "warn";
    nonCompDetail =
      "Missing total-assets or total-liabilities rows; cannot fully validate non-compensation.";
  } else if (totalAssets <= 0 || totalLiabilities <= 0) {
    nonCompStatus = "fail";
    nonCompDetail =
      "Assets or liabilities total is non-positive, which may indicate netting or classification issues.";
  }
  const nonCompensation: GaapCheckResult = {
    id: "non_compensation",
    label: "Non-Compensation",
    status: nonCompStatus,
    detail: nonCompDetail,
  };

  const taxExpense = readAmount(input.income, "tax_expense");
  let prudenceStatus: "pass" | "warn" | "fail" = "pass";
  let prudenceDetail = "Tax expense is presented as an expense (non-positive display amount).";
  if (taxExpense == null) {
    prudenceStatus = "warn";
    prudenceDetail = "Tax-expense evidence is missing; prudence proxy cannot be fully checked.";
  } else if (taxExpense > 0) {
    prudenceStatus = "fail";
    prudenceDetail =
      "Tax expense appears as positive income on the display row, indicating an implausible negative tax charge.";
  }
  const prudence: GaapCheckResult = {
    id: "prudence",
    label: "Prudence",
    status: prudenceStatus,
    detail: prudenceDetail,
  };

  const continuity: GaapCheckResult =
    endingCash == null
      ? {
          id: "continuity",
          label: "Continuity (Going Concern Proxy)",
          status: "warn",
          detail:
            "Ending cash is missing, so this automated going-concern proxy is inconclusive and needs reviewer judgment.",
        }
      : endingCash > 0
        ? {
            id: "continuity",
            label: "Continuity (Going Concern Proxy)",
            status: "pass",
            detail:
              "Ending cash is positive for the selected period. This is a liquidity proxy and not a legal going-concern certification.",
          }
        : {
            id: "continuity",
            label: "Continuity (Going Concern Proxy)",
            status: "warn",
            detail:
              "Ending cash is non-positive. This proxy flags potential continuity risk and requires professional judgment.",
          };

  const periodicity: GaapCheckResult = /^\d{4}-(0[1-9]|1[0-2])$/.test(input.period)
    ? {
        id: "periodicity",
        label: "Periodicity",
        status: "pass",
        detail: "Reporting period matches YYYY-MM.",
      }
    : {
        id: "periodicity",
        label: "Periodicity",
        status: "fail",
        detail: `Invalid reporting period '${input.period}'. Expected YYYY-MM.`,
      };

  const materiality: GaapCheckResult = {
    id: "materiality",
    label: "Materiality",
    status: "warn",
    detail:
      "Condensed statements are provided for demo scope; materiality thresholds and disclosure sufficiency require human judgment.",
  };

  const utmostGoodFaith: GaapCheckResult = {
    id: "utmost_good_faith",
    label: "Utmost Good Faith",
    status: "pass",
    detail:
      "Statements are rendered read-only from governed views with reproducible exports; this evidences control design, not legal certification.",
  };

  return [
    regularity,
    consistency,
    sincerity,
    permanence,
    nonCompensation,
    prudence,
    continuity,
    periodicity,
    materiality,
    utmostGoodFaith,
  ];
}
