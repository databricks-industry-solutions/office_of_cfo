"""Company-search competitor benchmarking (Competitors benchmarking2).

Isolated from the Close Support / IDP tab: its own Delta tables + serving view so
iterating here never touches the existing "Benchmarking" page. A search resolves
a listed company (ESEF/filings.xbrl.org for EU-listed, SEC EDGAR for US) and pulls
structured public financials — no PDF parsing — computes the curated sparse
benchmark metrics (see company_lookup), writes them to competitor_search_benchmarks,
and generates a one-line AI positioning note via ai_query. The frontend polls
/run-status for a staged progress bar, then reads the refreshed serving view.
"""
import contextvars
import hashlib
import logging
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import company_lookup as cl
from ..config import (CLOSE_FQ, SRV_FQ, WAREHOUSE_ID, current_industry,
                      get_workspace_client, set_current_industry)
from ..warehouse import invalidate_cache, query

logger = logging.getLogger(__name__)

router = APIRouter()

SRV = SRV_FQ
CLOSE = CLOSE_FQ


class _TableProxy:
    """Fully-qualified table name that resolves through the (per-request) schema
    proxy each time it is interpolated, so these module-level handles stay
    industry-correct instead of freezing to the default industry at import."""
    __slots__ = ("schema", "name")

    def __init__(self, schema, name):
        self.schema = schema
        self.name = name

    def __str__(self):
        return f"{self.schema}.{self.name}"

    def __format__(self, spec):
        return format(str(self), spec)


BENCH = _TableProxy(CLOSE, "competitor_search_benchmarks")
NOTES = _TableProxy(CLOSE, "competitor_search_notes")
TREND = _TableProxy(CLOSE, "competitor_search_trends")
# View lives in the CLOSE schema (the app's SP has CREATE there and owns these
# objects); it reads working_capital_kpis from SERVING cross-schema (SELECT only).
VIEW = _TableProxy(CLOSE, "competitor_search_vs_us")

_NOTE_MODEL = "databricks-claude-sonnet-4-5"

# Cache freshness: public filings are annual, so a competitor analyzed within this
# window is served from the stored rows instead of re-fetching + recomputing. To
# force a refresh, remove the competitor (DELETE endpoint) and analyze it again.
_CACHE_TTL_DAYS = 180


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _q(s: str) -> str:
    """Single-quote a string literal for SQL, escaping embedded quotes."""
    return "'" + str(s).replace("'", "''") + "'"


def _exec(stmt: str):
    """Run one statement to completion (polls past the 50s wait window)."""
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


def _view_is_queryable() -> bool:
    """True when the serving view already exists and is readable."""
    try:
        _exec(f"SELECT 1 FROM {VIEW} LIMIT 1")
        return True
    except RuntimeError:
        return False


def _is_manage_permission_denied(err: RuntimeError) -> bool:
    msg = str(err)
    return "PERMISSION_DENIED" in msg and "MANAGE" in msg


# The isolated view mirrors competitor_benchmark_vs_us: it joins each searched
# competitor's metrics to our own current-period figures (same scale-independent
# ratios as the KPI API), so the reused charts render "us vs peers" unchanged.
def _setup_statements() -> list[str]:
    """DDL for the isolated competitor-search objects, built PER CALL so the
    CLOSE / SRV schema proxies resolve to the ACTIVE industry at interpolation
    time. A module-level list would freeze every industry's setup to the default
    industry's schemas (they interpolate once, at import)."""
    return [
        f"""CREATE TABLE IF NOT EXISTS {BENCH} (
              competitor STRING, metric STRING, their_value DOUBLE, unit STRING,
              source_file STRING, source_url STRING, period STRING, fetched_at TIMESTAMP,
              metric_schema INT)""",
        f"""CREATE TABLE IF NOT EXISTS {NOTES} (
              competitor STRING, note STRING, source STRING)""",
        f"""CREATE TABLE IF NOT EXISTS {TREND} (
              competitor STRING, metric STRING, period_end DATE, label STRING,
              granularity STRING, value DOUBLE, unit STRING, fetched_at TIMESTAMP)""",
        f"""CREATE OR REPLACE VIEW {VIEW} AS
            WITH ours AS (
              SELECT SUM(ar_balance) AS ar, SUM(ap_balance) AS ap, SUM(inventory_balance) AS inv,
                     SUM(revenue) AS rev, SUM(cogs) AS cogs, SUM(operating_expense) AS opex,
                     MAX(days_in_period) AS days
              FROM {SRV}.working_capital_kpis
            ),
            ourmap AS (
              SELECT metric, our_value FROM ours
              LATERAL VIEW stack(8,
                'Revenue ($B)',     cast(round(rev * 12 / 1e9, 2) AS DOUBLE),
                'Gross margin',     cast(round((rev - cogs) / rev * 100, 1) AS DOUBLE),
                'Operating margin', cast(round((rev - cogs - opex) / rev * 100, 1) AS DOUBLE),
                'Net margin',       cast(round((rev - cogs - opex) / rev * 100, 1) AS DOUBLE),
                'DSO',              cast(round(ar / rev * days, 1) AS DOUBLE),
                'DIO',              cast(round(inv / cogs * days, 1) AS DOUBLE),
                'DPO',              cast(round(ap / cogs * days, 1) AS DOUBLE),
                'CCC',              cast(round(ar / rev * days + inv / cogs * days - ap / cogs * days, 1) AS DOUBLE)
              ) s AS metric, our_value
            )
            SELECT b.competitor, b.metric, b.their_value, o.our_value,
                   round(b.their_value - o.our_value, 1) AS delta, b.unit,
                   b.source_file, b.source_url, b.period
            FROM {BENCH} b LEFT JOIN ourmap o USING (metric)""",
    ]


