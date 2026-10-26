"""FP&A Scenario Planning — the pure projection engine (L1).

This is the deterministic, side-effect-free core. It takes a per-period **baseline** and a
set of driver **assumptions** and produces a **StatementSet** (P&L + articulated
cash) over the horizon. No I/O, no config, no warehouse — everything the engine
needs is passed in, so it is trivially unit-testable and identical whether it runs
for a live `/project` preview or to freeze a committed scenario.

Design commitments honoured here:

* **Declarative composition, re-evaluated.** Each period's statement is computed as
  a small ordered graph of nodes (leaves → subtotals → cash), evaluated top-to-bottom.
  We recompute the whole graph every call rather than propagating deltas. Extending to
  a richer grain later (opex sub-lines, per-industry driver trees — the deferred A1
  upgrade) is *adding nodes*, not rewriting the engine.
* **Articulated cash, tie-out by construction.** Cash is derived *from* the P&L + the
  working-capital deltas (indirect method) + the investing/financing lines, never
  reconciled against an independent figure — so `cash_balance` (== `ending_cash`) always
  rolls forward from opening cash by the period's net change in cash
  (`operating_cash + investing_cash + financing_cash`). `free_cash_flow` (CFO − capex)
  is kept as a reported metric, not the roll driver.
  Actual months are the exception: when the baseline carries posted month-end cash,
  `cash_balance` is pinned to the books and the difference from the modelled roll is
  shown as `other_cash` (still part of the net change, so the bridge ties out). The
  forecast then rolls on from the last *posted* balance, not a modelled one.
  Boundary: a three-section cash-flow statement (CFO/CFI/CFF) + a cash *balance*, NOT a
  balancing balance sheet (debt/PP&E/equity roll-forward → deferred to L2).
* **Baseline is an injected input** (`BaselineSeries`), produced elsewhere by
  `get_baseline(...)` — run-rate + budget in L1, an ML forecast later. The
  engine neither knows nor cares which. The horizon is embedded in `baseline.periods`.
* **Self-describing assumptions.** An assumption may be a bare number or
  `{"value": .., "unit": .., "mode": ..}`; the engine reads the value and applies the
  semantics it knows for that driver id.
"""
from __future__ import annotations

from dataclasses import dataclass, field

# Days used to convert working-capital *days* into a period balance. The route that
# builds the baseline MUST feed DSO/DPO/DIO on the same convention the app's KPI
# surfaces use (kpis.py / working_capital_kpis) so a scenario's baseline ties to the
# numbers shown elsewhere. 365/12 = average month length.
DAYS_PER_MONTH = 365.0 / 12.0

# Canonical statement lines the engine emits (the graph's nodes). This list is the
# contract for `StatementSet.lines` and the `frozen_result` payload. Ordered as a
# real cash-flow statement: P&L → operating (CFO) → investing (CFI) → financing (CFF)
# → the beginning→net-change→ending bridge (`cash_balance` == `ending_cash`).
LINE_IDS = [
    # --- P&L ---
    "revenue", "cogs", "gross_profit", "opex", "operating_income",
    "interest_income", "interest_expense", "tax", "net_income",
    # --- Operating cash (CFO) ---
    "dna", "delta_ar", "delta_inventory", "delta_ap", "operating_cash",
    # --- Investing cash (CFI): asset sales in, capex + acquisitions out ---
    "capex", "acquisitions", "asset_sales", "investing_cash",
    # --- Financing cash (CFF): debt drawn in, repayments + dividends out ---
    "debt_draw", "debt_repayment", "dividends", "financing_cash",
    # --- Actual months only: posted cash movement the model doesn't explain ---
    "other_cash",
    # --- Bridge: beginning + net change = ending (cash_balance is the ending) ---
    "free_cash_flow", "beginning_cash", "net_change_in_cash", "ending_cash", "cash_balance",
]


