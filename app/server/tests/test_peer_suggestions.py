"""Offline guardrail for the peer-suggestion chips under the competitor search bar.

The chips are peers of the customer company set in the top-left brand picker, and
that list comes back from a language model as free text. The model mostly honours
"one company name per line", but not reliably — across runs it has emitted numbered
lists, bullets, a "Here are the competitors:" preamble, quoted names, and trailing
"(NYSE: KO)" tickers. `_parse_peer_lines` is the funnel that turns that into clean
names, and it matters more than its size suggests for two reasons:

1. Every surviving name costs a public-API round trip in the resolver probe that
   follows, so junk that gets through is wasted latency on every cache miss.
2. A name that survives parsing but is subtly wrong ("Coca-Cola Company (KO)")
   fails to resolve, silently shrinking the chip row.

These tests need no network, no warehouse, and no model — the parser is pure, which
is why it was split out from the ai_query call. They are the only part of the
feature that can be verified on an offline box.

Run under pytest, or standalone: `python app/server/tests/test_peer_suggestions.py`.
"""
from __future__ import annotations

import pathlib
import sys

# Make `server` importable whether run via pytest or directly (.../app on path).
_APP = pathlib.Path(__file__).resolve().parents[2]
if str(_APP) not in sys.path:
    sys.path.insert(0, str(_APP))

from server.config import current_industry, set_current_industry  # noqa: E402
from server.routes import competitor_search as cs  # noqa: E402

parse = cs._parse_peer_lines


def test_plain_lines_pass_through_in_order():
    """The happy path: the model obeyed the prompt. Order is preserved because it
    encodes the model's own relevance ranking, which the chip row relies on."""
    raw = "Globex\nNestle\nGeneral Mills"
    assert parse(raw, "Acmeco") == ["Globex", "Nestle", "General Mills"]


def test_strips_numbering_and_bullets():
    """Numbered and bulleted lists are the single most common deviation."""
    raw = "1. Globex\n2) Nestle\n- Kraft Heinz\n* Mondelez\n\u2022 Kellogg\n\u2013 Hormel"
    assert parse(raw, "Acmeco") == [
        "Globex", "Nestle", "Kraft Heinz", "Mondelez", "Kellogg", "Hormel",
    ]


def test_strips_quotes_and_trailing_parenthetical():
    """A trailing ticker/exchange gloss has to go: "Nestle (SWX: NESN)" does not
    resolve, while "Nestle" does."""
    raw = '"Globex"\nNestle (SWX: NESN)\n\u201cKraft Heinz\u201d\nMondelez (NASDAQ: MDLZ)'
    assert parse(raw, "Acmeco") == ["Globex", "Nestle", "Kraft Heinz", "Mondelez"]


def test_drops_preamble_and_prose():
    """Prose lines are dropped, not salvaged. A colon marks a preamble or an
    annotation, and a long word run marks an explanation — neither is a name."""
    raw = (
        "Here are the 10 largest publicly listed competitors:\n"
        "Globex\n"
        "Note: these all file with the SEC or publish ESEF filings\n"
        "Nestle is the largest of these by revenue and has a broader portfolio\n"
        "Kraft Heinz\n"
    )
    assert parse(raw, "Acmeco") == ["Globex", "Kraft Heinz"]


def test_drops_blank_and_whitespace_only_lines():
    raw = "Globex\n\n   \n\t\nNestle\n"
    assert parse(raw, "Acmeco") == ["Globex", "Nestle"]


def test_excludes_the_company_itself():
    """The prompt forbids it and the model still does it. Self-comparison is the
    one chip guaranteed to be useless, and it survives resolver validation (the
    company is real), so parsing is the only place it can be caught."""
    raw = "Acmeco\nGlobex\nNestle"
    assert parse(raw, "Acmeco") == ["Globex", "Nestle"]


def test_excludes_the_company_under_a_different_legal_suffix():
    """The model swaps legal suffixes in and out, so exact equality is not enough —
    "Peers of Acmeco: Acmeco PLC" is the visible failure this prevents."""
    assert parse("Acmeco PLC\nGlobex", "Acmeco") == ["Globex"]
    assert parse("Acmeco\nGlobex", "Acmeco PLC") == ["Globex"]


def test_self_exclusion_ignores_accents_and_case():
    """Normalization is shared with the resolver, so "NESTLE" and "Nestlé" are the
    same company here exactly as they are in the search box."""
    assert parse("nestle\nGlobex", "Nestl\u00e9") == ["Globex"]
    assert parse("ACMECO\nGlobex", "Acmeco") == ["Globex"]


def test_dedupes_on_the_normalized_name():
    """The model repeats itself across spellings. Duplicate chips look broken and
    each one costs another resolver probe."""
    raw = "Coca-Cola\nGlobex\nCoca Cola\nCOCA-COLA\nPepsiCo"
    assert parse(raw, "Acmeco") == ["Coca-Cola", "Globex", "PepsiCo"]


def test_keeps_the_original_spelling():
    """The parsed string is both the resolver query and the chip label, so it must
    keep the model's spelling — never the normalized form used for comparison."""
    assert parse("1. Procter & Gamble\n", "Acmeco") == ["Procter & Gamble"]


def test_trims_trailing_legal_suffixes():
    """Worth 3 of Nike's 5 chips. The resolver matches whole normalized tokens
    against what a human would type, so the model's full legal names miss filers
    that the terse name hits exactly."""
    trim = cs._peer_search_name
    assert trim("Skechers U.S.A., Inc.") == "Skechers"
    assert trim("VF Corporation") == "VF"
    assert trim("Deckers Outdoor Corporation") == "Deckers Outdoor"
    assert trim("Under Armour, Inc.") == "Under Armour"
    assert trim("PUMA SE") == "PUMA"
    assert trim("Anta Sports Products Limited") == "Anta Sports Products"


