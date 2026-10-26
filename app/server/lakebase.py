"""Lakebase (Autoscaling Postgres) — one database per industry.

Each industry keeps its OLTP state (tasks, adjustments, scenarios) in its own
Postgres database, so state is fully isolated per industry. A ContextVar-driven
router exposes the familiar ``pool`` object whose ``.connection()`` transparently
targets the ACTIVE industry's database, so route code (`pool.connection()`) is
unchanged. A fresh OAuth database credential is minted per connection.

Per-industry settings come from env, each falling back to the shared default in
config.py: ``PGDATABASE_<IND>`` (database), ``PGENDPOINT_<IND>`` (Autoscaling
endpoint, default ``ENDPOINT_NAME``/``LAKEBASE_PROJECT``), ``PGHOST_<IND>`` (default
``PGHOST``, else resolved from the endpoint) and ``PGINSTANCE_<IND>`` (a legacy
provisioned instance name; credentials are then minted against the instance).
The bundle deploys one Autoscaling project with a database per industry, so it
only sets ``LAKEBASE_PROJECT`` and the five ``PGDATABASE_<IND>`` values.
"""
import os
import threading
import time
import uuid
from contextlib import contextmanager

import psycopg
from psycopg_pool import ConnectionPool, PoolTimeout

from .config import (
    LAKEBASE_ENDPOINT, MULTI_INDUSTRY, PGDATABASE, PGHOST, PGPORT,
    current_industry, get_workspace_client, pg_user,
)
from .industry import INSTALLED_INDUSTRIES

# The shared default — used when MULTI_INDUSTRY is off, and as the fallback for
# any per-industry setting that is not overridden.
_BASELINE = {"endpoint": LAKEBASE_ENDPOINT, "host": PGHOST, "db": PGDATABASE, "instance": ""}


def _instance_cfg(industry: str) -> dict[str, str]:
    up = industry.upper()
    return {
        "instance": os.environ.get(f"PGINSTANCE_{up}", ""),
        "endpoint": os.environ.get(f"PGENDPOINT_{up}", _BASELINE["endpoint"]),
        "host": os.environ.get(f"PGHOST_{up}", _BASELINE["host"]),
        "db": os.environ.get(f"PGDATABASE_{up}", _BASELINE["db"]),
    }


_resolved_hosts: dict[str, str] = {}


def _host(cfg: dict[str, str]) -> str:
    """The configured host, else the read/write host of the Autoscaling endpoint
    (looked up once per endpoint and cached for the life of the process)."""
    if cfg.get("host") or not cfg.get("endpoint"):
        return cfg.get("host", "")
    endpoint = cfg["endpoint"]
    if endpoint not in _resolved_hosts:
        ep = get_workspace_client().postgres.get_endpoint(name=endpoint)
        _resolved_hosts[endpoint] = ep.status.hosts.host
    return _resolved_hosts[endpoint]


def _mint_token(cfg: dict[str, str]) -> str:
    """Fresh OAuth DB credential. Provisioned instances use instance_names; the
    baseline autoscale instance uses its endpoint."""
    w = get_workspace_client()
    if cfg.get("instance"):
        cred = w.database.generate_database_credential(
            request_id=str(uuid.uuid4()), instance_names=[cfg["instance"]])
        return cred.token
    return w.postgres.generate_database_credential(endpoint=cfg["endpoint"]).token


def _make_pool(cfg: dict[str, str]) -> ConnectionPool:
    class _OAuthConnection(psycopg.Connection):
        @classmethod
        def connect(cls, conninfo="", **kwargs):
            kwargs["password"] = _mint_token(cfg)
            return super().connect(conninfo, **kwargs)

    return ConnectionPool(
        conninfo=(
            f"dbname={cfg['db']} user={pg_user()} host={_host(cfg)} "
            # connect_timeout is generous enough for a cold provisioned instance's
            # first connection; once warm, connections are fast.
            f"port={PGPORT} sslmode=require connect_timeout=20"
        ),
        connection_class=_OAuthConnection,
        # min_size=0 so an unreachable instance never spins a retry loop; timeout
        # bounds how long a Lakebase-backed endpoint waits before degrading.
        min_size=0, max_size=8, max_lifetime=2700, timeout=25, open=False,
    )


