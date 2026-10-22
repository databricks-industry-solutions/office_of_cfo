"""AI ROI three-act API over the active industry's governed serving schema."""
# ruff: noqa: B008
from __future__ import annotations

from datetime import date
from typing import Literal

from fastapi import APIRouter, HTTPException, Query

from .. import ai_roi_queries as reads

router = APIRouter(prefix="/ai-roi", tags=["AI ROI"])

Dimension = Literal[
    "business_unit", "use_case", "market", "model", "environment", "org_unit", "consumer"
]
Confidence = Literal["all", "proven"]
Metric = Literal[
    "run_cost", "ai_run_cost", "fully_loaded_cost", "realised_value",
    "realised_value_all", "realised_value_proven", "profitability_index",
]
Grain = Literal["month", "quarter", "year", "day"]
_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$"


def _kwargs(
    from_date: date | None = None,
    to_date: date | None = None,
    period: str | None = None,
    business_unit: str | None = None,
    use_case: str | None = None,
    market: str | None = None,
    scope_type: str | None = None,
    scope_id: str | None = None,
) -> dict:
    return {
        "from_date": from_date, "to_date": to_date, "period": period,
        "business_unit": business_unit, "use_case": use_case, "market": market,
        "scope_type": scope_type, "scope_id": scope_id,
    }


@router.get("/executive")
def executive(
    from_date: date | None = Query(default=None),
    to_date: date | None = Query(default=None),
    period: str | None = Query(default=None),
    scope_type: str | None = Query(default=None),
    scope_id: str | None = Query(default=None, pattern=_ID_PATTERN),
):
    return reads.executive(**_kwargs(from_date, to_date, period, scope_type=scope_type, scope_id=scope_id))


@router.get("/spend")
def spend(
    dimension: Dimension = Query(default="business_unit"),
    from_date: date | None = Query(default=None),
    to_date: date | None = Query(default=None),
    period: str | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=100),
    scope_type: str | None = Query(default=None),
    scope_id: str | None = Query(default=None, pattern=_ID_PATTERN),
):
    return reads.spend(
        dimension=dimension, limit=limit,
        **_kwargs(from_date, to_date, period, scope_type=scope_type, scope_id=scope_id),
    )


@router.get("/metrics/summary")
def metrics_summary(
    from_date: date | None = Query(default=None),
    to_date: date | None = Query(default=None),
    period: str | None = Query(default=None),
    scope_type: str | None = Query(default=None),
    scope_id: str | None = Query(default=None, pattern=_ID_PATTERN),
):
    return reads.metrics_summary(**_kwargs(from_date, to_date, period, scope_type=scope_type, scope_id=scope_id))


@router.get("/metrics/timeseries")
def metrics_timeseries(
    metric: Metric = Query(default="ai_run_cost"),
    grain: Grain = Query(default="month"),
    group_by: Dimension | None = Query(default=None),
    from_date: date | None = Query(default=None),
    to_date: date | None = Query(default=None),
    period: str | None = Query(default=None),
    scope_type: str | None = Query(default=None),
    scope_id: str | None = Query(default=None, pattern=_ID_PATTERN),
):
    return reads.metrics_timeseries(
        metric=metric, grain=grain, group_by=group_by,
        **_kwargs(from_date, to_date, period, scope_type=scope_type, scope_id=scope_id),
    )


@router.get("/metrics/breakdown")
def metrics_breakdown(
    metric: Metric = Query(default="ai_run_cost"),
    group_by: Dimension = Query(default="business_unit"),
    sort: str = Query(default="value"),
    limit: int = Query(default=50, ge=1, le=100),
    from_date: date | None = Query(default=None),
    to_date: date | None = Query(default=None),
    period: str | None = Query(default=None),
    scope_type: str | None = Query(default=None),
    scope_id: str | None = Query(default=None, pattern=_ID_PATTERN),
):
    return reads.metrics_breakdown(
        metric=metric, group_by=group_by, sort=sort, limit=limit,
        **_kwargs(from_date, to_date, period, scope_type=scope_type, scope_id=scope_id),
    )


@router.get("/revenue-attribution")
def revenue_attribution(
    dimension: Dimension = Query(default="use_case"),
    confidence: Confidence = Query(default="all"),
    from_date: date | None = Query(default=None),
    to_date: date | None = Query(default=None),
    period: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
):
    return reads.revenue_attribution(
        dimension=dimension, confidence=confidence, limit=limit,
        **_kwargs(from_date, to_date, period),
    )


@router.get("/roi/league-table")
def league_table(
    ratio: str = Query(default="run_rate_rodt"),
    period: str | None = Query(default=None),
    scope_type: str | None = Query(default=None),
    scope_id: str | None = Query(default=None, pattern=_ID_PATTERN),
):
    return reads.league_table(ratio=ratio, period=period, scope_type=scope_type, scope_id=scope_id)


@router.get("/roi/breakeven")
def roi_breakeven(
    period: str | None = Query(default=None),
    market: str | None = Query(default=None, pattern=r"^[A-Za-z0-9][A-Za-z0-9,_.:/-]{0,255}$"),
    scope_type: str | None = Query(default=None),
    scope_id: str | None = Query(default=None, pattern=_ID_PATTERN),
):
    return reads.breakeven(period=period, market=market, scope_type=scope_type, scope_id=scope_id)


@router.get("/roi/use-case/{use_case_id}")
def roi_use_case(
    use_case_id: str,
    from_date: date | None = Query(default=None),
    to_date: date | None = Query(default=None),
    period: str | None = Query(default=None),
    scope_type: str | None = Query(default=None),
    scope_id: str | None = Query(default=None, pattern=_ID_PATTERN),
):
    out = reads.use_case_detail(
        use_case_id,
        **_kwargs(from_date, to_date, period, scope_type=scope_type, scope_id=scope_id),
    )
    if out.get("error") == "not_found":
        raise HTTPException(404, "Use case not found")
    return out


