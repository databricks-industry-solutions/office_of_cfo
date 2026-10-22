"""Believable monthly working-capital-days history (DSO / DPO / DIO / CCC).

The baseline generator draws every month's GL independently, so its days ratios
are noise around a level and flip direction almost every month. This module
replaces the *historical* months with a series a CFO would recognise:

  * a slow drift into the current level (direction of travel),
  * mild annual seasonality (year-end inventory build, year-end billing),
  * low, autocorrelated, lightly averaged noise (consecutive months move together),
  * one or two material events per scope (late-paying customer, inventory
    build, tighter supplier terms) -- the sharp moves worth acting on.

The last period is pinned to the anchor (the active close) so current-month
KPIs are unchanged. Pure + deterministic per key: no I/O, stdlib only.
"""
from __future__ import annotations

import hashlib
import math
import random

METRICS = ("dso", "dpo", "dio")

# Seasonal amplitude (fraction of level) and the calendar month it peaks in.
_SEASON = {"dio": (0.035, 10.5), "dso": (0.02, 12.0), "dpo": (0.01, 12.0)}
_NOISE_PHI = 0.6
_NOISE_SIGMA = 0.005
_NOISE_WINDOW = 3

# Event catalog: (metric, kind). Magnitudes / durations are drawn per scope.
_EVENTS = (("dso", "spike"), ("dio", "build"), ("dpo", "squeeze"))


def _rng(key: str) -> random.Random:
    return random.Random(int(hashlib.md5(key.encode()).hexdigest(), 16) % (2 ** 32))


def _event_bumps(n: int, key: str) -> dict[str, list[float]]:
    """Additive multiplier bumps per metric from 1-2 deterministic events."""
    bumps = {m: [0.0] * n for m in METRICS}
    if n < 16:
        return bumps
    r = _rng(f"{key}:events")
    chosen = r.sample(_EVENTS, r.choice((1, 2)))
    for metric, kind in chosen:
        b = bumps[metric]
        if kind == "spike":
            # A key customer pays late: sharp jump, then collections recover.
            a = r.uniform(0.12, 0.18)
            t0 = r.randint(3, n - 5)
            for j, f in enumerate((1.0, 0.55, 0.25)):
                b[t0 + j] += a * f
        elif kind == "build":
            # Inventory build: steps up, holds, then eases back.
            a = r.uniform(0.08, 0.12)
            hold = r.randint(3, 5)
            t0 = r.randint(3, n - 4 - hold - 2)
            for j in range(hold):
                b[t0 + j] += a
            b[t0 + hold] += a * 0.5
            b[t0 + hold + 1] += a * 0.2
        else:
            # Supplier terms tightened: DPO drops and stays down.
            a = r.uniform(0.08, 0.12)
            t0 = r.randint(3, n - 4)
            for t in range(t0, n):
                b[t] -= a
    return bumps


def _shape_metric(anchor: float, metric: str, periods: list[str], key: str,
                  bump: list[float]) -> list[float]:
    n = len(periods)
    if anchor <= 0 or n < 2:
        return [anchor] * n
    r = _rng(f"{key}:{metric}")
    start = 1.0 + r.choice((-1, 1)) * r.uniform(0.03, 0.08)
    amp, peak = _SEASON[metric]
    peak += r.uniform(-1.0, 1.0)
    ar, recent = 0.0, []
    raw = []
    for i, p in enumerate(periods):
        month = int(p[5:7])
        drift = start + (1.0 - start) * i / (n - 1)
        season = amp * math.cos(2 * math.pi * (month - peak) / 12.0)
        ar = _NOISE_PHI * ar + r.gauss(0.0, _NOISE_SIGMA)
        recent = (recent + [ar])[-_NOISE_WINDOW:]
        noise = sum(recent) / len(recent)
        raw.append(max(0.05, drift + season + noise + bump[i]))
    # Rescale so the active close lands exactly on the anchor.
    return [anchor * v / raw[-1] for v in raw]


def shape_days_series(anchor: dict[str, float], periods: list[str], key: str) -> list[dict]:
    """Per-period {dso, dpo, dio, ccc}; last period == anchor exactly; ccc = dso + dio - dpo."""
    bumps = _event_bumps(len(periods), key)
    series = {m: _shape_metric(float(anchor[m]), m, periods, key, bumps[m]) for m in METRICS}
    out = []
    for i, p in enumerate(periods):
        last = i == len(periods) - 1
        vals = {m: (float(anchor[m]) if last else round(series[m][i], 1)) for m in METRICS}
        vals["ccc"] = round(vals["dso"] + vals["dio"] - vals["dpo"], 1)
        out.append({"period": p, **vals})
    return out
