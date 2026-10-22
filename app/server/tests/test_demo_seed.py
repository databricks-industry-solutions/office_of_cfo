"""Guardrail: the demo seeder must produce a demo-ready Approvals queue without
inventing audit records, and must not judge a batch as if it were a snapshot.

The seeder is the one place that posts many adjustments at once, so two things
have to hold that the single-entry POST never exercises:

1. Every entry is decided by the real policy engine, and the batch is judged as a
   sequence — folding each auto-approval back into the period state, so the
   cumulative cap and break-backed rules see the period its predecessors made. A
   snapshot would let the whole batch auto-approve past the cap.
2. The plan spans rules, types and both sides of the amount limit, so the charts
   on the Approvals page have something to show.

Pure unit tests — no database, no warehouse, no network. The warehouse read inside
`gather` is stubbed.

Run under pytest, or standalone: `python app/server/tests/test_demo_seed.py`.
"""
from __future__ import annotations

import copy
import pathlib
import random
import sys

_APP = pathlib.Path(__file__).resolve().parents[2]
if str(_APP) not in sys.path:
    sys.path.insert(0, str(_APP))

from server import demo_seed  # noqa: E402
from server.policy import DEFAULT_POLICY, evaluate_policy  # noqa: E402

ACCOUNTS = [
    {"account_code": "50000", "account_type": "Expense", "normal_balance": "D"},
    {"account_code": "50100", "account_type": "Expense", "normal_balance": "D"},
    {"account_code": "50200", "account_type": "Expense", "normal_balance": "D"},
    {"account_code": "13000", "account_type": "Asset", "normal_balance": "D"},
    {"account_code": "21000", "account_type": "Liability", "normal_balance": "C"},
    {"account_code": "40000", "account_type": "Revenue", "normal_balance": "C"},
    {"account_code": "30000", "account_type": "Equity", "normal_balance": "C"},
    # Reconciliation control accounts: only a correcting entry may touch these.
    {"account_code": "11000", "account_type": "Asset", "normal_balance": "D"},
    {"account_code": "20000", "account_type": "Liability", "normal_balance": "C"},
]
BUS = ["BU-100", "BU-200", "BU-300", "BU-400"]
BREAK_ROWS = [
    {"control_account_code": "11000", "business_unit_id": "BU-100",
     "variance": 9000.0, "is_break": True},
    {"control_account_code": "20000", "business_unit_id": "BU-200",
     "variance": -4000.0, "is_break": True},
    {"control_account_code": "11000", "business_unit_id": "BU-300",
     "variance": 0.0, "is_break": False},
]


def _policy(**rule_overrides) -> dict:
    p = copy.deepcopy(DEFAULT_POLICY)
    for rule_id, changes in rule_overrides.items():
        p["rules"][rule_id].update(changes)
    return p


def _facts(policy, clearable=None, totals=None):
    demo_seed.query = lambda *a, **k: BREAK_ROWS  # stub the warehouse read
    return demo_seed.gather(ACCOUNTS, BUS, policy,
                           {"auto_approved_totals": totals or {}, "break_amounts": {}},
                           clearable)


def _decide(payload, policy, state):
    """The same call `decide_adjustment` makes, minus the row building."""
    types = {a["account_code"]: a["account_type"] for a in ACCOUNTS}
    return evaluate_policy(
        {"amount": payload["amount"],
         "business_unit_id": payload["business_unit_id"],
         "debit_account": payload["debit_account"],
         "debit_account_type": types.get(payload["debit_account"]),
         "credit_account": payload["credit_account"],
         "credit_account_type": types.get(payload["credit_account"]),
         "adjustment_type": payload.get("adjustment_type"),
         "memo": payload.get("memo", ""),
         "resolves_break": payload.get("resolves_break")},
        policy, state)


def _replay(items, policy, state):
    """Post the plan the way `seed` does: decide, then fold the verdict back in."""
    verdicts = []
    for it in items:
        d = _decide(it.payload, policy, state)
        if d.is_auto:
            bu = it.payload["business_unit_id"]
            totals = state.setdefault("auto_approved_totals", {})
            totals[bu] = totals.get(bu, 0.0) + it.payload["amount"]
            if it.payload.get("resolves_break"):
                state.setdefault("break_amounts", {}).pop(it.payload["resolves_break"], None)
        verdicts.append((it, d))
    return verdicts


# ---- the plan is safe by construction -----------------------------------
def test_plan_never_touches_a_control_account_except_to_correct():
    """A non-correcting entry that moved a control account would silently rewrite
    the Reconciliation page — the one side effect seeding must never have."""
    policy = _policy(break_backed={"enabled": False})
    items = demo_seed.plan(_facts(policy), random.Random(1))
    assert items
    controls = {"11000", "20000"}
    for it in items:
        touched = {it.payload["debit_account"], it.payload["credit_account"]} & controls
        assert not touched or it.payload.get("resolves_break"), \
            f"{it.label} touches {touched} without clearing a break"


def test_correcting_entries_only_clear_allowlisted_breaks():
    """The reset manufactures sacrificial breaks for the auto lane and keeps the
    scenario's own breaks open; the plan must respect that allowlist."""
    policy = _policy()  # break_backed on
    facts = _facts(policy, clearable={"11000/BU-100"})
    items = demo_seed.plan(facts, random.Random(2))
    refs = {it.payload["resolves_break"] for it in items if it.payload.get("resolves_break")}
    assert refs == {"11000/BU-100"}, refs


