-- 0r-rollback.sql
-- BUG-SAMPLEPRODUCTBLEND-001 — restore resolve_harvest_weight v5 (no category-error guard).
--
-- This is the VERBATIM v5 definition, captured from live prod with pg_get_functiondef BEFORE 0a was
-- applied, not reconstructed from memory or from the migration that first created it. Applying it
-- returns the resolver to the exact behaviour that priced a Green Magic crown at 42.55 g.
--
-- Signature is unchanged in both directions, so this is a plain CREATE OR REPLACE and cannot leave a
-- second overload behind. No table, column or row is touched by either direction.
--
-- NOTE: this does NOT undo anything downstream. Harvest rows saved while 0a was live keep the weights
-- they were given; the guard only ever changed what the NEXT save resolved.

CREATE OR REPLACE FUNCTION public.resolve_harvest_weight(p_plant_id uuid, p_unit text, p_qty numeric, p_user_grams numeric DEFAULT NULL::numeric)
 RETURNS TABLE(weight_grams numeric, weight_estimated boolean, weight_basis text)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT
    CASE
      WHEN p_user_grams IS NOT NULL THEN p_user_grams
      WHEN p_unit IN ('g','kg','lb','oz') THEN p_qty * CASE p_unit
             WHEN 'g'  THEN 1
             WHEN 'kg' THEN 1000
             WHEN 'lb' THEN 453.592
             WHEN 'oz' THEN 28.3495
           END
      ELSE p_qty * f.factor
    END AS weight_grams,
    CASE
      WHEN p_user_grams IS NOT NULL       THEN false
      WHEN p_unit IN ('g','kg','lb','oz') THEN false
      WHEN f.factor IS NOT NULL           THEN true
      ELSE NULL
    END AS weight_estimated,
    CASE
      WHEN p_user_grams IS NOT NULL       THEN 'measured'
      WHEN p_unit IN ('g','kg','lb','oz') THEN 'measured'
      ELSE f.basis
    END AS weight_basis
  FROM (SELECT 1) AS anchor
  LEFT JOIN public.plants pl              ON pl.id   = p_plant_id       AND pl.deleted_at IS NULL
  LEFT JOIN public.plant_varieties v      ON v.id    = pl.variety_id    AND v.deleted_at IS NULL
  LEFT JOIN public.crop_types ct          ON ct.slug = v.crop_type_slug AND ct.deleted_at IS NULL
  -- one row per (cultivar_id, unit) by GROUP BY, so this LEFT JOIN cannot multiply the anchor row
  LEFT JOIN public.cultivar_weight_derived d ON d.cultivar_id = v.id AND d.unit = p_unit
  -- The promotion predicate, evaluated ONCE. v5 changes ONE input: the accumulation escape hatch
  -- counts INDEPENDENT observations, not rows, so N duplicates of one weighing can no longer buy
  -- promotion. COALESCE(...,false) so the no-derived-row case is a plain false rather than a NULL
  -- that has to be re-guarded below.
  CROSS JOIN LATERAL (
    SELECT COALESCE(d.confidence IN ('high','medium') OR d.independent_n >= 5, false) AS corroborated
  ) c
  -- THE TIER, RESOLVED ONCE. Factor and basis are two projections of one decision, so basis cannot
  -- label a number it did not source. First match wins. Unchanged from v4.
  CROSS JOIN LATERAL (
    SELECT CASE
      -- tier 3: corroborated samples
      WHEN c.corroborated AND d.grams_per_unit IS NOT NULL          THEN 3
      -- tier 4: curated variety reference
      WHEN (v.unit_weights ->> p_unit) IS NOT NULL                  THEN 4
      -- tier 5: provisional samples — demoted below the reference, still above the crop average
      WHEN d.grams_per_unit IS NOT NULL                             THEN 5
      -- tier 6: crop reference, gated on variety_grams_required
      WHEN NOT COALESCE(ct.variety_grams_required, true)
           AND (ct.unit_weights ->> p_unit) IS NOT NULL             THEN 6
    END AS tier
  ) t
  CROSS JOIN LATERAL (
    SELECT
      CASE t.tier
        WHEN 3 THEN d.grams_per_unit
        WHEN 4 THEN (v.unit_weights ->> p_unit)::numeric
        WHEN 5 THEN d.grams_per_unit
        WHEN 6 THEN (ct.unit_weights ->> p_unit)::numeric
      END AS factor,
      CASE t.tier
        WHEN 3 THEN 'cultivar_sample'   -- sample-backed, corroborated
        WHEN 4 THEN 'cultivar'          -- catalogue-backed (curated reference)
        WHEN 5 THEN 'cultivar_sample'   -- sample-backed, provisional
        WHEN 6 THEN 'crop_type'
      END AS basis
  ) f
$function$;

DELETE FROM public.schema_version WHERE version = '4.63.1-sampleblendguard-001';
