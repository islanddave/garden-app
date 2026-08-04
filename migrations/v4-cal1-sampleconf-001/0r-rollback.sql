-- 0r-rollback.sql — V4-CAL1SAMPLECONF-001.
--
-- Restores resolve_harvest_weight v2 (v4-cal1-slicec-001/0a-resolver-v2.sql) byte-for-byte: the
-- flat COALESCE in which cultivar_weight_derived outranks the curated variety reference
-- unconditionally.
--
-- NO LAMBDA COORDINATION NEEDED, in either direction. v3 changed only the function BODY — same
-- signature, same three return columns, same weight_basis vocabulary ('measured'|'cultivar'|
-- 'crop_type'). Every deployed caller (the POST CTE and the PUT recompute in lambda/events/index.js)
-- works identically against v2 and v3, so this can be run at any time without touching the deploy.
-- That is the opposite of slicec-001's rollback, which had to revert the Lambda FIRST because it
-- changed the return type and armed CHECKs the old writer could not satisfy.
--
-- NOTHING IS DROPPED AND NO ROW IS TOUCHED. cultivar_weight_sample, cultivar_weight_void and the
-- cultivar_weight_derived view are untouched by both 0a and this file — Dave's measurements are
-- never at risk from either direction of this migration.
--
-- WHAT ROLLING BACK COSTS: the defect returns immediately. 16 of 18 derived groups are
-- sample_n=1/'provisional' and would again override the curated reference by -92%..+83% on every
-- new harvest, and the PUT edit path would again rewrite the stored weight of any older harvest on
-- those cultivars to the single-sample number on any unrelated edit. Roll back only if v3 itself
-- misbehaves, not to "restore sample priority" — v3 keeps sample priority wherever the samples are
-- corroborated.

BEGIN;

CREATE OR REPLACE FUNCTION public.resolve_harvest_weight(
  p_plant_id   uuid,
  p_unit       text,
  p_qty        numeric,
  p_user_grams numeric DEFAULT NULL::numeric
)
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
  CROSS JOIN LATERAL (
    SELECT
      COALESCE(
        d.grams_per_unit,                                            -- tier 3: real samples
        (v.unit_weights ->> p_unit)::numeric,                        -- tier 4: variety reference
        CASE WHEN NOT COALESCE(ct.variety_grams_required, true)      -- tier 5: crop reference, gated
             THEN (ct.unit_weights ->> p_unit)::numeric END
      ) AS factor,
      CASE
        WHEN d.grams_per_unit IS NOT NULL             THEN 'cultivar'
        WHEN (v.unit_weights ->> p_unit) IS NOT NULL  THEN 'cultivar'
        WHEN NOT COALESCE(ct.variety_grams_required, true)
             AND (ct.unit_weights ->> p_unit) IS NOT NULL THEN 'crop_type'
      END AS basis
  ) f
$function$;

COMMENT ON FUNCTION public.resolve_harvest_weight(uuid, text, numeric, numeric) IS
  'CAL-1 single weight-derivation locus (v2, restored by sampleconf-001 rollback). Order: user '
  'grams > weight-unit quantity > cultivar_weight_derived (any sample_n) > plant_varieties.'
  'unit_weights > crop_types.unit_weights (gated on variety_grams_required) > NULL.';

DELETE FROM public.schema_version WHERE version = '4.20.6-cal1-sampleconf-001';

COMMIT;
