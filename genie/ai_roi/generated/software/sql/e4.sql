WITH roi AS (
  SELECT `Use Case` AS use_case,
         MEASURE(`Realised Value All`) AS realised_value_all,
         MEASURE(`Fully Loaded Cost`) AS fully_loaded_cost,
         MEASURE(`Profitability Index`) AS profitability_index
  FROM office_of_cfo.software_serving.mv_ai_roi
  GROUP BY ALL
)
SELECT roi.use_case,
       ROUND(roi.realised_value_all, 2) AS realised_value_all_usd,
       ROUND(roi.fully_loaded_cost, 2) AS fully_loaded_cost_usd,
       ROUND(roi.profitability_index, 3) AS profitability_index,
       ROUND(ABS(roi.profitability_index - 1), 3) AS distance_from_break_even
FROM roi
ORDER BY distance_from_break_even ASC
LIMIT 10
