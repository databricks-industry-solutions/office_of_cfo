"""Lineage + data-quality evidence: one contract for the Sankey and the record table.

Industry-agnostic flow registry (stable ids). Source-system *labels* are remapped
per industry; ids, tables, and stages stay the same.
"""
from __future__ import annotations

from collections import defaultdict
from typing import Callable, Iterable

# Stable flow ids — never industry-specific.
FLOW_IDS = (
    "gl", "ar", "sales-orders", "ap", "procurement",
    "inventory", "product-costs", "fixed-assets", "bank",
    "payroll", "staff-expenses", "planning",
)

STAGES = ("ingestion", "post_ingestion", "reconciliation", "close")
STATUSES = ("success", "warning", "error", "unavailable")

FLOWS: tuple[dict, ...] = (
    {"flow_id": "gl", "domain": "General Ledger", "source_token": "SAP / AFAS",
     "table": "gl_journal_entries", "value_chain": "Record to Report",
     "record_key": "je_id", "note": "Balanced journal entries from every ERP."},
    {"flow_id": "ar", "domain": "Accounts Receivable", "source_token": "SAP / AFAS",
     "table": "subledger_ar", "value_chain": "Order to Cash",
     "record_key": "invoice_id", "note": "Customer invoices behind DSO."},
    {"flow_id": "sales-orders", "domain": "Sales Orders", "source_token": "CRM",
     "table": "subledger_sales_orders", "value_chain": "Order to Cash",
     "record_key": "sales_order_id", "note": "Order-to-cash upstream of AR."},
    {"flow_id": "ap", "domain": "Accounts Payable", "source_token": "SAP / AFAS",
     "table": "subledger_ap", "value_chain": "Procure to Pay",
     "record_key": "invoice_id", "note": "Vendor invoices behind DPO."},
    {"flow_id": "procurement", "domain": "Procurement", "source_token": "SAP",
     "table": "subledger_procurement", "value_chain": "Procure to Pay",
     "record_key": "purchase_order_id", "note": "Purchase orders; 3-way matched against AP."},
    {"flow_id": "inventory", "domain": "Inventory", "source_token": "SAP",
     "table": "subledger_inventory", "value_chain": "Inventory & Cost",
     "record_key": "inventory_item_id", "note": "On-hand value behind DIO."},
    {"flow_id": "product-costs", "domain": "Product Costs", "source_token": "SAP",
     "table": "subledger_inventory", "value_chain": "Inventory & Cost",
     "record_key": "inventory_item_id", "note": "Standard unit costs feeding COGS."},
    {"flow_id": "fixed-assets", "domain": "Fixed Assets", "source_token": "SAP",
     "table": "subledger_fixed_assets", "value_chain": "Record to Report",
     "record_key": "asset_id", "note": "Asset register and monthly depreciation."},
    {"flow_id": "bank", "domain": "Bank Accounts", "source_token": "Bank Feed",
     "table": "subledger_bank", "value_chain": "Treasury & Cash",
     "record_key": "statement_id", "note": "Bank statement balances reconciled to GL cash."},
    {"flow_id": "payroll", "domain": "Payroll", "source_token": "Workday",
     "table": "subledger_payroll", "value_chain": "Hire to Retire",
     "record_key": "payroll_run_id", "note": "Payroll runs posted to payroll liabilities."},
    {"flow_id": "staff-expenses", "domain": "Staff Expenses", "source_token": "Workday",
     "table": "subledger_staff_expenses", "value_chain": "Hire to Retire",
     "record_key": "expense_claim_id", "note": "Employee travel & expense claims."},
    {"flow_id": "planning", "domain": "Planning Accruals", "source_token": "Planning",
     "table": "close_adjustments", "value_chain": "Record to Report",
     "record_key": "adjustment_id", "note": "Planning-system accruals posted into the close folder."},
)

FLOWS_BY_ID = {f["flow_id"]: f for f in FLOWS}


