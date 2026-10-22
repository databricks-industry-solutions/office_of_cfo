WITH roi AS (
  SELECT `Market` AS market,
         MEASURE(`Revenue per Mtok`) AS revenue_per_mtok,
         MEASURE(`Fully Loaded Cost per Mtok`) AS fully_loaded_cost_per_mtok
  FROM office_of_cfo.consumer_serving.mv_ai_roi
  GROUP BY ALL
)
SELECT roi.market,
       ROUND(roi.revenue_per_mtok, 2) AS revenue_per_mtok_usd,
       ROUND(roi.fully_loaded_cost_per_mtok, 2) AS fully_loaded_cost_per_mtok_usd
FROM roi
ORDER BY revenue_per_mtok DESC
