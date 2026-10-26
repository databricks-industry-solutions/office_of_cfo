"""Tests for the scenario route's compute endpoints (no Lakebase needed).

`get_baseline` is monkeypatched, so /drivers, /project and /bridge (assumptions form)
are exercised without a warehouse or database. The Lakebase-backed library endpoints
(CRUD / commit / clone) are covered by integration against a live instance.
"""
from __future__ import annotations

import pathlib
import sys
from collections import deque

import pytest

_APP = pathlib.Path(__file__).resolve().parents[2]
if str(_APP) not in sys.path:
    sys.path.insert(0, str(_APP))

from server import scenario_engine as eng
from server.routes import scenario as route


def _baseline(n: int = 12, hinge: int = 5) -> eng.BaselineSeries:
    return eng.BaselineSeries(
        periods=[f"2026-{m:02d}" for m in range(1, n + 1)], hinge_index=hinge,
        revenue=[1000.0] * n, cogs=[550.0] * n, opex=[300.0] * n,
        interest_income=[5.0] * n, interest_expense=[8.0] * n, dna=[40.0] * n,
        tax_rate=0.25, dso=45.0, dpo=50.0, dio=60.0, capex_pct=5.0,
        opening_cash=2000.0, opening_ar=1400.0, opening_inventory=1050.0, opening_ap=900.0)


@pytest.fixture(autouse=True)
def _patch_baseline(monkeypatch):
    monkeypatch.setattr(route, "get_baseline", lambda *a, **k: _baseline())


def test_drivers_endpoint_returns_catalog():
    ids = {d["id"] for d in route.scenario_drivers()["drivers"]}
    assert {"revenue_growth", "gross_margin", "opex_growth", "dso", "dpo", "dio", "capex_pct",
            "acquisitions", "asset_sales", "debt_draw", "debt_repayment", "dividend_payout"} == ids


def test_project_returns_baseline_and_projection_that_tie_out():
    out = route.scenario_project(route.ProjectBody(assumptions={"revenue_growth": 8, "dso": 5}))
    assert set(out) == {"as_of", "baseline", "projection", "baseline_source"}
    proj = out["projection"]
    # StatementSet payload shape
    assert proj["hinge_index"] == 5 and len(proj["periods"]) == 12
    assert "cash_balance" in proj["lines"] and "operating_margin_pct" in proj["kpis"]
    # tie-out survives serialization
    running = 2000.0
    for i in range(12):
        running += proj["lines"]["free_cash_flow"][i]
        assert proj["lines"]["cash_balance"][i] == pytest.approx(running)
    # a growth scenario lifts forecast revenue above the neutral baseline
    assert out["projection"]["lines"]["revenue"][6] > out["baseline"]["lines"]["revenue"][6]


def test_describe_expands_bare_to_self_describing_and_drops_unknown():
    d = route._describe({"revenue_growth": 8, "not_a_driver": 3, "gross_margin": {"value": -150}})
    assert d["revenue_growth"] == {"value": 8.0, "unit": "%", "mode": "growth"}
    assert d["gross_margin"] == {"value": -150.0, "unit": "bps", "mode": "shift"}
    assert "not_a_driver" not in d


def test_bridge_steps_plus_residual_equal_total_for_operating_income():
    out = route.bridge(route.BridgeBody(
        assumptions={"revenue_growth": -8, "gross_margin": -150, "opex_growth": 3,
                     "dso": 6, "dpo": 4},
        target="operating_income"))
    assert out["target"] == "operating_income"
    reconstructed = sum(s["value"] for s in out["steps"]) + out["residual"]
    assert reconstructed == pytest.approx(out["total"])
    # working-capital drivers don't move operating income -> absent from OI steps
    step_ids = {s["driver"] for s in out["steps"]}
    assert "dso" not in step_ids and "dpo" not in step_ids
    assert "revenue_growth" in step_ids


def test_bridge_cash_target_includes_working_capital_drivers():
    out = route.bridge(route.BridgeBody(
        assumptions={"revenue_growth": -8, "dso": 6, "dpo": 4}, target="cash"))
    reconstructed = sum(s["value"] for s in out["steps"]) + out["residual"]
    assert reconstructed == pytest.approx(out["total"])
    step_ids = {s["driver"] for s in out["steps"]}
    assert "dso" in step_ids  # DSO moves cash


class _RowsPool:
    def __init__(self, rows):
        self.rows = rows

    def connection(self):
        return _RowsConnection(self.rows)


