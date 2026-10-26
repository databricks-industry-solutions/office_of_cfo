"""Seed the multi-industry catalog by COPYING the baseline (never mutating it).

For each industry in industry_profiles.INDUSTRIES this script:
  1. Creates schemas  {catalog}.{industry}_{raw,close,serving,ops}
  2. DEEP CLONEs every managed table from baseline raw/close into them
  3. Snapshots the ops DQ materialized views into plain tables
  4. Applies the industry's cosmetic relabels ON THE COPY (org names, source
     systems, business lines, COA labels, counterparty names)
  5. Builds the additive {industry}_close.headline_kpis table + serving view
  6. Rebuilds the serving views, metric view, close-support views and the
     ZeroOps insights table, all repointed at the industry's own schemas
  7. Builds the additive Market-Insights tables {industry}_serving.{fact_market_drivers,
     driver_sensitivities} — synthetic driver series + a LassoCV-fitted driver ranking.

The baseline schemas are only ever read. Idempotent: safe to re-run.

Run:  uv run --with databricks-sdk --with pyyaml --with numpy --with scikit-learn \
          python data_generation/seed_industries.py
      (optionally: ... seed_industries.py energy   to seed a single industry)
      (numpy + scikit-learn are needed only for step 7, the market-driver fit.)
"""
from __future__ import annotations

import argparse
import hashlib
import math
import random
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import (  # noqa: E402
    BASELINE, CATALOG, CLOSE_PERIOD, HISTORY_MONTHS, industry_schemas, render_sql,
    require_warehouse, workspace_client,
)
from ai_roi_semantic import AI_ROI_END_PERIOD, seed_ai_roi  # noqa: E402
from industry_profiles import INDUSTRIES, profile  # noqa: E402
from kpi_history_shape import shape_days_series  # noqa: E402
from opex_forecast_shape import forecast_sql_case, opex_account_list_sql  # noqa: E402


def _period_seq(end_period: str, n: int) -> list[str]:
    """The n trailing YYYY-MM strings ending at end_period (inclusive)."""
    y, m = int(end_period[:4]), int(end_period[5:7])
    out = []
    for _ in range(n):
        out.append(f"{y:04d}-{m:02d}")
        m -= 1
        if m == 0:
            m, y = 12, y - 1
    return list(reversed(out))


def _kpi_trajectory(anchor: float, key: str, periods: list[str]) -> list[float]:
    """Deterministic per-KPI value trajectory anchored so the LAST period equals
    the profile's headline value (keeping the Executive tiles unchanged). Older
    months trend gently below with a seasonal ripple, seeded by the KPI key so it
    is stable across re-seeds and independent per KPI/segment."""
    rnd = random.Random(int(hashlib.md5(key.encode()).hexdigest(), 16) % (2 ** 32))
    growth = rnd.uniform(0.004, 0.018)
    amp = rnd.uniform(0.01, 0.05)
    phase = rnd.uniform(0.0, 2 * math.pi)
    n = len(periods)
    out = []
    for i, p in enumerate(periods):
        k = n - 1 - i                       # 0 at the active close
        month = int(p[5:7])
        f = ((1 + growth) ** (-k)) * (1 + amp * math.sin((month / 12.0) * 2 * math.pi + phase))
        out.append(anchor * f)
    out[-1] = anchor                        # pin the active close exactly
    return out

REPO_ROOT = Path(__file__).resolve().parents[1]

# --- Market-Insights driver generation ------------------------------------
# Months of synthetic driver history to generate (independent of HISTORY_MONTHS;
# a longer window gives the LassoCV a robust fit and nicer time-series charts).
DRIVER_MONTHS = 36
MAX_LAG = 3          # months a driver may lead the target (lag search 0..MAX_LAG)
# A driver is a selected "key driver" only if it (a) correlates with the target on
# its own (>= CORR_MIN) AND (b) contributes uniquely in the Lasso (|beta| > BETA_EPS).
# Decoys fail (a); redundant/collinear drivers fail (b).
CORR_MIN = 0.12
BETA_EPS = 0.005
# Cosmetic display level/volatility per driver unit, so generated series LOOK
# real (gas ~95 p/therm, PMI ~100 index, ...). Fit/sensitivity use standardized
# latents, so these levels are presentation-only. Fallback = (100, 12).
_DRIVER_DISPLAY = {
    "HDD": (180.0, 60.0),
    "$/MWh": (65.0, 18.0), "$/MMBtu": (3.5, 1.0), "$/t": (75.0, 20.0),
    "rate": (1.16, 0.05), "%": (3.0, 1.2), "index": (100.0, 8.0),
    "€m": (300.0, 40.0), "€bn": (640.0, 30.0), "$bn": (3.0, 0.3),
    "FTE": (5200.0, 300.0), "bps": (60.0, 40.0),
}

