"""Shared helpers for the Office of the CFO setup scripts.

Loads config/demo.yaml (the shape of the demo data) and lets the environment
override the workspace-specific values, so the same scripts run against any
workspace. scripts/setup.py sets these from the deployed bundle:

  DATABRICKS_CONFIG_PROFILE  CLI profile; unset inside a Databricks job/notebook
  DATABRICKS_WAREHOUSE_ID    SQL warehouse that executes every statement
  CFO_CATALOG                catalog holding the baseline and industry schemas
"""
from __future__ import annotations

import os
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = REPO_ROOT / "config" / "demo.yaml"


def load_config() -> dict:
    with open(CONFIG_PATH) as f:
        return yaml.safe_load(f)


CFG = load_config()

# DATABRICKS_PROFILE is the older name, still honoured for existing shells.
PROFILE = (os.environ.get("DATABRICKS_CONFIG_PROFILE") or os.environ.get("DATABRICKS_PROFILE")
           or CFG["databricks"].get("profile") or None)
WAREHOUSE_ID = os.environ.get("DATABRICKS_WAREHOUSE_ID") or CFG["databricks"].get("warehouse_id") or ""
CATALOG = os.environ.get("CFO_CATALOG") or CFG["unity_catalog"]["catalog"]
SCHEMAS = CFG["unity_catalog"]["schemas"]
VOLUME = CFG["unity_catalog"]["volume"]
CLOSE_PERIOD = str(CFG["close_period"])
# Trailing months of history to generate (inclusive of CLOSE_PERIOD). 1 == the
# original single-snapshot behavior; 24 == two years for YoY comparisons.
HISTORY_MONTHS = int(CFG.get("history_months", 1) or 1)
from industry_profiles import INDUSTRIES  # noqa: E402,F401  (the one industry list for setup)

RAW = f"{CATALOG}.{SCHEMAS['raw']}"
CLOSE = f"{CATALOG}.{SCHEMAS['close']}"
SERVING = f"{CATALOG}.{SCHEMAS['serving']}"
OPS = f"{CATALOG}.{SCHEMAS['ops']}"
BASELINE = {"raw": RAW, "close": CLOSE, "serving": SERVING, "ops": OPS}

VOLUME_BASE = f"/Volumes/{CATALOG}/{SCHEMAS['raw']}/{VOLUME}"          # close-folder spreadsheets
LANDING_BASE = f"/Volumes/{CATALOG}/{SCHEMAS['raw']}/landing"          # ERP feed files
DOCUMENTS_BASE = f"/Volumes/{CATALOG}/{SCHEMAS['raw']}/close_documents"  # unstructured close support

# Industry schemas live in the same catalog as the baseline. Kept as an alias for
# the scripts that predate the single-catalog layout.
MULTI_CATALOG = CATALOG


def industry_schemas(industry: str, catalog: str | None = None) -> dict[str, str]:
    """Fully-qualified schema names for one industry: {catalog}.{industry}_{layer}."""
    cat = catalog or CATALOG
    return {k: f"{cat}.{industry}_{k}" for k in ("raw", "close", "serving", "ops")}


def render_sql(sql: str, schemas: dict[str, str] | None = None) -> str:
    """Fill the schema placeholders used by the repo's .sql files.

    ``{{raw}}``/``{{close}}``/``{{serving}}``/``{{ops}}`` become fully-qualified
    schema names (``catalog.schema``) and ``{{raw_volume}}``/``{{ops_volume}}`` the
    matching ``/Volumes/catalog/schema`` roots. Defaults to the baseline schemas;
    pass an industry's map to build the same objects for that industry.
    """
    for layer, fq in (schemas or BASELINE).items():
        sql = sql.replace("{{" + layer + "}}", fq)
        sql = sql.replace("{{" + layer + "_volume}}", "/Volumes/" + fq.replace(".", "/", 1))
    return sql


def require_warehouse() -> str:
    """The configured warehouse id, or a clear error naming how to set it."""
    if not WAREHOUSE_ID:
        raise SystemExit(
            "No SQL warehouse configured. Run through scripts/setup.py, or set "
            "DATABRICKS_WAREHOUSE_ID to the id of a SQL warehouse you can use.")
    return WAREHOUSE_ID


def workspace_client():
    """WorkspaceClient for the configured profile, or ambient auth when none is set
    (inside a Databricks job/notebook, or DATABRICKS_HOST/TOKEN in the env)."""
    from databricks.sdk import WorkspaceClient
    return WorkspaceClient(profile=PROFILE) if PROFILE else WorkspaceClient()


OUTPUT_DIR = REPO_ROOT / "data_generation" / "output"
LANDING_OUT = OUTPUT_DIR / "landing"
CLOSE_FOLDER_OUT = OUTPUT_DIR / "close_folder"


def ensure_output_dirs() -> None:
    for d in (LANDING_OUT, CLOSE_FOLDER_OUT):
        d.mkdir(parents=True, exist_ok=True)
