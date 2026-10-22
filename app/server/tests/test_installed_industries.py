"""CFO_INDUSTRIES limits the app to the industries setup installed.

An industry left out by `setup.py --industries` has no schemas, so the resolver
must never route a request to it, even when a browser still remembers it.
"""
from __future__ import annotations

import importlib

import server.industry as industry


def _reload(monkeypatch, value: str | None):
    if value is None:
        monkeypatch.delenv("CFO_INDUSTRIES", raising=False)
    else:
        monkeypatch.setenv("CFO_INDUSTRIES", value)
    return importlib.reload(industry)


def test_unset_means_every_industry(monkeypatch):
    mod = _reload(monkeypatch, None)
    assert mod.INSTALLED_INDUSTRIES == mod.INDUSTRIES
    assert mod.DEFAULT_INDUSTRY == "consumer"
    assert mod.resolve_industry("energy") == "energy"


def test_subset_keeps_canonical_order_and_falls_back(monkeypatch):
    try:
        mod = _reload(monkeypatch, " capmarkets , fsi,unknown ")
        assert mod.INSTALLED_INDUSTRIES == ("fsi", "capmarkets")
        assert mod.DEFAULT_INDUSTRY == "fsi"
        assert mod.resolve_industry("capmarkets") == "capmarkets"
        assert mod.resolve_industry("consumer") == "fsi"   # not installed
        assert mod.resolve_industry("retail") == "fsi"     # alias of an uninstalled one
        assert mod.resolve_industry(None) == "fsi"
    finally:
        _reload(monkeypatch, None)


def test_only_unknown_values_mean_every_industry(monkeypatch):
    try:
        assert _reload(monkeypatch, "banking").INSTALLED_INDUSTRIES == industry.INDUSTRIES
    finally:
        _reload(monkeypatch, None)
