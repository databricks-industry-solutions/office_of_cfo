"""ZeroOps self-heal inbox (Act 2): detected DQ signals with proposed repairs.

Reads the governed `zeroops_insights` table built by the supply chain, and lets a
Controller approve a PROPOSED repair (flips its status), so the self-heal loop
(detect -> diagnose -> propose -> approve) is interactive in the app.
"""
from fastapi import APIRouter, HTTPException

from ..config import OPS_FQ, CLOSE_PERIOD, current_user
from ..warehouse import query, invalidate_cache

router = APIRouter()

OPS = OPS_FQ


@router.get("/zeroops-insights")
def zeroops_insights():
    return query(
        f"SELECT insight_id, detected_ts, signal_type, severity, source, title, "
        f"diagnosis, proposed_repair, status, approver, period "
        f"FROM {OPS}.zeroops_insights "
        f"WHERE period = '{CLOSE_PERIOD}' "
        f"ORDER BY CASE status WHEN 'PROPOSED' THEN 0 WHEN 'APPROVED' THEN 1 ELSE 2 END, "
        f"CASE severity WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END, insight_id")


@router.post("/zeroops-insights/{insight_id}/approve")
def approve_insight(insight_id: str):
    safe_id = insight_id.replace("'", "''")
    user = current_user().replace("'", "''")
    rows = query(
        f"SELECT status FROM {OPS}.zeroops_insights "
        f"WHERE insight_id = '{safe_id}' AND period = '{CLOSE_PERIOD}'")
    if not rows:
        raise HTTPException(404, "Insight not found")
    query(
        f"UPDATE {OPS}.zeroops_insights "
        f"SET status = 'APPROVED', approver = '{user}' "
        f"WHERE insight_id = '{safe_id}' AND period = '{CLOSE_PERIOD}'")
    # Drop cached SELECTs so the next /zeroops-insights read reflects the new
    # status immediately (otherwise the UI shows the stale row for up to the
    # cache TTL and the approval looks like it did nothing).
    invalidate_cache()
    return {"insight_id": insight_id, "status": "APPROVED", "approver": current_user()}
