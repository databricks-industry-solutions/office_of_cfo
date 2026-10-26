"""Generate synthetic month-end close data for "The Self-Healing Close" demo.

Vertical-neutral by design. Produces:
  ERP feeds (parquet, -> output/landing/), each stamped with a named source
  system (SAP / Workday / AFAS / Bank Feed) so the "many systems -> one governed
  lakehouse" integration story is concrete:
    - dim_org                  org hierarchy (region -> country -> legal entity -> BU)
    - chart_of_accounts        vertical-neutral COA with control accounts + account_group
    - gl_journal_entries       balanced journal entries for the period (tagged business_line)
    - subledger_ap / ar / payroll / fixed_assets       transaction detail
    - subledger_inventory      product costs + on-hand value (SAP) -> real DIO
    - subledger_sales_orders   order-to-cash upstream of AR (SAP)   -> feeds DSO story
    - subledger_procurement    procure-to-pay purchase orders (SAP) -> feeds DPO story
    - subledger_bank           bank statement balances (Bank Feed)  -> cash/bank rec
    - subledger_staff_expenses employee T&E claims (Workday)
    - budget_forecast          IS forecast by account x BU for the close period
    - kpi_history              trailing monthly DSO/DPO/DIO/CCC snapshots per scope
  Close-folder spreadsheets (CSV, -> output/close_folder/):
    - accruals / reclasses / intercompany / fx_overlays   manual adjustments
      (these simulate the SharePoint "Month-End Close" folder)

Deliberately seeded issues (the heart of the demo):
  1. Subledger-to-GL break (AP timing difference)  -> residual recon breaks (Act 4)
  2. Debits != credits in one source batch          -> DQ validity failure
  3. Orphan account_id in one AP invoice            -> DQ referential-integrity failure
  4. Stale feed load timestamp (fixed assets)       -> DQ freshness failure
  5. Renamed column in the accruals spreadsheet     -> schema evolution + ZeroOps (Act 2)
  6. Inventory-to-GL break (missed COGS posting)    -> new recon break (Inventory)
  7. Bank-to-GL timing break (deposit in transit)   -> new recon break (Bank)
  8. PO-to-invoice 3-way-match mismatch             -> procurement DQ check
  9. Ingestion rejects (schema, duplicate, timeout) -> lineage/data-quality Sankey

Everything is deterministic (seed=42). No Databricks dependency here -- this
script only writes local files. Use load_to_uc.py to land them in Unity Catalog.
"""
from __future__ import annotations

import hashlib
from datetime import datetime, timedelta

import numpy as np
import pandas as pd

from _common import CLOSE_FOLDER_OUT, CLOSE_PERIOD, HISTORY_MONTHS, LANDING_OUT, ensure_output_dirs
from opex_forecast_shape import OPEX_FORECAST_FACTORS

SEED = 42

# --- Period context (mutable) ------------------------------------------------
# The generator produces HISTORY_MONTHS trailing months. These module globals
# describe the period currently being generated and are reassigned by
# `_set_period()` on each loop iteration. `SCALE` scales the transactional
# magnitudes for historical months (older = smaller, plus seasonality) so the
# 24-month history has genuine trend + shape; the active close (CLOSE_PERIOD)
# always uses SCALE == 1.0 and the original seed so its numbers and seeded
# demo issues are preserved exactly.
PERIOD = CLOSE_PERIOD                      # "2026-06" (reassigned per period)
PERIOD_START = datetime.strptime(PERIOD + "-01", "%Y-%m-%d")
_next_month = (PERIOD_START.replace(day=28) + timedelta(days=4)).replace(day=1)
PERIOD_END = _next_month - timedelta(days=1)
DAYS_IN_PERIOD = (PERIOD_END - PERIOD_START).days + 1
LOAD_TS = datetime(PERIOD_END.year, PERIOD_END.month, PERIOD_END.day, 23, 0, 0)
SCALE = 1.0
rng = np.random.default_rng(SEED)


def _period_bounds(period: str):
    start = datetime.strptime(period + "-01", "%Y-%m-%d")
    nxt = (start.replace(day=28) + timedelta(days=4)).replace(day=1)
    end = nxt - timedelta(days=1)
    days = (end - start).days + 1
    load = datetime(end.year, end.month, end.day, 23, 0, 0)
    return start, end, days, load


def _months_between(period: str, end: str) -> int:
    y1, m1 = int(period[:4]), int(period[5:7])
    y2, m2 = int(end[:4]), int(end[5:7])
    return (y2 - y1) * 12 + (m2 - m1)


def _period_scale(period: str) -> float:
    """Deterministic per-period magnitude factor. The active close is 1.0;
    older months are modestly smaller (gentle growth toward the present) with a
    seasonal ripple so revenue/opex/net trends have organic shape."""
    if period == CLOSE_PERIOD:
        return 1.0
    k = _months_between(period, CLOSE_PERIOD)          # >=1 going back
    month = int(period[5:7])
    growth = (1.0 - 0.012) ** k                        # ~1.2%/month
    season = (1.0 + 0.05 * np.sin((month / 12.0) * 2 * np.pi)
              + 0.03 * np.sin((month / 6.0) * 2 * np.pi + 0.9))
    return float(growth * season)


def _set_period(period: str) -> None:
    """Point the module period-context globals at `period` and reseed the RNG.
    The active close reuses SEED so it is byte-identical to the single-period
    baseline; historical months get their own deterministic (period-hashed)
    stream so they are stable across runs and independent of each other."""
    global PERIOD, PERIOD_START, PERIOD_END, DAYS_IN_PERIOD, LOAD_TS, SCALE, rng
    PERIOD = period
    PERIOD_START, PERIOD_END, DAYS_IN_PERIOD, LOAD_TS = _period_bounds(period)
    SCALE = _period_scale(period)
    seed = SEED if period == CLOSE_PERIOD else (
        int(hashlib.md5(period.encode()).hexdigest(), 16) % (2 ** 32))
    rng = np.random.default_rng(seed)


# --- Counterparty payment behaviour ------------------------------------------
# Every vendor / customer has a persistent, deterministic payment profile so the
# 24-month history builds a real "usually pays late / early" baseline that is
# stable across regens and survives the per-industry name relabel (profiles are
# keyed by the stable baseline name; the relabel only swaps the display string).
# All draws here use dedicated hash-seeded RNGs, NOT the global `rng`, so adding
# payment fields leaves every other feed (amounts, KPIs, statements) untouched.
ACTIVE_CLOSE_END = _period_bounds(CLOSE_PERIOD)[1]
_CP_PROFILE_CACHE: dict[str, tuple[int, str, float, float]] = {}


def _cp_profile(name: str) -> tuple[int, str, float, float]:
    """(payment_terms, category, days_vs_terms_mean, days_vs_terms_sigma)."""
    cached = _CP_PROFILE_CACHE.get(name)
    if cached is not None:
        return cached
    r = np.random.default_rng(int(hashlib.md5(name.encode()).hexdigest(), 16) % (2 ** 32))
    terms = int(r.choice([30, 45, 60]))
    roll = float(r.random())
    if roll < 0.28:
        cat, mean = "early", float(r.uniform(-9.0, -3.0))
    elif roll < 0.62:
        cat, mean = "prompt", float(r.uniform(-1.5, 3.0))
    else:
        cat, mean = "late", float(r.uniform(6.0, 16.0))
    sigma = float(r.uniform(2.0, 5.0))
    v = (terms, cat, mean, sigma)
    _CP_PROFILE_CACHE[name] = v
    return v


def _settle(invoice_id: str, inv_date: datetime, terms: int, mean: float, sigma: float):
    """Deterministic (due_date, paid_date) for an invoice. paid_date is the
    eventual settlement date; the serving layer decides 'paid as of period X' by
    comparing paid_date to that period's close date."""
    r = np.random.default_rng(int(hashlib.md5(invoice_id.encode()).hexdigest(), 16) % (2 ** 32))
    dvt = int(round(float(r.normal(mean, sigma))))
    due = inv_date + timedelta(days=terms)
    paid = due + timedelta(days=dvt)
    return due, paid


def _status_as_of(due: datetime, paid, as_of: datetime) -> str:
    if paid is not None and paid <= as_of:
        return "Paid"
    return "Overdue" if due <= as_of else "Open"


