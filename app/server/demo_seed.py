"""Seed a period's worth of posted adjustments so the Approvals page opens on a
distribution worth demoing: every lane populated, several adjustment types, and
amounts on both sides of the Controller's limit.

Entries go through the real policy engine (`decide_adjustment`), never hand-built
rows, so each one carries its own `decision_detail`, `approval_mode` and audit
trail. Fabricating those would put invented records behind a four-eyes control —
the one place in this app where that is not acceptable.

Two properties of the app shape everything below:

1. Auto-approval under `break_backed` requires clearing an open reconciliation
   break, and a correcting entry closes the break it clears. So where that rule
   is on, the auto-approved population can only be as large as the number of
   clearable breaks; where the Controller has turned it off, auto-approval is
   bounded only by the cumulative cap. The plan adapts per industry.
2. Any entry that flows to the lake moves the GL. Touching one of the
   reconciliation control accounts therefore rewrites the Reconciliation page, so
   only deliberately-correcting entries against `clearable` refs may do so.

Called in-process by the demo reset and by `data_generation/seed_adjustments.py`,
which is a thin CLI over the same plan.
"""
from __future__ import annotations

import random
import uuid
from dataclasses import dataclass, field

from .config import CLOSE_PERIOD, SRV_FQ as SRV
from .personas import persona_label
from .warehouse import query

TYPES = ("accrual", "reclass", "intercompany_elimination", "fx_overlay")
# Real close populations are lopsided — accruals dominate, FX overlays are rare —
# so the auto-approved breakdown is weighted rather than round-robin.
TYPE_WEIGHTS = (45, 25, 20, 10)

POSTER, APPROVER, SIGNER = "accountant", "controller", "cfo"

RECALL_REASON = ("Cleared against a stale subledger extract; the reconciliation "
                 "is being re-run before it is re-posted.")

MEMOS: dict[str, list[str]] = {
    "clean": [
        "Catch-up accrual for delayed supplier invoices, per the goods-received log",
        "Reclass of freight recovery booked to the wrong cost centre in June",
        "Intercompany service fee true-up per the Q2 transfer pricing schedule",
        "FX overlay on intercompany balances at the published period-end rate",
        "Accrue unbilled logistics charges confirmed by the 3PL statement",
        "Reclass rebate accrual from trade spend to customer deductions",
        "True-up of the shared-service allocation to the agreed driver split",
        "Accrue audit fees per the engagement letter, unbilled at cut-off",
        "Accrue June utilities per the supplier's estimated read schedule",
        "Reclass prepaid insurance amortisation to the correct expense line",
        "Intercompany royalty accrual per the licensing addendum",
        "FX retranslation of the intercompany loan at the closing rate",
        "Accrue contractor time approved in the June timesheet cycle",
        "Reclass software subscription cost from opex to prepaid",
        "Accrue inbound duty per the customs broker's June statement",
        "True-up of the marketing accrual to the agency's final invoice",
    ],
    "correcting": [
        "Clear the reconciliation variance against the subledger control balance",
        "Post the identified control-account difference confirmed by the subledger",
        "Correct the control-account balance to agree to the subledger extract",
        "Clear the open reconciliation difference on the control account",
    ],
    "unbacked": [
        "Manual top-side accrual requested by the regional controller",
        "Provision refresh pending the updated actuarial memo",
        "Accrue disputed vendor claim ahead of legal confirmation",
        "Estimated utilities accrual, meter reads not yet received",
        "Placeholder accrual for the restructuring programme",
    ],
    "oversized": [
        "Inventory obsolescence provision per the quarterly ageing review",
        "Accrue the annual volume rebate settlement with the largest account",
        "Legal settlement provision per counsel's latest assessment",
        "Restructuring provision for the announced site consolidation",
        "Onerous contract provision on the loss-making supply agreement",
    ],
    "restricted": [
        "Revenue cut-off correction for shipments recognised a day early",
        "Reclass of share-based compensation to the equity reserve",
        "Correct revenue recognised on an unsigned order form",
    ],
    "thin_memo": ["Fix", "adj", "per JS"],
    "untyped": [
        "Top-side consolidation entry agreed with group reporting",
        "Late adjustment passed by the divisional finance team",
    ],
    "oversized_restricted": [
        "Large revenue deferral pending the audit committee's review",
    ],
    "sloppy": ["tbd"],
    "capped": [
        "Further accrual for the same business unit late in the cycle",
        "Additional allocation true-up for the same business unit",
    ],
}


