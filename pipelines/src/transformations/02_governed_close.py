"""Act 2 — the self-healing data supply chain (governed close tables).

Reads the ingested ERP feeds (subledgers + GL) from the raw schema and
publishes governed, typed close tables with declared data-quality expectations.
Expectations FLAG rather than drop, so seeded breaks stay visible (the demo's
"breaks are quantified, not hidden" principle). The explicit pass/fail metrics
are computed in 03_data_quality.py for the trial-balance DQ badge.
"""
from pyspark import pipelines as dp
from pyspark.sql import functions as F

CATALOG = spark.conf.get("catalog")
RAW = spark.conf.get("raw_schema")


def raw(table: str) -> str:
    return f"{CATALOG}.{RAW}.{table}"


@dp.materialized_view(name="chart_of_accounts", comment="Governed chart of accounts.")
def chart_of_accounts():
    return spark.read.table(raw("chart_of_accounts"))


@dp.materialized_view(
    name="dim_org",
    comment="Org hierarchy dimension: region -> country -> legal entity -> business unit, "
            "with each unit's primary source system.",
)
def dim_org():
    return spark.read.table(raw("dim_org"))


@dp.materialized_view(
    name="dim_date",
    comment="Monthly period dimension (period, year, quarter, label, days, active-close flag).",
)
def dim_date():
    return spark.read.table(raw("dim_date"))


@dp.materialized_view(
    name="gl_journal_entries",
    comment="Governed general-ledger journal entries for the close period.",
    cluster_by=["period", "account_code"],
)
@dp.expect("valid_account", "account_id IS NOT NULL")
@dp.expect("valid_drcr", "dr_cr IN ('D','C')")
@dp.expect("positive_amount", "amount > 0")
def gl_journal_entries():
    return (
        spark.read.table(raw("gl_journal_entries"))
        .withColumn("amount", F.col("amount").cast("decimal(18,2)"))
        .withColumn("entry_date", F.to_date("entry_date"))
        .withColumn("load_ts", F.to_timestamp("load_ts"))
    )


@dp.materialized_view(name="subledger_ap", comment="AP subledger (vendor invoices) with payment terms / due / paid dates.")
@dp.expect("control_is_ap", "control_account_code = '20000'")
@dp.expect("positive_amount", "amount > 0")
def subledger_ap():
    return (
        spark.read.table(raw("subledger_ap"))
        .withColumn("amount", F.col("amount").cast("decimal(18,2)"))
        .withColumn("invoice_date", F.to_date("invoice_date"))
        .withColumn("due_date", F.to_date("due_date"))
        .withColumn("paid_date", F.to_date("paid_date"))
        .withColumn("load_ts", F.to_timestamp("load_ts"))
    )


@dp.materialized_view(name="subledger_ar", comment="AR subledger (customer invoices) with payment terms / due / paid dates.")
@dp.expect("control_is_ar", "control_account_code = '11000'")
@dp.expect("positive_amount", "amount > 0")
def subledger_ar():
    return (
        spark.read.table(raw("subledger_ar"))
        .withColumn("amount", F.col("amount").cast("decimal(18,2)"))
        .withColumn("invoice_date", F.to_date("invoice_date"))
        .withColumn("due_date", F.to_date("due_date"))
        .withColumn("paid_date", F.to_date("paid_date"))
        .withColumn("load_ts", F.to_timestamp("load_ts"))
    )


@dp.materialized_view(name="subledger_payroll", comment="Payroll subledger (payroll runs).")
@dp.expect("control_is_payroll", "control_account_code = '22000'")
def subledger_payroll():
    return (
        spark.read.table(raw("subledger_payroll"))
        .withColumn("amount", F.col("amount").cast("decimal(18,2)"))
        .withColumn("run_date", F.to_date("run_date"))
        .withColumn("load_ts", F.to_timestamp("load_ts"))
    )


@dp.materialized_view(name="subledger_fixed_assets", comment="Fixed-asset subledger.")
def subledger_fixed_assets():
    return (
        spark.read.table(raw("subledger_fixed_assets"))
        .withColumn("gross_cost", F.col("gross_cost").cast("decimal(18,2)"))
        .withColumn("monthly_depreciation", F.col("monthly_depreciation").cast("decimal(18,2)"))
        .withColumn("load_ts", F.to_timestamp("load_ts"))
    )


