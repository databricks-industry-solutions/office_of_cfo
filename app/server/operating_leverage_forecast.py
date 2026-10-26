"""Governed, scope-aware three-month Operating Leverage forecast.

Revenue uses the same warehouse-native trend plus monthly seasonal overlay as the
scenario baseline. Costs remain driver-based: non-opex costs hold their trailing
share of revenue while opex holds its trailing run rate. The chart can therefore
show operating leverage without inventing daily observations.
"""
from __future__ import annotations

import os
import time

from . import ml_forecast
from .config import SRV_FQ, resolve_period
from .personas import is_valid_scope
from .warehouse import query

HORIZON_MONTHS = 3
MIN_HISTORY_MONTHS = 24
TRAILING_COST_MONTHS = 3
_CACHE_TTL = float(os.environ.get("OPERATING_LEVERAGE_FORECAST_CACHE_TTL", "3600"))
_cache: dict[tuple[str, str, str, str, int], tuple[float, dict]] = {}

_SCOPE_TYPES = {
    "region",
    "legal_entity",
    "business_unit",
    "business_line",
}


def _f(value) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def periods_after(period: str, count: int = HORIZON_MONTHS) -> list[str]:
    """Return the next ``count`` monthly periods after a YYYY-MM period."""
    year, month = int(period[:4]), int(period[5:7])
    periods = []
    for _ in range(count):
        month += 1
        if month == 13:
            year += 1
            month = 1
        periods.append(f"{year:04d}-{month:02d}")
    return periods


def _scope_key(scope_type: str, scope_id: str) -> tuple[str, str]:
    if scope_type in _SCOPE_TYPES and is_valid_scope(scope_type, scope_id):
        return scope_type, scope_id
    return "consolidated", "ALL"


def _unavailable(as_of: str, reason: str) -> dict:
    return {
        "status": "unavailable",
        "source": None,
        "as_of": as_of,
        "horizon_months": HORIZON_MONTHS,
        "points": [],
        "reason": reason,
    }


def operating_leverage_forecast(
    scope_type: str = "consolidated",
    scope_id: str = "ALL",
) -> dict:
    """Return a cached governed forecast for the requested org scope."""
    st, sid = _scope_key(scope_type, scope_id)
    close = resolve_period(None)
    key = (str(SRV_FQ), st, sid, close, HORIZON_MONTHS)
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < _CACHE_TTL:
        return dict(hit[1])
    result = _build_forecast(st, sid, close)
    if result["status"] == "available":
        _cache[key] = (time.monotonic(), result)
    return dict(result)


def _build_forecast(scope_type: str, scope_id: str, close: str) -> dict:
    history = query(
        f"SELECT period, revenue, opex, net_income "
        f"FROM {SRV_FQ}.kpi_history "
        f"WHERE scope_type = '{scope_type}' AND scope_id = '{scope_id}' "
        f"AND period <= '{close}' ORDER BY period"
    )
    if not history:
        return _unavailable(close, "no_history")

    as_of = str(history[-1].get("period") or close)
    if len(history) < MIN_HISTORY_MONTHS:
        return _unavailable(as_of, "insufficient_history")
    if not ml_forecast.enabled():
        return _unavailable(as_of, "forecast_disabled")

    forecast_periods = periods_after(as_of)
    horizon = ml_forecast._horizon_after(forecast_periods[-1])
    try:
        raw_forecast = query(
            f"WITH h AS ("
            f"SELECT to_date(period || '-01') AS ds, CAST(revenue AS DOUBLE) AS y "
            f"FROM {SRV_FQ}.kpi_history "
            f"WHERE scope_type = '{scope_type}' AND scope_id = '{scope_id}' "
            f"AND period <= '{close}') "
            f"SELECT ds, y_forecast FROM ai_forecast("
            f"TABLE(h), horizon => '{horizon}', time_col => 'ds', value_col => 'y', "
            f"frequency => 'MS', parameters => '{{\"global_floor\": 0}}') ORDER BY ds"
        )
    except Exception:  # noqa: BLE001 - best effort, surfaced as unavailable
        return _unavailable(as_of, "forecast_unavailable")

    trend = {
        str(row.get("ds"))[:7]: _f(row.get("y_forecast"))
        for row in raw_forecast
        if row.get("y_forecast") not in (None, "")
    }
    seasonal = ml_forecast._seasonal_factors([
        (str(row.get("period")), _f(row.get("revenue")))
        for row in history
    ])
    revenues = {
        period: trend[period] * seasonal.get(int(period[5:7]), 1.0)
        for period in forecast_periods
        if period in trend
    }
    if len(revenues) != HORIZON_MONTHS:
        return _unavailable(as_of, "forecast_unavailable")

    trailing = history[-TRAILING_COST_MONTHS:]
    cost_ratios = []
    for row in trailing:
        revenue = _f(row.get("revenue"))
        if revenue > 0:
            other_cost = revenue - _f(row.get("opex")) - _f(row.get("net_income"))
            cost_ratios.append(other_cost / revenue)
    if not cost_ratios:
        return _unavailable(as_of, "invalid_history")
    other_cost_ratio = sum(cost_ratios) / len(cost_ratios)
    opex_run_rate = sum(_f(row.get("opex")) for row in trailing) / len(trailing)

    points = []
    for period in forecast_periods:
        revenue = revenues[period]
        opex = opex_run_rate
        net_income = revenue * (1 - other_cost_ratio) - opex
        points.append({
            "period": period,
            "revenue": round(revenue, 2),
            "opex": round(opex, 2),
            "net_income": round(net_income, 2),
            "net_margin_pct": round(net_income / revenue * 100, 4) if revenue else 0.0,
        })

    return {
        "status": "available",
        "source": "ai_seasonal_revenue_modeled_costs",
        "as_of": as_of,
        "horizon_months": HORIZON_MONTHS,
        "points": points,
    }
