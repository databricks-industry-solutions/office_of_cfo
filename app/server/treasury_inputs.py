"""13-Week Cash inputs — `get_inputs(as_of) -> TreasuryInputs`.

The only I/O piece of the treasury forecast, mirroring `scenario_baseline`: reads the
invoice history, the GL run-rates behind the rule-based flows, posted cash and the
FP&A projection, and hands them to the pure `treasury_engine.forecast`.

Boundary (MVP): consolidated scope, single currency, no intercompany / VAT /
factoring. Rules are fixed in `RULES` (no editor yet); amounts are trailing 3-month
GL run-rates so every industry gets numbers from its own books.
"""
from __future__ import annotations

import calendar
from datetime import date, timedelta

from .config import CLOSE_FQ, SRV_FQ
from .scenario_baseline import get_baseline, seed_period
from .scenario_engine import project
from .treasury_engine import (OTHER_WINDOW_WEEKS, RUN_RATE_MONTHS, FixedFlow, Invoice,
                              TreasuryInputs, recon_months)
from .warehouse import query

# Rule-based flows: (row id, GL selector, schedule, basis). Rent/utilities take only
# the GL-team accruals — rent billed by suppliers already settles through AP.
RULES: list[tuple[str, str, str, str]] = [
    ("payroll", "account_code = '60000' AND dr_cr = 'D'", "last_business_day",
     "Salaries & wages (GL 60000), last business day"),
    ("tax", "account_code = '80000' AND dr_cr = 'D'", "day:15",
     "Income tax expense (GL 80000), instalment on the 15th"),
    ("rent", "account_code IN ('61000', '62000') AND posted_by = 'gl.team' AND dr_cr = 'D'",
     "day:1", "Rent & utilities accruals (GL 61000/62000), 1st of the month"),
    ("interest_paid", "account_code = '71000' AND dr_cr = 'D'", "last_business_day",
     "Interest expense (GL 71000), last business day"),
    ("interest_received", "account_code = '70000' AND dr_cr = 'C'", "last_business_day",
     "Interest income (GL 70000), last business day"),
]
# Long tail rolled at its trailing 12-week average: inventory purchases paid straight
# from cash, and staff T&E.
_OTHER = ("(account_code = '10100' AND dr_cr = 'C' AND posted_by = 'inventory.subsystem') "
          "OR (account_code = '68000' AND dr_cr = 'D')")


def _f(v) -> float:
    if v is None or v == "":
        return 0.0
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _d(v) -> date | None:
    try:
        return date.fromisoformat(str(v)[:10]) if v not in (None, "") else None
    except ValueError:
        return None


def _month_end(period: str) -> date:
    y, m = int(period[:4]), int(period[5:7])
    return date(y, m, calendar.monthrange(y, m)[1])


def _trailing_periods(period: str, n: int) -> list[str]:
    y, m = int(period[:4]), int(period[5:7])
    out = []
    for k in range(n):
        t = y * 12 + (m - 1) - k
        out.append(f"{t // 12:04d}-{t % 12 + 1:02d}")
    return out


def _in(values: list[str]) -> str:
    return ", ".join(f"'{v}'" for v in values)


def _invoices(as_of: date) -> list[Invoice]:
    out = []
    for r in query(
        f"SELECT ledger, invoice_id, counterparty, amount, payment_terms, invoice_date, "
        f"due_date, paid_date FROM {SRV_FQ}.v_payment_behavior "
        f"WHERE invoice_date <= '{as_of.isoformat()}'"
    ):
        inv_d, due_d = _d(r.get("invoice_date")), _d(r.get("due_date"))
        if inv_d is None or due_d is None:
            continue
        out.append(Invoice(
            ledger=str(r.get("ledger")), invoice_id=str(r.get("invoice_id")),
            counterparty=str(r.get("counterparty")), amount=_f(r.get("amount")),
            terms=int(_f(r.get("payment_terms"))), invoice_date=inv_d, due_date=due_d,
            paid_date=_d(r.get("paid_date"))))
    return out


