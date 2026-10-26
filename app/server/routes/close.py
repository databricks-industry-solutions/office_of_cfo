"""API for the reconciliation & adjustments app (Act 4).

Adjustments follow a governed Accountant -> Controller -> CFO workflow: an
accountant posts a correcting entry (`pending`); a controller approves it
(`approved`); the CFO signs it off (`signed_off`), and only then does it flow
back to the lake so the real-time trial balance + live reconciliation reflect
it. Every transition is role-gated (segregation of duties) and written to the
append-only activity trail the Audit Log renders.

Routine entries skip that queue: every posting is evaluated against the
Controller's approval policy (see `server/policy.py`), and one that satisfies
every enabled rule is approved and signed off in the same request, flowing to the
lake immediately. Anything that breaks a rule takes the human path above with the
broken rule named. The policy itself carries the four-eyes control — a Controller
authors it, the CFO attests to it — and every automated decision stores the rule
set as it stood at decision time so it can be reconstructed years later.
"""
import json
import random
import threading
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Any

import psycopg
from fastapi import APIRouter, Header, HTTPException, Query
from pydantic import BaseModel, Field

from ..config import (
    CLOSE_PERIOD, CLOSE_FQ, OPS_FQ, SRV_FQ, current_industry, current_user,
    demo_today, resolve_period,
)
from ..lakebase import pool
from ..personas import can, persona_label, scope_clause
from ..policy import (
    ADJUSTMENT_TYPES, close_business_day, default_policy_for, evaluate_policy,
    normalize_policy, policy_diff,
)
from ..warehouse import invalidate_cache, query

router = APIRouter()

SRV = SRV_FQ
OPS = OPS_FQ
CLOSE = CLOSE_FQ

# Per-industry guard: each industry has its own Lakebase instance, so the
# adjustment-workflow schema must be ensured once per industry.
_schema_ready: set[str] = set()
_schema_locks: dict[str, threading.Lock] = {}
_schema_locks_guard = threading.Lock()


def _schema_lock_for(industry: str) -> threading.Lock:
    with _schema_locks_guard:
        return _schema_locks.setdefault(industry, threading.Lock())

_SCHEMA_DDL = (
    # Base table (the columns the original app posted); the ALTERs below add the
    # approval workflow. Created here so a fresh industry database works on first
    # request, with the app's service principal as owner.
    "CREATE TABLE IF NOT EXISTS posted_adjustments ("
    " adjustment_id text NOT NULL, period text NOT NULL, leg text NOT NULL,"
    " account_code text NOT NULL, business_unit_id text, dr_cr text NOT NULL,"
    " amount numeric(18,2) NOT NULL, memo text, resolves_break text, posted_by text,"
    " posted_ts timestamptz NOT NULL DEFAULT now())",
    "ALTER TABLE posted_adjustments ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'signed_off'",
    "ALTER TABLE posted_adjustments ADD COLUMN IF NOT EXISTS approved_by text",
    "ALTER TABLE posted_adjustments ADD COLUMN IF NOT EXISTS signed_off_by text",
    "ALTER TABLE posted_adjustments ADD COLUMN IF NOT EXISTS approved_ts timestamptz",
    "ALTER TABLE posted_adjustments ADD COLUMN IF NOT EXISTS signed_off_ts timestamptz",
    # Policy-based approvals. `approval_mode` MUST default to 'manual': legacy
    # rows already default `status` to 'signed_off', and without this default they
    # would retroactively read as policy-approved.
    "ALTER TABLE posted_adjustments ADD COLUMN IF NOT EXISTS adjustment_type text",
    "ALTER TABLE posted_adjustments ADD COLUMN IF NOT EXISTS approval_mode text NOT NULL DEFAULT 'manual'",
    "ALTER TABLE posted_adjustments ADD COLUMN IF NOT EXISTS policy_id text",
    "ALTER TABLE posted_adjustments ADD COLUMN IF NOT EXISTS policy_version integer",
    "ALTER TABLE posted_adjustments ADD COLUMN IF NOT EXISTS decision_ts timestamptz",
    "ALTER TABLE posted_adjustments ADD COLUMN IF NOT EXISTS decision_detail jsonb",
    "ALTER TABLE posted_adjustments ADD COLUMN IF NOT EXISTS recalled_by text",
    "ALTER TABLE posted_adjustments ADD COLUMN IF NOT EXISTS recalled_ts timestamptz",
    "ALTER TABLE posted_adjustments ADD COLUMN IF NOT EXISTS recall_reason text",
    # A reversal is a system-generated correction, not a candidate for approval:
    # scoring one would distort the automation rate and the register denominator.
    "ALTER TABLE posted_adjustments ADD COLUMN IF NOT EXISTS is_reversal boolean NOT NULL DEFAULT false",
    # Reversals posted before the column existed defaulted to false, which would
    # keep them in the scored population forever. The `-REV` suffix is minted only
    # by recall, so it is a safe backfill key.
    "UPDATE posted_adjustments SET is_reversal = true "
    "WHERE adjustment_id LIKE '%-REV' AND NOT is_reversal",
    # Append-only policy register: a new version is a new row and `data` is never
    # updated once activated, so a retired policy stays readable forever.
    "CREATE TABLE IF NOT EXISTS approval_policies ("
    " policy_id text NOT NULL, version integer NOT NULL, data jsonb NOT NULL,"
    " status text NOT NULL DEFAULT 'draft',"
    " authored_by text, authored_ts timestamptz NOT NULL DEFAULT now(),"
    " attested_by text, attested_ts timestamptz,"
    " activated_ts timestamptz, retired_ts timestamptz,"
    " PRIMARY KEY (policy_id, version))",
    # Shared append-only activity trail (also created by tasks.py); the Audit Log
    # reads it via /close-activity.
    "CREATE TABLE IF NOT EXISTS close_task_activity ("
    " activity_id text PRIMARY KEY, task_id text NOT NULL, period text NOT NULL,"
    " ts timestamptz NOT NULL DEFAULT now(), actor text, action text NOT NULL,"
    " detail text DEFAULT '')",
    # Variance analysis: a written explanation is one of the two ways to clear a
    # flagged variance for close (the other being a signed-off adjustment). ref is
    # "{control_account_code}/{business_unit_id}", matching resolves_break.
    "CREATE TABLE IF NOT EXISTS variance_explanations ("
    " period text NOT NULL, ref text NOT NULL, explanation text NOT NULL,"
    " explained_by text, explained_ts timestamptz NOT NULL DEFAULT now(),"
    " PRIMARY KEY (period, ref))",
)


def _ensure_adjustment_schema() -> None:
    """Add the approval-workflow columns + the shared activity trail (idempotent).

    New columns default to 'signed_off' so legacy rows (and the original app,
    which posts directly) stay valid and counted without a migration. Each DDL
    runs in its own transaction and is best-effort: the schema is normally
    pre-applied by the table owner at deploy time, so if the app's service
    principal lacks ALTER privilege this simply no-ops rather than 500-ing.
    """
    ind = current_industry()
    if ind in _schema_ready:
        return
    with _schema_lock_for(ind):
        if ind in _schema_ready:
            return
        try:
            with pool.connection() as conn:
                for stmt in _SCHEMA_DDL:
                    try:
                        with conn.cursor() as cur:
                            cur.execute(stmt)
                        conn.commit()
                    except psycopg.errors.UndefinedColumn as e:
                        if not stmt.startswith("UPDATE posted_adjustments SET is_reversal"):
                            raise
                        conn.rollback()
                        print(f"[schema] skipped ({e}): {stmt[:60]}…")
                    except psycopg.errors.InsufficientPrivilege as e:
                        conn.rollback()
                        print(f"[schema] skipped ({e}): {stmt[:60]}…")
                    except psycopg.Error:
                        raise
        except Exception as e:  # noqa: BLE001
            print(f"[schema] unavailable for {ind} ({e})")
            return
        _schema_ready.add(ind)


