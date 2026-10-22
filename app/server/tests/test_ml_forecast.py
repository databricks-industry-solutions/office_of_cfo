"""Tests for the seasonalized ML revenue forecast (ml_forecast).

Warehouse-free: `query` is monkeypatched to return canned history and ai_forecast
rows. Covers the seasonal-index math, the trend x seasonal composition, and the
best-effort fallbacks (too little history / query failure -> empty map).
"""
from __future__ import annotations

import pathlib
import sys

import pytest

_APP = pathlib.Path(__file__).resolve().parents[2]
if str(_APP) not in sys.path:
    sys.path.insert(0, str(_APP))

from server import ml_forecast as mf


def _history(n=24, start=(2024, 7), base=1000.0, slope=10.0, seas=None):
    """Synthetic monthly history: value = (base + slope*i) * seasonal[month]."""
    seas = seas or {m: 1.0 for m in range(1, 13)}
    y, m = start
    rows = []
    for i in range(n):
        period = f"{y:04d}-{m:02d}"
        rows.append({"period": period, "y": str((base + slope * i) * seas[m])})
        m += 1
        if m > 12:
            m, y = 1, y + 1
    return rows


def test_seasonal_factors_normalize_to_mean_one():
    seas = {m: 1.0 for m in range(1, 13)}
    seas[12] = 1.3  # December peak
    seas[9] = 0.7   # September trough
    hist = [(r["period"], float(r["y"])) for r in _history(seas=seas)]
    factors = mf._seasonal_factors(hist)
    assert len(factors) == 12
    assert sum(factors.values()) / 12 == pytest.approx(1.0, abs=1e-9)
    # relative shape is preserved: Dec is the highest, Sept the lowest
    assert max(factors, key=factors.get) == 12
    assert min(factors, key=factors.get) == 9


def test_forecast_applies_seasonal_factor_to_trend(monkeypatch):
    seas = {m: 1.0 for m in range(1, 13)}
    seas[12], seas[9] = 1.3, 0.7
    hist_rows = _history(seas=seas)
    # ai_forecast returns a smooth (seasonless) trend for the horizon months.
    trend = {"2026-07": 1300.0, "2026-08": 1310.0, "2026-09": 1320.0,
             "2026-10": 1330.0, "2026-11": 1340.0, "2026-12": 1350.0}
    fc_rows = [{"ds": f"{p}-01", "y_forecast": str(v)} for p, v in trend.items()]

    def fake_query(sql: str):
        return fc_rows if "ai_forecast(" in sql else hist_rows

    monkeypatch.setattr(mf, "query", fake_query)

    factors = mf._seasonal_factors([(r["period"], float(r["y"])) for r in hist_rows])
    out = mf.forecast_revenue(list(trend))
    assert set(out) == set(trend)
    for p, t in trend.items():
        assert out[p] == pytest.approx(t * factors[int(p[5:7])])
    # the seasonal overlay restores the swing the flat trend lacked
    assert out["2026-12"] > out["2026-09"]


def test_too_little_history_returns_empty(monkeypatch):
    monkeypatch.setattr(mf, "query", lambda sql: _history(n=12))  # only 1 cycle
    assert mf.forecast_revenue(["2026-07", "2026-08"]) == {}


def test_query_failure_returns_empty(monkeypatch):
    def boom(sql: str):
        raise RuntimeError("warehouse down")

    monkeypatch.setattr(mf, "query", boom)
    assert mf.forecast_revenue(["2026-07"]) == {}


def test_empty_periods_returns_empty():
    assert mf.forecast_revenue([]) == {}


@pytest.mark.parametrize("val,expected", [
    ("1", True), ("true", True), ("on", True), ("YES", True),
    ("0", False), ("false", False), ("off", False), ("", True),
])
def test_enabled_reads_env(monkeypatch, val, expected):
    monkeypatch.setenv("SCENARIO_ML_FORECAST", val)
    assert mf.enabled() is expected


def test_enabled_by_default(monkeypatch):
    monkeypatch.delenv("SCENARIO_ML_FORECAST", raising=False)
    assert mf.enabled() is True


def test_result_cached_per_schema_and_horizon(monkeypatch):
    calls = []
    monkeypatch.setattr(mf, "_cache", {})
    monkeypatch.setattr(mf, "_forecast_revenue", lambda periods: calls.append(1) or {p: 1.0 for p in periods})
    assert mf.forecast_revenue(["2026-07"]) == {"2026-07": 1.0}
    assert mf.forecast_revenue(["2026-07"]) == {"2026-07": 1.0}
    assert len(calls) == 1
    mf.forecast_revenue(["2026-07", "2026-08"])  # different horizon -> new model run
    assert len(calls) == 2


def test_failures_not_cached(monkeypatch):
    calls = []
    monkeypatch.setattr(mf, "_cache", {})
    monkeypatch.setattr(mf, "_forecast_revenue", lambda periods: calls.append(1) or {})
    mf.forecast_revenue(["2026-07"]); mf.forecast_revenue(["2026-07"])
    assert len(calls) == 2
