"""Public-filing resolver + metric computation for the company-search benchmark.

Stdlib-only (urllib) on purpose: the app is offline-vendored (see pyproject.toml
`no-index` / `find-links`), so we cannot add httpx/requests wheels. Two free,
public, structured sources are used — no PDF parsing:

- EU-listed companies -> ESEF (inline-XBRL) via filings.xbrl.org. Names resolve
  against a cached in-process index of the whole ESEF filer roster (~7.3k
  entities), so every candidate is a structured filer by construction.
- US-listed companies -> SEC EDGAR XBRL `companyfacts`, resolved by CIK (name ->
  CIK via the EDGAR ticker map, with a browse-edgar fallback that also matches
  FORMER names for renamed issuers).

From either source we compute the same curated metrics the benchmark charts plot
(Revenue, Revenue growth, Gross/Operating/Net margin, DSO/DIO/DPO/CCC) with
concept fallback chains, so IFRS vs US-GAAP tag differences degrade gracefully
(a missing concept simply drops that metric instead of failing the whole run).
Sparse by design: a successful compute emits whatever subset the filing supports.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

class NoStructuredFiling(LookupError):
    """No retrievable structured filing exists for this entity.

    Either the wrong entity was resolved (a subsidiary rather than the listed
    parent) or the filer's reports are not mirrored by the source — the case for
    every German issuer, whose filings go to the Bundesanzeiger.
    """


class UnreadableFiling(LookupError):
    """A structured filing was found and opened, but carries no comparable top line.

    Kept distinct from NoStructuredFiling because the actionable advice is the
    opposite: the entity resolved correctly, so telling the user to look for the
    parent company sends them after something they already have. Banks and
    insurers land here — they report interest and fee income rather than revenue.
    """


# Outbound User-Agent. SEC fair-access policy asks for a contact address;
# CFO_CONTACT_EMAIL supplies it (the bundle sets it to the deploying user).
_CONTACT = os.environ.get("CFO_CONTACT_EMAIL", "").strip()
_UA = f"office-of-cfo-demo/1.0 (contact: {_CONTACT})" if _CONTACT else "office-of-cfo-demo/1.0"

_XBRL = "https://filings.xbrl.org"
_SEC_TICKERS = "https://www.sec.gov/files/company_tickers.json"
_SEC_FACTS = "https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json"

# A bank's statutory top line, aliased under one stable name so the metric chains
# below can treat it like any other concept. Namespaced `synth:` so it can never
# collide with a real reported tag, and so it is greppable as derived.
_BANK_TOPLINE = "synth:BankTopLine"

# Local concept names (namespace stripped) that ARE a bank's statutory top line.
# Banks have no IFRS revenue concept, and their top line — net banking income,
# produit net bancaire — has no IFRS equivalent either, so each filer tags it in
# its own namespace and the prefix differs per issuer.
#
# Every entry here is verified against the filer's own reported total. Do NOT add
# a name on the strength of it sounding like a total: a subtotal aliased onto the
# revenue chain would be benchmarked as though it were revenue, silently. Verify
# with a filing first, then add.
_BANK_TOPLINE_NAMES = {
    "netbankingincome",                  # Société Générale — 27,254m FY2025
    "revenuesfromcontinuingactivities",  # BNP Paribas — 51,223m FY2025
}

# Metric concept fallback chains. First present wins.
_IFRS = {
    "revenue": [
        "ifrs-full:Revenue",
        "ifrs-full:RevenueFromContractsWithCustomers",
        # Banks report total income under this standard concept rather than
        # Revenue (ABN AMRO: 8,716m, matching its reported total operating
        # income). Kept LAST so an ordinary filer still matches Revenue first.
        # NOT a synthetic sum: gross interest revenue is several times the true
        # top line (BNP 71.5bn gross vs 51.2bn reported), so anything summed from
        # interest and fee components would overstate a bank badly.
        "ifrs-full:RevenueAndOperatingIncome",
        # A bank top line carried in the filer's own namespace, aliased here by
        # _alias_bank_topline. Last, so it only applies when nothing standard was
        # reported.
        _BANK_TOPLINE,
    ],
    "gross_profit": ["ifrs-full:GrossProfit"],
    "cogs": ["ifrs-full:CostOfSales"],
    "operating": ["ifrs-full:ProfitLossFromOperatingActivities"],
    "net": ["ifrs-full:ProfitLoss"],
    "inventory": ["ifrs-full:Inventories"],
    "receivables": [
        "ifrs-full:TradeAndOtherCurrentReceivables",
        "ifrs-full:CurrentTradeReceivables",
        "ifrs-full:TradeAndOtherReceivables",
    ],
    "payables": [
        "ifrs-full:TradeAndOtherCurrentPayables",
        "ifrs-full:CurrentTradePayables",
        "ifrs-full:TradeAndOtherPayables",
    ],
}
_USGAAP = {
    "revenue": [
        "RevenueFromContractWithCustomerExcludingAssessedTax",
        "Revenues",
        "RevenueFromContractWithCustomerIncludingAssessedTax",
        "SalesRevenueNet",
        # Banks / broker-dealers report top-line as net revenues (e.g. Goldman
        # Sachs). Kept LAST so ordinary filers still match a standard tag first.
        "RevenuesNetOfInterestExpense",
    ],
    "gross_profit": ["GrossProfit"],
    "cogs": ["CostOfGoodsAndServicesSold", "CostOfRevenue", "CostOfGoodsSold"],
    "operating": ["OperatingIncomeLoss"],
    "net": ["NetIncomeLoss", "ProfitLoss"],
    "inventory": ["InventoryNet"],
    "receivables": ["AccountsReceivableNetCurrent"],
    "payables": ["AccountsPayableCurrent", "AccountsPayableTradeCurrent"],
}


def _chains_for(series: dict[str, dict[str, float]]) -> dict[str, list[str]]:
    """The metric chains matching the taxonomy a series is tagged in.

    Every caller that asks "is a revenue line present here?" resolves the chain
    through this, so the readability gate in `_esef_compute` and the rows it guards
    cannot disagree about where revenue comes from. They previously did: the gate
    hardcoded `_IFRS["revenue"]` (which carries `_BANK_TOPLINE`) while the rows
    picked the chain by taxonomy, so a filer tagging no `ifrs-full:` concept at all
    read `_USGAAP["revenue"]`, which does not — passing the gate and then emitting
    zero metrics, an empty result that looked like success.
    """
    return _IFRS if any(c.startswith("ifrs-full:") for c in series) else _USGAAP


_CCY_SYMBOL = {"USD": "$", "EUR": "\u20ac", "GBP": "\u00a3", "CHF": "CHF ", "JPY": "\u00a5"}

# Catalog semantics version. Bump when metric names, formulas, or chartability
# change so Delta cache rows written under an older version are treated as a miss
# and recomputed. Independent of the filing TTL.
METRIC_SCHEMA_VERSION = 1

# Single source of truth for benchmark metric metadata. Charts and the compare
# matrix read this (via /metric-catalog) instead of hardcoding names. `chartable`
# is false for absolute scale metrics that should not appear on trend/rank plots.
METRIC_REGISTRY: dict[str, dict] = {
    "Revenue ($B)":     {"unit": "currencyB", "better": "neutral", "chartable": False},
    "Revenue growth":   {"unit": "%",         "better": "high",    "chartable": True},
    "Gross margin":     {"unit": "%",         "better": "high",    "chartable": True},
    "Operating margin": {"unit": "%",         "better": "high",    "chartable": True},
    "Net margin":       {"unit": "%",         "better": "high",    "chartable": True},
    "DSO":              {"unit": "days",      "better": "low",     "chartable": True},
    "DIO":              {"unit": "days",      "better": "low",     "chartable": True},
    "DPO":              {"unit": "days",      "better": "high",    "chartable": True},
    "CCC":              {"unit": "days",      "better": "low",     "chartable": True},
}


def metric_catalog() -> dict:
    """Public shape for GET /competitor-search/metric-catalog."""
    return {
        "metric_schema": METRIC_SCHEMA_VERSION,
        "metrics": [
            {"name": name, **meta}
            for name, meta in METRIC_REGISTRY.items()
        ],
    }


def normalize_competitor_name(name: str) -> str:
    """Cache / write key: trim and collapse internal whitespace. Display names stay
    as resolved by the filer; this only keeps 'KBC ' and 'KBC' on the same row."""
    return " ".join((name or "").split())


# There is deliberately NO curated LEI pin list here any more. The previous one
# (29 entries) existed to paper over the GLEIF resolver: it hard-coded the answer
# for every marquee demo name because the general search could not find them.
# With the filer index plus token ranking, all 29 resolve to the same entity from
# the index alone (measured), so the list was pure duplicated state that would
# silently rot as LEIs and legal names change. Brand-name and rename cases that no
# legal-name index can resolve live in `_QUERY_ALIASES` instead.

# ---------------------------------------------------------------------------
# HTTP (stdlib)
# ---------------------------------------------------------------------------
class SourceUnavailable(Exception):
    """A public source could not be reached and no cached copy is available.

    Distinguishes "the search backend is down" from "no such company", which the
    caller surfaces differently — an empty dropdown that means the latter when it
    was really the former is the single most confusing failure this module had.
    """


def _get_json(url: str, timeout: float = 20.0) -> dict:
    req = urllib.request.Request(
        url, headers={"User-Agent": _UA, "Accept": "application/json, application/vnd.api+json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 (trusted hosts)
        return json.loads(resp.read().decode("utf-8"))


# ---------------------------------------------------------------------------
# Name normalization
# ---------------------------------------------------------------------------
# Letters that carry a stroke/ligature rather than a combining accent, so NFKD
# leaves them intact (Ørsted, Æ-names). Folded explicitly so a query typed with
# or without the diacritic matches the same filer.
_FOLD = str.maketrans({
    "ø": "o", "Ø": "o", "æ": "ae", "Æ": "ae", "œ": "oe", "Œ": "oe",
    "ß": "ss", "ł": "l", "Ł": "l", "đ": "d", "Đ": "d", "ð": "d", "Ð": "d",
    "þ": "th", "Þ": "th", "ı": "i",
})


def _norm(s: str) -> str:
    """Accent-fold, lowercase, and collapse runs of non-alphanumerics to single
    spaces, so punctuation and diacritic differences don't block a name match
    ('Colgate-Palmolive' vs 'COLGATE PALMOLIVE CO', 'Nestlé' vs 'Nestle',
    'L'Oréal' vs 'LOREAL'). Accent folding matters for the EU filer set, where
    the registered name and the name a user types often differ only by accent."""
    folded = unicodedata.normalize("NFKD", s.translate(_FOLD))
    ascii_only = "".join(c for c in folded if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", " ", ascii_only.lower()).strip()


def _tokens(s: str) -> tuple[str, ...]:
    return tuple(_norm(s).split())


# Name fragments that mark a financing / structural vehicle rather than the
# listed operating group. Used only as a LATE tie-break, never to reject: the
# ESEF filer set legitimately contains both "NESTLE HOLDINGS, INC." (a financing
# subsidiary with no group revenue) and parents whose real name includes one of
# these words (e.g. "ASML Holding N.V."), so demoting must not exclude.
_STRUCTURAL_TOKENS = {
    # "bank" is here rather than in the geographic set: a name that adds "Bank"
    # beyond the query is usually the banking arm of a listed group ("BARCLAYS
    # BANK PLC" under Barclays PLC). Querying a
    # name that legitimately contains it ("Deutsche Bank") is unaffected, since
    # only tokens ABSENT from the query are considered.
    "bank", "holdings", "finance", "financing", "treasury", "trust", "pension",
    "pensions", "pensionskasse", "capital", "funding", "investments", "insurance",
    "reinsurance", "coordination", "leasing",
    # Pooled-vehicle and shell markers. The SEC ticker map is full of these under
    # a parent's brand ("Goldman Sachs BDC, Inc.", "Total Return Securities
    # Fund"), and they are never the operating group a CFO wants to benchmark.
    "bdc", "fund", "funds", "etf", "sicav", "ucits", "acquisition",
}

# Geographic qualifiers, which mark a national operating subsidiary rather than
# the group ("UniCredit Bank Austria AG" vs the Italian parent). Demotion only
# ever considers tokens NOT present in the query, so searching for a name that
# genuinely contains one of these ("Santander UK", "Naturgy Iberia") is unaffected.
_GEO_TOKENS = {
    "africa", "america", "americas", "asia", "atlantic",
    "austria", "belgium", "belgique", "belux", "benelux", "brazil", "bulgaria",
    "canada", "caribbean", "chile", "china", "colombia", "croatia", "cyprus",
    "czech", "denmark", "deutschland", "espana", "estonia", "europe", "finland",
    "france", "germany", "greece", "hungary", "iberia", "india", "indonesia",
    "ireland", "italia", "italy", "japan", "latvia", "lithuania", "luxembourg",
    "magreb", "maghreb", "malta", "mexico", "nederland", "netherlands", "nordic",
    "norway", "pacific", "peru", "poland", "polska", "portugal", "romania",
    "russia", "schweiz", "serbia", "slovakia", "slovenia", "spain", "suisse",
    "sverige", "sweden", "switzerland", "turkey", "ukraine", "usa",
}


# ---------------------------------------------------------------------------
# ESEF filer index (filings.xbrl.org)
# ---------------------------------------------------------------------------
# The entire ESEF filer universe is ~7.3k entities: 4 requests, ~3s, and every
# entry is a structured filer BY CONSTRUCTION. This replaces the previous
# approach of name-searching GLEIF's ~2.8M LEIs and then probing each candidate
# to ask "do you file ESEF?".
#
# GLEIF was never a search engine: `filter[entity.legalName]` returns an
# arbitrary UNRANKED slice capped by page[size], out of hundreds or thousands of
# same-brand entities, so the listed parent was usually absent from the response
# entirely (Allianz: 15 of 1,746; Henkel: 15 of 126 — parent in neither). No
# amount of client-side ranking could recover a parent that was never returned.
_XBRL_ENTITIES = f"{_XBRL}/api/entities"
_ESEF_PAGE_SIZE = 2000
_ESEF_MAX_PAGES = 12  # ~7.3k entities today; headroom as the registry grows
_ESEF_INDEX_TTL = 24 * 3600

_esef_index: list[dict] | None = None
_esef_index_built_at = 0.0
_esef_index_lock = threading.Lock()


def _fetch_esef_index() -> list[dict]:
    """Page the whole filer roster. `identifier` is the LEI for EU filers and a
    local registry code for a few others (e.g. Ukrainian EDRPOU); either way it
    is the key /api/entities/{id}/filings expects, so it is used verbatim."""
    out: list[dict] = []
    seen: set[str] = set()
    for page in range(1, _ESEF_MAX_PAGES + 1):
        data = _get_json(
            f"{_XBRL_ENTITIES}?page%5Bsize%5D={_ESEF_PAGE_SIZE}&page%5Bnumber%5D={page}",
            timeout=30.0,
        ).get("data", [])
        if not data:
            break
        for row in data:
            attrs = row.get("attributes") or {}
            nm = (attrs.get("name") or "").strip()
            ident = (attrs.get("identifier") or "").strip()
            if not nm or not ident or ident in seen:
                continue
            seen.add(ident)
            out.append({"name": nm, "key": ident, "tokens": _tokens(nm)})
    return out


def _esef_filers() -> list[dict]:
    """The cached filer index. Rebuilt past the TTL; on a rebuild failure the
    STALE index keeps serving (a transient outage must not empty the dropdown).
    Raises SourceUnavailable only when there is nothing cached to fall back to."""
    global _esef_index, _esef_index_built_at
    with _esef_index_lock:
        fresh = (_esef_index is not None
                 and (time.monotonic() - _esef_index_built_at) < _ESEF_INDEX_TTL)
        if fresh:
            return _esef_index  # type: ignore[return-value]
        try:
            built = _fetch_esef_index()
        except Exception as e:  # noqa: BLE001
            if _esef_index is not None:
                return _esef_index
            raise SourceUnavailable(f"ESEF filer index unavailable: {e}") from e
        if built:
            _esef_index, _esef_index_built_at = built, time.monotonic()
        elif _esef_index is None:
            raise SourceUnavailable("ESEF filer index came back empty.")
        return _esef_index or []


# Being in the entity roster does NOT guarantee a retrievable filing: entities can
# be registered with zero filings hosted here. That is not an edge case — EVERY
# German issuer is in this state (Henkel, Allianz, Siemens, Beiersdorf, Deutsche
# Bank all return zero), because DE filings go to the Bundesanzeiger and are not
# mirrored publicly. Offering such a candidate guarantees a "Couldn't analyze"
# failure downstream, so the roster is filtered by a per-candidate check.
#
# The same request also yields `country`, which the entities endpoint lacks and
# the filings collection is far too slow to bulk-fetch (a single 2000-row page
# does not return within minutes).
#
# This is deliberately NOT the old `_esef_has_filing` gate. The distinction:
#   - HTTP 200 with zero filings  -> definitive "cannot analyze", drop + cache.
#   - Timeout / network error      -> UNKNOWN, keep the candidate, cache nothing.
# The old version collapsed both into False and cached it forever, so one slow
# response hid a company until the process restarted.
_ESEF_VERIFY_TTL = 6 * 3600
# Budget for ONE probe, and with a single batch (see _verify_esef) the cap on how
# long a cold typed query can block. Measured against filings.xbrl.org: ten
# consecutive probes took 0.17-0.34s (median 0.21s), so 3s is ~14x the median —
# comfortably above a slow-but-working response, and low enough that a genuinely
# stuck request costs one wait rather than the 8s it used to.
_ESEF_VERIFY_TIMEOUT = 3.0
_esef_verify_cache: dict[str, tuple[float, bool, str]] = {}
_esef_verify_lock = threading.Lock()


def _esef_verify(key: str) -> tuple[bool | None, str]:
    """(has_filing, country) for a roster entity. has_filing is None on an
    inconclusive probe, which callers must treat as "keep", never as "drop".

    The predicate is "has a filing carrying a `json_url`", which is exactly what
    `_esef_compute` requires, so a candidate offered in the dropdown is one the
    analysis can actually open. Same page size as `_esef_compute` for the same
    reason — a filer whose newest filing lacks structured JSON may still have an
    older one that has it."""
    with _esef_verify_lock:
        hit = _esef_verify_cache.get(key)
        if hit and (time.monotonic() - hit[0]) < _ESEF_VERIFY_TTL:
            return hit[1], hit[2]
    try:
        data = _get_json(
            f"{_XBRL}/api/entities/{urllib.parse.quote(key)}/filings?page%5Bsize%5D=20",
            timeout=_ESEF_VERIFY_TIMEOUT,
        ).get("data", [])
    except Exception:  # noqa: BLE001 — inconclusive, NOT negative. Cache nothing.
        return None, ""
    attrs = [f.get("attributes") or {} for f in data]
    has = any(a.get("json_url") for a in attrs)
    country = next((str(a.get("country")).strip() for a in attrs if a.get("country")), "")
    with _esef_verify_lock:
        _esef_verify_cache[key] = (time.monotonic(), has, country)
    return has, country


def _verify_esef(scored: list[tuple[tuple, dict]]) -> tuple[list[tuple[tuple, dict]], list[dict]]:
    """Drop ESEF candidates confirmed to have no retrievable filing, and fill in
    `country` for the survivors. Returns (kept, dropped) as scored pairs, so the
    caller can tell whether the BEST match is the one that went missing."""
    todo = [c for _s, c in scored if c.get("source") == "ESEF"]
    if not todo:
        return scored, []
    # One worker per candidate: these are I/O-bound probes and a typed query is
    # blocked on all of them, so the old cap of 8 split a full candidate list into
    # two serial rounds and doubled the worst-case wait for nothing.
    with ThreadPoolExecutor(max_workers=len(todo)) as ex:
        verdicts = dict(zip((c["key"] for c in todo),
                            ex.map(lambda c: _esef_verify(c["key"]), todo)))
    kept: list[tuple[tuple, dict]] = []
    dropped: list[dict] = []
    for s, c in scored:
        if c.get("source") != "ESEF":
            kept.append((s, c))
            continue
        has, country = verdicts.get(c["key"], (None, ""))
        if has is False:
            dropped.append({**c, "_score": s})
            continue
        if country:
            c["country"] = country
        kept.append((s, c))
    return kept, dropped


# ---------------------------------------------------------------------------
# SEC ticker map (name/ticker -> CIK), cached once.
# ---------------------------------------------------------------------------
_tickers: list[dict] | None = None
_tickers_lock = threading.Lock()


def _sec_tickers() -> list[dict]:
    global _tickers
    if _tickers is None:
        with _tickers_lock:
            if _tickers is None:
                raw = _get_json(_SEC_TICKERS)
                # {"0": {"cik_str":..,"ticker":..,"title":..}, ...}
                _tickers = list(raw.values()) if isinstance(raw, dict) else []
    return _tickers


# ---------------------------------------------------------------------------
# EDGAR company search — the only source that matches FORMER names.
# ---------------------------------------------------------------------------
# company_tickers.json carries current names only, so a renamed issuer is
# unreachable by its old name ("RITCHIE BROS" -> nothing, though the entity is
# now "RB GLOBAL INC."). browse-edgar matches former names server-side, but it
# rate-limits aggressively (503 after ~6 rapid calls), so this runs ONLY when the
# local indexes find nothing, and every verdict is cached.
_EDGAR_BROWSE = "https://www.sec.gov/cgi-bin/browse-edgar"
_EDGAR_MIN_QUERY_LEN = 4
_EDGAR_MIN_SPACING = 0.4
_EDGAR_POS_TTL = 24 * 3600
_EDGAR_NEG_TTL = 3600

_edgar_name_cache: dict[str, tuple[float, list[tuple[str, str]]]] = {}
_edgar_browse_lock = threading.Lock()
_edgar_last_call = 0.0


def _parse_browse_atom(body: str) -> list[tuple[str, str]]:
    """[(name, cik)] from a browse-edgar atom feed, in feed order. `name` is empty
    when the feed carries none.

    browse-edgar answers a company-name query with two different documents, and
    only one of them names the companies:

    - ONE match  -> that company's filing list, carrying a single `<company-info>`
      with `<conformed-name>` and `<cik>`.
    - MANY match -> one `<entry>` per company, each with a `<cik>` but NO
      `<conformed-name>`; SEC leaks a Perl array reference into the name slots
      instead (`<entry title="ARRAY(0x55bd5dd22528)">`,
      `<company-info name="ARRAY(0x...)">`), so the name is not recoverable from
      this document at all — the caller resolves it from the cached ticker map.

    `<cik>` appears exactly once per company in BOTH shapes, which is why it is the
    anchor here. Pairing names with the `CIK=` query parameters instead — as this
    did — counts every filing link on a single-match page, so the two lists have
    different lengths and `zip` silently truncated a multi-company feed to nothing.
    """
    ciks = [str(int(c)) for c in re.findall(r"<cik>\s*(\d{1,10})\s*</cik>", body, re.I)]
    names = [n.strip() for n in
             re.findall(r"<conformed-name>(.*?)</conformed-name>", body, re.I | re.S)]
    # Zip only on a one-name-per-company document; anything else is name-less.
    if len(names) == len(ciks):
        return list(zip(names, ciks, strict=True))
    return [("", c) for c in ciks]


def _sec_titles_for_ciks(ciks: set[str]) -> dict[str, str]:
    """{cik: current legal name} from the cached ticker map, for feed entries that
    carry no name.

    The map is keyed on the CURRENT name, which is exactly what a former-name
    search needs to display: the user typed the old name, and the entity is only
    reachable here because the local indexes — this map included — did not match it.
    """
    out: dict[str, str] = {}
    if not ciks:
        return out
    try:
        for t in _sec_tickers():
            cik = str(t.get("cik_str") or "")
            if cik in ciks and t.get("title"):
                out[cik] = str(t["title"])
    except Exception:  # noqa: BLE001 — an unnamed hit is dropped by the caller
        pass
    return out


def _edgar_search_by_name(query: str) -> list[tuple[str, str]]:
    """[(name, cik)] for a company-name query, matching former names.

    The query MUST be punctuation-stripped: 'RITCHIE BROS.' with the trailing
    period returns nothing where 'RITCHIE BROS' resolves to RB GLOBAL INC.

    The name is the feed's `conformed-name` where it has one and the ticker map's
    current name otherwise (see _parse_browse_atom): a query matching several
    companies gets a document with no names in it. An entity in neither — a dead
    registrant with no current listing, e.g. every 'monsanto' or 'sears' match — is
    dropped, since there is nothing to label the row with and nothing to benchmark.
    """
    global _edgar_last_call
    nq = _norm(query)
    if len(nq) < _EDGAR_MIN_QUERY_LEN:
        return []
    now = time.monotonic()
    cached = _edgar_name_cache.get(nq)
    if cached is not None:
        stamp, hits = cached
        ttl = _EDGAR_POS_TTL if hits else _EDGAR_NEG_TTL
        if now - stamp < ttl:
            return hits
    # Single in-flight, minimum spacing: browse-edgar 503s under bursts.
    with _edgar_browse_lock:
        gap = time.monotonic() - _edgar_last_call
        if gap < _EDGAR_MIN_SPACING:
            time.sleep(_EDGAR_MIN_SPACING - gap)
        hits: list[tuple[str, str]] = []
        try:
            url = (f"{_EDGAR_BROWSE}?action=getcompany"
                   f"&company={urllib.parse.quote(nq)}"
                   f"&type=10-K&dateb=&owner=include&count=10&output=atom")
            req = urllib.request.Request(url, headers={"User-Agent": _UA,
                                                      "Accept": "application/atom+xml"})
            with urllib.request.urlopen(req, timeout=12.0) as resp:  # noqa: S310
                body = resp.read().decode("utf-8", errors="replace")
            pairs = _parse_browse_atom(body)
            titles = _sec_titles_for_ciks({c for nm, c in pairs if not nm})
            for nm, cik in pairs:
                nm = nm or titles.get(cik, "")
                if nm:  # unnamed and unknown to the ticker map: nothing to show
                    hits.append((nm, cik))
        except Exception:  # noqa: BLE001 — treat as "no former-name match"
            hits = []
        finally:
            _edgar_last_call = time.monotonic()
        _edgar_name_cache[nq] = (time.monotonic(), hits)
        return hits


# ---------------------------------------------------------------------------
# Query aliases and known-absent filers
# ---------------------------------------------------------------------------
# Brand / colloquial / former names that no legal-name index will ever contain.
# Keys are normalized queries; the value is searched instead.
_QUERY_ALIASES: dict[str, str] = {
    "google": "Alphabet",
    "facebook": "Meta Platforms",
    "fb": "Meta Platforms",
    "p g": "Procter & Gamble",          # _norm("P&G") == "p g"
    "pg": "Procter & Gamble",
    "ritchie bros": "RB Global",
    "ritchie brothers": "RB Global",
    "ritchie bros auctioneers": "RB Global",
    "square": "Block Inc",
    # "Total" alone matches dozens of funds and never TotalEnergies, whose only
    # token is the merged "totalenergies".
    "total": "TotalEnergies",
    "total energies": "TotalEnergies",
    "ab inbev": "Anheuser-Busch InBev",
    "abinbev": "Anheuser-Busch InBev",
    "inbev": "Anheuser-Busch InBev",
    "jpmorgan": "JPMorgan Chase",
    "j p morgan": "JPMorgan Chase",
}

# Companies a CFO would plausibly benchmark that have NO public structured
# filing on either source, so the page can say why instead of showing an empty
# dropdown (or, worse, an unrelated near-name match). Verified absent from the
# ESEF filer roster and from SEC XBRL companyfacts.
_KNOWN_NO_FILING: dict[str, str] = {
    "nestle": "Nestlé S.A. is Swiss-listed and files neither ESEF nor SEC XBRL, "
              "so no structured financials are available.",
    "nestle sa": "Nestlé S.A. is Swiss-listed and files neither ESEF nor SEC XBRL, "
                 "so no structured financials are available.",
    "roche": "Roche Holding AG is Swiss-listed and files neither ESEF nor SEC XBRL, "
             "so no structured financials are available.",
    "roche holding": "Roche Holding AG is Swiss-listed and files neither ESEF nor "
                     "SEC XBRL, so no structured financials are available.",
    "e on": "E.ON SE publishes no usable public structured filing (absent from the "
            "ESEF roster, and its US listing has no XBRL companyfacts).",
    "eon": "E.ON SE publishes no usable public structured filing (absent from the "
           "ESEF roster, and its US listing has no XBRL companyfacts).",
    "edf": "EDF publishes no usable public structured filing (absent from the ESEF "
           "roster since its delisting).",
    "electricite de france": "EDF publishes no usable public structured filing "
                             "(absent from the ESEF roster since its delisting).",
    "rwe": "RWE AG publishes no usable public structured filing (absent from the "
           "ESEF roster).",
}


# ---------------------------------------------------------------------------
# Search — returns autocomplete candidates from both sources.
# ---------------------------------------------------------------------------
# Match quality on normalized TOKEN sequences. Interior substring matches are
# rejected outright: the old raw `in` test made _norm("P&G") == "p g" a substring
# of "bhp group ltd", so "P&G" returned BHP Group, "RWE" returned DERWENT LONDON
# and "EDF" returned a Virtus bond fund.
_RANK_EXACT, _RANK_PREFIX, _RANK_TOKENS = 0, 1, 2
# A ticker match is precise but ranks BELOW any name match: tickers collide with
# unrelated companies ("UCB" is United Community Banks on the SEC, not the Belgian
# pharma), and for a cross-listed EU issuer the ticker points at the US ADR while
# the name points at the fuller home ESEF filing ("ASML").
_RANK_TICKER = 3


def _match_rank(qt: tuple[str, ...], nt: tuple[str, ...]) -> int | None:
    """Rank of a name against a query, or None when it doesn't match at all."""
    if not qt or not nt:
        return None
    if qt == nt:
        return _RANK_EXACT
    if nt[:len(qt)] == qt:
        return _RANK_PREFIX
    name_set = set(nt)
    if all(t in name_set for t in qt):
        return _RANK_TOKENS
    return None


def _score(qt: tuple[str, ...], nt: tuple[str, ...], source: str,
           ticker_hit: bool = False, name_len: int = 0) -> tuple | None:
    """Sort key for a candidate; None when it should not be offered at all.

    Ordered by (match quality, structural demotion, source, extra tokens):

    - match quality first, so an exact ticker or name beats a partial one;
    - then a structural/geographic demotion, so a group parent outranks its
      financing arm or a national subsidiary;
    - then ESEF ahead of EDGAR. Source outranks token count deliberately: an EU
      company's home ESEF filing should never be shadowed by its US ADR, and
      counting tokens picks the ADR by accident because punctuation splits the
      registered name into more tokens ("ASML Holding N.V." -> n, v) than the
      SEC's spelling ("ASML HOLDING NV" -> nv);
    - then how much of the name is extra beyond the query, and finally the raw
      name length, which both encodes "the listed parent has the tersest legal
      name" and makes the ordering deterministic instead of dependent on roster
      iteration order.
    """
    src_rank = 0 if source == "ESEF" else 1
    rank = _match_rank(qt, nt)
    if rank is None:
        if not ticker_hit:
            return None
        rank = _RANK_TICKER  # ticker hits only ever come from EDGAR
    elif ticker_hit:
        rank = min(rank, _RANK_TICKER)
    extra = set(nt) - set(qt)
    demote = 1 if extra & (_STRUCTURAL_TOKENS | _GEO_TOKENS) else 0
    return (rank, demote, src_rank, max(0, len(nt) - len(qt)), name_len)


def _resolve_query(name: str) -> str:
    """Apply the brand/former-name alias map to a raw query."""
    return _QUERY_ALIASES.get(_norm(name), (name or "").strip())


def search_companies(name: str, limit: int = 8) -> list[dict]:
    """Autocomplete candidates for a company name. Never raises for a single
    source being down; see `search_with_status` for the degraded-source detail."""
    return search_with_status(name, limit)["candidates"]


def search_with_status(name: str, limit: int = 8) -> dict:
    """Candidates plus which sources were degraded and any explanatory notice.

    Returns {"candidates": [...], "degraded": ["ESEF", ...], "notice": str|None}.
    A caller can then tell "we couldn't reach the filing sources" apart from
    "that company has no structured filing" apart from "no such company".
    """
    raw = (name or "").strip()
    if len(raw) < 2:
        return {"candidates": [], "degraded": [], "notice": None}

    # A known-absent filer is answered directly. Offering near-name matches here
    # is actively misleading — searching "Roche" must not hand back ROCHE BOBOIS,
    # a furniture retailer that happens to file ESEF.
    known = _KNOWN_NO_FILING.get(_norm(raw))
    if known:
        return {"candidates": [], "degraded": [], "notice": known}

    q = _resolve_query(raw)
    qt = _tokens(q)
    notice: str | None = None
    degraded: list[str] = []
    scored: list[tuple[tuple, dict]] = []
    seen: set[str] = set()

    # EU / ESEF: token match against the cached filer roster, in process. The
    # roster build and the per-candidate filing probe below DO use the network
    # (both cached, and the probe is bounded by _ESEF_VERIFY_TIMEOUT) — what is
    # gone is the per-keystroke *search request* the GLEIF resolver issued, which
    # is what used to rate-limit autocomplete against itself.
    try:
        for ent in _esef_filers():
            key = f"esef:{ent['key']}"
            if key in seen:
                continue
            s = _score(qt, ent["tokens"], "ESEF", name_len=len(ent["name"]))
            if s is None:
                continue
            seen.add(key)
            scored.append((s, {"name": ent["name"], "source": "ESEF",
                               "key": ent["key"], "country": "",
                               "detail": "ESEF (EU)"}))
    except SourceUnavailable:
        degraded.append("ESEF")

    # US / EDGAR: token match on the cached ticker map, plus an exact ticker hit.
    try:
        ql = _norm(q)
        for t in _sec_tickers():
            title = str(t.get("title", ""))
            ticker = str(t.get("ticker", ""))
            if not title:
                continue
            key = f"edgar:{t.get('cik_str')}"
            if key in seen:
                continue
            s = _score(qt, _tokens(title), "EDGAR",
                       ticker_hit=bool(ticker) and ql == _norm(ticker),
                       name_len=len(title))
            if s is None:
                continue
            seen.add(key)
            scored.append((s, {"name": title.title() if title.isupper() else title,
                               "source": "EDGAR", "key": str(t.get("cik_str")),
                               "country": "US", "ticker": ticker,
                               "detail": "EDGAR (US)"}))
    except Exception:  # noqa: BLE001
        degraded.append("EDGAR")

    # Nothing local matched: the name may belong to a renamed issuer, which only
    # browse-edgar can resolve. Rate-limited and cached — see _edgar_search_by_name.
    if not scored:
        for nm, cik in _edgar_search_by_name(q)[:3]:
            key = f"edgar:{cik}"
            if key in seen:
                continue
            seen.add(key)
            scored.append(((_RANK_PREFIX, 0, 1, 0, len(nm)),
                           {"name": nm.title() if nm.isupper() else nm,
                            "source": "EDGAR", "key": cik, "country": "US",
                            "detail": "EDGAR (US, former name)"}))

    scored.sort(key=lambda pair: pair[0])
    # Verify a small surplus so that dropping unfilable roster entries still
    # leaves a full page of candidates.
    kept, dropped = _verify_esef(scored[:limit + 6])
    candidates = [c for _s, c in kept][:limit]

    if not candidates and degraded:
        notice = ("Couldn't reach the public filing sources ("
                  + ", ".join(degraded) + "). This is a source outage, not a "
                  "missing company — try again shortly.")
    elif dropped:
        # Say so when the company the user most likely meant is the one that has
        # no readable filing: either nothing survived, or every surviving ESEF
        # match is a strictly worse match than what was dropped (so the leftovers
        # are same-brand noise), or only a US ADR of a different entity remains.
        best_dropped = min(d["_score"] for d in dropped)
        esef_survivors = [s for s, c in kept if c.get("source") == "ESEF"]
        if not candidates or not esef_survivors or best_dropped < min(esef_survivors):
            name = min(dropped, key=lambda d: d["_score"])["name"]
            notice = (f"{name} is listed in the ESEF register but publishes no filing "
                      "that can be read programmatically, so no structured financials "
                      "are available. German issuers file to the Bundesanzeiger, which "
                      "is not mirrored publicly.")
    return {"candidates": candidates, "degraded": degraded, "notice": notice}


# ---------------------------------------------------------------------------
# Metric computation from a normalized concept series.
# ---------------------------------------------------------------------------
def _pick(series: dict[str, dict[str, float]], chain: list[str], key: str):
    for c in chain:
        s = series.get(c)
        if s and key in s:
            return s[key]
    return None


def _r(v, nd=1):
    return round(float(v), nd)


def _fy_label(end_key: str) -> str:
    """Fiscal-year label from a period-end date. ESEF encodes a Dec-31 close as the
    following midnight (2026-01-01), so subtract a day before taking the year."""
    try:
        return f"FY{(date.fromisoformat(end_key) - timedelta(days=1)).year}"
    except ValueError:
        return "FY" + (end_key[:4] or "")


def _metrics_at(series, chains, cur_key, prev_key, days, sym) -> list[dict]:
    """Curated benchmark metrics for one period — sparse by design.

    Only metrics whose inputs are present are emitted; a missing concept drops
    that ratio instead of failing the whole compute. `days` scales the
    working-capital ratios to the period length (365 for a fiscal year, ~91 for
    a quarter); `prev_key` is the comparison period for revenue growth (prior
    year / same quarter last year).
    """
    rev = _pick(series, chains["revenue"], cur_key)
    rev_prev = _pick(series, chains["revenue"], prev_key) if prev_key else None
    gp = _pick(series, chains["gross_profit"], cur_key)
    cogs = _pick(series, chains["cogs"], cur_key)
    op = _pick(series, chains["operating"], cur_key)
    net = _pick(series, chains["net"], cur_key)
    inv = _pick(series, chains["inventory"], cur_key)
    ar = _pick(series, chains["receivables"], cur_key)
    ap = _pick(series, chains["payables"], cur_key)

    # Derive the missing half of the gross-profit / COGS pair when possible.
    if gp is None and rev is not None and cogs is not None:
        gp = rev - cogs
    if cogs is None and rev is not None and gp is not None:
        cogs = rev - gp

    rows: list[dict] = []

    def add(metric, value, unit):
        if value is not None:
            rows.append({"metric": metric, "their_value": _r(value, 2 if unit.endswith("B") else 1),
                         "unit": unit})

    if rev:
        add("Revenue ($B)", rev / 1e9, f"{sym}B")
    if rev and rev_prev:
        add("Revenue growth", (rev / rev_prev - 1) * 100, "%")
    if gp is not None and rev:
        add("Gross margin", gp / rev * 100, "%")
    if op is not None and rev:
        add("Operating margin", op / rev * 100, "%")
    if net is not None and rev:
        add("Net margin", net / rev * 100, "%")
    dso = ar / rev * days if (ar is not None and rev) else None
    dio = inv / cogs * days if (inv is not None and cogs) else None
    dpo = ap / cogs * days if (ap is not None and cogs) else None
    add("DSO", dso, "days")
    add("DIO", dio, "days")
    add("DPO", dpo, "days")
    if dso is not None and dio is not None and dpo is not None:
        add("CCC", dso + dio - dpo, "days")
    return rows


def _rows_from_series(series, currency, cur_key, prev_key) -> list[dict]:
    chains = _chains_for(series)
    sym = _CCY_SYMBOL.get(currency, f"{currency} ")
    return _metrics_at(series, chains, cur_key, prev_key, 365, sym)


def _period_label(end_key: str, granularity: str) -> str:
    """Display label for a trend point: `FY2023` for annual, `Q3 '24` for quarterly."""
    if granularity == "annual":
        return _fy_label(end_key)
    try:
        d = date.fromisoformat(end_key)
    except ValueError:
        return end_key[:7]
    return f"Q{(d.month - 1) // 3 + 1} '{d.year % 100:02d}"


def _yoy_prior(rev_ends: list[str], i: int, granularity: str) -> str | None:
    """The comparison period-end for revenue growth: the preceding fiscal year for
    annual series, or the closest end ~1 year earlier for quarterly (same quarter,
    prior year)."""
    if granularity == "annual":
        return rev_ends[i - 1] if i > 0 else None
    try:
        d1 = date.fromisoformat(rev_ends[i])
    except ValueError:
        return None
    best, best_diff = None, None
    for e in rev_ends:
        try:
            diff = (d1 - date.fromisoformat(e)).days
        except ValueError:
            continue
        if 330 <= diff <= 400 and (best_diff is None or abs(diff - 365) < abs(best_diff - 365)):
            best, best_diff = e, diff
    return best


def _trend_from_series(series, currency, granularity, max_periods=None) -> list[dict]:
    """A multi-period trend: the metrics computed at every revenue period-end in the
    series, in date order. Emits flat rows carrying the period_end date, a display
    label, and the granularity so the frontend can plot mixed-cadence peers on one
    continuous time axis."""
    chains = _chains_for(series)
    sym = _CCY_SYMBOL.get(currency, f"{currency} ")
    days = 91 if granularity == "quarterly" else 365
    rev_ends = sorted({k for c in chains["revenue"] if c in series for k in series[c]})
    if max_periods:
        rev_ends = rev_ends[-max_periods:]
    out: list[dict] = []
    for i, end in enumerate(rev_ends):
        prev = _yoy_prior(rev_ends, i, granularity)
        label = _period_label(end, granularity)
        for m in _metrics_at(series, chains, end, prev, days, sym):
            out.append({"metric": m["metric"], "period_end": end, "label": label,
                        "granularity": granularity, "value": m["their_value"], "unit": m["unit"]})
    return out


# ---------------------------------------------------------------------------
# ESEF (filings.xbrl.org) — resolve newest filing for an LEI + compute.
# ---------------------------------------------------------------------------
# Standard taxonomy namespaces whose axes carry breakdowns (segments, geography)
# we must NOT fold into a total. Anything else is treated as a filer extension.
_STD_AXIS_NS = {"ifrs-full", "us-gaap"}


def _is_income_extension_axis(axis: str) -> bool:
    """True for a filer's own income-statement extension axis — the pattern where
    the group P&L is split into total/adjusting members instead of reported as a
    bare non-dimensional total (e.g. Centrica's cna:GroupIncomeStatementAxis).
    Standard IFRS/US-GAAP breakdown axes return False so a segment or geography
    split is never mistaken for a total/components decomposition."""
    ns = axis.split(":", 1)[0]
    return ns not in _STD_AXIS_NS or "IncomeStatement" in axis


def _axis_total(vals: list[float]) -> float | None:
    """The aggregate member of a total+components axis: the single value equal to
    the sum of the others (within 0.5%). Returns None when the members don't form
    a clean total/components decomposition (no match, or an ambiguous one), so a
    pure breakdown is left unread instead of producing a bogus total."""
    if len(vals) < 2:
        return None
    total = sum(vals)
    hits = [t for t in vals if abs(2 * t - total) <= max(1.0, abs(t)) * 0.005]
    return hits[0] if len(hits) == 1 else None


def _alias_bank_topline(series: dict[str, dict[str, float]]) -> None:
    """Alias a bank's own top-line extension onto the revenue chain, in place.

    Only runs when the filer reported nothing on the standard revenue chain, so an
    ordinary filer is never affected. `series` holds non-dimensional facts only, so
    a segment or geography breakdown cannot be picked up here — the value aliased
    is the group total the filer reported.
    """
    if any(c in series for c in _IFRS["revenue"]):
        return
    # Sorted for determinism: a filer tagging two of these would otherwise alias
    # whichever one dict iteration happened to reach first.
    for concept in sorted(series):
        if concept.split(":", 1)[-1].lower() in _BANK_TOPLINE_NAMES:
            series[_BANK_TOPLINE] = dict(series[concept])
            return


def _esef_compute(lei: str, name: str, max_filings: int = 3) -> dict:
    """Compute the metrics from an ESEF filer's newest `max_filings` annual reports.

    `max_filings=1` is the cheap probe used to ask "can this company be
    benchmarked at all?" — one report instead of three. It can only be stricter
    than the full read, never looser: merging older reports adds concepts and
    periods, so a top line readable from the newest filing is readable from the
    merge too.
    """
    filings = _get_json(f"{_XBRL}/api/entities/{lei}/filings?page%5Bsize%5D=20").get("data", [])
    cands = [f["attributes"] for f in filings if f.get("attributes", {}).get("json_url")]
    if not cands:
        raise NoStructuredFiling(f"No ESEF filing with structured data found for {name}.")
    # Merge the most recent few annual reports so the trend spans several fiscal
    # years. A single ESEF report already carries the prior-year comparative, so
    # ~3 filings yield up to ~6 years for well-covered filers (thin filers just get
    # fewer years). Newest first, so setdefault below keeps the latest restatement.
    cands.sort(key=lambda a: a.get("period_end") or "", reverse=True)
    use = cands[:max_filings]
    latest = use[0]

    def _fetch(a):
        try:
            return _get_json(_XBRL + a["json_url"]).get("facts", {})
        except Exception:  # noqa: BLE001 — a single filing failing just drops its years
            return {}

    with ThreadPoolExecutor(max_workers=3) as ex:
        facts_list = list(ex.map(_fetch, use))

    series: dict[str, dict[str, float]] = {}
    # concept -> period-end -> member values reported under a single filer
    # income-statement extension axis (see _is_income_extension_axis). Some IFRS
    # filers (e.g. Centrica) never emit a bare non-dimensional P&L total — they
    # split it into total/adjusting members on their own axis — so we recover the
    # statutory total from these after the scan (see _axis_total).
    axis_members: dict[str, dict[str, list[float]]] = {}
    currency = "EUR"
    base = {"concept", "entity", "period", "unit"}
    for facts in facts_list:
        local_dim: dict[str, dict[str, list[float]]] = {}
        for f in facts.values():
            dim = f.get("dimensions", {})
            concept = dim.get("concept")
            period = dim.get("period", "")
            if not concept or not period:
                continue
            end = period.split("/")[-1][:10]
            try:
                val = float(f.get("value"))
            except (TypeError, ValueError):
                continue
            unit = (dim.get("unit") or "").split(":")[-1]
            if unit and unit.isupper() and len(unit) == 3:
                currency = unit
            extra = [k for k in dim.keys() if k not in base]
            if not extra:
                series.setdefault(concept, {}).setdefault(end, val)
            elif len(extra) == 1 and _is_income_extension_axis(extra[0]):
                local_dim.setdefault(concept, {}).setdefault(end, []).append(val)
        # Newest filing wins: keep the first filing's member-set for a given
        # (concept, period) since facts_list is sorted newest-first.
        for concept, ends in local_dim.items():
            for end, vals in ends.items():
                axis_members.setdefault(concept, {}).setdefault(end, vals)

    # Recover the group total for any concept/period that has no bare total but
    # does have filer income-statement axis members. The aggregate is the member
    # equal to the sum of the others (Centrica: BusinessPerformance +
    # ExceptionalItems = ResultsForTheYear); a non-aggregating breakdown yields
    # nothing and is left unread rather than mis-summed.
    for concept, ends in axis_members.items():
        for end, vals in ends.items():
            if series.get(concept, {}).get(end) is not None:
                continue
            total = _axis_total(vals)
            if total is not None:
                series.setdefault(concept, {})[end] = total

    _alias_bank_topline(series)

    rev_ends = sorted({k for c in _chains_for(series)["revenue"] if c in series
                       for k in series[c]})
    if not rev_ends:
        raise UnreadableFiling(
            f"Found {name}'s ESEF filing, but it reports no comparable revenue line. "
            f"Banks and insurers do this — they report interest and fee income "
            f"instead of revenue, so the benchmark metrics cannot be computed."
        )
    cur_key = rev_ends[-1]
    prev_key = rev_ends[-2] if len(rev_ends) > 1 else None

    viewer = latest.get("viewer_url") or latest.get("report_url")
    period_label = _fy_label(cur_key)
    return {
        "competitor": name,
        "period": period_label,
        "currency": currency,
        "source": "ESEF",
        "source_file": f"{name} \u2014 ESEF {period_label}",
        "source_url": (_XBRL + viewer) if viewer else _XBRL,
        "rows": _rows_from_series(series, currency, cur_key, prev_key),
        "trend": _trend_from_series(series, currency, "annual", max_periods=6),
    }


# ---------------------------------------------------------------------------
# EDGAR (SEC companyfacts) — compute from us-gaap (10-K) or ifrs-full (20-F) facts.
# ---------------------------------------------------------------------------
def _edgar_units(node: dict) -> tuple[list, str]:
    """A concept's monetary fact array + currency: prefer USD (domestic filers),
    else the first ISO-4217 3-letter unit (foreign private issuers file 20-F in
    their home currency, e.g. EUR / GBP)."""
    units = node.get("units", {})
    if units.get("USD"):
        return units["USD"], "USD"
    for u, arr in units.items():
        if len(u) == 3 and u.isalpha() and u.isupper() and arr:
            return arr, u
    return [], "USD"


def _edgar_series(facts: dict, want: str) -> tuple[dict[str, dict[str, float]], str]:
    """Build a concept -> {period_end: value} series (and its currency) from SEC
    companyfacts of one taxonomy.

    want="annual"    -> 10-K / 20-F full-year duration facts (>= 350 days).
    want="quarterly" -> 10-Q ~quarter duration facts (80-100 days) for income items,
                        plus point-in-time balance facts (no `start`) from 10-Q/10-K
                        so each quarter-end has AR / inventory / payables snapshots.
    """
    series: dict[str, dict[str, float]] = {}
    currency = "USD"
    for concept, node in facts.items():
        arr, ccy = _edgar_units(node)
        if not arr:
            continue
        for it in arr:
            form = str(it.get("form", ""))
            end = it.get("end")
            if not end:
                continue
            start = it.get("start")
            if want == "annual":
                # 10-K (domestic) or 20-F (foreign private issuer) annual reports.
                if not (form.startswith("10-K") or form.startswith("20-F")):
                    continue
                if start:
                    try:
                        if (date.fromisoformat(end) - date.fromisoformat(start)).days < 350:
                            continue
                    except ValueError:
                        continue
            else:  # quarterly
                if start:  # duration (income) fact — keep only ~quarter-length 10-Q
                    if not form.startswith("10-Q"):
                        continue
                    try:
                        dd = (date.fromisoformat(end) - date.fromisoformat(start)).days
                        if not (80 <= dd <= 100):
                            continue
                    except ValueError:
                        continue
                elif not (form.startswith("10-Q") or form.startswith("10-K")):
                    continue  # point-in-time (balance) — accept from either form
            try:
                series.setdefault(concept, {})[end[:10]] = float(it.get("val"))
            except (TypeError, ValueError):
                continue
            currency = ccy
    return series, currency


def _edgar_compute(cik: str, name: str) -> dict:
    cik10 = str(cik).zfill(10)
    try:
        payload = _get_json(_SEC_FACTS.format(cik=cik10))
    except urllib.error.HTTPError as e:
        # 404 = the CIK has no XBRL companyfacts (common for ADRs / foreign issuers
        # that never filed structured financials). Surface a clean, non-leaky
        # message instead of a raw "HTTP Error 404: NOT FOUND".
        if e.code == 404:
            raise NoStructuredFiling(
                f"No public structured (XBRL) filing found on SEC EDGAR for {name}."
            ) from e
        raise
    facts_all = payload.get("facts", {})

    # Try US-GAAP (domestic 10-K) first, then IFRS (foreign 20-F). IFRS concept
    # keys in companyfacts are unprefixed local names, so prefix them to match the
    # _IFRS chains (and the ESEF path's detection of "ifrs-full:" concepts).
    taxonomies = (
        ("us-gaap", "10-K", _USGAAP, facts_all.get("us-gaap", {})),
        ("ifrs-full", "20-F", _IFRS,
         {f"ifrs-full:{k}": v for k, v in facts_all.get("ifrs-full", {}).items()}),
    )
    for _taxo, form_label, chains, facts in taxonomies:
        if not facts:
            continue
        annual, currency = _edgar_series(facts, "annual")
        rev_ends = sorted({k for c in chains["revenue"] if c in annual for k in annual[c]})
        if not rev_ends:
            continue
        cur_key = rev_ends[-1]
        prev_key = rev_ends[-2] if len(rev_ends) > 1 else None
        period_label = _fy_label(cur_key)

        # Quarterly-first trend: use 10-Q quarters when there are enough, else fall
        # back to the annual series so a thin filer still gets a (yearly) line.
        quarterly, _ = _edgar_series(facts, "quarterly")
        q_rev_ends = {k for c in chains["revenue"] if c in quarterly for k in quarterly[c]}
        if len(q_rev_ends) >= 4:
            trend = _trend_from_series(quarterly, currency, "quarterly", max_periods=20)
        else:
            trend = _trend_from_series(annual, currency, "annual", max_periods=6)

        return {
            "competitor": name,
            "period": period_label,
            "currency": currency,
            "source": "EDGAR",
            "source_file": f"{name} \u2014 SEC {form_label} {period_label}",
            "source_url": (f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany"
                           f"&CIK={cik10}&type={form_label}&dateb=&owner=include&count=10"),
            "rows": _rows_from_series(annual, currency, cur_key, prev_key),
            "trend": trend,
        }
    raise UnreadableFiling(f"Could not read revenue from {name}'s SEC filings.")


def resolve_and_compute(source: str, key: str, name: str, max_filings: int = 3) -> dict:
    """Fetch structured filings for a resolved candidate and compute the metrics.

    Falls back from ESEF to EDGAR (by name) when an EU candidate has no ESEF
    filing with structured data, so a cross-listed name still yields numbers.

    `max_filings` trims how many ESEF reports are merged; see `_esef_compute`.
    Callers validating "is this company benchmarkable?" pass 1, and get the same
    verdict for a fraction of the work.
    """
    src = (source or "").upper()
    if src == "EDGAR":
        return _edgar_compute(key, name)
    if src == "ESEF":
        try:
            return _esef_compute(key, name, max_filings=max_filings)
        except (LookupError, urllib.error.URLError) as e:
            # Fall back to EDGAR by name first, so a cross-listed EU name still
            # yields numbers from its 20-F.
            hits = [c for c in search_companies(name) if c["source"] == "EDGAR"]
            if hits:
                return _edgar_compute(hits[0]["key"], hits[0]["name"])
            # A filing we opened but could not read is already described accurately;
            # rewriting it as "wrong entity" would send the user hunting for a parent
            # company they have already got.
            if isinstance(e, UnreadableFiling):
                raise
            # Otherwise the filing genuinely isn't there. Surface that instead of
            # leaking the raw "HTTP Error 404: NOT FOUND" to the UI.
            raise NoStructuredFiling(
                f"No public structured filing found for {name}. It looks like a "
                f"subsidiary or non-filing entity — search for the listed parent "
                f"company instead (the group holding company, not its banking or "
                f"operating subsidiary)."
            ) from e
    raise ValueError(f"Unknown source '{source}'.")
