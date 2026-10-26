"""Shared test setup for the server suite."""
from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _ml_forecast_off(monkeypatch):
    """The ML revenue forecast is on by default in the app and queries the warehouse.
    Keep the suite warehouse-free: tests that exercise it opt in explicitly."""
    monkeypatch.setenv("SCENARIO_ML_FORECAST", "0")


@pytest.fixture(autouse=True)
def _ml_forecast_cache_clear():
    """The ML forecast caches per process; don't let one test's result leak into another."""
    from server import ml_forecast
    ml_forecast._cache.clear()
    yield
    ml_forecast._cache.clear()