def _audit(cur, entity_id: str, action: str, detail: str, actor: str) -> None:
    """Append one immutable event to the shared activity trail."""
    cur.execute(
        "INSERT INTO close_task_activity (activity_id, task_id, period, actor, action, detail) "
        "VALUES (%s,%s,%s,%s,%s,%s)",
        (uuid.uuid4().hex[:12], entity_id, CLOSE_PERIOD, actor, action, detail))


def _require(persona: str | None, capability: str, what: str) -> str:
    """Enforce RBAC; return the acting role label for attribution."""
    if not can(persona, capability):
        raise HTTPException(403, f"Your role isn't permitted to {what}.")
    return persona_label(persona)


# ---- approval policy (Lakebase, append-only) -----------------------------
POLICY_ID = "default"

# Cached (policy, version) per industry; busted on every policy write.
_policy_cache: dict[str, tuple[dict | None, int | None]] = {}


def _seed_policy_if_absent(cur) -> None:
    """Seed this industry's version 1 as active, so the app opens with a working
    policy. Uses the industry's control posture from `policy.default_policy_for`."""
    cur.execute("SELECT 1 FROM approval_policies WHERE policy_id = %s LIMIT 1", (POLICY_ID,))
    if cur.fetchone():
        return
    seed = default_policy_for(current_industry())
    cur.execute(
        "INSERT INTO approval_policies "
        "(policy_id, version, data, status, authored_by, attested_by, attested_ts, activated_ts) "
        "VALUES (%s, 1, %s, 'active', 'Controller', 'CFO', now(), now()) "
        "ON CONFLICT (policy_id, version) DO NOTHING",
        (POLICY_ID, json.dumps(seed)))


def _active_policy() -> tuple[dict | None, int | None]:
    """The active policy + version for this industry, or (None, None) when there
    is none or Lakebase is unreachable — both of which mean "no automation"."""
    ind = current_industry()
    if ind in _policy_cache:
        return _policy_cache[ind]
    result: tuple[dict | None, int | None] = (None, None)
    try:
        _ensure_adjustment_schema()
        with pool.connection() as conn:
            with conn.cursor() as cur:
                _seed_policy_if_absent(cur)
            conn.commit()
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT data, version FROM approval_policies "
                    "WHERE policy_id = %s AND status = 'active' ORDER BY version DESC LIMIT 1",
                    (POLICY_ID,))
                row = cur.fetchone()
                if row:
                    result = (row[0], int(row[1]))
    except Exception as e:  # noqa: BLE001 — no policy reachable => manual path
        print(f"[policy] active policy unavailable ({e})")
        return (None, None)
    _policy_cache[ind] = result
    return result


def _bust_policy_cache() -> None:
    _policy_cache.pop(current_industry(), None)


def _period_state(cur) -> dict:
    """The period context the policy needs: open break amounts per ref, value
    already auto-approved per BU, and how deep into the close we are."""
    break_amounts: dict[str, float] = {}
    try:
        for r in query(f"SELECT control_account_code, business_unit_id, abs_variance "
                       f"FROM {SRV}.recon_breaks_live WHERE is_break"):
            ref = f"{r['control_account_code']}/{r['business_unit_id']}"
            break_amounts[ref] = abs(float(r["abs_variance"] or 0))
    except Exception as e:  # noqa: BLE001 — no breaks readable => break_backed fails closed
        print(f"[policy] recon breaks unavailable ({e})")

    totals: dict[str, float] = {}
    cur.execute(
        "SELECT business_unit_id, COALESCE(SUM(amount), 0) FROM posted_adjustments "
        "WHERE period = %s AND approval_mode = 'auto' AND status <> 'void' AND leg = 'debit' "
        "GROUP BY business_unit_id",
        (CLOSE_PERIOD,))
    for bu, total in cur.fetchall():
        totals[bu] = float(total or 0)

    return {
        "break_amounts": break_amounts,
        "auto_approved_totals": totals,
        "close_bd": close_business_day(CLOSE_PERIOD, demo_today()),
    }

# column maps for scope filtering per view
_TB_COLS = {"region": "region", "legal_entity": "legal_entity_id",
            "business_unit": "business_unit_id", "business_line": "business_line"}
_RECON_COLS = {"region": "region", "legal_entity": "legal_entity_id",
               "business_unit": "business_unit_id"}
_OPEX_COLS = {"region": "region", "business_unit": "business_unit_id"}


class AdjustmentIn(BaseModel):
    debit_account: str = Field(..., description="Account code to debit")
    credit_account: str = Field(..., description="Account code to credit")
    business_unit_id: str
    amount: float = Field(..., gt=0)
    memo: str = ""
    resolves_break: str | None = None
    adjustment_type: str | None = Field(
        default=None, description=f"One of {', '.join(ADJUSTMENT_TYPES)}")


# ---- reads (governed UC) -------------------------------------------------
def _adjustment_count() -> int:
    """Distinct fully signed-off adjustments from Lakebase; 0 if unreachable.

    Only `signed_off` entries have flowed to the lake, so only they count as
    posted for the close.
    """
    try:
        _ensure_adjustment_schema()
        with pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT COUNT(DISTINCT adjustment_id) FROM posted_adjustments "
                        "WHERE period = %s AND status = 'signed_off'",
                        (CLOSE_PERIOD,))
            return int(cur.fetchone()[0])
    except Exception:  # noqa: BLE001
        return 0


def _open_approval_counts() -> dict[str, int]:
    """Entries still inside the four-eyes chain, split by which role owns them.

    `pending` sits with whoever can approve, `approved` with whoever can sign off,
    so the caller can show a persona the number that is actually theirs — the same
    split the Approvals queue makes. Reversals need no filtering here: a recall
    posts its reversal already signed off, so it is never in either bucket.

    Unscoped, matching the Approvals page: both are period-wide counts.
    """
    try:
        _ensure_adjustment_schema()
        with pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT status, COUNT(DISTINCT adjustment_id) FROM posted_adjustments "
                "WHERE period = %s AND status IN ('pending', 'approved') GROUP BY status",
                (CLOSE_PERIOD,))
            by_status = {r[0]: int(r[1]) for r in cur.fetchall()}
        return {"pending_approval": by_status.get("pending", 0),
                "awaiting_sign_off": by_status.get("approved", 0)}
    except Exception:  # noqa: BLE001
        return {"pending_approval": 0, "awaiting_sign_off": 0}


def _handled_variance_refs() -> set[str]:
    """Refs (control/bu) already cleared for close: they carry a posted adjustment
    (any non-void status) or a written explanation. Empty set if Lakebase is
    unreachable, which is treated conservatively (variances stay unexplained)."""
    _ensure_adjustment_schema()
    handled: set[str] = set()
    with pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT DISTINCT resolves_break FROM posted_adjustments "
            "WHERE period = %s AND status <> 'void' AND resolves_break IS NOT NULL",
            (CLOSE_PERIOD,))
        handled |= {r[0] for r in cur.fetchall() if r[0]}
        cur.execute("SELECT ref FROM variance_explanations WHERE period = %s", (CLOSE_PERIOD,))
        handled |= {r[0] for r in cur.fetchall()}
    return handled


def _unexplained_variance_count(scope_type: str, scope_id: str) -> int:
    """Open variances (is_break, in scope) with neither a posted adjustment nor a
    written explanation. This is the hard gate on close readiness."""
    scope = scope_clause(scope_type, scope_id, _RECON_COLS)
    rows = query(
        f"SELECT control_account_code, business_unit_id "
        f"FROM {SRV}.recon_breaks_live WHERE is_break{scope}")
    open_refs = {f"{r['control_account_code']}/{r['business_unit_id']}" for r in rows}
    if not open_refs:
        return 0
    try:
        handled = _handled_variance_refs()
    except Exception:  # noqa: BLE001 — Lakebase unreachable -> conservative NO-GO
        return len(open_refs)
    return len(open_refs - handled)


