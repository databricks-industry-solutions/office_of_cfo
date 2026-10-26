"""Per-industry profiles for the multi-industry CFO demo.

Single source of truth for how each industry re-skins the (structurally identical)
Northwind close dataset when it is cloned into its own `office_of_cfo.{industry}_*`
schema set. Cosmetic + additive only:

  * ``bu`` .............. per-business-unit display names, legal entities, source
                          system and country (BU-id + region codes stay STABLE so
                          kpi_history / personas / scope rollups remain valid).
  * ``source_system`` .. old -> new source-system relabel map (data + lineage page).
  * ``business_line`` .. old -> new business-line relabel map.
  * ``coa`` ............ account_code -> new account_name overrides (trial balance).
  * ``cogs_label`` ..... display label for the cost-of-revenue line.
  * ``ar_counterparties`` / ``ap_counterparties`` .. curated pools that replace the
                          generic "Customer A00" / "Vendor A00" names, mapped
                          deterministically onto the existing distinct names.
  * ``headline_kpis`` .. the Executive-page headline KPI tiles: illustrative FY2025
                          figures at a realistic scale for the industry. They are not
                          any real company's reported results.
  * ``market_target`` / ``market_drivers`` .. the Market-Insights driver panel: the
                          forecast target metric + its candidate external/internal
                          drivers, each with a synthetic ground-truth sensitivity
                          (``beta``) and lead (``lag_m``) that the driver-ID step
                          (LassoCV in seed_industries.py) re-discovers from the data;
                          decoys (``is_signal=False``) get correctly de-selected.

Industries whose profile has no relabel maps (``software``, ``fsi``) are cloned as
Northwind and only receive light source-system/COGS relabels + headline KPIs.
"""
from __future__ import annotations

# Industry roster (must match app/server/industry.py and frontend industries.ts).
# The one industry list for every setup script (data_generation/_common.py, genie/,
# aibi/ and scripts/setup.py import it). The app keeps its own copies in
# app/server/industry.py and app/frontend/src/lib/industries.ts, and the bundle
# has one database + env/variables per industry; tests/test_industry_lists_in_sync.py
# fails if any of them drift.
INDUSTRIES = ("consumer", "software", "fsi", "energy", "capmarkets")
DEFAULT_INDUSTRY = "consumer"


def _kpi(kpi_id, label, value, unit, good, delta=None, segment=None, order=0):
    return {
        "kpi_id": kpi_id, "label": label, "value": float(value), "unit": unit,
        "good_direction": good, "delta": None if delta is None else float(delta),
        "segment": segment, "sort_order": order,
    }


def _driver(driver_id, label, unit, category, beta, lag_m=0, is_signal=True):
    """A candidate market driver for the Market-Insights forecast panel.

    beta      -- synthetic ground-truth sensitivity: %Delta-target per +1 unit
                 (or +1%) of the driver. Re-discovered by the LassoCV fit in the
                 seed step; the panel ranks drivers by the *fitted* value, not this.
    lag_m     -- months the driver LEADS the target (0 = contemporaneous).
    is_signal -- False => a decoy: generated with NO real link to the target so the
                 driver-ID step correctly de-selects it (demonstrates the method).
    """
    return {
        "driver_id": driver_id, "label": label, "unit": unit,
        "category": category, "beta": float(beta), "lag_m": int(lag_m),
        "is_signal": bool(is_signal),
    }


def _event(driver_id, headline, source, move_sigma):
    """A curated 'current' market signal for the Market-Insights feed (demo).

    driver_id  -- the market driver this news maps to (must be a SELECTED driver,
                  so it carries a fitted sensitivity).
    move_sigma -- size of the recent move, in standard deviations (signed). The
                  forecast impact is derived at seed time as
                  move_sigma * the driver's fitted impact_per_sigma, so the feed
                  reuses the driver model rather than inventing numbers.
    """
    return {"driver_id": driver_id, "headline": headline, "source": source,
            "move_sigma": float(move_sigma)}


