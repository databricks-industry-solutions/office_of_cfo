# Milestone 3 — Real-time trial balance, DQ badge, metric view

The serving layer (in `baseline_serving` and industry-specific `{industry}_serving`) for Act 3 (real-time trial balance)
and Act 5 (Genie). Everything is a **view** over the governed close tables, so it
recomputes on read — an adjustment posted by the app (Act 4) into
`baseline_close.posted_adjustments` flows into the trial balance immediately.

## Objects

| Object | Purpose |
|---|---|
| `baseline_close.posted_adjustments` (table) | system of record for app-posted adjustments (synced from Lakebase); feeds the trial balance live |
| `v_postings` | GL + posted adjustments, normalized |
| `account_balance_by_bu` | signed balances per account × business unit |
| `trial_balance` | one row per account with debit/credit columns |
| `trial_balance_dq` | the trial balance **carrying the live close DQ badge** (Act 3: "the live number is also a trusted number") |
| `opex_variance` | operating-expense actual vs forecast by account × BU (Act 5) |
| `close_metrics` (metric view) | governed UC metric view (Revenue, OpEx, Net Income, Balance) for Genie + dashboards |

## Verified

- Trial balance ties to the penny **except** the seeded $1,250 imbalance (the validity break stays visible).
- DQ badge attaches to every trial-balance row: `NO-GO — 4 checks failing` (pre-heal).
- Realistic P&L: Revenue ~$8.7M, OpEx ~$2.6M, Net Income ~$5.9M.
- Metric view queries with `MEASURE()` (e.g. OpEx and Net Income by Business Unit).

## Lakehouse//RT note

In production this serving layer runs on **Lakehouse//RT** (private preview) for
sub-200ms reads directly off the lake. These objects are plain views, so they run
on the serverless DBSQL warehouse today and drop onto an RT warehouse unchanged
when selected from the warehouse picker — no rewrite. The "real-time" property
comes from views recomputing on read over live governed tables.

## Run

```bash
cd serving
uv run --with databricks-sdk --with pyyaml python build_serving.py
```
