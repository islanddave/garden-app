-- 0b-resolver-v5.sql
-- V4-CAL1INDEP-001 — close the one promotion path 0a cannot reach.
--
-- ── WHY 0a IS NOT ENOUGH BY ITSELF ───────────────────────────────────────────────────────────────
-- resolver v4 promotes on:
--
--     corroborated := confidence IN ('high','medium') OR sample_n >= 5
--
-- 0a fixes the FIRST disjunct — a set of duplicate rows can no longer reach 'high', and a set that
-- is genuinely one observation now reads 'provisional'. The SECOND disjunct is untouched by 0a and
-- reads sample_n, which 0a deliberately left with its v2 meaning (raw live row count). So five rows
-- describing ONE weighing still satisfy `sample_n >= 5` and still promote over the curated
-- reference — the exact failure 0a exists to prevent, arriving through the back door.
--
-- The escape hatch itself is sound and must survive. Its purpose (v4-cal1-sampleconf-001/0a) is a
-- legitimately variable crop — zucchini picked at whatever size it is found — which sits above
-- cv 0.35 permanently and would otherwise be overruled by a catalogue number forever however many
-- times Dave weighed it. That argument is about ACCUMULATED INDEPENDENT WEIGHINGS. It was written
-- when the two counts were indistinguishable; 0a makes them distinguishable, and independent_n is
-- the count the argument was always about.
--
-- ── WHAT THIS CHANGES ────────────────────────────────────────────────────────────────────────────
-- One token: `d.sample_n >= 5` becomes `d.independent_n >= 5`. Nothing else in the function differs
-- from v4 — same signature, same six tiers in the same order, same basis vocabulary, same
-- resolve-tier-once structure. The two are identical for every group where no duplicate exists,
-- which is every group in the live set today (independent_n = sample_n for all 25).
--
-- ORDER vs 0a: 0a MUST be applied first. This body references d.independent_n, a column 0a adds; run
-- against a v2 view it fails at parse with 42703 and the function is left at v4 — which is a safe
-- failure, not a broken one, since v4 remains valid on both view versions.
--
-- ORDER vs THE LAMBDA: none required, same as v3->v4. Identical signature and identical three return
-- columns, so the deployed POST CTE (lambda/events/index.js ~1542) and PUT recompute call it the
-- same way before and after. The basis vocabulary is unchanged, so chk_harvest_log_weight_basis
-- cannot be violated in either direction and the 2026-08-03 23514 class of outage is not in scope.
--
-- SAFETY: CREATE OR REPLACE with an unchanged return type, so the swap is atomic and a Lambda
-- executing mid-statement cannot observe a missing function. Function body only — no table, column,
-- constraint, view or row touched. Re-runnable.

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

COMMENT ON FUNCTION public.resolve_harvest_weight(uuid, text, numeric, numeric) IS
  'CAL-1 single weight-derivation locus (v5). Order: user grams > weight-unit quantity > '
  'cultivar_weight_derived WHEN corroborated (confidence high/medium OR independent_n>=5) > '
  'plant_varieties.unit_weights (curated reference) > cultivar_weight_derived provisional (only '
  'where no curated reference exists) > crop_types.unit_weights (gated on variety_grams_required) > '
  'NULL. v5 changes ONE input against v4: the accumulation escape hatch counts INDEPENDENT '
  'observations (cultivar_weight_derived.independent_n, added in v4-cal1-indep-001/0a) rather than '
  'raw rows, so N duplicate samples describing ONE weighing can no longer promote over the curated '
  'reference. Tier order, basis vocabulary and every other expression are identical to v4, and the '
  'two agree exactly wherever independent_n = sample_n. Requires the v3 view. Returns (weight_grams, '
  'weight_estimated, weight_basis) together so the harvest_log weight CHECKs hold by construction.';

INSERT INTO public.schema_version (version, description)
VALUES ('4.23.1-cal1-indep-001-resolver-v5',
  'V4-CAL1INDEP-001 phase 2/2: resolve_harvest_weight v5 — the accumulation escape hatch now reads '
  'cultivar_weight_derived.independent_n instead of sample_n. 0a stopped duplicate rows reaching '
  'confidence ''high'', but v4''s second disjunct (sample_n >= 5) promoted on raw row count, so five '
  'rows describing one weighing still overrode the curated reference. The hatch itself is preserved '
  '— a genuinely variable crop that sits above cv 0.35 forever must still win on accumulation — it '
  'now counts the independent weighings its rationale was always about. One-token change; tier '
  'order, signature and basis vocabulary identical to v4, and no resolved gram value differs for any '
  'group where independent_n = sample_n (all 25 live groups today).')
ON CONFLICT (version) DO NOTHING;
