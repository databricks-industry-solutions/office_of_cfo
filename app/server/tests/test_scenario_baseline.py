"""Tests for the baseline provider (scenario_baseline.get_baseline).

Warehouse-free: `query` is monkeypatched with a dispatcher that returns canned rows
per source view (mimicking the string-typed cells the SQL API returns). Asserts the
assembled BaselineSeries uses the app's exact WC definitions and feeds the engine to
a clean tie-out.
"""
from __future__ import annotations

import pathlib
import sys

import pytest

_APP = pathlib.Path(__file__).resolve().parents[2]
if str(_APP) not in sys.path:
    sys.path.insert(0, str(_APP))

from server import scenario_baseline as sb
from server import scenario_engine as eng


def _fake_query(sql: str):
    """Route by source view. Values are strings (as the SQL Execution API returns)."""
    if "income_statement" in sql:
        rows = []
        for p in ("2026-01", "2026-02"):
            for lid, amt in (("revenue", "1000"), ("cogs", "550"), ("opex", "300"),
                             ("interest_income", "5"), ("interest_expense", "8"),
                             ("tax_expense", "34")):
                rows.append({"period": p, "line_id": lid, "amount": amt})
        return rows
    if "account_balance_by_bu" in sql:
        return [{"period": "2026-01", "dna": "40"}, {"period": "2026-02", "dna": "40"}]
    if "budget_forecast" in sql:
        rows = []
        for p in ("2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08",
                  "2026-09", "2026-10", "2026-11", "2026-12"):
            for lid, amt in (("revenue", "1100"), ("cogs", "600"), ("opex", "320")):
                rows.append({"period": p, "line_id": lid, "amount": amt})
        return rows
    if "working_capital_kpis" in sql:
        return [
            {"period": "2026-02", "ar": "1500", "ap": "900", "inv": "1100",
             "rev": "1000", "cogs": "550", "days": "28"},
            {"period": "2025-12", "ar": "1400", "ap": "880", "inv": "1050",
             "rev": "1000", "cogs": "550", "days": "31"},
        ]
    if "cash_flow" in sql:
        return [{"period": "2026-01", "beg": "2000", "end_cash": "1980", "capex": "50"},
                {"period": "2026-02", "beg": "1980", "end_cash": "2010", "capex": "50"}]
    return []


@pytest.fixture
def baseline(monkeypatch):
    monkeypatch.setattr(sb, "query", _fake_query)
    return sb.get_baseline("2026-02")  # hinge=1 (Jan, Feb actual), Mar..Dec forecast


def test_window_and_hinge(baseline):
    assert baseline.periods == [f"2026-{m:02d}" for m in range(1, 13)]
    assert baseline.hinge_index == 1


def test_actuals_from_income_statement_forecast_from_budget(baseline):
    assert baseline.revenue[0] == 1000 and baseline.revenue[1] == 1000    # actuals
    assert baseline.cogs[1] == 550 and baseline.opex[1] == 300
    assert baseline.revenue[2] == 1100 and baseline.cogs[2] == 600        # budgeted forecast
    assert baseline.opex[2] == 320


def test_interest_and_dna_extend_at_run_rate(baseline):
    assert baseline.interest_income[5] == pytest.approx(5.0)   # not budgeted -> run-rate
    assert baseline.interest_expense[5] == pytest.approx(8.0)
    assert baseline.dna[0] == pytest.approx(40.0)
    assert baseline.dna[7] == pytest.approx(40.0)              # forecast run-rate


def test_working_capital_days_use_app_formula(baseline):
    # DSO = ar/rev*days, DPO = ap/cogs*days, DIO = inv/cogs*days, at as_of (2026-02, 28 days).
    assert baseline.dso == pytest.approx(1500 / 1000 * 28)      # 42.0
    assert baseline.dpo == pytest.approx(round(900 / 550 * 28, 1))
    assert baseline.dio == pytest.approx(1100 / 550 * 28)       # 56.0
    assert baseline.days_per_period == pytest.approx(28.0)


