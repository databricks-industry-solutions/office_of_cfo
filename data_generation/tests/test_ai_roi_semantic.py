"""Deterministic accounting and contract tests for every AI ROI industry dataset."""
from __future__ import annotations

import sys
from datetime import date
from decimal import Decimal
from pathlib import Path

DATA_GENERATION = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DATA_GENERATION))

from ai_roi_semantic import (  # noqa: E402
    APP_SERVICE_PRINCIPALS,
    POLICY_ID,
    PROFILES,
    build_dataset,
    seed_ai_roi,
    validate_dataset,
    _level1_parent,
)


def _contract(dataset: dict[str, list[dict]]) -> dict[str, set[str]]:
    return {
        table: set(rows[0]) if rows else set()
        for table, rows in dataset.items()
    }


def test_all_industries_have_identical_complete_contract():
    datasets = {
        industry: build_dataset(industry, "2026-06")
        for industry in PROFILES
    }
    expected_tables = {
        "fact_ai_daily", "fact_usage_daily", "fact_value_event",
        "fact_investment_event", "fact_invocation", "fact_budget",
        "dim_org_unit", "dim_use_case", "dim_model", "dim_allocation_policy", "dim_attribution_policy",
        "dim_reorganisation", "ai_roi_metric_registry",
    }
    assert set(next(iter(datasets.values()))) == expected_tables
    reference = _contract(datasets["consumer"])
    for industry, dataset in datasets.items():
        assert _contract(dataset) == reference, industry
        assert dataset == build_dataset(industry, "2026-06")
        validate_dataset(dataset, PROFILES[industry])


def test_profiles_are_tailored_and_have_real_operating_variation():
    datasets = {
        industry: build_dataset(industry, "2026-06")
        for industry in PROFILES
    }
    all_names = []
    all_use_cases = []
    cache_signatures = set()
    failure_signatures = set()
    concentration_signatures = set()
    for industry, dataset in datasets.items():
        names = tuple(r["name"] for r in dataset["dim_org_unit"] if r["level"] == 1)
        use_cases = tuple(r["name"] for r in dataset["dim_use_case"])
        assert not any("manufactur" in x.lower() for x in names + use_cases)
        assert dataset["dim_allocation_policy"][0]["signed_by"]
        assert dataset["dim_allocation_policy"][0]["allocation_policy_id"] == POLICY_ID
        all_names.append(names)
        all_use_cases.append(use_cases)
        usage = dataset["fact_usage_daily"]
        cache_signatures.add(round(sum(r["cached_read_tokens"] for r in usage) / sum(
            r["input_tokens"] + r["output_tokens"] + r["cached_read_tokens"]
            for r in usage
        ), 4))
        failure_signatures.add(round(sum(r["requests_failed"] for r in usage) / sum(
            r["requests"] for r in usage
        ), 5))
        concentration_signatures.add(tuple(PROFILES[industry].concentration))
    assert len(set(all_names)) == len(PROFILES)
    assert len(set(all_use_cases)) == len(PROFILES)
    assert len(cache_signatures) >= 3
    assert len(failure_signatures) >= 3
    assert len(concentration_signatures) == len(PROFILES)


def test_efficiency_trend_tells_a_coherent_model_migration_story():
    for industry in PROFILES:
        usage = build_dataset(industry, "2026-06")["fact_usage_daily"]
        monthly: dict[object, tuple[Decimal, int]] = {}
        for row in usage:
            cost, tokens = monthly.get(row["usage_date"], (Decimal(0), 0))
            monthly[row["usage_date"]] = (
                cost + row["cost_usd"],
                tokens + row["input_tokens"] + row["output_tokens"],
            )

        trend = [
            cost / (Decimal(tokens) / Decimal(1_000_000))
            for _, (cost, tokens) in sorted(monthly.items())
        ]
        assert len(trend) == 12
        assert len({round(value, 3) for value in trend}) >= 8, industry
        assert all(current <= previous for previous, current in zip(trend, trend[1:])), (
            industry,
            trend,
        )
        drops = [
            (previous - current) / previous
            for previous, current in zip(trend, trend[1:])
        ]
        assert max(drops) >= Decimal("0.08"), (industry, drops)
        assert max(drops) <= Decimal("0.15"), (industry, drops)
        assert trend[-1] <= trend[0] * Decimal("0.65"), (industry, trend)


