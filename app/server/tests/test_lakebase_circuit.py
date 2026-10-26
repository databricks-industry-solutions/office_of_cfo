"""Per-industry Lakebase connection circuit-breaker tests."""
from __future__ import annotations

import pathlib
import sys
import threading
from contextlib import contextmanager
from unittest import mock

import pytest
import psycopg
from psycopg_pool import PoolTimeout

_APP = pathlib.Path(__file__).resolve().parents[2]
if str(_APP) not in sys.path:
    sys.path.insert(0, str(_APP))

from server import config, lakebase  # noqa: E402


class FakePool:
    def __init__(self, failures: list[Exception | None]):
        self.failures = failures
        self.calls = 0

    @contextmanager
    def connection(self, *args, **kwargs):
        self.calls += 1
        failure = self.failures.pop(0) if self.failures else None
        if failure:
            raise failure
        yield object()


class ConcurrentFailPool:
    def __init__(self):
        self.barrier = threading.Barrier(2)

    @contextmanager
    def connection(self, *args, **kwargs):
        self.barrier.wait()
        raise PoolTimeout("pool busy")
        yield  # pragma: no cover


@pytest.fixture(autouse=True)
def reset_circuits():
    lakebase._circuit_deadline.clear()
    lakebase._acquire_locks.clear()
    lakebase._connection_verified.clear()
    config.set_current_industry("consumer")
    yield
    lakebase._circuit_deadline.clear()
    lakebase._acquire_locks.clear()
    lakebase._connection_verified.clear()


def test_connection_timeout_opens_industry_circuit():
    fake = FakePool([PoolTimeout("unreachable")])
    router = lakebase._PoolRouter()

    with mock.patch.object(lakebase, "pool_for", return_value=fake):
        with pytest.raises(PoolTimeout):
            with router.connection():
                pass
        with pytest.raises(lakebase.LakebaseCircuitOpen):
            with router.connection():
                pass

    assert fake.calls == 1


def test_open_circuit_does_not_affect_another_industry():
    consumer = FakePool([PoolTimeout("unreachable")])
    software = FakePool([None])
    router = lakebase._PoolRouter()

    def selected_pool(industry: str):
        return {"consumer": consumer, "software": software}[industry]

    with mock.patch.object(lakebase, "pool_for", side_effect=selected_pool):
        with pytest.raises(PoolTimeout):
            with router.connection():
                pass
        config.set_current_industry("software")
        with router.connection():
            pass

    assert consumer.calls == 1
    assert software.calls == 1


def test_circuit_allows_probe_after_cooldown_and_closes_on_success():
    fake = FakePool([PoolTimeout("unreachable"), None, None])
    router = lakebase._PoolRouter()

    with mock.patch.object(lakebase, "pool_for", return_value=fake), \
         mock.patch.object(lakebase.time, "monotonic",
                           side_effect=[10.0, 10.0, 10.0, 41.0, 42.0]):
        with pytest.raises(PoolTimeout):
            with router.connection():
                pass
        with pytest.raises(lakebase.LakebaseCircuitOpen):
            with router.connection():
                pass
        with router.connection():
            pass
        with router.connection():
            pass

    assert fake.calls == 3
    assert "consumer" not in lakebase._circuit_deadline


def test_query_operational_error_does_not_open_connection_circuit():
    fake = FakePool([None, None])
    router = lakebase._PoolRouter()

    with mock.patch.object(lakebase, "pool_for", return_value=fake):
        with pytest.raises(psycopg.OperationalError):
            with router.connection():
                raise psycopg.OperationalError("connection dropped during query")
        with router.connection():
            pass

    assert fake.calls == 2


def test_one_timeout_after_verified_connection_does_not_open_circuit():
    fake = FakePool([None, PoolTimeout("pool busy"), None])
    router = lakebase._PoolRouter()

    with mock.patch.object(lakebase, "pool_for", return_value=fake):
        with router.connection():
            pass
        with pytest.raises(PoolTimeout):
            with router.connection():
                pass
        with router.connection():
            pass

    assert fake.calls == 3


def test_guarded_timeout_after_verified_timeout_opens_circuit():
    fake = FakePool([None, PoolTimeout("pool busy"), PoolTimeout("unreachable")])
    router = lakebase._PoolRouter()

    with mock.patch.object(lakebase, "pool_for", return_value=fake):
        with router.connection():
            pass
        with pytest.raises(PoolTimeout):
            with router.connection():
                pass
        with pytest.raises(PoolTimeout):
            with router.connection():
                pass
        with pytest.raises(lakebase.LakebaseCircuitOpen):
            with router.connection():
                pass

    assert fake.calls == 3


def test_concurrent_timeouts_from_verified_pool_do_not_open_circuit():
    fake = ConcurrentFailPool()
    router = lakebase._PoolRouter()
    lakebase._connection_verified.add("consumer")
    errors = []

    def connect():
        config.set_current_industry("consumer")
        try:
            with router.connection():
                pass
        except PoolTimeout as exc:
            errors.append(exc)

    with mock.patch.object(lakebase, "pool_for", return_value=fake):
        threads = [threading.Thread(target=connect) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

    assert len(errors) == 2
    assert "consumer" not in lakebase._circuit_deadline
