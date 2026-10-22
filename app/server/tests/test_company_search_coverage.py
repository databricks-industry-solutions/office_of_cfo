"""Coverage guardrail for company search: does typing a well-known name find it?

Covers resolution, the layer before computing benchmarks, over a ~50-name
corpus of large listed companies, and pins the three historical failure modes:

1. **Zero results for a real company.** The old resolver used GLEIF's legal-name
   filter as a search engine. It returns an arbitrary unranked slice, so the
   listed parent was usually absent entirely (Allianz: 15 of 1,746 matches) and
   the dropdown came back empty.
2. **A confidently wrong top hit.** Matching was a raw substring test on a
   punctuation-stripped name, so `_norm("P&G") == "p g"` matched "bhp group ltd"
   and `P&G` returned BHP Group. Likewise RWE -> DERWENT LONDON, EDF -> a Virtus
   bond fund. `test_no_unrelated_top_hit` fails if any of those come back.
3. **"Not found" for a company that is simply unfilable.** Nestlé, Roche, E.ON,
   EDF and every German ESEF registrant publish nothing machine-readable. Those
   must produce an explicit `notice`, not a bare empty result.
4. **A renamed issuer unreachable by its old name.** `RITCHIE BROS` is
   `RB GLOBAL INC.` on EDGAR and only browse-edgar matches former names. That feed
   arrives in two different shapes and just one of them names the companies, so the
   parser is pinned against a fixture of each (`_ATOM_*` below).

The corpus assertions match a normalized FRAGMENT of the expected legal name, not
the whole string, so a registry respelling ("Enel SpA" -> "ENEL - SPA") doesn't
fail the build but resolving to a different company does.

The unit tests at the top need no network and always run — they are what protects
the ranking rules on an offline box, where everything below skips.

Run under pytest, or standalone:
`python app/server/tests/test_company_search_coverage.py`.
"""
from __future__ import annotations

import pathlib
import sys
import urllib.request

# Make `server` importable whether run via pytest or directly (.../app on path).
_APP = pathlib.Path(__file__).resolve().parents[2]
if str(_APP) not in sys.path:
    sys.path.insert(0, str(_APP))

from server import company_lookup as cl  # noqa: E402

try:
    import pytest
    _HAS_PYTEST = True
except ModuleNotFoundError:
    _HAS_PYTEST = False

if _HAS_PYTEST:
    # Live SEC lookups: SEC answers 403 unless the User-Agent names a contact.
    pytestmark = pytest.mark.skipif(
        "contact:" not in cl._UA,
        reason="live SEC lookups need CFO_CONTACT_EMAIL (SEC fair-access policy)")


