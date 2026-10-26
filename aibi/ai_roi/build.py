"""Build valid, reproducible AI/BI dashboard JSON for one or all industries.

Run:  python3 aibi/ai_roi/build.py [--catalog CATALOG] [all|industry]

Environment: CFO_CATALOG (default: office_of_cfo)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "data_generation"))
from industry_profiles import INDUSTRIES, profile  # noqa: E402  (the one industry list)
DEFAULT_CATALOG = os.environ.get("CFO_CATALOG", "office_of_cfo")
HERE = Path(__file__).resolve().parent
# Where the built artifacts go. Defaults to the committed generated/ folder (built
# for the default catalog); scripts/setup.py points CFO_GENERATED_DIR at the bundle
# target's state directory so an install never rewrites committed files.
GENERATED = Path(os.environ["CFO_GENERATED_DIR"]) / "aibi" if os.environ.get("CFO_GENERATED_DIR") \
    else HERE / "generated"

CUR = {"type": "number-currency", "currencyCode": "USD", "abbreviation": "compact",
       "decimalPlaces": {"type": "max", "places": 2}}
CUR2 = {"type": "number-currency", "currencyCode": "USD",
        "decimalPlaces": {"type": "exact", "places": 2}}
RATIO = {"type": "number", "decimalPlaces": {"type": "exact", "places": 2}}
RATIO_COUNTER = {"type": "number-plain", "decimalPlaces": {"type": "exact", "places": 2}}
CNT = {"type": "number", "abbreviation": "compact",
       "decimalPlaces": {"type": "max", "places": 1}}

# Warm-neutral/brick palette used by the app (ExecutiveCharts/index.css).
PALETTE = ["#C4382B", "#1E232B", "#A98A34", "#64748B", "#8B909A", "#1B8A5A", "#C77D3A"]
BREAKEVEN = {
    "type": "vertical-line",
    "encodings": {
        "x": {"dataValue": "1", "dataType": "DECIMAL"},
        "label": {"value": "1.0 break-even"},
        "color": {"value": {"themeColorType": "visualizationColors", "position": 0}},
    },
}


def field(name: str, expression: str) -> dict:
    return {"name": name, "expression": expression}


EXPOSED_MEASURES = {
    "run_cost": "Token Run Cost",
    "fully_loaded_cost": "Fully Loaded Cost",
    "realised_value_all": "Realised Value All",
    "realised_value_proven": "Realised Value Proven",
    "profitability_index": "Profitability Index",
    "tokens": "Total Tokens",
    "requests": "Requests",
}


def measure(name: str, expression: str | None = None) -> dict:
    exposed = EXPOSED_MEASURES.get(name, name)
    return field(f"measure({name})", expression or f"MEASURE(`{exposed}`)")


def counter(name: str, title: str, description: str, metric: dict, fmt: dict) -> dict:
    return {
        "name": name,
        "queries": [{"name": "main_query", "query": {
            "datasetName": "ds_ai_roi", "fields": [metric], "disaggregated": False,
        }}],
        "spec": {
            "version": 2, "widgetType": "counter",
            "encodings": {"value": {
                "fieldName": metric["name"], "displayName": title, "format": fmt,
            }},
            "frame": {"showTitle": True, "title": title, "showDescription": True,
                      "description": description},
        },
    }


def build_dashboard(industry: str, catalog: str = DEFAULT_CATALOG) -> dict:
    if industry not in INDUSTRIES:
        raise ValueError(f"Unsupported industry: {industry}")
    metric_view = f"{catalog}.{industry}_serving.mv_ai_roi"
    layout: list[dict] = []

    def add(widget: dict, x: int, y: int, width: int, height: int) -> None:
        layout.append({"widget": widget, "position": {
            "x": x, "y": y, "width": width, "height": height,
        }})

    pi = measure("profitability_index")
    pi_proven = measure(
        "profitability_index_proven",
        "MEASURE(`Realised Value Proven`) / NULLIF(MEASURE(`Fully Loaded Cost`), 0)",
    )
    revenue_mtok = measure(
        "revenue_per_mtok",
        "MEASURE(`Realised Value All`) / NULLIF(MEASURE(`Total Tokens`) / 1000000, 0)",
    )
    loaded_mtok = measure(
        "fully_loaded_cost_per_mtok",
        "MEASURE(`Fully Loaded Cost`) / NULLIF(MEASURE(`Total Tokens`) / 1000000, 0)",
    )
    run_mtok = measure(
        "run_cost_per_mtok",
        "MEASURE(`Token Run Cost`) / NULLIF(MEASURE(`Total Tokens`) / 1000000, 0)",
    )

    add({"name": "header", "multilineTextboxSpec": {"lines": [
        f"# AI ROI — {profile(industry)['label']}\n", "\n",
        f"Governed by `{metric_view}`. ",
        "**Profitability Index is a gross ratio, not a percentage: realised value divided by fully loaded cost; 1.0 is break-even.** ",
        "All value includes metered, attested and modelled value. Proven value includes only metered and attested value. ",
        "`Revenue per Mtok ÷ Fully Loaded Cost per Mtok = Profitability Index`.",
    ]}}, 0, 0, 12, 3)

    add(counter("kpi-fully-loaded-cost", "Fully Loaded Cost",
                "Run cost + amortised investment + allocated build",
                measure("fully_loaded_cost"), CUR), 0, 3, 3, 3)
    add(counter("kpi-realised-value-all", "Realised Value (All)",
                "Metered + attested + modelled",
                measure("realised_value_all"), CUR), 3, 3, 3, 3)
    add(counter("kpi-profitability-index", "Profitability Index",
                "Gross ratio; 1.0 = break-even", pi, RATIO_COUNTER), 6, 3, 3, 3)
    add(counter("kpi-revenue-per-mtok", "Revenue per Mtok",
                "÷ Fully Loaded Cost per Mtok = Profitability Index",
                revenue_mtok, CUR2), 9, 3, 3, 3)

    for name, widget_type, column, title, x in (
        ("filter-business-unit", "filter-multi-select", "Business Unit", "Business Unit", 0),
        ("filter-use-case", "filter-multi-select", "Use Case", "Use Case", 4),
        ("filter-month", "filter-date-range-picker", "Month", "Month", 8),
    ):
        query_name = f"q_{column.lower().replace(' ', '_')}"
        add({
            "name": name,
            "queries": [{"name": query_name, "query": {
                "datasetName": "ds_ai_roi",
                "fields": [field(column, f"`{column}`")],
                "disaggregated": False,
            }}],
            "spec": {
                "version": 2, "widgetType": widget_type,
                "encodings": {"fields": [{
                    "fieldName": column, "displayName": title, "queryName": query_name,
                }]},
                "frame": {"showTitle": True, "title": title},
            },
        }, x, 6, 4, 2)

    ranking_query = {
        "datasetName": "ds_ai_roi",
        "fields": [field("Business Unit", "`Business Unit`"), pi],
        "disaggregated": False,
        "orders": [{"direction": "ASC", "expression": "MEASURE(`Profitability Index`)"}],
    }
    add({
        "name": "profitability-ranking",
        "queries": [{"name": "main_query", "query": ranking_query}],
        "spec": {
            "version": 3, "widgetType": "bar",
            "encodings": {
                "x": {
                    "fieldName": pi["name"], "displayName": "Profitability Index",
                    "scale": {"type": "quantitative"}, "format": RATIO,
                    "axis": {"title": "Profitability Index (1.0 = break-even)"},
                },
                "y": {
                    "fieldName": "Business Unit", "displayName": "Business Unit",
                    "scale": {"type": "categorical", "sort": {"by": "query-order"}},
                    "axis": {"title": "Business Unit"},
                },
                "color": {"value": {"themeColorType": "visualizationColors", "position": 1}},
            },
            "annotations": [BREAKEVEN],
            "frame": {
                "showTitle": True, "title": "Profitability ranking (worst first)",
                "showDescription": True,
                "description": "Ranked ascending. The explicit 1.0 marker separates value destruction from value creation.",
            },
        },
    }, 0, 8, 6, 6)

    add({
        "name": "all-vs-proven",
        "queries": [{"name": "main_query", "query": {
            "datasetName": "ds_ai_roi",
            "fields": [field("Business Unit", "`Business Unit`"), pi, pi_proven],
            "disaggregated": False,
            "orders": [{"direction": "ASC", "expression": "MEASURE(`Profitability Index`)"}],
        }}],
        "spec": {
            "version": 3, "widgetType": "bar", "mark": {"layout": "group"},
            "encodings": {
                "x": {
                    "scale": {"type": "quantitative"}, "format": RATIO,
                    "axis": {"title": "Index (1.0 = break-even)"},
                    "fields": [
                        {"fieldName": pi["name"], "displayName": "All value (incl. modelled)"},
                        {"fieldName": pi_proven["name"], "displayName": "Proven only"},
                    ],
                },
                "y": {
                    "fieldName": "Business Unit", "displayName": "Business Unit",
                    "scale": {"type": "categorical", "sort": {"by": "query-order"}},
                    "axis": {"title": "Business Unit"},
                },
            },
            "annotations": [BREAKEVEN],
            "frame": {
                "showTitle": True, "title": "All-value vs proven-only index",
                "showDescription": True,
                "description": "The gap is modelled value; the two indices are never substitutes.",
            },
        },
    }, 6, 8, 6, 6)

    add({
        "name": "unit-economics-trend",
        "queries": [{"name": "main_query", "query": {
            "datasetName": "ds_ai_roi",
            "fields": [field("monthly(Month)", 'DATE_TRUNC("MONTH", `Month`)'),
                       revenue_mtok, loaded_mtok],
            "disaggregated": False,
            "orders": [{"direction": "ASC", "expression": 'DATE_TRUNC("MONTH", `Month`)'}],
        }}],
        "spec": {
            "version": 3, "widgetType": "line",
            "encodings": {
                "x": {"fieldName": "monthly(Month)", "displayName": "Month",
                      "scale": {"type": "temporal"}, "axis": {"title": "Month"}},
                "y": {
                    "scale": {"type": "quantitative"}, "format": CUR2,
                    "axis": {"title": "USD per million tokens"},
                    "fields": [
                        {"fieldName": revenue_mtok["name"], "displayName": "Revenue per Mtok"},
                        {"fieldName": loaded_mtok["name"], "displayName": "Fully Loaded Cost per Mtok"},
                    ],
                },
            },
            "frame": {
                "showTitle": True, "title": "Unit economics trend",
                "showDescription": True,
                "description": "Revenue and fully loaded cost per million tokens share one axis; their ratio is the profitability index.",
            },
        },
    }, 0, 14, 12, 6)

    table_measures = [
        ("fully_loaded_cost", CUR), ("run_cost", CUR),
        ("realised_value_proven", CUR), ("realised_value_all", CUR),
        ("profitability_index", RATIO), ("profitability_index_proven", RATIO),
        ("revenue_per_mtok", CUR2), ("fully_loaded_cost_per_mtok", CUR2),
        ("run_cost_per_mtok", CUR2), ("tokens", CNT), ("requests", CNT),
    ]
    metric_by_name = {
        "fully_loaded_cost": measure("fully_loaded_cost"),
        "run_cost": measure("run_cost"),
        "realised_value_proven": measure("realised_value_proven"),
        "realised_value_all": measure("realised_value_all"),
        "profitability_index": pi, "profitability_index_proven": pi_proven,
        "revenue_per_mtok": revenue_mtok, "fully_loaded_cost_per_mtok": loaded_mtok,
        "run_cost_per_mtok": run_mtok, "tokens": measure("tokens"),
        "requests": measure("requests"),
    }
    table_fields = [field("Business Unit", "`Business Unit`")] + [
        metric_by_name[name] for name, _ in table_measures
    ]
    columns = [{"fieldName": "Business Unit", "displayName": "Business Unit"}] + [
        {"fieldName": metric_by_name[name]["name"],
         "displayName": name.replace("_", " ").title(), "format": fmt}
        for name, fmt in table_measures
    ]
    add({
        "name": "business-unit-detail",
        "queries": [{"name": "main_query", "query": {
            "datasetName": "ds_ai_roi", "fields": table_fields,
            "disaggregated": False,
            "orders": [{"direction": "ASC", "expression": "MEASURE(`Profitability Index`)"}],
        }}],
        "spec": {
            "version": 2, "widgetType": "table",
            "encodings": {"columns": columns},
            "frame": {
                "showTitle": True, "title": "Business Unit detail",
                "showDescription": True,
                "description": "Worst-first fully loaded economics, with all-confidence and proven-only value shown separately.",
            },
        },
    }, 0, 20, 12, 7)

    return {
        "datasets": [{
            "name": "ds_ai_roi",
            "displayName": f"AI ROI ({industry})",
            "asset_name": metric_view,
        }],
        "pages": [{
            "name": "overview", "displayName": "Overview",
            "pageType": "PAGE_TYPE_CANVAS", "layoutVersion": "GRID_V1",
            "layout": layout,
        }],
        "uiSettings": {"theme": {
            "canvasBackgroundColor": {"light": "#F6F5F2", "dark": "#101217"},
            "widgetBackgroundColor": {"light": "#FFFFFF", "dark": "#1E232B"},
            "fontColor": {"light": "#1E232B", "dark": "#F6F5F2"},
            "selectionColor": {"light": "#C4382B", "dark": "#E4674F"},
            "visualizationColors": PALETTE,
            "widgetHeaderAlignment": "LEFT", "widgetCornerRadius": 8,
        }},
    }


def write_dashboard(industry: str, catalog: str = DEFAULT_CATALOG) -> Path:
    out = GENERATED / f"{industry}.dashboard.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(build_dashboard(industry, catalog), indent=2) + "\n")
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", default=DEFAULT_CATALOG, help=f"Catalog name (default: {DEFAULT_CATALOG})")
    parser.add_argument("industry", nargs="*", choices=(*INDUSTRIES, "all"),
                        help="industries to process (default: all)")
    args = parser.parse_args()
    selected = INDUSTRIES if not args.industry or "all" in args.industry else tuple(args.industry)
    for industry in selected:
        print(write_dashboard(industry, args.catalog))


if __name__ == "__main__":
    main()
