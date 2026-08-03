-- 0e-coverage.sql — read-only. Run before AND after 0b to prove the reference-revert changed no
-- resolved weight, and after 0c to see the provenance split. No writes.

\echo '== weight provenance across live harvests =='
SELECT weight_basis, weight_estimated, count(*) AS rows, round(sum(weight_grams)/1000.0,2) AS kg
  FROM public.harvest_log WHERE deleted_at IS NULL
 GROUP BY 1,2 ORDER BY 3 DESC;

\echo '== real samples now backing a variety =='
SELECT v.name AS variety, d.unit, round(d.grams_per_unit,2) AS g_per_unit,
       d.sample_n, d.total_units, d.confidence, d.usable_for_comparison
  FROM public.cultivar_weight_derived d
  JOIN public.plant_varieties v ON v.id = d.cultivar_id
 ORDER BY v.name;

\echo '== resolved grams per measured variety (must not change across 0b) =='
SELECT v.name AS variety, round((r.weight_grams),3) AS grams_per_1, r.weight_basis
  FROM public.plant_varieties v
  JOIN public.plants pl ON pl.variety_id = v.id AND pl.deleted_at IS NULL
  CROSS JOIN LATERAL public.resolve_harvest_weight(pl.id, 'count', 1, NULL) r
 WHERE v.crop_type_slug = 'tomato' AND v.deleted_at IS NULL
   AND EXISTS (SELECT 1 FROM public.cultivar_weight_sample s WHERE s.cultivar_id = v.id)
 ORDER BY v.name;

\echo '== any row left without provenance (must be zero) =='
SELECT count(*) AS violations FROM public.harvest_log
 WHERE deleted_at IS NULL AND (weight_grams IS NULL) <> (weight_basis IS NULL);
