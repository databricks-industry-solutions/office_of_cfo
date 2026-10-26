# Page-latency harness (`app/frontend/perf/`)

A committed, repeatable Playwright harness that measures **feature-ready** page
latency for every persona-visible page, across all four industries, and produces
a ranked diagnosis. It is the measurement backbone for the app-latency audit.

## What it measures

For every `(industry, persona, page)` combination it records:

- **cold** feature-ready time — a fresh browser context, timed from the persona
  entry action to the target page (cold browser cache and in-memory state).
  Entrance bootstrap is drained first so persona/org fetches are not charged to
  every page. A persona's home page includes its configured default query.
- **warm** feature-ready time — in-app hash navigation inside an already-entered
  context.

"Feature-ready" ends when the remounted page container is visible, genuine
loading affordances are gone, and the page's API activity has settled—not at
`networkidle` — see [`landmarks.ts`](./landmarks.ts).

Each measured load also captures **API timings** (per `/api/...` path), **failed
requests** (network failures and `>=400` reads), and **console/page errors**.

## Read-only by construction

Every mutating call to `/api` is aborted at the network layer. Two reviewed
read-only computations that happen to use POST (`historical-insights/narrative`
and `scenario/project`) are allowed. The harness only enters a persona and
navigates; it never submits a form, posts an adjustment, approves an item, runs
extraction, or triggers competitor analysis.

## Layout

| File | Purpose | Pure? |
|------|---------|-------|
| `types.ts` | Shared result/coverage types | yes |
| `analysis.ts` | Medians, ranking, change classification, diagnosis Markdown | yes (unit-tested) |
| `discovery.ts` | Coverage matrix, reusing the app's real nav + overlay rules | yes (unit-tested) |
| `landmarks.ts` | Per-page feature-ready landmarks | yes (unit-tested) |
| `browser.ts` | Playwright measurement engine (cold/warm) | no |
| `run.ts` | CLI: discover → measure → write artifacts | no |

The pure modules are covered by `*.test.ts` under `perf/` and run as part of
`npm test` (vitest). The browser engine and CLI are exercised against a running
app, not in unit tests.

## Running

Start the app locally first (see `app/README.md`), then:

```bash
cd app/frontend
node perf/run.ts \
  --base-url http://localhost:8000 \
  --samples 3 \
  --out .ralph/latency/local-baseline.json
# or: npm run perf -- --base-url http://localhost:8000
```

### Flags

| Flag | Default | Meaning |
|------|---------|---------|
| `--base-url <url>` | `http://localhost:8000` (or `PERF_BASE_URL`) | App origin to measure |
| `--samples <n>` | `3` | Samples per mode (medians compared) |
| `--timeout <ms>` | `30000` | Per-phase feature-ready timeout |
| `--industries <csv>` | all four | Subset of `consumer,software,fsi,energy` |
| `--personas <csv>` | all | Restrict to specific persona ids |
| `--out <path>` | `.ralph/latency/local-baseline.json` | Raw result JSON (relative to repo root) |
| `--md <path>` | `<out>.md` | Ranked diagnosis Markdown |
| `--headed` | off | Show the browser |

## Output — never commit it

Results are written under `.ralph/latency/`, which is **gitignored**. The raw
JSON (`local-baseline.json`) is treated as immutable for the audit; the Markdown
is a ranked human-readable diagnosis. Do not stage or commit either, nor any
screenshots, traces, or other generated performance artifacts.
