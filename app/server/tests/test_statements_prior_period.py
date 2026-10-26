"""Task 3 API contract tests for statement prior-period comparisons.

These tests are intentionally warehouse-free: they monkeypatch the route module's
`query` and `scope_clause` functions so we can verify period handling, query shape,
and scope-column semantics directly.
"""
from __future__ import annotations

import pathlib
import sys

import pytest

# Make `server` importable under pytest from repo root.
_APP = pathlib.Path(__file__).resolve().parents[2]
if str(_APP) not in sys.path:
    sys.path.insert(0, str(_APP))

from server.routes import statements


def test_prior_period_rolls_month():
    assert statements.prior_period("2026-06") == "2026-05"


def test_prior_period_rolls_year():
    assert statements.prior_period("2026-01") == "2025-12"


def test_prior_period_invalid():
    assert statements.prior_period("bad") is None


@pytest.mark.parametrize(
    "endpoint_name,expected_from",
    [
        ("income_statement", "income_statement"),
        ("balance_sheet", "balance_sheet"),
        ("cash_flow_statement", "cash_flow_statement"),
    ],
)
def test_statement_queries_include_current_and_true_prior_period(
    monkeypatch: pytest.MonkeyPatch, endpoint_name: str, expected_from: str
):
    seen_sql: list[str] = []

    def fake_query(sql: str):
        seen_sql.append(sql)
        return [{
            "section": "ops",
            "line_id": "revenue",
            "line_label": "Revenue",
            "sort_order": 10,
            "amount": 123.45,
            "prior_amount": 111.11,
        }]

    monkeypatch.setattr(statements, "query", fake_query)
    monkeypatch.setattr(statements, "scope_clause", lambda *args, **kwargs: "")

    fn = getattr(statements, endpoint_name)
    rows = fn(scope_type="consolidated", scope_id="ALL", period="2026-01")

    assert rows[0]["amount"] == 123.45
    assert rows[0]["prior_amount"] == 111.11
    assert len(seen_sql) == 1
    sql = seen_sql[0]
    assert f"FROM {statements.SRV}.{expected_from}" in sql
    assert "period IN ('2026-01', '2025-12')" in sql
    assert "CASE WHEN period = '2026-01' THEN amount" in sql
    assert "CASE WHEN period = '2025-12' THEN amount" in sql


def test_equity_statement_query_shape_and_keys(
    monkeypatch: pytest.MonkeyPatch,
):
    seen_sql: list[str] = []

    def fake_query(sql: str):
        seen_sql.append(sql)
        return [{
            "equity_class": "retained_earnings",
            "section": "equity",
            "line_id": "ending",
            "line_label": "Ending",
            "sort_order": 40,
            "amount": 200.0,
            "prior_amount": 175.0,
        }]

    monkeypatch.setattr(statements, "query", fake_query)
    monkeypatch.setattr(statements, "scope_clause", lambda *args, **kwargs: "")

    rows = statements.equity_statement(
        scope_type="consolidated",
        scope_id="ALL",
        period="2026-06",
    )

    assert rows[0]["equity_class"] == "retained_earnings"
    assert rows[0]["section"] == "equity"
    assert rows[0]["line_id"] in {"beginning", "net_income", "dividends", "ending"}
    assert rows[0]["amount"] == 200.0
    assert rows[0]["prior_amount"] == 175.0
    sql = seen_sql[0]
    assert f"FROM {statements.SRV}.equity_statement" in sql
    assert "GROUP BY equity_class, section, line_id" in sql


def test_scope_column_contract_by_endpoint(monkeypatch: pytest.MonkeyPatch):
    seen_cols: list[dict[str, str]] = []

    def fake_scope_clause(scope_type, scope_id, cols, prefix=" AND "):
        seen_cols.append(dict(cols))
        return ""

    monkeypatch.setattr(statements, "scope_clause", fake_scope_clause)
    monkeypatch.setattr(statements, "query", lambda _sql: [])

    statements.income_statement(scope_type="business_line", scope_id="Products", period="2026-06")
    statements.balance_sheet(scope_type="business_line", scope_id="Products", period="2026-06")
    statements.cash_flow_statement(scope_type="business_line", scope_id="Products", period="2026-06")
    statements.equity_statement(scope_type="business_line", scope_id="Products", period="2026-06")

    assert "business_line" in seen_cols[0]
    assert "business_line" in seen_cols[1]
    assert "business_line" not in seen_cols[2]
    assert "business_line" not in seen_cols[3]


@pytest.mark.parametrize(
    "endpoint_name",
    ["income_statement", "balance_sheet", "cash_flow_statement", "equity_statement"],
)
def test_statement_sql_requires_current_row_and_current_metadata(
    monkeypatch: pytest.MonkeyPatch, endpoint_name: str
):
    """Prior-only lines must not leak; label/sort_order come from current period."""
    seen_sql: list[str] = []
    monkeypatch.setattr(statements, "query", lambda sql: seen_sql.append(sql) or [])
    monkeypatch.setattr(statements, "scope_clause", lambda *args, **kwargs: "")

    getattr(statements, endpoint_name)(
        scope_type="consolidated", scope_id="ALL", period="2026-06"
    )
    assert len(seen_sql) == 1
    sql = seen_sql[0]

    # Current-driven output: exclude groups that have no current-period row.
    assert "HAVING SUM(CASE WHEN period = '2026-06' THEN 1 ELSE 0 END) > 0" in sql

    # Metadata must prefer current-period values, not MAX across both periods.
    assert "MAX(CASE WHEN period = '2026-06' THEN line_label END) AS line_label" in sql
    assert "MAX(CASE WHEN period = '2026-06' THEN sort_order END) AS sort_order" in sql
    assert "MAX(line_label) AS line_label" not in sql
    assert "MAX(sort_order) AS sort_order" not in sql

    # Missing prior stays NULL (no ELSE 0 on prior_amount).
    assert "CASE WHEN period = '2026-05' THEN amount END" in sql
    assert "CASE WHEN period = '2026-05' THEN amount ELSE 0 END" not in sql