def test_opening_balances_from_prior_december(baseline):
    assert baseline.opening_ar == pytest.approx(1400)
    assert baseline.opening_inventory == pytest.approx(1050)
    assert baseline.opening_ap == pytest.approx(880)
    assert baseline.opening_cash == pytest.approx(2000)         # beginning cash of Jan


def test_tax_rate_and_capex_pct_derived_from_actuals(baseline):
    # pbt/period = 1000-550-300+5-8 = 147; 2 periods -> 294; tax 34*2 = 68.
    assert baseline.tax_rate == pytest.approx(68 / 294, abs=1e-3)
    # capex 50+50 over revenue 1000+1000 -> 5.0%.
    assert baseline.capex_pct == pytest.approx(5.0)


def test_posted_ending_cash_for_actual_months_only(baseline):
    assert baseline.posted_cash == [1980.0, 2010.0] + [None] * 10


def test_feeds_engine_and_ties_out(baseline):
    s = eng.project(baseline, {"revenue_growth": 6, "dso": 5})
    # Actual months tie to the books; the forecast rolls on from February's posted cash.
    assert s.lines["cash_balance"][:2] == pytest.approx([1980.0, 2010.0])
    running = baseline.opening_cash
    for i in range(len(baseline.periods)):
        running += s.lines["net_change_in_cash"][i]
        assert s.lines["cash_balance"][i] == pytest.approx(running)


def test_non_consolidated_scope_not_supported_in_l1(monkeypatch):
    monkeypatch.setattr(sb, "query", _fake_query)
    with pytest.raises(NotImplementedError):
        sb.get_baseline("2026-02", scope_type="region", scope_id="EMEA")


def _no_budget_query(sql: str):
    return [] if "budget_forecast" in sql else _fake_query(sql)


def test_ai_revenue_drives_forecast_and_holds_margin(monkeypatch):
    monkeypatch.setattr(sb, "query", _no_budget_query)
    monkeypatch.setattr(sb.ml_forecast, "enabled", lambda: True)
    monkeypatch.setattr(sb.ml_forecast, "forecast_revenue",
                        lambda periods: {p: 1200.0 + 10 * i for i, p in enumerate(periods)})
    b = sb.get_baseline("2026-02")
    assert b.revenue_source == "ai"
    assert b.revenue[2] == pytest.approx(1200.0) and b.revenue[11] == pytest.approx(1290.0)
    # COGS follows AI revenue at the actuals' 55% ratio; opex stays at run-rate.
    assert b.cogs[2] == pytest.approx(1200.0 * 0.55)
    assert b.opex[2] == pytest.approx(300.0)


def test_falls_back_to_run_rate_when_ai_returns_nothing(monkeypatch):
    monkeypatch.setattr(sb, "query", _no_budget_query)
    monkeypatch.setattr(sb.ml_forecast, "enabled", lambda: True)
    monkeypatch.setattr(sb.ml_forecast, "forecast_revenue", lambda periods: {})
    b = sb.get_baseline("2026-02")
    assert b.revenue_source == "run_rate"
    assert b.revenue[5] == pytest.approx(1000.0) and b.cogs[5] == pytest.approx(550.0)


def test_budget_source_reported(baseline):
    assert baseline.revenue_source == "budget"


def test_demo_calendar_does_not_shift_the_close(monkeypatch):
    # Under X-Demo-Today the display calendar runs ahead of the seed; the baseline
    # must still hinge on the seeded close, not close − offset.
    from server import demo_calendar
    monkeypatch.setattr(demo_calendar, "month_offset", lambda *a, **k: 4)
    monkeypatch.setattr(sb, "query", _fake_query)
    monkeypatch.setattr(sb, "CLOSE_PERIOD", "2026-06")
    assert sb.get_baseline(None).hinge_index == 5
    assert sb.get_baseline("2026-02").hinge_index == 1
    assert sb.seed_period("not-a-period") == "2026-06"
