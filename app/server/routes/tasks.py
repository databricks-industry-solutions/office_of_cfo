"""Month-end close operations workspace API.

Tasks, their activity trail, and the per-office workflow configuration are an
OLTP concern (created/assigned/transitioned interactively in the app), so they
live in Lakebase as the system of record - mirroring `posted_adjustments` in
`close.py`. Derived tasks are synced from the governed Unity Catalog serving/DQ
tables (recon breaks + data-quality results) and auto-complete when the
underlying data is fixed, fusing the governed-data story with the task story.

Everything degrades gracefully: if Lakebase is unreachable the lists return
empty and the summary returns zeros, so the rest of the app keeps rendering.
"""
import json
import math
import threading
import uuid
from datetime import date, datetime, timedelta

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from ..config import (
    CLOSE_PERIOD, OPS_FQ, SRV_FQ, current_industry, current_user, demo_close_today, demo_today,
)
from ..lakebase import pool
from ..personas import scope_business_units
from ..warehouse import cache_version, query

router = APIRouter()

SRV = SRV_FQ
OPS = OPS_FQ

# Per-industry init/seed guard: each industry has its own Lakebase instance, so
# initialization + seeding must run once PER industry (not once globally).
_initialized: set[str] = set()
_schema_locks: dict[str, threading.Lock] = {}
_schema_locks_guard = threading.Lock()


def _schema_lock_for(industry: str) -> threading.Lock:
    with _schema_locks_guard:
        return _schema_locks.setdefault(industry, threading.Lock())

# Bump when the seeded scenario (task_templates / target / statuses) changes so
# deployed environments self-migrate: the default config is refreshed and the
# seeded (template / recon / dq) tasks are dropped and re-seeded with the new
# plan. Manual tasks are always preserved.
SEED_VERSION = 3


# ---------------------------------------------------------------------------
# Default per-office configuration (modular: editable via /close-config).
# ---------------------------------------------------------------------------
DEFAULT_CONFIG: dict = {
    "workstreams": [
        "Subledger Close", "Journal Entries", "Reconciliation",
        "Intercompany", "Data Quality", "Reporting", "Review & Approval",
    ],
    "statuses": [
        {"id": "NOT_STARTED", "label": "Not started", "color": "gray", "order": 0},
        {"id": "IN_PROGRESS", "label": "In progress", "color": "blue", "order": 1},
        {"id": "IN_REVIEW", "label": "In review", "color": "amber", "order": 2},
        {"id": "DONE", "label": "Done", "color": "emerald", "order": 3},
    ],
    "reason_codes": [
        "Awaiting upstream data", "Pending approval", "System issue",
        "Dependency", "Capacity",
    ],
    "team": [
        {"name": "Sarah Chen", "role": "Controller"},
        {"name": "Marcus Lee", "role": "Senior Accountant"},
        {"name": "Priya Nair", "role": "Staff Accountant"},
        {"name": "David Okafor", "role": "Senior Accountant"},
        {"name": "Elena Rossi", "role": "Staff Accountant"},
    ],
    # due_offset_bd: business days relative to period end. An on-track ~12
    # business-day close, viewed mid-cycle: the subledger / journal-entry /
    # reconciliation work due in the first week is already DONE (on time), the
    # data-quality sign-off is in progress, and only reporting + final sign-off
    # remain ahead — so the burn-down reads as a close running slightly ahead of
    # plan rather than behind.
    "task_templates": [
        {"name": "AP subledger cutoff & close", "workstream": "Subledger Close", "owner": "Sarah Chen", "priority": "HIGH", "due_offset_bd": 1, "seed_status": "DONE"},
        {"name": "AR subledger cutoff & close", "workstream": "Subledger Close", "owner": "Marcus Lee", "priority": "HIGH", "due_offset_bd": 1, "seed_status": "DONE"},
        {"name": "Fixed assets & depreciation run", "workstream": "Journal Entries", "owner": "Priya Nair", "priority": "MEDIUM", "due_offset_bd": 2, "seed_status": "DONE"},
        {"name": "Accruals & prepaids posting", "workstream": "Journal Entries", "owner": "David Okafor", "priority": "HIGH", "due_offset_bd": 2, "seed_status": "DONE"},
        {"name": "Payroll journal entry", "workstream": "Journal Entries", "owner": "Elena Rossi", "priority": "MEDIUM", "due_offset_bd": 3, "seed_status": "DONE"},
        {"name": "Bank reconciliation", "workstream": "Reconciliation", "owner": "Sarah Chen", "priority": "HIGH", "due_offset_bd": 3, "seed_status": "DONE"},
        {"name": "Intercompany matching & elimination", "workstream": "Intercompany", "owner": "Marcus Lee", "priority": "HIGH", "due_offset_bd": 4, "seed_status": "DONE"},
        {"name": "FX revaluation", "workstream": "Journal Entries", "owner": "Priya Nair", "priority": "MEDIUM", "due_offset_bd": 4, "seed_status": "DONE"},
        {"name": "Trial balance review & flux analysis", "workstream": "Reporting", "owner": "David Okafor", "priority": "HIGH", "due_offset_bd": 5, "seed_status": "DONE"},
        {"name": "Data-quality sign-off", "workstream": "Data Quality", "owner": "Elena Rossi", "priority": "MEDIUM", "due_offset_bd": 6, "seed_status": "IN_PROGRESS"},
        {"name": "Management reporting pack", "workstream": "Reporting", "owner": "Priya Nair", "priority": "MEDIUM", "due_offset_bd": 9, "seed_status": "NOT_STARTED"},
        {"name": "Controller final review & GO/NO-GO", "workstream": "Review & Approval", "owner": "Sarah Chen", "priority": "HIGH", "due_offset_bd": 12, "seed_status": "NOT_STARTED"},
    ],
    "automations": {
        "recurring_generation": True,
        "auto_assign": True,
        "data_driven_tasks": True,
        "due_soon_reminders": True,
        "overdue_escalation": True,
    },
    "target_close_bd": 13,
}


