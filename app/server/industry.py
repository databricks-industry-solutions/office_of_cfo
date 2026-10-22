"""Shared industry resolver for the multi-industry app.

The frontend sends the active industry on every request via the `X-Industry`
header (see api.ts). The backend uses it to (a) pick the industry's own Unity
Catalog schema set + Lakebase instance (see config.py / lakebase.py) and (b)
localize hardcoded display labels (source systems, concentration nouns).

Five first-class industries, each with its own data. `retail` is accepted as a
back-compat alias for `consumer` (the reframed former retail overlay).
"""
from __future__ import annotations

import os

INDUSTRIES = ("consumer", "software", "fsi", "energy", "capmarkets")

# The industries this deployment installed (CFO_INDUSTRIES, comma-separated, set
# from setup.py --industries). Unset or empty means all of them. Order follows
# INDUSTRIES so the default and the switcher order do not depend on how the list
# was typed.
_requested = {i.strip().lower() for i in os.environ.get("CFO_INDUSTRIES", "").split(",") if i.strip()}
INSTALLED_INDUSTRIES = tuple(i for i in INDUSTRIES if i in _requested) or INDUSTRIES
DEFAULT_INDUSTRY = INSTALLED_INDUSTRIES[0]

# Back-compat: a persisted/stored "retail" maps to the reframed "consumer".
_ALIASES = {"retail": "consumer"}


def resolve_industry(x_industry: str | None) -> str:
    """Normalize the X-Industry header to an installed industry (default: the
    first installed). An industry that was not installed has no schemas, so a
    stale browser selection falls back instead of querying tables that are not
    there."""
    v = (x_industry or "").strip().lower()
    v = _ALIASES.get(v, v)
    return v if v in INSTALLED_INDUSTRIES else DEFAULT_INDUSTRY