@router.get("/close-status")
def close_status(scope_type: str = Query("consolidated"), scope_id: str = Query("ALL")):
    summary = query(f"SELECT close_status, badge, fail_count, warn_count, total_checks, period "
                    f"FROM {OPS}.dq_summary")
    scope = scope_clause(scope_type, scope_id, _RECON_COLS)
    live_breaks = query(
        f"SELECT COUNT(*) AS n FROM {SRV}.recon_breaks_live WHERE is_break{scope}")
    adj_count = _adjustment_count()
    s = summary[0] if summary else {}
    return {
        "period": CLOSE_PERIOD,
        "close_status": s.get("close_status"),
        "badge": s.get("badge"),
        "fail_count": int(s.get("fail_count", 0) or 0),
        "warn_count": int(s.get("warn_count", 0) or 0),
        "total_checks": int(s.get("total_checks", 0) or 0),
        "open_recon_breaks": int(live_breaks[0]["n"]) if live_breaks else 0,
        "unexplained_variances": _unexplained_variance_count(scope_type, scope_id),
        "adjustments_posted": int(adj_count),
        **_open_approval_counts(),
    }


@router.get("/dq-checks")
def dq_checks():
    return query(
        f"SELECT check_id, dimension, scope, metric_value, status "
        f"FROM {OPS}.dq_results "
        f"ORDER BY CASE status WHEN 'FAIL' THEN 0 WHEN 'WARN' THEN 1 ELSE 2 END, dimension")


@router.get("/recon-breaks")
def recon_breaks(scope_type: str = Query("consolidated"), scope_id: str = Query("ALL")):
    where = scope_clause(scope_type, scope_id, _RECON_COLS, prefix=" WHERE ")
    return query(
        f"SELECT control_account_code, account_name, subledger, business_unit_id, "
        f"business_unit_name, region, legal_entity_id, subledger_total, gl_balance, "
        f"variance, abs_variance, is_break "
        f"FROM {SRV}.recon_breaks_live{where} ORDER BY is_break DESC, abs_variance DESC")


class ExplainIn(BaseModel):
    control_account_code: str
    business_unit_id: str
    explanation: str = Field(..., min_length=1)


@router.get("/variance-explanations")
def variance_explanations():
    """Written explanations that clear a flagged variance for close (ref = control/bu)."""
    try:
        _ensure_adjustment_schema()
        with pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT ref, explanation, explained_by, explained_ts "
                "FROM variance_explanations WHERE period = %s ORDER BY explained_ts DESC",
                (CLOSE_PERIOD,))
            cols = [d[0] for d in cur.description]
            rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    except Exception:  # noqa: BLE001
        return []
    for r in rows:
        r["explained_ts"] = r["explained_ts"].isoformat() if r.get("explained_ts") else None
    return rows


@router.post("/variance-explanations")
def explain_variance(body: ExplainIn, x_persona: str | None = Header(default=None)):
    """Document why a flagged variance is acceptable. Requires posting rights
    (Accountant / Controller). Upsert so a variance carries one current
    explanation; every write is appended to the audit trail."""
    role = _require(x_persona, "can_post", "explain variances")
    _ensure_adjustment_schema()
    ref = f"{body.control_account_code}/{body.business_unit_id}"
    explanation = body.explanation.strip()
    if not explanation:
        raise HTTPException(400, "Explanation cannot be empty")
    task_id = f"TASK-{CLOSE_PERIOD}-R-{body.control_account_code}-{body.business_unit_id}"
    with pool.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO variance_explanations (period, ref, explanation, explained_by) "
                "VALUES (%s,%s,%s,%s) "
                "ON CONFLICT (period, ref) DO UPDATE SET "
                " explanation = EXCLUDED.explanation, explained_by = EXCLUDED.explained_by, "
                " explained_ts = now()",
                (CLOSE_PERIOD, ref, explanation, role))
            _audit(cur, task_id, "variance_explained",
                   f"Explained {ref}: {explanation[:200]} [{current_user()}]", role)
        conn.commit()
    return {"ref": ref, "status": "explained", "explained_by": role}


@router.get("/trial-balance")
def trial_balance(scope_type: str = Query("consolidated"), scope_id: str = Query("ALL"),
                  period: str = Query(None)):
    p = resolve_period(period)
    where = f" WHERE period = '{p}'" + scope_clause(scope_type, scope_id, _TB_COLS, prefix=" AND ")
    return query(
        f"SELECT account_code, account_name, account_type, statement, fs_line, account_group, "
        f"SUM(total_debits) AS total_debits, SUM(total_credits) AS total_credits, "
        f"SUM(debit_balance) AS debit_balance, SUM(credit_balance) AS credit_balance "
        f"FROM {SRV}.trial_balance_by_org{where} "
        f"GROUP BY account_code, account_name, account_type, statement, fs_line, account_group "
        f"ORDER BY account_code")


@router.get("/opex-variance")
def opex_variance(scope_type: str = Query("consolidated"), scope_id: str = Query("ALL"),
                  period: str = Query(None)):
    p = resolve_period(period)
    where = f" WHERE period = '{p}'" + scope_clause(scope_type, scope_id, _OPEX_COLS, prefix=" AND ")
    return query(
        f"SELECT account_code, account_name, business_unit_id, business_unit_name, "
        f"actual_amount, forecast_amount, variance, variance_pct, variance_direction "
        f"FROM {SRV}.opex_variance{where} ORDER BY abs(variance) DESC")


@router.get("/accounts")
def accounts():
    return query(
        f"SELECT account_code, account_name, account_type, normal_balance "
        f"FROM {CLOSE}.chart_of_accounts ORDER BY account_code")


@router.get("/business-units")
def business_units():
    return query(f"SELECT business_unit_id, business_unit_name, region, country, "
                 f"legal_entity_id, legal_entity_name, primary_source_system "
                 f"FROM {CLOSE}.dim_org ORDER BY business_unit_id")


@router.get("/adjustments")
def list_adjustments():
    try:
        _ensure_adjustment_schema()
        with pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT adjustment_id, leg, account_code, business_unit_id, dr_cr, amount, "
                "memo, resolves_break, posted_by, posted_ts, status, "
                "approved_by, approved_ts, signed_off_by, signed_off_ts, "
                "adjustment_type, approval_mode, policy_version, decision_ts, "
                "decision_detail, recalled_by, recalled_ts, recall_reason, is_reversal "
                "FROM posted_adjustments WHERE period = %s AND status <> 'void' "
                "ORDER BY posted_ts DESC, adjustment_id, leg",
                (CLOSE_PERIOD,))
            cols = [d[0] for d in cur.description]
            rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    except Exception as e:  # noqa: BLE001
        # An unreachable ledger is not an empty close. Returning [] here rendered a
        # dead connection pool as "no adjustments this period" — indistinguishable
        # from a genuinely clean period, on the page that governs approvals.
        print(f"[close] adjustments unavailable for {current_industry()}: "
              f"{type(e).__name__}: {e}")
        raise HTTPException(
            status_code=503,
            detail="The adjustment ledger is unreachable, so this queue can't be "
                   "shown. This is a connection problem, not an empty period.",
        ) from e
    for r in rows:
        r["amount"] = float(r["amount"])
        for ts in ("posted_ts", "approved_ts", "signed_off_ts", "decision_ts", "recalled_ts"):
            r[ts] = r[ts].isoformat() if r.get(ts) else None
    return rows


# ---- write: governed Accountant -> Controller -> CFO workflow ------------
# The lake table is created by serving/serving_views.sql, which may predate the
# policy columns on an already-deployed catalog. Adding them is best-effort and
# cached per industry: when the ALTER can't be applied (no privilege, older
# deployment) the insert simply omits them rather than failing the sign-off.
_lake_policy_cols: dict[str, bool] = {}


def _lake_carries_policy_cols() -> bool:
    ind = current_industry()
    if ind not in _lake_policy_cols:
        try:
            query(f"ALTER TABLE {CLOSE}.posted_adjustments "
                  f"ADD COLUMNS (approval_mode STRING, policy_version INT)")
            _lake_policy_cols[ind] = True
        except Exception as e:  # noqa: BLE001
            msg = str(e).lower()
            # "already exists" means a previous run (or the seed) added them.
            _lake_policy_cols[ind] = "already exist" in msg or "already exists" in msg
            if not _lake_policy_cols[ind]:
                print(f"[policy] lake policy columns unavailable ({e})")
    return _lake_policy_cols[ind]


