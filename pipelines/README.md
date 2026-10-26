# Milestone 2 — Lakeflow self-healing pipeline + data quality

A Lakeflow Spark Declarative Pipeline (DAB) that ingests the close data into
governed Unity Catalog tables, applies declared data-quality expectations, and
turns quality into queryable fields (the DQ badge) plus reconciliation-break
detail for the app.

## What it builds

**`{catalog}.baseline_close`** (governed close tables):
- `bronze_close_folder_adjustments` — Auto Loader ingest of the close-folder
  spreadsheets **with schema evolution** (the renamed `amount` → `adjustment_amount`
  column is captured, not silently dropped).
- `close_adjustments` — governed manual adjustments; coalesces the drifted column
  back into `amount`, flags `had_schema_drift`, and keeps spreadsheet provenance
  (`source_spreadsheet`, `submitted_by`) for the Act 6 audit trace.
- `chart_of_accounts`, `dim_org`, `gl_journal_entries`,
  `subledger_ap/ar/payroll/fixed_assets/inventory/sales_orders/procurement/bank/staff_expenses`,
  `budget_forecast`, `kpi_history` — typed, with declared expectations that
  **flag rather than drop** (breaks stay visible).

**`{catalog}.baseline_ops`** (quality + reconciliation):
- `recon_breaks` — subledger-to-GL reconciliation by control account × BU;
  `is_break` flags residual items needing human judgment (drives Act 4).
- `dq_results` — one row per data-quality check across the CFO's six DQ
  dimensions (completeness, freshness, validity, referential integrity,
  reconciliation, schema evolution).
- `dq_summary` — the single go/no-go close badge.

## Verified seeded-issue detection

| Check | Result |
|---|---|
| `validity_debits_equal_credits` | FAIL — 1 unbalanced Legacy-ERP batch |
| `referential_integrity_ap_account` | FAIL — 1 AP invoice with orphan account `99999` |
| `freshness_ERP-FixedAssets` | FAIL — feed 3 days stale |
| `reconciliation_subledger_to_gl` | FAIL — 1 break (AP, BU-300, $6,552.79) |
| `schema_drift_close_folder` | WARN — accruals spreadsheet column renamed (auto-handled) |
| **`dq_summary.badge`** | **NO-GO — 4 checks failing** (pre-heal; ZeroOps resolves in Act 2/M6) |

## Deploy & run

The pipeline is part of the repo-root bundle (`resources/close_pipeline.pipeline.yml`)
and `scripts/setup.py` runs it. To re-run it on its own:

```bash
databricks bundle run close_pipeline --profile <profile>
```

## Design notes

- **Modern SDP API** (`from pyspark import pipelines as dp`), serverless, `channel: PREVIEW`.
- **Never use eager actions** (`.count()` / `.collect()`) inside a pipeline
  function — they can observe empty upstream tables. All checks are lazy
  DataFrames (this bit us once; see git history).
- Publishes to two schemas from one pipeline via partially-qualified names
  (`baseline_ops.<table>`).
- The SharePoint connector (Beta, API/Bundle-only) is approximated by the UC
  Volume + Auto Loader on-ramp — functionally identical and demoable today.
