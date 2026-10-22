"""Guardrail: the adjustment auto-approval engine must only ever auto-approve
what the Controller's policy actually permits.

`evaluate_policy` is the single gate between "a human reviews this journal" and
"this journal signs itself off and hits the ledger", so every rule is tested
passing AND failing in isolation, plus the global kill switch, the disabled-rule
skip, and the cumulative-cap boundary. A rule that stops being enforced fails the
build.

Pure unit tests — no database, no warehouse, no network.

Run under pytest, or standalone: `python app/server/tests/test_policy_engine.py`.
"""
from __future__ import annotations

import copy
import pathlib
import sys
from datetime import date

# Make `server` importable whether run via pytest or directly (.../app on path).
_APP = pathlib.Path(__file__).resolve().parents[2]
if str(_APP) not in sys.path:
    sys.path.insert(0, str(_APP))

from server.policy import (  # noqa: E402
    DEFAULT_POLICY, RULE_IDS, SEED_DISABLED_RULES, Decision, close_business_day,
    default_policy_for, evaluate_policy, normalize_policy, policy_diff,
)

BREAK_REF = "11000/BU-100"


def _policy(**rule_overrides) -> dict:
    """The default policy with optional per-rule parameter overrides."""
    p = copy.deepcopy(DEFAULT_POLICY)
    for rule_id, changes in rule_overrides.items():
        p["rules"][rule_id].update(changes)
    return p


def _adjustment(**overrides) -> dict:
    """A fully policy-conforming adjustment: a break-backed accrual, well under
    the amount limit, on unrestricted accounts, with a real memo."""
    adj = {
        "amount": 12_400.0,
        "business_unit_id": "BU-100",
        "debit_account": "21000",
        "debit_account_type": "Liability",
        "credit_account": "60000",
        "credit_account_type": "Expense",
        "adjustment_type": "accrual",
        "memo": "Accrue November services invoice received after cutoff",
        "resolves_break": BREAK_REF,
    }
    adj.update(overrides)
    return adj


def _state(**overrides) -> dict:
    state = {
        "break_amounts": {BREAK_REF: 12_400.0},
        "auto_approved_totals": {},
        "close_bd": 3,
    }
    state.update(overrides)
    return state


# ---------------------------------------------------------------------------
# Baseline + global behaviour
# ---------------------------------------------------------------------------
def test_conforming_adjustment_is_auto_approved():
    d = evaluate_policy(_adjustment(), _policy(), _state())
    assert d.mode == "auto", d.reasons()
    assert d.broken_rules == []
    assert d.is_auto
    # Every rule is enabled by default, so all seven must have been evaluated.
    assert {e.rule for e in d.evaluations} == set(RULE_IDS)
    assert all(e.passed for e in d.evaluations)


def test_kill_switch_forces_manual_even_when_every_rule_would_pass():
    p = _policy()
    p["auto_approval_enabled"] = False
    d = evaluate_policy(_adjustment(), p, _state())
    assert d.mode == "manual"
    assert d.disabled is True
    assert d.evaluations == []


def test_missing_policy_is_treated_as_no_automation():
    for policy in (None, {}):
        d = evaluate_policy(_adjustment(), policy, _state())
        assert d.mode == "manual"
        assert d.disabled is True


def test_disabled_rule_is_skipped_not_failed():
    # An adjustment that would break amount_limit passes once the rule is off.
    adj = _adjustment(amount=90_000.0)
    broken = evaluate_policy(adj, _policy(), _state(break_amounts={BREAK_REF: 90_000.0}))
    assert "amount_limit" in broken.broken_rules

    p = _policy(amount_limit={"enabled": False})
    d = evaluate_policy(adj, p, _state(break_amounts={BREAK_REF: 90_000.0}))
    assert d.mode == "auto", d.reasons()
    assert "amount_limit" not in {e.rule for e in d.evaluations}


def test_multiple_broken_rules_are_all_reported_in_rule_order():
    adj = _adjustment(amount=96_000.0, credit_account="40000",
                      credit_account_type="Revenue", resolves_break=None)
    d = evaluate_policy(adj, _policy(), _state())
    assert d.mode == "manual"
    assert d.broken_rules == ["amount_limit", "account_policy", "break_backed"]
    assert len(d.reasons()) == 3