def _record(
    *,
    record_id: str,
    flow_id: str,
    status: str,
    stage: str,
    source_system: str,
    entity: str | None,
    amount: float | None,
    event_ts: str,
    regions: list[str],
    rule: str | None,
    message: str | None,
    attributes: dict,
    provenance: dict,
    issues: list[dict] | None = None,
) -> dict:
    flow = FLOWS_BY_ID[flow_id]
    return {
        "record_id": record_id,
        "flow_id": flow_id,
        "status": status,
        "stage": stage,
        "source_system": source_system,
        "domain": flow["domain"],
        "value_chain": flow["value_chain"],
        "table": flow["table"],
        "entity": entity,
        "amount": amount,
        "event_ts": event_ts,
        "regions": regions,
        "rule": rule,
        "message": message,
        "attributes": attributes,
        "provenance": provenance,
        "issues": issues or ([{
            "check_id": rule, "dimension": stage, "status": "FAIL" if status == "error" else "WARN",
            "message": message,
        }] if rule else []),
        "activity": [],
    }


def synthetic_success(
    flow_id: str,
    n: int,
    source_label: Callable[[str], str],
    period: str,
) -> list[dict]:
    """Deterministic success samples so every flow ribbon has rows to drill into."""
    flow = FLOWS_BY_ID[flow_id]
    src = source_label(flow["source_token"])
    regions = ("AMER", "EMEA", "APAC")
    units = ("BU-100", "BU-200", "BU-300", "BU-400")
    rows = []
    for i in range(n):
        region = regions[i % 3]
        bu = units[i % 4]
        rows.append(_record(
            record_id=f"{flow_id.upper()}-OK-{period}-{i:03d}",
            flow_id=flow_id,
            status="success",
            stage="post_ingestion",
            source_system=src,
            entity=bu,
            amount=round(1200.0 + i * 37.5, 2),
            event_ts=f"{period}-30T23:00:00",
            regions=[region],
            rule=None,
            message=None,
            attributes={flow["record_key"]: f"{flow_id}-{i:03d}"},
            provenance={
                "source_table": flow["table"],
                "source_system": src,
                "load_id": f"close-{period}",
                "record_key": flow["record_key"],
                "sampled": True,
            },
        ))
    return rows


