WITH monthly AS (
  SELECT `Month` AS month,
         MEASURE(`Total Tokens`) AS tokens,
         MEASURE(`Token Run Cost`) AS run_cost,
         MEASURE(`Fully Loaded Cost`) AS fully_loaded_cost,
         MEASURE(`Realised Value All`) AS realised_value_all
  FROM office_of_cfo.software_serving.mv_ai_roi
  GROUP BY ALL
)
SELECT month,
       ROUND(realised_value_all / NULLIF(tokens / 1000000.0, 0), 2) AS revenue_per_mtok_usd,
       ROUND(fully_loaded_cost / NULLIF(tokens / 1000000.0, 0), 2) AS fully_loaded_cost_per_mtok_usd,
       ROUND(run_cost / NULLIF(tokens / 1000000.0, 0), 2) AS run_cost_per_mtok_usd,
       ROUND(realised_value_all / NULLIF(fully_loaded_cost, 0), 3) AS profitability_index
FROM monthly
ORDER BY month