# ---------------------------------------------------------------------------
# Rule 1 — amount_limit
# ---------------------------------------------------------------------------
def test_amount_limit_passes_at_the_limit_and_fails_above():
    st = _state(break_amounts={BREAK_REF: 25_000.0})
    at_limit = evaluate_policy(_adjustment(amount=25_000.0), _policy(), st)
    assert "amount_limit" not in at_limit.broken_rules

    st_over = _state(break_amounts={BREAK_REF: 25_000.01})
    over = evaluate_policy(_adjustment(amount=25_000.01), _policy(), st_over)
    assert over.broken_rules == ["amount_limit"]


def test_amount_limit_honours_per_bu_override():
    p = _policy(amount_limit={"max_amount": 25_000.0, "bu_overrides": {"BU-900": 100_000.0}})
    st = _state(break_amounts={BREAK_REF: 80_000.0})
    corporate = evaluate_policy(
        _adjustment(amount=80_000.0, business_unit_id="BU-900"), p, st)
    assert "amount_limit" not in corporate.broken_rules

    other = evaluate_policy(_adjustment(amount=80_000.0, business_unit_id="BU-100"), p, st)
    assert "amount_limit" in other.broken_rules


# ---------------------------------------------------------------------------
# Rule 2 — account_policy
# ---------------------------------------------------------------------------
def test_restricted_account_type_blocks_auto_approval():
    d = evaluate_policy(
        _adjustment(credit_account="40000", credit_account_type="Revenue"),
        _policy(), _state())
    assert d.broken_rules == ["account_policy"]
    assert "40000" in d.reasons()[0]


def test_restricted_account_code_blocks_auto_approval():
    p = _policy(account_policy={"restricted_account_types": [], "restricted_accounts": ["21000"]})
    d = evaluate_policy(_adjustment(), p, _state())
    assert d.broken_rules == ["account_policy"]


def test_debit_side_is_checked_too():
    d = evaluate_policy(
        _adjustment(debit_account="31000", debit_account_type="Equity"),
        _policy(), _state())
    assert d.broken_rules == ["account_policy"]


def test_unrestricted_accounts_pass():
    d = evaluate_policy(_adjustment(), _policy(), _state())
    assert "account_policy" not in d.broken_rules


# ---------------------------------------------------------------------------
# Rule 3 — type_allowlist
# ---------------------------------------------------------------------------
def test_allowed_type_passes_and_unknown_type_fails():
    ok = evaluate_policy(_adjustment(adjustment_type="reclass"), _policy(), _state())
    assert "type_allowlist" not in ok.broken_rules

    bad = evaluate_policy(_adjustment(adjustment_type="writeoff"), _policy(), _state())
    assert bad.broken_rules == ["type_allowlist"]


def test_absent_type_fails_when_the_rule_is_enabled():
    for missing in (None, "", "   "):
        d = evaluate_policy(_adjustment(adjustment_type=missing), _policy(), _state())
        assert d.broken_rules == ["type_allowlist"], missing
        assert "No adjustment type set" in d.reasons()[0]


def test_type_not_in_a_narrowed_allowlist_fails():
    p = _policy(type_allowlist={"allowed_types": ["reclass"]})
    d = evaluate_policy(_adjustment(adjustment_type="accrual"), p, _state())
    assert d.broken_rules == ["type_allowlist"]


# ---------------------------------------------------------------------------
# Rule 4 — break_backed
# ---------------------------------------------------------------------------
def test_break_backed_requires_a_break_reference():
    d = evaluate_policy(_adjustment(resolves_break=None), _policy(), _state())
    assert d.broken_rules == ["break_backed"]


def test_break_backed_fails_when_the_referenced_break_is_unknown():
    d = evaluate_policy(_adjustment(resolves_break="99999/BU-700"), _policy(), _state())
    assert d.broken_rules == ["break_backed"]
    assert "No open break found" in d.reasons()[0]


def test_break_backed_tolerance_boundary():
    # 5% of 10,000 is 500: 10,500 is inside, 10,501 is outside.
    st = _state(break_amounts={BREAK_REF: 10_000.0})
    inside = evaluate_policy(_adjustment(amount=10_500.0), _policy(), st)
    assert "break_backed" not in inside.broken_rules

    outside = evaluate_policy(_adjustment(amount=10_501.0), _policy(), st)
    assert outside.broken_rules == ["break_backed"]


