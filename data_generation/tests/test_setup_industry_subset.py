"""setup.py --industries limits every per-industry step to those industries.

An industry that was left out has no schemas, so a step that still loops over all
five fails on the first missing one. Runs the steps offline with the workspace
calls stubbed out and records what each one touched.
"""
from __future__ import annotations

import importlib.util
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("setup_script", ROOT / "scripts" / "setup.py")
setup_script = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(setup_script)

SUBSET = ("consumer", "energy")


def _setup(tmp_path):
    args = types.SimpleNamespace(profile=None, target="test", var=[])
    s = setup_script.Setup(args)
    s.state_dir = tmp_path
    s.assets_file = tmp_path / "ai_roi_assets.json"
    s.overrides_file = tmp_path / "variable-overrides.json"
    s.industries = SUBSET
    s._summary = {"variables": {"catalog": {"value": "cat"}, "app_name": {"value": "app"}},
                  "resources": {"sql_warehouses": {setup_script.WAREHOUSE_KEY: {"id": "wh"}}}}
    calls: list[tuple] = []
    s.script = lambda path, *a, env=None: calls.append((path, a))
    s.set_permissions = lambda *a, **k: None
    s.app_sp = lambda: "sp"
    s._self_service_space = lambda ind: (calls.append(("space", (ind,))), {})[1]
    s._w = types.SimpleNamespace(api_client=types.SimpleNamespace(do=lambda *a, **k: {"space_id": "id"}))
    s.env = lambda: {}
    return s, calls


def _industries_touched(calls):
    touched = set()
    for _, args in calls:
        touched |= {a for a in args if a in setup_script.INDUSTRIES}
    return touched


def test_genie_step_only_touches_installed_industries(tmp_path):
    s, calls = _setup(tmp_path)
    s.step_genie()
    assert _industries_touched(calls) == set(SUBSET)
    assert ("genie/ai_roi/build.py", ("--catalog", "cat", *SUBSET)) in calls


def test_dashboards_and_seeding_only_touch_installed_industries(tmp_path):
    s, calls = _setup(tmp_path)
    s.step_dashboards()
    s.step_industries()
    assert _industries_touched(calls) == set(SUBSET)


def test_app_values_cover_every_industry(tmp_path):
    """The app env names every industry, so the ones left out get a placeholder
    rather than an empty value (which starting the app rejects)."""
    s, _ = _setup(tmp_path)
    values = s.app_vars()
    assert values["genie_space_software"] == setup_script.NOT_INSTALLED
    assert values["genie_space_consumer"] == ""   # installed, not created yet