def demo_evidence(period: str, source_label: Callable[[str], str]) -> list[dict]:
    """Deterministic ingestion + post-ingestion examples (all industries)."""
    sap = source_label("SAP / AFAS")
    sap_only = source_label("SAP")
    crm = source_label("CRM")
    planning = source_label("Planning")
    bank = source_label("Bank Feed")
    workday = source_label("Workday")
    load = f"{period}-30T23:00:00"
    ingest_ts = f"{period}-29T06:12:00"
    rows: list[dict] = []

    def add(**kw):
        rows.append(_record(**kw))

    # --- errors (ingestion, post-ingestion, reconciliation) ---
    add(record_id=f"ING-{period}-AP-SCHEMA", flow_id="ap", status="error",
        stage="ingestion", source_system=sap, entity="BU-200", amount=18420.0,
        event_ts=ingest_ts, regions=["EMEA"],
        rule="ingestion_schema_reject",
        message="Vendor invoice rejected at landing: unexpected column `gross_amt`.",
        attributes={"file": "sap_ap_extract.csv", "row": 4412},
        provenance={"source_file": "sap_ap_extract.csv", "target_table": "subledger_ap",
                    "load_id": f"land-{period}-ap", "rejected": True})
    add(record_id=f"ING-{period}-PAY-TIMEOUT", flow_id="payroll", status="error",
        stage="ingestion", source_system=workday, entity="BU-100", amount=None,
        event_ts=ingest_ts, regions=["AMER", "EMEA"],
        rule="ingestion_timeout",
        message="Workday payroll extract timed out; 14 rows not landed.",
        attributes={"run_id": f"WD-{period}-R07"},
        provenance={"source_file": "workday_payroll.xml", "target_table": "subledger_payroll",
                    "load_id": f"land-{period}-payroll", "rejected": True})
    add(record_id=f"ING-{period}-SO-REJECT", flow_id="sales-orders", status="error",
        stage="ingestion", source_system=crm, entity="BU-200", amount=18800.0,
        event_ts=ingest_ts, regions=["EMEA"],
        rule="ingestion_schema_reject",
        message="CRM order rejected: `booked_arr` is not numeric.",
        attributes={"file": "salesforce_orders.csv", "row": 902},
        provenance={"source_file": "salesforce_orders.csv", "target_table": "subledger_sales_orders",
                    "load_id": f"land-{period}-so", "rejected": True})
    add(record_id=f"JE-{period}-LEGACY01", flow_id="gl", status="error",
        stage="post_ingestion", source_system=sap, entity="BU-300", amount=1250.0,
        event_ts=load, regions=["APAC"],
        rule="validity_debits_equal_credits",
        message="Legacy-ERP journal debits ≠ credits by $1,250.00.",
        attributes={"je_id": f"JE-{period}-LEGACY01", "diff": 1250.0},
        provenance={"source_table": "gl_journal_entries", "source_system": sap,
                    "load_id": f"close-{period}", "je_id": f"JE-{period}-LEGACY01"})
    add(record_id="ADJ-ACCRUAL-DRIFT", flow_id="gl", status="warning",
        stage="post_ingestion", source_system=sap, entity="BU-100", amount=8800.0,
        event_ts=load, regions=["AMER"],
        rule="schema_drift_close_folder",
        message="Accruals spreadsheet renamed `amount` → `adjustment_amount` (healed).",
        attributes={"source_spreadsheet": f"accruals_{period}.csv", "had_schema_drift": True},
        provenance={"source_file": f"accruals_{period}.csv", "target_table": "close_adjustments",
                    "load_id": f"close-folder-{period}"})
    add(record_id=f"AP-{period}-ORPHAN", flow_id="ap", status="error",
        stage="post_ingestion", source_system=sap, entity="BU-100", amount=6400.0,
        event_ts=load, regions=["AMER"],
        rule="referential_integrity_ap_account",
        message="AP invoice references account 99999, which is not on the chart.",
        attributes={"expense_account_code": "99999"},
        provenance={"source_table": "subledger_ap", "load_id": f"close-{period}"})
    add(record_id=f"FA-{period}-STALE", flow_id="fixed-assets", status="error",
        stage="post_ingestion", source_system=sap_only, entity="BU-200", amount=None,
        event_ts=f"{period}-27T23:00:00", regions=["EMEA"],
        rule="freshness_fixed_assets",
        message="Fixed-assets feed is 3 days behind the latest close load.",
        attributes={"lag_days": 3},
        provenance={"source_table": "subledger_fixed_assets", "load_id": f"close-{period}"})
    add(record_id=f"PO-{period}-MISMATCH", flow_id="procurement", status="error",
        stage="post_ingestion", source_system=sap_only, entity="BU-400", amount=3100.0,
        event_ts=load, regions=["AMER"],
        rule="three_way_match_po_invoice",
        message="PO amount differs from its matched AP invoice.",
        attributes={"control": "three_way_match"},
        provenance={"source_table": "subledger_procurement", "load_id": f"close-{period}"})
    add(record_id=f"PC-{period}-STD-COST", flow_id="product-costs", status="error",
        stage="post_ingestion", source_system=sap_only, entity="BU-100", amount=890.0,
        event_ts=load, regions=["AMER"],
        rule="validity_standard_cost",
        message="SKU standard cost is zero while on-hand quantity is positive.",
        attributes={"sku": "SKU-4401"},
        provenance={"source_table": "subledger_inventory", "load_id": f"close-{period}"})
    add(record_id=f"EXP-{period}-POLICY", flow_id="staff-expenses", status="error",
        stage="post_ingestion", source_system=workday, entity="BU-200", amount=4120.0,
        event_ts=load, regions=["EMEA"],
        rule="policy_expense_limit",
        message="Expense claim exceeds the unreceipted limit.",
        attributes={"claim_id": f"EXP-{period}-991"},
        provenance={"source_table": "subledger_staff_expenses", "load_id": f"close-{period}"})
    add(record_id=f"PLN-{period}-SIGN", flow_id="planning", status="error",
        stage="post_ingestion", source_system=planning, entity="BU-300", amount=22000.0,
        event_ts=load, regions=["APAC"],
        rule="validity_accrual_sign",
        message="Planning accrual posted with a credit where a debit is required.",
        attributes={"adjustment_id": f"ADJ-{period}-PLAN01"},
        provenance={"source_table": "close_adjustments", "load_id": f"close-{period}"})
    add(record_id=f"RECON-AP-{period}-BU-300", flow_id="ap", status="error",
        stage="reconciliation", source_system=sap, entity="BU-300", amount=18400.0,
        event_ts=load, regions=["APAC"],
        rule="reconciliation_subledger_to_gl",
        message="AP subledger vs GL timing break (invoices in subledger, delayed in GL).",
        attributes={"control_account_code": "20000", "business_unit_id": "BU-300"},
        provenance={"source_table": "recon_breaks_live", "load_id": f"close-{period}"})
    add(record_id=f"RECON-INV-{period}-BU-100", flow_id="inventory", status="error",
        stage="reconciliation", source_system=sap_only, entity="BU-100", amount=12750.0,
        event_ts=load, regions=["AMER"],
        rule="reconciliation_subledger_to_gl",
        message="Inventory relief (COGS) missing from GL.",
        attributes={"control_account_code": "12000", "business_unit_id": "BU-100"},
        provenance={"source_table": "recon_breaks_live", "load_id": f"close-{period}"})
    add(record_id=f"RECON-BANK-{period}-BU-400", flow_id="bank", status="error",
        stage="reconciliation", source_system=bank, entity="BU-400", amount=6250.0,
        event_ts=load, regions=["AMER"],
        rule="reconciliation_subledger_to_gl",
        message="Bank statement deposit in transit vs GL cash.",
        attributes={"control_account_code": "10100", "business_unit_id": "BU-400"},
        provenance={"source_table": "recon_breaks_live", "load_id": f"close-{period}"})

    # One warning on every flow, then extra ingestion / post-ingestion warnings.
    _src = {
        "gl": sap, "ar": sap, "sales-orders": crm, "ap": sap, "procurement": sap_only,
        "inventory": sap_only, "product-costs": sap_only, "fixed-assets": sap_only,
        "bank": bank, "payroll": workday, "staff-expenses": workday, "planning": planning,
    }
    per_flow = (
        ("gl", "post_ingestion", "threshold_unposted_journals",
         "12 journals sit in draft past the close calendar.", "BU-100", "AMER", 2100.0),
        ("ar", "ingestion", "ingestion_duplicate_key",
         "Duplicate invoice key quarantined; original row kept.", "BU-100", "AMER", 9200.0),
        ("sales-orders", "ingestion", "ingestion_late_file",
         "CRM order extract arrived 6 hours after the landing SLA.", "BU-200", "EMEA", 4400.0),
        ("ap", "ingestion", "ingestion_soft_schema",
         "Optional column `payment_terms` missing; defaulted to NET30.", "BU-400", "AMER", 800.0),
        ("procurement", "post_ingestion", "threshold_open_po_age",
         "PO has been open 94 days with no goods receipt.", "BU-300", "APAC", 15600.0),
        ("inventory", "post_ingestion", "threshold_negative_qty",
         "On-hand quantity rounded negative after unit-of-measure conversion.", "BU-100", "AMER", 240.0),
        ("product-costs", "post_ingestion", "threshold_cost_variance",
         "Standard vs actual cost variance exceeds 8% on this SKU.", "BU-200", "EMEA", 610.0),
        ("fixed-assets", "ingestion", "ingestion_rounding",
         "Depreciation amount rounded; 4 cents carried to next period.", "BU-400", "AMER", 0.04),
        ("bank", "ingestion", "ingestion_late_file",
         "Bank statement file landed after the 06:00 cutoff.", "BU-100", "AMER", None),
        ("payroll", "post_ingestion", "threshold_payroll_variance",
         "Payroll run is 2.1% above the prior-period baseline.", "BU-200", "EMEA", 18800.0),
        ("staff-expenses", "ingestion", "ingestion_duplicate_key",
         "Expense claim submitted twice; second row quarantined.", "BU-300", "APAC", 340.0),
        ("planning", "post_ingestion", "schema_drift_close_folder",
         "Planning extract renamed `amount` → `adjustment_amount` (healed).", "BU-100", "AMER", 8800.0),
    )
    extra = (
        ("gl", "ingestion", "ingestion_soft_schema",
         "Memo field truncated at 255 characters.", "BU-200", "EMEA", None),
        ("gl", "post_ingestion", "threshold_manual_journals",
         "Manual journal count is above the monthly control limit.", "BU-400", "AMER", 500.0),
        ("ar", "post_ingestion", "threshold_dso_outlier",
         "Invoice terms look like a DSO outlier versus the customer median.", "BU-300", "APAC", 22000.0),
        ("ar", "ingestion", "ingestion_rounding",
         "FX conversion rounded; residual parked on clearing.", "BU-200", "EMEA", 1.12),
        ("sales-orders", "post_ingestion", "threshold_unbilled",
         "Booked order has no invoice after 21 days.", "BU-100", "AMER", 7600.0),
        ("sales-orders", "ingestion", "ingestion_duplicate_key",
         "CRM opportunity id reused across two orders.", "BU-400", "AMER", 1900.0),
        ("ap", "post_ingestion", "threshold_duplicate_vendor",
         "Same vendor invoice number posted on two entities.", "BU-200", "EMEA", 4100.0),
        ("ap", "ingestion", "ingestion_late_file",
         "AP extract split across two files; second file was late.", "BU-300", "APAC", None),
        ("procurement", "ingestion", "ingestion_soft_schema",
         "Buyer code not in reference data; mapped to UNKNOWN.", "BU-100", "AMER", 2700.0),
        ("inventory", "ingestion", "ingestion_late_file",
         "Cycle-count file missed the nightly landing window.", "BU-200", "EMEA", None),
        ("product-costs", "ingestion", "ingestion_rounding",
         "Unit cost precision dropped from 6 to 2 decimals.", "BU-300", "APAC", 0.18),
        ("fixed-assets", "post_ingestion", "threshold_fully_depreciated",
         "Asset still in service after net book value hit zero.", "BU-100", "AMER", 0.0),
        ("bank", "post_ingestion", "threshold_unmatched_id",
         "Statement line has no matching GL cash posting yet.", "BU-200", "EMEA", 950.0),
        ("payroll", "ingestion", "ingestion_soft_schema",
         "New earning code `OT-NIGHT` not on the mapping table.", "BU-400", "AMER", None),
        ("staff-expenses", "post_ingestion", "threshold_missing_receipt",
         "Claim over $75 has no receipt image attached.", "BU-100", "AMER", 180.0),
        ("planning", "ingestion", "ingestion_late_file",
         "Planning close pack arrived after the controller lock.", "BU-200", "EMEA", 13400.0),
        ("planning", "post_ingestion", "threshold_flash_vs_actual",
         "Flash accrual differs from the booked amount by more than 5%.", "BU-400", "AMER", 2700.0),
        ("inventory", "post_ingestion", "threshold_slow_moving",
         "SKU has had no movement in 180 days.", "BU-400", "AMER", 5100.0),
    )
    for i, (fid, stage, rule, msg, entity, region, amount) in enumerate((*per_flow, *extra)):
        add(record_id=f"WARN-{period}-{fid}-{i:02d}", flow_id=fid, status="warning",
            stage=stage, source_system=_src[fid], entity=entity, amount=amount,
            event_ts=ingest_ts if stage == "ingestion" else load, regions=[region],
            rule=rule, message=msg,
            attributes={"warning": True},
            provenance={"target_table": FLOWS_BY_ID[fid]["table"], "load_id": f"close-{period}"})

    return rows


