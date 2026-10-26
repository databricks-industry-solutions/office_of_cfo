"""Controller -> CFO variance commentary for the FP&A comparative statement.

The variance table already answers *what* moved (the numbers) and offers an AI
one-liner for *why*. Neither carries an owner, and the first question a CFO asks
of any narrative is "who stands behind this?". This module adds the missing
accountability layer: a Controller writes (or edits an AI draft of) the
explanation for a P&L line, and the CFO reads it attributed to a named author,
then acknowledges it.

Deliberately a separate table from close.py's `variance_explanations`:
that one is keyed on a reconciliation control account ("{account}/{bu}") and
clearing a row there clears a close blocker. FP&A commentary is keyed on a
statement line in a specific comparison, explains a P&L movement rather than a
subledger-to-GL break, and must NOT affect close readiness. Sharing the table
would also leak FP&A rows into the Reconciliation page's explanation list, which
reads every row for the period.

Roles follow the app's existing capability model: `can_post` (Controller /
Accountant) authors, `can_sign_off` (CFO) acknowledges. Every write appends to
the same `close_task_activity` trail the Audit Log renders.
"""
import logging
import uuid

from fastapi import APIRouter, Header, HTTPException, Query
from pydantic import BaseModel, Field

from ..config import CLOSE_PERIOD, current_industry, current_user, resolve_period
from ..lakebase import pool
from ..personas import can, persona_label

logger = logging.getLogger(__name__)

router = APIRouter()

# The identity of one commentary row: a statement line, in one comparison, for one
# scope and period. Window/compare are part of the key on purpose — "COGS this
# month vs prior" and "COGS year-to-date vs prior year" are different variances
# with different explanations, so they must not overwrite each other.
_KEY_COLS = ("period", "stmt", "time_window", "compare_mode", "scope_type", "scope_id", "line_id")

# `window` and `compare` are SQL keywords, so the columns carry the `time_window`
# / `compare_mode` names and the API maps onto them.
_DDL = (
    "CREATE TABLE IF NOT EXISTS fpa_line_commentary ("
    " period text NOT NULL, stmt text NOT NULL, time_window text NOT NULL,"
    " compare_mode text NOT NULL, scope_type text NOT NULL, scope_id text NOT NULL,"
    " line_id text NOT NULL, commentary text NOT NULL,"
    # The AI sentence the author started from (null if they wrote from scratch).
    # Keeping it lets the UI distinguish an accepted draft from an edited one —
    # the governance point of the whole feature.
    " ai_draft text,"
    " author text, author_role text,"
    " updated_ts timestamptz NOT NULL DEFAULT now(),"
    " ack_by text, ack_role text, ack_ts timestamptz,"
    " PRIMARY KEY (period, stmt, time_window, compare_mode, scope_type, scope_id, line_id))",
    # Shared append-only activity trail (also created by tasks.py / close.py); the
    # Audit Log reads it via /close-activity.
    "CREATE TABLE IF NOT EXISTS close_task_activity ("
    " activity_id text PRIMARY KEY, task_id text NOT NULL, period text NOT NULL,"
    " ts timestamptz NOT NULL DEFAULT now(), actor text, action text NOT NULL,"
    " detail text DEFAULT '')",
)

# Per-industry guard: each industry has its own Lakebase instance, so the schema
# must be ensured once per industry (mirrors close.py's `_schema_ready`).
_schema_ready: set[str] = set()


def _ensure_schema() -> None:
    industry = current_industry()
    if industry in _schema_ready:
        return
    with pool.connection() as conn, conn.cursor() as cur:
        for stmt in _DDL:
            cur.execute(stmt)
    _schema_ready.add(industry)


def _unavailable(exc: Exception) -> HTTPException:
    """Turn an unreachable-Lakebase error into an honest 503.

    Reads degrade to an empty column, but a WRITE must never look like it worked.
    Without this the pool blocks for its full timeout and then surfaces a bare 500,
    which the UI can only render as an indefinite "Saving…". A 503 tells the author
    their note was NOT saved; the underlying reason is logged, not leaked to the UI."""
    logger.warning("Commentary storage unavailable: %s: %s", type(exc).__name__, exc)
    return HTTPException(
        503,
        "Commentary storage is temporarily unavailable, so the note was not saved. "
        "Please try again in a moment.",
    )


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


def _ref(key: dict) -> str:
    """Stable id for the audit trail: which line, in which view, was explained."""
    return (f"FPA-{key['period']}-{key['stmt']}-{key['line_id']}"
            f"-{key['time_window']}-{key['compare_mode']}-{key['scope_type']}:{key['scope_id']}")


