# Milestone 4 — Genie space (CFO self-service)

Act 5: the CFO asks for numbers *and their reliability* in plain language, grounded
in live, post-adjustment, governed data — no analyst in the loop.

## What's built

A per-industry Genie space, **"The Self-Healing Close — CFO Self-Service"**, focused on **four tables** per Genie
[best practices](https://docs.databricks.com/aws/en/genie/best-practices) —
"stay focused, aim for five or fewer tables, prefer metric views." Config in
[`genie_space.yaml`](genie_space.yaml); question sets in
[`question_sets.md`](question_sets.md).

Each industry has its own space pointing to its own schema set (`{industry}_serving` / `{industry}_ops` / `{industry}_close`):

| Table | Answers |
|---|---|
| `{industry}_serving.close_metrics` (metric view) | all the numbers — Revenue, OpEx, Net Income, DSO/DPO/DIO, **CCC**, by region / BU / legal entity / business line |
| `{industry}_serving.opex_variance` | operating-expense actual vs forecast by account × BU |
| `{industry}_ops.dq_summary` | the close go/no-go data-quality badge |
| `{industry}_ops.recon_breaks` | subledger-to-GL reconciliation breaks still open |

The metric view pre-joins and pre-defines every KPI, so it replaces the four
redundant balance/KPI tables (`trial_balance_dq`, `account_balance_by_bu`,
`working_capital_kpis`, `kpi_history`) that previously forced Genie to guess which
source to use. Attribution (`close_adjustments`), the ZeroOps inbox
(`zeroops_insights`), per-check DQ (`dq_results`), and the raw dimension tables were
removed as out-of-scope for CFO number self-service — they remain in the app UI. A
`Cash Conversion Cycle` measure was added to `close_metrics` so the CCC question is
answered from the governed view rather than a separate table.

## Verified end-to-end (live, 2026-06 close)

| Question | Table | Genie result |
|---|---|---|
| OpEx variance to forecast, which BU? | `opex_variance` | 37 lines; **+$291K** total variance |
| Net income this period by region? | `close_metrics` | AMER $2.89M, APAC $1.00M, EMEA $0.99M |
| Cash conversion cycle by business line? | `close_metrics` | Products **31.0 days** (DSO 30.0 + DIO 20.6 − DPO 19.7) |
| Data-quality status right now? | `dq_summary` | **NO-GO — 5 checks failing** |
| Reconciliation breaks still open? | `recon_breaks` | **3** open breaks |

The "trust" questions are the differentiator: Genie reads the close's DQ status and
open reconciliation breaks, so self-service covers both the numbers and whether you
can trust them.

## Curation (instructions, example SQL, expressions, joins)

Per best practices, the space carries a curated knowledge store — deployed by
[`curate_space.py`](curate_space.py) (re-runnable; validates every SQL fragment
before pushing):

| Asset | Count | What it does |
|---|---|---|
| **Example SQL** (`example_question_sqls`) | 7 | verified query per sample question — Genie matches prompts to these instead of generating from scratch (biggest accuracy + latency lever) |
| **Text instructions** | 1 block | purpose, current close period, where each answer lives (metric view vs opex_variance vs dq_summary vs recon_breaks), variance sign convention, rounding, and summary rules |
| **SQL expressions** (`sql_snippets`) | 1 measure / 2 filters / 1 dimension | OpEx variance measure; "open reconciliation breaks" and "unfavorable variance" filters; business-unit dimension |
| **Join relationships** (`join_specs`) | 2 | `opex_variance` and `recon_breaks` → `dq_summary` on `period`, so Genie can attach the close's go/no-go status to any numbers result |
| **Benchmarks** | 7 | same verified Q&A pairs as an evaluation set for the space |

These are stored in the space's `serialized_space` (schema v2), which the simple
`create_or_update_genie` tool doesn't manage — `curate_space.py` drives
`PATCH /api/2.0/genie/spaces/{id}` directly.

### Latency

Raw SQL on the four tables runs in **<1.5s** (warm serverless warehouse). Genie
end-to-end is dominated by its LLM SQL-generation step, not the query. Curation cut
that materially: median end-to-end **~25s → ~14s** (min ~9s) once prompts match the
verified example SQL. The Genie Conversation API can't reach a 3–4s target on its own
— for a guaranteed sub-4s demo path, cache the fixed suggestion chips (pre-computed
Genie responses) and fall back to live Genie only for ad-hoc questions.

## How it was created

The space's tables, description, and sample questions are set with the
`databricks-ai-dev-kit` MCP tool `create_or_update_genie` (config in
`genie_space.yaml`); the curation knowledge store is deployed with `curate_space.py`.
To recreate/update: call `create_or_update_genie` with the same `display_name`,
`table_identifiers`, `warehouse_id`, `description`, and `sample_questions` (pass the
existing `space_id` to update in place), then run `curate_space.py`.

## Vertical localization

One neutral space ships by default. To localize, swap only the question wording and
relabel `business_unit_name` per `config/vertical_overlays.yaml` — see
`question_sets.md` for the Manufacturing, Financial Services, and Oil & Gas variants.
