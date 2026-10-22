"""DBSQL reads for the AI ROI API over the industry metric view.

Financial figures are read with MEASURE() from ``mv_ai_roi``. Dimensions, events,
budgets, invocations and telemetry come from supporting tables. Dynamic SQL
fragments come only from allowlists; identifiers are validated and quoted.
"""
from __future__ import annotations

import math
import os
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from typing import Any

from .config import (
    AI_ROI_DASHBOARD_URL,
    AI_ROI_GATEWAY_TABLE,
    AI_ROI_GENIE_URL,
    AI_ROI_METRIC_VIEW_URL,
    SRV_FQ,
    current_industry,
)
from .warehouse import query

DIMENSIONS = {
    "business_unit": ("`Business Unit`", "o.name", "dim_org_unit", "org_unit_bk"),
    "use_case": ("`Use Case`", "u.name", "dim_use_case", "use_case_id"),
    "market": ("`Market`", "`Market`", None, None),
    "model": ("`Model`", "m.name", "dim_model", "model_id"),
    "environment": ("`Environment`", "`Environment`", None, None),
    "org_unit": ("`Business Unit`", "o.name", "dim_org_unit", "org_unit_bk"),
    "consumer": ("`Business Unit`", "o.name", "dim_org_unit", "org_unit_bk"),
}
CONFIDENCE_MODES = {"all", "proven"}
TIMESERIES_METRICS = {
    "run_cost": "MEASURE(`Token Run Cost`)",
    "ai_run_cost": "MEASURE(`Token Run Cost`)",
    "fully_loaded_cost": "MEASURE(`Fully Loaded Cost`)",
    "realised_value": "MEASURE(`Realised Value All`)",
    "realised_value_all": "MEASURE(`Realised Value All`)",
    "realised_value_proven": "MEASURE(`Realised Value Proven`)",
    "profitability_index": "MEASURE(`Profitability Index`)",
}
GRAINS = {"month": "MONTH", "quarter": "QUARTER", "year": "YEAR", "day": "DAY"}
_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$")
_TABLE_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){1,2}$")
_MEASURE_BLOCK = """
    MEASURE(`Token Run Cost`) AS run_cost,
    MEASURE(`Amortised Build Cost`) AS amortised_build,
    MEASURE(`Allocated Build Cost`) AS allocated_build,
    MEASURE(`Fully Loaded Cost`) AS fully_loaded_cost,
    MEASURE(`Realised Value All`) AS realised_value_all,
    MEASURE(`Realised Value Proven`) AS realised_value_proven,
    MEASURE(`Net Value`) AS net_value,
    MEASURE(`Profitability Index`) AS profitability_index,
    MEASURE(`Profitability Index Proven`) AS profitability_index_proven,
    MEASURE(`Total Tokens`) AS tokens,
    MEASURE(`Requests`) AS requests,
    MEASURE(`Revenue per Mtok`) AS revenue_per_mtok,
    MEASURE(`Token Cost per Mtok`) AS cost_per_mtok,
    MEASURE(`Fully Loaded Cost per Mtok`) AS loaded_cost_per_mtok
"""


def validate_dimension(value: str) -> str:
    if value not in DIMENSIONS:
        raise ValueError(f"dimension must be one of {sorted(DIMENSIONS)}")
    return value


def validate_confidence(value: str) -> str:
    if value not in CONFIDENCE_MODES:
        raise ValueError(f"confidence must be one of {sorted(CONFIDENCE_MODES)}")
    return value


def validate_metric(value: str) -> str:
    if value not in TIMESERIES_METRICS:
        raise ValueError(f"metric must be one of {sorted(TIMESERIES_METRICS)}")
    return value


def validate_grain(value: str) -> str:
    if value not in GRAINS:
        raise ValueError(f"grain must be one of {sorted(GRAINS)}")
    return value


def _literal(value: str) -> str:
    if not _ID_RE.fullmatch(value):
        raise ValueError(
            "filter identifiers may contain only letters, numbers, . _ : / -"
        )
    return "'" + value.replace("'", "''") + "'"


def _csv_in(column: str, value: str) -> str:
    parts = [part.strip() for part in value.split(",") if part.strip()]
    if not parts:
        return ""
    literals = ", ".join(_literal(part) for part in parts)
    if len(parts) == 1:
        return f"{column} = {literals}"
    return f"{column} IN ({literals})"


def _org_unit_clause(column: str, business_unit: str) -> str:
    child_sql = (
        f"SELECT org_unit_bk FROM {_schema()}.dim_org_unit "
        f"WHERE parent_bk = {_literal(business_unit)} "
        f"OR parent_bk IN (SELECT org_unit_bk FROM {_schema()}.dim_org_unit "
        f"WHERE parent_bk = {_literal(business_unit)})"
    )
    return f"({column} = {_literal(business_unit)} OR {column} IN ({child_sql}))"


def _child_bucket_sql(parent: str) -> str:
    srv = _schema()
    lit = _literal(parent)
    return f"""
        direct AS (
          SELECT org_unit_bk, name FROM {srv}.dim_org_unit
          WHERE parent_bk = {lit} AND effective_to IS NULL
        ),
        mapped AS (
          SELECT u.org_unit_bk AS leaf_bk,
                 CASE
                   WHEN u.parent_bk = {lit} THEN u.org_unit_bk
                   WHEN u.parent_bk IN (SELECT org_unit_bk FROM direct) THEN u.parent_bk
                   ELSE NULL
                 END AS bucket
          FROM {srv}.dim_org_unit u
          WHERE u.effective_to IS NULL
        )"""


def _schema() -> str:
    return str(SRV_FQ)


def _mv() -> str:
    return f"{_schema()}.mv_ai_roi"


def _shift_month(value: date, months: int) -> date:
    year = value.year + (value.month - 1 + months) // 12
    month = (value.month - 1 + months) % 12 + 1
    return date(year, month, 1)


def _window(
    from_date: date | None,
    to_date: date | None,
    period: str | None = None,
) -> tuple[date | None, date | None]:
    if from_date or to_date:
        return from_date, to_date
    if period and re.fullmatch(r"\d{4}-\d{2}", period[:7] if period else ""):
        year, month = map(int, period[:7].split("-"))
        end = date(year, month, 1)
        return _shift_month(end, -11), end
    return None, None


def _period_sql(from_date: date | None, to_date: date | None, column: str = "`Month`") -> str:
    clauses: list[str] = []
    if from_date:
        clauses.append(f"{column} >= DATE '{from_date.isoformat()}'")
    if to_date:
        clauses.append(f"{column} <= DATE '{to_date.isoformat()}'")
    return (" AND " + " AND ".join(clauses)) if clauses else ""


def _scoped_business_unit(
    business_unit: str | None = None,
    scope_type: str | None = None,
    scope_id: str | None = None,
) -> str | None:
    if scope_type == "business_unit" and scope_id and scope_id not in ("ALL", "ROOT"):
        return business_unit or scope_id
    if business_unit and business_unit not in ("ALL", "ROOT"):
        return business_unit
    return None


def _fact_scope_sql(
    business_unit: str | None = None,
    use_case: str | None = None,
    market: str | None = None,
    scope_type: str | None = None,
    scope_id: str | None = None,
) -> str:
    business_unit = _scoped_business_unit(business_unit, scope_type, scope_id)
    if scope_type == "use_case" and scope_id and scope_id != "ALL":
        use_case = use_case or scope_id
    clauses: list[str] = []
    if business_unit:
        clauses.append(_org_unit_clause("org_unit_bk", business_unit))
    if use_case:
        clauses.append(f"use_case_id = {_literal(use_case)}")
    if market:
        clauses.append(_csv_in("market", market))
    return (" AND " + " AND ".join(clauses)) if clauses else ""


def _scope_sql(
    business_unit: str | None = None,
    use_case: str | None = None,
    market: str | None = None,
    scope_type: str | None = None,
    scope_id: str | None = None,
) -> str:
    business_unit = _scoped_business_unit(business_unit, scope_type, scope_id)
    if scope_type == "use_case" and scope_id and scope_id != "ALL":
        use_case = use_case or scope_id
    clauses: list[str] = []
    if business_unit:
        clauses.append(_org_unit_clause("`Business Unit`", business_unit))
    if use_case:
        clauses.append(f"`Use Case` = {_literal(use_case)}")
    if market:
        clauses.append(_csv_in("`Market`", market))
    return (" AND " + " AND ".join(clauses)) if clauses else ""


def _num(value) -> float:
    return float(value or 0)


def _int(value) -> int:
    return int(value or 0)


def _optional_num(value) -> float | None:
    return None if value is None else float(value)


def _iso(value) -> str | None:
    if value is None:
        return None
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def _run_parallel(statements: dict[str, str]) -> dict[str, list[dict]]:
    if len(statements) < 2:
        return {name: query(sql) for name, sql in statements.items()}
    with ThreadPoolExecutor(max_workers=min(6, len(statements))) as executor:
        futures = {name: executor.submit(query, sql) for name, sql in statements.items()}
        return {name: future.result() for name, future in futures.items()}