# ops DQ objects that are materialized views in the baseline -> snapshot as tables.
OPS_SNAPSHOTS = ["dq_results", "dq_summary", "recon_breaks"]

w = workspace_client()


def run(stmt: str):
    resp = w.statement_execution.execute_statement(
        statement=stmt, warehouse_id=require_warehouse(), wait_timeout="50s")
    # some statements (large views) may need polling
    import time
    sid = resp.statement_id
    while resp.status and resp.status.state and resp.status.state.value in ("PENDING", "RUNNING"):
        time.sleep(1.0)
        resp = w.statement_execution.get_statement(sid)
    state = resp.status.state.value if resp.status and resp.status.state else "UNKNOWN"
    if state != "SUCCEEDED":
        err = resp.status.error.message if resp.status and resp.status.error else state
        raise RuntimeError(f"FAILED ({state}): {err}\n  -- {stmt[:160]}")
    return resp


def query(stmt: str) -> list[list]:
    resp = run(stmt)
    return resp.result.data_array if resp.result and resp.result.data_array else []


def schemas(industry: str) -> dict[str, str]:
    return industry_schemas(industry)


def _objects(schema_fq: str, types: tuple[str, ...]) -> list[str]:
    cat, sch = schema_fq.split(".")
    type_list = ", ".join(f"'{t}'" for t in types)
    rows = query(
        f"SELECT table_name FROM {cat}.information_schema.tables "
        f"WHERE table_schema = '{sch}' AND table_type IN ({type_list}) "
        f"AND table_name NOT LIKE '__materialization%' "
        f"AND table_name NOT LIKE 'event_log%' "
        # competitor_search_* are app-managed runtime objects (their own isolated
        # tables + a serving VIEW). Never clone them: CTAS'ing the view into a
        # plain TABLE breaks the app's CREATE OR REPLACE VIEW, and the app creates
        # + owns these per-industry on demand anyway.
        f"AND table_name NOT LIKE 'competitor_search%' "
        f"AND table_name NOT LIKE '_sqldf%' ORDER BY table_name")
    return [r[0] for r in rows]


def base_tables(schema_fq: str) -> list[str]:
    """Managed/base tables only (safe to DEEP CLONE)."""
    return _objects(schema_fq, ("MANAGED", "EXTERNAL", "BASE TABLE"))


def all_data_objects(schema_fq: str) -> list[str]:
    """Every readable object (tables + materialized/streaming/plain views) — CTAS-able."""
    return _objects(schema_fq, ("MANAGED", "EXTERNAL", "BASE TABLE",
                                "MATERIALIZED_VIEW", "STREAMING_TABLE", "VIEW"))


def columns(table_fq: str) -> set[str]:
    cat, sch, tbl = table_fq.split(".")
    rows = query(
        f"SELECT column_name FROM {cat}.information_schema.columns "
        f"WHERE table_schema = '{sch}' AND table_name = '{tbl}'")
    return {r[0] for r in rows}


def sql_str(v: str) -> str:
    return "'" + v.replace("'", "''") + "'"


def ensure_schemas(dst: dict[str, str]):
    for fq in dst.values():
        run(f"CREATE SCHEMA IF NOT EXISTS {fq}")


def clone_schema(src_fq: str, dst_fq: str):
    """DEEP CLONE managed tables (used for the raw layer)."""
    tables = base_tables(src_fq)
    for t in tables:
        run(f"CREATE OR REPLACE TABLE {dst_fq}.{t} DEEP CLONE {src_fq}.{t}")
    print(f"    deep-cloned {len(tables)} tables -> {dst_fq}")


def ctas_schema(src_fq: str, dst_fq: str):
    """Snapshot every object (incl. materialized/streaming views) into plain tables.
    Used for the close layer, whose core objects are Lakeflow materialized views."""
    objs = all_data_objects(src_fq)
    for t in objs:
        run(f"CREATE OR REPLACE TABLE {dst_fq}.{t} AS SELECT * FROM {src_fq}.{t}")
    print(f"    materialized {len(objs)} objects -> {dst_fq}")


