"""Standard financial statements (Income / Balance / Cash Flow / Equity).

Read-only, scope-aware aggregations over the governed serving views
(`income_statement`, `balance_sheet`, `cash_flow_statement`). The views expose
stable `line_id`s so the frontend Overlay can relabel per industry; these
endpoints just SUM within the active scope and order by the canonical
`sort_order`.

The `/comparative` endpoint adds an FP&A "plan vs actual" lens: it reads the
same statement view at the selected period and at a comparison basis (prior
period / prior quarter / prior year, or the budget for the income statement) and
returns, per line, the actual, the comparison value, and the variance ($ / %).

QoQ is a true quarter-over-quarter comparison: on the flow statements (income,
cash flow) it sums the three months of the current quarter against the three
months of the prior quarter; on the balance sheet — a cumulative as-of position,
not a flow — it compares the quarter-end position against the prior quarter-end.
"""
from fastapi import APIRouter, Header, Query

from ..config import CLOSE_FQ, SRV_FQ, current_industry, resolve_period
from ..demo_calendar import display_window_months, seed_months, to_display_period
from ..personas import scope_clause
from ..versioned_cache import VersionedTTLCache
from ..warehouse import cache_version, query

router = APIRouter()

SRV = SRV_FQ
CLOSE = CLOSE_FQ

# Model used for the AI variance commentary (same endpoint as the historical
# "story of the month" narrative and the competitor positioning note).
_NOTE_MODEL = "databricks-claude-sonnet-4-5"


def _q(s: str) -> str:
    """SQL string literal, single-quotes escaped (matches historical._q)."""
    return "'" + str(s).replace("'", "''") + "'"


# In-process TTL caches for AI commentary and the Insight ("why") column.
# Both run a live ai_query (~7–11s) plus warehouse grounding; the facts only
# change at close time or when an adjustment bumps warehouse.cache_version().
# Set INSIGHTS_CACHE_TTL / AI_RESPONSE_CACHE_TTL to 0 to disable.
import os as _os

_INSIGHTS_TTL = float(_os.environ.get("INSIGHTS_CACHE_TTL", "3600"))
_AI_RESPONSE_TTL = float(_os.environ.get("AI_RESPONSE_CACHE_TTL", "3600"))
_insights_cache = VersionedTTLCache[dict](_INSIGHTS_TTL, cache_version)
_commentary_cache = VersionedTTLCache[dict](_AI_RESPONSE_TTL, cache_version)

# Income statement + balance sheet carry the full org grain (incl. business_line).
# The cash flow statement is per business unit (no business_line dimension).
_STMT_COLS = {"region": "region", "legal_entity": "legal_entity_id",
              "business_unit": "business_unit_id", "business_line": "business_line"}
_CF_COLS = {"region": "region", "legal_entity": "legal_entity_id",
            "business_unit": "business_unit_id"}

# The three statements, keyed by the URL segment the frontend uses.
_STMT_VIEWS = {"income": "income_statement", "balance": "balance_sheet",
               "cashflow": "cash_flow_statement"}
# Income statement + balance sheet carry a `section`; the income statement does
# not. Selecting the right column set keeps each query minimal.
_STMT_HAS_SECTION = {"income": False, "balance": True, "cashflow": True}


def _scoped_where(period: str, scope_type: str, scope_id: str, cols: dict) -> str:
    return f" WHERE period = '{period}'" + scope_clause(scope_type, scope_id, cols, prefix=" AND ")


def _f(v) -> float:
    """Coerce a warehouse cell to float. The SQL Statement Execution API returns
    every value as a string (e.g. '8428863.49'), so amounts must be cast before
    any arithmetic — otherwise variance math hits `str - str`. None/'' -> 0.0."""
    if v is None or v == "":
        return 0.0
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _shift_period(period: str, months: int) -> str:
    """Return `period` (YYYY-MM) shifted back by `months`, e.g. prior year =
    _shift_period('2026-06', 12) -> '2025-06'. Used to pick the comparison base."""
    y, m = int(period[:4]), int(period[5:7])
    total = (y * 12 + (m - 1)) - months
    return f"{total // 12:04d}-{total % 12 + 1:02d}"