def _flow_many_to_lake(cur, adjustment_ids: Sequence[str]) -> None:
    """Push the signed-off legs of several adjustments to the lake in one INSERT.

    One statement per batch rather than per entry: the warehouse round trip costs
    about a second and `invalidate_cache` clears every cached read, so flowing N
    entries separately also forces N re-reads of the chart of accounts and org.
    The demo seeder posts twenty entries at once and needs both costs paid once.
    """
    ids = list(dict.fromkeys(adjustment_ids))
    if not ids:
        return
    cur.execute(
        "SELECT adjustment_id, account_code, business_unit_id, dr_cr, amount, memo, "
        "posted_by, approval_mode, policy_version "
        "FROM posted_adjustments WHERE adjustment_id = ANY(%s) AND period = %s "
        "ORDER BY adjustment_id, leg",
        (ids, CLOSE_PERIOD))
    legs = cur.fetchall()
    if not legs:
        return
    with_policy = _lake_carries_policy_cols()
    # Build the VALUES list explicitly (amounts are numeric, not quoted).
    rows_sql = ",\n".join(
        "('{aid}','{per}','{acct}','{bu}','{drcr}',{amt},'{memo}','{by}',"
        "current_timestamp(),'app'{extra})".format(
            aid=aid, per=CLOSE_PERIOD, acct=acct, bu=bu, drcr=drcr,
            amt=round(float(amt), 2),
            memo=(memo or "").replace("'", "''"),
            by=(by or "").replace("'", "''"),
            extra=(f",'{mode or 'manual'}',{int(ver) if ver else 'NULL'}"
                   if with_policy else ""))
        for aid, acct, bu, drcr, amt, memo, by, mode, ver in legs
    )
    cols = ("adjustment_id, period, account_code, business_unit_id, dr_cr, amount, memo, "
            "posted_by, posted_ts, source")
    if with_policy:
        cols += ", approval_mode, policy_version"
    query(f"INSERT INTO {CLOSE}.posted_adjustments ({cols}) VALUES\n{rows_sql}")
    # The adjustments are now in the lake, so the serving views (trial balance,
    # recon breaks, KPIs) have changed — drop cached reads so they refresh.
    invalidate_cache()


def _flow_to_lake(cur, adjustment_id: str) -> None:
    """Push one adjustment's signed-off legs to the lake so the real-time trial
    balance + live reconciliation reflect it. Called on CFO sign-off and on
    policy auto-approval alike — the ledger path is identical either way."""
    _flow_many_to_lake(cur, [adjustment_id])


# ---- decide + record: shared by the live POST and the demo seeder ---------
# Split out so the seeder cannot drift from the endpoint. Deciding is pure, and
# the rows are built without touching the database, so a caller may persist one
# entry (the POST) or a whole period's worth in two statements (the seeder) and
# get byte-identical ledger rows, audit events and lake behaviour either way.
@dataclass
class Decided:
    """One entry's verdict plus the rows that record it. `legs` and `events` are
    parameter tuples for `posted_adjustments` and `close_task_activity`."""
    adjustment_id: str
    auto: bool
    status: str
    decision: Any
    actor: str | None
    legs: list[tuple]
    events: list[tuple]

    @property
    def broken_rules(self) -> list[str]:
        return list(self.decision.broken_rules)


def decide_adjustment(adj: "AdjustmentIn", role: str, policy: dict | None,
                      policy_version: int | None, acct_types: dict[str, str | None],
                      state: dict) -> Decided:
    """Run the Controller's policy over one entry and build its ledger + audit
    rows. No I/O, so the cumulative-cap and break-backed rules see exactly the
    `state` the caller hands in — which is what lets a batch caller advance that
    state between entries instead of re-reading the period after every post."""
    adjustment_id = f"APP-{CLOSE_PERIOD}-{uuid.uuid4().hex[:8]}"
    amount = round(adj.amount, 2)
    decision = evaluate_policy(
        {
            "amount": amount,
            "business_unit_id": adj.business_unit_id,
            "debit_account": adj.debit_account,
            "debit_account_type": acct_types.get(adj.debit_account),
            "credit_account": adj.credit_account,
            "credit_account_type": acct_types.get(adj.credit_account),
            "adjustment_type": adj.adjustment_type,
            "memo": adj.memo,
            "resolves_break": adj.resolves_break,
        },
        policy,
        state,
    )
    auto = decision.is_auto
    detail = json.dumps(decision.as_detail(policy, policy_version))
    # An auto-approved entry is attributed to the policy, never to a person: the
    # UI must never suggest a human reviewed what a rule did.
    actor = f"{(policy or {}).get('name', 'Policy')} v{policy_version}" if auto else None
    status = "signed_off" if auto else "pending"
    decided_at = datetime.now(timezone.utc) if auto else None

    legs = [
        (adjustment_id, CLOSE_PERIOD, leg, account, adj.business_unit_id, drcr,
         amount, adj.memo, adj.resolves_break, role, status, adj.adjustment_type,
         "auto" if auto else "manual", POLICY_ID if auto else None,
         policy_version if auto else None, detail, actor, decided_at, actor, decided_at)
        for leg, account, drcr in (("debit", adj.debit_account, "D"),
                                   ("credit", adj.credit_account, "C"))
    ]

    events = [(adjustment_id, "adjustment_posted",
               f"Posted {adj.debit_account}/{adj.credit_account} ${amount:,.2f} "
               f"({adj.business_unit_id}) [{current_user()}]", role)]
    if auto:
        events.append((adjustment_id, "adjustment_auto_approved",
                       f"Auto-approved and signed off under {actor} — "
                       f"{len(decision.evaluations)} rules passed, flowed to the lake",
                       actor))
    else:
        reasons = decision.reasons()
        why = "; ".join(reasons) if reasons else "auto-approval is disabled"
        events.append((adjustment_id, "adjustment_routed_to_review",
                       f"Routed to review — {why}", role))

    return Decided(adjustment_id=adjustment_id, auto=auto, status=status,
                   decision=decision, actor=actor, legs=legs, events=events)


_ADJ_INSERT = (
    "INSERT INTO posted_adjustments "
    "(adjustment_id, period, leg, account_code, business_unit_id, dr_cr, "
    " amount, memo, resolves_break, posted_by, status, adjustment_type, "
    " approval_mode, policy_id, policy_version, decision_ts, decision_detail, "
    " approved_by, approved_ts, signed_off_by, signed_off_ts) "
    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now(),%s,%s,%s,%s,%s)")


def record_decided(cur, decided: Sequence[Decided]) -> None:
    """Write every leg and audit event for a batch, two statements regardless of
    size. Each Lakebase round trip is tens of milliseconds deployed and hundreds
    from a laptop, so a twenty-entry seed run must not issue a hundred of them."""
    legs = [row for d in decided for row in d.legs]
    if not legs:
        return
    cur.executemany(_ADJ_INSERT, legs)
    cur.executemany(
        "INSERT INTO close_task_activity (activity_id, task_id, period, actor, action, detail) "
        "VALUES (%s,%s,%s,%s,%s,%s)",
        [(uuid.uuid4().hex[:12], entity, CLOSE_PERIOD, actor, action, detail)
         for d in decided for entity, action, detail, actor in d.events])


def advance_state(state: dict, adj: "AdjustmentIn", d: Decided) -> None:
    """Fold one auto-approval back into the period state, so the next entry in a
    batch is judged against the period its predecessors actually created: the
    cumulative cap counts value already auto-approved, and a cleared break is no
    longer open for the next entry to claim."""
    if not d.auto:
        return
    totals = state.setdefault("auto_approved_totals", {})
    totals[adj.business_unit_id] = totals.get(adj.business_unit_id, 0.0) + round(adj.amount, 2)
    if adj.resolves_break:
        (state.setdefault("break_amounts", {})).pop(adj.resolves_break, None)