def attach_activity(records: list[dict], events: Iterable[dict]) -> list[dict]:
    by_rec: dict[str, list[dict]] = defaultdict(list)
    for e in events:
        rid = e.get("record_id")
        if rid:
            by_rec[rid].append(e)
    out = []
    for rec in records:
        attached = sorted(by_rec.get(rec["record_id"], []), key=lambda a: a.get("ts") or "")
        out.append({**rec, "activity": attached})
    return out


def filter_records(
    records: list[dict],
    *,
    flow_id: str | None = None,
    node_id: str | None = None,
    status: str | None = None,
    stage: str | None = None,
    source_system: str | None = None,
    search: str | None = None,
    regions: list[str] | None = None,
    business_units: list[str] | None = None,
) -> list[dict]:
    q = (search or "").strip().lower()
    out = []
    for r in records:
        if flow_id and r["flow_id"] != flow_id:
            continue
        if status and r["status"] != status:
            continue
        if stage and r["stage"] != stage:
            continue
        if source_system and r["source_system"] != source_system:
            continue
        if node_id:
            ids = {
                f"sys:{r['source_system']}",
                f"dom:{r['domain']}",
                f"chain:{r['value_chain']}",
                "close",
                f"flow:{r['flow_id']}",
            }
            if node_id not in ids:
                continue
        rec_regions = r.get("regions") or []
        if regions is not None and rec_regions and not any(x in regions for x in rec_regions):
            continue
        if business_units is not None:
            attr_bu = (r.get("attributes") or {}).get("business_unit_id")
            entity = r.get("entity")
            resolved = attr_bu or (entity if str(entity or "").startswith("BU-") else None)
            if resolved and resolved not in business_units:
                continue
        if q:
            blob = " ".join([
                r.get("record_id") or "",
                r.get("entity") or "",
                r.get("rule") or "",
                r.get("message") or "",
                r.get("source_system") or "",
                r.get("domain") or "",
            ]).lower()
            if q not in blob:
                continue
        out.append(r)
    return out


