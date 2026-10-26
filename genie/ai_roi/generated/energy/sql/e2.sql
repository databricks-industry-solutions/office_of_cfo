WITH roi AS (
  SELECT `Business Unit` AS business_unit,
         MEASURE(`Realised Value All`) AS realised_value_all,
         MEASURE(`Realised Value Proven`) AS realised_value_proven,
         MEASURE(`Fully Loaded Cost`) AS fully_loaded_cost
  FROM office_of_cfo.energy_serving.mv_ai_roi
  GROUP BY ALL
)
SELECT roi.business_unit,
       ROUND(roi.realised_value_all / NULLIF(roi.fully_loaded_cost, 0), 3) AS profitability_index_all,
       ROUND(roi.realised_value_proven / NULLIF(roi.fully_loaded_cost, 0), 3) AS profitability_index_proven,
       ROUND((roi.realised_value_all - roi.realised_value_proven)
             / NULLIF(roi.fully_loaded_cost, 0), 3) AS modelled_index_gap
FROM roi
ORDER BY profitability_index_all ASC
