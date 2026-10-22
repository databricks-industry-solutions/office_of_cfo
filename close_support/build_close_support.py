"""Build the Close Support / IDP governed tables + serving views.

Runs statement-by-statement on the configured SQL warehouse:
  1. build_close_support.sql   — ai_parse_document + ai_extract + ai_query -> Delta
  2. serving_close_support.sql — serving views the app reads

AI statements can run longer than a single wait window, so this polls the
statement to completion rather than failing on PENDING/RUNNING.

Run:  uv run --with databricks-sdk --with pyyaml python build_close_support.py
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

from databricks.sdk import WorkspaceClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "data_generation"))
from _common import BASELINE, PROFILE, render_sql, workspace_client  # noqa: E402

w = workspace_client()
SQL_FILES = [
    Path(__file__).with_name("build_close_support.sql"),
    Path(__file__).with_name("serving_close_support.sql"),
]


def split_statements(sql: str) -> list[str]:
    lines = [ln for ln in sql.splitlines() if not ln.strip().startswith("--")]
    return [s.strip() for s in "\n".join(lines).split(";") if s.strip()]


def label(stmt: str) -> str:
    import re
    m = re.search(r"(CREATE (?:OR REPLACE )?(?:VIEW|TABLE)(?: IF NOT EXISTS)?)\s+([\w.`]+)", stmt, re.I)
    return f"{m.group(1)} {m.group(2)}" if m else stmt[:60].replace("\n", " ")


def main():
    from _common import require_warehouse  # noqa: E402
    warehouse_id = require_warehouse()

    for sql_file in SQL_FILES:
        sql_text = render_sql(sql_file.read_text(), BASELINE)
        statements = split_statements(sql_text)
        print(f"\n{sql_file.name}: {len(statements)} statements on warehouse {warehouse_id}")
        for stmt in statements:
            try:
                resp = w.statement_execution.execute_statement(
                    statement=stmt, warehouse_id=warehouse_id, wait_timeout="50s")
                sid = resp.statement_id
                while resp.status and resp.status.state and resp.status.state.value in ("PENDING", "RUNNING"):
                    time.sleep(3)
                    resp = w.statement_execution.get_statement(sid)
                state = resp.status.state.value if resp.status and resp.status.state else "UNKNOWN"
                if state != "SUCCEEDED":
                    err = resp.status.error.message if resp.status and resp.status.error else state
                    raise RuntimeError(f"FAILED ({state}): {err}")
                print(f"  OK   {label(stmt)}")
            except Exception as e:
                print(f"  FAIL {label(stmt)}\n       {e}")
                raise
    print("\nClose Support build complete.")


if __name__ == "__main__":
    main()
