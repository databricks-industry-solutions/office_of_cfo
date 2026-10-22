WITH roi AS (
  SELECT `Business Unit` AS business_unit,
         MEASURE(`Realised Value All`) AS realised_value_all,
         MEASURE(`Fully Loaded Cost`) AS fully_loaded_cost,
         MEASURE(`Profitability Index`) AS profitability_index
  FROM office_of_cfo.energy_serving.mv_ai_roi
  GROUP BY ALL
)
SELECT roi.business_unit,
       ROUND(roi.realised_value_all, 2) AS realised_value_all_usd,
       ROUND(roi.fully_loaded_cost, 2) AS fully_loaded_cost_usd,
       ROUND(roi.profitability_index, 3) AS profitability_index,
       CASE WHEN roi.profitability_index < 1 THEN 'below break-even'
            ELSE 'at or above break-even' END AS break_even_status
FROM roi
ORDER BY profitability_index ASC
