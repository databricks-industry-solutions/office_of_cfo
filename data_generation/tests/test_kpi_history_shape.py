"""Shape invariants for the reshaped working-capital-days history."""

import statistics
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from kpi_history_shape import shape_days_series  # noqa: E402
from industry_profiles import INDUSTRIES  # noqa: E402

PERIODS = [f"{2024 + (9 + i) // 12}-{(9 + i) % 12 + 1:02d}" for i in range(24)]  # 2024-10 .. 2026-09
ANCHOR = {"dso": 52.3, "dpo": 68.4, "dio": 33.1}
KEYS = [f"{ind}:{st}:{sid}" for ind in INDUSTRIES
        for st, sid in (("consolidated", "ALL"), ("region", "EMEA"), ("region", "APAC"),
                        ("business_unit", "BU-300"), ("legal_entity", "LE-100"))]


def _diffs(xs):
    return [b - a for a, b in zip(xs, xs[1:])]


def _sign_flips(xs, eps=0.05):
    signs = [d > 0 for d in _diffs(xs) if abs(d) > eps]
    return sum(1 for a, b in zip(signs, signs[1:]) if a != b)


def test_periods_fixture_is_contiguous():
    assert PERIODS[0] == "2024-10" and PERIODS[-1] == "2026-09" and len(set(PERIODS)) == 24


@pytest.mark.parametrize("key", KEYS)
def test_last_point_is_the_anchor(key):
    last = shape_days_series(ANCHOR, PERIODS, key)[-1]
    assert last["period"] == PERIODS[-1]
    for m in ("dso", "dpo", "dio"):
        assert last[m] == ANCHOR[m]


@pytest.mark.parametrize("key", KEYS)
def test_ccc_identity_every_period(key):
    for row in shape_days_series(ANCHOR, PERIODS, key):
        assert row["ccc"] == pytest.approx(row["dso"] + row["dio"] - row["dpo"], abs=0.051)


def test_deterministic_per_key_and_distinct_across_keys():
    a = shape_days_series(ANCHOR, PERIODS, KEYS[0])
    assert a == shape_days_series(ANCHOR, PERIODS, KEYS[0])
    assert a != shape_days_series(ANCHOR, PERIODS, KEYS[1])


@pytest.mark.parametrize("key", KEYS)
def test_values_stay_positive(key):
    for row in shape_days_series(ANCHOR, PERIODS, key):
        assert min(row["dso"], row["dpo"], row["dio"]) > 0


@pytest.mark.parametrize("key", KEYS)
def test_not_flipping_direction_every_month(key):
    rows = shape_days_series(ANCHOR, PERIODS, key)
    for m in ("dso", "dpo", "dio", "ccc"):
        assert _sign_flips([r[m] for r in rows]) <= 8, m


@pytest.mark.parametrize("key", KEYS)
def test_has_a_material_event(key):
    rows = shape_days_series(ANCHOR, PERIODS, key)
    ratios = []
    for m in ("dso", "dpo", "dio"):
        d = [abs(x) for x in _diffs([r[m] for r in rows])]
        ratios.append(max(d) / max(statistics.median(d), 0.05))
    assert max(ratios) > 3


def test_non_positive_anchor_is_left_flat():
    rows = shape_days_series({"dso": 0.0, "dpo": 40.0, "dio": 20.0}, PERIODS, KEYS[0])
    assert all(r["dso"] == 0.0 for r in rows)


def test_short_history_has_no_events_but_still_pins():
    rows = shape_days_series(ANCHOR, PERIODS[-6:], KEYS[0])
    assert len(rows) == 6 and rows[-1]["dso"] == ANCHOR["dso"]
