"""Curate a per-industry CFO/FP&A Genie space with instructions, verified example
SQL, SQL expressions (sql_snippets), and join relationships — per Genie best
practices (docs.databricks.com/aws/en/genie/best-practices).

Multi-industry: each industry has its own space over its own schema set
({catalog}.{industry}_{serving,ops,close}). Because the four schemas are
structurally identical, this ONE script curates any of them — pass the industry
and point it at that industry's space id:

    GENIE_SPACE_ID_CONSUMER=<space id> \\
      uv run --with databricks-sdk python genie/curate_space.py consumer

The target space id is read from GENIE_SPACE_ID_<INDUSTRY> (same env the app's
config.genie_space_id() reads), so the script and the running app always agree on
which space belongs to which industry. Create the space once in the UI (add the
industry's serving/ops tables + sample questions), then run this to layer on the
curation. Re-runnable and idempotent: it preserves the space's tables + sample
questions and replaces only the curation (instructions / snippets / benchmarks).

Genie curation lives in the space's `serialized_space` (schema v2), managed via
PATCH /api/2.0/genie/spaces/{id}. Every SQL fragment is executed against the
warehouse before deploy — nothing ships unless it runs.

Environment:
  DATABRICKS_CONFIG_PROFILE (or DATABRICKS_PROFILE): CLI profile
  DATABRICKS_WAREHOUSE_ID: SQL warehouse for validating queries
  CFO_CATALOG: catalog name (default: office_of_cfo)
  GENIE_SPACE_ID_<INDUSTRY>: space id for that industry
"""
from __future__ import annotations

import json
import os
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "data_generation"))
from _common import CATALOG, CLOSE_PERIOD, require_warehouse, workspace_client  # noqa: E402

PERIOD = CLOSE_PERIOD        # current close (latest period in the data)
# Derive prior period (one month back)
year, month = int(PERIOD[:4]), int(PERIOD[5:7])
month -= 1
if month == 0:
    month = 12
    year -= 1
PRIOR_PERIOD = f"{year:04d}-{month:02d}"  # the preceding period (for month-over-month examples)

from industry_profiles import INDUSTRIES  # noqa: E402  (the one industry list)


def _parse_industry(argv: list[str]) -> str:
    args = [a for a in argv[1:] if not a.startswith("-")]
    ind = (args[0] if args else "").lower()
    if ind not in INDUSTRIES:
        sys.exit(f"usage: curate_space.py <{'|'.join(INDUSTRIES)}> [--validate-only]\n"
                 f"       (and set GENIE_SPACE_ID_<INDUSTRY> to that industry's space id)")
    return ind


INDUSTRY = _parse_industry(sys.argv)
SERVING = f"{CATALOG}.{INDUSTRY}_serving"
OPS = f"{CATALOG}.{INDUSTRY}_ops"
CLOSE = f"{CATALOG}.{INDUSTRY}_close"

# Same env the app reads (config.genie_space_id): each industry curates its OWN
# space. Required — never silently fall back to another industry's / the shared
# space, or we'd curate one space with another industry's tables.
SPACE_ID = os.environ.get(f"GENIE_SPACE_ID_{INDUSTRY.upper()}")
if not SPACE_ID:
    sys.exit(f"Set GENIE_SPACE_ID_{INDUSTRY.upper()} to the {INDUSTRY} Genie space id to curate.")

w = workspace_client()
warehouse_id = require_warehouse()


def _id() -> str:
    return uuid.uuid4().hex