# ---------------------------------------------------------------------------
# ENERGY & UTILITIES — GENERIC integrated energy company (energy supply,
# generation, trading & optimization). Deliberately brand-free: region-based BU
# names like ``consumer`` (no real company), USD reporting, figures synthetic and
# illustrative for a ~$25–30bn integrated energy group — NOT tied to any one firm.
# ---------------------------------------------------------------------------
ENERGY = {
    "label": "Energy & Utilities",
    "bu": {
        # BU-id      display name       legal entity                          source system                country
        "BU-100": ("North America",   "Energy & Utilities NA Inc.",          "SAP S/4HANA Utilities",     "United States"),
        "BU-200": ("Europe",          "Energy & Utilities Europe B.V.",      "SAP IS-U (Billing)",        "Netherlands"),
        "BU-300": ("Asia Pacific",    "Energy & Utilities APAC Pte. Ltd.",   "SAP S/4HANA Utilities",     "Singapore"),
        "BU-400": ("Latin America",   "Energy & Utilities LatAm Ltda.",      "ETRM (Trading)",            "Brazil"),
        "BU-900": ("Corporate",       "Energy & Utilities Group plc",        "SAP S/4HANA Utilities",     "United Kingdom"),
    },
    "source_system": {
        "SAP": "SAP S/4HANA Utilities",
        "AFAS": "SAP IS-U (Billing)",
        "SAP-FixedAssets": "SAP S/4HANA Utilities",
        "Legacy-ERP": "Legacy Billing System",
        "Workday": "Workday",
        "Bank Feed": "Bank Feed",
    },
    "business_line": {
        "Products": "Energy Supply",
        "Services": "Generation",
        "Shared Services": "Trading & Optimization",
    },
    "coa": {
        "40000": "Energy Supply Revenue",
        "41000": "Generation Revenue",
        "50000": "Cost of Energy (Wholesale & Fuel)",
        "12000": "Gas in Storage",
        "62000": "Operating Expense - Network Charges",
    },
    "cogs_label": "Cost of Energy",
    "ap_counterparties": [
        "Regional Transmission Operator", "Transmission System Operator — Europe",
        "Distribution Network — North America", "Distribution Network — Europe",
        "Gas Pipeline Operator", "Power Exchange (Day-Ahead)", "Power Exchange (Intraday)",
        "North Sea Gas Producer", "Integrated Oil Major — Gas Trading", "LNG Portfolio Supplier",
        "Wholesale Gas Marketer", "Global Commodities Trader", "Independent Energy Trader",
        "Physical Gas & Power Trader", "Offshore Wind Generator", "Renewables Marketing Co",
        "Nuclear Generator — Wholesale", "Utility Trading Desk",
    ],
    "ar_counterparties": [
        "Continental Steelworks", "Global Auto Manufacturing", "National Health Estates",
        "National Rail Infrastructure", "Metro Grocery Group", "Hyperscale Data Centres",
        "Cloud Services Datacenter", "International Airport Authority", "State University System",
        "Metropolitan City Council", "Global Logistics Group", "Continental Foods",
        "Consumer Products Mfg", "Pharma Manufacturing", "Beverage Bottling Co",
        "Regional Transit Authority", "Advanced Semiconductors", "Chemical Processing Plc",
        "Automotive Assembly Group", "Heavy Industries Ltd",
    ],
    "headline_kpis": [
        _kpi("adjusted_ebitda", "Group Adjusted EBITDA", 6.2, "$bn", "up", 0.4, order=1),
        _kpi("adjusted_operating_profit", "Adjusted Operating Profit", 3.4, "$bn", "up", 0.2, order=2),
        _kpi("free_cash_flow", "Free Cash Flow", 2.8, "$bn", "up", 0.3, order=3),
        _kpi("adjusted_eps", "Adjusted EPS", 1.85, "$", "up", 0.12, order=4),
        _kpi("total_retail_customers", "Total Energy Customers", 12.5, "m", "up", 0.3, order=5),
        _kpi("renewables_share", "Renewables Share of Generation", 42, "%", "up", 8, order=6),
        _kpi("aop_supply", "AOP — Energy Supply", 1.4, "$bn", "up", 0.1, segment="Energy Supply", order=7),
        _kpi("aop_generation", "AOP — Generation", 1.1, "$bn", "up", 0.15, segment="Generation", order=8),
        _kpi("aop_trading", "AOP — Trading & Optimization", 0.9, "$bn", "up", -0.1, segment="Trading & Optimization", order=9),
    ],
}

