"""13-Week Cash API (treasury, direct method).

Read-only: `treasury_inputs.get_inputs` does the warehouse reads, the pure
`treasury_engine.forecast` does the math. No Lakebase — overrides and rule editing
are later phases. Dates are returned on the seed calendar plus a `display_*` twin
shifted onto the demo calendar (X-Demo-Today), like the rest of the app.
"""
from datetime import date

from fastapi import APIRouter, Query

from ..demo_calendar import month_offset, shift_date, shift_period
from ..treasury_engine import forecast
from ..treasury_inputs import get_inputs

router = APIRouter()


def _display(iso: str, offset: int) -> str:
    return shift_date(date.fromisoformat(iso), offset).isoformat() if offset else iso


@router.get("/treasury/13w")
def thirteen_week(as_of: str = Query(None), min_cash: float = Query(None)):
    """13-week cash grid + open-invoice detail + month 1–3 tie-out to FP&A."""
    out = forecast(get_inputs(as_of, min_cash=min_cash))
    off = month_offset()
    out["display_as_of"] = _display(out["as_of"], off)
    for w in out["weeks"]:
        w["display_start"], w["display_end"] = _display(w["start"], off), _display(w["end"], off)
    for i in out["items"]:
        i["display_expected_date"] = _display(i["expected_date"], off)
        i["display_due_date"] = _display(i["due_date"], off)
    for m in out["reconciliation"]:
        m["display_period"] = shift_period(m["period"], off)
    return out
