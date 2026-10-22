# Office of the CFO — working guide for coding agents

The multi-industry CFO close & FP&A demo: one React + FastAPI Databricks App over
five industries. This file is the shared guide for any coding agent (Genie Code
reads `AGENTS.md`; Claude Code reads it through `CLAUDE.md`). Users who only want
to install the demo should follow the README; the short version is under
**Deploying** below.

## The five industries

One React + FastAPI app serves five first-class industries (FY2025, 100%
synthetic values). Every industry is **brand-free**: each is a generic company of
its type, and its headline figures are illustrative, not any firm's reported
results. Keep it that way: never name a real company as the model, and use
generic customer / supplier names.

**No company lists in the code.** The one real company in a deployment is the
one the user names at install (`--company`, bundle variable `company_name`, app
env `CFO_COMPANY_NAME`). Competitor benchmarking asks the model for that
company's listed peers at run time (`/competitor-search/peer-suggestions`); never
add curated peer lists, quick picks or example company names to the app, the
overlays or the docs.

| id         | label               | basis                                        |
|------------|---------------------|----------------------------------------------|
| `consumer` | Consumer Goods      | Global home & personal care and foods group  |
| `software` | Software & SaaS     | Global enterprise SaaS vendor                |
| `fsi`      | Financial Services  | European retail & wholesale bank             |
| `energy`   | Energy & Utilities  | Integrated energy company (USD)              |
| `capmarkets` | Capital Markets   | Global ETP market maker                      |

The active industry travels on every request in the `X-Industry` header. Each
industry has its **own data** (`office_of_cfo.{industry}_{raw,close,serving,ops}`),
its **own Lakebase instance** (`close-{industry}`), and its **own headline KPIs**.

## GOLDEN RULE: shared by default, exception by declaration

The app is **one codebase, one set of pages/components**. An industry is **data +
a thin overlay**, never a forked UI. When something must differ per industry,
express it **declaratively in the `Overlay`** — never with `if (industry === ...)`
scattered through components.

```tsx
// ❌ Never do this in a component
if (industry === "energy") return <GasStorageTile />;

// ✅ Do this — component is industry-agnostic, the overlay decides
const label = ov.kpiLabels[id] ?? metric.label;   // relabel
if (ov.hiddenKpis.includes(id)) return null;       // hide
if (ov.features?.commodityFraming) { /* variant */ }
```

Do not add `X-Industry` / `industry === "..."` branches to route modules or React
components. If you catch yourself wanting one, add a field to the `Overlay` type
or the per-industry data instead.

## The only sanctioned ways to make an industry differ

All per-industry UI difference flows through `app/frontend/src/lib/industries.ts`
(the `Overlay` interface) or the per-industry data:

1. **Relabel** — `label`, `navLabels`, `pageCopy`, `kpiLabels`, `cogsLabel`,
   `exposure.*`, `stressLeverLabels`. Same component, different words.
2. **Show / hide** — `hiddenPages`, `hiddenKpis`, `stressHiddenLevers`.
3. **Data-driven content** — headline KPIs, org tree, source systems, tasks,
   trial balance, exposure graph all come from the industry's own schema via the
   `X-Industry` header. Components render whatever the API returns.
4. **Feature flags** — `features?: Record<string, boolean>` (default off). This is
   the escape hatch for a genuinely different *visual*; keep it opt-in and
   greppable. Reach for this only after 1–3 don't fit.

Need a 5th kind of difference? **Add a field to `Overlay`** (as we did with
`headlineKpis` / `stressLeverLabels`), don't branch in a component.

## Keep the data contract identical across industries

Shared components work because every industry's schema set is **structurally
identical** — same tables, columns, KPI shape; only labels/values differ.

- Stable ids stay stable across industries: `BU-100..BU-900`, region codes
  (`AMER/EMEA/APAC/GLOBAL`), legal-entity ids, and KPI ids. **Display names change;
  ids do not.** This is what keeps scope, personas, and joins valid everywhere.
- Any new field/table/KPI must be added to **every** industry via the seed
  pipeline, never ad-hoc to one.

## Personas are shared too

The same 3-persona model (CFO / Controller / Accountant) — identical page
visibility, default landing pages, and four-eyes permissions
(`can_post`/`can_approve`/`can_sign_off`) — applies to every industry. Only the
concrete org tree + scope defaults resolve per industry (data-driven from
`dim_org`). Don't special-case personas per industry.

## Common tasks

**Add a new headline KPI**
1. Add it to the industry profile(s) in `data_generation/industry_profiles.py`, e.g.
   `_kpi("free_cash_flow", "Free Cash Flow", 4.7, "€bn", "up", -0.3, order=4)`
   (id, label, value, unit, good direction, optional Y/Y delta, optional
   `segment=`, display `order=`). Values are illustrative; never copy a real
   company's reported figures.
2. Re-run `uv run scripts/setup.py --profile <p> --only industries` to rebuild `headline_kpis`.
3. The Executive tile renderer picks it up automatically (no component change).

**Add a new industry**
1. Add the id to `INDUSTRIES` + `Industry` union + an `Overlay` in `industries.ts`.
2. Add it to `app/server/industry.py` `INDUSTRIES`.
3. Add it to `INDUSTRIES` and add a profile in `data_generation/industry_profiles.py`
   (every setup script imports that list).
4. Add a `postgres_databases` entry in `resources/lakebase.postgres.yml`, its
   `PGDATABASE_<IND>` / `GENIE_SPACE_ID_<IND>` / `AI_ROI_*_<IND>` env entries in
   `resources/app.app.yml`, and the three matching variables in `databricks.yml`.
