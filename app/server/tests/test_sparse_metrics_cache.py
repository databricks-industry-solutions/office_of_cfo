"""Offline tests for sparse metrics + durable competitor-search cache.

Covers the contracts that need no network / warehouse:
- `_metrics_at` emits whatever subset the filing supports (partial success)
- metric catalog + schema version are the cache invalidation key
- name normalize collapses whitespace for cache keys
- `_cache_lookup` misses on wrong/null schema; hits when schema + TTL match
- `_peer_benchmarks` short-circuits to True on a durable cache hit (no live fetch)
- `_run_add` cache hit skips `resolve_and_compute`

Run: `python app/server/tests/test_sparse_metrics_cache.py`
"""
from __future__ import annotations

import pathlib
import sys
import types
from unittest.mock import MagicMock, patch

_APP = pathlib.Path(__file__).resolve().parents[2]
if str(_APP) not in sys.path:
    sys.path.insert(0, str(_APP))

# The app venv may not have fastapi / databricks wheels on this machine
# (linux-locked lockfile). Stub the surfaces the route module imports so these
# pure tests stay offline.
def _stub(name: str, **attrs):
    if name in sys.modules:
        return sys.modules[name]
    mod = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(mod, k, v)
    sys.modules[name] = mod
    return mod


if "fastapi" not in sys.modules:
    _stub("fastapi", APIRouter=MagicMock, HTTPException=type("HTTPException", (Exception,), {}))
if "pydantic" not in sys.modules:
    class _BaseModel:
        def __init__(self, **kwargs):
            for k, v in kwargs.items():
                setattr(self, k, v)

    _stub("pydantic", BaseModel=_BaseModel)
if "databricks" not in sys.modules:
    _stub("databricks")
if "databricks.sdk" not in sys.modules:
    _stub("databricks.sdk", WorkspaceClient=MagicMock)

# config / warehouse pull Databricks; provide lightweight stand-ins before import.
if "server.config" not in sys.modules:
    cfg = types.ModuleType("server.config")
    cfg.CLOSE_FQ = "close"  # type: ignore[attr-defined]
    cfg.SRV_FQ = "serving"  # type: ignore[attr-defined]
    cfg.WAREHOUSE_ID = "wh"  # type: ignore[attr-defined]
    cfg.get_workspace_client = MagicMock()  # type: ignore[attr-defined]
    cfg.current_industry = MagicMock(return_value="fsi")  # type: ignore[attr-defined]
    sys.modules["server.config"] = cfg
if "server.warehouse" not in sys.modules:
    wh = types.ModuleType("server.warehouse")
    wh.invalidate_cache = MagicMock()  # type: ignore[attr-defined]
    wh.query = MagicMock(return_value=[])  # type: ignore[attr-defined]
    sys.modules["server.warehouse"] = wh

from server import company_lookup as cl  # noqa: E402
from server.routes import competitor_search as cs  # noqa: E402

CUR = "2025-12-31"
PREV = "2024-12-31"
CHAINS = cl._IFRS


def _series_topline_only():
    """Revenue + operating profit for two years — enough for growth + op margin,
    not enough for WC ratios or gross margin."""
    return {
        "ifrs-full:Revenue": {CUR: 10e9, PREV: 8e9},
        "ifrs-full:ProfitLossFromOperatingActivities": {CUR: 2e9, PREV: 1.5e9},
    }


def test_partial_metrics_succeed_without_full_nine():
    rows = cl._metrics_at(_series_topline_only(), CHAINS, CUR, PREV, 365, "€")
    names = {r["metric"] for r in rows}
    assert "Revenue ($B)" in names
    assert "Revenue growth" in names
    assert "Operating margin" in names
    # WC + gross not present — sparse emit, not a hard fail.
    assert "Gross margin" not in names
    assert "DSO" not in names
    assert "CCC" not in names
    assert len(rows) >= 3


def test_empty_rows_when_no_topline_inputs():
    """No revenue concept → no metrics. Caller raises UnreadableFiling separately."""
    rows = cl._metrics_at({}, CHAINS, CUR, PREV, 365, "$")
    assert rows == []


def test_metric_catalog_lists_nine_with_schema():
    cat = cl.metric_catalog()
    assert cat["metric_schema"] == cl.METRIC_SCHEMA_VERSION == 1
    names = [m["name"] for m in cat["metrics"]]
    assert names == list(cl.METRIC_REGISTRY.keys())
    rev = next(m for m in cat["metrics"] if m["name"] == "Revenue ($B)")
    assert rev["chartable"] is False
    assert rev["better"] == "neutral"
    dso = next(m for m in cat["metrics"] if m["name"] == "DSO")
    assert dso["chartable"] is True
    assert dso["better"] == "low"


