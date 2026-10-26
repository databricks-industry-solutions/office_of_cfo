"""13-Week Cash API (treasury, direct method).

Read-only: `treasury_inputs.get_inputs` does the warehouse reads, the pure
`treasury_engine.forecast` does the math. No Lakebase — overrides and rule editing
are later phases. Dates are returned on the seed calendar plus a `display_*` twin
on the demo calendar (X-Demo-Today). Only the close date is month-shifted; every
other date moves by the same number of days, so weeks stay seven days apart on
screen (a per-date month shift would make them uneven across month ends).
"""
from datetime import date, timedelta

from fastapi import APIRouter, Query

from ..demo_calendar import month_offset, shift_date, shift_period
from ..treasury_engine import forecast
from ..treasury_inputs import get_inputs

router = APIRouter()


@router.get("/treasury/13w")
def thirteen_week(as_of: str = Query(None), min_cash: float = Query(None)):
    """13-week cash grid + open-invoice detail + month 1–3 tie-out to FP&A."""
    out = forecast(get_inputs(as_of, min_cash=min_cash))
    off = month_offset()
    close = date.fromisoformat(out["as_of"])
    shift = timedelta(days=(shift_date(close, off) - close).days if off else 0)

    def _display(iso: str) -> str:
        return (date.fromisoformat(iso) + shift).isoformat()

    out["display_as_of"] = _display(out["as_of"])
    for w in out["weeks"]:
        w["display_start"], w["display_end"] = _display(w["start"]), _display(w["end"])
    for i in out["items"]:
        i["display_expected_date"] = _display(i["expected_date"])
        i["display_due_date"] = _display(i["due_date"])
    for m in out["reconciliation"]:
        m["display_period"] = shift_period(m["period"], off)
    return out