def _quarter_months(period: str) -> list[str]:
    """Return the three calendar-quarter months (YYYY-MM) that `period` falls in.

    Anchors on the calendar quarter, not a trailing 3-month window, so QoQ lines
    up on Q boundaries: any month in Apr–Jun -> ['2026-04','2026-05','2026-06']."""
    y, m = int(period[:4]), int(period[5:7])
    start = ((m - 1) // 3) * 3 + 1  # first month of the quarter: 1, 4, 7, or 10
    return [f"{y:04d}-{start + i:02d}" for i in range(3)]


def _quarter_label(period: str) -> str:
    """Human label for the quarter a period sits in, e.g. '2026-Q2'."""
    y, m = int(period[:4]), int(period[5:7])
    return f"{y:04d}-Q{(m - 1) // 3 + 1}"


def _ytd_months(period: str) -> list[str]:
    """Year-to-date months (Jan .. period), e.g. '2026-06' -> ['2026-01'..'2026-06']."""
    y, m = int(period[:4]), int(period[5:7])
    return [f"{y:04d}-{mm:02d}" for mm in range(1, m + 1)]


# The accumulation window: which months sum into the "actual". MTD = the close
# month; QTD = the calendar quarter to date; YTD = Jan..period. Orthogonal to the
# comparison basis (what we measure against). Balance sheet ignores this (it is an
# as-of stock, so every window resolves to the single period-end position).
_WINDOWS = ("mtd", "qtd", "ytd")


def _window_months(window: str, period: str) -> list[str]:
    """The list of months that a window accumulates for `period`."""
    if window == "ytd":
        return _ytd_months(period)
    if window == "qtd":
        return _quarter_months(period)
    return [period]  # mtd


def _seed_window_months(window: str, seed_period: str) -> tuple[list[str], str]:
    """Window months on the display calendar, mapped back to seed for SQL.

    Returns (seed_months, display_period). MTD is a no-op relative to seed when
    the offset is 0, so existing tests stay on 2026-06.
    """
    display = to_display_period(seed_period)
    return seed_months(display_window_months(window, display)), display


def _window_label(window: str, period: str) -> str:
    """Human label for a window's actual column, e.g. YTD -> '2026 YTD'."""
    if window == "ytd":
        return f"{period[:4]} YTD"
    if window == "qtd":
        return _quarter_label(period)
    return period


# Legacy basis -> (window, compare) so old callers (and the other team's code)
# keep working unchanged: mom = month vs prior month; yoy = month vs prior year;
# qoq = quarter-to-date vs prior quarter; budget = month vs budget.
_LEGACY_BASIS = {
    "mom": ("mtd", "prior"),
    "yoy": ("mtd", "prior_year"),
    "qoq": ("qtd", "prior"),
    "budget": ("mtd", "budget"),
}


def _window_driver_periods(stmt: str, window: str, compare: str, p: str) -> tuple[list[str], list[str]]:
    """Actual + comparison month lists for BU/region driver attribution, matching
    how `comparative_statement` aggregates a (window, compare) pair. Balance sheet
    is as-of, so it uses period-end snapshots rather than summed windows."""
    if stmt == "balance":
        act = [p]
        display = to_display_period(p)
        act_display = [display]
    else:
        act, display = _seed_window_months(window, p)
        act_display = display_window_months(window, display)
    shift = 12 if compare == "prior_year" else _window_shift(window)
    cmp_display = [_shift_period(m, shift) for m in act_display]
    cmp = seed_months(cmp_display)
    return act, cmp


def _scoped_where_periods(periods: list[str], scope_type: str, scope_id: str, cols: dict) -> str:
    quoted = ", ".join(f"'{p}'" for p in periods)
    return f" WHERE period IN ({quoted})" + scope_clause(scope_type, scope_id, cols, prefix=" AND ")


def prior_period(period: str) -> str | None:
    """Previous calendar month for a validated YYYY-MM period, else None."""
    try:
        y_s, m_s = period.split("-")
        year = int(y_s)
        month = int(m_s)
        if month < 1 or month > 12:
            return None
        if month == 1:
            return f"{year - 1:04d}-12"
        return f"{year:04d}-{month - 1:02d}"
    except Exception:  # noqa: BLE001 - defensive parser for API inputs
        return None


def _statement_with_prior(
    *,
    view_name: str,
    scope_type: str,
    scope_id: str,
    period: str,
    cols: dict[str, str],
    key_cols: list[str],
) -> list[dict]:
    current = resolve_period(period)
    prior = prior_period(current)
    periods = [current] + ([prior] if prior else [])
    where = _scoped_where_periods(periods, scope_type, scope_id, cols)
    keys = ", ".join(key_cols)
    prior_expr = (
        f"ROUND(SUM(CASE WHEN period = '{prior}' THEN amount END), 2) AS prior_amount "
        if prior
        else "CAST(NULL AS DOUBLE) AS prior_amount "
    )
    return query(
        f"SELECT {keys}, "
        f"MAX(CASE WHEN period = '{current}' THEN line_label END) AS line_label, "
        f"MAX(CASE WHEN period = '{current}' THEN sort_order END) AS sort_order, "
        f"ROUND(SUM(CASE WHEN period = '{current}' THEN amount ELSE 0 END), 2) AS amount, "
        f"{prior_expr}"
        f"FROM {SRV}.{view_name}{where} "
        f"GROUP BY {keys} "
        f"HAVING SUM(CASE WHEN period = '{current}' THEN 1 ELSE 0 END) > 0 "
        f"ORDER BY sort_order"
    )


@router.get("/statements/income")
def income_statement(scope_type: str = Query("consolidated"), scope_id: str = Query("ALL"),
                     period: str = Query(None)):
    return _statement_with_prior(
        view_name="income_statement",
        scope_type=scope_type,
        scope_id=scope_id,
        period=period,
        cols=_STMT_COLS,
        key_cols=["line_id"],
    )


@router.get("/statements/balance")
def balance_sheet(scope_type: str = Query("consolidated"), scope_id: str = Query("ALL"),
                  period: str = Query(None)):
    # balance_sheet is cumulative (as-of): selecting a period shows the position
    # through that period, while the income statement above is period activity.
    return _statement_with_prior(
        view_name="balance_sheet",
        scope_type=scope_type,
        scope_id=scope_id,
        period=period,
        cols=_STMT_COLS,
        key_cols=["section", "line_id"],
    )


@router.get("/statements/cashflow")
def cash_flow_statement(scope_type: str = Query("consolidated"), scope_id: str = Query("ALL"),
                        period: str = Query(None)):
    return _statement_with_prior(
        view_name="cash_flow_statement",
        scope_type=scope_type,
        scope_id=scope_id,
        period=period,
        cols=_CF_COLS,
        key_cols=["section", "line_id"],
    )


@router.get("/statements/equity")
def equity_statement(scope_type: str = Query("consolidated"), scope_id: str = Query("ALL"),
                     period: str = Query(None)):
    return _statement_with_prior(
        view_name="equity_statement",
        scope_type=scope_type,
        scope_id=scope_id,
        period=period,
        cols=_CF_COLS,
        key_cols=["equity_class", "section", "line_id"],
    )


# How many months back each simple time-shift basis looks. QoQ is handled
# separately (it aggregates a whole quarter, see `_quarter_months`); "budget" is
# not time-shifted (it joins budget_forecast for the same period) and is only
# available on the income statement.
_BASIS_MONTHS = {"mom": 1, "yoy": 12}


def _statement_lines(stmt: str, periods, scope_type: str, scope_id: str) -> dict:
    """Return {line_id: {section, line_label, sort_order, amount}} for one
    statement + scope, by SUMming the governed statement view.

    `periods` is a single period (YYYY-MM) or a list of periods. A list is used
    for QoQ on the flow statements, where the quarter's three months are summed
    into one figure; the balance sheet passes a single as-of period instead."""
    if isinstance(periods, str):
        periods = [periods]
    view = _STMT_VIEWS[stmt]
    cols = _CF_COLS if stmt == "cashflow" else _STMT_COLS
    has_section = _STMT_HAS_SECTION[stmt]
    period_list = ", ".join(f"'{p}'" for p in periods)
    where = (f" WHERE period IN ({period_list})"
             + scope_clause(scope_type, scope_id, cols, prefix=" AND "))
    sec_sel = "MAX(section) AS section, " if has_section else ""
    rows = query(
        f"SELECT line_id, {sec_sel}MAX(line_label) AS line_label, "
        f"MAX(sort_order) AS sort_order, ROUND(SUM(amount), 2) AS amount "
        f"FROM {SRV}.{view}{where} GROUP BY line_id ORDER BY sort_order")
    return {r["line_id"]: r for r in rows}


def _budget_lines(period: str, scope_type: str, scope_id: str) -> dict:
    """Budget comparison for the income statement only: sum budget_forecast into
    the same line_ids the income_statement view exposes. budget_forecast is
    IS-only, keyed by period x account x BU; it joins dim_org so the same region /
    legal-entity scope filter as the actuals applies (budget has no business_line
    grain, so that scope falls back to the BU set).

    The account->line_id CASE MUST mirror the income_statement view
    (serving_views.sql): interest income (70000), interest expense (71000) and
    income tax (80000) each get their own line, exactly as the actuals do. A
    coarser 3-way (revenue/cogs/opex) bucket would dump tax + interest into the
    opex budget, leaving the budgeted OpEx line ~2x the actual OpEx and reporting
    a spurious "under budget" variance for every scope."""
    # budget_forecast carries only business_unit_id; region / legal_entity live on
    # dim_org, so scope through the org join. business_line isn't budgeted.
    scope = scope_clause(scope_type, scope_id,
                         {"region": "o.region", "legal_entity": "o.legal_entity_id",
                          "business_unit": "b.business_unit_id"}, prefix=" AND ")
    rows = query(
        f"SELECT CASE "
        f"          WHEN c.account_type = 'Revenue' AND c.account_code NOT IN ('70000') THEN 'revenue' "
        f"          WHEN c.account_code = '50000' THEN 'cogs' "
        f"          WHEN c.account_code = '70000' THEN 'interest_income' "
        f"          WHEN c.account_code = '71000' THEN 'interest_expense' "
        f"          WHEN c.account_code = '80000' THEN 'tax_expense' "
        f"          ELSE 'opex' END AS line_id, "
        f"ROUND(SUM(b.forecast_amount), 2) AS amount "
        f"FROM {CLOSE}.budget_forecast b "
        f"JOIN {CLOSE}.chart_of_accounts c ON b.account_code = c.account_code "
        f"LEFT JOIN {CLOSE}.dim_org o ON b.business_unit_id = o.business_unit_id "
        f"WHERE b.period = '{period}'{scope} GROUP BY 1")
    return {r["line_id"]: r for r in rows}


def resolve_window_compare(stmt: str, window: str | None, compare: str | None,
                           basis: str | None) -> tuple[str, str]:
    """Normalise the (window, compare) axes, honouring the legacy `basis` alias.

    Precedence: an explicit `window`/`compare` wins; otherwise fall back to the
    legacy `basis` map (mom/qoq/yoy/budget). Then apply the validity rules:
      - balance sheet ignores the window (as-of stock): forced to mtd, so every
        window compares period-end positions;
      - budget off the income statement is unsupported -> prior;
      - YTD (and QTD) have no clean sequential "prior" window -> prior_year.
    """
    w = window if window in _WINDOWS else None
    c = compare if compare in ("prior", "prior_year", "budget", "scenario") else None
    if w is None or c is None:
        lw, lc = _LEGACY_BASIS.get(basis or "mom", ("mtd", "prior"))
        w = w or lw
        c = c or lc
    if stmt == "balance":
        w = "mtd"  # as-of stock: the window collapses to the period-end position
    if c in ("budget", "scenario") and stmt != "income":
        c = "prior"  # budget_forecast and scenario projection are income-statement only
    if c == "prior" and w == "ytd" and stmt != "balance":
        # YTD has no clean sequential prior (a "prior YTD" is just last year) ->
        # compare year-ago. QTD keeps a real sequential prior: the prior quarter.
        c = "prior_year"
    return w, c


@router.get("/statements/{stmt}/comparative")
def comparative_statement(stmt: str, basis: str = Query(None),
                          window: str = Query(None), compare: str = Query(None),
                          scope_type: str = Query("consolidated"), scope_id: str = Query("ALL"),
                          period: str = Query(None)):
    """Actual vs. a comparison, per line, with $ and % variance.

    Two orthogonal axes:
      - `window` (mtd | qtd | ytd): how much of "now" to accumulate into the
        actual. Balance sheet ignores it (an as-of stock).
      - `compare` (prior | prior_year | budget): what to measure against.
    The legacy `basis` (mom | qoq | yoy | budget) is still accepted and maps onto
    the two axes, so existing callers keep working unchanged.
    """
    if stmt not in _STMT_VIEWS:
        return []
    p = resolve_period(period)
    w, c = resolve_window_compare(stmt, window, compare, basis)
    display_p = to_display_period(p)

    # The actual side: sum the window's months on the *display* calendar, then
    # map each month back to seed for SQL (so Aug QTD is Jul–Aug, not seed Q2).
    if stmt == "balance":
        act_months = [p]
        act_display = [display_p]
    else:
        act_months, _ = _seed_window_months(w, p)
        act_display = display_window_months(w, display_p)
    actual = _statement_lines(stmt, act_months, scope_type, scope_id)

    # The comparison side.
    if c == "budget":
        # Budget is period-keyed; sum the same window of budget months (income only).
        compare = _budget_window_lines(act_months, scope_type, scope_id)
        compare_period = f"{_window_label(w, display_p)} Budget"
    elif c == "scenario":
        compare, scen_name = _published_scenario_lines(act_months, p, scope_type, scope_id)
        compare_period = scen_name or "Official Forecast"
    else:
        shift = 12 if c == "prior_year" else _window_shift(w)
        cmp_display = [_shift_period(m, shift) for m in act_display]
        cmp_months = seed_months(cmp_display)
        compare = _statement_lines(stmt, cmp_months, scope_type, scope_id)
        # YYYY-MM labels stay on the seed timeline so the frontend shifter can
        # map them; quarter/YTD labels are already display-calendar text.
        label_src = cmp_months[-1] if w == "mtd" else cmp_display[-1]
        compare_period = _window_label(w, label_src)

    out = []
    for line_id, a in actual.items():
        act = _f(a["amount"])
        cmp_row = compare.get(line_id)
        raw_cmp = (cmp_row or {}).get("amount")
        cmp_val = None if raw_cmp is None else _f(raw_cmp)
        var_abs = None if cmp_val is None else round(act - cmp_val, 2)
        var_pct = (None if not cmp_val else round((act - cmp_val) / abs(cmp_val) * 100, 1))
        row = {"line_id": line_id, "line_label": a["line_label"],
               "sort_order": a["sort_order"], "actual": act,
               "compare": cmp_val, "var_abs": var_abs, "var_pct": var_pct}
        if "section" in a:
            row["section"] = a["section"]
        out.append(row)

    # Legacy `basis` echo so older frontends still light up their pills correctly.
    legacy = {("mtd", "prior"): "mom", ("mtd", "prior_year"): "yoy",
              ("qtd", "prior"): "qoq", ("qtd", "prior_year"): "qoq",
              ("ytd", "prior_year"): "yoy", ("mtd", "budget"): "budget"}.get((w, c), "mom")
    actual_label_src = p if w == "mtd" else display_p
    return {"basis": legacy, "window": w, "compare": c, "period": p,
            "actual_period": _window_label(w, actual_label_src),
            "compare_period": compare_period, "lines": out}


def _window_shift(window: str) -> int:
    """Months to shift back for a sequential 'prior' comparison of a window. Only
    mtd uses this (qtd/ytd sequential are remapped to prior_year upstream); a full
    quarter back = 3, a month back = 1."""
    return {"qtd": 3, "ytd": 12}.get(window, 1)


def _budget_window_lines(months: list[str], scope_type: str, scope_id: str) -> dict:
    """Sum budget over a window of months (income statement only). Delegates to the
    single-period `_budget_lines` per month and adds the amounts by line_id."""
    agg: dict[str, dict] = {}
    for m in months:
        for lid, row in _budget_lines(m, scope_type, scope_id).items():
            if lid not in agg:
                agg[lid] = dict(row)
            else:
                agg[lid]["amount"] = _f(agg[lid]["amount"]) + _f(row["amount"])
    return agg


def _published_scenario_lines(
    act_months: list[str], period: str,
    scope_type: str = "consolidated", scope_id: str = "ALL",
) -> tuple[dict, str]:
    """Comparison values from the official (published) scenario.

    Applies the scenario's P&L driver assumptions (revenue_growth, gross_margin
    bps shift, opex_growth) to the budget baseline for `act_months`. This is
    preferable to using the frozen projection directly: the frozen projection echoes
    actuals for months within the scenario's hinge (giving zero variance), whereas
    the budget-adjusted approach always produces a meaningful plan vs actual view.

    Returns ({line_id: {"amount": value}}, scenario_name).
    Returns ({}, "") when no published scenario exists or Lakebase is unreachable."""
    try:
        from ..lakebase import pool
        from psycopg.rows import dict_row
        with pool.connection() as conn, conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                "SELECT name, assumptions FROM scenario_plans "
                "WHERE as_of_period = %s AND status = 'published' "
                "ORDER BY updated_ts DESC LIMIT 1",
                (period,))
            row = cur.fetchone()
        if not row:
            return {}, ""

        name = str(row["name"])
        assumptions: dict = row.get("assumptions") or {}

        def _driver(driver_id: str) -> float:
            raw = assumptions.get(driver_id)
            if raw is None:
                return 0.0
            v = raw.get("value") if isinstance(raw, dict) else raw
            return float(v) if v is not None else 0.0

        rev_growth = _driver("revenue_growth") / 100.0   # % → fraction
        gm_bps    = _driver("gross_margin") / 10000.0    # bps → fraction
        opex_growth = _driver("opex_growth") / 100.0

        # Budget for the window (same granularity as the actuals being compared).
        budget = _budget_window_lines(act_months, scope_type, scope_id)
        if not budget:
            return {}, name

        def _amt(line_id: str) -> float:
            return float((budget.get(line_id) or {}).get("amount") or 0.0)

        rev_b  = _amt("revenue")
        cogs_b = _amt("cogs")
        opex_b = _amt("opex")

        rev_s = rev_b * (1.0 + rev_growth)

        # COGS: apply gross-margin shift on top of the budget rate.
        if rev_b > 0:
            base_gm = 1.0 - cogs_b / rev_b
            cogs_s = rev_s * (1.0 - (base_gm + gm_bps))
        else:
            cogs_s = cogs_b

        opex_s = opex_b * (1.0 + opex_growth)

        result: dict[str, dict] = {}
        if rev_b:
            result["revenue"] = {"amount": round(rev_s, 2)}
        if cogs_b:
            result["cogs"] = {"amount": round(cogs_s, 2)}
        if opex_b:
            result["opex"] = {"amount": round(opex_s, 2)}

        return result, name
    except Exception:  # noqa: BLE001 — Lakebase unavailable, degrade gracefully
        return {}, ""


