# AI ROI Genie spaces

Build deterministic serialized-space payloads, example SQL and benchmarks:

```bash
python3 genie/ai_roi/build.py [--catalog <catalog>] all
```

To create or update workspace spaces later:

```bash
uv run --with databricks-sdk python genie/ai_roi/deploy.py all
```

Deployment needs `DATABRICKS_WAREHOUSE_ID` (and `DATABRICKS_CONFIG_PROFILE` outside
a workspace) and records each space ID and URL in the file named by
`CFO_ASSETS_FILE` (default `config/ai_roi_assets.json`, git-ignored), so re-runs
update in place. `scripts/setup.py` runs both steps and passes the URLs to the
app. Builders never call workspace APIs; pass `--catalog` to target another catalog.
