"""FP&A Scenario Planning API (L1).

Deterministic scenario projection over the current close's baseline, plus the
scenario library (Lakebase, per-industry). Split of concerns:

* the pure engine (`scenario_engine.project`) does the math;
* the baseline provider (`scenario_baseline.get_baseline`) does the one warehouse read;
* this module wires them to HTTP and persists scenario *definitions* in Lakebase.

`/project` is stateless (live slider preview). Scenarios persist as drafts, freeze
on commit (the exact projected `StatementSet` is stored, so a committed scenario never
changes even if the engine later does), and are edited-by-clone thereafter. Everything
degrades gracefully: if Lakebase is unreachable the library endpoints return empty /
503 and the stateless `/project` still works.
"""
import json
import logging
import math
import uuid

from fastapi import APIRouter, Body, HTTPException, Query
from pydantic import BaseModel

from ..config import CLOSE_PERIOD, current_industry, current_user, resolve_period
from ..scenario_baseline import get_baseline, seed_period
from ..scenario_engine import StatementSet, driver_catalog, project
from ..scenario_uniqueness import assumption_signature, decorate_compare_eligibility, duplicate_match

router = APIRouter()
log = logging.getLogger(__name__)

# Stamped onto a frozen scenario for provenance (not used to recompute — a committed
# scenario renders its stored snapshot verbatim). Bump when engine semantics change.
ENGINE_VERSION = "engine-l1.0"

_CATALOG_BY_ID = {d["id"]: d for d in driver_catalog()}

# Per-industry init guard: each industry has its own Lakebase instance.
_initialized: set[str] = set()


def _pool():
    """The Lakebase pool, imported lazily so the compute endpoints (/drivers,
    /project, /bridge) import and run without psycopg installed."""
    from ..lakebase import pool
    return pool


# --------------------------------------------------------------------------- #
# Assumptions <-> self-describing form
# --------------------------------------------------------------------------- #
def _describe(assumptions: dict | None) -> dict:
    """Expand `{driver_id: value}` (or already-described) into the self-describing
    stored form `{driver_id: {value, unit, mode}}`, using the catalog. Unknown
    drivers are dropped so the persisted record stays interpretable."""
    out: dict = {}
    for did, raw in (assumptions or {}).items():
        meta = _CATALOG_BY_ID.get(did)
        if not meta:
            continue
        val = raw.get("value") if isinstance(raw, dict) else raw
        if val is None or val == "":
            continue
        try:
            val = float(val)
        except (TypeError, ValueError):
            continue
        out[did] = {"value": val, "unit": meta["unit"], "mode": meta["mode"]}
    return out


def _ss(s: StatementSet) -> dict:
    return {"periods": s.periods, "hinge_index": s.hinge_index, "lines": s.lines, "kpis": s.kpis}


# --------------------------------------------------------------------------- #
# Lakebase store
# --------------------------------------------------------------------------- #
def _seed_rows() -> list[tuple]:
    """Period-scoped seed IDs so each close period gets its own Base/Downside/Upside.
    ON CONFLICT DO NOTHING stays idempotent within a period; rolling CLOSE_PERIOD
    to the next month automatically seeds a fresh trio on first request."""
    p = CLOSE_PERIOD
    # Each tuple: (scenario_id, name, status, is_baseline, assumptions)
    return [
        (f"seed-base-{p}",     "Base",     "baseline", True,  {}),
        (f"seed-downside-{p}", "Worst case", "draft",    False,
         {"revenue_growth": -8, "gross_margin": -150, "opex_growth": 3, "dso": 6, "dpo": 4, "dio": 5}),
        (f"seed-upside-{p}",   "Best case",  "draft",    False,
         {"revenue_growth": 6, "gross_margin": 80, "opex_growth": 1, "dso": -3, "dpo": 2, "dio": -4}),
    ]


