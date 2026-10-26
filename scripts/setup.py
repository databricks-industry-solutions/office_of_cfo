#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "databricks-sdk>=0.81",
#   "pyyaml",
#   "numpy",
#   "pandas",
#   "pyarrow",
#   "scikit-learn",
#   "reportlab",
# ]
# ///
"""Install the Office of the CFO solution into a Databricks workspace, end to end.

    uv run scripts/setup.py --profile <cli-profile> --company "<company>" [--var catalog=<catalog>] ...

--company is your company's name: the app shows it in the top bar, and
competitor benchmarking asks the model for its listed peers. Setup asks for it
when it is not given. --industries (comma-separated, default all five) limits the
install to some industries; the app then lists only those. Both are remembered
for later runs.

Every step is idempotent. If one fails, fix the cause and resume from it with
``--from <step>``; ``--to <step>`` stops after a step. Steps, in order:

  catalog     create the catalog if it is missing (the bundle's pipeline needs it)
  deploy      databricks bundle deploy: SQL warehouse, Lakebase project and
              databases, close pipeline, usage job, and the app
  data        generate the synthetic company locally, load it to baseline_raw
  pipeline    run the Lakeflow close pipeline (baseline_close, baseline_ops)
  baseline    build the baseline serving views, close support and governance
  industries  clone + relabel the baseline into the five industries (+ AI ROI)
  grants      give the app's service principal access to the solution's schemas
  genie       create and curate the Genie spaces (self-service + AI ROI)
  dashboards  publish the AI ROI dashboard for each industry
  app         hand the Genie/dashboard ids to the app, redeploy and start it

``--teardown`` removes everything this script and the bundle created, and
``--print-env`` prints the exports for running the app locally against it. State
(created Genie space / dashboard ids) lives in .databricks/bundle/<target>/.
"""
from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "data_generation"))

STEPS = ("catalog", "deploy", "data", "pipeline", "baseline", "industries",
         "grants", "genie", "dashboards", "app")
from _common import INDUSTRIES  # noqa: E402  (config/demo.yaml)
APP_KEY = "office_of_cfo"          # resource key in resources/app.app.yml
WAREHOUSE_KEY = "cfo_warehouse"    # resource key in resources/warehouse.sql_warehouse.yml
LAYERS = ("raw", "close", "serving", "ops")
NOT_INSTALLED = "not-installed"    # app env value for an industry left out by --industries


