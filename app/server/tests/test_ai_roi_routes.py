"""AI ROI route/query contract tests; no warehouse connection required."""
from __future__ import annotations

import pathlib
import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

_APP = pathlib.Path(__file__).resolve().parents[2]
if str(_APP) not in sys.path:
    sys.path.insert(0, str(_APP))

from server import ai_roi_queries as reads  # noqa: E402
from server.config import set_current_industry  # noqa: E402
from server.routes import ai_roi  # noqa: E402


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(ai_roi.router, prefix="/api")
    return TestClient(app)


def test_router_exposes_complete_ai_roi_surface():
    from app import app

    paths = set(app.openapi()["paths"])
    assert {
        "/api/ai-roi/executive",
        "/api/ai-roi/spend",
        "/api/ai-roi/revenue-attribution",
        "/api/ai-roi/profitability",
        "/api/ai-roi/timeseries",
        "/api/ai-roi/org",
        "/api/ai-roi/efficiency",
        "/api/ai-roi/provenance",
        "/api/ai-roi/gateway/telemetry",
        "/api/ai-roi/native-assets",
    } <= paths


def test_revenue_market_dimension_uses_active_industry_schema(monkeypatch):
    captured: list[str] = []

    def fake_query(sql: str):
        captured.append(sql)
        return [{
            "key": "Retail",
            "label": "Retail",
            "attributed_revenue": "125.5",
            "proven_revenue": "100",
            "modelled_revenue": "25.5",
        }]

    monkeypatch.setattr(reads, "query", fake_query)
    set_current_industry("energy")
    out = reads.revenue_attribution("market", "all")

    assert "office_of_cfo.energy_serving.mv_ai_roi" in captured[0]
    assert "`Market`" in captured[0]
    assert out == {
        "dimension": "market",
        "confidence": "all",
        "rows": [{
            "key": "Retail",
            "label": "Retail",
            "attributed_revenue": 125.5,
            "proven_revenue": 100.0,
            "modelled_revenue": 25.5,
            "share": 1.0,
        }],
    }


def test_profitability_has_one_point_zero_threshold_confidence_and_policy(monkeypatch):
    def fake_query(sql: str):
        if "dim_allocation_policy" in sql:
            return [{
                "allocation_policy_id": "alloc-1",
                "policy_name": "Token share",
                "basis": "token_share",
                "owner_role": "CFO",
                "rule": "Allocate shared build by token share",
                "signed_off_on": "2026-01-01",
                "review_due_on": "2027-01-01",
            }]
        return [
            {
                "key": "BU-100", "label": "BU-100", "run_cost": 10,
                "amortised_build": 2, "allocated_build": 3,
                "fully_loaded_cost": 15, "realised_value_all": 12,
                "realised_value_proven": 9, "pi_all": 0.8, "pi_proven": 0.6,
            },
            {
                "key": "BU-200", "label": "BU-200", "run_cost": 10,
                "amortised_build": 2, "allocated_build": 3,
                "fully_loaded_cost": 15, "realised_value_all": 30,
                "realised_value_proven": 18, "pi_all": 2.0, "pi_proven": 1.2,
            },
        ]

    monkeypatch.setattr(reads, "query", fake_query)
    out = reads.profitability("business_unit")

    assert out["break_even_at"] == 1.0
    assert out["period_basis"] == "programme"
    assert out["below_break_even"] == 1
    assert out["below_break_even_proven"] == 1
    assert out["allocation_policy"]["basis"] == "token_share"
    assert out["rows"][0]["pi_all"] == 0.8
    assert out["rows"][0]["pi_proven"] == 0.6