def _ensure_schema() -> None:
    ind = current_industry()
    if ind in _initialized:
        return
    with _pool().connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "CREATE TABLE IF NOT EXISTS scenario_plans ("
                " scenario_id text PRIMARY KEY,"
                " name text NOT NULL,"
                " status text NOT NULL DEFAULT 'draft',"
                " is_baseline boolean NOT NULL DEFAULT false,"
                " is_official boolean NOT NULL DEFAULT false,"
                " scope_type text NOT NULL DEFAULT 'consolidated',"
                " scope_id text NOT NULL DEFAULT 'ALL',"
                " as_of_period text NOT NULL,"
                " horizon_end text,"
                " assumptions jsonb NOT NULL DEFAULT '{}',"
                " frozen_result jsonb,"
                " engine_version text,"
                " parent_scenario_id text,"
                " created_by text,"
                " created_ts timestamptz NOT NULL DEFAULT now(),"
                " updated_ts timestamptz NOT NULL DEFAULT now())")
            # Migrate existing tables that pre-date this column. Best-effort: Postgres
            # checks ownership *before* IF NOT EXISTS, so an app SP that doesn't own the
            # table (any deploy where a different principal created it) can't ALTER — but
            # the column already exists there, so skip via a savepoint rather than aborting
            # the whole transaction (and failing create/commit/save downstream).
            try:
                with conn.transaction():
                    cur.execute(
                        "ALTER TABLE scenario_plans "
                        "ADD COLUMN IF NOT EXISTS is_official boolean NOT NULL DEFAULT false")
            except Exception:  # noqa: BLE001 — non-fatal: caller may not own the table
                pass
            # Seed Base / Upside / Downside drafts for the current close, idempotently
            # (stable ids; ON CONFLICT DO NOTHING never resurrects an archived seed).
            for sid, name, status, is_base, bare in _seed_rows():
                cur.execute(
                    "INSERT INTO scenario_plans "
                    " (scenario_id, name, status, is_baseline, as_of_period, assumptions, created_by) "
                    "VALUES (%s, %s, %s, %s, %s, %s, 'system') "
                    "ON CONFLICT (scenario_id) DO NOTHING",
                    (sid, name, status, is_base, CLOSE_PERIOD, json.dumps(_describe(bare))))
        conn.commit()
    # GRANT TO PUBLIC so any authenticated Lakebase user (e.g. a dev's personal
    # account running locally) can read/write — same pattern as tasks.py.
    with _pool().connection() as gc:
        with gc.cursor() as cur:
            try:
                cur.execute("GRANT SELECT, INSERT, UPDATE ON scenario_plans TO PUBLIC")
                cur.execute(
                    "ALTER DEFAULT PRIVILEGES IN SCHEMA public "
                    "GRANT SELECT, INSERT, UPDATE ON TABLES TO PUBLIC")
                gc.commit()
            except Exception:  # noqa: BLE001 — non-fatal: caller may not own the table
                gc.rollback()
    _initialized.add(ind)


_PLAN_COLS = ("scenario_id", "name", "status", "is_baseline", "is_official", "scope_type", "scope_id",
              "as_of_period", "horizon_end", "assumptions", "frozen_result",
              "engine_version", "parent_scenario_id", "created_by")


def _plan_row(row: dict) -> dict:
    """Normalise a scenario_plans row (jsonb columns already decode to dict)."""
    return {
        "scenario_id": row["scenario_id"], "name": row["name"], "status": row["status"],
        "is_baseline": bool(row["is_baseline"]), "is_official": bool(row.get("is_official", False)),
        "scope_type": row["scope_type"],
        "scope_id": row["scope_id"], "as_of_period": row["as_of_period"],
        "horizon_end": row.get("horizon_end"), "assumptions": row.get("assumptions") or {},
        "frozen_result": row.get("frozen_result"), "engine_version": row.get("engine_version"),
        "parent_scenario_id": row.get("parent_scenario_id"), "created_by": row.get("created_by"),
    }


def _fetch_plan(scenario_id: str) -> dict | None:
    with _pool().connection() as conn, conn.cursor(row_factory=_dict_rows()) as cur:
        cur.execute(f"SELECT {', '.join(_PLAN_COLS)} FROM scenario_plans WHERE scenario_id = %s",
                    (scenario_id,))
        row = cur.fetchone()
    return _plan_row(row) if row else None


def _dict_rows():
    """psycopg3 dict row factory (imported lazily so tests can run without psycopg)."""
    from psycopg.rows import dict_row
    return dict_row


def _normalize_for_store(assumptions: dict | None) -> dict:
    described = _describe(assumptions)
    for driver_id, entry in described.items():
        value = entry.get("value")
        if not math.isfinite(float(value)):
            raise HTTPException(
                status_code=422,
                detail=f"non-finite value for driver '{driver_id}' is not allowed",
            )
    return described


def _scope_lock_token(as_of_period: str, scope_type: str, scope_id: str) -> str:
    return f"{current_industry()}|{as_of_period}|{scope_type}|{scope_id}"


def _lock_scope(cur, as_of_period: str, scope_type: str, scope_id: str) -> None:
    cur.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
        (_scope_lock_token(as_of_period, scope_type, scope_id),),
    )