class _RowsConnection:
    def __init__(self, rows):
        self.rows = rows

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def cursor(self, row_factory=None):
        return _RowsCursor(self.rows)

    def commit(self):
        return None


class _RowsCursor:
    def __init__(self, rows):
        self.rows = rows

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def execute(self, sql, params=None):
        return None

    def fetchall(self):
        return self.rows


class _ScriptedPool:
    def __init__(self, steps):
        self.steps = deque(steps)
        self.calls: list[tuple[str, object]] = []

    def connection(self):
        return _ScriptedConnection(self)


class _ScriptedConnection:
    def __init__(self, pool):
        self.pool = pool
        self.committed = False

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def cursor(self, row_factory=None):
        return _ScriptedCursor(self.pool)

    def commit(self):
        self.committed = True

    def transaction(self):
        return self


class _ScriptedCursor:
    def __init__(self, pool):
        self.pool = pool
        self._current = {}
        self.rowcount = 0

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def execute(self, sql, params=None):
        self.pool.calls.append((sql, params))
        assert self.pool.steps, f"unexpected SQL: {sql}"
        step = self.pool.steps.popleft()
        assert step["contains"] in sql
        if "params" in step:
            expected = step["params"]
            if isinstance(params, list):
                assert tuple(params) == expected
            else:
                assert params == expected
        self._current = step
        self.rowcount = step.get("rowcount", 0)

    def fetchone(self):
        return self._current.get("fetchone")

    def fetchall(self):
        return self._current.get("fetchall", [])


def test_update_plan_rejects_name_only_save_when_it_matches_baseline(monkeypatch):
    monkeypatch.setattr(route, "_ensure_schema", lambda: None)
    monkeypatch.setattr(route, "current_industry", lambda: "consumer")
    monkeypatch.setattr(route, "_dict_rows", lambda: None)
    plan = {
        "scenario_id": "scn-name-only",
        "name": "Draft",
        "status": "draft",
        "is_baseline": False,
        "is_official": False,
        "as_of_period": "2026-06",
        "scope_type": "consolidated",
        "scope_id": "ALL",
        "horizon_end": None,
        "assumptions": {},
        "frozen_result": None,
        "engine_version": None,
        "parent_scenario_id": None,
        "created_by": "user",
    }
    pool = _ScriptedPool([
        {"contains": "SELECT scenario_id, name, status", "params": ("scn-name-only",), "fetchone": plan},
        {"contains": "pg_advisory_xact_lock", "params": ("consumer|2026-06|consolidated|ALL",)},
        {"contains": "FROM scenario_plans", "params": ("2026-06", "consolidated", "ALL"), "fetchall": []},
    ])
    monkeypatch.setattr(route, "_pool", lambda: pool)
    with pytest.raises(route.HTTPException) as exc:
        route.update_plan("scn-name-only", route.PatchBody(name="Rename"))
    assert exc.value.status_code == 409
    assert exc.value.detail == "This scenario matches Baseline. Change at least one driver."


def test_commit_plan_rejects_duplicate_assumptions(monkeypatch):
    monkeypatch.setattr(route, "_ensure_schema", lambda: None)
    monkeypatch.setattr(route, "current_industry", lambda: "consumer")
    monkeypatch.setattr(route, "_dict_rows", lambda: None)
    plan = {
        "scenario_id": "scn-commit",
        "name": "Draft",
        "status": "draft",
        "is_baseline": False,
        "is_official": False,
        "as_of_period": "2026-06",
        "scope_type": "consolidated",
        "scope_id": "ALL",
        "horizon_end": None,
        "assumptions": {"revenue_growth": {"value": 4}},
        "frozen_result": None,
        "engine_version": None,
        "parent_scenario_id": None,
        "created_by": "user",
    }
    pool = _ScriptedPool([
        {"contains": "SELECT scenario_id, name, status", "params": ("scn-commit",), "fetchone": plan},
        {"contains": "pg_advisory_xact_lock", "params": ("consumer|2026-06|consolidated|ALL",)},
        {
            "contains": "FROM scenario_plans",
            "params": ("2026-06", "consolidated", "ALL"),
            "fetchall": [{
                "scenario_id": "scn-other",
                "name": "Peer scenario",
                "status": "draft",
                "as_of_period": "2026-06",
                "scope_type": "consolidated",
                "scope_id": "ALL",
                "assumptions": {"revenue_growth": {"value": 4}},
            }],
        },
    ])
    monkeypatch.setattr(route, "_pool", lambda: pool)
    with pytest.raises(route.HTTPException) as exc:
        route.commit_plan("scn-commit")
    assert exc.value.status_code == 409
    assert exc.value.detail == 'This scenario matches "Peer scenario". Change at least one driver.'