def test_break_backed_matches_absolute_variance_regardless_of_sign():
    st = _state(break_amounts={BREAK_REF: -12_400.0})
    d = evaluate_policy(_adjustment(amount=12_400.0), _policy(), st)
    assert "break_backed" not in d.broken_rules


def test_zero_amount_break_requires_an_exact_match():
    st = _state(break_amounts={BREAK_REF: 0.0})
    exact = evaluate_policy(_adjustment(amount=0.0), _policy(), st)
    assert "break_backed" not in exact.broken_rules

    off = evaluate_policy(_adjustment(amount=1.0), _policy(), st)
    assert "break_backed" in off.broken_rules


# ---------------------------------------------------------------------------
# Rule 5 — memo_required
# ---------------------------------------------------------------------------
def test_memo_length_boundary():
    p = _policy(memo_required={"min_chars": 12})
    exact = evaluate_policy(_adjustment(memo="a" * 12), p, _state())
    assert "memo_required" not in exact.broken_rules

    short = evaluate_policy(_adjustment(memo="a" * 11), p, _state())
    assert short.broken_rules == ["memo_required"]


def test_whitespace_only_memo_fails():
    d = evaluate_policy(_adjustment(memo="        "), _policy(), _state())
    assert d.broken_rules == ["memo_required"]


# ---------------------------------------------------------------------------
# Rule 6 — period_window
# ---------------------------------------------------------------------------
def test_period_window_boundary():
    p = _policy(period_window={"max_bd": 8})
    inside = evaluate_policy(_adjustment(), p, _state(close_bd=8))
    assert "period_window" not in inside.broken_rules

    outside = evaluate_policy(_adjustment(), p, _state(close_bd=9))
    assert outside.broken_rules == ["period_window"]


def test_close_business_day_is_zero_before_and_counts_weekdays_after_cutoff():
    # 2025-11-30 is a Sunday, so the cutoff T is Friday 2025-11-28.
    assert close_business_day("2025-11", date(2025, 11, 20)) == 0
    assert close_business_day("2025-11", date(2025, 11, 28)) == 0
    assert close_business_day("2025-11", date(2025, 11, 29)) == 0   # Saturday
    assert close_business_day("2025-11", date(2025, 12, 1)) == 1    # Monday
    assert close_business_day("2025-11", date(2025, 12, 5)) == 5    # Friday
    assert close_business_day("2025-12", date(2025, 12, 31)) == 0


# ---------------------------------------------------------------------------
# Rule 7 — cumulative_cap
# ---------------------------------------------------------------------------
def test_cumulative_cap_boundary_crossing_entry_routes_to_review():
    p = _policy(cumulative_cap={"max_total": 100_000.0},
                amount_limit={"max_amount": 100_000.0, "bu_overrides": {}})
    st = _state(break_amounts={BREAK_REF: 10_000.0},
                auto_approved_totals={"BU-100": 90_000.0})

    # The entry that lands exactly on the cap is fine...
    at_cap = evaluate_policy(_adjustment(amount=10_000.0), p, st)
    assert "cumulative_cap" not in at_cap.broken_rules, at_cap.reasons()

    # ...the one that crosses it is not.
    st_over = _state(break_amounts={BREAK_REF: 10_001.0},
                     auto_approved_totals={"BU-100": 90_000.0})
    over = evaluate_policy(_adjustment(amount=10_001.0), p, st_over)
    assert over.broken_rules == ["cumulative_cap"]


def test_cumulative_cap_is_tracked_per_business_unit():
    p = _policy(cumulative_cap={"max_total": 100_000.0})
    st = _state(auto_approved_totals={"BU-200": 99_000.0})
    d = evaluate_policy(_adjustment(business_unit_id="BU-100"), p, st)
    assert "cumulative_cap" not in d.broken_rules


# ---------------------------------------------------------------------------
# Audit record + policy hygiene
# ---------------------------------------------------------------------------
def test_decision_detail_captures_parameters_as_they_stood():
    p = _policy(amount_limit={"max_amount": 25_000.0, "bu_overrides": {}})
    d = evaluate_policy(_adjustment(), p, _state())
    detail = d.as_detail(p, policy_version=4)

    assert detail["mode"] == "auto"
    assert detail["policy_version"] == 4
    assert detail["auto_approval_enabled"] is True
    by_rule = {e["rule"]: e for e in detail["evaluations"]}
    # The limit in force at decision time is frozen into the record, so a later
    # policy change cannot rewrite why this entry passed.
    assert by_rule["amount_limit"]["parameter"] == 25_000.0
    assert by_rule["amount_limit"]["observed"] == 12_400.0
    assert by_rule["amount_limit"]["label"] == "Amount limit"


