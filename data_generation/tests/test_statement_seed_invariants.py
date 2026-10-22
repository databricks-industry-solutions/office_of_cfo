"""Invariants for GAAP statement seed data (run after generate_close_data)."""

from pathlib import Path

import pandas as pd

OUT = Path(__file__).resolve().parents[1] / "output" / "landing"

REQUIRED_COA = {"70000", "71000", "80000", "30000", "31000"}


def test_coa_has_gaap_accounts():
    coa = pd.read_parquet(OUT / "chart_of_accounts.parquet")
    codes = set(coa["account_code"].astype(str))
    missing = REQUIRED_COA - codes
    assert not missing, f"COA missing {missing}"


def test_equity_accounts_have_activity():
    gl = pd.read_parquet(OUT / "gl_journal_entries.parquet")
    equity = gl[gl["account_code"].astype(str).isin(["30000", "31000"])]
    assert len(equity) > 0, "Expected Common Stock / RE journal lines"


def test_below_the_line_accounts_have_activity():
    gl = pd.read_parquet(OUT / "gl_journal_entries.parquet")
    for code in ("70000", "71000", "80000"):
        assert (gl["account_code"].astype(str) == code).any(), f"No journals for {code}"


def test_cash_flow_has_dividends_paid():
    cf = pd.read_parquet(OUT / "cash_flow.parquet")
    assert "dividends_paid" in cf.columns
    assert cf["dividends_paid"].sum() > 0


def test_tax_accrual_is_22pct_of_pretax_income():
    """Tax on 80000 must be 22% of pre-tax income (revenue − cogs − opex + interest_net).

    Rebuilds the seed tax base from observable journal lines for one BU/period.
    Fails if tax was computed with the wrong interest_net sign (subtract instead of add).
    """
    gl = pd.read_parquet(OUT / "gl_journal_entries.parquet")
    # Prefer a clean historical period (not the active close with seeded breaks).
    periods = sorted(gl["period"].astype(str).unique())
    period = periods[1] if len(periods) > 1 else periods[0]
    bu = "BU-100"
    s = gl[(gl["period"].astype(str) == period) & (gl["business_unit_id"] == bu)].copy()
    assert len(s) > 0, f"No GL rows for {bu}/{period}"
    code = s["account_code"].astype(str)

    revenue = float(s.loc[code.isin(["40000", "41000"]) & (s["dr_cr"] == "C"), "amount"].sum())
    cogs = float(
        s.loc[
            (code == "50000") & (s["dr_cr"] == "D") & (s["description"] == "COGS on sale"),
            "amount",
        ].sum()
    )
    opex = float(
        s.loc[
            (
                ((code == "60000") & s["description"].astype(str).str.startswith("Payroll run"))
                | ((code == "68000") & s["description"].astype(str).str.startswith("Staff expense"))
                | ((code == "61000") & (s["description"] == "Monthly rent"))
                | ((code == "62000") & (s["description"] == "Utilities"))
                | ((code == "65000") & (s["description"] == "Monthly depreciation"))
            )
            & (s["dr_cr"] == "D"),
            "amount",
        ].sum()
    )
    interest_income = float(s.loc[(code == "70000") & (s["dr_cr"] == "C"), "amount"].sum())
    interest_expense = float(s.loc[(code == "71000") & (s["dr_cr"] == "D"), "amount"].sum())
    interest_net = interest_income - interest_expense
    assert interest_net != 0, "interest_net must be non-zero for this regression to detect wrong sign"

    pretax = revenue - cogs - opex + interest_net
    expected_tax = round(pretax * 0.22, 2) if pretax > 0 else 0.0
    tax_posted = float(s.loc[(code == "80000") & (s["dr_cr"] == "D"), "amount"].sum())
    assert tax_posted > 0, f"Expected a tax accrual for {bu}/{period}"
    assert abs(tax_posted - expected_tax) < 0.01, (
        f"Tax for {bu}/{period}={tax_posted} != 22% of pretax {pretax:.2f} "
        f"(expected {expected_tax}; interest_net={interest_net}). "
        "Tax base must be revenue − cogs − opex + interest_net."
    )


def test_cash_flow_chains_month_to_month():
    """Each BU's beginning cash is the prior month's ending cash, and no BU is overdrawn."""
    cf = pd.read_parquet(OUT / "cash_flow.parquet").sort_values(["business_unit_id", "period"])
    prior_end = cf.groupby("business_unit_id")["ending_cash"].shift(1)
    gaps = (cf["beginning_cash"] - prior_end).dropna().abs()
    assert gaps.max() < 0.01, f"cash_flow months don't chain (max gap {gaps.max():,.2f})"
    rolled = cf.beginning_cash + cf.collections - cf.operating_disbursements - cf.capex - cf.dividends_paid
    assert (rolled - cf.ending_cash).abs().max() < 1.0
    assert cf["ending_cash"].min() > 0, "a BU ends a month overdrawn"


