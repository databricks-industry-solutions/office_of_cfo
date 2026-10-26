"""Counterparty concentration network (Concentration Risk page).

Aggregates the AR (customer) or AP (vendor) subledger by counterparty x business
unit to reveal the biggest single-name exposures across legal entities. Ranks by
the selected metric (dollar exposure or invoice volume) and flags the top N (N
configurable), so the page can spotlight a whole group of concentration risks.

The final, meaningful step is a governed action: `POST /concentration/raise-reviews`
creates a credit-review close task per flagged counterparty in Lakebase (the same
system of record + audit trail as the rest of the close), so the Controller can
delegate the follow-up down to the Accountant's Close Tasks board.
"""
import re

from fastapi import APIRouter, Header, Query
from pydantic import BaseModel

from ..config import CLOSE_FQ, CLOSE_PERIOD, SRV_FQ, resolve_period
from ..industry import resolve_industry
from ..lakebase import pool
from ..personas import scope_clause
from ..warehouse import query
from .tasks import _due_from_offset, _ensure_schema, _log

router = APIRouter()

CLOSE = CLOSE_FQ
SRV = SRV_FQ

# Scope columns on the inventory_exposure serving view.
_INV_COLS = {"region": "region", "legal_entity": "legal_entity_id",
             "business_unit": "business_unit_id", "business_line": "business_line"}


@router.get("/inventory-exposure")
def inventory_exposure(scope_type: str = Query("consolidated"), scope_id: str = Query("ALL"),
                       period: str = Query(None)):
    """Inventory exposure by business unit: total carried value plus the
    slow-moving and supplier-managed exposure lenses (working-capital view)."""
    p = resolve_period(period)
    where = f" WHERE period = '{p}'" + scope_clause(scope_type, scope_id, _INV_COLS, prefix=" AND ")
    return query(
        f"SELECT business_unit_id, business_unit_name, region, "
        f"ROUND(SUM(inventory_value), 2) AS total_inventory, "
        f"ROUND(SUM(CASE WHEN is_slow_moving THEN inventory_value ELSE 0 END), 2) AS slow_moving_value, "
        f"ROUND(SUM(CASE WHEN is_supplier_managed THEN inventory_value ELSE 0 END), 2) AS supplier_managed_value, "
        f"COUNT(*) AS item_count "
        f"FROM {SRV}.inventory_exposure{where} "
        f"GROUP BY business_unit_id, business_unit_name, region ORDER BY total_inventory DESC")

# Per-industry review-task noun (customer side, vendor side), so raised
# concentration tasks read in the right vocabulary end-to-end.
REVIEW_NOUNS: dict[str, dict[str, str]] = {
    "consumer": {"customer": "Customer", "vendor": "Supplier"},
    "software": {"customer": "Account", "vendor": "Vendor"},
    "fsi": {"customer": "Credit", "vendor": "Counterparty"},
    "energy": {"customer": "Counterparty", "vendor": "Counterparty"},
    "capmarkets": {"customer": "Counterparty", "vendor": "Venue"},
}

# dimension -> (governed subledger table, counterparty column)
_DIMS = {
    "customer": ("subledger_ar", "customer_name"),
    "vendor": ("subledger_ap", "vendor_name"),
}

# Cap counterparty nodes so the graph stays legible (top by dollar exposure).
_MAX_COUNTERPARTIES = 40


