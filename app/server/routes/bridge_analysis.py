"""Bridge Analysis endpoints — price/volume/mix (PVM) driver decomposition.

Its own router (like variance_dashboard.py) so PVM work merges independently and
`statements.py` stays untouched. Reuses the comparative period helpers from
statements.py by import.

TIER 1.5 — COGS rate × volume. The inventory subledger carries per-row
`unit_cost`, `cogs_amount`, `sku`, so we can recover units (cogs_amount /
unit_cost) and split the COGS movement between a RATE effect (unit cost changed)
and a VOLUME effect (we consumed more/fewer units) using a sequential, mix-as-
residual decomposition that ties out exactly to the subledger COGS variance:

    rate_effect   = Σ (cost₁ − cost₀) × qty₁      (revalue current volume)
    volume_effect = (qty₁ − qty₀) × avg_cost₀      (volume Δ at prior avg cost)
    residual      = totalΔ − rate − volume         (mix / interaction; ~0 at the
                                                     aggregate grain used here)

NOTE ON RECONCILIATION: this is the COGS that flows FROM the inventory subledger.
The income-statement COGS line (GL 50000) also carries manual adjustments and the
seeded recon break, so the two won't match to the penny. The response therefore
reports both the subledger total and (best-effort) the P&L COGS variance so the
UI can show an honest tie-out rather than implying an exact match.
"""
from fastapi import APIRouter, Query

from ..config import CLOSE_FQ, resolve_period
from ..personas import scope_clause
from ..warehouse import query
from ..demo_calendar import display_window_months, seed_months
from .statements import (
    _f,
    _seed_window_months,
    _shift_period,
    _window_label,
    _window_shift,
    comparative_statement,
    resolve_window_compare,
)

router = APIRouter()

CLOSE = CLOSE_FQ

# Inventory carries business_unit_id + business_line inline; region / legal_entity
# live on dim_org, so those scopes join through the org dimension.
_INV_DIRECT = {"business_unit": "i.business_unit_id", "business_line": "i.business_line"}
_ORG_SCOPED = {"region": "o.region", "legal_entity": "o.legal_entity_id",
               "business_unit": "i.business_unit_id", "business_line": "i.business_line"}


def _bridge_periods(window: str, compare: str, p: str) -> tuple[list[str], list[str], str]:
    """(actual_periods, compare_periods, compare_label) for a (window, compare)
    pair. The actual side sums the window's months; the compare side shifts each
    of those months back (12 for prior_year, else the window's sequential shift).
    Budget compare is unsupported here (no budgeted units/cost) — callers coerce
    it away first."""
    act, display = _seed_window_months(window, p)
    shift = 12 if compare == "prior_year" else _window_shift(window)
    act_display = display_window_months(window, display)
    cmp_display = [_shift_period(m, shift) for m in act_display]
    cmp = seed_months(cmp_display)
    label_src = cmp[-1] if window == "mtd" else cmp_display[-1]
    return act, cmp, _window_label(window, label_src)


def _inv_cost_qty(periods: list[str], scope_type: str, scope_id: str) -> tuple[float, float]:
    """Total COGS $ and total units from the inventory subledger over `periods`,
    within scope. Units = Σ cogs_amount / unit_cost (per row, so mixed unit costs
    aggregate correctly). Region/legal-entity scope joins dim_org."""
    plist = ", ".join(f"'{p}'" for p in periods)
    needs_org = scope_type in ("region", "legal_entity")
    cols = _ORG_SCOPED if needs_org else _INV_DIRECT
    where = scope_clause(scope_type, scope_id, cols, prefix=" AND ")
    join = (f"JOIN {CLOSE}.dim_org o ON i.business_unit_id = o.business_unit_id "
            if needs_org else "")
    rows = query(
        "SELECT ROUND(SUM(i.cogs_amount), 2) AS cogs, "
        "ROUND(SUM(CASE WHEN i.unit_cost > 0 THEN i.cogs_amount / i.unit_cost ELSE 0 END), 4) AS qty "
        f"FROM {CLOSE}.subledger_inventory i {join}"
        f"WHERE i.period IN ({plist}){where}")
    if not rows:
        return 0.0, 0.0
    return _f(rows[0].get("cogs")), _f(rows[0].get("qty"))


@router.get("/bridge/cogs")
def cogs_bridge(basis: str = Query(None),
                window: str = Query(None), compare: str = Query(None),
                scope_type: str = Query("consolidated"), scope_id: str = Query("ALL"),
                period: str = Query(None)):
    """COGS rate × volume bridge from the inventory subledger.

    Honours the (window, compare) axes (legacy `basis` still accepted). Returns the
    anchor (prior COGS), the rate & volume effects, a residual, the actual COGS,
    and a best-effort tie-out to the income-statement COGS variance. Budget compare
    isn't defined here (no budgeted units/cost), so it coerces to prior."""
    p = resolve_period(period)
    # Resolve axes as the income statement would, then drop budget (unsupported).
    w, c = resolve_window_compare("income", window, compare, basis)
    if c == "budget":
        c = "prior"
        # a sequential prior for qtd/ytd may itself remap; re-resolve cleanly
        w, c = resolve_window_compare("income", w, "prior", None)
    act_periods, cmp_periods, cmp_label = _bridge_periods(w, c, p)

    cogs1, qty1 = _inv_cost_qty(act_periods, scope_type, scope_id)
    cogs0, qty0 = _inv_cost_qty(cmp_periods, scope_type, scope_id)

    total = round(cogs1 - cogs0, 2)
    avg0 = cogs0 / qty0 if qty0 else 0.0          # prior average unit cost
    avg1 = cogs1 / qty1 if qty1 else 0.0          # current average unit cost
    # Sequential decomposition (rate at current volume, volume at prior avg cost).
    rate_effect = round((avg1 - avg0) * qty1, 2)
    volume_effect = round((qty1 - qty0) * avg0, 2)
    residual = round(total - rate_effect - volume_effect, 2)

    # Best-effort P&L COGS variance for the honest tie-out (income statement,
    # same window/compare/scope). The `cogs` line is a positive magnitude here.
    pnl_cogs_var = None
    try:
        data = comparative_statement("income", window=w, compare=c, scope_type=scope_type,
                                     scope_id=scope_id, period=period)
        if isinstance(data, dict):
            row = next((r for r in data.get("lines", []) if r.get("line_id") == "cogs"), None)
            if row and row.get("var_abs") is not None:
                pnl_cogs_var = round(_f(row["var_abs"]), 2)
    except Exception:  # noqa: BLE001 — tie-out is informational, never fail the bridge
        pnl_cogs_var = None

    return {
        "basis": None, "window": w, "compare": c, "period": p, "compare_period": cmp_label,
        "anchor": round(cogs0, 2), "actual": round(cogs1, 2),
        "total_var": total,
        "rate_effect": rate_effect,
        "volume_effect": volume_effect,
        "residual": residual,
        "qty_prior": round(qty0, 2), "qty_actual": round(qty1, 2),
        "avg_cost_prior": round(avg0, 4), "avg_cost_actual": round(avg1, 4),
        "pnl_cogs_var": pnl_cogs_var,   # None if unavailable
    }
