WITH roi AS (
  SELECT `Business Unit` AS business_unit,
         MEASURE(`Net Value`) AS net_value,
         MEASURE(`Fully Loaded Cost`) AS fully_loaded_cost
  FROM office_of_cfo.consumer_serving.mv_ai_roi
  GROUP BY ALL
)
SELECT roi.business_unit,
       ROUND(roi.net_value, 2) AS net_value_usd,
       ROUND(roi.fully_loaded_cost, 2) AS fully_loaded_cost_usd
FROM roi
ORDER BY net_value ASC