# Track setup per CLOSE schema, not once globally — each industry has its own
# schema set and needs its own objects created (a single flag would set up only
# the first industry hit and skip the rest).
_setup_done: set[str] = set()
_setup_lock = threading.Lock()


def _ensure_setup():
    schema = str(CLOSE)  # resolves to the active industry's close schema
    if schema in _setup_done:
        return
    with _setup_lock:
        if schema in _setup_done:
            return
        for stmt in _setup_statements():
            try:
                _exec(stmt)
            except RuntimeError as e:
                # A prior seed/clone can materialize the serving view as a TABLE in
                # this industry's schema, so CREATE OR REPLACE VIEW fails with
                # EXPECT_VIEW_NOT_TABLE. Drop the stray table and recreate the view.
                if "EXPECT_VIEW_NOT_TABLE" in str(e) and "CREATE OR REPLACE VIEW" in stmt:
                    _exec(f"DROP TABLE IF EXISTS {VIEW}")
                    _exec(stmt)
                elif (
                    _is_manage_permission_denied(e)
                    and "CREATE OR REPLACE VIEW" in stmt
                    and _view_is_queryable()
                ):
                    # View exists under another owner; app SP can read but not replace.
                    logger.warning(
                        "Skipping CREATE OR REPLACE VIEW for %s — MANAGE denied but view is queryable",
                        VIEW,
                    )
                else:
                    raise
        # Migrate a benchmarks table created before the cache column existed.
        try:
            _exec(f"ALTER TABLE {BENCH} ADD COLUMN fetched_at TIMESTAMP")
        except Exception:  # noqa: BLE001 — column already present on fresh tables
            pass
        # Schema version for metric-catalog invalidation (null legacy rows = miss).
        try:
            _exec(f"ALTER TABLE {BENCH} ADD COLUMN metric_schema INT")
        except Exception:  # noqa: BLE001 — column already present on fresh tables
            pass
        _setup_done.add(schema)


# Single in-flight run, with its own state (isolated from the IDP tab's RUN_STATE).
_RUN_LOCK = threading.Lock()
RUN_STATE: dict = {
    "stage": "idle",      # idle | resolving | fetching | computing | writing | done | error
    "competitor": None,
    "source": None,
    "period": None,
    "metrics": 0,
    "note": None,
    "error": None,
    "cached": False,
}


def _build_note(competitor: str, rows: list[dict]) -> str | None:
    """One-sentence AI positioning note via ai_query, seeded with the metrics.
    Best-effort: a model/permission failure just skips the note (non-fatal)."""
    summary = ", ".join(f"{r['metric']} {r['their_value']}{r['unit']}" for r in rows)
    prompt = (
        "You are an equity analyst. In ONE concise sentence (max 24 words), describe "
        f"{competitor}'s competitive positioning based only on these figures: {summary}. "
        "No preamble, no markdown.")
    try:
        resp = _exec(f"SELECT ai_query({_q(_NOTE_MODEL)}, {_q(prompt)})")
        note = resp.result.data_array[0][0]
        return note.strip() if note else None
    except Exception:  # noqa: BLE001 — note is a nice-to-have, never fail the run
        return None


