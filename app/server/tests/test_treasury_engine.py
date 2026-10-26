"""Tests for the 13-Week Cash engine (treasury_engine) and its input provider.

Engine tests are pure (hand-built TreasuryInputs). The provider test monkeypatches
`query` with canned, string-typed rows like the SQL Execution API returns.
"""
from __future__ import annotations

import pathlib
import sys
from dataclasses import replace
from datetime import date, timedelta

import pytest

_APP = pathlib.Path(__file__).resolve().parents[2]
if str(_APP) not in sys.path:
    sys.path.insert(0, str(_APP))

from server import treasury_engine as te
from server import treasury_inputs as ti

AS_OF = date(2026, 6, 30)  # Tuesday


def _inv(ledger, i, cp, amount, inv_date, terms=30, paid_offset=None):
    due = inv_date + timedelta(days=terms)
    paid = due + timedelta(days=paid_offset) if paid_offset is not None else None
    return te.Invoice(ledger, f"{ledger}-{i}", cp, amount, terms, inv_date, due, paid)


def _history(ledger, cp, lag, n=20, terms=30):
    """n settled invoices for `cp` paying `lag` days vs due, all before the close."""
    start = date(2025, 1, 1)
    return [_inv(ledger, f"{cp}-{k}", cp, 1000.0, start + timedelta(days=7 * k), terms, lag)
            for k in range(n)]


def _inputs(invoices, **kw):
    base = dict(as_of=AS_OF, opening_cash=10_000.0, invoices=invoices, fixed=[],
                other_daily={}, revenue_forecast={})
    base.update(kw)
    return te.TreasuryInputs(**base)


# ---------------------------------------------------------------- payment habit
def test_profile_learns_counterparty_lag_and_shrinks_thin_history():
    invs = _history("ar", "Late Co", 10) + _history("ar", "Early Co", -4) \
        + _history("ar", "Thin Co", 30, n=1)
    profiles, defaults = te.build_profiles(invs, AS_OF)
    late = profiles[("ar", "Late Co")]
    assert late.n == 20 and late.mean == pytest.approx((20 * 10 + 5 * defaults["ar"].mean) / 25)
    assert profiles[("ar", "Early Co")].mean < 0
    thin = profiles[("ar", "Thin Co")]
    assert defaults["ar"].mean < thin.mean < 30          # pulled toward the ledger average
    assert te.confidence(thin) != "high"                 # thin history caps confidence


def test_history_ignores_invoices_settled_after_close():
    invs = _history("ar", "A", 0) + [_inv("ar", "x", "A", 1000.0, date(2026, 6, 1), 30, 40)]
    profiles, _ = te.build_profiles(invs, AS_OF)
    assert profiles[("ar", "A")].n == 20                 # the post-close settlement isn't history


def test_open_invoice_forecast_never_reads_its_own_paid_date():
    """No look-ahead: an open invoice's eventual paid_date must not move its forecast."""
    open_a = _inv("ar", "o", "A", 5000.0, date(2026, 6, 10), 30, 3)
    open_b = replace(open_a, paid_date=open_a.due_date + timedelta(days=60))
    hist = _history("ar", "A", 5)
    a = te.forecast(_inputs(hist + [open_a]))
    b = te.forecast(_inputs(hist + [open_b]))
    assert a["rows"][0]["values"] == b["rows"][0]["values"]
    assert a["items"][0]["expected_date"] == b["items"][0]["expected_date"]


def test_expected_date_shifts_by_habit_and_rolls_off_weekends():
    hist = _history("ar", "A", 5)
    profiles, _ = te.build_profiles(hist, AS_OF)
    p = profiles[("ar", "A")]
    inv = _inv("ar", "o", "A", 1.0, date(2026, 6, 15), 30)        # due Wed 15 Jul
    when, conf, past = te.expected_settlement(inv, p, AS_OF)
    assert when.weekday() < 5 and not past
    assert when >= inv.due_date + timedelta(days=round(p.mean))
    assert conf in ("high", "medium", "low")


def test_invoice_past_its_usual_habit_lands_just_after_close_at_low_confidence():
    hist = _history("ar", "A", 0)
    profiles, _ = te.build_profiles(hist, AS_OF)
    stale = _inv("ar", "o", "A", 1.0, date(2026, 4, 1), 30)       # due 1 May, still open
    when, conf, past = te.expected_settlement(stale, profiles[("ar", "A")], AS_OF)
    assert past and conf == "low" and AS_OF < when <= AS_OF + timedelta(days=10)


