-- 0a-data.sql
-- V4-CROPTYPE-002 — seed the harvest/sow attributes for the 26 PLANTED crop types that still
--   carry NULLs. DATA ONLY: every column written here already exists (added by v4-planttype-001,
--   v4-harvattr-001, v4-sowfirstyear-001). There is NO DDL in this migration.
--
-- PURPOSE: close the gap where a crop type with a live planting is missing the attributes that
--   drive user-visible behaviour:
--     * harvest_habit + repeat_interval_days -> src/lib/harvestReadiness.js. Either one NULL and the
--       planting is SILENTLY omitted from the Today "Ready to pick" band, permanently, with no way
--       to discover why from the UI.
--     * first_year_harvest -> src/lib/sowEngine.js via v_sow_candidates. NULL falls through to a
--       hardcoded 16-slug allowlist and lands on 'establishment', which clamps the sow window to a
--       flat first-frost-minus-35d instead of a DTM-derived date. This is the only one of the three
--       that shows a visibly WRONG number rather than an omission.
--
-- SCOPE: the 26 slugs with >=1 live planting that fail the completeness predicate AND are not on
--   harvest-attributes-v1.json's `not_harvest_tracked` list (49 ornamental/houseplant/succulent
--   slugs where NULL is a DECISION, not a gap — those are deliberately untouched here). Derived
--   from live prod 2026-08-03; 56 planted types fail the predicate, 30 of them are not-tracked.
--
-- PROVENANCE: values authored for zone 5b western Massachusetts (~518ft, last frost ~May 15-20,
--   first frost ~Oct 1-5) and reviewed by the horticulture-planning-analyst agent against the live
--   varieties and seed inventory. Per-row confidence + rationale in the trailing comments, matching
--   the v4-harvattr-001/0b-data.sql convention. ONE value is empirical rather than authored
--   (blackberry, see below). Four values were CHANGED from the first draft by review: spinach
--   interval 7->10, luffa NULL->single, rosemary true->false, lemon_verbena true->NULL.
--
-- NULL IS STILL A DECISION HERE. Three slugs are deliberately left NULL and MUST NOT be "completed"
--   by a later pass without a design decision:
--     * garlic, shallot  — precedent set in v4-sowfirstyear-001: fall-planted and lifted the
--       FOLLOWING summer, so neither "first year" nor "establishment" is meaningful for them.
--     * lemon_verbena    — propagated from cuttings, never sown; the seed-sown question this flag
--       asks is ill-defined for it. Rated LOW confidence at review, and the binding rule is that a
--       low-confidence value becomes NULL, not a written guess.
--   No harvest_season_start_doy / harvest_season_end_doy is written for ANY row. A wrong window
--   SUPPRESSES a true readiness signal, which is the same class of harm inverted.
--
-- SAFETY: fully idempotent, first-write-wins.
--   * Every UPDATE is guarded on the target column IS NULL, per column (NOT on a single sentinel
--     column) so a re-run can never overwrite an existing or hand-corrected value, and a row that
--     already has one attribute can still receive another.
--   * All UPDATEs scoped `AND deleted_at IS NULL` (live vocabulary rows only).
--   * schema_version INSERT is ON CONFLICT (version) DO NOTHING.
--   * Re-running the whole file is a clean no-op.
--
-- CONSTRAINT AGREEMENT (checked before authoring): every harvest_habit literal is one of the three
--   in chk_crop_types_harvest_habit; no 'single' row carries a repeat_interval_days
--   (chk_crop_types_repeat_interval forbids it); every interval is within 1..365.
--
-- APPLY ORDER: 0a (this file) -> post gates. NOT applied to any environment by the authoring
--   session — apply is Dave-gated, staging first.
--
-- ROLLBACK: 0r-rollback.sql (re-NULLs exactly the cells this file sets, and only where they still
--   hold the value this file wrote).

BEGIN;

-- ============================================================================
-- 1. harvest_habit + repeat_interval_days — only 4 of the 26 are missing these.
-- ============================================================================

UPDATE public.crop_types SET harvest_habit='repeat', repeat_interval_days=2, updated_at=now()
 WHERE slug='blackberry' AND deleted_at IS NULL AND harvest_habit IS NULL;
-- high | EMPIRICAL, not authored: 4 picks on one planting 2026-07-25..07-31 (gaps 2,3,1 -> mean 2.0d).
-- Converges exactly on the three curated Rubus rows (red_raspberry/black_raspberry/wineberry, all
-- repeat/2). CAVEAT for future readers: n=4 and each pick was ~0.05 cup — a young cane's first
-- trickle, so the gap partly measures Dave's checking cadence, not purely ripening rate.

UPDATE public.crop_types SET harvest_habit='single', updated_at=now()
 WHERE slug='carrot' AND deleted_at IS NULL AND harvest_habit IS NULL;
-- high | Root is one terminal pull per planting. Tops are not a tracked harvest here; cf. beet,
-- which carries the same dual-organ caveat in the curated file.

UPDATE public.crop_types SET harvest_habit='cut_and_come_again', updated_at=now()
 WHERE slug='spinach' AND deleted_at IS NULL AND harvest_habit IS NULL;
