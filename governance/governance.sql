-- Milestone 6 — ZeroOps insights inbox + governance/lineage polish.

-- =====================================================================
-- ZeroOps insights inbox (Act 2 self-heal loop, presented as forward-looking).
-- Modeled directly off the supply chain's real DQ results: each detected signal
-- is triaged, diagnosed, and given a proposed repair for a human to approve.
-- The schema-drift signal is already RESOLVED (Auto Loader schema evolution
-- handled the column rename); the rest are PROPOSED, awaiting Controller approval.
-- =====================================================================
CREATE OR REPLACE TABLE {{ops}}.zeroops_insights AS
WITH failing AS (
  SELECT * FROM {{ops}}.dq_results WHERE status IN ('FAIL','WARN')
),
mapped AS (
  SELECT
    dimension, scope, status, period,
    CASE dimension
      WHEN 'schema_evolution'      THEN 'Schema drift detected on close-folder ingest'
      WHEN 'validity'              THEN 'Unbalanced journal batch detected'
      WHEN 'referential_integrity' THEN 'Orphan account reference detected'
      WHEN 'freshness'             THEN 'Stale source feed detected'
      WHEN 'reconciliation'        THEN 'Subledger-to-GL reconciliation break'
      WHEN 'three_way_match'       THEN 'Purchase-order to invoice mismatch'
      ELSE 'Data-quality signal'
    END AS title,
    CASE dimension
      WHEN 'schema_evolution'      THEN 'A close-folder spreadsheet renamed its amount column to adjustment_amount overnight.'
      WHEN 'validity'              THEN 'A Legacy-ERP journal batch has debits not equal to credits (off by 1250.00).'
      WHEN 'referential_integrity' THEN 'An AP invoice references account 99999, which is not in the chart of accounts.'
      WHEN 'freshness'             THEN 'The SAP-FixedAssets feed loaded 3 days late relative to the rest of the close.'
      WHEN 'reconciliation'        THEN 'A subledger balance diverges from its GL control account, consistent with delayed or missing GL postings.'
      WHEN 'three_way_match'       THEN 'A purchase order amount does not agree with the invoice it was received against.'
      ELSE 'See dq_results for detail.'
    END AS diagnosis,
    CASE dimension
      WHEN 'schema_evolution'      THEN 'Auto-applied schema evolution and coalesced adjustment_amount back into amount.'
      WHEN 'validity'              THEN 'Quarantine the batch to a suspense account and request source resubmission.'
      WHEN 'referential_integrity' THEN 'Map the orphan line to 67000 (Operating Expense - Other) or reject for correction.'
      WHEN 'freshness'             THEN 'Re-trigger ingestion for the SAP-FixedAssets feed before striking the trial balance.'
      WHEN 'reconciliation'        THEN 'Route to the reconciliation app for accountant judgment and a correcting adjustment.'
      WHEN 'three_way_match'       THEN 'Flag the PO-invoice variance for procurement review before releasing payment.'
      ELSE 'Review.'
    END AS proposed_repair,
    CASE WHEN dimension = 'schema_evolution' THEN 'RESOLVED' ELSE 'PROPOSED' END AS state,
    CASE WHEN status = 'FAIL' THEN 'High' ELSE 'Low' END AS severity,
    CASE WHEN dimension = 'schema_evolution' THEN 'ZeroOps (auto-healed)' ELSE NULL END AS approver
  FROM failing
)
SELECT
  concat('ZO-', period, '-', lpad(cast(row_number() OVER (ORDER BY severity DESC, dimension) AS string), 3, '0')) AS insight_id,
  current_timestamp() AS detected_ts,
  dimension AS signal_type,
  severity,
  scope AS source,
  title,
  diagnosis,
  proposed_repair,
  state AS status,
  approver,
  period
FROM mapped;

-- =====================================================================
-- Governance: descriptive comments so the catalog is self-documenting and the
-- Act 6 audit trace reads cleanly in Catalog Explorer / lineage.
-- =====================================================================
COMMENT ON TABLE {{close}}.gl_journal_entries IS
  'Governed general-ledger journal entries for the month-end close (Act 2).';
COMMENT ON TABLE {{close}}.close_adjustments IS
  'Governed manual adjustments ingested from the close-folder spreadsheets, carrying source_spreadsheet and submitted_by for audit provenance (Act 6).';
COMMENT ON TABLE {{close}}.posted_adjustments IS
  'Journal adjustments posted from the reconciliation app (Act 4), synced from Lakebase and flowing into the real-time trial balance.';
COMMENT ON TABLE {{ops}}.dq_summary IS
  'Single go/no-go close-quality signal (the trial-balance DQ badge).';
COMMENT ON TABLE {{ops}}.zeroops_insights IS
  'ZeroOps insights inbox: detected DQ signals with diagnosis and proposed repair for human approval (Act 2 self-heal loop).';
