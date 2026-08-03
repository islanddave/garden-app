-- 0a-resolver-v2.sql
-- V4-HARVDUAL-001 Slice C — teach the single derivation locus about REAL measurements.
--
-- resolve_harvest_weight v1 (v4-cal1-harvweight-002) knew four tiers: user-supplied, weight-unit,
-- variety REFERENCE, crop REFERENCE. v2 inserts the tier the whole feature exists for — actual
-- weighings, pooled per (variety, unit) by cultivar_weight_derived — and starts returning the
-- weight_basis provenance that v4-cal1-pervariety-001 added to harvest_log.
--
-- RESOLUTION ORDER (v2):
--   1. p_user_grams              -> basis 'measured'   estimated false   the user weighed THIS pick
--   2. unit is g/kg/lb/oz        -> basis 'measured'   estimated false   the quantity IS the weight
--   3. cultivar_weight_derived   -> basis 'cultivar'   estimated true    real samples for this variety
--   4. plant_varieties.unit_weights -> basis 'cultivar' estimated true   catalog/USDA reference
--   5. crop_types.unit_weights   -> basis 'crop_type'  estimated true    ONLY if the crop permits it
--   6. nothing                   -> NULL / NULL / NULL                   no estimate, never guessed
--
-- TIER 3 OVER TIER 4 regardless of sample count. The view flags n=1 as confidence 'provisional' and
-- usable_for_comparison=false, but a single real weighing still beats a seed-catalog figure: Dave's
-- first eight samples landed 25% below catalog across the board (Cherry Falls 6.2 g measured vs 25 g
-- catalog). min-n governs whether a number may anchor a cross-season COMPARISON, which is a separate
-- question from which number is the best available estimate today.
--
-- TIER 5 IS NOW GATED on crop_types.variety_grams_required (pervariety-001's contract): for a
-- high-between-variety-variance crop — tomato, pepper, squash, tomatillo, cucumber, shallot — a
-- crop-level average is not a defensible stand-in for a missing variety number, so the answer is
-- NULL rather than a plausible-looking guess. Verified against live prod before applying: ZERO
-- existing rows resolve through that path, so the gate costs no coverage today and only prevents a
-- future bad estimate.
--
-- SIGNATURE CHANGE: v1 returned two columns, v2 returns three, so CREATE OR REPLACE cannot be used
-- (Postgres refuses a return-type change) — this is a DROP + CREATE. The Slice A Lambda that calls
-- the function is on dev and NOT promoted, so no deployed code references it during the swap; a
-- prod Lambda deploy must therefore happen AFTER this migration, never before (L-081, same as
-- harvweight-002).
--
-- SAFETY: function-only. No table, column, constraint or row touched here. Re-runnable.

DROP FUNCTION IF EXISTS public.resolve_harvest_weight(uuid, text, numeric, numeric);

CREATE FUNCTION public.resolve_harvest_weight(
  p_plant_id   uuid,
  p_unit       text,
  p_qty        numeric,
  p_user_grams numeric DEFAULT NULL
)
RETURNS TABLE (weight_grams numeric, weight_estimated boolean, weight_basis text)
LANGUAGE sql
STABLE
AS $$
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
$$;

COMMENT ON FUNCTION public.resolve_harvest_weight(uuid, text, numeric, numeric) IS
  'CAL-1 single derivation locus (v2). Resolution order: user-supplied grams > weight-unit harvest > '
  'cultivar_weight_derived (real samples) > plant_varieties.unit_weights (reference) > '
  'crop_types.unit_weights (reference, only when variety_grams_required is false) > NULL. Returns '
  'weight_grams/weight_estimated/weight_basis together so all three harvest_log CHECKs hold by '
  'construction. Called by the POST new_harvest CTE and the PUT recompute in lambda/events/index.js '
  'and by 0c-backfill — do not reimplement the expression at a call site.';

INSERT INTO public.schema_version (version, description)
VALUES ('4.20.0-cal1-slicec-001','V4-HARVDUAL-001 Slice C: resolve_harvest_weight v2 — adds the cultivar_weight_derived (real-sample) tier above the reference tiers, gates the crop-type tier on crop_types.variety_grams_required, and returns weight_basis (measured|cultivar|crop_type) as a third column so pervariety-001 three-way CHECKs hold by construction. DROP+CREATE (return type changed).')
ON CONFLICT (version) DO NOTHING;
