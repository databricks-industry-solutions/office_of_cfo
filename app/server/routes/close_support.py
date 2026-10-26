"""Close Support / Intelligent Document Processing (IDP) API.

Read-only surface over the governed serving views produced offline by
`close_support/build_close_support.py` (ai_parse_document + ai_extract +
ai_query). No model inference happens on the request path — the app only reads
pre-computed Delta, so page loads are sub-second. Every extracted figure carries
its source document + page for the audit/lineage story.
"""
import io
import threading
import time
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from ..config import (
    CLOSE_DOCUMENTS_VOLUME, CLOSE_FQ, SRV_FQ, WAREHOUSE_ID, get_workspace_client, raw_volume,
)
from ..warehouse import query

router = APIRouter()

SRV = SRV_FQ
CLOSE = CLOSE_FQ


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


@router.get("/close-support/documents")
def documents():
    rows = query(
        f"SELECT filename, doc_type, counterparty, period, pages, ingested_ts "
        f"FROM {SRV}.close_documents_catalog ORDER BY doc_type, filename")
    for r in rows:
        r["pages"] = int(_num(r.get("pages")) or 0)
    return rows


@router.get("/close-support/benchmarks")
def benchmarks():
    rows = query(
        f"SELECT competitor, metric, their_value, our_value, delta, unit, "
        f"source_file, source_page "
        f"FROM {SRV}.competitor_benchmark_vs_us ORDER BY competitor, metric")
    for r in rows:
        r["their_value"] = _num(r.get("their_value"))
        r["our_value"] = _num(r.get("our_value"))
        r["delta"] = _num(r.get("delta"))
        r["source_page"] = int(_num(r.get("source_page")) or 1)
    return rows


@router.get("/close-support/obligations")
def obligations():
    rows = query(
        f"SELECT counterparty, contract_id, category, renewal_date, auto_renew, "
        f"payment_terms, annual_value, currency, liability, risk_level, risk_note, "
        f"obligations, source_file, source_page "
        f"FROM {SRV}.contract_obligations "
        f"ORDER BY CASE upper(risk_level) WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END, "
        f"renewal_date")
    for r in rows:
        r["annual_value"] = _num(r.get("annual_value"))
        r["source_page"] = int(_num(r.get("source_page")) or 1)
        av = r.get("auto_renew")
        r["auto_renew"] = str(av).lower() == "true" if av is not None else False
        r["obligations"] = [o.strip() for o in (r.get("obligations") or "").split("|") if o.strip()]
    return rows


# ---------------------------------------------------------------------------
# Live extraction (interactive). Re-runs the extraction pipeline on demand over
# the already-parsed text in close_documents_elements, rebuilding the governed
# tables. Parsing was done offline at build time, so a live run is only the
# ai_extract + ai_query('databricks-claude-sonnet-4-5', ...) statements (~20-40s).
# It runs in a background thread; the UI polls /run-status to drive a progress
# stepper, then re-reads the (now refreshed) serving views.
# ---------------------------------------------------------------------------

# Path label shown in the UI (narrative only — the run reads the parsed table,
# never the volume). The raw schema follows the repo convention.
# The close-documents volume (IDP source PDFs + uploads) is shared: it holds the
# governed unstructured inputs and was not cloned per-industry. Benchmarks/
# obligations/documents the page renders come from each industry's serving views;
# only run-extraction + uploads touch this volume.
_VOLUME_BASE = CLOSE_DOCUMENTS_VOLUME

# scope -> (label, path, extraction tables to rebuild before the catalog).
_SCOPES = {
    "all": ("All documents", f"{_VOLUME_BASE}/", ["benchmarks", "obligations"]),
    "filings": ("Competitor filings", f"{_VOLUME_BASE}/filings/", ["benchmarks"]),
    "contracts": ("Contracts", f"{_VOLUME_BASE}/contracts/", ["obligations"]),
}


def _load_statements() -> dict[str, str]:
    """Load the scope-parameterized extraction statements, keyed by target table.

    Kept in lockstep with close_support/build_close_support.sql (steps 3/4/5);
    lives in the app tree so it ships with `databricks sync`.
    """
    sql = (Path(__file__).with_name("run_extraction.sql")).read_text()
    body = "\n".join(ln for ln in sql.splitlines() if not ln.strip().startswith("--"))
    out: dict[str, str] = {}
    for raw in body.split(";"):
        stmt = raw.strip().replace("{close}", str(CLOSE)).replace("{volume}", _VOLUME_BASE)
        if not stmt:
            continue
        head = stmt.split(" AS ", 1)[0]
        if "competitor_benchmarks" in head:
            out["benchmarks"] = stmt
        elif "contract_obligations" in head:
            out["obligations"] = stmt
        elif "close_documents_catalog" in head:
            out["catalog"] = stmt
        elif "close_documents_elements" in head:  # INSERT ... parse new uploads
            out["parse_new"] = stmt
    return out


_STATEMENTS = _load_statements()

# Single in-flight run; the UI enforces one run at a time and we reject overlaps.
_RUN_LOCK = threading.Lock()
RUN_STATE: dict = {
    "stage": "idle",        # idle | parsing | extracting | materializing | done | error
    "scope": None,
    "docs": 0,
    "benchmarks": 0,
    "obligations": 0,
    "error": None,
}


