"""Create the Milestone 3 serving layer (trial balance, DQ badge, variance,
metric view) by executing serving_views.sql statement-by-statement on the
configured SQL warehouse.

Run:  uv run --with databricks-sdk --with pyyaml python build_serving.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "data_generation"))
from _common import BASELINE, render_sql, require_warehouse, workspace_client  # noqa: E402

w = workspace_client()
SQL_FILE = Path(__file__).with_name("serving_views.sql")


def split_statements(sql: str) -> list[str]:
    # strip full-line -- comments, then split on ';' (no ';' appears inside the
    # metric-view $$...$$ YAML body or any string literal here).
    lines = [ln for ln in sql.splitlines() if not ln.strip().startswith("--")]
    body = "\n".join(lines)
    return [s.strip() for s in body.split(";") if s.strip()]


def run_sql(stmt: str, warehouse_id: str):
    resp = w.statement_execution.execute_statement(
        statement=stmt, warehouse_id=warehouse_id, wait_timeout="50s")
    state = resp.status.state.value if resp.status and resp.status.state else "UNKNOWN"
    if state != "SUCCEEDED":
        err = resp.status.error.message if resp.status and resp.status.error else state
        raise RuntimeError(f"FAILED ({state}): {err}")
    return resp


def label(stmt: str) -> str:
    m = re.search(r"(CREATE (?:OR REPLACE )?(?:VIEW|TABLE)(?: IF NOT EXISTS)?)\s+([\w.`]+)", stmt, re.I)
    return f"{m.group(1)} {m.group(2)}" if m else stmt[:60].replace("\n", " ")


def main():
    warehouse_id = require_warehouse()
    sql_text = render_sql(SQL_FILE.read_text(), BASELINE)
    statements = split_statements(sql_text)
    print(f"Executing {len(statements)} statements on warehouse {warehouse_id}")
    for stmt in statements:
        try:
            run_sql(stmt, warehouse_id)
            print(f"  OK   {label(stmt)}")
        except Exception as e:
            print(f"  FAIL {label(stmt)}\n       {e}")
            raise
    print("\nMilestone 3 serving layer built.")


if __name__ == "__main__":
    main()
