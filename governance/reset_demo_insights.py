#!/usr/bin/env python3
"""Restore the ZeroOps "Approve repair" items to a clean demo-ready state.

Usage:
    python governance/reset_demo_insights.py [industry ...]   # default: every industry

Runs governance/reset_demo_insights.sql against each industry's ops schema (the
one the app reads). Safe to run repeatedly (idempotent UPDATE). Needs
DATABRICKS_WAREHOUSE_ID, and DATABRICKS_CONFIG_PROFILE outside a workspace.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "data_generation"))
from _common import (  # noqa: E402
    INDUSTRIES, industry_schemas, render_sql, require_warehouse, workspace_client,
)

SQL_FILE = Path(__file__).with_name("reset_demo_insights.sql")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("industries", nargs="*", choices=INDUSTRIES)
    args = parser.parse_args()
    warehouse_id = require_warehouse()
    w = workspace_client()
    for industry in args.industries or INDUSTRIES:
        resp = w.statement_execution.execute_statement(
            statement=render_sql(SQL_FILE.read_text(), industry_schemas(industry)),
            warehouse_id=warehouse_id, wait_timeout="50s")
        state = resp.status.state.value if resp.status and resp.status.state else "UNKNOWN"
        if state != "SUCCEEDED":
            err = resp.status.error.message if resp.status and resp.status.error else state
            raise SystemExit(f"{industry}: reset failed ({state}): {err}")
        print(f"{industry}: ZeroOps insights reset")
    print("Refresh the app (Cmd+Shift+R) and you'll have PROPOSED repairs to approve.")


if __name__ == "__main__":
    main()
