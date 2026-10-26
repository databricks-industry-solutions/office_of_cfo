"""Pure policy-evaluation engine for adjustment auto-approval.

The Controller declares, in advance, what "routine" means; adjustments that
satisfy every enabled rule are approved and signed off without a human touch,
and anything that breaks a rule is routed to review with the broken rule named.

This module deliberately has no I/O and no app imports: the caller assembles the
adjustment, the active policy and the period state, and gets back a `Decision` it
can persist. That keeps the entire rule set unit-testable without a database, a
warehouse or a running app — which is also what makes the decision reproducible
years later from the stored `decision_detail`.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any, Callable

# The seven rule kinds, in evaluation order. Fixed by design: adding an eighth is
# a product decision, not a configuration one.
RULE_IDS = (
    "amount_limit",
    "account_policy",
    "type_allowlist",
    "break_backed",
    "memo_required",
    "period_window",
    "cumulative_cap",
)

# Canonical adjustment types, matching `manual_adjustments` in
# config/vertical_overlays.yaml.
ADJUSTMENT_TYPES = ("accrual", "reclass", "intercompany_elimination", "fx_overlay")

RULE_LABELS: dict[str, str] = {
    "amount_limit": "Amount limit",
    "account_policy": "Restricted accounts",
    "type_allowlist": "Adjustment type",
    "break_backed": "Break-backed",
    "memo_required": "Memo required",
    "period_window": "Close window",
    "cumulative_cap": "Cumulative cap",
}

DEFAULT_POLICY: dict[str, Any] = {
    "name": "Close Approval Policy",
    "auto_approval_enabled": True,
    "rules": {
        "amount_limit": {"enabled": True, "max_amount": 25_000.0, "bu_overrides": {}},
        "account_policy": {
            "enabled": True,
            "restricted_account_types": ["Revenue", "Equity"],
            "restricted_accounts": [],
        },
        "type_allowlist": {"enabled": True, "allowed_types": list(ADJUSTMENT_TYPES)},
        "break_backed": {"enabled": True, "tolerance_pct": 5.0},
        "memo_required": {"enabled": True, "min_chars": 12},
        "period_window": {"enabled": True, "max_bd": 8},
        "cumulative_cap": {"enabled": True, "max_total": 250_000.0},
    },
}


# Per-industry seed policies. Every industry's transactional data is cloned from
# the same baseline, so the AMOUNT limit stays constant — varying it per industry
# would make identical entries behave differently for no defensible reason. What
# genuinely differs is control posture: FSI runs a tighter tolerance, longer memo
# and shorter window; Energy allows a wider tolerance for commodity-driven swings.
INDUSTRY_POLICY_DEFAULTS: dict[str, dict[str, Any]] = {
    "consumer": {"name": "Close Approval Policy"},
    "software": {"name": "Close Approval Policy"},
    "fsi": {
        "name": "Delegated Approval Authority",
        "rules": {
            "break_backed": {"tolerance_pct": 2.0},
            "memo_required": {"min_chars": 20},
            "period_window": {"max_bd": 6},
            "cumulative_cap": {"max_total": 150_000.0},
        },
    },
    "capmarkets": {
        "name": "Delegated Approval Authority",
        "rules": {
            "break_backed": {"tolerance_pct": 1.5},
            "memo_required": {"min_chars": 20},
            "period_window": {"max_bd": 5},
            "cumulative_cap": {"max_total": 250_000.0},
        },
    },
    "energy": {
        "name": "Close Approval Policy",
        "rules": {
            "break_backed": {"tolerance_pct": 7.5},
            "period_window": {"max_bd": 9},
        },
    },
}


# Seeded OFF for every industry. `close_bd` is measured against `CLOSE_PERIOD`,
# which this app pins as configuration rather than tracking the wall clock; once
# that pin goes stale the window rule would fail every entry and silently switch
# the whole feature off. A Controller can enable it at any time — the rule itself
# is fully implemented and enforced.
SEED_DISABLED_RULES = ("period_window",)


def default_policy_for(industry: str | None) -> dict[str, Any]:
    """The seed policy for an industry: the shared default with that industry's
    control-posture overrides applied."""
    overlay = INDUSTRY_POLICY_DEFAULTS.get(industry or "", {})
    policy: dict[str, Any] = {
        "name": overlay.get("name", DEFAULT_POLICY["name"]),
        "auto_approval_enabled": True,
        "rules": {rid: dict(cfg) for rid, cfg in DEFAULT_POLICY["rules"].items()},
    }
    for rule_id, changes in (overlay.get("rules") or {}).items():
        policy["rules"][rule_id].update(changes)
    for rule_id in SEED_DISABLED_RULES:
        policy["rules"][rule_id]["enabled"] = False
    return policy


@dataclass(frozen=True)
class RuleResult:
    """One rule's verdict, carrying enough context to reconstruct it later."""
    rule: str
    passed: bool
    parameter: Any
    observed: Any
    detail: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "rule": self.rule,
            "label": RULE_LABELS.get(self.rule, self.rule),
            "passed": self.passed,
            "parameter": self.parameter,
            "observed": self.observed,
            "detail": self.detail,
        }


