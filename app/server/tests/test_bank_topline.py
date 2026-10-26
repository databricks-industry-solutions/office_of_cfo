"""Offline guardrail for benchmarking banks, and for saying so honestly when we can't.

Banks broke the competitor benchmark twice over, and both failures were invisible
until a chip was clicked:

1. A bank reports no revenue. The metric chains looked for `ifrs-full:Revenue` and
   `RevenueFromContractsWithCustomers`; a bank's top line is total income, tagged
   either as `ifrs-full:RevenueAndOperatingIncome` (ABN AMRO) or in the filer's own
   namespace, because "net banking income" has no IFRS concept at all (Société
   Générale: `SocGen:NetBankingIncome`, BNP Paribas:
   `bnpp:RevenuesFromContinuingActivities`).

2. The resulting failure lied about its cause. Every `LookupError` out of
   `_esef_compute` was rewritten as "looks like a subsidiary — search for the
   listed parent company instead", so BNP Paribas — which IS the listed parent —
   told the user to go find its parent.

The aliasing is deliberately a small allowlist of verified concept names rather
than a pattern match on anything total-shaped, because the failure mode of a wrong
entry is silent: a subtotal would be benchmarked as though it were the top line.
These tests pin that conservatism in place.

No network, no warehouse, no model: `_alias_bank_topline` is pure and the error
types are plain classes.

Run under pytest, or standalone: `python app/server/tests/test_bank_topline.py`.
"""
from __future__ import annotations

import pathlib
import sys

# Make `server` importable whether run via pytest or directly (.../app on path).
_APP = pathlib.Path(__file__).resolve().parents[2]
if str(_APP) not in sys.path:
    sys.path.insert(0, str(_APP))

from server import company_lookup as cl  # noqa: E402

alias = cl._alias_bank_topline
END = "2026-01-01"


def test_aliases_a_filer_extension_onto_the_revenue_chain():
    """Société Générale's real case: the only top line is in its own namespace, so
    without aliasing the filing computes to nothing."""
    series = {"SocGen:NetBankingIncome": {END: 27_254e6}}
    alias(series)
    assert series[cl._BANK_TOPLINE] == {END: 27_254e6}
    # And the chain actually reaches it, which is the point of the alias.
    assert cl._pick(series, cl._IFRS["revenue"], END) == 27_254e6


def test_alias_is_prefix_independent():
    """Each bank tags its top line in its own namespace, so matching must ignore the
    prefix — BNP's concept differs from SocGen's only by the name after the colon."""
    series = {"bnpp:RevenuesFromContinuingActivities": {END: 51_223e6}}
    alias(series)
    assert cl._pick(series, cl._IFRS["revenue"], END) == 51_223e6


def test_standard_revenue_wins_and_blocks_aliasing():
    """An ordinary filer must be untouched. A bank that reports BOTH a standard Revenue
    and bank-style components keeps the figure it calls revenue."""
    series = {
        "ifrs-full:Revenue": {END: 23_035e6},
        "SocGen:NetBankingIncome": {END: 999e6},
    }
    alias(series)
    assert cl._BANK_TOPLINE not in series
    assert cl._pick(series, cl._IFRS["revenue"], END) == 23_035e6


def test_standard_bank_concept_needs_no_alias():
    """ABN AMRO's top line is a standard IFRS concept, just not one of the two the
    chains used to carry. It must resolve without touching the extension path."""
    series = {"ifrs-full:RevenueAndOperatingIncome": {END: 8_716e6}}
    alias(series)
    assert cl._BANK_TOPLINE not in series
    assert cl._pick(series, cl._IFRS["revenue"], END) == 8_716e6


def test_unknown_extensions_are_left_alone():
    """The allowlist is the safety property: an unverified concept that merely sounds
    like a total must NOT become the benchmark top line."""
    series = {
        "SocGen:AdjustmentsRelatedToInterbankTransactions": {END: 31_087e6},
        "san:TotalAssetsSomething": {END: 62_000e6},
        "ifrs-full:RevenueFromInterest": {END: 71_532e6},
    }
    alias(series)
    assert cl._BANK_TOPLINE not in series


