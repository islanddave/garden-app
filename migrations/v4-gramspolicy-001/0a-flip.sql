-- 0a-flip.sql
-- V4-GRAMSPOLICY-001 — clear crop_types.variety_grams_required on the crops whose varieties are
-- measurably uniform, so resolve_harvest_weight tier 6 (the crop-type average) can price a harvest
-- whose cultivar carries no curated weight and no samples.
--
-- Dave's decision, verbatim: "Per-crop — flip only uniform crops."
--
-- ── WHAT THE FLAG ACTUALLY GATES ────────────────────────────────────────────────────────────────
-- resolve_harvest_weight (LIVE ON PROD IS v5, migrations/v4-cal1-indep-001/0b-resolver-v5.sql — NOT
-- the v4 in v4-harvbasis-sample-001; v5 swapped sample_n>=5 for independent_n>=5 in the corroboration
-- predicate and left the tier ladder identical) ends:
--     WHEN NOT COALESCE(ct.variety_grams_required, true)
--          AND (ct.unit_weights ->> p_unit) IS NOT NULL   THEN 6
-- With the flag true, tier 6 is unreachable: the resolver returns NULL, the harvest renders unweighed
-- and contributes 0 g. Measured on prod 2026-08-16: 130 of 137 live crop types carry the flag true,
-- and 77 of those 130 hold a crop_types.unit_weights figure that is therefore sitting unused.
--
-- ── WHY NOT ALL 130 ─────────────────────────────────────────────────────────────────────────────
-- A crop-type average is right for a low-variance crop and badly wrong for a high-variance one.
-- Prod evidence: tomato `count` spans 68x across 31 measured cultivars, pepper `count` 155x across
-- 22. Flipping those installs a confident wrong number in place of a visible gap. This migration
-- flips FOUR crops, each of which clears both evidence tests below on the database it is applied to.
--
-- ── THE TWO TESTS, ENCODED IN THE UPDATE PREDICATE RATHER THAN ASSUMED ──────────────────────────
-- The crop list is NOT a hardcoded flip. Membership in `target` only nominates a crop; the WHERE
-- clause re-derives both tests against live data at apply time, per unit, and withholds any crop
-- that fails. This is deliberate and it is load-bearing — see the STAGING note below.
--
--   TEST 1  UNIFORMITY.  For every unit the crop can price, the spread of curated per-variety
--           weights (plant_varieties.unit_weights) must satisfy max/min <= 1.25, and any MEASURED
--           spread (cultivar_weight_derived, >=2 cultivars) must satisfy the same. 1.25 is the
--           observed cluster boundary on prod: the differentiated-catalogue ratios run
--           1.11, 1.17, 1.20, 1.20, 1.21, 1.22 and then jump to 1.33, 1.40, 1.78, 2.00 ... 500.
--
--   TEST 2  FALLBACK AGREEMENT.  Uniformity alone is not enough — the crop-type number must also
--           agree with the varieties it will stand in for: ct_g / mean(variety_g) in [0.85, 1.15].
--           This test is what excludes `radish`, which IS uniform (3 varieties, 10-12 g, ratio 1.20)
--           but whose crop-type figure is 4.5 g — 2.5x lighter than every variety it would price.
--           `pea` fails it too at 0.80. Both are correctable by fixing the crop-type figure; neither
--           is a variance problem. They are listed in README-BUILD.md as follow-ups, not rejects.
--
-- Absence of evidence passes vacuously (NOT EXISTS of a violating unit). The predicate blocks
-- known-bad, not unknown — a crop with no curated varieties on this database is nominated on the
-- judgment recorded in README-BUILD.md, not on local measurement.
--
-- ── THE STAGING CASE IS WHY THE PREDICATE IS NOT DECORATIVE ─────────────────────────────────────
-- `squash` is safe on PROD only because CROPSPLIT-001 (4.18.0) moved the winter cultivars out to
-- `winter_squash`. Prod's squash is Summer Squash: zucchini 220 g, straightneck 200 g, Zephyr 180 g,
-- ratio 1.22. STAGING is a PRE-cropsplit snapshot (86 crop types vs prod's 137) and still files Pink
-- Banana 6800 g, PA Dutch Crookneck 4500 g and Red Kuri 1600 g under `squash` — ratio 4.25, with the
-- 200 g crop figure 21x lighter than the variety mean. A hardcoded flip would have armed a 200 g
-- fallback for a 6.8 kg squash there. The predicate withholds it and RAISEs a WARNING instead.
-- Expected outcome per environment (verified live 2026-08-16, read-only):
--     prod     arugula, bean, beet, squash flip  (4 rows)
--     staging  arugula, beet flip; squash WITHHELD (test 1 and test 2); bean absent  (2 rows)
-- Both are correct. The staging divergence is the migration working, not a partial apply.
--
-- ── EFFECT ON EXISTING ROWS: ZERO, MEASURED, NOT ASSUMED ────────────────────────────────────────
-- resolve_harvest_weight is STABLE and is called at WRITE time (lambda/events/index.js POST CTE
-- ~1653 and PUT recompute ~2566). Stored harvest_log rows keep the value frozen at their write, so a
-- policy change cannot move history by itself. The only re-derivation path is the manual
-- scripts/harvest-weight-ratchet.sh. Simulated read-only against prod over that script's exact scope
-- predicate (368 rows): 0 rows newly priced, 0 g added, 0 rows re-priced. Cross-checked by calling
-- the LIVE function over the same 368 rows — it disagrees with the stored value on 0 of them, so the
-- ratchet is already at a fixed point and this migration does not move it off one.
-- The change is forward-only insurance: 51 of the 205 varieties added in 2026-07 arrived with no
-- curated unit_weights, and each such variety in a flipped crop now prices instead of reading 0 g.
--
-- ── SAFETY ─────────────────────────────────────────────────────────────────────────────────────
-- One boolean column on at most 4 rows. No DDL on an existing object, no function, no constraint, no
-- harvest_log row. No Lambda deploy in either direction: nothing in JS reads variety_grams_required
-- (audited — the only readers are this resolver and the migration corpus). Re-runnable: the snapshot
-- insert is ON CONFLICT DO NOTHING so a second run cannot overwrite the captured prior state, and the
-- UPDATE is idempotent.

\set ON_ERROR_STOP on

BEGIN;

-- Prior per-crop state, captured before the UPDATE in the same transaction. 0r-rollback.sql restores
-- FROM THIS TABLE rather than blanket-setting true, so a crop that was already false before this
-- migration ran is restored to false and not silently re-armed.
CREATE TABLE IF NOT EXISTS public.crop_types_vgr_snapshot_gramspolicy_001 (
  slug        text PRIMARY KEY,
  prior_value boolean,
  captured_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.crop_types_vgr_snapshot_gramspolicy_001 (slug, prior_value)
SELECT ct.slug, ct.variety_grams_required
  FROM public.crop_types ct
 WHERE ct.deleted_at IS NULL
   AND ct.slug = ANY (ARRAY['arugula','bean','beet','squash'])
ON CONFLICT (slug) DO NOTHING;

WITH target AS (SELECT unnest(ARRAY['arugula','bean','beet','squash']) AS slug),
-- Every (crop, unit) the flip would arm, with the curated variety evidence for that unit alongside.
unit_evidence AS (
  SELECT ct.slug,
         u.key                                  AS unit,
         (u.value #>> '{}')::numeric            AS ct_g,
         cat.n                                  AS cat_n,
         cat.ratio                              AS cat_ratio,
         cat.mean                               AS cat_mean,
         meas.n                                 AS meas_n,
         meas.ratio                             AS meas_ratio
    FROM public.crop_types ct
    JOIN target t ON t.slug = ct.slug
   CROSS JOIN LATERAL jsonb_each(ct.unit_weights) u
    LEFT JOIN LATERAL (
      SELECT count(*) AS n,
             max((e.value #>> '{}')::numeric) / nullif(min((e.value #>> '{}')::numeric),0) AS ratio,
             avg((e.value #>> '{}')::numeric) AS mean
        FROM public.plant_varieties v
       CROSS JOIN LATERAL jsonb_each(v.unit_weights) e
       WHERE v.deleted_at IS NULL AND v.crop_type_slug = ct.slug AND e.key = u.key
    ) cat ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS n,
             max(d.grams_per_unit) / nullif(min(d.grams_per_unit),0) AS ratio
        FROM public.cultivar_weight_derived d
        JOIN public.plant_varieties v2 ON v2.id = d.cultivar_id AND v2.deleted_at IS NULL
       WHERE v2.crop_type_slug = ct.slug AND d.unit = u.key
    ) meas ON true
   WHERE ct.deleted_at IS NULL
),
-- A crop is withheld if ANY of its units breaks either test. Stated as the violating set so the
-- WARNING below can name the unit and the reason rather than just the crop.
violation AS (
  SELECT slug, unit,
         CASE
           WHEN cat_n >= 2 AND cat_ratio > 1.25 THEN
             'test1 curated spread ' || round(cat_ratio,2) || 'x over ' || cat_n || ' varieties'
           WHEN meas_n >= 2 AND meas_ratio > 1.25 THEN
             'test1 measured spread ' || round(meas_ratio,2) || 'x over ' || meas_n || ' cultivars'
           WHEN cat_n >= 1 AND cat_mean > 0
                AND ct_g / cat_mean NOT BETWEEN 0.85 AND 1.15 THEN
             'test2 crop figure ' || ct_g || ' g is ' || round(ct_g / cat_mean, 3)
             || 'x the variety mean ' || round(cat_mean,2) || ' g'
         END AS reason
    FROM unit_evidence
)
UPDATE public.crop_types ct
   SET variety_grams_required = false,
       updated_at             = now()
 WHERE ct.deleted_at IS NULL
   AND ct.slug = ANY (ARRAY['arugula','bean','beet','squash'])
   AND ct.variety_grams_required IS DISTINCT FROM false
   -- inert without a crop figure to fall back to; flipping such a crop changes nothing but the audit
   -- trail, so it is excluded rather than recorded as a flip that did something
   AND ct.unit_weights IS NOT NULL AND ct.unit_weights <> '{}'::jsonb
   AND NOT EXISTS (SELECT 1 FROM violation v WHERE v.slug = ct.slug AND v.reason IS NOT NULL);

-- Withholding must never be silent: a crop nominated by the analysis but rejected by live data is
-- the single most interesting thing this migration can report, and on staging it is the expected
-- outcome for `squash`.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT ct.slug,
           CASE WHEN ct.unit_weights IS NULL OR ct.unit_weights = '{}'::jsonb
                THEN 'no crop_types.unit_weights figure — flip would be inert'
                ELSE 'evidence test failed on this database' END AS why
      FROM public.crop_types ct
     WHERE ct.deleted_at IS NULL
       AND ct.slug = ANY (ARRAY['arugula','bean','beet','squash'])
       AND ct.variety_grams_required IS DISTINCT FROM false
  LOOP
    RAISE WARNING 'V4-GRAMSPOLICY-001 WITHHELD %: %. Re-derive the crop list against this database before forcing it.', r.slug, r.why;
  END LOOP;
END $$;

INSERT INTO public.schema_version (version, description)
VALUES ('4.23.17-gramspolicy-001',
  'V4-GRAMSPOLICY-001: clear crop_types.variety_grams_required on the measurably uniform crops so '
  'resolve_harvest_weight tier 6 (crop-type average) can price a harvest whose cultivar has neither '
  'a curated unit_weights entry nor samples. Dave''s ruling was per-crop, flip only uniform crops. '
  'Nominates arugula, bean, beet, squash; the UPDATE predicate re-derives the evidence per unit at '
  'apply time and withholds any crop failing either test — (1) curated AND measured per-variety '
  'spread max/min <= 1.25, (2) crop figure within [0.85,1.15] of the curated variety mean. On a '
  'pre-CROPSPLIT-001 database (staging) squash is withheld because winter cultivars still sit under '
  'it at 4.25x spread. radish and pea were excluded by test 2 (crop figure 0.40x and 0.80x of their '
  'variety means) — correctable figures, not variance. tomato (68x) and pepper (155x) stay gated. '
  'Zero effect on stored rows: the resolver is STABLE and runs at write time, and a read-only '
  'simulation over harvest-weight-ratchet.sh''s exact 368-row scope showed 0 rows re-priced and 0 g '
  'moved. Forward-only. One boolean on <=4 rows; no DDL on existing objects, no Lambda deploy.')
ON CONFLICT DO NOTHING;

COMMIT;