@router.post("/adjustments")
def post_adjustment(adj: AdjustmentIn, x_persona: str | None = Header(default=None)):
    role = _require(x_persona, "can_post", "post adjustments")
    _ensure_adjustment_schema()
    valid_accounts = {a["account_code"] for a in accounts()}
    valid_bus = {b["business_unit_id"] for b in business_units()}
    if adj.debit_account not in valid_accounts or adj.credit_account not in valid_accounts:
        raise HTTPException(400, "Unknown account code")
    if adj.business_unit_id not in valid_bus:
        raise HTTPException(400, "Unknown business unit")
    if adj.debit_account == adj.credit_account:
        raise HTTPException(400, "Debit and credit accounts must differ")

    if adj.adjustment_type and adj.adjustment_type not in ADJUSTMENT_TYPES:
        raise HTTPException(400, f"Unknown adjustment type '{adj.adjustment_type}'")

    acct_types = {a["account_code"]: a.get("account_type") for a in accounts()}
    policy, policy_version = _active_policy()

    with pool.connection() as conn:
        with conn.cursor() as cur:
            # Evaluate the Controller's policy on the entry as posted. The
            # candidate carries resolved account TYPES so the restricted-account
            # rule is expressed semantically rather than per industry code list.
            d = decide_adjustment(adj, role, policy, policy_version,
                                  acct_types, _period_state(cur))
            record_decided(cur, [d])
        conn.commit()

        # Flow to the lake only after the transactional state change is committed,
        # exactly as CFO sign-off does.
        if d.auto:
            with conn.cursor() as cur:
                _flow_to_lake(cur, d.adjustment_id)

    return {
        "adjustment_id": d.adjustment_id,
        "legs": 2,
        "posted_by": role,
        "status": d.status,
        "approval_mode": "auto" if d.auto else "manual",
        "policy_version": policy_version if d.auto else None,
        "policy_name": (policy or {}).get("name") if d.auto else None,
        "broken_rules": d.decision.broken_rules,
        "reasons": d.decision.reasons(),
    }


@router.post("/adjustments/{adjustment_id}/approve")
def approve_adjustment(adjustment_id: str, x_persona: str | None = Header(default=None)):
    role = _require(x_persona, "can_approve", "approve adjustments")
    _ensure_adjustment_schema()
    with pool.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT DISTINCT status, posted_by FROM posted_adjustments "
                "WHERE adjustment_id = %s AND period = %s",
                (adjustment_id, CLOSE_PERIOD))
            row = cur.fetchone()
            if row is None:
                raise HTTPException(404, "Adjustment not found")
            status, posted_by = row
            if status != "pending":
                raise HTTPException(409, f"Adjustment is already {status}, not pending")
            # Segregation of duties: the approver must be a different role than the poster.
            if role == posted_by:
                raise HTTPException(403, "Segregation of duties: the approver must differ from the poster")
            cur.execute(
                "UPDATE posted_adjustments SET status='approved', approved_by=%s, approved_ts=now() "
                "WHERE adjustment_id=%s AND period=%s",
                (role, adjustment_id, CLOSE_PERIOD))
            _audit(cur, adjustment_id, "adjustment_approved",
                   f"Approved by {role} — awaiting CFO sign-off [{current_user()}]", role)
        conn.commit()
    return {"adjustment_id": adjustment_id, "status": "approved", "approved_by": role}


@router.post("/adjustments/{adjustment_id}/sign-off")
def sign_off_adjustment(adjustment_id: str, x_persona: str | None = Header(default=None)):
    role = _require(x_persona, "can_sign_off", "sign off adjustments")
    _ensure_adjustment_schema()
    with pool.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT DISTINCT status, approved_by FROM posted_adjustments "
                "WHERE adjustment_id = %s AND period = %s",
                (adjustment_id, CLOSE_PERIOD))
            row = cur.fetchone()
            if row is None:
                raise HTTPException(404, "Adjustment not found")
            status, approved_by = row
            if status != "approved":
                raise HTTPException(409, f"Adjustment must be approved before sign-off (currently {status})")
            if role == approved_by:
                raise HTTPException(403, "Segregation of duties: the signer must differ from the approver")
            cur.execute(
                "UPDATE posted_adjustments SET status='signed_off', signed_off_by=%s, signed_off_ts=now() "
                "WHERE adjustment_id=%s AND period=%s",
                (role, adjustment_id, CLOSE_PERIOD))
            _audit(cur, adjustment_id, "adjustment_signed_off",
                   f"Signed off by {role} — attested complete & accurate, flowed to the lake "
                   f"[{current_user()}]", role)
        conn.commit()
        # Flow to the lake after the transactional state change is committed.
        with conn.cursor() as cur:
            _flow_to_lake(cur, adjustment_id)
    return {"adjustment_id": adjustment_id, "status": "signed_off", "signed_off_by": role}


# ---- approval policy: author (Controller) -> attest (CFO) ----------------
class PolicyIn(BaseModel):
    data: dict


class RecallIn(BaseModel):
    reason: str = Field(..., min_length=5)


def _policy_rows() -> list[dict]:
    with pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT version, data, status, authored_by, authored_ts, attested_by, "
            "attested_ts, activated_ts, retired_ts FROM approval_policies "
            "WHERE policy_id = %s ORDER BY version DESC",
            (POLICY_ID,))
        cols = [d[0] for d in cur.description]
        rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    for r in rows:
        for ts in ("authored_ts", "attested_ts", "activated_ts", "retired_ts"):
            r[ts] = r[ts].isoformat() if r.get(ts) else None
    return rows


@router.get("/approval-policy")
def get_approval_policy():
    """The active policy for this industry, plus the rule catalogue the editor
    renders. `active` is null when there is none — which means no automation."""
    policy, version = _active_policy()
    return {
        "policy_id": POLICY_ID,
        "version": version,
        "active": policy,
        "adjustment_types": list(ADJUSTMENT_TYPES),
        "close_bd": close_business_day(CLOSE_PERIOD, demo_today()),
    }


@router.get("/approval-policy/versions")
def list_approval_policy_versions():
    """Full immutable version history, newest first, each with its diff against
    the version it replaced. This is the look-back surface in Settings."""
    try:
        _ensure_adjustment_schema()
        rows = _policy_rows()
    except Exception:  # noqa: BLE001
        return []
    by_version = {r["version"]: r for r in rows}
    for r in rows:
        prior = by_version.get(r["version"] - 1)
        r["diff"] = policy_diff(prior["data"] if prior else None, r["data"])
    return rows


@router.post("/approval-policy")
def draft_approval_policy(body: PolicyIn, x_persona: str | None = Header(default=None)):
    """Author a new DRAFT version. Drafts never take effect until the CFO attests,
    so the Controller can iterate and simulate freely."""
    role = _require(x_persona, "can_approve", "author the approval policy")
    _ensure_adjustment_schema()
    data = normalize_policy(body.data)
    with pool.connection() as conn:
        with conn.cursor() as cur:
            _seed_policy_if_absent(cur)
            cur.execute("SELECT COALESCE(MAX(version), 0) FROM approval_policies "
                        "WHERE policy_id = %s", (POLICY_ID,))
            version = int(cur.fetchone()[0]) + 1
            cur.execute(
                "INSERT INTO approval_policies "
                "(policy_id, version, data, status, authored_by) "
                "VALUES (%s,%s,%s,'draft',%s)",
                (POLICY_ID, version, json.dumps(data), role))
            _audit(cur, f"POLICY-{POLICY_ID}-v{version}", "policy_drafted",
                   f"Drafted v{version} by {role} — awaiting CFO attestation "
                   f"[{current_user()}]", role)
        conn.commit()
    return {"policy_id": POLICY_ID, "version": version, "status": "draft", "data": data}