_pools: dict[str, ConnectionPool] = {}
_CIRCUIT_COOLDOWN_SECONDS = 30.0
_circuit_deadline: dict[str, float] = {}
_acquire_locks: dict[str, threading.Lock] = {}
_connection_verified: set[str] = set()
_state_lock = threading.Lock()


class LakebaseCircuitOpen(RuntimeError):
    """Raised immediately while an industry's Lakebase connection is unhealthy."""


def _acquire_lock(industry: str) -> threading.Lock:
    with _state_lock:
        return _acquire_locks.setdefault(industry, threading.Lock())


def _raise_if_circuit_open(industry: str) -> None:
    now = time.monotonic()
    with _state_lock:
        deadline = _circuit_deadline.get(industry)
        if deadline is None:
            return
        if now < deadline:
            raise LakebaseCircuitOpen(f"lakebase circuit open for {industry}")
        _circuit_deadline.pop(industry, None)


def record_failure(industry: str) -> None:
    with _state_lock:
        _circuit_deadline[industry] = time.monotonic() + _CIRCUIT_COOLDOWN_SECONDS


def record_success(industry: str) -> None:
    with _state_lock:
        _circuit_deadline.pop(industry, None)
        _connection_verified.add(industry)


def _is_connectivity_error(exc: BaseException) -> bool:
    if isinstance(exc, (PoolTimeout, psycopg.OperationalError)):
        return True
    message = str(exc).lower()
    return (
        "password authentication failed" in message
        or "couldn't get a connection" in message
        or "connection failed" in message
        or "connection timed out" in message
    )


def _is_verified(industry: str) -> bool:
    with _state_lock:
        return industry in _connection_verified


def _checkout(industry: str, *args, guarded: bool, **kwargs):
    manager = pool_for(industry).connection(*args, **kwargs)
    try:
        conn = manager.__enter__()
    except BaseException as exc:
        if _is_connectivity_error(exc):
            with _state_lock:
                _connection_verified.discard(industry)
            # A single timeout after a proven healthy checkout can be pool
            # saturation. Require the next guarded probe to fail before opening
            # the industry-wide circuit.
            if not (isinstance(exc, PoolTimeout) and not guarded):
                record_failure(industry)
        raise
    record_success(industry)
    return manager, conn


def _key() -> str:
    return current_industry() if MULTI_INDUSTRY else "_baseline"


def pool_for(industry: str) -> ConnectionPool:
    if industry not in _pools:
        cfg = _BASELINE if industry == "_baseline" else _instance_cfg(industry)
        _pools[industry] = _make_pool(cfg)
    p = _pools[industry]
    # open() is idempotent; call it every time so a pool that wasn't ready on a
    # cold first attempt still opens on a later request (no cached-failure state).
    try:
        p.open(wait=False)
    except Exception:  # noqa: BLE001
        pass
    return p


class _PoolRouter:
    """Delegates to the active industry's ConnectionPool so `pool.connection()`
    stays a drop-in for the route code."""

    @contextmanager
    def connection(self, *args, **kwargs):
        industry = _key()
        manager = None
        conn = None
        if _is_verified(industry):
            _raise_if_circuit_open(industry)
            manager, conn = _checkout(industry, *args, guarded=False, **kwargs)
        else:
            # Serialize the first/unhealthy checkout only. Once an industry has
            # connected successfully, healthy pool checkouts remain concurrent.
            with _acquire_lock(industry):
                _raise_if_circuit_open(industry)
                if not _is_verified(industry):
                    manager, conn = _checkout(industry, *args, guarded=True, **kwargs)
            if manager is None:
                manager, conn = _checkout(industry, *args, guarded=False, **kwargs)
        try:
            yield conn
        except BaseException as exc:
            if not manager.__exit__(type(exc), exc, exc.__traceback__):
                raise
        else:
            manager.__exit__(None, None, None)

    def open(self, *args, **kwargs):
        # Best-effort open of every industry's pool at startup; never blocks the
        # app if an instance isn't ready yet (Lakebase-backed endpoints degrade).
        keys = list(INSTALLED_INDUSTRIES) if MULTI_INDUSTRY else ["_baseline"]
        for k in keys:
            try:
                pool_for(k)
            except Exception as e:  # noqa: BLE001
                print(f"[lakebase] pool for {k} not ready: {e}")

    def close(self, *args, **kwargs):
        for p in _pools.values():
            try:
                p.close(*args, **kwargs)
            except Exception:  # noqa: BLE001
                pass


pool = _PoolRouter()
