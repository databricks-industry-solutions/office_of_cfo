"""Per-request demo calendar: offset, seed-equivalent today, comparison windows."""
from __future__ import annotations

import contextvars
import pathlib
import sys
from datetime import date

import pytest

_APP = pathlib.Path(__file__).resolve().parents[2]
if str(_APP) not in sys.path:
    sys.path.insert(0, str(_APP))

from server import config
from server.demo_calendar import (
    display_window_months,
    month_offset,
    seed_months,
    seed_today,
    set_browser_today,
    shift_date,
    to_display_period,
    to_seed_period,
)
from server.routes import statements, tasks


@pytest.fixture(autouse=True)
def _clear_browser_today():
    set_browser_today(None)
    yield
    set_browser_today(None)


def test_missing_header_keeps_frozen_clock():
    assert month_offset() == 0
    assert seed_today() is None
    assert config.demo_today() == date(2026, 7, 15)
    assert config.resolve_period("2026-06") == "2026-06"


def test_invalid_header_is_ignored():
    set_browser_today("26-08-2026")
    assert month_offset() == 0
    assert config.demo_today() == date(2026, 7, 15)


def test_august_offset_and_seed_today():
    set_browser_today("2026-08-26")
    assert month_offset() == 2
    assert to_seed_period("2026-08") == "2026-06"
    assert to_display_period("2026-06") == "2026-08"
    assert to_seed_period("2026-07") == "2026-05"
    assert to_seed_period("2025-08") == "2025-06"
    assert seed_today() == date(2026, 6, 26)
    assert config.demo_today() == date(2026, 6, 26)
    assert config.resolve_period("2026-08") == "2026-06"


def test_close_cycle_clock_preserves_seeded_stage():
    set_browser_today("2026-08-26")
    assert config.demo_today() == date(2026, 6, 26)
    assert config.demo_close_today() == date(2026, 7, 15)


def test_burndown_uses_close_cycle_clock(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(tasks, "demo_close_today", lambda: date(2026, 7, 15))
    rows = [
        {"status": "DONE", "due_date": "2026-07-10", "completed_ts": "2026-07-10"},
        {"status": "NOT_STARTED", "due_date": "2026-07-17", "completed_ts": None},
    ]
    result = tasks._compute_burndown(rows)
    assert result["today"] == "2026-07-15"
    assert result["today_t"] == 11


def test_september_offset():
    set_browser_today("2026-09-01")
    assert month_offset() == 3
    assert to_seed_period("2026-09") == "2026-06"


def test_year_rollover_and_month_end_clamp():
    assert shift_date(date(2026, 6, 30), 2) == date(2026, 8, 31)
    assert shift_date(date(2024, 2, 29), 12) == date(2025, 2, 28)
    set_browser_today("2026-08-31")
    assert seed_today() == date(2026, 6, 30)


def test_request_contexts_are_isolated():
    def req_aug():
        set_browser_today("2026-08-26")
        return month_offset()

    def req_sep():
        set_browser_today("2026-09-15")
        return month_offset()

    assert contextvars.Context().run(req_aug) == 2
    assert contextvars.Context().run(req_sep) == 3
    assert month_offset() == 0


def test_middleware_sets_offset_header():
    from fastapi import FastAPI, Request
    from fastapi.testclient import TestClient

    mini = FastAPI()

    @mini.middleware("http")
    async def _demo(request: Request, call_next):
        set_browser_today(request.headers.get("X-Demo-Today"))
        response = await call_next(request)
        response.headers["X-Demo-Month-Offset"] = str(month_offset())
        return response

    @mini.get("/ok")
    def ok():
        return {"period": config.resolve_period("2026-08")}

    c = TestClient(mini)
    r = c.get("/ok", headers={"X-Demo-Today": "2026-08-26"})
    assert r.headers["X-Demo-Month-Offset"] == "2"
    assert r.json()["period"] == "2026-06"
    r2 = c.get("/ok")
    assert r2.headers["X-Demo-Month-Offset"] == "0"


def test_qtd_display_is_quarter_to_date():
    set_browser_today("2026-08-26")
    display = to_display_period("2026-06")
    assert display == "2026-08"
    assert display_window_months("qtd", display) == ["2026-07", "2026-08"]
    assert seed_months(["2026-07", "2026-08"]) == ["2026-05", "2026-06"]
    # June (offset 0) still sums the full completed Q2.
    set_browser_today(None)
    assert display_window_months("qtd", "2026-06") == ["2026-04", "2026-05", "2026-06"]


def test_ytd_maps_display_jan_through_current_to_seed(monkeypatch: pytest.MonkeyPatch):
    seen: list[str] = []

    def fake_query(sql: str):
        seen.append(sql)
        return [{"line_id": "revenue", "line_label": "Revenue", "sort_order": 10, "amount": 1}]

    monkeypatch.setattr(statements, "query", fake_query)
    monkeypatch.setattr(statements, "scope_clause", lambda *args, **kwargs: "")
    set_browser_today("2026-08-26")
    out = statements.comparative_statement(
        "income", window="ytd", compare="prior_year", period="2026-08")
    actual_sql = seen[0]
    for month in ("2025-11", "2025-12", "2026-01", "2026-06"):
        assert f"'{month}'" in actual_sql
    assert out["period"] == "2026-06"
    assert out["actual_period"] == "2026 YTD"


def test_qtd_maps_display_quarter_not_seed_q2(monkeypatch: pytest.MonkeyPatch):
    seen: list[str] = []

    def fake_query(sql: str):
        seen.append(sql)
        return [{"line_id": "revenue", "line_label": "Revenue", "sort_order": 10, "amount": 1}]

    monkeypatch.setattr(statements, "query", fake_query)
    monkeypatch.setattr(statements, "scope_clause", lambda *args, **kwargs: "")
    set_browser_today("2026-08-26")
    out = statements.comparative_statement(
        "income", window="qtd", compare="prior", period="2026-08")
    assert "period IN ('2026-05', '2026-06')" in seen[0]
    assert "period IN ('2026-02', '2026-03')" in seen[1]
    assert out["actual_period"] == "2026-Q3"
    assert out["compare_period"] == "2026-Q2"


def test_mtd_prior_is_one_seed_month_back(monkeypatch: pytest.MonkeyPatch):
    seen: list[str] = []

    def fake_query(sql: str):
        seen.append(sql)
        return [{"line_id": "revenue", "line_label": "Revenue", "sort_order": 10, "amount": 1}]

    monkeypatch.setattr(statements, "query", fake_query)
    monkeypatch.setattr(statements, "scope_clause", lambda *args, **kwargs: "")
    set_browser_today("2026-08-26")
    out = statements.comparative_statement(
        "income", window="mtd", compare="prior", period="2026-08")
    assert "period IN ('2026-06')" in seen[0]
    assert "period IN ('2026-05')" in seen[1]
    assert out["period"] == "2026-06"
    assert out["actual_period"] == "2026-06"
    assert out["compare_period"] == "2026-05"


def test_comparative_without_header_stays_on_seed_june(monkeypatch: pytest.MonkeyPatch):
    seen: list[str] = []
    monkeypatch.setattr(statements, "query", lambda sql: seen.append(sql) or [
        {"line_id": "revenue", "line_label": "Revenue", "sort_order": 10, "amount": 1}])
    monkeypatch.setattr(statements, "scope_clause", lambda *args, **kwargs: "")
    out = statements.comparative_statement(
        "income", window="mtd", compare="prior", period="2026-06")
    assert "period IN ('2026-06')" in seen[0]
    assert "period IN ('2026-05')" in seen[1]
    assert out["actual_period"] == "2026-06"