def _key(stmt: str, window: str | None, compare: str | None,
         scope_type: str, scope_id: str, period: str, line_id: str = "") -> dict:
    """Normalise the view axes into the row key. Defaults mirror the statement
    endpoint's own defaults (mtd / prior) so a commentary written from the default
    view is found again when the page reloads on those same defaults."""
    return {
        "period": resolve_period(period), "stmt": stmt,
        "time_window": window or "mtd", "compare_mode": compare or "prior",
        "scope_type": scope_type or "consolidated", "scope_id": scope_id or "ALL",
        "line_id": line_id,
    }


def _row_to_entry(cols: list[str], row: tuple) -> dict:
    r = dict(zip(cols, row))
    for ts in ("updated_ts", "ack_ts"):
        r[ts] = r[ts].isoformat() if r.get(ts) else None
    # Which cut of the business this note explains. The CFO reads across scopes, so
    # the column has to say "EMEA" rather than implying the note is consolidated.
    st, sid = r.get("scope_type"), r.get("scope_id")
    r["scope_label"] = "" if not st or st == "consolidated" else str(sid)
    # "Was the AI draft accepted as-is, or did a human change it?" — the single
    # most useful governance signal on the page.
    draft = (r.get("ai_draft") or "").strip()
    r["edited_from_draft"] = bool(draft) and draft != (r.get("commentary") or "").strip()
    r["from_ai_draft"] = bool(draft)
    return r


@router.get("/statements/{stmt}/comparative/line-commentary")
def line_commentary(
    stmt: str,
    window: str = Query(None), compare: str = Query(None),
    scope_type: str = Query("consolidated"), scope_id: str = Query("ALL"),
    period: str = Query(None),
    x_persona: str | None = Header(default=None),
):
    """Every commentary written for this view, keyed by line_id.

    SCOPE IS PART OF THE ROW KEY on write, because "COGS EMEA vs prior" is a
    different variance from "COGS consolidated vs prior" and must not share an
    explanation. But that alone breaks the handoff this feature exists for: a
    Controller authors at their own scope (region/EMEA by default) while the CFO
    reads consolidated AND has `scope_locked`, so a note would never reach the one
    persona who can acknowledge it.

    So a `can_sign_off` persona reads ACROSS scopes: they see every note for this
    period/statement/window/compare, each carrying the scope it was written for so
    the CFO can tell an EMEA explanation from a consolidated one. Authors keep the
    strict per-scope view (they explain the numbers they are looking at).

    Best-effort like the AI-insight endpoint: if Lakebase is unreachable we return
    `available=False` with an empty map and the column simply renders empty — the
    variance table itself must never break because commentary is down."""
    k = _key(stmt, window, compare, scope_type, scope_id, period)
    across_scopes = can(x_persona, "can_sign_off")
    where = ("period = %s AND stmt = %s AND time_window = %s AND compare_mode = %s"
             + ("" if across_scopes else " AND scope_type = %s AND scope_id = %s"))
    drop = {"line_id"} if across_scopes else set()
    drop |= {"scope_type", "scope_id"} if across_scopes else set()
    params = tuple(k[c] for c in _KEY_COLS if c not in drop and c != "line_id")
    try:
        _ensure_schema()
        with pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT line_id, commentary, ai_draft, author, author_role, updated_ts,"
                " ack_by, ack_role, ack_ts, scope_type, scope_id FROM fpa_line_commentary "
                "WHERE " + where + " ORDER BY updated_ts",
                params)
            cols = [d[0] for d in cur.description]
            rows = [_row_to_entry(cols, r) for r in cur.fetchall()]
    except Exception:  # noqa: BLE001 — additive; never fail the table
        return {"available": False, "period": k["period"], "entries": {}, "groups": {}}
    # Reading across scopes can return several notes for one line (one per scope).
    # `groups` keeps ALL of them, in write order, so a sign-off reader sees each
    # region's explanation under its own `scope_label` instead of only the most
    # recent one winning the column. `entries` stays most-recent-per-line (rows are
    # ORDER BY updated_ts) for the single-scope author flow and the editor prefill.
    entries: dict[str, dict] = {}
    groups: dict[str, list[dict]] = {}
    for r in rows:
        lid = r["line_id"]
        groups.setdefault(lid, []).append(r)
        entries[lid] = r
    return {"available": True, "period": k["period"], "across_scopes": across_scopes,
            "entries": entries, "groups": groups}


class CommentaryIn(BaseModel):
    stmt: str
    line_id: str = Field(..., min_length=1)
    line_label: str = ""
    commentary: str = Field(..., min_length=1)
    # The AI sentence shown to the author, if any — stored so the UI can show
    # whether the human accepted or rewrote it.
    ai_draft: str | None = None
    window: str | None = None
    compare: str | None = None
    scope_type: str = "consolidated"
    scope_id: str = "ALL"
    period: str = CLOSE_PERIOD


