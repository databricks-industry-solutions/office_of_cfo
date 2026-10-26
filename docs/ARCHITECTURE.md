# Solution Architecture — The Self-Healing Close

One governed copy of data flows through a self-healing supply chain into a real-time trial balance, a reconciliation app, and natural-language query — all governed and audited by Unity Catalog.

## Data flow

```
                          ┌─────────────────────────────────────────────────────────┐
                          │                     UNITY CATALOG                        │
                          │       governance · lineage · ACLs · DQ · provenance      │
                          └─────────────────────────────────────────────────────────┘
                                                  ▲
  SharePoint "Month-End Close" folder             │
  (CSV/XLSX adjustments: accruals,                │  governed managed tables
   reclasses, intercompany, FX)  ──┐              │
                                   │              │
  Subledgers (AP, AR, payroll,     ├── Lakeflow ──┼──►  <industry>_close.* ──►  serving views
   fixed assets) + GL ────────────┘   ingest +    │     (governed tables)        real-time
                                       DQ + ZeroOps│                              trial balance
                                                   │                                  │
                                                   │                                  ▼
                                                   │                         ┌──────────────────┐
                                  Lakebase (Postgres)◄────adjustments────────│ Reconciliation & │
                                  system of record   ────flow back to lake──►│ adjustments app  │
                                                   │                         └──────────────────┘
                                                   │
                                                   ▼
                                                 Genie  ◄── CFO self-service (numbers + trust)
```

## Engine roles (the technical point worth landing)

| Engine | Role | Latency profile |
|---|---|---|
| **Lakebase** | OLTP system of record for the adjustment app's state | point reads/writes, ms |
| **Databricks SQL (serverless)** | serving views that recompute the trial balance on read, plus heavier analytical queries | sub-second to seconds |

## Unity Catalog layout

> Everything lives in one catalog (the bundle's `catalog` variable, default
> `office_of_cfo`). The **baseline** company is built once in the `baseline_*` schemas
> below, then cloned and relabelled into each industry's own `{industry}_raw/_close/
> _serving/_ops` set, which is what the app reads.

| Schema | Contents |
|---|---|
| `baseline_raw` | landing tables from ingest (subledgers, GL, close-folder files) + `close_folder` volume |
| `baseline_close` | governed, DQ-validated close tables: chart of accounts (+ `account_group`), GL (+ `business_line`), `dim_org` hierarchy, subledger detail (AP/AR/Payroll/Fixed Assets/**Inventory/Sales Orders/Procurement/Bank/Staff Expenses**), adjustments, `kpi_history` |
| `baseline_serving` | real-time trial balance + `trial_balance_by_org` segmentation, account balances, `working_capital_kpis`, metric views, DQ badge |
| `baseline_ops` | DQ results, pipeline-health / ZeroOps insights inbox, spreadsheet provenance |

## Organization hierarchy, personas & scope

The demo mirrors a large finance department: an org hierarchy of **Region → Country → Legal Entity → Business Unit**, crossed with a posting-level **Business Line**, held in `dim_org` (+ the `business_line` tag on every GL posting). Three personas — **CFO → Controller → Accountant** — each get a tailored page set, landing page, and data scope, selected via a demo "view as" switcher. The backend (`app/server/personas.py`) resolves a `(scope_type, scope_id)` selection to a safe SQL filter that every scoped read (`/trial-balance`, `/recon-breaks`, `/opex-variance`, `/close-tasks`, `/kpis`) applies. The persona switcher is a demo convenience that changes what the screens show; it is not an access control. Real access is enforced by Unity Catalog and Lakebase permissions, which in a production deployment would map each user to their own scope.

## Source-system integration

Each finance domain is a real synthetic subledger stamped with a named `source_system` — **SAP** (GL/AR/AP/Inventory/Product Costs/Sales Orders/Procurement/Fixed Assets), **Workday** (Payroll/Staff Expenses), **AFAS** (the NL legal entity), and a **Bank Feed**. Reconciliation now covers AP/AR/Payroll **plus Inventory and Bank** controls, with a procurement 3-way-match DQ check. `GET /api/source-systems` reports live coverage (row counts + freshness) for the Data Sources page.

## Working-capital KPIs

`working_capital_kpis` exposes the *additive* KPI components (AR/AP/Inventory balances, Revenue, COGS) per org node × business line. `GET /api/kpis` sums components across a scope and derives the (non-additive) ratios: **DSO = AR/Revenue × days**, **DPO = AP/COGS × days**, **DIO = Inventory/COGS × days**, **CCC = DSO + DIO − DPO**. Trailing `kpi_history` snapshots power the direction-of-travel sparklines; the `close_metrics` metric view also exposes DSO/DPO/DIO to Genie.

## Data-quality expectations (declared, enforced)

Applied to subledgers, GL, and close-folder spreadsheets alike:

- **Completeness** — every subledger and manual input lands before the trial balance is struck.
- **Freshness / timeliness** — each feed is current; late arrivals are flagged.
- **Validity / conformance** — `debits = credits`, no orphan accounts, values in range.
- **Referential integrity** — every posting maps to a valid chart-of-accounts entry.
- **Reconciliation integrity** — subledger ties to GL; breaks are quantified, not hidden.

DQ pass/fail status is surfaced as a field that the trial balance and Genie can read — so the live number is also a *trusted* number.

## The self-healing loop (ZeroOps)

1. An analyst renames a column in a close-folder spreadsheet (as humans do).
2. The connector handles the rename via **schema evolution** — no silent break.
3. A background agent **detects** the signal, **triages** it, **diagnoses** the cause, and **proposes a repair** as an insight in an inbox.
4. A human (the Controller) **approves**; the feed heals; the close stays on track.

Lands the three ZeroOps goals: signal from noise, automated toil, safe execution with least-privilege identity and human approval.

## What the demo simulates

- **The shared "Month-End Close" folder** is a Unity Catalog volume with an Auto Loader ingest, standing in for a SharePoint or file-share connector; the on-ramp behaves the same way.
- **The ZeroOps insights inbox** (detect → diagnose → propose → approve) is modelled as a governed table driven by the pipeline's data-quality results. It illustrates the pattern; it is not a separate product.
- **All finance data is synthetic**, generated by `data_generation/`.