@dataclass(frozen=True)
class Decision:
    mode: str                                        # "auto" | "manual"
    broken_rules: list[str] = field(default_factory=list)
    evaluations: list[RuleResult] = field(default_factory=list)
    disabled: bool = False                           # auto-approval globally off

    @property
    def is_auto(self) -> bool:
        return self.mode == "auto"

    def reasons(self) -> list[str]:
        """Human-readable reasons the adjustment needs a human, in rule order."""
        return [e.detail for e in self.evaluations if not e.passed]

    def as_detail(self, policy: dict[str, Any] | None = None,
                  policy_version: int | None = None) -> dict[str, Any]:
        """The immutable audit record: every rule, its parameter AS IT STOOD at
        decision time, the observed value, and the verdict."""
        return {
            "mode": self.mode,
            "auto_approval_enabled": not self.disabled,
            "policy_name": (policy or {}).get("name"),
            "policy_version": policy_version,
            "broken_rules": list(self.broken_rules),
            "evaluations": [e.as_dict() for e in self.evaluations],
        }


# ---------------------------------------------------------------------------
# Business-day math (pure: the caller supplies `today`).
# ---------------------------------------------------------------------------
def _period_end(period: str) -> date:
    y, m = (int(x) for x in period.split("-")[:2])
    return date(y, 12, 31) if m == 12 else date(y, m + 1, 1) - timedelta(days=1)


def close_business_day(period: str, today: date) -> int:
    """Business days elapsed since the close cutoff T (the last business day of
    the period): 0 on T itself, +n after, and 0 for any date before T so a
    mid-period posting is never treated as late."""
    cutoff = _period_end(period)
    while cutoff.weekday() >= 5:
        cutoff -= timedelta(days=1)
    if today <= cutoff:
        return 0
    n, d = 0, cutoff
    while d < today:
        d += timedelta(days=1)
        if d.weekday() < 5:
            n += 1
    return n


# ---------------------------------------------------------------------------
# The seven rules. Each returns (passed, parameter, observed, detail).
# ---------------------------------------------------------------------------
def _money(x: float) -> str:
    return f"{float(x):,.2f}"


def _rule_amount_limit(cfg: dict, adj: dict, state: dict) -> tuple[bool, Any, Any, str]:
    bu = adj.get("business_unit_id") or ""
    overrides = cfg.get("bu_overrides") or {}
    limit = float(overrides.get(bu, cfg.get("max_amount", 0)) or 0)
    amount = abs(float(adj.get("amount") or 0))
    passed = amount <= limit
    scope = f" for {bu}" if bu in overrides else ""
    detail = (f"Amount {_money(amount)} is within the {_money(limit)} limit{scope}"
              if passed else
              f"Amount {_money(amount)} exceeds the {_money(limit)} limit{scope}")
    return passed, limit, amount, detail