def overlay_success_totals(
    success_totals: dict[str, int] | None,
    *,
    scoped: bool = False,
    scoped_totals: dict[str, int] | None = None,
) -> dict[str, int] | None:
    """Company-wide coverage must not stand in for a scoped Controller view.

    When `scoped` is false, return the governed company totals. When a region /
    legal-entity / business-unit cut is active, only `scoped_totals` (warehouse
    counts for that cut) may overlay the sample rows; otherwise drop the overlay
    so headlines follow the filtered records.
    """
    if not scoped:
        return success_totals
    return scoped_totals


def paginate(records: list[dict], offset: int = 0, limit: int = 50) -> tuple[list[dict], int]:
    offset = max(0, int(offset or 0))
    limit = max(1, min(int(limit or 50), 200))
    return records[offset:offset + limit], len(records)


def summarize(records: list[dict]) -> dict:
    counts = {s: 0 for s in STATUSES}
    last = None
    for r in records:
        st = r.get("status")
        if st in counts:
            counts[st] += 1
        ts = r.get("event_ts")
        if ts and (last is None or ts > last):
            last = ts
    total = sum(counts.values())
    return {
        "total": total,
        "success": counts["success"],
        "warning": counts["warning"],
        "error": counts["error"],
        "unavailable": counts["unavailable"],
        "last_ingestion": last,
    }