def _fetch_plan_locked(cur, scenario_id: str) -> dict | None:
    cur.execute(
        f"SELECT {', '.join(_PLAN_COLS)} FROM scenario_plans WHERE scenario_id = %s FOR UPDATE",
        (scenario_id,),
    )
    row = cur.fetchone()
    return _plan_row(row) if row else None


def _scope_candidates(cur, as_of_period: str, scope_type: str, scope_id: str) -> list[dict]:
    cur.execute(
        "SELECT scenario_id, name, status, as_of_period, scope_type, scope_id, assumptions "
        "FROM scenario_plans "
        "WHERE status <> 'archived' AND as_of_period = %s AND scope_type = %s AND scope_id = %s",
        (as_of_period, scope_type, scope_id),
    )
    return cur.fetchall()


def _assert_unique_plan(plan: dict, normalized_assumptions: dict) -> None:
    signature = assumption_signature(normalized_assumptions)
    if not signature:
        raise HTTPException(
            status_code=409,
            detail="This scenario matches Baseline. Change at least one driver.",
        )
    hit = duplicate_match(plan["scenario_id"], signature, plan["_candidates"])
    if hit:
        raise HTTPException(
            status_code=409,
            detail=f'This scenario matches "{hit.get("name")}". Change at least one driver.',
        )


# --------------------------------------------------------------------------- #
# Driver catalog + stateless projection
# --------------------------------------------------------------------------- #
@router.get("/scenario/drivers")
def scenario_drivers():
    """The driver catalog — the `assumptions` contract the page renders."""
    return {"drivers": driver_catalog()}


class ProjectBody(BaseModel):
    assumptions: dict = {}
    as_of: str | None = None
    scope_type: str = "consolidated"
    scope_id: str = "ALL"


@router.post("/scenario/project")
def scenario_project(body: ProjectBody):
    """Stateless projection for live preview: baseline + scenario StatementSets.

    Pure math on a cached baseline — no persistence. The `baseline` is the neutral
    (no-assumptions) projection; `projection` applies the drivers."""
    baseline = get_baseline(body.as_of, body.scope_type, body.scope_id)
    return {
        "as_of": seed_period(body.as_of),
        "baseline": _ss(project(baseline, {})),
        "projection": _ss(project(baseline, body.assumptions or {})),
        "baseline_source": baseline.revenue_source,
    }


# --------------------------------------------------------------------------- #
# Scenario library (Lakebase)
# --------------------------------------------------------------------------- #
@router.get("/scenario/plans")
def list_plans(period: str = Query(None), status: str = Query(None)):
    """Light scenario list (no frozen_result). Defaults to the current close period
    and hides archived — `as_of_period` is the library's organising dimension."""
    # Scenario plans are seeded and stored on the raw CLOSE_PERIOD (seed) timeline,
    # so default to it directly — only map an *explicitly supplied* display period
    # back to seed. (Passing the default CLOSE_PERIOD through resolve_period would
    # let the demo-calendar shift move it off the seeded period and hide every plan.)
    p = resolve_period(period) if period else CLOSE_PERIOD
    try:
        _ensure_schema()
        with _pool().connection() as conn, conn.cursor(row_factory=_dict_rows()) as cur:
            cur.execute(
                "SELECT scenario_id, name, status, is_baseline, is_official, scope_type, scope_id, "
                "as_of_period, assumptions, created_by, updated_ts FROM scenario_plans "
                "WHERE as_of_period = %s AND status <> 'archived' "
                "ORDER BY is_baseline DESC, updated_ts DESC",
                (p,),
            )
            rows = cur.fetchall()
        decorated = decorate_compare_eligibility([dict(r) for r in rows])
        if status:
            decorated = [row for row in decorated if row["status"] == status]
        for row in decorated:
            row.pop("assumptions", None)
        return {"period": p, "plans": decorated}
    except Exception:  # noqa: BLE001 — degrade gracefully if Lakebase is unreachable
        # A healthy store always has the seeded Base/Worst/Best trio for the current
        # period, so an empty list means the store is unreachable. Log the real cause
        # (shows in app_ops.otel_logs) and flag it so the UI can say "unavailable"
        # instead of rendering a phantom, un-committable draft.
        log.exception("scenario_plans list failed for %s/%s — degrading to empty",
                      current_industry(), p)
        return {"period": p, "plans": [], "unavailable": True}


