"""Native in-app Genie chat (Act 5) over the CFO self-service space.

Wraps the Databricks SDK Genie Conversation API so the CFO can ask plain-language
questions and get answers rendered inside the app: a text reply plus, when Genie
runs SQL, the query result as a table.
"""
from databricks.sdk.errors import PermissionDenied
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..config import (
    CLOSE_PERIOD, current_industry, genie_embed_url, genie_investigation_space_id,
    genie_space_id, get_user_workspace_client, get_workspace_client,
)

router = APIRouter()

# Neutral question set (mirrors genie/genie_space.yaml sample_questions).
SUGGESTIONS = [
    "What's our operating-expense variance to forecast this month, and which business unit is driving it?",
    "What is our net income this period by region?",
    "What are our DSO, DPO and DIO this month, and how do they compare by region?",
    "What's our cash conversion cycle, and which business line is driving it?",
    "What is the data-quality status of this close right now?",
    "Are all subledgers and manual adjustments fully loaded and passing quality checks for this close?",
    "Show the variances that still need review.",
]

# Per-industry question set (falls back to the neutral SUGGESTIONS above). The
# data/answers are grounded in each industry's own governed close data.
SUGGESTIONS_BY_INDUSTRY: dict[str, list[str]] = {
    "capmarkets": [
        "What's our net trading income variance to forecast this month, and which entity is driving it?",
        "What is our net income this period by region?",
        "Which venues and clearing counterparties carry the largest fee exposure?",
        "How much of this month's operating expense is technology and market data?",
        "What is the data-quality status of this close right now?",
        "Are trade capture, clearing and finance subledgers fully loaded and passing quality checks?",
        "Show the variances that still need review.",
    ],
    "energy": [
        "What's our wholesale energy cost variance to forecast this month, and which business unit is driving it?",
        "What is our net income this period by region?",
        "Which counterparties carry the largest single-name exposure across entities?",
        "What's our gas-in-storage position and how does it affect commodity days?",
        "What is the data-quality status of this close right now?",
        "Are all billing, settlement and trading subledgers fully loaded and passing quality checks?",
        "Show the variances that still need review.",
    ],
    "consumer": [
        "What's our operating-expense variance to forecast this month, and which category is driving it?",
        "What is our net income this period by region?",
        "What are our DSO, DPO and DIO this month, and how do they compare by region?",
        "What's our cash conversion cycle, and which business line is driving it?",
        "What is the data-quality status of this close right now?",
        "Are all subledgers and manual adjustments fully loaded and passing quality checks for this close?",
        "Show the variances that still need review.",
    ],
    "fsi": [
        "What's our operating-expense variance to forecast this month, and which line of business is driving it?",
        "What is our net income this period by region?",
        "What are our receivables and payables days this month, and how do they compare by region?",
        "What's our cash cycle, and which line of business is driving it?",
        "What is the data-quality status of this close right now?",
        "Are all subledgers and manual adjustments fully loaded and passing quality checks for this close?",
        "Show the variances that still need review.",
    ],
}


def _suggestions() -> list[str]:
    return SUGGESTIONS_BY_INDUSTRY.get(current_industry(), SUGGESTIONS)


class AskIn(BaseModel):
    content: str


def _call_genie(method: str, *args, **kwargs):
    """Call Genie as the viewer, falling back when OBO lacks API scope."""
    user_client = get_user_workspace_client()
    app_client = get_workspace_client()
    try:
        return getattr(user_client.genie, method)(*args, **kwargs)
    except PermissionDenied:
        if user_client is app_client:
            raise
        return getattr(app_client.genie, method)(*args, **kwargs)


def _shape_statement(resp) -> dict | None:
    """Shape a GenieGetMessageQueryResultResponse into {columns, rows} or None."""
    sr = getattr(resp, "statement_response", None)
    if not sr or not sr.manifest or not sr.manifest.schema or not sr.manifest.schema.columns:
        return None
    data = sr.result.data_array if sr.result and sr.result.data_array else []
    if not data:  # answer text already carries the result; skip an empty table
        return None
    columns = [c.name for c in sr.manifest.schema.columns]
    return {"columns": columns, "rows": data}