# ---------------------------------------------------------------------------
# Org hierarchy: Region -> Country -> Legal Entity -> Business Unit.
# Each BU carries the ERP that feeds its GL/AR/AP/Inventory (SAP everywhere,
# except the Netherlands legal entity, which runs AFAS -- the SME's NL example).
# ---------------------------------------------------------------------------
BU_META = {
    "BU-100": dict(name="North America", region="AMER", country="United States",
                   le_id="LE-US", le_name="Northwind Inc. (US)", erp="SAP"),
    "BU-200": dict(name="EMEA", region="EMEA", country="Netherlands",
                   le_id="LE-NL", le_name="Northwind Europe B.V. (NL)", erp="AFAS"),
    "BU-300": dict(name="APAC", region="APAC", country="Singapore",
                   le_id="LE-SG", le_name="Northwind APAC Pte. Ltd. (SG)", erp="SAP"),
    "BU-400": dict(name="LATAM", region="AMER", country="Brazil",
                   le_id="LE-BR", le_name="Northwind LATAM Ltda. (BR)", erp="SAP"),
    "BU-900": dict(name="Corporate", region="GLOBAL", country="United States",
                   le_id="LE-CORP", le_name="Northwind Global Corp.", erp="SAP"),
}

BUSINESS_LINES = ["Products", "Services"]
SHARED = "Shared Services"

PAYROLL_ERP = "Workday"          # HRIS
EXPENSE_ERP = "Workday"          # employee T&E
BANK_ERP = "Bank Feed"           # bank statement import
FA_ERP = "SAP-FixedAssets"       # kept distinct so we can make it deliberately stale


def erp_of(bu: str) -> str:
    return BU_META[bu]["erp"]


def make_org() -> pd.DataFrame:
    rows = []
    for bu_id, m in BU_META.items():
        rows.append((bu_id, m["name"], m["region"], m["country"],
                     m["le_id"], m["le_name"], m["erp"]))
    return pd.DataFrame(rows, columns=[
        "business_unit_id", "business_unit_name", "region", "country",
        "legal_entity_id", "legal_entity_name", "primary_source_system"])


# (account_code, name, type, normal_balance, statement, is_control, subledger, fs_line, account_group)
_COA = [
    ("10100", "Cash and Cash Equivalents", "Asset", "D", "BS", True, "BANK", "Cash", "Cash & Bank"),
    ("10200", "Bank Accounts - Operating", "Asset", "D", "BS", False, None, "Cash", "Cash & Bank"),
    ("11000", "Accounts Receivable", "Asset", "D", "BS", True, "AR", "Receivables", "Receivables"),
    ("12000", "Inventory", "Asset", "D", "BS", True, "INV", "Inventory", "Inventory"),
    ("13000", "Prepaid Expenses", "Asset", "D", "BS", False, None, "Other Current Assets", "Other Current Assets"),
    ("15000", "Fixed Assets - Gross", "Asset", "D", "BS", True, "FA", "PP&E", "Property, Plant & Equipment"),
    ("15900", "Accumulated Depreciation", "Asset", "C", "BS", False, None, "PP&E", "Property, Plant & Equipment"),
    ("20000", "Accounts Payable", "Liability", "C", "BS", True, "AP", "Payables", "Payables"),
    ("21000", "Accrued Liabilities", "Liability", "C", "BS", False, None, "Accrued Liabilities", "Accrued Liabilities"),
    ("22000", "Payroll Liabilities", "Liability", "C", "BS", True, "PR", "Accrued Liabilities", "Accrued Liabilities"),
    ("23000", "Taxes Payable", "Liability", "C", "BS", False, None, "Taxes Payable", "Taxes Payable"),
    ("25000", "Intercompany Payable", "Liability", "C", "BS", False, None, "Intercompany", "Intercompany"),
    ("30000", "Common Stock", "Equity", "C", "BS", False, None, "Equity", "Equity"),
    ("31000", "Retained Earnings", "Equity", "C", "BS", False, None, "Equity", "Equity"),
    ("40000", "Product Revenue", "Revenue", "C", "IS", False, None, "Revenue", "Revenue"),
    ("41000", "Service Revenue", "Revenue", "C", "IS", False, None, "Revenue", "Revenue"),
    ("50000", "Cost of Goods Sold", "Expense", "D", "IS", False, None, "COGS", "Cost of Goods Sold"),
    ("60000", "Salaries and Wages", "Expense", "D", "IS", False, None, "Operating Expense", "Operating Expense"),
    ("61000", "Operating Expense - Rent", "Expense", "D", "IS", False, None, "Operating Expense", "Operating Expense"),
    ("62000", "Operating Expense - Utilities", "Expense", "D", "IS", False, None, "Operating Expense", "Operating Expense"),
    ("63000", "Operating Expense - Marketing", "Expense", "D", "IS", False, None, "Operating Expense", "Operating Expense"),
    ("64000", "Operating Expense - Travel", "Expense", "D", "IS", False, None, "Operating Expense", "Operating Expense"),
    ("65000", "Depreciation Expense", "Expense", "D", "IS", False, None, "Operating Expense", "Operating Expense"),
    ("66000", "Operating Expense - Professional Fees", "Expense", "D", "IS", False, None, "Operating Expense", "Operating Expense"),
    ("67000", "Operating Expense - Other", "Expense", "D", "IS", False, None, "Operating Expense", "Operating Expense"),
    ("68000", "Staff Expenses (T&E)", "Expense", "D", "IS", False, None, "Operating Expense", "Operating Expense"),
    ("70000", "Interest Income", "Revenue", "C", "IS", False, None, "Interest Income", "Interest Income"),
    ("71000", "Interest Expense", "Expense", "D", "IS", False, None, "Interest Expense", "Interest Expense"),
    ("80000", "Income Tax Expense", "Expense", "D", "IS", False, None, "Income Tax", "Income Tax"),
]

OPEX_ACCOUNTS = ["60000", "61000", "62000", "63000", "64000", "65000", "66000", "67000", "68000"]

# Deterministic per-BU cash-flow rates (seed=42) so the statement is stable and
# built from the same transactional magnitudes as the rest of the close.
CASH_COLLECT_RATE = 0.82   # interest-income cash proxy only; the cash_flow table uses real paid dates
CAPEX_RATE = 0.06          # of gross fixed-asset base treated as this-period additions
PRE_HISTORY_MONTHS = 3     # months of invoices assumed open before the first period (see make_cash_flow)
BANK_TRANSIT_AMOUNT = 8500.00   # seeded deposit in transit at BU-400 on the active close
SETTLEMENT_POSTER = "treasury.settlement"   # posted_by on GL cash settlement legs (see make_cash_settlements)


def make_coa() -> pd.DataFrame:
    df = pd.DataFrame(
        _COA,
        columns=[
            "account_code", "account_name", "account_type", "normal_balance",
            "statement", "is_control_account", "subledger", "fs_line", "account_group",
        ],
    )
    df.insert(0, "account_id", range(1, len(df) + 1))
    return df


# ---------------------------------------------------------------------------
# Journal-entry helper: accumulate balanced GL lines (each line tagged with the
# business line and the source system that produced it).
# ---------------------------------------------------------------------------
class GLBuilder:
    def __init__(self):
        self.lines: list[dict] = []
        self._je = 0

    def post(self, period, entry_date, source_system, description, postings, posted_by,
             business_line=SHARED):
        """postings: list of (account_code, business_unit_id, dr_cr, amount)."""
        self._je += 1
        je_id = f"JE-{period}-{self._je:05d}"
        for i, (acct, bu, drcr, amt) in enumerate(postings, start=1):
            self.lines.append({
                "je_id": je_id,
                "je_line": i,
                "period": period,
                "entry_date": entry_date,
                "account_code": acct,
                "business_unit_id": bu,
                "business_line": business_line,
                "dr_cr": drcr,
                "amount": round(float(amt), 2),
                "source_system": source_system,
                "description": description,
                "posted_by": posted_by,
            })
        return je_id

    def to_frame(self) -> pd.DataFrame:
        return pd.DataFrame(self.lines)


def rand_day(rng) -> datetime:
    span = (PERIOD_END - PERIOD_START).days
    return PERIOD_START + timedelta(days=int(rng.integers(0, span + 1)))


def rand_line(rng, bu: str) -> str:
    if bu == "BU-900":
        return SHARED
    return BUSINESS_LINES[int(rng.integers(0, len(BUSINESS_LINES)))]


BUS = ["BU-100", "BU-200", "BU-300", "BU-400"]   # operating BUs (Corporate carries little)
BU_SCALE = {"BU-100": 1.0, "BU-200": 0.7, "BU-300": 0.55, "BU-400": 0.3, "BU-900": 0.15}

VENDORS = [f"Vendor {chr(65 + i)}{i:02d}" for i in range(40)]
CUSTOMERS = [f"Customer {chr(65 + i)}{i:02d}" for i in range(40)]
EMPLOYEE_GROUPS = ["Engineering", "Sales", "G&A", "Operations", "Marketing"]
SKUS = [f"SKU-{1000 + i}" for i in range(30)]
EXPENSE_TYPES = ["Travel", "Meals", "Lodging", "Software", "Training"]
ANALYSTS = [
    "amelia.ortiz@example.com", "raj.patel@example.com", "sofia.nguyen@example.com",
    "liam.murphy@example.com", "grace.kim@example.com",
]


