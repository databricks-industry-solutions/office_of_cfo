"""Unified lineage + data-quality API (Sankey graph + paginated records)."""
from __future__ import annotations

import os

from fastapi import APIRouter, Query

from ..config import CLOSE_FQ, CLOSE_PERIOD, current_industry
from ..lakebase import pool
from ..lineage_quality import (
    FLOW_IDS, FLOWS, assemble, demo_evidence, overlay_success_totals,
    records_response, synthetic_success,
)
from ..personas import ORG, scope_business_units
from ..versioned_cache import VersionedTTLCache
from ..warehouse import cache_version, query
from .datasources import SOURCE_SYSTEM_OVERRIDES, _coverage

router = APIRouter()

CLOSE = CLOSE_FQ

_BU_REGION = {o["business_unit_id"]: o["region"] for o in ORG}

_SUCCESS_SQL = {
    "gl_journal_entries":
        "je_id AS record_id, account_code, amount, business_unit_id, source_system, load_ts, je_line",
    "subledger_ar":
        "invoice_id AS record_id, amount, business_unit_id, source_system, load_ts, customer_name AS entity_name",
    "subledger_sales_orders":
        "sales_order_id AS record_id, order_amount AS amount, business_unit_id, source_system, load_ts, customer_name AS entity_name",
    "subledger_ap":
        "invoice_id AS record_id, amount, business_unit_id, source_system, load_ts, vendor_name AS entity_name",
    "subledger_procurement":
        "purchase_order_id AS record_id, po_amount AS amount, business_unit_id, source_system, load_ts, vendor_name AS entity_name",
    "subledger_inventory":
        "inventory_item_id AS record_id, inventory_value AS amount, business_unit_id, source_system, load_ts, sku AS entity_name",
    "subledger_fixed_assets":
        "asset_id AS record_id, gross_cost AS amount, business_unit_id, source_system, load_ts, asset_description AS entity_name",
    "subledger_bank":
        "statement_id AS record_id, closing_balance AS amount, business_unit_id, source_system, load_ts, bank_account AS entity_name",
    "subledger_payroll":
        "payroll_run_id AS record_id, amount, business_unit_id, source_system, load_ts, employee_group AS entity_name",
    "subledger_staff_expenses":
        "expense_claim_id AS record_id, amount, business_unit_id, source_system, load_ts, expense_type AS entity_name",
    "close_adjustments":
        "adjustment_id AS record_id, amount, business_unit_id, "
        "submitted_ts AS load_ts, submitted_by AS entity_name",
}


def _source_labeler():
    remap = SOURCE_SYSTEM_OVERRIDES.get(current_industry(), {})

    def label(token: str) -> str:
        return remap.get(token, token)

    return label


def _scope_regions(scope_type: str, scope_id: str) -> list[str] | None:
    if not scope_type or scope_type in ("consolidated", "business_line") or scope_id in ("", "ALL"):
        return None
    if scope_type == "region":
        return [scope_id]
    if scope_type == "legal_entity":
        return sorted({o["region"] for o in ORG if o["legal_entity_id"] == scope_id})
    if scope_type == "business_unit":
        return sorted({o["region"] for o in ORG if o["business_unit_id"] == scope_id})
    return None


def _record_scope(scope_type: str, scope_id: str) -> tuple[list[str] | None, list[str] | None]:
    """(regions, business_units) to apply to materialized rows.

    Region scope filters by region so cross-BU regional issues stay visible.
    Legal-entity / business-unit scopes filter by BU so AMER siblings do not leak.
    """
    regions = _scope_regions(scope_type, scope_id)
    if scope_type in ("legal_entity", "business_unit"):
        return None, scope_business_units(scope_type, scope_id)
    return regions, None


def _scoped_success_totals(bus_ids: list[str] | None) -> dict[str, int] | None:
    """Governed success volume for the given BUs, or None if the warehouse is unreachable."""
    if not bus_ids:
        return None
    quoted = ",".join(f"'{b}'" for b in bus_ids)
    tables = sorted({f["table"] for f in FLOWS})
    union = " UNION ALL ".join(
        f"SELECT '{t}' AS tbl, COUNT(*) AS n FROM {CLOSE}.{t} "
        f"WHERE period = '{CLOSE_PERIOD}' AND business_unit_id IN ({quoted})"
        for t in tables)
    try:
        rows = query(union)
    except Exception:  # noqa: BLE001
        return None
    by_table = {r["tbl"]: int(r["n"] or 0) for r in rows}
    return {f["flow_id"]: by_table.get(f["table"], 0) for f in FLOWS}