@router.post("/statements/{stmt}/comparative/line-commentary")
def save_line_commentary(stmt: str, body: CommentaryIn,
                         x_persona: str | None = Header(default=None)):
    """Write (or revise) the explanation for one statement line. Controller /
    Accountant only — the CFO consumes commentary, they don't author it.

    Upsert on the view key so a line carries one current explanation, and a
    revision RE-OPENS any prior acknowledgement: the CFO signed off on the old
    words, so that sign-off cannot silently carry over to new ones."""
    role = _require(x_persona, "can_post", "write variance commentary")
    text = body.commentary.strip()
    if not text:
        raise HTTPException(400, "Commentary cannot be empty")
    k = _key(stmt, body.window, body.compare, body.scope_type, body.scope_id,
             body.period, body.line_id)
    actor = current_user()
    draft = (body.ai_draft or "").strip() or None
    try:
        _ensure_schema()
        _save_commentary(k, text, draft, actor, role, body)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 — a failed write must say so, not 500
        raise _unavailable(exc) from exc
    return {"ref": _ref(k), "line_id": k["line_id"], "commentary": text,
            "author": actor, "author_role": role, "status": "saved"}


def _save_commentary(k: dict, text: str, draft: str | None, actor: str, role: str,
                     body: "CommentaryIn") -> None:
    with pool.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO fpa_line_commentary ("
                " period, stmt, time_window, compare_mode, scope_type, scope_id, line_id,"
                " commentary, ai_draft, author, author_role)"
                " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)"
                " ON CONFLICT (period, stmt, time_window, compare_mode, scope_type,"
                " scope_id, line_id) DO UPDATE SET"
                "  commentary = EXCLUDED.commentary, ai_draft = EXCLUDED.ai_draft,"
                "  author = EXCLUDED.author, author_role = EXCLUDED.author_role,"
                "  updated_ts = now(),"
                # Revising the words invalidates the old acknowledgement.
                "  ack_by = NULL, ack_role = NULL, ack_ts = NULL",
                tuple(k[c] for c in _KEY_COLS) + (text, draft, actor, role))
            label = body.line_label or body.line_id
            edited = bool(draft) and draft != text
            how = ("edited the AI draft" if edited
                   else "accepted the AI draft" if draft else "wrote from scratch")
            _audit(cur, _ref(k), "variance_commentary",
                   f"{role} {how} for {label} ({k['stmt']}, {k['time_window']} vs "
                   f"{k['compare_mode']}): {text[:180]}", actor)
        conn.commit()


class AckIn(BaseModel):
    stmt: str
    line_id: str = Field(..., min_length=1)
    line_label: str = ""
    window: str | None = None
    compare: str | None = None
    scope_type: str = "consolidated"
    scope_id: str = "ALL"
    period: str = CLOSE_PERIOD


@router.post("/statements/{stmt}/comparative/line-commentary/ack")
def ack_line_commentary(stmt: str, body: AckIn,
                        x_persona: str | None = Header(default=None)):
    """CFO acknowledgement that they have read and accept a controller's
    explanation. `can_sign_off` only — this is the CFO's half of the workflow, and
    it is the reason the commentary is worth more than an unattributed AI
    sentence. Acknowledging a line that has no commentary is a 404, not a no-op."""
    role = _require(x_persona, "can_sign_off", "acknowledge variance commentary")
    k = _key(stmt, body.window, body.compare, body.scope_type, body.scope_id,
             body.period, body.line_id)
    actor = current_user()
    try:
        _ensure_schema()
        got = _ack_commentary(k, actor, role, body)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 — a failed ack must say so, not 500
        raise _unavailable(exc) from exc
    if not got:
        raise HTTPException(404, "No commentary to acknowledge on this line.")
    ack_ts = got[0].isoformat() if got[0] else None
    return {"ref": _ref(k), "line_id": k["line_id"], "ack_by": actor,
            "ack_role": role, "ack_ts": ack_ts, "status": "acknowledged"}


def _ack_commentary(k: dict, actor: str, role: str, body: "AckIn") -> tuple | None:
    with pool.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE fpa_line_commentary SET ack_by = %s, ack_role = %s, ack_ts = now()"
                " WHERE period = %s AND stmt = %s AND time_window = %s AND compare_mode = %s"
                " AND scope_type = %s AND scope_id = %s AND line_id = %s"
                " RETURNING ack_ts",
                (actor, role) + tuple(k[c] for c in _KEY_COLS))
            got = cur.fetchone()
            if got:
                label = body.line_label or body.line_id
                _audit(cur, _ref(k), "variance_commentary_ack",
                       f"{role} acknowledged the commentary for {label} "
                       f"({k['stmt']}, {k['time_window']} vs {k['compare_mode']})", actor)
        # Commit (or not) before raising, so the 404 can't leave the UPDATE and its
        # audit row half-applied.
        if got:
            conn.commit()
    return got