def build_one_period(coa, org, active: bool, is_first_period: bool):
    """Generate one period's ERP feeds + close-folder artifacts. Reads the module
    period-context globals (PERIOD, PERIOD_START, ..., SCALE) set by _set_period.
    When `active` is True this reproduces the original single-period baseline
    (SCALE == 1.0, seed 42) including every seeded demo issue; historical periods
    are clean, balanced, scaled months. Returns (frames_dict, manifest_or_None)."""
    gl = GLBuilder()
    code_to_id = dict(zip(coa.account_code, coa.account_id))

    # ----- AP subledger: vendor invoices (Dr expense/inventory, Cr AP) -----
    ap_rows = []
    ap_expense_mix = ["50000", "61000", "62000", "63000", "64000", "66000", "67000"]
    inv_no = 0
    for b in BUS:
        n = int(40 * BU_SCALE[b])
        for _ in range(n):
            inv_no += 1
            acct = ap_expense_mix[int(rng.integers(0, len(ap_expense_mix)))]
            bl = rand_line(rng, b)
            amt = round((float(rng.gamma(2.0, 1.0)) * 7000 * BU_SCALE[b] + 600) * SCALE, 2)
            d = rand_day(rng)
            vendor = VENDORS[int(rng.integers(0, len(VENDORS)))]
            inv_id = f"AP-{PERIOD}-{inv_no:05d}"
            terms, _cat, dvt_mean, dvt_sigma = _cp_profile(vendor)
            due, paid = _settle(inv_id, d, terms, dvt_mean, dvt_sigma)
            ap_rows.append({
                "invoice_id": inv_id,
                "period": PERIOD, "vendor_name": vendor,
                "business_unit_id": b, "business_line": bl, "expense_account_code": acct,
                "control_account_code": "20000", "invoice_date": d.date().isoformat(),
                "amount": amt, "payment_terms": terms, "due_date": due.date().isoformat(),
                "paid_date": paid.date().isoformat(),
                "status": _status_as_of(due, paid, ACTIVE_CLOSE_END),
                "source_system": erp_of(b),
            })
            gl.post(PERIOD, d.date().isoformat(), erp_of(b),
                    f"Vendor invoice {VENDORS[0]}",
                    [(acct, b, "D", amt), ("20000", b, "C", amt)], "ap.subsystem",
                    business_line=bl)
    ap = pd.DataFrame(ap_rows)

    # ----- AR subledger: customer invoices (Dr AR, Cr revenue) -----
    ar_rows = []
    rev_mix = ["40000", "41000"]
    arn = 0
    for b in BUS:
        n = int(35 * BU_SCALE[b])
        for _ in range(n):
            arn += 1
            acct = rev_mix[int(rng.integers(0, len(rev_mix)))]
            bl = "Products" if acct == "40000" else "Services"
            amt = round((float(rng.gamma(2.5, 1.0)) * 55000 * BU_SCALE[b] + 2000) * SCALE, 2)
            d = rand_day(rng)
            customer = CUSTOMERS[int(rng.integers(0, len(CUSTOMERS)))]
            inv_id = f"AR-{PERIOD}-{arn:05d}"
            terms, _cat, dvt_mean, dvt_sigma = _cp_profile(customer)
            due, paid = _settle(inv_id, d, terms, dvt_mean, dvt_sigma)
            ar_rows.append({
                "invoice_id": inv_id,
                "period": PERIOD, "customer_name": customer,
                "business_unit_id": b, "business_line": bl, "revenue_account_code": acct,
                "control_account_code": "11000", "invoice_date": d.date().isoformat(),
                "amount": amt, "payment_terms": terms, "due_date": due.date().isoformat(),
                "paid_date": paid.date().isoformat(),
                "status": _status_as_of(due, paid, ACTIVE_CLOSE_END),
                "source_system": erp_of(b),
            })
            gl.post(PERIOD, d.date().isoformat(), erp_of(b),
                    "Customer invoice",
                    [("11000", b, "D", amt), (acct, b, "C", amt)], "ar.subsystem",
                    business_line=bl)
    ar = pd.DataFrame(ar_rows)

    # ----- Sales orders subledger: order-to-cash upstream of AR (no GL yet) -----
    so_rows = []
    son = 0
    for _, r in ar.iterrows():
        son += 1
        so_rows.append({
            "sales_order_id": f"SO-{PERIOD}-{son:05d}",
            "period": PERIOD, "customer_name": r["customer_name"],
            "business_unit_id": r["business_unit_id"], "business_line": r["business_line"],
            "order_date": (datetime.fromisoformat(r["invoice_date"]) - timedelta(days=int(rng.integers(2, 20)))).date().isoformat(),
            "order_amount": r["amount"], "invoice_id": r["invoice_id"],
            "status": "Invoiced", "source_system": erp_of(r["business_unit_id"]),
        })
    sales_orders = pd.DataFrame(so_rows)

    # ----- Procurement subledger: purchase orders upstream of AP (no GL yet) -----
    po_rows = []
    pon = 0
    for _, r in ap.iterrows():
        pon += 1
        # Normally the PO amount matches the invoice it was received against.
        po_rows.append({
            "purchase_order_id": f"PO-{PERIOD}-{pon:05d}",
            "period": PERIOD, "vendor_name": r["vendor_name"],
            "business_unit_id": r["business_unit_id"], "business_line": r["business_line"],
            "order_date": (datetime.fromisoformat(r["invoice_date"]) - timedelta(days=int(rng.integers(3, 25)))).date().isoformat(),
            "po_amount": r["amount"], "matched_invoice_id": r["invoice_id"],
            "status": "Received", "source_system": erp_of(r["business_unit_id"]),
        })
    procurement = pd.DataFrame(po_rows)

    # ----- Payroll subledger (Dr Salaries, Cr Payroll Liabilities) — Workday -----
    pr_rows = []
    prn = 0
    for b in BUS + ["BU-900"]:
        for grp in EMPLOYEE_GROUPS:
            prn += 1
            headcount = int(rng.integers(6, 22) * BU_SCALE[b]) + 2
            amt = round(headcount * float(rng.normal(6800, 700)) * SCALE, 2)
            d = PERIOD_END
            pr_rows.append({
                "payroll_run_id": f"PR-{PERIOD}-{prn:04d}",
                "period": PERIOD, "employee_group": grp, "headcount": headcount,
                "business_unit_id": b, "expense_account_code": "60000",
                "control_account_code": "22000", "run_date": d.date().isoformat(),
                "amount": amt, "status": "Posted", "source_system": PAYROLL_ERP,
            })
            gl.post(PERIOD, d.date().isoformat(), PAYROLL_ERP,
                    f"Payroll run {grp}",
                    [("60000", b, "D", amt), ("22000", b, "C", amt)], "payroll.subsystem")
    payroll = pd.DataFrame(pr_rows)

    # ----- Staff expenses subledger (Dr Staff Expenses, Cr Accrued) — Workday -----
    se_rows = []
    sen = 0
    for b in BUS + ["BU-900"]:
        n = int(18 * BU_SCALE[b]) + 3
        for _ in range(n):
            sen += 1
            etype = EXPENSE_TYPES[int(rng.integers(0, len(EXPENSE_TYPES)))]
            amt = round((float(rng.gamma(2.0, 1.0)) * 450 + 60) * SCALE, 2)
            d = rand_day(rng)
            se_rows.append({
                "expense_claim_id": f"EXP-{PERIOD}-{sen:05d}",
                "period": PERIOD, "employee_group": EMPLOYEE_GROUPS[int(rng.integers(0, len(EMPLOYEE_GROUPS)))],
                "business_unit_id": b, "expense_type": etype,
                "expense_account_code": "68000", "control_account_code": "21000",
                "claim_date": d.date().isoformat(), "amount": amt, "status": "Approved",
                "source_system": EXPENSE_ERP,
            })
            gl.post(PERIOD, d.date().isoformat(), EXPENSE_ERP,
                    f"Staff expense claim ({etype})",
                    [("68000", b, "D", amt), ("21000", b, "C", amt)], "expenses.subsystem")
    staff_expenses = pd.DataFrame(se_rows)

    # ----- Inventory subledger + product costs (SAP) -----
    #   Purchase into inventory (Dr 12000, Cr 10100 cash) and COGS on sale
    #   (Dr 50000, Cr 12000). Ending on-hand value = purchases - COGS, which
    #   reconciles to the GL Inventory (12000) balance.
    inv_rows = []
    invn = 0
    dropped_cogs_je = None
    for b in BUS:
        n = int(14 * BU_SCALE[b]) + 3
        for _ in range(n):
            invn += 1
            bl = "Products"
            unit_cost = round((float(rng.gamma(2.0, 1.0)) * 120 + 20) * SCALE, 2)
            qty_purchased = int(rng.integers(20, 200))
            qty_sold = int(qty_purchased * float(rng.uniform(0.45, 0.8)))
            qty_on_hand = qty_purchased - qty_sold
            purchase_value = round(unit_cost * qty_purchased, 2)
            cogs_value = round(unit_cost * qty_sold, 2)
            inv_value = round(purchase_value - cogs_value, 2)
            d = rand_day(rng)
            inv_rows.append({
                "inventory_item_id": f"INV-{PERIOD}-{invn:05d}",
                "period": PERIOD, "sku": SKUS[int(rng.integers(0, len(SKUS)))],
                "business_unit_id": b, "business_line": bl,
                "control_account_code": "12000", "unit_cost": unit_cost,
                "quantity_on_hand": qty_on_hand, "inventory_value": inv_value,
                "cogs_amount": cogs_value, "as_of_date": d.date().isoformat(),
                "source_system": erp_of(b),
            })
            gl.post(PERIOD, d.date().isoformat(), erp_of(b), "Inventory purchase",
                    [("12000", b, "D", purchase_value), ("10100", b, "C", purchase_value)],
                    "inventory.subsystem", business_line=bl)
            cogs_je = gl.post(PERIOD, d.date().isoformat(), erp_of(b), "COGS on sale",
                              [("50000", b, "D", cogs_value), ("12000", b, "C", cogs_value)],
                              "inventory.subsystem", business_line=bl)
            # remember one COGS entry (BU-100) to drop later -> seeded inventory break
            if b == "BU-100" and dropped_cogs_je is None:
                dropped_cogs_je = cogs_je
    inventory = pd.DataFrame(inv_rows)

    # ----- Fixed assets subledger (assets + monthly depreciation) -----
    fa_rows = []
    fan = 0
    for b in BUS:
        n = int(12 * BU_SCALE[b]) + 2
        for _ in range(n):
            fan += 1
            cost = round((float(rng.gamma(2.0, 1.0)) * 30000 * BU_SCALE[b] + 5000) * SCALE, 2)
            life = int(rng.choice([36, 48, 60, 84]))
            monthly_dep = round(cost / life, 2)
            fa_rows.append({
                "asset_id": f"FA-{fan:05d}",
                "period": PERIOD, "asset_description": f"Asset {fan}",
                "business_unit_id": b, "gross_account_code": "15000",
                "accum_dep_account_code": "15900", "dep_expense_account_code": "65000",
                "in_service_date": (PERIOD_START - timedelta(days=int(rng.integers(60, 1500)))).date().isoformat(),
                "gross_cost": cost, "useful_life_months": life, "monthly_depreciation": monthly_dep,
                "source_system": FA_ERP,
            })
            gl.post(PERIOD, PERIOD_END.date().isoformat(), FA_ERP,
                    "Monthly depreciation",
                    [("65000", b, "D", monthly_dep), ("15900", b, "C", monthly_dep)],
                    "fa.subsystem")
    fixed_assets = pd.DataFrame(fa_rows)

    # ----- Direct GL: rent + utilities via cash -----
    for b in BUS:
        rent = round(28000 * BU_SCALE[b] * SCALE, 2)
        util = round(9000 * BU_SCALE[b] * SCALE, 2)
        gl.post(PERIOD, PERIOD_END.date().isoformat(), erp_of(b),
                "Monthly rent", [("61000", b, "D", rent), ("10100", b, "C", rent)], "gl.team")
        gl.post(PERIOD, PERIOD_END.date().isoformat(), erp_of(b),
                "Utilities", [("62000", b, "D", util), ("10100", b, "C", util)], "gl.team")

    # =====================================================================
    # SEEDED ISSUE 2: debits != credits in one Legacy-ERP batch (active only)
    #   A reclass JE posted from a legacy feed is off by $1,250 (credit short).
    # =====================================================================
    if active:
        gl.lines.append({
            "je_id": f"JE-{PERIOD}-LEGACY01", "je_line": 1, "period": PERIOD,
            "entry_date": PERIOD_END.date().isoformat(), "account_code": "67000",
            "business_unit_id": "BU-200", "business_line": SHARED, "dr_cr": "D", "amount": 14250.00,
            "source_system": "Legacy-ERP", "description": "Legacy reclass batch (UNBALANCED)",
            "posted_by": "legacy.feed",
        })
        gl.lines.append({
            "je_id": f"JE-{PERIOD}-LEGACY01", "je_line": 2, "period": PERIOD,
            "entry_date": PERIOD_END.date().isoformat(), "account_code": "21000",
            "business_unit_id": "BU-200", "business_line": SHARED, "dr_cr": "C", "amount": 13000.00,
            "source_system": "Legacy-ERP", "description": "Legacy reclass batch (UNBALANCED)",
            "posted_by": "legacy.feed",
        })

    all_bus = BUS + ["BU-900"]
    ar_by_bu = ar.groupby("business_unit_id")["amount"].sum().to_dict()
    ap_by_bu = ap.groupby("business_unit_id")["amount"].sum().to_dict()
    payroll_by_bu = payroll.groupby("business_unit_id")["amount"].sum().to_dict()
    staff_by_bu = staff_expenses.groupby("business_unit_id")["amount"].sum().to_dict()
    cogs_by_bu = inventory.groupby("business_unit_id")["cogs_amount"].sum().to_dict()
    dep_by_bu = fixed_assets.groupby("business_unit_id")["monthly_depreciation"].sum().to_dict()

    for b in all_bus:
        source_system = erp_of(b)
        if is_first_period:
            common_stock = round(150000 * BU_SCALE[b], 2)
            retained_earnings = round(420000 * BU_SCALE[b], 2)
            opening_cash = round(common_stock + retained_earnings, 2)
            gl.post(
                PERIOD,
                PERIOD_START.date().isoformat(),
                source_system,
                "Opening equity seed",
                [("10100", b, "D", opening_cash), ("30000", b, "C", common_stock), ("31000", b, "C", retained_earnings)],
                "gl.team",
            )

        collections_proxy = float(ar_by_bu.get(b, 0.0)) * CASH_COLLECT_RATE
        cash_proxy = collections_proxy * 1.5 + 250000 * BU_SCALE[b] * SCALE
        interest_income = round(max(cash_proxy * 0.001, 0.0), 2)
        if interest_income > 0:
            gl.post(
                PERIOD,
                PERIOD_END.date().isoformat(),
                source_system,
                "Interest income accrual",
                [("10100", b, "D", interest_income), ("70000", b, "C", interest_income)],
                "gl.team",
            )

        liabilities_proxy = (
            float(ap_by_bu.get(b, 0.0))
            + float(payroll_by_bu.get(b, 0.0))
            + float(staff_by_bu.get(b, 0.0))
        )
        interest_expense = round(max(liabilities_proxy * 0.004, 0.0), 2)
        if interest_expense > 0:
            gl.post(
                PERIOD,
                PERIOD_END.date().isoformat(),
                source_system,
                "Interest expense accrual",
                [("71000", b, "D", interest_expense), ("21000", b, "C", interest_expense)],
                "gl.team",
            )

        revenue = float(ar_by_bu.get(b, 0.0))
        cogs = float(cogs_by_bu.get(b, 0.0))
        opex = (
            float(payroll_by_bu.get(b, 0.0))
            + float(staff_by_bu.get(b, 0.0))
            + round(28000 * BU_SCALE[b] * SCALE, 2)
            + round(9000 * BU_SCALE[b] * SCALE, 2)
            + float(dep_by_bu.get(b, 0.0))
        )
        interest_net = interest_income - interest_expense
        taxable_income = revenue - cogs - opex + interest_net
        tax_expense = round(taxable_income * 0.22, 2) if taxable_income > 0 else 0.0
        if tax_expense > 0:
            gl.post(
                PERIOD,
                PERIOD_END.date().isoformat(),
                source_system,
                "Income tax accrual",
                [("80000", b, "D", tax_expense), ("23000", b, "C", tax_expense)],
                "gl.team",
            )

        period_net_income = revenue - cogs - opex + interest_net - tax_expense
        dividends = round(period_net_income * 0.15, 2) if period_net_income > 0 else 0.0
        if dividends > 0:
            gl.post(
                PERIOD,
                PERIOD_END.date().isoformat(),
                source_system,
                "Dividend declaration",
                [("31000", b, "D", dividends), ("10100", b, "C", dividends)],
                "gl.team",
            )

    gl_df = gl.to_frame()

    # Defaults so the (active-only) manifest/prints have values on historical runs.
    timing_break_invoices: list[str] = []
    timing_break_amount = 0.0
    inventory_break_amount = 0.0
    match_break_po = None
    bank_break_amount = BANK_TRANSIT_AMOUNT

    # =====================================================================
    # SEEDED ISSUE 1: subledger-to-GL timing break (active only).
    #   Two AP invoices (BU-300) exist in the subledger but their GL postings
    #   were "delayed" -> remove them from GL so subledger total > GL control.
    # =====================================================================
    if active:
        bu300_open = ap[(ap.business_unit_id == "BU-300")].head(2)
        timing_break_invoices = bu300_open["invoice_id"].tolist()
        timing_break_amount = round(float(bu300_open["amount"].sum()), 2)
        drop_amts = set(round(a, 2) for a in bu300_open["amount"].tolist())
        mask_drop = (
            (gl_df.source_system == erp_of("BU-300"))
            & (gl_df.business_unit_id == "BU-300")
            & (gl_df.account_code == "20000")
            & (gl_df.amount.isin(drop_amts))
        )
        drop_jes = gl_df.loc[mask_drop, "je_id"].unique().tolist()[:2]
        gl_df = gl_df[~gl_df.je_id.isin(drop_jes)].reset_index(drop=True)

    # =====================================================================
    # SEEDED ISSUE 6: inventory-to-GL break — drop one COGS credit to 12000
    #   for BU-100 so GL Inventory > inventory subledger on-hand value (active only).
    # =====================================================================
    if active and dropped_cogs_je is not None:
        cr_line = gl_df[(gl_df.je_id == dropped_cogs_je) & (gl_df.account_code == "12000")]
        if not cr_line.empty:
            inventory_break_amount = round(float(cr_line["amount"].iloc[0]), 2)
        # remove only the Cr 12000 leg (leaves the Dr 50000 COGS in place, so the
        # break is a residual unmatched inventory relief the accountant chases).
        gl_df = gl_df[~((gl_df.je_id == dropped_cogs_je) & (gl_df.account_code == "12000"))].reset_index(drop=True)

    # =====================================================================
    # SEEDED ISSUE 3: orphan account in one AP invoice (active only)
    # =====================================================================
    if active and len(ap) > 5:
        ap.loc[ap.index[5], "expense_account_code"] = "99999"  # not in COA

    # =====================================================================
    # SEEDED ISSUE 8: procurement 3-way-match mismatch — one PO amount differs
    #   from the invoice it was received against (active only).
    # =====================================================================
    if active and len(procurement) > 3:
        match_break_po = procurement.loc[procurement.index[3], "purchase_order_id"]
        procurement.loc[procurement.index[3], "po_amount"] = round(
            float(procurement.loc[procurement.index[3], "po_amount"]) * 1.18, 2)

    # The bank feed carries running balances, so build() makes it from the full GL
    # (make_bank_feed) once the cash settlements are posted.

    # The cash-flow statement chains across periods, so build() makes it once from
    # the full history (make_cash_flow) instead of per period here.

    # map account_id onto GL + build per-source freshness
    gl_df["account_id"] = gl_df["account_code"].map(code_to_id)

    # =====================================================================
    # SEEDED ISSUE 4: stale freshness for the fixed-assets feed (active only)
    # =====================================================================
    present_sources = sorted(gl_df["source_system"].unique().tolist())
    feed_load = {s: LOAD_TS for s in present_sources}
    fa_load = LOAD_TS - timedelta(days=3) if active else LOAD_TS   # STALE on active close
    feed_load[FA_ERP] = fa_load
    gl_df["load_ts"] = gl_df["source_system"].map(lambda s: feed_load.get(s, LOAD_TS).isoformat())

    fixed_assets["load_ts"] = fa_load.isoformat()
    for f in (ap, ar, payroll, inventory, sales_orders, procurement, staff_expenses):
        f["load_ts"] = LOAD_TS.isoformat()

    # ----- Budget / forecast for IS accounts x BU -----
    bf_rows = []
    is_accounts = coa[coa.statement == "IS"]
    actuals = (
        gl_df.merge(coa[["account_code", "normal_balance", "statement"]], on="account_code")
        .query("statement == 'IS'")
    )

    def signed(row):
        s = 1 if row["dr_cr"] == row["normal_balance"] else -1
        return s * row["amount"]
    actuals = actuals.assign(signed=actuals.apply(signed, axis=1))
    act_grp = actuals.groupby(["account_code", "business_unit_id"])["signed"].sum().to_dict()
    for _, a in is_accounts.iterrows():
        for b in BUS + ["BU-900"]:
            base = abs(act_grp.get((a.account_code, b), 0.0))
            if base == 0:
                continue
            if a.account_code in OPEX_FORECAST_FACTORS:
                factor = OPEX_FORECAST_FACTORS[a.account_code] * float(rng.normal(1.0, 0.015))
            else:
                factor = float(rng.normal(1.0, 0.04))
            bf_rows.append({
                "period": PERIOD, "account_code": a.account_code,
                "business_unit_id": b, "forecast_amount": round(base * factor, 2),
            })
    budget = pd.DataFrame(bf_rows)

    # ----- Close-folder manual adjustment spreadsheets -----
    def adj_df(prefix, account_pool, n, kind):
        rows = []
        for i in range(n):
            acct = account_pool[int(rng.integers(0, len(account_pool)))]
            b = (BUS + ["BU-900"])[int(rng.integers(0, len(BUS) + 1))]
            amt = round(float(rng.gamma(2.0, 1.0)) * 3000 + 400, 2)
            drcr = "D" if coa.loc[coa.account_code == acct, "normal_balance"].iloc[0] == "D" else "C"
            rows.append({
                "adjustment_id": f"{prefix}-{PERIOD}-{i + 1:03d}",
                "period": PERIOD, "adjustment_type": kind,
                "account_code": acct, "business_unit_id": b,
                "dr_cr": drcr, "amount": amt,
                "memo": f"{kind} adjustment {i + 1}",
                "submitted_by": ANALYSTS[int(rng.integers(0, len(ANALYSTS)))],
                "submitted_ts": (PERIOD_END - timedelta(days=int(rng.integers(0, 3)))).isoformat(),
            })
        return pd.DataFrame(rows)

    accruals = adj_df("ACC", ["60000", "61000", "63000", "64000", "66000", "67000", "21000"], 22, "Accrual")
    reclasses = adj_df("RCL", OPEX_ACCOUNTS, 14, "Reclass")
    intercompany = adj_df("ICE", ["25000", "67000", "41000"], 9, "Intercompany Elimination")
    fx = adj_df("FXO", ["67000", "40000", "41000", "10100"], 8, "FX Overlay")

    # =====================================================================
    # SEEDED ISSUE 5: the accruals spreadsheet has its `amount` column renamed
    #   to `adjustment_amount` (the overnight rename) -> schema evolution +ZeroOps
    #   (active close only — the close folder models the *current* month-end).
    # =====================================================================
    if active:
        accruals_renamed = accruals.rename(columns={"amount": "adjustment_amount"})
        accruals_renamed.to_csv(CLOSE_FOLDER_OUT / f"accruals_{PERIOD}.csv", index=False)
        reclasses.to_csv(CLOSE_FOLDER_OUT / f"reclasses_{PERIOD}.csv", index=False)
        intercompany.to_csv(CLOSE_FOLDER_OUT / f"intercompany_{PERIOD}.csv", index=False)
        fx.to_csv(CLOSE_FOLDER_OUT / f"fx_overlays_{PERIOD}.csv", index=False)

    # per-period frames returned to build(); dims/kpi_history are built once there.
    frames = {
        "gl_journal_entries": gl_df, "subledger_ap": ap, "subledger_ar": ar,
        "subledger_payroll": payroll, "subledger_fixed_assets": fixed_assets,
        "subledger_inventory": inventory, "subledger_sales_orders": sales_orders,
        "subledger_procurement": procurement,
        "subledger_staff_expenses": staff_expenses,
        "budget_forecast": budget,
    }

    manifest = None
    if active:
        # ----- machine-readable manifest of seeded issues (drives DQ + ZeroOps) -----
        manifest = {
            "period": PERIOD,
            "seeded_issues": [
                {"id": "timing_break", "type": "reconciliation",
                 "detail": f"AP invoices {timing_break_invoices} (BU-300, ${timing_break_amount:,.2f}) in subledger but delayed in GL",
                 "surfaces_in": "Act 4 recon app aged items"},
                {"id": "unbalanced_batch", "type": "validity",
                 "detail": "Legacy-ERP JE JE-%s-LEGACY01 debits != credits by $1,250.00" % PERIOD,
                 "surfaces_in": "Act 2 DQ validity (debits=credits)"},
                {"id": "orphan_account", "type": "referential_integrity",
                 "detail": "One AP invoice references account 99999 not in chart_of_accounts",
                 "surfaces_in": "Act 2 DQ referential integrity"},
                {"id": "stale_feed", "type": "freshness",
                 "detail": f"{FA_ERP} feed load_ts is 3 days stale",
                 "surfaces_in": "Act 2 DQ freshness"},
                {"id": "column_rename", "type": "schema_evolution",
                 "detail": "accruals_%s.csv renamed `amount` -> `adjustment_amount`" % PERIOD,
                 "surfaces_in": "Act 2 schema evolution + ZeroOps self-heal"},
                {"id": "inventory_break", "type": "reconciliation",
                 "detail": f"BU-100 inventory relief (COGS) of ${inventory_break_amount:,.2f} missing from GL",
                 "surfaces_in": "Act 4 recon app (Inventory control)"},
                {"id": "bank_timing_break", "type": "reconciliation",
                 "detail": f"BU-400 bank statement shows ${bank_break_amount:,.2f} deposit in transit vs GL cash",
                 "surfaces_in": "Act 4 recon app (Bank control)"},
                {"id": "po_invoice_mismatch", "type": "three_way_match",
                 "detail": f"PO {match_break_po} amount differs from its matched invoice",
                 "surfaces_in": "Act 2 DQ procurement 3-way match"},
                {"id": "ingestion_rejects", "type": "ingestion",
                 "detail": "AP schema reject, AR duplicate key, Workday payroll timeout",
                 "surfaces_in": "Data & Audit lineage Sankey (ingestion stage)"},
            ],
        }

    d = gl_df.loc[gl_df.dr_cr == "D", "amount"].sum()
    c = gl_df.loc[gl_df.dr_cr == "C", "amount"].sum()
    print(f"  period {PERIOD}  ({DAYS_IN_PERIOD}d, scale={SCALE:.3f})  "
          f"GL rows={len(gl_df):6d}  debits={d:,.0f}  credits={c:,.0f}  diff={d - c:,.2f}"
          + ("  <- active close (seeded issues)" if active else ""))
    return frames, manifest


