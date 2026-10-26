"""Market Insights endpoints — the FP&A "discover the forecast drivers" surface.

Two reads over the additive serving tables built by
``data_generation/seed_industries.build_market_drivers`` (industry-aware through
``SRV_FQ``, which resolves to ``office_of_cfo.{industry}_serving`` per request):

  GET /market-drivers        -> monthly series for each candidate driver PLUS the
                                forecast target (for the Discover charts:
                                driver-vs-target lines over time).
  GET /driver-sensitivities  -> the LassoCV-fitted driver ranking (for the
                                Quantify view + the "build scenario" handoff).

Both are read-only over synthetic serving data; no scope/period axes (the driver
panel is a standalone 36-month analytical series, independent of the close period).
"""
from fastapi import APIRouter

from ..config import SRV_FQ
from ..warehouse import query

router = APIRouter()

SRV = SRV_FQ


def _f(v):
    """Coerce a warehouse cell (often a string) to float, or None."""
    try:
        return None if v is None or v == "" else float(v)
    except (TypeError, ValueError):
        return None


def _bool(v):
    if isinstance(v, bool):
        return v
    return str(v).strip().lower() in ("true", "t", "1")


@router.get("/market-signals")
def market_signals():
    """Curated 'current' market signals for the active industry, most material
    first. Each signal maps a news headline to a forecast driver; its impact is
    derived from the fitted model (move_sigma x impact_per_sigma) at seed time.
    Returns the net estimated impact on the forecast + per-signal cards."""
    rows = query(
        "SELECT event_id, driver_id, driver_label, category, headline, source, "
        "as_of, move_sigma, impact, direction, target, target_unit, lag_m "
        f"FROM {SRV}.market_events ORDER BY ABS(impact) DESC")
    trow = query(
        f"SELECT series_id, label, unit FROM {SRV}.fact_market_drivers "
        "WHERE is_target LIMIT 1")
    target = {}
    if trow:
        t = trow[0]
        target = {"metric_id": t.get("series_id"), "label": t.get("label"),
                  "unit": t.get("unit")}
    events = [{
        "event_id": r.get("event_id"), "driver_id": r.get("driver_id"),
        "driver_label": r.get("driver_label"), "category": r.get("category"),
        "headline": r.get("headline"), "source": r.get("source"),
        "as_of": r.get("as_of"), "move_sigma": _f(r.get("move_sigma")),
        "impact": _f(r.get("impact")), "direction": r.get("direction"),
        "lag_m": int(_f(r.get("lag_m")) or 0),
    } for r in rows]
    unit = target.get("unit") or (rows[0].get("target_unit") if rows else "")
    net = sum((e["impact"] or 0.0) for e in events)
    return {
        "target": target,
        "as_of": events[0]["as_of"] if events else None,
        "unit": unit,
        "net_impact": round(net, 4),
        "events": events,
    }


@router.get("/driver-sensitivities")
def driver_sensitivities():
    """Fitted driver ranking for the active industry: each candidate driver with
    its standalone correlation, Lasso sensitivity, best lead/lag, per-sigma impact,
    and whether it was selected as a key driver. Selected drivers come first, by
    rank; dropped drivers (decoys / redundant) keep their corr + beta as evidence."""
    rows = query(
        "SELECT driver_id, label, category, unit, target, beta_true, beta_est, "
        "lag_m, corr, r2, selected, `rank`, impact_per_sigma "
        f"FROM {SRV}.driver_sensitivities "
        "ORDER BY selected DESC, `rank` NULLS LAST, ABS(corr) DESC")

    # The target's display label/unit live on the is_target row of the series table.
    trow = query(
        f"SELECT series_id, label, unit FROM {SRV}.fact_market_drivers "
        "WHERE is_target LIMIT 1")
    target = {}
    if trow:
        t = trow[0]
        target = {"metric_id": t.get("series_id"), "label": t.get("label"),
                  "unit": t.get("unit")}

    drivers = [{
        "driver_id": r.get("driver_id"), "label": r.get("label"),
        "category": r.get("category"), "unit": r.get("unit"),
        "lag_m": int(_f(r.get("lag_m")) or 0),
        "corr": _f(r.get("corr")),
        "beta_est": _f(r.get("beta_est")),
        "beta_true": _f(r.get("beta_true")),
        "impact_per_sigma": _f(r.get("impact_per_sigma")),
        "selected": _bool(r.get("selected")),
        "rank": None if _f(r.get("rank")) is None else int(_f(r.get("rank"))),
    } for r in rows]
    r2 = next((_f(r.get("r2")) for r in rows if _f(r.get("r2")) is not None), None)
    return {"target": target, "r2": r2, "drivers": drivers}


@router.get("/market-drivers")
def market_drivers():
    """Monthly series for the active industry: every candidate driver plus the
    forecast target (is_target=true), each aligned to a shared period axis for the
    Discover time-series / dual-axis charts."""
    rows = query(
        "SELECT period, series_id, label, unit, category, value, is_target "
        f"FROM {SRV}.fact_market_drivers ORDER BY series_id, period")
    periods = sorted({r.get("period") for r in rows})

    series: dict[str, dict] = {}
    for r in rows:
        sid = r.get("series_id")
        s = series.get(sid)
        if s is None:
            s = series[sid] = {
                "series_id": sid, "label": r.get("label"), "unit": r.get("unit"),
                "category": r.get("category"), "is_target": _bool(r.get("is_target")),
                "points": {},
            }
        s["points"][r.get("period")] = _f(r.get("value"))

    def _vals(s):
        return [s["points"].get(p) for p in periods]

    target = next((s for s in series.values() if s["is_target"]), None)
    drivers = [s for s in series.values() if not s["is_target"]]
    return {
        "periods": periods,
        "target": None if target is None else {
            "series_id": target["series_id"], "label": target["label"],
            "unit": target["unit"], "values": _vals(target)},
        "drivers": [{
            "series_id": s["series_id"], "label": s["label"], "unit": s["unit"],
            "category": s["category"], "values": _vals(s)} for s in drivers],
    }