# ---------------------------------------------------------------------------
# Date helpers (business-day math anchored to the close period end).
# ---------------------------------------------------------------------------
def _period_end() -> date:
    y, m = (int(x) for x in CLOSE_PERIOD.split("-"))
    return (date(y, 12, 31) if m == 12 else date(y, m + 1, 1) - timedelta(days=1))


def _add_business_days(start: date, n: int) -> date:
    step = 1 if n >= 0 else -1
    remaining = abs(n)
    d = start
    while remaining > 0:
        d += timedelta(days=step)
        if d.weekday() < 5:
            remaining -= 1
    return d


def _due_from_offset(offset_bd: int) -> date:
    return _add_business_days(_period_end(), offset_bd)


def _bdays_between(a: date, b: date) -> int:
    """Business days strictly after `a`, up to and including `b`."""
    if b <= a:
        return 0
    n = 0
    d = a
    while d < b:
        d += timedelta(days=1)
        if d.weekday() < 5:
            n += 1
    return n


def _target_close_date() -> date:
    return _due_from_offset(int(_config().get("target_close_bd", 4)))


def _period_cutoff() -> date:
    """T — the close cutoff: the last BUSINESS day of the period. `_period_end()`
    is the last calendar day, so step back over a weekend if it lands on one."""
    d = _period_end()
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


def _t_offset(d: date, cutoff: date) -> int:
    """Business days of `d` relative to the cutoff T: 0 at T, +n after (weekends
    skipped), -n before. So the first business day after month-end is T+1."""
    if d == cutoff:
        return 0
    if d > cutoff:
        return _bdays_between(cutoff, d)
    return -_bdays_between(d, cutoff)


# ---------------------------------------------------------------------------
# Schema + config + activity helpers.
# ---------------------------------------------------------------------------
def _ensure_schema() -> None:
    ind = current_industry()
    if ind in _initialized:
        return
    with _schema_lock_for(ind):
        if ind in _initialized:
            return
        _initialize_schema(ind)