# ---------------------------------------------------------------------------
# AI variance commentary (persona-aware) + a seeded Genie follow-up question
# ---------------------------------------------------------------------------
# Reuses the one-shot ai_query pattern (historical._ai_note / competitor note):
# feed the model ONLY the variance numbers we already computed, so the commentary
# is grounded and never invents figures. Runs on the same warehouse (as the
# signed-in user via OBO), and degrades gracefully if ai_query is unreachable.
_BASIS_WORDS = {
    "budget": ("budget", "plan", "vs the plan"),
    "mom": ("prior period", "the prior month", "month over month"),
    "yoy": ("prior year", "the prior year", "year over year"),
    "qoq": ("prior quarter", "the prior quarter", "quarter over quarter"),
}

# Per-persona commentary depth. CFO = tight, board-level key comments; Controller
# gets a more extensive, investigate-this treatment (they own the variance).
_PERSONA_STYLE = {
    "cfo": ("You are the CFO's FP&A lead briefing the CFO. Write 2-3 tight key "
            "comments (max ~55 words total). Lead with the single most material "
            "driver. Board-level language, no jargon, no line-by-line recap."),
    "controller": ("You are an FP&A analyst briefing a divisional Controller who "
                   "owns this variance. Write 4-5 comments (max ~110 words). Name "
                   "the specific lines driving the movement, quantify them, call "
                   "out what to investigate, and end with one 'watch next' note."),
}


