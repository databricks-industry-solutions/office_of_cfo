"""ML revenue forecast for the scenario baseline.

`get_baseline()` fills its forecast months from `budget_forecast`, falling back to
a flat run-rate. That misses both trend and seasonality. This module produces a
per-period revenue forecast that captures both, using only the governed serving
history and warehouse-native compute:

* **Trend** from `ai_forecast()` (a prophet-like piecewise-linear trend, run in the
  SQL warehouse — no ML cluster, no serving endpoint). We pass `global_floor=0`
  so revenue can never be forecast negative.
* **Seasonality** from a seasonal index derived from the same history. `ai_forecast`
  exposes no yearly/monthly seasonality control, and with ~2 annual cycles it
  under-fits the annual shape, so we detrend the history (least-squares line),
  take the ratio-to-trend per calendar month, and multiply the trend forecast by
  that normalized factor. This recovers the real seasonal swing (e.g. the Sept
  trough / Dec peak) that a flat run-rate hides.

Best-effort by contract: any failure (too little history, warehouse error,
`ai_forecast` unavailable) returns an empty map so `get_baseline()` falls back to
budget/run-rate exactly as before. On by default; set `SCENARIO_ML_FORECAST=0` to
fall back to budget/run-rate (kill switch).
"""
from __future__ import annotations

import os
import time

from .config import SRV_FQ
from .warehouse import query

# Need at least two full annual cycles for a stable monthly seasonal index; below
# that we skip the seasonal overlay (and, below the trend minimum, skip entirely).
_MIN_HISTORY_MONTHS = 24

# `ai_forecast` takes ~8-10s and its inputs only change when a month closes, so a
# result is kept per (industry schema, horizon) for an hour — far longer than the
# warehouse's 60s query cache — so dragging a lever never waits on the model.
_CACHE_TTL = float(os.environ.get("ML_FORECAST_CACHE_TTL", "3600"))
_cache: dict[tuple[str, tuple[str, ...]], tuple[float, dict[str, float]]] = {}


def enabled() -> bool:
    """Whether the scenario baseline should use the ML revenue forecast (default on)."""
    return os.environ.get("SCENARIO_ML_FORECAST", "1").strip().lower() not in (
        "0", "false", "no", "off",
    )


def _f(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _horizon_after(period: str) -> str:
    """First day of the month AFTER `period` — ai_forecast forecasts up to (but not
    including) the horizon, so this makes `period` the last month returned."""
    y, m = int(period[:4]), int(period[5:7])
    y2, m2 = (y + 1, 1) if m == 12 else (y, m + 1)
    return f"{y2:04d}-{m2:02d}-01"


def _seasonal_factors(history: list[tuple[str, float]]) -> dict[int, float]:
    """Normalized monthly seasonal index (calendar month -> factor, mean 1.0).

    Least-squares detrend, then average the actual/trend ratio per calendar month.
    Returns {} unless all 12 months are represented (a partial index would bias
    whichever months it covers)."""
    n = len(history)
    ys = [v for _, v in history]
    xs = list(range(n))
    mx = sum(xs) / n
    my = sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx == 0:
        return {}
    b1 = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
    b0 = my - b1 * mx

    ratios: dict[int, list[float]] = {}
    for i, (p, v) in enumerate(history):
        trend = b0 + b1 * i
        if trend > 0:
            ratios.setdefault(int(p[5:7]), []).append(v / trend)
    if len(ratios) < 12:
        return {}
    factors = {m: sum(r) / len(r) for m, r in ratios.items()}
    mean_f = sum(factors.values()) / len(factors)
    if mean_f <= 0:
        return {}
    return {m: factors[m] / mean_f for m in factors}


def forecast_revenue(forecast_periods: list[str]) -> dict[str, float]:
    """Seasonalized revenue forecast for `forecast_periods` (each ``YYYY-MM``).

    Returns {period: revenue} for the periods it can forecast, or {} on any
    failure — the caller treats a missing period as "fall back to budget/run-rate".
    """
    if not forecast_periods:
        return {}
    key = (f"{SRV_FQ}", tuple(forecast_periods))
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < _CACHE_TTL:
        return dict(hit[1])
    out = _forecast_revenue(forecast_periods)
    if out:  # failures aren't cached, so the next call retries
        _cache[key] = (time.monotonic(), out)
    return dict(out)


def _forecast_revenue(forecast_periods: list[str]) -> dict[str, float]:
    try:
        history = [
            (str(r.get("period")), _f(r.get("y")))
            for r in query(
                f"SELECT period, CAST(SUM(amount) AS DOUBLE) AS y "
                f"FROM {SRV_FQ}.income_statement WHERE line_id = 'revenue' "
                f"GROUP BY period ORDER BY period"
            )
            if r.get("y") not in (None, "")
        ]
        if len(history) < _MIN_HISTORY_MONTHS:
            return {}
        factors = _seasonal_factors(history)

        horizon = _horizon_after(forecast_periods[-1])
        trend = {}
        for r in query(
            f"WITH h AS (SELECT to_date(period || '-01') AS ds, "
            f"CAST(SUM(amount) AS DOUBLE) AS y FROM {SRV_FQ}.income_statement "
            f"WHERE line_id = 'revenue' GROUP BY period) "
            f"SELECT ds, y_forecast FROM ai_forecast("
            f"TABLE(h), horizon => '{horizon}', time_col => 'ds', value_col => 'y', "
            f"frequency => 'MS', parameters => '{{\"global_floor\": 0}}') ORDER BY ds"
        ):
            trend[str(r.get("ds"))[:7]] = _f(r.get("y_forecast"))

        out: dict[str, float] = {}
        for p in forecast_periods:
            if p in trend:
                out[p] = trend[p] * factors.get(int(p[5:7]), 1.0)
        return out
    except Exception:  # noqa: BLE001 — best-effort; caller falls back to budget/run-rate
        return {}
