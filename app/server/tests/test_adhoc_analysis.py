"""Contract tests for the read-only ad-hoc sample analysis."""
from __future__ import annotations

import pathlib
import sys

import pytest

_APP = pathlib.Path(__file__).resolve().parents[2]
if str(_APP) not in sys.path:
    sys.path.insert(0, str(_APP))

from server.routes import adhoc_analysis


def test_sample_pack_joins_deterministic_flash_to_current_books(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(adhoc_analysis, "current_industry", lambda: "software")
    monkeypatch.setattr(
        adhoc_analysis,
        "comparative_statement",
        lambda *args, **kwargs: {
            "period": "2026-06",
            "actual_period": "Jun 2026",
            "lines": [
                {
                    "line_id": "revenue",
                    "line_label": "Revenue",
                    "sort_order": 1,
                    "actual": 1_000.0,
                },
                {
                    "line_id": "cogs",
                    "line_label": "Cost of Revenue",
                    "sort_order": 2,
                    "actual": 400.0,
                },
                {
                    "line_id": "opex",
                    "line_label": "Operating Expenses",
                    "sort_order": 4,
                    "actual": 300.0,
                },
            ],
        },
    )

    result = adhoc_analysis.sample_pack(
        scope_type="region", scope_id="EMEA", period="2026-06"
    )

    assert result["analysis_id"] == "sample-software-2026-06-region-emea"
    assert result["source"]["filename"] == "bu_flash_software.xlsx"
    assert result["source"]["layout_kind"] == "account_month_pivot"
    assert result["scope"] == {"type": "region", "id": "EMEA"}
    assert result["summary"]["matched_rows"] == 3
    assert result["summary"]["join_coverage_pct"] == 75.0
    assert result["summary"]["unmapped_amount"] == 52.0

    lines = {line["line_id"]: line for line in result["lines"]}
    assert lines["revenue"]["uploaded"] == 1_030.0
    assert lines["revenue"]["gap"] == 30.0
    assert lines["opex"]["uploaded"] == 324.0
    assert lines["opex"]["gap"] == 24.0
    assert result["narrative"]["available"] is True
    assert len(result["narrative"]["bullets"]) == 3


from fastapi import HTTPException


def _books():
    return {
        "period": "2026-06",
        "actual_period": "Jun 2026",
        "lines": [
            {"line_id": "revenue", "line_label": "Revenue", "sort_order": 1, "actual": 1_000.0},
            {"line_id": "cogs", "line_label": "Cost of Revenue", "sort_order": 2, "actual": 400.0},
            {"line_id": "opex", "line_label": "Operating Expenses", "sort_order": 4, "actual": 300.0},
        ],
    }


def test_parse_suggests_synonym_headers_for_flat_flash():
    result = adhoc_analysis.parse_pack({
        "filename": "emea_flash.csv",
        "sheet": "BU Flash",
        "headers": ["Account", "Month", "Amt", "Version"],
        "sample_rows": [
            ["Revenue", "2026-06", "1030", "Flash"],
            ["Cost of Revenue", "2026-06", "392", "Flash"],
        ],
        "row_count": 4,
    })

    by_source = {item["source"]: item for item in result["mappings"]}
    assert by_source["Amt"]["target"] == "amount"
    assert by_source["Amt"]["confidence"] >= 0.9
    assert by_source["Account"]["target"] == "metric_id"
    assert by_source["Month"]["target"] == "period"
    assert by_source["Version"]["target"] == "version"
    assert result["layout_kind"] == "flat"
    assert result["filename"] == "emea_flash.csv"


def test_parse_detects_account_month_pivot():
    result = adhoc_analysis.parse_pack({
        "filename": "bu_flash_software.xlsx",
        "sheet": "BU Flash",
        "headers": ["Account", "2026-04", "2026-05", "2026-06", "Version"],
        "sample_rows": [["Revenue", "900", "950", "1030", "Flash"]],
        "row_count": 4,
    })

    assert result["layout_kind"] == "account_month_pivot"
    by_source = {item["source"]: item for item in result["mappings"]}
    assert by_source["Account"]["target"] == "metric_id"
    assert by_source["2026-06"]["target"] == "period"


def test_parse_infers_datatype_and_role_with_independent_confidence():
    result = adhoc_analysis.parse_pack({
        "filename": "flash.csv",
        "headers": ["Account", "Month", "Amt", "Approved", "Cutoff"],
        "sample_rows": [
            ["Revenue", "2026-06", "$1,030.25", "true", "14:30"],
            ["COGS", "2026-07", "992.00", "false", "09:15"],
        ],
        "row_count": 2,
    })
    by_source = {item["source"]: item for item in result["mappings"]}
    assert by_source["Account"]["data_type"] == "text"
    assert by_source["Month"]["data_type"] == "date"
    assert by_source["Amt"]["data_type"] == "number"
    assert by_source["Approved"]["data_type"] == "boolean"
    assert by_source["Cutoff"]["data_type"] == "time"
    assert by_source["Amt"]["target"] == "amount"
    assert by_source["Amt"]["data_type_confidence"] == 1.0
    assert by_source["Amt"]["role_confidence"] >= 0.9
    assert by_source["Amt"]["user_confirmed_data_type"] is False
    assert by_source["Amt"]["user_confirmed_role"] is False


def test_parse_uses_low_confidence_text_for_mixed_values():
    result = adhoc_analysis.parse_pack({
        "filename": "messy.xlsx",
        "headers": ["Value"],
        "sample_rows": [["10"], ["unknown"], ["12"]],
        "row_count": 3,
    })
    mapping = result["mappings"][0]
    assert mapping["data_type"] == "text"
    assert 0 < mapping["data_type_confidence"] < 1


def test_parse_pivot_period_columns_have_numeric_cells():
    result = adhoc_analysis.parse_pack({
        "filename": "pivot.xlsx",
        "headers": ["Account", "2026-06", "2026-07"],
        "sample_rows": [["Revenue", "100", "110"], ["COGS", "40", "42"]],
        "row_count": 2,
    })
    june = next(item for item in result["mappings"] if item["source"] == "2026-06")
    assert june["target"] == "period"
    assert june["data_type"] == "number"


def test_run_accepts_user_confirmed_mapping_and_currency_number(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(adhoc_analysis, "current_industry", lambda: "consumer")
    monkeypatch.setattr(adhoc_analysis, "comparative_statement", lambda *a, **k: _books())
    result = adhoc_analysis.run_pack({
        "filename": "manual.csv",
        "headers": ["Label", "When", "Value"],
        "rows": [["Revenue", "2026-06", "$1,030.00"]],
        "mappings": [
            {"source": "Label", "target": "metric_id", "data_type": "text",
             "role_confidence": 1, "data_type_confidence": 1,
             "user_confirmed_role": True, "user_confirmed_data_type": True},
            {"source": "When", "target": "period", "data_type": "date",
             "role_confidence": 1, "data_type_confidence": 1},
            {"source": "Value", "target": "amount", "data_type": "number",
             "role_confidence": 1, "data_type_confidence": 1},
        ],
        "scope_type": "consolidated", "scope_id": "ALL", "period": "2026-06",
    })
    assert result["lines"][0]["uploaded"] == 1030


def test_run_reports_invalid_number_as_exception(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(adhoc_analysis, "current_industry", lambda: "consumer")
    monkeypatch.setattr(adhoc_analysis, "comparative_statement", lambda *a, **k: _books())
    result = adhoc_analysis.run_pack({
        "filename": "manual.csv",
        "headers": ["Label", "When", "Value"],
        "rows": [["Revenue", "2026-06", "not posted"]],
        "mappings": [
            {"source": "Label", "target": "metric_id", "data_type": "text"},
            {"source": "When", "target": "period", "data_type": "date"},
            {"source": "Value", "target": "amount", "data_type": "number"},
        ],
        "scope_type": "consolidated", "scope_id": "ALL", "period": "2026-06",
    })
    assert result["lines"][0]["uploaded"] == 0
    assert any(item["code"] == "invalid_value" for item in result["exceptions"])
    assert result["summary"]["matched_rows"] == 0
    assert result["summary"]["total_rows"] == 0
    assert result["summary"]["join_coverage_pct"] == 0.0


def test_run_rejects_unknown_data_type(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(adhoc_analysis, "current_industry", lambda: "consumer")
    monkeypatch.setattr(adhoc_analysis, "comparative_statement", lambda *a, **k: _books())
    with pytest.raises(HTTPException) as err:
        adhoc_analysis.run_pack({
            "filename": "manual.csv",
            "headers": ["Value"],
            "rows": [["1030"]],
            "mappings": [
                {"source": "Value", "target": "amount", "data_type": "currency"},
            ],
            "scope_type": "consolidated", "scope_id": "ALL", "period": "2026-06",
        })
    assert err.value.status_code == 400


def test_parse_caps_role_confidence_for_incompatible_mapping():
    result = adhoc_analysis.parse_pack({
        "filename": "flash.csv",
        "headers": ["Amt"],
        "sample_rows": [["not-a-number"]],
        "row_count": 1,
    })
    mapping = result["mappings"][0]
    assert mapping["target"] == "amount"
    assert mapping["data_type"] == "text"
    assert mapping["role_confidence"] == 0.5
    assert any("Amount usually expects Number" in warning for warning in result["warnings"])


def test_run_rejects_text_typed_amount_value(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(adhoc_analysis, "current_industry", lambda: "consumer")
    monkeypatch.setattr(adhoc_analysis, "comparative_statement", lambda *a, **k: _books())
    result = adhoc_analysis.run_pack({
        "filename": "manual.csv",
        "headers": ["Label", "When", "Value"],
        "rows": [["Revenue", "2026-06", "$1,030.00"]],
        "mappings": [
            {"source": "Label", "target": "metric_id", "data_type": "text"},
            {"source": "When", "target": "period", "data_type": "date"},
            {"source": "Value", "target": "amount", "data_type": "text"},
        ],
        "scope_type": "consolidated", "scope_id": "ALL", "period": "2026-06",
    })
    assert result["summary"]["matched_rows"] == 0
    assert result["summary"]["total_rows"] == 0
    assert any(
        item["code"] == "invalid_value" and item["label"] == "Value: $1,030.00"
        for item in result["exceptions"]
    )


def test_run_reports_invalid_period_and_skips_row(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(adhoc_analysis, "current_industry", lambda: "consumer")
    monkeypatch.setattr(adhoc_analysis, "comparative_statement", lambda *a, **k: _books())
    result = adhoc_analysis.run_pack({
        "filename": "manual.csv",
        "headers": ["Label", "When", "Value"],
        "rows": [["Revenue", "not-a-date", "1030"]],
        "mappings": [
            {"source": "Label", "target": "metric_id", "data_type": "text"},
            {"source": "When", "target": "period", "data_type": "date"},
            {"source": "Value", "target": "amount", "data_type": "number"},
        ],
        "scope_type": "consolidated", "scope_id": "ALL", "period": "2026-06",
    })
    assert result["summary"]["matched_rows"] == 0
    assert result["summary"]["total_rows"] == 0
    assert any(
        item["code"] == "invalid_value" and item["label"] == "When: not-a-date"
        for item in result["exceptions"]
    )


def test_run_normalizes_confirmed_confidence_to_one(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(adhoc_analysis, "current_industry", lambda: "consumer")
    monkeypatch.setattr(adhoc_analysis, "comparative_statement", lambda *a, **k: _books())
    result = adhoc_analysis.run_pack({
        "filename": "manual.csv",
        "headers": ["Label", "Value"],
        "rows": [["Revenue", "1030"]],
        "mappings": [
            {"source": "Label", "target": "metric_id", "data_type": "text",
             "role_confidence": 0.2, "data_type_confidence": 0.3,
             "user_confirmed_role": True, "user_confirmed_data_type": True},
            {"source": "Value", "target": "amount", "data_type": "number",
             "role_confidence": 0.4, "data_type_confidence": 0.5},
        ],
        "scope_type": "consolidated", "scope_id": "ALL", "period": "2026-06",
    })
    label = next(item for item in result["mappings"] if item["source"] == "Label")
    assert label["role_confidence"] == 1.0
    assert label["data_type_confidence"] == 1.0
    assert label["confidence"] == 1.0


def test_mapping_warning_names_incompatible_role_and_datatype():
    warning = adhoc_analysis._mapping_warning(
        {"target": "amount", "data_type": "text"},
        "flat",
    )
    assert warning == "Amount usually expects Number, not Text."


def test_run_joins_uploaded_grid_to_current_books(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(adhoc_analysis, "current_industry", lambda: "software")
    monkeypatch.setattr(adhoc_analysis, "comparative_statement", lambda *args, **kwargs: _books())

    result = adhoc_analysis.run_pack({
        "analysis_id": "upload-1",
        "filename": "emea_flash.csv",
        "sheet": "BU Flash",
        "headers": ["Account", "Month", "Amt", "Version"],
        "rows": [
            ["Revenue", "2026-06", "1030", "Flash"],
            ["Cost of Revenue", "2026-06", "392", "Flash"],
            ["Operating Expenses", "2026-06", "324", "Flash"],
            ["Discretionary projects", "2026-06", "52", "Flash"],
        ],
        "mappings": [
            {"source": "Account", "target": "metric_id", "confidence": 0.98},
            {"source": "Month", "target": "period", "confidence": 0.99},
            {"source": "Amt", "target": "amount", "confidence": 0.96},
            {"source": "Version", "target": "version", "confidence": 0.99},
        ],
        "scope_type": "region",
        "scope_id": "EMEA",
        "period": "2026-06",
    })

    assert result["source"]["filename"] == "emea_flash.csv"
    assert result["summary"]["matched_rows"] == 3
    assert result["summary"]["total_rows"] == 4
    assert result["summary"]["join_coverage_pct"] == 75.0
    assert result["summary"]["unmapped_amount"] == 52.0
    lines = {line["line_id"]: line for line in result["lines"]}
    assert lines["revenue"]["uploaded"] == 1030.0
    assert lines["revenue"]["gap"] == 30.0
    assert lines["opex"]["uploaded"] == 324.0
    assert result["exceptions"][0]["label"] == "Discretionary projects"


def test_run_maps_industry_statement_labels_to_line_ids(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(adhoc_analysis, "current_industry", lambda: "fsi")
    monkeypatch.setattr(adhoc_analysis, "comparative_statement", lambda *args, **kwargs: _books())

    result = adhoc_analysis.run_pack({
        "filename": "fsi_flash.csv",
        "sheet": "Flash",
        "headers": ["Line", "Period", "Amount"],
        "rows": [["Net Interest & Fee Income", "2026-06", "1100"]],
        "mappings": [
            {"source": "Line", "target": "metric_id", "confidence": 0.9},
            {"source": "Period", "target": "period", "confidence": 0.9},
            {"source": "Amount", "target": "amount", "confidence": 0.9},
        ],
        "scope_type": "consolidated",
        "scope_id": "ALL",
        "period": "2026-06",
    })

    assert result["lines"][0]["line_id"] == "revenue"
    assert result["lines"][0]["uploaded"] == 1100.0


def test_run_parses_us_slash_dates_as_period(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(adhoc_analysis, "current_industry", lambda: "consumer")
    monkeypatch.setattr(adhoc_analysis, "comparative_statement", lambda *args, **kwargs: _books())

    result = adhoc_analysis.run_pack({
        "filename": "emea_flash.csv",
        "sheet": "Sheet1",
        "headers": ["Account", "Month", "Amt"],
        "rows": [["Revenue", "6/1/26", "1030"]],
        "mappings": [
            {"source": "Account", "target": "metric_id", "confidence": 1},
            {"source": "Month", "target": "period", "confidence": 1},
            {"source": "Amt", "target": "amount", "confidence": 1},
        ],
        "scope_type": "consolidated",
        "scope_id": "ALL",
        "period": "2026-06",
    })

    assert result["lines"][0]["line_id"] == "revenue"
    assert result["lines"][0]["uploaded"] == 1030.0


def test_run_joins_display_period_cells_to_chrome_period(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(adhoc_analysis, "current_industry", lambda: "consumer")
    monkeypatch.setattr(adhoc_analysis, "comparative_statement", lambda *args, **kwargs: _books())

    result = adhoc_analysis.run_pack({
        "filename": "emea_flash.csv",
        "sheet": "Sheet1",
        "headers": ["Account", "Month", "Amt"],
        "rows": [["Revenue", "2026-09", "1030"]],
        "mappings": [
            {"source": "Account", "target": "metric_id", "confidence": 1},
            {"source": "Month", "target": "period", "confidence": 1},
            {"source": "Amt", "target": "amount", "confidence": 1},
        ],
        "scope_type": "consolidated",
        "scope_id": "ALL",
        "period": "2026-09",
    })

    assert result["lines"][0]["uploaded"] == 1030.0
    assert result["period"] == "2026-06"


def test_run_rejects_oversized_grid():
    with pytest.raises(HTTPException) as err:
        adhoc_analysis.run_pack({
            "filename": "huge.csv",
            "sheet": "Sheet1",
            "headers": ["Account", "Amt"],
            "rows": [["Revenue", "1"]] * 50_001,
            "mappings": [
                {"source": "Account", "target": "metric_id", "confidence": 1},
                {"source": "Amt", "target": "amount", "confidence": 1},
            ],
            "scope_type": "consolidated",
            "scope_id": "ALL",
            "period": "2026-06",
        })
    assert err.value.status_code == 400


def test_sample_pack_handles_empty_statement_data(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(adhoc_analysis, "current_industry", lambda: "consumer")
    monkeypatch.setattr(
        adhoc_analysis,
        "comparative_statement",
        lambda *args, **kwargs: {"period": "2026-06", "lines": []},
    )

    result = adhoc_analysis.sample_pack(
        scope_type="consolidated", scope_id="ALL", period="2026-06"
    )

    assert result["summary"]["matched_rows"] == 0
    assert result["summary"]["join_coverage_pct"] == 0.0
    assert result["lines"] == []
    assert result["narrative"] == {"available": False, "bullets": []}