def _rule_account_policy(cfg: dict, adj: dict, state: dict) -> tuple[bool, Any, Any, str]:
    codes = {str(c) for c in (cfg.get("restricted_accounts") or [])}
    types = {str(t).lower() for t in (cfg.get("restricted_account_types") or [])}
    touched = [
        (adj.get("debit_account"), adj.get("debit_account_type")),
        (adj.get("credit_account"), adj.get("credit_account_type")),
    ]
    hits = [
        f"{code}{f' ({atype})' if atype else ''}"
        for code, atype in touched
        if code and (str(code) in codes or str(atype or "").lower() in types)
    ]
    parameter = {"restricted_accounts": sorted(codes),
                 "restricted_account_types": sorted(types)}
    observed = [c for c, _ in touched if c]
    detail = ("No restricted account touched"
              if not hits else
              f"Restricted account touched: {', '.join(hits)}")
    return not hits, parameter, observed, detail


def _rule_type_allowlist(cfg: dict, adj: dict, state: dict) -> tuple[bool, Any, Any, str]:
    allowed = [str(t).lower() for t in (cfg.get("allowed_types") or [])]
    atype = str(adj.get("adjustment_type") or "").lower().strip()
    passed = bool(atype) and atype in allowed
    if not atype:
        detail = "No adjustment type set"
    elif passed:
        detail = f"Type '{atype}' is allowed"
    else:
        detail = f"Type '{atype}' is not in the allowed set"
    return passed, allowed, atype or None, detail


def _rule_break_backed(cfg: dict, adj: dict, state: dict) -> tuple[bool, Any, Any, str]:
    """The strongest rule: the entry must clear a reconciliation break the system
    itself identified, to within a tolerance of that break's amount."""
    tol = float(cfg.get("tolerance_pct", 0) or 0)
    ref = adj.get("resolves_break")
    if not ref:
        return False, tol, None, "Not linked to an identified reconciliation break"
    break_amount = (state.get("break_amounts") or {}).get(ref)
    if break_amount is None:
        return False, tol, None, f"No open break found for {ref}"
    target = abs(float(break_amount))
    amount = abs(float(adj.get("amount") or 0))
    # A zero-amount break can only be matched exactly.
    allowed = target * tol / 100.0
    delta = abs(amount - target)
    passed = delta <= allowed
    pct = (delta / target * 100.0) if target else (0.0 if delta == 0 else 100.0)
    detail = (f"Clears break {ref} ({_money(target)}) within {tol:g}% tolerance"
              if passed else
              f"Amount {_money(amount)} is {pct:.1f}% off break {ref} "
              f"({_money(target)}), over the {tol:g}% tolerance")
    return passed, tol, {"ref": ref, "break_amount": target, "delta": round(delta, 2)}, detail


def _rule_memo_required(cfg: dict, adj: dict, state: dict) -> tuple[bool, Any, Any, str]:
    min_chars = int(cfg.get("min_chars", 0) or 0)
    memo = (adj.get("memo") or "").strip()
    passed = len(memo) >= min_chars
    detail = (f"Memo is {len(memo)} characters"
              if passed else
              f"Memo is {len(memo)} characters, under the {min_chars} required")
    return passed, min_chars, len(memo), detail


def _rule_period_window(cfg: dict, adj: dict, state: dict) -> tuple[bool, Any, Any, str]:
    max_bd = int(cfg.get("max_bd", 0) or 0)
    bd = int(state.get("close_bd", 0) or 0)
    passed = bd <= max_bd
    detail = (f"Business day {bd} is within the BD{max_bd} auto-approval window"
              if passed else
              f"Business day {bd} is past the BD{max_bd} auto-approval window")
    return passed, max_bd, bd, detail


def _rule_cumulative_cap(cfg: dict, adj: dict, state: dict) -> tuple[bool, Any, Any, str]:
    cap = float(cfg.get("max_total", 0) or 0)
    bu = adj.get("business_unit_id") or ""
    already = float((state.get("auto_approved_totals") or {}).get(bu, 0) or 0)
    amount = abs(float(adj.get("amount") or 0))
    running = already + amount
    passed = running <= cap
    detail = (f"{bu} auto-approved total would be {_money(running)} of {_money(cap)}"
              if passed else
              f"{bu} auto-approved total would reach {_money(running)}, over the "
              f"{_money(cap)} cap")
    return passed, cap, round(running, 2), detail


