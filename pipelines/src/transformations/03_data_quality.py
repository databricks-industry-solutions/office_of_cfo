"""Act 2/3 — data quality made queryable + Act 4 reconciliation breaks.

Turns the supply chain's quality into *fields the trial balance and Genie can
read*: a per-check results table, a reconciliation-break detail table, and a
single go/no-go close summary (the DQ badge). The checks mirror what a CFO asks
about: completeness, freshness, validity, referential integrity, and
reconciliation integrity — plus schema-drift detection from the spreadsheet
on-ramp.

Published to the ops schema (partially-qualified names, same catalog).
"""
from pyspark import pipelines as dp
from pyspark.sql import functions as F
from pyspark.sql.window import Window

OPS = spark.conf.get("ops_schema")
PERIOD = spark.conf.get("close_period")


def active(table: str):
    """Read a governed table scoped to the active close period. The demo now
    holds ~24 months of history; DQ/recon are a *current-close* motion, so every
    check evaluates only the active period (historical months are read-only)."""
    return spark.read.table(table).filter(F.col("period") == PERIOD)

# Uniform DQ-result columns. NOTE: never use eager actions (.count()/.collect())
# inside a pipeline function -- they can observe empty upstream tables. Keep
# everything lazy.
_RESULT_COLS = ["check_id", "dimension", "scope", "metric_value",
                "threshold", "status", "period", "evaluated_ts"]


def _finalize(df, check_id, dimension, scope, threshold, status_expr):
    return (
        df.withColumn("metric_value", F.col("metric_value").cast("double"))
        .select(
            F.lit(check_id).alias("check_id"),
            F.lit(dimension).alias("dimension"),
            F.lit(scope).alias("scope"),
            "metric_value",
            F.lit(float(threshold)).alias("threshold"),
            status_expr.alias("status"),
            F.lit(PERIOD).alias("period"),
            F.current_timestamp().alias("evaluated_ts"),
        )
    )


FAIL_IF_POS = F.when(F.col("metric_value") > 0, F.lit("FAIL")).otherwise(F.lit("PASS"))

# control account -> (subledger table, amount column, normal balance, name)
CONTROLS = {
    "20000": ("subledger_ap", "amount", "C", "Accounts Payable"),
    "11000": ("subledger_ar", "amount", "D", "Accounts Receivable"),
    "22000": ("subledger_payroll", "amount", "C", "Payroll Liabilities"),
    "12000": ("subledger_inventory", "inventory_value", "D", "Inventory"),
    "10100": ("subledger_bank", "closing_balance", "D", "Cash and Cash Equivalents"),
}
RECON_TOLERANCE = 1.00
SETTLEMENT_POSTER = "treasury.settlement"   # GL cash legs (generate_close_data.make_cash_settlements)


# ---------------------------------------------------------------------------
# Reconciliation breaks (drives the Act 4 recon app)
# ---------------------------------------------------------------------------
@dp.materialized_view(
    name=f"{OPS}.recon_breaks",
    comment="Subledger-to-GL reconciliation by control account x business unit. "
            "is_break flags residual items needing human judgment (Act 4).",
)
def recon_breaks():
    gl_all = spark.read.table("gl_journal_entries").filter(F.col("period") <= PERIOD)
    # Subledgers list the period's invoices, so compare the period's invoice
    # postings (skip the cash settlement legs). The bank statement is a running
    # balance, so cash compares against GL cash through the period.
    invoices = gl_all.filter((F.col("period") == PERIOD) & (F.col("posted_by") != SETTLEMENT_POSTER))
    frames = []
    for control, (subtab, amt_col, normal, acct_name) in CONTROLS.items():
        gl = gl_all if control == "10100" else invoices
        # GL balance for the control account by BU (signed to the natural balance)
        gl_bal = (
            gl.filter(F.col("account_code") == control)
            .groupBy("business_unit_id")
            .agg(
                F.sum(F.when(F.col("dr_cr") == "D", F.col("amount")).otherwise(0)).alias("d"),
                F.sum(F.when(F.col("dr_cr") == "C", F.col("amount")).otherwise(0)).alias("c"),
            )
        )
        if normal == "C":
            gl_bal = gl_bal.withColumn("gl_balance", F.col("c") - F.col("d"))
        else:
            gl_bal = gl_bal.withColumn("gl_balance", F.col("d") - F.col("c"))
        gl_bal = gl_bal.select("business_unit_id", "gl_balance")

        sub = (
            active(subtab)
            .groupBy("business_unit_id")
            .agg(F.sum(amt_col).alias("subledger_total"))
        )
        merged = (
            sub.join(gl_bal, "business_unit_id", "full_outer")
            .fillna(0, ["subledger_total", "gl_balance"])
            .withColumn("control_account_code", F.lit(control))
            .withColumn("account_name", F.lit(acct_name))
            .withColumn("subledger", F.lit(subtab))
            .withColumn("variance",
                        F.col("subledger_total").cast("decimal(18,2)")
                        - F.col("gl_balance").cast("decimal(18,2)"))
            .withColumn("abs_variance", F.abs("variance"))
            .withColumn("is_break", F.col("abs_variance") > F.lit(RECON_TOLERANCE))
            .withColumn("period", F.lit(PERIOD))
            .withColumn("evaluated_ts", F.current_timestamp())
        )
        frames.append(merged)
    out = frames[0]
    for f in frames[1:]:
        out = out.unionByName(f)
    return out.select(
        "period", "control_account_code", "account_name", "subledger",
        "business_unit_id", "subledger_total", "gl_balance", "variance",
        "abs_variance", "is_break", "evaluated_ts",
    )


