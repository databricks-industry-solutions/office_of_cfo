"""Act 2 — the spreadsheet on-ramp.

Ingests the close-folder "spreadsheets" (CSV exports of the SharePoint
Month-End Close folder) into governed Unity Catalog tables via Auto Loader,
with schema evolution. One file (accruals) renamed its `amount` column to
`adjustment_amount` overnight; Auto Loader's schema evolution captures the new
column instead of silently breaking, and the silver layer coalesces the two
into one governed `amount` — the "self-heal" the Controller approves.

In production this source is the Lakeflow Connect SharePoint connector; here the
UC Volume is the functionally-identical, demoable on-ramp.
"""
from pyspark import pipelines as dp
from pyspark.sql import functions as F

CLOSE_FOLDER = spark.conf.get("close_folder_path")
SCHEMA_LOC = spark.conf.get("schema_location_base")
OPS = spark.conf.get("ops_schema")


@dp.table(
    name="bronze_close_folder_adjustments",
    comment="Raw close-folder spreadsheets ingested with Auto Loader + schema evolution.",
    cluster_by=["adjustment_type"],
)
def bronze_close_folder_adjustments():
    return (
        spark.readStream.format("cloudFiles")
        .option("cloudFiles.format", "csv")
        .option("header", "true")
        .option("cloudFiles.schemaLocation", f"{SCHEMA_LOC}/bronze_close_folder")
        .option("cloudFiles.schemaEvolutionMode", "addNewColumns")
        .option("cloudFiles.inferColumnTypes", "true")
        # Pin business keys to STRING so they join cleanly to the COA / DQ tables
        # (account codes and period are categorical, not numeric/date).
        .option(
            "cloudFiles.schemaHints",
            "adjustment_id string, period string, adjustment_type string, "
            "account_code string, business_unit_id string, dr_cr string, "
            "amount double, adjustment_amount double, memo string, "
            "submitted_by string, submitted_ts string",
        )
        .load(CLOSE_FOLDER)
        .withColumn("_source_file", F.col("_metadata.file_path"))
        .withColumn("_ingested_at", F.current_timestamp())
    )


@dp.materialized_view(
    name="close_adjustments",
    comment="Governed manual adjustments. Unifies the drifted `adjustment_amount` "
            "column back into `amount`; carries spreadsheet provenance for audit (Act 6).",
)
@dp.expect("valid_account", "account_code IS NOT NULL")
@dp.expect("valid_drcr", "dr_cr IN ('D','C')")
@dp.expect("positive_amount", "amount > 0")
def close_adjustments():
    df = spark.read.table("bronze_close_folder_adjustments")
    has_drift = "adjustment_amount" in df.columns
    amount = (
        F.coalesce(F.col("amount").cast("decimal(18,2)"),
                   F.col("adjustment_amount").cast("decimal(18,2)"))
        if has_drift else F.col("amount").cast("decimal(18,2)")
    )
    drift_flag = (F.col("adjustment_amount").isNotNull() if has_drift else F.lit(False))
    return (
        df.withColumn("amount", amount)
        .withColumn("had_schema_drift", drift_flag)
        .withColumn("source_spreadsheet", F.element_at(F.split(F.col("_source_file"), "/"), -1))
        .select(
            "adjustment_id", "period", "adjustment_type", "account_code",
            "business_unit_id", "dr_cr", "amount", "memo", "submitted_by",
            "submitted_ts", "had_schema_drift", "source_spreadsheet", "_ingested_at",
        )
    )