# ---------------------------------------------------------------------------
# 1. Text instructions — FP&A close & variance analysis, account-level.
# ---------------------------------------------------------------------------
TEXT_INSTRUCTION = [
    f"PURPOSE: FP&A month-end close & variance analysis for a CFO/Controller audience ({INDUSTRY} — BU/region P&L). Lead with the number, then the driver; be concise.\n",
    f"PERIODS are strings 'YYYY-MM'. The active close is the latest period present ({PERIOD}); 'last month' / prior = the preceding period ({PRIOR_PERIOD}). Month-over-month (MoM) = current minus prior period. If the user names no period, use the latest.\n",
    "SCOPE: always state the PERIOD and SCOPE (region AMER/EMEA/APAC/GLOBAL, business unit, legal entity, business line, or account). Filter to the scope the user names; default to consolidated. Amounts are USD.\n",
    "\n",
    "WHERE EACH ANSWER LIVES:\n",
    f"- Certified KPI rollups (Revenue, Operating Expense, Net Income, DSO/DPO/DIO/Cash Conversion Cycle): the governed metric view {SERVING}.close_metrics. Read measures with MEASURE(), e.g. MEASURE(`Net Income`); never sum raw balances yourself. Break down by its dimensions: Region, Business Unit, Legal Entity, Country, Business Line, Account.\n",
    f"- Operating-expense variance to forecast/plan: {SERVING}.opex_variance (grain: account x business unit; actual_amount, forecast_amount, variance, variance_pct, variance_direction are precomputed). variance = actual_amount - forecast_amount. A POSITIVE variance is UNFAVORABLE (spend above forecast); negative is Favorable. 'Which BU / account is driving it' = ORDER BY SUM(variance) DESC.\n",
    f"- Account-level actuals and month-over-month change (any line): {SERVING}.account_balance_by_bu (balance by period x account_code / account_name x business_unit x region x business_line). For 'what drove the change vs last month', compare the two periods, GROUP BY account_name, ORDER BY the delta. Operating-expense accounts are 60000-68000; COGS is 50000.\n",
    f"- Statement lines & totals: {SERVING}.income_statement (line_id / line_label: revenue, cogs, opex, interest_income, interest_expense, tax_expense; amount per period x scope).\n",
    f"- Trends / history: {SERVING}.kpi_history (period x scope x revenue / opex / net_income / DSO / DPO / DIO / CCC). Account metadata: {CLOSE}.chart_of_accounts.\n",
    f"- Close go/no-go status: {OPS}.dq_summary (one row per period) — close_status, badge, fail_count, warn_count, total_checks. The close is GO only when fail_count = 0. Subledger-to-GL reconciliation breaks: {OPS}.recon_breaks (an OPEN break is is_break = true; variance = subledger_total - gl_balance).\n",
    "\n",
    "SEMANTICS: favorable / unfavorable from the company's view — higher revenue / net income is favorable; higher cost is unfavorable; a positive opex variance-to-forecast is unfavorable.\n",
    "FORMATTING: whole dollars for currency; ratios and day-counts to 1 decimal; percentages to 1 decimal.\n",
    "ANSWER STYLE: lead with the number (period + scope), name the top drivers (account / BU), say favorable / unfavorable, and cite the table (and metric-view measure) you used. When asked 'why / what drove it', decompose to the ACCOUNT level and rank by contribution.\n",
    "CLARIFICATION: if the user asks for a KPI 'by' something that is not a close_metrics dimension, ask whether they mean Region, Business Unit, Legal Entity, or Business Line.",
]

# ---------------------------------------------------------------------------
# 2. SQL expressions (sql_snippets): measures, filters, dimensions.
# ---------------------------------------------------------------------------
SNIPPETS = {
    "measures": [
        {
            "id": _id(),
            "sql": [f"SUM({SERVING}.opex_variance.variance)"],
            "display_name": "OpEx Variance to Forecast",
            "instruction": ["Total operating-expense variance vs forecast; positive is unfavorable (over forecast)."],
            "synonyms": ["variance to forecast", "budget variance", "opex variance", "overspend"],
        }
    ],
    "filters": [
        {
            "id": _id(),
            "sql": [f"{OPS}.recon_breaks.is_break = true"],
            "display_name": "Open reconciliation breaks",
            "instruction": ["Use when the user asks for reconciliation breaks that still need review, are open, unresolved, or still breaking."],
            "synonyms": ["open breaks", "unresolved breaks", "breaks needing review", "still breaking"],
        },
        {
            "id": _id(),
            "sql": [f"{SERVING}.opex_variance.variance > 0"],
            "display_name": "Unfavorable OpEx variance",
            "instruction": ["Use when the user asks about overspend or unfavorable operating-expense variance."],
            "synonyms": ["unfavorable", "over forecast", "overspend"],
        },
    ],
    "expressions": [
        {
            "id": _id(),
            "sql": [f"{SERVING}.opex_variance.business_unit_name"],
            "display_name": "Business Unit (OpEx variance)",
            "instruction": ["Group opex_variance by this to show which business unit drives the variance."],
            "synonyms": ["business unit", "bu", "by business unit"],
        },
        {
            "id": _id(),
            "sql": [f"{SERVING}.opex_variance.account_name"],
            "display_name": "Account (OpEx variance)",
            "instruction": ["Group opex_variance by this to show which expense account drives the variance (account-level drill)."],
            "synonyms": ["account", "expense account", "by account", "line item"],
        },
    ],
}

# ---------------------------------------------------------------------------
# 3. Join relationships (join_specs). Both fact tables share `period` with the
#    per-period dq_summary (MANY_TO_ONE), so Genie can attach go/no-go status.
# ---------------------------------------------------------------------------
JOIN_SPECS = [
    {
        "id": _id(),
        "left": {"identifier": f"{SERVING}.opex_variance", "alias": "opex_variance"},
        "right": {"identifier": f"{OPS}.dq_summary", "alias": "dq_summary"},
        "sql": ["`opex_variance`.`period` = `dq_summary`.`period`", "--rt=FROM_RELATIONSHIP_TYPE_MANY_TO_ONE--"],
    },
    {
        "id": _id(),
        "left": {"identifier": f"{OPS}.recon_breaks", "alias": "recon_breaks"},
        "right": {"identifier": f"{OPS}.dq_summary", "alias": "dq_summary"},
        "sql": ["`recon_breaks`.`period` = `dq_summary`.`period`", "--rt=FROM_RELATIONSHIP_TYPE_MANY_TO_ONE--"],
    },
]

