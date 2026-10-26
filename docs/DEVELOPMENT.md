# Developing the Office of the CFO

For what the demo does and how to install it, see the [README](../README.md). The
rules for changing the app — one codebase for every industry, differences only
through the overlay or the industry's data — are in [AGENTS.md](../AGENTS.md).

## Repo layout

```
.
├── README.md                   # what it is, how to deploy it
├── AGENTS.md                   # working guide for coding agents (CLAUDE.md imports it)
├── databricks.yml              # the bundle: variables + targets
├── resources/                  # bundle resources: warehouse, Lakebase, pipeline, job, app env
├── scripts/setup.py            # end-to-end install / resume / teardown
├── config/
│   ├── demo.yaml               # shape of the data: schemas, close_period, history_months, industries
│   └── vertical_overlays.yaml  # human-readable per-vertical reference
├── data_generation/            # synthetic 24-month company, loaders, per-industry seed
├── pipelines/                  # Lakeflow ingestion + DQ sources (deployed by the bundle)
├── serving/                    # period-aware views: balance sheet, trial balance, KPIs, statements
├── close_support/              # unstructured close documents (ai_parse_document)
├── governance/                 # lineage comments + ZeroOps insights inbox seed
├── genie/                      # self-service Genie space template + curation, AI ROI spaces
├── aibi/                       # AI ROI AI/BI dashboards
├── samples/                    # spreadsheets for the Ad-hoc analysis page
├── docs/                       # ARCHITECTURE.md + diagram, this file
└── app/
    ├── app.yaml                # workspace-neutral app settings (the bundle adds the rest)
    ├── server/                 # FastAPI: close, tasks, statements, scenario, …
    ├── frontend/               # React app; src/lib/industries.ts overlays; dist/ is the built SPA
    └── wheels/                 # vendored Linux wheels: the app installs offline
```


Two things in the tree look generated, and are:

- **`app/frontend/dist/`** is the built React app. The Databricks Apps runtime
  builds it from `app/package.json` on every deploy, so a checkout without it
  deploys as is; to run the app locally, build it first (below). The team's
  internal repo commits it for workspaces that cannot reach npm; the public repo
  does not.
- **`app/wheels/`** holds Linux Python wheels for the app's dependencies, and
  `app/pyproject.toml` installs only from them (`no-index`). This keeps the app
  installable in workspaces whose Apps runtime cannot reach PyPI. If yours can, you
  can drop the folder and the `[tool.uv]` block.

`data_generation/output/landing/` is the generated synthetic company. It is
regenerated on every setup run and committed only because the seed-invariant tests
read it.

## Run the app locally

Deploy once with `scripts/setup.py` first: the app's service principal has to
create its Lakebase tables before you connect as yourself. Then point a local
server at that deployment:

```bash
(cd app/frontend && npm install && npm run build)
eval "$(uv run scripts/setup.py --profile cfo-demo --print-env)"   # catalog, warehouse, Lakebase, Genie ids
# Run from the repo root: app/pyproject.toml pins the offline Linux wheels, so a
# local environment is assembled with --with instead.
uv run --no-project --with fastapi --with uvicorn --with 'psycopg[binary,pool]' \
  --with databricks-sdk --with pydantic --with python-multipart \
  uvicorn --app-dir app app:app --port 8000          # backend + built SPA on :8000
```

For hot reload, run the backend as above and, in a second terminal,
`cd app/frontend && npm run dev` (http://localhost:5173; it proxies `/api` to
`:8000`). Every setting the app reads is an environment variable; see
`app/server/config.py` and `resources/app.app.yml`.

## Tests

```bash
# backend (from the repo root)
uv run --no-project --with fastapi --with 'psycopg[binary,pool]' --with databricks-sdk \
  --with pydantic --with python-multipart --with pytest --with httpx \
  python -m pytest app/server/tests --rootdir app
# setup scripts, generated artifacts and the cross-file industry checks
uv run --with pytest --with pyyaml --with numpy --with pandas --with pyarrow \
  --with databricks-sdk --with scikit-learn python -m pytest data_generation/tests
# frontend
cd app/frontend && npm test
```

The competitor-search tests call SEC EDGAR live and are skipped unless
`CFO_CONTACT_EMAIL` is set (SEC refuses requests without a contact address).

## Definition of done

- A **UI change is done only when it looks right in all five industries.**
- `cd app/frontend && npm run build` passes (tsc + vite).
- The test suites above pass.