# ---------------------------------------------------------------- rule flows
def test_fixed_flows_follow_their_calendar():
    fixed = [te.FixedFlow("payroll", 100.0, "last_business_day", ""),
             te.FixedFlow("tax", 50.0, "day:15", "")]
    out = te.forecast(_inputs([], fixed=fixed))
    paid_weeks = [w for w, v in zip(out["weeks"], _row(out, "payroll")["values"]) if v]
    # Jul 31 2026 is a Friday; Aug 31 a Monday — both inside 13 weeks from 1 Jul.
    assert [any(w["start"] <= d <= w["end"] for w in paid_weeks)
            for d in ("2026-07-31", "2026-08-31")] == [True, True]
    assert _row(out, "payroll")["total"] == 200.0
    assert _row(out, "tax")["total"] == 150.0                     # 15 Jul, 17 Aug (Mon), 15 Sep


def test_schedule_rolls_weekends():
    assert te._schedule_date(2026, 8, "day:15") == date(2026, 8, 17)      # Sat → Mon
    assert te._schedule_date(2026, 5, "last_business_day") == date(2026, 5, 29)  # Sun → Fri


def test_other_line_is_trailing_twelve_week_average_on_business_days():
    other = {AS_OF - timedelta(days=d): 100.0 for d in range(0, 84)}   # 84 days × 100
    out = te.forecast(_inputs([], other_daily=other))
    assert out["assumptions"]["other_weekly_run_rate"] == pytest.approx(700.0)
    assert _row(out, "other")["values"][1] == pytest.approx(700.0)    # a full Mon–Fri week


# ---------------------------------------------------------------- grid + tie-out
def _row(out, row_id):
    return next(r for r in out["rows"] if r["id"] == row_id)


def _full_inputs():
    invs = _history("ar", "A", 4) + _history("ap", "V", -2) + [
        _inv("ar", "o1", "A", 3000.0, date(2026, 6, 5), 30),
        _inv("ar", "o2", "A", 2000.0, date(2026, 6, 20), 45),
        _inv("ap", "o3", "V", 800.0, date(2026, 6, 12), 30),
    ]
    fixed = [te.FixedFlow("payroll", 900.0, "last_business_day", ""),
             te.FixedFlow("capex", 100.0, "day:15", "")]
    fpa = [{"period": p, "receipts": 1.0, "operating_payments": 1.0, "capex": 1.0,
            "net_change": 1.0, "ending_cash": 1.0} for p in ("2026-07", "2026-08", "2026-09")]
    return _inputs(invs, fixed=fixed, revenue_forecast={"2026-07": 3100.0, "2026-08": 3100.0},
                   other_daily={AS_OF - timedelta(days=3): 120.0}, fpa_months=fpa, min_cash=500.0)


def test_grid_rolls_cash_forward_week_to_week():
    out = te.forecast(_full_inputs())
    s = out["summary"]
    assert len(out["weeks"]) == 13 and out["weeks"][0]["start"] == "2026-07-01"
    assert s["opening_cash"][0] == 10_000.0
    for k in range(13):
        assert s["closing_cash"][k] == pytest.approx(s["opening_cash"][k] + s["inflows"][k] - s["outflows"][k])
        if k:
            assert s["opening_cash"][k] == s["closing_cash"][k - 1]
    assert s["lowest_cash"] == min(s["closing_cash"])
    assert _row(out, "receipts_open")["total"] == pytest.approx(5000.0)
    assert len(_row(out, "receipts_open")["confidence"]) == 13


