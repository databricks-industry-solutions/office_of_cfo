# Genie question sets

Two layers: **one neutral core question
set** plus **three vertical variants**. The architecture, tables, and metric view are
identical across verticals — only the surface wording of the questions changes. The
presenter selects the overlay before the session.

The space is scoped to **four tables** (see `genie_space.yaml`), so every question
maps to one of: the governed `close_metrics` metric view, `opex_variance`,
`dq_summary`, or `recon_breaks`. Questions that required the old attribution
(`close_adjustments`) or ZeroOps (`zeroops_insights`) tables were removed when the
space was refocused — that detail still lives in the app UI, just not in Genie.

## Neutral core (the demo default)

**The numbers** *(close_metrics + opex_variance)*
1. What's our operating-expense variance to forecast this month, and which business unit is driving it?
2. What is our net income this period by region?
3. What are our DSO, DPO and DIO this month, and how do they compare by region?
4. What's our cash conversion cycle, and which business line is driving it?

**The trust (the differentiator)** *(dq_summary + recon_breaks)*
5. What is the data-quality status of this close right now? *(returns the go/no-go badge)*
6. Are all subledgers and manual adjustments fully loaded and passing quality checks for this close?
7. Show the reconciliation breaks that still need review.

## Manufacturing variant
- What's our COGS variance to standard this month, and which plant is driving it?
- Show gross margin by plant.
- What is the data-quality status of this close, and which subledger reconciliations are still breaking?

## Financial Services variant
- What's our NII variance to forecast this month, and which line of business is driving it?
- Show net interest margin by line of business.
- What is the data-quality status of this close, and which subledger reconciliations are still breaking?

## Oil & Gas / Petroleum variant
- What's our lease operating expense variance by field this month, and which field is driving it?
- Show lifting cost per barrel by field.
- What is the data-quality status of this close, and which subledger reconciliations are still breaking?

> To localize fully, relabel `business_unit_name` (→ plant / line-of-business / field),
> map the OpEx account set to the vertical KPI accounts, and add the vertical subledgers
> from `config/vertical_overlays.yaml` as optional add-on tables. No architectural change.