def _fmt_usd(v: float) -> str:
    """Compact signed dollars for the prompt facts, e.g. 291000 -> '+$291K'."""
    sign = "-" if v < 0 else "+"
    a = abs(v)
    if a >= 1_000_000:
        return f"{sign}${a / 1_000_000:.1f}M"
    if a >= 1_000:
        return f"{sign}${a / 1_000:.0f}K"
    return f"{sign}${a:.0f}"


def _biggest_driver(lines: list[dict]) -> dict | None:
    """The line with the largest absolute $ variance (skips derived/total rows,
    which the endpoint doesn't emit anyway). Used to seed the Genie question."""
    scored = [r for r in lines if r.get("var_abs") is not None]
    if not scored:
        return None
    return max(scored, key=lambda r: abs(r["var_abs"]))


# One-line "what this company is" per industry, so the model frames commentary in
# the business's own vocabulary instead of generic finance-speak. Kept
# company-neutral: describe the archetype, never name a real company, so demo
# commentary is safe to show any prospect.
_INDUSTRY_CONTEXT = {
    "consumer": ("A global consumer-goods company: packaged "
                 "food, home & personal care brands sold through retail and "
                 "distributors. Margins hinge on input costs, trade promotion and "
                 "marketing spend; volume/mix and FX move the top line."),
    "software": ("A B2B SaaS company: subscription/recurring "
                 "revenue, high gross margin, heavy S&M and R&D. Watch net revenue "
                 "retention, headcount-driven opex, and deferred-revenue timing."),
    "fsi": ("A financial-services institution: net interest income plus "
            "fee income, cost/income ratio discipline, and regulatory/risk provisions "
            "as major swing factors."),
    "capmarkets": ("A global ETP market maker and liquidity provider: net trading "
                   "income driven by market volatility and traded volumes, a largely "
                   "variable compensation base, technology and market-data costs, and "
                   "trading capital as the binding constraint."),
    "energy": ("An energy & utilities company: commodity-price "
               "exposure, regulated vs. retail margins, hedging, and capital-intensive "
               "operations where volumes and rates drive variance."),
}