def _exec(stmt: str):
    """Execute one statement, polling to completion (AI statements can exceed the
    single 50s wait window). Mirrors close_support/build_close_support.py."""
    w = get_workspace_client()
    resp = w.statement_execution.execute_statement(
        statement=stmt, warehouse_id=WAREHOUSE_ID, wait_timeout="50s")
    sid = resp.statement_id
    while resp.status and resp.status.state and resp.status.state.value in ("PENDING", "RUNNING"):
        time.sleep(2)
        resp = w.statement_execution.get_statement(sid)
    state = resp.status.state.value if resp.status and resp.status.state else "UNKNOWN"
    if state != "SUCCEEDED":
        err = resp.status.error.message if resp.status and resp.status.error else state
        raise RuntimeError(err)
    return resp


def _scalar(resp) -> int:
    try:
        return int(float(resp.result.data_array[0][0]))
    except (AttributeError, TypeError, ValueError, IndexError):
        return 0


def _run_extraction(scope: str):
    _label, _path, tables = _SCOPES[scope]
    try:
        # Parse any newly-uploaded PDFs not yet in close_documents_elements.
        # No-op for the seeded set (all already parsed) so the Parsing stage
        # stays fast/cosmetic; genuine ai_parse_document work when a doc was
        # just uploaded, which is what makes the numbers actually change.
        RUN_STATE["stage"] = "parsing"
        if "parse_new" in _STATEMENTS:
            _exec(_STATEMENTS["parse_new"])
        where = "" if scope == "all" else (
            " WHERE doc_type = 'filing'" if scope == "filings" else " WHERE doc_type = 'contract'")
        RUN_STATE["docs"] = _scalar(_exec(
            f"SELECT count(DISTINCT filename) FROM {CLOSE}.close_documents_elements{where}"))

        # Extract (ai_extract + ai_query) into the governed tables.
        RUN_STATE["stage"] = "extracting"
        for t in tables:
            _exec(_STATEMENTS[t])

        # Materialize the registry + read back the refreshed counts.
        RUN_STATE["stage"] = "materializing"
        _exec(_STATEMENTS["catalog"])
        RUN_STATE["benchmarks"] = _scalar(_exec(f"SELECT count(*) FROM {CLOSE}.competitor_benchmarks"))
        RUN_STATE["obligations"] = _scalar(_exec(f"SELECT count(*) FROM {CLOSE}.contract_obligations"))

        RUN_STATE["stage"] = "done"
    except Exception as e:  # noqa: BLE001
        RUN_STATE["error"] = str(e)
        RUN_STATE["stage"] = "error"
    finally:
        if _RUN_LOCK.locked():
            _RUN_LOCK.release()


class RunIn(BaseModel):
    scope: str = "all"


@router.get("/close-support/scopes")
def scopes():
    """Enumerate the analyzable folders + doc counts (from the parsed table, no
    volume listing) to populate the source-folder selector."""
    counts = {r["doc_type"]: int(_num(r.get("n")) or 0) for r in query(
        f"SELECT doc_type, count(DISTINCT filename) AS n "
        f"FROM {CLOSE}.close_documents_elements GROUP BY doc_type")}
    total = sum(counts.values())
    pdf = {"all": total, "filings": counts.get("filing", 0), "contracts": counts.get("contract", 0)}
    return [
        {"scope": s, "label": label, "path": path, "pdf_count": pdf[s]}
        for s, (label, path, _tables) in _SCOPES.items()
    ]


@router.post("/close-support/run-extraction")
def run_extraction(body: RunIn):
    if body.scope not in _SCOPES:
        raise HTTPException(400, f"Unknown scope '{body.scope}'")
    if not _RUN_LOCK.acquire(blocking=False):
        raise HTTPException(409, "An extraction is already running.")
    RUN_STATE.update(stage="parsing", scope=body.scope, docs=0,
                     benchmarks=0, obligations=0, error=None)
    threading.Thread(target=_run_extraction, args=(body.scope,), daemon=True).start()
    return {"started": True, "scope": body.scope}


@router.get("/close-support/run-status")
def run_status():
    return RUN_STATE


@router.post("/close-support/upload")
async def upload(file: UploadFile = File(...), doc_type: str = Form("filing")):
    """Land a PDF in the close_documents volume so the next run parses + extracts
    it. New/changed documents are the real lever for different numbers: this
    stages the file and clears any stale parsed rows so the run re-parses it."""
    dt = doc_type if doc_type in ("filing", "contract") else "filing"
    folder = "filings" if dt == "filing" else "contracts"
    name = Path(file.filename or "upload.pdf").name
    if not name.lower().endswith(".pdf"):
        raise HTTPException(400, "Please upload a PDF file.")
    data = await file.read()
    if not data:
        raise HTTPException(400, "The uploaded file is empty.")

    dest = f"{_VOLUME_BASE}/{folder}/{name}"
    try:
        get_workspace_client().files.upload(dest, io.BytesIO(data), overwrite=True)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Upload failed: {e}")

    # Drop any prior parse of this filename so a re-upload is re-parsed next run.
    try:
        _exec(f"DELETE FROM {CLOSE}.close_documents_elements "
              f"WHERE filename = '{name.replace(chr(39), chr(39) * 2)}'")
    except Exception:  # noqa: BLE001
        pass

    return {"filename": name, "doc_type": dt, "path": dest}
