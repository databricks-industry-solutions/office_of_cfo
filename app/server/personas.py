"""Persona hierarchy + org tree + scope resolution for the Office of the CFO app.

Personas are a demo "view as" control (no enforced RBAC): each persona has a set
of visible pages, a default landing page, and an org-scope model. The org tree
mirrors the governed `dim_org` dimension (kept in sync with data_generation) so
scope resolution needs no warehouse round-trip.

`scope_clause()` turns a (scope_type, scope_id) selection into a safe SQL filter
fragment against whatever dimensional columns a given view exposes; scope_id is
validated against the known org values, so unknown/spoofed values simply yield
no filter rather than an injection surface.
"""
from __future__ import annotations

# Org hierarchy — mirrors data_generation/generate_close_data.py BU_META / dim_org.
ORG = [
    {"business_unit_id": "BU-100", "business_unit_name": "North America", "region": "AMER",
     "country": "United States", "legal_entity_id": "LE-US",
     "legal_entity_name": "Northwind Inc. (US)", "primary_source_system": "SAP"},
    {"business_unit_id": "BU-200", "business_unit_name": "EMEA", "region": "EMEA",
     "country": "Netherlands", "legal_entity_id": "LE-NL",
     "legal_entity_name": "Northwind Europe B.V. (NL)", "primary_source_system": "AFAS"},
    {"business_unit_id": "BU-300", "business_unit_name": "APAC", "region": "APAC",
     "country": "Singapore", "legal_entity_id": "LE-SG",
     "legal_entity_name": "Northwind APAC Pte. Ltd. (SG)", "primary_source_system": "SAP"},
    {"business_unit_id": "BU-400", "business_unit_name": "LATAM", "region": "AMER",
     "country": "Brazil", "legal_entity_id": "LE-BR",
     "legal_entity_name": "Northwind LATAM Ltda. (BR)", "primary_source_system": "SAP"},
    {"business_unit_id": "BU-900", "business_unit_name": "Corporate", "region": "GLOBAL",
     "country": "United States", "legal_entity_id": "LE-CORP",
     "legal_entity_name": "Northwind Global Corp.", "primary_source_system": "SAP"},
]

BUSINESS_LINES = ["Products", "Services", "Shared Services"]

# Valid scope values per scope_type (drives validation + the scope picker).
_VALID = {
    "consolidated": {"ALL"},
    "region": {o["region"] for o in ORG},
    "legal_entity": {o["legal_entity_id"] for o in ORG},
    "business_unit": {o["business_unit_id"] for o in ORG},
    "business_line": set(BUSINESS_LINES),
}

# Persona definitions: which pages each sees, their default landing, and whether
# they pick an org scope. Access is scoped by data (view-as), not enforced auth.
PERSONAS = [
    {
        "id": "cfo",
        "label": "CFO",
        "title": "Chief Financial Officer",
        "description": "Ultimate aggregator. Consolidated KPIs across every geography and "
                       "business line, read-only, with drill-down and self-service Q&A.",
        "default_page": "executive",
        "pages": ["executive", "dashboard", "trial-balance", "financial-statements",
                  "comparative-statements", "approvals", "market-insights", "scenario-planning",
                  "cash-flow", "historical-insights", "adhoc-analysis", "payment-behavior",
                  "close-support-2", "data-sources",
                  "ai-roi-executive", "ai-roi-spend", "ai-roi-roi",
                  "ai-roi-org", "ai-roi-efficiency", "settings"],
        "scope_type": "consolidated",
        "scope_locked": True,
        "can_post": False,
        "can_approve": False,
        "can_sign_off": True,
    },
    {
        "id": "controller",
        "label": "Controller",
        "title": "Regional / Business-Line Controller",
        "description": "Aggregate-level manager for a geography or business line. KPIs, close "
                       "readiness, variance analysis and the team's tasks — scoped to their org node.",
        "default_page": "dashboard",
        "pages": ["executive", "dashboard", "tasks", "trial-balance",
                  "reconciliation", "financial-statements", "comparative-statements",
                  "approvals", "stress-test", "market-insights", "scenario-planning", "cash-flow", "exposure",
                  "inventory-exposure", "historical-insights", "adhoc-analysis", "payment-behavior",
                  "data-sources", "ai-roi-executive", "ai-roi-spend", "ai-roi-roi",
                  "ai-roi-org", "ai-roi-efficiency", "settings"],
        "scope_type": "region",
        "scope_default": "EMEA",
        "scope_locked": False,
        "can_post": True,
        "can_approve": True,
        "can_sign_off": False,
    },
    {
        "id": "accountant",
        "label": "Accountant",
        "title": "Accountant (IC / transactional)",
        "description": "Transactional workbench: investigate variances, clear data-quality "
                       "issues, post correcting entries and work assigned close tasks.",
        "default_page": "tasks",
        "default_query": "view=calendar",
        "pages": ["reconciliation", "financial-statements", "trial-balance", "tasks", "data-sources", "settings"],
        "scope_type": "business_unit",
        "scope_default": "BU-100",
        "scope_locked": False,
        "can_post": True,
        "can_approve": False,
        "can_sign_off": False,
    },
]