def snapshot_ops(dst: dict[str, str]):
    # zeroops_insights is a managed table -> clone; the DQ objects are MVs -> CTAS snapshot
    run(f"CREATE OR REPLACE TABLE {dst['ops']}.zeroops_insights DEEP CLONE {BASELINE['ops']}.zeroops_insights")
    for t in OPS_SNAPSHOTS:
        run(f"CREATE OR REPLACE TABLE {dst['ops']}.{t} AS SELECT * FROM {BASELINE['ops']}.{t}")
    print(f"    ops snapshot: zeroops_insights + {', '.join(OPS_SNAPSHOTS)}")


def _case(col: str, mapping: dict[str, str]) -> str:
    whens = " ".join(f"WHEN {sql_str(k)} THEN {sql_str(v)}" for k, v in mapping.items())
    return f"CASE {col} {whens} ELSE {col} END"


def apply_relabels(industry: str, dst: dict[str, str]):
    p = profile(industry)
    close = dst["close"]
    raw = dst["raw"]

    # 1. dim_org display names (both close + raw copies, keep BU/region/LE ids stable)
    for sch in (close, raw):
        for bu_id, (name, le_name, src_sys, country) in p.get("bu", {}).items():
            run(f"UPDATE {sch}.dim_org SET business_unit_name = {sql_str(name)}, "
                f"legal_entity_name = {sql_str(le_name)}, primary_source_system = {sql_str(src_sys)}, "
                f"country = {sql_str(country)} WHERE business_unit_id = {sql_str(bu_id)}")
        # dim_business_unit mirror (close has it)
        if "dim_business_unit" in base_tables(sch):
            cols = columns(f"{sch}.dim_business_unit")
            for bu_id, (name, le_name, src_sys, country) in p.get("bu", {}).items():
                sets = []
                if "business_unit_name" in cols:
                    sets.append(f"business_unit_name = {sql_str(name)}")
                if sets:
                    run(f"UPDATE {sch}.dim_business_unit SET {', '.join(sets)} "
                        f"WHERE business_unit_id = {sql_str(bu_id)}")

    # 2. chart_of_accounts labels
    for sch in (close, raw):
        for code, name in p.get("coa", {}).items():
            run(f"UPDATE {sch}.chart_of_accounts SET account_name = {sql_str(name)} "
                f"WHERE account_code = {sql_str(code)}")

    # 3. source_system + business_line relabels on every close/raw table that has them
    ss_map = p.get("source_system", {})
    bl_map = p.get("business_line", {})
    for sch in (close, raw):
        for t in base_tables(sch):
            cols = columns(f"{sch}.{t}")
            if ss_map and "source_system" in cols:
                run(f"UPDATE {sch}.{t} SET source_system = {_case('source_system', ss_map)}")
            if bl_map and "business_line" in cols:
                run(f"UPDATE {sch}.{t} SET business_line = {_case('business_line', bl_map)}")

    # 4. counterparty names (map generic Northwind names onto curated pools)
    _relabel_counterparties(close, "vendor_name",
                            ["subledger_ap", "subledger_procurement"], p.get("ap_counterparties", []))
    _relabel_counterparties(close, "customer_name",
                            ["subledger_ar", "subledger_sales_orders"], p.get("ar_counterparties", []))

    # 5. kpi_history denormalized scope labels (BU / legal_entity / business_line)
    kh = f"{close}.kpi_history"
    for bu_id, (name, *_rest) in p.get("bu", {}).items():
        run(f"UPDATE {kh} SET scope_label = {sql_str(name)} "
            f"WHERE scope_type = 'business_unit' AND scope_id = {sql_str(bu_id)}")
    for old, new in bl_map.items():
        run(f"UPDATE {kh} SET scope_label = {sql_str(new)}, scope_id = {sql_str(new)} "
            f"WHERE scope_type = 'business_line' AND scope_id = {sql_str(old)}")
    # legal entity labels keyed by scope_id (LE-*), read from dim_org copy
    le_rows = query(f"SELECT DISTINCT legal_entity_id, legal_entity_name FROM {close}.dim_org")
    for le_id, le_name in le_rows:
        run(f"UPDATE {kh} SET scope_label = {sql_str(le_name)} "
            f"WHERE scope_type = 'legal_entity' AND scope_id = {sql_str(le_id)}")
    print(f"    relabels applied for {industry}")


def _relabel_counterparties(close: str, col: str, tables: list[str], pool: list[str]):
    if not pool:
        return
    # distinct existing names across the given tables, ordered deterministically
    names: list[str] = []
    for t in tables:
        if col in columns(f"{close}.{t}"):
            names += [r[0] for r in query(f"SELECT DISTINCT {col} FROM {close}.{t} WHERE {col} IS NOT NULL")]
    names = sorted(set(names))
    if not names:
        return
    mapping = {old: pool[i % len(pool)] for i, old in enumerate(names)}
    case = _case(col, mapping)
    for t in tables:
        if col in columns(f"{close}.{t}"):
            run(f"UPDATE {close}.{t} SET {col} = {case}")


