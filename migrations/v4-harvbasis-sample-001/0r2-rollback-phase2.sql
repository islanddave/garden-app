-- 0r2-rollback-phase2.sql
-- V4-HARVBASIS-SAMPLE-001 — roll back PHASE 2 ONLY. Restores resolve_harvest_weight to v3.
--
-- ROLL BACK IN REVERSE ORDER: 0r2 (this file) BEFORE 0r1. Running 0r1 first re-narrows the CHECK
-- while v4 is still installed and emitting 'cultivar_sample' -> 23514 on every harvest save through
-- tier 3 or 5. That is the same outage as the forward mis-ordering, arrived at from the other side.
--
-- SAFE TO STOP HERE, INDEFINITELY. After this file:
--   * new writes revert to 'cultivar' for tiers 3/4/5, exactly as before the feature;
--   * 'cultivar_sample' rows written while v4 was live REMAIN in harvest_log and are INERT — the
--     widened CHECK from 0a still admits them, chk_harvest_log_weight_basis_estimated holds
--     ('cultivar_sample' <> 'measured' -> weight_estimated stays true, unchanged),
--     chk_harvest_log_weight_basis_pairing holds (grams and basis both non-null, unchanged), and
--     no reader in the app branches on the value.
-- You do NOT need to run 0r1. Leaving the widened constraint in place is the lower-risk state; 0r1
-- exists only for a full revert to the pre-feature schema.
--
-- BODY BELOW IS BYTE-EXACT PROD v3 as captured 2026-08-04 from pg_get_functiondef, md5
-- 68ab340bae8eeff567514acde3a68571 (prod and staging were identical). Archived alongside the v2
-- asset at:
--   ~/AI/Claude/Projects/Gardening/directwritedrift-reversal-20260804/
--     resolve_harvest_weight-v3-prod-20260804.sql   <- this body
--     resolve_harvest_weight-v2-prod-20260804.sql   <- the previous generation
-- Do not "tidy" it. It is a restore artefact; drift here is how a rollback silently becomes a
-- fourth version. Note it re-introduces the latent factor/basis desync documented in 0b — harmless
-- under v3, because tiers 3 and 4 share the 'cultivar' label there.
--
-- SAFETY: function body only. No table, constraint or row is touched. Re-runnable.

\set ON_ERROR_STOP on

BEGIN;

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
  -- The promotion predicate, evaluated ONCE. COALESCE(...,false) so the no-derived-row case is a
  -- plain false rather than a NULL that has to be re-guarded at every use below.
  CROSS JOIN LATERAL (
    SELECT COALESCE(d.confidence IN ('high','medium') OR d.sample_n >= 5, false) AS corroborated
  ) c
  CROSS JOIN LATERAL (
    SELECT
      COALESCE(
        CASE WHEN c.corroborated THEN d.grams_per_unit END,       -- tier 3: corroborated samples
        (v.unit_weights ->> p_unit)::numeric,                     -- tier 4: curated variety ref
        d.grams_per_unit,                                         -- tier 5: provisional samples
        CASE WHEN NOT COALESCE(ct.variety_grams_required, true)   -- tier 6: crop reference, gated
             THEN (ct.unit_weights ->> p_unit)::numeric END
      ) AS factor,
      CASE
        WHEN c.corroborated                              THEN 'cultivar'
        WHEN (v.unit_weights ->> p_unit) IS NOT NULL     THEN 'cultivar'
        WHEN d.grams_per_unit IS NOT NULL                THEN 'cultivar'
        WHEN NOT COALESCE(ct.variety_grams_required, true)
             AND (ct.unit_weights ->> p_unit) IS NOT NULL THEN 'crop_type'
      END AS basis
  ) f
$function$;

COMMENT ON FUNCTION public.resolve_harvest_weight(uuid, text, numeric, numeric) IS
  'CAL-1 single weight-derivation locus (v3). Order: user grams > weight-unit quantity > '
  'cultivar_weight_derived WHEN corroborated (confidence high/medium, i.e. sample_n>=2, OR '
  'sample_n>=5) > plant_varieties.unit_weights (curated reference) > cultivar_weight_derived '
  'provisional (n=1, only where no curated reference exists) > crop_types.unit_weights (gated on '
  'variety_grams_required) > NULL. Returns (weight_grams, weight_estimated, weight_basis) together '
  'so the harvest_log weight CHECKs hold by construction. Basis vocabulary unchanged from v2.';

DELETE FROM public.schema_version WHERE version = '4.20.8-harvbasis-sample-001-resolver-v4';

COMMIT;
