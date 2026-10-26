"""13-Week Cash — the pure treasury forecast engine (direct method).

Deterministic and side-effect-free, like `scenario_engine.project`: everything it
needs arrives in `TreasuryInputs` (built by `treasury_inputs.get_inputs`), so it is
unit-testable without a warehouse. It forecasts actual receipts and payments,
day by day, from the close date forward and rolls them into a 13-week grid plus a
month 1–3 tie-out against the FP&A (indirect) projection.

Three kinds of line, per the treasury pattern:

* **AI-predicted** — open customer and supplier invoices settle on an *expected*
  date, not the due date: each counterparty's own days-paid-vs-due history (shrunk
  toward the ledger average when the history is thin) shifts the due date, and the
  spread of that history sets a High / Medium / Low confidence.
* **Rule-based** — payroll, tax, rent, interest and capex land on a fixed calendar
  (e.g. last business day) at their trailing monthly run-rate.
* **Rolling baseline** — the long tail (inventory purchases, staff T&E) projects at
  its trailing 12-week average, spread over business days.

Sales not yet invoiced (and supplier invoices not yet received) fill the later weeks:
the FP&A revenue forecast (AP: the trailing invoicing run-rate) is invoiced daily and
collected after the ledger's average payment lag.

No look-ahead: only invoices settled on or before `as_of` feed the payment history.
An open invoice's recorded `paid_date` (the seed knows when it eventually settles)
is never used for its forecast — that is the backtest's "actual" (Phase 3).
"""
from __future__ import annotations

import calendar
import math
from dataclasses import dataclass, field
from datetime import date, timedelta

WEEKS = 13
# Pseudo-invoices pulling a counterparty's mean/spread toward the ledger average, so
# a customer with three invoices doesn't get a confident, extreme payment habit.
SHRINK_K = 5.0
SD_FLOOR = 1.0
DEFAULT_SD = 5.0
# Confidence = chance the invoice lands in its predicted week (within ±3.5 days of the
# expected date): High when more likely than not with margin (≥60%), Low under 35%.
# Provisional bands until the Phase-3 backtest calibrates them against actuals.
_CONF_WINDOW = 3.5
_HIGH, _MEDIUM = 0.60, 0.35
_THIN_HISTORY = 6           # fewer paid invoices than this caps confidence at Medium
OTHER_WINDOW_WEEKS = 12
RUN_RATE_MONTHS = 3

# Grid rows, top to bottom. `method` drives the UI chip; `direction` the sign.
ROWS: list[dict] = [
    {"id": "receipts_open", "label": "Customer receipts: open invoices",
     "direction": "in", "method": "ai"},
    {"id": "receipts_new", "label": "Customer receipts: sales not yet invoiced",
     "direction": "in", "method": "forecast"},
    {"id": "interest_received", "label": "Interest received",
     "direction": "in", "method": "rule"},
    {"id": "suppliers_open", "label": "Supplier payments: open invoices",
     "direction": "out", "method": "ai"},
    {"id": "suppliers_new", "label": "Supplier payments: invoices not yet received",
     "direction": "out", "method": "forecast"},
    {"id": "payroll", "label": "Payroll", "direction": "out", "method": "rule"},
    {"id": "tax", "label": "Income tax", "direction": "out", "method": "rule"},
    {"id": "rent", "label": "Rent & utilities", "direction": "out", "method": "rule"},
    {"id": "interest_paid", "label": "Interest paid", "direction": "out", "method": "rule"},
    {"id": "other", "label": "Other operating (inventory, T&E)",
     "direction": "out", "method": "rolling"},
    {"id": "capex", "label": "Capex", "direction": "out", "method": "rule"},
]
_ROW_BY_ID = {r["id"]: r for r in ROWS}


@dataclass(frozen=True)
class Invoice:
    ledger: str                 # 'ar' (customer) | 'ap' (supplier)
    invoice_id: str
    counterparty: str
    amount: float
    terms: int
    invoice_date: date
    due_date: date
    paid_date: date | None      # eventual settlement; only trusted when <= as_of


@dataclass(frozen=True)
class FixedFlow:
    """A rule-based flow: `monthly_amount` lands once a month on `schedule`."""
    row_id: str                 # one of the rule rows in ROWS
    monthly_amount: float
    schedule: str               # 'last_business_day' | 'day:<N>'
    basis: str                  # human-readable source, shown in the UI