def reshape_kpi_history(industry: str, dst: dict[str, str]):
    """Rewrite historical DSO/DPO/DIO/CCC in {close}.kpi_history with a believable
    trajectory (see kpi_history_shape). Each scope is anchored on its CLOSE_PERIOD
    row, which is never modified; revenue/opex/net_income are untouched.
    Idempotent: the shape depends only on the anchor and the scope key."""
    close = dst["close"]
    kh = f"{close}.kpi_history"
    rows = query(f"SELECT period, scope_type, scope_id, dso, dpo, dio FROM {kh} "
                 f"WHERE period <= {sql_str(CLOSE_PERIOD)}")
    by_scope: dict[tuple[str, str], dict[str, dict[str, float]]] = {}
    for period, st, sid, dso, dpo, dio in rows:
        by_scope.setdefault((st, sid), {})[period] = {
            "dso": float(dso or 0), "dpo": float(dpo or 0), "dio": float(dio or 0)}
    values = []
    for (st, sid), per in by_scope.items():
        anchor = per.get(CLOSE_PERIOD)
        if anchor is None:
            continue
        periods = sorted(per)
        for r in shape_days_series(anchor, periods, f"{industry}:{st}:{sid}")[:-1]:
            values.append(f"({sql_str(r['period'])}, {sql_str(st)}, {sql_str(sid)}, "
                          f"{r['dso']}, {r['dpo']}, {r['dio']}, {r['ccc']})")
    stage = f"{close}._kpi_history_shape_stage"
    run(f"CREATE OR REPLACE TABLE {stage} (period STRING, scope_type STRING, scope_id STRING, "
        f"dso DOUBLE, dpo DOUBLE, dio DOUBLE, ccc DOUBLE)")
    for i in range(0, len(values), 200):
        run(f"INSERT INTO {stage} VALUES {', '.join(values[i:i + 200])}")
    run(f"MERGE INTO {kh} t USING {stage} s "
        f"ON t.period = s.period AND t.scope_type = s.scope_type AND t.scope_id = s.scope_id "
        f"WHEN MATCHED THEN UPDATE SET t.dso = s.dso, t.dpo = s.dpo, t.dio = s.dio, t.ccc = s.ccc")
    run(f"DROP TABLE IF EXISTS {stage}")
    print(f"    kpi_history reshaped: {len(by_scope)} scopes, {len(values)} historical rows")


def reshape_opex_forecast(industry: str, dst: dict[str, str]):
    """Set opex forecast_amount = actual * per-account factor so the FP&A
    budget-variance strip mixes overspend and underspend. Serving view
    opex_variance is live off close.budget_forecast, so no view rebuild."""
    close, serving = dst["close"], dst["serving"]
    codes = opex_account_list_sql()
    factor = forecast_sql_case("s.account_code")
    run(
        f"MERGE INTO {close}.budget_forecast t USING ("
        f"  SELECT period, account_code, business_unit_id, SUM(balance) AS actual_amount"
        f"  FROM {serving}.account_balance_by_bu"
        f"  WHERE account_code IN ({codes})"
        f"  GROUP BY period, account_code, business_unit_id"
        f") s ON t.period = s.period AND t.account_code = s.account_code"
        f" AND t.business_unit_id = s.business_unit_id"
        f" WHEN MATCHED THEN UPDATE SET forecast_amount = ROUND(s.actual_amount * ({factor}), 2)"
    )
    print(f"    opex forecast reshaped for {industry}")