def test_normalize_policy_drops_unknown_rules_and_restores_missing_ones():
    normalized = normalize_policy({
        "name": "Custom",
        "auto_approval_enabled": True,
        "rules": {
            "amount_limit": {"enabled": True, "max_amount": 5_000.0, "sneaky": True},
            "not_a_real_rule": {"enabled": True},
        },
    })
    assert set(normalized["rules"]) == set(RULE_IDS)
    assert normalized["rules"]["amount_limit"]["max_amount"] == 5_000.0
    assert "sneaky" not in normalized["rules"]["amount_limit"]
    assert "not_a_real_rule" not in normalized["rules"]
    # A rule the payload omitted comes back at its default, never wide open.
    assert normalized["rules"]["break_backed"] == DEFAULT_POLICY["rules"]["break_backed"]


def test_normalize_policy_defaults_automation_off_when_unstated():
    assert normalize_policy({})["auto_approval_enabled"] is False


def test_seed_policy_leaves_the_window_rule_off_but_enforceable():
    """`close_bd` is measured against the pinned CLOSE_PERIOD, so the window rule
    ships off — but it must stay a real, enforced rule the moment it is enabled."""
    from server.industry import INDUSTRIES

    for industry in INDUSTRIES:
        seeded = default_policy_for(industry)
        for rule_id in SEED_DISABLED_RULES:
            assert seeded["rules"][rule_id]["enabled"] is False, industry
        # Every other rule ships on, so automation is governed from day one.
        assert all(seeded["rules"][r]["enabled"] for r in RULE_IDS
                   if r not in SEED_DISABLED_RULES), industry
        d = evaluate_policy(_adjustment(), seeded, _state(close_bd=999))
        assert d.mode == "auto", (industry, d.reasons())

    turned_on = default_policy_for("consumer")
    turned_on["rules"]["period_window"]["enabled"] = True
    late = evaluate_policy(_adjustment(), turned_on, _state(close_bd=999))
    assert late.broken_rules == ["period_window"]


def test_fsi_seeds_a_tighter_posture_than_consumer():
    fsi, consumer = default_policy_for("fsi"), default_policy_for("consumer")
    assert fsi["name"] == "Delegated Approval Authority"
    assert fsi["rules"]["break_backed"]["tolerance_pct"] < consumer["rules"]["break_backed"]["tolerance_pct"]
    assert fsi["rules"]["memo_required"]["min_chars"] > consumer["rules"]["memo_required"]["min_chars"]
    # The amount limit is deliberately identical: all industries clone the same
    # transactional data, so an identical entry must decide identically.
    assert fsi["rules"]["amount_limit"]["max_amount"] == consumer["rules"]["amount_limit"]["max_amount"]


def test_policy_diff_reports_readable_changes():
    old = _policy()
    new = _policy(amount_limit={"max_amount": 50_000.0})
    diff = policy_diff(old, new)
    assert any("Amount limit" in line and "50000" in line.replace(",", "")
               for line in diff)
    assert policy_diff(None, new) == ["Initial version"]
    assert policy_diff(old, _policy()) == ["No changes"]


def test_decision_default_is_manual():
    assert Decision(mode="manual").is_auto is False


# ---------------------------------------------------------------------------
# Standalone runner (no pytest required)
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    tests = [(n, o) for n, o in sorted(globals().items())
             if n.startswith("test_") and callable(o)]
    failures: list[str] = []
    for name, fn in tests:
        try:
            fn()
            print(f"PASS {name}")
        except AssertionError as exc:
            failures.append(f"{name}: {exc}")
            print(f"FAIL {name}: {exc}")
        except Exception as exc:  # noqa: BLE001
            failures.append(f"{name}: {type(exc).__name__}: {exc}")
            print(f"ERROR {name}: {type(exc).__name__}: {exc}")
    print(f"\n{len(tests) - len(failures)}/{len(tests)} policy-engine tests passed")
    raise SystemExit(1 if failures else 0)