@dp.materialized_view(name="subledger_inventory", comment="Inventory subledger (SAP) — on-hand value + product costs.")
@dp.expect("control_is_inventory", "control_account_code = '12000'")
def subledger_inventory():
    return (
        spark.read.table(raw("subledger_inventory"))
        .withColumn("inventory_value", F.col("inventory_value").cast("decimal(18,2)"))
        .withColumn("cogs_amount", F.col("cogs_amount").cast("decimal(18,2)"))
        .withColumn("as_of_date", F.to_date("as_of_date"))
        .withColumn("load_ts", F.to_timestamp("load_ts"))
    )


@dp.materialized_view(name="subledger_sales_orders", comment="Sales orders (SAP) — order-to-cash upstream of AR.")
def subledger_sales_orders():
    return (
        spark.read.table(raw("subledger_sales_orders"))
        .withColumn("order_amount", F.col("order_amount").cast("decimal(18,2)"))
        .withColumn("order_date", F.to_date("order_date"))
        .withColumn("load_ts", F.to_timestamp("load_ts"))
    )


@dp.materialized_view(name="subledger_procurement", comment="Procurement purchase orders (SAP) — procure-to-pay upstream of AP.")
def subledger_procurement():
    return (
        spark.read.table(raw("subledger_procurement"))
        .withColumn("po_amount", F.col("po_amount").cast("decimal(18,2)"))
        .withColumn("order_date", F.to_date("order_date"))
        .withColumn("load_ts", F.to_timestamp("load_ts"))
    )


@dp.materialized_view(name="subledger_bank", comment="Bank statement balances (Bank Feed) — cash/bank reconciliation.")
def subledger_bank():
    return (
        spark.read.table(raw("subledger_bank"))
        .withColumn("opening_balance", F.col("opening_balance").cast("decimal(18,2)"))
        .withColumn("closing_balance", F.col("closing_balance").cast("decimal(18,2)"))
        .withColumn("statement_date", F.to_date("statement_date"))
        .withColumn("load_ts", F.to_timestamp("load_ts"))
    )


@dp.materialized_view(
    name="cash_flow",
    comment="Per-BU cash-flow statement (beginning/collections/disbursements/capex/dividends/ending).",
)
@dp.expect(
    "reconciles",
    "abs(ending_cash - (beginning_cash + collections - operating_disbursements - capex - dividends_paid)) < 1.0",
)
def cash_flow():
    def dec(c):
        return F.col(c).cast("decimal(18,2)")

    return (
        spark.read.table(raw("cash_flow"))
        .withColumn("beginning_cash", dec("beginning_cash"))
        .withColumn("collections", dec("collections"))
        .withColumn("operating_disbursements", dec("operating_disbursements"))
        .withColumn("capex", dec("capex"))
        .withColumn("dividends_paid", dec("dividends_paid"))
        .withColumn("ending_cash", dec("ending_cash"))
        .withColumn("load_ts", F.to_timestamp("load_ts"))
    )


@dp.materialized_view(name="subledger_staff_expenses", comment="Employee T&E claims (Workday).")
def subledger_staff_expenses():
    return (
        spark.read.table(raw("subledger_staff_expenses"))
        .withColumn("amount", F.col("amount").cast("decimal(18,2)"))
        .withColumn("claim_date", F.to_date("claim_date"))
        .withColumn("load_ts", F.to_timestamp("load_ts"))
    )


@dp.materialized_view(name="budget_forecast", comment="IS forecast by account x business unit.")
def budget_forecast():
    return (
        spark.read.table(raw("budget_forecast"))
        .withColumn("forecast_amount", F.col("forecast_amount").cast("decimal(18,2)"))
    )


@dp.materialized_view(name="kpi_history", comment="Trailing monthly DSO/DPO/DIO/CCC snapshots per scope (direction of travel).")
def kpi_history():
    return spark.read.table(raw("kpi_history"))


@dp.materialized_view(
    name="ingestion_events",
    comment="Landing-time rejects/quarantine (never reached a governed subledger). "
            "Feeds the Data & Audit lineage Sankey ingestion band.",
)
def ingestion_events():
    return (
        spark.read.table(raw("ingestion_events"))
        .withColumn("amount", F.col("amount").cast("decimal(18,2)"))
        .withColumn("event_ts", F.to_timestamp("event_ts"))
    )