# ---------------------------------------------------------------------------
# 4. Verified example SQL — one per sample question. Biggest lever for accuracy
#    AND latency: Genie matches prompts to these instead of generating fresh.
# ---------------------------------------------------------------------------
EXAMPLES = [
    (
        "What's our operating-expense variance to forecast this month, and which business unit is driving it?",
        "SELECT business_unit_name,\n"
        "       ROUND(SUM(variance), 0) AS opex_variance_to_forecast\n"
        f"FROM {SERVING}.opex_variance\n"
        f"WHERE period = '{PERIOD}'\n"
        "GROUP BY business_unit_name\n"
        "ORDER BY opex_variance_to_forecast DESC",
    ),
    (
        "Which expense accounts are over forecast this month, and by how much?",
        "SELECT account_name,\n"
        "       ROUND(SUM(variance), 0) AS variance_to_forecast\n"
        f"FROM {SERVING}.opex_variance\n"
        f"WHERE period = '{PERIOD}'\n"
        "GROUP BY account_name\n"
        "ORDER BY variance_to_forecast DESC",
    ),
    (
        "What drove the change in operating expenses versus last month, by account?",
        "SELECT account_name,\n"
        f"       ROUND(SUM(CASE WHEN period = '{PERIOD}' THEN balance END)\n"
        f"           - SUM(CASE WHEN period = '{PRIOR_PERIOD}' THEN balance END), 0) AS mom_change\n"
        f"FROM {SERVING}.account_balance_by_bu\n"
        "WHERE account_code IN ('60000','61000','62000','63000','64000','65000','66000','67000','68000')\n"
        f"  AND period IN ('{PRIOR_PERIOD}', '{PERIOD}')\n"
        "GROUP BY account_name\n"
        "ORDER BY ABS(mom_change) DESC",
    ),
    (
        "What is our net income this period by region?",
        "SELECT `Region`,\n"
        "       ROUND(MEASURE(`Net Income`), 0) AS net_income\n"
        f"FROM {SERVING}.close_metrics\n"
        f"WHERE `Period` = '{PERIOD}'\n"
        "GROUP BY `Region`\n"
        "ORDER BY net_income DESC",
    ),
    (
        "What are our DSO, DPO and DIO this month, and how do they compare by region?",
        "SELECT `Region`,\n"
        "       ROUND(MEASURE(`Days Sales Outstanding`), 1) AS dso,\n"
        "       ROUND(MEASURE(`Days Payable Outstanding`), 1) AS dpo,\n"
        "       ROUND(MEASURE(`Days Inventory Outstanding`), 1) AS dio\n"
        f"FROM {SERVING}.close_metrics\n"
        f"WHERE `Period` = '{PERIOD}'\n"
        "GROUP BY `Region`\n"
        "ORDER BY `Region`",
    ),
    (
        "What's our cash conversion cycle, and which business line is driving it?",
        "SELECT `Business Line`,\n"
        "       ROUND(MEASURE(`Cash Conversion Cycle`), 1) AS cash_conversion_cycle_days\n"
        f"FROM {SERVING}.close_metrics\n"
        f"WHERE `Period` = '{PERIOD}'\n"
        "GROUP BY `Business Line`\n"
        "ORDER BY cash_conversion_cycle_days DESC",
    ),
    (
        "What is the data-quality status of this close right now?",
        "SELECT close_status, badge, fail_count, warn_count, total_checks\n"
        f"FROM {OPS}.dq_summary\n"
        f"WHERE period = '{PERIOD}'",
    ),
    (
        "Show the reconciliation breaks that still need review.",
        "SELECT control_account_code, account_name, subledger, business_unit_id,\n"
        "       ROUND(subledger_total, 2) AS subledger_total,\n"
        "       ROUND(gl_balance, 2) AS gl_balance,\n"
        "       ROUND(variance, 2) AS variance\n"
        f"FROM {OPS}.recon_breaks\n"
        f"WHERE period = '{PERIOD}' AND is_break = true\n"
        "ORDER BY abs_variance DESC",
    ),
]


def _run(sql: str) -> None:
    r = w.statement_execution.execute_statement(warehouse_id=warehouse_id, statement=sql, wait_timeout="30s")
    state = r.status.state.value if r.status and r.status.state else "?"
    if state != "SUCCEEDED":
        msg = r.status.error.message if (r.status and r.status.error) else state
        raise RuntimeError(f"SQL failed ({state}): {msg}\n{sql}")


