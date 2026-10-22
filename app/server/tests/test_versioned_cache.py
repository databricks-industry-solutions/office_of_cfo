from concurrent.futures import ThreadPoolExecutor
import threading
import time

from server.versioned_cache import VersionedTTLCache


def test_reuses_value_until_version_changes():
    version = [0]
    calls = [0]
    cache = VersionedTTLCache(60, lambda: version[0])

    def compute():
        calls[0] += 1
        return {"value": calls[0]}

    assert cache.get_or_compute("key", compute) == {"value": 1}
    assert cache.get_or_compute("key", compute) == {"value": 1}
    version[0] += 1
    assert cache.get_or_compute("key", compute) == {"value": 2}


def test_does_not_cache_unsuccessful_result():
    calls = [0]
    cache = VersionedTTLCache(60, lambda: 0)

    def compute():
        calls[0] += 1
        return {"available": calls[0] > 1}

    predicate = lambda result: result["available"]
    assert not cache.get_or_compute("key", compute, cache_when=predicate)["available"]
    assert cache.get_or_compute("key", compute, cache_when=predicate)["available"]
    assert cache.get_or_compute("key", compute, cache_when=predicate)["available"]
    assert calls[0] == 2


def test_does_not_cache_value_invalidated_during_compute():
    version = [0]
    calls = [0]
    cache = VersionedTTLCache(60, lambda: version[0])

    def compute():
        calls[0] += 1
        if calls[0] == 1:
            version[0] += 1
        return calls[0]

    assert cache.get_or_compute("key", compute) == 1
    assert cache.get_or_compute("key", compute) == 2
    assert cache.get_or_compute("key", compute) == 2


def test_collapses_concurrent_identical_misses():
    calls = [0]
    entered = threading.Event()
    release = threading.Event()
    cache = VersionedTTLCache(60, lambda: 0)

    def compute():
        calls[0] += 1
        entered.set()
        release.wait(timeout=2)
        return "done"

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(cache.get_or_compute, "key", compute)
        assert entered.wait(timeout=1)
        second = pool.submit(cache.get_or_compute, "key", compute)
        time.sleep(0.05)
        release.set()
        assert first.result() == second.result() == "done"

    assert calls[0] == 1


def test_comparative_commentary_cache_is_persona_specific(monkeypatch):
    from server.routes import statements

    statements._commentary_cache.clear()
    calls = []

    def compute(*args):
        calls.append(args[-1])
        return {"available": True, "persona": args[-1]}

    monkeypatch.setattr(statements, "_compute_comparative_commentary", compute)
    args = ("income", None, "mtd", "prior", "consolidated", "ALL", None)
    assert statements.comparative_commentary(*args, "cfo")["persona"] == "cfo"
    assert statements.comparative_commentary(*args, "cfo")["persona"] == "cfo"
    assert statements.comparative_commentary(*args, "controller")["persona"] == "controller"
    assert calls == ["cfo", "controller"]


def test_historical_narrative_cache_reuses_identical_body(monkeypatch):
    from server.routes import historical

    historical._narrative_cache.clear()
    calls = [0]

    def compute(_body):
        calls[0] += 1
        return {"available": True, "narrative": f"run {calls[0]}"}

    monkeypatch.setattr(historical, "_compute_historical_narrative", compute)
    body = historical.NarrativeIn(
        scope_type="consolidated", scope_id="ALL", metric="ccc", period="2026-06",
    )
    assert historical.historical_narrative(body)["narrative"] == "run 1"
    assert historical.historical_narrative(body)["narrative"] == "run 1"
    assert calls[0] == 1


def test_comparative_line_insights_cache_reuses_identical_view(monkeypatch):
    from server.routes import statements

    statements._insights_cache.clear()
    calls = [0]

    def compute(*_args):
        calls[0] += 1
        return {"available": True, "insights": {"revenue": f"run {calls[0]}"}}

    monkeypatch.setattr(statements, "_compute_line_insights", compute)
    args = ("income", None, "mtd", "prior", "consolidated", "ALL", None)
    assert statements.comparative_line_insights(*args)["insights"]["revenue"] == "run 1"
    assert statements.comparative_line_insights(*args)["insights"]["revenue"] == "run 1"
    assert calls[0] == 1


def test_comparative_line_insights_does_not_cache_unavailable(monkeypatch):
    from server.routes import statements

    statements._insights_cache.clear()
    calls = [0]

    def compute(*_args):
        calls[0] += 1
        return {"available": calls[0] > 1, "insights": {}}

    monkeypatch.setattr(statements, "_compute_line_insights", compute)
    args = ("income", None, "mtd", "prior", "consolidated", "ALL", None)
    assert not statements.comparative_line_insights(*args)["available"]
    assert statements.comparative_line_insights(*args)["available"]
    assert statements.comparative_line_insights(*args)["available"]
    assert calls[0] == 2


def test_universe_cache_reuses_identical_industry_period(monkeypatch):
    from server.routes import lineage_quality

    lineage_quality._universe_cache.clear()
    calls = [0]

    def compute():
        calls[0] += 1
        return {"run": calls[0]}

    monkeypatch.setattr(lineage_quality, "_build_universe", compute)
    assert lineage_quality._universe()["run"] == 1
    assert lineage_quality._universe()["run"] == 1
    assert calls[0] == 1
