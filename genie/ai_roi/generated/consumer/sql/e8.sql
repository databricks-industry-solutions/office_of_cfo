WITH roi AS (
  SELECT `Model` AS model,
         MEASURE(`Fully Loaded Cost per Mtok`) AS fully_loaded_cost_per_mtok,
         MEASURE(`Token Cost per Mtok`) AS token_cost_per_mtok
  FROM office_of_cfo.consumer_serving.mv_ai_roi
  GROUP BY ALL
)
SELECT roi.model,
       ROUND(roi.fully_loaded_cost_per_mtok, 2) AS fully_loaded_cost_per_mtok_usd,
       ROUND(roi.token_cost_per_mtok, 2) AS token_cost_per_mtok_usd
FROM roi
ORDER BY fully_loaded_cost_per_mtok ASC