def test_list_plans_decorates_compare_eligibility_without_exposing_assumptions(monkeypatch):
    monkeypatch.setattr(route, "_ensure_schema", lambda: None)
    monkeypatch.setattr(route, "_dict_rows", lambda: None)
    monkeypatch.setattr(route, "_pool", lambda: _RowsPool([
        {
            "scenario_id": "seed-base-2026-06",
            "name": "Base",
            "status": "baseline",
            "is_baseline": True,
            "is_official": False,
            "scope_type": "consolidated",
            "scope_id": "ALL",
            "as_of_period": "2026-06",
            "assumptions": {},
            "created_by": "system",
            "updated_ts": "2026-06-01T00:00:00Z",
        },
        {
            "scenario_id": "scn-empty",
            "name": "Empty",
            "status": "draft",
            "is_baseline": False,
            "is_official": False,
            "scope_type": "consolidated",
            "scope_id": "ALL",
            "as_of_period": "2026-06",
            "assumptions": {},
            "created_by": "user",
            "updated_ts": "2026-06-02T00:00:00Z",
        },
        {
            "scenario_id": "scn-valid",
            "name": "Valid",
            "status": "draft",
            "is_baseline": False,
            "is_official": False,
            "scope_type": "consolidated",
            "scope_id": "ALL",
            "as_of_period": "2026-06",
            "assumptions": {"revenue_growth": {"value": 3}},
            "created_by": "user",
            "updated_ts": "2026-06-03T00:00:00Z",
        },
    ]))
    out = route.list_plans(period=None, status=None)
    by_id = {p["scenario_id"]: p for p in out["plans"]}
    assert by_id["seed-base-2026-06"]["compare_eligible"] is True
    assert by_id["scn-empty"]["compare_eligible"] is False
    assert by_id["scn-empty"]["compare_block_reason"] == "This scenario matches Baseline. Change at least one driver."
    assert by_id["scn-valid"]["compare_eligible"] is True
    assert "assumptions" not in by_id["scn-empty"]


def test_compare_rejects_non_baseline_ineligible_scenario(monkeypatch):
    monkeypatch.setattr(route, "_ensure_schema", lambda: None)
    monkeypatch.setattr(route, "_dict_rows", lambda: None)
    pool = _ScriptedPool([
        {"contains": "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"},
        {
            "contains": "WHERE scenario_id = ANY(%s)",
            "params": (["seed-base-2026-06", "scn-empty"],),
            "fetchall": [
                {
                    "scenario_id": "seed-base-2026-06",
                    "name": "Base",
                    "status": "baseline",
                    "is_baseline": True,
                    "is_official": False,
                    "scope_type": "consolidated",
                    "scope_id": "ALL",
                    "as_of_period": "2026-06",
                    "horizon_end": None,
                    "assumptions": {},
                    "frozen_result": None,
                    "engine_version": None,
                    "parent_scenario_id": None,
                    "created_by": "system",
                },
                {
                    "scenario_id": "scn-empty",
                    "name": "Empty",
                    "status": "draft",
                    "is_baseline": False,
                    "is_official": False,
                    "scope_type": "consolidated",
                    "scope_id": "ALL",
                    "as_of_period": "2026-06",
                    "horizon_end": None,
                    "assumptions": {},
                    "frozen_result": None,
                    "engine_version": None,
                    "parent_scenario_id": None,
                    "created_by": "user",
                },
            ],
        },
        {
            "contains": "FROM scenario_plans",
            "params": ("2026-06", "consolidated", "ALL"),
            "fetchall": [
                {
                    "scenario_id": "seed-base-2026-06",
                    "name": "Base",
                    "status": "baseline",
                    "is_baseline": True,
                    "assumptions": {},
                    "scope_type": "consolidated",
                    "scope_id": "ALL",
                    "as_of_period": "2026-06",
                },
                {
                    "scenario_id": "scn-empty",
                    "name": "Empty",
                    "status": "draft",
                    "is_baseline": False,
                    "assumptions": {},
                    "scope_type": "consolidated",
                    "scope_id": "ALL",
                    "as_of_period": "2026-06",
                },
            ],
        },
    ])
    monkeypatch.setattr(route, "_pool", lambda: pool)
    with pytest.raises(route.HTTPException) as exc:
        route.compare_plans(ids=["seed-base-2026-06", "scn-empty"])
    assert exc.value.status_code == 409
    assert exc.value.detail == "This scenario matches Baseline. Change at least one driver."