@router.post("/approval-policy/{version}/attest")
def attest_approval_policy(version: int, x_persona: str | None = Header(default=None)):
    """Attest and activate a draft, retiring the version it replaces.

    This is the four-eyes control, relocated from the entry to the policy: the
    role that authored the draft cannot be the role that puts it in force.
    """
    role = _require(x_persona, "can_sign_off", "attest the approval policy")
    _ensure_adjustment_schema()
    with pool.connection() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT status, authored_by FROM approval_policies "
                        "WHERE policy_id = %s AND version = %s", (POLICY_ID, version))
            row = cur.fetchone()
            if row is None:
                raise HTTPException(404, "Policy version not found")
            status, authored_by = row
            if status != "draft":
                raise HTTPException(409, f"Policy v{version} is already {status}, not a draft")
            if role == authored_by:
                raise HTTPException(
                    403, "Segregation of duties: the attester must differ from the author")
            cur.execute(
                "UPDATE approval_policies SET status='retired', retired_ts=now() "
                "WHERE policy_id=%s AND status='active'", (POLICY_ID,))
            cur.execute(
                "UPDATE approval_policies SET status='active', attested_by=%s, "
                "attested_ts=now(), activated_ts=now() "
                "WHERE policy_id=%s AND version=%s", (role, POLICY_ID, version))
            _audit(cur, f"POLICY-{POLICY_ID}-v{version}", "policy_attested",
                   f"Attested and activated v{version} by {role} (authored by "
                   f"{authored_by}) [{current_user()}]", role)
        conn.commit()
    _bust_policy_cache()
    return {"policy_id": POLICY_ID, "version": version, "status": "active", "attested_by": role}


@router.post("/approval-policy/simulate")
def simulate_approval_policy(body: PolicyIn, x_persona: str | None = Header(default=None)):
    """Score a candidate policy against this period's adjustments.

    Nobody should activate a policy they have not seen scored: this replays every
    adjustment posted this period through the candidate rules and reports what
    would have auto-approved and what would have come to a human, and why.
    """
    _require(x_persona, "can_approve", "simulate the approval policy")
    _ensure_adjustment_schema()
    candidate = normalize_policy(body.data)
    acct_types = {a["account_code"]: a.get("account_type") for a in accounts()}

    with pool.connection() as conn, conn.cursor() as cur:
        state = _period_state(cur)
        cur.execute(
            "SELECT adjustment_id, business_unit_id, amount, memo, resolves_break, "
            " adjustment_type,"
            " MAX(CASE WHEN dr_cr = 'D' THEN account_code END) AS debit_account,"
            " MAX(CASE WHEN dr_cr = 'C' THEN account_code END) AS credit_account "
            "FROM posted_adjustments "
            "WHERE period = %s AND status <> 'void' AND NOT is_reversal "
            "GROUP BY adjustment_id, business_unit_id, amount, memo, resolves_break, "
            " adjustment_type "
            "ORDER BY adjustment_id",
            (CLOSE_PERIOD,))
        cols = [d[0] for d in cur.description]
        entries = [dict(zip(cols, r)) for r in cur.fetchall()]

    # Replay in order, accumulating the cumulative cap exactly as live posting
    # would, so the simulation reflects the real running-total behaviour.
    totals: dict[str, float] = {}
    results = []
    for e in entries:
        amount = float(e["amount"])
        bu = e["business_unit_id"]
        decision = evaluate_policy(
            {
                "amount": amount,
                "business_unit_id": bu,
                "debit_account": e["debit_account"],
                "debit_account_type": acct_types.get(e["debit_account"]),
                "credit_account": e["credit_account"],
                "credit_account_type": acct_types.get(e["credit_account"]),
                "adjustment_type": e["adjustment_type"],
                "memo": e["memo"],
                "resolves_break": e["resolves_break"],
            },
            candidate,
            {**state, "auto_approved_totals": dict(totals)},
        )
        if decision.is_auto:
            totals[bu] = totals.get(bu, 0.0) + amount
        results.append({
            "adjustment_id": e["adjustment_id"],
            "business_unit_id": bu,
            "amount": amount,
            "mode": decision.mode,
            "broken_rules": decision.broken_rules,
            "reasons": decision.reasons(),
        })

    auto = [r for r in results if r["mode"] == "auto"]
    total_value = sum(r["amount"] for r in results)
    auto_value = sum(r["amount"] for r in auto)
    return {
        "evaluated": len(results),
        "auto_approved": len(auto),
        "routed_to_review": len(results) - len(auto),
        "auto_share_pct": round(len(auto) / len(results) * 100, 1) if results else 0.0,
        "auto_value": round(auto_value, 2),
        "total_value": round(total_value, 2),
        "auto_value_share_pct": round(auto_value / total_value * 100, 1) if total_value else 0.0,
        "results": results,
    }


@router.post("/adjustments/{adjustment_id}/recall")
def recall_adjustment(adjustment_id: str, body: RecallIn,
                      x_persona: str | None = Header(default=None)):
    """Reverse an auto-approved entry that should not have passed.

    Nothing is ever deleted or edited: the original stays exactly as posted and is
    stamped with who recalled it and why, while a balanced reversing entry nets it
    out of the ledger. Recalls are the signal that the rules need tightening.
    """
    if not (can(x_persona, "can_approve") or can(x_persona, "can_sign_off")):
        raise HTTPException(403, "Your role isn't permitted to recall adjustments.")
    role = persona_label(x_persona)
    _ensure_adjustment_schema()
    reversal_id = f"{adjustment_id}-REV"

    with pool.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT leg, account_code, business_unit_id, dr_cr, amount, approval_mode, "
                " status, recalled_by, adjustment_type "
                "FROM posted_adjustments WHERE adjustment_id = %s AND period = %s ORDER BY leg",
                (adjustment_id, CLOSE_PERIOD))
            legs = cur.fetchall()
            if not legs:
                raise HTTPException(404, "Adjustment not found")
            if legs[0][5] != "auto":
                raise HTTPException(409, "Only policy auto-approved entries can be recalled")
            if legs[0][6] != "signed_off":
                raise HTTPException(409, "Only signed-off entries can be recalled")
            if legs[0][7]:
                raise HTTPException(409, "Adjustment has already been recalled")

            # The reversal swaps each leg's side, so the pair nets to zero. It
            # carries the original's type so it reads as what it reverses.
            for leg, account, bu, drcr, amount, _mode, _st, _rb, adj_type in legs:
                cur.execute(
                    "INSERT INTO posted_adjustments "
                    "(adjustment_id, period, leg, account_code, business_unit_id, dr_cr, "
                    " amount, memo, posted_by, status, approval_mode, is_reversal, "
                    " adjustment_type, approved_by, approved_ts, signed_off_by, signed_off_ts) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,'signed_off','manual',true,"
                    " %s,%s,now(),%s,now())",
                    (reversal_id, CLOSE_PERIOD, leg, account, bu,
                     "C" if drcr == "D" else "D", amount,
                     f"Reversal of {adjustment_id}: {body.reason}", role, adj_type,
                     role, role))

            cur.execute(
                "UPDATE posted_adjustments SET recalled_by=%s, recalled_ts=now(), "
                "recall_reason=%s WHERE adjustment_id=%s AND period=%s",
                (role, body.reason, adjustment_id, CLOSE_PERIOD))
            _audit(cur, adjustment_id, "adjustment_recalled",
                   f"Recalled by {role}: {body.reason} — reversing entry {reversal_id} "
                   f"posted [{current_user()}]", role)
        conn.commit()
        with conn.cursor() as cur:
            _flow_to_lake(cur, reversal_id)

    return {"adjustment_id": adjustment_id, "reversal_id": reversal_id,
            "status": "recalled", "recalled_by": role}


