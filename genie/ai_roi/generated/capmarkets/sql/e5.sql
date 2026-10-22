SELECT ROUND(MEASURE(`Realised Value All`), 2) AS realised_value_all_usd,
       ROUND(MEASURE(`Realised Value Proven`), 2) AS realised_value_proven_usd,
       ROUND(MEASURE(`Fully Loaded Cost`), 2) AS fully_loaded_cost_usd,
       ROUND(MEASURE(`Realised Value All`) - MEASURE(`Fully Loaded Cost`), 2) AS net_value_usd,
       ROUND(MEASURE(`Profitability Index`), 3) AS profitability_index
FROM office_of_cfo.capmarkets_serving.mv_ai_roi
