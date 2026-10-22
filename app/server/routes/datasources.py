"""Source-system integration map (Item 3).

Shows how each finance domain (GL, AR, AP, Bank, Inventory, Product Costs, Sales
Orders, Fixed Assets, Procurement, Payroll, Staff Expenses) is fed from a named
source system (SAP / Workday / AFAS / Bank Feed) into the governed lakehouse,
with live coverage (row counts + freshness) read from the governed tables.
"""
from fastapi import APIRouter, Header

from ..config import CLOSE_FQ
from ..industry import resolve_industry
from ..personas import ORG
from ..warehouse import query

router = APIRouter()

CLOSE = CLOSE_FQ

# Per-industry source-system relabeling. The governed tables and row counts are
# unchanged — only the named source system shown in the UI is localized so the
# integration story reads right for each vertical (cosmetic).
SOURCE_SYSTEM_OVERRIDES: dict[str, dict[str, str]] = {
    "consumer": {
        "SAP / AFAS": "SAP S/4HANA",
        "SAP": "SAP S/4HANA",
        "Bank Feed": "Bank Feed",
        "CRM": "Salesforce",
        "Planning": "Anaplan",
    },
    "software": {
        "SAP / AFAS": "NetSuite",
        "SAP": "NetSuite",
        "Bank Feed": "Stripe / Bank Feed",
        "CRM": "Salesforce",
        "Planning": "Adaptive Planning",
    },
    "fsi": {
        "SAP / AFAS": "Core Banking (FIS)",
        "SAP": "Core Banking (FIS)",
        "CRM": "Salesforce Financial Services",
        "Planning": "Anaplan",
    },
    "capmarkets": {
        "SAP / AFAS": "Finance ERP / Trade Capture",
        "SAP": "Finance ERP (SAP S/4HANA)",
        "Bank Feed": "Clearing & Prime Broker Feed",
        "CRM": "Salesforce",
        "Planning": "Anaplan",
    },
    "energy": {
        "SAP / AFAS": "SAP S/4HANA Utilities",
        "SAP": "SAP S/4HANA Utilities",
        "Bank Feed": "Bank Feed",
        "CRM": "Salesforce",
        "Planning": "Anaplan",
    },
}

# (domain, source_system, governed table, order in the finance value chain, note)
DOMAINS = [
    ("General Ledger", "SAP / AFAS", "gl_journal_entries", "Record to Report",
     "Balanced journal entries from every ERP; AFAS feeds the NL legal entity."),
    ("Accounts Receivable", "SAP / AFAS", "subledger_ar", "Order to Cash",
     "Customer invoices — the money-in subledger behind DSO."),
    ("Sales Orders", "CRM", "subledger_sales_orders", "Order to Cash",
     "Order-to-cash upstream of AR / revenue."),
    ("Accounts Payable", "SAP / AFAS", "subledger_ap", "Procure to Pay",
     "Vendor invoices — the money-out subledger behind DPO."),
    ("Procurement", "SAP", "subledger_procurement", "Procure to Pay",
     "Purchase orders; 3-way matched against AP invoices."),
    ("Inventory", "SAP", "subledger_inventory", "Inventory & Cost",
     "On-hand value behind DIO."),
    ("Product Costs", "SAP", "subledger_inventory", "Inventory & Cost",
     "Standard unit costs feeding COGS."),
    ("Fixed Assets", "SAP", "subledger_fixed_assets", "Record to Report",
     "Asset register and monthly depreciation."),
    ("Bank Accounts", "Bank Feed", "subledger_bank", "Treasury & Cash",
     "Bank statement balances reconciled to GL cash."),
    ("Payroll", "Workday", "subledger_payroll", "Hire to Retire",
     "Payroll runs posted to payroll liabilities."),
    ("Staff Expenses", "Workday", "subledger_staff_expenses", "Hire to Retire",
     "Employee travel & expense claims."),
]

# End-to-end lineage the app can render alongside the map.
VALUE_CHAINS = [
    {"name": "Order to Cash", "flow": ["Sales Orders", "Accounts Receivable", "General Ledger"]},
    {"name": "Procure to Pay", "flow": ["Procurement", "Accounts Payable", "General Ledger"]},
    {"name": "Inventory & Cost", "flow": ["Inventory", "Product Costs", "General Ledger"]},
    {"name": "Hire to Retire", "flow": ["Payroll", "Staff Expenses", "General Ledger"]},
    {"name": "Treasury & Cash", "flow": ["Bank Accounts", "General Ledger"]},
]


# Which regions each source-system token feeds, from ORG.primary_source_system.
# Used to highlight the feeds relevant to a scoped controller (e.g. EMEA → AFAS).
# Global feeds (Workday payroll, Bank Feed) have no token match → empty = all-regions.
_SYSTEM_REGIONS: dict[str, set[str]] = {}
for _o in ORG:
    _SYSTEM_REGIONS.setdefault(_o["primary_source_system"], set()).add(_o["region"])


def _domain_regions(base_source: str) -> list[str]:
    """Regions a domain's (pre-relabel) source system feeds; [] means global/all."""
    regions: set[str] = set()
    for token in (t.strip() for t in base_source.split("/")):
        regions |= _SYSTEM_REGIONS.get(token, set())
    return sorted(regions)


def _coverage() -> dict:
    """Row count + last load + dominant source system per governed table (empty if
    warehouse unreachable). The source system is read from the DATA (each feed is
    stamped with its relabeled system), so the map reflects each industry's own
    source systems (e.g. SAP IS-U / ETRM for energy, NetSuite for software)."""
    tables = sorted({d[2] for d in DOMAINS})
    union = " UNION ALL ".join(
        f"SELECT '{t}' AS tbl, COUNT(*) AS n, MAX(load_ts) AS last_load, "
        f"source_system AS src FROM {CLOSE}.{t} GROUP BY source_system"
        for t in tables)
    try:
        rows = query(union)
    except Exception:  # noqa: BLE001
        return {}
    out: dict[str, dict] = {}
    for r in rows:
        t = r["tbl"]
        n = int(r["n"]) if r.get("n") is not None else 0
        agg = out.setdefault(t, {"row_count": 0, "last_load": None, "_srcs": {}})
        agg["row_count"] += n
        if r.get("last_load"):
            agg["last_load"] = max(agg["last_load"] or r["last_load"], r["last_load"])
        if r.get("src"):
            agg["_srcs"][r["src"]] = agg["_srcs"].get(r["src"], 0) + n
    for agg in out.values():
        srcs = agg.pop("_srcs", {})
        agg["source_system"] = max(srcs, key=srcs.get) if srcs else None
        if not agg["row_count"]:
            agg["row_count"] = None
    return out


@router.get("/source-systems")
def source_systems(x_industry: str | None = Header(default=None)):
    industry = resolve_industry(x_industry)
    remap = SOURCE_SYSTEM_OVERRIDES.get(industry, {})
    cov = _coverage()
    domains = []
    for domain, src, table, chain, note in DOMAINS:
        c = cov.get(table, {})
        # Prefer the actual (relabeled) source system stamped in the data; fall
        # back to the static domain token + per-industry override.
        src_label = c.get("source_system") or remap.get(src, src)
        domains.append({
            "domain": domain,
            "source_system": src_label,
            "table": table,
            "value_chain": chain,
            "note": note,
            "status": "live" if c.get("row_count") else ("empty" if cov else "configured"),
            "row_count": c.get("row_count"),
            "last_load": c.get("last_load"),
            "regions": _domain_regions(src),
        })
    systems = sorted({d["source_system"] for d in domains})
    return {"domains": domains, "value_chains": VALUE_CHAINS, "systems": systems}
