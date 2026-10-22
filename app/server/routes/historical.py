"""Historical Insights API — powers the two FP&A sub-tabs.

  - GET  /periods                       available periods (feeds the period picker)
  - GET  /historical-insights           per-scope KPI time series + computed callouts
                                        (MoM, best/worst area, above/below trailing avg)
  - GET  /payment-behavior              counterparty scorecard (AR / AP)
  - GET  /payment-behavior/anomalies    counterparties off their own historical norm
  - POST /historical-insights/narrative AI "story of the month" from the metrics

Everything is scope-aware (shared scope_clause) and degrades gracefully when an
industry has only a single period (no history yet) so the un-seeded industries
keep working during the energy-first rollout.
"""
from __future__ import annotations

import calendar
import os
import statistics

from fastapi import APIRouter, Query
from pydantic import BaseModel

from ..config import CLOSE_PERIOD, SRV_FQ, current_industry, resolve_period
from ..personas import scope_clause
from ..versioned_cache import VersionedTTLCache
from ..warehouse import cache_version, query

router = APIRouter()

SRV = SRV_FQ

_METRICS = ("ccc", "dso", "dpo", "dio", "revenue", "opex", "net_income")
# lower-is-better metrics (worse = higher); the rest are higher-is-better.
_LOWER_BETTER = {"ccc", "dso", "dio", "opex"}

_PAY_COLS = {
    "region": "region",
    "legal_entity": "legal_entity_id",
    "business_unit": "business_unit_id",
    "business_line": "business_line",
}

_NOTE_MODEL = "databricks-claude-sonnet-4-5"
_AI_RESPONSE_TTL = float(os.environ.get("AI_RESPONSE_CACHE_TTL", "3600"))
_narrative_cache = VersionedTTLCache[dict](_AI_RESPONSE_TTL, cache_version)