# ---------------------------------------------------------------------------
# Corpus: query -> a fragment the top hit's name must contain (normalized).
# ---------------------------------------------------------------------------
EXPECTED_TOP: dict[str, str] = {
    # The six GLEIF casualties. Each returned ZERO results before this work,
    # because GLEIF never included the parent in its response.
    "Henkel": "",  # unfilable, see NO_FILING — kept here only as documentation
    "Allianz": "",
    "Reckitt": "reckitt benckiser",
    "UniCredit": "unicredit",
    "LVMH": "lvmh",
    "Naturgy": "naturgy energy",
    # Brand and colloquial names no legal-name index contains.
    "Google": "alphabet",
    "Facebook": "meta platforms",
    "P&G": "procter gamble",
    "Total": "totalenergies",
    "AB InBev": "anheuser busch inbev",
    # A renamed issuer, reachable only via EDGAR's former-name search.
    "RITCHIE BROS": "rb global",
    # EU / ESEF long tail.
    "TotalEnergies": "totalenergies",
    "Shell": "shell",
    "Carrefour": "carrefour",
    "Tesco": "tesco",
    "Sainsbury": "sainsbury",
    "Diageo": "diageo",
    "L'Oréal": "l oreal",
    "BNP Paribas": "bnp paribas",
    "Barclays": "barclays",
    "AXA": "axa",
    "Vattenfall": "vattenfall",
    "Iberdrola": "iberdrola",
    "Engie": "engie",
    "Enel": "enel",
    "Endesa": "endesa",
    "Ørsted": "orsted",
    "Centrica": "centrica",
    "SSE": "sse",
    "National Grid": "national grid",
    "ASML": "asml",
    "KBC": "kbc",
    "UCB": "ucb",
    "Ahold Delhaize": "ahold delhaize",
    "ArcelorMittal": "arcelormittal",
    "Philips": "philips",
    "Adyen": "adyen",
    # US / EDGAR.
    "Alphabet": "alphabet",
    "Microsoft": "microsoft",
    "Oracle": "oracle",
    "Adobe": "adobe",
    "Workday": "workday",
    "ServiceNow": "servicenow",
    "Snowflake": "snowflake",
    "Intuit": "intuit",
    "PepsiCo": "pepsico",
    "Coca-Cola": "coca cola",
    "Mondelez": "mondelez",
    "Kraft Heinz": "kraft heinz",
    "Colgate-Palmolive": "colgate palmolive",
    "Procter & Gamble": "procter gamble",
    "Novartis": "novartis",
    "Visa": "visa",
    "JPMorgan": "jpmorgan chase",
    # "group" is load-bearing: the SEC map also carries "Goldman Sachs BDC, Inc.",
    # a fund vehicle that ties on every other ranking key.
    "Goldman Sachs": "goldman sachs group",
    "Bank of America": "bank of america",
}
# The unfilable ones are asserted by NO_FILING instead; drop the placeholders.
EXPECTED_TOP = {q: frag for q, frag in EXPECTED_TOP.items() if frag}

# Real companies with no machine-readable filing on either source. Every German
# ESEF registrant is in this state — DE filings go to the Bundesanzeiger, which
# filings.xbrl.org does not mirror, so the entity is listed with zero filings.
NO_FILING = [
    "Nestle", "Nestlé", "Roche", "E.ON", "EDF", "RWE",   # Swiss / delisted / absent
    "Henkel", "Allianz", "Beiersdorf", "Siemens",         # German registrants
]

# Historical wrong answers. Each pair is (query, fragment that must NOT be the
# top hit) — these are the exact garbage matches the old substring test produced.
NEVER_TOP = [
    ("P&G", "bhp"),
    ("RWE", "derwent"),
    ("Roche", "roche bobois"),
    ("EDF", "virtus"),
]


def _network_up() -> bool:
    try:
        urllib.request.urlopen(
            urllib.request.Request(f"{cl._XBRL}/api/entities?page%5Bsize%5D=1",
                                   headers={"User-Agent": cl._UA}),
            timeout=8)
        return True
    except Exception:  # noqa: BLE001 — any failure => treat as offline => skip
        return False


# ---------------------------------------------------------------------------
# Offline unit tests — the ranking rules, with no network.
# ---------------------------------------------------------------------------
def check_norm_folds_accents() -> None:
    """Accents and strokes must fold, or an EU filer is unreachable by the name a
    user actually types."""
    assert cl._norm("Nestlé") == cl._norm("Nestle") == "nestle"
    assert cl._norm("Ørsted") == "orsted"
    assert cl._norm("L'Oréal") == "l oreal"
    assert cl._norm("Société Générale") == "societe generale"
    assert cl._norm("Colgate-Palmolive") == "colgate palmolive"


def check_interior_substrings_are_rejected() -> None:
    """The bug that made `P&G` return BHP Group: a token-boundary-free substring
    test. These must be rejected outright, not merely ranked lower."""
    reject = [
        ("P&G", "BHP GROUP LTD"),
        ("RWE", "DERWENT LONDON PLC"),
        ("EDF", "VIRTUS TOTAL RETURN FUND INC"),
        ("SAP", "SAPIENT CORP"),
    ]
    for query, name in reject:
        assert cl._match_rank(cl._tokens(query), cl._tokens(name)) is None, \
            f"{query!r} must not match {name!r}"


