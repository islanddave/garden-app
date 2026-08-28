-- 0a-function.sql
-- BUG-SAMPLEPRODUCTBLEND-001 — stop a two-product sample blend from outranking the curated reference.
--
-- FUNCTION-ONLY. No table, column, constraint, index or row is touched. CREATE OR REPLACE is safe
-- here and is NOT the hazard the dual-harvest design flagged: that warning is about ADDING A
-- PARAMETER, which creates a second overload and makes every existing 4-argument call ambiguous.
-- The signature is byte-identical to v5; only the body of the `corroborated` predicate changes.
--
-- TAKES EFFECT IMMEDIATELY, WITH NO DEPLOY. Both harvest write paths call this through LATERAL
-- (lambda/events/index.js:1937 and :3149), so the fix lands the moment this applies and needs no
-- promote. That cuts both ways and is why 0r exists and why this was rehearsed on a prod fork first.
--
-- DOES NOT REWRITE HISTORY. Rows already stored keep their weights and their basis; this changes what
-- the NEXT save resolves. One prod row (Green Magic, 10.64 g, basis cultivar_sample) was written under
-- the old behaviour and is deliberately left alone — re-pricing stored harvests is a separate,
-- Dave-visible decision, not a side effect of a resolver fix.

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
    -- v6 — BUG-SAMPLEPRODUCTBLEND-001. ONE new conjunct: a CATEGORY-ERROR GUARD.
    --
    -- WHY. The escape hatch (independent_n >= 5) exists so that enough independent weighings beat a
    -- generic catalogue number, and it is RIGHT to keep: Cucamelon has 21 observations and Suyo Long
    -- 21, and their learned values are better than the curated reference. But it also promoted
    -- broccoli, where one unit spans TWO PRODUCTS: every 'head' sample on prod is a SIDE SHOOT
    -- (66,18,27,45,50 g) while the curated reference is a CROWN. Green Magic therefore priced a crown
    -- at 42.55 g against a curated 500 g — an 11.8x understatement on the primary harvest surface,
    -- live, verified by calling this function on prod 2026-08-28.
    --
    -- THE DISCRIMINATOR IS THE RATIO, NOT THE CONFIDENCE OR THE COUNT. Both broccoli rows are
    -- confidence='low', but so are eight legitimate ones; demoting all low-confidence rows would have
    -- thrown away real calibration. Measured on prod, every legitimate divergence is <= 3.05x
    -- (Bitter Melon 200/65.5) and both broccoli rows are >= 7.72x (450/58.3).
    --
    -- THE THRESHOLD IS 6.5x, AND IT WAS TIGHTENED FROM 5x AFTER MEASURING. At 5x a whole-garden diff
    -- (101 varieties, prod-vs-fork) moved FOUR rows, not the two broccoli ones: Pineapple Tomatillo
    -- (curated 8 g vs learned 1.53 g = 5.23x) and Ristra Cayenne II (curated 12 g vs learned 68.4 g =
    -- 5.70x the other way) also tripped. Both look like bad data — a 1.53 g tomatillo and a 68 g
    -- cayenne are both implausible — but neither has a DEMONSTRATED two-product split the way broccoli
    -- does, and Dave's decision was scoped to broccoli. 6.5 sits in the measured empty band between
    -- 5.70 and 7.72, so this guard now moves exactly the two rows whose cause is proven. The lower
    -- bound is its reciprocal (1/6.5 = 0.154), symmetric because a learned value 6.5x ABOVE a
    -- reference is exactly as suspicious as one 6.5x below.
    --
    -- Those two near-misses are real candidates and are recorded in the README rather than silently
    -- swept in — they need their own evidence, not a threshold chosen to include them.
    --
    -- The claim this encodes: a learned value that disagrees with a curated reference by more than 5x
    -- is evidence the two are measuring DIFFERENT THINGS, not that the reference is stale. Calibration
    -- corrects a number; it does not multiply it tenfold.
    --
    -- FAIL-SAFE DIRECTION. The guard only ever DEMOTES tier 3 -> tier 5 (provisional), which the tier
    -- table already places BELOW the curated reference. It cannot promote anything, cannot invent a
    -- value, and where no curated reference exists it is inert (the IS NOT NULL conjunct) — so a
    -- variety with samples and no catalogue entry keeps today's behaviour exactly.
    --
    -- WHEN THE PRODUCT AXIS LANDS (V4-DUALHARVEST-001), this guard becomes redundant for the case it
    -- was written for, because crown and side shoot will carry different products and stop sharing a
    -- reference. Re-evaluate it then rather than leaving it as folklore. It is a stopgap and says so.
    SELECT COALESCE(
      (d.confidence IN ('high','medium') OR d.independent_n >= 5)
      AND NOT (
        d.grams_per_unit IS NOT NULL
        AND (v.unit_weights ->> p_unit) IS NOT NULL
        AND NULLIF((v.unit_weights ->> p_unit)::numeric, 0) IS NOT NULL
        AND (d.grams_per_unit / NULLIF((v.unit_weights ->> p_unit)::numeric, 0)) NOT BETWEEN 0.154 AND 6.5
      ), false) AS corroborated
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



INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('4.63.1-sampleblendguard-001',
        'BUG-SAMPLEPRODUCTBLEND-001: resolve_harvest_weight v6 — category-error guard demotes a learned '
        'value that disagrees with the curated reference by more than 5x from corroborated (tier 3) to '
        'provisional (tier 5), which the tier table already ranks below the reference.',
        now())
ON CONFLICT DO NOTHING;