class CreateBody(BaseModel):
    name: str
    assumptions: dict = {}
    as_of: str | None = None
    scope_type: str = "consolidated"
    scope_id: str = "ALL"
    horizon_end: str | None = None
    parent_scenario_id: str | None = None


@router.post("/scenario/plans")
def create_plan(body: CreateBody):
    """Create a draft scenario (assumptions persisted self-describing)."""
    _ensure_schema()
    sid = "scn-" + uuid.uuid4().hex[:12]
    as_of = resolve_period(body.as_of) if body.as_of else CLOSE_PERIOD
    normalized_assumptions = _normalize_for_store(body.assumptions)
    try:
        with _pool().connection() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO scenario_plans (scenario_id, name, status, as_of_period, "
                "scope_type, scope_id, horizon_end, assumptions, parent_scenario_id, created_by) "
                "VALUES (%s, %s, 'draft', %s, %s, %s, %s, %s, %s, %s)",
                (sid, body.name.strip() or "Untitled", as_of, body.scope_type, body.scope_id,
                 body.horizon_end, json.dumps(normalized_assumptions),
                 body.parent_scenario_id, current_user()))
            conn.commit()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=f"scenario store unavailable: {e}")
    plan = _fetch_plan(sid)
    return plan


@router.get("/scenario/plans/{scenario_id}")
def get_plan(scenario_id: str):
    """One scenario, with its result. Draft → projected live; committed → the frozen
    snapshot verbatim (never recomputed)."""
    _ensure_schema()
    plan = _fetch_plan(scenario_id)
    if not plan:
        raise HTTPException(status_code=404, detail="scenario not found")
    if plan["status"] in ("committed", "published") and plan.get("frozen_result"):
        plan["result"] = plan["frozen_result"]
    else:
        baseline = get_baseline(plan["as_of_period"], plan["scope_type"], plan["scope_id"])
        plan["result"] = {"baseline": _ss(project(baseline, {})),
                          "projection": _ss(project(baseline, plan["assumptions"]))}
    return plan


class PatchBody(BaseModel):
    name: str | None = None
    assumptions: dict | None = None


@router.patch("/scenario/plans/{scenario_id}")
def update_plan(scenario_id: str, body: PatchBody):
    """Edit a draft in place. Committed scenarios are immutable — clone to edit (409)."""
    _ensure_schema()
    with _pool().connection() as conn, conn.cursor(row_factory=_dict_rows()) as cur:
        plan = _fetch_plan_locked(cur, scenario_id)
        if not plan:
            raise HTTPException(status_code=404, detail="scenario not found")
        if plan["status"] != "draft":
            raise HTTPException(status_code=409, detail="committed scenarios are immutable — clone to edit")
        proposed_assumptions = (
            _normalize_for_store(body.assumptions)
            if body.assumptions is not None
            else _normalize_for_store(plan["assumptions"])
        )
        _lock_scope(cur, plan["as_of_period"], plan["scope_type"], plan["scope_id"])
        plan["_candidates"] = _scope_candidates(cur, plan["as_of_period"], plan["scope_type"], plan["scope_id"])
        _assert_unique_plan(plan, proposed_assumptions)
        sets, params = [], []
        if body.name is not None:
            sets.append("name = %s")
            params.append(body.name.strip() or "Untitled")
        if body.assumptions is not None:
            sets.append("assumptions = %s")
            params.append(json.dumps(proposed_assumptions))
        if sets:
            sets.append("updated_ts = now()")
            params.append(scenario_id)
            cur.execute(
                f"UPDATE scenario_plans SET {', '.join(sets)} WHERE scenario_id = %s AND status = 'draft'",
                params,
            )
            if cur.rowcount != 1:
                raise HTTPException(status_code=409, detail="scenario is not a draft")
        cur.execute(f"SELECT {', '.join(_PLAN_COLS)} FROM scenario_plans WHERE scenario_id = %s", (scenario_id,))
        row = cur.fetchone()
        conn.commit()
    return _plan_row(row) if row else None


