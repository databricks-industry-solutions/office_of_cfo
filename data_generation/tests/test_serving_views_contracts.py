"""SQL contract + reference-model tests for serving statement views (Task 2)."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path


SERVING_SQL = (
    Path(__file__).resolve().parents[2] / "serving" / "serving_views.sql"
).read_text()


def _normalize_sql(sql: str) -> str:
    return " ".join(sql.split())


def _view_sql(view_name: str) -> str:
    # Strip line comments so embedded ';' in comments cannot truncate the view body.
    uncommented = "\n".join(
        ln for ln in SERVING_SQL.splitlines() if not ln.strip().startswith("--")
    )
    pattern = (
        r"CREATE OR REPLACE VIEW\s+\{\{serving\}\}\."
        + re.escape(view_name)
        + r"\s+AS\s+(.*?);"
    )
    match = re.search(pattern, uncommented, flags=re.IGNORECASE | re.DOTALL)
    assert match, f"View not found: {view_name}"
    return _normalize_sql(match.group(1))


def _prior_calendar_month(period: str) -> str:
    y, m = int(period[:4]), int(period[5:7])
    m -= 1
    if m == 0:
        y, m = y - 1, 12
    return f"{y:04d}-{m:02d}"


def densify_then_cumsum(
    activity: dict[str, float],
    periods: list[str],
) -> dict[str, float]:
    """Reference densify: zero-fill missing periods, then cumulative sum."""
    out: dict[str, float] = {}
    running = 0.0
    for p in periods:
        running += float(activity.get(p, 0.0))
        out[p] = running
    return out


def sparse_cumsum(activity: dict[str, float], periods: list[str]) -> dict[str, float]:
    """Broken as-of: only periods with activity exist; later months disappear."""
    out: dict[str, float] = {}
    running = 0.0
    for p in periods:
        if p not in activity:
            continue
        running += float(activity[p])
        out[p] = running
    return out


@dataclass(frozen=True)
class EquityPeriodInput:
    period: str
    cs_period_activity: float
    re_period_activity: float  # typically -dividends in seed data
    period_ni: float
    dividends_paid: float


def equity_rollforward_reference(
    rows: list[EquityPeriodInput],
) -> dict[str, dict[str, dict[str, float]]]:
    """Locked equity statement accounting model (pure Python)."""
    periods = [r.period for r in rows]
    period_set = set(periods)
    by_period = {r.period: r for r in rows}

    cs_asof = densify_then_cumsum(
        {r.period: r.cs_period_activity for r in rows}, periods
    )
    re_asof = densify_then_cumsum(
        {r.period: r.re_period_activity for r in rows}, periods
    )
    # Cumulative IS through each month (period NI densified then cumsum).
    cum_is = densify_then_cumsum({r.period: r.period_ni for r in rows}, periods)

    result: dict[str, dict[str, dict[str, float]]] = {}
    for p in periods:
        r = by_period[p]
        prior = _prior_calendar_month(p)
        has_true_prior = prior in period_set

        cs_ending = cs_asof[p]
        cs_beginning = cs_asof[prior] if has_true_prior else cs_ending
        cs_ni = 0.0
        cs_div = 0.0

        dividends = -float(r.dividends_paid)
        ni = float(r.period_ni)
        if has_true_prior:
            re_beginning = re_asof[prior] + cum_is[prior]
        else:
            # First available period: recover seeded opening RE before dividends.
            re_beginning = re_asof[p] - dividends
        re_ending = re_beginning + ni + dividends
        expected_re_ending = re_asof[p] + cum_is[p]
        assert abs(re_ending - expected_re_ending) < 1e-9, (
            f"{p}: RE ending {re_ending} != RE asof+cumIS {expected_re_ending}"
        )
        assert abs(cs_beginning + cs_ni + cs_div - cs_ending) < 1e-9

        result[p] = {
            "common_stock": {
                "beginning": cs_beginning,
                "net_income": cs_ni,
                "dividends": cs_div,
                "ending": cs_ending,
            },
            "retained_earnings": {
                "beginning": re_beginning,
                "net_income": ni,
                "dividends": dividends,
                "ending": re_ending,
            },
            "total": {
                "beginning": cs_beginning + re_beginning,
                "net_income": cs_ni + ni,
                "dividends": cs_div + dividends,
                "ending": cs_ending + re_ending,
            },
        }
        for cls, vals in result[p].items():
            assert abs(
                vals["beginning"] + vals["net_income"] + vals["dividends"] - vals["ending"]
            ) < 1e-9, f"{p}/{cls} identity failed"
    return result


def test_income_statement_includes_interest_and_tax_lines():
    sql = _view_sql("income_statement")
    assert (
        "WHEN account_type = 'Revenue' AND account_code NOT IN ('70000') THEN 'revenue'" in sql
    )
    assert "WHEN account_code = '50000' THEN 'cogs'" in sql
    assert "WHEN account_code = '70000' THEN 'interest_income'" in sql
    assert "WHEN account_code = '71000' THEN 'interest_expense'" in sql
    assert "WHEN account_code = '80000' THEN 'tax_expense'" in sql

    assert "WHEN account_code = '70000' THEN 'Interest Income'" in sql
    assert "WHEN account_code = '71000' THEN 'Interest Expense'" in sql
    assert "WHEN account_code = '80000' THEN 'Tax Expense'" in sql

    assert "WHEN account_code = '70000' THEN 6" in sql
    assert "WHEN account_code = '71000' THEN 7" in sql
    assert "WHEN account_code = '80000' THEN 9" in sql


def test_balance_sheet_uses_common_stock_and_retained_earnings_lines():
    sql = _view_sql("balance_sheet")
    assert "THEN 'assets_current'" in sql
    assert "THEN 'assets_noncurrent'" in sql
    assert "THEN 'liabilities_current'" in sql
    assert "'equity' END AS section" in sql

    assert "WHEN account_code = '30000' THEN 'common_stock'" in sql
    assert "WHEN account_code = '31000' THEN 'retained_earnings'" in sql
    assert "'current_earnings' AS line_id" in sql

    assert "'opening_equity'" not in sql
    # Comment must not still claim a synthetic opening-equity residual.
    assert "opening-equity residual" not in SERVING_SQL


def test_cash_flow_statement_has_dividends_and_balancing_contract():
    sql = _view_sql("cash_flow_statement")
    assert "'dividends_paid'" in sql
    assert "-dividends_paid" in sql
    assert (
        "ending_cash - beginning_cash - (collections - operating_disbursements) - (-capex) - (-dividends_paid)"
        in sql
    )
    assert "financing_other" in sql
    assert "dividends_paid" in sql and "financing_other" in sql


def test_account_balance_asof_densifies_sparse_periods():
    sql = _view_sql("account_balance_asof")
    assert "CROSS JOIN" in sql
    assert "COALESCE(" in sql
    assert "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW" in sql
    # Densify pattern: keys x periods left-joined to activity, then window.
    assert "LEFT JOIN" in sql


def test_equity_statement_locked_line_ids_and_true_prior_month():
    sql = _view_sql("equity_statement")
    assert "'common_stock'" in sql
    assert "'retained_earnings'" in sql
    assert "'total'" in sql
    assert "'beginning'" in sql
    assert "'net_income'" in sql
    assert "'dividends'" in sql
    assert "'ending'" in sql
    assert "'beginning_balance'" not in sql
    assert "'ending_balance'" not in sql
    assert "LAG(" not in sql
    assert "ADD_MONTHS(" in sql
    assert "prior_period" in sql


def test_sparse_asof_without_densify_drops_opening_equity():
    periods = ["2025-07", "2025-08", "2025-09"]
    # One-time CS / opening RE postings only in the first month.
    activity = {"2025-07": 570000.0}
    sparse = sparse_cumsum(activity, periods)
    dense = densify_then_cumsum(activity, periods)
    assert "2025-09" not in sparse
    assert dense["2025-09"] == 570000.0


def test_true_prior_month_does_not_silently_skip_missing_month():
    """LAG over available rows would reuse an older month; true prior must not."""
    available = ["2025-07", "2025-09"]
    asof = densify_then_cumsum({"2025-07": 150000.0}, available)
    # Broken LAG: previous available row for 2025-09 is 2025-07.
    broken_lag_beginning = asof["2025-07"]
    true_prior = _prior_calendar_month("2025-09")
    assert true_prior == "2025-08"
    assert true_prior not in asof
    # Locked semantics when prior calendar month is absent: do not invent 2025-07.
    locked_cs_beginning = asof["2025-09"]  # COALESCE(prior, current)
    assert locked_cs_beginning == 150000.0
    assert broken_lag_beginning == 150000.0  # same CS number...
    # ...but RE+cumIS beginning differs under LAG vs true-prior absence.
    re_asof = densify_then_cumsum({"2025-07": 418500.0, "2025-09": -2000.0}, available)
    cum_is = densify_then_cumsum({"2025-07": 10000.0, "2025-09": 12000.0}, available)
    broken_re_beginning = re_asof["2025-07"] + cum_is["2025-07"]  # LAG into Jul
    # True prior Aug missing => recover from current period only (no Jul NI).
    dividends = -2000.0
    locked_re_beginning = re_asof["2025-09"] - dividends
    assert broken_re_beginning == 428500.0
    assert locked_re_beginning == 418500.0
    assert locked_re_beginning != broken_re_beginning


def test_equity_rollforward_first_period_and_identity():
    rows = [
        EquityPeriodInput("2025-07", 150000.0, 420000.0 - 1500.0, 10000.0, 1500.0),
        EquityPeriodInput("2025-08", 0.0, -1800.0, 11000.0, 1800.0),
        EquityPeriodInput("2025-09", 0.0, -2000.0, 12000.0, 2000.0),
    ]
    out = equity_rollforward_reference(rows)

    # First period: opening CS seed is beginning; opening RE recovered pre-dividend.
    assert out["2025-07"]["common_stock"]["beginning"] == 150000.0
    assert out["2025-07"]["common_stock"]["ending"] == 150000.0
    assert out["2025-07"]["retained_earnings"]["beginning"] == 420000.0
    assert out["2025-07"]["retained_earnings"]["dividends"] == -1500.0
    assert out["2025-07"]["retained_earnings"]["net_income"] == 10000.0
    assert out["2025-07"]["retained_earnings"]["ending"] == 420000.0 + 10000.0 - 1500.0

    # Later period ties to prior RE+cumIS and cumulative earnings.
    assert out["2025-08"]["retained_earnings"]["beginning"] == (
        out["2025-07"]["retained_earnings"]["ending"]
    )
    # Ending RE class = RE asof + cum IS through month.
    re_asof_sep = (420000.0 - 1500.0) + (-1800.0) + (-2000.0)
    cum_is_sep = 10000.0 + 11000.0 + 12000.0
    assert out["2025-09"]["retained_earnings"]["ending"] == re_asof_sep + cum_is_sep


def test_recon_skips_settlement_legs_except_on_cash():
    postings = _view_sql("v_postings")
    assert "WHEN posted_by = 'treasury.settlement' THEN 'Settlement'" in postings
    recon = _view_sql("recon_breaks_live")
    assert "AND (origin <> 'Settlement' OR account_code = '10100')" in recon
    # The bank statement is a running balance: compare the latest one only.
    assert "WHERE period = (SELECT MAX(period) FROM {{close}}.subledger_bank)" in recon


def test_working_capital_reads_ar_ap_as_month_end_balances():
    sql = _view_sql("working_capital_kpis")
    assert "FROM {{serving}}.account_balance_asof WHERE account_code IN ('11000', '20000')" in sql
    assert "CASE WHEN account_code = '12000' THEN balance ELSE 0 END AS inventory_balance" in sql