@dataclass
class TreasuryInputs:
    as_of: date                             # close date (last actual day)
    opening_cash: float                     # posted cash at as_of
    invoices: list[Invoice]
    fixed: list[FixedFlow]
    other_daily: dict[date, float]          # long-tail outflows by posting date (trailing)
    revenue_forecast: dict[str, float]      # 'YYYY-MM' -> forecast revenue (FP&A baseline)
    fpa_months: list[dict] = field(default_factory=list)  # month 1–3 FP&A lines
    min_cash: float | None = None
    revenue_source: str = "run_rate"


@dataclass(frozen=True)
class Profile:
    ledger: str
    counterparty: str
    n: int
    mean: float                 # days paid vs due (+ late, − early), shrunk
    sd: float
    terms: int


@dataclass
class _Flow:
    day: date
    row_id: str
    amount: float               # always positive; the row carries the direction
    confidence: str | None = None


# --------------------------------------------------------------------------- #
# Calendar helpers
# --------------------------------------------------------------------------- #
def _roll_forward(d: date) -> date:
    """Weekend → next Monday (banks don't settle on Saturday/Sunday)."""
    while d.weekday() >= 5:
        d += timedelta(days=1)
    return d


def _roll_back(d: date) -> date:
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


def _month_end(y: int, m: int) -> date:
    return date(y, m, calendar.monthrange(y, m)[1])


def _add_months(y: int, m: int, k: int) -> tuple[int, int]:
    t = y * 12 + (m - 1) + k
    return t // 12, t % 12 + 1


def _period(d: date) -> str:
    return f"{d.year:04d}-{d.month:02d}"


def _schedule_date(y: int, m: int, schedule: str) -> date:
    if schedule == "last_business_day":
        return _roll_back(_month_end(y, m))
    if schedule.startswith("day:"):
        day = min(int(schedule[4:]), calendar.monthrange(y, m)[1])
        return _roll_forward(date(y, m, day))
    raise ValueError(f"unknown schedule {schedule!r}")


def week_windows(as_of: date, weeks: int = WEEKS) -> list[tuple[date, date]]:
    """Seven-day buckets starting the day after the close."""
    start = as_of + timedelta(days=1)
    return [(start + timedelta(days=7 * k), start + timedelta(days=7 * k + 6))
            for k in range(weeks)]


def recon_months(as_of: date, months: int = 3) -> list[str]:
    return [f"{y:04d}-{m:02d}" for y, m in
            (_add_months(as_of.year, as_of.month, k) for k in range(1, months + 1))]


# --------------------------------------------------------------------------- #
# Payment habit
# --------------------------------------------------------------------------- #
def _mean_sd(xs: list[float]) -> tuple[float, float | None]:
    if not xs:
        return 0.0, None
    mu = sum(xs) / len(xs)
    if len(xs) < 2:
        return mu, None
    var = sum((x - mu) ** 2 for x in xs) / (len(xs) - 1)
    return mu, math.sqrt(var)


def build_profiles(invoices: list[Invoice], as_of: date) -> tuple[dict, dict]:
    """Per-(ledger, counterparty) payment habit from invoices settled by `as_of`.

    Returns (profiles, ledger_defaults); ledger_defaults[ledger] is the Profile used
    for counterparties with no history and as the shrinkage target."""
    hist: dict[tuple[str, str], list[float]] = {}
    terms: dict[tuple[str, str], int] = {}
    for inv in invoices:
        terms.setdefault((inv.ledger, inv.counterparty), inv.terms)
        if inv.paid_date is not None and inv.paid_date <= as_of:
            hist.setdefault((inv.ledger, inv.counterparty), []).append(
                float((inv.paid_date - inv.due_date).days))

    defaults: dict[str, Profile] = {}
    for ledger in {k[0] for k in terms}:
        xs = [x for (led, _cp), v in hist.items() if led == ledger for x in v]
        mu, sd = _mean_sd(xs)
        defaults[ledger] = Profile(ledger, "", len(xs), mu,
                                   max(sd if sd is not None else DEFAULT_SD, SD_FLOOR), 0)

    profiles: dict[tuple[str, str], Profile] = {}
    for key, t in terms.items():
        d = defaults[key[0]]
        xs = hist.get(key, [])
        n = len(xs)
        mu, sd = _mean_sd(xs)
        mean = (n * mu + SHRINK_K * d.mean) / (n + SHRINK_K)
        sd = (n * (sd if sd is not None else d.sd) + SHRINK_K * d.sd) / (n + SHRINK_K)
        profiles[key] = Profile(key[0], key[1], n, mean, max(sd, SD_FLOOR), t)
    return profiles, defaults