def test_update_plan_rejects_nonfinite_numeric_values(monkeypatch):
    monkeypatch.setattr(route, "_ensure_schema", lambda: None)
    monkeypatch.setattr(route, "_dict_rows", lambda: None)
    plan = {
        "scenario_id": "scn-1",
        "name": "Draft",
        "status": "draft",
        "is_baseline": False,
        "is_official": False,
        "scope_type": "consolidated",
        "scope_id": "ALL",
        "as_of_period": "2026-06",
        "horizon_end": None,
        "assumptions": {"revenue_growth": {"value": 1.0, "unit": "%", "mode": "growth"}},
        "frozen_result": None,
        "engine_version": None,
        "parent_scenario_id": None,
        "created_by": "user",
    }
    pool = _ScriptedPool([
        {"contains": "SELECT scenario_id, name, status", "params": ("scn-1",), "fetchone": plan},
    ])
    monkeypatch.setattr(route, "_pool", lambda: pool)
    with pytest.raises(route.HTTPException) as exc:
        route.update_plan("scn-1", route.PatchBody(assumptions={"revenue_growth": float("inf")}))
    assert exc.value.status_code == 422
    assert "non-finite value" in exc.value.detail


def test_update_plan_normalizes_once_for_duplicate_check_and_persistence(monkeypatch):
    monkeypatch.setattr(route, "_ensure_schema", lambda: None)
    monkeypatch.setattr(route, "current_industry", lambda: "consumer")
    monkeypatch.setattr(route, "_dict_rows", lambda: None)
    plan = {
        "scenario_id": "scn-1",
        "name": "Draft",
        "status": "draft",
        "is_baseline": False,
        "is_official": False,
        "scope_type": "consolidated",
        "scope_id": "ALL",
        "as_of_period": "2026-06",
        "horizon_end": None,
        "assumptions": {"revenue_growth": {"value": 1.0, "unit": "%", "mode": "growth"}},
        "frozen_result": None,
        "engine_version": None,
        "parent_scenario_id": None,
        "created_by": "user",
    }
    pool = _ScriptedPool([
        {"contains": "SELECT scenario_id, name, status", "params": ("scn-1",), "fetchone": plan},
        {"contains": "pg_advisory_xact_lock", "params": ("consumer|2026-06|consolidated|ALL",)},
        {
            "contains": "FROM scenario_plans",
            "params": ("2026-06", "consolidated", "ALL"),
            "fetchall": [{
                "scenario_id": "scn-2",
                "name": "Peer",
                "status": "draft",
                "assumptions": {"revenue_growth": {"value": 4.0, "unit": "%", "mode": "growth"}},
            }],
        },
    ])
    monkeypatch.setattr(route, "_pool", lambda: pool)
    with pytest.raises(route.HTTPException) as exc:
        route.update_plan("scn-1", route.PatchBody(name="Renamed", assumptions={"revenue_growth": 4, "unknown": 999}))
    assert exc.value.status_code == 409
    assert exc.value.detail == 'This scenario matches "Peer". Change at least one driver.'


def test_update_plan_uses_atomic_locking_and_conditional_update(monkeypatch):
    monkeypatch.setattr(route, "_ensure_schema", lambda: None)
    monkeypatch.setattr(route, "current_industry", lambda: "consumer")
    monkeypatch.setattr(route, "_dict_rows", lambda: None)
    plan = {
        "scenario_id": "scn-1",
        "name": "Draft",
        "status": "draft",
        "is_baseline": False,
        "is_official": False,
        "scope_type": "consolidated",
        "scope_id": "ALL",
        "as_of_period": "2026-06",
        "horizon_end": None,
        "assumptions": {"revenue_growth": {"value": 1.0, "unit": "%", "mode": "growth"}},
        "frozen_result": None,
        "engine_version": None,
        "parent_scenario_id": None,
        "created_by": "user",
    }
    updated = dict(plan)
    updated["name"] = "New name"
    pool = _ScriptedPool([
        {"contains": "SELECT scenario_id, name, status", "params": ("scn-1",), "fetchone": plan},
        {"contains": "pg_advisory_xact_lock", "params": ("consumer|2026-06|consolidated|ALL",)},
        {"contains": "FROM scenario_plans", "params": ("2026-06", "consolidated", "ALL"), "fetchall": []},
        {"contains": "UPDATE scenario_plans SET", "params": ("New name", "scn-1"), "rowcount": 1},
        {"contains": "SELECT scenario_id, name, status", "params": ("scn-1",), "fetchone": updated},
    ])
    monkeypatch.setattr(route, "_pool", lambda: pool)
    out = route.update_plan("scn-1", route.PatchBody(name="New name"))
    assert out["name"] == "New name"
    sqls = [sql for sql, _ in pool.calls]
    assert "FOR UPDATE" in sqls[0]
    assert "status = 'draft'" in sqls[3]
    assert "FOR UPDATE" not in sqls[4]


