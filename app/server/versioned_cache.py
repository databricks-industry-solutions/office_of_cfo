"""Small process-local cache for expensive derived read responses.

Entries expire by TTL and whenever the governed warehouse cache is invalidated.
Per-key locks collapse concurrent misses so identical AI requests execute once.
"""
from __future__ import annotations

import threading
import time
from collections.abc import Callable, Hashable
from typing import Generic, TypeVar

T = TypeVar("T")


class VersionedTTLCache(Generic[T]):
    def __init__(self, ttl_seconds: float, version: Callable[[], int]):
        self._ttl = ttl_seconds
        self._version = version
        self._entries: dict[Hashable, tuple[float, int, T]] = {}
        self._locks: dict[Hashable, threading.Lock] = {}
        self._locks_guard = threading.Lock()

    def _get(self, key: Hashable) -> T | None:
        if self._ttl <= 0:
            return None
        hit = self._entries.get(key)
        if (
            hit is not None
            and hit[1] == self._version()
            and time.monotonic() - hit[0] < self._ttl
        ):
            return hit[2]
        return None

    def _lock_for(self, key: Hashable) -> threading.Lock:
        with self._locks_guard:
            return self._locks.setdefault(key, threading.Lock())

    def get_or_compute(
        self,
        key: Hashable,
        compute: Callable[[], T],
        *,
        cache_when: Callable[[T], bool] = lambda _value: True,
    ) -> T:
        cached = self._get(key)
        if cached is not None:
            return cached
        with self._lock_for(key):
            cached = self._get(key)
            if cached is not None:
                return cached
            version_before = self._version()
            value = compute()
            # A write may invalidate governed data while a slow computation is
            # running. Never stamp that now-stale result with the newer version.
            if (
                self._ttl > 0
                and self._version() == version_before
                and cache_when(value)
            ):
                self._entries[key] = (time.monotonic(), version_before, value)
            return value

    def clear(self) -> None:
        """Clear entries explicitly (primarily useful for isolated tests)."""
        self._entries.clear()