def build_headline_kpis(industry: str, dst: dict[str, str]):
    """Historized headline tiles: one row per (period, kpi_id[, segment]) across
    the trailing HISTORY_MONTHS. The ACTIVE close keeps the profile's exact value
    and delta (so the Executive tiles are unchanged); historical periods carry a
    deterministic trajectory with a month-over-month delta, powering the trend +
    'above/below normal' visuals in the Historical Insights tab."""
    p = profile(industry)
    rows = p["headline_kpis"]
    close = dst["close"]
    periods = _period_seq(CLOSE_PERIOD, HISTORY_MONTHS)
    run(f"""CREATE OR REPLACE TABLE {close}.headline_kpis (
      period STRING, kpi_id STRING, label STRING, value DOUBLE, unit STRING,
      good_direction STRING, delta DOUBLE, segment STRING, sort_order INT)""")
    values = []
    for k in rows:
        seg = "NULL" if k["segment"] is None else sql_str(k["segment"])
        key = f"{industry}:{k['kpi_id']}:{k.get('segment') or ''}"
        series = _kpi_trajectory(float(k["value"]), key, periods)
        for i, per in enumerate(periods):
            val = series[i]
            if per == CLOSE_PERIOD:
                # active close: keep the profile's value + its (YoY-style) delta.
                val = float(k["value"])
                dl = "NULL" if k["delta"] is None else str(k["delta"])
            else:
                dl = str(round(val - series[i - 1], 4)) if i > 0 else "NULL"
            values.append(
                f"({sql_str(per)}, {sql_str(k['kpi_id'])}, {sql_str(k['label'])}, "
                f"{round(val, 4)}, {sql_str(k['unit'])}, {sql_str(k['good_direction'])}, "
                f"{dl}, {seg}, {k['sort_order']})")
    # chunk the INSERT so a 24-month x N-tile payload stays well under statement limits
    for i in range(0, len(values), 200):
        run(f"INSERT INTO {close}.headline_kpis VALUES {', '.join(values[i:i + 200])}")
    run(f"CREATE OR REPLACE VIEW {dst['serving']}.headline_kpis AS "
        f"SELECT period, kpi_id, label, value, unit, good_direction, delta, segment, sort_order "
        f"FROM {close}.headline_kpis ORDER BY sort_order")
    print(f"    headline_kpis: {len(rows)} tiles x {len(periods)} periods = {len(values)} rows")