def check_match_rank_ordering() -> None:
    """Exact beats a prefix run, which beats tokens-anywhere."""
    assert cl._match_rank(cl._tokens("DANONE"), cl._tokens("DANONE")) == cl._RANK_EXACT
    assert cl._match_rank(cl._tokens("Henkel"),
                          cl._tokens("Henkel AG & Co. KGaA")) == cl._RANK_PREFIX
    assert cl._match_rank(cl._tokens("Ahold Delhaize"),
                          cl._tokens("Koninklijke Ahold Delhaize N.V.")) == cl._RANK_TOKENS


def check_structural_and_geo_demotion() -> None:
    """A group parent must outrank its financing arm and its national
    subsidiaries — the filer roster genuinely contains all three."""
    qt = cl._tokens("UniCredit")
    parent = cl._score(qt, cl._tokens("UNICREDIT, SOCIETA' PER AZIONI"), "ESEF")
    austria = cl._score(qt, cl._tokens("UniCredit Bank Austria AG"), "ESEF")
    assert parent < austria, "the Italian parent must outrank UniCredit Bank Austria"

    qt = cl._tokens("Nestle")
    assert (cl._score(qt, cl._tokens("NESTLE SA"), "ESEF")
            < cl._score(qt, cl._tokens("NESTLE HOLDINGS, INC."), "ESEF")), \
        "a financing subsidiary must not outrank the operating parent"

    # Demotion looks only at tokens ABSENT from the query, so a company whose own
    # name carries the marker is unaffected.
    qt = cl._tokens("Deutsche Bank")
    assert cl._score(qt, cl._tokens("DEUTSCHE BANK AG"), "ESEF")[1] == 0


def check_esef_preferred_over_us_adr() -> None:
    """An EU issuer's home ESEF filing must not be shadowed by its US ADR, whose
    SEC spelling accidentally tokenizes shorter ("ASML HOLDING NV" vs "N.V.")."""
    qt = cl._tokens("ASML")
    esef = cl._score(qt, cl._tokens("ASML Holding N.V."), "ESEF", name_len=17)
    adr = cl._score(qt, cl._tokens("ASML HOLDING NV"), "EDGAR", name_len=15)
    assert esef < adr


def check_ticker_ranks_below_a_name_match() -> None:
    """`UCB` is the Belgian pharma to a user and United Community Banks to the
    SEC ticker map. A name match must win."""
    qt = cl._tokens("UCB")
    by_name = cl._score(qt, cl._tokens("UCB BIOPHARMA"), "ESEF", name_len=13)
    by_ticker = cl._score(qt, cl._tokens("United Community Banks Inc"), "EDGAR",
                          ticker_hit=True, name_len=26)
    assert by_name < by_ticker
    # A ticker-only query must still resolve, just at a lower rank.
    assert cl._score(cl._tokens("MSFT"), cl._tokens("Microsoft Corp"), "EDGAR",
                     ticker_hit=True) is not None


# Real browse-edgar atom responses, trimmed. These two shapes are the whole reason
# the former-name fallback needs a parser of its own — see _parse_browse_atom.
_ATOM_ONE_COMPANY = """<?xml version="1.0" encoding="ISO-8859-1" ?>
  <feed xmlns="http://www.w3.org/2005/Atom">
    <company-info>
      <assigned-sic-href>...&amp;SIC=7389&amp;owner=include</assigned-sic-href>
      <cik>0001046102</cik>
      <cik-href>...&amp;CIK=0001046102&amp;owner=include</cik-href>
      <conformed-name>RB GLOBAL INC.</conformed-name>
      <formerly-names count="1">
        <names><date>2023-05-18</date><name>RITCHIE BROS AUCTIONEERS INC</name></names>
      </formerly-names>
    </company-info>
    <entry>
      <content type="text/xml">
        <xbrl_href>...&amp;cik=1046102&amp;xbrl_type=f</xbrl_href>
      </content>
      <link href="...&amp;CIK=0001046102&amp;type=10-K" rel="alternate" />
    </entry>
    <entry>
      <link href="...&amp;CIK=0001046102&amp;type=10-K" rel="alternate" />
    </entry>
  </feed>"""