def _unavailable_stubs(coverage: dict, source_label: Callable[[str], str]) -> list[dict]:
    stubs = []
    for flow in FLOWS:
        fid = flow["flow_id"]
        cov = coverage.get(fid) or {}
        if cov.get("available"):
            continue
        src = source_label(flow["source_token"])
        stubs.append(_record(
            record_id=f"UNAVAIL-{fid}",
            flow_id=fid,
            status="unavailable",
            stage="ingestion",
            source_system=src,
            entity=None,
            amount=None,
            event_ts="",
            regions=[],
            rule="source_unavailable",
            message="Governed feed could not be read (warehouse unreachable or empty coverage).",
            attributes={},
            provenance={"target_table": flow["table"]},
        ))
    return stubs


def assemble(
    *,
    coverage: dict,
    issue_records: list[dict],
    success_records: list[dict],
    activity: Iterable[dict],
    coverage_ok: bool,
    source_label: Callable[[str], str] | None = None,
    success_totals: dict[str, int] | None = None,
) -> dict:
    """Build the canonical record universe + graph from the same rows.

    `success_totals` (per flow_id) lets the Sankey use governed row volume while
    the table only materializes a page of success samples. Issue bands always
    count the issue records themselves.
    """
    remap = source_label or (lambda t: t)
    records = list(issue_records)
    if coverage_ok:
        records.extend(success_records)
    else:
        records.extend(_unavailable_stubs(coverage, remap))
        success_totals = None
    records = attach_activity(records, activity)
    graph = build_graph(records, coverage, coverage_ok, remap, success_totals)
    return {"records": records, "graph": graph, "success_totals": success_totals or {}}