def test_plan_spans_types_rules_and_both_sides_of_the_limit():
    policy = _policy(break_backed={"enabled": False})
    facts = _facts(policy)
    items = demo_seed.plan(facts, random.Random(3))
    assert len(items) >= 20, len(items)
    types = {it.payload.get("adjustment_type") for it in items}
    assert len(types & set(demo_seed.TYPES)) == len(demo_seed.TYPES), types
    assert None in types, "an untyped entry is how type_allowlist gets broken"
    amounts = [it.payload["amount"] for it in items]
    assert max(amounts) > facts.amount_limit and min(amounts) < facts.amount_limit
    broken = {r for it in items for r in it.expected}
    for rule in ("amount_limit", "account_policy", "memo_required", "type_allowlist"):
        assert rule in broken, f"nothing in the plan breaks {rule}"


# ---- the engine agrees with the plan's intent ---------------------------
def test_engine_verdicts_match_the_plan_when_break_backed_is_off():
    policy = _policy(break_backed={"enabled": False})
    facts = _facts(policy)
    items = demo_seed.plan(facts, random.Random(4))
    state = {"auto_approved_totals": {}, "break_amounts": {}, "close_bd": 3}
    for it, d in _replay(items, policy, state):
        assert frozenset(d.broken_rules) == it.expected, \
            f"{it.label}: plan said {sorted(it.expected)}, engine said {sorted(d.broken_rules)}"


def test_engine_verdicts_match_the_plan_when_break_backed_is_on():
    policy = _policy()
    facts = _facts(policy, clearable={"11000/BU-100", "20000/BU-200"})
    items = demo_seed.plan(facts, random.Random(5))
    state = {"auto_approved_totals": {},
             "break_amounts": {"11000/BU-100": 9000.0, "20000/BU-200": 4000.0},
             "close_bd": 3}
    for it, d in _replay(items, policy, state):
        assert frozenset(d.broken_rules) == it.expected, \
            f"{it.label}: plan said {sorted(it.expected)}, engine said {sorted(d.broken_rules)}"


def test_batch_produces_both_lanes():
    """A seed run that auto-approved everything, or nothing, would leave half the
    Approvals page empty — the whole reason the reset seeds at all."""
    for backed in (True, False):
        policy = _policy(break_backed={"enabled": backed})
        facts = _facts(policy, clearable={"11000/BU-100", "20000/BU-200"} if backed else None)
        items = demo_seed.plan(facts, random.Random(6))
        state = {"auto_approved_totals": {},
                 "break_amounts": {"11000/BU-100": 9000.0, "20000/BU-200": 4000.0},
                 "close_bd": 3}
        modes = [d.is_auto for _, d in _replay(items, policy, state)]
        assert any(modes), f"break_backed={backed}: nothing auto-approved"
        assert not all(modes), f"break_backed={backed}: nothing came to a human"


# ---- the batch is a sequence, not a snapshot ----------------------------
def test_cap_is_enforced_across_the_batch_not_just_the_first_entry():
    """Without folding each auto-approval back into the state, every entry would
    be measured against an empty running total and the cap would never bite."""
    policy = _policy(break_backed={"enabled": False},
                     cumulative_cap={"enabled": True, "max_total": 60000.0})
    facts = _facts(policy)
    items = demo_seed.plan(facts, random.Random(7))
    state = {"auto_approved_totals": {}, "break_amounts": {}, "close_bd": 3}
    verdicts = _replay(items, policy, state)
    assert any("cumulative_cap" in d.broken_rules for _, d in verdicts), \
        "the cap never bit, so the batch was judged as a snapshot"
    auto_total = sum(it.payload["amount"] for it, d in verdicts
                     if d.is_auto and it.payload["business_unit_id"] == facts.bus[0])
    assert auto_total <= 60000.0, f"auto-approved {auto_total:,.0f} past a 60,000 cap"


def test_a_cleared_break_cannot_be_claimed_twice():
    """Two entries clearing the same break would both auto-approve on a snapshot,
    but the first one closes it."""
    policy = _policy()
    state = {"auto_approved_totals": {}, "break_amounts": {"11000/BU-100": 9000.0},
             "close_bd": 3}
    payload = {"debit_account": "50000", "credit_account": "11000",
               "business_unit_id": "BU-100", "amount": 9000.0,
               "adjustment_type": "accrual", "resolves_break": "11000/BU-100",
               "memo": "Clear the reconciliation variance against the control balance"}
    first = _decide(payload, policy, state)
    assert first.is_auto, first.broken_rules
    state["break_amounts"].pop("11000/BU-100")
    second = _decide(payload, policy, state)
    assert not second.is_auto
    assert "break_backed" in second.broken_rules


def test_advance_state_only_counts_auto_approvals():
    """A reviewed entry has not hit the ledger, so it must not consume cap."""
    from server.routes.close import Decided, advance_state

    class _Adj:
        business_unit_id, amount, resolves_break = "BU-100", 5000.0, None

    state: dict = {}
    advance_state(state, _Adj(), Decided("A", False, "pending", None, None, [], []))
    assert not state.get("auto_approved_totals")
    advance_state(state, _Adj(), Decided("B", True, "signed_off", None, None, [], []))
    assert state["auto_approved_totals"]["BU-100"] == 5000.0


if __name__ == "__main__":
    ok = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            ok += 1
            print(f"  ok  {name}")
    print(f"\n{ok} passed")
