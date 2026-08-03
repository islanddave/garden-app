-- 0a-function.sql
-- V4-CAL1-HARVWEIGHT-002 — ONE derivation locus for harvest weight, + user-supplied weight support.
--
-- WHY THIS EXISTS (two problems, one fix):
--
-- 1. DRIFT. The weight derivation is currently written TWICE in lambda/events/index.js — once in the
--    POST `new_harvest` CTE and once in the PUT recompute — as two hand-copied SQL expressions with a
--    comment asking them to stay identical. That is exactly the shape of BUG-HARVESTEDIT-001 (one
--    write path, then two, nothing keeping them in agreement). Slice A has to change the derivation,
--    which would mean editing both copies. Extracting it to a single SQL function kills the drift
--    class structurally instead of by comment.
--
-- 2. STALE TIER. Both copies resolve grams from `crop_types.grams_per_unit`, gated on
--    `ct.default_unit = unit`. That predates v4-cal1-refweight-001, which added the per-VARIETY
--    `unit_weights` override and the per-unit jsonb map. Consequence today, on live data: editing a
--    Super Sweet 100 harvest would silently overwrite its MEASURED 8 g/fruit with the tomato
--    crop-level 123 g/fruit — a ~15x corruption of a measured value, on an unrelated edit. Any
--    harvest logged in an off-modal unit (raspberries by count) resolves to NULL for the same reason.
--
-- RESOLUTION ORDER (the tier contract, now in one place):
--   1. p_user_grams          — the user put it on a scale. weight_estimated = false.
--   2. weight-unit harvest   — unit itself is g/kg/lb/oz. Exact. weight_estimated = false.
--   3. variety unit_weights  — plant_varieties.unit_weights ->> unit. weight_estimated = true.
--   4. crop unit_weights     — crop_types.unit_weights ->> unit.     weight_estimated = true.
--   5. NULL/NULL             — no factor for this unit anywhere. No estimate, never guessed.
--
-- Tiers 1-2 and 5 are unchanged in spirit from the original; tiers 3-4 are the upgrade. The function
-- returns BOTH columns together so chk_harvest_log_weight_pairing
-- ((weight_grams IS NULL) = (weight_estimated IS NULL)) holds by construction — a caller cannot set
-- one without the other, which is what made a half-update a hard 23514 before.
--
-- STABLE, not IMMUTABLE: it reads plants/plant_varieties/crop_types. Always returns exactly one row
-- (the LEFT JOIN chain hangs off a one-row anchor), so it is safe in a LATERAL without a
-- COALESCE guard on the caller side.
--
-- SAFETY: purely additive — CREATE OR REPLACE of a NEW function name, no table/column/constraint
-- touched, no data change. Re-runnable. Rollback is 0r (DROP FUNCTION), but note the Lambda must be
-- reverted first or its CTEs will fail to resolve the call.

CREATE OR REPLACE FUNCTION public.resolve_harvest_weight(
  p_plant_id   uuid,
  p_unit       text,
  p_qty        numeric,
  p_user_grams numeric DEFAULT NULL
)
RETURNS TABLE (weight_grams numeric, weight_estimated boolean)
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
      ELSE p_qty * COALESCE((v.unit_weights  ->> p_unit)::numeric,
                            (ct.unit_weights ->> p_unit)::numeric)
    END AS weight_grams,
    CASE
      WHEN p_user_grams IS NOT NULL              THEN false
      WHEN p_unit IN ('g','kg','lb','oz')        THEN false
      WHEN COALESCE((v.unit_weights  ->> p_unit)::numeric,
                    (ct.unit_weights ->> p_unit)::numeric) IS NOT NULL THEN true
      ELSE NULL
    END AS weight_estimated
  FROM (SELECT 1) AS anchor
  LEFT JOIN public.plants pl          ON pl.id   = p_plant_id        AND pl.deleted_at IS NULL
  LEFT JOIN public.plant_varieties v  ON v.id    = pl.variety_id     AND v.deleted_at IS NULL
  LEFT JOIN public.crop_types ct      ON ct.slug = v.crop_type_slug  AND ct.deleted_at IS NULL
$$;

COMMENT ON FUNCTION public.resolve_harvest_weight(uuid, text, numeric, numeric) IS
  'CAL-1 single derivation locus for harvest_log.weight_grams/weight_estimated. Resolution order: '
  'user-supplied grams > weight-unit harvest > plant_varieties.unit_weights > crop_types.unit_weights '
  '> NULL. Returns both columns together so chk_harvest_log_weight_pairing holds by construction. '
  'Called by the POST new_harvest CTE and the PUT recompute in lambda/events/index.js — do not '
  'reimplement the expression at a call site.';

INSERT INTO public.schema_version (version, description)
VALUES ('4.19.0-cal1-harvweight-002','CAL-1: public.resolve_harvest_weight(plant,unit,qty,user_grams) — one derivation locus for both harvest write paths, upgraded to the refweight-001 variety/crop unit_weights tiers and accepting a user-supplied measured weight (dual count+weight capture, Slice A). Additive function only; no table touched.')
ON CONFLICT (version) DO NOTHING;
