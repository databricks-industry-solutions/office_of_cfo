"""Budget-variance factors must mix overspend and underspend."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from opex_forecast_shape import (  # noqa: E402
    OPEX_FORECAST_FACTORS,
    forecast_sql_case,
    opex_account_list_sql,
)


def test_factors_mix_over_and_under_spend():
    over = [c for c, f in OPEX_FORECAST_FACTORS.items() if f < 1]
    under = [c for c, f in OPEX_FORECAST_FACTORS.items() if f > 1]
    assert len(over) >= 3
    assert len(under) >= 3
    assert "60000" in over
    assert "63000" in under


def test_sql_helpers_cover_every_opex_account():
    case = forecast_sql_case("s.account_code")
    listed = opex_account_list_sql()
    for code in OPEX_FORECAST_FACTORS:
        assert f"'{code}'" in case
        assert f"'{code}'" in listed
