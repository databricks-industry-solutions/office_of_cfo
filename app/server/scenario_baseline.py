"""Scenario baseline provider — `get_baseline(...) -> BaselineSeries`.

This is the **only I/O piece** of the scenario engine, deliberately isolated behind
the `get_baseline` interface so an ML forecast
can replace it later without touching the engine. The L1 implementation derives the
baseline from the warehouse: real actuals from the income statement + the plan from
`budget_forecast`, with working-capital days, D&A, capex and opening balances read
from the app's existing governed views — using the app's **exact** DSO/DPO/DIO
definitions (`kpis.py`) so a scenario's baseline ties to the KPI pages.

Boundary (L1): **consolidated** scope only (the P&L is consolidated-grain for now);
`scope_type`/`scope_id` are accepted for forward-compatibility but not yet filtered.
The window is the fiscal year of `as_of` (Jan..Dec); actuals run Jan..as_of, the
forecast is as_of+1..Dec.
"""
from __future__ import annotations

from . import ml_forecast
import re

from .config import CLOSE_FQ, CLOSE_PERIOD, SRV_FQ
from .scenario_engine import BaselineSeries
from .warehouse import query

# Depreciation & amortization lives in GL account 65000 (collapsed into `opex` on the
# income statement). We read it straight from the account grain so the indirect cash
# bridge has a real non-cash add-back without the deferred opex-split.
_DNA_ACCOUNT = "65000"


def _f(v) -> float:
    """Coerce a warehouse cell (returned as a string) to float; None/'' -> 0.0."""
    if v is None or v == "":
        return 0.0
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


_PERIOD_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")


def seed_period(as_of: str | None) -> str:
    """A seed-calendar YYYY-MM for the baseline; anything else → the active close.

    Callers already hold seed periods (CLOSE_PERIOD, a saved plan's as_of_period,
    request bodies the client maps to seed via toSeedPayload), so this only
    validates. It must NOT apply the demo-calendar shift (`resolve_period`) — that
    would move the close back by the display offset (e.g. June → February)."""
    p = (as_of or "").strip()
    return p if _PERIOD_RE.match(p) else CLOSE_PERIOD


def _fy_window(as_of: str) -> tuple[list[str], int]:
    """The fiscal-year window (12 YYYY-MM periods) + the hinge index (last actual).

    e.g. '2026-06' -> (['2026-01'..'2026-12'], 5)."""
    year = int(as_of[:4])
    month = int(as_of[5:7])
    periods = [f"{year:04d}-{m:02d}" for m in range(1, 13)]
    return periods, month - 1


def _prior_period(p: str) -> str:
    """Previous calendar month (rolls the year at January)."""
    y, m = int(p[:4]), int(p[5:7])
    return f"{y - 1:04d}-12" if m == 1 else f"{y:04d}-{m - 1:02d}"


def _mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _in(periods: list[str]) -> str:
    return ", ".join(f"'{p}'" for p in periods)