# --------------------------------------------------------------------------- #
# Driver catalog — the `assumptions` contract (served by GET /scenario/drivers).
# Industry-agnostic here; per-industry hide/relabel happens in the overlay/route.
# --------------------------------------------------------------------------- #
DRIVER_CATALOG: list[dict] = [
    {"id": "revenue_growth", "label": "Revenue growth", "group": "Revenue",
     "unit": "%", "mode": "growth", "applies_to": "revenue", "min": -20, "max": 20, "step": 0.5, "default": 0},
    {"id": "gross_margin", "label": "Gross margin", "group": "Cost",
     "unit": "bps", "mode": "shift", "applies_to": "cogs", "min": -400, "max": 400, "step": 10, "default": 0},
    {"id": "opex_growth", "label": "Opex growth", "group": "Cost",
     "unit": "%", "mode": "growth", "applies_to": "opex", "min": -10, "max": 15, "step": 0.5, "default": 0},
    {"id": "dso", "label": "DSO", "group": "Working capital & capex",
     "unit": "days", "mode": "delta", "applies_to": "cash", "min": -15, "max": 15, "step": 1, "default": 0},
    {"id": "dpo", "label": "DPO", "group": "Working capital & capex",
     "unit": "days", "mode": "delta", "applies_to": "cash", "min": -15, "max": 15, "step": 1, "default": 0},
    {"id": "dio", "label": "DIO", "group": "Working capital & capex",
     "unit": "days", "mode": "delta", "applies_to": "cash", "min": -15, "max": 15, "step": 1, "default": 0},
    {"id": "capex_pct", "label": "Capex intensity", "group": "Working capital & capex",
     "unit": "% rev", "mode": "ratio", "applies_to": "cash", "min": 0, "max": 15, "step": 0.25, "default": None},
    # ---- Investing (CFI): scale-invariant as % of revenue so ranges hold across industries ----
    {"id": "acquisitions", "label": "Acquisitions", "group": "Investing",
     "unit": "% rev", "mode": "ratio", "applies_to": "cash", "min": 0, "max": 25, "step": 0.5, "default": 0},
    {"id": "asset_sales", "label": "Asset disposals", "group": "Investing",
     "unit": "% rev", "mode": "ratio", "applies_to": "cash", "min": 0, "max": 25, "step": 0.5, "default": 0},
    # ---- Financing (CFF): debt as % of revenue; dividends as a payout % of net income ----
    {"id": "debt_draw", "label": "New debt drawn", "group": "Financing",
     "unit": "% rev", "mode": "ratio", "applies_to": "cash", "min": 0, "max": 25, "step": 0.5, "default": 0},
    {"id": "debt_repayment", "label": "Debt repayment", "group": "Financing",
     "unit": "% rev", "mode": "ratio", "applies_to": "cash", "min": 0, "max": 25, "step": 0.5, "default": 0},
    {"id": "dividend_payout", "label": "Dividend payout", "group": "Financing",
     "unit": "% NI", "mode": "payout", "applies_to": "cash", "min": 0, "max": 100, "step": 5, "default": None},
]

def driver_catalog() -> list[dict]:
    """The driver catalog (a copy, so callers can relabel/filter per industry)."""
    return [dict(d) for d in DRIVER_CATALOG]


# --------------------------------------------------------------------------- #
# Data shapes
# --------------------------------------------------------------------------- #
@dataclass
class BaselineSeries:
    """Per-period baseline inputs for the graph's leaves, for one scope + as-of.

    `periods` spans the display window (locked actuals through `hinge_index`, forecast
    beyond); driver assumptions apply only to forecast periods (index > hinge_index).
    List fields are per-period and length == len(periods); rate/day fields are the
    scope's baseline levels; opening_* are the balances at the start of periods[0].
    """
    periods: list[str]
    hinge_index: int
    revenue: list[float]
    cogs: list[float]
    opex: list[float]
    interest_income: list[float]
    interest_expense: list[float]
    dna: list[float]
    tax_rate: float
    dso: float
    dpo: float
    dio: float
    capex_pct: float                 # baseline capex as % of revenue (e.g. 5.0)
    opening_cash: float
    opening_ar: float
    opening_inventory: float
    opening_ap: float
    # Baseline financing/investing policy — the "do nothing" cash flows the forecast
    # carries before any lever is moved. Dividend payout is a % of net income (matches
    # the actuals' declaration policy); debt/acquisition/disposal baselines are 0 (no
    # scheduled activity in the L1 data — they exist purely as forecast levers).
    dividend_payout: float = 0.0     # baseline dividend payout as % of net income
    acquisitions_pct: float = 0.0    # baseline acquisitions as % of revenue
    asset_sales_pct: float = 0.0     # baseline asset disposals as % of revenue
    debt_draw_pct: float = 0.0       # baseline new debt drawn as % of revenue
    debt_repayment_pct: float = 0.0  # baseline debt repayment as % of revenue
    days_per_period: float = DAYS_PER_MONTH
    # Posted month-end cash per period (actuals only; None where not posted). When
    # set, actual months' `cash_balance` ties to the books — see `other_cash`.
    posted_cash: list[float | None] | None = None
    # Where forecast-month revenue came from: "ai" (ml_forecast), "budget" or
    # "run_rate". Display metadata only — the engine never reads it.
    revenue_source: str = "run_rate"