_RULES: dict[str, Callable[[dict, dict, dict], tuple[bool, Any, Any, str]]] = {
    "amount_limit": _rule_amount_limit,
    "account_policy": _rule_account_policy,
    "type_allowlist": _rule_type_allowlist,
    "break_backed": _rule_break_backed,
    "memo_required": _rule_memo_required,
    "period_window": _rule_period_window,
    "cumulative_cap": _rule_cumulative_cap,
}


def evaluate_policy(adjustment: dict[str, Any], policy: dict[str, Any] | None,
                    period_state: dict[str, Any] | None = None) -> Decision:
    """Decide whether `adjustment` may be auto-approved under `policy`.

    `adjustment` carries amount, business_unit_id, memo, resolves_break,
    adjustment_type, and the debit/credit account codes plus their resolved
    account types. `period_state` carries `break_amounts` (ref -> open variance),
    `auto_approved_totals` (BU -> value already auto-approved this period) and
    `close_bd`.

    Every enabled rule must pass for `auto`. A missing or malformed policy is
    treated as "no automation", which is the safe direction.
    """
    state = period_state or {}
    policy = policy or {}
    rules = policy.get("rules") or {}

    if not policy or not policy.get("auto_approval_enabled", False):
        return Decision(mode="manual", broken_rules=[], evaluations=[], disabled=True)

    evaluations: list[RuleResult] = []
    broken: list[str] = []
    for rule_id in RULE_IDS:
        cfg = rules.get(rule_id) or {}
        if not cfg.get("enabled", False):
            continue
        passed, parameter, observed, detail = _RULES[rule_id](cfg, adjustment, state)
        evaluations.append(RuleResult(rule_id, passed, parameter, observed, detail))
        if not passed:
            broken.append(rule_id)

    return Decision(
        mode="manual" if broken else "auto",
        broken_rules=broken,
        evaluations=evaluations,
    )


def normalize_policy(data: dict[str, Any] | None) -> dict[str, Any]:
    """Coerce a submitted policy onto the known shape: unknown rule ids are
    dropped and missing ones fall back to their defaults, so a stale or
    hand-edited payload can never widen the automation by accident."""
    src = data or {}
    src_rules = src.get("rules") or {}
    rules: dict[str, Any] = {}
    for rule_id in RULE_IDS:
        default = dict(DEFAULT_POLICY["rules"][rule_id])
        incoming = src_rules.get(rule_id)
        if isinstance(incoming, dict):
            # Only keys the default declares are honoured.
            default.update({k: v for k, v in incoming.items() if k in default})
        rules[rule_id] = default
    return {
        "name": str(src.get("name") or DEFAULT_POLICY["name"]),
        "auto_approval_enabled": bool(src.get("auto_approval_enabled", False)),
        "rules": rules,
    }


def policy_diff(old: dict[str, Any] | None, new: dict[str, Any]) -> list[str]:
    """Readable field-level changes between two policy versions, for the version
    history in Settings."""
    if not old:
        return ["Initial version"]
    out: list[str] = []
    if old.get("name") != new.get("name"):
        out.append(f"Name: '{old.get('name')}' -> '{new.get('name')}'")
    if bool(old.get("auto_approval_enabled")) != bool(new.get("auto_approval_enabled")):
        out.append("Auto-approval " + ("enabled" if new.get("auto_approval_enabled") else "disabled"))
    old_rules, new_rules = old.get("rules") or {}, new.get("rules") or {}
    for rule_id in RULE_IDS:
        o, n = old_rules.get(rule_id) or {}, new_rules.get(rule_id) or {}
        label = RULE_LABELS.get(rule_id, rule_id)
        if bool(o.get("enabled")) != bool(n.get("enabled")):
            out.append(f"{label}: " + ("enabled" if n.get("enabled") else "disabled"))
        for key in n:
            if key == "enabled":
                continue
            if o.get(key) != n.get(key):
                out.append(f"{label} · {key.replace('_', ' ')}: {o.get(key)} -> {n.get(key)}")
    return out or ["No changes"]
