"""Build reproducible per-industry AI ROI Genie space payloads.

Run:  python3 genie/ai_roi/build.py [--catalog CATALOG] [all|industry]

Environment: CFO_CATALOG (default: office_of_cfo)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "data_generation"))
from industry_profiles import INDUSTRIES  # noqa: E402  (the one industry list)
DEFAULT_CATALOG = os.environ.get("CFO_CATALOG", "office_of_cfo")
HERE = Path(__file__).resolve().parent
# Where the built artifacts go. Defaults to the committed generated/ folder (built
# for the default catalog); scripts/setup.py points CFO_GENERATED_DIR at the bundle
# target's state directory so an install never rewrites committed files.
GENERATED = Path(os.environ["CFO_GENERATED_DIR"]) / "genie" if os.environ.get("CFO_GENERATED_DIR") \
    else HERE / "generated"


def stable_id(industry: str, kind: str, name: str) -> str:
    return uuid.uuid5(uuid.NAMESPACE_URL, f"office-of-cfo/ai-roi/{industry}/{kind}/{name}").hex


def sql_lines(sql: str) -> list[str]:
    lines = sql.strip().splitlines()
    return [line + "\n" for line in lines[:-1]] + [lines[-1]]


def example_sql(industry: str, catalog: str = DEFAULT_CATALOG) -> list[tuple[str, str, str]]:
    schema = f"{catalog}.{industry}_serving"
    mv = f"{schema}.mv_ai_roi"
    return [
        (
            "Which business units return less than they cost?",
            f"""WITH roi AS (
  SELECT `Business Unit` AS business_unit,
         MEASURE(`Realised Value All`) AS realised_value_all,
         MEASURE(`Fully Loaded Cost`) AS fully_loaded_cost,
         MEASURE(`Profitability Index`) AS profitability_index
  FROM {mv}
  GROUP BY ALL
)
SELECT roi.business_unit,
       ROUND(roi.realised_value_all, 2) AS realised_value_all_usd,
       ROUND(roi.fully_loaded_cost, 2) AS fully_loaded_cost_usd,
       ROUND(roi.profitability_index, 3) AS profitability_index,
       CASE WHEN roi.profitability_index < 1 THEN 'below break-even'
            ELSE 'at or above break-even' END AS break_even_status
FROM roi
ORDER BY profitability_index ASC""",
            "Profitability Index is a gross ratio. The CTE makes the break-even filter and ranking safe.",
        ),
        (
            "Compare all-confidence and proven-only profitability by business unit.",
            f"""WITH roi AS (
  SELECT `Business Unit` AS business_unit,
         MEASURE(`Realised Value All`) AS realised_value_all,
         MEASURE(`Realised Value Proven`) AS realised_value_proven,
         MEASURE(`Fully Loaded Cost`) AS fully_loaded_cost
  FROM {mv}
  GROUP BY ALL
)
SELECT roi.business_unit,
       ROUND(roi.realised_value_all / NULLIF(roi.fully_loaded_cost, 0), 3) AS profitability_index_all,
       ROUND(roi.realised_value_proven / NULLIF(roi.fully_loaded_cost, 0), 3) AS profitability_index_proven,
       ROUND((roi.realised_value_all - roi.realised_value_proven)
             / NULLIF(roi.fully_loaded_cost, 0), 3) AS modelled_index_gap
FROM roi
ORDER BY profitability_index_all ASC""",
            "All value includes modelled value; proven includes metered and attested value only. State both scopes.",
        ),
        (
            "Show the monthly unit economics trend.",
            f"""WITH monthly AS (
  SELECT `Month` AS month,
         MEASURE(`Total Tokens`) AS tokens,
         MEASURE(`Token Run Cost`) AS run_cost,
         MEASURE(`Fully Loaded Cost`) AS fully_loaded_cost,
         MEASURE(`Realised Value All`) AS realised_value_all
  FROM {mv}
  GROUP BY ALL
)
SELECT month,
       ROUND(realised_value_all / NULLIF(tokens / 1000000.0, 0), 2) AS revenue_per_mtok_usd,
       ROUND(fully_loaded_cost / NULLIF(tokens / 1000000.0, 0), 2) AS fully_loaded_cost_per_mtok_usd,
       ROUND(run_cost / NULLIF(tokens / 1000000.0, 0), 2) AS run_cost_per_mtok_usd,
       ROUND(realised_value_all / NULLIF(fully_loaded_cost, 0), 3) AS profitability_index
FROM monthly
ORDER BY month""",
            "All measures use MEASURE(). Revenue per Mtok divided by loaded cost per Mtok is the profitability index.",
        ),
        (
            "Which use cases are closest to break-even?",
            f"""WITH roi AS (
  SELECT `Use Case` AS use_case,
         MEASURE(`Realised Value All`) AS realised_value_all,
         MEASURE(`Fully Loaded Cost`) AS fully_loaded_cost,
         MEASURE(`Profitability Index`) AS profitability_index
  FROM {mv}
  GROUP BY ALL
)
SELECT roi.use_case,
       ROUND(roi.realised_value_all, 2) AS realised_value_all_usd,
       ROUND(roi.fully_loaded_cost, 2) AS fully_loaded_cost_usd,
       ROUND(roi.profitability_index, 3) AS profitability_index,
       ROUND(ABS(roi.profitability_index - 1), 3) AS distance_from_break_even
