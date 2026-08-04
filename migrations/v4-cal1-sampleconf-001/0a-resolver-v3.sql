-- 0a-resolver-v3.sql
-- V4-CAL1SAMPLECONF-001 — make the real-sample tier CONFIDENCE-AWARE.
--
-- WHAT WAS WRONG
-- resolve_harvest_weight v2 (v4-cal1-slicec-001/0a) ranked cultivar_weight_derived above the
-- curated variety reference UNCONDITIONALLY — a flat COALESCE with no reference to sample_n or
-- confidence. Its header states the intent plainly: "TIER 3 OVER TIER 4 regardless of sample
-- count ... a single real weighing still beats a seed-catalog figure", justified on the
-- observation that "Dave's first eight samples landed 25% below catalog across the board".
--
-- That inference does not survive the fuller sample. At 21 samples / 18 (cultivar,unit) groups the
-- n=1 deltas vs catalog are NOT a consistent -25% bias; they are noise spanning -92% to +83%:
--
--   Beefsteak  -92% | Aster      -89% | Strawberry -87% | Cherry Falls -75% | Sunray    -60%
--   Zucchini   -49% | SSweet 100 -47% | San Marzano -39% | Suyo Long   -29% | Granadero -24%
--   Ukr Purple -24% | High Bush  -19% | Moskvich   -18% | Chilly Chill -13% | Blk Cherry -6%
--   Sub Arctic Plenty +83%
--
-- Every one of those 16 is sample_n = 1 / confidence 'provisional'. If catalog carried a uniform
-- bias the deltas would cluster; instead 5 of 16 exceed -50% and one runs +83%. At n=1 a single
-- fruit cannot distinguish "this cultivar is smaller than the catalog says" from "I happened to
-- pick one small fruit". The two groups that DO have corroboration are both coherent and both
-- plausibly better than catalog — San Marzano Roma n=2 at cv=1.5% (two weighings agreeing to
-- within 1.5 percent — a converged estimate) and Celebrity n=3 at cv=18%, 'medium'.
--
-- User-visible headline: logging 5 Beefsteak resolved to 5 x 28 g = 140 g (0.3 lb) against a
-- curated 5 x 350 g = 1750 g (3.9 lb), off one unrepresentative fruit.
--
-- WHAT THIS CHANGES
-- The fix is NOT "demote derived below curated" — that would discard San Marzano Roma and
-- Celebrity, which are the two rows where CAL-1 is working exactly as designed, and would defeat
-- the point of the feature. Real samples still win; they must simply be CORROBORATED first.
-- Uncorroborated samples are not discarded either: they still outrank a crop-level average and
-- still supply the only estimate for a cultivar that has no curated reference at all.
--
-- PROMOTION PREDICATE
--   corroborated := confidence IN ('high','medium') OR sample_n >= 5
--
--   * confidence is the view's OWN pre-existing model, authored in pervariety-001 — 'provisional'
--     is defined as count(*) < 2, so high/medium already imply sample_n >= 2 by construction. This
--     reuses the schema's existing judgment rather than inventing a second, competing threshold.
--   * 'low' (n >= 2 but cv > 0.35) does NOT promote on n alone: samples that disagree that badly
--     are not yet a better estimate than a considered catalog figure.
--   * ... UNLESS sample_n >= 5. This escape hatch is load-bearing, not decoration. A legitimately
--     variable crop — zucchini picked at whatever size it is found, mixed-size cucumbers — will sit
--     above cv 0.35 permanently, and without this clause it could accumulate fifty genuine
--     weighings and still be overruled by a catalog number forever. Celebrity already shows real
--     produce spread at cv=0.18 with n=3. By n=5 the standard error of the mean is ~45% of the
--     per-fruit sd, which is enough for the pooled mean to beat a single catalog point estimate
--     even when the underlying fruit genuinely varies.
--
-- RESOLUTION ORDER (v3) — inserts one tier, reorders nothing else:
--   1. p_user_grams                      -> 'measured'   estimated false
--   2. unit is g/kg/lb/oz                -> 'measured'   estimated false
--   3. derived, CORROBORATED             -> 'cultivar'   estimated true    <-- narrowed from v2
--   4. plant_varieties.unit_weights      -> 'cultivar'   estimated true
--   5. derived, provisional              -> 'cultivar'   estimated true    <-- NEW position
--   6. crop_types.unit_weights           -> 'crop_type'  estimated true    ONLY if crop permits
--   7. nothing                           -> NULL/NULL/NULL
--
-- Tier 5 is deliberately NOT subject to the variety_grams_required gate. That gate says a
-- crop-level AVERAGE is not a defensible stand-in across varieties; it says nothing about a real
-- weighing of the actual cultivar, which is still the best evidence available when no curated
-- number exists.
--
-- BASIS VOCABULARY UNCHANGED — DELIBERATE. Tiers 3, 4 and 5 all report 'cultivar', exactly as in
-- v2, so not one harvest_log row changes weight_basis and chk_harvest_log_weight_basis (VALIDATED)
-- is untouched. Distinguishing sample-backed from catalog-backed in the basis column would need a
-- new vocabulary value, which means widening a validated CHECK ahead of a Lambda that does not yet
-- emit it — the exact ordering that 23514'd every prod harvest save on 2026-08-03 (see
-- v4-cal1-slicec-001/README-BUILD.md). If that provenance split is wanted it is its own migration,
-- sequenced check-widen -> deploy -> writer. Not folded in here.
--
-- CREATE OR REPLACE, NOT DROP+CREATE. The return type is identical to v2, so the swap is atomic and
-- a Lambda executing mid-statement cannot observe a missing function. Unlike slicec-001/0a this
-- needs no Lambda coordination in either direction: the call sites in lambda/events/index.js (POST
-- CTE and PUT recompute) pass the same four arguments and read the same three columns before and
-- after. Schema-only, no writer change required.
--
-- SAFETY: function body only. No table, column, constraint, view, or row is touched. Re-runnable.

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

INSERT INTO public.schema_version (version, description)
VALUES ('4.20.6-cal1-sampleconf-001',
  'V4-CAL1SAMPLECONF-001: resolve_harvest_weight v3 — the real-sample tier is now confidence-aware. '
  'v2 ranked cultivar_weight_derived above the curated variety reference unconditionally, so a '
  'single unrepresentative weighing (16 of 18 derived groups are sample_n=1/provisional) overrode '
  'catalog by -92%..+83% (5 Beefsteak resolved 140 g vs a curated 1750 g). Derived now outranks the '
  'reference only when corroborated (confidence high/medium OR sample_n>=5); uncorroborated samples '
  'drop to a new tier BELOW the variety reference but still ABOVE the crop-type average, so they '
  'remain the estimate wherever no curated number exists. San Marzano Roma (n=2, cv 1.5%) and '
  'Celebrity (n=3, medium) keep their promotion. CREATE OR REPLACE, signature and basis vocabulary '
  'unchanged; no writer change and no row touched.')
ON CONFLICT DO NOTHING;