def _initialize_schema(ind: str) -> None:
    with pool.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "CREATE TABLE IF NOT EXISTS close_config ("
                " config_id text PRIMARY KEY,"
                " data jsonb NOT NULL,"
                " updated_ts timestamptz NOT NULL DEFAULT now())")
            cur.execute(
                "CREATE TABLE IF NOT EXISTS close_tasks ("
                " task_id text PRIMARY KEY,"
                " period text NOT NULL,"
                " task_name text NOT NULL,"
                " description text DEFAULT '',"
                " workstream text,"
                " business_unit_id text,"
                " assignee text,"
                " priority text NOT NULL DEFAULT 'MEDIUM',"
                " due_date date,"
                " status text NOT NULL DEFAULT 'NOT_STARTED',"
                " is_blocked boolean NOT NULL DEFAULT false,"
                " delay_reason text,"
                " source text NOT NULL DEFAULT 'template',"
                " linked_ref text,"
                " depends_on text,"
                " created_by text,"
                " created_ts timestamptz NOT NULL DEFAULT now(),"
                " started_ts timestamptz,"
                " updated_ts timestamptz NOT NULL DEFAULT now(),"
                " completed_ts timestamptz)")
            cur.execute(
                "CREATE TABLE IF NOT EXISTS close_task_activity ("
                " activity_id text PRIMARY KEY,"
                " task_id text NOT NULL,"
                " period text NOT NULL,"
                " ts timestamptz NOT NULL DEFAULT now(),"
                " actor text,"
                " action text NOT NULL,"
                " detail text DEFAULT '')")
            cur.execute("SELECT 1 FROM close_config WHERE config_id = 'default'")
            has_default = cur.fetchone() is not None
            cur.execute("SELECT data FROM close_config WHERE config_id = 'seed_meta'")
            meta_row = cur.fetchone()
            stored_version = (meta_row[0] or {}).get("version") if meta_row else None

            migrating = stored_version != SEED_VERSION
            if not has_default:
                cur.execute(
                    "INSERT INTO close_config (config_id, data) VALUES ('default', %s)",
                    (json.dumps(DEFAULT_CONFIG),))
            elif migrating:
                # Scenario changed: refresh the default plan. The seeded template
                # tasks are reconciled to the new schedule below (via UPSERT, no
                # DELETE — the app's DB role only has SELECT/INSERT/UPDATE), and
                # the open data-driven tasks are re-dated to the new offsets.
                cur.execute(
                    "UPDATE close_config SET data = %s, updated_ts = now() WHERE config_id = 'default'",
                    (json.dumps(DEFAULT_CONFIG),))
                cur.execute(
                    "UPDATE close_tasks SET due_date = %s, updated_ts = now() "
                    "WHERE period = %s AND source = 'recon' AND status <> 'DONE'",
                    (_due_from_offset(6), CLOSE_PERIOD))
                cur.execute(
                    "UPDATE close_tasks SET due_date = %s, updated_ts = now() "
                    "WHERE period = %s AND source = 'dq' AND status <> 'DONE'",
                    (_due_from_offset(5), CLOSE_PERIOD))

            if migrating:
                cur.execute(
                    "INSERT INTO close_config (config_id, data) VALUES ('seed_meta', %s) "
                    "ON CONFLICT (config_id) DO UPDATE SET data = EXCLUDED.data, updated_ts = now()",
                    (json.dumps({"version": SEED_VERSION}),))
        conn.commit()
    _config_cache.pop(ind, None)  # bust cache so the refreshed config is picked up
    # On a scenario migration, reconcile existing seeded template tasks to the
    # new plan; otherwise just insert any missing ones (preserving live edits).
    _seed_from_config(reconcile=migrating)
    _initialized.add(ind)


_config_cache: dict[str, dict] = {}


def _config() -> dict:
    ind = current_industry()
    cached = _config_cache.get(ind)
    if cached is not None:
        return cached
    try:
        with pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT data FROM close_config WHERE config_id = 'default'")
            row = cur.fetchone()
            _config_cache[ind] = row[0] if row and row[0] else DEFAULT_CONFIG
    except Exception:  # noqa: BLE001
        _config_cache[ind] = DEFAULT_CONFIG
    return _config_cache[ind]


def _save_config(data: dict) -> None:
    with pool.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO close_config (config_id, data, updated_ts) "
                "VALUES ('default', %s, now()) "
                "ON CONFLICT (config_id) DO UPDATE SET data = EXCLUDED.data, updated_ts = now()",
                (json.dumps(data),))
        conn.commit()
    _config_cache[current_industry()] = data


def _log(cur, task_id: str, action: str, detail: str, actor: str | None = None) -> None:
    cur.execute(
        "INSERT INTO close_task_activity (activity_id, task_id, period, actor, action, detail) "
        "VALUES (%s,%s,%s,%s,%s,%s)",
        (uuid.uuid4().hex[:12], task_id, CLOSE_PERIOD, actor or current_user(), action, detail))