@router.post("/scenario/plans/{scenario_id}/commit")
def commit_plan(scenario_id: str):
    """Freeze a draft: project now, store {baseline, projection} + engine_version,
    status -> committed. Immutable thereafter."""
    _ensure_schema()
    with _pool().connection() as conn, conn.cursor(row_factory=_dict_rows()) as cur:
        plan = _fetch_plan_locked(cur, scenario_id)
        if not plan:
            raise HTTPException(status_code=404, detail="scenario not found")
        if plan["status"] != "draft":
            raise HTTPException(status_code=409, detail="scenario is not a draft")
        _lock_scope(cur, plan["as_of_period"], plan["scope_type"], plan["scope_id"])
        plan["_candidates"] = _scope_candidates(cur, plan["as_of_period"], plan["scope_type"], plan["scope_id"])
        normalized_assumptions = _normalize_for_store(plan["assumptions"])
        _assert_unique_plan(plan, normalized_assumptions)
        baseline = get_baseline(plan["as_of_period"], plan["scope_type"], plan["scope_id"])
        frozen = {"baseline": _ss(project(baseline, {})),
                  "projection": _ss(project(baseline, normalized_assumptions))}
        cur.execute(
            "UPDATE scenario_plans SET status = 'committed', frozen_result = %s, "
            "engine_version = %s, updated_ts = now() WHERE scenario_id = %s AND status = 'draft'",
            (json.dumps(frozen), ENGINE_VERSION, scenario_id),
        )
        if cur.rowcount != 1:
            raise HTTPException(status_code=409, detail="scenario is not a draft")
        cur.execute(f"SELECT {', '.join(_PLAN_COLS)} FROM scenario_plans WHERE scenario_id = %s", (scenario_id,))
        row = cur.fetchone()
        conn.commit()
    return _plan_row(row) if row else None


@router.post("/scenario/plans/{scenario_id}/clone")
def clone_plan(scenario_id: str):
    """Fork a new draft from any scenario (the way you 'edit' a committed one).
    Lands in the current close period so it shows in the picker."""
    _ensure_schema()
    src = _fetch_plan(scenario_id)
    if not src:
        raise HTTPException(status_code=404, detail="scenario not found")
    sid = "scn-" + uuid.uuid4().hex[:12]
    name = src["name"].removesuffix(" (copy)") + " (copy)"
    with _pool().connection() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO scenario_plans (scenario_id, name, status, as_of_period, "
            "scope_type, scope_id, assumptions, parent_scenario_id, created_by) "
            "VALUES (%s, %s, 'draft', %s, %s, %s, %s, %s, %s)",
            (sid, name, CLOSE_PERIOD, src["scope_type"], src["scope_id"],
             json.dumps(src["assumptions"]), src["scenario_id"], current_user()))
        conn.commit()
    return _fetch_plan(sid)


@router.post("/scenario/plans/{scenario_id}/archive")
def archive_plan(scenario_id: str):
    """Soft-delete (status -> archived; the app SP role has no DELETE)."""
    _ensure_schema()
    plan = _fetch_plan(scenario_id)
    if plan and plan["status"] == "baseline":
        raise HTTPException(status_code=409, detail="the baseline scenario cannot be archived")
    with _pool().connection() as conn, conn.cursor() as cur:
        cur.execute("UPDATE scenario_plans SET status = 'archived', updated_ts = now() "
                    "WHERE scenario_id = %s", (scenario_id,))
        conn.commit()
    return {"scenario_id": scenario_id, "status": "archived"}


@router.post("/scenario/plans/{scenario_id}/publish")
def publish_plan(scenario_id: str):
    """Promote a committed scenario to published — the official forecast for its period.
    Clears any previously published scenario for the same period first.
    Only committed scenarios may be published."""
    _ensure_schema()
    plan = _fetch_plan(scenario_id)
    if not plan:
        raise HTTPException(status_code=404, detail="scenario not found")
    if plan["status"] != "committed":
        raise HTTPException(status_code=409, detail="only committed scenarios can be published")
    with _pool().connection() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE scenario_plans SET status = 'committed', is_official = false, updated_ts = now() "
            "WHERE as_of_period = %s AND status = 'published'",
            (plan["as_of_period"],))
        cur.execute(
            "UPDATE scenario_plans SET status = 'published', is_official = true, updated_ts = now() "
            "WHERE scenario_id = %s",
            (scenario_id,))
        conn.commit()
    return _fetch_plan(scenario_id)


@router.post("/scenario/plans/{scenario_id}/unpublish")
def unpublish_plan(scenario_id: str):
    """Revoke the published status — returns the scenario to committed (under review)."""
    _ensure_schema()
    plan = _fetch_plan(scenario_id)
    if not plan:
        raise HTTPException(status_code=404, detail="scenario not found")
    with _pool().connection() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE scenario_plans SET status = 'committed', is_official = false, updated_ts = now() "
            "WHERE scenario_id = %s",
            (scenario_id,))
        conn.commit()
    return _fetch_plan(scenario_id)