def test_normalize_competitor_name_collapses_whitespace():
    assert cl.normalize_competitor_name("  KBC   Group  ") == "KBC Group"
    assert cl.normalize_competitor_name("") == ""
    assert cl.normalize_competitor_name(None) == ""  # type: ignore[arg-type]


def test_cache_lookup_miss_on_wrong_schema():
    """Legacy or bumped-schema rows must not short-circuit a live fetch."""
    with patch.object(cs, "query") as q, patch.object(cs, "_ensure_setup"):
        # First query returns zero metrics for current schema filter.
        q.return_value = [{"period": "FY2025", "metrics": 0}]
        assert cs._cache_lookup("KBC") is None


def test_cache_lookup_hit_requires_trends():
    with patch.object(cs, "query") as q, patch.object(cs, "_ensure_setup"):
        q.side_effect = [
            [{"period": "FY2025", "metrics": 4}],  # BENCH
            [{"n": 0}],  # TREND empty → miss
        ]
        assert cs._cache_lookup("KBC") is None


def test_cache_lookup_hit_with_matching_schema():
    with patch.object(cs, "query") as q, patch.object(cs, "_ensure_setup"):
        q.side_effect = [
            [{"period": "FY2025", "metrics": 4}],
            [{"n": 12}],
            [{"note": "Solid franchise."}],
        ]
        hit = cs._cache_lookup("  KBC  ")
        assert hit is not None
        assert hit["competitor"] == "KBC"
        assert hit["metrics"] == 4
        assert hit["note"] == "Solid franchise."
        # Schema version must be in the BENCH SQL.
        sql = q.call_args_list[0][0][0]
        assert f"metric_schema = {cl.METRIC_SCHEMA_VERSION}" in sql


def test_run_add_cache_hit_skips_resolve_and_compute():
    fake_lock = MagicMock()
    fake_lock.locked.return_value = False
    with patch.object(cs, "_ensure_setup"), \
         patch.object(cs, "_cache_lookup", return_value={
             "competitor": "KBC", "period": "FY2025", "metrics": 5, "note": "n",
         }), \
         patch.object(cl, "resolve_and_compute") as resolve, \
         patch.object(cs, "_RUN_LOCK", fake_lock):
        cs.RUN_STATE.update(stage="idle", cached=False, error=None)
        cs._run_add("ESEF", "lei", "KBC")
        resolve.assert_not_called()
        assert cs.RUN_STATE["stage"] == "done"
        assert cs.RUN_STATE["cached"] is True
        assert cs.RUN_STATE["competitor"] == "KBC"
        assert cs.RUN_STATE["metrics"] == 5


def test_peer_benchmarks_short_circuits_on_cache_hit():
    with patch.object(cs, "_ensure_setup"), \
         patch.object(cs, "_cache_lookup", return_value={
             "competitor": "KBC", "period": "FY2025", "metrics": 3, "note": None,
         }), \
         patch.object(cl, "search_companies") as search, \
         patch.object(cl, "resolve_and_compute") as resolve:
        # Bypass the in-process peer-ok memo so this call exercises the Delta path.
        with patch.object(cs, "_PEER_OK_CACHE", {}):
            assert cs._peer_benchmarks("KBC") is True
        search.assert_not_called()
        resolve.assert_not_called()


def test_peer_benchmarks_falls_through_on_cache_miss():
    with patch.object(cs, "_ensure_setup"), \
         patch.object(cs, "_cache_lookup", return_value=None), \
         patch.object(cl, "search_companies", return_value=[
             {"source": "ESEF", "key": "lei", "name": "KBC"},
         ]) as search, \
         patch.object(cl, "resolve_and_compute",
                      return_value={"rows": [{"metric": "Revenue ($B)"}]}) as resolve:
        with patch.object(cs, "_PEER_OK_CACHE", {}):
            assert cs._peer_benchmarks("KBC") is True
        search.assert_called_once()
        resolve.assert_called_once()


def _run_all():
    tests = [v for k, v in globals().items() if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in tests:
        try:
            fn()
            print(f"ok  {fn.__name__}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"FAIL {fn.__name__}: {e}")
    if failed:
        raise SystemExit(1)
    print(f"{len(tests)} passed")


if __name__ == "__main__":
    try:
        import pytest
    except ImportError:
        _run_all()
    else:
        raise SystemExit(pytest.main([__file__, "-q"]))