def test_new_sales_collect_after_the_ledger_lag():
    out = te.forecast(_full_inputs())
    lag = out["assumptions"]["receipts_lag_days"]
    first = next(k for k, v in enumerate(_row(out, "receipts_new")["values"]) if v)
    assert first in (lag // 7, lag // 7 + 1)   # first invoice (1 Jul) + lag, weekend-rolled


def test_reconciliation_covers_months_one_to_three_and_ties_to_flows():
    out = te.forecast(_full_inputs())
    rec = out["reconciliation"]
    assert [m["period"] for m in rec] == ["2026-07", "2026-08", "2026-09"]
    cash = 10_000.0
    for m in rec:
        t = m["treasury"]
        assert t["net_change"] == pytest.approx(t["receipts"] - t["operating_payments"] - t["capex"])
        cash += t["net_change"]
        assert t["ending_cash"] == pytest.approx(cash)
        assert m["difference"]["receipts"] == pytest.approx(t["receipts"] - 1.0)
    # July carries one payroll + one capex run.
    assert rec[0]["treasury"]["capex"] == 100.0


def test_drivers_explain_counterparties_with_open_items():
    out = te.forecast(_full_inputs())
    d = {x["counterparty"]: x for x in out["drivers"]}
    assert set(d) == {"A", "V"}
    assert d["A"]["open_amount"] == 5000.0 and "late" in d["A"]["explanation"]
    assert "early" in d["V"]["explanation"]


# ---------------------------------------------------------------- input provider
def _fake_query(sql: str):
    if "v_payment_behavior" in sql:
        return [
            {"ledger": "ar", "invoice_id": "AR-1", "counterparty": "A", "amount": "1000.00",
             "payment_terms": "30", "invoice_date": "2026-05-01", "due_date": "2026-05-31",
             "paid_date": "2026-06-03"},
            {"ledger": "ar", "invoice_id": "AR-2", "counterparty": "A", "amount": "2000.00",
             "payment_terms": "30", "invoice_date": "2026-06-10", "due_date": "2026-07-10",
             "paid_date": "2026-07-14"},
        ]
    if "CASE WHEN" in sql and "gl_journal_entries" in sql:
        return [{"row_id": "payroll", "amount": "3000"}, {"row_id": "tax", "amount": "600"},
                {"row_id": None, "amount": "999"}]
    if "entry_date" in sql:
        return [{"entry_date": "2026-06-29", "amount": "50"}]
    if "SUM(capex)" in sql:
        return [{"capex": "300"}]
    if "ending_cash" in sql and "cash_flow" in sql:
        return [{"cash": "14670000"}]
    return []


def test_get_inputs_assembles_run_rates_and_fpa(monkeypatch):
    from server import scenario_engine as eng

    monkeypatch.setattr(ti, "query", _fake_query)
    periods = [f"2026-{m:02d}" for m in range(1, 13)]
    zeros = [0.0] * 12
    ss = eng.StatementSet(periods=periods, hinge_index=5,
                          lines={k: list(zeros) for k in eng.LINE_IDS}, kpis={})
    ss.lines["revenue"] = [1000.0] * 12
    ss.lines["delta_ar"] = [10.0] * 12
    ss.lines["operating_cash"] = [400.0] * 12
    ss.lines["cogs"] = [500.0] * 12
    ss.lines["opex"] = [200.0] * 12
    monkeypatch.setattr(ti, "get_baseline", lambda p: type("B", (), {"revenue_source": "ai"})())
    monkeypatch.setattr(ti, "project", lambda b, a: ss)

    inp = ti.get_inputs("2026-06")
    assert inp.as_of == date(2026, 6, 30) and inp.opening_cash == 14_670_000.0
    assert len(inp.invoices) == 2 and inp.invoices[1].paid_date == date(2026, 7, 14)
    fixed = {f.row_id: f.monthly_amount for f in inp.fixed}
    assert fixed["payroll"] == pytest.approx(1000.0) and fixed["tax"] == pytest.approx(200.0)
    assert fixed["capex"] == pytest.approx(100.0) and fixed["rent"] == 0.0
    assert inp.other_daily == {date(2026, 6, 29): 50.0}
    assert sorted(inp.revenue_forecast) == periods[6:]
    assert [m["period"] for m in inp.fpa_months] == ["2026-07", "2026-08", "2026-09"]
    assert inp.fpa_months[0]["receipts"] == 990.0 and inp.fpa_months[0]["operating_payments"] == 590.0
    assert inp.min_cash == 700.0 and inp.revenue_source == "ai"


# ---------------------------------------------------------------- route
def test_route_display_dates_keep_weeks_seven_days_apart(monkeypatch):
    from server.routes import treasury as route

    monkeypatch.setattr(route, "get_inputs", lambda as_of, min_cash=None: _full_inputs())
    monkeypatch.setattr(route, "month_offset", lambda: 4)
    out = route.thirteen_week(as_of=None, min_cash=None)
    assert out["display_as_of"] == "2026-10-31"            # close month-shifted Jun → Oct
    starts = [date.fromisoformat(w["display_start"]) for w in out["weeks"]]
    assert starts[0] == date(2026, 11, 1)
    assert all((b - a).days == 7 for a, b in zip(starts, starts[1:]))
    assert [m["display_period"] for m in out["reconciliation"]] == ["2026-11", "2026-12", "2027-01"]