def _cache_lookup(name: str) -> dict | None:
    """Return summary metadata if this competitor was analyzed within the TTL under
    the current metric schema, else None. The benchmark rows stay in the table for
    the serving view; we only need the summary fields to report the (cached) run as
    done without re-fetching. Best-effort: any read failure just yields a cache miss
    (falls back to a live fetch), so the cache can never break an analysis run.

    Legacy rows with null `metric_schema` are a miss so they are rewritten once
    under the current catalog version.
    """
    name = cl.normalize_competitor_name(name)
    if not name:
        return None
    try:
        # use_cache=False: bypass warehouse.query's 60s result cache so we read the
        # rows just written by a prior run, not a stale pre-write count.
        rows = query(
            f"SELECT any_value(period) AS period, COUNT(*) AS metrics "
            f"FROM {BENCH} "
            f"WHERE competitor = {_q(name)} "
            f"AND metric_schema = {int(cl.METRIC_SCHEMA_VERSION)} "
            f"AND fetched_at >= current_timestamp() - INTERVAL {int(_CACHE_TTL_DAYS)} DAYS",
            use_cache=False)
        if not rows or not rows[0].get("metrics") or int(rows[0]["metrics"]) == 0:
            return None
        # A competitor analyzed before the trend series existed has benchmark rows
        # but no trend rows — treat that as a miss so the run recomputes and backfills
        # the trend table (otherwise its trend line would silently be missing).
        trend_rows = query(
            f"SELECT COUNT(*) AS n FROM {TREND} WHERE competitor = {_q(name)}", use_cache=False)
        if not trend_rows or int(trend_rows[0].get("n") or 0) == 0:
            return None
        note_rows = query(
            f"SELECT note FROM {NOTES} WHERE competitor = {_q(name)} LIMIT 1", use_cache=False)
        note = note_rows[0]["note"] if note_rows else None
        return {"period": rows[0].get("period"), "metrics": int(rows[0]["metrics"]),
                "note": note, "competitor": name}
    except Exception:  # noqa: BLE001 — cache is best-effort; miss on any error
        return None


def _run_add(source: str, key: str, name: str):
    try:
        RUN_STATE["stage"] = "resolving"
        RUN_STATE["cached"] = False
        _ensure_setup()

        name = cl.normalize_competitor_name(name)

        # Cache hit: reuse stored rows (skip the live filing fetch, recompute, and
        # the ai_query note). The competitor written to the tables equals `name`.
        cached = _cache_lookup(name)
        if cached:
            RUN_STATE.update(competitor=cached["competitor"], period=cached["period"],
                             metrics=cached["metrics"], note=cached["note"],
                             cached=True, stage="done")
            return

        RUN_STATE["stage"] = "fetching"
        result = cl.resolve_and_compute(source, key, name)
        rows = result.get("rows", [])
        if not rows:
            raise RuntimeError(f"No structured financials found for {name}.")

        RUN_STATE["stage"] = "computing"
        competitor = cl.normalize_competitor_name(result["competitor"])
        RUN_STATE.update(competitor=competitor, source=result["source"], period=result["period"])

        RUN_STATE["stage"] = "writing"
        schema_v = int(cl.METRIC_SCHEMA_VERSION)
        values = ", ".join(
            f"({_q(competitor)}, {_q(r['metric'])}, {r['their_value']}, {_q(r['unit'])}, "
            f"{_q(result['source_file'])}, {_q(result['source_url'])}, {_q(result['period'])}, "
            f"current_timestamp(), {schema_v})"
            for r in rows)
        _exec(f"DELETE FROM {BENCH} WHERE competitor = {_q(competitor)}")
        _exec(f"INSERT INTO {BENCH} (competitor, metric, their_value, unit, source_file, "
              f"source_url, period, fetched_at, metric_schema) VALUES {values}")

        # Multi-period trend series (quarterly for US / EDGAR, annual for EU / ESEF).
        trend = [t for t in result.get("trend", []) if t.get("value") is not None]
        _exec(f"DELETE FROM {TREND} WHERE competitor = {_q(competitor)}")
        if trend:
            tvals = ", ".join(
                f"({_q(competitor)}, {_q(t['metric'])}, DATE'{t['period_end']}', {_q(t['label'])}, "
                f"{_q(t['granularity'])}, {t['value']}, {_q(t['unit'])}, current_timestamp())"
                for t in trend)
            _exec(f"INSERT INTO {TREND} (competitor, metric, period_end, label, granularity, value, unit, fetched_at) "
                  f"VALUES {tvals}")

        note = _build_note(competitor, rows)
        _exec(f"DELETE FROM {NOTES} WHERE competitor = {_q(competitor)}")
        if note:
            _exec(f"INSERT INTO {NOTES} (competitor, note, source) VALUES "
                  f"({_q(competitor)}, {_q(note)}, {_q(result['source_file'])})")

        # Drop the warehouse read cache so the freshly written rows are visible to
        # the benchmarks view query and to the next cache lookup.
        invalidate_cache()
        RUN_STATE.update(metrics=len(rows), note=note, cached=False, stage="done")
    except Exception as e:  # noqa: BLE001
        RUN_STATE["error"] = str(e)
        RUN_STATE["stage"] = "error"
    finally:
        if _RUN_LOCK.locked():
            _RUN_LOCK.release()