def _confidence_mix(**kwargs) -> dict[str, float]:
    where, start, end = filters(**kwargs)
    period = _period_sql(start, end, column="month")
    scope = _fact_scope_sql(
        kwargs.get("business_unit"), kwargs.get("use_case"), kwargs.get("market"),
        kwargs.get("scope_type"), kwargs.get("scope_id"),
    )
    row = (query(f"""
        SELECT SUM(value_metered_usd) AS metered,
               SUM(value_attested_usd) AS attested,
               SUM(value_modelled_usd) AS modelled
        FROM {_schema()}.fact_ai_daily
        WHERE 1=1{period}{scope}""") or [{}])[0]
    metered = _num(row.get("metered"))
    attested = _num(row.get("attested"))
    modelled = _num(row.get("modelled"))
    total = metered + attested + modelled
    if total <= 0:
        return {}
    return {
        "metered": round(metered / total, 6),
        "attested": round(attested / total, 6),
        "modelled": round(modelled / total, 6),
    }


def _project_breakeven(cum_value: list[float], horizon: int = 12) -> tuple[list[float], list[float], list[float]]:
    if len(cum_value) < 2:
        return [], [], []
    deltas = [cum_value[i] - cum_value[i - 1] for i in range(1, len(cum_value))]
    window = deltas[-6:] if len(deltas) >= 6 else deltas
    mu = sum(window) / len(window)
    if len(window) >= 2:
        mean = mu
        var = sum((d - mean) ** 2 for d in window) / (len(window) - 1)
        sigma = math.sqrt(var)
    else:
        sigma = 0.0
    proj, band_low, band_high = [], [], []
    base = cum_value[-1]
    for n in range(1, horizon + 1):
        projected = base + n * mu
        half = sigma * math.sqrt(n)
        proj.append(projected)
        band_low.append(projected - half)
        band_high.append(projected + half)
    return proj, band_low, band_high


def _breakeven_payload(monthly: list[dict], summary: dict) -> dict:
    pay = _payback(summary, monthly)
    cum_value = cum_outlay = 0.0
    actual_months: list[dict] = []
    cum_values: list[float] = []
    for row in monthly:
        cum_value += _num(row.get("realised_value_all"))
        cum_outlay += _num(row.get("fully_loaded_cost"))
        cum_values.append(cum_value)
        actual_months.append({
            "period": _iso(row.get("month")),
            "cum_value": cum_value,
            "cum_outlay": cum_outlay,
        })
    last_actual = len(actual_months) - 1
    proj_values, band_low, band_high = _project_breakeven(cum_values)
    months = list(actual_months)
    low_band: list[float | None] = [None] * len(actual_months)
    high_band: list[float | None] = [None] * len(actual_months)
    if proj_values and last_actual >= 0:
        last_period = actual_months[-1]["period"]
        year, month = map(int, str(last_period)[:7].split("-"))
        cur = date(year, month, 1)
        last_outlay = actual_months[-1]["cum_outlay"]
        outlay_delta = (
            (last_outlay - actual_months[-2]["cum_outlay"]) / max(len(actual_months) - 1, 1)
            if len(actual_months) > 1 else last_outlay / max(len(actual_months), 1)
        )
        projected_outlay = last_outlay
        for i, value in enumerate(proj_values):
            month = _shift_month(cur, i + 1)
            projected_outlay += outlay_delta
            months.append({
                "period": month.isoformat(),
                "cum_value": value,
                "cum_outlay": projected_outlay,
            })
            low_band.append(band_low[i])
            high_band.append(band_high[i])
    return {
        "crossover_month": pay["cash_breakeven_month"],
        "simple_payback_months": pay["simple_payback_months"],
        "ramp_drag_months": pay["ramp_drag_months"],
        "last_actual_index": last_actual,
        "band_low": low_band,
        "band_high": high_band,
        "months": months,
        "reason": None if pay["cash_breakeven_month"] else (
            "Cumulative value has not crossed fully loaded outlay."
        ),
    }


def _payback(summary: dict, monthly: list[dict]) -> dict[str, Any]:
    run_cost = _num(summary.get("run_cost"))
    loaded = _num(summary.get("fully_loaded_cost"))
    value_all = _num(summary.get("realised_value_all"))
    n = max(len(monthly), 1)
    monthly_value = value_all / n
    monthly_run = run_cost / n
    simple = (loaded / monthly_value) if monthly_value else None
    cum_v = cum_o = 0.0
    crossover = None
    for i, row in enumerate(monthly, start=1):
        cum_v += _num(row.get("realised_value_all") or row.get("realised_value"))
        cum_o += _num(row.get("fully_loaded_cost") or row.get("run_cost"))
        if crossover is None and cum_v >= cum_o and cum_o > 0:
            crossover = i
    return {
        "run_rate_rodt": ((value_all - run_cost) / run_cost) if run_cost else None,
        "programme_rodt": ((value_all - loaded) / loaded) if loaded else None,
        "net_run_rate_value": (monthly_value - monthly_run) * 12,
        "cash_breakeven_month": crossover,
        "simple_payback_months": simple,
        "ramp_drag_months": (
            (crossover - simple) if crossover is not None and simple is not None else None
        ),
        "months": n,
        "cum_value": [_num(r.get("realised_value_all") or r.get("realised_value")) for r in monthly],
        "cum_outlay": [_num(r.get("fully_loaded_cost") or r.get("run_cost")) for r in monthly],
    }


def _summary_row(row: dict, monthly: list[dict] | None = None) -> dict:
    run_cost = _num(row.get("run_cost"))
    loaded_cost = _num(row.get("fully_loaded_cost"))
    value_all = _num(row.get("realised_value_all"))
    value_proven = _num(row.get("realised_value_proven"))
    extra = _payback(row, monthly or []) if monthly is not None else {}
    net_value = _optional_num(row.get("net_value"))
    if net_value is None:
        net_value = value_all - loaded_cost
    return {
        "run_cost": run_cost,
        "ai_run_cost": run_cost,
        "fully_loaded_cost": loaded_cost,
        "realised_value": value_all,
        "realised_value_all": value_all,
        "realised_value_proven": value_proven,
        "net_value": net_value,
        "net_ai_value": net_value,
        "amortised_investment": _num(row.get("amortised_build")),
        "vpmt": _optional_num(row.get("revenue_per_mtok")),
        "cost_per_outcome": None,
        "run_rate_rodt": extra.get("run_rate_rodt") or (
            ((value_all - run_cost) / run_cost) if run_cost else None
        ),
        "programme_rodt": extra.get("programme_rodt") or (
            ((value_all - loaded_cost) / loaded_cost) if loaded_cost else None
        ),
        "profitability_index": _optional_num(row.get("profitability_index"))
        or (value_all / loaded_cost if loaded_cost else None),
        "profitability_index_proven": _optional_num(row.get("profitability_index_proven"))
        or (value_proven / loaded_cost if loaded_cost else None),
        "tokens": _int(row.get("tokens")),
        "requests": _int(row.get("requests")),
        "net_run_rate_value": extra.get("net_run_rate_value"),
        "cash_breakeven_month": extra.get("cash_breakeven_month"),
        "simple_payback_months": extra.get("simple_payback_months"),
        "ramp_drag_months": extra.get("ramp_drag_months"),
    }


def filters(
    from_date: date | None = None,
    to_date: date | None = None,
    period: str | None = None,
    business_unit: str | None = None,
    use_case: str | None = None,
    market: str | None = None,
    scope_type: str | None = None,
    scope_id: str | None = None,
) -> tuple[str, date | None, date | None]:
    start, end = _window(from_date, to_date, period)
    where = _period_sql(start, end) + _scope_sql(
        business_unit, use_case, market, scope_type, scope_id
    )
    return where, start, end


def native_asset_links() -> dict[str, str]:
    suffix = current_industry().upper()
    return {
        name: url
        for name, url in {
            "dashboard": os.environ.get(
                f"AI_ROI_DASHBOARD_URL_{suffix}", AI_ROI_DASHBOARD_URL
            ),
            "genie": os.environ.get(
                f"AI_ROI_GENIE_URL_{suffix}", AI_ROI_GENIE_URL
            ),
            "metric_view": AI_ROI_METRIC_VIEW_URL,
        }.items()
        if url
    }


def _summary_sql(where: str) -> str:
    return f"SELECT {_MEASURE_BLOCK} FROM {_mv()} WHERE 1=1{where}"


def _monthly_sql(where: str) -> str:
    return f"""
        SELECT `Month` AS month, {_MEASURE_BLOCK}
        FROM {_mv()} WHERE 1=1{where}
        GROUP BY `Month` ORDER BY `Month`"""