def _num(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _q(s: str) -> str:
    return "'" + str(s).replace("'", "''") + "'"


def _period_end(period: str) -> str:
    y, m = int(period[:4]), int(period[5:7])
    return f"{y:04d}-{m:02d}-{calendar.monthrange(y, m)[1]:02d}"


def _history_key(scope_type: str, scope_id: str) -> tuple[str, str]:
    if not scope_type or scope_type == "consolidated":
        return "consolidated", "ALL"
    return scope_type, scope_id


# ---------------------------------------------------------------------------
# Periods
# ---------------------------------------------------------------------------
@router.get("/periods")
def periods():
    """Available periods for the picker (newest first), plus the active close.
    Falls back to distinct kpi_history periods if v_periods is absent."""
    rows: list[dict] = []
    try:
        rows = query(
            f"SELECT period, month_label, year, month, quarter, days_in_period, is_active_close "
            f"FROM {SRV}.v_periods ORDER BY period DESC")
    except Exception:  # noqa: BLE001
        try:
            rows = query(f"SELECT DISTINCT period FROM {SRV}.kpi_history ORDER BY period DESC")
        except Exception:  # noqa: BLE001
            rows = []
    # The SQL Statement Execution API returns every column as a string, so
    # is_active_close arrives as "true"/"false" — and the string "false" is
    # truthy in JS, which tagged *every* month "current" in the period picker.
    # Coerce to a real bool so the API contract (PeriodInfo.is_active_close)
    # holds and only the active close is flagged.
    for r in rows:
        if "is_active_close" in r:
            r["is_active_close"] = str(r["is_active_close"]).strip().lower() == "true"
    return {"active": CLOSE_PERIOD, "periods": rows}


# ---------------------------------------------------------------------------
# Historical insights (KPI trends + callouts + area leaderboard)
# ---------------------------------------------------------------------------
def _stats(prev_values: list[float]) -> tuple[float, float]:
    if not prev_values:
        return 0.0, 0.0
    mean = statistics.fmean(prev_values)
    std = statistics.pstdev(prev_values) if len(prev_values) > 1 else 0.0
    return mean, std


def _series_callouts(series: list[dict], metric: str, period: str) -> dict:
    """MoM, YoY and above/below trailing-average (z-score) for one scope series."""
    ordered = sorted(series, key=lambda r: r["period"])
    idx = next((i for i, r in enumerate(ordered) if r["period"] == period), len(ordered) - 1)
    if idx < 0 or not ordered:
        return {}
    cur = _num(ordered[idx].get(metric))
    prev = _num(ordered[idx - 1].get(metric)) if idx >= 1 else None
    mom = (cur - prev) if prev is not None else None
    mom_pct = (mom / prev * 100.0) if (prev not in (None, 0)) else None
    yoy = None
    if idx >= 12:
        py = _num(ordered[idx - 12].get(metric))
        yoy = (cur - py) if py else None
    trailing = [_num(r.get(metric)) for r in ordered[max(0, idx - 12):idx]]
    mean, std = _stats(trailing)
    z = (cur - mean) / std if std else 0.0
    lower_better = metric in _LOWER_BETTER
    # "above normal" = worse-than-usual for lower-is-better metrics
    above = z > 0
    return {
        "current": round(cur, 2),
        "prev": None if prev is None else round(prev, 2),
        "mom": None if mom is None else round(mom, 2),
        "mom_pct": None if mom_pct is None else round(mom_pct, 1),
        "yoy": None if yoy is None else round(yoy, 2),
        "trailing_avg": round(mean, 2),
        "trailing_std": round(std, 2),
        "zscore": round(z, 2),
        "above_normal": above,
        "outlier": abs(z) >= 2,
        "good_direction": "lower" if lower_better else "higher",
    }


@router.get("/historical-insights")
def historical_insights(
    scope_type: str = Query("consolidated"),
    scope_id: str = Query("ALL"),
    metric: str = Query("ccc"),
    dimension: str = Query("region"),
    period: str = Query(None),
):
    p = resolve_period(period)
    metric = metric if metric in _METRICS else "ccc"
    st, sid = _history_key(scope_type, scope_id)
    try:
        rows = query(
            f"SELECT period, scope_type, scope_id, scope_label, dso, dpo, dio, ccc, "
            f"revenue, opex, net_income FROM {SRV}.kpi_history")
    except Exception:  # noqa: BLE001
        return {"period": p, "metric": metric, "series": [], "callouts": {},
                "leaderboard": {"dimension": dimension, "areas": []}}

    def _cast(r):
        return {k: (_num(r.get(k)) if k not in ("period", "scope_type", "scope_id", "scope_label")
                    else r.get(k)) for k in
                ("period", "scope_type", "scope_id", "scope_label",
                 "dso", "dpo", "dio", "ccc", "revenue", "opex", "net_income")}

    all_rows = [_cast(r) for r in rows]
    # selected-scope series (for the trend/control-band/CCC/seasonality visuals)
    series = sorted([r for r in all_rows if r["scope_type"] == st and r["scope_id"] == sid],
                    key=lambda r: r["period"])
    callouts = _series_callouts(series, metric, p) if series else {}

    # area leaderboard: every scope of `dimension`, ranked by MoM + vs-average.
    areas = []
    dim_rows = [r for r in all_rows if r["scope_type"] == dimension]
    by_scope: dict[str, list[dict]] = {}
    for r in dim_rows:
        by_scope.setdefault(r["scope_id"], []).append(r)
    for sc, srows in by_scope.items():
        c = _series_callouts(srows, metric, p)
        if not c:
            continue
        label = next((x["scope_label"] for x in srows), sc)
        areas.append({
            "scope_id": sc, "scope_label": label,
            "current": c["current"], "prev": c["prev"],
            "mom": c["mom"], "mom_pct": c["mom_pct"],
            "vs_avg": round(c["current"] - c["trailing_avg"], 2),
            "zscore": c["zscore"],
        })
    lower_better = metric in _LOWER_BETTER
    # worst first: for lower-is-better a positive MoM is worst; invert otherwise.
    areas.sort(key=lambda a: (a["mom"] if a["mom"] is not None else 0),
               reverse=not lower_better)
    return {
        "period": p, "metric": metric,
        "scope_type": scope_type, "scope_id": scope_id,
        "series": series, "callouts": callouts,
        "leaderboard": {"dimension": dimension, "areas": areas},
    }


# ---------------------------------------------------------------------------
# Payment behaviour — scorecard + anomalies
# ---------------------------------------------------------------------------
def _category(avg_dvt: float) -> str:
    if avg_dvt <= -2:
        return "early"
    if avg_dvt <= 3:
        return "prompt"
    return "late"


def _pay_rows(ledger: str, scope_type: str, scope_id: str):
    led = "ap" if ledger == "ap" else "ar"
    where = f" WHERE ledger = '{led}'" + scope_clause(scope_type, scope_id, _PAY_COLS, prefix=" AND ")
    return query(
        f"SELECT counterparty, period, amount, payment_terms, due_date, paid_date, "
        f"days_to_pay, days_vs_terms, on_time, status "
        f"FROM {SRV}.v_payment_behavior{where}"), led


@router.get("/payment-behavior")
def payment_behavior(
    ledger: str = Query("ar"),
    scope_type: str = Query("consolidated"),
    scope_id: str = Query("ALL"),
    period: str = Query(None),
    limit: int = Query(25),
):
    """Counterparty scorecard: baseline avg days-vs-terms, on-time %, invoice
    count/amount and a per-period trend sparkline, through the selected period."""
    p = resolve_period(period)
    try:
        rows, led = _pay_rows(ledger, scope_type, scope_id)
    except Exception:  # noqa: BLE001
        return {"period": p, "ledger": ledger, "counterparties": []}

    by_cp: dict[str, dict] = {}
    trend: dict[str, dict[str, list[float]]] = {}
    for r in rows:
        if r.get("period", "") > p:
            continue
        cp = r["counterparty"]
        d = by_cp.setdefault(cp, {
            "counterparty": cp, "terms": r.get("payment_terms"),
            "invoices": 0, "amount": 0.0, "dvts": [], "on_time": 0, "paid": 0,
            "overdue_open": 0, "overdue_amount": 0.0})
        d["invoices"] += 1
        d["amount"] += _num(r.get("amount"))
        dvt = r.get("days_vs_terms")
        if dvt is not None and r.get("paid_date"):
            d["dvts"].append(_num(dvt))
            d["paid"] += 1
            # The SQL API returns booleans as the STRING "true"/"false", so a bare
            # truthiness check treats "false" as on-time. Compare on days-vs-terms
            # directly (paid on or before the due date) to be type-agnostic.
            if _num(dvt) <= 0:
                d["on_time"] += 1
            trend.setdefault(cp, {}).setdefault(r["period"], []).append(_num(dvt))
        elif not r.get("paid_date") and (r.get("due_date") or "") <= _period_end(p):
            d["overdue_open"] += 1
            d["overdue_amount"] += _num(r.get("amount"))

    out = []
    for cp, d in by_cp.items():
        avg_dvt = statistics.fmean(d["dvts"]) if d["dvts"] else 0.0
        on_time_pct = (100.0 * d["on_time"] / d["paid"]) if d["paid"] else 0.0
        spark = [round(statistics.fmean(v), 1) for _per, v in sorted(trend.get(cp, {}).items())]
        out.append({
            "counterparty": cp,
            "terms": d["terms"],
            "invoices": d["invoices"],
            "amount": round(d["amount"], 2),
            "avg_days_vs_terms": round(avg_dvt, 1),
            "on_time_pct": round(on_time_pct, 1),
            "category": _category(avg_dvt),
            "overdue_open": d["overdue_open"],
            "overdue_amount": round(d["overdue_amount"], 2),
            "trend": spark,
        })
    # worst payers first (largest positive days-vs-terms = latest)
    out.sort(key=lambda c: c["avg_days_vs_terms"], reverse=True)
    return {"period": p, "ledger": led, "counterparties": out[:max(1, limit)]}


@router.get("/payment-behavior/anomalies")
def payment_anomalies(
    ledger: str = Query("ar"),
    scope_type: str = Query("consolidated"),
    scope_id: str = Query("ALL"),
    period: str = Query(None),
):
    """Counterparties deviating from their OWN historical norm as of the selected
    period: a normally-prompt payer now overdue, or a paid invoice whose timing is
    a >=2-sigma outlier vs the counterparty's baseline."""
    p = resolve_period(period)
    end = _period_end(p)
    try:
        rows, led = _pay_rows(ledger, scope_type, scope_id)
    except Exception:  # noqa: BLE001
        return {"period": p, "ledger": ledger, "anomalies": []}

    # baseline (paid invoices strictly before the selected period)
    base: dict[str, list[float]] = {}
    for r in rows:
        if r.get("paid_date") and r.get("days_vs_terms") is not None and r.get("period", "") < p:
            base.setdefault(r["counterparty"], []).append(_num(r["days_vs_terms"]))

    anomalies = []
    seen_overdue: dict[str, dict] = {}
    for r in rows:
        cp = r["counterparty"]
        hist = base.get(cp, [])
        mean, std = _stats(hist)
        cat = _category(mean) if hist else "prompt"
        # 1. overdue opens (any period, unpaid, past due as of the close)
        if not r.get("paid_date") and (r.get("due_date") or "") <= end:
            agg = seen_overdue.setdefault(cp, {"amount": 0.0, "count": 0, "worst_due": None})
            agg["amount"] += _num(r.get("amount"))
            agg["count"] += 1
            if agg["worst_due"] is None or (r.get("due_date") or "") < agg["worst_due"]:
                agg["worst_due"] = r.get("due_date")
        # 2. paid this period but a timing outlier vs the counterparty's norm
        elif r.get("paid_date") and r.get("period") == p and r.get("days_vs_terms") is not None and std:
            z = (_num(r["days_vs_terms"]) - mean) / std
            if abs(z) >= 2:
                direction = "late" if z > 0 else "early"
                anomalies.append({
                    "counterparty": cp, "type": "timing_outlier", "direction": direction,
                    "invoice_id": None, "amount": round(_num(r.get("amount")), 2),
                    "days_vs_terms": round(_num(r["days_vs_terms"]), 1),
                    "baseline_avg": round(mean, 1), "zscore": round(z, 1), "category": cat,
                    "detail": (f"{cp} paid {abs(round(_num(r['days_vs_terms']) - mean))} days "
                               f"{'later' if z > 0 else 'earlier'} than usual "
                               f"(normally {_category(mean)})"),
                })

    for cp, agg in seen_overdue.items():
        mean, _std = _stats(base.get(cp, []))
        cat = _category(mean) if base.get(cp) else "prompt"
        anomalies.append({
            "counterparty": cp, "type": "overdue", "direction": "late",
            "amount": round(agg["amount"], 2), "count": agg["count"],
            "worst_due": agg["worst_due"], "baseline_avg": round(mean, 1), "category": cat,
            "detail": (f"{cp} (usually {cat}) has {agg['count']} invoice(s) totalling "
                       f"{agg['amount']:,.0f} unpaid past due — expected paid by now"),
        })

    # surprising if a normally early/prompt counterparty is the one now overdue
    def _severity(a):
        base_sev = a.get("amount", 0.0)
        surprise = 2.0 if a.get("category") in ("early", "prompt") else 1.0
        kind = 1.5 if a["type"] == "overdue" else 1.0
        return base_sev * surprise * kind

    anomalies.sort(key=_severity, reverse=True)
    return {"period": p, "ledger": led, "anomalies": anomalies[:20]}


# ---------------------------------------------------------------------------
# AI narrative
# ---------------------------------------------------------------------------
class NarrativeIn(BaseModel):
    scope_type: str = "consolidated"
    scope_id: str = "ALL"
    metric: str = "ccc"
    period: str = CLOSE_PERIOD


def _ai_note(prompt: str) -> str | None:
    """One-shot ai_query on the warehouse (same pattern as the competitor note)."""
    from ..config import WAREHOUSE_ID, get_workspace_client
    try:
        w = get_workspace_client()
        resp = w.statement_execution.execute_statement(
            statement=f"SELECT ai_query({_q(_NOTE_MODEL)}, {_q(prompt)})",
            warehouse_id=WAREHOUSE_ID, wait_timeout="50s")
        import time
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


def _compute_historical_narrative(body: NarrativeIn):
    """Grounded 'story of the month vs history' from the computed metrics. Best
    effort: returns available=False if the serving model is unreachable so the tab
    degrades to computed-only."""
    p = resolve_period(body.period)
    insights = historical_insights(
        scope_type=body.scope_type, scope_id=body.scope_id, metric=body.metric,
        dimension="region", period=p)
    c = insights.get("callouts") or {}
    areas = (insights.get("leaderboard") or {}).get("areas") or []
    worst = areas[0] if areas else None
    best = areas[-1] if areas else None
    try:
        anoms = payment_anomalies(ledger="ar", scope_type=body.scope_type,
                                  scope_id=body.scope_id, period=p).get("anomalies", [])
    except Exception:  # noqa: BLE001
        anoms = []

    facts = [f"Period {p}. Metric {body.metric.upper()}."]
    if c:
        facts.append(f"Current {c.get('current')}, prior {c.get('prev')}, "
                     f"MoM {c.get('mom')} ({c.get('mom_pct')}%), "
                     f"trailing avg {c.get('trailing_avg')} (z={c.get('zscore')}, "
                     f"{'above' if c.get('above_normal') else 'below'} normal).")
    if worst:
        facts.append(f"Worst area: {worst['scope_label']} (MoM {worst['mom']}).")
    if best:
        facts.append(f"Best area: {best['scope_label']} (MoM {best['mom']}).")
    if anoms:
        facts.append("Payment anomalies: " + "; ".join(a["detail"] for a in anoms[:3]) + ".")

    prompt = (
        "You are a CFO's FP&A analyst. In 3 short sentences (max 70 words total), "
        "tell the story of this month versus its history using ONLY these facts. "
        "Lead with the most material change. No preamble, no markdown, no bullet points.\n\n"
        + " ".join(facts))
    note = _ai_note(prompt)
    return {
        "period": p, "available": note is not None,
        "narrative": note or "AI narrative unavailable — see the metrics and callouts above.",
        "facts": facts,
    }


@router.post("/historical-insights/narrative")
def historical_narrative(body: NarrativeIn):
    """Serve the grounded narrative from a versioned one-hour cache."""
    key = (
        current_industry(), body.scope_type, body.scope_id, body.metric, body.period,
    )
    return _narrative_cache.get_or_compute(
        key,
        lambda: _compute_historical_narrative(body),
        cache_when=lambda result: bool(result.get("available")),
    )
