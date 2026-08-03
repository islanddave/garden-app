-- 0e-coverage.sql — read-only reporting. Run after 0d to see what the reference tier actually covers.
-- No writes; safe to run any time.

\echo '== reference-data coverage =='
SELECT 'crop_types'      AS tbl, count(*) AS live, count(unit_weights) AS seeded FROM public.crop_types      WHERE deleted_at IS NULL
UNION ALL
SELECT 'plant_varieties',       count(*),          count(unit_weights) FROM public.plant_varieties WHERE deleted_at IS NULL;

\echo '== seeded reference values by source/confidence =='
SELECT weight_source, weight_confidence, count(*) AS varieties
  FROM public.plant_varieties WHERE deleted_at IS NULL AND unit_weights IS NOT NULL
 GROUP BY 1,2 ORDER BY 1,2;

\echo '== harvest_log weight coverage =='
SELECT count(*) AS live_rows,
       count(weight_grams) FILTER (WHERE weight_estimated IS FALSE) AS measured,
       count(weight_grams) FILTER (WHERE weight_estimated IS TRUE)  AS estimated,
       count(*) FILTER (WHERE weight_grams IS NULL)                 AS no_estimate
  FROM public.harvest_log WHERE deleted_at IS NULL;

\echo '== rows still without any weight, and why =='
SELECT h.unit,
       CASE WHEN e.plant_id IS NULL THEN 'no plant_id on event'
            WHEN pl.variety_id IS NULL THEN 'planting has no variety'
            WHEN v.crop_type_slug IS NULL THEN 'variety has no crop_type'
            ELSE 'no unit_weights entry for this unit' END AS reason,
       count(*) AS rows
  FROM public.harvest_log h
  JOIN public.event_log e            ON e.id = h.event_id  AND e.deleted_at IS NULL
  LEFT JOIN public.plants pl         ON pl.id = e.plant_id AND pl.deleted_at IS NULL
  LEFT JOIN public.plant_varieties v ON v.id = pl.variety_id AND v.deleted_at IS NULL
 WHERE h.deleted_at IS NULL AND h.weight_grams IS NULL
 GROUP BY 1,2 ORDER BY 3 DESC;

\echo '== estimated season yield by crop (kg) =='
SELECT ct.display_name AS crop,
       round(sum(h.weight_grams)/1000.0, 2) AS kg,
       count(*) AS harvests,
       bool_or(h.weight_estimated) AS any_estimated
  FROM public.harvest_log h
  JOIN public.event_log e            ON e.id = h.event_id  AND e.deleted_at IS NULL
  JOIN public.plants pl              ON pl.id = e.plant_id AND pl.deleted_at IS NULL
  JOIN public.plant_varieties v      ON v.id = pl.variety_id AND v.deleted_at IS NULL
  JOIN public.crop_types ct          ON ct.slug = v.crop_type_slug
 WHERE h.deleted_at IS NULL AND h.weight_grams IS NOT NULL
 GROUP BY 1 ORDER BY 2 DESC;