@router.get("/auto-approval-register")
def auto_approval_register():
    """The period's auto-approved population: the audit deliverable and the CFO's
    attestation surface. Reports auto-approved value as a share of the total,
    which is the risk counterweight to the automation-rate headline."""
    try:
        _ensure_adjustment_schema()
        with pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT adjustment_id, business_unit_id, amount, memo, adjustment_type, "
                " policy_version, decision_ts, decision_detail, recalled_by, recalled_ts, "
                " recall_reason "
                "FROM posted_adjustments "
                "WHERE period = %s AND status <> 'void' AND approval_mode = 'auto' "
                " AND leg = 'debit' AND NOT is_reversal "
                "ORDER BY decision_ts DESC",
                (CLOSE_PERIOD,))
            cols = [d[0] for d in cur.description]
            entries = [dict(zip(cols, r)) for r in cur.fetchall()]
            cur.execute(
                "SELECT COUNT(*), COALESCE(SUM(amount), 0) FROM posted_adjustments "
                "WHERE period = %s AND status <> 'void' AND leg = 'debit' AND NOT is_reversal",
                (CLOSE_PERIOD,))
            total_count, total_value = cur.fetchone()
    except Exception:  # noqa: BLE001
        return {"period": CLOSE_PERIOD, "entries": [], "auto_count": 0, "total_count": 0,
                "auto_value": 0.0, "total_value": 0.0, "count_share_pct": 0.0,
                "value_share_pct": 0.0, "policy_versions": [], "recalled_count": 0}

    for e in entries:
        e["amount"] = float(e["amount"])
        for ts in ("decision_ts", "recalled_ts"):
            e[ts] = e[ts].isoformat() if e.get(ts) else None
    auto_value = sum(e["amount"] for e in entries)
    total_value = float(total_value or 0)
    total_count = int(total_count or 0)
    return {
        "period": CLOSE_PERIOD,
        "entries": entries,
        "auto_count": len(entries),
        "total_count": total_count,
        "auto_value": round(auto_value, 2),
        "total_value": round(total_value, 2),
        "count_share_pct": round(len(entries) / total_count * 100, 1) if total_count else 0.0,
        "value_share_pct": round(auto_value / total_value * 100, 1) if total_value else 0.0,
        "policy_versions": sorted({e["policy_version"] for e in entries
                                   if e.get("policy_version")}),
        "recalled_count": sum(1 for e in entries if e.get("recalled_by")),
    }


# ---- demo reset: rotate the reconciliation scenario ----------------------
# The demo reset shapes the governed breaks purely through the lake
# `posted_adjustments` table (the SP has MODIFY = INSERT/DELETE there). Because
# `recon_breaks_live` compares subledger vs GL and GL includes posted
# adjustments, we can MANUFACTURE a break of any amount on any control account x
# BU (insert a balanced entry whose control leg shifts that control's GL) and
# CLEAR any open break (post a correcting entry sized to its live variance).
# Every injected entry is balanced (debits = credits, so no spurious DQ validity
# failure) with a balance-sheet offset leg (net income unchanged), and tagged
# source='demo_reset' so the next reset removes it cleanly.
CONTROL_NORMAL = {"20000": "C", "22000": "C", "11000": "D", "12000": "D", "10100": "D"}
# Offset leg keeps the entry balanced without touching P&L: a BS account whose
# natural side is opposite the control move nets net-income to zero.
OFFSET_FOR = {"C": "13000", "D": "21000"}  # Prepaid (D) / Accrued (C)

# Curated rotation: each click advances to the next scenario. Every scenario has
# a distinct mix of control accounts, BUs, variance amounts, open-vs-cleared
# counts, and recon task flavor (status / blocked / owner) so the demo always
# opens on a different picture. Owners are drawn from the close team.
DEMO_SCENARIOS: list[dict] = [
    {"name": "AP timing + bank in transit", "breaks": [
        {"code": "20000", "bu": "BU-100", "amount": 18400, "status": "IN_PROGRESS", "owner": "Marcus Lee"},
        {"code": "10100", "bu": "BU-200", "amount": 6250, "status": "NOT_STARTED", "blocked": True, "reason": "Awaiting upstream data"},
        {"code": "11000", "bu": "BU-400", "amount": 27900, "status": "NOT_STARTED"},
    ]},
    {"name": "Inventory relief backlog", "breaks": [
        {"code": "12000", "bu": "BU-200", "amount": 12750, "status": "NOT_STARTED"},
        {"code": "12000", "bu": "BU-300", "amount": 9300, "status": "IN_PROGRESS", "owner": "Priya Nair"},
        {"code": "22000", "bu": "BU-100", "amount": 4100, "status": "NOT_STARTED", "blocked": True, "reason": "Dependency"},
    ]},
    {"name": "Receivables focus", "breaks": [
        {"code": "11000", "bu": "BU-100", "amount": 41200, "status": "IN_REVIEW", "owner": "Sarah Chen"},
        {"code": "11000", "bu": "BU-300", "amount": 15600, "status": "NOT_STARTED"},
        {"code": "20000", "bu": "BU-400", "amount": 8900, "status": "IN_PROGRESS", "owner": "David Okafor"},
    ]},
    {"name": "Broad cross-BU", "breaks": [
        {"code": "20000", "bu": "BU-200", "amount": 22000, "status": "NOT_STARTED"},
        {"code": "10100", "bu": "BU-100", "amount": 5400, "status": "NOT_STARTED", "blocked": True, "reason": "System issue"},
        {"code": "22000", "bu": "BU-300", "amount": 7700, "status": "NOT_STARTED"},
        {"code": "12000", "bu": "BU-400", "amount": 13100, "status": "IN_PROGRESS", "owner": "Elena Rossi"},
    ]},
    {"name": "Two-break clean close", "breaks": [
        {"code": "11000", "bu": "BU-200", "amount": 19800, "status": "IN_PROGRESS", "owner": "Marcus Lee"},
        {"code": "10100", "bu": "BU-300", "amount": 3900, "status": "NOT_STARTED"},
    ]},
    {"name": "Payroll & AP squeeze", "breaks": [
        {"code": "22000", "bu": "BU-100", "amount": 6600, "status": "NOT_STARTED"},
        {"code": "22000", "bu": "BU-200", "amount": 5200, "status": "NOT_STARTED", "blocked": True, "reason": "Capacity"},
        {"code": "20000", "bu": "BU-100", "amount": 16750, "status": "IN_PROGRESS", "owner": "David Okafor"},
    ]},
]

_mem_reset_index = -1  # fallback rotation counter if close_config is unreachable


def _next_scenario_index() -> int:
    """Read + increment the persisted rotation index (close_config row), so the
    scenario advances one step per reset and survives app restarts."""
    global _mem_reset_index
    try:
        with pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT data FROM close_config WHERE config_id = 'demo_reset'")
            row = cur.fetchone()
            current = int((row[0] or {}).get("index", -1)) if row and row[0] else -1
            nxt = current + 1
            cur.execute(
                "INSERT INTO close_config (config_id, data, updated_ts) "
                "VALUES ('demo_reset', %s, now()) "
                "ON CONFLICT (config_id) DO UPDATE SET data = EXCLUDED.data, updated_ts = now()",
                (json.dumps({"index": nxt}),))
            conn.commit()
            return nxt
    except Exception:  # noqa: BLE001
        _mem_reset_index += 1
        return _mem_reset_index


def _legs_for(code: str, delta: float) -> list[tuple[str, str, float]]:
    """Two balanced legs that move the control account's variance by `delta`
    (variance = subledger_total - gl_balance). Moving variance by +delta means
    moving GL by -delta; the direction depends on the control's normal balance.
    Returns [(account, dr_cr, amount), ...] with a BS offset leg."""
    amt = round(abs(delta), 2)
    normal = CONTROL_NORMAL[code]
    offset = OFFSET_FOR[normal]
    if normal == "C":            # gl = credits - debits
        ctrl_dr = "D" if delta > 0 else "C"
    else:                        # gl = debits - credits
        ctrl_dr = "C" if delta > 0 else "D"
    off_dr = "C" if ctrl_dr == "D" else "D"
    return [(code, ctrl_dr, amt), (offset, off_dr, amt)]


def _sacrificial_refs(live: dict, targets: dict, rng: random.Random) -> dict:
    """Extra breaks for the seeded auto-approvals to clear, on cells the scenario
    does not use.

    Where `break_backed` is on, the only way an entry can auto-approve is by
    genuinely clearing an open break — and clearing one closes it. Without these,
    seeding would eat the scenario's own breaks and leave the Reconciliation page
    empty. These are sized under the amount limit so they are clearable, get
    consumed during the same reset, and never reach the Reconciliation page.
    """
    policy, _ = _active_policy()
    rules = (policy or {}).get("rules") or {}
    if not (rules.get("break_backed") or {}).get("enabled"):
        return {}
    limit = float((rules.get("amount_limit") or {}).get("max_amount") or 0)
    if limit <= 0:
        return {}
    free = sorted(cell for cell in live
                  if cell[0] in CONTROL_NORMAL and cell not in targets)
    return {cell: round(limit * f, 2)
            for cell, f in zip(rng.sample(free, min(4, len(free))),
                               (0.14, 0.31, 0.47, 0.63))}