def test_executive_shapes_parallel_reads(monkeypatch):
    def fake_query(sql: str):
        if "DISTINCT market" in sql:
            return [{"market": "AMER"}, {"market": "EMEA"}]
        if "ORDER BY profitability_index" in sql:
            return [{"key": "BU-100", "profitability_index": "0.8",
                     "profitability_index_proven": "0.6"}]
        if "GROUP BY `Month`" in sql or "GROUP BY `Use Case`" in sql:
            if "`Use Case`" in sql and "GROUP BY `Month`" not in sql:
                return [{"key": "demand-forecast", "value": 10}]
            return [{
                "month": "2026-01-01", "run_cost": 10, "realised_value_all": 15,
                "fully_loaded_cost": 12,
            }]
        return [{
            "run_cost": 10, "fully_loaded_cost": 12,
            "realised_value_all": 18, "realised_value_proven": 15,
            "tokens": 1000, "requests": 20, "net_value": 6,
            "profitability_index": 1.5, "profitability_index_proven": 1.25,
        }]

    monkeypatch.setattr(reads, "query", fake_query)
    monkeypatch.setattr(reads, "AI_ROI_DASHBOARD_URL", "https://example/dashboard")
    out = reads.executive()

    assert out["summary"]["profitability_index"] == 1.5
    assert out["summary"]["programme_rodt"] == 0.5
    assert out["exception"]["key"] == "BU-100"
    assert out["native_assets"] == {"dashboard": "https://example/dashboard"}


def test_league_table_matches_reference_row_contract(monkeypatch):
    def fake_query(sql: str):
        if "GROUP BY `Use Case`, `Month`" in sql:
            return [
                {
                    "use_case_id": "claims",
                    "month": "2026-01-01",
                    "run_cost": 10,
                    "realised_value_all": 5,
                    "fully_loaded_cost": 12,
                },
                {
                    "use_case_id": "claims",
                    "month": "2026-02-01",
                    "run_cost": 10,
                    "realised_value_all": 30,
                    "fully_loaded_cost": 12,
                },
            ]
        return [{
            "use_case_id": "claims", "name": "Claims Copilot",
            "org_unit_bk": "BU-100", "status": "active",
            "run_cost": 20, "realised_value_all": 35,
            "realised_value_proven": 28, "revenue_per_mtok": 3.5,
        }]

    monkeypatch.setattr(reads, "query", fake_query)
    row = reads.league_table()["rows"][0]

    assert row["cash_breakeven_month"] == 2
    assert row["cash_breakeven_days"] == 60
    assert row["variance"] == 0
    assert row["confidence_mix"] == {
        "metered_attested": 0.8,
        "modelled": 0.2,
    }
    assert row["rodt_trend"] == [-0.5, 2.0]


def test_org_shapes_flat_rows_into_tree(monkeypatch):
    monkeypatch.setattr(reads, "query", lambda sql: (
        [{"hierarchy_as_of": "2025-01-01"}] if "hierarchy_as_of" in sql else [
            {"key": "ROOT", "name": "Company", "parent_bk": None, "level": 0,
             "run_cost": 0, "realised_value": 0},
            {"key": "BU-100", "name": "Consumer", "parent_bk": "ROOT", "level": 1,
             "run_cost": 10, "realised_value": 25},
        ]
    ))
    out = reads.org()
    root = out["tree"][0]
    assert out["node_count"] == 2
    assert root["children"][0]["key"] == "BU-100"
    assert root["ai_run_cost"] == 10
    assert root["run_rate_rodt"] == 1.5


def test_org_tree_ignores_selected_unit(monkeypatch):
    calls: list[str] = []
    monkeypatch.setattr(reads, "query", lambda sql: calls.append(sql) or [])
    reads.org(scope_type="business_unit", scope_id="BU-200", period="2026-06")
    tree_sql = next(sql for sql in calls if "dim_org_unit o" in sql)
    assert "BU-200" not in tree_sql
    assert "2026-06-01" in tree_sql