def test_trimming_leaves_distinctive_names_alone():
    """Only trailing legal forms go. A leading or embedded word that happens to
    look like one stays, and a trailing non-word (a digit) stops the trim."""
    trim = cs._peer_search_name
    assert trim("American Express Company") == "American Express"
    assert trim("General Mills") == "General Mills"
    assert trim("Procter & Gamble") == "Procter & Gamble"
    assert trim("Company 0") == "Company 0"


def test_trimming_does_not_leave_dangling_scaffolding():
    """Both of these shipped broken chips ("JPMorgan Chase &" and "Bank of") the
    first time the peer set was derived for a bank: removing the legal form exposes
    the connector that was holding it on."""
    trim = cs._peer_search_name
    assert trim("JPMorgan Chase & Co.") == "JPMorgan Chase"
    assert trim("Bank of America Corporation") == "Bank of America"
    assert trim("Marsh & McLennan Companies") == "Marsh & McLennan"


def test_trimming_never_consumes_the_whole_name():
    """A name made entirely of suffix words must survive as something searchable
    rather than collapsing to an empty query."""
    trim = cs._peer_search_name
    assert trim("3M Company") == "3M"
    assert trim("Holdings") == "Holdings"
    assert trim("Group Inc") == "Group"


def test_trimming_applies_through_the_parser():
    """End to end: what the parser emits is what gets probed and rendered."""
    raw = "Skechers U.S.A., Inc.\nVF Corporation\nAdidas AG"
    assert parse(raw, "Nike") == ["Skechers", "VF", "Adidas"]


def test_trimming_collapses_duplicates_across_legal_forms():
    """"Adidas AG" and "Adidas" are one company and must not be two chips."""
    assert parse("Adidas AG\nAdidas\nPuma SE", "Nike") == ["Adidas", "Puma"]


def test_caps_the_candidate_list():
    """Bounds the resolver fan-out: a model that ignores the count must not turn
    into fifty concurrent public-API calls."""
    raw = "\n".join(f"Company {i}" for i in range(40))
    assert len(parse(raw, "Acmeco")) == cs._PEER_ASK


def test_tolerates_empty_and_degenerate_input():
    """The ai_query column can come back empty or NULL; the caller passes "" for
    NULL, and neither may raise."""
    assert parse("", "Acmeco") == []
    assert parse("\n\n", "Acmeco") == []
    assert parse("Acmeco", "Acmeco") == []


def test_endpoint_short_circuits_without_touching_the_model():
    """The guard runs before any warehouse call, so a missing or too-short company
    name can never cost a model round trip. This is also what keeps the page usable
    when no company is configured (local development)."""
    assert cs._suggest_peers("") == {"company": "", "picks": []}
    assert cs._suggest_peers("   ") == {"company": "", "picks": []}
    assert cs._suggest_peers("A") == {"company": "A", "picks": []}


def test_endpoint_normalizes_the_customer_name():
    """The company name reaches a prompt, so newlines are collapsed and the length
    is capped. Verified via the short-circuit path to stay offline."""
    assert cs._suggest_peers("\n\t ") == {"company": "", "picks": []}
    assert " ".join("Foo\nBar  Baz".split()) == "Foo Bar Baz"
    assert len(" ".join(("x" * 500).split())[:cs._PEER_NAME_MAX]) == cs._PEER_NAME_MAX


def test_validation_keeps_the_request_industry_on_worker_threads():
    """Each probe must run under the industry the request carried.

    `_peer_benchmarks` reads the durable Delta cache through the CLOSE schema proxy,
    which resolves the `X-Industry` ContextVar at interpolation time. A pool worker
    starts with an EMPTY context, so without carrying the value across the thread
    boundary every probe resolved to the default industry: the "already benchmarked"
    shortcut could then never hit outside `consumer`, and each candidate paid a live
    filing lookup instead — the slow path, on every cache miss, for three of the four
    industries.
    """
    seen: list[str] = []
    before = current_industry()
    names, probe = cs._peer_names_from_model, cs._peer_benchmarks
    try:
        cs._peer_names_from_model = lambda company: ["Alpha", "Beta", "Gamma"]

        def _record(name: str) -> bool:
            seen.append(current_industry())
            return True

        cs._peer_benchmarks = _record
        set_current_industry("energy")
        assert cs._validated_peers("Centrica") == ["Alpha", "Beta", "Gamma"]
    finally:
        cs._peer_names_from_model, cs._peer_benchmarks = names, probe
        set_current_industry(before)
    assert seen == ["energy"] * 3, f"probes ran under {sorted(set(seen))}, not the request industry"


def test_the_industry_under_test_is_not_the_default():
    """Guards the test above from passing vacuously: if `energy` ever became the
    default industry, a worker inheriting nothing would look correct."""
    assert current_industry() != "energy"


if __name__ == "__main__":
    failures = 0
    tests = [(n, f) for n, f in sorted(globals().items())
             if n.startswith("test_") and callable(f)]
    for name, fn in tests:
        try:
            fn()
            print(f"  ok   {name}")
        except AssertionError as e:
            failures += 1
            print(f"  FAIL {name}: {e}")
    print(f"\n{len(tests) - failures}/{len(tests)} passed")
    sys.exit(1 if failures else 0)