@router.post("/demo/reset")
def demo_reset():
    """Rotate the reconciliation demo to the next curated scenario and re-seed the
    Approvals queue, so the demo opens with breaks to work AND adjustments in
    every stage of the four-eyes chain.

    Permission-safe: only DELETE/INSERT on the lake `posted_adjustments`
    (covered by MODIFY) and SELECT/INSERT/UPDATE on Lakebase. Never DELETEs from
    Lakebase. Degrades gracefully if Lakebase is unreachable (the lake-driven
    breaks still rotate; task state just won't update)."""
    index = _next_scenario_index()
    scenario = DEMO_SCENARIOS[index % len(DEMO_SCENARIOS)]
    # Seeded off the rotation counter, so each click gives a different picture and
    # the same click always gives the same one — a rehearsed demo stays rehearsable.
    rng = random.Random(f"{current_industry()}:{index}")

    # 1. Clean slate on the lake -> back to the seeded baseline breaks.
    query(f"DELETE FROM {CLOSE}.posted_adjustments "
          f"WHERE period = '{CLOSE_PERIOD}' AND source IN ('app','demo_reset')")
    invalidate_cache()

    # 2. Read the live (baseline) variance per control x BU cell.
    live_rows = query(
        f"SELECT control_account_code, business_unit_id, variance "
        f"FROM {SRV}.recon_breaks_live", use_cache=False)
    live = {(r["control_account_code"], r["business_unit_id"]): float(r.get("variance") or 0)
            for r in live_rows}

    # 3. Target: each scenario cell should show a +amount variance; every other
    #    cell should be clean (0). Build the injected balanced entries.
    targets = {(b["code"], b["bu"]): float(b["amount"]) for b in scenario["breaks"]}
    sacrificial = _sacrificial_refs(live, targets, rng)
    for cell, amount in sacrificial.items():
        targets[cell] = amount
    values: list[str] = []
    for (code, bu), base in live.items():
        if code not in CONTROL_NORMAL:
            continue
        target = targets.get((code, bu), 0.0)
        delta = target - base
        if abs(delta) <= 1.0:
            continue
        aid = f"DEMO-{CLOSE_PERIOD}-{uuid.uuid4().hex[:8]}"
        memo = f"Demo scenario: {code} {bu}".replace("'", "''")
        for acct, drcr, amt in _legs_for(code, delta):
            values.append(
                "('{aid}','{per}','{acct}','{bu}','{drcr}',{amt},'{memo}',"
                "'demo_reset',current_timestamp(),'demo_reset')".format(
                    aid=aid, per=CLOSE_PERIOD, acct=acct, bu=bu, drcr=drcr, amt=amt, memo=memo))
    if values:
        query(
            f"INSERT INTO {CLOSE}.posted_adjustments "
            f"(adjustment_id, period, account_code, business_unit_id, dr_cr, amount, "
            f"memo, posted_by, posted_ts, source) VALUES\n" + ",\n".join(values))
    invalidate_cache()

    # 3a. Void the previous period's workflow rows, then seed a fresh queue. Both
    #     happen before the recon task sync below: the seeded correcting entries
    #     clear the sacrificial breaks, and the sync should only see what is left.
    seeded: dict = {}
    try:
        from .. import demo_seed
        with pool.connection() as conn:
            with conn.cursor() as cur:
                _ensure_adjustment_schema()
                # Can't DELETE on Lakebase (INSERT/UPDATE-only role), so mark out.
                cur.execute(
                    "UPDATE posted_adjustments SET status='void' "
                    "WHERE period=%s AND status <> 'void'", (CLOSE_PERIOD,))
            conn.commit()
            with conn.cursor() as cur:
                out = demo_seed.seed(
                    cur, rng,
                    clearable={f"{code}/{bu}" for code, bu in sacrificial})
            conn.commit()
        seeded = {"adjustments": len(out.posted), "by_status": out.by_status(),
                  "rules": out.rule_hits(), "reopened": out.reopened}
        if out.mismatched:
            print(f"[demo_reset] seed intent mismatches: {out.mismatched}")
    except Exception as e:  # noqa: BLE001 — an empty queue beats a failed reset
        print(f"[demo_reset] adjustment seeding skipped ({e})")

    # 3b. Restore the ZeroOps "Approve repair" inbox: the schema-drift signal
    #     stays auto-healed (RESOLVED); every other signal returns to PROPOSED
    #     with its approver cleared, so the Controller has repairs to approve
    #     again after a reset. Needs MODIFY on ops.zeroops_insights; wrapped so a
    #     missing grant degrades gracefully rather than failing the whole reset.
    try:
        query(
            f"UPDATE {OPS}.zeroops_insights "
            f"SET status = CASE WHEN signal_type = 'schema_evolution' THEN 'RESOLVED' ELSE 'PROPOSED' END, "
            f"approver = CASE WHEN signal_type = 'schema_evolution' THEN approver ELSE NULL END "
            f"WHERE period = '{CLOSE_PERIOD}'")
        invalidate_cache()
    except Exception as e:  # noqa: BLE001 — needs MODIFY on ops.zeroops_insights
        print(f"[demo_reset] ZeroOps insights reset skipped ({e})")

    # 4. Reconcile the recon tasks + apply scenario flavor (best-effort).
    open_breaks = [{"code": b["code"], "bu": b["bu"], "amount": b["amount"]}
                   for b in scenario["breaks"]]
    # A recalled auto-approval was reversed, so the break it had cleared is open
    # again and belongs on the board next to the scenario's own.
    for ref in seeded.get("reopened") or []:
        code, _, bu = ref.partition("/")
        open_breaks.append({"code": code, "bu": bu,
                            "amount": sacrificial.get((code, bu), 0.0)})
    try:
        from . import tasks
        # Reopen every recon task first, then let the sync auto-complete the
        # cleared cells and create tasks for the newly-open ones.
        with pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE close_tasks SET status='NOT_STARTED', is_blocked=false, "
                "delay_reason=NULL, started_ts=NULL, completed_ts=NULL, updated_ts=now() "
                "WHERE period=%s AND source='recon'", (CLOSE_PERIOD,))
            conn.commit()
        tasks.resync_recon()
        with pool.connection() as conn, conn.cursor() as cur:
            for b in scenario["breaks"]:
                tid = f"TASK-{CLOSE_PERIOD}-R-{b['code']}-{b['bu']}"
                st = b.get("status", "NOT_STARTED")
                cur.execute(
                    "UPDATE close_tasks SET status=%s, is_blocked=%s, delay_reason=%s, "
                    "assignee=COALESCE(%s, assignee), "
                    "started_ts = CASE WHEN %s <> 'NOT_STARTED' THEN now() ELSE started_ts END, "
                    "updated_ts=now() WHERE task_id=%s AND period=%s AND status <> 'DONE'",
                    (st, bool(b.get("blocked", False)), b.get("reason"), b.get("owner"),
                     st, tid, CLOSE_PERIOD))
            # Clear the concentration-review tasks so the Exposure "raise
            # reviews" action demos fresh again. Can't DELETE (INSERT/UPDATE-only
            # role), so archive them out of the live period; raise-reviews
            # re-arms them on the next click.
            cur.execute(
                "UPDATE close_tasks SET period=%s, updated_ts=now() "
                "WHERE period=%s AND source='concentration'",
                (f"{CLOSE_PERIOD}-archived", CLOSE_PERIOD))
            _audit(cur, f"DEMO-RESET-{index}", "demo_reset",
                   f"Reset to scenario '{scenario['name']}' ({len(open_breaks)} open breaks, "
                   f"{seeded.get('adjustments', 0)} adjustments seeded) [{current_user()}]",
                   "system")
            conn.commit()
    except Exception as e:  # noqa: BLE001
        print(f"[demo_reset] Lakebase task update skipped ({e})")

    return {"reset": True, "scenario": scenario["name"], "index": index,
            "open_breaks": open_breaks, "seeded": seeded}