def test_org_detail_returns_children_and_consumers(monkeypatch):
    calls: list[str] = []

    def fake_query(sql: str):
        calls.append(sql)
        if "dim_org_unit c" in sql and "parent_bk" in sql:
            return [{"key": "BU-100", "label": "Consumer", "value": "10"}]
        if "FROM direct d" in sql and "roi.month" in sql:
            return [{"grp": "BU-100", "label": "Consumer", "month": "2026-01-01", "run_cost": 4}]
        if "FROM direct d" in sql:
            return [{"key": "BU-100", "label": "Consumer", "value": "10"}]
        if "fact_invocation" in sql:
            return [{"key": "svc-a", "value": "4"}]
        if "SELECT name FROM" in sql and "org_unit_bk" in sql:
            return [{"name": "Company"}]
        if "value_metered_usd" in sql:
            return [{"metered": 10, "attested": 0, "modelled": 0}]
        if "GROUP BY `Month`" in sql:
            return [{"month": "2026-01-01", "run_cost": 10, "realised_value_all": 15,
                     "fully_loaded_cost": 12}]
        return [{
            "run_cost": 10, "fully_loaded_cost": 12, "realised_value_all": 15,
            "realised_value_proven": 12, "net_value": 3, "tokens": 100, "requests": 5,
        }]

    monkeypatch.setattr(reads, "query", fake_query)
    out = reads.org_detail(scope_type="business_unit", scope_id="ROOT")
    assert out["scope_label"] == "Company"
    assert out["children"][0]["key"] == "BU-100"
    assert out["consumers"][0]["key"] == "svc-a"
    assert out["spend_trend"][0]["group"] == "Total"
    assert any(row.get("group") == "Consumer" for row in out["spend_trend"])
    assert out["summary"]["run_rate_rodt"] == 0.5


def test_provenance_metric_returns_structured_confidence_mix(monkeypatch):
    def fake_query(sql: str):
        if "ai_roi_metric_registry" in sql:
            return [{
                "metric_id": "run_rate_rodt",
                "label": "Run-rate RODT",
                "unit": "ratio",
                "definition": "Net / run cost",
                "confidence_scope": "all",
            }]
        if "value_metered_usd" in sql:
            return [{"metered": 60, "attested": 30, "modelled": 10}]
        if "COUNT(*)" in sql:
            return [{"n": 42}]
        return []

    monkeypatch.setattr(reads, "query", fake_query)
    out = reads.provenance_metric("run_rate_rodt")
    assert out["confidence_mix"] == {"metered": 0.6, "attested": 0.3, "modelled": 0.1}
    assert out["row_count"] == 42


def test_efficiency_models_include_cost_per_request(monkeypatch):
    def fake_query(sql: str):
        if "JOIN" in sql and "dim_model" in sql:
            return [{
                "model_id": "m1", "name": "Model", "tier": "standard",
                "run_cost": 100, "tokens": 1_000_000, "requests": 50,
            }]
        if "cached_read_tokens" in sql:
            return [{
                "run_cost": 100, "cached_tokens": 100_000, "billable_tokens": 1_000_000,
                "retried_requests": 0, "failed_requests": 0,
            }]
        if "DATE_TRUNC" in sql:
            return [{"period": "2026-01-01", "run_cost": 100, "tokens": 1_000_000}]
        return []

    monkeypatch.setattr(reads, "query", fake_query)
    out = reads.efficiency()
    assert out["models"][0]["cost_per_request"] == 2.0
    assert out["waste"]["token_efficiency_ratio"] == 0.1


def test_efficiency_trend_is_not_clipped_to_close_period(monkeypatch):
    seen: list[str] = []

    def fake_query(sql: str):
        seen.append(sql)
        if "JOIN" in sql and "dim_model" in sql:
            return [{
                "model_id": "m1", "name": "Model", "tier": "standard",
                "run_cost": 100, "tokens": 1_000_000, "requests": 50,
            }]
        if "cached_read_tokens" in sql:
            return [{
                "run_cost": 100, "cached_tokens": 100_000, "billable_tokens": 1_000_000,
                "retried_requests": 0, "failed_requests": 0,
            }]
        if "DATE_TRUNC" in sql:
            return [{"period": "2026-09-01", "run_cost": 100, "tokens": 1_000_000}]
        return []

    monkeypatch.setattr(reads, "query", fake_query)
    reads.efficiency(period="2026-06")
    trend_sql = next(sql for sql in seen if "DATE_TRUNC" in sql)
    assert "2026-06" not in trend_sql
    assert "2025-07" not in trend_sql


@pytest.mark.parametrize("path", [
    "/api/ai-roi/timeseries?dimension=not_a_dimension",
    "/api/ai-roi/spend?dimension=business_unit&limit=101",
    "/api/ai-roi/timeseries?business_unit=x%27%20OR%201%3D1",
])
def test_route_allowlists_reject_invalid_query_values(path):
    response = _client().get(path)
    assert response.status_code == 422


