"""Variance dashboard endpoints (the graphical "why did the number move" view).

Kept in its own module — separate from `statements.py` — so this feature can be
developed and merged independently while others work on the core statement
endpoints. It adds NO new statement logic; it reuses the comparative machinery
already in `statements.py` (the `/comparative` aggregation, the biggest-driver
picker, and the BU×region attribution) and only exposes a driver/attribution
endpoint the frontend variance dashboard needs.

Because it reuses those helpers by import, `statements.py` stays untouched. If a
helper there is renamed, this import fails loudly at startup rather than silently
drifting.
"""
from fastapi import APIRouter, Query

from ..config import resolve_period
from .statements import (
    _biggest_driver,
    _line_drivers,
    _window_driver_periods,
    comparative_statement,
)

router = APIRouter()


@router.get("/statements/{stmt}/comparative/drivers")
def comparative_drivers(
    stmt: str, basis: str = Query(None),
    window: str = Query(None), compare: str = Query(None),
    scope_type: str = Query("consolidated"), scope_id: str = Query("ALL"),
    period: str = Query(None),
    line_id: str | None = Query(default=None),
    top: int = Query(default=6),
):
    """Break a statement line's variance down by business unit × region, for the
    tornado attribution chart. Defaults to the biggest-moving line (the same one
    the AI commentary narrates); pass `line_id` to attribute a specific line.

    Honours the (window, compare) axes (legacy `basis` still accepted). Warehouse-
    only. Budget compare is unsupported (budget_forecast isn't at BU/region grain
    in the statement views), so it returns an empty driver set there."""
    data = comparative_statement(stmt, basis=basis, window=window, compare=compare,
                                 scope_type=scope_type, scope_id=scope_id, period=period)
    if not isinstance(data, dict):
        return {"line_id": None, "line_label": None, "drivers": []}
    lines = data.get("lines", [])
    eff_window = data.get("window", "mtd")
    eff_compare = data.get("compare", "prior")
    p = data.get("period", resolve_period(period))

    target = None
    if line_id:
        target = next((r for r in lines if r.get("line_id") == line_id), None)
    if target is None:
        target = _biggest_driver(lines)
    if target is None or eff_compare == "budget":
        return {"line_id": None, "line_label": None, "drivers": []}

    act_periods, cmp_periods = _window_driver_periods(stmt, eff_window, eff_compare, p)
    try:
        drivers = _line_drivers(stmt, target["line_id"], act_periods, cmp_periods,
                                scope_type, scope_id, top=top)
    except Exception:  # noqa: BLE001 — attribution is best-effort
        drivers = []
    return {"line_id": target["line_id"], "line_label": target["line_label"],
            "window": eff_window, "compare": eff_compare, "period": p, "drivers": drivers}