# --------------------------------------------------------------------------- #
# Compare + bridge (read-side, reuse the engine)
# --------------------------------------------------------------------------- #
def _projection_for(plan: dict, baseline) -> dict:
    """A scenario's projection StatementSet: frozen snapshot if committed, else live."""
    if plan["status"] in ("committed", "published") and plan.get("frozen_result"):
        return plan["frozen_result"]["projection"]
    return _ss(project(baseline, plan["assumptions"]))


@router.post("/scenario/compare")
def compare_plans(ids: list[str] = Body(..., embed=True)):
    """Align N scenarios' projections against the current baseline for side-by-side."""
    _ensure_schema()
    with _pool().connection() as conn, conn.cursor(row_factory=_dict_rows()) as cur:
        with conn.transaction():
            cur.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
            cur.execute(
                f"SELECT {', '.join(_PLAN_COLS)} FROM scenario_plans WHERE scenario_id = ANY(%s)",
                (ids,),
            )
            requested_rows = cur.fetchall()
            by_requested_id = {row["scenario_id"]: _plan_row(row) for row in requested_rows}
            for sid in ids:
                row = by_requested_id.get(sid)
                if row and row["status"] == "archived":
                    raise HTTPException(status_code=409, detail="scenario is archived and cannot be compared")

            requested = [by_requested_id[sid] for sid in ids if sid in by_requested_id and by_requested_id[sid]["status"] != "archived"]
            groups = {(p["as_of_period"], p["scope_type"], p["scope_id"]) for p in requested}
            all_active: list[dict] = []
            for as_of_period, scope_type, scope_id in groups:
                all_active.extend(_scope_candidates(cur, as_of_period, scope_type, scope_id))
            by_id = {p["scenario_id"]: p for p in decorate_compare_eligibility([dict(p) for p in all_active])}

            for sid in ids:
                plan = next((p for p in requested if p["scenario_id"] == sid), None)
                if not plan:
                    continue
                if not plan["is_baseline"]:
                    eligible = by_id.get(sid)
                    if eligible is None:
                        raise HTTPException(status_code=409, detail="scenario eligibility could not be verified")
                    if not eligible.get("compare_eligible", False):
                        raise HTTPException(status_code=409, detail=eligible["compare_block_reason"])
    baseline = get_baseline(CLOSE_PERIOD)
    base_ss = _ss(project(baseline, {}))
    out = []
    for sid in ids:
        plan = next((p for p in requested if p["scenario_id"] == sid), None)
        if not plan:
            continue
        out.append({"scenario_id": sid, "name": plan["name"], "is_baseline": plan["is_baseline"],
                    "projection": _projection_for(plan, baseline)})
    return {"periods": base_ss["periods"], "hinge_index": base_ss["hinge_index"],
            "base": base_ss, "scenarios": out}


def _target_value(ss: dict, target: str) -> float:
    if target == "cash":
        return ss["lines"]["cash_balance"][-1]
    return sum(ss["lines"]["operating_income"])


class BridgeBody(BaseModel):
    scenario_id: str | None = None
    assumptions: dict | None = None
    target: str = "operating_income"  # operating_income | cash
    as_of: str | None = None


@router.post("/scenario/bridge")
def bridge(body: BridgeBody):
    """Base→scenario waterfall: each driver's isolated contribution to `target`
    (operating income FY total, or ending cash), plus an interaction residual."""
    if body.scenario_id:
        _ensure_schema()
        plan = _fetch_plan(body.scenario_id)
        if not plan:
            raise HTTPException(status_code=404, detail="scenario not found")
        assumptions = plan["assumptions"]
        as_of = plan["as_of_period"]
    else:
        assumptions = _describe(body.assumptions)
        as_of = body.as_of

    baseline = get_baseline(as_of)
    base_val = _target_value(_ss(project(baseline, {})), body.target)
    scn_val = _target_value(_ss(project(baseline, assumptions)), body.target)

    steps = []
    for did, entry in assumptions.items():
        contrib = _target_value(_ss(project(baseline, {did: entry})), body.target) - base_val
        if abs(contrib) < 1e-6:
            continue
        steps.append({"driver": did, "label": _CATALOG_BY_ID.get(did, {}).get("label", did),
                      "value": round(contrib, 2)})
    residual = round((scn_val - base_val) - sum(s["value"] for s in steps), 2)
    return {"target": body.target, "base": round(base_val, 2), "scenario": round(scn_val, 2),
            "total": round(scn_val - base_val, 2), "steps": steps, "residual": residual}