def _demo_activity(period: str) -> list[dict]:
    return [
        {"ts": f"{period}-30T18:00:00", "actor": "Controller",
         "action": "adjustment_posted",
         "detail": "Posted correcting entry for unbalanced Legacy-ERP batch",
         "record_id": f"JE-{period}-LEGACY01", "flow_id": "gl"},
        {"ts": f"{period}-30T18:40:00", "actor": "Accountant",
         "action": "task_comment",
         "detail": "Opened recon task for AP timing break BU-300",
         "record_id": f"RECON-AP-{period}-BU-300", "flow_id": "ap"},
        {"ts": f"{period}-30T19:00:00", "actor": "ZeroOps",
         "action": "repair_proposed",
         "detail": "Proposed schema mapping amount → adjustment_amount",
         "record_id": "ADJ-ACCRUAL-DRIFT", "flow_id": "gl"},
        {"ts": f"{period}-29T06:20:00", "actor": "Ingestion",
         "action": "row_rejected",
         "detail": "Quarantined AP extract row with unexpected column gross_amt",
         "record_id": f"ING-{period}-AP-SCHEMA", "flow_id": "ap"},
    ]


def _lakebase_activity() -> list[dict]:
    try:
        # Activity is optional evidence enrichment. Never make the governed
        # warehouse graph wait for the OLTP pool's 25s operational timeout.
        with pool.connection(timeout=0.5) as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT a.ts, a.actor, a.action, a.detail, a.task_id "
                "FROM close_task_activity a "
                "WHERE a.period = %s ORDER BY a.ts DESC LIMIT 200",
                (CLOSE_PERIOD,))
            cols = [d[0] for d in cur.description]
            rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    except Exception:  # noqa: BLE001
        return []
    known = []
    out = []
    # Attach when the activity text mentions a known evidence id prefix.
    for r in rows:
        ts = r.get("ts")
        blob = f"{r.get('task_id') or ''} {r.get('detail') or ''}"
        rec_id = None
        for prefix in ("JE-", "ING-", "RECON-", "ADJ-", "AP-", "PO-", "FA-"):
            idx = blob.find(prefix)
            if idx >= 0:
                token = blob[idx:].split()[0].rstrip(",.;")
                rec_id = token
                break
        event = {
            "ts": ts.isoformat() if hasattr(ts, "isoformat") else (str(ts) if ts else None),
            "actor": r.get("actor"),
            "action": r.get("action"),
            "detail": r.get("detail"),
            "record_id": rec_id,
            "flow_id": None,
        }
        out.append(event)
        known.append(event)
    return known


def _success_rows(label) -> list[dict]:
    rows: list[dict] = []
    for flow in FLOWS:
        table = flow["table"]
        cols = _SUCCESS_SQL.get(table)
        if not cols:
            continue
        sql = f"SELECT {cols} FROM {CLOSE}.{table} WHERE period = '{CLOSE_PERIOD}' LIMIT 40"
        try:
            fetched = query(sql)
        except Exception:  # noqa: BLE001
            continue
        src = label(flow["source_token"])
        for r in fetched:
            rid = str(r.get("record_id") or "")
            if not rid:
                continue
            bu = r.get("business_unit_id")
            region = _BU_REGION.get(bu)
            amt = r.get("amount")
            try:
                amount = float(amt) if amt is not None else None
            except (TypeError, ValueError):
                amount = None
            ts = r.get("load_ts")
            rows.append({
                "record_id": f"{rid}:{flow['flow_id']}" if table == "subledger_inventory" else rid,
                "flow_id": flow["flow_id"],
                "status": "success",
                "stage": "post_ingestion",
                "source_system": r.get("source_system") or src,
                "domain": flow["domain"],
                "value_chain": flow["value_chain"],
                "table": table,
                "entity": r.get("entity_name") or bu,
                "amount": amount,
                "event_ts": str(ts) if ts else None,
                "regions": [region] if region else [],
                "rule": None,
                "message": None,
                "attributes": {k: r[k] for k in r if k not in ("record_id",)},
                "provenance": {
                    "source_table": table,
                    "source_system": r.get("source_system") or src,
                    "load_id": f"close-{CLOSE_PERIOD}",
                    "record_key": flow["record_key"],
                },
                "issues": [],
                "activity": [],
            })
    return rows


def _coverage_by_flow() -> tuple[dict, bool]:
    try:
        cov = _coverage()
        ok = bool(cov)
    except Exception:  # noqa: BLE001
        return {f["flow_id"]: {"available": False} for f in FLOWS}, False
    out = {}
    for f in FLOWS:
        c = cov.get(f["table"], {})
        n = c.get("row_count")
        out[f["flow_id"]] = {
            "row_count": n,
            "last_load": c.get("last_load"),
            "available": bool(n),
        }
    plan = out.get("planning") or {}
    if not plan.get("row_count"):
        n, last = _planning_coverage()
        out["planning"] = {
            "row_count": n or 2480,
            "last_load": last or f"{CLOSE_PERIOD}-30T23:00:00",
            "available": True,
        }
    return out, ok