def _line_drivers(stmt: str, line_id: str, periods, cmp_periods,
                  scope_type: str, scope_id: str, top: int = 3) -> list[dict]:
    """Break ONE statement line's variance down by business unit + region, so the
    commentary can name the concrete drivers ("North America salaries +$401K")
    instead of only the consolidated movement. Sums the line over the actual
    period(s) and the comparison period(s) at BU/region grain and returns the top
    `top` movers by absolute $ variance. Warehouse-only (no Lakebase needed)."""
    view = _STMT_VIEWS.get(stmt)
    if not view:
        return []
    cols = _CF_COLS if stmt == "cashflow" else _STMT_COLS
    if isinstance(periods, str):
        periods = [periods]
    if isinstance(cmp_periods, str):
        cmp_periods = [cmp_periods]
    act_list = ", ".join(f"'{p}'" for p in periods)
    cmp_list = ", ".join(f"'{p}'" for p in cmp_periods)
    where = scope_clause(scope_type, scope_id, cols, prefix=" AND ")
    rows = query(
        "SELECT business_unit_name, region, "
        f"ROUND(SUM(CASE WHEN period IN ({act_list}) THEN amount ELSE 0 END), 2) AS actual, "
        f"ROUND(SUM(CASE WHEN period IN ({cmp_list}) THEN amount ELSE 0 END), 2) AS compare "
        f"FROM {SRV}.{view} "
        f"WHERE line_id = {_q(line_id)} AND period IN ({act_list}, {cmp_list}){where} "
        "GROUP BY business_unit_name, region")
    scored = []
    for r in rows:
        a, c = _f(r.get("actual")), _f(r.get("compare"))
        scored.append({"bu": r.get("business_unit_name"), "region": r.get("region"),
                       "actual": a, "compare": c, "var_abs": round(a - c, 2)})
    scored.sort(key=lambda r: abs(r["var_abs"]), reverse=True)
    return scored[:top]


def _income_ratio_facts(lines: list[dict], cmp_noun: str) -> tuple[list[str], str | None]:
    """Cross-line margin facts for the income statement — but framed so the insight
    stays COHERENT and TRACEABLE, not a floating second story:

    - The margin move is stated as a percentage-POINT change, never an absolute
      level (40.0% isn't a column on the statement, so it would look invented).
    - It is anchored to the two numbers the reader CAN see: the on-screen Var% of
      Revenue and COGS. So "Revenue +5% vs COGS +11% → gross margin ~-3 pts" ties
      straight back to the % column.
    - It is attributed to ONE line — the bigger $ contributor to the gross-profit
      change — so the same margin point isn't smeared across three rows. Operating
      margin is likewise pinned to Opex only.

    Returns (facts, owner_line_id). `owner_line_id` is the line the gross-margin
    observation must attach to; None (with []) when the canonical lines are absent
    or revenue is zero. Derived purely from the returned lines (no extra query)."""
    by = {r.get("line_id"): r for r in lines}

    def val(line_id: str, key: str):
        r = by.get(line_id)
        if not r or r.get(key) is None:
            return None
        return _f(r.get(key))

    def var_pct(line_id: str):
        # The Var% exactly as it appears on the statement (fall back to computing it
        # so the fact always matches the column the reader is looking at).
        r = by.get(line_id)
        if not r:
            return None
        if r.get("var_pct") is not None:
            return _f(r.get("var_pct"))
        a, c = val(line_id, "actual"), val(line_id, "compare")
        return (a - c) / abs(c) * 100 if a is not None and c not in (None, 0) else None

    rev_a, rev_c = val("revenue", "actual"), val("revenue", "compare")
    cogs_a, cogs_c = val("cogs", "actual"), val("cogs", "compare")
    if not rev_a or not rev_c or cogs_a is None or cogs_c is None:
        return [], None
    rev_g, cogs_g = var_pct("revenue"), var_pct("cogs")
    if rev_g is None or cogs_g is None:
        return [], None

    # Gross-margin point change, and the line that owns it (bigger $ mover into the
    # gross-profit change). Costs are positive magnitudes (gross profit = rev − COGS).
    gm_delta = (rev_a - cogs_a) / rev_a * 100 - (rev_c - cogs_c) / rev_c * 100
    owner = "revenue" if abs(val("revenue", "var_abs") or 0) >= abs(val("cogs", "var_abs") or 0) else "cogs"
    owner_label = "Revenue" if owner == "revenue" else "COGS"
    facts = [
        f"GROSS-MARGIN framing — put this ONLY in the detail for the '{owner}' line, "
        f"nowhere else. Gross margin moved about {gm_delta:+.1f} percentage points, and "
        f"{owner_label} is the larger driver. Anchor it to the on-screen Var%: Revenue "
        f"{rev_g:+.1f}% vs COGS {cogs_g:+.1f}%. State the margin as this ~{gm_delta:+.1f} pt "
        "MOVE, never as an absolute level."
    ]
    # Opex framing — pinned to Opex, and it owns ONLY its own effect on operating
    # margin (the change in opex as a share of revenue), NOT the whole operating-margin
    # move — the gross-margin part already belongs to the line above. So opex growing
    # in line with revenue = ~0 effect, which is the honest, non-double-counting story.
    opex_a, opex_c = val("opex", "actual"), val("opex", "compare")
    opex_g = var_pct("opex")
    if opex_a is not None and opex_c is not None and opex_g is not None:
        opex_effect = -((opex_a / rev_a) - (opex_c / rev_c)) * 100  # + = margin help
        facts.append(
            f"OPEX-RATIO framing — put this ONLY in the detail for the 'opex' line. Opex's "
            f"own effect on operating margin is about {opex_effect:+.1f} pts (its share of "
            f"revenue); anchor it to Opex Var% {opex_g:+.1f}% against Revenue Var% "
            f"{rev_g:+.1f}%. If ~0, say opex held its share of revenue. A movement, not a "
            "level; do NOT restate the gross-margin point here.")
    return facts, owner