# ---------------------------------------------------------------------------
# CONSUMER GOODS — a global home & personal care and foods group (illustrative, FY2025).
# ---------------------------------------------------------------------------
CONSUMER = {
    "label": "Consumer Goods",
    "bu": {
        "BU-100": ("North America",   "Consumer Goods NA Inc.",       "SAP S/4HANA", "United States"),
        "BU-200": ("Europe",          "Consumer Goods Europe B.V.",   "SAP ECC",     "Netherlands"),
        "BU-300": ("Asia Pacific",    "Consumer Goods APAC Pte. Ltd.", "SAP S/4HANA", "Singapore"),
        "BU-400": ("Latin America",   "Consumer Goods LatAm Ltda.",   "SAP S/4HANA", "Brazil"),
        "BU-900": ("Corporate",       "Consumer Goods Group plc",     "SAP S/4HANA", "United Kingdom"),
    },
    "source_system": {
        "SAP": "SAP S/4HANA",
        "AFAS": "SAP ECC",
        "SAP-FixedAssets": "SAP S/4HANA",
        "Legacy-ERP": "Legacy ERP (JDE)",
        "Workday": "Workday",
        "Bank Feed": "Bank Feed",
    },
    "business_line": {
        "Products": "Home & Personal Care",
        "Services": "Foods & Nutrition",
        "Shared Services": "Corporate",
    },
    "coa": {
        "40000": "Net Sales — Home & Personal Care",
        "41000": "Net Sales — Foods & Nutrition",
        "50000": "Cost of Goods Sold",
        "12000": "Inventory — Finished Goods",
    },
    "cogs_label": "Cost of Goods Sold",
    "ap_counterparties": [
        "Specialty Chemicals Supplier", "Commodity Chemicals Supplier", "Agri-Commodities Trader",
        "Grain & Oilseed Processor", "Nutrition Ingredients Supplier", "Flavours & Fragrances House",
        "Rigid Packaging Supplier", "Corrugated Packaging Mill", "Carton Packaging Supplier",
        "Flexible Packaging Supplier", "Ocean Freight Carrier", "Contract Logistics Provider",
        "Freight Forwarder", "Global Advertising Agency", "Media Buying Agency",
        "Personal-Care Actives Supplier", "Aroma Ingredients Supplier", "Fine Paper Mill",
        "Plastics Converter", "Fibre Packaging Supplier",
    ],
    "ar_counterparties": [
        "US Mass Merchant", "UK Grocery Chain", "European Hypermarket Group",
        "Benelux Grocery Group", "Membership Warehouse Club", "Online Marketplace",
        "US Discount Retailer", "German Discount Grocer", "European Discount Chain",
        "UK Supermarket Group", "US Grocery Chain", "Cash & Carry Wholesaler",
        "French Hypermarket Group", "China E-commerce Platform", "Indian Retail Group",
        "US Pharmacy Chain", "US Health Retailer", "Australian Supermarket Group",
        "Canadian Grocery Group", "European Retail Conglomerate",
    ],
    "headline_kpis": [
        _kpi("usg", "Underlying Sales Growth", 4.1, "%", "up", 0.4, order=1),
        _kpi("gross_margin", "Gross Margin", 44.8, "%", "up", 0.3, order=2),
        _kpi("underlying_operating_margin", "Underlying Operating Margin", 18.6, "%", "up", 0.5, order=3),
        _kpi("free_cash_flow", "Free Cash Flow", 4.7, "€bn", "up", -0.3, order=4),
        _kpi("cash_conversion_pct", "Cash Conversion", 96, "%", "up", None, order=5),
        _kpi("underlying_eps", "Underlying EPS", 2.64, "€", "up", 0.05, order=6),
        _kpi("usg_beauty", "USG — Beauty & Wellbeing", 5.2, "%", "up", None, segment="Beauty & Wellbeing", order=7),
        _kpi("usg_personal", "USG — Personal Care", 3.9, "%", "up", None, segment="Personal Care", order=8),
        _kpi("usg_home", "USG — Home Care", 3.1, "%", "up", None, segment="Home Care", order=9),
        _kpi("usg_foods", "USG — Foods", 2.0, "%", "up", None, segment="Foods", order=10),
    ],
}

# ---------------------------------------------------------------------------
# SOFTWARE & SaaS — a global enterprise SaaS vendor (illustrative, FY2025). Northwind data kept; light
# source-system relabels + headline KPIs only.
# ---------------------------------------------------------------------------
SOFTWARE = {
    "label": "Software & SaaS",
    "bu": {},  # keep Northwind org
    "source_system": {
        "SAP": "NetSuite",
        "AFAS": "NetSuite",
        "SAP-FixedAssets": "NetSuite",
        "Bank Feed": "Stripe / Bank Feed",
    },
    "business_line": {},
    "coa": {"50000": "Cost of Revenue"},
    "cogs_label": "Cost of Revenue",
    "ap_counterparties": [],
    "ar_counterparties": [],
    "headline_kpis": [
        _kpi("total_revenue_growth", "Total Revenue Growth (Y/Y)", 11.0, "%", "up", None, order=1),
        _kpi("subscription_revenue", "Subscription & Support Revenue", 21.4, "$bn", "up", 2.0, order=2),
        _kpi("crpo", "Current RPO (cRPO)", 18.1, "$bn", "up", 1.7, order=3),
        _kpi("total_rpo", "Total RPO", 38.0, "$bn", "up", 4.1, order=4),
        _kpi("non_gaap_operating_margin", "Non-GAAP Operating Margin", 29.5, "%", "up", None, order=5),
        _kpi("free_cash_flow", "Free Cash Flow", 6.8, "$bn", "up", 1.2, order=6),
    ],
}