class Setup:
    def __init__(self, args: argparse.Namespace):
        self.profile = args.profile
        self.target = args.target
        self.user_vars = args.var or []
        self.state_dir = REPO / ".databricks" / "bundle" / self.target
        self.assets_file = self.state_dir / "ai_roi_assets.json"
        self.overrides_file = self.state_dir / "variable-overrides.json"
        self._summary: dict | None = None
        self._w = None
        self.company = ""
        self.industries: tuple[str, ...] = INDUSTRIES

    # --- the company the app is set up for ----------------------------------
    def saved_overrides(self) -> dict:
        return json.loads(self.overrides_file.read_text()) if self.overrides_file.exists() else {}

    def save_overrides(self, values: dict, drop: tuple[str, ...] = ()) -> None:
        self.state_dir.mkdir(parents=True, exist_ok=True)
        merged = {k: v for k, v in (self.saved_overrides() | values).items() if k not in drop}
        self.overrides_file.write_text(json.dumps(merged, indent=2, sort_keys=True) + "\n")

    def resolve_company(self, given: str | None, ask: bool = True) -> None:
        """Set the bundle variable company_name: --company, else --var company_name=,
        else the value saved by an earlier run, else ask. Saved for later runs."""
        from_var = next((v.split("=", 1)[1] for v in self.user_vars
                         if v.startswith("company_name=")), None)
        name = given or from_var or self.saved_overrides().get("company_name") or ""
        if not name.strip() and ask:
            if not sys.stdin.isatty():
                raise SystemExit('No company name given. Re-run with --company "<company name>".')
            name = input("Your company name (shown in the app; benchmarking suggests its listed peers): ")
        name = " ".join(name.split())[:120]
        if len(name) < 2 and ask:
            raise SystemExit('A company name is required: --company "<company name>".')
        self.company = name
        if name and name != self.saved_overrides().get("company_name"):
            self.save_overrides({"company_name": name})
            print(f"Company: {name} (saved in {self.overrides_file.relative_to(REPO)})", flush=True)

    def resolve_industries(self, given: str | None) -> None:
        """Set the bundle variable industries: --industries, else --var industries=,
        else the value saved by an earlier run, else all. Saved for later runs."""
        from_var = next((v.split("=", 1)[1] for v in self.user_vars
                         if v.startswith("industries=")), None)
        raw = given or from_var or self.saved_overrides().get("industries") or ",".join(INDUSTRIES)
        wanted = {i.strip().lower() for i in raw.split(",") if i.strip()}
        unknown = sorted(wanted - set(INDUSTRIES))
        if unknown or not wanted:
            raise SystemExit(f"Unknown industries: {', '.join(unknown) or repr(raw)}. "
                             f"Choose from: {', '.join(INDUSTRIES)}.")
        self.industries = tuple(i for i in INDUSTRIES if i in wanted)
        value = ",".join(self.industries)
        if value != self.saved_overrides().get("industries", ",".join(INDUSTRIES)):
            self.save_overrides({"industries": value})
            print(f"Industries: {value} (saved in {self.overrides_file.relative_to(REPO)})", flush=True)

    # --- bundle CLI ---------------------------------------------------------
    def bundle(self, *cmd: str, capture: bool = False, extra_vars: dict | None = None) -> str:
        argv = ["databricks", "bundle", *cmd, "-t", self.target]
        if self.profile:
            argv += ["--profile", self.profile]
        for v in self.user_vars:
            if not v.startswith(("company_name=", "industries=")):
                argv += ["--var", v]
        for k, v in (extra_vars or {}).items():
            argv += ["--var", f"{k}={v}"]
        # The CLI splits --var values on commas ("industries=consumer,fsi", "Acme,
        # Inc."), so these two go through BUNDLE_VAR_<name> instead. Teardown can run
        # without a known company; the variable just needs a value.
        bundle_env = {"BUNDLE_VAR_company_name": self.company or "unset",
                      "BUNDLE_VAR_industries": ",".join(self.industries)}
        shown = " ".join(f"{k}={shlex.quote(v)}" for k, v in bundle_env.items())
        print(f"$ {shown} " + " ".join(argv), file=sys.stderr, flush=True)
        res = subprocess.run(argv, cwd=REPO, env=os.environ | bundle_env, text=True, check=False,
                             stdout=subprocess.PIPE if capture else None)
        if res.returncode != 0:
            raise SystemExit(f"`databricks bundle {cmd[0]}` failed (exit {res.returncode}).")
        return res.stdout or ""

    def summary(self) -> dict:
        if self._summary is None:
            self._summary = json.loads(self.bundle("summary", "-o", "json", capture=True))
        return self._summary

    def var(self, name: str) -> str:
        return str(self.summary()["variables"][name]["value"])

    @property
    def catalog(self) -> str:
        return self.var("catalog")

    @property
    def app_name(self) -> str:
        return self.var("app_name")

    @property
    def w(self):
        if self._w is None:
            from databricks.sdk import WorkspaceClient
            self._w = WorkspaceClient(profile=self.profile) if self.profile else WorkspaceClient()
        return self._w

    @property
    def host(self) -> str:
        return (self.w.config.host or "").rstrip("/")

    def warehouse_id(self) -> str:
        wid = self.summary()["resources"]["sql_warehouses"][WAREHOUSE_KEY].get("id")
        if not wid:
            raise SystemExit("The bundle has not created the SQL warehouse yet; run the deploy step.")
        return wid

    def app_sp(self) -> str:
        sp = self.w.apps.get(self.app_name).service_principal_client_id
        if not sp:
            raise SystemExit(f"App {self.app_name} has no service principal yet; run the deploy step.")
        return sp

    def pin_app_service_principal(self) -> None:
        """Record the app's service principal as the bundle variable
        app_service_principal once the app exists (see databricks.yml for why).
        A missing app (first install, another app name, after teardown) unpins it,
        so the bundle falls back to the app it creates."""
        from databricks.sdk.errors import NotFound
        try:
            sp = self.w.apps.get(self.app_name).service_principal_client_id or ""
        except NotFound:
            sp = ""
        saved = self.saved_overrides().get("app_service_principal", "")
        if sp != saved:
            self.save_overrides({"app_service_principal": sp} if sp else {},
                                drop=() if sp else ("app_service_principal",))

    # --- helpers ------------------------------------------------------------
    def env(self) -> dict[str, str]:
        env = dict(os.environ)
        env.update({
            "CFO_CATALOG": self.catalog,
            "DATABRICKS_WAREHOUSE_ID": self.warehouse_id(),
            "CFO_ASSETS_FILE": str(self.assets_file),
            # Names the dashboards of a second install apart from the first.
            "CFO_APP_NAME": self.app_name,
            # Built Genie / dashboard artifacts stay out of the repo's generated/ folder.
            "CFO_GENERATED_DIR": str(self.state_dir / "generated"),
            # Stream the scripts' progress even when output goes to a file or CI log.
            "PYTHONUNBUFFERED": "1",
        })
        if self.profile:
            env["DATABRICKS_CONFIG_PROFILE"] = self.profile
        return env

    def script(self, path: str, *args: str, env: dict[str, str] | None = None) -> None:
        print(f"\n$ python {path} {' '.join(args)}", flush=True)
        subprocess.run([sys.executable, str(REPO / path), *args], cwd=REPO,
                       env=env or self.env(), check=True)

    def sql(self, statement: str, warehouse_id: str | None = None) -> list[list]:
        from databricks.sdk.service.sql import StatementState
        resp = self.w.statement_execution.execute_statement(
            statement=statement, warehouse_id=warehouse_id or self.warehouse_id(), wait_timeout="50s")
        while resp.status.state in (StatementState.PENDING, StatementState.RUNNING):
            resp = self.w.statement_execution.get_statement(resp.statement_id)
        if resp.status.state != StatementState.SUCCEEDED:
            msg = resp.status.error.message if resp.status.error else resp.status.state
            raise RuntimeError(f"{msg}\n  -- {statement[:160]}")
        return (resp.result.data_array or []) if resp.result else []

    def assets(self) -> dict:
        if self.assets_file.exists():
            return json.loads(self.assets_file.read_text())
        return {"industries": {}}

    def save_assets(self, data: dict) -> None:
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.assets_file.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")

    def demo_schemas(self, industries: tuple[str, ...] | None = None) -> list[str]:
        """Baseline schemas plus those of the given industries (default: installed)."""
        from _common import SCHEMAS, industry_schemas
        out = [f"{self.catalog}.{s}" for s in SCHEMAS.values()]
        for ind in industries or self.industries:
            out += list(industry_schemas(ind, self.catalog).values())
        return out

    def set_permissions(self, object_type: str, object_id: str, acl: list[dict]) -> None:
        self.w.api_client.do("PATCH", f"/api/2.0/permissions/{object_type}/{object_id}",
                             body={"access_control_list": acl})

    # --- steps --------------------------------------------------------------
    def step_deploy(self) -> None:
        self.pin_app_service_principal()
        self.bundle("deploy")
        self._summary = None
        self.pin_app_service_principal()

    def step_catalog(self) -> None:
        from databricks.sdk.errors import DatabricksError, NotFound
        try:
            self.w.catalogs.get(self.catalog)
            print(f"Catalog {self.catalog} exists.")
            return
        except NotFound:
            pass
        # This runs before the deploy, so the bundle's warehouse may not exist yet.
        # The UC API needs a metastore storage root; workspaces on Default Storage
        # refuse it and only accept CREATE CATALOG in SQL, so fall back to running
        # that on a warehouse the user already has.
        try:
            self.w.catalogs.create(name=self.catalog, comment="Office of the CFO (scripts/setup.py)")
            print(f"Created catalog {self.catalog}.")
            return
        except DatabricksError as e:
            api_error = e
        warehouse = self._existing_warehouse()
        if not warehouse:
            raise SystemExit(self._catalog_help(api_error))
        try:
            self.sql(f"CREATE CATALOG IF NOT EXISTS `{self.catalog}` "
                     "COMMENT 'Office of the CFO (scripts/setup.py)'", warehouse_id=warehouse)
            print(f"Created catalog {self.catalog}.")
        except RuntimeError as e:
            raise SystemExit(self._catalog_help(e))

    def _existing_warehouse(self) -> str | None:
        """The bundle's warehouse if it is deployed, else a serverless warehouse the
        user can see (running ones first), for statements that run before deploy."""
        wid = self.summary()["resources"]["sql_warehouses"][WAREHOUSE_KEY].get("id")
        if wid:
            return wid
        warehouses = [w for w in self.w.warehouses.list() if w.enable_serverless_compute]
        warehouses.sort(key=lambda w: (w.state is None or w.state.value != "RUNNING"))
        return warehouses[0].id if warehouses else None

    def _catalog_help(self, error: Exception) -> str:
        return (f"Could not create catalog {self.catalog}: {error}\n"
                "Ask a metastore admin to create it (or grant you CREATE CATALOG), or re-run "
                "with --var catalog=<an existing catalog you can create schemas in>.")

    def step_data(self) -> None:
        self.script("data_generation/generate_close_data.py")
        self.script("data_generation/generate_close_documents.py")
        self.script("data_generation/load_to_uc.py")
        self.script("data_generation/load_documents.py")

    def step_pipeline(self) -> None:
        self.bundle("run", "close_pipeline")

    def step_baseline(self) -> None:
        self.script("serving/build_serving.py")
        self.script("close_support/build_close_support.py")
        self.script("governance/build_governance.py")

    def step_industries(self) -> None:
        env = self.env() | {"CFO_APP_SP_IDS": self.app_sp()}
        self.script("data_generation/seed_industries.py", *self.industries, env=env)

    def step_grants(self) -> None:
        sp = self.app_sp()
        self.sql(f"GRANT USE CATALOG ON CATALOG `{self.catalog}` TO `{sp}`")
        for schema in self.demo_schemas():
            self.sql(f"GRANT USE SCHEMA, SELECT, MODIFY, CREATE TABLE, READ VOLUME, "
                     f"WRITE VOLUME, EXECUTE ON SCHEMA {schema} TO `{sp}`")
        print(f"Granted the app service principal ({sp}) access to "
              f"{len(self.demo_schemas())} schemas in {self.catalog}.")

    def _self_service_space(self, industry: str) -> dict:
        """serialized_space for an industry's self-service space, from genie/genie_space.yaml."""
        import uuid

        import yaml
        from _common import industry_schemas, render_sql
        spec = yaml.safe_load(render_sql((REPO / "genie" / "genie_space.yaml").read_text(),
                                         industry_schemas(industry, self.catalog)))
        tables, metric_views = [], []
        for name in spec["tables"]:
            kind = self.w.tables.get(name).table_type
            (metric_views if kind and kind.value == "METRIC_VIEW" else tables).append({"identifier": name})
        questions = [{"id": uuid.uuid5(uuid.NAMESPACE_URL, f"office-of-cfo/{industry}/{q}").hex,
                      "question": [q]} for q in spec["sample_questions"]]
        data_sources = {"tables": sorted(tables, key=lambda t: t["identifier"])}
        if metric_views:
            data_sources["metric_views"] = sorted(metric_views, key=lambda t: t["identifier"])
        return {
            "title": f"{spec['display_name']} ({industry})",
            "description": spec["description"].strip(),
            "serialized_space": json.dumps({
                "version": 2,
                "config": {"sample_questions": sorted(questions, key=lambda q: q["id"])},
                "data_sources": data_sources,
            }),
        }

    def step_genie(self) -> None:
        sp = self.app_sp()
        data = self.assets()
        for ind in self.industries:
            record = data["industries"].setdefault(ind, {})
            if not record.get("self_service_space_id"):
                body = self._self_service_space(ind) | {"warehouse_id": self.warehouse_id()}
                resp = self.w.api_client.do("POST", "/api/2.0/genie/spaces", body=body)
                record["self_service_space_id"] = resp.get("space_id") or resp["id"]
                self.save_assets(data)
            space = record["self_service_space_id"]
            self.script("genie/curate_space.py", ind,
                        env=self.env() | {f"GENIE_SPACE_ID_{ind.upper()}": space})
            # The app chats with this space as its service principal.
            self.set_permissions("genie", space, [
                {"service_principal_name": sp, "permission_level": "CAN_RUN"},
                {"group_name": "users", "permission_level": "CAN_RUN"},
            ])
        self.script("genie/ai_roi/build.py", "--catalog", self.catalog, *self.industries)
        self.script("genie/ai_roi/deploy.py", *self.industries)
        for ind, record in self.assets()["industries"].items():
            if ind in self.industries and record.get("genie_space_id"):
                self.set_permissions("genie", record["genie_space_id"],
                                     [{"group_name": "users", "permission_level": "CAN_RUN"}])

    def step_dashboards(self) -> None:
        self.script("aibi/ai_roi/build.py", "--catalog", self.catalog, *self.industries)
        self.script("aibi/ai_roi/deploy.py", *self.industries)
        for ind, record in self.assets()["industries"].items():
            if ind in self.industries and record.get("dashboard_id"):
                self.set_permissions("dashboards", record["dashboard_id"],
                                     [{"group_name": "users", "permission_level": "CAN_READ"}])

    def app_vars(self) -> dict[str, str]:
        """Genie space and dashboard values for the app, per industry. An industry
        that is not installed gets a placeholder: starting the app rejects empty
        values, and the app never reads them because it only serves installed ones."""
        out: dict[str, str] = {}
        records = self.assets()["industries"]
        for ind in INDUSTRIES:
            record = records.get(ind, {}) if ind in self.industries else None
            for var, key in (("genie_space", "self_service_space_id"),
                             ("ai_roi_genie_url", "genie_url"),
                             ("ai_roi_dashboard_url", "dashboard_url")):
                out[f"{var}_{ind}"] = NOT_INSTALLED if record is None else record.get(key, "")
        return out

    def step_app(self) -> None:
        values = self.app_vars()
        # Starting the app rejects an env var with an empty value, with an error that
        # does not name it, so check first and say which step fills it.
        missing = sorted(k for k, v in values.items() if not v)
        if missing:
            raise SystemExit(f"No value yet for {', '.join(missing)}. Run the genie and dashboards "
                             "steps first (--from genie).")
        # Persist for later plain `databricks bundle deploy` runs, and pass them
        # explicitly on this one.
        self.save_overrides(values)
        self.pin_app_service_principal()
        self.bundle("deploy", extra_vars=values)
        self.bundle("run", APP_KEY, extra_vars=values)
        url = self.w.apps.get(self.app_name).url
        print(f"\nOffice of the CFO is running: {url}")

    # --- local development --------------------------------------------------
    def print_env(self) -> None:
        """Shell exports that point a local app server at this deployment."""
        import shlex
        env = {
            "MULTI_CATALOG": self.catalog,
            "DATABRICKS_WAREHOUSE_ID": self.warehouse_id(),
            "LAKEBASE_PROJECT": self.var("lakebase_project"),
            "CFO_CONTACT_EMAIL": self.var("contact_email"),
            "CFO_COMPANY_NAME": self.company,
            "CFO_INDUSTRIES": ",".join(self.industries),
        }
        if self.profile:
            env["DATABRICKS_CONFIG_PROFILE"] = self.profile
        names = {"genie_space": "GENIE_SPACE_ID", "ai_roi_genie_url": "AI_ROI_GENIE_URL",
                 "ai_roi_dashboard_url": "AI_ROI_DASHBOARD_URL"}
        for ind in INDUSTRIES:
            # Database names match resources/lakebase.postgres.yml (a test keeps them in sync).
            env[f"PGDATABASE_{ind.upper()}"] = f"close_{ind}"
            for var, name in names.items():
                if (value := self.app_vars().get(f"{var}_{ind}")) and value != NOT_INSTALLED:
                    env[f"{name}_{ind.upper()}"] = value
        for key, value in env.items():
            print(f"export {key}={shlex.quote(value)}")

    # --- teardown -----------------------------------------------------------
    def teardown(self, assume_yes: bool) -> None:
        catalog = self.catalog
        print(f"This deletes the app {self.app_name}, its Lakebase project and warehouse, the "
              f"Genie spaces and dashboards created by setup, and every schema setup created in "
              f"catalog {catalog} (baseline_* and <industry>_*). The catalog itself is kept.")
        if not assume_yes and input("Type 'delete' to continue: ").strip() != "delete":
            raise SystemExit("Aborted.")
        from databricks.sdk.errors import NotFound
        for ind, record in self.assets()["industries"].items():
            for key in ("self_service_space_id", "genie_space_id"):
                if record.get(key):
                    try:
                        self.w.api_client.do("DELETE", f"/api/2.0/genie/spaces/{record[key]}")
                    except NotFound:
                        pass
            if record.get("dashboard_id"):
                try:
                    self.w.lakeview.trash(record["dashboard_id"])
                except NotFound:
                    pass
        # Every industry, not just the installed ones: an earlier run may have used more.
        for schema in self.demo_schemas(INDUSTRIES) + [f"{catalog}.app_ops"]:
            self.sql(f"DROP SCHEMA IF EXISTS {schema} CASCADE")
        self.bundle("destroy", "--auto-approve")
        for f in (self.assets_file, self.overrides_file):
            f.unlink(missing_ok=True)
        print("Teardown complete.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--profile", help="Databricks CLI profile (default: DATABRICKS_CONFIG_PROFILE / DEFAULT)")
    parser.add_argument("--target", "-t", default="default", help="bundle target (default: default)")
    parser.add_argument("--company", help="your company's name (asked when not given; remembered)")
    parser.add_argument("--industries", metavar="A,B",
                        help=f"comma-separated industries to install (default: all of {','.join(INDUSTRIES)}; remembered)")
    parser.add_argument("--var", action="append", metavar="NAME=VALUE",
                        help="bundle variable override, e.g. --var catalog=main (repeatable)")
    parser.add_argument("--from", dest="start", choices=STEPS, default=STEPS[0], help="resume from this step")
    parser.add_argument("--to", dest="stop", choices=STEPS, default=STEPS[-1], help="stop after this step")
    parser.add_argument("--only", choices=STEPS, help="run a single step")
    parser.add_argument("--teardown", action="store_true", help="delete everything setup created")
    parser.add_argument("--print-env", action="store_true",
                        help="print shell exports for running the app locally against this deployment")
    parser.add_argument("--yes", action="store_true", help="skip the teardown confirmation")
    args = parser.parse_args()
    setup = Setup(args)
    # print-env output is eval'd, so it must never prompt; teardown needs no company.
    setup.resolve_company(args.company, ask=not (args.teardown or args.print_env))
    setup.resolve_industries(args.industries)
    if args.print_env:
        setup.print_env()
        return
    if args.teardown:
        setup.teardown(args.yes)
        return
    steps = (args.only,) if args.only else STEPS[STEPS.index(args.start):STEPS.index(args.stop) + 1]
    if not steps:
        parser.error("--from must not come after --to")
    for name in steps:
        print(f"\n=== {name} ===", flush=True)
        getattr(setup, f"step_{name}")()
    if not args.only and steps[-1] == "app":
        print("Setup complete.")


if __name__ == "__main__":
    main()