@dataclass(frozen=True)
class Item:
    """One planned entry: the payload to post and the rules it is built to break,
    so the engine's actual verdict can be checked against the intent."""
    label: str
    expected: frozenset[str]
    payload: dict


@dataclass
class Facts:
    """Everything the plan needs about this industry, read once."""
    bus: list[str]
    expense: list[str]          # safe debit side, never a control account
    settlement: list[str]       # safe credit side, never a control account
    restricted: list[str]
    control: dict[str, str]     # control account code -> normal_balance
    # ref -> (signed variance, control account) for clearable breaks inside the limit
    usable: list[tuple[str, float, str]]
    auto_totals: dict[str, float]
    enabled: set[str]
    amount_limit: float
    min_memo: int
    cap: float


@dataclass
class Outcome:
    posted: list[dict] = field(default_factory=list)
    mismatched: list[str] = field(default_factory=list)
    # Breaks that a recalled auto-approval had cleared. Reversing the entry undoes
    # the clearing, so these are open again — which is the point of a recall, and
    # the caller has to count them as open rather than assume its own scenario.
    reopened: list[str] = field(default_factory=list)

    def by_status(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for p in self.posted:
            out[p["status"]] = out.get(p["status"], 0) + 1
        return out

    def rule_hits(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for p in self.posted:
            for r in p["broken"]:
                out[r] = out.get(r, 0) + 1
        return dict(sorted(out.items(), key=lambda kv: -kv[1]))


def gather(accounts: list[dict], bus: list[str], policy: dict | None,
           state: dict, clearable: set[str] | None = None) -> Facts:
    """Derive the planning facts from the live policy and chart of accounts.

    `clearable` restricts which open breaks a correcting entry may close. The demo
    reset passes the sacrificial breaks it manufactured for exactly that purpose,
    which is what keeps the scenario's own breaks open on the Reconciliation page.
    """
    rules = (policy or {}).get("rules") or {}
    enabled = {rid for rid, cfg in rules.items() if cfg.get("enabled")}
    limit = float(rules.get("amount_limit", {}).get("max_amount") or 0)

    restricted_types = {str(t).lower() for t in
                        (rules.get("account_policy", {}).get("restricted_account_types") or [])}
    restricted_codes = {str(x) for x in
                        (rules.get("account_policy", {}).get("restricted_accounts") or [])}

    breaks = query(f"SELECT control_account_code, business_unit_id, variance, is_break "
                   f"FROM {SRV}.recon_breaks_live", use_cache=False)
    # The reconciliation control accounts, straight from the breaks view — an
    # entry touching one of these moves the GL and rewrites that page.
    control_codes = {str(b["control_account_code"]) for b in breaks}
    normal = {str(a["account_code"]): str(a.get("normal_balance") or "D") for a in accounts}

    def is_restricted(a: dict) -> bool:
        return (str(a.get("account_type")).lower() in restricted_types
                or str(a["account_code"]) in restricted_codes)

    free = [a for a in accounts if str(a["account_code"]) not in control_codes]
    expense = [a["account_code"] for a in free
               if not is_restricted(a) and str(a.get("account_type")).lower() == "expense"]
    settlement = [a["account_code"] for a in free
                  if not is_restricted(a)
                  and str(a.get("account_type")).lower() in ("liability", "asset")]

    usable: list[tuple[str, float, str]] = []
    for b in breaks:
        if not b.get("is_break"):
            continue
        code = str(b["control_account_code"])
        ref = f"{code}/{b['business_unit_id']}"
        if clearable is not None and ref not in clearable:
            continue
        var = float(b.get("variance") or 0)
        # A zero-variance break cannot be cleared: the API requires a positive
        # amount and the tolerance around zero is zero. An oversized one would
        # fail the amount limit, so it is left for a human either way.
        if abs(var) <= 0 or abs(var) > limit:
            continue
        usable.append((ref, var, code))

    return Facts(
        bus=bus, expense=expense, settlement=settlement,
        restricted=[a["account_code"] for a in accounts if is_restricted(a)],
        control={code: normal.get(code, "D") for code in control_codes},
        usable=usable,
        auto_totals=dict(state.get("auto_approved_totals") or {}),
        enabled=enabled, amount_limit=limit,
        min_memo=int(rules.get("memo_required", {}).get("min_chars") or 0),
        cap=float(rules.get("cumulative_cap", {}).get("max_total") or 0),
    )


def _memo(f: Facts, bucket: str, i: int, thin: bool = False) -> str:
    pool = MEMOS[bucket]
    text = pool[i % len(pool)]
    if thin:
        return text[: max(f.min_memo - 1, 1)]
    if len(text) < f.min_memo:
        text += " — supported by the reconciliation working paper"
    return text


def plan(f: Facts, rng: random.Random) -> list[Item]:
    """The period's entries, in posting order. Review entries come first: the
    cumulative cap counts auto-approved value, so anything posted after the clean
    batch would pick up a second broken rule it was never meant to test."""
    if not (f.expense and f.settlement and f.restricted and f.bus):
        return []
    items: list[Item] = []
    backed = "break_backed" in f.enabled
    # Where break_backed is on, an entry not tied to a break breaks it too, so
    # every deliberate violation below carries it as well.
    tag = frozenset({"break_backed"}) if backed else frozenset()

    def review(label: str, rules: set[str], payload: dict) -> None:
        items.append(Item(label, frozenset(rules) | tag, payload))

    for i in range(4):
        review("oversized", {"amount_limit"}, {
            "debit_account": f.expense[i % len(f.expense)],
            "credit_account": f.settlement[i % len(f.settlement)],
            "business_unit_id": f.bus[i % len(f.bus)],
            "amount": round(f.amount_limit * rng.uniform(1.3, 4.5), 2),
            "adjustment_type": TYPES[i % len(TYPES)],
            "memo": _memo(f, "oversized", i),
        })
    for i in range(3):
        review("restricted", {"account_policy"}, {
            "debit_account": f.restricted[i % len(f.restricted)],
            "credit_account": f.settlement[(i + 1) % len(f.settlement)],
            "business_unit_id": f.bus[(i + 2) % len(f.bus)],
            "amount": round(f.amount_limit * rng.uniform(0.15, 0.8), 2),
            "adjustment_type": TYPES[i % len(TYPES)],
            "memo": _memo(f, "restricted", i),
        })
    for i in range(2):
        review("thin_memo", {"memo_required"}, {
            "debit_account": f.expense[(i + 2) % len(f.expense)],
            "credit_account": f.settlement[(i + 2) % len(f.settlement)],
            "business_unit_id": f.bus[(i + 1) % len(f.bus)],
            "amount": round(f.amount_limit * rng.uniform(0.1, 0.6), 2),
            "adjustment_type": TYPES[(i + 1) % len(TYPES)],
            "memo": _memo(f, "thin_memo", i, thin=True),
        })
    for i in range(2):
        # No type at all — the API only accepts the four canonical types, so an
        # unclassified entry is the way this rule actually gets broken.
        review("untyped", {"type_allowlist"}, {
            "debit_account": f.expense[(i + 4) % len(f.expense)],
            "credit_account": f.settlement[(i + 3) % len(f.settlement)],
            "business_unit_id": f.bus[(i + 3) % len(f.bus)],
            "amount": round(f.amount_limit * rng.uniform(0.2, 0.7), 2),
            "adjustment_type": None,
            "memo": _memo(f, "untyped", i),
        })
    review("oversized_restricted", {"amount_limit", "account_policy"}, {
        "debit_account": f.restricted[0],
        "credit_account": f.settlement[0],
        "business_unit_id": f.bus[0],
        "amount": round(f.amount_limit * 2.6, 2),
        "adjustment_type": TYPES[1],
        "memo": _memo(f, "oversized_restricted", 0),
    })
    review("sloppy", {"memo_required", "type_allowlist"}, {
        "debit_account": f.expense[1 % len(f.expense)],
        "credit_account": f.settlement[1 % len(f.settlement)],
        "business_unit_id": f.bus[2 % len(f.bus)],
        "amount": round(f.amount_limit * 0.42, 2),
        "adjustment_type": None,
        "memo": _memo(f, "sloppy", 0, thin=True),
    })

    if backed:
        # Otherwise-clean entries that simply aren't tied to an identified break.
        for i in range(4):
            items.append(Item("unbacked", frozenset({"break_backed"}), {
                "debit_account": f.expense[(i + 3) % len(f.expense)],
                "credit_account": f.settlement[(i + 4) % len(f.settlement)],
                "business_unit_id": f.bus[i % len(f.bus)],
                "amount": round(f.amount_limit * rng.uniform(0.1, 0.9), 2),
                "adjustment_type": TYPES[i % len(TYPES)],
                "memo": _memo(f, "unbacked", i),
            }))
        # Auto-approval requires genuinely clearing a break, and clearing one
        # closes it — so there is exactly one such entry per clearable break.
        for i, (ref, var, code) in enumerate(f.usable):
            credit_control = (f.control[code] == "C") == (var > 0)
            items.append(Item("correcting", frozenset(), {
                "debit_account": f.expense[i % len(f.expense)] if credit_control else code,
                "credit_account": code if credit_control else f.settlement[i % len(f.settlement)],
                "business_unit_id": ref.split("/", 1)[1],
                "amount": round(abs(var), 2),
                "adjustment_type": TYPES[i % len(TYPES)],
                "memo": _memo(f, "correcting", i),
                "resolves_break": ref,
            }))
        return items

    # break_backed is off, so auto-approval only needs a sane amount, an allowed
    # account, a real type and a memo. Load most of the value onto one BU until the
    # cumulative cap bites, and spread the rest across the others for variety.
    #
    # The cap is projected here rather than estimated: an entry the cap rejects is
    # never auto-approved, so it adds nothing to the running total. Tracking that
    # exactly is what lets each entry declare which rule it should break.
    target = f.bus[0]
    capped_on = "cumulative_cap" in f.enabled
    running = f.auto_totals.get(target, 0.0)
    step = f.amount_limit * 0.86

    for i in range(14):
        amount = round(step * rng.uniform(0.9, 1.0), 2)
        over = capped_on and running + amount > f.cap
        if not over:
            running += amount
        items.append(Item("capped" if over else "clean",
                          frozenset({"cumulative_cap"}) if over else frozenset(), {
            "debit_account": f.expense[i % len(f.expense)],
            "credit_account": f.settlement[i % len(f.settlement)],
            "business_unit_id": target,
            "amount": amount,
            "adjustment_type": rng.choices(TYPES, weights=TYPE_WEIGHTS, k=1)[0],
            "memo": _memo(f, "capped" if over else "clean", i),
        }))
    for i in range(8):
        items.append(Item("clean", frozenset(), {
            "debit_account": f.expense[(i + 6) % len(f.expense)],
            "credit_account": f.settlement[(i + 2) % len(f.settlement)],
            "business_unit_id": f.bus[1 + (i % max(len(f.bus) - 1, 1))],
            "amount": round(f.amount_limit * rng.uniform(0.08, 0.75), 2),
            "adjustment_type": rng.choices(TYPES, weights=TYPE_WEIGHTS, k=1)[0],
            "memo": _memo(f, "clean", i + 3),
        }))
    return items


def seed(cur, rng: random.Random, clearable: set[str] | None = None) -> Outcome:
    """Post the plan and spread it across the queue's lanes. One Lakebase
    transaction and one lake insert for the whole batch; returns what happened.

    The caller owns the connection and the commit, so the reset can fold this into
    the rest of its work.
    """
    # Imported here: this module is reached from `routes.close`, which is fully
    # loaded by the time anything calls in.
    from .routes.close import (
        AdjustmentIn, _active_policy, _flow_many_to_lake, _period_state,
        accounts as read_accounts, advance_state, business_units, decide_adjustment,
        record_decided,
    )

    acct_rows = read_accounts()
    policy, policy_version = _active_policy()
    state = _period_state(cur)
    f = gather(acct_rows, [b["business_unit_id"] for b in business_units()],
               policy, state, clearable)
    items = plan(f, rng)
    if not items:
        return Outcome()

    acct_types = {a["account_code"]: a.get("account_type") for a in acct_rows}
    out = Outcome()
    decided = []
    for item in items:
        adj = AdjustmentIn(**item.payload)
        d = decide_adjustment(adj, persona_label(POSTER), policy, policy_version,
                              acct_types, state)
        # The batch is judged as a sequence, not a snapshot: fold each verdict back
        # in so the cap and break-backed rules see the period its predecessors made.
        advance_state(state, adj, d)
        decided.append(d)
        broke = frozenset(d.decision.broken_rules)
        if broke != item.expected:
            out.mismatched.append(
                f"{item.label}: expected {sorted(item.expected) or ['none']}, "
                f"engine said {sorted(broke) or ['none']}")
        out.posted.append({"kind": item.label, "adjustment_id": d.adjustment_id,
                           "mode": "auto" if d.auto else "manual",
                           "status": d.status, "broken": sorted(broke),
                           "ref": item.payload.get("resolves_break")})

    record_decided(cur, decided)
    _advance_lanes(cur, out, rng)
    # Ask the table which entries are signed off rather than trusting the labels
    # above: a recalled entry stays signed off (the recall adds a reversal instead
    # of unwinding it), so both it and its reversal belong in the ledger.
    cur.execute(
        "SELECT DISTINCT adjustment_id FROM posted_adjustments "
        "WHERE period = %s AND adjustment_id = ANY(%s) AND status = 'signed_off'",
        (CLOSE_PERIOD, [p["adjustment_id"] for p in out.posted]))
    _flow_many_to_lake(cur, [r[0] for r in cur.fetchall()])
    return out


def _advance_lanes(cur, out: Outcome, rng: random.Random) -> None:
    """Move some review entries along and recall one auto-approval, so every lane
    on the Approvals page has something in it and the reversal lane is not empty.

    The transitions mirror `approve_adjustment` / `sign_off_adjustment` /
    `recall_adjustment` exactly, but batched — a per-entry call would cost a round
    trip each, and the whole point of seeding in-process is to stay cheap.
    """
    review = [p for p in out.posted if p["mode"] == "manual"]
    auto = [p for p in out.posted if p["mode"] == "auto"]
    rng.shuffle(review)
    third = max(len(review) // 3, 1)
    to_approve = review[:third]
    to_sign = review[third:third * 2]

    approver, signer = persona_label(APPROVER), persona_label(SIGNER)
    events: list[tuple[str, str, str, str]] = []
    if to_approve or to_sign:
        cur.execute(
            "UPDATE posted_adjustments SET status='approved', approved_by=%s, approved_ts=now() "
            "WHERE adjustment_id = ANY(%s) AND period = %s AND status = 'pending'",
            (approver, [p["adjustment_id"] for p in to_approve + to_sign], CLOSE_PERIOD))
        for p in to_approve + to_sign:
            p["status"] = "approved"
            events.append((p["adjustment_id"], "adjustment_approved",
                           f"Approved by {approver} — awaiting CFO sign-off [demo reset]",
                           approver))
    if to_sign:
        cur.execute(
            "UPDATE posted_adjustments SET status='signed_off', signed_off_by=%s, "
            "signed_off_ts=now() WHERE adjustment_id = ANY(%s) AND period = %s "
            "AND status = 'approved'",
            (signer, [p["adjustment_id"] for p in to_sign], CLOSE_PERIOD))
        for p in to_sign:
            p["status"] = "signed_off"
            events.append((p["adjustment_id"], "adjustment_signed_off",
                           f"Signed off by {signer} — attested complete & accurate, flowed "
                           f"to the lake [demo reset]", signer))

    # Recall a small share, not a headline share: the recalled shading should read
    # as an exception to the automation, not as its main story. Where break_backed
    # caps the auto lane at a handful of entries, recalling two would shade most of
    # it — so a lane of one keeps its only entry standing.
    for p in rng.sample(auto, min(2, len(auto) // 3)) if len(auto) >= 3 else []:
        rev = f"{p['adjustment_id']}-REV"
        # The reversal swaps each leg's side so the pair nets to zero, and carries
        # the original's type so it reads as what it reverses.
        cur.execute(
            "INSERT INTO posted_adjustments "
            "(adjustment_id, period, leg, account_code, business_unit_id, dr_cr, amount, "
            " memo, posted_by, status, approval_mode, is_reversal, adjustment_type, "
            " approved_by, approved_ts, signed_off_by, signed_off_ts) "
            "SELECT %s, period, leg, account_code, business_unit_id, "
            " CASE WHEN dr_cr = 'D' THEN 'C' ELSE 'D' END, amount, %s, %s, "
            " 'signed_off', 'manual', true, adjustment_type, %s, now(), %s, now() "
            "FROM posted_adjustments WHERE adjustment_id = %s AND period = %s",
            (rev, f"Reversal of {p['adjustment_id']}: {RECALL_REASON}",
             signer, signer, signer, p["adjustment_id"], CLOSE_PERIOD))
        cur.execute(
            "UPDATE posted_adjustments SET recalled_by=%s, recalled_ts=now(), "
            "recall_reason=%s WHERE adjustment_id=%s AND period=%s",
            (signer, RECALL_REASON, p["adjustment_id"], CLOSE_PERIOD))
        p["status"] = "recalled"
        if p.get("ref"):
            out.reopened.append(p["ref"])
        out.posted.append({"kind": "reversal", "adjustment_id": rev, "mode": "manual",
                           "status": "signed_off", "broken": [], "ref": None})
        events.append((p["adjustment_id"], "adjustment_recalled",
                       f"Recalled by {signer}: {RECALL_REASON} — reversing entry {rev} "
                       f"posted [demo reset]", signer))

    if events:
        cur.executemany(
            "INSERT INTO close_task_activity "
            "(activity_id, task_id, period, actor, action, detail) VALUES (%s,%s,%s,%s,%s,%s)",
            [(uuid.uuid4().hex[:12], entity, CLOSE_PERIOD, actor, action, detail)
             for entity, action, detail, actor in events])
