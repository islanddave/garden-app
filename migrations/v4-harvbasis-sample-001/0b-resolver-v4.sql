-- 0b-resolver-v4.sql
-- V4-HARVBASIS-SAMPLE-001 PHASE 2 of 2 — resolve_harvest_weight v4. The writer that emits
-- 'cultivar_sample'.
--
-- HARD PRECONDITION: 0a-widen-check.sql MUST already be committed on this database. Running 0b
-- first raises 23514 on every harvest save that resolves through tier 3 or tier 5 — which is all 18
-- (cultivar,unit) derived groups in prod. The guard block below refuses to run if 0a is absent; do
-- not remove it.
--
-- WHAT CHANGES: the basis LABEL only. Not one gram value moves.
--
-- v3 reported 'cultivar' for tiers 3, 4 AND 5, collapsing two different kinds of evidence:
--   tier 3/5  cultivar_weight_derived  -> Dave's OWN weighings, pooled
--   tier 4    plant_varieties.unit_weights -> a CURATED CATALOGUE figure
-- so nothing downstream could tell "we measured this" from "the seed packet says". v4 splits them:
--
--   1. p_user_grams                      -> 'measured'         estimated false
--   2. unit is g/kg/lb/oz                -> 'measured'         estimated false
--   3. derived, CORROBORATED             -> 'cultivar_sample'  estimated true   <-- relabelled
--   4. plant_varieties.unit_weights      -> 'cultivar'         estimated true       (unchanged)
--   5. derived, provisional              -> 'cultivar_sample'  estimated true   <-- relabelled
--   6. crop_types.unit_weights           -> 'crop_type'        estimated true       (unchanged)
--   7. nothing                           -> NULL/NULL/NULL                          (unchanged)
--
-- DEMOTE-DON'T-DISCARD IS UNTOUCHED. The promotion predicate is byte-identical to v3
-- (confidence IN ('high','medium') OR sample_n >= 5). Tier ORDER is unchanged. Celebrity (n=3,
-- medium) and San Marzano Roma (n=2, cv 1.5%) keep their promotion above the curated reference; the
-- 16 provisional n=1 groups stay demoted below the reference and above the crop average. The new
-- value is a PROVENANCE label, not a ranking change — both the promoted and the demoted sample
-- tiers report 'cultivar_sample', because both are sample-backed. Anyone wanting the promoted /
-- demoted distinction reads cultivar_weight_derived.confidence and .sample_n, which is where that
-- judgment already lives; duplicating it into the basis vocabulary would be a second competing
-- threshold. No "reject derived if it deviates >X% from curated" guard is added — that was
-- explicitly rejected as circular, since it would prevent CAL-1 ever correcting a wrong catalogue
-- number, which is the entire point of the feature.
--
-- GRAM VALUES ARE PROVABLY UNCHANGED. v3 computed `factor` as a 4-arm COALESCE and `basis` as a
-- SEPARATE, independent CASE. v4 computes the TIER ONCE and derives both from it. That is
-- equivalent for factor by inspection of COALESCE precedence:
--     arm A non-null  iff  corroborated AND d.grams_per_unit IS NOT NULL   -> tier 3
--     else arm B non-null                                                 -> tier 4
--     else arm C non-null (d.grams_per_unit IS NOT NULL)                   -> tier 5
--     else arm D                                                           -> tier 6
-- ...which is exactly the tier CASE below, first-match-wins. Verified empirically against v3 over
-- the full (plant x unit) matrix on staging before this shipped; see README-BUILD.md.
--
-- ...AND IT CLOSES A LATENT v3 DESYNC. In v3 the basis CASE's first arm was `WHEN c.corroborated`
-- with NO `d.grams_per_unit IS NOT NULL` conjunct, while the factor COALESCE's arm A HAD one. So if
-- a derived row could ever be corroborated with a NULL grams_per_unit, factor would fall through to
-- tier 4/6 while basis still said 'cultivar'. Today that is UNREACHABLE — cultivar_weight_derived
-- is a VIEW doing SUM(total_grams)/SUM(unit_count) over cultivar_weight_sample, whose two operands
-- are NOT NULL with validated >0 CHECKs, so a group exists only if grams_per_unit is non-null
-- (verified live: 0 rows with corroborated AND grams_per_unit IS NULL, prod and staging) — and
-- under v3 the mismatch was invisible anyway because tiers 3 and 4 shared one label. Under v4 it
-- would stop being invisible: it would stamp a CATALOGUE number as 'cultivar_sample' — precisely
-- the lie this feature exists to prevent — or, falling through to nothing, produce a non-NULL basis
-- with a NULL weight_grams and 23514 against chk_harvest_log_weight_basis_pairing. It becomes
-- reachable the moment anyone materialises the view, adds outlier trimming that can null a group,
-- or LEFT JOINs reference rows with no samples. Deriving both from one tier makes it structurally
-- impossible rather than accidentally absent.
--
-- basis IS NULL <=> factor IS NULL <=> weight_grams IS NULL <=> weight_estimated IS NULL now holds
-- by construction, so chk_harvest_log_weight_basis_pairing and chk_harvest_log_weight_pairing
-- cannot be tripped by a resolver disagreement.
--
-- NO LAMBDA DEPLOY IS REQUIRED, IN EITHER DIRECTION. Both write paths in lambda/events/index.js
-- (the POST CTE ~1510 and the PUT recompute ~1113) are pure pass-throughs: they SELECT
-- rw.weight_basis from a LATERAL call and never type a basis literal. The signature and return type
-- are identical to v3, so CREATE OR REPLACE is atomic and a Lambda executing mid-statement cannot
-- observe a missing function. No JS/TS anywhere in the repo branches on weight_basis (no switch, no
-- label map, no filter, no TS union, no zod schema, no request validator) — audited exhaustively.
-- The API echoes the value in the events payload; an unknown value there is inert.
--
-- SAFETY: function body only. No table, column, constraint, view, index or ROW is touched. Existing
-- harvest_log rows keep whatever basis they already have — see the DELIBERATELY-NOT-BACKFILLED note
-- in README-BUILD.md. Re-runnable.