# ---------------------------------------------------------------------------
# FINANCIAL SERVICES — a European retail & wholesale bank (illustrative, FY2025). Northwind data kept; light
# source-system / COGS relabels + headline KPIs.
# ---------------------------------------------------------------------------
FSI = {
    "label": "Financial Services",
    "bu": {},
    "source_system": {
        "SAP": "Core Banking (FIS)",
        "AFAS": "Core Banking (FIS)",
        "SAP-FixedAssets": "Core Banking (FIS)",
        "Bank Feed": "Bank Feed",
    },
    "business_line": {},
    "coa": {"50000": "Cost of Services"},
    "cogs_label": "Cost of Services",
    "ap_counterparties": [],
    "ar_counterparties": [],
    "headline_kpis": [
        _kpi("net_interest_income", "Net Interest Income", 11240, "€m", "up", -260, order=1),
        _kpi("nim", "Net Interest Margin", 1.62, "%", "up", None, order=2),
        _kpi("fee_income_growth", "Fee Income Growth (Y/Y)", 9.0, "%", "up", None, order=3),
        _kpi("cost_income_ratio", "Cost/Income Ratio", 57.9, "%", "down", 0.8, order=4),
        _kpi("roe", "Return on Equity", 11.4, "%", "up", 0.3, order=5),
        _kpi("cet1_ratio", "CET1 Ratio", 14.2, "%", "up", -0.3, order=6),
    ],
}

# ---------------------------------------------------------------------------
# CAPITAL MARKETS — a mid-sized global ETP market maker (illustrative, FY2025).
# A market maker reports net trading income rather than revenue and has no
# COGS / gross-profit line, so the overlay hides those statement lines.
# ---------------------------------------------------------------------------
CAPMARKETS = {
    "label": "Capital Markets",
    "bu": {
        # BU-id      display name     legal entity                           source system                 country
        "BU-100": ("Europe",        "Capital Markets Europe B.V.",          "Trade Capture & P&L",        "Netherlands"),
        "BU-200": ("Americas",      "Capital Markets U.S. LLC",             "Trade Capture & P&L",        "United States"),
        "BU-300": ("Asia",          "Capital Markets Asia Pte. Ltd.",       "Trade Capture & P&L",        "Singapore"),
        "BU-400": ("Hong Kong",     "Capital Markets Hong Kong Ltd.",       "Trade Capture & P&L",        "Hong Kong"),
        "BU-900": ("Group",         "Capital Markets Group N.V.",           "Finance ERP (SAP S/4HANA)",  "Netherlands"),
    },
    "source_system": {
        "SAP": "Finance ERP (SAP S/4HANA)",
        "AFAS": "Trade Capture & P&L",
        "SAP-FixedAssets": "Finance ERP (SAP S/4HANA)",
        "Legacy-ERP": "Legacy Settlement System",
        "Workday": "Workday",
        "Bank Feed": "Clearing & Prime Broker Feed",
    },
    "business_line": {
        "Products": "ETP Market Making",
        "Services": "Institutional OTC",
        "Shared Services": "Group Functions",
    },
    "coa": {
        "40000": "Net Trading Income",
        "41000": "Other Income",
        "50000": "Exchange, Clearing & Brokerage Fees",
        "62000": "Operating Expense - Market Data",
    },
    "cogs_label": "Exchange & Clearing Fees",
    "ap_counterparties": [
        "Pan-European Exchange", "German Equity Exchange", "UK Equity Exchange", "European MTF",
        "Swiss Equity Exchange", "US ETF Listing Venue", "US Equity Exchange", "US Options Exchange",
        "Hong Kong Equity Exchange", "Singapore Equity Venue", "UK Central Counterparty",
        "EU Central Counterparty", "US Options Clearing House",
        "Market Data Terminal Provider", "EU Market Data Vendor", "US Market Data Vendor",
        "Hyperscale Cloud Provider", "Public Cloud Provider",
    ],
    "ar_counterparties": [
        "Global Asset Manager", "European Pension Fund", "Sovereign Wealth Fund",
        "Multi-Strategy Hedge Fund", "Private Bank", "Regional Bank Treasury",
        "Insurance Investment Office", "Family Office", "Wealth Platform",
        "Digital Asset Exchange", "Crypto Custodian", "Corporate Treasury",
        "Retail Brokerage", "Robo-Adviser Platform", "ETF Issuer",
    ],
    "headline_kpis": [
        _kpi("net_trading_income", "Net Trading Income", 362.4, "€m", "up", 14, order=1),
        _kpi("ebitda", "EBITDA", 141.7, "€m", "up", -12, order=2),
        _kpi("ebitda_margin", "EBITDA Margin", 39.1, "%", "up", None, order=3),
        _kpi("net_profit", "Net Profit", 96.3, "€m", "up", -18, order=4),
        _kpi("trading_capital", "Trading Capital", 780, "€m", "up", None, order=5),
        _kpi("etp_value_traded", "ETP Value Traded", 1420, "€bn", "up", 290, order=6),
        _kpi("fte", "FTE", 480, "", "up", None, order=7),
    ],
}