class AddIn(BaseModel):
    source: str
    key: str
    name: str


from ..config import COMPANY_NAME, current_industry  # noqa: E402


# ---------------------------------------------------------------------------
# Peer suggestions for the chosen customer company
# ---------------------------------------------------------------------------
# The chips under the search bar are peers of the company the demo was installed
# for (CFO_COMPANY_NAME, asked by scripts/setup.py). That company can be ANY
# listed company, so the peer set is derived by the model, never curated: the
# repo carries no list of companies to benchmark. Every name it returns is then put through the SAME resolver the
# search box uses and dropped unless it resolves: a chip that cannot be analyzed
# is worse than no chip, because the user only discovers that after clicking Run.

_PEER_ASK = 10          # names requested from the model
_PEER_KEEP = 6          # validated chips returned
_PEER_NAME_MAX = 120    # cap on the configured company name reaching the prompt
_PEER_LINE_MAX = 60     # a returned line longer than this is prose, not a name

_PEER_TTL_SECONDS = 24 * 3600
# Empty results are cached far more briefly than real ones. An empty list is
# usually a transient failure (warehouse asleep, filing source unreachable), and
# caching that for a day would turn a blip into a day of missing chips — the same
# cache-poisoning trap the ESEF filing probe fell into.
_PEER_EMPTY_TTL_SECONDS = 600
_PEER_CACHE_MAX = 64
_PEER_CACHE: dict[str, tuple[float, list[str]]] = {}
_PEER_CACHE_LOCK = threading.Lock()

# Per-NAME "can this be benchmarked?" verdicts, shared across customers. Peer sets
# overlap heavily inside a vertical — every bank names the same handful of banks —
# so this is the cache that actually earns its keep once a second customer in the
# same industry is looked up. Larger than _PEER_CACHE because it holds individual
# names rather than whole rows. Only definitive verdicts land here; an inconclusive
# probe returns without writing, so a source blip is retried rather than sticking.
_PEER_OK_CACHE_MAX = 512
_PEER_OK_CACHE: dict[str, tuple[float, bool]] = {}
_PEER_OK_LOCK = threading.Lock()

_PEER_NUMBERING = re.compile(r"^\s*(?:\d+\s*[.)\-]|[-*\u2022\u2013])\s*")
_PEER_TRAILING_PAREN = re.compile(r"\s*\([^)]*\)\s*$")

# Trailing legal-form and geographic words the model appends but a filing search
# does not want. See _peer_search_name for why this matters so much.
# "america"/"americas" are deliberately absent: they are load-bearing parts of
# real names ("Bank of America Corporation" must trim to "Bank of America", not
# "Bank of"), unlike the purely geographic "USA" in "Skechers U.S.A., Inc.".
_PEER_SUFFIX_WORDS = {
    "inc", "incorporated", "corp", "corporation", "co", "company", "companies",
    "ltd", "limited", "plc", "llc", "lp", "holdings", "holding", "group",
    "ag", "se", "sa", "nv", "bv", "spa", "ab", "asa", "oyj", "kgaa", "aps",
    "sarl", "srl", "usa", "us",
}

# Words that are only ever left dangling by a trim, never a name's last word.
_PEER_CONNECTOR_WORDS = {"and", "of", "the", "for"}