def _seed_from_config(reconcile: bool = False) -> None:
    """Seed the template close tasks from config.

    Default (`reconcile=False`): insert only the tasks that don't exist yet, so
    live status/assignee edits are preserved across restarts.
    `reconcile=True` (used on a scenario migration): UPSERT every template task
    so existing rows are re-aligned to the new plan (due date, status, spread
    timestamps). No DELETE is used — the deployed DB role is INSERT/UPDATE only.
    """
    cfg = _config()
    user = current_user()
    conflict = (
        "ON CONFLICT (task_id) DO UPDATE SET "
        "task_name = EXCLUDED.task_name, workstream = EXCLUDED.workstream, "
        "assignee = EXCLUDED.assignee, priority = EXCLUDED.priority, "
        "due_date = EXCLUDED.due_date, status = EXCLUDED.status, "
        "is_blocked = EXCLUDED.is_blocked, delay_reason = EXCLUDED.delay_reason, "
        "started_ts = EXCLUDED.started_ts, completed_ts = EXCLUDED.completed_ts, updated_ts = now()"
        if reconcile else "ON CONFLICT (task_id) DO NOTHING"
    )
    with pool.connection() as conn:
        with conn.cursor() as cur:
            for i, t in enumerate(cfg.get("task_templates", []), start=1):
                task_id = f"TASK-{CLOSE_PERIOD}-T{i:02d}"
                status = t.get("seed_status", "NOT_STARTED")
                due = _due_from_offset(int(t.get("due_offset_bd", 0)))
                # Spread lifecycle timestamps across the close calendar so the
                # burn-down has a realistic slope: work starts a business day
                # before its due date and DONE tasks finish on (or by) it, never
                # in the future relative to now.
                now = datetime.utcnow()
                start_dt = datetime.combine(_add_business_days(due, -1), datetime.min.time()).replace(hour=9)
                done_dt = min(datetime.combine(due, datetime.min.time()).replace(hour=15), now)
                completed = done_dt if status == "DONE" else None
                started = None if status == "NOT_STARTED" else min(start_dt, now)
                cur.execute(
                    "INSERT INTO close_tasks "
                    "(task_id, period, task_name, workstream, assignee, priority, due_date, "
                    " status, is_blocked, delay_reason, source, created_by, started_ts, completed_ts) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'template',%s,%s,%s) " + conflict,
                    (task_id, CLOSE_PERIOD, t["name"], t.get("workstream"), t.get("owner"),
                     t.get("priority", "MEDIUM"), due, status, bool(t.get("blocked", False)),
                     t.get("reason"), user, started, completed))
                if cur.rowcount and not reconcile:
                    _log(cur, task_id, "created", f"Seeded from template ({t.get('workstream')})", actor="system")
        conn.commit()


# ---------------------------------------------------------------------------
# Derived tasks: born from governed recon breaks + DQ results.
# ---------------------------------------------------------------------------
# The governed source tables (recon breaks + DQ results) only change when the
# app writes back to the lake, which bumps the warehouse cache version. So we
# only re-run the (warehouse + Lakebase) sync when that version advances past
# the last successful sync. A lock dedupes the concurrent requests a single
# page load fires (burndown + tasks + summary), collapsing them to one sync.
_sync_lock = threading.Lock()
# Per-industry derived-task watermark (each industry syncs into its own Lakebase).
_last_synced_version: dict[str, int] = {}


def _sync_derived() -> None:
    ind = current_industry()
    if cache_version() == _last_synced_version.get(ind, -1):
        return  # governed data unchanged since last sync — nothing to do
    with _sync_lock:
        version = cache_version()
        if version == _last_synced_version.get(ind, -1):
            return  # another request just synced while we waited on the lock
        _sync_derived_locked(version)