def test_update_plan_conflicts_if_conditional_update_touches_no_row(monkeypatch):
    monkeypatch.setattr(route, "_ensure_schema", lambda: None)
    monkeypatch.setattr(route, "current_industry", lambda: "consumer")
    monkeypatch.setattr(route, "_dict_rows", lambda: None)
    plan = {
        "scenario_id": "scn-1",
        "name": "Draft",
        "status": "draft",
        "is_baseline": False,
        "is_official": False,
        "scope_type": "consolidated",
        "scope_id": "ALL",
        "as_of_period": "2026-06",
        "horizon_end": None,
        "assumptions": {"revenue_growth": {"value": 1.0, "unit": "%", "mode": "growth"}},
        "frozen_result": None,
        "engine_version": None,
        "parent_scenario_id": None,
        "created_by": "user",
    }
    pool = _ScriptedPool([
        {"contains": "SELECT scenario_id, name, status", "params": ("scn-1",), "fetchone": plan},
        {"contains": "pg_advisory_xact_lock", "params": ("consumer|2026-06|consolidated|ALL",)},
        {"contains": "FROM scenario_plans", "params": ("2026-06", "consolidated", "ALL"), "fetchall": []},
        {"contains": "UPDATE scenario_plans SET", "params": ("Name", "scn-1"), "rowcount": 0},
    ])
    monkeypatch.setattr(route, "_pool", lambda: pool)
    with pytest.raises(route.HTTPException) as exc:
        route.update_plan("scn-1", route.PatchBody(name="Name"))
    assert exc.value.status_code == 409
    assert exc.value.detail == "scenario is not a draft"


def test_commit_plan_rejects_baseline_equivalent_assumptions(monkeypatch):
    monkeypatch.setattr(route, "_ensure_schema", lambda: None)
    monkeypatch.setattr(route, "current_industry", lambda: "consumer")
    monkeypatch.setattr(route, "_dict_rows", lambda: None)
    plan = {
        "scenario_id": "scn-1",
        "name": "Draft",
        "status": "draft",
        "is_baseline": False,
        "is_official": False,
        "scope_type": "consolidated",
        "scope_id": "ALL",
        "as_of_period": "2026-06",
        "horizon_end": None,
        "assumptions": {},
        "frozen_result": None,
        "engine_version": None,
        "parent_scenario_id": None,
        "created_by": "user",
    }
    pool = _ScriptedPool([
        {"contains": "SELECT scenario_id, name, status", "params": ("scn-1",), "fetchone": plan},
        {"contains": "pg_advisory_xact_lock", "params": ("consumer|2026-06|consolidated|ALL",)},
        {"contains": "FROM scenario_plans", "params": ("2026-06", "consolidated", "ALL"), "fetchall": [plan]},
    ])
    monkeypatch.setattr(route, "_pool", lambda: pool)
    with pytest.raises(route.HTTPException) as exc:
        route.commit_plan("scn-1")
    assert exc.value.status_code == 409
    assert exc.value.detail == "This scenario matches Baseline. Change at least one driver."


