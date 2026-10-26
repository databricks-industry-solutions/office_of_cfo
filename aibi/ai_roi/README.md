# AI ROI AI/BI dashboards

Build all five deterministic dashboard payloads without provisioning:

```bash
python3 aibi/ai_roi/build.py [--catalog <catalog>] all
```

To create or update workspace dashboards later:

```bash
uv run --with databricks-sdk python aibi/ai_roi/deploy.py all
```

Deployment needs `DATABRICKS_WAREHOUSE_ID` (and `DATABRICKS_CONFIG_PROFILE` outside
a workspace) and records each dashboard ID and URL in the file named by
`CFO_ASSETS_FILE` (default `config/ai_roi_assets.json`, git-ignored), so re-runs
update in place. `scripts/setup.py` runs both steps and passes the URLs to the
app. Builders never call workspace APIs; pass `--catalog` to target another catalog.
