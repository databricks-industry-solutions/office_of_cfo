"""Sources (Act 1) + audit / lineage close-out (Act 6).

- /sources: the ungoverned spreadsheet origin (close-folder files + who submitted).
- /lineage: the end-to-end UC lineage graph for the trial balance, for rendering.
- /audit/provenance: row-level adjustment provenance + the period's DQ evidence and
  ZeroOps incidents, so an auditor can trace a figure back to its source.
"""
from fastapi import APIRouter

from ..config import CLOSE_FQ, OPS_FQ, CLOSE_PERIOD
from ..warehouse import query

router = APIRouter()

CLOSE = CLOSE_FQ
OPS = OPS_FQ


@router.get("/sources")
def sources():
    """Close-folder spreadsheets that fed the close, with submitter + schema-drift flag."""
    return query(
        f"SELECT source_spreadsheet, submitted_by, "
        f"COUNT(*) AS adjustments, ROUND(SUM(amount), 2) AS total_amount, "
        f"MAX(had_schema_drift) AS had_schema_drift "
        f"FROM {CLOSE}.close_adjustments "
        f"WHERE period = '{CLOSE_PERIOD}' "
        f"GROUP BY source_spreadsheet, submitted_by "
        f"ORDER BY source_spreadsheet")


@router.get("/lineage")
def lineage():
    """The documented end-to-end lineage graph for the trial balance (Act 6)."""
    nodes = [
        {"id": "close_folder", "label": "close_folder volume (SharePoint files)", "layer": "source"},
        {"id": "bronze_close_folder_adjustments", "label": "bronze_close_folder_adjustments (Auto Loader)", "layer": "bronze"},
        {"id": "close_adjustments", "label": "close_adjustments (+ source_spreadsheet, submitted_by)", "layer": "governed"},
        {"id": "gl_journal_entries", "label": "gl_journal_entries", "layer": "governed"},
        {"id": "posted_adjustments", "label": "posted_adjustments (app, from Lakebase)", "layer": "governed"},
        {"id": "v_postings", "label": "v_postings", "layer": "serving"},
        {"id": "account_balance_by_bu", "label": "account_balance_by_bu", "layer": "serving"},
        {"id": "trial_balance", "label": "trial_balance", "layer": "serving"},
        {"id": "trial_balance_dq", "label": "trial_balance_dq (+ DQ badge)", "layer": "serving"},
    ]
    edges = [
        {"from": "close_folder", "to": "bronze_close_folder_adjustments"},
        {"from": "bronze_close_folder_adjustments", "to": "close_adjustments"},
        {"from": "close_adjustments", "to": "v_postings"},
        {"from": "gl_journal_entries", "to": "v_postings"},
        {"from": "posted_adjustments", "to": "v_postings"},
        {"from": "v_postings", "to": "account_balance_by_bu"},
        {"from": "account_balance_by_bu", "to": "trial_balance"},
        {"from": "trial_balance", "to": "trial_balance_dq"},
    ]
    return {"nodes": nodes, "edges": edges}


@router.get("/audit/provenance")
def provenance():
    """Row-level adjustment provenance + DQ evidence + ZeroOps incidents for the period."""
    adjustments = query(
        f"SELECT adjustment_id, adjustment_type, account_code, business_unit_id, "
        f"dr_cr, amount, memo, submitted_by, submitted_ts, had_schema_drift, source_spreadsheet "
        f"FROM {CLOSE}.close_adjustments "
        f"WHERE period = '{CLOSE_PERIOD}' "
        f"ORDER BY source_spreadsheet, adjustment_id")
    dq_evidence = query(
        f"SELECT check_id, dimension, scope, metric_value, status "
        f"FROM {OPS}.dq_results "
        f"ORDER BY CASE status WHEN 'FAIL' THEN 0 WHEN 'WARN' THEN 1 ELSE 2 END, dimension")
    incidents = query(
        f"SELECT insight_id, signal_type, severity, title, status, approver "
        f"FROM {OPS}.zeroops_insights "
        f"WHERE period = '{CLOSE_PERIOD}' "
        f"ORDER BY CASE status WHEN 'PROPOSED' THEN 0 ELSE 1 END, insight_id")
    return {"adjustments": adjustments, "dq_evidence": dq_evidence, "incidents": incidents}