def _fixed(period: str) -> list[FixedFlow]:
    periods = _trailing_periods(period, RUN_RATE_MONTHS)
    cases = " ".join(f"WHEN {sel} THEN '{rid}'" for rid, sel, _s, _b in RULES)
    totals: dict[str, float] = {}
    for r in query(
        f"SELECT CASE {cases} END AS row_id, ROUND(SUM(amount), 2) AS amount "
        f"FROM {CLOSE_FQ}.gl_journal_entries WHERE period IN ({_in(periods)}) GROUP BY 1"
    ):
        if r.get("row_id"):
            totals[str(r["row_id"])] = _f(r.get("amount"))

    flows = [FixedFlow(rid, totals.get(rid, 0.0) / RUN_RATE_MONTHS, sched, basis)
             for rid, _sel, sched, basis in RULES]
    capex = query(
        f"SELECT ROUND(SUM(capex), 2) AS capex FROM {SRV_FQ}.cash_flow "
        f"WHERE period IN ({_in(periods)})")
    flows.append(FixedFlow("capex", _f(capex[0].get("capex")) / RUN_RATE_MONTHS if capex else 0.0,
                           "day:15", "Capex (cash-flow statement), mid-month"))
    return flows


def _other_daily(as_of: date) -> dict[date, float]:
    since = as_of - timedelta(days=7 * OTHER_WINDOW_WEEKS)
    out: dict[date, float] = {}
    for r in query(
        f"SELECT entry_date, ROUND(SUM(amount), 2) AS amount "
        f"FROM {CLOSE_FQ}.gl_journal_entries WHERE ({_OTHER}) "
        f"AND entry_date > '{since.isoformat()}' AND entry_date <= '{as_of.isoformat()}' "
        f"GROUP BY entry_date"
    ):
        d = _d(r.get("entry_date"))
        if d is not None:
            out[d] = _f(r.get("amount"))
    return out


def _opening_cash(period: str) -> float:
    rows = query(f"SELECT ROUND(SUM(ending_cash), 2) AS cash FROM {SRV_FQ}.cash_flow "
                 f"WHERE period = '{period}'")
    return _f(rows[0].get("cash")) if rows else 0.0


def _fpa(period: str, months: list[str], assumptions: dict | None) -> tuple[dict, list[dict], float | None, str]:
    """FP&A revenue forecast + month 1–3 cash lines from the scenario engine. The
    baseline is the fiscal year of the close, so months past December are absent."""
    baseline = get_baseline(period)
    ss = project(baseline, assumptions or {})
    idx = {p: i for i, p in enumerate(ss.periods)}
    revenue = {p: ss.lines["revenue"][i] for p, i in idx.items() if i > ss.hinge_index}
    rows = []
    for per in months:
        i = idx.get(per)
        if i is None:
            continue
        line = {k: v[i] for k, v in ss.lines.items()}
        receipts = line["revenue"] - line["delta_ar"]
        rows.append({
            "period": per,
            "receipts": receipts,
            "operating_payments": receipts - line["operating_cash"],
            "capex": line["capex"],
            "net_change": line["net_change_in_cash"],
            "ending_cash": line["ending_cash"],
        })
    m1 = idx.get(months[0])
    min_cash = (ss.lines["cogs"][m1] + ss.lines["opex"][m1]) if m1 is not None else None
    return revenue, rows, min_cash, baseline.revenue_source


def get_inputs(as_of: str | None = None, assumptions: dict | None = None,
               min_cash: float | None = None) -> TreasuryInputs:
    """Everything the 13-week engine needs for the close `as_of` (seed YYYY-MM)."""
    period = seed_period(as_of)
    close = _month_end(period)
    revenue, fpa_rows, default_min, source = _fpa(period, recon_months(close), assumptions)
    return TreasuryInputs(
        as_of=close,
        opening_cash=_opening_cash(period),
        invoices=_invoices(close),
        fixed=_fixed(period),
        other_daily=_other_daily(close),
        revenue_forecast=revenue,
        fpa_months=fpa_rows,
        min_cash=min_cash if min_cash is not None else default_min,
        revenue_source=source,
    )