def test_commit_plan_freezes_locked_assumptions_and_checks_conditional_status(monkeypatch):
    monkeypatch.setattr(route, "_ensure_schema", lambda: None)
    monkeypatch.setattr(route, "current_industry", lambda: "consumer")
    monkeypatch.setattr(route, "_dict_rows", lambda: None)
    monkeypatch.setattr(route, "get_baseline", lambda *args, **kwargs: _baseline())
    plan = {
        "scenario_id": "scn-1",
        "name": "Draft",
        "status": "draft",
        "is_baseline": False,
        "is_official": False,
        "scope_type": "consolidated",
        "scope_id": "ALL",
        "as_of_period": "2026-06",
        "horizon_end": None,
        "assumptions": {"revenue_growth": {"value": 3.0, "unit": "%", "mode": "growth"}},
        "frozen_result": None,
        "engine_version": None,
        "parent_scenario_id": None,
        "created_by": "user",
    }
    committed = dict(plan)
    committed["status"] = "committed"
    pool = _ScriptedPool([
        {"contains": "SELECT scenario_id, name, status", "params": ("scn-1",), "fetchone": plan},
        {"contains": "pg_advisory_xact_lock", "params": ("consumer|2026-06|consolidated|ALL",)},
        {"contains": "FROM scenario_plans", "params": ("2026-06", "consolidated", "ALL"), "fetchall": [plan]},
        {"contains": "UPDATE scenario_plans SET status = 'committed'", "rowcount": 1},
        {"contains": "SELECT scenario_id, name, status", "params": ("scn-1",), "fetchone": committed},
    ])
    monkeypatch.setattr(route, "_pool", lambda: pool)
    out = route.commit_plan("scn-1")
    assert out["status"] == "committed"
    update_sql, update_params = pool.calls[3]
    assert "status = 'draft'" in update_sql
    assert update_params[-1] == "scn-1"


def test_compare_rejects_when_requested_duplicates_unselected_scenario(monkeypatch):
    monkeypatch.setattr(route, "_ensure_schema", lambda: None)
    monkeypatch.setattr(route, "_dict_rows", lambda: None)
    monkeypatch.setattr(route, "get_baseline", lambda *args, **kwargs: _baseline())
    pool = _ScriptedPool([
        {
            "contains": "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
        },
        {
            "contains": "WHERE scenario_id = ANY(%s)",
            "params": (["scn-a"],),
            "fetchall": [{
                "scenario_id": "scn-a",
                "name": "A",
                "status": "draft",
                "is_baseline": False,
                "is_official": False,
                "scope_type": "consolidated",
                "scope_id": "ALL",
                "as_of_period": "2026-06",
                "horizon_end": None,
                "assumptions": {"revenue_growth": {"value": 4.0, "unit": "%", "mode": "growth"}},
                "frozen_result": None,
                "engine_version": None,
                "parent_scenario_id": None,
                "created_by": "user",
            }],
        },
        {
            "contains": "FROM scenario_plans",
            "params": ("2026-06", "consolidated", "ALL"),
            "fetchall": [
                {
                    "scenario_id": "scn-a",
                    "name": "A",
                    "status": "draft",
                    "is_baseline": False,
                    "scope_type": "consolidated",
                    "scope_id": "ALL",
                    "as_of_period": "2026-06",
                    "assumptions": {"revenue_growth": {"value": 4.0, "unit": "%", "mode": "growth"}},
                },
                {
                    "scenario_id": "scn-hidden",
                    "name": "Hidden duplicate",
                    "status": "draft",
                    "is_baseline": False,
                    "scope_type": "consolidated",
                    "scope_id": "ALL",
                    "as_of_period": "2026-06",
                    "assumptions": {"revenue_growth": {"value": 4.0, "unit": "%", "mode": "growth"}},
                },
            ],
        },
    ])
    monkeypatch.setattr(route, "_pool", lambda: pool)
    with pytest.raises(route.HTTPException) as exc:
        route.compare_plans(ids=["scn-a"])
    assert exc.value.status_code == 409
    assert exc.value.detail == 'This scenario matches "Hidden duplicate". Change at least one driver.'


def test_compare_rejects_archived_plan_ids(monkeypatch):
    monkeypatch.setattr(route, "_ensure_schema", lambda: None)
    monkeypatch.setattr(route, "_dict_rows", lambda: None)
    monkeypatch.setattr(route, "get_baseline", lambda *args, **kwargs: _baseline())
    pool = _ScriptedPool([
        {"contains": "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"},
        {
            "contains": "WHERE scenario_id = ANY(%s)",
            "params": (["scn-archived"],),
            "fetchall": [{
                "scenario_id": "scn-archived",
                "name": "Archived",
                "status": "archived",
                "is_baseline": False,
                "is_official": False,
                "scope_type": "consolidated",
                "scope_id": "ALL",
                "as_of_period": "2026-06",
                "horizon_end": None,
                "assumptions": {"revenue_growth": {"value": 4.0, "unit": "%", "mode": "growth"}},
                "frozen_result": None,
                "engine_version": None,
                "parent_scenario_id": None,
                "created_by": "user",
            }],
        },
    ])
    monkeypatch.setattr(route, "_pool", lambda: pool)
    with pytest.raises(route.HTTPException) as exc:
        route.compare_plans(ids=["scn-archived"])
    assert exc.value.status_code == 409
    assert exc.value.detail == "scenario is archived and cannot be compared"