def validate_all() -> None:
    print(f"Validating SQL fragments for {INDUSTRY} ({SERVING})...")
    checks: dict[str, str] = {}
    for i, (q, sql) in enumerate(EXAMPLES, 1):
        checks[f"example {i}"] = sql
    checks["measure: opex variance"] = f"SELECT {SNIPPETS['measures'][0]['sql'][0]} FROM {SERVING}.opex_variance WHERE period='{PERIOD}'"
    checks["filter: open breaks"] = f"SELECT COUNT(*) c FROM {OPS}.recon_breaks WHERE {SNIPPETS['filters'][0]['sql'][0]}"
    checks["filter: unfavorable"] = f"SELECT COUNT(*) c FROM {SERVING}.opex_variance WHERE {SNIPPETS['filters'][1]['sql'][0]}"
    checks["dimension: bu"] = f"SELECT {SNIPPETS['expressions'][0]['sql'][0]} FROM {SERVING}.opex_variance LIMIT 1"
    checks["dimension: account"] = f"SELECT {SNIPPETS['expressions'][1]['sql'][0]} FROM {SERVING}.opex_variance LIMIT 1"
    checks["join: opex x dq"] = f"SELECT o.business_unit_name, d.close_status FROM {SERVING}.opex_variance o JOIN {OPS}.dq_summary d ON o.period = d.period LIMIT 1"
    checks["join: recon x dq"] = f"SELECT r.subledger, d.close_status FROM {OPS}.recon_breaks r JOIN {OPS}.dq_summary d ON r.period = d.period LIMIT 1"
    for name, sql in checks.items():
        _run(sql)
        print(f"  ok  {name}")
    print("All SQL valid.\n")


def _bench_items() -> list[dict]:
    return [
        {"id": _id(), "question": [q], "answer": [{"format": "SQL", "content": [sql]}]}
        for q, sql in EXAMPLES
    ]


def _get() -> tuple[dict, str]:
    resp = w.api_client.do("GET", f"/api/2.0/genie/spaces/{SPACE_ID}", query={"include_serialized_space": "true"})
    return json.loads(resp["serialized_space"]), resp["etag"]


def _normalize(config: dict) -> dict:
    """The API requires every asset list to be sorted by `id`. Order within these
    lists is not semantically meaningful, so sort them all before sending."""
    instr = config.get("instructions") or {}
    for key in ("text_instructions", "join_specs", "example_question_sqls"):
        if isinstance(instr.get(key), list):
            instr[key].sort(key=lambda x: x["id"])
    for key in ("measures", "filters", "expressions"):
        snips = (instr.get("sql_snippets") or {}).get(key)
        if isinstance(snips, list):
            snips.sort(key=lambda x: x["id"])
    bq = (config.get("benchmarks") or {}).get("questions")
    if isinstance(bq, list):
        bq.sort(key=lambda x: x["id"])
    return config


def _patch(config: dict, etag: str) -> None:
    w.api_client.do("PATCH", f"/api/2.0/genie/spaces/{SPACE_ID}",
                    body={"serialized_space": json.dumps(_normalize(config)), "etag": etag})


def deploy() -> None:
    base, etag = _get()
    print(f"[{INDUSTRY}] space {SPACE_ID} — current instructions keys: {list((base.get('instructions') or {}).keys())}")

    instructions = {
        "text_instructions": [{"id": _id(), "content": TEXT_INSTRUCTION}],
        "example_question_sqls": [
            {"id": _id(), "question": [q], "sql": [sql]} for q, sql in EXAMPLES
        ],
        "sql_snippets": SNIPPETS,
        "join_specs": JOIN_SPECS,
    }
    cfg = {
        "version": base.get("version", 2),
        "config": base.get("config", {}),               # preserve sample questions
        "data_sources": base.get("data_sources", {}),   # preserve the space's tables
        "instructions": instructions,
        "benchmarks": {"questions": _bench_items()},
    }
    _patch(cfg, etag)

    final, _ = _get()
    fi = final.get("instructions") or {}
    print("\nFINAL instructions keys:", list(fi.keys()))
    print("  text_instructions:", len(fi.get("text_instructions", [])))
    print("  join_specs:", len(fi.get("join_specs", [])))
    ss = fi.get("sql_snippets", {})
    print("  sql_snippets: measures=%d filters=%d expressions=%d" % (
        len(ss.get("measures", [])), len(ss.get("filters", [])), len(ss.get("expressions", []))))
    print("  example_question_sqls:", len(fi.get("example_question_sqls", []) or []))
    print("  benchmarks.questions:", len((final.get("benchmarks") or {}).get("questions", [])))


if __name__ == "__main__":
    validate_all()
    if "--validate-only" not in sys.argv:
        deploy()