\set ON_ERROR_STOP on

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid AND rel.relkind = 'r'
     WHERE rel.relname = 'harvest_log'
       AND con.conname = 'chk_harvest_log_weight_basis'
       AND pg_get_constraintdef(con.oid) LIKE '%cultivar_sample%'
  ) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'REFUSING TO INSTALL RESOLVER v4: chk_harvest_log_weight_basis does not admit cultivar_sample on this database.',
      HINT    = 'Apply migrations/v4-harvbasis-sample-001/0a-widen-check.sql FIRST. Installing v4 ahead of the widened CHECK raises 23514 on every harvest save resolving through tier 3 or 5 — the 2026-08-03 outage, reproduced.';
  END IF;
END $$;

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
  -- The promotion predicate, evaluated ONCE. Unchanged from v3. COALESCE(...,false) so the
  -- no-derived-row case is a plain false rather than a NULL that has to be re-guarded below.
  CROSS JOIN LATERAL (
    SELECT COALESCE(d.confidence IN ('high','medium') OR d.sample_n >= 5, false) AS corroborated
  ) c
  -- THE TIER, RESOLVED ONCE. v3 derived factor and basis from two independent expressions that
  -- could in principle disagree; here they are two projections of one decision. First match wins,
  -- which reproduces the v3 COALESCE precedence exactly.
  CROSS JOIN LATERAL (
    SELECT CASE
      -- tier 3: corroborated samples. The grams_per_unit conjunct is the fix — v3's basis arm
      -- omitted it, so basis could claim a sample while factor came from the catalogue.
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
  'CAL-1 single weight-derivation locus (v4). Order: user grams > weight-unit quantity > '
  'cultivar_weight_derived WHEN corroborated (confidence high/medium, i.e. sample_n>=2, OR '
  'sample_n>=5) > plant_varieties.unit_weights (curated reference) > cultivar_weight_derived '
  'provisional (n=1, only where no curated reference exists) > crop_types.unit_weights (gated on '
  'variety_grams_required) > NULL. Ranking is IDENTICAL to v3 and no gram value changed. v4 splits '
  'the basis vocabulary only: the two SAMPLE-backed tiers (3 and 5) now report ''cultivar_sample'' '
  'while the CURATED catalogue tier (4) keeps ''cultivar'', so provenance is legible downstream. '
  'Tier is resolved once and both factor and basis are projections of it, so basis can no longer '
  'disagree with the number it labels. Returns (weight_grams, weight_estimated, weight_basis) '
  'together so the harvest_log weight CHECKs hold by construction.';

INSERT INTO public.schema_version (version, description)
VALUES ('4.20.8-harvbasis-sample-001-resolver-v4',
  'V4-HARVBASIS-SAMPLE-001 phase 2/2: resolve_harvest_weight v4 — sample-backed weights now report '
  'weight_basis=''cultivar_sample'' (resolver tiers 3 and 5, sourced from cultivar_weight_derived) '
  'while catalogue-backed weights keep ''cultivar'' (tier 4, plant_varieties.unit_weights). LABEL '
  'CHANGE ONLY: the promotion predicate, the tier order and every resolved gram value are identical '
  'to v3, so demote-don''t-discard is preserved — Celebrity (n=3) and San Marzano Roma (n=2) keep '
  'their promotion, the 16 provisional groups stay demoted. Also folds in a latent v3 fix: tier and '
  'factor are now derived from one CASE, so basis cannot label a number it did not source. '
  'CREATE OR REPLACE, signature unchanged, no Lambda deploy required (both write paths are '
  'pass-throughs), no row touched. Requires 4.20.7-harvbasis-sample-001-widen (guarded).')
ON CONFLICT DO NOTHING;

COMMIT;