def build_graph(
    records: list[dict],
    coverage: dict,
    coverage_ok: bool,
    source_label: Callable[[str], str],
    success_totals: dict[str, int] | None = None,
) -> dict:
    by_flow_status: dict[tuple[str, str], int] = defaultdict(int)
    for r in records:
        by_flow_status[(r["flow_id"], r["status"])] += 1

    nodes: dict[str, dict] = {}
    links: list[dict] = []

    def add_node(nid: str, name: str, stage: int):
        n = nodes.get(nid)
        if n is None:
            nodes[nid] = {"id": nid, "name": name, "stage": stage, "counts": {s: 0 for s in STATUSES}}
            n = nodes[nid]
        return n

    close = add_node("close", "Consolidated Close", 3)

    for flow in FLOWS:
        fid = flow["flow_id"]
        src_name = source_label(flow["source_token"])
        sys_id = f"sys:{src_name}"
        dom_id = f"dom:{flow['domain']}"
        chain_id = f"chain:{flow['value_chain']}"
        add_node(sys_id, src_name, 0)
        add_node(dom_id, flow["domain"], 1)
        add_node(chain_id, flow["value_chain"], 2)
        for status in STATUSES:
            if status == "success" and success_totals is not None:
                n = int(success_totals.get(fid, 0) or 0)
            else:
                n = by_flow_status.get((fid, status), 0)
            if n <= 0:
                continue
            for src, tgt in ((sys_id, dom_id), (dom_id, chain_id), (chain_id, "close")):
                links.append({
                    "source": src,
                    "target": tgt,
                    "value": n,
                    "status": status,
                    "flow_id": fid,
                    "id": f"{fid}|{status}|{src}|{tgt}",
                })
            nodes[sys_id]["counts"][status] += n
            nodes[dom_id]["counts"][status] += n
            nodes[chain_id]["counts"][status] += n
            close["counts"][status] += n

    summary = summarize(records)
    if success_totals is not None:
        summary["success"] = sum(int(v or 0) for v in success_totals.values())
        summary["total"] = (
            summary["success"] + summary["warning"] + summary["error"] + summary["unavailable"]
        )
    systems = sorted({source_label(f["source_token"]) for f in FLOWS})
    last_loads = [c.get("last_load") for c in coverage.values() if c.get("last_load")]
    if last_loads:
        summary["last_ingestion"] = max(str(x) for x in last_loads)
    return {
        "nodes": list(nodes.values()),
        "links": links,
        "summary": summary,
        "systems": systems,
        "stages": list(STAGES),
        "flows": [
            {
                **{k: f[k] for k in ("flow_id", "domain", "table", "value_chain", "record_key", "note")},
                "source_system": source_label(f["source_token"]),
                "row_count": (coverage.get(f["flow_id"]) or {}).get("row_count"),
                "last_load": (coverage.get(f["flow_id"]) or {}).get("last_load"),
                "available": bool((coverage.get(f["flow_id"]) or {}).get("available")),
            }
            for f in FLOWS
        ],
        "partial": not coverage_ok,
        "filters": {
            "statuses": list(STATUSES),
            "stages": list(STAGES),
            "systems": systems,
            "flow_ids": list(FLOW_IDS),
        },
    }