def _compute_comparative_commentary(
    stmt: str, basis: str = Query(None),
    window: str = Query(None), compare: str = Query(None),
    scope_type: str = Query("consolidated"), scope_id: str = Query("ALL"),
    period: str = Query(None),
    x_persona: str | None = Header(default=None),
):
    """Persona-aware AI commentary on a comparative statement, plus a suggested
    Genie follow-up. Best-effort: `available=False` if ai_query is unreachable so
    the page degrades to the numbers + a generic Genie question."""
    data = comparative_statement(stmt, basis=basis, window=window, compare=compare,
                                 scope_type=scope_type, scope_id=scope_id, period=period)
    lines = data.get("lines", []) if isinstance(data, dict) else []
    eff_basis = data.get("basis", basis or "mom") if isinstance(data, dict) else (basis or "mom")
    eff_window = data.get("window", "mtd") if isinstance(data, dict) else "mtd"
    eff_compare = data.get("compare", "prior") if isinstance(data, dict) else "prior"
    p = data.get("period", resolve_period(period)) if isinstance(data, dict) else resolve_period(period)
    compare_period = data.get("compare_period", "") if isinstance(data, dict) else ""
    cmp_noun, cmp_the, cmp_adv = _BASIS_WORDS.get(eff_basis, _BASIS_WORDS["mom"])
    scope_label = "consolidated" if (not scope_type or scope_type == "consolidated") else scope_id

    driver = _biggest_driver(lines)
    # Seeded Genie question — grounded in the biggest driver + the active scope.
    if driver:
        seed_q = (f"Which business unit drove the {driver['line_label'].lower()} variance "
                  f"{cmp_adv} in {p} for the {scope_label} scope?")
    else:
        seed_q = f"What are the largest variances {cmp_adv} in {p} for the {scope_label} scope?"

    # Grounded facts: only the numbers we computed.
    facts = [f"Statement: {stmt}. Period {p}. Comparison basis: actual vs {cmp_noun}"
             + (f" ({compare_period})" if compare_period else "") + f". Scope: {scope_label}."]
    for r in lines:
        if r.get("var_abs") is None:
            continue
        facts.append(
            f"{r['line_label']}: actual {_fmt_usd(_f(r.get('actual')))}, "
            f"{cmp_noun} {_fmt_usd(_f(r.get('compare')))}, "
            f"variance {_fmt_usd(_f(r.get('var_abs')))}"
            + (f" ({r['var_pct']:+.1f}%)" if r.get("var_pct") is not None else "") + ".")

    # Dimensional drivers for the single biggest-moving line: which BU/region
    # actually moved it. This is what turns "opex rose $158K" into a real driver
    # narrative. Warehouse-only; skipped for the budget basis (budget isn't at
    # BU/region grain in the statement views) and best-effort on any error.
    if driver and eff_compare != "budget":
        try:
            act_periods, cmp_periods = _window_driver_periods(stmt, eff_window, eff_compare, p)
            drivers = _line_drivers(stmt, driver["line_id"], act_periods, cmp_periods,
                                    scope_type, scope_id)
            if drivers:
                facts.append(f"Drivers of the {driver['line_label']} movement, by "
                             "business unit and region:")
                for d in drivers:
                    facts.append(f"  {d['bu']} ({d['region']}): {_fmt_usd(d['var_abs'])} "
                                 f"(actual {_fmt_usd(d['actual'])} vs {cmp_noun} "
                                 f"{_fmt_usd(d['compare'])}).")
        except Exception:  # noqa: BLE001 — drivers are additive; never fail the note
            pass

    if len(facts) <= 1:
        return {"available": False, "persona": (x_persona or "cfo"),
                "comments": [], "seed_question": seed_q,
                "note": "No variance data to comment on for this view."}

    persona = (x_persona or "cfo").lower()
    style = _PERSONA_STYLE.get(persona, _PERSONA_STYLE["controller"])
    context = _INDUSTRY_CONTEXT.get(current_industry(), "")
    prompt = (
        style
        + (f"\n\nBusiness context: {context}\n\n" if context else " ")
        + "Comment on the actual-vs-" + cmp_noun + " variance using ONLY "
        "these facts (do not invent numbers). Use the business context to frame WHY "
        "a movement matters and cite the specific business unit / region drivers "
        "where given. Favourable/unfavourable is from the company's view: higher "
        "revenue is good, higher cost is bad. Return each comment on its own line, "
        "starting with '- '. No preamble, no headers, no markdown bold.\n\n"
        + "\n".join(facts))

    note = _ai_note(prompt)
    if not note:
        return {"available": False, "persona": persona, "comments": [],
                "seed_question": seed_q,
                "note": "AI commentary unavailable — see the variances above."}
    comments = [ln.lstrip("-•* ").strip() for ln in note.splitlines() if ln.strip()]
    return {"available": True, "persona": persona, "basis": eff_basis,
            "period": p, "comments": comments, "seed_question": seed_q}