def _sync_derived_locked(version: int) -> None:
    try:
        breaks = query(
            f"SELECT control_account_code, account_name, business_unit_id, business_unit_name, "
            f"abs_variance, is_break FROM {SRV}.recon_breaks_live")
        dq = query(
            f"SELECT check_id, dimension, status FROM {OPS}.dq_results "
            f"WHERE status IN ('FAIL','WARN')")
    except Exception:  # noqa: BLE001
        return  # warehouse not reachable; keep existing tasks as-is (retry next call)

    # Keep data-driven breaks due in the near future (not stale/overdue) so the
    # in-flight close scenario stays realistic.
    due_recon = _due_from_offset(6)
    due_dq = _due_from_offset(5)
    with pool.connection() as conn:
        with conn.cursor() as cur:
            for b in breaks:
                code = b.get("control_account_code")
                bu = b.get("business_unit_id")
                linked = f"{code}/{bu}"
                task_id = f"TASK-{CLOSE_PERIOD}-R-{code}-{bu}"
                is_break = str(b.get("is_break")).lower() == "true"
                if is_break:
                    name = f"Resolve {b.get('account_name')} variance — {b.get('business_unit_name')}"
                    cur.execute(
                        "INSERT INTO close_tasks "
                        "(task_id, period, task_name, workstream, business_unit_id, priority, "
                        " due_date, status, source, linked_ref, created_by) "
                        "VALUES (%s,%s,%s,'Reconciliation',%s,'HIGH',%s,'NOT_STARTED','recon',%s,'system') "
                        "ON CONFLICT (task_id) DO NOTHING",
                        (task_id, CLOSE_PERIOD, name, bu, due_recon, linked))
                    if cur.rowcount:
                        _log(cur, task_id, "created", f"Auto-created from variance {linked}", actor="system")
                else:
                    # Break cleared (e.g. an adjustment was posted) -> auto-complete.
                    cur.execute(
                        "UPDATE close_tasks SET status='DONE', is_blocked=false, "
                        "completed_ts=now(), updated_ts=now() "
                        "WHERE task_id=%s AND status <> 'DONE'", (task_id,))
                    if cur.rowcount:
                        _log(cur, task_id, "auto_completed",
                             f"Break {linked} cleared in the governed data", actor="system")
            for d in dq:
                check_id = d.get("check_id")
                task_id = f"TASK-{CLOSE_PERIOD}-Q-{check_id}"
                sev = "HIGH" if d.get("status") == "FAIL" else "MEDIUM"
                name = f"Clear {str(d.get('dimension')).replace('_', ' ')} data-quality {d.get('status')}"
                cur.execute(
                    "INSERT INTO close_tasks "
                    "(task_id, period, task_name, workstream, priority, due_date, status, "
                    " source, linked_ref, created_by) "
                    "VALUES (%s,%s,%s,'Data Quality',%s,%s,'NOT_STARTED','dq',%s,'system') "
                    "ON CONFLICT (task_id) DO NOTHING",
                    (task_id, CLOSE_PERIOD, name, sev, due_dq, check_id))
                if cur.rowcount:
                    _log(cur, task_id, "created", f"Auto-created from DQ result {check_id}", actor="system")
        conn.commit()
    # Only advance the watermark after a fully successful sync, so a mid-way
    # failure (or unreachable warehouse) is retried on the next request.
    _last_synced_version[current_industry()] = version


def resync_recon() -> None:
    """Force the derived recon/DQ task sync now.

    Used by the demo reset (`close.py`) after it changes the governed breaks:
    materializes NOT_STARTED tasks for the newly-open breaks and auto-completes
    the cells whose break was cleared. Safe to call directly — `_sync_derived`
    re-runs because the reset bumped the warehouse cache version.
    """
    _ensure_schema()
    _sync_derived()


# ---------------------------------------------------------------------------
# Read shaping.
# ---------------------------------------------------------------------------
def _rows(cur) -> list[dict]:
    cols = [c[0] for c in cur.description]
    out = []
    for r in cur.fetchall():
        d = dict(zip(cols, r))
        for k, v in list(d.items()):
            if isinstance(v, (date, datetime)):
                d[k] = v.isoformat()
        out.append(d)
    return out


def _list_tasks(scope_bus: list[str] | None = None) -> list[dict]:
    with pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT task_id, period, task_name, description, workstream, business_unit_id, "
            "assignee, priority, due_date, status, is_blocked, delay_reason, source, "
            "linked_ref, depends_on, created_by, created_ts, started_ts, updated_ts, completed_ts "
            "FROM close_tasks WHERE period = %s ORDER BY due_date NULLS LAST, task_id",
            (CLOSE_PERIOD,))
        rows = _rows(cur)
    if scope_bus is not None:
        allowed = set(scope_bus)
        # keep tasks in scope plus shared (no BU) tasks the whole team owns
        rows = [t for t in rows if not t.get("business_unit_id") or t["business_unit_id"] in allowed]
    return rows


# ---------------------------------------------------------------------------
# Request models.
# ---------------------------------------------------------------------------
class TaskIn(BaseModel):
    task_name: str
    workstream: str | None = None
    assignee: str | None = None
    priority: str = "MEDIUM"
    due_date: str | None = None
    description: str = ""
    business_unit_id: str | None = None


class AssignIn(BaseModel):
    assignee: str


class StatusIn(BaseModel):
    status: str
    is_blocked: bool | None = None
    delay_reason: str | None = None


class CommentIn(BaseModel):
    text: str