@dataclass
class StatementSet:
    """The engine's output: per-period node values + KPIs, with the actuals hinge.

    This is exactly what a `/project` call returns and what a committed scenario's
    `frozen_result` stores (as {baseline, projection})."""
    periods: list[str]
    hinge_index: int
    lines: dict[str, list[float]] = field(default_factory=dict)
    kpis: dict[str, list[float]] = field(default_factory=dict)


# --------------------------------------------------------------------------- #
# Assumption access
# --------------------------------------------------------------------------- #
def _value(assumptions: dict | None, driver_id: str, default: float | None) -> float | None:
    """Read a driver's numeric value from `assumptions`.

    Accepts self-describing `{"value": ..}` entries or a bare number; missing/blank
    falls back to `default`."""
    if not assumptions:
        return default
    raw = assumptions.get(driver_id)
    if raw is None:
        return default
    if isinstance(raw, dict):
        raw = raw.get("value")
    if raw is None or raw == "":
        return default
    try:
        return float(raw)
    except (TypeError, ValueError):
        return default


# --------------------------------------------------------------------------- #
# The projection
# --------------------------------------------------------------------------- #
def project(baseline: BaselineSeries, assumptions: dict | None = None) -> StatementSet:
    """Project the articulated P&L + cash for `assumptions` over `baseline.periods`.

    Deterministic and pure. Actual periods (index <= hinge_index) pass through
    unchanged; forecast periods are flexed by the drivers. Cash is derived from the
    P&L + working-capital deltas so it ties out by construction.
    """
    n = len(baseline.periods)
    assumptions = assumptions or {}

    g = (_value(assumptions, "revenue_growth", 0.0) or 0.0) / 100.0
    gm_shift = (_value(assumptions, "gross_margin", 0.0) or 0.0) / 10000.0
    og = (_value(assumptions, "opex_growth", 0.0) or 0.0) / 100.0
    dso_delta = _value(assumptions, "dso", 0.0) or 0.0
    dpo_delta = _value(assumptions, "dpo", 0.0) or 0.0
    dio_delta = _value(assumptions, "dio", 0.0) or 0.0
    capex_override = _value(assumptions, "capex_pct", None)
    # Investing / financing overrides (forecast-only, like capex). Each falls back to
    # the baseline policy so the "do nothing" forecast still carries real cash flows.
    acq_override = _value(assumptions, "acquisitions", None)
    disposal_override = _value(assumptions, "asset_sales", None)
    debt_draw_override = _value(assumptions, "debt_draw", None)
    debt_repay_override = _value(assumptions, "debt_repayment", None)
    payout_override = _value(assumptions, "dividend_payout", None)

    lines: dict[str, list[float]] = {k: [0.0] * n for k in LINE_IDS}
    dpp = baseline.days_per_period

    prev_ar = baseline.opening_ar
    prev_inv = baseline.opening_inventory
    prev_ap = baseline.opening_ap
    prev_cash = baseline.opening_cash

    for i in range(n):
        forecast = i > baseline.hinge_index

        # ---- P&L nodes (leaves → subtotals) ----
        base_rev = baseline.revenue[i]
        revenue = base_rev * (1.0 + g) if forecast else base_rev
        base_margin = 1.0 - (baseline.cogs[i] / base_rev) if base_rev else 0.0
        margin = base_margin + (gm_shift if forecast else 0.0)
        cogs = revenue * (1.0 - margin)
        gross_profit = revenue - cogs
        opex = baseline.opex[i] * (1.0 + og) if forecast else baseline.opex[i]
        operating_income = gross_profit - opex
        interest_income = baseline.interest_income[i]
        interest_expense = baseline.interest_expense[i]
        pbt = operating_income + interest_income - interest_expense
        tax = pbt * baseline.tax_rate
        net_income = pbt - tax

        # ---- Working capital (indirect-method cash) ----
        dso_i = baseline.dso + (dso_delta if forecast else 0.0)
        dio_i = baseline.dio + (dio_delta if forecast else 0.0)
        dpo_i = baseline.dpo + (dpo_delta if forecast else 0.0)
        ar = dso_i / dpp * revenue
        inventory = dio_i / dpp * cogs
        ap = dpo_i / dpp * cogs
        delta_ar = ar - prev_ar
        delta_inventory = inventory - prev_inv
        delta_ap = ap - prev_ap

        dna = baseline.dna[i]

        # ---- Operating cash (CFO), indirect method ----
        operating_cash = net_income + dna - delta_ar - delta_inventory + delta_ap

        # ---- Investing cash (CFI): capex + acquisitions out, disposals in ----
        # A driver override only bites on forecast periods; actuals keep the baseline.
        def _pct(override, base):
            return (override if (forecast and override is not None) else base) / 100.0 * revenue
        capex = _pct(capex_override, baseline.capex_pct)
        acquisitions = _pct(acq_override, baseline.acquisitions_pct)
        asset_sales = _pct(disposal_override, baseline.asset_sales_pct)
        investing_cash = asset_sales - capex - acquisitions

        # ---- Financing cash (CFF): debt drawn in, repayments + dividends out ----
        debt_draw = _pct(debt_draw_override, baseline.debt_draw_pct)
        debt_repayment = _pct(debt_repay_override, baseline.debt_repayment_pct)
        payout_i = payout_override if (forecast and payout_override is not None) else baseline.dividend_payout
        dividends = payout_i / 100.0 * max(net_income, 0.0)  # no dividend on a loss
        financing_cash = debt_draw - debt_repayment - dividends

        # ---- Bridge (tie-out by construction): begin + net change = end ----
        free_cash_flow = operating_cash - capex          # reported metric, not the roll driver
        beginning_cash = prev_cash
        modelled_change = operating_cash + investing_cash + financing_cash
        posted = baseline.posted_cash[i] if (baseline.posted_cash and not forecast) else None
        # Actual month with posted cash: pin to the books; the unexplained remainder is
        # `other_cash`. Forecast months (and unposted actuals) carry none.
        other_cash = (posted - beginning_cash - modelled_change) if posted is not None else 0.0
        net_change_in_cash = modelled_change + other_cash
        cash_balance = beginning_cash + net_change_in_cash

        lines["revenue"][i] = revenue
        lines["cogs"][i] = cogs
        lines["gross_profit"][i] = gross_profit
        lines["opex"][i] = opex
        lines["operating_income"][i] = operating_income
        lines["interest_income"][i] = interest_income
        lines["interest_expense"][i] = interest_expense
        lines["tax"][i] = tax
        lines["net_income"][i] = net_income
        lines["dna"][i] = dna
        lines["delta_ar"][i] = delta_ar
        lines["delta_inventory"][i] = delta_inventory
        lines["delta_ap"][i] = delta_ap
        lines["operating_cash"][i] = operating_cash
        lines["capex"][i] = capex
        lines["acquisitions"][i] = acquisitions
        lines["asset_sales"][i] = asset_sales
        lines["investing_cash"][i] = investing_cash
        lines["debt_draw"][i] = debt_draw
        lines["debt_repayment"][i] = debt_repayment
        lines["dividends"][i] = dividends
        lines["financing_cash"][i] = financing_cash
        lines["other_cash"][i] = other_cash
        lines["free_cash_flow"][i] = free_cash_flow
        lines["beginning_cash"][i] = beginning_cash
        lines["net_change_in_cash"][i] = net_change_in_cash
        lines["ending_cash"][i] = cash_balance
        lines["cash_balance"][i] = cash_balance

        prev_ar, prev_inv, prev_ap, prev_cash = ar, inventory, ap, cash_balance

    kpis = _kpis(baseline, lines, dso_delta, dpo_delta, dio_delta)
    return StatementSet(periods=list(baseline.periods), hinge_index=baseline.hinge_index,
                        lines=lines, kpis=kpis)


def _kpis(baseline: BaselineSeries, lines: dict[str, list[float]],
          dso_delta: float, dpo_delta: float, dio_delta: float) -> dict[str, list[float]]:
    n = len(baseline.periods)
    gm, om, dso, dpo, dio, ccc = ([0.0] * n for _ in range(6))
    for i in range(n):
        forecast = i > baseline.hinge_index
        rev = lines["revenue"][i]
        gm[i] = (lines["gross_profit"][i] / rev * 100.0) if rev else 0.0
        om[i] = (lines["operating_income"][i] / rev * 100.0) if rev else 0.0
        dso[i] = baseline.dso + (dso_delta if forecast else 0.0)
        dpo[i] = baseline.dpo + (dpo_delta if forecast else 0.0)
        dio[i] = baseline.dio + (dio_delta if forecast else 0.0)
        ccc[i] = dso[i] + dio[i] - dpo[i]
    return {"gross_margin_pct": gm, "operating_margin_pct": om,
            "dso": dso, "dpo": dpo, "dio": dio, "ccc": ccc}