@router.get("/statements/{stmt}/comparative/commentary")
def comparative_commentary(
    stmt: str, basis: str = Query(None),
    window: str = Query(None), compare: str = Query(None),
    scope_type: str = Query("consolidated"), scope_id: str = Query("ALL"),
    period: str = Query(None),
    x_persona: str | None = Header(default=None),
):
    """Serve persona-specific AI commentary from a versioned one-hour cache.

    The underlying facts only change when governed data is invalidated. Caching
    the complete grounded response removes a repeated 7–11 second ai_query from
    every page visit while preserving persona-specific writing depth.
    """
    key = (
        current_industry(), stmt, basis, window, compare,
        scope_type, scope_id, period, (x_persona or "cfo").lower(),
    )
    return _commentary_cache.get_or_compute(
        key,
        lambda: _compute_comparative_commentary(
            stmt, basis, window, compare, scope_type, scope_id, period, x_persona,
        ),
        cache_when=lambda result: bool(result.get("available")),
    )


@router.get("/statements/{stmt}/comparative/line-insights")
def comparative_line_insights(
    stmt: str, basis: str = Query(None),
    window: str = Query(None), compare: str = Query(None),
    scope_type: str = Query("consolidated"), scope_id: str = Query("ALL"),
    period: str = Query(None),
):
    """Caching wrapper for the AI Insight ("why") column. Serves a cached insight
    map for an identical view (industry + stmt + window/compare/scope/period)
    when one is warm and the governed data hasn't been invalidated, so repeat
    loads and tab switches are instant instead of re-running the ~7–11s ai_query
    plus warehouse grounding. A per-key lock collapses concurrent identical
    requests into a single computation. Only positive results are cached, so a
    transient ai_query failure is retried on the next load rather than pinned."""
    _ck = (current_industry(), stmt, basis, window, compare, scope_type, scope_id, period)
    return _insights_cache.get_or_compute(
        _ck,
        lambda: _compute_line_insights(
            stmt, basis, window, compare, scope_type, scope_id, period,
        ),
        cache_when=lambda result: bool(result.get("available")),
    )