def _num(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _slug(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "-", s).strip("-")


# Selectable exposure metric -> the per-counterparty key it ranks/flags on.
_METRICS = {"amount": "exposure", "txn": "txn_count"}


def _metric_key(metric: str) -> str:
    return _METRICS.get(metric, "exposure")


def _aggregate(dim: str):
    """Return (entities, cps, total) for a dimension. Raises if warehouse unreachable."""
    table, name_col = _DIMS[dim]
    rows = query(
        f"SELECT s.{name_col} AS counterparty, s.business_unit_id AS bu, "
        f"o.business_unit_name AS bu_name, ROUND(SUM(s.amount), 2) AS exposure, "
        f"COUNT(*) AS txn_count "
        f"FROM {CLOSE}.{table} s "
        f"JOIN {CLOSE}.dim_org o ON s.business_unit_id = o.business_unit_id "
        f"WHERE s.period = '{CLOSE_PERIOD}' "
        f"GROUP BY s.{name_col}, s.business_unit_id, o.business_unit_name")

    entities: dict[str, dict] = {}
    cps: dict[str, dict] = {}
    total = 0.0
    for r in rows:
        bu = r["bu"]
        name = r["counterparty"]
        exp = _num(r["exposure"])
        txn = int(_num(r["txn_count"]))
        total += exp
        e = entities.setdefault(bu, {"id": bu, "label": r.get("bu_name") or bu, "exposure": 0.0})
        e["exposure"] += exp
        c = cps.setdefault(name, {"name": name, "exposure": 0.0, "txn_count": 0, "by_entity": {}})
        c["exposure"] += exp
        c["txn_count"] += txn
        c["by_entity"][bu] = c["by_entity"].get(bu, 0.0) + exp
    return entities, cps, total


def _rank_and_flag(cps: dict, min_count: int, metric: str = "amount"):
    """Rank counterparties by the chosen metric; flag exactly the top N.

    We flag the top N outright (not everything at/above the Nth value) so the
    control stays responsive even when the metric has many ties — e.g. invoice
    counts are small integers where a ">= Nth-largest" rule would flag a whole
    tied block regardless of N. Dollar exposure breaks ties deterministically.
    """
    key = _metric_key(metric)
    # Selection of which nodes to draw always stays by dollar exposure so the
    # graph shows the biggest names; only the ranking/flagging honours `metric`.
    selected = sorted(cps.values(), key=lambda c: c["exposure"], reverse=True)[:_MAX_COUNTERPARTIES]
    if not selected:
        return selected, 0.0, []
    by_metric = sorted(selected, key=lambda c: (c[key], c["exposure"]), reverse=True)
    n = max(1, min(min_count, len(by_metric)))
    flagged = by_metric[:n]
    threshold = flagged[-1][key] if flagged else 0.0
    return selected, threshold, flagged


def cp_id(name: str) -> str:
    return f"C::{name}"


@router.get("/exposure-graph")
def exposure_graph(dimension: str = "customer", min_count: int = 3, metric: str = "amount"):
    dim = dimension if dimension in _DIMS else "customer"
    metric = metric if metric in _METRICS else "amount"
    try:
        entities, cps, total = _aggregate(dim)
    except Exception:  # noqa: BLE001 — warehouse not reachable; render empty gracefully
        return {"dimension": dim, "metric": metric, "nodes": [], "links": [], "summary": {},
                "converge_target": None, "converge_targets": [], "threshold": 0.0}

    selected, threshold, flagged = _rank_and_flag(cps, min_count, metric)
    flagged_names = {c["name"] for c in flagged}

    nodes: list[dict] = []
    for e in sorted(entities.values(), key=lambda x: x["exposure"], reverse=True):
        nodes.append({
            "id": e["id"], "type": "entity", "label": e["label"],
            "properties": {"exposure": round(e["exposure"], 2)},
        })

    links: list[dict] = []

    for c in selected:
        touched = len(c["by_entity"])
        pct = round(100.0 * c["exposure"] / total, 2) if total else 0.0
        is_flagged = c["name"] in flagged_names
        nodes.append({
            "id": cp_id(c["name"]), "type": "counterparty", "label": c["name"],
            "properties": {
                "exposure": round(c["exposure"], 2),
                "txn_count": c["txn_count"],
                "entities_touched": touched,
                "pct_of_total": pct,
                "flagged": is_flagged,
                "tone": "critical" if is_flagged else "good",
            },
        })
        for bu, exp in c["by_entity"].items():
            links.append({
                "id": f"{bu}-{cp_id(c['name'])}", "source": bu, "target": cp_id(c["name"]),
                "type": "exposed_to", "weight": round(exp, 2), "properties": {},
            })

    flagged_exposure = sum(c["exposure"] for c in flagged)
    flagged_txn = sum(c["txn_count"] for c in flagged)
    entities_union: set[str] = set()
    for c in flagged:
        entities_union.update(c["by_entity"].keys())

    summary = {
        "flagged_count": len(flagged),
        "flagged_exposure": round(flagged_exposure, 2),
        "flagged_txn": flagged_txn,
        "entities_exposed": len(entities_union),
        "pct_of_total": round(100.0 * flagged_exposure / total, 2) if total else 0.0,
        "min_count": max(1, min(min_count, len(selected))) if selected else min_count,
        "counterparty_count": len(cps),
        "total_exposure": round(total, 2),
    }
    # Flagged targets, ordered by the active metric so the review list matches.
    key = _metric_key(metric)
    converge_targets = [cp_id(c["name"]) for c in sorted(flagged, key=lambda c: c[key], reverse=True)]

    return {
        "dimension": dim,
        "metric": metric,
        "nodes": nodes,
        "links": links,
        "summary": summary,
        "threshold": round(threshold, 2),
        "converge_targets": converge_targets,
        "converge_target": converge_targets[0] if converge_targets else None,
    }


class RaiseReviewsIn(BaseModel):
    dimension: str = "customer"
    min_count: int = 3
    metric: str = "amount"


@router.post("/concentration/raise-reviews")
def raise_reviews(body: RaiseReviewsIn, x_industry: str | None = Header(default=None)):
    """Raise one concentration-review close task per flagged counterparty (idempotent)."""
    dim = body.dimension if body.dimension in _DIMS else "customer"
    metric = body.metric if body.metric in _METRICS else "amount"
    try:
        _entities, cps, total = _aggregate(dim)
    except Exception:  # noqa: BLE001
        return {"created": [], "skipped": [], "count": 0}

    _selected, _threshold, flagged = _rank_and_flag(cps, body.min_count, metric)
    if not flagged:
        return {"created": [], "skipped": [], "count": 0}

    _ensure_schema()
    industry = resolve_industry(x_industry)
    # Default must be a real key — Python evaluates .get() defaults eagerly, so
    # REVIEW_NOUNS["retail"] KeyError'd on every call after retail→consumer rename.
    noun = REVIEW_NOUNS.get(industry, REVIEW_NOUNS["consumer"])[dim]
    book = "AR" if dim == "customer" else "AP"
    due = _due_from_offset(2)
    created: list[str] = []
    skipped: list[str] = []

    with pool.connection() as conn:
        with conn.cursor() as cur:
            for c in flagged:
                name = c["name"]
                touched = len(c["by_entity"])
                pct = round(100.0 * c["exposure"] / total, 1) if total else 0.0
                top_bu = max(c["by_entity"], key=c["by_entity"].get) if c["by_entity"] else None
                task_id = f"TASK-{CLOSE_PERIOD}-CONC-{dim[:3].upper()}-{_slug(name)}"
                task_name = f"{noun} review — {name}"
                ent_word = "entity" if touched == 1 else "entities"
                desc = (f"{name} is a top single-name {dim} exposure: "
                        f"${c['exposure']:,.0f} across {touched} {ent_word} "
                        f"({pct}% of {book}). Review credit limit and concentration.")
                # Idempotent, but re-armable after a demo reset: the reset
                # "archives" these tasks by moving them to a sentinel period, so
                # here we re-raise (DO UPDATE) any row that isn't in the live
                # period, while a row already live in this period is left alone
                # (rowcount 0 → reported as "already open"). No DELETE needed —
                # the deployed DB role is INSERT/UPDATE only.
                cur.execute(
                    "INSERT INTO close_tasks "
                    "(task_id, period, task_name, description, workstream, business_unit_id, "
                    " priority, due_date, status, source, linked_ref, created_by) "
                    "VALUES (%s,%s,%s,%s,'Risk & Controls',%s,'HIGH',%s,'NOT_STARTED','concentration',%s,'system') "
                    "ON CONFLICT (task_id) DO UPDATE SET "
                    "  period = EXCLUDED.period, task_name = EXCLUDED.task_name, "
                    "  description = EXCLUDED.description, business_unit_id = EXCLUDED.business_unit_id, "
                    "  priority = EXCLUDED.priority, due_date = EXCLUDED.due_date, "
                    "  status = 'NOT_STARTED', is_blocked = false, delay_reason = NULL, "
                    "  started_ts = NULL, completed_ts = NULL, linked_ref = EXCLUDED.linked_ref, "
                    "  updated_ts = now() "
                    "WHERE close_tasks.period <> EXCLUDED.period",
                    (task_id, CLOSE_PERIOD, task_name, desc, top_bu, due, name))
                if cur.rowcount:
                    _log(cur, task_id, "created",
                         f"Concentration review raised for {name} ({pct}% of {book})", actor="system")
                    created.append(task_id)
                else:
                    skipped.append(task_id)
        conn.commit()

    return {"created": created, "skipped": skipped, "count": len(created)}