def confidence(p: Profile) -> str:
    """High / Medium / Low: chance the invoice settles within ±3.5 days of the
    expected date under the counterparty's spread, capped for thin histories."""
    prob = math.erf(_CONF_WINDOW / (p.sd * math.sqrt(2.0)))
    if p.n < _THIN_HISTORY:
        prob = min(prob, _HIGH - 0.01)
    return "high" if prob >= _HIGH else "medium" if prob >= _MEDIUM else "low"


def explain(p: Profile) -> str:
    """One-line 'why' for the driver popover."""
    if p.n == 0:
        return (f"No settled invoices yet: uses the ledger average "
                f"({_days_phrase(p.mean)}).")
    return (f"Pays {_days_phrase(p.mean)} on {p.terms}-day terms, ±{p.sd:.0f} days, "
            f"across {p.n} settled invoices.")


def _days_phrase(mean: float) -> str:
    if abs(mean) < 1.0:
        return "on the due date on average"
    d = round(abs(mean))
    return f"{d} day{'s' if d != 1 else ''} {'late' if mean > 0 else 'early'} on average"


def expected_settlement(inv: Invoice, p: Profile, as_of: date) -> tuple[date, str, bool]:
    """(expected date, confidence, past_habit). An invoice already later than the
    counterparty usually pays is pushed just past the close at Low confidence."""
    raw = inv.due_date + timedelta(days=round(p.mean))
    if raw <= as_of:
        return _roll_forward(as_of + timedelta(days=max(1, round(p.sd)))), "low", True
    return _roll_forward(raw), confidence(p), False


# --------------------------------------------------------------------------- #
# Flows
# --------------------------------------------------------------------------- #
def _weighted_lag(invoices: list[Invoice], ledger: str, d: Profile) -> int:
    """Amount-weighted terms + the ledger's average days-vs-due → invoice-to-cash lag."""
    rows = [i for i in invoices if i.ledger == ledger]
    amt = sum(i.amount for i in rows)
    terms = sum(i.terms * i.amount for i in rows) / amt if amt else 30.0
    return max(0, round(terms + d.mean))


def _trailing_monthly_invoicing(invoices: list[Invoice], ledger: str, as_of: date) -> float:
    months = {_period(date(*_add_months(as_of.year, as_of.month, -k), 1))
              for k in range(RUN_RATE_MONTHS)}
    total = sum(i.amount for i in invoices
                if i.ledger == ledger and _period(i.invoice_date) in months)
    return total / RUN_RATE_MONTHS


def _new_invoice_flows(row_id: str, monthly: dict[str, float], fallback: float,
                       lag: int, as_of: date, end: date) -> list[_Flow]:
    """Invoice each future day at month/days, settle `lag` days later (in-horizon only)."""
    out: list[_Flow] = []
    d = as_of + timedelta(days=1)
    while d <= end:
        amount = monthly.get(_period(d), fallback) / calendar.monthrange(d.year, d.month)[1]
        settle = _roll_forward(d + timedelta(days=lag))
        if settle <= end and amount:
            out.append(_Flow(settle, row_id, amount, "medium"))
        d += timedelta(days=1)
    return out


def _fixed_flows(fixed: list[FixedFlow], as_of: date, end: date) -> list[_Flow]:
    out: list[_Flow] = []
    for f in fixed:
        if not f.monthly_amount:
            continue
        k = 0
        while True:
            y, m = _add_months(as_of.year, as_of.month, k)
            if date(y, m, 1) > end:
                break
            when = _schedule_date(y, m, f.schedule)
            if as_of < when <= end:
                out.append(_Flow(when, f.row_id, f.monthly_amount))
            k += 1
    return out