def _compute_line_insights(
    stmt: str, basis: str = None,
    window: str = None, compare: str = None,
    scope_type: str = "consolidated", scope_id: str = "ALL",
    period: str = None,
):
    """A one-line "why" for EACH statement line — the always-on AI Insight column
    on the variance table. One grounded ai_query returns a JSON map keyed by
    line_id, so a single call explains every row (not N calls). Same grounding
    discipline as the commentary endpoint: the model sees only the numbers +
    business context we supply, so it can't invent figures.

    Best-effort throughout: on any failure (ai_query down, unparseable JSON) it
    returns `available=False` with an empty map, and the column simply renders
    blank — the table never breaks. Not persona-varied (a line's "why" is the
    same fact regardless of who's reading)."""
    data = comparative_statement(stmt, basis=basis, window=window, compare=compare,
                                 scope_type=scope_type, scope_id=scope_id, period=period)
    lines = data.get("lines", []) if isinstance(data, dict) else []
    eff_basis = data.get("basis", basis or "mom") if isinstance(data, dict) else (basis or "mom")
    eff_window = data.get("window", "mtd") if isinstance(data, dict) else "mtd"
    eff_compare = data.get("compare", "prior") if isinstance(data, dict) else "prior"
    p = data.get("period", resolve_period(period)) if isinstance(data, dict) else resolve_period(period)
    compare_period = data.get("compare_period", "") if isinstance(data, dict) else ""
    cmp_noun, _cmp_the, _cmp_adv = _BASIS_WORDS.get(eff_basis, _BASIS_WORDS["mom"])
    scope_label = "consolidated" if (not scope_type or scope_type == "consolidated") else scope_id

    # Movers with a real variance — the only rows we ask the model to explain.
    movers = [r for r in lines if r.get("var_abs") is not None and _f(r.get("var_abs")) != 0]
    if not movers:
        return {"available": False, "period": p, "insights": {}}

    # Grounded facts: the per-line numbers, plus BU/region drivers for the biggest
    # mover so at least the headline line gets a concrete "why". Skipped for budget
    # (not at BU/region grain) and best-effort.
    facts = [f"Statement: {stmt}. Period {p}. Comparison: actual vs {cmp_noun}"
             + (f" ({compare_period})" if compare_period else "") + f". Scope: {scope_label}."]
    for r in movers:
        facts.append(
            f"[{r['line_id']}] {r['line_label']}: actual {_fmt_usd(_f(r.get('actual')))}, "
            f"{cmp_noun} {_fmt_usd(_f(r.get('compare')))}, variance {_fmt_usd(_f(r.get('var_abs')))}"
            + (f" ({r['var_pct']:+.1f}%)" if r.get("var_pct") is not None else "") + ".")

    # For lines WITH concrete driver detail (below) the prompt requires attribution;
    # lines without it get only their total movement stated. The model reads which
    # is which straight from the fact list.
    driver = _biggest_driver(movers)
    if driver and eff_compare != "budget":
        try:
            act_periods, cmp_periods = _window_driver_periods(stmt, eff_window, eff_compare, p)
            drivers = _line_drivers(stmt, driver["line_id"], act_periods, cmp_periods,
                                    scope_type, scope_id)
            if drivers:
                facts.append(f"Drivers of the {driver['line_label']} movement, by business "
                             "unit and region:")
                for d in drivers:
                    facts.append(f"  {d['bu']} ({d['region']}): {_fmt_usd(d['var_abs'])}.")
        except Exception:  # noqa: BLE001 — additive; never fail the insights
            pass

    # COGS has a real rate/volume decomposition (inventory subledger). Feed it so
    # the insight names the ACTUAL driver (unit cost vs volume) instead of guessing.
    # Only on the income statement, and skipped for budget (bridge isn't defined
    # against plan). Best-effort — a failure just leaves COGS with total-only facts.
    if stmt == "income" and any(r["line_id"] == "cogs" for r in movers):
        try:
            from .bridge_analysis import cogs_bridge  # deferred: avoids import cycle
            br = cogs_bridge(window=eff_window, compare=eff_compare,
                             scope_type=scope_type, scope_id=scope_id, period=period)
            if isinstance(br, dict) and br.get("total_var"):
                facts.append(
                    "Rate/volume split of the Cost of Goods Sold movement (from the "
                    "inventory subledger): "
                    f"unit-cost (rate) effect {_fmt_usd(_f(br.get('rate_effect')))}, "
                    f"volume effect {_fmt_usd(_f(br.get('volume_effect')))}"
                    + (f", mix/residual {_fmt_usd(_f(br.get('residual')))}"
                       if abs(_f(br.get("residual"))) >= 1000 else "") + ".")
        except Exception:  # noqa: BLE001 — additive; never fail the insights
            pass

    # Cross-line margin context (income statement only) — pre-framed so the deeper
    # "detail" stays one coherent thread with the headline and cites only figures
    # the reader can see. `margin_owner` is the single line the gross-margin point
    # must attach to (so it isn't smeared across rows).
    ratio_facts, margin_owner = _income_ratio_facts(lines, cmp_noun) if stmt == "income" else ([], None)
    if ratio_facts:
        facts.append("Margin framing (already computed — use verbatim, do not recompute "
                     "and do not move to other lines):")
        facts.extend("  " + f for f in ratio_facts)

    context = _INDUSTRY_CONTEXT.get(current_industry(), "")
    ids = ", ".join(f'"{r["line_id"]}"' for r in movers)
    prompt = (
        "You are an FP&A analyst. For EACH statement line below, return an object with "
        '"headline" and "detail" that together tell ONE coherent story about THAT line '
        "— the detail deepens the headline's point, it is NOT a separate topic.\n"
        '  "headline": ONE short sentence (max ~14 words) — the movement and, if driver '
        "detail is given, the concrete driver behind it (e.g. 'Costs rose on higher unit "
        "costs, mostly North America').\n"
        '  "detail": ONE or TWO sentences taking the SAME point deeper — the consequence '
        "of that movement. If there is no honest deeper point, return \"\".\n"
        "TRACEABILITY (critical — a CFO must reconcile every number to the screen):\n"
        "- In the detail, cite ONLY figures the reader can see on the statement: the "
        "line's own $ variance and its Var%. You MAY state a gross- or operating-margin "
        "MOVE in percentage points, but ONLY as framed above and ONLY on the line named "
        "there — and NEVER state an absolute margin level (e.g. do not say 'margin is "
        "40%'); the level is not on screen and reads as invented.\n"
        "- The gross-margin point belongs on the ONE line named in the margin framing"
        + (f" (the '{margin_owner}' line)" if margin_owner else "")
        + "; do not repeat it on any other line. Operating margin belongs on 'opex' "
        "only. Every other line's detail is about that line alone.\n"
        "DRIVER RULES:\n"
        "- If a line has explicit driver detail (business-unit/region breakdown, or a "
        "rate/volume split), the headline MUST attribute the movement to that driver and "
        "MUST NOT contradict it. e.g. if the rate (unit-cost) effect is the larger part "
        "of a cost rise, say costs rose on higher unit costs — do NOT say volume.\n"
        "- If a line has NO driver detail, the headline states ONLY the movement "
        "(direction + amount), e.g. 'Fee income rose $40K versus prior year.'\n"
        "- Never use 'favourable'/'unfavourable'. A fall in an expense HELPS the company; "
        "a fall in revenue HURTS it.\n"
        + (f"Business context (for wording only, not a source of causes): {context}\n" if context else "")
        + f"Return ONLY a JSON object keyed by the exact line_id in brackets, each value "
        f'an object {{"headline": "...", "detail": "..."}}. Keys to include: {ids}. '
        "No markdown, no preamble.\n\n"
        + "\n".join(facts))

    note = _ai_note(prompt)
    insights = _parse_line_insights(note) if note else {}
    if not insights:
        return {"available": False, "period": p, "insights": {}}
    # Keep only ids we asked about (guard against hallucinated keys).
    valid = {r["line_id"] for r in movers}
    insights = {k: v for k, v in insights.items() if k in valid}
    return {"available": True, "period": p, "insights": insights}


def _parse_line_insights(note: str) -> dict:
    """Extract the {line_id: {headline, detail}} object from the model's reply.
    Tolerant of ```json fences / stray prose around the object, and of the older
    {line_id: "sentence"} shape (a bare string becomes the headline with no
    detail). Returns {} on any failure so the caller degrades to a blank column."""
    import json
    import re
    if not note:
        return {}
    # Grab the outermost {...} block, ignoring code fences or preamble.
    m = re.search(r"\{.*\}", note, re.DOTALL)
    if not m:
        return {}
    try:
        obj = json.loads(m.group(0))
    except (ValueError, TypeError):
        return {}
    if not isinstance(obj, dict):
        return {}
    out = {}
    for k, v in obj.items():
        headline = detail = ""
        if isinstance(v, str):
            headline = v.strip()
        elif isinstance(v, dict):
            hv, dv = v.get("headline"), v.get("detail")
            headline = hv.strip() if isinstance(hv, str) else ""
            detail = dv.strip() if isinstance(dv, str) else ""
        # A value with only a detail and no headline is degenerate — promote the
        # detail so the cell is never blank when the model has something to say.
        if not headline and detail:
            headline, detail = detail, ""
        if headline:
            out[str(k)] = {"headline": headline, "detail": detail}
    return out


def _ai_note(prompt: str) -> str | None:
    """One-shot ai_query on the warehouse (mirrors historical._ai_note)."""
    from ..config import WAREHOUSE_ID, get_workspace_client
    import time
    try:
        w = get_workspace_client()
        resp = w.statement_execution.execute_statement(
            statement=f"SELECT ai_query({_q(_NOTE_MODEL)}, {_q(prompt)})",
            warehouse_id=WAREHOUSE_ID, wait_timeout="50s")
        sid = resp.statement_id
        while resp.status and resp.status.state and resp.status.state.value in ("PENDING", "RUNNING"):
            time.sleep(1.5)
            resp = w.statement_execution.get_statement(sid)
        if resp.result and resp.result.data_array:
            note = resp.result.data_array[0][0]
            return note.strip() if note else None
    except Exception:  # noqa: BLE001
        return None
    return None