_ATOM_MANY_COMPANIES = """<?xml version="1.0" encoding="ISO-8859-1" ?>
  <feed xmlns="http://www.w3.org/2005/Atom">
    <entry title="ARRAY(0x55bd5dd22528)">
      <content type="text/xml">
        <company-info name="ARRAY(0x55bd5dc9a520)">
          <cik>0000320193</cik>
          <sic>3571</sic>
        </company-info>
      </content>
      <id>urn:tag:www.sec.gov:cik=0000320193</id>
      <link href="...&amp;CIK=0000320193&amp;owner=exclude" type="text/html" />
    </entry>
    <entry title="ARRAY(0x55bd5dc971b0)">
      <content type="text/xml">
        <company-info name="ARRAY(0x55bd5dcd0d98)">
          <cik>0001510976</cik>
        </company-info>
      </content>
      <id>urn:tag:www.sec.gov:cik=0001510976</id>
      <link href="...&amp;CIK=0001510976&amp;owner=exclude" type="text/html" />
    </entry>
  </feed>"""


def check_browse_atom_single_company() -> None:
    """The shape the headline rename case arrives in: one company, its filing list,
    and a `CIK=` query parameter on every filing link. Reading the CIK off those
    parameters — as this did — counts links rather than companies."""
    assert cl._parse_browse_atom(_ATOM_ONE_COMPANY) == [("RB GLOBAL INC.", "1046102")]


def check_browse_atom_multi_company_survives_unnamed() -> None:
    """A query matching several companies returned NOTHING, silently killing the
    fallback for exactly the ambiguous queries that need it (real example:
    `monsanto`, two matches). This document has no `<conformed-name>` at all — SEC
    leaks a Perl array reference into the name slots — so zipping names against CIKs
    produced an empty list. The CIKs must survive, unnamed, to be labelled by the
    caller; the array reference must never reach a name."""
    pairs = cl._parse_browse_atom(_ATOM_MANY_COMPANIES)
    assert pairs == [("", "320193"), ("", "1510976")]
    assert "ARRAY" not in "".join(nm for nm, _ in pairs)
    # A document with neither names nor CIKs is empty, not an exception.
    assert cl._parse_browse_atom("<feed></feed>") == []