def metrics_summary(**kwargs) -> dict:
    where, start, end = filters(**kwargs)
    prior_where = ""
    if start and end:
        span = (end.year - start.year) * 12 + (end.month - start.month) + 1
        prior_end = _shift_month(start, -1)
        prior_start = _shift_month(prior_end, 1 - span)
        prior_where = _period_sql(prior_start, prior_end) + _scope_sql(
            kwargs.get("business_unit"), kwargs.get("use_case"), kwargs.get("market"),
            kwargs.get("scope_type"), kwargs.get("scope_id"),
        )
    statements = {
        "summary": _summary_sql(where),
        "monthly": _monthly_sql(where),
        "unattributed": f"""
            SELECT MEASURE(`Token Run Cost`) AS unattributed_cost
            FROM {_mv()} WHERE `Use Case` IS NULL{where}""",
        "concentration": f"""
            SELECT MEASURE(`Token Run Cost`) AS run_cost
            FROM {_mv()} WHERE 1=1{where}
            GROUP BY `Business Unit` ORDER BY run_cost DESC""",
    }
    if prior_where:
        statements["previous"] = _summary_sql(prior_where)
    results = _run_parallel(statements)
    summary = _summary_row((results["summary"] or [{}])[0], results.get("monthly") or [])
    previous = _summary_row((results.get("previous") or [{}])[0]) if results.get("previous") else {
        "ai_run_cost": 0, "run_rate_rodt": None, "run_cost": 0,
    }
    costs = [_num(r.get("run_cost")) for r in results.get("concentration") or []]
    total = sum(costs) or 1
    top10 = sum(costs[:10]) / total if costs else None
    unattributed = _num((results.get("unattributed") or [{}])[0].get("unattributed_cost"))
    mix = _confidence_mix(**kwargs)
    if not mix:
        mix_proven = (
            summary["realised_value_proven"] / summary["realised_value_all"]
            if summary["realised_value_all"] else None
        )
        if mix_proven is not None:
            mix = {
                "metered": round(mix_proven, 6),
                "attested": 0.0,
                "modelled": round(1 - mix_proven, 6),
            }
    return {
        **summary,
        "previous": previous,
        "spend_concentration_top10": top10,
        "unattributed_cost": unattributed,
        "tagging_coverage": (1 - unattributed / summary["run_cost"]) if summary["run_cost"] else 1,
        "confidence_mix": mix,
    }


def executive(**kwargs) -> dict:
    where, _, _ = filters(**kwargs)
    results = _run_parallel({
        "summary": _summary_sql(where),
        "monthly": _monthly_sql(where),
        "exception": f"""
            SELECT `Business Unit` AS key,
                   MEASURE(`Profitability Index`) AS profitability_index,
                   MEASURE(`Profitability Index Proven`) AS profitability_index_proven
            FROM {_mv()} WHERE `Business Unit` IS NOT NULL{where}
            GROUP BY `Business Unit`
            ORDER BY profitability_index ASC NULLS LAST LIMIT 1""",
            "markets": f"""
            SELECT DISTINCT market
            FROM {_schema()}.dim_org_unit
            WHERE market IS NOT NULL AND market <> 'GLOBAL'
            ORDER BY market""",
        "changed": f"""
            WITH monthly AS (
              SELECT `Use Case` AS key, `Month` AS month,
                     MEASURE(`Token Run Cost`) AS value
              FROM {_mv()} WHERE `Use Case` IS NOT NULL{where}
              GROUP BY `Use Case`, `Month`
            ),
            ranked AS (
              SELECT *, ROW_NUMBER() OVER (PARTITION BY key ORDER BY month DESC) AS recency
              FROM monthly
            ),
            movers AS (
              SELECT key,
                     MAX(CASE WHEN recency = 1 THEN value END) AS value,
                     MAX(CASE WHEN recency = 2 THEN value END) AS prior_value
              FROM ranked WHERE recency <= 2 GROUP BY key
            )
            SELECT m.key, COALESCE(u.name, m.key) AS label, m.value,
                   m.value - COALESCE(m.prior_value, m.value) AS delta
            FROM movers m
            LEFT JOIN {_schema()}.dim_use_case u ON u.use_case_id = m.key
            ORDER BY ABS(delta) DESC LIMIT 8""",
    })
    summary = _summary_row((results["summary"] or [{}])[0], results["monthly"])
    exception_row = results["exception"][0] if results["exception"] else None
    monthly = results["monthly"]
    return {
        "summary": summary,
        "break_even_at": 1.0,
        "exception": (
            {
                "key": exception_row.get("key"),
                "profitability_index": _optional_num(exception_row.get("profitability_index")),
                "profitability_index_proven": _optional_num(
                    exception_row.get("profitability_index_proven")
                ),
            }
            if exception_row else None
        ),
        "trend": [
            {
                "period": _iso(r.get("month")),
                "run_cost": _num(r.get("run_cost")),
                "realised_value": _num(r.get("realised_value_all")),
                "fully_loaded_cost": _num(r.get("fully_loaded_cost")),
            }
            for r in monthly
        ],
        "breakeven": _breakeven_payload(monthly, summary),
        "what_changed": [
            {
                "key": r.get("key"),
                "label": r.get("label") or r.get("key"),
                "value": _num(r.get("value")),
                "delta": _num(r.get("delta")),
            }
            for r in results["changed"]
        ],
        "markets": [
            str(r.get("market"))
            for r in results.get("markets") or []
            if r.get("market")
        ],
        "native_assets": native_asset_links(),
    }


def _dim_join(dimension: str) -> tuple[str, str, str, str]:
    dim_expr, label_expr, table, key = DIMENSIONS[dimension]
    srv = _schema()
    join = ""
    extra = "CAST(NULL AS STRING) AS extra"
    if table == "dim_org_unit":
        join = f"LEFT JOIN {srv}.dim_org_unit o ON o.org_unit_bk = roi.key"
        label_expr = "COALESCE(o.name, roi.key)"
    elif table == "dim_use_case":
        join = f"LEFT JOIN {srv}.dim_use_case u ON u.use_case_id = roi.key"
        label_expr = "COALESCE(u.name, roi.key)"
    elif table == "dim_model":
        join = f"LEFT JOIN {srv}.dim_model m ON m.model_id = roi.key"
        label_expr = "COALESCE(m.name, roi.key)"
        extra = "m.model_class AS extra"
    else:
        label_expr = "roi.key"
    return dim_expr, label_expr, join, extra


def _breakdown_sql(where: str, group_by: str, measure: str, order: str, limit: int) -> str:
    dim_expr, label_expr, join, extra = _dim_join(group_by)
    return f"""
        WITH roi AS (
          SELECT {dim_expr} AS key, {measure} AS value
          FROM {_mv()} WHERE {dim_expr} IS NOT NULL{where}
          GROUP BY {dim_expr}
        )
        SELECT roi.key, {label_expr} AS label, roi.value, {extra}
        FROM roi {join}
        ORDER BY {order} LIMIT {int(limit)}"""


def metrics_breakdown(metric: str = "ai_run_cost", group_by: str = "business_unit",
                      sort: str = "value", limit: int = 50, **kwargs) -> dict:
    metric = validate_metric(metric)
    group_by = validate_dimension(group_by)
    where, start, end = filters(**kwargs)
    measure = TIMESERIES_METRICS[metric]
    order = "value DESC" if sort != "key" else "key"
    statements = {"current": _breakdown_sql(where, group_by, measure, order, limit)}
    prior_where = ""
    if start and end:
        span = (end.year - start.year) * 12 + (end.month - start.month) + 1
        prior_end = _shift_month(start, -1)
        prior_start = _shift_month(prior_end, 1 - span)
        prior_where = _period_sql(prior_start, prior_end) + _scope_sql(
            kwargs.get("business_unit"), kwargs.get("use_case"), kwargs.get("market"),
            kwargs.get("scope_type"), kwargs.get("scope_id"),
        )
        statements["previous"] = _breakdown_sql(prior_where, group_by, measure, order, limit)
    results = _run_parallel(statements)
    rows = results["current"]
    prior_map = {
        str(r.get("key")): _num(r.get("value"))
        for r in (results.get("previous") or [])
    }
    total = sum(_num(r.get("value")) for r in rows) or 1
    shaped = []
    for r in rows:
        value = _num(r.get("value"))
        prior_value = prior_map.get(str(r.get("key")), 0)
        delta = value - prior_value
        item = {
            "key": r.get("key"),
            "label": r.get("label") or r.get("key"),
            "value": value,
            "delta": delta,
            "delta_pct": (delta / prior_value) if prior_value else None,
            "share": value / total,
        }
        if group_by == "model":
            item["model_class"] = r.get("extra")
        shaped.append(item)
    return {"group_by": group_by, "metric": metric, "rows": shaped}