# ---------------------------------------------------------------------------
# Per-check DQ results
# ---------------------------------------------------------------------------
@dp.materialized_view(
    name=f"{OPS}.dq_results",
    comment="One row per data-quality check across the close. Drives the trial-balance DQ badge.",
)
def dq_results():
    gl = active("gl_journal_entries")
    ap = active("subledger_ap")
    coa = spark.read.table("chart_of_accounts").select("account_code")
    adj = active("close_adjustments")
    breaks = spark.read.table(f"{OPS}.recon_breaks")   # already period-scoped

    frames = []

    # --- completeness: every governed feed landed with rows (one row per feed) ---
    for t in ["gl_journal_entries", "subledger_ap", "subledger_ar",
              "subledger_payroll", "subledger_fixed_assets", "subledger_inventory",
              "subledger_sales_orders", "subledger_procurement", "subledger_bank",
              "subledger_staff_expenses", "close_adjustments"]:
        cnt = active(t).agg(F.count("*").alias("metric_value"))
        frames.append(_finalize(
            cnt, f"completeness_{t}", "completeness", t, threshold=1,
            status_expr=F.when(F.col("metric_value") < 1, F.lit("FAIL")).otherwise(F.lit("PASS"))))

    # --- validity: debits = credits per journal entry ---
    je = gl.groupBy("je_id").agg(
        F.sum(F.when(F.col("dr_cr") == "D", F.col("amount")).otherwise(0)).alias("d"),
        F.sum(F.when(F.col("dr_cr") == "C", F.col("amount")).otherwise(0)).alias("c"),
    )
    unbalanced = (je.withColumn("diff", F.abs(F.col("d") - F.col("c")))
                  .filter("diff > 0.01").agg(F.count("*").alias("metric_value")))
    frames.append(_finalize(unbalanced, "validity_debits_equal_credits", "validity",
                            "gl_journal_entries", 0, FAIL_IF_POS))

    # --- referential integrity: AP expense account exists in COA ---
    orphans = (ap.join(coa, ap.expense_account_code == coa.account_code, "left_anti")
               .agg(F.count("*").alias("metric_value")))
    frames.append(_finalize(orphans, "referential_integrity_ap_account",
                            "referential_integrity", "subledger_ap", 0, FAIL_IF_POS))

    # --- three-way match: PO amount agrees with the invoice it was received against ---
    po = active("subledger_procurement")
    ap_amt = active("subledger_ap").select(
        F.col("invoice_id").alias("m_invoice_id"), F.col("amount").alias("inv_amount"))
    mismatches = (
        po.join(ap_amt, po.matched_invoice_id == ap_amt.m_invoice_id, "inner")
        .withColumn("gap", F.abs(F.col("po_amount") - F.col("inv_amount")))
        .filter("gap > 1.0")
        .agg(F.count("*").alias("metric_value"))
    )
    frames.append(_finalize(mismatches, "three_way_match_po_invoice", "three_way_match",
                            "subledger_procurement", 0, FAIL_IF_POS))

    # --- freshness: per GL source feed, days behind the latest feed (lazy window) ---
    feed_ts = gl.groupBy("source_system").agg(F.max("load_ts").alias("max_ts"))
    feed_ts = feed_ts.withColumn("ref", F.max("max_ts").over(Window.partitionBy()))
    feed_ts = feed_ts.withColumn("lag_days", F.datediff(F.col("ref"), F.col("max_ts")))
    fresh = feed_ts.select(
        F.concat(F.lit("freshness_"), F.col("source_system")).alias("check_id"),
        F.lit("freshness").alias("dimension"),
        F.col("source_system").alias("scope"),
        F.col("lag_days").cast("double").alias("metric_value"),
        F.lit(1.0).alias("threshold"),
        F.when(F.col("lag_days") > 1, F.lit("FAIL")).otherwise(F.lit("PASS")).alias("status"),
        F.lit(PERIOD).alias("period"),
        F.current_timestamp().alias("evaluated_ts"),
    )
    frames.append(fresh)

    # --- reconciliation integrity: count of residual breaks ---
    recon = breaks.filter("is_break").agg(F.count("*").alias("metric_value"))
    frames.append(_finalize(recon, "reconciliation_subledger_to_gl", "reconciliation",
                            "control_accounts", 0, FAIL_IF_POS))

    # --- schema drift: spreadsheets whose columns drifted (detected + healed) ---
    drift = adj.filter("had_schema_drift = true").agg(F.count("*").alias("metric_value"))
    frames.append(_finalize(
        drift, "schema_drift_close_folder", "schema_evolution", "close_adjustments", 0,
        F.when(F.col("metric_value") > 0, F.lit("WARN")).otherwise(F.lit("PASS"))))

    # --- ingestion rejects: landing errors that never reached a governed table ---
    ing = active("ingestion_events")
    ing_fail = ing.filter("status = 'error'").agg(F.count("*").alias("metric_value"))
    frames.append(_finalize(ing_fail, "ingestion_reject_errors", "ingestion",
                            "ingestion_events", 0, FAIL_IF_POS))
    ing_warn = ing.filter("status = 'warning'").agg(F.count("*").alias("metric_value"))
    frames.append(_finalize(
        ing_warn, "ingestion_reject_warnings", "ingestion", "ingestion_events", 0,
        F.when(F.col("metric_value") > 0, F.lit("WARN")).otherwise(F.lit("PASS"))))

    out = frames[0]
    for f in frames[1:]:
        out = out.unionByName(f)
    return out