def build_market_drivers(industry: str, dst: dict[str, str]):
    """Market-Insights driver panel (two serving tables), the FP&A 'discover the
    drivers before you model a scenario' surface:

      * ``fact_market_drivers``   -- monthly series for each candidate driver PLUS
                                     the forecast target (is_target=true).
      * ``driver_sensitivities``  -- one row per driver: the LassoCV-fitted
                                     sensitivity, best lead/lag, correlation,
                                     model R2, selected flag and rank.

    The target is built FROM the signal drivers (target = sum(beta_i * driver_i at
    its lag) + noise), so the LassoCV genuinely RE-DISCOVERS the profile betas and
    DROPS the decoys (is_signal=False) -- a real data-driven ranking, not hardcoded
    bars. Deterministic (seeded per industry) => idempotent across re-seeds."""
    import numpy as np
    try:
        from sklearn.linear_model import LassoCV
    except ImportError as e:  # noqa: BLE001
        raise RuntimeError(
            "build_market_drivers needs scikit-learn + numpy — re-run with "
            "`uv run --with databricks-sdk --with pyyaml --with numpy "
            "--with scikit-learn python data_generation/seed_industries.py`") from e

    p = profile(industry)
    tgt = p["market_target"]
    drivers = p["market_drivers"]
    serving = dst["serving"]
    n = DRIVER_MONTHS
    periods = _period_seq(CLOSE_PERIOD, n)
    months = np.array([int(pp[5:7]) for pp in periods])
    seed0 = int(hashlib.md5(f"mkt:{industry}".encode()).hexdigest(), 16) % (2 ** 32)

    nd = len(drivers)

    def _shift(z, lag):
        """Driver LEADS the target by `lag` months (front-padded with the mean=0)."""
        if lag <= 0:
            return z
        out = np.zeros_like(z)
        out[lag:] = z[:-lag]
        return out

    def _lead(z, lag):
        """z advanced by `lag` (end-padded). Identity: _shift(a, L) . b == a . _lead(b, L),
        so orthogonalizing a driver vs _lead(target, L) zeroes its lag-L correlation."""
        if lag <= 0:
            return z
        out = np.zeros_like(z)
        out[:n - lag] = z[lag:]
        return out

    def _std(z):
        return (z - z.mean()) / (z.std() + 1e-9)

    # 1. deterministic standardized latent per driver: AR(1); SIGNAL drivers also get
    #    a spread-out seasonal component (shared annual structure) while decoys stay
    #    pure noise, so signals correlate with the target and decoys do not.
    latents: dict[str, "np.ndarray"] = {}
    for i, d in enumerate(drivers):
        rs = np.random.RandomState((seed0 + i * 7919) % (2 ** 32))
        e = rs.standard_normal(n)
        z = np.zeros(n)
        for t in range(1, n):
            z[t] = 0.55 * z[t - 1] + e[t]
        if d["is_signal"]:
            z = z + 0.30 * np.sin(2 * np.pi * months / 12.0 + i * (2 * np.pi / nd))
        latents[d["driver_id"]] = _std(z)

    # 2. build the target from the SIGNAL drivers at their lag, + noise, standardized
    ty = np.zeros(n)
    for d in drivers:
        if d["is_signal"]:
            ty += d["beta"] * _shift(latents[d["driver_id"]], d["lag_m"])
    rs_noise = np.random.RandomState((seed0 + 104729) % (2 ** 32))
    ty = _std(ty + 0.35 * (ty.std() + 1e-9) * rs_noise.standard_normal(n))

    # 2b. make decoys genuinely unrelated: Gram-Schmidt-orthogonalize each decoy
    #     against the target at EVERY candidate lag (via the target's lead-shifts),
    #     so its correlation is ~0 at all lags -> it fails the CORR_MIN gate below
    #     regardless of any finite-sample fluke.
    ortho_basis: list["np.ndarray"] = []
    for L in range(MAX_LAG + 1):
        b = _lead(ty, L)
        for u in ortho_basis:
            b = b - float(b @ u) * u
        nrm = float(np.linalg.norm(b))
        if nrm > 1e-9:
            ortho_basis.append(b / nrm)
    for d in drivers:
        if not d["is_signal"]:
            z = latents[d["driver_id"]]
            for u in ortho_basis:
                z = z - float(z @ u) * u
            latents[d["driver_id"]] = _std(z)

    # 3. re-DISCOVER best lag per driver (max |corr|), then LassoCV over those lags
    best_lag, best_corr, cols = {}, {}, []
    for d in drivers:
        z = latents[d["driver_id"]]
        bl, bc = 0, 0.0
        for L in range(MAX_LAG + 1):
            c = float(np.corrcoef(_shift(z, L), ty)[0, 1])
            if abs(c) > abs(bc):
                bl, bc = L, c
        best_lag[d["driver_id"]], best_corr[d["driver_id"]] = bl, bc
        cols.append(_shift(z, bl))
    X = np.column_stack(cols)
    model = LassoCV(cv=5, random_state=0, max_iter=200000).fit(X, ty)
    r2 = float(model.score(X, ty))

    # 4. sensitivities: standardized beta -> target-unit impact per +1 sigma driver move
    level = float(tgt.get("level", 1000.0))
    tgt_disp = level * (1 + 0.08 * ty)                 # display revenue-like series
    tgt_disp_std = float(tgt_disp.std())
    sens = []
    for i, d in enumerate(drivers):
        beta_est = float(model.coef_[i])
        corr = float(best_corr[d["driver_id"]])
        selected = abs(corr) >= CORR_MIN and abs(beta_est) > BETA_EPS
        sens.append({
            "driver_id": d["driver_id"], "label": d["label"], "category": d["category"],
            "unit": d["unit"], "beta_true": float(d["beta"]), "beta_est": beta_est,
            "lag_m": int(best_lag[d["driver_id"]]), "corr": corr,
            "selected": selected,
            # Only selected (real) drivers carry an impact; a dropped driver's raw
            # beta_est/corr stay visible as the EVIDENCE for dropping it, but its
            # impact is 0 so no decoy/redundant driver ever shows a spurious number.
            "impact_per_sigma": (beta_est * tgt_disp_std) if selected else 0.0,
        })
    ranked = sorted((s for s in sens if s["selected"]), key=lambda s: -abs(s["beta_est"]))
    rank_of = {s["driver_id"]: r + 1 for r, s in enumerate(ranked)}

    # 5. fact_market_drivers: each driver's display series + the target series
    run(f"""CREATE OR REPLACE TABLE {serving}.fact_market_drivers (
      period STRING, series_id STRING, label STRING, unit STRING, category STRING,
      value DOUBLE, is_target BOOLEAN)""")
    fvals = []
    for d in drivers:
        base, vol = _DRIVER_DISPLAY.get(d["unit"], (100.0, 12.0))
        z = latents[d["driver_id"]]
        for j, per in enumerate(periods):
            v = base + vol * float(z[j])
            if d["unit"] in ("$/MWh", "$/MMBtu", "$/t", "HDD", "FTE", "index", "€bn", "$bn"):
                v = max(v, 0.0)                         # positive-only display units
            fvals.append(f"({sql_str(per)}, {sql_str(d['driver_id'])}, {sql_str(d['label'])}, "
                         f"{sql_str(d['unit'])}, {sql_str(d['category'])}, {round(v, 4)}, FALSE)")
    for j, per in enumerate(periods):
        fvals.append(f"({sql_str(per)}, {sql_str(tgt['metric_id'])}, {sql_str(tgt['label'])}, "
                     f"{sql_str(tgt['unit'])}, 'target', {round(float(tgt_disp[j]), 4)}, TRUE)")
    for i in range(0, len(fvals), 200):
        run(f"INSERT INTO {serving}.fact_market_drivers VALUES {', '.join(fvals[i:i + 200])}")

    # 6. driver_sensitivities: the fitted driver-ID output
    run(f"""CREATE OR REPLACE TABLE {serving}.driver_sensitivities (
      driver_id STRING, label STRING, category STRING, unit STRING, target STRING,
      beta_true DOUBLE, beta_est DOUBLE, lag_m INT, corr DOUBLE, r2 DOUBLE,
      selected BOOLEAN, `rank` INT, impact_per_sigma DOUBLE)""")
    svals = []
    for s in sens:
        rk = rank_of.get(s["driver_id"])
        svals.append(
            f"({sql_str(s['driver_id'])}, {sql_str(s['label'])}, {sql_str(s['category'])}, "
            f"{sql_str(s['unit'])}, {sql_str(tgt['metric_id'])}, {round(s['beta_true'], 6)}, "
            f"{round(s['beta_est'], 6)}, {s['lag_m']}, {round(s['corr'], 6)}, {round(r2, 6)}, "
            f"{'TRUE' if s['selected'] else 'FALSE'}, {rk if rk is not None else 'NULL'}, "
            f"{round(s['impact_per_sigma'], 4)})")
    run(f"INSERT INTO {serving}.driver_sensitivities VALUES {', '.join(svals)}")
    n_sel = sum(1 for s in sens if s["selected"])
    print(f"    market_drivers: {len(drivers)} drivers x {n} months, LassoCV R2={r2:.3f}, "
          f"{n_sel} selected / {len(drivers) - n_sel} dropped (target={tgt['metric_id']})")

    # 7. market_events: curated 'current' signals for the feed. Impact is DERIVED
    #    from the fitted model (move_sigma * impact_per_sigma), so the feed reuses
    #    the sensitivities rather than inventing numbers. as_of = latest period.
    sens_by_id = {s["driver_id"]: s for s in sens}
    events = p.get("market_events", [])
    as_of = periods[-1]
    run(f"""CREATE OR REPLACE TABLE {serving}.market_events (
      event_id STRING, driver_id STRING, driver_label STRING, category STRING,
      headline STRING, source STRING, as_of STRING, move_sigma DOUBLE,
      impact DOUBLE, direction STRING, target STRING, target_unit STRING, lag_m INT)""")
    evals = []
    for i, ev in enumerate(events):
        s = sens_by_id.get(ev["driver_id"])
        # A curated event must map to a SELECTED driver — otherwise impact_per_sigma
        # is 0 and the card would render a misleading "+£0m / favourable". Skip loudly
        # so a re-seed that drops a borderline driver is caught, not shipped silently.
        if s is None or not s["selected"]:
            print(f"    WARN market_events: driver '{ev['driver_id']}' is not a selected "
                  f"driver — skipping its signal card (no fitted sensitivity)")
            continue
        impact = ev["move_sigma"] * s["impact_per_sigma"]
        # The fitted impact sign should match the hand-authored narrative
        # (move_sigma x the driver's intended beta). Warn if the fit contradicts it,
        # so a card never turns green on an adverse headline (or vice versa) unnoticed.
        authored = ev["move_sigma"] * s["beta_true"]
        if impact and authored and (impact > 0) != (authored > 0):
            print(f"    WARN market_events: fitted impact sign for '{ev['driver_id']}' "
                  f"contradicts the authored headline — review the event")
        direction = "favourable" if impact >= 0 else "adverse"
        evals.append(
            f"({sql_str(f'{industry}-evt-{i}')}, {sql_str(ev['driver_id'])}, "
            f"{sql_str(s['label'])}, {sql_str(s['category'])}, {sql_str(ev['headline'])}, "
            f"{sql_str(ev['source'])}, {sql_str(as_of)}, {round(ev['move_sigma'], 4)}, "
            f"{round(impact, 4)}, {sql_str(direction)}, {sql_str(tgt['metric_id'])}, "
            f"{sql_str(tgt['unit'])}, {s['lag_m']})")
    if evals:
        run(f"INSERT INTO {serving}.market_events VALUES {', '.join(evals)}")
    print(f"    market_events: {len(evals)} curated signals (as_of {as_of})")


