"""Bundle settings that a fresh install and every redeploy depend on."""
from __future__ import annotations

from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]


def test_lakebase_role_takes_the_pinned_service_principal():
    """The role's postgres_role is immutable. Referencing the app's service
    principal directly makes it unknown whenever the same deploy updates the app,
    so the bundle plans to recreate the role, and Lakebase refuses because the
    role owns the databases. setup.py pins the id in app_service_principal."""
    for rel in ("resources/lakebase.postgres.yml", "resources/ai_roi_usage.job.yml"):
        assert "${resources.apps." not in (ROOT / rel).read_text(), rel
    role = yaml.safe_load((ROOT / "resources/lakebase.postgres.yml").read_text())
    assert role["resources"]["postgres_roles"]["app"]["postgres_role"] == "${var.app_service_principal}"
    var = yaml.safe_load((ROOT / "databricks.yml").read_text())["variables"]["app_service_principal"]
    assert var["default"] == "${resources.apps.office_of_cfo.service_principal_client_id}"
