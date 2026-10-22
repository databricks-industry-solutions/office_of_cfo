# Office of the CFO

**Real-time, spreadsheet-free month-end close and FP&A on Databricks** — a
vision-led demo for the Office of the CFO, delivered as **one React + FastAPI
Databricks App** that serves **five industries** from a shared codebase.

> Today the close lives in spreadsheets no one can inventory, validate, or trace.
> We put those spreadsheets — and every subledger feed — onto one governed platform
> that catches and heals its own breaks, strikes a trusted trial balance in real
> time, lets accountants post adjustments in a governed app instead of Excel,
> answers the CFO's questions in plain language, and proves every number back to
> its source. On top of the close, an **FP&A layer** turns 24 months of governed
> history into trend, variance, scenario, and peer insight.

All data is **100% synthetic**. One command installs the whole demo into your own
workspace: data, pipeline, Lakebase, Genie spaces, dashboards and the app.

### What you'll see

1. **Close Dashboard** — where the current close stands: tasks by owner, approvals
   waiting, and a data-quality badge that says whether today's numbers can be trusted.
2. **Reconciliation Breaks** — a subledger that does not tie to the GL, with the
   invoices behind the gap. An accountant posts a correcting adjustment in the app
   (not in Excel); a controller approves it (four-eyes); the trial balance updates
   on the next refresh because it is computed from the governed data on read.
3. **Ask Genie** (bottom-right) — "What's our operating-expense variance to
   forecast this month, and which business unit is driving it?" — answered in plain
   language from the same governed numbers.
4. **FP&A** — variance against budget and prior year, 24 months of history, scenario
   planning, and benchmarking against listed peers' public filings. The peers are
   suggested for the company you name at install, so the comparison fits the
   customer you are presenting to.

Switch industry in **Settings** and persona (CFO / Controller / Accountant) in the
top bar: the same screens re-label and re-scope for each.

| Close Dashboard (Controller) | Reconciliation Breaks (Accountant) |
|---|---|
| ![Close Dashboard: go/no-go, close progress, data-quality checks and task breakdown](docs/screenshots/close-dashboard.png) | ![Reconciliation Breaks: an inventory subledger that does not tie to the GL, with Explain and Post adjustment](docs/screenshots/reconciliation-breaks.png) |

![FP&A overview for the Financial Services industry: bank headline KPIs, budget variance and cash-flow reconciliation](docs/screenshots/fpa-overview-financial-services.png)

*Screenshots from a fresh install for a fictional "Acme Corp"; the FP&A overview
shows the Financial Services industry.*

### Databricks terms used here

| Term | What it is in this demo |
|---|---|
| **Unity Catalog** | Where all the governed finance tables live, with permissions and lineage. |
| **Lakeflow pipeline** | The ingest job that loads subledgers and close-folder spreadsheets and runs the data-quality checks. |
| **SQL warehouse** | The compute that runs the app's reports and the trial balance. |
| **Lakebase** | A managed Postgres database: the system of record for close tasks, adjustments and approvals. |
| **Genie** | Natural-language Q&A over the governed tables. |
| **AI/BI dashboard** | A published dashboard (here: AI ROI per industry). |
| **Databricks App** | Hosts the web app itself, running as its own service principal. |
| **Bundle** | `databricks.yml` + `resources/`: the infrastructure-as-code that creates all of the above. |

## Deploy to your workspace

### What you need