def _peer_search_name(name: str) -> str:
    """Trim trailing legal-form words to the terse name the resolver ranks highest.

    This is the difference between two and six chips. The model returns full legal
    names, and the resolver matches on whole normalized tokens against what a
    human would type — so "Skechers U.S.A., Inc." misses the filer indexed as
    "SKECHERS USA INC", and "VF Corporation" misses "V.F. CORP", even though both
    are SEC filers that resolve instantly as "Skechers" and "VF". Trimming also
    makes a better chip label, so the trimmed name is what we keep.

    Only trailing words are trimmed, and never the last one, so a name that is all
    suffix ("3M Company" -> "3M") still survives.
    """
    words = name.replace(",", " ").split()
    while len(words) > 1:
        tail = words[-1].lower()
        letters = re.sub(r"[^a-z]", "", tail)
        # Dropping a suffix strips its own scaffolding too: "JPMorgan Chase & Co."
        # leaves a dangling "&" that breaks the resolver as surely as "Co." did.
        # A trailing token with no letters at all is only ever that scaffolding,
        # unless it carries a digit ("3M", "Company 0"), which is part of the name.
        if re.search(r"[a-z0-9]", tail) and letters not in _PEER_SUFFIX_WORDS \
                and letters not in _PEER_CONNECTOR_WORDS:
            break
        words.pop()
    return " ".join(words) or name


def _peer_prompt(company: str) -> str:
    """Ask for competitors in the customer's own market first, but never at the
    cost of the sector.

    Both halves are load-bearing. Without the home-market preference the model
    anchors geographically only by accident, and a Dutch bank came back with a
    US peer set (JPMorgan, Bank of America, Citigroup) while its two obvious
    Dutch rivals were absent. But with the market preference and no sector guard
    it substitutes geography for competition outright — an energy retailer
    came back with UK *water* utilities (Pennon, Severn Trent, United
    Utilities), which are regional peers and not competitors at all.
    """
    return (
        f"List the {_PEER_ASK} largest publicly listed competitors of {company}. "
        f"Every name must compete in {company}'s own line of business - a company "
        "in an adjacent industry is not a competitor even if it is a close "
        "geographic peer. Among those, prefer companies whose primary market or "
        f"headquarters is in the same country or region as {company}, then fill "
        "the remaining slots with global peers. "
        "Rules: one company name per line; the common or legal name only, with no "
        "ticker, exchange, country, or commentary; no numbering, no bullets, no "
        "preamble; prefer companies that file with the SEC or publish ESEF "
        f"filings; never include {company} itself.")


def _parse_peer_lines(raw: str, company: str) -> list[str]:
    """Model text -> clean candidate names. Pure, so it is unit-testable offline.

    The model mostly honours "one name per line", but not always: it slips in
    numbering, bullets, quotes, a trailing "(NYSE: NKE)", or a "Here are the
    competitors:" preamble. Anything still not name-shaped after stripping is
    dropped rather than guessed at, since the resolver probe that follows costs a
    network round trip per name and a malformed one can only waste it.
    """
    self_norm = cl._norm(company)
    out: list[str] = []
    seen: set[str] = set()
    for line in (raw or "").splitlines():
        name = _PEER_NUMBERING.sub("", line.strip())
        name = _PEER_TRAILING_PAREN.sub("", name).strip().strip("\"'\u201c\u201d").strip()
        # A colon or a long word run means prose (a preamble or an explanation),
        # never a company name.
        if not name or ":" in name or len(name) > _PEER_LINE_MAX or len(name.split()) > 7:
            continue
        name = _peer_search_name(name)
        key = cl._norm(name)
        # "Acme Foods PLC" when the customer IS Acme Foods is still self-comparison.
        # The model adds and drops legal suffixes freely, so compare on a token
        # prefix rather than exact equality. This can cost a genuine peer that
        # extends the customer's name (Coca-Cola / Coca-Cola FEMSA), which is a
        # trade worth making: a chip benchmarking the customer against itself is
        # visibly broken, a missing eleventh peer is not.
        if not key or key in seen:
            continue
        if key == self_norm or key.startswith(f"{self_norm} ") or self_norm.startswith(f"{key} "):
            continue
        seen.add(key)
        out.append(name)
        if len(out) >= _PEER_ASK:
            break
    return out