def metrics_timeseries(metric: str = "ai_run_cost", grain: str = "month",
                       group_by: str | None = None, **kwargs) -> dict:
    metric = validate_metric(metric)
    grain = validate_grain(grain)
    if group_by:
        group_by = validate_dimension(group_by)
    where, _, _ = filters(**kwargs)
    measure = TIMESERIES_METRICS[metric]
    dim_expr = DIMENSIONS[group_by][0] if group_by else None
    select_key = f", {dim_expr} AS key" if dim_expr else ""
    group_key = f", {dim_expr}" if dim_expr else ""
    rows = query(f"""
        SELECT `Month` AS period{select_key}, {measure} AS value
        FROM {_mv()} WHERE 1=1{where}
        GROUP BY `Month`{group_key}
        ORDER BY period{group_key}""")
    return {
        "metric": metric, "grain": grain, "group_by": group_by,
        "series": [
            {"period": _iso(r.get("period")), "group": r.get("key"),
             "key": r.get("key"), "value": _optional_num(r.get("value"))}
            for r in rows
        ],
    }


def spend(dimension: str = "business_unit", limit: int = 20, **kwargs) -> dict:
    dimension = validate_dimension(dimension)
    summary = metrics_summary(**kwargs)
    # enrich tokens from a second breakdown-like query
    where, _, _ = filters(**kwargs)
    dim_expr, label_expr, join, extra = _dim_join(dimension)
    detail = query(f"""
        WITH roi AS (
          SELECT {dim_expr} AS key, {_MEASURE_BLOCK}
          FROM {_mv()} WHERE {dim_expr} IS NOT NULL{where}
          GROUP BY {dim_expr}
        )
        SELECT roi.key, {label_expr} AS label, roi.run_cost, roi.tokens, roi.requests,
               roi.cost_per_mtok, {extra}
        FROM roi {join} ORDER BY roi.run_cost DESC LIMIT {int(limit)}""")
    return {
        "dimension": dimension,
        "total_run_cost": summary["run_cost"],
        "total_tokens": summary["tokens"],
        "total_requests": summary["requests"],
        "ai_run_cost": summary["run_cost"],
        "previous": summary["previous"],
        "spend_concentration_top10": summary["spend_concentration_top10"],
        "unattributed_cost": summary["unattributed_cost"],
        "tagging_coverage": summary["tagging_coverage"],
        "rows": [
            {
                "key": r.get("key"),
                "label": r.get("label") or r.get("key"),
                "run_cost": _num(r.get("run_cost")),
                "tokens": _int(r.get("tokens")),
                "requests": _int(r.get("requests")),
                "cost_per_mtok": _optional_num(r.get("cost_per_mtok")),
                "share": (_num(r.get("run_cost")) / summary["run_cost"]) if summary["run_cost"] else 0,
                **({"model_class": r.get("extra")} if dimension == "model" else {}),
            }
            for r in detail
        ],
    }


def revenue_attribution(dimension: str = "use_case", confidence: str = "all",
                        limit: int = 50, **kwargs) -> dict:
    dimension = validate_dimension(dimension)
    confidence = validate_confidence(confidence)
    where, _, _ = filters(**kwargs)
    dim_expr, label_expr, join, extra = _dim_join(dimension)
    value_measure = (
        "MEASURE(`Realised Value Proven`)" if confidence == "proven"
        else "MEASURE(`Realised Value All`)"
    )
    rows = query(f"""
        WITH roi AS (
          SELECT {dim_expr} AS key,
                 {value_measure} AS attributed_revenue,
                 MEASURE(`Realised Value Proven`) AS proven_revenue,
                 MEASURE(`Realised Value All`) - MEASURE(`Realised Value Proven`) AS modelled_revenue
          FROM {_mv()} WHERE {dim_expr} IS NOT NULL{where}
          GROUP BY {dim_expr}
        )
        SELECT roi.key, {label_expr} AS label, roi.attributed_revenue,
               roi.proven_revenue, roi.modelled_revenue, {extra}
        FROM roi {join}
        ORDER BY attributed_revenue DESC LIMIT {int(limit)}""")
    total = sum(_num(r.get("attributed_revenue")) for r in rows) or 1
    return {
        "dimension": dimension,
        "confidence": confidence,
        "rows": [
            {
                "key": r.get("key"),
                "label": r.get("label") or r.get("key"),
                "attributed_revenue": _num(r.get("attributed_revenue")),
                "proven_revenue": _num(r.get("proven_revenue")),
                "modelled_revenue": _num(r.get("modelled_revenue")),
                "share": _num(r.get("attributed_revenue")) / total,
            }
            for r in rows
        ],
    }


def _profitability_rollup_cte(where: str) -> str:
    """Business-unit ranking rolled up to level-1 units.

    The metric view's `Business Unit` is the leaf org unit, so an unscoped ranking
    listed every sub-desk and corporate function (26 rows, "11 of 26 below 1.0")
    instead of the five units a CFO reasons about ("2 of 5"). Leaves are aggregated
    through the metric view first, then mapped to their level-1 parent OUTSIDE it
    (metric views reject joins). Ratios are recomputed from the summed numerators
    and denominators: averaging indices would weight a small desk like a large one.
    """
    return f"""
        WITH leaf AS (
          SELECT `Business Unit` AS leaf_key, {_MEASURE_BLOCK}
          FROM {_mv()} WHERE `Business Unit` IS NOT NULL{where}
          GROUP BY `Business Unit`
        ), parent AS (
          SELECT u.org_unit_bk AS leaf_key,
                 CASE WHEN p.level = 1 THEN p.org_unit_bk ELSE u.org_unit_bk END AS key
          FROM {_schema()}.dim_org_unit u
          LEFT JOIN {_schema()}.dim_org_unit p ON p.org_unit_bk = u.parent_bk
        ), roi AS (
          SELECT parent.key,
                 SUM(leaf.run_cost) AS run_cost,
                 SUM(leaf.amortised_build) AS amortised_build,
                 SUM(leaf.allocated_build) AS allocated_build,
                 SUM(leaf.fully_loaded_cost) AS fully_loaded_cost,
                 SUM(leaf.realised_value_all) AS realised_value_all,
                 SUM(leaf.realised_value_proven) AS realised_value_proven,
                 SUM(leaf.realised_value_all) / NULLIF(SUM(leaf.fully_loaded_cost), 0) AS profitability_index,
                 SUM(leaf.realised_value_proven) / NULLIF(SUM(leaf.fully_loaded_cost), 0) AS profitability_index_proven,
                 SUM(leaf.realised_value_all) / NULLIF(SUM(leaf.tokens) / 1000000.0, 0) AS revenue_per_mtok,
                 SUM(leaf.fully_loaded_cost) / NULLIF(SUM(leaf.tokens) / 1000000.0, 0) AS loaded_cost_per_mtok,
                 SUM(leaf.tokens) AS tokens
          FROM leaf JOIN parent ON parent.leaf_key = leaf.leaf_key
          GROUP BY parent.key
        )"""


def profitability(dimension: str = "business_unit", limit: int = 50, **kwargs) -> dict:
    dimension = validate_dimension(dimension)
    where, _, _ = filters(**kwargs)
    dim_expr, label_expr, join, extra = _dim_join(dimension)
    # Unscoped business-unit rankings roll up to level-1 units; once a business
    # unit is selected, its sub-units are ranked instead (the Org Explorer drill).
    scoped_bu = _scoped_business_unit(
        kwargs.get("business_unit"), kwargs.get("scope_type"), kwargs.get("scope_id"))
    rolled_up = dimension in ("business_unit", "org_unit") and not scoped_bu
    roi_cte = _profitability_rollup_cte(where) if rolled_up else f"""
        WITH roi AS (
          SELECT {dim_expr} AS key, {_MEASURE_BLOCK}
          FROM {_mv()} WHERE {dim_expr} IS NOT NULL{where}
          GROUP BY {dim_expr}
        )"""
    ranking_sql = f"""{roi_cte}
        SELECT roi.key, {label_expr} AS label, roi.run_cost, roi.amortised_build,
               roi.allocated_build, roi.fully_loaded_cost, roi.realised_value_all,
               roi.realised_value_proven, roi.profitability_index AS pi_all,
               roi.profitability_index_proven AS pi_proven, roi.revenue_per_mtok,
               roi.loaded_cost_per_mtok, roi.tokens AS total_tokens, {extra}
        FROM roi {join}
        ORDER BY pi_all ASC NULLS LAST LIMIT {int(limit)}"""
    results = _run_parallel({
        "rows": ranking_sql,
        "policy": f"""
            SELECT p.allocation_policy_id, p.policy_name, p.basis, p.owner_role,
                   p.rule, p.signed_off_on, p.review_due_on
            FROM {_schema()}.dim_allocation_policy p LIMIT 1""",
    })
    shaped = [
        {
            "key": r.get("key"),
            "label": r.get("label") or r.get("key"),
            "run_cost": _num(r.get("run_cost")),
            "amortised_build": _num(r.get("amortised_build")),
            "allocated_build": _num(r.get("allocated_build")),
            "fully_loaded_cost": _num(r.get("fully_loaded_cost")),
            "realised_value_all": _num(r.get("realised_value_all")),
            "realised_value_proven": _num(r.get("realised_value_proven")),
            "pi_all": _optional_num(r.get("pi_all")),
            "pi_proven": _optional_num(r.get("pi_proven")),
            "revenue_per_mtok": _optional_num(r.get("revenue_per_mtok")),
            "loaded_cost_per_mtok": _optional_num(r.get("loaded_cost_per_mtok")),
            "total_tokens": _int(r.get("total_tokens")),
        }
        for r in results["rows"]
    ]
    policy = None
    if results["policy"]:
        p = results["policy"][0]
        policy = {
            "allocation_policy_id": p.get("allocation_policy_id"),
            "policy_name": p.get("policy_name"),
            "basis": p.get("basis"),
            "owner_role": p.get("owner_role"),
            "rule": p.get("rule"),
            "signed_off_on": _iso(p.get("signed_off_on")),
            "review_due_on": _iso(p.get("review_due_on")),
        }
    return {
        "dimension": dimension,
        "group_by": dimension,
        # True when sub-units were rolled up to level-1 business units.
        "rolled_up": rolled_up,
        "period_basis": "programme",
        "break_even_at": 1.0,
        "below_break_even": sum(1 for r in shaped if r["pi_all"] is not None and r["pi_all"] < 1.0),
        "below_break_even_proven": sum(
            1 for r in shaped if r["pi_proven"] is not None and r["pi_proven"] < 1.0
        ),
        "counted": len(shaped),
        "allocation_policy": policy,
        "rows": shaped,
    }