def test_use_case_rotu_trends_are_not_all_rising():
    for industry in PROFILES:
        facts = build_dataset(industry, "2026-06")["fact_ai_daily"]
        by_uc: dict[str, dict[object, tuple[Decimal, Decimal]]] = {}
        for row in facts:
            month_map = by_uc.setdefault(row["use_case_id"], {})
            value, run = month_map.get(row["month"], (Decimal(0), Decimal(0)))
            month_map[row["month"]] = (
                value + row["value_metered_usd"] + row["value_attested_usd"]
                + row["value_modelled_usd"],
                run + row["run_cost_usd"],
            )
        series = []
        for month_map in by_uc.values():
            series.append([
                ((value - run) / run) if run else Decimal(0)
                for _, (value, run) in sorted(month_map.items())
            ])
        assert len(series) == 6, industry
        rising = [
            all(later >= earlier for earlier, later in zip(points, points[1:]))
            for points in series
        ]
        assert sum(rising) < len(rising), (industry, rising)
        assert any(points[-1] < points[0] for points in series), industry
        def max_step_share(points: list) -> Decimal:
            span = max(points) - min(points)
            if span == 0:
                return Decimal(0)
            return max(abs(later - earlier) / span for earlier, later in zip(points, points[1:]))
        assert all(max_step_share(points) < Decimal("0.45") for points in series), industry
        signatures = {
            (
                points[-1] > points[0],
                max(points) not in (points[0], points[-1]),
                min(points) not in (points[0], points[-1]),
            )
            for points in series
        }
        assert len(signatures) >= 3, (industry, signatures)


def test_ai_roi_history_reaches_september_2026():
    usage = build_dataset("fsi", "2026-09")["fact_usage_daily"]
    months = {row["usage_date"] for row in usage}
    assert date(2026, 9, 1) in months
    assert date(2025, 7, 1) in months
    assert len(months) == 15


def test_fsi_root_keeps_acronym_casing():
    names = {
        industry: build_dataset(industry, "2026-06")["dim_org_unit"][0]["name"]
        for industry in PROFILES
    }
    assert names["fsi"] == "FSI Group"
    assert names["consumer"] == "Consumer Group"
    assert names["software"] == "Software Group"
    assert names["energy"] == "Energy Group"
    retail = [
        row["name"] for row in build_dataset("fsi", "2026-06")["dim_org_unit"]
        if row["parent_bk"] == "BU-100"
    ]
    assert "Everyday Banking & Deposits" in retail
    assert "Mortgages" in retail


def test_allocation_conservation_and_profitability_calibration():
    for industry, profile in PROFILES.items():
        dataset = build_dataset(industry, "2026-06")
        facts = dataset["fact_ai_daily"]
        for month in {r["month"] for r in facts}:
            actual = sum(
                r["allocated_build_usd"] for r in facts if r["month"] == month
            )
            expected = (
                profile.shared_build_pool
                * (Decimal("0.92") + Decimal(month.month % 6) * Decimal("0.025"))
            ).quantize(Decimal("0.01"))
            assert actual == expected, (industry, month)

        by_bk = {r["org_unit_bk"]: r for r in dataset["dim_org_unit"]}
        by_unit: dict[str, tuple[Decimal, Decimal]] = {}
        for row in facts:
            key = _level1_parent(row["org_unit_bk"], by_bk)
            value, cost = by_unit.get(key, (Decimal(0), Decimal(0)))
            by_unit[key] = (
                value + row["value_metered_usd"] + row["value_attested_usd"]
                + row["value_modelled_usd"],
                cost + row["run_cost_usd"] + row["amortised_investment_usd"]
                + row["allocated_build_usd"],
            )
        ratios = [value / cost for value, cost in by_unit.values()]
        assert sum(r < 1 for r in ratios) >= 1
        assert sum(r > 1 for r in ratios) >= 1
        for org_id, target in zip(
            ("BU-100", "BU-200", "BU-300", "BU-400", "BU-900"), profile.profitability
        ):
            value, cost = by_unit[org_id]
            assert abs(value / cost - target) < Decimal("0.25"), (industry, org_id, value / cost, target)


