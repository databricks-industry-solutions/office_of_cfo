export interface StatementNote {
  id: string;
  title: string;
  body: string;
}

export const DEFAULT_STATEMENT_NOTES: StatementNote[] = [
  {
    id: "accounting_policies",
    title: "Accounting Policies",
    body:
      "These demo statements are prepared on an accrual basis in USD and aligned to monthly close periods, " +
      "and are presented on a going concern basis. " +
      "Recognition and presentation are modeled consistently by period to support deterministic controls and reproducible exports.",
  },
  {
    id: "segmental_analysis",
    title: "Segmental Analysis",
    body:
      "Results are presented on a consolidated basis and can be reviewed by management scope " +
      "(region, legal entity, and business unit) using the scope controls in this application.",
  },
  {
    id: "taxation",
    title: "Taxation",
    body:
      "Income tax expense is modeled at a statutory-rate proxy over profit before tax. " +
      "Taxes payable is presented separately on the Balance Sheet when applicable " +
      "(for example as liabilities_current-taxes_payable) to preserve gross presentation.",
  },
  {
    id: "going_concern",
    title: "Going Concern",
    body:
      "Liquidity is monitored using forecasted cash headroom and observed ending-cash outcomes in each reporting period. " +
      "This is a demo control narrative and should be complemented by management judgment for formal external reporting.",
  },
];

export function resolveStatementNotes(overrideNotes?: StatementNote[]): StatementNote[] {
  if (overrideNotes && overrideNotes.length > 0) {
    return overrideNotes.map((note) => ({ ...note }));
  }
  return DEFAULT_STATEMENT_NOTES.map((note) => ({ ...note }));
}