5. Run `data_generation/tests/test_industry_lists_in_sync.py`; it names any of
   the places above that still lack the new industry.
6. Re-run `uv run scripts/setup.py --profile <p> --from deploy` (it seeds, grants,
   and creates the Genie space and dashboard for the new industry).

**Add a page/feature** — build it once, industry-agnostic. Use `hiddenPages` to
scope it to the industries that should see it.

## Dev loop & definition of done

- Run locally with `CFO_MULTI_INDUSTRY=1`; switch industries via the top-nav
  dropdown (or the `X-Industry` header for API testing).
- **A UI change is done only when it looks right in all five industries** — or, if
  it's an intentional exception, it's declared in the overlay and you've eyeballed
  the industry that differs plus one that doesn't.
- Frontend: `cd app/frontend && npm run build` must pass (tsc + vite) with no lint
  errors before deploy.

## Deploying

To install, reconfigure or remove the demo for a user, follow the install skill in
`.agents/skills/install-office-of-cfo/SKILL.md`: it lists the questions to ask
first and the commands for each stage and scenario.

Everything workspace-specific comes from the bundle (`databricks.yml` +
`resources/`); nothing in the code names a workspace, catalog, warehouse or id.

```bash
uv run scripts/setup.py --profile <p> --company "<company>" [--var catalog=<c>]  # full install
uv run scripts/setup.py --profile <p> --from <step>                              # resume
uv run scripts/setup.py --profile <p> --only app                                 # redeploy the app
uv run scripts/setup.py --profile <p> --company "<new company>" --only app        # change company
uv run scripts/setup.py --profile <p> --industries consumer,fsi --only app        # show fewer industries
uv run scripts/setup.py --profile <p> --teardown                                 # remove it all
```

- **Always pass `--profile`, and ask the user which profile to use**; never pick
  one yourself. Check it with `databricks current-user me --profile <p>`; if it
  is missing or expired, the user runs `databricks auth login --host <url>
  --profile <p>`.
- **Ask the user which company the demo is for** before the first install, and
  pass it as `--company`; never choose one. Setup cannot prompt when it runs
  non-interactively (as under an agent), so it stops and asks for `--company`
  instead. It saves the name in `variable-overrides.json`, so later runs reuse it.
- Each step prints `=== <step> ===` before it runs. Steps are idempotent, so on
  failure fix the cause and resume with `--from <step>`. Do not run two installs
  against the same `--target` at the same time.
- Setup records the Genie space and dashboard ids it created in
  `.databricks/bundle/<target>/` (`ai_roi_assets.json`, `variable-overrides.json`).
  Do not delete them unless you mean to create new spaces and dashboards.
  `variable-overrides.json` also pins `app_service_principal`, the app's service
  principal that owns the Lakebase databases. Without it, a deploy that updates the
  app tries to recreate that role and fails; never reference
  `${resources.apps.…service_principal_client_id}` from a Lakebase role or database.
- **Never run `--teardown`, `bundle destroy` or `DROP` statements unless the user
  explicitly asks**; teardown deletes the app, Lakebase project and every demo schema.
- The app name, catalog and Lakebase project are bundle variables (defaults
  `office-of-cfo` / `office_of_cfo` / `office-of-cfo`); read them from
  `databricks bundle summary` rather than assuming the defaults.
- Never hardcode a catalog, warehouse id, Genie space id, host or service
  principal. Add a bundle variable or resource and pass it to the app through
  `resources/app.app.yml`; setup scripts read `data_generation/_common.py`.
- SQL files use `{{raw}}`/`{{close}}`/`{{serving}}`/`{{ops}}` placeholders, filled
  by `_common.render_sql()` for the baseline or for one industry.
- The app's service principal owns the Lakebase databases, so it creates its own
  tables. Do not create app tables in Lakebase as your own user (the app then
  cannot read them); let the app create them on first request.
- When a Lakebase-backed page is empty, check `databricks apps logs <app>` for
  `password authentication failed` or `lakebase circuit open`.
- `uv run scripts/setup.py --profile <p> --print-env` prints the exports to run the
  app locally against a deployment (see docs/DEVELOPMENT.md).
- Every industry is brand-free: never name a real company as the model, and use
  generic customer / supplier names.

## Key files

- `app/frontend/src/lib/industries.ts` — the `Overlay` (single source of truth for
  per-industry copy/labels/flags) + `useOverlay()`.
- `app/server/config.py` — `X-Industry` ContextVar + per-request schema proxies
  (`SRV_FQ`/`CLOSE_FQ`/`OPS_FQ`/`RAW_FQ`); every env setting the app reads.
- `app/server/industry.py` — industry roster + resolver (`retail`→`consumer` alias).
- `app/server/lakebase.py` — per-industry Lakebase pool router (`pool_for`).
- `databricks.yml`, `resources/` — the bundle: warehouse, Lakebase, pipeline, job, app env.
- `scripts/setup.py` — end-to-end install / resume / teardown.
- `data_generation/_common.py` — config contract for every setup script.
- `app/server/personas.py` — shared persona roster; data-driven `org_tree()`.
- `data_generation/industry_profiles.py` — per-industry relabels + headline KPIs.
- `data_generation/seed_industries.py` — clones the baseline into each industry's
  schemas, relabels on the copy, builds `headline_kpis`.
- `config/vertical_overlays.yaml` — human-readable per-vertical reference.