def personas() -> list[dict]:
    return PERSONAS


def get_persona(pid: str | None) -> dict | None:
    return next((p for p in PERSONAS if p["id"] == pid), None)


def can(pid: str | None, capability: str) -> bool:
    """True when the persona holds the given capability (can_post/can_approve/can_sign_off)."""
    p = get_persona(pid)
    return bool(p and p.get(capability))


def persona_label(pid: str | None) -> str:
    p = get_persona(pid)
    return p["label"] if p else "Unknown"


def _org_units() -> list[dict]:
    """The org rows for the ACTIVE industry.

    Persona roster, permissions and scope *types* are identical across every
    industry — only the concrete org (display names + business lines) differs. We
    read it from the active industry's governed `dim_org` (relabeled per industry
    during seeding); the BU/region/legal-entity *ids* are stable, so scope
    defaults and validation stay valid everywhere. Falls back to the static
    baseline ORG if the warehouse is unreachable."""
    try:
        from .config import CLOSE_FQ
        from .warehouse import query
        rows = query(
            f"SELECT business_unit_id, business_unit_name, region, country, "
            f"legal_entity_id, legal_entity_name, primary_source_system "
            f"FROM {CLOSE_FQ}.dim_org ORDER BY business_unit_id")
        return rows or ORG
    except Exception:  # noqa: BLE001
        return ORG


def _business_lines() -> list[str]:
    """Distinct business lines for the active industry (falls back to baseline)."""
    try:
        from .config import CLOSE_FQ
        from .warehouse import query
        rows = query(
            f"SELECT DISTINCT business_line FROM {CLOSE_FQ}.gl_journal_entries "
            f"WHERE business_line IS NOT NULL ORDER BY business_line")
        vals = [r["business_line"] for r in rows if r.get("business_line")]
        return vals or BUSINESS_LINES
    except Exception:  # noqa: BLE001
        return BUSINESS_LINES


def org_tree() -> dict:
    """Structured org hierarchy for the scope picker (active industry): regions ->
    legal entities -> BUs."""
    units = _org_units()
    regions: dict[str, dict] = {}
    for o in units:
        r = regions.setdefault(o["region"], {"region": o["region"], "legal_entities": {}})
        le = r["legal_entities"].setdefault(
            o["legal_entity_id"],
            {"legal_entity_id": o["legal_entity_id"], "legal_entity_name": o["legal_entity_name"],
             "country": o["country"], "business_units": []})
        le["business_units"].append({
            "business_unit_id": o["business_unit_id"],
            "business_unit_name": o["business_unit_name"],
            "primary_source_system": o["primary_source_system"],
        })
    return {
        "regions": [
            {"region": r["region"], "legal_entities": list(r["legal_entities"].values())}
            for r in regions.values()
        ],
        "business_lines": _business_lines(),
        "units": units,
    }


def is_valid_scope(scope_type: str | None, scope_id: str | None) -> bool:
    if not scope_type or scope_type == "consolidated":
        return True
    return scope_id in _VALID.get(scope_type, set())


def scope_business_units(scope_type: str | None, scope_id: str | None) -> list[str] | None:
    """Business units in scope, or None for 'no restriction' (consolidated / business_line)."""
    if not scope_type or scope_type == "consolidated" or not is_valid_scope(scope_type, scope_id):
        return None
    if scope_type == "business_unit":
        return [scope_id]
    if scope_type == "region":
        return [o["business_unit_id"] for o in ORG if o["region"] == scope_id]
    if scope_type == "legal_entity":
        return [o["business_unit_id"] for o in ORG if o["legal_entity_id"] == scope_id]
    if scope_type == "business_line":
        return None  # a posting-level cut, not a BU set
    return None


def scope_clause(scope_type: str | None, scope_id: str | None, cols: dict[str, str],
                 prefix: str = " AND ") -> str:
    """Return a safe SQL fragment filtering `cols` to the scope, or "" for none.

    `cols` maps logical dimensions to the actual column name in the target view,
    e.g. {"region": "region", "legal_entity": "legal_entity_id",
          "business_unit": "business_unit_id", "business_line": "business_line"}.
    """
    if not scope_type or scope_type == "consolidated" or not is_valid_scope(scope_type, scope_id):
        return ""
    col = cols.get(scope_type)
    if not col:
        return ""
    # scope_id is validated against the known enum above, so this is injection-safe.
    return f"{prefix}{col} = '{scope_id}'"