def build():
    """Generate HISTORY_MONTHS trailing months of ERP feeds. Static dimensions
    (org, COA, dim_date) are written once; per-period transactional feeds are
    concatenated; kpi_history is computed from the real per-period GL."""
    ensure_output_dirs()
    coa = make_coa()
    org = make_org()
    periods = _period_seq(CLOSE_PERIOD, HISTORY_MONTHS)

    print(f"Generating {len(periods)} period(s): {periods[0]} .. {periods[-1]} "
          f"(active close = {CLOSE_PERIOD})")
    accum: dict[str, list[pd.DataFrame]] = {}
    manifest = None
    for period in periods:
        _set_period(period)
        frames, m = build_one_period(coa, org, active=(period == CLOSE_PERIOD), is_first_period=(period == periods[0]))
        if m is not None:
            manifest = m
        for name, df in frames.items():
            accum.setdefault(name, []).append(df)

    combined = {name: pd.concat(parts, ignore_index=True) for name, parts in accum.items()}
    combined["dim_org"] = org
    combined["chart_of_accounts"] = coa
    combined["dim_date"] = make_dim_date(periods)
    combined["ingestion_events"] = make_ingestion_events(CLOSE_PERIOD)

    anomaly_notes = _inject_payment_anomalies(
        combined["subledger_ar"], combined["subledger_ap"], periods)
    # After the anomalies, so the overdue / paid-early invoices move cash too.
    combined["cash_flow"] = make_cash_flow(combined, periods)
    # Post the same cash movements to the GL, then derive what reads GL balances.
    combined["gl_journal_entries"] = pd.concat(
        [combined["gl_journal_entries"],
         make_cash_settlements(combined, periods, combined["cash_flow"], coa)], ignore_index=True)
    combined["subledger_bank"] = make_bank_feed(combined["gl_journal_entries"], periods)
    combined["kpi_history"] = make_kpi_history_real(combined["gl_journal_entries"], coa, org, periods)

    feed_order = [
        "dim_org", "chart_of_accounts", "dim_date",
        "gl_journal_entries", "subledger_ap", "subledger_ar",
        "subledger_payroll", "subledger_fixed_assets", "subledger_inventory",
        "subledger_sales_orders", "subledger_procurement", "subledger_bank",
        "cash_flow", "subledger_staff_expenses", "budget_forecast", "kpi_history",
        "ingestion_events",
    ]
    for name in feed_order:
        combined[name].to_parquet(LANDING_OUT / f"{name}.parquet", index=False)

    if manifest is not None:
        import json
        (LANDING_OUT / "seeded_issues_manifest.json").write_text(json.dumps(manifest, indent=2))

    print("\nERP feeds (parquet -> output/landing/):")
    for name in feed_order:
        print(f"  {name:28s} {len(combined[name]):7d} rows")
    print(f"\nHistory: {len(periods)} months, {combined['gl_journal_entries'].period.nunique()} "
          f"distinct GL periods; kpi_history rows={len(combined['kpi_history'])}")
    if anomaly_notes:
        print("Injected payment-behaviour anomalies (active close):")
        for n in anomaly_notes:
            print(f"  - {n}")