def test_cash_change_articulates_with_the_pnl():
    """Consolidated change in cash = net income + depreciation - change in open AR
    + change in open AP - inventory build - capex - dividends (indirect method).
    Clean historical months tie to the cent; the active close carries the seeded
    GL breaks, so it only has to land within 1% of operating cash flow."""
    cf = pd.read_parquet(OUT / "cash_flow.parquet")
    gl = pd.read_parquet(OUT / "gl_journal_entries.parquet")
    ar = pd.read_parquet(OUT / "subledger_ar.parquet")
    ap = pd.read_parquet(OUT / "subledger_ap.parquet")
    inv = pd.read_parquet(OUT / "subledger_inventory.parquet")
    periods = sorted(cf["period"].unique())

    def open_at(df, period):
        end = pd.Period(period).end_time.normalize()
        issued = pd.to_datetime(df["invoice_date"]) <= end
        paid = pd.to_datetime(df["paid_date"], errors="coerce")
        return float(df.loc[issued & (paid.isna() | (paid > end)), "amount"].sum())

    gl = gl.assign(cr=gl.amount.where(gl.dr_cr == "C", -gl.amount), code=gl.account_code.astype(str))
    month = cf.groupby("period")[["beginning_cash", "ending_cash", "capex", "dividends_paid"]].sum()
    # Skip the first months: their cash includes the pre-history stand-in invoices,
    # which are not in the subledgers.
    for prev, p in zip(periods[3:], periods[4:]):
        g = gl[gl.period == p]
        net_income = float(g.loc[g.code >= "40000", "cr"].sum())
        dep = -float(g.loc[g.code == "65000", "cr"].sum())
        d_ar = open_at(ar, p) - open_at(ar, prev)
        d_ap = open_at(ap, p) - open_at(ap, prev)
        build = float(inv.loc[inv.period == p, "inventory_value"].sum())
        m = month.loc[p]
        expected = net_income + dep - d_ar + d_ap - build - m.capex - m.dividends_paid
        actual = m.ending_cash - m.beginning_cash
        ocf = actual + m.capex + m.dividends_paid
        tol = 0.01 * abs(ocf) if p == periods[-1] else 1.0
        assert abs(actual - expected) <= tol, (
            f"{p}: cash change {actual:,.0f} vs P&L-implied {expected:,.0f}")


def _running(gl, code):
    g = gl[gl["account_code"].astype(str) == code]
    signed = g.amount.where(g.dr_cr == "D", -g.amount)
    return signed.groupby([g.business_unit_id, g.period]).sum().groupby(level=0).cumsum()


def test_gl_cash_ties_to_cash_flow():
    """The GL posts every receipt and payment the cash_flow table counts, so the
    running GL cash (10100) equals cash_flow ending cash for every BU-month."""
    gl = pd.read_parquet(OUT / "gl_journal_entries.parquet")
    cf = pd.read_parquet(OUT / "cash_flow.parquet").set_index(["business_unit_id", "period"])
    gap = (_running(gl, "10100").reindex(cf.index).fillna(0.0) - cf["ending_cash"]).abs()
    assert gap.max() < 0.01, f"GL cash drifts from cash_flow (max gap {gap.max():,.2f})"


def test_gl_ar_ap_equal_open_invoices():
    """Settlements clear AR / AP: at the active close the GL balance is the
    invoices still open, except AP at BU-300 (seeded timing break)."""
    gl = pd.read_parquet(OUT / "gl_journal_entries.parquet")
    close = gl["period"].max()
    end = pd.Period(close).end_time.normalize()
    for code, name in (("11000", "subledger_ar"), ("20000", "subledger_ap")):
        sub = pd.read_parquet(OUT / f"{name}.parquet")
        paid = pd.to_datetime(sub["paid_date"], errors="coerce")
        open_ = sub[paid.isna() | (paid > end)].groupby("business_unit_id")["amount"].sum()
        sign = 1 if code == "11000" else -1
        gl_bal = sign * _running(gl, code).xs(close, level="period")
        gap = (open_ - gl_bal.reindex(open_.index).fillna(0.0)).abs()
        if code == "20000":
            gap = gap.drop("BU-300")
        assert gap.max() < 0.01, f"{code}: GL vs open invoices gap {gap.max():,.2f}"


def test_liabilities_settle_instead_of_accumulating():
    """Payroll and tax are paid in the month they are booked, so their GL
    balances stay at zero instead of growing every month."""
    gl = pd.read_parquet(OUT / "gl_journal_entries.parquet")
    for code in ("22000", "23000"):
        assert _running(gl, code).abs().max() < 0.01, f"{code} accumulates"


def test_bank_feed_chains_and_keeps_the_deposit_in_transit():
    """Bank statements chain month to month and match GL cash, except the seeded
    deposit in transit at BU-400 on the active close."""
    gl = pd.read_parquet(OUT / "gl_journal_entries.parquet")
    bank = pd.read_parquet(OUT / "subledger_bank.parquet").sort_values(["business_unit_id", "period"])
    prior = bank.groupby("business_unit_id")["closing_balance"].shift(1)
    close = bank["period"].max()
    chained = bank[(bank.period != bank.period.min()) & (prior.notna())]
    transit = (chained.business_unit_id == "BU-400") & (chained.period == close)
    gaps = (chained.opening_balance - prior[chained.index]).abs()
    assert gaps[~transit].max() < 0.01
    diff = (bank.set_index(["business_unit_id", "period"])["closing_balance"]
            - _running(gl, "10100")).dropna().round(2)
    breaks = diff[diff.abs() > 1.0]
    assert breaks.to_dict() == {("BU-400", close): 8500.0}