def get_baseline(as_of: str | None = None,
                 scope_type: str = "consolidated",
                 scope_id: str = "ALL") -> BaselineSeries:
    """Build the consolidated `BaselineSeries` for the fiscal year of `as_of`.

    Actual months (<= as_of) come from the income statement; forecast months come
    from `budget_forecast` (falling back to the actuals run-rate for any line the
    budget doesn't carry). Interest, D&A and capex — not budgeted — extend at the
    trailing actual run-rate. WC days, opening balances and opening cash come from
    the governed WC / cash-flow views at the appropriate periods. Posted month-end
    cash for the actual months rides along as `posted_cash`, so the engine ties
    actual months to the books and forecasts from the last posted balance.

    Forecast-month **revenue** is taken from a seasonalized `ai_forecast` model
    (`ml_forecast.forecast_revenue`, on unless `SCENARIO_ML_FORECAST=0`) when the
    model returns a value for the period; otherwise it falls back to budget then
    run-rate. Where revenue is AI-forecast and the budget carries no COGS, COGS
    follows it at the actuals' COGS-to-revenue ratio (margin held); opex stays at
    run-rate (treated as largely fixed). `revenue_source` records which source won.
    """
    if scope_type != "consolidated" or scope_id != "ALL":
        # L1 is consolidated-grain; scope params are reserved for the L2 seam.
        raise NotImplementedError("get_baseline supports consolidated scope only in L1")
    as_of = seed_period(as_of)
    periods, hinge = _fy_window(as_of)
    actual_periods = periods[: hinge + 1]
    forecast_periods = periods[hinge + 1:]
    prior = _prior_period(periods[0])  # opening balances anchor (prior December)

    # ---- actual P&L by period x line_id (revenue/cogs/opex/interest_*/tax) ----
    pl: dict[str, dict[str, float]] = {p: {} for p in actual_periods}
    if actual_periods:
        for r in query(
            f"SELECT period, line_id, ROUND(SUM(amount),2) AS amount "
            f"FROM {SRV_FQ}.income_statement WHERE period IN ({_in(actual_periods)}) "
            f"GROUP BY period, line_id"
        ):
            pl.setdefault(str(r.get("period")), {})[str(r.get("line_id"))] = _f(r.get("amount"))

    # ---- actual D&A (account 65000 activity) by period ----
    dna_actual: dict[str, float] = {}
    if actual_periods:
        for r in query(
            f"SELECT period, ROUND(SUM(total_debits - total_credits),2) AS dna "
            f"FROM {SRV_FQ}.account_balance_by_bu "
            f"WHERE statement = 'IS' AND account_code = '{_DNA_ACCOUNT}' "
            f"AND period IN ({_in(actual_periods)}) GROUP BY period"
        ):
            dna_actual[str(r.get("period"))] = _f(r.get("dna"))

    # ---- budgeted forecast P&L (revenue/cogs/opex) by period ----
    budget: dict[str, dict[str, float]] = {p: {} for p in forecast_periods}
    if forecast_periods:
        for r in query(
            f"SELECT b.period AS period, "
            f"CASE WHEN c.account_type = 'Revenue' AND c.account_code <> '70000' THEN 'revenue' "
            f"     WHEN c.account_code = '50000' THEN 'cogs' ELSE 'opex' END AS line_id, "
            f"ROUND(SUM(b.forecast_amount),2) AS amount "
            f"FROM {CLOSE_FQ}.budget_forecast b "
            f"JOIN {CLOSE_FQ}.chart_of_accounts c ON b.account_code = c.account_code "
            f"WHERE b.period IN ({_in(forecast_periods)}) GROUP BY 1, 2"
        ):
            budget.setdefault(str(r.get("period")), {})[str(r.get("line_id"))] = _f(r.get("amount"))

    # ---- working capital at as_of (days) + prior December (opening balances) ----
    wc: dict[str, dict[str, float]] = {}
    for r in query(
        f"SELECT period, SUM(ar_balance) AS ar, SUM(ap_balance) AS ap, "
        f"SUM(inventory_balance) AS inv, SUM(revenue) AS rev, SUM(cogs) AS cogs, "
        f"MAX(days_in_period) AS days "
        f"FROM {SRV_FQ}.working_capital_kpis WHERE period IN ('{as_of}', '{prior}') GROUP BY period"
    ):
        wc[str(r.get("period"))] = {k: _f(r.get(k)) for k in ("ar", "ap", "inv", "rev", "cogs", "days")}
    at = wc.get(as_of, {})
    op = wc.get(prior, at)  # fall back to as_of if no prior row

    days = at.get("days") or (365.0 / 12.0)
    dso = round(at.get("ar", 0) / at["rev"] * days, 1) if at.get("rev") else 45.0
    dpo = round(at.get("ap", 0) / at["cogs"] * days, 1) if at.get("cogs") else 50.0
    dio = round(at.get("inv", 0) / at["cogs"] * days, 1) if at.get("cogs") else 60.0

    # ---- cash flow: opening cash (beginning of Jan), posted ending cash, capex ----
    cf: dict[str, dict[str, float]] = {}
    posted_end: dict[str, float] = {}
    if actual_periods:
        for r in query(
            f"SELECT period, SUM(beginning_cash) AS beg, SUM(ending_cash) AS end_cash, "
            f"SUM(capex) AS capex "
            f"FROM {SRV_FQ}.cash_flow WHERE period IN ({_in(actual_periods)}) GROUP BY period"
        ):
            per = str(r.get("period"))
            cf[per] = {"beg": _f(r.get("beg")), "capex": _f(r.get("capex"))}
            if r.get("end_cash") not in (None, ""):
                posted_end[per] = _f(r.get("end_cash"))
    opening_cash = cf.get(periods[0], {}).get("beg", 0.0)

    # ---- run-rates over the actual periods (for lines the budget doesn't carry) ----
    def actual_line(line_id: str) -> list[float]:
        return [pl.get(p, {}).get(line_id, 0.0) for p in actual_periods]

    rr_rev = _mean(actual_line("revenue"))
    rr_cogs = _mean(actual_line("cogs"))
    rr_opex = _mean(actual_line("opex"))
    rr_ii = _mean(actual_line("interest_income"))
    rr_ie = _mean(actual_line("interest_expense"))
    rr_dna = _mean([dna_actual.get(p, 0.0) for p in actual_periods])
    capex_actual = [cf.get(p, {}).get("capex", 0.0) for p in actual_periods]
    rev_actual = actual_line("revenue")
    cogs_ratio = (sum(actual_line("cogs")) / sum(rev_actual)) if sum(rev_actual) else None
    capex_pct = (sum(capex_actual) / sum(rev_actual) * 100.0) if sum(rev_actual) else 5.0

    # tax rate implied by the actuals (tax / pre-tax income), guarded.
    tax_actual = sum(actual_line("tax_expense"))
    pbt_actual = sum(r - c - o + ii - ie for r, c, o, ii, ie in zip(
        rev_actual, actual_line("cogs"), actual_line("opex"),
        actual_line("interest_income"), actual_line("interest_expense")))
    tax_rate = round(tax_actual / pbt_actual, 4) if pbt_actual else 0.25

    # Baseline financing/investing policy is 0 in L1: the serving `cash_flow` view
    # exposes only beginning_cash / collections / disbursements / capex / ending_cash —
    # no dividends, debt draws/repayments or M&A — and account 31000 commingles net
    # income with dividends, so there is no reliable baseline source. Dividends, debt
    # and acquisitions/disposals therefore act as pure *forecast levers* (the neutral
    # baseline carries none). Surfacing a real baseline payout is a Phase-1.5 item:
    # add a `dividends_paid` column to the serving cash_flow view via the seed pipeline.

    # ---- forecast-month revenue from the seasonalized ML model, when on ----
    ml_rev = ml_forecast.forecast_revenue(forecast_periods) if ml_forecast.enabled() else {}

    # ---- assemble the per-period baseline series ----
    revenue, cogs, opex, ii, ie, dna = [], [], [], [], [], []
    sources: set[str] = set()
    for i, p in enumerate(periods):
        if i <= hinge:  # actuals
            row = pl.get(p, {})
            revenue.append(row.get("revenue", rr_rev))
            cogs.append(row.get("cogs", rr_cogs))
            opex.append(row.get("opex", rr_opex))
            ii.append(row.get("interest_income", rr_ii))
            ie.append(row.get("interest_expense", rr_ie))
            dna.append(dna_actual.get(p, rr_dna))
        else:  # forecast: ML revenue (if on) → budgeted P&L → run-rate
            b = budget.get(p, {})
            if p in ml_rev:
                rev, src = ml_rev[p], "ai"
            elif "revenue" in b:
                rev, src = b["revenue"], "budget"
            else:
                rev, src = rr_rev, "run_rate"
            sources.add(src)
            revenue.append(rev)
            if "cogs" in b:
                cogs.append(b["cogs"])
            elif src == "ai" and cogs_ratio is not None:
                cogs.append(rev * cogs_ratio)  # margin held on the AI revenue path
            else:
                cogs.append(rr_cogs)
            opex.append(b.get("opex", rr_opex))
            ii.append(rr_ii)
            ie.append(rr_ie)
            dna.append(rr_dna)

    return BaselineSeries(
        periods=periods,
        hinge_index=hinge,
        revenue=revenue,
        cogs=cogs,
        opex=opex,
        interest_income=ii,
        interest_expense=ie,
        dna=dna,
        tax_rate=tax_rate,
        dso=dso,
        dpo=dpo,
        dio=dio,
        capex_pct=round(capex_pct, 2),
        opening_cash=opening_cash,
        opening_ar=op.get("ar", 0.0),
        opening_inventory=op.get("inv", 0.0),
        opening_ap=op.get("ap", 0.0),
        days_per_period=float(days),
        posted_cash=[posted_end.get(p) for p in periods] if posted_end else None,
        revenue_source=next((s for s in ("ai", "budget", "run_rate") if s in sources), "run_rate"),
    )