def make_ingestion_events(period: str) -> pd.DataFrame:
    """Landing-time rejects that never reach a governed subledger.

    Shared by every industry (stable ids); source_system tokens match the
    baseline ERP names and are relabeled on industry seed.
    """
    ingest_ts = f"{period}-29T06:12:00"
    rows = [
        {"event_id": f"ING-{period}-AP-SCHEMA", "period": period, "flow_id": "ap",
         "stage": "ingestion", "status": "error", "source_system": "SAP / AFAS",
         "business_unit_id": "BU-200", "amount": 18420.0, "event_ts": ingest_ts,
         "rule": "ingestion_schema_reject",
         "message": "Vendor invoice rejected at landing: unexpected column `gross_amt`.",
         "source_file": "sap_ap_extract.csv"},
        {"event_id": f"ING-{period}-AR-DUP", "period": period, "flow_id": "ar",
         "stage": "ingestion", "status": "warning", "source_system": "SAP / AFAS",
         "business_unit_id": "BU-100", "amount": 9200.0, "event_ts": ingest_ts,
         "rule": "ingestion_duplicate_key",
         "message": "Duplicate invoice key quarantined; original row kept.",
         "source_file": "sap_ar_extract.csv"},
        {"event_id": f"ING-{period}-PAY-TIMEOUT", "period": period, "flow_id": "payroll",
         "stage": "ingestion", "status": "error", "source_system": "Workday",
         "business_unit_id": "BU-100", "amount": None, "event_ts": ingest_ts,
         "rule": "ingestion_timeout",
         "message": "Workday payroll extract timed out; 14 rows not landed.",
         "source_file": "workday_payroll.xml"},
    ]
    return pd.DataFrame(rows)


