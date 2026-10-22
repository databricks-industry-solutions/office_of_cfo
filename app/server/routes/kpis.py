"""Working-capital KPI API (Item 4): DSO / DPO / DIO / Cash Conversion Cycle
with direction-of-travel, scoped to any org node.

The KPI *components* (AR / AP / Inventory balances, Revenue, COGS) are additive,
so we sum them across the requested scope and then compute the (non-additive)
ratios. The trailing trend comes from the governed kpi_history snapshots.
"""
from fastapi import APIRouter, Query

from ..config import SRV_FQ, resolve_period
from ..operating_leverage_forecast import (
    operating_leverage_forecast as get_operating_leverage_forecast,
)
from ..personas import scope_clause
from ..warehouse import query

router = APIRouter()

SRV = SRV_FQ


def _scoped_where(period: str, scope_type: str, scope_id: str, cols: dict) -> str:
    """WHERE period = <p> [AND <scope>] — reporting views are period-aware now."""
    return f" WHERE period = '{period}'" + scope_clause(scope_type, scope_id, cols, prefix=" AND ")

# logical dimension -> column name in working_capital_kpis
_KPI_COLS = {
    "region": "region",
    "legal_entity": "legal_entity_id",
    "business_unit": "business_unit_id",
    "business_line": "business_line",
}

# Cash flow is tracked at BU grain only (cash isn't split by business line), so a
# business_line scope has no matching column and falls back to consolidated.
_CF_COLS = {
    "region": "region",
    "legal_entity": "legal_entity_id",
    "business_unit": "business_unit_id",
}


