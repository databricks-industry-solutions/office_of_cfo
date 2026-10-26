"""Deterministic, identical-contract AI ROI semantic data for every industry.

The generator is deliberately pure Python. Tests can prove accounting identities
without a warehouse; ``seed_ai_roi`` only translates the validated records to UC.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import ROUND_DOWN, Decimal

# Read application service principal IDs from environment (comma-separated).
# If not set, no grants are issued. This allows the script to run in any workspace.
_CFO_APP_SP_IDS = os.environ.get("CFO_APP_SP_IDS", "").strip()
APP_SERVICE_PRINCIPALS = tuple(_CFO_APP_SP_IDS.split(",")) if _CFO_APP_SP_IDS else ()
AI_ROI_MONTHS = 12
# AI ROI usage is generated through this month even when the close calendar is
# still pinned at CLOSE_PERIOD (2026-06), so Efficiency can show a current trend.
AI_ROI_END_PERIOD = "2026-09"
POLICY_ID = "ai-roi-token-share-v1"
ATTRIBUTION_POLICY_ID = "ai-roi-attribution-v1"
ENVIRONMENTS = ("production", "sandbox", "evaluation")


@dataclass(frozen=True)
class AiRoiProfile:
    org_names: tuple[str, ...]
    markets: tuple[str, ...]
    use_cases: tuple[tuple[str, str, str], ...]
    concentration: tuple[Decimal, ...]
    profitability: tuple[Decimal, ...]
    confidence: tuple[Decimal, Decimal, Decimal]
    cache_rates: tuple[Decimal, Decimal, Decimal]
    failure_rates: tuple[Decimal, Decimal, Decimal]
    monthly_run_cost: Decimal
    shared_build_pool: Decimal
    # Root org-node name. Optional so existing profiles keep their derived name;
    # set it whenever the industry id does not title-case into a sensible label.
    group_name: str | None = None


PROFILES: dict[str, AiRoiProfile] = {
    "consumer": AiRoiProfile(
        ("North America", "Europe", "Asia Pacific", "Latin America", "Corporate"),
        ("AMER", "EMEA", "APAC", "LATAM", "GLOBAL"),
        (
            ("demand-forecast", "Retail demand forecasting", "Commercial"),
            ("trade-promo", "Trade promotion optimisation", "Commercial"),
            ("consumer-care", "Consumer care copilot", "Customer"),
            ("creative-studio", "Brand creative studio", "Marketing"),
            ("supply-risk", "Ingredient supply-risk sensing", "Operations"),
            ("finance-copilot", "Finance close copilot", "Corporate"),
        ),
        tuple(map(Decimal, ("0.34", "0.25", "0.20", "0.13", "0.08"))),
        tuple(map(Decimal, ("1.72", "1.31", "1.12", "0.78", "0.66"))),
        tuple(map(Decimal, ("0.48", "0.34", "0.18"))),
        tuple(map(Decimal, ("0.27", "0.43", "0.61"))),
        tuple(map(Decimal, ("0.006", "0.011", "0.024"))),
        Decimal(182000), Decimal(46000),
    ),
    "software": AiRoiProfile(
        ("Sales Cloud", "Service Cloud", "Platform & Data", "Marketing Cloud", "Corporate"),
        ("AMER", "EMEA", "APAC", "GLOBAL", "GLOBAL"),
        (
            ("seller-copilot", "Seller opportunity copilot", "Revenue"),
            ("service-agent", "Autonomous service agent", "Customer"),
            ("code-assist", "Engineering code assistant", "Product"),
            ("renewal-risk", "Renewal risk prediction", "Revenue"),
            ("trust-triage", "Trust incident triage", "Operations"),
            ("finance-copilot", "Finance close copilot", "Corporate"),
        ),
        tuple(map(Decimal, ("0.39", "0.25", "0.18", "0.11", "0.07"))),
        tuple(map(Decimal, ("1.88", "1.47", "1.21", "0.91", "0.62"))),
        tuple(map(Decimal, ("0.56", "0.29", "0.15"))),
        tuple(map(Decimal, ("0.52", "0.66", "0.73"))),
        tuple(map(Decimal, ("0.004", "0.009", "0.018"))),
        Decimal(246000), Decimal(72000),
    ),
    "fsi": AiRoiProfile(
        ("Retail Banking", "Wholesale Banking", "Private Banking", "Payments", "Group Functions"),
        ("BENELUX", "EMEA", "APAC", "GLOBAL", "GLOBAL"),
        (
            ("fraud-detection", "Real-time payment fraud detection", "Risk"),
            ("aml-investigation", "AML investigation copilot", "Compliance"),
            ("credit-memo", "Credit memo assistant", "Lending"),
            ("client-service", "Client service copilot", "Customer"),
            ("liquidity-forecast", "Intraday liquidity forecasting", "Treasury"),
            ("reg-reporting", "Regulatory reporting assistant", "Corporate"),
        ),
        tuple(map(Decimal, ("0.31", "0.27", "0.16", "0.17", "0.09"))),
        tuple(map(Decimal, ("1.54", "1.36", "1.09", "0.83", "0.58"))),
        tuple(map(Decimal, ("0.62", "0.27", "0.11"))),
        tuple(map(Decimal, ("0.19", "0.37", "0.54"))),
        tuple(map(Decimal, ("0.003", "0.008", "0.015"))),
        Decimal(273000), Decimal(81000),
    ),
    "energy": AiRoiProfile(
        ("Energy Supply", "Generation", "Trading & Optimization", "Networks & Field Services", "Corporate"),
        ("AMER", "EMEA", "APAC", "GLOBAL", "GLOBAL"),
        (
            ("load-forecast", "Power and gas load forecasting", "Energy Supply"),
            ("field-copilot", "Field engineer copilot", "Networks & Field Services"),
            ("trading-signals", "Commodity trading signals", "Trading & Optimization"),
            ("churn-next-best", "Customer churn next-best action", "Energy Supply"),
            ("asset-maintenance", "Predictive asset maintenance", "Generation"),
            ("finance-copilot", "Finance close copilot", "Corporate"),
        ),
        tuple(map(Decimal, ("0.21", "0.37", "0.12", "0.20", "0.10"))),
        tuple(map(Decimal, ("1.19", "1.63", "0.74", "1.08", "0.55"))),
        tuple(map(Decimal, ("0.51", "0.31", "0.18"))),
        tuple(map(Decimal, ("0.24", "0.48", "0.69"))),
        tuple(map(Decimal, ("0.005", "0.013", "0.029"))),
        Decimal(211000), Decimal(59000),
    ),
    # Global ETP market maker (illustrative; synthetic values). Each
    # desk is its own P&L, so desks are the business units. Fixed Income ETPs is
    # the newest and smallest book and the one that does not yet cover its fully
    # loaded AI cost; Group Functions sits below 1.0 as it does in every industry.
    "capmarkets": AiRoiProfile(
        ("ETP Equities", "Fixed Income ETPs", "Digital Assets", "Systematic & Quant Research", "Group Functions"),
        ("EMEA", "AMER", "APAC", "GLOBAL", "GLOBAL"),
        (
            ("etp-quote-engine", "ETP market-making quote engine", "ETP Equities"),
            ("bond-etp-pricing", "Bond ETP fair-value pricing", "Fixed Income"),
            ("crypto-hedging", "Crypto perpetuals hedging agent", "Digital Assets"),
            ("quant-research-copilot", "Quant research copilot", "Research"),
            ("trade-reporting", "Regulatory trade reporting assistant", "Corporate"),
            ("nav-arbitrage", "NAV premium and creation/redemption monitor", "ETP Equities"),
        ),
        tuple(map(Decimal, ("0.30", "0.14", "0.18", "0.28", "0.10"))),
        tuple(map(Decimal, ("1.86", "0.84", "1.24", "1.52", "0.57"))),
        tuple(map(Decimal, ("0.24", "0.56", "0.20"))),
        tuple(map(Decimal, ("0.22", "0.41", "0.58"))),
        tuple(map(Decimal, ("0.004", "0.010", "0.021"))),
        Decimal(236000), Decimal(64000),
        group_name="Capital Markets Group",
    ),
}

# List prices, USD per million tokens, as of 2026-10-01, from each provider's own
# API (Kimi K3 and GLM 5.3 converted from CNY; gpt-oss from a public host). Every
# model is served by Databricks Foundation Model APIs.
# (id, name, tier, class, input, output).
# Order matters: extra models take SIDECAR_WEIGHTS in this order.
MODELS = (
    ("claude-opus-5-5", "Claude Opus 5.5", "premium", "frontier", Decimal("4.00"), Decimal("20.00")),
    ("gemini-3-1-pro", "Gemini 3.1 Pro", "premium", "frontier", Decimal("2.00"), Decimal("12.00")),
    ("gpt-6-1-sol", "GPT-6.1 Sol", "premium", "frontier", Decimal("2.00"), Decimal("10.00")),
    ("grok-4-7", "Grok 4.7", "premium", "frontier", Decimal("2.00"), Decimal("6.00")),
    ("kimi-k3", "Kimi K3", "specialist", "open_weights", Decimal("3.00"), Decimal("15.00")),
    ("qwen3-5-122b", "Qwen3.5 122B", "standard", "open_weights", Decimal("0.40"), Decimal("3.20")),
    ("deepseek-v4-1-flash", "DeepSeek V4.1 Flash", "standard", "open_weights", Decimal("0.30"), Decimal("1.20")),
    ("gpt-oss-120b", "gpt-oss-120b", "standard", "open_weights", Decimal("0.15"), Decimal("0.60")),
    ("glm-5-3-flash", "GLM 5.3 Flash", "standard", "open_weights", Decimal("0.15"), Decimal("0.50")),
    ("glm-5-3", "GLM 5.3", "standard", "open_weights", Decimal("1.40"), Decimal("4.40")),
)
# Blended rate the generator prices tokens at: list input and output weighted by
# the fleet's ~72% input share.
BLENDED_INPUT_SHARE = Decimal("0.72")


def _blended_per_mtok(input_price: Decimal, output_price: Decimal) -> Decimal:
    return (
        input_price * BLENDED_INPUT_SHARE + output_price * (1 - BLENDED_INPUT_SHARE)
    ).quantize(Decimal("0.0001"))


MIGRATION_SMALL = "glm-5-3"
MIGRATION_MID = "gemini-3-1-pro"
MIGRATION_LARGE = "claude-opus-5-5"
GROUP_FUNCTION_UNITS = (
    ("GF-RISK", "Risk", Decimal("0.24")),
    ("GF-COMPLIANCE", "Compliance", Decimal("0.18")),
    ("GF-FINANCE", "Finance", Decimal("0.22")),
    ("GF-TECHNOLOGY", "Technology", Decimal("0.16")),
    ("GF-FACILITIES", "Facilities", Decimal("0.08")),
    ("GF-HR", "HR", Decimal("0.12")),
)
LINE_PARENTS = ("BU-100", "BU-200", "BU-300", "BU-400")
LINE_WEIGHTS = (
    tuple(map(Decimal, ("0.28", "0.22", "0.18", "0.20", "0.12"))),
    tuple(map(Decimal, ("0.24", "0.18", "0.22", "0.16", "0.20"))),
    tuple(map(Decimal, ("0.30", "0.14", "0.16", "0.22", "0.18"))),
    tuple(map(Decimal, ("0.18", "0.26", "0.12", "0.24", "0.20"))),
)
# Per-desk month multipliers (normalised later). Combined with LINE_WEIGHTS so
# sibling MoM lines are not parallel copies of the parent.
LINE_MONTH_SHAPES = (
    (1.15, 1.10, 1.05, 1.00, 0.95, 0.90, 0.88, 0.92, 0.98, 1.05, 1.12, 1.18, 1.16, 1.12, 1.08),
    (0.80, 0.85, 0.92, 1.00, 1.08, 1.15, 1.20, 1.18, 1.10, 1.02, 0.94, 0.88, 0.90, 0.94, 0.98),
    (1.20, 0.70, 1.15, 0.75, 1.10, 0.80, 1.05, 0.85, 1.18, 0.78, 1.08, 0.90, 1.12, 0.82, 1.00),
    (0.95, 0.98, 1.02, 1.08, 1.12, 1.10, 1.04, 0.98, 0.94, 0.96, 1.00, 1.04, 1.06, 1.04, 1.02),
    (1.08, 1.04, 0.98, 0.90, 0.85, 0.88, 0.94, 1.02, 1.10, 1.14, 1.08, 1.00, 0.96, 0.94, 0.92),
)
LINE_NAMES: dict[str, tuple[tuple[str, ...], ...]] = {
    "capmarkets": (
        ("European Equity ETPs", "US Equity ETPs", "Asia-Pacific Equity ETPs", "Institutional RFQ", "Index Futures & Options Hedging"),
        ("Government Bond ETPs", "Corporate Bond ETPs", "Rates Futures", "Cash Bonds", "Money-Market ETPs"),
        ("Crypto ETPs", "Spot & OTC Crypto", "Perpetuals & Options", "DeFi Liquidity", "Tokenised Assets"),
        ("Alpha Research", "Systematic Strategies", "Execution Research", "Market Microstructure", "Commodities & FX Systematic"),
    ),
    "fsi": (
        ("Everyday Banking & Deposits", "Mortgages", "Consumer Lending", "SME Banking", "Digital Channels"),
        ("Corporate Lending", "Transaction Banking", "Financial Markets", "Trade Finance", "Real Estate Finance"),
        ("Wealth Advisory", "Investment Management", "Private Lending", "Family Office & UHNW", "Client Service"),
        ("Cards & Merchant Services", "Account-to-Account Payments", "Cross-Border Payments", "Payment Processing", "Fraud & Disputes"),
    ),
    "consumer": (
        ("Ice Cream", "Beauty & Personal Care", "Nutrition", "Home Care", "Food & Refreshment"),
        ("Retail partnerships", "Food service", "E-commerce", "Distributors", "Own stores"),
        ("Premium brands", "Mass brands", "Local jewels", "New ventures", "Licensing"),
        ("Modern trade", "Traditional trade", "Quick commerce", "Export", "Private label"),
    ),
    "software": (
        ("Core CRM", "CPQ", "Partner Channel", "Sales Analytics", "Enablement"),
        ("Case Management", "Self-service", "Workforce Engagement", "Field Service", "Knowledge"),
        ("Data Cloud", "MuleSoft", "Tableau", "Heroku", "Platform Services"),
        ("Marketing Automation", "Commerce", "Personalisation", "Loyalty", "Account Engagement"),
    ),
    "energy": (
        ("Residential Energy", "SME Energy", "Smart Metering", "EV & Home Services", "Digital Retail"),
        # Generation desks. These were previously named after a real utility's
        # consumer brands, which the brand-removal pass missed; energy is brand-free.
        ("Gas-fired Generation", "Onshore Wind", "Offshore Wind", "Solar & Storage", "Plant Operations"),
        ("Upstream Supply", "Trading Book", "LNG", "Renewables Origination", "Optimisation"),
        ("Residential Dual Fuel", "SME Dual Fuel", "Heat Networks", "Metering", "Customer Ops"),
    ),
}
# Mild enterprise ramp (averages 1.0). Stronger than this hides use-case
# sparkline shape; weaker than this lets monthly value fall through outlay.
VALUE_RAMP = tuple(map(Decimal, (
    "0.70", "0.76", "0.82", "0.88", "0.94", "1.00",
    "1.06", "1.12", "1.16", "1.18", "1.20", "1.18",
    "1.16", "1.15", "1.14",
)))
# Build investment is amortised front-loaded (normalised to mean 1), so monthly
# outlay falls while monthly value ramps up and the two lines cross.
BUILD_FRONT_LOAD = (
    4.2, 3.4, 2.7, 2.0, 1.5, 1.0, 0.6, 0.35, 0.15, 0.06, 0.03, 0.01,
    0.008, 0.006, 0.005,
)
# Per-use-case multipliers on value (normalised to mean 1). Combined with
# VALUE_RAMP they give the league Trend column distinct paths: rise, fade,
# recovery, hump, trough, stall.
USE_CASE_ROTU_SHAPES = (
    (0.55, 0.62, 0.72, 0.82, 0.92, 1.02, 1.12, 1.22, 1.32, 1.40, 1.48, 1.55, 1.58, 1.60, 1.62),
    (1.85, 1.70, 1.52, 1.35, 1.18, 1.02, 0.88, 0.75, 0.64, 0.55, 0.48, 0.42, 0.40, 0.38, 0.36),
    (0.72, 0.82, 0.94, 1.08, 1.18, 1.12, 1.00, 0.90, 0.96, 1.10, 1.22, 1.28, 1.24, 1.18, 1.12),
    (0.50, 0.75, 1.10, 1.45, 1.70, 1.80, 1.50, 1.15, 0.90, 0.70, 0.58, 0.52, 0.50, 0.48, 0.47),
    (1.40, 1.15, 0.90, 0.65, 0.48, 0.42, 0.55, 0.78, 1.05, 1.30, 1.50, 1.62, 1.66, 1.68, 1.70),
    (0.60, 0.75, 0.90, 1.08, 1.22, 1.35, 1.42, 1.40, 1.28, 1.12, 0.98, 0.85, 0.80, 0.76, 0.74),
)
# Sidecar models share a small residual of BU-100 spend. Unique weights and
# month shapes keep their run cost and MoM from collapsing to the same cents.
SIDECAR_WEIGHTS = tuple(Decimal(v) for v in (64, 32, 16, 8, 4, 2, 1))
# Input share of total tokens per usage row (mean ~0.72, the previous constant).
INPUT_SHARE_CYCLE = (0.69, 0.74, 0.71, 0.77, 0.66, 0.73, 0.70, 0.75)
SIDECAR_MONTH_SHAPES = (
    (1.10, 1.08, 1.06, 1.04, 1.02, 1.00, 0.98, 0.96, 0.98, 1.00, 1.02, 1.04, 1.06, 1.00, 1.22),
    (0.90, 0.93, 0.96, 1.00, 1.04, 1.08, 1.12, 1.10, 1.06, 1.02, 0.98, 0.94, 0.92, 1.14, 0.86),
    (1.12, 0.94, 1.10, 0.96, 1.08, 0.98, 1.06, 1.00, 1.08, 0.96, 1.04, 0.98, 1.06, 0.88, 1.16),
    (0.97, 0.99, 1.01, 1.04, 1.07, 1.08, 1.06, 1.03, 1.00, 0.98, 0.97, 0.99, 1.02, 1.10, 0.94),
    (1.05, 1.08, 1.10, 1.08, 1.04, 1.00, 0.96, 0.94, 0.95, 0.98, 1.01, 1.04, 1.06, 0.90, 1.12),
    (0.88, 0.92, 0.97, 1.03, 1.09, 1.13, 1.14, 1.10, 1.04, 0.98, 0.94, 0.91, 0.92, 1.18, 0.82),
    (1.02, 0.97, 1.06, 0.94, 1.08, 0.96, 1.04, 0.98, 1.07, 0.95, 1.03, 0.99, 1.05, 0.84, 1.20),
)


def _norm_shape(values: tuple[float, ...] | list[float]) -> list[Decimal]:
    raw = [Decimal(str(v)) for v in values]
    total = sum(raw)
    n = Decimal(len(raw))
    return [v * n / total for v in raw]


def _level1_parent(org_unit_bk: str, by_bk: dict[str, dict]) -> str:
    row = by_bk[org_unit_bk]
    if row["level"] <= 1 or not row.get("parent_bk"):
        return org_unit_bk
    parent = by_bk[row["parent_bk"]]
    if parent["level"] <= 1:
        return parent["org_unit_bk"]
    return _level1_parent(parent["org_unit_bk"], by_bk)

def _months(end_period: str, count: int | None = None) -> list[date]:
    year, month = map(int, end_period.split("-"))
    if count is None:
        # Keep July 2025 as the first month so the close-period 12-month window
        # stays populated when the series is extended through Sep 2026.
        count = max(AI_ROI_MONTHS, (year - 2025) * 12 + month - 6)
    out: list[date] = []
    for _ in range(count):
        out.append(date(year, month, 1))
        month -= 1
        if month == 0:
            month, year = 12, year - 1
    return list(reversed(out))


def _cents_allocate(total: Decimal, weights: list[Decimal]) -> list[Decimal]:
    """Largest-remainder allocation; output sums exactly to ``total``."""
    total_cents = int((total * 100).to_integral_value())
    denominator = sum(weights)
    raw = [Decimal(total_cents) * w / denominator for w in weights]
    cents = [int(v.to_integral_value(rounding=ROUND_DOWN)) for v in raw]
    remainder = total_cents - sum(cents)
    order = sorted(range(len(raw)), key=lambda i: (raw[i] - cents[i], -i), reverse=True)
    for i in order[:remainder]:
        cents[i] += 1
    return [Decimal(v) / 100 for v in cents]


def _line_desks(industry: str, org_id: str) -> tuple[tuple[str, str, Decimal], ...]:
    if org_id == "BU-900":
        return GROUP_FUNCTION_UNITS
    if org_id not in LINE_PARENTS:
        return ()
    index = LINE_PARENTS.index(org_id)
    names = LINE_NAMES[industry][index]
    weights = LINE_WEIGHTS[index]
    prefix = org_id.replace("BU-", "LN-")
    return tuple(
        (f"{prefix}-{suffix}", names[j], weights[j])
        for j, suffix in enumerate("ABCDE")
    )


def _season(month: date) -> Decimal:
    return Decimal("0.92") + Decimal(month.month % 6) * Decimal("0.025")


def build_dataset(industry: str, end_period: str) -> dict[str, list[dict]]:
    """Build the complete semantic contract with reproducible decimal arithmetic."""
    p = PROFILES[industry]
    org_ids = ("BU-100", "BU-200", "BU-300", "BU-400", "BU-900")
    org = [{
        "org_unit_bk": "ROOT",
        "name": p.group_name or ("FSI Group" if industry == "fsi" else f"{industry.title()} Group"),
        "parent_bk": None, "level": 0, "effective_from": date(2025, 1, 1),
        "effective_to": None, "market": "GLOBAL",
    }]
    org += [{
        "org_unit_bk": key, "name": p.org_names[i], "parent_bk": "ROOT",
        "level": 1, "effective_from": date(2025, 1, 1), "effective_to": None,
        "market": p.markets[i],
    } for i, key in enumerate(org_ids)]
    org_market = {row["org_unit_bk"]: row["market"] for row in org}
    for parent_id in (*LINE_PARENTS, "BU-900"):
        for key, name, _ in _line_desks(industry, parent_id):
            org.append({
                "org_unit_bk": key, "name": name, "parent_bk": parent_id,
                "level": 2, "effective_from": date(2025, 1, 1), "effective_to": None,
                "market": org_market[parent_id],
            })
    org_market = {row["org_unit_bk"]: row["market"] for row in org}
    use_cases = [{
        "use_case_id": uc[0], "name": uc[1], "market": p.markets[i % len(p.markets)],
        "category": uc[2],
        "confidence_method": ("metered", "attested", "modelled")[i % 3],
        "owner_role": ("Chief Data Officer", "Business Value Owner")[i % 2],
        "status": "active" if i < 5 else "watch",
        "launched_on": date(2025, 1, 15),
        "org_unit_bk": org_ids[i] if i < len(org_ids) else org_ids[0],
        "attribution_policy_id": ATTRIBUTION_POLICY_ID,
    } for i, uc in enumerate(p.use_cases)]
    models = [{
        "model_id": m[0], "name": m[1], "tier": m[2], "model_class": m[3],
        "cost_per_mtok": _blended_per_mtok(m[4], m[5]),
        "price_input_per_mtok": m[4], "price_output_per_mtok": m[5],
        "provider": "workspace_gateway",
    } for m in MODELS]
    policy = [{
        "allocation_policy_id": POLICY_ID,
        "policy_name": "Enterprise AI shared-cost allocation — token share",
        "basis": "token_share",
        "owner_role": "Group CFO",
        "rule": "Allocate each month's shared platform and enablement cost by billable token share; residual cents go to the largest fractional remainders.",
        "signed_by": "Group CFO and Chief Data Officer",
        "signed_off_on": date(2025, 6, 1),
        "review_due_on": date(2026, 6, 1),
    }]
    attribution_policy = [{
        "attribution_policy_id": ATTRIBUTION_POLICY_ID,
        "policy_name": "Enterprise AI revenue attribution — signed baseline uplift",
        "owner_role": "Business Value Owner",
        "rule": "Attribute only uplift above a signed pre-AI baseline; modelled scenarios require explicit sign-off.",
        "method": "attested_uplift",
        "signed_off_on": date(2025, 7, 1),
        "review_due_on": date(2026, 7, 1),
    }]

    facts: list[dict] = []
    usage: list[dict] = []
    value_events: list[dict] = []
    investment_events: list[dict] = []
    invocations: list[dict] = []
    models_by_id = {model["model_id"]: model for model in models}
    use_case_shapes = [_norm_shape(shape) for shape in USE_CASE_ROTU_SHAPES]
    line_month_shapes = [_norm_shape(shape) for shape in LINE_MONTH_SHAPES]
    build_front_load = _norm_shape(BUILD_FRONT_LOAD)
    extra_models = [m for m in MODELS if m[0] not in (MIGRATION_SMALL, MIGRATION_MID, MIGRATION_LARGE)]
    sidecar_shapes = [_norm_shape(shape) for shape in SIDECAR_MONTH_SHAPES]
    orgs_by_concentration = sorted(
        range(len(org_ids)), key=lambda index: p.concentration[index]
    )
    small_model_org = orgs_by_concentration[0]
    migration_month = dict(zip(orgs_by_concentration[1:4], (2, 5, 8)))

    def _emit(
        *,
        org_id: str,
        org_index: int,
        uc: dict,
        model: dict,
        run_cost: Decimal,
        allocated: Decimal,
        month,
        month_index: int,
        tag: str,
    ) -> None:
        env = ENVIRONMENTS[(org_index + month_index) % 3]
        base_amortised = run_cost * (Decimal("0.18") + Decimal(org_index) * Decimal("0.015"))
        amortised = (base_amortised * build_front_load[month_index]).quantize(Decimal("0.01"))
        baseline_loaded = run_cost + base_amortised + allocated
        uc_index = next(i for i, row in enumerate(use_cases) if row["use_case_id"] == uc["use_case_id"])
        value = (
            baseline_loaded * p.profitability[org_index] * VALUE_RAMP[month_index] * use_case_shapes[uc_index][month_index]
        ).quantize(Decimal("0.01"))
        metered = (value * p.confidence[0]).quantize(Decimal("0.01"))
        attested = (value * p.confidence[1]).quantize(Decimal("0.01"))
        modelled = value - metered - attested
        effective_unit_cost = model["cost_per_mtok"] * (
            Decimal("1") - Decimal(month_index) * Decimal("0.015")
        )
        tokens = int((run_cost / effective_unit_cost * 1_000_000).to_integral_value()) if effective_unit_cost else 0
        requests = max(1, tokens // (1650 + org_index * 170)) if tokens else 1
        cache_rate = p.cache_rates[(org_index + month_index) % 3]
        # Input share of tokens varies by row. A single fixed 0.72 on every row is
        # an immediate synthetic-data tell; the cycle keeps generation deterministic
        # and leaves token totals and cost unchanged (output = tokens - input).
        input_share = INPUT_SHARE_CYCLE[(org_index * 3 + month_index + len(model["model_id"])) % len(INPUT_SHARE_CYCLE)]
        failure_rate = p.failure_rates[(org_index * 2 + month_index) % 3]
        cached = int(Decimal(tokens) * cache_rate)
        failed = int(Decimal(requests) * failure_rate)
        retried = int(Decimal(requests) * failure_rate * Decimal("1.65"))
        market = org_market[org_id]
        common = {
            "month": month, "org_unit_bk": org_id,
            "use_case_id": uc["use_case_id"], "model_id": model["model_id"],
            "market": market, "environment": env,
        }
        facts.append({
            **common, "allocation_policy_id": POLICY_ID,
            "run_cost_usd": run_cost,
            "amortised_investment_usd": amortised,
            "allocated_build_usd": allocated,
            "value_metered_usd": metered,
            "value_attested_usd": attested,
            "value_modelled_usd": modelled,
            "tokens": tokens, "requests": requests,
            "confidence_score": (p.confidence[0] + p.confidence[1]).quantize(Decimal("0.001")),
        })
        usage.append({
            **common, "usage_date": month, "input_tokens": int(tokens * input_share),
            "output_tokens": tokens - int(tokens * input_share),
            "cached_read_tokens": cached, "requests": requests,
            "requests_retried": retried, "requests_failed": failed,
            "cost_usd": run_cost,
            "p95_latency_ms": 310 + org_index * 95 + (month_index % 3) * 40,
        })
        for kind, amount in (
            ("metered", metered), ("attested", attested), ("modelled", modelled),
        ):
            if amount:
                value_events.append({
                    "event_id": f"val-{org_id}-{uc['use_case_id']}-{month.isoformat()}-{kind}-{tag}",
                    "event_date": month + timedelta(days=8),
                    "use_case_id": uc["use_case_id"],
                    "org_unit_bk": org_id,
                    "category": kind,
                    "amount_usd": amount,
                    "confidence": "proven" if kind != "modelled" else "modelled",
                    "source_system": "value_ledger",
                    "note": f"{kind} attribution",
                })
        for kind, amount in (
            ("amortised_build", amortised), ("allocated_build", allocated),
        ):
            if amount:
                investment_events.append({
                    "event_id": f"inv-{org_id}-{uc['use_case_id']}-{month.isoformat()}-{kind}-{tag}",
                    "event_date": month + timedelta(days=2),
                    "use_case_id": uc["use_case_id"],
                    "org_unit_bk": org_id,
                    "category": kind,
                    "amount_usd": amount,
                    "confidence": "attested",
                    "source_system": "investment_ledger",
                    "note": kind.replace("_", " "),
                })
        inv_cost = (run_cost / Decimal(max(requests, 1))).quantize(Decimal("0.0001"))
        for sample in range(2):
            invocations.append({
                "invocation_id": f"{org_id}-{month.isoformat()}-{org_index}-{tag}-{sample}",
                "event_time": f"{month.isoformat()}T0{8 + sample}:14:00",
                "consumer_id": org_id,
                "use_case_id": uc["use_case_id"],
                "model_id": model["model_id"],
                "api_type": "chat",
                "input_tokens": 800 + org_index * 40 + sample * 25,
                "output_tokens": 220 + sample * 30,
                "latency_ms": 280 + org_index * 40,
                "status_code": 200 if sample == 0 else (500 if failed else 200),
                "cost_usd": inv_cost,
                "request_tags": f"market={market};environment={env}",
            })

    for month_index, month in enumerate(_months(end_period)):
        season = _season(month)
        org_run = _cents_allocate(p.monthly_run_cost * season, list(p.concentration))
        allocations = _cents_allocate(p.shared_build_pool * season, list(p.concentration))
        for i, org_id in enumerate(org_ids):
            if i == small_model_org:
                model_id = MIGRATION_SMALL
            elif i in migration_month and month_index >= migration_month[i]:
                model_id = MIGRATION_MID
            else:
                model_id = MIGRATION_LARGE
            primary = models_by_id[model_id]
            run_cost = org_run[i]
            allocated = allocations[i]
            desks = _line_desks(industry, org_id)
            raw_weights = [
                desk[2] * line_month_shapes[j % len(line_month_shapes)][month_index]
                for j, desk in enumerate(desks)
            ]

            def _emit_desks(total_run: Decimal, total_alloc: Decimal, uc: dict, tag: str) -> None:
                desk_runs = _cents_allocate(total_run, raw_weights)
                desk_allocs = _cents_allocate(total_alloc, raw_weights)
                for desk, desk_run, desk_alloc in zip(desks, desk_runs, desk_allocs):
                    _emit(
                        org_id=desk[0], org_index=i, uc=uc, model=primary,
                        run_cost=desk_run, allocated=desk_alloc, month=month,
                        month_index=month_index, tag=f"{tag}:{desk[0]}",
                    )

            if i == 0:
                sidecar_run, primary_run = _cents_allocate(run_cost, [Decimal("0.05"), Decimal("0.95")])
                sidecar_alloc, primary_alloc = _cents_allocate(allocated, [Decimal("0.05"), Decimal("0.95")])
                run_a, run_b = _cents_allocate(primary_run, [Decimal("0.72"), Decimal("0.28")])
                alloc_a, alloc_b = _cents_allocate(primary_alloc, [Decimal("0.72"), Decimal("0.28")])
                _emit_desks(run_a, alloc_a, use_cases[0], "primary")
                _emit_desks(run_b, alloc_b, use_cases[5], "split")
                ceiling = primary["cost_per_mtok"] * Decimal("1.08")
                eligible = [m for m in extra_models if _blended_per_mtok(m[4], m[5]) <= ceiling] or extra_models
                side_weights = [
                    SIDECAR_WEIGHTS[j % len(SIDECAR_WEIGHTS)]
                    * sidecar_shapes[j % len(sidecar_shapes)][month_index]
                    for j in range(len(eligible))
                ]
                side_runs = _cents_allocate(sidecar_run, side_weights)
                side_allocs = _cents_allocate(sidecar_alloc, side_weights)
                first_desk = desks[0][0]
                for extra, side_run, side_alloc in zip(eligible, side_runs, side_allocs):
                    _emit(
                        org_id=first_desk, org_index=i, uc=use_cases[0],
                        model=models_by_id[extra[0]],
                        run_cost=side_run, allocated=side_alloc, month=month,
                        month_index=month_index, tag=extra[0],
                    )
                continue
            _emit_desks(run_cost, allocated, use_cases[i], "primary")

    year = int(end_period.split("-")[0])
    budgets = [{
        "org_unit_bk": org_id,
        "period_start": date(year, 1, 1),
        "period_end": date(year, 12, 31),
        "budget_usd": (p.monthly_run_cost * Decimal("12") * w * Decimal("1.08")).quantize(Decimal("0.01")),
    } for org_id, w in zip(org_ids, p.concentration)]

    reorg = [{
        "org_unit_bk": "BU-900",
        "name": p.org_names[-1],
        "effective_from": date(2025, 1, 1),
        "note": "Corporate functions retained; no material reorganisation in the window.",
    }]

    registry = [
        ("ai_run_cost", "AI run cost", "usd", "MEASURE(`Token Run Cost`)", "all"),
        ("fully_loaded_cost", "Fully loaded cost", "usd", "MEASURE(`Fully Loaded Cost`)", "all"),
        ("realised_value", "Realised value", "usd", "MEASURE(`Realised Value All`)", "all"),
        ("realised_value_proven", "Proven realised value", "usd", "MEASURE(`Realised Value Proven`)", "proven"),
        ("net_value", "Net value", "usd", "MEASURE(`Net Value`)", "all"),
        ("net_run_rate_value", "Net run-rate value", "usd", "Realised value − run cost (run-rate basis)", "all"),
        ("profitability_index", "Profitability index", "ratio", "MEASURE(`Profitability Index`)", "all"),
        ("run_rate_rodt", "Run-rate Return on Token Used", "ratio", "Net run-rate value / run cost", "all"),
        ("programme_rodt", "Programme Return on Token Used", "ratio", "Net value / fully loaded cost", "all"),
        ("cash_breakeven_month", "Cash break-even month", "months", "First month cumulative value covers cumulative outlay", "all"),
        ("cash_breakeven_days", "Cash break-even days", "days", "Cash break-even month × 30", "all"),
        ("simple_payback_months", "Simple payback", "months", "Fully loaded cost / average monthly realised value", "all"),
        ("cache_saving_usd", "Cache saving", "usd", "Cached tokens priced at blended run cost", "all"),
        ("retry_waste_usd", "Retry waste", "usd", "Retried request share of run cost", "all"),
        ("tagging_coverage", "Tagging coverage", "share", "1 - unattributed run cost / run cost", "all"),
    ]
    return {
        "dim_org_unit": org, "dim_use_case": use_cases, "dim_model": models,
        "dim_allocation_policy": policy, "dim_attribution_policy": attribution_policy,
        "fact_ai_daily": facts,
        "fact_usage_daily": usage, "fact_value_event": value_events,
        "fact_investment_event": investment_events, "fact_invocation": invocations,
        "fact_budget": budgets, "dim_reorganisation": reorg,
        "ai_roi_metric_registry": [
            {"metric_id": r[0], "label": r[1], "unit": r[2],
             "definition": r[3], "confidence_scope": r[4]} for r in registry
        ],
    }


def validate_dataset(dataset: dict[str, list[dict]], profile: AiRoiProfile) -> None:
    facts, usage = dataset["fact_ai_daily"], dataset["fact_usage_daily"]
    assert sum(r["run_cost_usd"] for r in facts) == sum(r["cost_usd"] for r in usage)
    assert {r["market"] for r in facts} <= {r["market"] for r in dataset["dim_org_unit"]}
    classes = [r["model_class"] for r in dataset["dim_model"]]
    assert classes.count("frontier") == 4
    assert classes.count("open_weights") == 6
    gf_names = {r["name"] for r in dataset["dim_org_unit"] if r["parent_bk"] == "BU-900"}
    assert gf_names == {"Risk", "Compliance", "Finance", "Technology", "Facilities", "HR"}
    for parent in LINE_PARENTS:
        kids = [r for r in dataset["dim_org_unit"] if r["parent_bk"] == parent]
        assert len(kids) == 5, parent
        costs = [
            sum(f["run_cost_usd"] for f in facts if f["org_unit_bk"] == kid["org_unit_bk"])
            for kid in kids
        ]
        assert all(cost > 0 for cost in costs), (parent, costs)
        assert min(costs) / max(costs) < Decimal("0.85"), (parent, costs)
    for month in {r["month"] for r in facts}:
        month_rows = [r for r in facts if r["month"] == month]
        expected = (profile.shared_build_pool * _season(month)).quantize(Decimal("0.01"))
        assert sum(r["allocated_build_usd"] for r in month_rows) == expected
    by_bk = {r["org_unit_bk"]: r for r in dataset["dim_org_unit"]}
    pi: dict[str, tuple[Decimal, Decimal]] = {}
    for row in facts:
        key = _level1_parent(row["org_unit_bk"], by_bk)
        value, cost = pi.get(key, (Decimal(0), Decimal(0)))
        pi[key] = (
            value + row["value_metered_usd"] + row["value_attested_usd"] + row["value_modelled_usd"],
            cost + row["run_cost_usd"] + row["amortised_investment_usd"] + row["allocated_build_usd"],
        )
    ratios = [v / c for v, c in pi.values()]
    assert min(ratios) < Decimal("1.0") < max(ratios)
    event_value = sum(r["amount_usd"] for r in dataset["fact_value_event"])
    fact_value = sum(
        r["value_metered_usd"] + r["value_attested_usd"] + r["value_modelled_usd"]
        for r in facts
    )
    assert event_value == fact_value
    assert dataset["fact_budget"]
    assert dataset["fact_invocation"]


def _sql_value(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, date):
        return f"DATE '{value.isoformat()}'"
    if isinstance(value, (Decimal, int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def _create_table(run, fq: str, columns: tuple[tuple[str, str], ...], rows: list[dict]) -> None:
    run(f"CREATE OR REPLACE TABLE {fq} ({', '.join(f'`{n}` {t}' for n, t in columns)})")
    names = [name for name, _ in columns]
    values = [f"({', '.join(_sql_value(row[name]) for name in names)})" for row in rows]
    for start in range(0, len(values), 200):
        run(f"INSERT INTO {fq} VALUES {', '.join(values[start:start + 200])}")


def seed_ai_roi(industry: str, serving_schema: str, end_period: str, run) -> None:
    """Create the warehouse contract and restore both app principals' grants."""
    dataset = build_dataset(industry, end_period)
    validate_dataset(dataset, PROFILES[industry])
    specs = {
        "dim_org_unit": (("org_unit_bk", "STRING"), ("name", "STRING"), ("parent_bk", "STRING"), ("level", "INT"), ("effective_from", "DATE"), ("effective_to", "DATE"), ("market", "STRING")),
        "dim_use_case": (("use_case_id", "STRING"), ("name", "STRING"), ("market", "STRING"), ("category", "STRING"), ("confidence_method", "STRING"), ("owner_role", "STRING"), ("status", "STRING"), ("launched_on", "DATE"), ("org_unit_bk", "STRING"), ("attribution_policy_id", "STRING")),
        "dim_model": (("model_id", "STRING"), ("name", "STRING"), ("tier", "STRING"), ("model_class", "STRING"), ("cost_per_mtok", "DECIMAL(18,4)"), ("price_input_per_mtok", "DECIMAL(18,4)"), ("price_output_per_mtok", "DECIMAL(18,4)"), ("provider", "STRING")),
        "dim_allocation_policy": (("allocation_policy_id", "STRING"), ("policy_name", "STRING"), ("basis", "STRING"), ("owner_role", "STRING"), ("rule", "STRING"), ("signed_by", "STRING"), ("signed_off_on", "DATE"), ("review_due_on", "DATE")),
        "dim_attribution_policy": (("attribution_policy_id", "STRING"), ("policy_name", "STRING"), ("owner_role", "STRING"), ("rule", "STRING"), ("method", "STRING"), ("signed_off_on", "DATE"), ("review_due_on", "DATE")),
        "dim_reorganisation": (("org_unit_bk", "STRING"), ("name", "STRING"), ("effective_from", "DATE"), ("note", "STRING")),
        "fact_ai_daily": (("month", "DATE"), ("org_unit_bk", "STRING"), ("use_case_id", "STRING"), ("model_id", "STRING"), ("market", "STRING"), ("environment", "STRING"), ("allocation_policy_id", "STRING"), ("run_cost_usd", "DECIMAL(18,2)"), ("amortised_investment_usd", "DECIMAL(18,2)"), ("allocated_build_usd", "DECIMAL(18,2)"), ("value_metered_usd", "DECIMAL(18,2)"), ("value_attested_usd", "DECIMAL(18,2)"), ("value_modelled_usd", "DECIMAL(18,2)"), ("tokens", "BIGINT"), ("requests", "BIGINT"), ("confidence_score", "DECIMAL(6,3)")),
        "fact_usage_daily": (("usage_date", "DATE"), ("month", "DATE"), ("org_unit_bk", "STRING"), ("use_case_id", "STRING"), ("model_id", "STRING"), ("market", "STRING"), ("environment", "STRING"), ("input_tokens", "BIGINT"), ("output_tokens", "BIGINT"), ("cached_read_tokens", "BIGINT"), ("requests", "BIGINT"), ("requests_retried", "BIGINT"), ("requests_failed", "BIGINT"), ("cost_usd", "DECIMAL(18,2)"), ("p95_latency_ms", "BIGINT")),
        "fact_value_event": (("event_id", "STRING"), ("event_date", "DATE"), ("use_case_id", "STRING"), ("org_unit_bk", "STRING"), ("category", "STRING"), ("amount_usd", "DECIMAL(18,2)"), ("confidence", "STRING"), ("source_system", "STRING"), ("note", "STRING")),
        "fact_investment_event": (("event_id", "STRING"), ("event_date", "DATE"), ("use_case_id", "STRING"), ("org_unit_bk", "STRING"), ("category", "STRING"), ("amount_usd", "DECIMAL(18,2)"), ("confidence", "STRING"), ("source_system", "STRING"), ("note", "STRING")),
        "fact_invocation": (("invocation_id", "STRING"), ("event_time", "STRING"), ("consumer_id", "STRING"), ("use_case_id", "STRING"), ("model_id", "STRING"), ("api_type", "STRING"), ("input_tokens", "BIGINT"), ("output_tokens", "BIGINT"), ("latency_ms", "BIGINT"), ("status_code", "INT"), ("cost_usd", "DECIMAL(18,4)"), ("request_tags", "STRING")),
        "fact_budget": (("org_unit_bk", "STRING"), ("period_start", "DATE"), ("period_end", "DATE"), ("budget_usd", "DECIMAL(18,2)")),
        "ai_roi_metric_registry": (("metric_id", "STRING"), ("label", "STRING"), ("unit", "STRING"), ("definition", "STRING"), ("confidence_scope", "STRING")),
    }
    for table, columns in specs.items():
        _create_table(run, f"{serving_schema}.{table}", columns, dataset[table])
    run(f"""CREATE OR REPLACE VIEW {serving_schema}.mv_ai_roi
      WITH METRICS
      LANGUAGE YAML
      AS $$
      version: 1.1
      source: {serving_schema}.fact_ai_daily
      dimensions:
        - name: Month
          expr: month
        - name: Business Unit
          expr: org_unit_bk
        - name: Use Case
          expr: use_case_id
        - name: Market
          expr: market
        - name: Model
          expr: model_id
        - name: Environment
          expr: environment
      measures:
        - name: Token Run Cost
          expr: SUM(run_cost_usd)
        - name: Amortised Build Cost
          expr: SUM(amortised_investment_usd)
        - name: Allocated Build Cost
          expr: SUM(allocated_build_usd)
        - name: Fully Loaded Cost
          expr: SUM(run_cost_usd + amortised_investment_usd + allocated_build_usd)
        - name: Realised Value All
          expr: SUM(value_metered_usd + value_attested_usd + value_modelled_usd)
        - name: Realised Value Proven
          expr: SUM(value_metered_usd + value_attested_usd)
        - name: Net Value
          expr: MEASURE(`Realised Value All`) - MEASURE(`Fully Loaded Cost`)
        - name: Profitability Index
          expr: MEASURE(`Realised Value All`) / NULLIF(MEASURE(`Fully Loaded Cost`), 0)
        - name: Profitability Index Proven
          expr: MEASURE(`Realised Value Proven`) / NULLIF(MEASURE(`Fully Loaded Cost`), 0)
        - name: Total Tokens
          expr: SUM(tokens)
        - name: Requests
          expr: SUM(requests)
        - name: Revenue per Mtok
          expr: MEASURE(`Realised Value All`) / NULLIF(MEASURE(`Total Tokens`) / 1000000.0, 0)
        - name: Token Cost per Mtok
          expr: MEASURE(`Token Run Cost`) / NULLIF(MEASURE(`Total Tokens`) / 1000000.0, 0)
        - name: Fully Loaded Cost per Mtok
          expr: MEASURE(`Fully Loaded Cost`) / NULLIF(MEASURE(`Total Tokens`) / 1000000.0, 0)
      $$""")
    catalog = serving_schema.split(".", 1)[0]
    if APP_SERVICE_PRINCIPALS:
        for principal in APP_SERVICE_PRINCIPALS:
            run(f"GRANT USE CATALOG ON CATALOG {catalog} TO `{principal}`")
            run(f"GRANT USE SCHEMA ON SCHEMA {serving_schema} TO `{principal}`")
            run(f"GRANT SELECT ON SCHEMA {serving_schema} TO `{principal}`")
        print(f"    ai_roi: {len(dataset['fact_ai_daily'])} fact rows + semantic contract + grants to {len(APP_SERVICE_PRINCIPALS)} app SPs")
    else:
        print(f"    ai_roi: {len(dataset['fact_ai_daily'])} fact rows + identical semantic contract (no app SP grants; set CFO_APP_SP_IDS to grant access)")
