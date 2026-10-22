#!/usr/bin/env python3
"""Seed a period's worth of posted adjustments, one industry at a time.

A thin CLI over `app/server/demo_seed.py` — the same planner the demo reset uses,
so there is one definition of what a demo-ready Approvals queue looks like. Runs
in-process against Lakebase and the warehouse (no app server required), which is
also what makes it cheap: the whole batch is one transaction and one lake insert.

Usage:
    python data_generation/seed_adjustments.py                  # all industries
    python data_generation/seed_adjustments.py --industries consumer
    python data_generation/seed_adjustments.py --dry-run
    python data_generation/seed_adjustments.py --clear-breaks   # see the flag's help

Appends to whatever is already posted; it does not clear prior entries, and by
default it leaves the open reconciliation breaks alone. Use the gear-icon reset in
the app for a clean slate — that path manufactures its own breaks for the
auto-approved lane and preserves the scenario's.
"""
from __future__ import annotations

import argparse
import os
import random
import sys
from pathlib import Path

# Set up data_generation module path first
data_gen_path = Path(__file__).resolve().parent
sys.path.insert(0, str(data_gen_path))
from _common import CATALOG  # noqa: E402

# Then set up app path and environment
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
os.environ.setdefault("CFO_MULTI_INDUSTRY", "1")
os.environ.setdefault("MULTI_CATALOG", CATALOG)

from server import demo_seed  # noqa: E402
from server.config import set_current_industry  # noqa: E402
from server.industry import INDUSTRIES  # noqa: E402
from server.lakebase import pool  # noqa: E402
from server.routes.close import (  # noqa: E402
    _active_policy, _period_state, accounts, business_units,
)


def run(industry: str, rng: random.Random, dry_run: bool, clear_breaks: bool) -> list[str]:
    set_current_industry(industry)
    # A correcting entry closes the break it clears, so left to itself this would
    # quietly empty the Reconciliation page. Topping up a queue should not change
    # what the close has left to reconcile, hence opt-in.
    clearable = None if clear_breaks else set()
    print(f"\n=== {industry} ===")
    with pool.connection() as conn:
        with conn.cursor() as cur:
            policy, _ = _active_policy()
            facts = demo_seed.gather(
                accounts(), [b["business_unit_id"] for b in business_units()],
                policy, _period_state(cur), clearable)
            print(f"    rules on: {', '.join(sorted(facts.enabled))}")
            print(f"    limit={facts.amount_limit:,.0f} memo>={facts.min_memo} "
                  f"cap={facts.cap:,.0f} | clearable breaks={len(facts.usable)}"
                  f"{'' if clear_breaks else ' (--clear-breaks off)'}")
            if dry_run:
                items = demo_seed.plan(facts, rng)
                for it in items:
                    print(f"    {it.label:22s} {it.payload['amount']:>12,.2f} "
                          f"{it.payload.get('adjustment_type') or '(none)':24s} "
                          f"expects {sorted(it.expected) or ['none']}")
                print(f"    would post {len(items)}")
                return []
            out = demo_seed.seed(cur, rng, clearable)
        conn.commit()
    print(f"    posted {len(out.posted)} | {dict(sorted(out.by_status().items()))}")
    if out.rule_hits():
        print(f"    rule hits {out.rule_hits()}")
    for m in out.mismatched:
        print(f"    NOTE {m}")
    return [p["adjustment_id"] for p in out.posted]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--industries", nargs="+", default=list(INDUSTRIES), choices=INDUSTRIES)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--clear-breaks", action="store_true",
                    help="let auto-approvals clear real open reconciliation breaks "
                         "(closes them; off by default so the recon board is untouched)")
    ap.add_argument("--manifest", help="write every posted adjustment id here")
    ap.add_argument("--seed", type=int, default=20260730)
    args = ap.parse_args()

    ids: list[str] = []
    for industry in args.industries:
        rng = random.Random(f"{args.seed}:{industry}")
        try:
            ids.extend(run(industry, rng, args.dry_run, args.clear_breaks))
        except Exception as e:  # noqa: BLE001
            print(f"    FAILED: {type(e).__name__}: {e}")
    if args.manifest and ids:
        Path(args.manifest).write_text("\n".join(ids) + "\n")
        print(f"\nwrote {len(ids)} ids to {args.manifest}")
    print("\ndry run" if args.dry_run else "\ndone")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