# ---------------------------------------------------------------------------
# MARKET-INSIGHTS DRIVERS (additive; consumed by the shared Market Insights page).
#
# Each industry declares the forecast target metric + a candidate universe of
# external/internal drivers. seed_industries.py builds the target FROM the signal
# drivers  ( target = seasonal_base + sum( beta_i * driver_i(t - lag_i) ) + noise )
# then re-fits a LassoCV to *re-discover* these betas and drop the decoys, so the
# panel shows a genuine data-driven ranking. beta / lag_m are demo dials — tune per
# model-company narrative. Every industry carries exactly one decoy (is_signal=False).
# ---------------------------------------------------------------------------
ENERGY["market_target"] = {"metric_id": "energy_supply_revenue", "label": "Energy Supply Revenue", "unit": "$bn", "level": 12.5}
ENERGY["market_drivers"] = [
    _driver("power_price",   "Baseload Power Price",   "$/MWh",   "commodity", beta=0.42, lag_m=1),
    _driver("gas_price",     "Wholesale Gas Price",    "$/MMBtu", "commodity", beta=0.31, lag_m=1),
    _driver("hdd",           "Heating Degree Days",    "HDD",     "weather",   beta=0.28, lag_m=0),
    _driver("carbon_price",  "Carbon Allowance Price", "$/t",     "commodity", beta=0.15, lag_m=1),
    _driver("policy_rate",   "Policy Rate",            "%",       "macro",     beta=0.00, lag_m=2, is_signal=False),
]

CONSUMER["market_target"] = {"metric_id": "net_sales", "label": "Net Sales", "unit": "€m", "level": 5000.0}
CONSUMER["market_drivers"] = [
    _driver("cons_confidence", "Consumer Confidence Index", "index", "macro",     beta=0.38, lag_m=1),
    _driver("disp_income",     "Real Disposable Income",    "%",     "macro",     beta=0.22, lag_m=1),
    _driver("input_cost_idx",  "Input Cost Index",          "index", "commodity", beta=0.14, lag_m=1),
    _driver("fx_basket",       "FX Basket (translation)",   "index", "macro",     beta=0.12, lag_m=0),
    _driver("ad_spend",        "Advertising Spend",         "€m",    "internal",  beta=0.15, lag_m=1),
    _driver("retail_footfall", "Retail Footfall",           "index", "sector",    beta=0.00, lag_m=0, is_signal=False),
]

SOFTWARE["market_target"] = {"metric_id": "subscription_revenue", "label": "Subscription & Support Revenue", "unit": "$bn", "level": 3.0}
SOFTWARE["market_drivers"] = [
    _driver("it_spend_idx",    "Enterprise IT Spend Index", "index", "sector",   beta=0.40, lag_m=1),
    _driver("ent_pmi",         "Enterprise PMI",            "index", "macro",    beta=0.24, lag_m=1),
    _driver("sales_headcount", "Quota-Carrying Headcount",  "FTE",   "internal", beta=0.30, lag_m=2),
    _driver("policy_rate",     "Policy Rate",               "%",     "macro",    beta=-0.16, lag_m=1),
    _driver("retail_footfall", "Retail Footfall",           "index", "sector",   beta=0.00, lag_m=0, is_signal=False),
]