class ConfigIn(BaseModel):
    data: dict


# ---------------------------------------------------------------------------
# Endpoints.
# ---------------------------------------------------------------------------
@router.get("/close-tasks")
def list_tasks(scope_type: str = Query("consolidated"), scope_id: str = Query("ALL")):
    try:
        _ensure_schema()
        _sync_derived()
        return _list_tasks(scope_business_units(scope_type, scope_id))
    except Exception:  # noqa: BLE001
        return []


@router.get("/close-tasks/summary")
def task_summary(scope_type: str = Query("consolidated"), scope_id: str = Query("ALL")):
    try:
        _ensure_schema()
        _sync_derived()
        tasks = _list_tasks(scope_business_units(scope_type, scope_id))
    except Exception:  # noqa: BLE001
        tasks = []

    today = demo_today()
    statuses = ["NOT_STARTED", "IN_PROGRESS", "IN_REVIEW", "DONE"]
    buckets = {s: 0 for s in statuses}
    overdue = blocked = awaiting = auto_completed = 0
    by_assignee: dict[str, dict] = {}
    by_workstream: dict[str, dict] = {}

    for t in tasks:
        st = t.get("status", "NOT_STARTED")
        buckets[st] = buckets.get(st, 0) + 1
        is_done = st == "DONE"
        is_overdue = (not is_done and t.get("due_date") and
                      date.fromisoformat(t["due_date"][:10]) < today)
        if is_overdue:
            overdue += 1
        if t.get("is_blocked"):
            blocked += 1
        if st == "IN_REVIEW":
            awaiting += 1
        if t.get("source") == "recon" and is_done:
            auto_completed += 1

        owner = t.get("assignee") or "Unassigned"
        a = by_assignee.setdefault(owner, {"assignee": owner, "open": 0, "overdue": 0, "completed": 0})
        a["completed" if is_done else "open"] += 1
        if is_overdue:
            a["overdue"] += 1

        ws = t.get("workstream") or "Other"
        w = by_workstream.setdefault(ws, {"workstream": ws, "total": 0, "done": 0})
        w["total"] += 1
        if is_done:
            w["done"] += 1

    total = len(tasks)
    done = buckets.get("DONE", 0)
    target = _target_close_date()
    return {
        "period": CLOSE_PERIOD,
        "total": total,
        "buckets": buckets,
        "overdue": overdue,
        "blocked": blocked,
        "awaiting_approval": awaiting,
        "auto_completed": auto_completed,
        "pct_complete": round(100 * done / total) if total else 0,
        "today": today.isoformat(),
        "target_close_date": target.isoformat(),
        "days_to_close": (target - today).days,
        "by_assignee": sorted(by_assignee.values(), key=lambda x: (-x["overdue"], -x["open"])),
        "by_workstream": sorted(by_workstream.values(), key=lambda x: x["workstream"]),
    }