def timeseries(metric: str = "run_cost", grain: str = "month", dimension: str | None = None,
               **kwargs) -> dict:
    mapped = {"run_cost": "ai_run_cost"}.get(metric, metric)
    return metrics_timeseries(mapped, grain, group_by=dimension, **kwargs)


def league_table(ratio: str = "run_rate_rodt", **kwargs) -> dict:
    where, _, _ = filters(**kwargs)
    srv = _schema()
    rows = query(f"""
        WITH roi AS (
          SELECT `Use Case` AS use_case_id, {_MEASURE_BLOCK}
          FROM {_mv()} WHERE `Use Case` IS NOT NULL{where}
          GROUP BY `Use Case`
        )
        SELECT roi.*, u.name, u.org_unit_bk, u.status,
               u.confidence_method
        FROM roi LEFT JOIN {srv}.dim_use_case u ON u.use_case_id = roi.use_case_id
        ORDER BY roi.profitability_index DESC""")
    monthly = query(f"""
        SELECT `Use Case` AS use_case_id, `Month` AS month,
               MEASURE(`Token Run Cost`) AS run_cost,
               MEASURE(`Realised Value All`) AS realised_value_all,
               MEASURE(`Fully Loaded Cost`) AS fully_loaded_cost
        FROM {_mv()} WHERE 1=1{where}
        GROUP BY `Use Case`, `Month` ORDER BY month""")
    trends: dict[str, list[float]] = {}
    crossover: dict[str, int | None] = {}
    cumulative: dict[str, tuple[float, float]] = {}
    for r in monthly:
        key = str(r.get("use_case_id"))
        run = _num(r.get("run_cost"))
        val = _num(r.get("realised_value_all"))
        trends.setdefault(key, []).append(((val - run) / run) if run else 0)
        cum_value, cum_outlay = cumulative.get(key, (0.0, 0.0))
        cum_value += val
        cum_outlay += _num(r.get("fully_loaded_cost") or r.get("run_cost"))
        cumulative[key] = (cum_value, cum_outlay)
        if key not in crossover and cum_outlay > 0 and cum_value >= cum_outlay:
            crossover[key] = len(trends[key])
    shaped = []
    for r in rows:
        run = _num(r.get("run_cost"))
        val = _num(r.get("realised_value_all"))
        proven = _num(r.get("realised_value_proven"))
        shaped.append({
            "use_case_id": r.get("use_case_id"),
            "name": r.get("name") or r.get("use_case_id"),
            "org_unit_bk": r.get("org_unit_bk"),
            "status": r.get("status"),
            "ai_run_cost": run,
            "realised_value": val,
            "run_rate_rodt": ((val - run) / run) if run else None,
            "vpmt": _optional_num(r.get("revenue_per_mtok")),
            "cash_breakeven_month": crossover.get(str(r.get("use_case_id"))),
            "cash_breakeven_days": (
                crossover.get(str(r.get("use_case_id"))) * 30
                if crossover.get(str(r.get("use_case_id"))) is not None else None
            ),
            "confidence_mix": {
                "metered_attested": (proven / val) if val else 0,
                "modelled": ((val - proven) / val) if val else 0,
            },
            "rodt_trend": trends.get(str(r.get("use_case_id")), []),
        })
    days_values = sorted(
        row["cash_breakeven_days"] for row in shaped if row["cash_breakeven_days"] is not None
    )
    median_days = None
    if days_values:
        mid = len(days_values) // 2
        median_days = (
            days_values[mid] if len(days_values) % 2
            else (days_values[mid - 1] + days_values[mid]) / 2
        )
    for row in shaped:
        days = row["cash_breakeven_days"]
        row["variance"] = (days - median_days) if days is not None and median_days is not None else None
    sort_key = {
        "run_rate_rodt": "run_rate_rodt",
        "vpmt": "vpmt",
        "ai_run_cost": "ai_run_cost",
        "realised_value": "realised_value",
    }.get(ratio, "run_rate_rodt")
    shaped.sort(
        key=lambda row: (
            row[sort_key] is None,
            -(row[sort_key] or 0),
        )
    )
    return {"ratio": ratio, "rows": shaped}


def breakeven(**kwargs) -> dict:
    where, _, _ = filters(**kwargs)
    monthly = query(_monthly_sql(where))
    summary = _summary_row((query(_summary_sql(where)) or [{}])[0], monthly)
    return _breakeven_payload(monthly, summary)


def _shape_attribution_policy(row: dict | None) -> dict | None:
    if not row:
        return None
    return {
        "attribution_policy_id": row.get("attribution_policy_id"),
        "policy_name": row.get("policy_name"),
        "owner_role": row.get("owner_role"),
        "rule": row.get("rule"),
        "method": row.get("method") or row.get("basis"),
        "signed_off_on": _iso(row.get("signed_off_on")),
        "review_due_on": _iso(row.get("review_due_on")),
    }


def use_case_detail(use_case_id: str, **kwargs) -> dict:
    kwargs = {**kwargs, "use_case": use_case_id}
    srv = _schema()
    header = query(f"""
        SELECT use_case_id, name, org_unit_bk, category, status, launched_on,
               attribution_policy_id
        FROM {srv}.dim_use_case WHERE use_case_id = {_literal(use_case_id)}""")
    if not header:
        return {"error": "not_found", "use_case_id": use_case_id}
    row = header[0]
    summary = metrics_summary(**kwargs)
    be = breakeven(**kwargs)
    policy = None
    policy_id = row.get("attribution_policy_id")
    if policy_id:
        policy_rows = query(f"""
            SELECT attribution_policy_id, policy_name, owner_role, rule, method,
                   signed_off_on, review_due_on
            FROM {srv}.dim_attribution_policy
            WHERE attribution_policy_id = {_literal(str(policy_id))}""")
        policy = _shape_attribution_policy(policy_rows[0] if policy_rows else None)
    cats = query(f"""
        SELECT category, SUM(amount_usd) AS amount_usd
        FROM {srv}.fact_value_event
        WHERE use_case_id = {_literal(use_case_id)}
        GROUP BY category""")
    return {
        "use_case_id": use_case_id,
        "name": row.get("name"),
        "org_unit_bk": row.get("org_unit_bk"),
        "category": row.get("category"),
        "status": row.get("status"),
        "launched_on": _iso(row.get("launched_on")),
        "summary": summary,
        "breakeven": be,
        "attribution_policy": policy,
        "value_categories": [
            {"category": r.get("category"), "amount_usd": _num(r.get("amount_usd"))}
            for r in cats
        ],
    }


def use_case_events(use_case_id: str, kind: str = "value", **kwargs) -> dict:
    srv = _schema()
    table = "fact_value_event" if kind != "investment" else "fact_investment_event"
    rows = query(f"""
        SELECT event_date, category, amount_usd, confidence, source_system, note
        FROM {srv}.{table}
        WHERE use_case_id = {_literal(use_case_id)}
        ORDER BY event_date""")
    return {
        "kind": kind,
        "events": [
            {
                "event_date": _iso(r.get("event_date")),
                "category": r.get("category"),
                "amount_usd": _num(r.get("amount_usd")),
                "confidence": r.get("confidence"),
                "source_system": r.get("source_system"),
                "note": r.get("note"),
            }
            for r in rows
        ],
    }