FSI["market_target"] = {"metric_id": "net_interest_income", "label": "Net Interest Income", "unit": "€m", "level": 1200.0}
FSI["market_drivers"] = [
    _driver("policy_rate",  "ECB Policy Rate",             "%",     "macro",    beta=0.45, lag_m=0),
    _driver("curve_slope",  "Yield Curve Slope (10y-2y)",  "bps",   "macro",    beta=0.22, lag_m=1),
    _driver("loan_volume",  "Loan Book Volume",            "€bn",   "internal", beta=0.28, lag_m=1),
    _driver("unemployment", "Unemployment Rate",           "%",     "macro",    beta=-0.15, lag_m=2),
    _driver("equity_index", "Equity Market Index",         "index", "market",   beta=0.00, lag_m=0, is_signal=False),
]

CAPMARKETS["market_target"] = {"metric_id": "net_trading_income", "label": "Net Trading Income", "unit": "€m", "level": 40.0}
CAPMARKETS["market_drivers"] = [
    _driver("equity_vol",    "Equity Volatility (VSTOXX)",     "index", "market",   beta=0.44, lag_m=0),
    _driver("etp_volume",    "Global ETP Value Traded",        "€bn",   "market",   beta=0.31, lag_m=0),
    _driver("crypto_vol",    "Crypto Volatility",              "index", "market",   beta=0.17, lag_m=0),
    _driver("rates_vol",     "Rates Volatility (MOVE)",        "index", "macro",    beta=0.12, lag_m=1),
    _driver("policy_rate",   "ECB Policy Rate",                "%",     "macro",    beta=0.00, lag_m=1, is_signal=False),
]

# ---------------------------------------------------------------------------
# CURATED 'CURRENT' MARKET SIGNALS (demo feed). Each event maps a news headline
# to a SELECTED driver + a recent move (in sigma); seed_industries derives the
# £/€/$ forecast impact as move_sigma * that driver's fitted impact_per_sigma.
# Curated (not derived) so the demo story is controlled: each industry leans one
# way (energy = upside gas exposure; consumer = downside demand) with an offset.
# ---------------------------------------------------------------------------
ENERGY["market_events"] = [
    _event("power_price", "Baseload power rises as a cold snap and tighter generation margins squeeze supply", "Market Report", 1.4),
    _event("gas_price",   "Wholesale gas spikes as production outages tighten the global market", "Energy Intelligence", 1.1),
    _event("hdd",         "Forecasters signal a colder-than-normal winter across key markets", "Weather Service", 0.9),
]
CONSUMER["market_events"] = [
    _event("cons_confidence", "Consumer confidence slides to a two-year low on cost-of-living strain", "GfK", -1.3),
    _event("disp_income",     "Real disposable income dips as wage growth trails inflation", "ONS", -0.6),
    _event("fx_basket",       "Euro weakens against the dollar, lifting translated overseas sales", "ECB Reference Rates", 0.7),
]
SOFTWARE["market_events"] = [
    _event("it_spend_idx", "Enterprise IT budgets expand as firms accelerate AI programmes", "Gartner", 1.3),
    _event("policy_rate",  "Central bank signals rates 'higher for longer', lengthening deal cycles", "Reuters", 0.9),
    _event("ent_pmi",      "Global business-activity index rises for a third straight month", "S&P Global PMI", 0.5),
]
FSI["market_events"] = [
    _event("policy_rate",  "ECB holds at cycle-high rates as core inflation stays sticky", "ECB", 1.2),
    _event("unemployment", "Euro-area unemployment edges up as hiring cools", "Eurostat", 0.8),
    _event("curve_slope",  "Yield curve steepens as long-end yields climb", "Bloomberg", 0.6),
]
CAPMARKETS["market_events"] = [
    _event("equity_vol", "European equity volatility jumps as a growth scare hits risk assets", "Bloomberg", 1.3),
    _event("etp_volume", "ETP trading volumes hit a record as investors rotate through index products", "Financial Times", 0.9),
    _event("crypto_vol", "Crypto volatility subsides as spot ETF flows stabilise", "CoinDesk", -0.6),
]


PROFILES = {
    "consumer": CONSUMER,
    "software": SOFTWARE,
    "fsi": FSI,
    "energy": ENERGY,
    "capmarkets": CAPMARKETS,
}


def profile(industry: str) -> dict:
    return PROFILES.get(industry, CONSUMER)