@router.get("/roi/use-case/{use_case_id}/events")
def roi_use_case_events(
    use_case_id: str,
    kind: Literal["value", "investment"] = "value",
    from_date: date | None = Query(default=None),
    to_date: date | None = Query(default=None),
    period: str | None = Query(default=None),
    scope_type: str | None = Query(default=None),
    scope_id: str | None = Query(default=None, pattern=_ID_PATTERN),
):
    return reads.use_case_events(
        use_case_id, kind,
        **_kwargs(from_date, to_date, period, scope_type=scope_type, scope_id=scope_id),
    )


@router.get("/profitability")
def profitability(
    dimension: Dimension = Query(default="business_unit"),
    from_date: date | None = Query(default=None),
    to_date: date | None = Query(default=None),
    period: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
    scope_type: str | None = Query(default=None),
    scope_id: str | None = Query(default=None, pattern=_ID_PATTERN),
):
    return reads.profitability(
        dimension=dimension, limit=limit,
        **_kwargs(from_date, to_date, period, scope_type=scope_type, scope_id=scope_id),
    )


@router.get("/timeseries")
def timeseries(
    metric: Metric = Query(default="run_cost"),
    grain: Grain = Query(default="month"),
    dimension: Dimension | None = Query(default=None),
    business_unit: str | None = Query(default=None, pattern=_ID_PATTERN),
    use_case: str | None = Query(default=None, pattern=_ID_PATTERN),
    market: str | None = Query(default=None, pattern=_ID_PATTERN),
    from_date: date | None = Query(default=None),
    to_date: date | None = Query(default=None),
):
    return reads.timeseries(
        metric=metric, grain=grain, dimension=dimension,
        **_kwargs(from_date, to_date, business_unit=business_unit, use_case=use_case, market=market),
    )


@router.get("/org")
def org(
    from_date: date | None = Query(default=None),
    to_date: date | None = Query(default=None),
    period: str | None = Query(default=None),
    scope_type: str | None = Query(default=None),
    scope_id: str | None = Query(default=None, pattern=_ID_PATTERN),
):
    return reads.org(**_kwargs(from_date, to_date, period, scope_type=scope_type, scope_id=scope_id))


@router.get("/org/detail")
def org_detail(
    from_date: date | None = Query(default=None),
    to_date: date | None = Query(default=None),
    period: str | None = Query(default=None),
    scope_type: str | None = Query(default=None),
    scope_id: str | None = Query(default=None, pattern=_ID_PATTERN),
):
    return reads.org_detail(**_kwargs(from_date, to_date, period, scope_type=scope_type, scope_id=scope_id))


@router.get("/budgets")
def budgets(period: str | None = Query(default=None), scope_type: str | None = Query(default=None),
            scope_id: str | None = Query(default=None, pattern=_ID_PATTERN)):
    return reads.budgets(period=period, scope_type=scope_type, scope_id=scope_id)


@router.get("/anomalies")
def anomalies(
    period: str | None = Query(default=None),
    scope_type: str | None = Query(default=None),
    scope_id: str | None = Query(default=None, pattern=_ID_PATTERN),
):
    return reads.anomalies(period=period, scope_type=scope_type, scope_id=scope_id)


@router.get("/invocations")
def invocations(
    cursor: int = Query(default=0, ge=0),
    limit: int = Query(default=25, ge=1, le=100),
    scope_type: str | None = Query(default=None),
    scope_id: str | None = Query(default=None, pattern=_ID_PATTERN),
):
    return reads.invocations(cursor=cursor, limit=limit, scope_type=scope_type, scope_id=scope_id)


@router.get("/efficiency")
def efficiency(
    from_date: date | None = Query(default=None),
    to_date: date | None = Query(default=None),
    period: str | None = Query(default=None),
    scope_type: str | None = Query(default=None),
    scope_id: str | None = Query(default=None, pattern=_ID_PATTERN),
):
    return reads.efficiency(**_kwargs(from_date, to_date, period, scope_type=scope_type, scope_id=scope_id))


@router.get("/efficiency/trend")
def efficiency_trend(period: str | None = Query(default=None)):
    return reads.efficiency_trend(period=period)


@router.get("/efficiency/models")
def efficiency_models(period: str | None = Query(default=None)):
    return reads.efficiency_models(period=period)


@router.get("/efficiency/waste")
def efficiency_waste(period: str | None = Query(default=None)):
    return reads.efficiency_waste(period=period)


@router.get("/provenance")
def provenance():
    return reads.provenance()


@router.get("/provenance/status")
def provenance_status():
    return reads.provenance_status()


@router.get("/provenance/metric/{metric_id}")
def provenance_metric(
    metric_id: str,
    from_date: date | None = Query(default=None),
    to_date: date | None = Query(default=None),
    period: str | None = Query(default=None),
    scope_type: str | None = Query(default=None),
    scope_id: str | None = Query(default=None, pattern=_ID_PATTERN),
):
    out = reads.provenance_metric(
        metric_id,
        **_kwargs(from_date, to_date, period, scope_type=scope_type, scope_id=scope_id),
    )
    if out.get("error") == "not_found":
        raise HTTPException(404, "Metric not found")
    return out


@router.get("/gateway/telemetry")
def gateway_telemetry():
    return reads.gateway_telemetry()


@router.get("/native-assets")
def native_assets():
    return {"links": reads.native_asset_links()}
