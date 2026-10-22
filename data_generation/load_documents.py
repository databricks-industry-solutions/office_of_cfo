"""Land the Close Support / IDP source documents into a Unity Catalog Volume.

  1. Creates the `close_documents` volume under <catalog>.<raw schema>.
  2. Uploads competitor filings + contracts (PDF) into filings/ and contracts/.
  3. Uploads manifest.json to the volume root.

The offline extraction pass (close_support/build_close_support.py) then parses +
extracts these with Databricks AI functions into governed tables the app reads.

Run:  uv run --with databricks-sdk --with pyyaml python load_documents.py
"""
from __future__ import annotations

import json
import sys

from _common import CATALOG, SCHEMAS, OUTPUT_DIR, require_warehouse, workspace_client

w = workspace_client()

RAW = f"{CATALOG}.{SCHEMAS['raw']}"
VOLUME = "close_documents"
VOLUME_BASE = f"/Volumes/{CATALOG}/{SCHEMAS['raw']}/{VOLUME}"

DOCS_OUT = OUTPUT_DIR / "documents"


def run_sql(stmt: str, warehouse_id: str):
    resp = w.statement_execution.execute_statement(
        statement=stmt, warehouse_id=warehouse_id, wait_timeout="50s")
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
    print(f"Target volume: {RAW}.{VOLUME}, warehouse: {warehouse_id}")

    run_sql(f"CREATE VOLUME IF NOT EXISTS {RAW}.{VOLUME} "
            f"COMMENT 'Close Support / IDP source documents (competitor filings + contracts)'",
            warehouse_id)

    if DOCS_OUT.exists():
        manifest = json.loads((DOCS_OUT / "manifest.json").read_text())
        print("Uploading documents:")
        for row in manifest:
            local = DOCS_OUT / row["folder"] / row["filename"]
            upload(local, f"{VOLUME_BASE}/{row['folder']}/{row['filename']}")
        upload(DOCS_OUT / "manifest.json", f"{VOLUME_BASE}/manifest.json")
    else:
        print("No generated documents found. Run generate_close_documents.py first.")

    print(f"\nLoaded {len(manifest)} documents into {VOLUME_BASE}.")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