def test_optional_gateway_degrades_but_core_errors_remain_visible(monkeypatch):
    monkeypatch.setattr(reads, "AI_ROI_GATEWAY_TABLE", None)
    assert reads.gateway_telemetry() == {
        "available": False,
        "reason": "Gateway telemetry is not configured.",
    }

    def fail(_sql: str):
        raise RuntimeError("warehouse unavailable")

    monkeypatch.setattr(reads, "query", fail)
    with pytest.raises(RuntimeError, match="warehouse unavailable"):
        reads.spend("business_unit")


def test_metrics_breakdown_includes_prior_period_delta(monkeypatch):
    call = {"n": 0}

    def fake_query(_sql: str):
        call["n"] += 1
        value = "100" if call["n"] == 1 else "40"
        return [{"key": "uc-1", "label": "Claims", "value": value}]

    monkeypatch.setattr(reads, "query", fake_query)
    out = reads.metrics_breakdown(
        "ai_run_cost", "use_case", period="2026-01",
        scope_type="consolidated", scope_id="ALL",
    )
    assert out["rows"][0]["value"] == 100
    assert out["rows"][0]["delta"] == 60
    assert call["n"] == 2


def test_anomalies_use_trailing_28d_z_threshold(monkeypatch):
    captured: list[str] = []

    def fake_query(sql: str):
        captured.append(sql)
        rows = []
        for day in range(1, 29):
            rows.append({
                "org_unit_bk": "BU-100",
                "usage_date": f"2026-01-{day:02d}",
                "cost_usd": "100",
            })
        rows.append({
            "org_unit_bk": "BU-100",
            "usage_date": "2026-01-29",
            "cost_usd": "5000",
        })
        return rows

    monkeypatch.setattr(reads, "query", fake_query)
    out = reads.anomalies(period="2026-01")
    assert "INTERVAL 28" in captured[0]
    assert out["anomalies"]
    assert all(abs(a["z"]) > 3 for a in out["anomalies"])
    assert all(a["cost_usd"] > 500 for a in out["anomalies"])


def test_budget_variance_sign_matches_actual_minus_prorated(monkeypatch):
    def fake_query(sql: str):
        if "fact_budget" in sql:
            return [{"budget_usd": "1200000"}]
        return [{"actual": "70000"}]

    monkeypatch.setattr(reads, "query", fake_query)
    out = reads.budgets(
        period="2026-01",
        scope_type="business_unit",
        scope_id="BU-100",
    )
    b = out["budget_variance"]
    assert b["variance_usd"] == b["actual_usd"] - b["prorated_budget_usd"]


def test_invocations_scope_filters_use_case(monkeypatch):
    captured: list[str] = []

    def fake_query(sql: str):
        captured.append(sql)
        return []

    monkeypatch.setattr(reads, "query", fake_query)
    reads.invocations(0, 25, scope_type="use_case", scope_id="uc-claims")
    assert "use_case_id = 'uc-claims'" in captured[0]