def _other_flows(other_daily: dict[date, float], as_of: date, end: date) -> tuple[list[_Flow], float]:
    since = as_of - timedelta(days=7 * OTHER_WINDOW_WEEKS)
    weekly = sum(v for d, v in other_daily.items() if since < d <= as_of) / OTHER_WINDOW_WEEKS
    out: list[_Flow] = []
    d = as_of + timedelta(days=1)
    while d <= end:
        if d.weekday() < 5 and weekly:
            out.append(_Flow(d, "other", weekly / 5.0))
        d += timedelta(days=1)
    return out, weekly


# --------------------------------------------------------------------------- #
# The forecast
# --------------------------------------------------------------------------- #
_CONF_SCORE = {"high": 1.0, "medium": 0.5, "low": 0.0}


def _cell_confidence(flows: list[_Flow]) -> str | None:
    amt = sum(f.amount for f in flows if f.confidence)
    if not amt:
        return None
    score = sum(_CONF_SCORE[f.confidence] * f.amount for f in flows if f.confidence) / amt
    return "high" if score >= 0.75 else "medium" if score >= 0.4 else "low"


def _r(x: float) -> float:
    return round(x, 2)


def forecast(inp: TreasuryInputs) -> dict:
    """The 13-week grid, the open-invoice detail, counterparty drivers and the
    month 1–3 tie-out. Amounts are positive; each row carries its direction."""
    as_of = inp.as_of
    weeks = week_windows(as_of)
    months = recon_months(as_of)
    y3, m3 = int(months[-1][:4]), int(months[-1][5:7])
    end = max(weeks[-1][1], _month_end(y3, m3))   # flows run to the end of month 3

    profiles, defaults = build_profiles(inp.invoices, as_of)
    flows: list[_Flow] = []
    items: list[dict] = []
    open_by_cp: dict[tuple[str, str], float] = {}
    beyond = {"ar": 0.0, "ap": 0.0}

    for inv in inp.invoices:
        is_open = inv.invoice_date <= as_of and (inv.paid_date is None or inv.paid_date > as_of)
        if not is_open:
            continue
        p = profiles[(inv.ledger, inv.counterparty)]
        when, conf, past = expected_settlement(inv, p, as_of)
        row_id = "receipts_open" if inv.ledger == "ar" else "suppliers_open"
        week = next((k for k, (s, e) in enumerate(weeks) if s <= when <= e), None)
        if when <= end:
            flows.append(_Flow(when, row_id, inv.amount, conf))
        if week is None:
            beyond[inv.ledger] += inv.amount
        open_by_cp[(inv.ledger, inv.counterparty)] = (
            open_by_cp.get((inv.ledger, inv.counterparty), 0.0) + inv.amount)
        items.append({
            "ledger": inv.ledger, "invoice_id": inv.invoice_id,
            "counterparty": inv.counterparty, "amount": _r(inv.amount),
            "due_date": inv.due_date.isoformat(), "expected_date": when.isoformat(),
            "week": week, "confidence": conf, "past_habit": past,
        })

    ar_d = defaults.get("ar", Profile("ar", "", 0, 0.0, DEFAULT_SD, 0))
    ap_d = defaults.get("ap", Profile("ap", "", 0, 0.0, DEFAULT_SD, 0))
    ar_rate = _trailing_monthly_invoicing(inp.invoices, "ar", as_of)
    ap_rate = _trailing_monthly_invoicing(inp.invoices, "ap", as_of)
    ar_lag = _weighted_lag(inp.invoices, "ar", ar_d)
    ap_lag = _weighted_lag(inp.invoices, "ap", ap_d)
    flows += _new_invoice_flows("receipts_new", inp.revenue_forecast, ar_rate, ar_lag, as_of, end)
    flows += _new_invoice_flows("suppliers_new", {}, ap_rate, ap_lag, as_of, end)
    flows += _fixed_flows(inp.fixed, as_of, end)
    other, other_weekly = _other_flows(inp.other_daily, as_of, end)
    flows += other

    # ---- weekly grid ----
    rows = []
    for spec in ROWS:
        row_flows = [f for f in flows if f.row_id == spec["id"]]
        cells = [[f for f in row_flows if s <= f.day <= e] for s, e in weeks]
        values = [_r(sum(f.amount for f in c)) for c in cells]
        row = {**spec, "values": values, "total": _r(sum(values))}
        if spec["method"] == "ai":
            row["confidence"] = [_cell_confidence(c) for c in cells]
        rows.append(row)

    inflows = [_r(sum(r["values"][k] for r in rows if r["direction"] == "in")) for k in range(WEEKS)]
    outflows = [_r(sum(r["values"][k] for r in rows if r["direction"] == "out")) for k in range(WEEKS)]
    opening, closing = [], []
    cash = inp.opening_cash
    for k in range(WEEKS):
        opening.append(_r(cash))
        cash += inflows[k] - outflows[k]
        closing.append(_r(cash))
    low_k = min(range(WEEKS), key=lambda k: closing[k])

    # ---- counterparty drivers (those with open invoices), biggest first ----
    drivers = []
    for (ledger, cp), amt in sorted(open_by_cp.items(), key=lambda kv: -kv[1]):
        p = profiles[(ledger, cp)]
        drivers.append({
            "ledger": ledger, "counterparty": cp, "open_amount": _r(amt),
            "terms": p.terms, "invoices_settled": p.n,
            "avg_days_vs_due": round(p.mean, 1), "spread_days": round(p.sd, 1),
            "confidence": confidence(p), "explanation": explain(p),
        })

    return {
        "as_of": as_of.isoformat(),
        "weeks": [{"index": k, "start": s.isoformat(), "end": e.isoformat()}
                  for k, (s, e) in enumerate(weeks)],
        "rows": rows,
        "summary": {
            "opening_cash": opening, "inflows": inflows, "outflows": outflows,
            "net_flow": [_r(i - o) for i, o in zip(inflows, outflows)],
            "closing_cash": closing,
            "lowest_week": low_k, "lowest_cash": closing[low_k],
            "min_cash": _r(inp.min_cash) if inp.min_cash is not None else None,
            "beyond_horizon": {k: _r(v) for k, v in beyond.items()},
        },
        "items": sorted(items, key=lambda i: (i["expected_date"], -i["amount"])),
        "drivers": drivers,
        "assumptions": {
            "receipts_lag_days": ar_lag, "supplier_lag_days": ap_lag,
            "supplier_monthly_run_rate": _r(ap_rate),
            "other_weekly_run_rate": _r(other_weekly),
            "revenue_source": inp.revenue_source,
            "rules": [{"row_id": f.row_id, "label": _ROW_BY_ID[f.row_id]["label"],
                       "monthly_amount": _r(f.monthly_amount), "schedule": f.schedule,
                       "basis": f.basis} for f in inp.fixed],
        },
        "reconciliation": _reconcile(flows, months, inp),
    }