def _rollup_org_metrics(node: dict) -> tuple[float, float]:
    run = _num(node.get("run_cost"))
    value = _num(node.get("realised_value"))
    for child in node.get("children") or []:
        child_run, child_value = _rollup_org_metrics(child)
        run += child_run
        value += child_value
    node["run_cost"] = run
    node["ai_run_cost"] = run
    node["realised_value"] = value
    node["run_rate_rodt"] = ((value - run) / run) if run else None
    return run, value


def _org_parent_key(scope_type: str | None, scope_id: str | None) -> str:
    if scope_type == "business_unit" and scope_id and scope_id not in ("ALL", "ROOT"):
        return scope_id
    return "ROOT"


def org(**kwargs) -> dict:
    where, _, _ = filters(
        kwargs.get("from_date"), kwargs.get("to_date"), kwargs.get("period"),
    )
    srv = _schema()
    rows = query(f"""
        SELECT o.org_unit_bk AS key, o.name, o.parent_bk, o.level,
               COALESCE(m.run_cost, 0) AS run_cost,
               COALESCE(m.realised_value, 0) AS realised_value,
               COALESCE(m.fully_loaded_cost, 0) AS fully_loaded_cost,
               m.profitability_index
        FROM {srv}.dim_org_unit o
        LEFT JOIN (
            SELECT `Business Unit` AS org_unit_bk,
                   MEASURE(`Token Run Cost`) AS run_cost,
                   MEASURE(`Realised Value All`) AS realised_value,
                   MEASURE(`Fully Loaded Cost`) AS fully_loaded_cost,
                   MEASURE(`Profitability Index`) AS profitability_index
            FROM {_mv()} WHERE 1=1{where}
            GROUP BY `Business Unit`
        ) m ON m.org_unit_bk = o.org_unit_bk
        WHERE o.effective_to IS NULL
        ORDER BY o.level, o.org_unit_bk""")
    nodes = {
        str(r["key"]): {
            "key": r.get("key"),
            "name": r.get("name") or r.get("key"),
            "level": r.get("level"),
            "run_cost": _num(r.get("run_cost")),
            "ai_run_cost": _num(r.get("run_cost")),
            "realised_value": _num(r.get("realised_value")),
            "fully_loaded_cost": _num(r.get("fully_loaded_cost")),
            "profitability_index": _optional_num(r.get("profitability_index")),
            "run_rate_rodt": None,
            "children": [],
        }
        for r in rows if r.get("key") is not None
    }
    roots: list[dict] = []
    for r in rows:
        node = nodes.get(str(r.get("key")))
        if not node:
            continue
        parent = nodes.get(str(r.get("parent_bk"))) if r.get("parent_bk") else None
        (parent["children"] if parent else roots).append(node)
    for root in roots:
        _rollup_org_metrics(root)
    as_of = query(f"SELECT MAX(effective_from) AS hierarchy_as_of FROM {srv}.dim_org_unit")
    return {
        "tree": roots,
        "node_count": len(nodes),
        "hierarchy_as_of": _iso((as_of or [{}])[0].get("hierarchy_as_of")),
    }


def org_detail(**kwargs) -> dict:
    srv = _schema()
    parent = _org_parent_key(kwargs.get("scope_type"), kwargs.get("scope_id"))
    summary = metrics_summary(**kwargs)
    scope_row = query(
        f"SELECT name FROM {srv}.dim_org_unit WHERE org_unit_bk = {_literal(parent)}"
    )
    scope_label = (scope_row or [{}])[0].get("name") or parent
    where, start, end = filters(**kwargs)
    child_rows = query(f"""
        WITH {_child_bucket_sql(parent)},
        roi AS (
          SELECT `Business Unit` AS key, MEASURE(`Token Run Cost`) AS value
          FROM {_mv()} WHERE `Business Unit` IS NOT NULL{where}
          GROUP BY `Business Unit`
        )
        SELECT d.org_unit_bk AS key, d.name AS label, COALESCE(SUM(roi.value), 0) AS value
        FROM direct d
        LEFT JOIN mapped m ON m.bucket = d.org_unit_bk
        LEFT JOIN roi ON roi.key = m.leaf_bk
        GROUP BY d.org_unit_bk, d.name
        ORDER BY value DESC LIMIT 12""")
    total_child = sum(_num(r.get("value")) for r in child_rows) or 1
    children = [
        {
            "key": r.get("key"),
            "label": r.get("label") or r.get("key"),
            "value": _num(r.get("value")),
            "share": _num(r.get("value")) / total_child,
        }
        for r in child_rows
    ]
    subtree = [parent]
    if parent == "ROOT":
        subtree = [
            str(r.get("org_unit_bk"))
            for r in query(
                f"SELECT org_unit_bk FROM {srv}.dim_org_unit "
                f"WHERE parent_bk = 'ROOT' AND effective_to IS NULL"
            )
        ]
    inlist = ",".join(_literal(k) for k in subtree)
    inv_clauses = [
        f"f.use_case_id IN (SELECT use_case_id FROM {srv}.dim_use_case "
        f"WHERE org_unit_bk IN ({inlist}))"
    ]
    if start:
        inv_clauses.append(f"f.event_time >= {_literal(start.isoformat())}")
    if end:
        inv_clauses.append(
            f"f.event_time < {_literal(_shift_month(end, 1).isoformat())}"
        )
    consumer_rows = query(f"""
        SELECT f.consumer_id AS key, SUM(f.cost_usd) AS value
        FROM {srv}.fact_invocation f
        WHERE {' AND '.join(inv_clauses)}
        GROUP BY f.consumer_id
        ORDER BY value DESC
        LIMIT 8""")
    consumers = [
        {
            "key": r.get("key"),
            "label": str(r.get("key")),
            "value": _num(r.get("value")),
        }
        for r in consumer_rows
    ]
    monthly_total = query(_monthly_sql(where))
    child_monthly = query(f"""
        WITH {_child_bucket_sql(parent)},
        roi AS (
          SELECT `Business Unit` AS key, `Month` AS month,
                 MEASURE(`Token Run Cost`) AS run_cost
          FROM {_mv()} WHERE 1=1{where}
          GROUP BY `Business Unit`, `Month`
        )
        SELECT d.org_unit_bk AS grp, d.name AS label, roi.month,
               SUM(roi.run_cost) AS run_cost
        FROM direct d
        JOIN mapped m ON m.bucket = d.org_unit_bk
        JOIN roi ON roi.key = m.leaf_bk
        GROUP BY d.org_unit_bk, d.name, roi.month
        ORDER BY roi.month, d.org_unit_bk""")
    spend_trend = [
        {
            "period": _iso(r.get("month") or r.get("period")),
            "group": "Total",
            "run_cost": _num(r.get("run_cost")),
        }
        for r in monthly_total
    ]
    spend_trend.extend(
        {
            "period": _iso(r.get("month") or r.get("period")),
            "group": str(r.get("label") or r.get("grp")),
            "key": r.get("grp"),
            "run_cost": _num(r.get("run_cost")),
        }
        for r in child_monthly
    )
    return {
        "scope_label": scope_label,
        "summary": summary,
        "children": children,
        "consumers": consumers,
        "spend_trend": spend_trend,
    }