# ---------------------------------------------------------------------------
# Close-level go/no-go badge
# ---------------------------------------------------------------------------
@dp.materialized_view(
    name=f"{OPS}.dq_summary",
    comment="Single go/no-go close-quality signal (the trial-balance DQ badge).",
)
def dq_summary():
    res = spark.read.table(f"{OPS}.dq_results")
    agg = res.agg(
        F.sum(F.when(F.col("status") == "FAIL", 1).otherwise(0)).alias("fail_count"),
        F.sum(F.when(F.col("status") == "WARN", 1).otherwise(0)).alias("warn_count"),
        F.count("*").alias("total_checks"),
    )
    return agg.withColumn(
        "close_status",
        F.when(F.col("fail_count") > 0, F.lit("NO-GO"))
        .when(F.col("warn_count") > 0, F.lit("GO WITH NOTES"))
        .otherwise(F.lit("GO")),
    ).withColumn(
        "badge",
        F.when(F.col("fail_count") > 0,
               F.concat(F.lit("NO-GO — "), F.col("fail_count").cast("string"), F.lit(" checks failing")))
        .when(F.col("warn_count") > 0,
              F.concat(F.lit("GO WITH NOTES — "), F.col("warn_count").cast("string"), F.lit(" advisories")))
        .otherwise(F.lit("GO — all checks passed")),
    ).withColumn("period", F.lit(PERIOD)).withColumn("evaluated_ts", F.current_timestamp())
