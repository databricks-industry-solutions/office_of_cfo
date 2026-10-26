-- Close Support / IDP — serving views the app reads (sub-second, no inference).

CREATE OR REPLACE VIEW {{serving}}.close_documents_catalog AS
SELECT filename, doc_type, counterparty, period, pages, ingested_ts
FROM {{close}}.close_documents_catalog;

CREATE OR REPLACE VIEW {{serving}}.contract_obligations AS
SELECT counterparty, contract_id, category, renewal_date, auto_renew, payment_terms,
       annual_value, currency, liability, risk_level, risk_note, obligations,
       source_file, source_page
FROM {{close}}.contract_obligations;

-- Competitor metrics joined to our own current-period figures (scale-independent
-- ratios computed the same way as the KPI API). Revenue is annualized to $B.
CREATE OR REPLACE VIEW {{serving}}.competitor_benchmark_vs_us AS
WITH ours AS (
  SELECT SUM(ar_balance) AS ar, SUM(ap_balance) AS ap, SUM(inventory_balance) AS inv,
         SUM(revenue) AS rev, SUM(cogs) AS cogs, SUM(operating_expense) AS opex,
         MAX(days_in_period) AS days
  FROM {{serving}}.working_capital_kpis
),
ourmap AS (
  SELECT metric, our_value FROM ours
  LATERAL VIEW stack(8,
    'Revenue ($B)',     cast(round(rev * 12 / 1e9, 2) AS DOUBLE),
    'Gross margin',     cast(round((rev - cogs) / rev * 100, 1) AS DOUBLE),
    'Operating margin', cast(round((rev - cogs - opex) / rev * 100, 1) AS DOUBLE),
    'Net margin',       cast(round((rev - cogs - opex) / rev * 100, 1) AS DOUBLE),
    'DSO',              cast(round(ar / rev * days, 1) AS DOUBLE),
    'DIO',              cast(round(inv / cogs * days, 1) AS DOUBLE),
    'DPO',              cast(round(ap / cogs * days, 1) AS DOUBLE),
    'CCC',              cast(round(ar / rev * days + inv / cogs * days - ap / cogs * days, 1) AS DOUBLE)
  ) s AS metric, our_value
)
SELECT b.competitor, b.metric, b.their_value, o.our_value,
       round(b.their_value - o.our_value, 1) AS delta, b.unit,
       b.source_file, b.source_page
FROM {{close}}.competitor_benchmarks b
LEFT JOIN ourmap o USING (metric);