def efficiency(**kwargs) -> dict:
    srv = _schema()
    # Trend is the full seeded usage history (through Sep 2026), not the
    # 12-month close-period window used by the rest of the app.
    _, start, end = filters(
        None, None, None,
        business_unit=kwargs.get("business_unit"),
        use_case=kwargs.get("use_case"),
        market=kwargs.get("market"),
        scope_type=kwargs.get("scope_type"),
        scope_id=kwargs.get("scope_id"),
    )
    usage_period = _period_sql(start, end, "f.usage_date")
    scope = _fact_scope_sql(
        kwargs.get("business_unit"), kwargs.get("use_case"), kwargs.get("market"),
        kwargs.get("scope_type"), kwargs.get("scope_id"),
    )
    statements = {
        "models": f"""
            SELECT f.model_id, m.name, m.tier, m.model_class, SUM(f.cost_usd) AS run_cost,
                   SUM(f.input_tokens + f.output_tokens) AS tokens,
                   SUM(f.requests) AS requests
            FROM {srv}.fact_usage_daily f
            JOIN {srv}.dim_model m ON m.model_id = f.model_id
            WHERE 1=1{usage_period}{scope}
            GROUP BY f.model_id, m.name, m.tier, m.model_class ORDER BY run_cost DESC""",
        "trend": f"""
            SELECT DATE_TRUNC('MONTH', f.usage_date) AS period,
                   SUM(f.cost_usd) AS run_cost,
                   SUM(f.input_tokens + f.output_tokens) AS tokens
            FROM {srv}.fact_usage_daily f WHERE 1=1{usage_period}{scope}
            GROUP BY DATE_TRUNC('MONTH', f.usage_date) ORDER BY period""",
        "waste": f"""
            SELECT SUM(f.cost_usd) AS run_cost,
                   SUM(f.cached_read_tokens) AS cached_tokens,
                   SUM(f.input_tokens + f.output_tokens + f.cached_read_tokens) AS billable_tokens,
                   SUM(f.requests_retried) AS retried_requests,
                   SUM(f.requests_failed) AS failed_requests
            FROM {srv}.fact_usage_daily f WHERE 1=1{usage_period}{scope}""",
    }
    results = _run_parallel(statements)
    waste = (results["waste"] or [{}])[0]
    billable = _num(waste.get("billable_tokens"))
    cached = _num(waste.get("cached_tokens"))
    run_cost = _num(waste.get("run_cost"))
    models = [
        {
            "model_id": r.get("model_id"),
            "name": r.get("name"),
            "tier": r.get("tier"),
            "model_class": r.get("model_class"),
            "run_cost": _num(r.get("run_cost")),
            "ai_run_cost": _num(r.get("run_cost")),
            "tokens": _int(r.get("tokens")),
            "total_tokens": _int(r.get("tokens")),
            "requests": _int(r.get("requests")),
            "cost_per_mtok": (
                _num(r.get("run_cost")) / (_num(r.get("tokens")) / 1_000_000)
                if _num(r.get("tokens")) else None
            ),
            "blended_cost_per_mtok": (
                _num(r.get("run_cost")) / (_num(r.get("tokens")) / 1_000_000)
                if _num(r.get("tokens")) else None
            ),
            "cost_per_request": (
                _num(r.get("run_cost")) / _num(r.get("requests"))
                if _num(r.get("requests")) else None
            ),
        }
        for r in results["models"]
    ]
    trend = [
        {
            "period": _iso(r.get("period")),
            "run_cost": _num(r.get("run_cost")),
            "ai_run_cost": _num(r.get("run_cost")),
            "cost_per_mtok": (
                _num(r.get("run_cost")) / (_num(r.get("tokens")) / 1_000_000)
                if _num(r.get("tokens")) else None
            ),
            "blended_cost_per_mtok": (
                _num(r.get("run_cost")) / (_num(r.get("tokens")) / 1_000_000)
                if _num(r.get("tokens")) else None
            ),
        }
        for r in results["trend"]
    ]
    retried = _int(waste.get("retried_requests"))
    failed = _int(waste.get("failed_requests"))
    return {
        "models": models,
        "trend": trend,
        "waste": {
            "run_cost": run_cost,
            "cache_ratio": cached / billable if billable else None,
            "cache_saving_usd": run_cost * (cached / billable) if billable else 0,
            "retry_waste_usd": run_cost * 0.08 if retried else 0,
            "token_efficiency_ratio": cached / billable if billable else None,
            "retried_requests": retried,
            "failed_requests": failed,
        },
    }


def efficiency_trend(**kwargs) -> dict:
    return {"trend": efficiency(**kwargs)["trend"]}


def efficiency_models(**kwargs) -> dict:
    return {"models": efficiency(**kwargs)["models"]}


def efficiency_waste(**kwargs) -> dict:
    return efficiency(**kwargs)["waste"]


def budgets(**kwargs) -> dict:
    srv = _schema()
    scope_type = kwargs.get("scope_type")
    scope_id = kwargs.get("scope_id")
    if scope_type != "business_unit" or not scope_id or scope_id == "ALL":
        return {"budget_variance": None}
    where, start, end = filters(**kwargs)
    actual = query(f"SELECT MEASURE(`Token Run Cost`) AS actual FROM {_mv()} WHERE 1=1{where}")
    budget_rows = query(
        f"SELECT SUM(budget_usd) AS budget_usd FROM {srv}.fact_budget "
        f"WHERE org_unit_bk = {_literal(scope_id)}"
    )
    budget = _num((budget_rows or [{}])[0].get("budget_usd"))
    actual_usd = _num((actual or [{}])[0].get("actual"))
    months = 12
    if start and end:
        months = max(1, (end.year - start.year) * 12 + (end.month - start.month) + 1)
    prorated = budget * (months / 12)
    if not budget:
        return {"budget_variance": None}
    return {
        "budget_variance": {
            "budget_usd": budget,
            "prorated_budget_usd": prorated,
            "actual_usd": actual_usd,
            "variance_usd": actual_usd - prorated,
            "variance_pct": ((actual_usd - prorated) / prorated) if prorated else None,
            "forecast_period_end_usd": actual_usd * (12 / months),
            "forecast_variance_usd": budget - actual_usd * (12 / months),
        }
    }


def anomalies(**kwargs) -> dict:
    srv = _schema()
    _, start, end = filters(**kwargs)
    anchor = end or start
    if not anchor:
        return {"anomalies": []}
    scope_type = kwargs.get("scope_type")
    scope_id = kwargs.get("scope_id")
    scope_clause = ""
    if scope_type == "business_unit" and scope_id and scope_id != "ALL":
        scope_clause = f" AND f.org_unit_bk = {_literal(scope_id)}"
    elif scope_type == "use_case" and scope_id and scope_id != "ALL":
        scope_clause = f" AND f.use_case_id = {_literal(scope_id)}"
    rows = query(f"""
        SELECT f.org_unit_bk, f.usage_date, SUM(f.cost_usd) AS cost_usd
        FROM {srv}.fact_usage_daily f
        WHERE f.usage_date BETWEEN DATE '{anchor.isoformat()}' - INTERVAL 28 DAYS
              AND DATE '{anchor.isoformat()}'{scope_clause}
        GROUP BY f.org_unit_bk, f.usage_date""")
    by_org: dict[str, list[float]] = {}
    for r in rows:
        by_org.setdefault(str(r.get("org_unit_bk")), []).append(_num(r.get("cost_usd")))
    found = []
    for r in rows:
        cost = _num(r.get("cost_usd"))
        series = by_org[str(r.get("org_unit_bk"))]
        mean = sum(series) / len(series)
        var = sum((x - mean) ** 2 for x in series) / max(len(series) - 1, 1)
        std = var ** 0.5 or 1
        z = (cost - mean) / std
        if abs(z) > 3 and cost > 500:
            found.append({
                "org_unit_bk": r.get("org_unit_bk"),
                "usage_date": _iso(r.get("usage_date")),
                "cost_usd": cost,
                "z": round(z, 2),
            })
    found.sort(key=lambda a: abs(a["z"]), reverse=True)
    return {"anomalies": found[:6]}


def _invocation_scope_clause(**kwargs) -> str:
    srv = _schema()
    scope_type = kwargs.get("scope_type")
    scope_id = kwargs.get("scope_id")
    if scope_type == "use_case" and scope_id and scope_id != "ALL":
        return f" WHERE use_case_id = {_literal(scope_id)}"
    if scope_type == "business_unit" and scope_id and scope_id != "ALL":
        return (
            f" WHERE use_case_id IN (SELECT use_case_id FROM {srv}.dim_use_case "
            f"WHERE org_unit_bk = {_literal(scope_id)})"
        )
    bu = kwargs.get("business_unit")
    if bu:
        return (
            f" WHERE use_case_id IN (SELECT use_case_id FROM {srv}.dim_use_case "
            f"WHERE org_unit_bk = {_literal(bu)})"
        )
    return ""


def invocations(cursor: int = 0, limit: int = 25, **kwargs) -> dict:
    srv = _schema()
    offset = max(int(cursor), 0)
    limit = min(max(int(limit), 1), 100)
    clause = _invocation_scope_clause(**kwargs)
    rows = query(f"""
        SELECT invocation_id, event_time, consumer_id, use_case_id, model_id, api_type,
               input_tokens, output_tokens, latency_ms, status_code, cost_usd, request_tags
        FROM {srv}.fact_invocation{clause}
        ORDER BY event_time DESC
        LIMIT {limit + 1} OFFSET {offset}""")
    items = rows[:limit]
    return {
        "items": [
            {
                **{k: r.get(k) for k in (
                    "invocation_id", "event_time", "consumer_id", "use_case_id",
                    "model_id", "api_type", "status_code",
                )},
                "input_tokens": _int(r.get("input_tokens")),
                "output_tokens": _int(r.get("output_tokens")),
                "latency_ms": _int(r.get("latency_ms")),
                "cost_usd": _num(r.get("cost_usd")),
                "request_tags": dict(
                    part.split("=", 1) for part in str(r.get("request_tags") or "").split(";")
                    if "=" in part
                ),
            }
            for r in items
        ],
        "next_cursor": (offset + limit) if len(rows) > limit else None,
    }


def provenance() -> dict:
    return provenance_status()


