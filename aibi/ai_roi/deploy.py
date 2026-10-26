"""Create or update per-industry AI/BI dashboards.

This script is intentionally not called by the builder. Run it explicitly only
when provisioning is desired.

Environment:
  DATABRICKS_CONFIG_PROFILE (or DATABRICKS_PROFILE): CLI profile
  DATABRICKS_WAREHOUSE_ID: SQL warehouse (required)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "data_generation"))
from _common import require_warehouse, workspace_client  # noqa: E402

from industry_profiles import INDUSTRIES, profile  # noqa: E402  (the one industry list)
ROOT = Path(__file__).resolve().parents[2]
# Where created ids are recorded so re-runs update in place. scripts/setup.py
# points this at the bundle target's state directory.
ASSETS = Path(os.environ.get("CFO_ASSETS_FILE") or ROOT / "config" / "ai_roi_assets.json")
# Built artifacts: the same folder build.py writes (see CFO_GENERATED_DIR there).
GENERATED = Path(os.environ["CFO_GENERATED_DIR"]) / "aibi" if os.environ.get("CFO_GENERATED_DIR") \
    else Path(__file__).resolve().parent / "generated"


def _host(client) -> str:
    return (client.config.host or "").rstrip("/")


def _refresh_env(config: dict) -> None:
    env: dict[str, str] = {}
    for industry, asset in config["industries"].items():
        suffix = industry.upper()
        if asset.get("dashboard_url"):
            env[f"AI_ROI_DASHBOARD_URL_{suffix}"] = asset["dashboard_url"]
        if asset.get("genie_space_id"):
            env[f"AI_ROI_GENIE_SPACE_ID_{suffix}"] = asset["genie_space_id"]
        if asset.get("genie_url"):
            env[f"AI_ROI_GENIE_URL_{suffix}"] = asset["genie_url"]
    config["app_env"] = env


def _display_name(industry: str) -> str:
    """Dashboard names must be unique in the folder they are created in, so a second
    install in the same workspace (another app name, via --target) gets its own."""
    name = f"AI ROI — {profile(industry)['label']}"
    app = os.environ.get("CFO_APP_NAME", "").strip()
    return f"{name} ({app})" if app and app != "office-of-cfo" else name


def deploy(industry: str, client, warehouse_id: str, config: dict) -> None:
    dashboard = GENERATED / f"{industry}.dashboard.json"
    if not dashboard.exists():
        raise SystemExit(f"Build first: python3 aibi/ai_roi/build.py {industry}")
    serialized = dashboard.read_text()
    # setdefault: a newly added industry has no record in ai_roi_assets.json yet.
    record = config["industries"].setdefault(industry, {})
    dashboard_id = record.get("dashboard_id")
    body = {
        "display_name": _display_name(industry),
        "warehouse_id": warehouse_id,
        "serialized_dashboard": serialized,
    }
    if dashboard_id:
        response = client.api_client.do(
            "PATCH", f"/api/2.0/lakeview/dashboards/{dashboard_id}", body=body
        )
    else:
        response = client.api_client.do(
            "POST", "/api/2.0/lakeview/dashboards", body=body
        )
        dashboard_id = response["dashboard_id"]
    client.api_client.do(
        "POST",
        f"/api/2.0/lakeview/dashboards/{dashboard_id}/published",
        body={"warehouse_id": warehouse_id},
    )
    record["dashboard_id"] = dashboard_id
    record["dashboard_url"] = (
        f"{_host(client)}/sql/dashboardsv3/{dashboard_id}/published"
    )
    print(f"{industry}: {record['dashboard_url']}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("industry", nargs="*", choices=(*INDUSTRIES, "all"),
                        help="industries to process (default: all)")
    args = parser.parse_args()
    warehouse_id = require_warehouse()
    config = json.loads(ASSETS.read_text()) if ASSETS.exists() else {"industries": {}}
    client = workspace_client()
    selected = INDUSTRIES if not args.industry or "all" in args.industry else tuple(args.industry)
    for industry in selected:
        deploy(industry, client, warehouse_id, config)
    _refresh_env(config)
    ASSETS.parent.mkdir(parents=True, exist_ok=True)
    ASSETS.write_text(json.dumps(config, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