def _peer_benchmarks(name: str) -> bool:
    """True when the name yields actual benchmark metrics, computed through the
    exact path the Run-analysis button uses.

    Resolving the name is not enough: an entity can sit in the ESEF roster, and
    even have a filing, yet still produce nothing comparable — a bank reporting
    interest and fee income rather than revenue is the common case. Validating on
    resolution alone is what let ABN AMRO and BNP Paribas onto the chip row and
    then failed when clicked.

    An unreachable source is not a verdict, so it drops the name for this call
    without being cached as a definitive no (see _PEER_EMPTY_TTL_SECONDS).

    Companies already analyzed into Delta (fresh TTL + matching metric_schema)
    short-circuit to True without a live filing probe — the same store the Run
    button reuses.
    """
    name = cl.normalize_competitor_name(name)
    key = cl._norm(name)
    now = time.time()
    with _PEER_OK_LOCK:
        hit = _PEER_OK_CACHE.get(key)
        if hit and hit[0] > now:
            return hit[1]
    # Durable cache hit: already proven benchmarkable under the current schema.
    try:
        _ensure_setup()
        if _cache_lookup(name):
            with _PEER_OK_LOCK:
                if len(_PEER_OK_CACHE) >= _PEER_OK_CACHE_MAX:
                    _PEER_OK_CACHE.clear()
                _PEER_OK_CACHE[key] = (now + _PEER_TTL_SECONDS, True)
            return True
    except Exception:  # noqa: BLE001 — fall through to live probe
        pass
    try:
        hits = cl.search_companies(name, limit=1)
        if not hits:
            return False
        c = hits[0]
        # One filing is enough to answer "can this be benchmarked?" — see
        # resolve_and_compute. The full three-filing read happens when the user
        # actually clicks the chip.
        ok = bool(cl.resolve_and_compute(
            c["source"], c["key"], c["name"], max_filings=1).get("rows"))
    except Exception:  # noqa: BLE001
        return False
    # Cached per NAME rather than per customer, because peer sets overlap heavily —
    # every bank proposes the same handful of banks, so the second customer in a
    # vertical mostly reads verdicts the first one already paid for.
    with _PEER_OK_LOCK:
        if len(_PEER_OK_CACHE) >= _PEER_OK_CACHE_MAX:
            _PEER_OK_CACHE.clear()
        _PEER_OK_CACHE[key] = (now + _PEER_TTL_SECONDS, ok)
    return ok


def _peer_names_from_model(company: str) -> list[str]:
    """One ai_query round trip, parsed. Same call shape as _build_note."""
    resp = _exec(f"SELECT ai_query({_q(_NOTE_MODEL)}, {_q(_peer_prompt(company))})")
    raw = resp.result.data_array[0][0]
    return _parse_peer_lines(raw or "", company)


def _validated_peers(company: str) -> list[str]:
    names = _peer_names_from_model(company)
    if not names:
        return []
    # A worker thread starts with an EMPTY context, so the X-Industry ContextVar
    # falls back to the default industry and _peer_benchmarks' Delta probe reads the
    # wrong schema — the durable-cache shortcut then never fires outside `consumer`
    # and every candidate pays a live filing lookup. `add()` carries the industry
    # over with copy_context(), but a single copied Context cannot be reused here:
    # two threads entering the same one raises "cannot enter context". So the
    # resolved value is captured on the request thread and re-set per task.
    industry = current_industry()

    def probe(name: str) -> bool:
        set_current_industry(industry)
        return _peer_benchmarks(name)

    # All candidates at once, one worker each: the page is blocked on this, so what
    # matters is wall time — roughly the slowest single probe — not the number of
    # requests. Probing in waves to save requests serializes the waves and was
    # measurably worse where it hurts (Centrica: 106s in two waves).
    with ThreadPoolExecutor(max_workers=len(names)) as pool:
        verdicts = list(pool.map(probe, names))
    # Model order is preserved, which is what keeps home-market names at the front.
    return [n for n, ok in zip(names, verdicts, strict=True) if ok][:_PEER_KEEP]


def _cached_peers(company: str) -> list[str]:
    """Validated peers for a company, memoized per process. The chip row is fetched
    on every mount of the page, and the uncached path costs a model call plus a
    metric computation per candidate, so without this the page would pay tens of
    seconds each time."""
    key = cl._norm(company)
    now = time.time()
    with _PEER_CACHE_LOCK:
        hit = _PEER_CACHE.get(key)
        if hit and hit[0] > now:
            return hit[1]
    picks = _validated_peers(company)
    ttl = _PEER_TTL_SECONDS if picks else _PEER_EMPTY_TTL_SECONDS
    with _PEER_CACHE_LOCK:
        if len(_PEER_CACHE) >= _PEER_CACHE_MAX:
            _PEER_CACHE.clear()
        _PEER_CACHE[key] = (now + ttl, picks)
    return picks


