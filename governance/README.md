# Milestone 6 — Governance, lineage & the ZeroOps inbox

Closes the loop: the self-heal inbox (Act 2) and the audit close-out (Act 6).

## ZeroOps insights inbox

`baseline_ops.zeroops_insights` (and per-industry `{industry}_ops.zeroops_insights`) models the self-heal loop
(detect → triage → diagnose → propose repair → human approve). It is derived
directly from the supply chain's real DQ results, so it is never fabricated:

| Signal | Severity | Status | Proposed repair |
|---|---|---|---|
| Schema drift (close-folder column rename) | Low | **RESOLVED** | Auto-applied schema evolution + coalesce (auto-healed) |
| Unbalanced journal batch | High | PROPOSED | Quarantine to suspense, request resubmission |
| Orphan account reference | High | PROPOSED | Map to 67000 or reject for correction |
| Stale source feed (ERP-FixedAssets) | High | PROPOSED | Re-trigger ingestion |
| Subledger-to-GL break | High | PROPOSED | Route to the reconciliation app for judgment |

The schema-drift signal is already RESOLVED (Auto Loader handled the rename in
Milestone 2); the rest are PROPOSED, awaiting Controller approval. Surfaced in
the Genie space so the CFO can ask *"what is ZeroOps proposing for this close?"*.

## Governance & lineage (Act 6)

Unity Catalog captures end-to-end lineage automatically across the build:

```
source spreadsheet (close_folder volume)
  └─▶ bronze_close_folder_adjustments (Auto Loader)
       └─▶ close_adjustments  (governed, + source_spreadsheet, submitted_by)
            └─▶ v_postings ─▶ account_balance_by_bu ─▶ trial_balance ─▶ trial_balance_dq

gl_journal_entries ─▶ v_postings ─▶ trial_balance
posted_adjustments (app, from Lakebase) ─▶ v_postings ─▶ trial_balance
```

To run the **Act 6 audit trace** live:

1. Open **Catalog Explorer → `{industry}_serving.trial_balance` → Lineage** (or `baseline_serving.trial_balance`).
   Walk upstream: `trial_balance → account_balance_by_bu → v_postings →
   gl_journal_entries / posted_adjustments / close_adjustments`.
2. For a former-spreadsheet value, continue `close_adjustments →
   bronze_close_folder_adjustments → close_folder volume file`, and show the
   `source_spreadsheet` + `submitted_by` columns — the original file and analyst.
3. Show the period's DQ evidence (`{industry}_ops.dq_results`) and the ZeroOps incident
   (`{industry}_ops.zeroops_insights`) that was detected and remediated.

Descriptive `COMMENT`s are applied to the key tables so the catalog is
self-documenting during the trace.

## Run

```bash
cd governance
uv run --with databricks-sdk --with pyyaml python build_governance.py
```
