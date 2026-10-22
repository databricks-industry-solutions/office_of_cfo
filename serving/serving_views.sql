-- Milestone 3 — real-time trial balance, DQ badge, variance, KPIs, metric view.
-- Served as VIEWS over the governed close tables: they recompute on read, so an
-- adjustment posted by the app (Act 4) flows into the trial balance immediately
-- (the "real-time" trial balance). In production this serving layer is
-- Lakehouse//RT; on serverless DBSQL these views are RT-compatible and low-latency.

-- System of record for app-posted adjustments (synced from Lakebase). The app
-- appends here; the trial balance reads it live.
CREATE TABLE IF NOT EXISTS {{close}}.posted_adjustments (
  adjustment_id   STRING,
  period          STRING,
  account_code    STRING,
  business_unit_id STRING,
  dr_cr           STRING,
  amount          DECIMAL(18,2),
  memo            STRING,
  posted_by       STRING,
  posted_ts       TIMESTAMP,
  source          STRING,
  -- Approval provenance: 'manual' (Accountant -> Controller -> CFO) or 'auto'
  -- (approved by the Controller's policy), with the policy version in force. Lets
  -- the audit trace name the policy that approved a figure, not just the entry.
  approval_mode   STRING,
  policy_version  INT
)
COMMENT 'Journal adjustments posted from the reconciliation app (Act 4), synced from Lakebase. Flows into the real-time trial balance.';

-- All postings that move the trial balance: GL + app-posted adjustments.
-- GL carries the business_line tag; adjustments are labelled 'Unassigned'.
-- origin 'Settlement' marks the GL cash legs (receipts, payments) so the
-- subledger-to-GL recons can compare invoice postings only.
CREATE OR REPLACE VIEW {{serving}}.v_postings AS
SELECT period, account_code, business_unit_id, business_line, dr_cr, amount,
       CASE WHEN posted_by = 'treasury.settlement' THEN 'Settlement' ELSE 'GL' END AS origin
FROM {{close}}.gl_journal_entries
UNION ALL
SELECT period, account_code, business_unit_id, CAST('Unassigned' AS STRING) AS business_line,
       dr_cr, amount, 'Adjustment' AS origin
FROM {{close}}.posted_adjustments;

-- Account balances by org node x business line (signed to each account's natural
-- balance). This is the segmentation grain for the hierarchy (region -> country
-- -> legal entity -> business unit, crossed with business line).
CREATE OR REPLACE VIEW {{serving}}.account_balance_by_bu AS
SELECT
  p.period,
  p.account_code,
  c.account_name,
  c.account_type,
  c.statement,
  c.normal_balance,
  c.fs_line,
  c.account_group,
  p.business_unit_id,
  o.business_unit_name,
  o.region,
  o.country,
  o.legal_entity_id,
  o.legal_entity_name,
  p.business_line,
  SUM(CASE WHEN p.dr_cr = 'D' THEN p.amount ELSE 0 END) AS total_debits,
  SUM(CASE WHEN p.dr_cr = 'C' THEN p.amount ELSE 0 END) AS total_credits,
  SUM(CASE WHEN p.dr_cr = c.normal_balance THEN p.amount ELSE -p.amount END) AS balance
FROM {{serving}}.v_postings p
JOIN {{close}}.chart_of_accounts c ON p.account_code = c.account_code
LEFT JOIN {{close}}.dim_org o ON p.business_unit_id = o.business_unit_id
GROUP BY ALL;

-- Cumulative ("as of") account balances: for each period, the running total of
-- activity through that period per (account x org node x business line). Balance-
-- sheet accounts are cumulative by nature (a position, not a flow), so the
-- period-aware Balance Sheet reads this view: selecting period P shows the
-- position as of the end of P. P&L views keep using the period-only
-- account_balance_by_bu (income statement / trial balance are month activity).
-- Densify account/org/business-line keys across the canonical available periods
-- before the cumulative window so one-time BS postings (e.g. opening equity)
-- persist in later months instead of disappearing when sparse.
CREATE OR REPLACE VIEW {{serving}}.account_balance_asof AS
WITH keys AS (
  SELECT DISTINCT
    account_code,
    account_name,
    account_type,
    statement,
    normal_balance,
    fs_line,
    account_group,
    business_unit_id,
    business_unit_name,
    region,
    country,
    legal_entity_id,
    legal_entity_name,
    business_line
  FROM {{serving}}.account_balance_by_bu
),
periods AS (
  SELECT DISTINCT period
  FROM {{serving}}.account_balance_by_bu
),
dense AS (
  SELECT
    p.period,
    k.account_code,
    k.account_name,
    k.account_type,
    k.statement,
    k.normal_balance,
    k.fs_line,
    k.account_group,
    k.business_unit_id,
    k.business_unit_name,
    k.region,
    k.country,
    k.legal_entity_id,
    k.legal_entity_name,
    k.business_line,
    COALESCE(a.total_debits, 0) AS total_debits,
    COALESCE(a.total_credits, 0) AS total_credits,
    COALESCE(a.balance, 0) AS balance
  FROM keys k
  CROSS JOIN periods p
  LEFT JOIN {{serving}}.account_balance_by_bu a
    ON a.period = p.period
   AND a.account_code = k.account_code
   AND a.business_unit_id = k.business_unit_id
   AND a.business_line <=> k.business_line
)
SELECT
  period,
  account_code,
  account_name,
  account_type,
  statement,
  normal_balance,
  fs_line,
  account_group,
  business_unit_id,
  business_unit_name,
  region,
  country,
  legal_entity_id,
  legal_entity_name,
  business_line,
  SUM(total_debits)  OVER w AS total_debits,
  SUM(total_credits) OVER w AS total_credits,
  SUM(balance)       OVER w AS balance,
  total_debits  AS period_debits,
  total_credits AS period_credits,
  balance       AS period_balance
FROM dense
WINDOW w AS (
  PARTITION BY account_code, business_unit_id, business_line
  ORDER BY period
  ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
);

-- The trial balance: one row per account, presented with debit/credit columns.
CREATE OR REPLACE VIEW {{serving}}.trial_balance AS
SELECT
  period,
  account_code,
  account_name,
  account_type,
  statement,
  fs_line,
  account_group,
  normal_balance,
  SUM(total_debits)  AS total_debits,
  SUM(total_credits) AS total_credits,
  SUM(balance)       AS balance,
  CASE WHEN normal_balance = 'D' THEN SUM(balance) ELSE 0 END AS debit_balance,
  CASE WHEN normal_balance = 'C' THEN SUM(balance) ELSE 0 END AS credit_balance
FROM {{serving}}.account_balance_by_bu
GROUP BY period, account_code, account_name, account_type, statement, fs_line, account_group, normal_balance;

-- Segmented trial balance: one row per account x org node x business line, so
-- the app can filter by any scope (region / legal entity / BU / business line)
-- and roll up by account group.
CREATE OR REPLACE VIEW {{serving}}.trial_balance_by_org AS
SELECT
  period,
  business_unit_id,
  business_unit_name,
  region,
  country,
  legal_entity_id,
  legal_entity_name,
  business_line,
  account_code,
  account_name,
  account_type,
  statement,
  fs_line,
  account_group,
  normal_balance,
  total_debits,
  total_credits,
  balance,
  CASE WHEN normal_balance = 'D' THEN balance ELSE 0 END AS debit_balance,
  CASE WHEN normal_balance = 'C' THEN balance ELSE 0 END AS credit_balance
FROM {{serving}}.account_balance_by_bu;

-- The trial balance carrying the live close DQ badge -- the live number is also
-- a trusted number (Act 3).
CREATE OR REPLACE VIEW {{serving}}.trial_balance_dq AS
SELECT t.*, s.close_status, s.badge, s.fail_count, s.warn_count, s.total_checks
FROM {{serving}}.trial_balance t
CROSS JOIN {{ops}}.dq_summary s;

-- Working-capital KPI components per org node x business line. The components
-- (AR / AP / Inventory balances, Revenue, COGS) are ADDITIVE, so any scope can
-- SUM them and then compute the ratios DSO/DPO/DIO/CCC (which are not additive).
CREATE OR REPLACE VIEW {{serving}}.working_capital_kpis AS
-- AR / AP are month-end balances (the GL posts receipts and payments, so they
-- clear); inventory and the P&L lines are the month's own activity.
SELECT
  period,
  business_unit_id,
  business_unit_name,
  region,
  country,
  legal_entity_id,
  legal_entity_name,
  business_line,
  DAY(LAST_DAY(TO_DATE(CONCAT(period, '-01')))) AS days_in_period,
  SUM(ar_balance) AS ar_balance,
  SUM(ap_balance) AS ap_balance,
  SUM(inventory_balance) AS inventory_balance,
  SUM(revenue) AS revenue,
  SUM(cogs) AS cogs,
  SUM(operating_expense) AS operating_expense
FROM (
  SELECT period, business_unit_id, business_unit_name, region, country,
         legal_entity_id, legal_entity_name, business_line,
         0 AS ar_balance,
         0 AS ap_balance,
         CASE WHEN account_code = '12000' THEN balance ELSE 0 END AS inventory_balance,
         CASE WHEN account_type = 'Revenue' THEN balance ELSE 0 END AS revenue,
         CASE WHEN account_code = '50000' THEN balance ELSE 0 END AS cogs,
         CASE WHEN account_code IN ('60000','61000','62000','63000','64000','65000','66000','67000','68000')
              THEN balance ELSE 0 END AS operating_expense
  FROM {{serving}}.account_balance_by_bu
  UNION ALL
  SELECT period, business_unit_id, business_unit_name, region, country,
         legal_entity_id, legal_entity_name, business_line,
         CASE WHEN account_code = '11000' THEN balance ELSE 0 END,
         CASE WHEN account_code = '20000' THEN balance ELSE 0 END,
         0, 0, 0, 0
  FROM {{serving}}.account_balance_asof
  WHERE account_code IN ('11000', '20000')
) wc
GROUP BY period, business_unit_id, business_unit_name, region, country,
         legal_entity_id, legal_entity_name, business_line;

-- Cash-flow reconciliation per org node. The flows (collections, disbursements,
-- capex) and the balances (beginning / ending cash) are ADDITIVE across BUs, so
-- any scope (region / legal entity / consolidated) can SUM the rows and the
-- statement still reconciles: ending = beginning + collections - disbursements - capex.
CREATE OR REPLACE VIEW {{serving}}.cash_flow AS
SELECT
  cf.period,
  cf.business_unit_id,
  o.business_unit_name,
  o.region,
  o.country,
  o.legal_entity_id,
  o.legal_entity_name,
  cf.beginning_cash,
  cf.collections,
  cf.operating_disbursements,
  cf.capex,
  cf.ending_cash
FROM {{close}}.cash_flow cf
LEFT JOIN {{close}}.dim_org o ON cf.business_unit_id = o.business_unit_id;

-- Trailing monthly KPI snapshots (direction of travel) — passthrough of the
-- governed kpi_history table for the serving API.
CREATE OR REPLACE VIEW {{serving}}.kpi_history AS
SELECT period, scope_type, scope_id, scope_label, dso, dpo, dio, ccc,
       revenue, opex, net_income
FROM {{close}}.kpi_history;

-- Operating-expense variance to forecast by account x business unit (Act 5 Genie).
CREATE OR REPLACE VIEW {{serving}}.opex_variance AS
WITH actual AS (
  SELECT period, account_code, account_name, business_unit_id, business_unit_name, region,
         SUM(balance) AS actual_amount
  FROM {{serving}}.account_balance_by_bu
  WHERE account_code IN ('60000','61000','62000','63000','64000','65000','66000','67000','68000')
  GROUP BY period, account_code, account_name, business_unit_id, business_unit_name, region
)
SELECT
  a.period,
  a.account_code,
  a.account_name,
  a.business_unit_id,
  a.business_unit_name,
  a.region,
  a.actual_amount,
  f.forecast_amount,
  a.actual_amount - f.forecast_amount AS variance,
  ROUND((a.actual_amount - f.forecast_amount) / NULLIF(f.forecast_amount, 0) * 100, 1) AS variance_pct,
  CASE WHEN a.actual_amount > f.forecast_amount THEN 'Unfavorable (over forecast)' ELSE 'Favorable' END AS variance_direction
FROM actual a
LEFT JOIN {{close}}.budget_forecast f
  ON a.account_code = f.account_code AND a.business_unit_id = f.business_unit_id
 AND a.period = f.period;

-- LIVE reconciliation breaks: recomputed including app-posted adjustments, so a
-- break clears in real time the moment an accountant posts a correcting entry in
-- the app (Act 4). Covers AP / AR / Payroll (subledger-to-GL) plus Inventory and
-- Bank controls introduced with the expanded source systems.
CREATE OR REPLACE VIEW {{serving}}.recon_breaks_live AS
WITH control AS (
  SELECT * FROM (VALUES
    ('20000','Accounts Payable','subledger_ap','C'),
    ('11000','Accounts Receivable','subledger_ar','D'),
    ('22000','Payroll Liabilities','subledger_payroll','C'),
    ('12000','Inventory','subledger_inventory','D'),
    ('10100','Cash and Cash Equivalents','subledger_bank','D')
  ) AS t(control_account_code, account_name, subledger, normal_balance)
),
gl_bal AS (
  SELECT account_code, business_unit_id,
    SUM(CASE WHEN dr_cr = 'D' THEN amount ELSE 0 END) AS d,
    SUM(CASE WHEN dr_cr = 'C' THEN amount ELSE 0 END) AS c
  FROM {{serving}}.v_postings
  WHERE account_code IN ('20000','11000','22000','12000','10100')
    -- Cash legs settle invoices; the subledgers list invoices, so skip them
    -- except on cash itself (the bank statement is a running balance).
    AND (origin <> 'Settlement' OR account_code = '10100')
  GROUP BY account_code, business_unit_id
),
sub AS (
  SELECT '20000' AS control_account_code, business_unit_id, SUM(amount) AS subledger_total
    FROM {{close}}.subledger_ap GROUP BY business_unit_id
  UNION ALL
  SELECT '11000', business_unit_id, SUM(amount)
    FROM {{close}}.subledger_ar GROUP BY business_unit_id
  UNION ALL
  SELECT '22000', business_unit_id, SUM(amount)
    FROM {{close}}.subledger_payroll GROUP BY business_unit_id
  UNION ALL
  SELECT '12000', business_unit_id, SUM(inventory_value)
    FROM {{close}}.subledger_inventory GROUP BY business_unit_id
  UNION ALL
  SELECT '10100', business_unit_id, SUM(closing_balance)
    FROM {{close}}.subledger_bank
   WHERE period = (SELECT MAX(period) FROM {{close}}.subledger_bank)
   GROUP BY business_unit_id
)
SELECT
  ctl.control_account_code,
  ctl.account_name,
  ctl.subledger,
  s.business_unit_id,
  o.business_unit_name,
  o.region,
  o.legal_entity_id,
  ROUND(s.subledger_total, 2) AS subledger_total,
  ROUND(CASE WHEN ctl.normal_balance = 'C' THEN COALESCE(g.c,0) - COALESCE(g.d,0)
             ELSE COALESCE(g.d,0) - COALESCE(g.c,0) END, 2) AS gl_balance,
  ROUND(s.subledger_total - (CASE WHEN ctl.normal_balance = 'C' THEN COALESCE(g.c,0) - COALESCE(g.d,0)
             ELSE COALESCE(g.d,0) - COALESCE(g.c,0) END), 2) AS variance,
  ROUND(ABS(s.subledger_total - (CASE WHEN ctl.normal_balance = 'C' THEN COALESCE(g.c,0) - COALESCE(g.d,0)
             ELSE COALESCE(g.d,0) - COALESCE(g.c,0) END)), 2) AS abs_variance,
  ABS(s.subledger_total - (CASE WHEN ctl.normal_balance = 'C' THEN COALESCE(g.c,0) - COALESCE(g.d,0)
             ELSE COALESCE(g.d,0) - COALESCE(g.c,0) END)) > 1.0 AS is_break
FROM sub s
JOIN control ctl ON s.control_account_code = ctl.control_account_code
LEFT JOIN gl_bal g ON g.account_code = s.control_account_code AND g.business_unit_id = s.business_unit_id
LEFT JOIN {{close}}.dim_org o ON s.business_unit_id = o.business_unit_id;

-- Governed metric view (Unity Catalog) for Genie + dashboards.
CREATE OR REPLACE VIEW {{serving}}.close_metrics
WITH METRICS
LANGUAGE YAML
AS $$
version: 1.1
comment: "Governed month-end close KPIs (trial balance, OpEx, revenue, working-capital) for Genie and dashboards."
source: {{serving}}.account_balance_asof
dimensions:
  - name: Period
    expr: period
  - name: Account Code
    expr: account_code
  - name: Account Name
    expr: account_name
  - name: Account Type
    expr: account_type
  - name: Statement
    expr: statement
  - name: FS Line
    expr: fs_line
  - name: Account Group
    expr: account_group
  - name: Business Unit
    expr: business_unit_name
  - name: Region
    expr: region
  - name: Country
    expr: country
  - name: Legal Entity
    expr: legal_entity_name
  - name: Business Line
    expr: business_line
measures:
  - name: Balance
    expr: SUM(period_balance)
    comment: "The period's net activity in the account's natural sign"
  - name: Total Debits
    expr: SUM(period_debits)
  - name: Total Credits
    expr: SUM(period_credits)
  - name: Operating Expense
    expr: SUM(CASE WHEN account_code IN ('60000','61000','62000','63000','64000','65000','66000','67000','68000') THEN period_balance ELSE 0 END)
    comment: "Total operating expense"
  - name: Revenue
    expr: SUM(CASE WHEN account_type = 'Revenue' THEN period_balance ELSE 0 END)
  - name: Net Income
    expr: SUM(CASE WHEN account_type = 'Revenue' THEN period_balance WHEN account_type = 'Expense' THEN -period_balance ELSE 0 END)
    comment: "Revenue minus expense"
  - name: AR Balance
    expr: SUM(CASE WHEN account_code = '11000' THEN balance ELSE 0 END)
    comment: "Accounts receivable at period end"
  - name: AP Balance
    expr: SUM(CASE WHEN account_code = '20000' THEN balance ELSE 0 END)
    comment: "Accounts payable at period end"
  - name: Inventory Balance
    expr: SUM(CASE WHEN account_code = '12000' THEN period_balance ELSE 0 END)
  - name: COGS
    expr: SUM(CASE WHEN account_code = '50000' THEN period_balance ELSE 0 END)
  - name: Days Sales Outstanding
    expr: SUM(CASE WHEN account_code = '11000' THEN balance ELSE 0 END) / NULLIF(SUM(CASE WHEN account_type = 'Revenue' THEN period_balance ELSE 0 END), 0) * 30
    comment: "DSO = period-end AR / Revenue x days-in-period"
  - name: Days Payable Outstanding
    expr: SUM(CASE WHEN account_code = '20000' THEN balance ELSE 0 END) / NULLIF(SUM(CASE WHEN account_code = '50000' THEN period_balance ELSE 0 END), 0) * 30
    comment: "DPO = period-end AP / COGS x days-in-period"
  - name: Days Inventory Outstanding
    expr: SUM(CASE WHEN account_code = '12000' THEN period_balance ELSE 0 END) / NULLIF(SUM(CASE WHEN account_code = '50000' THEN period_balance ELSE 0 END), 0) * 30
    comment: "DIO = Inventory / COGS x days-in-period"
  - name: Cash Conversion Cycle
    expr: (SUM(CASE WHEN account_code = '11000' THEN balance ELSE 0 END) / NULLIF(SUM(CASE WHEN account_type = 'Revenue' THEN period_balance ELSE 0 END), 0) * 30) + (SUM(CASE WHEN account_code = '12000' THEN period_balance ELSE 0 END) / NULLIF(SUM(CASE WHEN account_code = '50000' THEN period_balance ELSE 0 END), 0) * 30) - (SUM(CASE WHEN account_code = '20000' THEN balance ELSE 0 END) / NULLIF(SUM(CASE WHEN account_code = '50000' THEN period_balance ELSE 0 END), 0) * 30)
    comment: "CCC = DSO + DIO - DPO (days)"
$$;

-- ===========================================================================
-- Standard financial statements (Income Statement / Balance Sheet / Cash Flow).
-- All three are additive at the org x business-line grain and carry the scope
-- columns (region / legal_entity_id / business_unit_id / business_line), so the
-- API can SUM(amount) within any scope and GROUP BY line. Line ids are stable so
-- the frontend Overlay can relabel per industry (e.g. bank-style presentation).
-- ===========================================================================

-- Income Statement: raw P&L line categories (revenue / cogs / opex) as positive
-- magnitudes. Subtotals (gross profit, operating income, net income) are derived
-- downstream from these additive lines.
CREATE OR REPLACE VIEW {{serving}}.income_statement AS
SELECT
  period,
  business_unit_id,
  business_unit_name,
  region,
  country,
  legal_entity_id,
  legal_entity_name,
  business_line,
  CASE
    WHEN account_type = 'Revenue' AND account_code NOT IN ('70000') THEN 'revenue'
    WHEN account_code = '50000' THEN 'cogs'
    WHEN account_code = '70000' THEN 'interest_income'
    WHEN account_code = '71000' THEN 'interest_expense'
    WHEN account_code = '80000' THEN 'tax_expense'
    ELSE 'opex'
  END AS line_id,
  CASE
    WHEN account_type = 'Revenue' AND account_code NOT IN ('70000') THEN 'Revenue'
    WHEN account_code = '50000' THEN 'Cost of Goods Sold'
    WHEN account_code = '70000' THEN 'Interest Income'
    WHEN account_code = '71000' THEN 'Interest Expense'
    WHEN account_code = '80000' THEN 'Tax Expense'
    ELSE 'Operating Expenses'
  END AS line_label,
  CASE
    WHEN account_type = 'Revenue' AND account_code NOT IN ('70000') THEN 1
    WHEN account_code = '50000' THEN 2
    WHEN account_code = '70000' THEN 6
    WHEN account_code = '71000' THEN 7
    WHEN account_code = '80000' THEN 9
    ELSE 4
  END AS sort_order,
  SUM(
    CASE
      WHEN account_code = '70000' THEN total_credits - total_debits
      WHEN account_code IN ('50000', '71000', '80000') THEN total_debits - total_credits
      WHEN account_type = 'Revenue' THEN total_credits - total_debits
      ELSE total_debits - total_credits
    END
  ) AS amount
FROM {{serving}}.account_balance_by_bu
WHERE statement = 'IS'
GROUP BY ALL;

-- Balance Sheet: assets presented debit-positive, liabilities & equity
-- credit-positive, grouped by account group. Reads the CUMULATIVE (as-of)
-- balances so selecting a period shows the position through that period. Earnings
-- through the period (Revenue - Expense, cumulative, not yet closed to retained
-- earnings) are added as current_earnings. Real Common Stock / Retained Earnings
-- postings (densified in account_balance_asof) carry the equity position.
CREATE OR REPLACE VIEW {{serving}}.balance_sheet AS
SELECT
  period,
  business_unit_id,
  business_unit_name,
  region,
  country,
  legal_entity_id,
  legal_entity_name,
  business_line,
  section,
  line_id,
  line_label,
  CASE line_id
    WHEN 'cash' THEN 1 WHEN 'receivables' THEN 2 WHEN 'inventory' THEN 3
    WHEN 'other_current_assets' THEN 4 WHEN 'ppe' THEN 5
    WHEN 'payables' THEN 11 WHEN 'accrued_liabilities' THEN 12
    WHEN 'taxes_payable' THEN 13 WHEN 'intercompany' THEN 14
    WHEN 'common_stock' THEN 21 WHEN 'retained_earnings' THEN 22 WHEN 'current_earnings' THEN 23
    ELSE 99 END AS sort_order,
  SUM(amount) AS amount
FROM (
  SELECT
    period, business_unit_id, business_unit_name, region, country,
    legal_entity_id, legal_entity_name, business_line,
    CASE
      WHEN account_group IN ('Cash & Bank', 'Receivables', 'Inventory', 'Other Current Assets') THEN 'assets_current'
      WHEN account_group = 'Property, Plant & Equipment' THEN 'assets_noncurrent'
      WHEN account_group IN ('Payables', 'Accrued Liabilities', 'Taxes Payable', 'Intercompany') THEN 'liabilities_current'
      ELSE 'equity'
    END AS section,
    CASE account_group
      WHEN 'Cash & Bank' THEN 'cash'
      WHEN 'Receivables' THEN 'receivables'
      WHEN 'Inventory' THEN 'inventory'
      WHEN 'Other Current Assets' THEN 'other_current_assets'
      WHEN 'Property, Plant & Equipment' THEN 'ppe'
      WHEN 'Payables' THEN 'payables'
      WHEN 'Accrued Liabilities' THEN 'accrued_liabilities'
      WHEN 'Taxes Payable' THEN 'taxes_payable'
      WHEN 'Intercompany' THEN 'intercompany'
      WHEN 'Equity' THEN CASE
        WHEN account_code = '30000' THEN 'common_stock'
        WHEN account_code = '31000' THEN 'retained_earnings'
        ELSE 'equity_other'
      END
      ELSE 'other'
    END AS line_id,
    CASE
      WHEN account_code = '30000' THEN 'Common Stock'
      WHEN account_code = '31000' THEN 'Retained Earnings'
      ELSE account_group
    END AS line_label,
    CASE WHEN account_type = 'Asset' THEN total_debits - total_credits
         ELSE total_credits - total_debits END AS amount
  FROM {{serving}}.account_balance_asof
  WHERE statement = 'BS'
  UNION ALL
  SELECT
    period, business_unit_id, business_unit_name, region, country,
    legal_entity_id, legal_entity_name, business_line,
    'equity' AS section, 'current_earnings' AS line_id, 'Earnings Through Period' AS line_label,
    SUM(total_credits - total_debits) AS amount
  FROM {{serving}}.account_balance_asof
  WHERE statement = 'IS'
  GROUP BY period, business_unit_id, business_unit_name, region, country,
           legal_entity_id, legal_entity_name, business_line
)
GROUP BY ALL;

-- Cash Flow (indirect method), per business unit. Operating cash equals the
-- modeled operating cash (collections - disbursements) presented indirect-style
-- (net income + depreciation add-back + a working-capital change balancing line);
-- investing is capex; financing is the balancing line that ties Ending Cash to
-- the Balance Sheet cash accounts (10100/10200). By construction Ending Cash =
-- Beginning Cash + net change = the Balance Sheet cash line.
CREATE OR REPLACE VIEW {{serving}}.cash_flow_statement AS
WITH bu_pl AS (
  SELECT period, business_unit_id,
    SUM(CASE WHEN statement = 'IS' THEN total_credits - total_debits ELSE 0 END) AS net_income,
    SUM(CASE WHEN account_code = '65000' THEN total_debits - total_credits ELSE 0 END) AS depreciation
  FROM {{serving}}.account_balance_by_bu
  GROUP BY period, business_unit_id
),
bu_cash AS (
  SELECT
    period,
    business_unit_id,
    SUM(CASE WHEN account_code IN ('10100', '10200') THEN total_debits - total_credits ELSE 0 END) AS ending_cash
  FROM {{serving}}.account_balance_asof
  GROUP BY period, business_unit_id
),
bu AS (
  SELECT
    p.period, p.business_unit_id, o.business_unit_name, o.region, o.country,
    o.legal_entity_id, o.legal_entity_name,
    p.net_income, p.depreciation,
    COALESCE(c.beginning_cash, 0) AS beginning_cash,
    COALESCE(c.collections, 0) AS collections,
    COALESCE(c.operating_disbursements, 0) AS operating_disbursements,
    COALESCE(c.capex, 0) AS capex,
    COALESCE(c.dividends_paid, 0) AS dividends_paid,
    COALESCE(bc.ending_cash, 0) AS ending_cash
  FROM bu_pl p
  LEFT JOIN {{close}}.cash_flow c
    ON p.period = c.period AND p.business_unit_id = c.business_unit_id
  LEFT JOIN bu_cash bc
    ON p.period = bc.period AND p.business_unit_id = bc.business_unit_id
  LEFT JOIN {{close}}.dim_org o ON p.business_unit_id = o.business_unit_id
)
SELECT period, business_unit_id, business_unit_name, region, country,
       legal_entity_id, legal_entity_name, section, line_id, line_label, sort_order, amount
FROM (
  SELECT bu.*, 'operating' AS section, 'net_income' AS line_id,
         'Net Income' AS line_label, 1 AS sort_order, net_income AS amount FROM bu
  UNION ALL
  SELECT bu.*, 'operating', 'depreciation', 'Depreciation & Amortization', 2, depreciation FROM bu
  UNION ALL
  SELECT bu.*, 'operating', 'wc_change', 'Changes in Working Capital', 3,
         (collections - operating_disbursements) - net_income - depreciation FROM bu
  UNION ALL
  SELECT bu.*, 'investing', 'capex', 'Capital Expenditures', 11, -capex FROM bu
  UNION ALL
  SELECT bu.*, 'financing', 'dividends_paid', 'Dividends Paid', 21, -dividends_paid FROM bu
  UNION ALL
  SELECT bu.*, 'financing', 'financing_other', 'Financing & Other', 22,
         ending_cash - beginning_cash - (collections - operating_disbursements) - (-capex) - (-dividends_paid) FROM bu
  UNION ALL
  SELECT bu.*, 'summary', 'beginning_cash', 'Beginning Cash', 31, beginning_cash FROM bu
  UNION ALL
  SELECT bu.*, 'summary', 'ending_cash', 'Ending Cash', 32, ending_cash FROM bu
);

-- Equity statement rollforward by equity class. Dividends are presented as
-- negative in statement rows so the identity is additive:
-- ending = beginning + net_income + dividends.
-- Retained Earnings class = posted RE + unclosed cumulative IS earnings.
-- Prior amounts use an explicit prior calendar month (not LAG over available rows).
CREATE OR REPLACE VIEW {{serving}}.equity_statement AS
WITH org_period AS (
  SELECT DISTINCT
    period,
    business_unit_id,
    business_unit_name,
    region,
    country,
    legal_entity_id,
    legal_entity_name
  FROM {{serving}}.account_balance_asof
),
available_periods AS (
  SELECT DISTINCT period FROM {{serving}}.account_balance_asof
),
cs_asof AS (
  SELECT
    period,
    business_unit_id,
    SUM(CASE WHEN account_code = '30000' THEN total_credits - total_debits ELSE 0 END) AS common_stock
  FROM {{serving}}.account_balance_asof
  GROUP BY period, business_unit_id
),
re_asof AS (
  SELECT
    period,
    business_unit_id,
    SUM(CASE WHEN account_code = '31000' THEN total_credits - total_debits ELSE 0 END) AS retained_earnings
  FROM {{serving}}.account_balance_asof
  GROUP BY period, business_unit_id
),
cum_is AS (
  SELECT
    period,
    business_unit_id,
    SUM(CASE WHEN statement = 'IS' THEN total_credits - total_debits ELSE 0 END) AS cum_net_income
  FROM {{serving}}.account_balance_asof
  GROUP BY period, business_unit_id
),
period_ni AS (
  SELECT
    period,
    business_unit_id,
    SUM(total_credits - total_debits) AS net_income
  FROM {{serving}}.account_balance_by_bu
  WHERE statement = 'IS'
  GROUP BY period, business_unit_id
),
dividends AS (
  SELECT
    period,
    business_unit_id,
    -SUM(COALESCE(dividends_paid, 0)) AS dividends
  FROM {{close}}.cash_flow
  GROUP BY period, business_unit_id
),
base AS (
  SELECT
    p.period,
    p.business_unit_id,
    p.business_unit_name,
    p.region,
    p.country,
    p.legal_entity_id,
    p.legal_entity_name,
    DATE_FORMAT(ADD_MONTHS(TO_DATE(CONCAT(p.period, '-01')), -1), 'yyyy-MM') AS prior_period,
    COALESCE(c.common_stock, 0) AS cs_ending,
    COALESCE(r.retained_earnings, 0) AS re_asof,
    COALESCE(i.cum_net_income, 0) AS cum_is,
    COALESCE(n.net_income, 0) AS net_income,
    COALESCE(d.dividends, 0) AS dividends
  FROM org_period p
  LEFT JOIN cs_asof c
    ON p.period = c.period AND p.business_unit_id = c.business_unit_id
  LEFT JOIN re_asof r
    ON p.period = r.period AND p.business_unit_id = r.business_unit_id
  LEFT JOIN cum_is i
    ON p.period = i.period AND p.business_unit_id = i.business_unit_id
  LEFT JOIN period_ni n
    ON p.period = n.period AND p.business_unit_id = n.business_unit_id
  LEFT JOIN dividends d
    ON p.period = d.period AND p.business_unit_id = d.business_unit_id
),
rollforward AS (
  SELECT
    b.period,
    b.business_unit_id,
    b.business_unit_name,
    b.region,
    b.country,
    b.legal_entity_id,
    b.legal_entity_name,
    -- Common Stock: beginning = true prior-month as-of CS
    -- First available period uses the opening CS seed as beginning (= ending)
    CASE WHEN ap.period IS NULL THEN b.cs_ending ELSE COALESCE(pcs.common_stock, 0) END AS cs_beginning,
    CAST(0 AS DECIMAL(18,2)) AS cs_net_income,
    CAST(0 AS DECIMAL(18,2)) AS cs_dividends,
    b.cs_ending AS cs_ending,
    -- RE class = posted RE + unclosed cumulative earnings.
    CASE
      WHEN ap.period IS NULL THEN b.re_asof - b.dividends  -- recover opening RE before current dividends
      ELSE COALESCE(pre.retained_earnings, 0) + COALESCE(pci.cum_net_income, 0)
    END AS re_beginning,
    b.net_income AS re_net_income,
    b.dividends AS re_dividends
  FROM base b
  LEFT JOIN available_periods ap
    ON b.prior_period = ap.period
  LEFT JOIN cs_asof pcs
    ON b.prior_period = pcs.period AND b.business_unit_id = pcs.business_unit_id
  LEFT JOIN re_asof pre
    ON b.prior_period = pre.period AND b.business_unit_id = pre.business_unit_id
  LEFT JOIN cum_is pci
    ON b.prior_period = pci.period AND b.business_unit_id = pci.business_unit_id
),
rollforward_ending AS (
  SELECT
    period, business_unit_id, business_unit_name, region, country,
    legal_entity_id, legal_entity_name,
    cs_beginning, cs_net_income, cs_dividends, cs_ending,
    re_beginning, re_net_income, re_dividends,
    re_beginning + re_net_income + re_dividends AS re_ending
  FROM rollforward
),
classes AS (
  SELECT period, business_unit_id, business_unit_name, region, country,
         legal_entity_id, legal_entity_name, 'equity' AS section,
         'common_stock' AS equity_class, 'beginning' AS line_id,
         'Beginning Balance' AS line_label, 1 AS sort_order, cs_beginning AS amount
  FROM rollforward_ending
  UNION ALL
  SELECT period, business_unit_id, business_unit_name, region, country,
         legal_entity_id, legal_entity_name, 'equity',
         'common_stock', 'net_income', 'Net Income', 2, cs_net_income
  FROM rollforward_ending
  UNION ALL
  SELECT period, business_unit_id, business_unit_name, region, country,
         legal_entity_id, legal_entity_name, 'equity',
         'common_stock', 'dividends', 'Dividends', 3, cs_dividends
  FROM rollforward_ending
  UNION ALL
  SELECT period, business_unit_id, business_unit_name, region, country,
         legal_entity_id, legal_entity_name, 'equity',
         'common_stock', 'ending', 'Ending Balance', 4, cs_ending
  FROM rollforward_ending
  UNION ALL
  SELECT period, business_unit_id, business_unit_name, region, country,
         legal_entity_id, legal_entity_name, 'equity',
         'retained_earnings', 'beginning', 'Beginning Balance', 1, re_beginning
  FROM rollforward_ending
  UNION ALL
  SELECT period, business_unit_id, business_unit_name, region, country,
         legal_entity_id, legal_entity_name, 'equity',
         'retained_earnings', 'net_income', 'Net Income', 2, re_net_income
  FROM rollforward_ending
  UNION ALL
  SELECT period, business_unit_id, business_unit_name, region, country,
         legal_entity_id, legal_entity_name, 'equity',
         'retained_earnings', 'dividends', 'Dividends', 3, re_dividends
  FROM rollforward_ending
  UNION ALL
  SELECT period, business_unit_id, business_unit_name, region, country,
         legal_entity_id, legal_entity_name, 'equity',
         'retained_earnings', 'ending', 'Ending Balance', 4, re_ending
  FROM rollforward_ending
)
SELECT
  period,
  business_unit_id,
  business_unit_name,
  region,
  country,
  legal_entity_id,
  legal_entity_name,
  equity_class,
  section,
  line_id,
  line_label,
  sort_order,
  amount
FROM classes
UNION ALL
SELECT
  period,
  business_unit_id,
  business_unit_name,
  region,
  country,
  legal_entity_id,
  legal_entity_name,
  'total' AS equity_class,
  section,
  line_id,
  line_label,
  sort_order,
  SUM(amount) AS amount
FROM classes
GROUP BY period, business_unit_id, business_unit_name, region, country,
         legal_entity_id, legal_entity_name, section, line_id, line_label, sort_order;

-- Inventory exposure (balance-sheet / working-capital lens). Flags each SKU as
-- slow-moving (low turnover: period COGS < half of carried value) and/or
-- supplier-managed (vendor-/consignment-managed, deterministic by SKU so the
-- demo is stable). The two exposure lenses can overlap. Additive at the item
-- grain with scope columns so the API aggregates within any scope; total
-- inventory value ties to GL control account 12000.
CREATE OR REPLACE VIEW {{serving}}.inventory_exposure AS
SELECT
  i.period,
  i.business_unit_id,
  o.business_unit_name,
  o.region,
  o.country,
  o.legal_entity_id,
  o.legal_entity_name,
  i.business_line,
  i.sku,
  i.quantity_on_hand,
  i.inventory_value,
  i.cogs_amount,
  ROUND(i.cogs_amount / NULLIF(i.inventory_value, 0), 3) AS turnover_ratio,
  (i.inventory_value > 0 AND COALESCE(i.cogs_amount, 0) < i.inventory_value) AS is_slow_moving,
  (pmod(hash(i.sku), 10) < 3) AS is_supplier_managed
FROM {{close}}.subledger_inventory i
LEFT JOIN {{close}}.dim_org o ON i.business_unit_id = o.business_unit_id;

-- ===========================================================================
-- Historical Insights serving views (period picker + payment behaviour).
-- ===========================================================================

-- Distinct available periods (feeds the period picker + "how many months of
-- history do I have" checks). Ordered newest-first, with dim_date labels.
CREATE OR REPLACE VIEW {{serving}}.v_periods AS
SELECT
  d.period,
  d.period_key,
  d.year,
  d.month,
  d.quarter,
  d.month_label,
  d.days_in_period,
  d.is_active_close
FROM {{close}}.dim_date d
WHERE d.period IN (SELECT DISTINCT period FROM {{close}}.gl_journal_entries);

-- Counterparty payment behaviour at the INVOICE grain, unified across AR
-- (customer collections) and AP (our vendor payments). The serving API
-- aggregates this into the scorecard (baseline avg days-vs-terms, on-time %) and
-- the anomaly feed (deviation from a counterparty's own norm + overdue opens).
-- days_to_pay / days_vs_terms are NULL for invoices not yet paid (open/overdue).
CREATE OR REPLACE VIEW {{serving}}.v_payment_behavior AS
SELECT
  'ar' AS ledger,
  ar.invoice_id,
  ar.period,
  ar.customer_name AS counterparty,
  ar.business_unit_id,
  o.business_unit_name,
  o.region,
  o.country,
  o.legal_entity_id,
  o.legal_entity_name,
  ar.business_line,
  CAST(ar.amount AS DECIMAL(18,2)) AS amount,
  ar.payment_terms,
  ar.invoice_date,
  ar.due_date,
  ar.paid_date,
  DATEDIFF(ar.paid_date, ar.invoice_date) AS days_to_pay,
  DATEDIFF(ar.paid_date, ar.due_date)     AS days_vs_terms,
  CASE WHEN ar.paid_date IS NOT NULL THEN (DATEDIFF(ar.paid_date, ar.due_date) <= 0) END AS on_time,
  ar.status
FROM {{close}}.subledger_ar ar
LEFT JOIN {{close}}.dim_org o ON ar.business_unit_id = o.business_unit_id
UNION ALL
SELECT
  'ap' AS ledger,
  ap.invoice_id,
  ap.period,
  ap.vendor_name AS counterparty,
  ap.business_unit_id,
  o.business_unit_name,
  o.region,
  o.country,
  o.legal_entity_id,
  o.legal_entity_name,
  ap.business_line,
  CAST(ap.amount AS DECIMAL(18,2)) AS amount,
  ap.payment_terms,
  ap.invoice_date,
  ap.due_date,
  ap.paid_date,
  DATEDIFF(ap.paid_date, ap.invoice_date) AS days_to_pay,
  DATEDIFF(ap.paid_date, ap.due_date)     AS days_vs_terms,
  CASE WHEN ap.paid_date IS NOT NULL THEN (DATEDIFF(ap.paid_date, ap.due_date) <= 0) END AS on_time,
  ap.status
FROM {{close}}.subledger_ap ap
LEFT JOIN {{close}}.dim_org o ON ap.business_unit_id = o.business_unit_id;