UPDATE public.crop_types SET repeat_interval_days=10, updated_at=now()
 WHERE slug='spinach' AND deleted_at IS NULL AND repeat_interval_days IS NULL AND harvest_habit <> 'single';
-- high (habit) / medium (interval) | Baby-leaf spinach: live variety "Baby Spinach", packets incl.
-- Baby Greens Blend at 20-25 DTM. 2-3 repeated outer/whole-crown cuts per sowing before bolt.
-- Interval 10d NOT the 7d of lettuce/arugula — spinach regrows measurably slower after cutting and
-- its 5b peak is cool spring/fall soil. 14 is equally defensible; 10 is the conservative middle.

UPDATE public.crop_types SET harvest_habit='single', updated_at=now()
 WHERE slug='luffa' AND deleted_at IS NULL AND harvest_habit IS NULL;
-- medium | Live variety is "Loofah Sponge" (Luffa aegyptiaca, 15-30ft trellis vine) — grown for
-- SPONGE, not for young edible fruit, which resolves the dual-use ambiguity toward one terminal
-- end-of-season cut. In 5b the gourds do not dry on the vine, so the trigger is the frost date and
-- all fruit comes off together to cure indoors. OPEN QUESTION FOR DAVE: if the sponge is a craft
-- output rather than a harvest, the correct home is the not_harvest_tracked list instead.

-- ============================================================================
-- 2. first_year_harvest — 22 of the 26 are missing it (blackberry/carrot already set).
--    Semantics (from the column COMMENT): does a SOWING made this season yield its payoff in the
--    SAME season? Authored for the seed-sown case. Orthogonal to lifecycle.
-- ============================================================================

UPDATE public.crop_types SET first_year_harvest=true, updated_at=now()
 WHERE deleted_at IS NULL AND first_year_harvest IS NULL AND slug IN (
   'arugula','basil','bean','bitter_melon','cilantro','cucamelon','cucumber','dill','endive',
   'lettuce','luffa','melon','nasturtium','okra','potato','spinach','squash','tomatillo','watermelon'
 );
-- high | Annuals: there is no second year, so a same-season harvest is definitional rather than a
-- judgment. All carry DTMs of 40-120d against a ~135d 5b frost-free window. luffa at 90-120 DTM is
-- the marginal one, which is precisely why the DTM-derived sow window (what `true` selects) is the
-- correct engine behaviour for it rather than the flat establishment clamp.

UPDATE public.crop_types SET first_year_harvest=false, updated_at=now()
 WHERE slug='bay' AND deleted_at IS NULL AND first_year_harvest IS NULL;
-- high | Laurus nobilis from seed: months to germinate, 2-3 years to usable leaf volume.
-- Unambiguously not a first-season harvest.

UPDATE public.crop_types SET first_year_harvest=false, updated_at=now()
 WHERE slug='rosemary' AND deleted_at IS NULL AND first_year_harvest IS NULL;
-- medium | The seed-sown case governs: rosemary germinates slowly and erratically and needs 1-2
-- seasons to reach harvestable size; a first-year seedling yields no usable cut. A BOUGHT plant
-- harvests immediately — but that is the acquisition path, not what this flag models. If a
-- variety-level override ever lands, rosemary is a prime candidate.

-- Deliberately NOT written (documented above, repeated here so a future pass does not "fix" them):
--   garlic, shallot  -> NULL per v4-sowfirstyear-001 (fall-planted, lifted the following summer).
--   lemon_verbena    -> NULL: cutting-propagated, never sown; low confidence -> NULL, not a guess.

INSERT INTO public.schema_version (version, description)
VALUES ('4.17.0-croptype-002',
        'CROPTYPE-002: seed harvest_habit/repeat_interval_days (blackberry, carrot, spinach, luffa) + first_year_harvest (19 true, 2 false) for the 26 PLANTED crop types with NULL attributes. Data-only, no DDL. garlic/shallot/lemon_verbena deliberately left NULL; no harvest_season DOY written. blackberry interval is empirical from harvest_log, not authored.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================================
-- KNOWN LIVE DEFECT, NOT FIXED HERE — the `squash` slug is one sowing from being wrong.
-- Both live squash PLANTINGS are Cucurbita pepo bush summer types (Dark Green Zucchini, Zephyr),
-- so the existing seeded repeat/2 is correct TODAY and is deliberately left untouched. But the seed
-- inventory holds SIX winter squash/pumpkin packets against ONE summer type:
--   Waltham Butternut 100-105, Red Kuri 95, Cinderella 95-110, Pink Banana 100-120,
--   PA Dutch Crookneck 105, Howden 115  vs  Early Prolific Straightneck 45.
-- Winter squash is harvest_habit='single' with a months-long cure — horticulturally opposite on
-- every column. The curated file already flags repeat/2 as "actively wrong" for winter types. This
-- is now the LIKELY next event, not a distant contingency. A `winter_squash` slug split should be
-- raised as its own ticket BEFORE any of those six packets is sown.
-- ============================================================================