def test_compare_preserves_requested_order(monkeypatch):
    monkeypatch.setattr(route, "_ensure_schema", lambda: None)
    monkeypatch.setattr(route, "_dict_rows", lambda: None)
    monkeypatch.setattr(route, "get_baseline", lambda *args, **kwargs: _baseline())
    pool = _ScriptedPool([
        {"contains": "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"},
        {
            "contains": "WHERE scenario_id = ANY(%s)",
            "params": (["scn-b", "scn-a"],),
            "fetchall": [
                {
                    "scenario_id": "scn-a",
                    "name": "A",
                    "status": "draft",
                    "is_baseline": False,
                    "is_official": False,
                    "scope_type": "consolidated",
                    "scope_id": "ALL",
                    "as_of_period": "2026-06",
                    "horizon_end": None,
                    "assumptions": {"revenue_growth": {"value": 1.0, "unit": "%", "mode": "growth"}},
                    "frozen_result": None,
                    "engine_version": None,
                    "parent_scenario_id": None,
                    "created_by": "user",
                },
                {
                    "scenario_id": "scn-b",
                    "name": "B",
                    "status": "draft",
                    "is_baseline": False,
                    "is_official": False,
                    "scope_type": "consolidated",
                    "scope_id": "ALL",
                    "as_of_period": "2026-06",
                    "horizon_end": None,
                    "assumptions": {"revenue_growth": {"value": 2.0, "unit": "%", "mode": "growth"}},
                    "frozen_result": None,
                    "engine_version": None,
                    "parent_scenario_id": None,
                    "created_by": "user",
                },
            ],
        },
        {
            "contains": "FROM scenario_plans",
            "params": ("2026-06", "consolidated", "ALL"),
            "fetchall": [
                {
                    "scenario_id": "scn-a",
                    "name": "A",
                    "status": "draft",
                    "is_baseline": False,
                    "scope_type": "consolidated",
                    "scope_id": "ALL",
                    "as_of_period": "2026-06",
                    "assumptions": {"revenue_growth": {"value": 1.0, "unit": "%", "mode": "growth"}},
                },
                {
                    "scenario_id": "scn-b",
                    "name": "B",
                    "status": "draft",
                    "is_baseline": False,
                    "scope_type": "consolidated",
                    "scope_id": "ALL",
                    "as_of_period": "2026-06",
                    "assumptions": {"revenue_growth": {"value": 2.0, "unit": "%", "mode": "growth"}},
                },
            ],
        },
    ])
    monkeypatch.setattr(route, "_pool", lambda: pool)
    out = route.compare_plans(ids=["scn-b", "scn-a"])
    assert [s["scenario_id"] for s in out["scenarios"]] == ["scn-b", "scn-a"]


def test_compare_rejects_unverified_non_baseline_candidate(monkeypatch):
    monkeypatch.setattr(route, "_ensure_schema", lambda: None)
    monkeypatch.setattr(route, "_dict_rows", lambda: None)
    monkeypatch.setattr(route, "get_baseline", lambda *args, **kwargs: _baseline())
    pool = _ScriptedPool([
        {"contains": "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"},
        {
            "contains": "WHERE scenario_id = ANY(%s)",
            "params": (["scn-a"],),
            "fetchall": [{
                "scenario_id": "scn-a",
                "name": "A",
                "status": "draft",
                "is_baseline": False,
                "is_official": False,
                "scope_type": "consolidated",
                "scope_id": "ALL",
                "as_of_period": "2026-06",
                "horizon_end": None,
                "assumptions": {"revenue_growth": {"value": 1.0, "unit": "%", "mode": "growth"}},
                "frozen_result": None,
                "engine_version": None,
                "parent_scenario_id": None,
                "created_by": "user",
            }],
        },
        {"contains": "FROM scenario_plans", "params": ("2026-06", "consolidated", "ALL"), "fetchall": []},
    ])
    monkeypatch.setattr(route, "_pool", lambda: pool)
    with pytest.raises(route.HTTPException) as exc:
        route.compare_plans(ids=["scn-a"])
    assert exc.value.status_code == 409
    assert exc.value.detail == "scenario eligibility could not be verified"