def test_seed_builds_every_object_and_restores_both_app_grants():
    statements: list[str] = []
    seed_ai_roi("software", "office_of_cfo.software_serving", "2026-06", statements.append)
    sql = "\n".join(statements)
    for object_name in (
        "fact_ai_daily", "fact_usage_daily", "fact_value_event",
        "fact_investment_event", "fact_invocation", "fact_budget",
        "dim_org_unit", "dim_use_case", "dim_model", "dim_allocation_policy", "dim_attribution_policy",
        "dim_reorganisation", "ai_roi_metric_registry", "mv_ai_roi",
    ):
        assert f"office_of_cfo.software_serving.{object_name}" in sql
    assert "net_run_rate_value" in sql
    assert "WITH METRICS" in sql
    assert "MEASURE(`Profitability Index`)" in sql
    assert "name: Market" in sql
    for principal in APP_SERVICE_PRINCIPALS:
        assert f"TO `{principal}`" in sql
        assert "SELECT ON SCHEMA office_of_cfo.software_serving" in sql


def test_model_run_cost_and_mom_are_unique():
    from collections import defaultdict

    def compact_dollar(value: Decimal) -> tuple[str, int]:
        # Keep the magnitude: "$13.1k" and "$1.3m" both rounded to 13 before, so
        # two models that could never look alike on screen counted as duplicates.
        amount = abs(float(value))
        if amount >= 1_000_000:
            return ("m", int(round(amount / 100_000)))
        if amount >= 10_000:
            return ("k", int(round(amount / 1_000)))
        return ("", int(round(amount)))

    for industry in PROFILES:
        dataset = build_dataset(industry, "2026-09")
        facts = dataset["fact_ai_daily"]
        months = sorted({row["month"] for row in facts})
        latest, prior = months[-1], months[-2]
        current: dict[str, Decimal] = defaultdict(lambda: Decimal("0"))
        previous: dict[str, Decimal] = defaultdict(lambda: Decimal("0"))
        lifetime: dict[str, Decimal] = defaultdict(lambda: Decimal("0"))
        for row in facts:
            lifetime[row["model_id"]] += row["run_cost_usd"]
            if row["month"] == latest:
                current[row["model_id"]] += row["run_cost_usd"]
            elif row["month"] == prior:
                previous[row["model_id"]] += row["run_cost_usd"]
        for bucket in (current, lifetime):
            display = [compact_dollar(value) for value in bucket.values()]
            assert display and len(display) == len(set(display)), industry
        deltas = [compact_dollar(current[key] - previous[key]) for key in current]
        assert len(deltas) == len(set(deltas)), industry


def test_gateway_refresh_is_aggregated_private_and_scheduled_daily():
    repo = DATA_GENERATION.parent
    script = (repo / "pipelines/scripts/refresh_ai_gateway_usage.py").read_text()
    job = (repo / "resources/ai_roi_usage.job.yml").read_text()
    assert "app_ops.ai_gateway_usage_daily" in script
    assert "COUNT(DISTINCT {requester}) AS requester_count" in script
    assert "prompt" not in script.split("SELECT", 1)[1].split("FROM", 1)[0].lower()
    assert "response" not in script.split("SELECT", 1)[1].split("FROM", 1)[0].lower()
    # Daily schedule, shipped paused: it needs system.ai_gateway access, which a
    # fresh workspace may not have granted yet.
    assert "quartz_cron_expression" in job and "pause_status: PAUSED" in job
    assert "../pipelines/scripts/refresh_ai_gateway_usage.py" in job
