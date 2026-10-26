"""Refresh the shared, privacy-safe AI Gateway daily aggregate.

No requester identifier, prompt, response, or request ID is persisted;
requester identity is used only inside COUNT(DISTINCT).

Task parameters (the bundle job passes them; env vars are the fallback):
  --catalog  CATALOG       target catalog (env AI_ROI_CATALOG / CFO_CATALOG, default office_of_cfo)
  --grant-to ID[,ID...]    app service principal ids given read access (env CFO_APP_SP_IDS)
Env AI_GATEWAY_LOOKBACK_DAYS sets the days of history to aggregate (default 90).
"""
from __future__ import annotations

import argparse
import os

from pyspark.sql import SparkSession

_parser = argparse.ArgumentParser()
_parser.add_argument("--catalog", default=os.environ.get("AI_ROI_CATALOG")
                     or os.environ.get("CFO_CATALOG", "office_of_cfo"))
_parser.add_argument("--grant-to", default=os.environ.get("CFO_APP_SP_IDS", ""))
_args, _ = _parser.parse_known_args()

SOURCE = "system.ai_gateway.usage"
CATALOG = _args.catalog
TARGET = f"{CATALOG}.app_ops.ai_gateway_usage_daily"
LOOKBACK_DAYS = int(os.environ.get("AI_GATEWAY_LOOKBACK_DAYS", "90"))
# App service principals to grant read access; none -> no grants issued.
APP_SERVICE_PRINCIPALS = tuple(p.strip() for p in _args.grant_to.split(",") if p.strip())


def _pick(columns: set[str], logical_name: str, candidates: tuple[str, ...]) -> str:
    for candidate in candidates:
        if candidate in columns:
            return f"`{candidate}`"
    raise RuntimeError(
        f"{SOURCE} has no supported {logical_name} column; tried {candidates}"
    )


def refresh(spark: SparkSession) -> None:
    columns = set(spark.table(SOURCE).columns)
    event_time = _pick(columns, "event time", ("event_time", "request_time", "timestamp"))
    destination = _pick(
        columns, "destination",
        ("endpoint_name", "destination_name", "model_serving_endpoint_name", "model_name"),
    )
    requester = _pick(columns, "requester", ("requester", "requester_id", "user_id"))
    input_tokens = _pick(
        columns, "input tokens", ("input_token_count", "input_tokens", "prompt_tokens")
    )
    output_tokens = _pick(
        columns, "output tokens", ("output_token_count", "output_tokens", "completion_tokens")
    )
    status = _pick(
        columns, "status", ("status_code", "response_status_code", "http_status_code")
    )
    latency = _pick(
        columns, "latency", ("request_duration_ms", "latency_ms", "duration_ms")
    )
    spark.sql(f"CREATE SCHEMA IF NOT EXISTS {CATALOG}.app_ops")
    spark.sql(f"""
      CREATE OR REPLACE TABLE {TARGET}
      COMMENT 'Privacy-safe daily AI Gateway aggregate; contains no prompts, responses, request IDs, or requester identifiers.'
      AS
      SELECT
        CAST({event_time} AS DATE) AS usage_date,
        CAST({destination} AS STRING) AS destination_name,
        'model_serving' AS destination_type,
        COUNT(*) AS requests,
        SUM(COALESCE(CAST({input_tokens} AS BIGINT), 0)) AS input_tokens,
        SUM(COALESCE(CAST({output_tokens} AS BIGINT), 0)) AS output_tokens,
        SUM(CASE WHEN CAST({status} AS INT) >= 400 THEN 1 ELSE 0 END) AS failed_requests,
        COUNT(DISTINCT {requester}) AS requester_count,
        PERCENTILE_APPROX(CAST({latency} AS DOUBLE), 0.95) AS p95_latency_ms,
        CURRENT_TIMESTAMP() AS built_at
      FROM {SOURCE}
      WHERE CAST({event_time} AS DATE) >= DATE_SUB(CURRENT_DATE(), {LOOKBACK_DAYS})
      GROUP BY CAST({event_time} AS DATE), CAST({destination} AS STRING)
    """)
    if APP_SERVICE_PRINCIPALS:
        for principal in APP_SERVICE_PRINCIPALS:
            spark.sql(f"GRANT USE CATALOG ON CATALOG {CATALOG} TO `{principal}`")
            spark.sql(f"GRANT USE SCHEMA ON SCHEMA {CATALOG}.app_ops TO `{principal}`")
            spark.sql(f"GRANT SELECT ON TABLE {TARGET} TO `{principal}`")


if __name__ == "__main__":
    refresh(SparkSession.builder.getOrCreate())