def _reconcile(flows: list[_Flow], months: list[str], inp: TreasuryInputs) -> list[dict]:
    """Treasury (direct) vs FP&A (indirect) for months 1–3, by cash category.

    FP&A receipts = revenue − ΔAR; operating payments = receipts − operating cash;
    so both sides' net change = receipts − payments − capex (+ any FP&A financing)."""
    fpa = {m.get("period"): m for m in inp.fpa_months}
    out = []
    t_cash = inp.opening_cash
    for per in months:
        mf = [f for f in flows if _period(f.day) == per]
        rec = sum(f.amount for f in mf if _ROW_BY_ID[f.row_id]["direction"] == "in")
        capex = sum(f.amount for f in mf if f.row_id == "capex")
        pay = sum(f.amount for f in mf
                  if _ROW_BY_ID[f.row_id]["direction"] == "out" and f.row_id != "capex")
        net = rec - pay - capex
        t_cash += net
        treasury = {"receipts": _r(rec), "operating_payments": _r(pay),
                    "capex": _r(capex), "net_change": _r(net), "ending_cash": _r(t_cash)}
        f = fpa.get(per)
        diff = ({k: _r(treasury[k] - f[k]) for k in treasury if f.get(k) is not None}
                if f else None)
        out.append({"period": per, "treasury": treasury,
                    "fpa": {k: _r(v) for k, v in f.items() if k != "period"} if f else None,
                    "difference": diff})
    return out