| | |
|---|---|
| **Workspace** | AWS or Azure, with Unity Catalog, serverless compute (SQL warehouses, Lakeflow pipelines, Databricks Apps), Lakebase Autoscaling, and AI Functions (`ai_query`, `ai_parse_document`). |
| **Permissions** | A workspace admin has everything needed. Otherwise you need to: create serverless SQL warehouses, Lakebase projects, Databricks Apps, pipelines and jobs; create Genie spaces and AI/BI dashboards; and **either** `CREATE CATALOG` on the metastore **or** `USE CATALOG` + `CREATE SCHEMA` on an existing catalog. Setup grants the app's service principal access to the schemas it creates, which works because you own them. |
| **On your machine** | [Databricks CLI](https://docs.databricks.com/aws/en/dev-tools/cli/install) v1.20 or later, [uv](https://docs.astral.sh/uv/getting-started/installation/), git. Node.js is only needed for frontend development. |
| **Optional** | [Genie Code CLI](https://docs.databricks.com/aws/en/genie-code/genie-code-cli) for the guided install below. |

### Quick start

```bash
git clone https://github.com/databricks-industry-solutions/office_of_cfo.git office-of-cfo && cd office-of-cfo
databricks auth login --host https://<your-workspace-url> --profile cfo-demo
uv run scripts/setup.py --profile cfo-demo --company "<company name>"
```

`--company` is the company the demo is for, typically the customer you will present
it to. The app shows its name in the top bar, and competitor benchmarking asks the
model for that company's listed peers. Nothing in the repo names a company to
benchmark. If you leave `--company` out, setup asks for it; either way it is saved,
so later runs reuse it. To change it, pass `--company` again with `--only app`.

`setup.py` deploys the bundle, generates and loads the synthetic company, runs the
close pipeline, seeds the industries (all five by default), creates the Genie spaces and AI/BI
dashboards, grants the app access, and starts the app. It prints the app URL at
the end. A full install takes about 45 minutes, most of it seeding the five
industries, and stores under 10 MB of data. Every step is idempotent: if one fails, fix the cause and resume with
`--from <step>` (the failing step is printed as `=== <step> ===`).

To install only some industries, add `--industries`, for example
`--industries consumer,fsi`. The app then lists only those, and each industry you
leave out saves about 7 minutes.

To install into a catalog you already have instead of creating `office_of_cfo`:

```bash
uv run scripts/setup.py --profile cfo-demo --company "<company name>" --var catalog=<your_catalog>
```

### Step by step with Genie Code CLI

[Genie Code CLI](https://docs.databricks.com/aws/en/genie-code/genie-code-cli) reads
this repo's `AGENTS.md` and its install skill
(`.agents/skills/install-office-of-cfo/`), so it knows how to install the demo and
which questions to ask. Install it, start it from the repo root, and pick the
profile Genie Code itself should use when asked:

```bash
curl -fsSL https://github.com/databricks/genie-code-cli/releases/latest/download/install.sh | bash
cd office-of-cfo && genie
```

Then ask:

> Install the Office of the CFO demo into my workspace.

Genie Code asks which Databricks CLI profile to install with, which company the
demo is for, which industries, which catalog, and whether you want a different
app name. It checks the workspace, then runs setup in four stages and reports
after each. It asks before every command that reaches your workspace; approve
them. These are the commands it runs, so you can also run them yourself:

1. **Check the workspace** (read-only): who you are, whether you are an admin,
   which catalogs you can use, and whether Lakebase Autoscaling and Apps respond.

   ```bash
   databricks current-user me --profile cfo-demo
   databricks catalogs list --profile cfo-demo
   databricks postgres list-projects --profile cfo-demo
   databricks apps list --profile cfo-demo
   ```

2. **Create the catalog and deploy the infrastructure**: the catalog (if it does
   not exist yet), the SQL warehouse, the Lakebase project with one database per
   industry, the close pipeline, the usage job and the (empty) app.

   ```bash
   uv run scripts/setup.py --profile cfo-demo --company "<company name>" --to deploy
   ```

3. **Load and seed the data**: loads the baseline company, runs the pipeline and
   clones it into each industry. This is the longest stage, about 7 minutes per
   industry.

   ```bash
   uv run scripts/setup.py --profile cfo-demo --from data --to industries
   ```

4. **Wire up Genie, dashboards and access**: grants the app's service principal
   access to the demo schemas, then creates a curated self-service Genie space and
   an AI ROI Genie space and dashboard per industry.

   ```bash
   uv run scripts/setup.py --profile cfo-demo --from grants --to dashboards
   ```

5. **Start the app** and print its URL.

   ```bash
   uv run scripts/setup.py --profile cfo-demo --only app
   ```

Open the URL, switch industries in **Settings**, and try the Genie window on the
Close Dashboard. **FP&A → Competitors benchmarking** lists the peers the model
suggests for your company. Setup saves the company and industries on the first
run, so the later commands do not repeat them. Ask Genie Code to change the
company, add an industry or run the app locally, and it uses the same skill.

### What gets created

| Resource | Name (defaults) | Notes |
|---|---|---|
| Unity Catalog schemas | `office_of_cfo.baseline_*`, `office_of_cfo.<industry>_{raw,close,serving,ops}` | 24 schemas of synthetic data, plus `app_ops` if you enable the usage job. |
| SQL warehouse | `office-of-cfo-warehouse` | Serverless, Small, stops after 10 idle minutes. |
| Lakebase Autoscaling project | `office-of-cfo` | One database per industry (`close_<industry>`), 0.5–2 CU, scales to zero after 5 idle minutes. |
| Lakeflow pipeline | `[default] Office of the CFO — Self-Healing Close` | Serverless; run once by setup. |
| Job | `office-of-cfo-ai-gateway-usage-refresh` | **Paused.** Optional; needs `SELECT` on `system.ai_gateway`. |
| Databricks App | `office-of-cfo` | Runs as its own service principal. |
| Genie spaces | one self-service + one AI ROI space per industry | `CAN_RUN` for the workspace `users` group (everyone in the workspace). |
| AI/BI dashboards | `AI ROI — <Industry>` | Published; `CAN_READ` for `users`. |

**How the app reaches its data.** The bundle gives the app's service principal a
Lakebase role that owns the five `close_<industry>` databases, so the app creates
its own tables on first use; nothing has to be attached by hand. For Unity Catalog,
setup grants the same service principal `USE CATALOG` plus read/write on the demo
schemas only. To limit who can open the Genie spaces and dashboards, change their
sharing after setup.

The warehouse and Lakebase stop on their own when idle. The app's compute runs
until you stop it (`databricks apps stop office-of-cfo`) or tear the demo down.

### Configuration

Set any of these with `--var name=value` (setup forwards them to every bundle
command), or create a git-ignored `databricks.local.yml` with your own target.

| Variable | Default | What it controls |
|---|---|---|
| `catalog` | `office_of_cfo` | Catalog for every demo schema. Created by setup if missing. |
| `app_name` | `office-of-cfo` | App name; also names the SQL warehouse. |
| `lakebase_project` | `office-of-cfo` | Lakebase Autoscaling project id. |
| `close_period` | `2026-06` | The month-end the demo closes. |
| `industries` | all five | Comma-separated industries to install and show. Set with `--industries`. |
| `company_name` | *(asked by setup)* | The company the demo is for: the top-bar name and the company whose peers benchmarking suggests. Set with `--company`. |
| `contact_email` | the deploying user | Contact address for SEC EDGAR lookups. Set it if you deploy as a service principal. |

The Genie space and dashboard variables in `databricks.yml` are filled in by
setup; you do not set them. Setup records the ids it created in
`.databricks/bundle/<target>/` (git-ignored), so re-running it updates the same
spaces and dashboards instead of creating new ones. To install a second, separate
copy in the same workspace, add a target in `databricks.local.yml` with different
`app_name`, `lakebase_project` and `catalog` values and pass `--target <name>`.

### Tear down

```bash
uv run scripts/setup.py --profile cfo-demo --teardown
```

This deletes the app, warehouse, Lakebase project, pipeline, job, Genie spaces,
dashboards and every demo schema, after you type `delete` to confirm. **It keeps the
catalog itself**, in case it holds anything else; drop it yourself if setup created
it (`DROP CATALOG office_of_cfo CASCADE`).

### Troubleshooting

| Symptom | Fix |
|---|---|
| `Could not create catalog …` | You lack `CREATE CATALOG`. Re-run with `--var catalog=<existing catalog>`, or ask an admin to create it. |
| A step fails partway | Fix the cause and re-run with `--from <step>`; steps are idempotent. |
| Close Support / document extraction fails in `baseline` | `ai_parse_document` is not available in your region or workspace. |
| Tasks, Approvals or Scenarios are empty | Check `databricks apps logs office-of-cfo` for `password authentication failed` or `lakebase circuit open`, then re-run `--only deploy` and `--only app`. |
| Competitor benchmarking finds nothing | SEC EDGAR needs a contact email in the request header. The bundle sets it to the deploying user (`CFO_CONTACT_EMAIL`); check it is present in the app's environment. |
| No peer suggestions on Competitors benchmarking | The model suggests them through `ai_query` on the `databricks-claude-sonnet-4-5` serving endpoint, which must be available in your workspace. Peers without a public structured filing are dropped, so a company with only private or non-filing competitors shows none; search by name instead. |
| `Which company is this demo for?` in a non-interactive run | Pass `--company "<company name>"`. |
| AI ROI shows no live AI Gateway usage | Expected until you unpause the usage job and grant it `SELECT` on `system.ai_gateway`. |

## Five industries, one codebase

The app serves five first-class industries (FY2025, 100% synthetic values). Each
is a generic company of its type: headline figures are illustrative and do not
match any real company's reported results.

| id | label | basis |
|------------|---------------------|--------------------|
| `consumer` | Consumer Goods | Global home & personal care and foods group |
| `software` | Software & SaaS | Global enterprise SaaS vendor |
| `fsi` | Financial Services | European retail & wholesale bank |
| `energy` | Energy & Utilities | Integrated energy company (USD) |
| `capmarkets` | Capital Markets | Global ETP market maker |

Each industry has its **own data** (`{catalog}.{industry}_{raw,close,serving,ops}`),
its **own Lakebase database** (`close_{industry}`), and its **own headline KPIs**.
The active industry travels on every request in the `X-Industry` header and is
switched from **Settings**. The **golden rule** is *shared by default, exception
by declaration*: one set of pages/components; per-industry differences flow
through a declarative `Overlay` (labels, hidden pages, copy, feature flags) or
the industry's own data — never `if (industry === ...)` branches. See
[AGENTS.md](AGENTS.md) for the working guide.

The UI is a hash SPA (`#/<page>`). **Month-End Close** and **FP&A** are live;
Treasury and Tax appear in the module bar as placeholders. A command palette
(⌘/) and an embedded **Genie** window sit in chrome, not as nav pages.

## Product map

Canonical nav lives in `app/frontend/src/nav.ts`.

### Month-End Close

The self-healing close narrative, as pages:

| Topic | Pages |
|-------|--------|
| Overview | Close Dashboard |
| Close Execution | Tasks, Approvals (four-eyes: post / approve / sign-off) |
| Ledger & Variance | Trial Balance, Reconciliation Breaks |
| Reporting | Financial Statements |
| Data & Audit | Lineage & Data Quality |

Behind those pages:

- **Spreadsheet on-ramp** (Lakeflow Connect / Auto Loader) ingests close-folder
  spreadsheets with schema evolution.
- **Data supply chain** (Lakeflow + built-in data-quality checks + a ZeroOps insights
  inbox that proposes repairs) ingests subledgers/GL,
  flags breaks rather than hiding them, and proposes repairs with human approval.
- **Real-time trial balance** recomputes on read, so an adjustment posted in the
  app flows straight through.
- **Reconciliation & adjustments** on a **Lakebase** (Postgres) backend — the
  governed Accountant → Controller → CFO workflow (system of record for adjustments).
- **CFO self-service** via **Genie**, and **governance & lineage** via Unity Catalog.

### FP&A

Planning and analysis over the same governed data:

| Topic | Pages |
|-------|--------|
| Overview | Executive KPIs — working-capital (DSO / DPO / DIO / CCC) + industry headline tiles |
| Performance & Trends | Variance Analysis, Historical Insights, Market Insights |
| Risk & Insights | Scenario Planning, Concentration Risk |
| Competitors benchmarking | Peers suggested for your company, pull public filings, curated metrics + AI note |

**Variance Analysis** compares income / balance / cash-flow statements (actual vs
budget, prior period, or prior year) with driver breakdowns, commentary, and a
visual dashboard.

**Historical Insights** answers “how does this month look vs history?”:

- KPI trend explorer (MoM / YoY)
- Trailing-average normal range with a z-score flag
- Area leaderboard (best / worst by MoM)
- CCC drivers (DSO + DIO − DPO) with CCC overlaid
- Seasonality heatmap
- `ai_query` narrative grounded in the computed metrics (degrades if unavailable)

**Market Insights** surfaces commodity / macro / sector signals and driver
sensitivities, with a path into Scenario Planning.

**Scenario Planning** projects P&L / cash from driver levers; draft, commit, and
publish plans, and **compare** eligible plans against baseline.

**Concentration Risk** is the live exposure graph. **Competitors benchmarking**
asks the model (`ai_query`) for the listed peers of the company named at install,
keeps only those whose public XBRL filings (ESEF / SEC EDGAR) yield metrics, and
benchmarks them. You can also search any listed company by name or ticker.

Implemented but **hidden from nav** (`GLOBALLY_HIDDEN_PAGES`): Payment Behaviour,
Stress Test, and Inventory Exposure. The generator still builds payment-behaviour
profiles and those APIs remain; they are not first-class demo pages.

## Historical data & the period picker

The demo holds **24 months** of period-aware history. A **global period picker**
in the top bar drives reporting pages (Executive KPIs, Trial Balance, Financial
Statements, Variance Analysis, Exposure, Historical Insights, and the other FP&A
reporting surfaces). The close *workflow* (Tasks, Approvals, DQ / reconciliation)
stays scoped to the active close.

Accounting semantics are explicit in the serving layer:

- **Balance sheet = cumulative** through the selected period (an `account_balance_asof`
  running total), so selecting a month shows the position as of that month-end.
- **Income statement / trial balance = that period's activity only.**
- `kpi_history` is computed from the **real per-period GL** across every scope
  (consolidated / region / legal entity / business unit / business line).

## Personas & scope

The same three personas apply to every industry:

- **CFO** — consolidated, read-only, drill-down + Genie, signs off.
- **Controller** — a geography or business line; KPIs, close readiness, variance, tasks.
- **Accountant** — transactional workbench: reconciliation, DQ, correcting entries, tasks.

A "view as" persona switcher (top bar) changes navigation, landing page, and data
scope. Scope resolves against the org hierarchy — **Region → Country → Legal
Entity → Business Unit**, crossed with **Business Line** — and every read filters
to it. Ids are stable across industries; only display names change.

## Source-system integration

The finance domains are modeled as synthetic subledgers, each labelled with a
standard source system: **SAP** (GL, AR, AP, Inventory, Product Costs, Sales
Orders, Procurement, Fixed Assets), **Workday** (Payroll, Staff Expenses),
**AFAS** (the Netherlands legal entity), plus a **Bank Feed**. **Lineage & Data
Quality** shows live coverage (row counts, freshness) and order-to-cash /
procure-to-pay lineage.

## For developers

The repo layout, local development and tests are in
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md); the rules for changing the app (one
codebase, per-industry differences only through the overlay) are in
[AGENTS.md](AGENTS.md).

## Roadmap

Approved items and their target quarter. Status as of 2026-10-21; targets are
indicative and may move.

### Q4 2026

| Item | Area | Status |
|---|---|---|
| **AI ROI: Return on Tokens Used (ROTU)**: AI spend by business unit and project from Unity AI Gateway, benefits with evidence levels, break-even and portfolio view | New module | In development |
| **Cash flow forecasting**: driver-based forecast, single currency first | FP&A | In development |
| **Forecast accuracy**: track forecast vs actuals accuracy over time | FP&A | Planned |
| **Connected planning & budgeting**: extend forecast vs actuals into planning and budgets | FP&A | Planned |
| **Architecture diagram** of the solution | Docs | In development |
| **Minimum data requirements**: the key data needed to power the core features | Docs | In development |

## Conventions

- **Unity Catalog:** everything lives in one catalog: the `baseline_*` schemas
  (one synthetic company, used to seed the industries and as the
  `CFO_MULTI_INDUSTRY=0` fallback) and each industry's `{industry}_*` set.
- **No workspace values in code:** catalogs, warehouses, Genie spaces, hosts and
  service principals come from the bundle. See AGENTS.md → Deploying.
- **Data:** 100% synthetic. No production data.

## Contributing

1. **git clone** this project locally
2. Utilize the Databricks CLI to test your changes against a Databricks workspace of your choice
3. Contribute to repositories with pull requests (PRs), ensuring that you always have a second-party review from a capable teammate

## 📄 Third-Party Package Licenses

&copy; 2025 Databricks, Inc. All rights reserved. The source in this project is provided subject to the Databricks License [https://databricks.com/db-license-source]. All included or referenced third party libraries are subject to the licenses set forth below.

Only dependencies that are **actually distributed** in the published app are listed — the built single-page frontend (`app/frontend/dist/`) and the offline Python wheelhouse (`app/wheels/`). Build- and test-only tooling (Vite, TypeScript, Vitest, Playwright, PostCSS, Autoprefixer) is not shipped and is not listed. Full per-package attribution (version, project URL, copyright) is in [`NOTICE.md`](NOTICE.md).

| Package | License | Copyright |
|---------|---------|-----------|
| FastAPI | MIT | 2018 Sebastián Ramírez |
| Pydantic | MIT | 2017-present Pydantic Services Inc. and contributors |
| Uvicorn | BSD 3-Clause | 2017-present Encode OSS Ltd. |
| python-multipart | Apache 2.0 | 2012 Andrew Dunham |
| Databricks SDK for Python | Apache 2.0 | 2023 Databricks, Inc. |
| psycopg (binary, pool) | LGPL v3.0 &sup1; | 2020 The Psycopg Team |
| React / React DOM | MIT | Meta Platforms, Inc. and affiliates |
| Framer Motion | MIT | 2018 Framer B.V. |
| clsx | MIT | Luke Edwards |
| tailwind-merge | MIT | 2021 Dany Castillo |
| jsPDF | MIT | 2010-2021 James Hall and contributors; yWorks GmbH |
| jspdf-autotable | MIT | 2014 Simon Bengtsson |
| html2canvas | MIT | 2012 Niklas von Hertzen |
| canvg | MIT | 2010 Gabe Lerner and contributors |
| react-force-graph-2d / force-graph | MIT | 2018 Vasco Asturiano |
| d3-force-3d | MIT | 2010-2016 Michael Bostock; Vasco Asturiano |
| d3-sankey | BSD 3-Clause | 2015 Mike Bostock |
| lucide-react | ISC | 2022 Lucide Contributors |
| SheetJS (xlsx) | Apache 2.0 | 2012-present SheetJS LLC |
| DOMPurify | MPL-2.0 OR Apache 2.0 | 2015 Mario Heiderich |

&sup1; psycopg (LGPL v3.0) is distributed unmodified and dynamically linked / imported as a library, satisfying the LGPL distribution conditions. See the LGPL compliance note in [`NOTICE.md`](NOTICE.md).
