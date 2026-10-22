-- Close Support / IDP — offline parse + extract.
-- Parses the source PDFs once with ai_parse_document, then uses ai_extract
-- (factual fields) and ai_query (contract risk reasoning) to materialize
-- governed Delta tables in {{close}}. Re-runnable (CREATE OR REPLACE).

-- 1. Parse every PDF in the volume once (VARIANT document with elements + bbox).
CREATE OR REPLACE TABLE {{close}}.close_documents_parsed AS
SELECT
  regexp_extract(path, '([^/]+)$', 1) AS filename,
  CASE WHEN path LIKE '%/filings/%' THEN 'filing' ELSE 'contract' END AS doc_type,
  ai_parse_document(content) AS parsed
FROM read_files('{{raw_volume}}/close_documents/',
                format => 'binaryFile', recursiveFileLookup => true)
WHERE lower(path) LIKE '%.pdf';

-- 2. Explode parsed elements (content + type + page number) for text + citations.
CREATE OR REPLACE TABLE {{close}}.close_documents_elements AS
SELECT
  filename, doc_type,
  cast(e:content AS STRING) AS content,
  cast(e:type AS STRING) AS el_type,
  cast(e:bbox[0]:page_id AS INT) AS page_id
FROM {{close}}.close_documents_parsed
LATERAL VIEW explode(cast(parsed:document:elements AS ARRAY<VARIANT>)) t AS e;

-- 3. Competitor KPI extraction (ai_extract) -> one row per competitor x metric.
CREATE OR REPLACE TABLE {{close}}.competitor_benchmarks AS
WITH docs AS (
  SELECT filename,
    array_join(collect_list(content), '\n') AS full_text,
    max(CASE WHEN el_type = 'title' THEN content END) AS title,
    coalesce(min(CASE WHEN lower(content) LIKE '%cash conversion cycle%' THEN page_id END), 0) + 1 AS metric_page
  FROM {{close}}.close_documents_elements
  WHERE doc_type = 'filing'
  GROUP BY filename
),
ext AS (
  SELECT filename, metric_page, full_text,
    regexp_replace(title, '\\s*\\(.*\\)\\s*$', '') AS competitor
  FROM docs
)
SELECT competitor, 'FY2026' AS period, metric, their_value, unit,
       filename AS source_file, metric_page AS source_page
FROM ext
LATERAL VIEW stack(9,
  'Revenue ($B)',     try_cast(regexp_extract(full_text, 'Total revenue</td>\\s*<td>\\$?\\s*([0-9][0-9.]*)', 1) AS DOUBLE), '$B',
  'Revenue growth',   try_cast(regexp_extract(full_text, 'Revenue growth \\(YoY\\)</td>\\s*<td>\\s*([0-9][0-9.]*)', 1) AS DOUBLE), '%',
  'Gross margin',     try_cast(regexp_extract(full_text, 'Gross margin</td>\\s*<td>\\s*([0-9][0-9.]*)', 1) AS DOUBLE), '%',
  'Operating margin', try_cast(regexp_extract(full_text, 'Operating margin</td>\\s*<td>\\s*([0-9][0-9.]*)', 1) AS DOUBLE), '%',
  'Net margin',       try_cast(regexp_extract(full_text, 'Net margin</td>\\s*<td>\\s*([0-9][0-9.]*)', 1) AS DOUBLE), '%',
  'DSO',              try_cast(regexp_extract(full_text, '\\(DSO\\)</td>\\s*<td>\\s*([0-9][0-9.]*)', 1) AS DOUBLE), 'days',
  'DIO',              try_cast(regexp_extract(full_text, '\\(DIO\\)</td>\\s*<td>\\s*([0-9][0-9.]*)', 1) AS DOUBLE), 'days',
  'DPO',              try_cast(regexp_extract(full_text, '\\(DPO\\)</td>\\s*<td>\\s*([0-9][0-9.]*)', 1) AS DOUBLE), 'days',
  'CCC',              try_cast(regexp_extract(full_text, '\\(CCC\\)</td>\\s*<td>\\s*([0-9][0-9.]*)', 1) AS DOUBLE), 'days'
) s AS metric, their_value, unit;

-- 4. Contract extraction: ai_extract (facts) + ai_query (risk reasoning as JSON).
CREATE OR REPLACE TABLE {{close}}.contract_obligations AS
WITH docs AS (
  SELECT filename,
    array_join(collect_list(content), '\n') AS full_text,
    coalesce(min(CASE WHEN lower(content) LIKE '%limitation of liability%' THEN page_id END), 0) + 1 AS terms_page
  FROM {{close}}.close_documents_elements
  WHERE doc_type = 'contract'
  GROUP BY filename
),
ext AS (
  SELECT filename, terms_page, full_text,
    ai_extract(full_text, array('counterparty','contract_id','category','renewal_date','payment_terms','annual_value','currency','limitation_of_liability')) AS f,
    from_json(
      regexp_replace(
        ai_query('databricks-claude-sonnet-4-5',
          concat('You are a contracts analyst. Using ONLY the contract text below, respond with COMPACT JSON and no markdown fences, with keys: ',
                 'risk_level (exactly one of HIGH, MEDIUM, LOW), risk_note (one sentence), obligations (array of up to 3 short strings). ',
                 'Contract text:\n', full_text)),
        '```[a-zA-Z]*', ''),
      'STRUCT<risk_level STRING, risk_note STRING, obligations ARRAY<STRING>>') AS r
  FROM docs
)
SELECT
  f.counterparty AS counterparty,
  f.contract_id AS contract_id,
  f.category AS category,
  f.renewal_date AS renewal_date,
  (lower(full_text) LIKE '%automatically renews%') AS auto_renew,
  f.payment_terms AS payment_terms,
  try_cast(regexp_replace(f.annual_value, '[^0-9.]', '') AS DOUBLE) AS annual_value,
  coalesce(f.currency, 'USD') AS currency,
  f.limitation_of_liability AS liability,
  upper(coalesce(r.risk_level, 'LOW')) AS risk_level,
  r.risk_note AS risk_note,
  array_join(r.obligations, ' | ') AS obligations,
  filename AS source_file,
  terms_page AS source_page
FROM ext;

-- 5. Document registry (self-contained from parsed elements + extracted names).
CREATE OR REPLACE TABLE {{close}}.close_documents_catalog AS
WITH pages AS (
  SELECT filename, any_value(doc_type) AS doc_type, max(page_id) + 1 AS pages
  FROM {{close}}.close_documents_elements GROUP BY filename
),
names AS (
  SELECT source_file AS filename, any_value(competitor) AS counterparty, 'FY2026' AS period
  FROM {{close}}.competitor_benchmarks GROUP BY source_file
  UNION ALL
  SELECT source_file AS filename, any_value(counterparty) AS counterparty, any_value(renewal_date) AS period
  FROM {{close}}.contract_obligations GROUP BY source_file
)
SELECT p.filename, p.doc_type, n.counterparty, n.period, p.pages, current_timestamp() AS ingested_ts
FROM pages p LEFT JOIN names n USING (filename);