@router.get("/competitor-search/peer-suggestions")
def peer_suggestions():
    """Peers of the company the demo was installed for (see routes/company.py)."""
    return _suggest_peers(COMPANY_NAME)


def _suggest_peers(company: str) -> dict:
    """Best-effort like the ai_query note: any failure — model unavailable, no
    warehouse permission, filing sources unreachable — returns an empty list with
    HTTP 200 so the page shows "no peers found" instead of erroring a page that is
    otherwise fine. The user can still search companies by hand.
    """
    # Collapse whitespace and cap the length before it reaches the prompt (config
    # already does this; repeated so the guard sits next to the prompt). _q()
    # escapes the literal.
    name = " ".join((company or "").split())[:_PEER_NAME_MAX]
    if len(name) < 2:
        return {"company": name, "picks": []}
    try:
        return {"company": name, "picks": _cached_peers(name)}
    except Exception:  # noqa: BLE001
        logger.warning("Peer suggestions failed for %r", name, exc_info=True)
        return {"company": name, "picks": []}


@router.get("/competitor-search/search")
def search(name: str = ""):
    """Candidates plus why a result set is thin.

    Returns an envelope rather than a bare list so the UI can tell three cases
    apart that all used to render as "No matches — try the full legal name":
      - `notice` set, no candidates -> the company is real but publishes no
        structured filing (Nestlé, E.ON, EDF, or any German ESEF registrant).
      - `degraded` non-empty        -> a public source was unreachable. Not a
        missing company; retrying works.
      - both empty, no candidates   -> genuinely no such company.
    """
    try:
        return cl.search_with_status(name)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Search failed: {e}")


@router.post("/competitor-search/add")
def add(body: AddIn):
    if not body.key or not body.name:
        raise HTTPException(400, "A company selection is required.")
    if not _RUN_LOCK.acquire(blocking=False):
        raise HTTPException(409, "An analysis is already running.")
    RUN_STATE.update(stage="resolving", competitor=cl.normalize_competitor_name(body.name),
                     source=body.source.upper(),
                     period=None, metrics=0, note=None, error=None, cached=False)
    # Run the worker inside a COPY of the current request context so the active
    # industry (X-Industry ContextVar) propagates into the thread. Plain threads
    # start with the default context, which made _run_add resolve to the default
    # industry (consumer) and write to the wrong schema.
    ctx = contextvars.copy_context()
    threading.Thread(target=ctx.run, args=(_run_add, body.source, body.key, body.name),
                     daemon=True).start()
    return {"started": True, "name": body.name}


@router.get("/competitor-search/run-status")
def run_status():
    return RUN_STATE


@router.get("/competitor-search/metric-catalog")
def metric_catalog_endpoint():
    """Curated metric metadata (unit / better / chartable) + schema version."""
    return cl.metric_catalog()


@router.get("/competitor-search/benchmarks")
def benchmarks():
    _ensure_setup()
    rows = query(
        f"SELECT competitor, metric, their_value, our_value, delta, unit, "
        f"source_file, source_url, period FROM {VIEW} ORDER BY competitor, metric")
    for r in rows:
        r["their_value"] = _num(r.get("their_value"))
        r["our_value"] = _num(r.get("our_value"))
        r["delta"] = _num(r.get("delta"))
    return rows


@router.get("/competitor-search/notes")
def notes():
    _ensure_setup()
    return query(f"SELECT competitor, note, source FROM {NOTES} ORDER BY competitor")


def _quarter_dates(dmin: date, dmax: date, cap: int = 40) -> list[date]:
    """Quarter-spaced dates from dmax back to dmin (ascending), capped for sanity."""
    out: list[date] = []
    d = dmax
    while d >= dmin and len(out) < cap:
        out.append(d)
        d = d - timedelta(days=91)
    out.reverse()
    return out