def _paid_in_period(df: pd.DataFrame, periods: list[str]) -> pd.DataFrame:
    """Invoices settled inside the history window, tagged with the settlement
    period. Unpaid invoices (paid_date None) and ones settled after the active
    close stay open, so they never reach cash."""
    paid = pd.to_datetime(df["paid_date"], errors="coerce")
    out = df.assign(cash_period=paid.dt.strftime("%Y-%m"))
    return out[out.cash_period.isin(periods)]


def _pre_history_runoff(df: pd.DataFrame, periods: list[str]) -> pd.DataFrame:
    """Invoices raised before the first generated month don't exist, so without
    them the first months would show almost no collections or supplier payments.
    Stand-in: replay the first month's invoices 1..PRE_HISTORY_MONTHS months
    earlier (same amounts and payment lags) and keep those settled in the window."""
    first = df[df.period == periods[0]]
    parts = []
    for k in range(1, PRE_HISTORY_MONTHS + 1):
        paid = pd.to_datetime(first["paid_date"], errors="coerce") - pd.DateOffset(months=k)
        parts.append(first.assign(paid_date=paid.dt.strftime("%Y-%m-%d")))
    return _paid_in_period(pd.concat(parts, ignore_index=True), periods) if parts else first.iloc[0:0]


def make_cash_flow(frames: dict[str, pd.DataFrame], periods: list[str]) -> pd.DataFrame:
    """Per-BU monthly cash-flow statement (direct method) built from the same
    books as the P&L, chained month to month: beginning = prior month's ending.

      collections             = customer invoices paid in the month (subledger paid_date)
                                + interest income received
      operating_disbursements = vendor invoices paid in the month + inventory purchases
                                + payroll + staff T&E + rent/utilities + interest + income tax
      capex                   = CAPEX_RATE x the period's fixed-asset base
      dividends_paid          = the period's dividend declaration (GL 31000)

    So the change in cash = net income + depreciation - change in open AR
    + change in open AP - inventory build - capex - dividends, and it articulates
    with the P&L instead of drifting from it. Payroll, T&E, interest and tax are
    settled in the month they are booked. make_cash_settlements posts the same
    movements to the GL, so GL cash ties to this table.
    Every column is additive across BUs, so any org scope can SUM the rows."""
    ar, ap = frames["subledger_ar"], frames["subledger_ap"]
    gl = frames["gl_journal_entries"]
    inv = frames["subledger_inventory"]

    def by(df, period_col, value):
        return df.groupby([period_col, "business_unit_id"])[value].sum()

    receipts = pd.concat([_pre_history_runoff(ar, periods), _paid_in_period(ar, periods)])
    vendor_paid = pd.concat([_pre_history_runoff(ap, periods), _paid_in_period(ap, periods)])

    def gl_sum(mask):
        return by(gl[mask], "period", "amount")

    rent_util = gl_sum((gl.posted_by == "gl.team") & gl.account_code.isin(["61000", "62000"]))
    interest_in = gl_sum((gl.account_code == "70000") & (gl.dr_cr == "C"))
    interest_out = gl_sum((gl.account_code == "71000") & (gl.dr_cr == "D"))
    tax = gl_sum((gl.account_code == "80000") & (gl.dr_cr == "D"))
    dividends = gl_sum((gl.account_code == "31000") & (gl.description == "Dividend declaration"))

    flows = pd.DataFrame({
        "collections_ar": by(receipts, "cash_period", "amount"),
        "interest_in": interest_in,
        "vendor_paid": by(vendor_paid, "cash_period", "amount"),
        "inventory": by(inv.assign(purchase=inv.inventory_value + inv.cogs_amount), "period", "purchase"),
        "payroll": by(frames["subledger_payroll"], "period", "amount"),
        "staff": by(frames["subledger_staff_expenses"], "period", "amount"),
        "rent_util": rent_util,
        "interest_out": interest_out,
        "tax": tax,
        "fa_base": by(frames["subledger_fixed_assets"], "period", "gross_cost"),
        "dividends_paid": dividends,
    })
    flows.index.names = ["period", "business_unit_id"]
    idx = pd.MultiIndex.from_product([periods, BUS + ["BU-900"]], names=flows.index.names)
    flows = flows.reindex(idx).fillna(0.0)

    flows["collections"] = (flows.collections_ar + flows.interest_in).round(2)
    flows["operating_disbursements"] = (
        flows.vendor_paid + flows.inventory + flows.payroll + flows.staff
        + flows.rent_util + flows.interest_out + flows.tax).round(2)
    flows["capex"] = (flows.fa_base * CAPEX_RATE).round(2)
    flows["dividends_paid"] = flows.dividends_paid.round(2)
    flows["net"] = flows.collections - flows.operating_disbursements - flows.capex - flows.dividends_paid

    rows = []
    for b in BUS + ["BU-900"]:
        f = flows.xs(b, level="business_unit_id")
        # Opening: ~1.5 months of collections plus a scaled buffer (as before), topped
        # up so a cash-consuming BU (Corporate has no revenue) never drops below that
        # buffer across the history.
        buffer = 250000 * BU_SCALE[b] * _period_scale(periods[0])
        opening = float(f.collections.iloc[0]) * 1.5 + buffer
        lowest = float((opening + f.net.cumsum()).min())
        cash = round(opening + max(0.0, buffer - lowest), 2)
        for period, r in f.iterrows():
            beginning = cash
            cash = round(beginning + r.collections - r.operating_disbursements - r.capex - r.dividends_paid, 2)
            rows.append({
                "period": period, "business_unit_id": b,
                "beginning_cash": beginning,
                "collections": r.collections,
                "operating_disbursements": r.operating_disbursements,
                "capex": r.capex,
                "dividends_paid": r.dividends_paid,
                "ending_cash": cash,
                "source_system": BANK_ERP,
                "load_ts": _period_bounds(period)[3].isoformat(),
            })
    return pd.DataFrame(rows)