FROM roi
ORDER BY distance_from_break_even ASC
LIMIT 10""",
            "Rank by absolute distance from 1.0 after aggregating the metric view in a CTE.",
        ),
        (
            "What is programme-to-date net value and profitability?",
            f"""SELECT ROUND(MEASURE(`Realised Value All`), 2) AS realised_value_all_usd,
       ROUND(MEASURE(`Realised Value Proven`), 2) AS realised_value_proven_usd,
       ROUND(MEASURE(`Fully Loaded Cost`), 2) AS fully_loaded_cost_usd,
       ROUND(MEASURE(`Realised Value All`) - MEASURE(`Fully Loaded Cost`), 2) AS net_value_usd,
       ROUND(MEASURE(`Profitability Index`), 3) AS profitability_index
FROM {mv}""",
            "Programme-to-date summary from governed measures; profitability is a ratio, not a percentage.",
        ),
        (
            "What is net value by business unit?",
            f"""WITH roi AS (
  SELECT `Business Unit` AS business_unit,
         MEASURE(`Net Value`) AS net_value,
         MEASURE(`Fully Loaded Cost`) AS fully_loaded_cost
  FROM {mv}
  GROUP BY ALL
)
SELECT roi.business_unit,
       ROUND(roi.net_value, 2) AS net_value_usd,
       ROUND(roi.fully_loaded_cost, 2) AS fully_loaded_cost_usd
FROM roi
ORDER BY net_value ASC""",
            "Net Value is realised value minus fully loaded cost.",
        ),
        (
            "Which markets have the highest revenue per million tokens?",
            f"""WITH roi AS (
  SELECT `Market` AS market,
         MEASURE(`Revenue per Mtok`) AS revenue_per_mtok,
         MEASURE(`Fully Loaded Cost per Mtok`) AS fully_loaded_cost_per_mtok
  FROM {mv}
  GROUP BY ALL
)
SELECT roi.market,
       ROUND(roi.revenue_per_mtok, 2) AS revenue_per_mtok_usd,
       ROUND(roi.fully_loaded_cost_per_mtok, 2) AS fully_loaded_cost_per_mtok_usd
FROM roi
ORDER BY revenue_per_mtok DESC""",
            "Unit economics from governed per-Mtok measures.",
        ),
        (
            "Filter fully loaded cost per million tokens by model.",
            f"""WITH roi AS (
  SELECT `Model` AS model,
         MEASURE(`Fully Loaded Cost per Mtok`) AS fully_loaded_cost_per_mtok,
         MEASURE(`Token Cost per Mtok`) AS token_cost_per_mtok
  FROM {mv}
  GROUP BY ALL
)
SELECT roi.model,
       ROUND(roi.fully_loaded_cost_per_mtok, 2) AS fully_loaded_cost_per_mtok_usd,
       ROUND(roi.token_cost_per_mtok, 2) AS token_cost_per_mtok_usd