def implied_flows(
    *,
    flow_id: str | None = None,
    node_id: str | None = None,
    source_system: str | None = None,
    source_label: Callable[[str], str] | None = None,
) -> set[str]:
    """Flows a selection covers, read off the registry rather than sampled rows.

    Success volume is governed row count, so a flow that materializes no sample
    rows of its own (two flows can share one table) still has to be counted.
    """
    label = source_label or (lambda t: t)
    out: set[str] = set()
    for f in FLOWS:
        fid = f["flow_id"]
        if flow_id and fid != flow_id:
            continue
        src = label(f["source_token"])
        if source_system and src != source_system:
            continue
        if node_id and node_id not in {
            f"sys:{src}",
            f"dom:{f['domain']}",
            f"chain:{f['value_chain']}",
            "close",
            f"flow:{fid}",
        }:
            continue
        out.add(fid)
    return out


def records_response(
    records: list[dict],
    *,
    flow_id: str | None = None,
    node_id: str | None = None,
    status: str | None = None,
    stage: str | None = None,
    source_system: str | None = None,
    search: str | None = None,
    regions: list[str] | None = None,
    business_units: list[str] | None = None,
    offset: int = 0,
    limit: int = 50,
    success_totals: dict[str, int] | None = None,
    source_label: Callable[[str], str] | None = None,
) -> dict:
    summary_records = filter_records(
        records, flow_id=flow_id, node_id=node_id, stage=stage,
        source_system=source_system, search=search, regions=regions,
        business_units=business_units,
    )
    filtered = filter_records(summary_records, status=status)
    page, total = paginate(filtered, offset, limit)
    totals = summarize(summary_records)
    # Governed volume only describes rows that landed clean, so a free-text search
    # or a non-landing stage must fall back to the rows actually materialized.
    governed = (
        success_totals is not None
        and not (search or "").strip()
        and stage in (None, "", "post_ingestion")
    )
    if governed:
        implied = implied_flows(
            flow_id=flow_id, node_id=node_id, source_system=source_system,
            source_label=source_label,
        )
        succ = sum(int(success_totals.get(fid, 0) or 0) for fid in implied)
        totals["success"] = succ
        totals["total"] = succ + totals["warning"] + totals["error"] + totals["unavailable"]
        if status == "success":
            total = succ
        elif not status:
            total = totals["total"]
    return {
        "records": page,
        "total": total,
        "offset": max(0, int(offset or 0)),
        "limit": max(1, min(int(limit or 50), 200)),
        "totals": totals,
        "matched_flow_ids": sorted({r["flow_id"] for r in filtered if r.get("flow_id")}),
    }