def _as_date(value) -> date | None:
    """Coerce an ISO timestamp/date string (or date) to a plain date."""
    if not value:
        return None
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def _compute_burndown(tasks: list[dict]) -> dict:
    """Daily close burn-down: tasks remaining (actuals) vs the planned path
    (the even burn to the target close), plus a velocity-based projection to a
    finish date.

    Everything is derived from real task data: `completed_ts` drives the actual
    line, the target close date sets the planned pace, and completion velocity
    so far drives the dashed forecast tail. No values are synthesized.

    The chart uses ``demo_close_today()`` because its seeded task statuses
    represent that close-cycle stage. Other close pages continue to use the
    browser-mapped ``demo_today()``.
    """
    today = demo_close_today()
    target = _target_close_date()
    cutoff = _period_cutoff()
    total = len(tasks)

    empty = {
        "points": [], "total": 0, "completed": 0, "remaining": 0, "pct_complete": 0,
        "start_date": today.isoformat(), "today": today.isoformat(),
        "target_close_date": target.isoformat(), "projected_finish_date": None,
        "days_delta": None, "on_track": True,
        "cutoff_date": cutoff.isoformat(), "today_t": _t_offset(today, cutoff),
        "target_t": _t_offset(target, cutoff), "projected_t": None,
    }
    if total == 0:
        return empty

    # One definition of "burned down": a DONE task. Derived recon/DQ rows are
    # auto-completed with a wall-clock stamp that can fall outside the frozen
    # demo cycle, so attribute those to the day they were due — otherwise the
    # actual line would never reach `remaining` and the projection would start
    # detached from it.
    dues = [_as_date(t.get("due_date")) or target for t in tasks]
    completions: list[date] = []
    for t, due in zip(tasks, dues):
        if t.get("status") != "DONE":
            continue
        done_on = _as_date(t.get("completed_ts"))
        if done_on is None or done_on > today:
            done_on = min(due, today)
        completions.append(done_on)
    completions.sort()

    completed_total = len(completions)
    remaining = total - completed_total

    # Timeline start: the earliest thing that anchors the cycle.
    start = min([*dues, *(completions or [today]), target, today])

    # Velocity from real completions so far, measured per BUSINESS day (close
    # work happens on weekdays) and projected forward over business days too —
    # weekends neither earn nor consume progress.
    elapsed_bd = max(_bdays_between(start, today), 1)
    done_by_today = sum(1 for d in completions if d <= today)
    velocity = done_by_today / elapsed_bd  # tasks completed per business day

    if remaining <= 0:
        projected_finish = max(completions) if completions else today
    elif velocity > 0:
        projected_finish = _add_business_days(today, math.ceil(remaining / velocity))
    else:
        projected_finish = None  # nothing completed yet -> can't project a finish

    # Visible window: include today / projected only while they stay near the
    # target. Caps the x-axis if DEMO_AS_OF (or a bad pin) drifts far past close.
    pad_end = _add_business_days(target, 5)
    end_candidates = [target]
    if today <= pad_end:
        end_candidates.append(today)
    if projected_finish is not None and projected_finish <= pad_end:
        end_candidates.append(projected_finish)
    end = max(end_candidates)

    proj_span = ((projected_finish - today).days if projected_finish else 0)

    # The plan is the pace the close is committed to: burn all `total` tasks down
    # to zero by the target close day, spread evenly over the BUSINESS days of the
    # cycle (weekends stay flat — no close work lands there). Task due dates make
    # a lumpy step curve that plateaus and then cliffs, which doesn't read as a
    # plan, so the commitment is drawn as this even burn instead.
    plan_span_bd = _bdays_between(start, target)

    points: list[dict] = []
    d = start
    while d <= end:
        if d >= target:
            planned = 0.0
        elif plan_span_bd <= 0:
            planned = float(total)
        else:
            planned = round(total * (1 - _bdays_between(start, d) / plan_span_bd), 2)
        actual = (total - sum(1 for c in completions if c <= d)) if d <= today else None

        projected = None
        if d == today:
            projected = remaining
        elif d > today:
            if remaining <= 0:
                projected = 0
            elif projected_finish is None:
                projected = remaining  # stalled: flat forecast
            elif d >= projected_finish:
                projected = 0
            else:
                frac = (d - today).days / proj_span if proj_span else 1
                projected = round(remaining * (1 - frac), 2)

        points.append({
            "date": d.isoformat(),
            "t": _t_offset(d, cutoff),
            "planned": planned,
            "actual": actual,
            "projected": projected,
        })
        d += timedelta(days=1)

    days_delta = (projected_finish - target).days if projected_finish else None
    on_track = projected_finish is not None and projected_finish <= target

    return {
        "points": points,
        "total": total,
        "completed": completed_total,
        "remaining": remaining,
        "pct_complete": round(100 * completed_total / total),
        "start_date": start.isoformat(),
        "today": today.isoformat(),
        "target_close_date": target.isoformat(),
        "projected_finish_date": projected_finish.isoformat() if projected_finish else None,
        "days_delta": days_delta,
        "on_track": on_track,
        "cutoff_date": cutoff.isoformat(),
        "today_t": _t_offset(today, cutoff),
        "target_t": _t_offset(target, cutoff),
        "projected_t": _t_offset(projected_finish, cutoff) if projected_finish else None,
    }


@router.get("/close-tasks/burndown")
def task_burndown(scope_type: str = Query("consolidated"), scope_id: str = Query("ALL")):
    try:
        _ensure_schema()
        _sync_derived()
        tasks = _list_tasks(scope_business_units(scope_type, scope_id))
    except Exception:  # noqa: BLE001
        tasks = []
    return _compute_burndown(tasks)


@router.get("/close-tasks/team")
def team():
    try:
        _ensure_schema()
    except Exception:  # noqa: BLE001
        pass
    return _config().get("team", [])


@router.get("/close-config")
def get_config():
    try:
        _ensure_schema()
    except Exception:  # noqa: BLE001
        pass
    return _config()