def make_cash_settlements(frames: dict[str, pd.DataFrame], periods: list[str],
                          cash_flow: pd.DataFrame, coa: pd.DataFrame) -> pd.DataFrame:
    """GL cash legs for everything make_cash_flow collects or pays, so GL cash
    (10100) rolls exactly like the cash_flow table and AR / AP / accrued balances
    clear instead of accumulating:

      customer receipts   Dr 10100 / Cr 11000   on the invoice's paid_date
      vendor payments     Dr 20000 / Cr 10100   on the invoice's paid_date
      payroll             Dr 22000 / Cr 10100   on the run date
      staff T&E           Dr 21000 / Cr 10100   reimbursed at month end
      interest expense    Dr 21000 / Cr 10100   paid at month end
      income tax          Dr 23000 / Cr 10100   paid at month end
      capex               Dr 15000 / Cr 10100   the cash_flow capex

    Plus one opening entry per BU in the first month: the pre-history invoices that
    are still open (Dr AR / Cr AP), opening cash topped up to cash_flow's beginning
    cash, retained earnings as the balancing leg. Every leg is tagged
    posted_by=SETTLEMENT_POSTER; the subledger-to-GL recons compare invoice
    postings, so they skip these."""
    gl = frames["gl_journal_entries"]
    code_to_id = dict(zip(coa.account_code, coa.account_id))
    rows: list[dict] = []
    seq: dict[str, int] = {}

    def post(period, entry_date, bu, description, legs, source=None):
        """legs: (account_code, dr_cr, amount, business_line). Zero legs are dropped."""
        legs = [(a, d, round(float(v), 2), bl) for a, d, v, bl in legs if round(float(v), 2) != 0]
        if not legs:
            return
        seq[period] = seq.get(period, 0) + 1
        je_id = f"JE-{period}-S{seq[period]:05d}"
        for i, (acct, drcr, amt, bl) in enumerate(legs, start=1):
            if amt < 0:                                   # keep amounts positive
                drcr, amt = ("C" if drcr == "D" else "D"), -amt
            rows.append({
                "je_id": je_id, "je_line": i, "period": period, "entry_date": entry_date,
                "account_code": acct, "business_unit_id": bu, "business_line": bl,
                "dr_cr": drcr, "amount": amt, "source_system": source or erp_of(bu),
                "description": description, "posted_by": SETTLEMENT_POSTER,
            })

    def end_of(period):
        return _period_bounds(period)[1].date().isoformat()

    ar, ap = frames["subledger_ar"], frames["subledger_ap"]
    ar_pre, ap_pre = _pre_history_runoff(ar, periods), _pre_history_runoff(ap, periods)

    # ----- opening balances (first month) -----
    first = periods[0]
    first_start = _period_bounds(first)[0].date().isoformat()
    g0 = gl[(gl.period == first) & (gl.description == "Opening equity seed") & (gl.account_code == "10100")]
    seeded_cash = g0.groupby("business_unit_id")["amount"].sum()
    target_cash = cash_flow[cash_flow.period == first].set_index("business_unit_id")["beginning_cash"]
    for b in BUS + ["BU-900"]:
        open_ar = ar_pre[ar_pre.business_unit_id == b].groupby("business_line")["amount"].sum()
        open_ap = ap_pre[ap_pre.business_unit_id == b].groupby("business_line")["amount"].sum()
        cash_topup = float(target_cash.get(b, 0.0)) - float(seeded_cash.get(b, 0.0))
        plug = float(open_ar.sum()) - float(open_ap.sum()) + cash_topup
        post(first, first_start, b, "Opening balances (pre-history invoices, opening cash)",
             [("11000", "D", v, bl) for bl, v in open_ar.items()]
             + [("20000", "C", v, bl) for bl, v in open_ap.items()]
             + [("10100", "D", cash_topup, SHARED), ("31000", "C", plug, SHARED)])

    # ----- invoice settlements on paid_date -----
    for r in pd.concat([ar_pre, _paid_in_period(ar, periods)]).itertuples():
        post(r.cash_period, r.paid_date, r.business_unit_id, f"Customer receipt {r.invoice_id}",
             [("10100", "D", r.amount, r.business_line), ("11000", "C", r.amount, r.business_line)])
    for r in pd.concat([ap_pre, _paid_in_period(ap, periods)]).itertuples():
        post(r.cash_period, r.paid_date, r.business_unit_id, f"Vendor payment {r.invoice_id}",
             [("20000", "D", r.amount, r.business_line), ("10100", "C", r.amount, r.business_line)])

    # ----- payroll, T&E, interest, tax, capex -----
    for r in frames["subledger_payroll"].itertuples():
        post(r.period, r.run_date, r.business_unit_id, f"Payroll payment {r.payroll_run_id}",
             [("22000", "D", r.amount, SHARED), ("10100", "C", r.amount, SHARED)], source=PAYROLL_ERP)
    staff = frames["subledger_staff_expenses"].groupby(["period", "business_unit_id"])["amount"].sum()
    for (period, b), amt in staff.items():
        post(period, end_of(period), b, "Staff expense reimbursement",
             [("21000", "D", amt, SHARED), ("10100", "C", amt, SHARED)], source=EXPENSE_ERP)
    for code, liability, label in (("71000", "21000", "Interest payment"), ("80000", "23000", "Income tax payment")):
        due = gl[(gl.account_code == code) & (gl.dr_cr == "D")].groupby(["period", "business_unit_id"])["amount"].sum()
        for (period, b), amt in due.items():
            post(period, end_of(period), b, label,
                 [(liability, "D", amt, SHARED), ("10100", "C", amt, SHARED)])
    for r in cash_flow.itertuples():
        post(r.period, end_of(r.period), r.business_unit_id, "Capital expenditure",
             [("15000", "D", r.capex, SHARED), ("10100", "C", r.capex, SHARED)])

    out = pd.DataFrame(rows)
    out["account_id"] = out["account_code"].map(code_to_id)
    out["load_ts"] = out["period"].map(lambda p: _period_bounds(p)[3].isoformat())
    return out[gl.columns]