def _split_statements(sql: str) -> list[str]:
    lines = [ln for ln in sql.splitlines() if not ln.strip().startswith("--")]
    return [s.strip() for s in "\n".join(lines).split(";") if s.strip()]


def build_views(industry: str, dst: dict[str, str]):
    files = [
        REPO_ROOT / "serving" / "serving_views.sql",
        REPO_ROOT / "close_support" / "serving_close_support.sql",
        REPO_ROOT / "governance" / "governance.sql",
    ]
    for f in files:
        if not f.exists():
            continue
        sql_text = render_sql(f.read_text(), dst)
        for stmt in _split_statements(sql_text):
            # skip COMMENT ON (cosmetic) failures gracefully
            try:
                run(stmt)
            except Exception as e:  # noqa: BLE001
                if stmt.upper().startswith("COMMENT ON"):
                    continue
                raise RuntimeError(f"{f.name}: {e}")
    print(f"    serving + ops views rebuilt from SQL for {industry}")


def seed(industry: str, with_ai_roi: bool = True):
    print(f"\n=== {industry} ({profile(industry)['label']}) ===")
    dst = schemas(industry)
    ensure_schemas(dst)
    ctas_schema(BASELINE["close"], dst["close"])   # close = mostly materialized views -> snapshot as tables
    clone_schema(BASELINE["raw"], dst["raw"])       # raw = managed tables -> deep clone
    snapshot_ops(dst)
    apply_relabels(industry, dst)
    reshape_kpi_history(industry, dst)
    build_views(industry, dst)          # serving views read the relabeled close
    reshape_opex_forecast(industry, dst)
    build_headline_kpis(industry, dst)
    # Market-Insights driver panel is additive + OPTIONAL: it needs numpy +
    # scikit-learn. If they are absent, SKIP it (never abort a full reseed) -- but
    # any error DURING the build still propagates, so real failures aren't hidden.
    import importlib.util
    have_deps = all(importlib.util.find_spec(m) for m in ("numpy", "sklearn"))
    if have_deps:
        build_market_drivers(industry, dst)
    else:
        print("    SKIP market_drivers: numpy/scikit-learn not installed "
              "(re-run with `--with numpy --with scikit-learn`)")
    if with_ai_roi:
        seed_ai_roi(industry, dst["serving"], AI_ROI_END_PERIOD, run)
    else:
        print("    SKIP ai_roi: omitted with --skip-ai-roi")
    # verify
    n = query(f"SELECT COUNT(*) FROM {dst['serving']}.trial_balance")[0][0]
    k = query(f"SELECT COUNT(*) FROM {dst['serving']}.headline_kpis")[0][0]
    if have_deps:
        m = query(f"SELECT COUNT(*) FROM {dst['serving']}.driver_sensitivities WHERE selected")[0][0]
        print(f"    OK: trial_balance rows={n}, headline_kpis={k}, market drivers selected={m}")
    else:
        print(f"    OK: trial_balance rows={n}, headline_kpis={k} (market drivers skipped)")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("industries", nargs="*", choices=INDUSTRIES)
    parser.add_argument(
        "--skip-ai-roi", action="store_true",
        help="omit the AI ROI semantic contract",
    )
    parser.add_argument(
        "--ai-roi-only", action="store_true",
        help="rebuild only the AI ROI serving contract (skip clone/relabel)",
    )
    parser.add_argument(
        "--kpi-history-only", action="store_true",
        help="reshape only the kpi_history DSO/DPO/DIO/CCC trajectory (skip clone/relabel)",
    )
    parser.add_argument(
        "--opex-forecast-only", action="store_true",
        help="reshape only opex budget_forecast vs actual (skip clone/relabel)",
    )
    args = parser.parse_args()
    targets = args.industries or list(INDUSTRIES)
    print(f"Seeding {targets} into {CATALOG} (source baseline_*, profile from environment)")
    for ind in targets:
        if args.ai_roi_only:
            print(f"\n=== {ind} AI ROI only ===")
            seed_ai_roi(ind, schemas(ind)["serving"], AI_ROI_END_PERIOD, run)
        elif args.kpi_history_only:
            print(f"\n=== {ind} kpi_history only ===")
            reshape_kpi_history(ind, schemas(ind))
        elif args.opex_forecast_only:
            print(f"\n=== {ind} opex forecast only ===")
            reshape_opex_forecast(ind, schemas(ind))
        else:
            seed(ind, with_ai_roi=not args.skip_ai_roi)
    print("\nAll done.")


if __name__ == "__main__":
    main()