def provenance_status() -> dict:
    srv = _schema()
    results = _run_parallel({
        "freshness": f"SELECT MAX(month) AS max_event_date, COUNT(*) AS row_count FROM {srv}.fact_ai_daily",
        "coverage": f"""
            SELECT COUNT(DISTINCT org_unit_bk) AS business_units,
                   COUNT(DISTINCT use_case_id) AS use_cases,
                   SUM(CASE WHEN use_case_id IS NULL THEN run_cost_usd ELSE 0 END) AS unattributed_cost,
                   SUM(run_cost_usd) AS run_cost
            FROM {srv}.fact_ai_daily""",
        "rate": f"""
            SELECT model_id, name, provider, price_input_per_mtok,
                   price_output_per_mtok,
                   -- 10% of input: the most common cache-hit rate on these models.
                   price_input_per_mtok * 0.1 AS price_cached_in_per_mtok
            FROM {srv}.dim_model""",
        "reorg": f"SELECT org_unit_bk, name, effective_from, note FROM {srv}.dim_reorganisation",
        "as_of": f"SELECT MAX(effective_from) AS hierarchy_as_of FROM {srv}.dim_org_unit",
    })
    freshness = (results["freshness"] or [{}])[0]
    coverage = (results["coverage"] or [{}])[0]
    run_cost = _num(coverage.get("run_cost"))
    unattributed = _num(coverage.get("unattributed_cost"))
    return {
        "provider": "databricks_sql",
        "serving_schema": srv,
        "capabilities": ["value_ledger", "budgets", "invocation_grain", "metric_view"],
        "source_tables": [
            "fact_ai_daily", "fact_usage_daily", "fact_value_event",
            "fact_investment_event", "dim_use_case", "dim_allocation_policy",
        ],
        "freshness": {
            "max_event_date": _iso(freshness.get("max_event_date")),
            "max_event_time": _iso(freshness.get("max_event_date")),
            "row_count": _int(freshness.get("row_count")),
            "lag_seconds": 0,
            "degraded": False,
        },
        "coverage": {
            "business_units": _int(coverage.get("business_units")),
            "use_cases": _int(coverage.get("use_cases")),
            "unattributed_periods": 0,
        },
        "tagging_coverage": (1 - unattributed / run_cost) if run_cost else 1,
        "unattributed_cost": unattributed,
        "cost_model_version": "ai-roi-token-share-v1",
        "rate_card": [
            {
                "model_id": r.get("model_id"),
                "name": r.get("name"),
                "provider": r.get("provider"),
                "price_input_per_mtok": _num(r.get("price_input_per_mtok")),
                "price_in_per_mtok": _num(r.get("price_input_per_mtok")),
                "price_output_per_mtok": _num(r.get("price_output_per_mtok")),
                "price_out_per_mtok": _num(r.get("price_output_per_mtok")),
                "price_cached_in_per_mtok": _num(r.get("price_cached_in_per_mtok")),
            }
            for r in results["rate"]
        ],
        "hierarchy_as_of": _iso((results["as_of"] or [{}])[0].get("hierarchy_as_of")),
        "reorganised_units": [
            str(r.get("org_unit_bk"))
            for r in results["reorg"]
        ],
        "reorganised_unit_rows": [
            {
                "org_unit_bk": r.get("org_unit_bk"),
                "name": r.get("name"),
                "effective_from": _iso(r.get("effective_from")),
                "note": r.get("note"),
            }
            for r in results["reorg"]
        ],
        "native_assets": native_asset_links(),
    }


def provenance_metric(metric_id: str, **kwargs) -> dict:
    srv = _schema()
    rows = query(f"""
        SELECT metric_id, label, unit, definition, confidence_scope
        FROM {srv}.ai_roi_metric_registry
        WHERE metric_id = {_literal(metric_id)}""")
    if not rows and metric_id == "net_run_rate_value":
        rows = query(f"""
            SELECT metric_id, label, unit, definition, confidence_scope
            FROM {srv}.ai_roi_metric_registry
            WHERE metric_id = 'net_value'""")
    if not rows:
        return {"error": "not_found", "metric_id": metric_id}
    r = rows[0]
    mix = _confidence_mix(**kwargs)
    if not mix:
        scope_note = str(r.get("confidence_scope") or "all")
        if scope_note == "proven":
            mix = {"metered": 1.0, "attested": 0.0, "modelled": 0.0}
    where, start, end = filters(**kwargs)
    period = _period_sql(start, end, column="month")
    scope = _fact_scope_sql(
        kwargs.get("business_unit"), kwargs.get("use_case"), kwargs.get("market"),
        kwargs.get("scope_type"), kwargs.get("scope_id"),
    )
    row_count = _int((query(
        f"SELECT COUNT(*) AS n FROM {srv}.fact_ai_daily WHERE 1=1{period}{scope}"
    ) or [{}])[0].get("n"))
    label = r.get("label")
    formula = r.get("definition")
    if metric_id == "net_run_rate_value":
        label = "Net run-rate value"
        formula = "Realised value − run cost, expressed at a run-rate basis"
    return {
        "metric_id": metric_id,
        "label": label,
        "formula": formula,
        "unit": r.get("unit"),
        "inputs": ["fact_ai_daily", "mv_ai_roi"],
        "row_count": row_count,
        "confidence_mix": mix or {},
    }


def gateway_telemetry() -> dict:
    table = (AI_ROI_GATEWAY_TABLE or "").strip()
    if not table:
        return {"available": False, "reason": "Gateway telemetry is not configured."}
    if not _TABLE_RE.fullmatch(table):
        return {"available": False, "reason": "Gateway telemetry table is invalid."}
    try:
        head = query(f"""
            SELECT COUNT(DISTINCT usage_date) AS days,
                   MIN(usage_date) AS from_date, MAX(usage_date) AS to_date,
                   SUM(requests) AS requests, MAX(requester_count) AS peak_requesters,
                   SUM(input_tokens) + SUM(output_tokens) AS total_tokens,
                   SUM(failed_requests) AS failed_requests,
                   COUNT(DISTINCT destination_name) AS distinct_models,
                   MAX(built_at) AS built_at
            FROM {table}""")
        row = head[0] if head else {}
        if not row or not _int(row.get("days")):
            return {
                "available": False,
                "reason": "The gateway aggregate exists but is empty.",
                "table": table,
            }
        results = _run_parallel({
            "series": f"""
                SELECT usage_date, SUM(requests) AS requests,
                       SUM(input_tokens) + SUM(output_tokens) AS tokens,
                       SUM(failed_requests) AS failed,
                       MAX(requester_count) AS requesters
                FROM {table} GROUP BY usage_date ORDER BY usage_date""",
            "destinations": f"""
                SELECT destination_name, destination_type,
                       SUM(requests) AS requests,
                       SUM(input_tokens) + SUM(output_tokens) AS tokens,
                       AVG(p95_latency_ms) AS p95_latency_ms
                FROM {table} GROUP BY destination_name, destination_type
                ORDER BY requests DESC LIMIT 10""",
            "types": f"""
                SELECT destination_type, SUM(requests) AS requests,
                       SUM(input_tokens) + SUM(output_tokens) AS tokens
                FROM {table} GROUP BY destination_type ORDER BY requests DESC""",
        })
    except Exception as exc:  # noqa: BLE001
        return {
            "available": False,
            "reason": "Gateway telemetry is unavailable in this workspace.",
            "detail": str(exc)[:300],
            "table": table,
        }
    return {
        "available": True,
        "table": table,
        "source": "system.ai_gateway.usage",
        "freshness": "batch aggregate",
        "built_at": _iso(row.get("built_at")),
        "days": _int(row.get("days")),
        "from": _iso(row.get("from_date")),
        "to": _iso(row.get("to_date")),
        "requests": _int(row.get("requests")),
        "peak_requesters": _int(row.get("peak_requesters")),
        "total_tokens": _int(row.get("total_tokens")),
        "failed_requests": _int(row.get("failed_requests")),
        "distinct_models": _int(row.get("distinct_models")),
        "series": [
            {
                "usage_date": _iso(r.get("usage_date")),
                "requests": _int(r.get("requests")),
                "tokens": _int(r.get("tokens")),
                "failed": _int(r.get("failed")),
                "requesters": _int(r.get("requesters")),
            }
            for r in results["series"]
        ],
        "by_destination_type": [
            {
                "destination_type": r.get("destination_type"),
                "requests": _int(r.get("requests")),
                "tokens": _int(r.get("tokens")),
            }
            for r in results["types"]
        ],
        "top_destinations": [
            {
                "name": r.get("destination_name"),
                "destination_type": r.get("destination_type"),
                "requests": _int(r.get("requests")),
                "tokens": _int(r.get("tokens")),
                "p95_latency_ms": _optional_num(r.get("p95_latency_ms")),
            }
            for r in results["destinations"]
        ],
    }
