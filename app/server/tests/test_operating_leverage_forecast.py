"""Warehouse-free tests for the governed Operating Leverage forecast."""
from __future__ import annotations

import pathlib
import sys

import pytest

_APP = pathlib.Path(__file__).resolve().parents[2]
if str(_APP) not in sys.path:
    sys.path.insert(0, str(_APP))

from server import operating_leverage_forecast as olf
from server.routes import kpis


def _history(n: int = 24, start: tuple[int, int] = (2024, 7)) -> list[dict]:
    year, month = start
    rows = []
    for i in range(n):
        revenue = 1_000.0 + i * 10.0
        opex = 300.0
        other_cost = revenue * 0.5
        rows.append({
            "period": f"{year:04d}-{month:02d}",
            "revenue": str(revenue),
            "opex": str(opex),
            "net_income": str(revenue - other_cost - opex),
        })
        month += 1
        if month == 13:
            year += 1
            month = 1
    return rows


def test_periods_after_rolls_across_year_end():
    assert olf.periods_after("2026-11", 3) == ["2026-12", "2027-01", "2027-02"]


def test_forecast_returns_three_governed_months_for_requested_scope(monkeypatch):
    history = _history()
    forecast_rows = [
        {"ds": "2026-07-01", "y_forecast": "1300"},
        {"ds": "2026-08-01", "y_forecast": "1320"},
        {"ds": "2026-09-01", "y_forecast": "1340"},
    ]
    seen_sql: list[str] = []

    def fake_query(sql: str):
        seen_sql.append(sql)
        return forecast_rows if "ai_forecast(" in sql else history

    monkeypatch.setattr(olf, "query", fake_query)
    monkeypatch.setattr(olf.ml_forecast, "enabled", lambda: True)
    monkeypatch.setattr(olf, "_cache", {})

    result = olf.operating_leverage_forecast("region", "EMEA")

    assert result["status"] == "available"
    assert result["source"] == "ai_seasonal_revenue_modeled_costs"
    assert result["as_of"] == "2026-06"
    assert result["horizon_months"] == 3
    assert [p["period"] for p in result["points"]] == [
        "2026-07", "2026-08", "2026-09",
    ]
    assert all(p["revenue"] > 0 and p["net_margin_pct"] > 0 for p in result["points"])
    assert any("scope_type = 'region'" in sql and "scope_id = 'EMEA'" in sql for sql in seen_sql)


def test_forecast_is_unavailable_without_two_years_of_history(monkeypatch):
    monkeypatch.setattr(olf, "query", lambda sql: _history(n=12))
    monkeypatch.setattr(olf.ml_forecast, "enabled", lambda: True)
    monkeypatch.setattr(olf, "_cache", {})

    result = olf.operating_leverage_forecast("consolidated", "ALL")

    assert result == {
        "status": "unavailable",
        "source": None,
        "as_of": "2025-06",
        "horizon_months": 3,
        "points": [],
        "reason": "insufficient_history",
    }


def test_forecast_is_unavailable_when_model_returns_no_points(monkeypatch):
    monkeypatch.setattr(
        olf,
        "query",
        lambda sql: [] if "ai_forecast(" in sql else _history(),
    )
    monkeypatch.setattr(olf.ml_forecast, "enabled", lambda: True)
    monkeypatch.setattr(olf, "_cache", {})

    result = olf.operating_leverage_forecast("consolidated", "ALL")

    assert result["status"] == "unavailable"
    assert result["reason"] == "forecast_unavailable"
    assert result["points"] == []


def test_route_forwards_scope_to_forecast_service(monkeypatch):
    expected = {
        "status": "available",
        "source": "ai_seasonal_revenue_modeled_costs",
        "as_of": "2026-06",
        "horizon_months": 3,
        "points": [],
    }
    seen: list[tuple[str, str]] = []
    monkeypatch.setattr(
        kpis,
        "get_operating_leverage_forecast",
        lambda scope_type, scope_id: seen.append((scope_type, scope_id)) or expected,
    )

    assert kpis.operating_leverage_forecast("business_unit", "BU-100") == expected
    assert seen == [("business_unit", "BU-100")]


def test_forecast_cache_is_scoped_by_industry_scope_and_close(monkeypatch):
    calls = []
    monkeypatch.setattr(olf, "_cache", {})
    monkeypatch.setattr(
        olf,
        "_build_forecast",
        lambda *args: calls.append(args) or {
            "status": "available",
            "source": "ai_seasonal_revenue_modeled_costs",
            "as_of": "2026-06",
            "horizon_months": 3,
            "points": [],
        },
    )

    olf.operating_leverage_forecast("region", "EMEA")
    olf.operating_leverage_forecast("region", "EMEA")
    olf.operating_leverage_forecast("region", "APAC")

    assert len(calls) == 2