def test_compare_uses_single_connection_repeatable_read_snapshot(monkeypatch):
    monkeypatch.setattr(route, "_ensure_schema", lambda: None)
    monkeypatch.setattr(route, "_dict_rows", lambda: None)
    monkeypatch.setattr(route, "get_baseline", lambda *args, **kwargs: _baseline())
    pool = _ScriptedPool([
        {"contains": "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"},
        {
            "contains": "WHERE scenario_id = ANY(%s)",
            "params": (["scn-a"],),
            "fetchall": [{
                "scenario_id": "scn-a",
                "name": "A",
                "status": "draft",
                "is_baseline": False,
                "is_official": False,
                "scope_type": "consolidated",
                "scope_id": "ALL",
                "as_of_period": "2026-06",
                "horizon_end": None,
                "assumptions": {"revenue_growth": {"value": 1.0, "unit": "%", "mode": "growth"}},
                "frozen_result": None,
                "engine_version": None,
                "parent_scenario_id": None,
                "created_by": "user",
            }],
        },
        {
            "contains": "FROM scenario_plans",
            "params": ("2026-06", "consolidated", "ALL"),
            "fetchall": [{
                "scenario_id": "scn-a",
                "name": "A",
                "status": "draft",
                "is_baseline": False,
                "scope_type": "consolidated",
                "scope_id": "ALL",
                "as_of_period": "2026-06",
                "assumptions": {"revenue_growth": {"value": 1.0, "unit": "%", "mode": "growth"}},
            }],
        },
    ])
    monkeypatch.setattr(route, "_pool", lambda: pool)
    route.compare_plans(ids=["scn-a"])
    assert len(pool.calls) == 3


def test_list_plans_status_filter_uses_all_active_candidates(monkeypatch):
    monkeypatch.setattr(route, "_ensure_schema", lambda: None)
    monkeypatch.setattr(route, "_dict_rows", lambda: None)
    pool = _ScriptedPool([
        {
            "contains": "FROM scenario_plans",
            "params": ("2026-06",),
            "fetchall": [
                {
                    "scenario_id": "seed-base-2026-06",
                    "name": "Base",
                    "status": "baseline",
                    "is_baseline": True,
                    "is_official": False,
                    "scope_type": "consolidated",
                    "scope_id": "ALL",
                    "as_of_period": "2026-06",
                    "assumptions": {},
                    "created_by": "system",
                    "updated_ts": "2026-06-01T00:00:00Z",
                },
                {
                    "scenario_id": "scn-committed",
                    "name": "Committed duplicate",
                    "status": "committed",
                    "is_baseline": False,
                    "is_official": False,
                    "scope_type": "consolidated",
                    "scope_id": "ALL",
                    "as_of_period": "2026-06",
                    "assumptions": {"revenue_growth": {"value": 2.0, "unit": "%", "mode": "growth"}},
                    "created_by": "user",
                    "updated_ts": "2026-06-02T00:00:00Z",
                },
                {
                    "scenario_id": "scn-draft",
                    "name": "Draft duplicate",
                    "status": "draft",
                    "is_baseline": False,
                    "is_official": False,
                    "scope_type": "consolidated",
                    "scope_id": "ALL",
                    "as_of_period": "2026-06",
                    "assumptions": {"revenue_growth": {"value": 2.0, "unit": "%", "mode": "growth"}},
                    "created_by": "user",
                    "updated_ts": "2026-06-03T00:00:00Z",
                },
                {
                    "scenario_id": "scn-archived",
                    "name": "Archived duplicate",
                    "status": "archived",
                    "is_baseline": False,
                    "is_official": False,
                    "scope_type": "consolidated",
                    "scope_id": "ALL",
                    "as_of_period": "2026-06",
                    "assumptions": {"revenue_growth": {"value": 2.0, "unit": "%", "mode": "growth"}},
                    "created_by": "user",
                    "updated_ts": "2026-06-04T00:00:00Z",
                },
            ],
        },
    ])
    monkeypatch.setattr(route, "_pool", lambda: pool)
    out = route.list_plans(period=None, status="draft")
    assert [p["scenario_id"] for p in out["plans"]] == ["scn-draft"]
    assert out["plans"][0]["compare_eligible"] is False
    assert out["plans"][0]["compare_block_reason"] == (
        'This scenario matches "Committed duplicate". Change at least one driver.'
    )
    for sql, _ in pool.calls:
        assert "status <> 'archived'" in sql