def make_bank_feed(gl: pd.DataFrame, periods: list[str]) -> pd.DataFrame:
    """Monthly bank statement per operating BU: opening = prior month's closing,
    closing = running GL cash (10100) balance, except the seeded deposit in transit
    at BU-400 on the active close (SEEDED ISSUE 7)."""
    cash = gl[gl.account_code == "10100"]
    signed = cash.amount.where(cash.dr_cr == "D", -cash.amount)
    by_month = signed.groupby([cash.business_unit_id, cash.period]).sum()
    rows = []
    for b in BUS:
        running = 0.0
        for period in periods:
            opening = running
            running = round(running + float(by_month.get((b, period), 0.0)), 2)
            closing, note = running, "Reconciled"
            if period == CLOSE_PERIOD and b == "BU-400":
                closing, note = round(running + BANK_TRANSIT_AMOUNT, 2), "Deposit in transit (timing)"
            end, load = _period_bounds(period)[1], _period_bounds(period)[3]
            rows.append({
                "statement_id": f"BANK-{period}-{b}", "period": period,
                "bank_account": f"NL{b[-3:]}-OPERATING", "business_unit_id": b,
                "statement_date": end.date().isoformat(),
                "opening_balance": round(opening, 2), "closing_balance": closing,
                "note": note, "source_system": BANK_ERP, "load_ts": load.isoformat(),
            })
    return pd.DataFrame(rows)


def _period_seq(end_period: str, n: int) -> list[str]:
    """The n trailing YYYY-MM strings ending at end_period (inclusive)."""
    y, m = int(end_period[:4]), int(end_period[5:7])
    out = []
    for _ in range(n):
        out.append(f"{y:04d}-{m:02d}")
        m -= 1
        if m == 0:
            m, y = 12, y - 1
    return list(reversed(out))


def _inject_payment_anomalies(ar: pd.DataFrame, ap: pd.DataFrame, periods: list[str]) -> list[str]:
    """Inject a few current-close deviations from each counterparty's own norm so
    the anomaly feed has concrete, deterministic stories: a normally-early payer
    now overdue, a chronic-late one paid early, and a vendor we usually pay on
    time now slipping. Mutates `ar`/`ap` in place; returns human-readable notes."""
    notes: list[str] = []
    close_iso = ACTIVE_CLOSE_END.date().isoformat()
    recent = set(periods[-4:])                     # look in the last few months

    def _pick(df, name_col, cat_want):
        names = sorted({n for n in df[name_col].dropna().unique() if _cp_profile(n)[1] == cat_want})
        return names[0] if names else None

    # 1. Normally-EARLY customer, big invoice now OVERDUE (due passed, still unpaid).
    cust = _pick(ar, "customer_name", "early")
    if cust is not None:
        cand = ar[(ar.customer_name == cust) & (ar.period.isin(recent)) & (ar.due_date <= close_iso)]
        if len(cand):
            idx = cand.amount.idxmax()
            ar.loc[idx, "paid_date"] = None
            ar.loc[idx, "status"] = "Overdue"
            notes.append(f"AR: {cust} (usually early) invoice {ar.loc[idx, 'invoice_id']} "
                         f"${ar.loc[idx, 'amount']:,.0f} now overdue")

    # 2. Chronic-LATE customer that (unusually) paid EARLY this close.
    cust2 = _pick(ar, "customer_name", "late")
    if cust2 is not None:
        cand = ar[(ar.customer_name == cust2) & (ar.period == CLOSE_PERIOD)]
        if len(cand):
            idx = cand.amount.idxmax()
            due = datetime.fromisoformat(ar.loc[idx, "due_date"])
            ar.loc[idx, "paid_date"] = (due - timedelta(days=9)).date().isoformat()
            ar.loc[idx, "status"] = "Paid"
            notes.append(f"AR: {cust2} (usually late) paid invoice {ar.loc[idx, 'invoice_id']} early")

    # 3. Vendor we normally pay on time, now OVERDUE (our payment slipping).
    vend = _pick(ap, "vendor_name", "prompt") or _pick(ap, "vendor_name", "early")
    if vend is not None:
        cand = ap[(ap.vendor_name == vend) & (ap.period.isin(recent)) & (ap.due_date <= close_iso)]
        if len(cand):
            idx = cand.amount.idxmax()
            ap.loc[idx, "paid_date"] = None
            ap.loc[idx, "status"] = "Overdue"
            notes.append(f"AP: {vend} (usually on time) invoice {ap.loc[idx, 'invoice_id']} "
                         f"${ap.loc[idx, 'amount']:,.0f} unpaid past due")
    return notes


def make_dim_date(periods: list[str]) -> pd.DataFrame:
    """Small monthly period dimension for clean ordering / labeling in the app."""
    rows = []
    for p in periods:
        y, m = int(p[:4]), int(p[5:7])
        start, _end, days, _load = _period_bounds(p)
        rows.append({
            "period": p,
            "period_key": y * 100 + m,
            "year": y,
            "month": m,
            "quarter": f"Q{(m - 1) // 3 + 1}",
            "month_label": start.strftime("%b %Y"),
            "days_in_period": days,
            "is_active_close": p == CLOSE_PERIOD,
        })
    return pd.DataFrame(rows)


def make_kpi_history_real(gl_all, coa, org, periods: list[str]) -> pd.DataFrame:
    """Real monthly DSO/DPO/DIO/CCC + revenue/opex/net_income per scope, computed
    directly from each period's generated GL (no synthetic drift). Scope coverage:
    consolidated, region, legal entity, business unit, business line. Because each
    period is generated as its own scaled month, the series has genuine trend and
    per-scope shape driven by the actual postings. DSO / DPO use the month-end AR /
    AP balance (settlements clear them); DIO still uses the month's inventory build."""
    merged = gl_all.merge(
        coa[["account_code", "normal_balance", "account_type"]], on="account_code", how="left")
    merged["signed"] = np.where(merged.dr_cr == merged.normal_balance, merged.amount, -merged.amount)

    bu_meta = {r.business_unit_id: r for r in org.itertuples()}
    scopes = [("consolidated", "ALL", "Consolidated", list(bu_meta.keys()))]
    for region in sorted(set(r.region for r in bu_meta.values())):
        members = [b for b, m in bu_meta.items() if m.region == region]
        scopes.append(("region", region, region, members))
    for le in sorted(set((m.legal_entity_id, m.legal_entity_name) for m in bu_meta.values())):
        members = [b for b, m in bu_meta.items() if m.legal_entity_id == le[0]]
        scopes.append(("legal_entity", le[0], le[1], members))
    for bu, m in bu_meta.items():
        scopes.append(("business_unit", bu, m.business_unit_name, [bu]))
    for bl in BUSINESS_LINES + [SHARED]:
        scopes.append(("business_line", bl, bl, None))

    # Month-end AR / AP balances: cumulative postings through each period.
    ctl = merged[merged.account_code.isin(["11000", "20000"])]

    rows = []
    for period in periods:
        _s, _e, days, _l = _period_bounds(period)
        pm = merged[merged.period == period]
        cm = ctl[ctl.period <= period]
        for stype, sid, slabel, members in scopes:
            if stype == "business_line":
                df, bal = pm[pm.business_line == sid], cm[cm.business_line == sid]
            elif members is not None:
                df, bal = pm[pm.business_unit_id.isin(members)], cm[cm.business_unit_id.isin(members)]
            else:
                df, bal = pm, cm
            ar_bal = float(bal.loc[bal.account_code == "11000", "signed"].sum())
            ap_bal = float(bal.loc[bal.account_code == "20000", "signed"].sum())
            inv_bal = float(df.loc[df.account_code == "12000", "signed"].sum())
            rev = float(df.loc[df.account_type == "Revenue", "signed"].sum())
            cogs = float(df.loc[df.account_code == "50000", "signed"].sum())
            opex = float(df.loc[df.account_code.isin(OPEX_ACCOUNTS), "signed"].sum())
            net = rev - float(df.loc[df.account_type == "Expense", "signed"].sum())
            dso = (ar_bal / rev * days) if rev else 0.0
            dpo = (ap_bal / cogs * days) if cogs else 0.0
            dio = (inv_bal / cogs * days) if cogs else 0.0
            rows.append({
                "period": period, "scope_type": stype, "scope_id": sid, "scope_label": slabel,
                "dso": round(dso, 1), "dpo": round(dpo, 1), "dio": round(dio, 1),
                "ccc": round(dso + dio - dpo, 1),
                "revenue": round(rev, 2), "opex": round(opex, 2), "net_income": round(net, 2),
            })
    return pd.DataFrame(rows)


if __name__ == "__main__":
    build()
