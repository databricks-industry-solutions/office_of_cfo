"""Unit tests for the pure scenario projection engine (scenario_engine.project).

Warehouse-free and I/O-free by construction — the engine takes an injected
`BaselineSeries`, so these tests build synthetic baselines and assert the invariants
the design rests on: cash tie-out, actuals/forecast hinge isolation, driver
directional effects, and the self-describing assumption contract.
"""
from __future__ import annotations

import pathlib
import sys

import pytest

# Make `server` importable under pytest from repo root (matches sibling tests).
_APP = pathlib.Path(__file__).resolve().parents[2]
if str(_APP) not in sys.path:
    sys.path.insert(0, str(_APP))

from server import scenario_engine as eng


def make_baseline(n: int = 6, hinge: int = 2) -> eng.BaselineSeries:
    """Flat synthetic baseline: 6 monthly periods, 3 actual (0..2) + 3 forecast (3..5).

    Revenue 1000, COGS 550 (45% gross margin), opex 300, small interest, 25% tax,
    D&A 40, WC days 45/50/60, capex 5% of revenue. Opening balances chosen so the
    first-period WC deltas are non-trivial."""
    return eng.BaselineSeries(
        periods=[f"2026-{m:02d}" for m in range(1, n + 1)],
        hinge_index=hinge,
        revenue=[1000.0] * n,
        cogs=[550.0] * n,
        opex=[300.0] * n,
        interest_income=[5.0] * n,
        interest_expense=[8.0] * n,
        dna=[40.0] * n,
        tax_rate=0.25,
        dso=45.0,
        dpo=50.0,
        dio=60.0,
        capex_pct=5.0,
        opening_cash=2000.0,
        opening_ar=1400.0,
        opening_inventory=1050.0,
        opening_ap=900.0,
        dividend_payout=15.0,  # baseline pays out 15% of net income
    )


# --------------------------------------------------------------------------- #
# Structure
# --------------------------------------------------------------------------- #
def test_output_shape():
    s = eng.project(make_baseline(), {})
    assert s.periods == make_baseline().periods
    assert s.hinge_index == 2
    assert set(s.lines) == set(eng.LINE_IDS)
    # The three cash-flow sections + the bridge are all emitted.
    for lid in ("operating_cash", "investing_cash", "financing_cash",
                "beginning_cash", "net_change_in_cash", "ending_cash"):
        assert lid in s.lines
    assert set(s.kpis) == {"gross_margin_pct", "operating_margin_pct", "dso", "dpo", "dio", "ccc"}
    for series in s.lines.values():
        assert len(series) == 6
    for series in s.kpis.values():
        assert len(series) == 6


def test_baseline_passthrough_when_no_assumptions():
    b = make_baseline()
    s = eng.project(b, {})
    for i in range(len(b.periods)):
        assert s.lines["revenue"][i] == pytest.approx(b.revenue[i])
        assert s.lines["cogs"][i] == pytest.approx(b.cogs[i])
        assert s.lines["opex"][i] == pytest.approx(b.opex[i])
        # Derived subtotals reconcile to the leaves.
        assert s.lines["gross_profit"][i] == pytest.approx(b.revenue[i] - b.cogs[i])
        assert s.lines["operating_income"][i] == pytest.approx(b.revenue[i] - b.cogs[i] - b.opex[i])


# --------------------------------------------------------------------------- #
# Tie-out by construction (the load-bearing invariant)
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("assumptions", [
    {},
    {"revenue_growth": 8},
    {"gross_margin": -150, "opex_growth": 3},
    {"dso": 6, "dpo": 4, "dio": 5},
    {"capex_pct": 8},
    {"acquisitions": 6, "asset_sales": 2},
    {"debt_draw": 10, "debt_repayment": 4, "dividend_payout": 40},
    {"revenue_growth": -8, "gross_margin": -150, "opex_growth": 3, "dso": 6, "dpo": 4, "dio": 5,
     "capex_pct": 7, "acquisitions": 5, "asset_sales": 1, "debt_draw": 8, "debt_repayment": 3,
     "dividend_payout": 30},
])
def test_cash_ties_out(assumptions):
    b = make_baseline()
    s = eng.project(b, assumptions)
    L = s.lines

    for i in range(len(b.periods)):
        # 1) operating cash IS net income + D&A - ΔAR - ΔInv + ΔAP, every period.
        expected_cfo = (L["net_income"][i] + L["dna"][i]
                        - L["delta_ar"][i] - L["delta_inventory"][i] + L["delta_ap"][i])
        assert L["operating_cash"][i] == pytest.approx(expected_cfo)
        assert L["free_cash_flow"][i] == pytest.approx(L["operating_cash"][i] - L["capex"][i])

        # 2) the three sections aggregate their leaves.
        assert L["investing_cash"][i] == pytest.approx(
            L["asset_sales"][i] - L["capex"][i] - L["acquisitions"][i])
        assert L["financing_cash"][i] == pytest.approx(
            L["debt_draw"][i] - L["debt_repayment"][i] - L["dividends"][i])

        # 3) net change = CFO + CFI + CFF, and begin + net change = end.
        assert L["net_change_in_cash"][i] == pytest.approx(
            L["operating_cash"][i] + L["investing_cash"][i] + L["financing_cash"][i])
        assert L["ending_cash"][i] == pytest.approx(L["beginning_cash"][i] + L["net_change_in_cash"][i])
        assert L["cash_balance"][i] == pytest.approx(L["ending_cash"][i])

    # 4) the cash balance rolls forward from opening cash by net change in cash.
    running = b.opening_cash
    for i in range(len(b.periods)):
        assert L["beginning_cash"][i] == pytest.approx(running)
        running += L["net_change_in_cash"][i]
        assert L["cash_balance"][i] == pytest.approx(running)
    assert L["cash_balance"][-1] == pytest.approx(b.opening_cash + sum(L["net_change_in_cash"]))


