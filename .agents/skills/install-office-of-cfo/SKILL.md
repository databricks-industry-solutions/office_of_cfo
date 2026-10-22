---
name: install-office-of-cfo
description: "Install, resume, change or remove the Office of the CFO demo in a Databricks workspace with scripts/setup.py. Use when the user asks to install, deploy, set up, update, reconfigure or tear down this demo, or to run it locally against a deployment."
compatibility: Requires databricks CLI (>= v1.20), uv and git, run from the repo root
---

# Install the Office of the CFO demo

`scripts/setup.py` does the whole install. Your job is to ask the user the few
questions it needs, check the workspace, run setup in stages, and explain what
happened. Read the "Deploy to your workspace" section of `README.md` and the
"Deploying" section of `AGENTS.md` first.

## 1. Ask before running anything

Ask these together, show the defaults, and wait for the answers. Never choose a
profile or a company yourself.

| Question | Becomes | Default |
|---|---|---|
| Which Databricks CLI profile? List them with `databricks auth profiles`. If none fits, the user runs `databricks auth login --host <workspace-url> --profile <name>`. | `--profile <p>` | none: ask |
| Which company is the demo for? Usually the customer it will be shown to. It names the app, and benchmarking suggests its listed peers. | `--company "<name>"` | none: ask |
| Which industries? Any of `consumer` (Consumer Goods), `software` (Software & SaaS), `fsi` (Financial Services), `energy` (Energy & Utilities), `capmarkets` (Capital Markets). Each one adds about 7 minutes to the install. | `--industries a,b` | all five |
| Which catalog? A new one (setup creates it, which needs `CREATE CATALOG`) or an existing one they can create schemas in. | `--var catalog=<c>` | `office_of_cfo` |
| Another app name? Only if `office-of-cfo` is taken or they want their own. | `--var app_name=<n>` | `office-of-cfo` |

If the workspace already has an install with the default names (step 2 shows
it), a second copy needs its own `app_name`, `lakebase_project` and `catalog` in
a target of its own: add it to a `databricks.local.yml` (git-ignored) and pass
`--target <name>` to every command.

## 2. Check the workspace (read-only)

```bash
databricks current-user me --profile <p>        # who; groups include "admins"?
databricks catalogs list --profile <p>          # the catalog exists, or can be created?
databricks postgres list-projects --profile <p> # Lakebase Autoscaling responds
databricks apps list --profile <p>              # Apps responds; is the app name free?
```

Report what you found and anything that blocks the install (no Lakebase, no
Apps, no catalog they can use). Do not create anything in this step.

## 3. Install in stages

Pass the answers on the first command. Setup saves the company and industries in
`.databricks/bundle/<target>/variable-overrides.json`, so later commands reuse
them; repeating `--var` options is harmless.

```bash
S="uv run scripts/setup.py --profile <p>"
$S --company "<name>" --industries <a,b> --var catalog=<c> --to deploy     # catalog, warehouse, Lakebase, pipeline, job, app
$S --var catalog=<c> --from data --to industries                          # longest: data, pipeline, ~7 min per industry
$S --var catalog=<c> --from grants --to dashboards                        # access, Genie spaces, dashboards
$S --var catalog=<c> --only app                                           # starts the app, prints its URL
```

Each step prints `=== <step> ===`. After each stage, summarise what it created.
A full install takes about 45 minutes. If your tool calls time out on long
commands, run the steps one at a time with `--only <step>`.

## 4. When something fails

- Read the error printed under the failing `=== <step> ===`, fix the cause, and
  resume with `--from <step>`. Every step is idempotent.
- `Could not create catalog`: re-run with `--var catalog=<an existing catalog>`.
- `Which company is this demo for?`: setup cannot prompt here; pass `--company`.
- `No value yet for genie_space_…`: run `--from genie` before `--only app`.
- Pages that use Lakebase are empty: check `databricks apps logs <app_name>
  --profile <p>` for `password authentication failed` or `lakebase circuit open`,
  then run `--only deploy` and `--only app`.
- Never run two setups against the same target at once.

## 5. Later changes

| The user wants to | Run |
|---|---|
| Show the demo for another company | `$S --company "<new name>" --only app` |
| Add an industry | `$S --industries <full new list> --from industries` |
| Drop an industry from the app | `$S --industries <new list> --only app` (its schemas stay until teardown) |
| Run the app locally against the deployment | `eval "$($S --print-env)"`, then see `docs/DEVELOPMENT.md` |
| Remove everything | `$S --teardown`, **only when the user explicitly asks**. It deletes the app, Lakebase project, warehouse, Genie spaces, dashboards and every demo schema, and keeps the catalog. |

Never run `--teardown`, `databricks bundle destroy` or `DROP` statements unless
the user asked for exactly that. Never add company names to the repo: the peers
come from the model at run time.
