"""Every place that enumerates the industries must agree with industry_profiles.

The setup scripts import industry_profiles.INDUSTRIES, but the app (backend and
frontend) and the bundle cannot, so they keep their own copies. Adding an
industry means touching each of them; this test names the one you missed.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "data_generation"))
from industry_profiles import INDUSTRIES  # noqa: E402

EXPECTED = set(INDUSTRIES)


def _read(rel: str) -> str:
    return (ROOT / rel).read_text()


def test_backend_list():
    m = re.search(r"^INDUSTRIES\s*=\s*\(([^)]*)\)", _read("app/server/industry.py"), re.M)
    assert m, "INDUSTRIES tuple not found in app/server/industry.py"
    assert set(re.findall(r'"([a-z]+)"', m.group(1))) == EXPECTED


def test_frontend_list():
    m = re.search(r"export const INDUSTRIES: Industry\[\] = \[([^\]]*)\]", _read("app/frontend/src/lib/industries.ts"))
    assert m, "INDUSTRIES array not found in app/frontend/src/lib/industries.ts"
    assert set(re.findall(r'"([a-z]+)"', m.group(1))) == EXPECTED


def test_lakebase_database_per_industry():
    body = _read("resources/lakebase.postgres.yml").split("postgres_databases:", 1)[1]
    assert set(re.findall(r"postgres_database: close_([a-z]+)", body)) == EXPECTED


def test_app_env_per_industry():
    env = _read("resources/app.app.yml")
    for prefix in ("PGDATABASE_", "GENIE_SPACE_ID_", "AI_ROI_GENIE_URL_", "AI_ROI_DASHBOARD_URL_"):
        found = {s.lower() for s in re.findall(rf"name: {prefix}([A-Z]+)\b", env)}
        assert found == EXPECTED, f"{prefix}<INDUSTRY> entries in resources/app.app.yml"


def test_bundle_variables_per_industry():
    yml = _read("databricks.yml")
    for prefix in ("genie_space_", "ai_roi_genie_url_", "ai_roi_dashboard_url_"):
        found = set(re.findall(rf"^  {prefix}([a-z]+):", yml, re.M))
        assert found == EXPECTED, f"{prefix}<industry> variables in databricks.yml"


def test_bundle_default_installs_every_industry():
    import yaml
    default = yaml.safe_load(_read("databricks.yml"))["variables"]["industries"]["default"]
    assert default.split(",") == list(INDUSTRIES), "databricks.yml variables.industries default"