# --------------------------------------------------------------------------- #
# Hinge isolation — drivers touch only the forecast
# --------------------------------------------------------------------------- #
def test_drivers_do_not_move_actual_periods():
    b = make_baseline()
    base = eng.project(b, {})
    flexed = eng.project(b, {"revenue_growth": 12, "gross_margin": 200, "opex_growth": 5,
                             "dso": 10, "dpo": 8, "dio": 9, "capex_pct": 9})
    for i in range(b.hinge_index + 1):  # actual periods
        for lid in ("revenue", "cogs", "opex", "operating_income", "free_cash_flow"):
            assert flexed.lines[lid][i] == pytest.approx(base.lines[lid][i]), f"{lid}@{i} moved"
    # ...but forecast periods DO move.
    assert flexed.lines["revenue"][b.hinge_index + 1] > base.lines["revenue"][b.hinge_index + 1]


# --------------------------------------------------------------------------- #
# Driver directional effects
# --------------------------------------------------------------------------- #
def test_revenue_growth_lifts_revenue_and_operating_income():
    b = make_baseline()
    base = eng.project(b, {})
    up = eng.project(b, {"revenue_growth": 10})
    f = b.hinge_index + 1
    assert up.lines["revenue"][f] == pytest.approx(base.lines["revenue"][f] * 1.10)
    assert up.lines["operating_income"][f] > base.lines["operating_income"][f]


def test_gross_margin_shift_lowers_cogs_and_lifts_gross_profit():
    b = make_baseline()
    base = eng.project(b, {})
    up = eng.project(b, {"gross_margin": 200})  # +200 bps
    f = b.hinge_index + 1
    assert up.lines["cogs"][f] < base.lines["cogs"][f]
    assert up.lines["gross_profit"][f] > base.lines["gross_profit"][f]
    assert up.kpis["gross_margin_pct"][f] == pytest.approx(base.kpis["gross_margin_pct"][f] + 2.0, abs=1e-6)


def test_opex_growth_reduces_operating_income():
    b = make_baseline()
    base = eng.project(b, {})
    up = eng.project(b, {"opex_growth": 5})
    f = b.hinge_index + 1
    assert up.lines["opex"][f] == pytest.approx(base.lines["opex"][f] * 1.05)
    assert up.lines["operating_income"][f] < base.lines["operating_income"][f]


def test_higher_dso_consumes_cash():
    b = make_baseline()
    base = eng.project(b, {})
    slow = eng.project(b, {"dso": 10})  # collecting slower ties up cash in AR
    assert slow.lines["cash_balance"][-1] < base.lines["cash_balance"][-1]


def test_higher_dpo_frees_cash():
    b = make_baseline()
    base = eng.project(b, {})
    stretch = eng.project(b, {"dpo": 10})  # paying suppliers slower frees cash
    assert stretch.lines["cash_balance"][-1] > base.lines["cash_balance"][-1]


def test_higher_dio_consumes_cash():
    b = make_baseline()
    base = eng.project(b, {})
    heavy = eng.project(b, {"dio": 10})  # more inventory ties up cash
    assert heavy.lines["cash_balance"][-1] < base.lines["cash_balance"][-1]


def test_higher_capex_reduces_free_cash_flow():
    b = make_baseline()
    base = eng.project(b, {})
    heavy = eng.project(b, {"capex_pct": 9})  # baseline is 5%
    f = b.hinge_index + 1
    assert heavy.lines["capex"][f] > base.lines["capex"][f]
    assert heavy.lines["free_cash_flow"][f] < base.lines["free_cash_flow"][f]


def test_debt_draw_adds_cash_repayment_and_dividends_consume_it():
    b = make_baseline()
    base = eng.project(b, {})
    drawn = eng.project(b, {"debt_draw": 10})
    repaid = eng.project(b, {"debt_repayment": 10})
    paid_out = eng.project(b, {"dividend_payout": 80})  # baseline is 15%
    assert drawn.lines["cash_balance"][-1] > base.lines["cash_balance"][-1]
    assert repaid.lines["cash_balance"][-1] < base.lines["cash_balance"][-1]
    assert paid_out.lines["cash_balance"][-1] < base.lines["cash_balance"][-1]
    # Financing lines DO NOT touch operating income (they are below the line).
    f = b.hinge_index + 1
    assert drawn.lines["operating_income"][f] == pytest.approx(base.lines["operating_income"][f])


