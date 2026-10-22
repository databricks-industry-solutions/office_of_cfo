"""Reference-parity API surface: endpoints and MEASURE() contract."""
from __future__ import annotations

import pathlib
import sys

_APP = pathlib.Path(__file__).resolve().parents[2]
if str(_APP) not in sys.path:
    sys.path.insert(0, str(_APP))

from app import app  # noqa: E402
from server import ai_roi_queries as reads  # noqa: E402


REQUIRED_PATHS = {
    "/api/ai-roi/executive",
    "/api/ai-roi/spend",
    "/api/ai-roi/metrics/summary",
    "/api/ai-roi/metrics/timeseries",
    "/api/ai-roi/metrics/breakdown",
    "/api/ai-roi/roi/league-table",
    "/api/ai-roi/roi/breakeven",
    "/api/ai-roi/profitability",
    "/api/ai-roi/org",
    "/api/ai-roi/org/detail",
    "/api/ai-roi/budgets",
    "/api/ai-roi/anomalies",
    "/api/ai-roi/invocations",
    "/api/ai-roi/efficiency",
    "/api/ai-roi/efficiency/trend",
    "/api/ai-roi/efficiency/models",
    "/api/ai-roi/efficiency/waste",
    "/api/ai-roi/provenance",
    "/api/ai-roi/provenance/status",
    "/api/ai-roi/gateway/telemetry",
}


def test_openapi_includes_reference_equivalent_surface():
    paths = set(app.openapi()["paths"])
    assert REQUIRED_PATHS <= paths
    assert any(p.startswith("/api/ai-roi/roi/use-case/") for p in paths)


def test_financial_sql_uses_metric_view_measures(monkeypatch):
    captured: list[str] = []

    def fake_query(sql: str):
        captured.append(sql)
        return []

    monkeypatch.setattr(reads, "query", fake_query)
    reads.executive()
    blob = "\n".join(captured)
    assert "mv_ai_roi" in blob
    assert "MEASURE(" in blob
