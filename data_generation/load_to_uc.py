"""Land the generated close data into Unity Catalog.

  1. Creates the baseline schemas and volumes (landing, close_folder, close_documents, pipeline_metadata).
  2. Uploads ERP feed parquet files -> /Volumes/.../landing/
  3. Uploads close-folder spreadsheets (CSV) -> /Volumes/.../close_folder/
  4. Builds raw Delta tables in {catalog}.baseline_raw from the parquet feeds.
  5. Prints row-count verification.

Close-folder CSVs are intentionally left as *files* (not tables) here -- they are
the simulated SharePoint folder, ingested with schema evolution by the Lakeflow
pipeline in Milestone 2.

Run:  uv run --with databricks-sdk --with pyyaml python load_to_uc.py
"""
from __future__ import annotations

import sys
import time

from _common import (
    CATALOG, CLOSE_FOLDER_OUT, LANDING_BASE, LANDING_OUT, OPS, RAW,
    SCHEMAS, VOLUME, VOLUME_BASE, require_warehouse, workspace_client,
)

w = workspace_client()

ERP_FEEDS = [
    "dim_org", "chart_of_accounts", "dim_date", "gl_journal_entries",
    "subledger_ap", "subledger_ar", "subledger_payroll",
    "subledger_fixed_assets", "subledger_inventory", "subledger_sales_orders",
    "subledger_procurement", "subledger_bank", "subledger_staff_expenses",
    "cash_flow", "budget_forecast", "kpi_history", "ingestion_events",
]

# Tables carrying a `period` column benefit from liquid clustering on period now
# that the demo holds ~24 months of history (was a single snapshot before).
PERIOD_CLUSTERED = {
    "gl_journal_entries", "subledger_ap", "subledger_ar", "subledger_payroll",
    "subledger_fixed_assets", "subledger_inventory", "subledger_sales_orders",
    "subledger_procurement", "subledger_bank", "subledger_staff_expenses",
    "cash_flow", "budget_forecast", "kpi_history",
}


def run_sql(stmt: str, warehouse_id: str):
    resp = w.statement_execution.execute_statement(
        statement=stmt, warehouse_id=warehouse_id, wait_timeout="50s",
    )
    state = resp.status.state.value if resp.status and resp.status.state else "UNKNOWN"
    if state != "SUCCEEDED":
        err = resp.status.error.message if resp.status and resp.status.error else state
        raise RuntimeError(f"SQL failed ({state}): {err}\n  -- {stmt[:120]}")
    return resp


def upload(local_path, volume_path):
    with open(local_path, "rb") as f:
        w.files.upload(volume_path, f, overwrite=True)
    print(f"  uploaded {volume_path}")


def main():
    warehouse_id = require_warehouse()
    print(f"Target catalog: {CATALOG}, warehouse: {warehouse_id}")

    # 1. create baseline schemas
    for schema in SCHEMAS.values():
        run_sql(f"CREATE SCHEMA IF NOT EXISTS {CATALOG}.{schema}", warehouse_id)
    print(f"  Created baseline schemas: {', '.join(SCHEMAS.values())}")

    # 2. create baseline volumes
    volumes_to_create = [
        (f"{RAW}.landing", "ERP source feeds (subledgers, GL, COA, budget) landing zone"),
        (f"{RAW}.{VOLUME}", "Close-folder spreadsheets (simulated SharePoint)"),
        (f"{RAW}.close_documents", "Unstructured close-support documents (PDFs)"),
        (f"{OPS}.pipeline_metadata", "Lakeflow pipeline metadata (Auto Loader schemas)"),
    ]
    for vol_fq, comment in volumes_to_create:
        run_sql(f"CREATE VOLUME IF NOT EXISTS {vol_fq} COMMENT '{comment}'", warehouse_id)
    print(f"  Created baseline volumes: {', '.join(v for v, _ in volumes_to_create)}")

    # 3. upload ERP feeds
    print("Uploading ERP feed files:")
    for name in ERP_FEEDS:
        upload(LANDING_OUT / f"{name}.parquet", f"{LANDING_BASE}/{name}/{name}.parquet")
    upload(LANDING_OUT / "seeded_issues_manifest.json", f"{LANDING_BASE}/seeded_issues_manifest.json")

    # 4. upload close-folder spreadsheets
    print("Uploading close-folder spreadsheets:")
    for csv in sorted(CLOSE_FOLDER_OUT.glob("*.csv")):
        upload(csv, f"{VOLUME_BASE}/{csv.name}")

    # 5. build raw Delta tables from parquet
    print("Building raw Delta tables:")
    for name in ERP_FEEDS:
        cluster = " CLUSTER BY (period)" if name in PERIOD_CLUSTERED else ""
        run_sql(
            f"CREATE OR REPLACE TABLE {RAW}.{name}{cluster} AS "
            f"SELECT * FROM read_files('{LANDING_BASE}/{name}/', format => 'parquet')",
            warehouse_id
        )
        print(f"  {RAW}.{name}{cluster}")

    # 6. verify
    print("\nRow counts:")
    for name in ERP_FEEDS:
        r = run_sql(f"SELECT COUNT(*) AS n FROM {RAW}.{name}", warehouse_id)
        n = r.result.data_array[0][0]
        print(f"  {name:28s} {n}")

    print("\nMilestone 1 load complete.")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
