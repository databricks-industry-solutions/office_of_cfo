"""Read-only access to the governed Unity Catalog serving/DQ tables via DBSQL."""
import os
import time

from .config import WAREHOUSE_ID, get_workspace_client

# Small in-process TTL cache for read (SELECT/WITH) statements. The serving/DQ
# tables only change at close time — or when an adjustment flows to the lake,
# which calls invalidate_cache() — so caching identical SELECTs for a short
# window collapses the many per-page-load warehouse round-trips into one and
# makes repeat loads / scope switches instant. Writes (INSERT/DDL) are never
# cached. Set QUERY_CACHE_TTL=0 to disable.
_CACHE_TTL = float(os.environ.get("QUERY_CACHE_TTL", "60"))
_cache: dict[str, tuple[float, list[dict]]] = {}

# Monotonic version bumped on every invalidation. Consumers (e.g. the derived
# task sync) can cheaply detect "governed data may have changed since I last
# looked" by comparing this counter, instead of re-doing work on every request.
_cache_version = 0


def cache_version() -> int:
    """Current invalidation version (increments whenever the cache is cleared)."""
    return _cache_version


def invalidate_cache() -> None:
    """Drop all cached query results (call after a write flows to the lake)."""
    global _cache_version
    _cache.clear()
    _cache_version += 1


def _cacheable(sql: str) -> bool:
    head = sql.lstrip().lstrip("(").lstrip()[:8].upper()
    return head.startswith("SELECT") or head.startswith("WITH")


def query(sql: str, use_cache: bool = True) -> list[dict]:
    cacheable = use_cache and _CACHE_TTL > 0 and _cacheable(sql)
    if cacheable:
        hit = _cache.get(sql)
        if hit and (time.monotonic() - hit[0]) < _CACHE_TTL:
            return hit[1]
    # SELECTs are idempotent, so retry transient failures (e.g. intermittent DNS
    # / connection blips to the workspace when many requests fire at once, as on
    # a fresh page load). Writes are not retried to avoid duplicate side effects.
    rows = _execute(sql, retries=3 if cacheable else 0)
    if cacheable:
        _cache[sql] = (time.monotonic(), rows)
    return rows


def _execute(sql: str, retries: int = 0) -> list[dict]:
    last_err: Exception | None = None
    for attempt in range(retries + 1):
        try:
            return _run(sql)
        except Exception as e:  # noqa: BLE001 — transient network/DNS/session blips
            last_err = e
            if attempt < retries:
                time.sleep(0.2 * (attempt + 1))
    raise last_err  # type: ignore[misc]


def _run(sql: str) -> list[dict]:
    w = get_workspace_client()
    resp = w.statement_execution.execute_statement(
        statement=sql, warehouse_id=WAREHOUSE_ID, wait_timeout="50s")
    state = resp.status.state.value if resp.status and resp.status.state else "UNKNOWN"
    if state != "SUCCEEDED":
        err = resp.status.error.message if resp.status and resp.status.error else state
        raise RuntimeError(f"Query failed ({state}): {err}")
    if not resp.manifest or not resp.manifest.schema or not resp.manifest.schema.columns:
        return []
    cols = [c.name for c in resp.manifest.schema.columns]
    data = resp.result.data_array if resp.result and resp.result.data_array else []
    return [dict(zip(cols, row)) for row in data]
