"""Contract tests for reproducible AI/BI dashboard and Genie artifacts."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from industry_profiles import INDUSTRIES  # noqa: E402


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


AIBI = _load("ai_roi_aibi_build", ROOT / "aibi/ai_roi/build.py")
GENIE = _load("ai_roi_genie_build", ROOT / "genie/ai_roi/build.py")


def test_dashboard_contract_for_all_industries():
    required = {
        "kpi-fully-loaded-cost", "kpi-realised-value-all",
        "kpi-profitability-index", "kpi-revenue-per-mtok",
        "filter-business-unit", "filter-use-case", "filter-month",
        "profitability-ranking", "all-vs-proven",
        "unit-economics-trend", "business-unit-detail",
    }
    for industry in INDUSTRIES:
        dashboard = AIBI.build_dashboard(industry)
        assert json.loads(json.dumps(dashboard)) == dashboard
        assert dashboard["datasets"][0]["asset_name"] == (
            f"office_of_cfo.{industry}_serving.mv_ai_roi"
        )
        page = dashboard["pages"][0]
        widgets = {item["widget"]["name"]: item["widget"] for item in page["layout"]}
        assert required <= set(widgets)
        for name in ("profitability-ranking", "all-vs-proven"):
            annotations = widgets[name]["spec"]["annotations"]
            assert any(
                annotation["encodings"]["x"]["dataValue"] == "1"
                and "break-even" in annotation["encodings"]["label"]["value"]
                for annotation in annotations
            )
        all_vs_proven = json.dumps(widgets["all-vs-proven"])
        assert "measure(profitability_index)" in all_vs_proven
        assert "Realised Value Proven" in all_vs_proven
        trend = json.dumps(widgets["unit-economics-trend"])
        assert "revenue_per_mtok" in trend
        assert "fully_loaded_cost_per_mtok" in trend
        theme = dashboard["uiSettings"]["theme"]
        assert theme["canvasBackgroundColor"]["light"] == "#F6F5F2"
        assert "#C4382B" in theme["visualizationColors"]
        assert sum(item["position"]["width"] for item in page["layout"]
                   if item["position"]["y"] == 3) == 12


def test_dashboard_builder_is_reproducible():
    assert AIBI.build_dashboard("software") == AIBI.build_dashboard("software")


def test_genie_semantics_examples_and_benchmarks():
    for industry in INDUSTRIES:
        space = GENIE.build_space(industry)
        assert space == GENIE.build_space(industry)
        sources = space["data_sources"]
        assert sources["metric_views"][0]["identifier"] == (
            f"office_of_cfo.{industry}_serving.mv_ai_roi"
        )
        table_ids = {table["identifier"] for table in sources["tables"]}
        for table in ("dim_org_unit", "dim_use_case", "dim_model",
                      "dim_allocation_policy", "ai_roi_metric_registry"):
            assert f"office_of_cfo.{industry}_serving.{table}" in table_ids
        text = "".join(
            space["instructions"]["text_instructions"][0]["content"]
        ).lower()
        assert "gross ratio" in text
        assert "never describe it as a percentage" in text
        assert "all-confidence" in text and "proven" in text
        assert "cost' without qualification" in text
        assert "measure()" in text
        examples = space["instructions"]["example_question_sqls"]
        benchmarks = space["benchmarks"]["questions"]
        assert len(examples) >= 5
        assert len(benchmarks) >= 2 * len(examples)
        for example in examples:
            sql = "".join(example["sql"])
            assert f"office_of_cfo.{industry}_serving.mv_ai_roi" in sql
            assert "MEASURE(" in sql
            assert "SELECT *" not in sql.upper()
        benchmark_sql = {
            "".join(answer["content"])
            for item in benchmarks for answer in item["answer"]
        }
        assert benchmark_sql == {"".join(item["sql"]) for item in examples}


def test_example_sql_uses_safe_metric_view_join_shape():
    for industry in INDUSTRIES:
        for _, sql, _ in GENIE.example_sql(industry):
            normalized = " ".join(sql.split()).lower()
            if " join " in normalized:
                assert normalized.startswith("with ")
                metric_position = normalized.index(
                    f"from office_of_cfo.{industry}_serving.mv_ai_roi"
                )
                join_position = normalized.index(" join ")
                assert metric_position < join_position
                assert "group by all" in normalized[:join_position]
