from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from typing import Any

AssumptionSignature = tuple[tuple[str, float], ...]

_BASELINE_REASON = "This scenario matches Baseline. Change at least one driver."


def assumption_signature(assumptions: Mapping[str, Any] | None) -> AssumptionSignature:
    pairs: list[tuple[str, float]] = []
    for driver_id, raw in (assumptions or {}).items():
        value = raw.get("value") if isinstance(raw, Mapping) else raw
        if value is None or value == "":
            continue
        try:
            numeric = float(value)
        except (TypeError, ValueError):
            continue
        if not math.isfinite(numeric):
            continue
        if numeric == 0.0:
            continue
        pairs.append((driver_id, numeric))
    return tuple(sorted(pairs, key=lambda p: p[0]))


def duplicate_match(
    scenario_id: str,
    signature: AssumptionSignature,
    candidates: Sequence[Mapping[str, Any]],
) -> Mapping[str, Any] | None:
    for candidate in candidates:
        if candidate.get("scenario_id") == scenario_id:
            continue
        if candidate.get("status") == "archived":
            continue
        if assumption_signature(candidate.get("assumptions")) == signature:
            return candidate
    return None


def decorate_compare_eligibility(plans: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = [dict(plan) for plan in plans]
    by_group: dict[tuple[str | None, str | None, str | None], dict[AssumptionSignature, list[int]]] = {}

    for idx, plan in enumerate(out):
        sig = assumption_signature(plan.get("assumptions"))
        plan["_signature"] = sig
        if plan.get("is_baseline"):
            continue
        if plan.get("status") == "archived":
            continue
        key = (
            plan.get("as_of_period"),
            plan.get("scope_type"),
            plan.get("scope_id"),
        )
        by_group.setdefault(key, {}).setdefault(sig, []).append(idx)

    for idx, plan in enumerate(out):
        sig = plan.pop("_signature")
        if plan.get("is_baseline"):
            plan["compare_eligible"] = True
            plan.pop("compare_block_reason", None)
            continue
        if not sig:
            plan["compare_eligible"] = False
            plan["compare_block_reason"] = _BASELINE_REASON
            continue
        key = (
            plan.get("as_of_period"),
            plan.get("scope_type"),
            plan.get("scope_id"),
        )
        dupes = by_group.get(key, {}).get(sig, [])
        if len(dupes) > 1:
            other_idx = next(i for i in dupes if i != idx)
            other_name = out[other_idx].get("name") or "another scenario"
            plan["compare_eligible"] = False
            plan["compare_block_reason"] = (
                f'This scenario matches "{other_name}". Change at least one driver.'
            )
            continue
        plan["compare_eligible"] = True
        plan.pop("compare_block_reason", None)
    return out