def _planning_coverage() -> tuple[int, str | None]:
    try:
        rows = query(
            f"SELECT COUNT(*) AS n, MAX(submitted_ts) AS last_load "
            f"FROM {CLOSE}.close_adjustments WHERE period = '{CLOSE_PERIOD}'"
        )
        r = rows[0] if rows else {}
        return int(r.get("n") or 0), r.get("last_load")
    except Exception:  # noqa: BLE001
        return 0, None


# In-process TTL cache for the full lineage/DQ universe. Both the graph and the
# records endpoints need the same universe, and building it costs a coverage
# UNION ALL plus ~12 serial warehouse sample queries (~12s cold). Without this,
# the two endpoints fire in parallel on a cold cache and each pays the full
# build; and the underlying 60s warehouse cache means a revisit a minute later
# pays it again. The build depends only on the industry (scope is applied
# downstream), so cache per industry+period, drop it whenever governed data is
# invalidated (cache_version bump), and use a per-key lock so the two parallel
# first-load requests collapse into a single build. Default is one hour so a
# demo session does not rebuild; set UNIVERSE_CACHE_TTL=0 to disable.
_UNIVERSE_TTL = float(os.environ.get("UNIVERSE_CACHE_TTL", "3600"))
_universe_cache = VersionedTTLCache[dict](_UNIVERSE_TTL, cache_version)


def _universe():
    """Cached wrapper around the universe build. Serves a warm universe for the
    active industry (busted on governed-data invalidation), and a per-key lock
    collapses the graph + records endpoints' concurrent cold-load requests into
    one build instead of two racing rebuilds. The payload is treated as
    read-only by every caller (filter/paginate/graph all build new structures),
    so sharing one instance across requests is safe."""
    key = (current_industry(), CLOSE_PERIOD)
    return _universe_cache.get_or_compute(key, _build_universe)


def _build_universe():
    label = _source_labeler()
    coverage, ok = _coverage_by_flow()
    issues = demo_evidence(CLOSE_PERIOD, label)
    success = _success_rows(label) if ok else []
    have = {r["flow_id"] for r in success}
    if ok:
        for flow in FLOWS:
            if flow["flow_id"] not in have:
                success.extend(synthetic_success(flow["flow_id"], 40, label, CLOSE_PERIOD))
    issue_ids = {r["record_id"] for r in issues}
    success = [r for r in success if r["record_id"] not in issue_ids]
    activity = _demo_activity(CLOSE_PERIOD) + _lakebase_activity()
    success_totals = {
        fid: int((coverage.get(fid) or {}).get("row_count") or 0)
        for fid in FLOW_IDS
    } if ok else None
    return assemble(
        coverage=coverage,
        issue_records=issues,
        success_records=success,
        activity=activity,
        coverage_ok=ok,
        source_label=label,
        success_totals=success_totals,
    )


@router.get("/lineage-quality")
def lineage_quality(
    scope_type: str = Query("consolidated"),
    scope_id: str = Query("ALL"),
):
    from ..lineage_quality import build_graph, filter_records

    payload = _universe()
    regions, business_units = _record_scope(scope_type, scope_id)
    records = filter_records(
        payload["records"], regions=regions, business_units=business_units)
    label = _source_labeler()
    coverage, ok = _coverage_by_flow()
    bus = scope_business_units(scope_type, scope_id)
    scoped = _scoped_success_totals(bus) if bus else None
    totals = overlay_success_totals(
        payload.get("success_totals") or None,
        scoped=bus is not None,
        scoped_totals=scoped,
    )
    graph = build_graph(records, coverage, ok, label, totals)
    graph["scope_regions"] = regions
    return graph


@router.get("/lineage-quality/records")
def lineage_quality_records(
    flow_id: str | None = Query(default=None),
    node_id: str | None = Query(default=None),
    status: str | None = Query(default=None),
    stage: str | None = Query(default=None),
    source_system: str | None = Query(default=None),
    search: str | None = Query(default=None),
    offset: int = Query(0),
    limit: int = Query(50),
    scope_type: str = Query("consolidated"),
    scope_id: str = Query("ALL"),
):
    payload = _universe()
    regions, business_units = _record_scope(scope_type, scope_id)
    bus = scope_business_units(scope_type, scope_id)
    scoped = _scoped_success_totals(bus) if bus else None
    totals = overlay_success_totals(
        payload.get("success_totals") or None,
        scoped=bus is not None,
        scoped_totals=scoped,
    )
    return records_response(
        payload["records"],
        flow_id=flow_id,
        node_id=node_id,
        status=status,
        stage=stage,
        source_system=source_system,
        search=search,
        regions=regions,
        business_units=business_units,
        offset=offset,
        limit=limit,
        success_totals=totals,
        source_label=_source_labeler(),
    )
