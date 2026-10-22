"""Build the ZeroOps insights inbox + apply governance comments.

Run:  uv run --with databricks-sdk --with pyyaml python build_governance.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "data_generation"))
from _common import BASELINE, render_sql, require_warehouse, workspace_client  # noqa: E402

w = workspace_client()
SQL_FILE = Path(__file__).with_name("governance.sql")


def split_statements(sql: str) -> list[str]:
    lines = [ln for ln in sql.splitlines() if not ln.strip().startswith("--")]
    return [s.strip() for s in "\n".join(lines).split(";") if s.strip()]


def run(stmt: str, warehouse_id: str):
    resp = w.statement_execution.execute_statement(
        statement=stmt, warehouse_id=warehouse_id, wait_timeout="50s")
    state = resp.status.state.value if resp.status and resp.status.state else "UNKNOWN"
    if state != "SUCCEEDED":
        err = resp.status.error.message if resp.status and resp.status.error else state
        raise RuntimeError(f"FAILED ({state}): {err}")


def label(stmt: str) -> str:
    m = re.search(r"(CREATE (?:OR REPLACE )?TABLE|COMMENT ON TABLE)\s+([\w.`]+)", stmt, re.I)
    return f"{m.group(1)} {m.group(2)}" if m else stmt[:55].replace("\n", " ")


def main():
    warehouse_id = require_warehouse()
    sql_text = render_sql(SQL_FILE.read_text(), BASELINE)
    for stmt in split_statements(sql_text):
        run(stmt, warehouse_id)
        print(f"  OK   {label(stmt)}")
    print("\nMilestone 6 governance + ZeroOps inbox built.")


if __name__ == "__main__":
    main()