def check_unnamed_hits_are_labelled_from_the_ticker_map() -> None:
    """Names for the multi-company shape come from the cached ticker map by CIK — the
    CURRENT name, which is what a former-name search should display. A CIK the map
    doesn't know stays unnamed, so the caller drops it rather than offering the user
    a bare number."""
    original = cl._sec_tickers
    try:
        cl._sec_tickers = lambda: [
            {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."},
            {"cik_str": 1510976, "ticker": "", "title": ""},
        ]
        assert cl._sec_titles_for_ciks({"320193"}) == {"320193": "Apple Inc."}
        assert cl._sec_titles_for_ciks({"1510976"}) == {}  # in the map, but nameless
        assert cl._sec_titles_for_ciks({"99"}) == {}       # not in the map
        assert cl._sec_titles_for_ciks(set()) == {}        # nothing to resolve
    finally:
        cl._sec_tickers = original


def check_aliases_and_known_absentees() -> None:
    """Brand aliases rewrite the query; known-unfilable names short-circuit."""
    assert cl._resolve_query("Google") == "Alphabet"
    assert cl._resolve_query("P&G") == "Procter & Gamble"
    assert cl._resolve_query("Ritchie Bros") == "RB Global"
    assert cl._resolve_query("Diageo") == "Diageo"  # untouched
    for name in ("Nestle", "Nestlé", "E.ON", "EDF", "Roche"):
        assert cl._norm(name) in cl._KNOWN_NO_FILING, f"{name} should short-circuit"
    # Short queries return nothing and never hit the network.
    assert cl.search_with_status("a") == {"candidates": [], "degraded": [], "notice": None}


OFFLINE_CHECKS = [
    check_norm_folds_accents,
    check_interior_substrings_are_rejected,
    check_match_rank_ordering,
    check_structural_and_geo_demotion,
    check_esef_preferred_over_us_adr,
    check_ticker_ranks_below_a_name_match,
    check_browse_atom_single_company,
    check_browse_atom_multi_company_survives_unnamed,
    check_unnamed_hits_are_labelled_from_the_ticker_map,
    check_aliases_and_known_absentees,
]


# ---------------------------------------------------------------------------
# Network-gated coverage over the corpus.
# ---------------------------------------------------------------------------
def _check_top_hit(query: str, fragment: str) -> None:
    result = cl.search_with_status(query)
    cands = result["candidates"]
    assert cands, (f"'{query}' returned no candidate "
                   f"(degraded={result['degraded']}, notice={result['notice']!r})")
    top = cands[0]["name"]
    assert fragment in cl._norm(top), \
        f"'{query}' -> top hit {top!r}, expected a name containing {fragment!r}"


def _check_no_filing(query: str) -> None:
    result = cl.search_with_status(query)
    assert result["notice"], (
        f"'{query}' has no machine-readable filing but returned "
        f"{len(result['candidates'])} candidates with no explanatory notice")


def _check_never_top(query: str, forbidden: str) -> None:
    cands = cl.search_with_status(query)["candidates"]
    if not cands:
        return  # nothing offered is an acceptable answer; a wrong hit is not
    assert forbidden not in cl._norm(cands[0]["name"]), \
        f"'{query}' -> {cands[0]['name']!r}, an unrelated company"


TOP_CASES = sorted(EXPECTED_TOP.items())

if _HAS_PYTEST:
    @pytest.mark.parametrize("check", OFFLINE_CHECKS,
                             ids=[c.__name__ for c in OFFLINE_CHECKS])
    def test_ranking_rules(check):
        check()

    @pytest.mark.skipif(not _network_up(), reason="public filing sources unreachable (offline)")
    @pytest.mark.parametrize("query,fragment", TOP_CASES, ids=[q for q, _ in TOP_CASES])
    def test_expected_top_hit(query, fragment):
        _check_top_hit(query, fragment)

    @pytest.mark.skipif(not _network_up(), reason="public filing sources unreachable (offline)")
    @pytest.mark.parametrize("query", NO_FILING)
    def test_no_structured_filing_is_explicit(query):
        _check_no_filing(query)

    @pytest.mark.skipif(not _network_up(), reason="public filing sources unreachable (offline)")
    @pytest.mark.parametrize("query,forbidden", NEVER_TOP,
                             ids=[f"{q}-not-{f}" for q, f in NEVER_TOP])
    def test_no_unrelated_top_hit(query, forbidden):
        _check_never_top(query, forbidden)


if __name__ == "__main__":
    failures: list[str] = []

    def _run(label, fn, *args):
        try:
            fn(*args)
            print(f"PASS {label}")
        except AssertionError as exc:
            failures.append(f"{label}: {exc}")
            print(f"FAIL {label}: {exc}")
        except Exception as exc:  # noqa: BLE001
            failures.append(f"{label}: {type(exc).__name__}: {exc}")
            print(f"ERROR {label}: {type(exc).__name__}: {exc}")

    for _check in OFFLINE_CHECKS:
        _run(_check.__name__, _check)

    if not _network_up():
        print("\nSKIP (offline): corpus coverage needs the public filing sources")
        raise SystemExit(1 if failures else 0)

    for _q, _frag in TOP_CASES:
        _run(f"top-hit {_q}", _check_top_hit, _q, _frag)
    for _q in NO_FILING:
        _run(f"no-filing {_q}", _check_no_filing, _q)
    for _q, _forbidden in NEVER_TOP:
        _run(f"never-top {_q}!={_forbidden}", _check_never_top, _q, _forbidden)

    total = len(OFFLINE_CHECKS) + len(TOP_CASES) + len(NO_FILING) + len(NEVER_TOP)
    print(f"\n{total - len(failures)}/{total} checks passed")
    raise SystemExit(1 if failures else 0)