def _mock_track(metric: str, v_now: float, n: int) -> list[float]:
    """A deterministic, plausible back-fill of `n` points ending exactly at our
    current value `v_now`. Seeded by the metric name so the shape is stable across
    renders but differs per metric."""
    seed = int(hashlib.md5(metric.encode()).hexdigest()[:8], 16)

    def noise(i: int) -> float:
        x = (seed * 2654435761 + i * 40503) & 0xFFFFFFFF
        x ^= x >> 13
        x = (x * 1274126177) & 0xFFFFFFFF
        return ((x >> 8) & 0xFFFFFF) / 0xFFFFFF  # 0..1

    drift = (noise(0) - 0.5) * 0.25            # total relative drift across the span
    start = v_now * (1 - drift)
    amp = 0.05 * (abs(v_now) or 1.0)
    out: list[float] = []
    for i in range(n):
        t = i / (n - 1) if n > 1 else 1.0
        base = start + (v_now - start) * t
        val = v_now if i == n - 1 else base + (noise(i + 1) - 0.5) * 2 * amp
        out.append(round(val, 1))
    return out


def _our_revenue_growth() -> float | None:
    """Our current revenue growth (%) from the trailing monthly kpi_history — the
    same first-vs-last calc the Rule-of-40 chart uses. Revenue growth isn't in the
    vs-us view (it's not a balance ratio), so we derive it here to anchor the mock
    'Us' trend for that metric. Best-effort: any failure just drops the Us line."""
    try:
        rows = query(
            f"SELECT revenue FROM {SRV}.kpi_history "
            f"WHERE scope_type = 'consolidated' AND scope_id = 'ALL' ORDER BY period")
        revs = [v for v in (_num(r.get("revenue")) for r in rows) if v]
        if len(revs) >= 2 and revs[0]:
            return round((revs[-1] - revs[0]) / revs[0] * 100, 1)
    except Exception:  # noqa: BLE001 — mock anchor is best-effort
        return None
    return None


def _mock_us_series(peer_rows: list[dict]) -> list[dict]:
    """A synthetic quarterly 'Us' trend spanning the peer date range. Our real
    history is only trailing-12-months, so we anchor each metric to our current
    value (from the vs-us view, plus a derived revenue-growth anchor) and
    deterministically back-fill the earlier points. Absolute revenue is skipped —
    only scale-independent ratios are comparable."""
    ends = [r["period_end"] for r in peer_rows if r.get("period_end")]
    if not ends:
        return []
    try:
        dmin = date.fromisoformat(min(ends)[:10])
        dmax = date.fromisoformat(max(ends)[:10])
    except ValueError:
        return []
    dates = _quarter_dates(dmin, dmax)
    if not dates:
        return []
    ours = list(query(f"SELECT DISTINCT metric, our_value, unit FROM {VIEW} WHERE our_value IS NOT NULL"))
    # Revenue growth lives outside the vs-us view; add it as an anchor so "Us" also
    # gets a trend line + forecast on that metric.
    growth = _our_revenue_growth()
    if growth is not None and not any(o.get("metric") == "Revenue growth" for o in ours):
        ours.append({"metric": "Revenue growth", "our_value": growth, "unit": "%"})
    out: list[dict] = []
    for o in ours:
        metric = o.get("metric")
        v_now = _num(o.get("our_value"))
        if v_now is None or metric == "Revenue ($B)":
            continue
        vals = _mock_track(metric, v_now, len(dates))
        for d, v in zip(dates, vals):
            out.append({
                "competitor": "Us", "metric": metric, "period_end": d.isoformat(),
                "label": f"Q{(d.month - 1) // 3 + 1} '{d.year % 100:02d}",
                "granularity": "quarterly", "value": v, "unit": o.get("unit") or "",
            })
    return out


@router.get("/competitor-search/trends")
def trends():
    _ensure_setup()
    rows = query(
        f"SELECT competitor, metric, CAST(period_end AS STRING) AS period_end, "
        f"label, granularity, value, unit FROM {TREND} "
        f"ORDER BY competitor, metric, period_end")
    for r in rows:
        r["value"] = _num(r.get("value"))
    rows.extend(_mock_us_series(rows))
    return rows


@router.delete("/competitor-search/competitor/{competitor}")
def remove(competitor: str):
    _ensure_setup()
    competitor = cl.normalize_competitor_name(competitor)
    _exec(f"DELETE FROM {BENCH} WHERE competitor = {_q(competitor)}")
    _exec(f"DELETE FROM {NOTES} WHERE competitor = {_q(competitor)}")
    _exec(f"DELETE FROM {TREND} WHERE competitor = {_q(competitor)}")
    return {"removed": competitor}