@router.put("/close-config")
def put_config(body: ConfigIn):
    _ensure_schema()
    _save_config(body.data)
    return {"status": "saved"}


@router.post("/close-tasks")
def create_task(t: TaskIn):
    _ensure_schema()
    task_id = f"TASK-{CLOSE_PERIOD}-U{uuid.uuid4().hex[:6]}"
    due = date.fromisoformat(t.due_date) if t.due_date else _due_from_offset(1)
    with pool.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO close_tasks "
                "(task_id, period, task_name, description, workstream, business_unit_id, "
                " assignee, priority, due_date, status, source, created_by) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,'NOT_STARTED','manual',%s)",
                (task_id, CLOSE_PERIOD, t.task_name, t.description, t.workstream,
                 t.business_unit_id, t.assignee, t.priority, due, current_user()))
            _log(cur, task_id, "created", "Created manually")
        conn.commit()
    return {"task_id": task_id, "status": "created"}


def _require_task(cur, task_id: str) -> None:
    cur.execute("SELECT 1 FROM close_tasks WHERE task_id = %s AND period = %s",
                (task_id, CLOSE_PERIOD))
    if cur.fetchone() is None:
        raise HTTPException(404, "Task not found")


@router.post("/close-tasks/{task_id}/assign")
def assign_task(task_id: str, body: AssignIn):
    _ensure_schema()
    with pool.connection() as conn:
        with conn.cursor() as cur:
            _require_task(cur, task_id)
            cur.execute(
                "UPDATE close_tasks SET assignee=%s, updated_ts=now() WHERE task_id=%s",
                (body.assignee, task_id))
            _log(cur, task_id, "assigned", f"Assigned to {body.assignee}")
        conn.commit()
    return {"task_id": task_id, "assignee": body.assignee}


@router.post("/close-tasks/{task_id}/status")
def set_status(task_id: str, body: StatusIn):
    _ensure_schema()
    valid = {s["id"] for s in _config().get("statuses", [])} or {
        "NOT_STARTED", "IN_PROGRESS", "IN_REVIEW", "DONE"}
    if body.status not in valid:
        raise HTTPException(400, "Unknown status")
    with pool.connection() as conn:
        with conn.cursor() as cur:
            _require_task(cur, task_id)
            is_done = body.status == "DONE"
            cur.execute(
                "UPDATE close_tasks SET status=%s, "
                "is_blocked = COALESCE(%s, is_blocked), "
                "delay_reason = %s, "
                "started_ts = COALESCE(started_ts, CASE WHEN %s <> 'NOT_STARTED' THEN now() END), "
                "completed_ts = CASE WHEN %s THEN now() ELSE NULL END, "
                "updated_ts = now() WHERE task_id=%s",
                (body.status, body.is_blocked, body.delay_reason, body.status, is_done, task_id))
            detail = f"Status → {body.status}"
            if body.is_blocked:
                detail += f" (blocked: {body.delay_reason or 'no reason'})"
            _log(cur, task_id, "status", detail)
        conn.commit()
    return {"task_id": task_id, "status": body.status}


@router.post("/close-tasks/{task_id}/comment")
def add_comment(task_id: str, body: CommentIn):
    _ensure_schema()
    if not body.text.strip():
        raise HTTPException(400, "Empty comment")
    with pool.connection() as conn:
        with conn.cursor() as cur:
            _require_task(cur, task_id)
            _log(cur, task_id, "comment", body.text.strip())
        conn.commit()
    return {"task_id": task_id, "status": "ok"}


@router.get("/close-tasks/{task_id}/activity")
def task_activity(task_id: str):
    try:
        _ensure_schema()
        with pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT activity_id, task_id, ts, actor, action, detail "
                "FROM close_task_activity WHERE task_id = %s ORDER BY ts DESC",
                (task_id,))
            return _rows(cur)
    except Exception:  # noqa: BLE001
        return []


@router.get("/close-activity")
def recent_activity():
    """Recent activity across all tasks this period (for Audit Log + dashboard)."""
    try:
        _ensure_schema()
        with pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT a.activity_id, a.task_id, a.ts, a.actor, a.action, a.detail, t.task_name "
                "FROM close_task_activity a LEFT JOIN close_tasks t ON a.task_id = t.task_id "
                "WHERE a.period = %s ORDER BY a.ts DESC LIMIT 100",
                (CLOSE_PERIOD,))
            return _rows(cur)
    except Exception:  # noqa: BLE001
        return []