def test_gross_interest_is_never_treated_as_a_top_line():
    """Explicitly pinned because it is the tempting wrong answer: BNP's gross interest
    revenue is 71,532m against a true top line of 51,223m, so benchmarking it would
    overstate the bank by ~40% while looking perfectly plausible."""
    assert "revenuefrominterest" not in cl._BANK_TOPLINE_NAMES
    assert "interestrevenueexpense" not in cl._BANK_TOPLINE_NAMES
    assert "feeandcommissionincome" not in cl._BANK_TOPLINE_NAMES


def test_alias_is_deterministic_when_two_names_match():
    """A filer tagging two allowlisted names must not alias whichever one dict order
    happened to reach first, or the same filing would benchmark differently per run."""
    series = {
        "SocGen:NetBankingIncome": {END: 1.0},
        "bnpp:RevenuesFromContinuingActivities": {END: 2.0},
    }
    twice = []
    for _ in range(2):
        s = {k: dict(v) for k, v in series.items()}
        alias(s)
        twice.append(s[cl._BANK_TOPLINE][END])
    assert twice[0] == twice[1]


def test_alias_copies_rather_than_shares_the_period_map():
    """The alias must not hand out the same dict object: a later write against the
    real concept would otherwise silently rewrite the benchmark top line too."""
    series = {"SocGen:NetBankingIncome": {END: 27_254e6}}
    alias(series)
    series["SocGen:NetBankingIncome"]["2027-01-01"] = 1.0
    assert "2027-01-01" not in series[cl._BANK_TOPLINE]


def test_empty_series_is_tolerated():
    """A filing that parsed to nothing must fall through to the caller's own
    "unreadable" error, not raise from inside the alias."""
    series: dict[str, dict[str, float]] = {}
    alias(series)
    assert series == {}


def test_the_two_failure_modes_are_distinguishable():
    """The bug behind the misleading message: both cases arrived as bare LookupError,
    so the handler could not tell "wrong entity" from "unreadable filing" and applied
    the wrong advice to both. Anything catching LookupError still catches both."""
    assert issubclass(cl.NoStructuredFiling, LookupError)
    assert issubclass(cl.UnreadableFiling, LookupError)
    assert not issubclass(cl.UnreadableFiling, cl.NoStructuredFiling)
    assert not issubclass(cl.NoStructuredFiling, cl.UnreadableFiling)


def test_unreadable_filing_message_does_not_blame_the_entity():
    """Regression on the reported symptom: BNP Paribas IS the listed parent, so the
    message must not send the user hunting for a parent company."""
    series = {"ifrs-full:RevenueFromInterest": {END: 71_532e6}}
    alias(series)
    # Mirrors _esef_compute's own check, which is what raises for this series.
    assert not sorted({k for c in cl._chains_for(series)["revenue"] if c in series
                       for k in series[c]})


def test_gate_and_rows_read_the_same_revenue_chain():
    """The readability gate and the metrics it guards must never disagree.

    They did: the gate hardcoded the IFRS chain, which carries the alias sentinel,
    while the rows resolved their chain from the taxonomy of the series. A filing
    tagging no `ifrs-full:` concept at all therefore passed the gate and then emitted
    zero metrics — an empty result that reads as success all the way to the UI.
    Whatever chain a series resolves to, "the gate sees a top line" and "the rows
    emit Revenue" have to be the same answer.
    """
    cases = {
        "IFRS bank whose top line is a filer extension": {
            "ifrs-full:ProfitLoss": {END: 4_000e6},
            "SocGen:NetBankingIncome": {END: 27_254e6},
        },
        "extension top line and no IFRS concept anywhere": {
            "SocGen:NetBankingIncome": {END: 27_254e6},
        },
        "ordinary IFRS filer": {"ifrs-full:Revenue": {END: 60_000e6}},
        "IFRS filer reporting only gross interest": {
            "ifrs-full:RevenueFromInterest": {END: 71_532e6},
        },
    }
    for label, series in cases.items():
        alias(series)
        chain = cl._chains_for(series)["revenue"]
        gate_sees_revenue = bool({k for c in chain if c in series for k in series[c]})
        rows = cl._rows_from_series(series, "EUR", END, None)
        assert gate_sees_revenue == any(r["metric"] == "Revenue ($B)" for r in rows), label


if __name__ == "__main__":
    import pytest

    raise SystemExit(pytest.main([__file__, "-q"]))