def _result_table(conversation_id: str, message_id: str, space_id: str | None = None,
                  attachment_id: str | None = None) -> dict | None:
    """Fetch the SQL result for a message, shaped as {columns, rows}; None if absent.

    Prefer the per-ATTACHMENT result endpoint — the message-level endpoint returns
    an empty payload for some spaces (observed on the investigation space), whereas
    the attachment-scoped result is populated. Fall back to the message-level call."""
    sid = space_id or genie_space_id()
    if attachment_id is not None:
        try:
            resp = _call_genie(
                "get_message_attachment_query_result",
                space_id=sid, conversation_id=conversation_id,
                message_id=message_id, attachment_id=attachment_id)
            shaped = _shape_statement(resp)
            if shaped is not None:
                return shaped
        except Exception:  # noqa: BLE001 — fall through to the message-level call
            pass
    try:
        resp = _call_genie(
            "get_message_query_result",
            space_id=sid, conversation_id=conversation_id, message_id=message_id)
    except Exception:  # noqa: BLE001
        return None
    return _shape_statement(resp)


def _shape(msg, space_id: str | None = None) -> dict:
    """Turn a GenieMessage into {conversation_id, message_id, text, query, table, error}."""
    if msg.error:
        raise HTTPException(502, getattr(msg.error, "error", None) or "Genie returned an error")

    text_parts: list[str] = []
    sql_query: str | None = None
    query_attachment_id: str | None = None
    for att in msg.attachments or []:
        if att.text and att.text.content:
            text_parts.append(att.text.content)
        if att.query:
            if att.query.description:
                text_parts.append(att.query.description)
            sql_query = att.query.query
            query_attachment_id = getattr(att, "attachment_id", None)

    table = None
    if sql_query is not None:
        table = _result_table(msg.conversation_id, msg.message_id, space_id, query_attachment_id)

    return {
        "conversation_id": msg.conversation_id,
        "message_id": msg.message_id,
        "text": "\n\n".join(p for p in text_parts if p).strip() or None,
        "query": sql_query,
        "table": table,
    }


@router.get("/genie/suggestions")
def suggestions():
    return {"space_id": genie_space_id(), "questions": _suggestions()}


@router.get("/genie/embed")
def embed():
    """The iframe embed URL for the native Genie space (renders visualizations)."""
    return {"space_id": genie_space_id(), "url": genie_embed_url()}


@router.post("/genie/conversations")
def start_conversation(body: AskIn):
    if not body.content.strip():
        raise HTTPException(400, "Empty question")
    try:
        msg = _call_genie("start_conversation_and_wait", genie_space_id(), body.content)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Genie unavailable: {e}")
    return _shape(msg)


@router.post("/genie/investigate")
def investigate(body: AskIn | None = None):
    """Root-cause analysis for the close's open reconciliation breaks, answered by
    the dedicated investigation Genie space (source_ref-linked subledger/GL data).

    One call per close: asks the space to decompose every open break by root
    cause (timing / missing credit note / FX / discount / posting error) and
    returns the narrative + the per-invoice table. Falls back to a default prompt
    if none is supplied."""
    space = genie_investigation_space_id()
    question = (body.content.strip() if body and body.content else "") or (
        f"For the {CLOSE_PERIOD} close, list every open subledger-to-GL "
        "reconciliation break and, for each, decompose the variance by root cause "
        "(timing/unposted, missing credit note, FX at wrong rate, early-payment "
        "discount, posting error). Name the specific invoices and their dollar "
        "contribution, and tie the pieces back to each break's total.")
    # Genie runs its generated SQL on the same serverless warehouse that the rest
    # of the app uses; if that warehouse is cold-starting, the query fails and
    # Genie marks the whole message FAILED. That's transient — retry once (the
    # warehouse is warm by the second attempt) before surfacing an error.
    last_err: Exception | None = None
    for attempt in range(2):
        try:
            msg = _call_genie("start_conversation_and_wait", space, question)
            return _shape(msg, space)
        except Exception as e:  # noqa: BLE001 — transient warehouse cold-start / FAILED message
            last_err = e
            if attempt == 0 and "FAILED" in str(e):
                continue
            break
    raise HTTPException(502, f"Genie investigation unavailable: {last_err}")


@router.post("/genie/conversations/{conversation_id}/messages")
def follow_up(conversation_id: str, body: AskIn):
    if not body.content.strip():
        raise HTTPException(400, "Empty question")
    try:
        msg = _call_genie(
            "create_message_and_wait", genie_space_id(), conversation_id, body.content,
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Genie unavailable: {e}")
    return _shape(msg)