def test_use_case_detail_exposes_reference_summary_and_attribution_policy(monkeypatch):
    calls: list[str] = []

    def fake_query(sql: str):
        calls.append(sql)
        if "dim_use_case" in sql and "attribution_policy_id" in sql:
            return [{
                "use_case_id": "claims",
                "name": "Claims Copilot",
                "org_unit_bk": "BU-100",
                "category": "Customer",
                "status": "active",
                "launched_on": "2025-01-15",
                "attribution_policy_id": "attr-1",
            }]
        if "dim_attribution_policy" in sql:
            return [{
                "attribution_policy_id": "attr-1",
                "policy_name": "Revenue attribution — attested uplift",
                "owner_role": "Business Value Owner",
                "rule": "Attribute uplift only above a signed baseline.",
                "method": "attested_uplift",
                "signed_off_on": "2026-01-10",
                "review_due_on": "2027-01-10",
            }]
        if "fact_value_event" in sql:
            return [{"category": "revenue_attributed", "amount_usd": "12000"}]
        if "GROUP BY `Month`" in sql:
            return [
                {"month": "2026-01-01", "run_cost": 10, "realised_value_all": 5,
                 "fully_loaded_cost": 12, "amortised_build": 1, "revenue_per_mtok": 2.5},
                {"month": "2026-02-01", "run_cost": 10, "realised_value_all": 30,
                 "fully_loaded_cost": 12, "amortised_build": 1, "revenue_per_mtok": 3.0},
            ]
        return [{
            "run_cost": 20, "fully_loaded_cost": 24, "realised_value_all": 35,
            "realised_value_proven": 28, "amortised_build": 4, "revenue_per_mtok": 3.5,
            "net_value": 11, "tokens": 1_000_000, "requests": 40,
        }]

    monkeypatch.setattr(reads, "query", fake_query)
    out = reads.use_case_detail("claims")

    summary = out["summary"]
    assert summary["net_ai_value"] == summary["net_value"]
    assert summary["amortised_investment"] == 4.0
    assert summary["vpmt"] == 3.5
    assert summary["cost_per_outcome"] is None
    assert out["attribution_policy"]["method"] == "attested_uplift"
    assert "dim_allocation_policy" not in "\n".join(calls)
    assert out["breakeven"]["months"]
    assert isinstance(out["breakeven"].get("band_low"), list)


def test_metrics_summary_confidence_mix_is_three_way(monkeypatch):
    def fake_query(sql: str):
        if "value_metered_usd" in sql:
            return [{"metered": 50, "attested": 30, "modelled": 20}]
        if "GROUP BY `Month`" in sql:
            return [{"month": "2026-01-01", "run_cost": 10, "realised_value_all": 100,
                     "fully_loaded_cost": 12}]
        return [{
            "run_cost": 10, "fully_loaded_cost": 12, "realised_value_all": 100,
            "realised_value_proven": 80, "net_value": 88, "tokens": 1000, "requests": 5,
        }]

    monkeypatch.setattr(reads, "query", fake_query)
    mix = reads.metrics_summary()["confidence_mix"]
    assert mix == {"metered": 0.5, "attested": 0.3, "modelled": 0.2}


def test_configured_gateway_failure_is_graceful(monkeypatch):
    monkeypatch.setattr(
        reads, "AI_ROI_GATEWAY_TABLE", "office_of_cfo.app_ops.gateway_daily"
    )
    monkeypatch.setattr(
        reads, "query", lambda _sql: (_ for _ in ()).throw(RuntimeError("denied"))
    )
    out = reads.gateway_telemetry()
    assert out["available"] is False
    assert out["table"] == "office_of_cfo.app_ops.gateway_daily"
    assert "denied" in out["detail"]


def test_profitability_rolls_up_to_level_one_unless_a_business_unit_is_scoped(monkeypatch):
    """Unscoped, the ranking is by level-1 business unit (the CFO's "2 of 5"), not
    by every leaf sub-unit and corporate function. Scoped to one business unit, it
    ranks that unit's sub-units instead. Ratios must come from summed numerators
    and denominators, never from averaging leaf indices."""
    seen: list[str] = []

    def fake_query(sql: str):
        seen.append(sql)
        return []

    monkeypatch.setattr(reads, "query", fake_query)

    unscoped = reads.profitability("business_unit")
    ranking = next(s for s in seen if "dim_allocation_policy" not in s)
    assert unscoped["rolled_up"] is True
    assert "WHEN p.level = 1 THEN p.org_unit_bk" in ranking
    assert "SUM(leaf.realised_value_all) / NULLIF(SUM(leaf.fully_loaded_cost), 0)" in ranking
    assert "AVG(" not in ranking

    seen.clear()
    scoped = reads.profitability("business_unit", scope_type="business_unit", scope_id="BU-200")
    ranking = next(s for s in seen if "dim_allocation_policy" not in s)
    assert scoped["rolled_up"] is False
    assert "WHEN p.level = 1" not in ranking

    seen.clear()
    by_use_case = reads.profitability("use_case")
    assert by_use_case["rolled_up"] is False