FROM roi
ORDER BY fully_loaded_cost_per_mtok ASC""",
            "Model-level unit cost uses MEASURE() on the metric view.",
        ),
    ]


def build_space(industry: str, catalog: str = DEFAULT_CATALOG) -> dict:
    if industry not in INDUSTRIES:
        raise ValueError(f"Unsupported industry: {industry}")
    schema = f"{catalog}.{industry}_serving"
    mv = f"{schema}.mv_ai_roi"
    examples = example_sql(industry, catalog)
    metric_columns = [
        ("Business Unit", "Stable business-unit key. Resolve it to dim_org_unit.name after aggregating the metric view."),
        ("Fully Loaded Cost", "Run cost plus amortised investment and allocated build cost; the profitability denominator."),
        ("Month", "First day of the reporting month."),
        ("Profitability Index", "Gross ratio of all realised value to fully loaded cost. 1.0 is break-even; never a percentage."),
        ("Realised Value All", "Metered plus attested plus modelled value."),
        ("Realised Value Proven", "Metered plus attested value only; excludes modelled value."),
        ("Requests", "Request count."),
        ("Token Run Cost", "Metered run cost only; excludes amortised and allocated build cost."),
        ("Total Tokens", "Billable tokens."),
        ("Market", "Operating market or region on the fact grain."),
        ("Model", "Model key. Resolve it to dim_model.name after aggregating the metric view."),
        ("Net Value", "Realised value all minus fully loaded cost."),
        ("Revenue per Mtok", "Realised value all per million tokens."),
        ("Fully Loaded Cost per Mtok", "Fully loaded cost per million tokens."),
        ("Token Cost per Mtok", "Token run cost per million tokens."),
    ]
    metric_view = {
        "identifier": mv,
        "description": [
            (
                f"Governed AI ROI semantic layer for {industry}. Every measure "
                "must be read with MEASURE(). Profitability Index is a gross "
                "ratio with break-even at 1.0."
            )
        ],
        "column_configs": [
            {"column_name": name, "description": [description],
             "enable_format_assistance": True}
            for name, description in sorted(metric_columns)
        ],
    }
    table_descriptions = {
        "dim_org_unit": "Business-unit hierarchy and display names. Join only to an aggregated metric-view CTE on org_unit_bk.",
        "dim_use_case": "Use-case names, market, confidence method and owner. Join only to an aggregated metric-view CTE on use_case_id.",
        "dim_model": "Model names, tiers and reference cost per million tokens.",
        "dim_allocation_policy": "Signed-off shared-build-cost allocation policy, owner, basis and review dates.",
        "ai_roi_metric_registry": "Human-readable governed metric definitions and confidence scope.",
    }
    tables = [
        {"identifier": f"{schema}.{name}", "description": [description]}
        for name, description in sorted(table_descriptions.items())
    ]
    text = [
        "## PURPOSE\n",
        f"- Answer CFO and technology-finance questions about AI cost, realised value and profitability for the {industry} business using {mv}.\n",
        "\n## REQUIRED SEMANTICS\n",
        "- Read every metric-view measure with MEASURE(). Never SUM a measure and never put a measure in WHERE or GROUP BY.\n",
        "- Never join the metric view directly. Aggregate it in a CTE with GROUP BY ALL, then join the CTE to a supporting dimension.\n",
        "- Profitability Index is a GROSS RATIO: realised value divided by fully loaded cost. 1.0 is break-even. Never describe it as a percentage return, percentage, ROI percentage, or margin. If asked for a percentage return, correct the framing and report the index.\n",
        "- All-confidence value includes metered, attested and modelled value. Proven value includes metered and attested value only. Always state which scope was used; never substitute one for the other.\n",
        "- If the user says 'cost' without qualification, ask whether they mean Run Cost (metered operation only) or Fully Loaded Cost (run + amortised investment + allocated build). Do not silently choose.\n",
        "- Revenue per million tokens divided by Fully Loaded Cost per million tokens equals Profitability Index.\n",
        "- Cost is actual and is not confidence-graded. Confidence applies only to value. Label modelled value as an estimate.\n",
        "\n## ANSWER STYLE\n",
        "- Quote Profitability Index to three decimals and explicitly name 1.0 as break-even.\n",
        "- Round USD to two decimals, state the date range, and name the business scope.\n",
        "- Lead with the number, then explain the fully loaded cost and confidence drivers.\n",
    ]
    sample_questions = [
        question for question, _, _ in examples
    ] + ["If cost is ambiguous, what should I clarify before analysing it?"]
    example_items = [{
        "id": stable_id(industry, "example", question),
        "question": [question], "sql": sql_lines(sql), "usage_guidance": [guidance],
    } for question, sql, guidance in examples]
    benchmarks = []
    for question, sql, _ in examples:
        for prompt in (question, f"For {industry}, {question[0].lower() + question[1:]}"):
            benchmarks.append({
                "id": stable_id(industry, "benchmark", prompt),
                "question": [prompt],
                "answer": [{"format": "SQL", "content": sql_lines(sql)}],
            })
    return {
        "version": 2,
        "config": {"sample_questions": [{
            "id": stable_id(industry, "sample", question), "question": [question],
        } for question in sample_questions]},
        "data_sources": {"metric_views": [metric_view], "tables": tables},
        "instructions": {
            "text_instructions": [{
                "id": stable_id(industry, "instruction", "semantic"), "content": text,
            }],
            "example_question_sqls": sorted(example_items, key=lambda item: item["id"]),
        },
        "benchmarks": {"questions": sorted(benchmarks, key=lambda item: item["id"])},
    }


def write_space(industry: str, catalog: str = DEFAULT_CATALOG) -> Path:
    output = GENERATED / f"{industry}.serialized_space.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(build_space(industry, catalog), indent=2) + "\n")
    sql_dir = GENERATED / industry / "sql"
    sql_dir.mkdir(parents=True, exist_ok=True)
    for index, (_, sql, _) in enumerate(example_sql(industry, catalog), 1):
        (sql_dir / f"e{index}.sql").write_text(sql.strip() + "\n")
    return output


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", default=DEFAULT_CATALOG, help=f"Catalog name (default: {DEFAULT_CATALOG})")
    parser.add_argument("industry", nargs="*", choices=(*INDUSTRIES, "all"),
                        help="industries to process (default: all)")
    args = parser.parse_args()
    selected = INDUSTRIES if not args.industry or "all" in args.industry else tuple(args.industry)
    for industry in selected:
        print(write_space(industry, args.catalog))


if __name__ == "__main__":
    main()
