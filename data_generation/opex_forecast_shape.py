"""Opex forecast vs actual: mixed over- and under-spend by account.

``forecast_amount = actual * factor``. Factor < 1 is overspend (unfavorable);
factor > 1 is underspend (favorable). Shared across industries so the FP&A
budget-variance strip is never a one-sided row of the same color.
"""
from __future__ import annotations

# Keys are COA account_code values (stable across industries).
OPEX_FORECAST_FACTORS: dict[str, float] = {
    "60000": 0.87,  # Salaries — overspend
    "61000": 0.93,  # Rent — overspend
    "62000": 0.94,  # Utilities / network charges — overspend
    "63000": 1.14,  # Marketing — underspend
    "64000": 1.13,  # Travel — underspend
    "65000": 1.10,  # Depreciation — underspend
    "66000": 1.12,  # Professional fees — underspend
    "67000": 0.96,  # Other — overspend
    "68000": 0.95,  # Staff T&E — overspend
}


def forecast_sql_case(col: str = "account_code") -> str:
    whens = " ".join(f"WHEN '{k}' THEN {v}" for k, v in OPEX_FORECAST_FACTORS.items())
    return f"CASE {col} {whens} ELSE 1.0 END"


def opex_account_list_sql() -> str:
    return ", ".join(f"'{c}'" for c in OPEX_FORECAST_FACTORS)