def _num(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _kpis(ar, ap, inv, rev, cogs, days):
    dso = round(ar / rev * days, 1) if rev else 0.0
    dpo = round(ap / cogs * days, 1) if cogs else 0.0
    dio = round(inv / cogs * days, 1) if cogs else 0.0
    return dso, dpo, dio, round(dso + dio - dpo, 1)


@router.get("/kpis")
def working_capital_kpis(
    scope_type: str = Query("consolidated"),
    scope_id: str = Query("ALL"),
    period: str = Query(None),
):
    p = resolve_period(period)
    where = _scoped_where(p, scope_type, scope_id, _KPI_COLS)
    rows = query(
        f"SELECT COALESCE(SUM(ar_balance),0) AS ar, COALESCE(SUM(ap_balance),0) AS ap, "
        f"COALESCE(SUM(inventory_balance),0) AS inv, COALESCE(SUM(revenue),0) AS rev, "
        f"COALESCE(SUM(cogs),0) AS cogs, COALESCE(SUM(operating_expense),0) AS opex, "
        f"MAX(days_in_period) AS days "
        f"FROM {SRV}.working_capital_kpis{where}")
    r = rows[0] if rows else {}
    ar, ap, inv = _num(r.get("ar")), _num(r.get("ap")), _num(r.get("inv"))
    rev, cogs, opex = _num(r.get("rev")), _num(r.get("cogs")), _num(r.get("opex"))
    days = int(_num(r.get("days")) or 30)
    dso, dpo, dio, ccc = _kpis(ar, ap, inv, rev, cogs, days)

    # Direction-of-travel deltas are computed on the client from the trend series
    # (/kpis/trend), which the Executive page already fetches — so we don't spend
    # a second warehouse round-trip here re-reading the trailing kpi_history rows.
    return {
        "period": p,
        "scope_type": scope_type,
        "scope_id": scope_id,
        "days_in_period": days,
        "components": {
            "ar_balance": round(ar, 2), "ap_balance": round(ap, 2),
            "inventory_balance": round(inv, 2), "revenue": round(rev, 2),
            "cogs": round(cogs, 2), "operating_expense": round(opex, 2),
            "net_income": round(rev - cogs - opex, 2),
        },
        "kpis": {
            "dso": {"value": dso, "delta": None, "better": "lower",
                    "label": "Days Sales Outstanding", "unit": "days"},
            "dpo": {"value": dpo, "delta": None, "better": "higher",
                    "label": "Days Payable Outstanding", "unit": "days"},
            "dio": {"value": dio, "delta": None, "better": "lower",
                    "label": "Days Inventory Outstanding", "unit": "days"},
            "ccc": {"value": ccc, "delta": None, "better": "lower",
                    "label": "Cash Conversion Cycle", "unit": "days"},
        },
    }


def _history_key(scope_type: str, scope_id: str) -> tuple[str, str]:
    if not scope_type or scope_type == "consolidated":
        return "consolidated", "ALL"
    return scope_type, scope_id


@router.get("/kpis/trend")
def kpi_trend(
    scope_type: str = Query("consolidated"),
    scope_id: str = Query("ALL"),
):
    st, sid = _history_key(scope_type, scope_id)
    return query(
        f"SELECT period, dso, dpo, dio, ccc, revenue, opex, net_income "
        f"FROM {SRV}.kpi_history "
        f"WHERE scope_type = '{st}' AND scope_id = '{sid}' "
        f"ORDER BY period")


@router.get("/kpis/operating-leverage/forecast")
def operating_leverage_forecast(
    scope_type: str = Query("consolidated"),
    scope_id: str = Query("ALL"),
):
    return get_operating_leverage_forecast(scope_type, scope_id)


@router.get("/kpis/cashflow")
def cash_flow(
    scope_type: str = Query("consolidated"),
    scope_id: str = Query("ALL"),
    period: str = Query(None),
):
    """Cash-flow reconciliation for the active scope: beginning cash -> collections
    (inflow) -> operating disbursements + capex (outflows) -> ending cash. The
    components are additive, so we SUM them across the scope and they reconcile."""
    p = resolve_period(period)
    where = _scoped_where(p, scope_type, scope_id, _CF_COLS)
    rows = query(
        f"SELECT COALESCE(SUM(beginning_cash),0) AS beginning, "
        f"COALESCE(SUM(collections),0) AS collections, "
        f"COALESCE(SUM(operating_disbursements),0) AS disbursements, "
        f"COALESCE(SUM(capex),0) AS capex, "
        f"COALESCE(SUM(ending_cash),0) AS ending "
        f"FROM {SRV}.cash_flow{where}")
    r = rows[0] if rows else {}
    return {
        "period": p,
        "scope_type": scope_type,
        "scope_id": scope_id,
        "beginning_cash": round(_num(r.get("beginning")), 2),
        "collections": round(_num(r.get("collections")), 2),
        "operating_disbursements": round(_num(r.get("disbursements")), 2),
        "capex": round(_num(r.get("capex")), 2),
        "ending_cash": round(_num(r.get("ending")), 2),
    }


@router.get("/kpis/cashflow/trend")
def cash_flow_trend(
    scope_type: str = Query("consolidated"),
    scope_id: str = Query("ALL"),
):
    """Monthly ending-cash series for the active scope — the actuals side of the
    cash runway chart. Same additive components as /kpis/cashflow, grouped by
    period instead of pinned to the close period."""
    where = scope_clause(scope_type, scope_id, _CF_COLS, prefix=" WHERE ")
    rows = query(
        f"SELECT period, "
        f"COALESCE(SUM(beginning_cash),0) AS beginning_cash, "
        f"COALESCE(SUM(collections),0) AS collections, "
        f"COALESCE(SUM(operating_disbursements),0) AS operating_disbursements, "
        f"COALESCE(SUM(capex),0) AS capex, "
        f"COALESCE(SUM(ending_cash),0) AS ending_cash "
        f"FROM {SRV}.cash_flow{where} "
        f"GROUP BY period ORDER BY period")
    return [
        {
            "period": r.get("period"),
            "beginning_cash": round(_num(r.get("beginning_cash")), 2),
            "collections": round(_num(r.get("collections")), 2),
            "operating_disbursements": round(_num(r.get("operating_disbursements")), 2),
            "capex": round(_num(r.get("capex")), 2),
            "ending_cash": round(_num(r.get("ending_cash")), 2),
        }
        for r in rows
    ]


@router.get("/kpis/breakdown")
def kpi_breakdown(
    scope_type: str = Query("consolidated"),
    scope_id: str = Query("ALL"),
    period: str = Query(None),
):
    """Fine-grained (business-unit x business-line) working-capital components
    within the active scope. The frontend filters these rows by region /
    business line / legal entity and re-aggregates the (additive) components to
    drive the KPI cards, drivers, profitability bridge, and breakdown table
    without a round-trip per filter change."""
    where = _scoped_where(resolve_period(period), scope_type, scope_id, _KPI_COLS)
    rows = query(
        f"SELECT region, legal_entity_id, legal_entity_name, business_line, "
        f"business_unit_id, business_unit_name, "
        f"SUM(ar_balance) AS ar, SUM(ap_balance) AS ap, "
        f"SUM(inventory_balance) AS inv, SUM(revenue) AS rev, SUM(cogs) AS cogs, "
        f"SUM(operating_expense) AS opex, MAX(days_in_period) AS days "
        f"FROM {SRV}.working_capital_kpis{where} "
        f"GROUP BY region, legal_entity_id, legal_entity_name, business_line, "
        f"business_unit_id, business_unit_name")
    out = []
    for r in rows:
        out.append({
            "region": r.get("region") or "Unassigned",
            "legal_entity_id": r.get("legal_entity_id") or "Unassigned",
            "legal_entity_name": r.get("legal_entity_name") or "Unassigned",
            "business_line": r.get("business_line") or "Unassigned",
            "business_unit_id": r.get("business_unit_id") or "Unassigned",
            "business_unit_name": r.get("business_unit_name") or "Unassigned",
            "ar_balance": round(_num(r.get("ar")), 2),
            "ap_balance": round(_num(r.get("ap")), 2),
            "inventory_balance": round(_num(r.get("inv")), 2),
            "revenue": round(_num(r.get("rev")), 2),
            "cogs": round(_num(r.get("cogs")), 2),
            "operating_expense": round(_num(r.get("opex")), 2),
            "days_in_period": int(_num(r.get("days")) or 30),
        })
    return out


@router.get("/kpis/headline")
def headline_kpis(period: str = Query(None)):
    """The active industry's headline KPI tiles (illustrative figures per industry),
    served from that industry's generated headline_kpis view
    for the requested period. Returns [] gracefully if the view is absent (e.g.
    baseline single-industry)."""
    p = resolve_period(period)
    try:
        rows = query(
            f"SELECT kpi_id, label, value, unit, good_direction, delta, segment, sort_order "
            f"FROM {SRV}.headline_kpis WHERE period = '{p}' ORDER BY sort_order")
    except Exception:  # noqa: BLE001
        return {"period": p, "kpis": [], "segments": []}
    tiles, segments = [], []
    for r in rows:
        item = {
            "kpi_id": r.get("kpi_id"),
            "label": r.get("label"),
            "value": _num(r.get("value")),
            "unit": r.get("unit"),
            "good_direction": r.get("good_direction") or "up",
            "delta": None if r.get("delta") is None else _num(r.get("delta")),
            "segment": r.get("segment"),
        }
        (segments if item["segment"] else tiles).append(item)
    return {"period": p, "kpis": tiles, "segments": segments}


@router.get("/kpis/segments")
def kpi_segments(dimension: str = Query("region"), period: str = Query(None)):
    """DSO/DPO/DIO/CCC broken down by a segmentation dimension (region /
    business_line / legal_entity / business_unit) for the requested period."""
    p = resolve_period(period)
    col = {
        "region": "region", "business_line": "business_line",
        "legal_entity": "legal_entity_name", "business_unit": "business_unit_name",
    }.get(dimension, "region")
    rows = query(
        f"SELECT {col} AS segment, SUM(ar_balance) AS ar, SUM(ap_balance) AS ap, "
        f"SUM(inventory_balance) AS inv, SUM(revenue) AS rev, SUM(cogs) AS cogs, "
        f"MAX(days_in_period) AS days "
        f"FROM {SRV}.working_capital_kpis WHERE period = '{p}' GROUP BY {col} ORDER BY {col}")
    out = []
    for r in rows:
        days = int(_num(r.get("days")) or 30)
        dso, dpo, dio, ccc = _kpis(_num(r.get("ar")), _num(r.get("ap")), _num(r.get("inv")),
                                   _num(r.get("rev")), _num(r.get("cogs")), days)
        out.append({
            "segment": r.get("segment") or "Unassigned",
            "dso": dso, "dpo": dpo, "dio": dio, "ccc": ccc,
            "revenue": round(_num(r.get("rev")), 2),
        })
    return out