def test_acquisitions_consume_cash_and_disposals_add_it():
    b = make_baseline()
    base = eng.project(b, {})
    buy = eng.project(b, {"acquisitions": 8})
    sell = eng.project(b, {"asset_sales": 8})
    assert buy.lines["cash_balance"][-1] < base.lines["cash_balance"][-1]
    assert sell.lines["cash_balance"][-1] > base.lines["cash_balance"][-1]
    # Investing lines flow through CFI, not CFO.
    f = b.hinge_index + 1
    assert buy.lines["operating_cash"][f] == pytest.approx(base.lines["operating_cash"][f])


def test_dividend_not_paid_on_a_loss():
    # Force a loss with a big opex hit; dividends must be zero (no payout on negative NI).
    b = make_baseline()
    loss = eng.project(b, {"opex_growth": 300, "dividend_payout": 50})
    f = b.hinge_index + 1
    assert loss.lines["net_income"][f] < 0
    assert loss.lines["dividends"][f] == pytest.approx(0.0)


def test_ccc_reflects_working_capital_days():
    b = make_baseline()
    s = eng.project(b, {"dso": 5, "dpo": -3, "dio": 4})
    f = b.hinge_index + 1
    # CCC = DSO + DIO - DPO, on the flexed forecast days.
    assert s.kpis["ccc"][f] == pytest.approx((45 + 5) + (60 + 4) - (50 - 3))
    # actual periods keep baseline CCC
    assert s.kpis["ccc"][0] == pytest.approx(45 + 60 - 50)


# --------------------------------------------------------------------------- #
# Self-describing assumption contract
# --------------------------------------------------------------------------- #
def test_self_describing_and_bare_values_are_equivalent():
    b = make_baseline()
    bare = eng.project(b, {"revenue_growth": 7, "dso": 4})
    described = eng.project(b, {
        "revenue_growth": {"value": 7, "unit": "%", "mode": "growth"},
        "dso": {"value": 4, "unit": "days", "mode": "delta"},
    })
    assert described.lines["cash_balance"] == pytest.approx(bare.lines["cash_balance"])
    assert described.lines["revenue"] == pytest.approx(bare.lines["revenue"])


def test_unknown_and_blank_assumptions_are_ignored():
    b = make_baseline()
    base = eng.project(b, {})
    noisy = eng.project(b, {"not_a_driver": 99, "revenue_growth": {"value": None}, "opex_growth": ""})
    assert noisy.lines["cash_balance"] == pytest.approx(base.lines["cash_balance"])


# --------------------------------------------------------------------------- #
# Catalog
# --------------------------------------------------------------------------- #
def test_driver_catalog_is_a_defensive_copy():
    a = eng.driver_catalog()
    a[0]["label"] = "MUTATED"
    assert eng.driver_catalog()[0]["label"] != "MUTATED"
    ids = {d["id"] for d in eng.driver_catalog()}
    assert {"revenue_growth", "gross_margin", "opex_growth", "dso", "dpo", "dio", "capex_pct",
            "acquisitions", "asset_sales", "debt_draw", "debt_repayment", "dividend_payout"} == ids


# --------------------------------------------------------------------------- #
# Posted-cash anchor (actual months tie to the books)
# --------------------------------------------------------------------------- #
def test_actual_months_pin_to_posted_cash():
    b = make_baseline()
    b.posted_cash = [2010.0, 2030.0, 2045.0, None, None, None]
    L = eng.project(b, {}).lines
    assert L["cash_balance"][:3] == pytest.approx([2010.0, 2030.0, 2045.0])
    # Still ties out: begin + (CFO + CFI + CFF + other) = end, every period.
    for i in range(len(b.periods)):
        assert L["net_change_in_cash"][i] == pytest.approx(
            L["operating_cash"][i] + L["investing_cash"][i] + L["financing_cash"][i] + L["other_cash"][i])
        assert L["ending_cash"][i] == pytest.approx(L["beginning_cash"][i] + L["net_change_in_cash"][i])
    assert L["other_cash"][3:] == [0.0, 0.0, 0.0]


def test_forecast_rolls_from_last_posted_balance():
    b = make_baseline()
    unanchored = eng.project(b, {"revenue_growth": 5}).lines
    b.posted_cash = [2010.0, 2030.0, 2045.0, None, None, None]
    anchored = eng.project(b, {"revenue_growth": 5}).lines
    assert anchored["beginning_cash"][3] == pytest.approx(2045.0)
    # Forecast flows are unchanged; only the starting balance moves.
    shift = 2045.0 - unanchored["cash_balance"][2]
    for i in range(3, 6):
        assert anchored["net_change_in_cash"][i] == pytest.approx(unanchored["net_change_in_cash"][i])
        assert anchored["cash_balance"][i] == pytest.approx(unanchored["cash_balance"][i] + shift)


def test_no_posted_cash_keeps_modelled_roll():
    L = eng.project(make_baseline(), {}).lines
    assert L["other_cash"] == [0.0] * 6
