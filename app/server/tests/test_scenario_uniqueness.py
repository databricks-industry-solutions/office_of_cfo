from __future__ import annotations

import pathlib
import sys

_APP = pathlib.Path(__file__).resolve().parents[2]
if str(_APP) not in sys.path:
    sys.path.insert(0, str(_APP))

from server.scenario_uniqueness import (  # noqa: E402
    assumption_signature,
    decorate_compare_eligibility,
    duplicate_match,
)


def test_assumption_signature_is_key_order_independent():
    left = {"revenue_growth": 5, "dso": {"value": 2}}
    right = {"dso": {"value": 2.0}, "revenue_growth": 5.0}
    assert assumption_signature(left) == assumption_signature(right)
    assert assumption_signature(left) == (("dso", 2.0), ("revenue_growth", 5.0))


def test_assumption_signature_drops_explicit_zero_and_empty_equals_baseline():
    assert assumption_signature(None) == ()
    assert assumption_signature({}) == ()
    assert assumption_signature({"revenue_growth": 0, "dso": {"value": 0.0}}) == ()


def test_duplicate_match_excludes_self_and_archived_candidates():
    sig = assumption_signature({"revenue_growth": 4})
    candidates = [
        {"scenario_id": "scn-self", "name": "Self", "status": "draft", "assumptions": {"revenue_growth": 4}},
        {"scenario_id": "scn-archived", "name": "Archived", "status": "archived", "assumptions": {"revenue_growth": 4}},
        {"scenario_id": "scn-live", "name": "Live", "status": "committed", "assumptions": {"revenue_growth": 4}},
    ]
    hit = duplicate_match("scn-self", sig, candidates)
    assert hit is not None
    assert hit["scenario_id"] == "scn-live"


def test_decorate_compare_eligibility_marks_baseline_empty_and_duplicates():
    plans = [
        {"scenario_id": "seed-base-1", "name": "Base", "is_baseline": True, "assumptions": {}},
        {"scenario_id": "scn-empty", "name": "Empty", "is_baseline": False, "assumptions": {}},
        {"scenario_id": "scn-a", "name": "A", "is_baseline": False, "assumptions": {"revenue_growth": 4}},
        {"scenario_id": "scn-b", "name": "B", "is_baseline": False, "assumptions": {"revenue_growth": {"value": 4.0}}},
        {"scenario_id": "scn-c", "name": "C", "is_baseline": False, "assumptions": {"revenue_growth": 5}},
    ]
    out = decorate_compare_eligibility(plans)
    by_id = {p["scenario_id"]: p for p in out}
    assert by_id["seed-base-1"]["compare_eligible"] is True
    assert by_id["scn-empty"]["compare_eligible"] is False
    assert by_id["scn-empty"]["compare_block_reason"] == "This scenario matches Baseline. Change at least one driver."
    assert by_id["scn-a"]["compare_eligible"] is False
    assert by_id["scn-a"]["compare_block_reason"] == 'This scenario matches "B". Change at least one driver.'
    assert by_id["scn-b"]["compare_eligible"] is False
    assert by_id["scn-c"]["compare_eligible"] is True


def test_decorate_compare_eligibility_isolated_by_period_and_scope():
    plans = [
        {
            "scenario_id": "scn-one",
            "name": "One",
            "is_baseline": False,
            "as_of_period": "2026-06",
            "scope_type": "consolidated",
            "scope_id": "ALL",
            "assumptions": {"revenue_growth": 4},
        },
        {
            "scenario_id": "scn-two",
            "name": "Two",
            "is_baseline": False,
            "as_of_period": "2026-07",
            "scope_type": "consolidated",
            "scope_id": "ALL",
            "assumptions": {"revenue_growth": 4},
        },
        {
            "scenario_id": "scn-three",
            "name": "Three",
            "is_baseline": False,
            "as_of_period": "2026-06",
            "scope_type": "bu",
            "scope_id": "BU-100",
            "assumptions": {"revenue_growth": 4},
        },
    ]
    out = decorate_compare_eligibility(plans)
    assert all(plan["compare_eligible"] for plan in out)


def test_assumption_signature_ignores_nonfinite_values():
    sig = assumption_signature({"revenue_growth": float("nan"), "dso": float("inf"), "dio": 3})
    assert sig == (("dio", 3.0),)


def test_decorate_compare_eligibility_ignores_archived_in_duplicate_grouping():
    plans = [
        {
            "scenario_id": "scn-live",
            "name": "Live",
            "status": "draft",
            "is_baseline": False,
            "as_of_period": "2026-06",
            "scope_type": "consolidated",
            "scope_id": "ALL",
            "assumptions": {"revenue_growth": 4},
        },
        {
            "scenario_id": "scn-archived",
            "name": "Archived twin",
            "status": "archived",
            "is_baseline": False,
            "as_of_period": "2026-06",
            "scope_type": "consolidated",
            "scope_id": "ALL",
            "assumptions": {"revenue_growth": 4},
        },
    ]
    out = decorate_compare_eligibility(plans)
    by_id = {p["scenario_id"]: p for p in out}
    assert by_id["scn-live"]["compare_eligible"] is True
