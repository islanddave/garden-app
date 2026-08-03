-- 0a-data.sql
-- V4-CROPSPLIT-001 — split three conflated crop_types slugs. DATA ONLY; no DDL (every column
--   written here already exists). Three independent splits, one migration, one apply:
--     squash  -> winter_squash   (6 cultivars move)   Dave-requested
--     onion   -> bunching_onion  (3 cultivars move)   Dave-approved; HIGHEST harm, live + silent
--     radish  -> rat_tail_radish (1 cultivar moves)   free today, permanent if missed
--
-- WHY SPLIT AND NOT FACET. `crop_types` carries harvest_habit / repeat_interval_days /
--   first_year_harvest PER SLUG. The derived-facet engine (lambda/*/crop-derive.js) can express a
--   descriptive difference on a cultivar, but it CANNOT give two groups different values for those
--   three columns. Where the divergence is CATEGORICAL — a signal that fires vs one that can never
--   fire — only a slug split works. Where it is merely continuous (interval a bit longer) or
--   descriptive (colour, size), a facet is correct and we do NOT split. That rule is why pea
--   (snap vs shelling: identical habit) and melon (all Cucumis melo, all single) are deliberately
--   left alone, and why `pumpkin` does NOT become a fourth slug: it differs from winter_squash on
--   zero behavioural columns and cross-cuts species (Howden is C. pepo, Cinderella C. maxima), so
--   it is a use-word -> facet territory, not a taxon.
--
-- THE AXIS MATTERS. Split on the axis that changes BEHAVIOUR, not the one that is taxonomically
--   satisfying. Howden is recorded Cucurbita pepo — botanically the same species as zucchini — but
--   it is a 115-day storage pumpkin. Any species- or name-based predicate mis-partitions it. Every
--   move below is therefore BY EXPLICIT CULTIVAR ID, never by a predicate.
--
-- SAFETY: fully idempotent, first-write-wins.
--   * Each INSERT is ON CONFLICT (slug) DO NOTHING, plus a guarded un-soft-delete scoped to this
--     migration's created_by — crop_types_pkey is a plain PRIMARY KEY (slug) with no live-partial
--     unique, so a soft-deleted row would otherwise squat the slug invisibly.
--   * Each UPDATE ... SET crop_type_slug is guarded `AND crop_type_slug = '<old>'`, which makes it
--     both idempotent (re-run matches 0) and non-clobbering (a later hand-correction survives).
--   * Cultivar moves are deliberately NOT filtered on deleted_at: a soft-deleted cultivar that is
--     later restored must not come back on the wrong slug.
--   * Attribute UPDATEs on the surviving parent slugs are guarded IS NULL.
--   * schema_version INSERT is ON CONFLICT DO NOTHING.
--
-- ORDER IS LOAD-BEARING: mint the new slug BEFORE repointing cultivars (FK), and re-derive facet
--   tags (0b-redrive.mjs) only AFTER this file commits. applyDerive reads
--   `crop_types WHERE deleted_at IS NULL` and computeDerivedTags guards `if (cropSlug && ct)` — a
--   missing or soft-deleted target row emits NO type tag at all, SILENTLY, hiding every moved
--   cultivar from the Garden by-type view.
--
-- NOT applied to any environment by the authoring session — apply is Dave-gated, staging first.
-- ROLLBACK: 0r-rollback.sql.

BEGIN;

-- ============================================================================
-- 1. winter_squash  (from squash)
-- ============================================================================
-- Currently ONE `squash` slug carries harvest_habit='repeat'/2d — a SUMMER squash cadence — while
-- 6 of its 9 cultivars are winter/storage types that are single-harvest and cured for months.
-- src/data/harvest-attributes-v1.json's squash note pre-authorized exactly this split, and
-- parseSowProfile.js's CROP_GUESS_SYNONYMS records the same debt ("no pumpkin/winter_squash type
-- exists yet"). DTM separates the two groups with no overlap: summer 45-60d, winter 95-120d.
INSERT INTO public.crop_types
  (slug, display_name, default_lifecycle, category, sort_order, created_by,
   harvest_habit, repeat_interval_days, first_year_harvest, default_unit)
VALUES
  ('winter_squash', 'Winter Squash', 'annual', 'vegetable', 0, 'v4-cropsplit-001',
   'single', NULL, true, 'count')
ON CONFLICT (slug) DO NOTHING;
-- harvest_habit='single'  | high   — definitional for a cured storage squash.
-- repeat_interval_days    | NULL   — REQUIRED: chk_crop_types_repeat_interval forbids an interval
--                                    on a 'single' habit.
-- first_year_harvest=true | high   — inert TODAY (all 7 sow candidates resolve lifecycle='annual',
--                                    and sowGoal short-circuits on annual before reading the flag)
--                                    but 3 of the 6 have grown_as NULL and rely solely on
--                                    lifecycle; a future cultivar entered without one WOULD read
--                                    it. Set defensively, and consistent with the 19 annuals
--                                    seeded true in v4-croptype-002.
-- default_unit='count'    | high   — UI defaulting ONLY. Verified against the LIVE
--                                    resolve_harvest_weight (v4-cal1-harvweight-002): it resolves
--                                    COALESCE(derived, variety.unit_weights, crop.unit_weights)
--                                    and does NOT reference default_unit. A wrong value here costs
--                                    one dropdown change and can never corrupt a total.
--
-- unit_weights / grams_per_unit / weight_source / weight_confidence: DELIBERATELY NULL (high).
--   The 6 winter cultivars are BIMODAL, not a continuous spread: culinary (Waltham Butternut 1400g,
--   Red Kuri 1600g, PA Dutch Crookneck 4500g) vs carving/decorative (Pink Banana 6800g,
--   Cinderella 7000g, Howden 9000g). A median (~5650g) sits in the GAP and describes neither, and
--   the likely next acquisition is an eating squash (delicata ~600g, acorn ~700g) for which it
--   would be 8-9x too high — posting a plausible-looking, silently wrong weight_estimated=true row
--   that corrupts multi-season yield comparison invisibly. All 6 current cultivars carry their own
--   unit_weights, so this tier is provably inert today. Accepted failure: a FUTURE winter squash
--   with no per-variety weight contributes 0g to season totals — missing-and-flagged (the
--   v4-cal1-refweight-001 coverage report attributes it as "no unit_weights entry for this unit")
--   beats wrong-and-invisible. Precedent: tomato carries no crop-level factor at a 20x spread.
--   A cup-based value was considered and rejected: cubed squash is preparation-variable
--   (raw ~140 g/cup vs cooked mashed ~245 g/cup), so it fails the same test at smaller magnitude.
--
-- harvest_season_start_doy / end_doy: NULL (high). Not a judgment call — INERT. isReadyToPick
--   (src/lib/harvestReadiness.js:27,29) returns false on the NULL interval and again on the
--   non-repeating habit; inHarvestWindow is the last expression and is never reached for a 'single'
--   crop. There is no server-side equivalent either (harvest-ready.test.js asserts the candidate
--   SQL carries no DOY predicate). Setting one would also force inventing a start_doy to satisfy
--   chk_crop_types_harvest_season_doy, and would trip the deliberate tripwire in
--   harvestAttributesSync.test.js pinning windowed === ['asparagus','garlic'].
-- loss_horizon_hours / set_to_first_pick_days: NULL — zero runtime consumers anywhere in the app,
--   and set_to_first_pick is doubly inert for a 'single' habit.

UPDATE public.crop_types SET deleted_at = NULL, updated_at = now()
 WHERE slug = 'winter_squash' AND deleted_at IS NOT NULL AND created_by = 'v4-cropsplit-001';

UPDATE public.plant_varieties SET crop_type_slug = 'winter_squash', updated_at = now()
 WHERE crop_type_slug = 'squash' AND id IN (
   'b6ffab33-afb9-4354-80a1-bfb8f61a76dd',  -- Cinderella (Rouge Vif d'Etampes)  C. maxima   95-110d
   '83b3195b-8be3-4806-94c5-c5dc85a7cb58',  -- Howden                            C. pepo(!)  115d
   'f1bbb5be-d48a-45d2-b536-b75d36860eec',  -- Pennsylvania Dutch Crookneck      moschata    105d
   'feb6719d-5d8e-45a8-b7fe-0cb5a6dd1121',  -- Pink Banana                                   100-120d
   'c7d0aee5-6983-4220-9b25-db9a19f88ab5',  -- Red Kuri                                      95d
   'a0f88678-9c47-4aed-899b-141448c06ca7'   -- Waltham Butternut                 C. moschata 100-105d
 );
-- STAY on squash (all C. pepo bush summer types, 45-60d): Dark Green Zucchini (1 planting),
-- Zephyr (1 planting), Early Prolific Straightneck. Both live plantings and the single
-- preservation_log row (Dark Green Zucchini, whole_freeze) are summer -> no harvest-history
-- disturbance, and the harvest-ready set must be IDENTICAL after this migration.

UPDATE public.crop_types SET display_name = 'Summer Squash', updated_at = now()
 WHERE slug = 'squash' AND deleted_at IS NULL AND display_name = 'Squash';
-- The surviving slug now means only summer squash; leaving it "Squash" alongside "Winter Squash"
-- is an ambiguous picker. Behavioural attrs (repeat/2) were already correct for summer types.

-- ============================================================================
-- 2. rat_tail_radish  (from radish)
-- ============================================================================
-- Rat's Tail (Raphanus sativus var. CAUDATUS) is grown for edible SEED PODS on a 4-5ft branching
-- plant, picked every few days, where picking sustains set — mechanically a snap bean. The other
-- three radishes are roots: one terminal pull. `radish` is currently UNSEEDED (all attrs NULL), so
-- this split is free RIGHT NOW; seeding radish first would bake root-'single' onto a pod crop
-- permanently.
INSERT INTO public.crop_types
  (slug, display_name, default_lifecycle, category, sort_order, created_by,
   harvest_habit, repeat_interval_days, first_year_harvest, default_unit)
VALUES
  ('rat_tail_radish', 'Rat''s Tail Radish', 'annual', 'vegetable', 0, 'v4-cropsplit-001',
   'repeat', 3, true, 'count')
ON CONFLICT (slug) DO NOTHING;
-- harvest_habit='repeat'/3 | high/medium — pods fiber fast; 2-3d cadence at peak, as for snap bean.
-- first_year_harvest=true  | high   — annual (inert via short-circuit; set for consistency).
-- default_unit='count'     | med-high — count is 75% of Dave's 332 logged harvests and is the
--                            discrete-countable-item cohort (tomato/pepper/cucumber/bean); `cup` is
--                            the volume-measured cohort (berries, leafy). A pod is a discrete item.
-- unit_weights: NULL — deliberately NOT copied from bean's 6g. A rat-tail pod is 3-4x a snap bean
--   pod in length and mass, and any figure here would be a guess. The cultivar already carries
--   {"cup":116,"count":2}, so grams resolve at variety tier today; Dave's first weighing populates
--   the rest via record_harvest_weight_sample.

UPDATE public.crop_types SET deleted_at = NULL, updated_at = now()
 WHERE slug = 'rat_tail_radish' AND deleted_at IS NOT NULL AND created_by = 'v4-cropsplit-001';

UPDATE public.plant_varieties SET crop_type_slug = 'rat_tail_radish', updated_at = now()
 WHERE crop_type_slug = 'radish' AND id = 'a53f78ae-aa0f-47ca-bff8-f6633048cdb8';  -- Rat's Tail

-- Seed the SURVIVING radish slug so the distinction is actually recorded. radish has 0 plantings,
-- so this changes no behaviour today — but leaving it NULL means the split asserts nothing about
-- what a radish IS, and the next seeding pass would face the same ambiguity this split resolves.
UPDATE public.crop_types SET harvest_habit = 'single', updated_at = now()
 WHERE slug = 'radish' AND deleted_at IS NULL AND harvest_habit IS NULL;
UPDATE public.crop_types SET first_year_harvest = true, updated_at = now()
 WHERE slug = 'radish' AND deleted_at IS NULL AND first_year_harvest IS NULL;
-- high | Root radish is one terminal pull; fast annual (~25-30d), unambiguously first-year.

-- ============================================================================
-- 3. bunching_onion  (from onion)   *** HIGHEST HARM — live and silent ***
-- ============================================================================
-- `onion` carries harvest_habit='single' (a BULB onion: one terminal lift), but 3 of its 10
-- cultivars are non-bulbing scallions that regrow from the base — cut_and_come_again. Because
-- isReadyToPick() returns false for any non-repeating habit (src/lib/harvestReadiness.js:29),
-- those scallions can NEVER appear in the Today "Ready to pick" band. Two of them are LIVE
-- plantings. This failure is invisible: a nudge that never arrives cannot be noticed. Unlike the
-- squash split (prospective — no winter type planted yet), this one is wrong RIGHT NOW.
--
-- Tokyo Long White is Allium FISTULOSUM — a different species from A. cepa — so this is also the
-- strongest botanical case in the set. But note the split is justified by HARVEST HABIT, not by
-- species: an A. cepa grown as a scallion still harvests cut-and-come-again. Species is the
-- descriptive axis; habit is the behavioural one. See the deliberate non-change below.
INSERT INTO public.crop_types
  (slug, display_name, default_lifecycle, category, sort_order, created_by,
   harvest_habit, repeat_interval_days, first_year_harvest,
   unit_weights, default_unit, grams_per_unit, weight_source, weight_confidence,
   variety_grams_required)
VALUES
  ('bunching_onion', 'Onion (bunching / scallion)', 'perennial', 'vegetable', 0, 'v4-cropsplit-001',
   'cut_and_come_again', 14, true,
   '{"count":15,"cup":160}'::jsonb, 'count', 15, 'usda', 'medium',
   false)
ON CONFLICT (slug) DO NOTHING;
-- harvest_habit='cut_and_come_again'/14 | high/medium — regrows from the base after cutting.
-- first_year_harvest=true | HIGH AND LOAD-BEARING — this is the one value here that is NOT inert.
--   Tokyo Long White is grown_as='perennial'/lifecycle='perennial', so sowGoal's annual
--   short-circuit does NOT fire and the flag IS read (src/lib/sowEngine.js:250-255). Leave it NULL
--   and it falls through to the dtm heuristic, where sowEngine's FIRST_YEAR_HARVEST_CROPS hardcodes
--   'onion' but NOT 'bunching_onion' -> 'establishment' -> a visibly wrong sow-window close date.
--   (The other two moved cultivars are grown_as='annual' and short-circuit, so are unaffected.)
--   sowEngine's own comment says "Prefer fixing the DATA over extending this list" — hence the
--   column, not the Set.
-- unit_weights {"count":15,"cup":160} + grams_per_unit=15 | usda/medium.
--   A crop-level factor IS supplied here, unlike winter_squash, and the distinction is principled:
--   `cup:160` is variety-invariant across the whole genus (every onion in the seed carries it —
--   a cup of chopped onion is 160 g whether bulb or bunching), and the bunching `count` population
--   is UNIMODAL and tight: 15, 15, 30 — a 2x spread with a clear mode at 15, which is also the
--   conservative end. Winter squash was BIMODAL across 6.4x with the median landing in the gap
--   between the two modes. Bounded 2x downside vs an 8-9x silent overstatement.
--   The 15 traces to USDA via the "Scallion" cultivar's own usda/high seed, not to authoring.
--   weight_confidence='medium' takes the weaker of the two keys (cup high, count medium).
-- variety_grams_required=false (vs true for winter_squash) follows from that same unimodality —
--   a 2x spread is exactly the case crop-level fallback is designed for.
-- default_unit='count' | high — consistent with `onion` (same physical logging act) and with 75%
--   of Dave's 332 logged harvests. NOT 'bunch' (used once, ever) and NOT 'cup': the chives analogy
--   fails on the number that matters — chives is count:0.3 (one blade, so counting is meaningless,
--   hence its cup default) while a scallion count is 15 g, a whole discrete countable plant.
--   default_unit must also name a key present in unit_weights, since refweight-001/0b-seed derives
--   grams_per_unit from it; 'count' is present.
-- loss_horizon_hours / set_to_first_pick_days: NULL — zero runtime consumers app-wide (same
--   rationale as the two splits above); set_to_first_pick is not meaningful for a non-fruit-set crop.

UPDATE public.crop_types SET deleted_at = NULL, updated_at = now()
 WHERE slug = 'bunching_onion' AND deleted_at IS NOT NULL AND created_by = 'v4-cropsplit-001';

UPDATE public.plant_varieties SET crop_type_slug = 'bunching_onion', updated_at = now()
 WHERE crop_type_slug = 'onion' AND id IN (
   '3d6fdd43-6fce-4c62-862c-d58f66b2845c',  -- Onion (scallion-type)  grown_as=annual   1 planting
   '3127a432-af9b-405d-8144-6a3c3470956e',  -- Scallion               grown_as=annual   1 planting
   '0b640bff-ad0a-446f-92b9-993afb5cf2c0'   -- Tokyo Long White        A. fistulosum, perennial
 );
-- STAY on onion (all A. cepa bulbing, 7): Flat of Italy, Monastrell, Red Amposta, Red Onion
-- (long-day), Yellow Granex PRR, Yellow Onion (long-day), Yellow Sweet Spanish Utah.
-- Side benefit: onion's own {"count":110} becomes MORE accurate once the 15g/30g outliers leave.

-- Data integrity on one moved cultivar: "Scallion" carries the literal species string
-- 'cepa (or fistulosum)' — a note parked in a species field, not a species value. Species-driven
-- derivation is an established pattern (basilUse/beanType substring-match on species), and a
-- parenthetical breaks any future exact match or join. No behavioural change today (alliumType
-- reads cropSlug + prose, not species).
UPDATE public.plant_varieties SET species = 'fistulosum', updated_at = now()
 WHERE id = '3127a432-af9b-405d-8144-6a3c3470956e' AND species = 'cepa (or fistulosum)';

-- DELIBERATE NON-CHANGES on the moved cultivars, recorded so a later pass does not "tidy" them:
--   * "Onion (scallion-type)" keeps species='cepa'. That may well be CORRECT — scallions genuinely
--     are sometimes immature A. cepa grown for green tops. Rewriting it to 'fistulosum' to match the
--     slug would be inventing a botanical claim to fit a classification, which is the worse error.
--     Species disagreeing with the slug is not a defect here; see the habit-not-species note above.
--   * NAMES are unchanged. They are join keys: migrations/v4-cal1-refweight-001/0b-seed.sql matches
--     on (crop_type_slug, name), the cal1 seed generator maps variety_name -> cultivar_id and is
--     FAIL-CLOSED on 0 matches, and cal1-cultivar-keys.lock.json pins them. Renaming is churn with
--     real breakage.
--   * lifecycle / grown_as unchanged on all three — verified correct as-is. Note computeDerivedTags
--     uses `cultivar.lifecycle ?? ct.default_lifecycle`, so bunching_onion's 'perennial' default
--     supplies a value only where a cultivar's own lifecycle is NULL; it will not overwrite the two
--     'biennial' values.
--
-- KNOWN, NOT FIXED HERE: the three refweight-001/0b-seed.sql UPDATEs for these cultivars hardcode
-- crop_type_slug='onion' and become silent no-ops after the move. Not a live bug — the values are
-- already applied — but a from-scratch rebuild of that seed would skip them. Fix when that seed is
-- next regenerated.

INSERT INTO public.schema_version (version, description)
VALUES ('4.18.0-cropsplit-001',
        'CROPSPLIT-001: split 3 conflated crop_types slugs — winter_squash out of squash (6 cultivars), bunching_onion out of onion (3 cultivars, highest harm: scallions could never reach the Ready-to-pick band), rat_tail_radish out of radish (1 cultivar, pod crop vs root). Data-only, no DDL. Moves are by explicit cultivar id, never a predicate (Howden is C. pepo but a winter pumpkin). Also: squash display_name -> Summer Squash, radish seeded single/first-year, Scallion species normalised. Requires 0b-redrive.mjs to swap derived type: facet tags, and MUST land before the Lambda deploy that repoints COUPLED_CROP_SYNONYMS.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
