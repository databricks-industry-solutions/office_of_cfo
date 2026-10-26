"""Regression tests for concurrent Month-End Close schema initialization."""
from __future__ import annotations

import pathlib
import sys
import threading
import time
from contextlib import contextmanager
from unittest import mock

import pytest
import psycopg

_APP = pathlib.Path(__file__).resolve().parents[2]
if str(_APP) not in sys.path:
    sys.path.insert(0, str(_APP))

from server import config  # noqa: E402
from server.routes import close, tasks  # noqa: E402


class FakeCursor:
    def __init__(self, rows=None, fail_at=None, fail_with=None):
        self.rows = list(rows or [])
        self.fail_at = fail_at
        self.fail_with = fail_with or psycopg.OperationalError("connection dropped during DDL")
        self.executed: list[str] = []

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, statement, *args):
        self.executed.append(statement)
        if self.fail_at == len(self.executed):
            raise self.fail_with

    def fetchone(self):
        return self.rows.pop(0) if self.rows else None


class FakeConnection:
    def __init__(self, rows=None, fail_at=None, fail_with=None):
        self.fake_cursor = FakeCursor(rows, fail_at, fail_with)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def cursor(self):
        return self.fake_cursor

    def commit(self):
        pass

    def rollback(self):
        pass


class CountingPool:
    def __init__(self, rows=None, delay=0.0, fail_at=None, fail_with=None):
        self.rows = rows
        self.delay = delay
        self.fail_at = fail_at
        self.fail_with = fail_with
        self.calls = 0
        self.active = 0
        self.max_active = 0
        self.connections: list[FakeConnection] = []
        self._lock = threading.Lock()

    @contextmanager
    def connection(self, *args, **kwargs):
        with self._lock:
            self.calls += 1
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        try:
            if self.delay:
                time.sleep(self.delay)
            conn = FakeConnection(self.rows, self.fail_at, self.fail_with)
            self.connections.append(conn)
            yield conn
        finally:
            with self._lock:
                self.active -= 1


@pytest.fixture(autouse=True)
def reset_schema_guards():
    config.set_current_industry("consumer")
    close._schema_ready.clear()
    tasks._initialized.clear()
    tasks._config_cache.clear()
    yield
    close._schema_ready.clear()
    tasks._initialized.clear()
    tasks._config_cache.clear()


def test_adjustment_schema_uses_one_connection_for_all_ddl():
    fake = CountingPool()

    with mock.patch.object(close, "pool", fake):
        close._ensure_adjustment_schema()

    assert fake.calls == 1
    assert len(fake.connections[0].fake_cursor.executed) == len(close._SCHEMA_DDL)


def test_concurrent_adjustment_schema_calls_initialize_once():
    fake = CountingPool(delay=0.05)

    with mock.patch.object(close, "pool", fake):
        threads = [threading.Thread(target=close._ensure_adjustment_schema) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

    assert fake.calls == 1


def test_concurrent_task_schema_calls_initialize_once():
    # Existing default config + current seed version means no migration writes.
    fake = CountingPool(rows=[(1,), ({"version": tasks.SEED_VERSION},)], delay=0.05)

    with mock.patch.object(tasks, "pool", fake), \
         mock.patch.object(tasks, "_seed_from_config") as seed:
        threads = [threading.Thread(target=tasks._ensure_schema) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

    assert fake.calls == 1
    seed.assert_called_once_with(reconcile=False)


def test_adjustment_schema_connection_loss_is_not_cached_as_ready():
    fake = CountingPool(fail_at=2)

    with mock.patch.object(close, "pool", fake):
        close._ensure_adjustment_schema()

    assert "consumer" not in close._schema_ready


def test_adjustment_schema_interface_error_is_not_cached_as_ready():
    fake = CountingPool(fail_at=2, fail_with=psycopg.InterfaceError("connection closed"))

    with mock.patch.object(close, "pool", fake):
        close._ensure_adjustment_schema()

    assert "consumer" not in close._schema_ready


def test_missing_reversal_column_does_not_abort_remaining_schema_ddl():
    backfill_index = next(
        i for i, statement in enumerate(close._SCHEMA_DDL, start=1)
        if statement.startswith("UPDATE posted_adjustments SET is_reversal")
    )
    fake = CountingPool(
        fail_at=backfill_index,
        fail_with=psycopg.errors.UndefinedColumn("is_reversal does not exist"),
    )

    with mock.patch.object(close, "pool", fake):
        close._ensure_adjustment_schema()

    assert "consumer" in close._schema_ready
    assert len(fake.connections[0].fake_cursor.executed) == len(close._SCHEMA_DDL)


def test_adjustment_schema_initializes_different_industries_concurrently():
    fake = CountingPool(delay=0.05)

    def initialize(industry: str):
        config.set_current_industry(industry)
        close._ensure_adjustment_schema()

    with mock.patch.object(close, "pool", fake):
        threads = [
            threading.Thread(target=initialize, args=("consumer",)),
            threading.Thread(target=initialize, args=("software",)),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

    assert fake.calls == 2
    assert fake.max_active == 2


def test_task_schema_initializes_different_industries_concurrently():
    fake = CountingPool(rows=[(1,), ({"version": tasks.SEED_VERSION},)], delay=0.05)

    def initialize(industry: str):
        config.set_current_industry(industry)
        tasks._ensure_schema()

    with mock.patch.object(tasks, "pool", fake), \
         mock.patch.object(tasks, "_seed_from_config"):
        threads = [
            threading.Thread(target=initialize, args=("consumer",)),
            threading.Thread(target=initialize, args=("software",)),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

    assert fake.calls == 2
    assert fake.max_active == 2
