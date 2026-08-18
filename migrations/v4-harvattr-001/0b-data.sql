-- 0b-data.sql
-- V4-HARVATTR-001 — DATA seed: harvest-readiness attribute values for zone 5b
--   (western Massachusetts, ~518ft, first frost ~Oct 5, last frost ~May 15).
--
-- PURPOSE: populate the six nullable columns added additively in 0a for the 51 crop types that are
--   actually harvested. Values are authored in src/data/harvest-attributes-v1.json (schema
--   garden.harvest_attributes.v1) and this file is MECHANICALLY GENERATED from it — the JSON is the
--   authoring source of record, the DB columns are the runtime source of truth, and the two must not
--   drift. Regenerate this file rather than hand-editing a value.
--
-- WHAT IS DELIBERATELY NOT SEEDED (NULL is a decision here, not a gap):
--   * 49 ornamental / houseplant / succulent / tree slugs (geranium, coleus, fittonia, petunia,
--     tradescantia, sedum, echeveria, succulent, cactus, sempervivum, japanese_maple, spider_plant,
--     flower_mix, rose, hosta, ... ) — not harvest-tracked.
--   * avocado — a zone-5b container houseplant that will never fruit. Permanent NULL.
--   * bee_balm — WAS NULL here (a genuine culinary herb grown as a pollinator ornamental, per owner
--     brief), conditional on "flip to cut_and_come_again/14d if Dave actually picks it". That
--     condition fired 2026-08-18 — see the ADDENDUM at the end of this file and
--     migrations/v4-beebalmflip-001/.
--   * 14 edible slugs in the vocabulary with no live planting (artichoke, carrot, radish, spinach,
--     parsnip, celery, bok_choy, brussels_sprouts, luffa, mustard, perilla, borage, althaea,
--     vietnamese_coriander) — seed them when something is actually planted rather than guessing now.
--   nasturtium IS seeded despite category='flower': leaves, flowers and pods are genuinely eaten.
--
-- NULL SEMANTICS: unchanged from 0a and load-bearing. A crop left NULL means UNKNOWN and NO
--   readiness predicate may fire on it. No downstream default, no coalesce-to-a-guess.
--
-- SAFETY: fully idempotent, first-write-wins.
--   * The UPDATE is guarded `AND c.harvest_habit IS NULL` — a re-run NEVER overwrites an existing or
--     hand-corrected value (house convention, cf. v4-planttype/0b-data.sql). harvest_habit is the
--     seeded-ness sentinel: every seeded crop sets it, so IS NULL means "untouched by this seed".
--   * Scoped `AND c.deleted_at IS NULL` (live vocabulary rows only).
--   * The JOIN silently skips any slug absent from crop_types; the 0c/gates assertions catch a
--     shortfall rather than the UPDATE failing loudly mid-apply.
--   * schema_version INSERT is ON CONFLICT (version) DO NOTHING.
--   Re-running the whole file is a clean no-op.
--
-- CONSTRAINT AGREEMENT: every harvest_habit literal below is one of the three values in
--   chk_crop_types_harvest_habit; no 'single' row carries a repeat_interval_days; every DOY is set
--   in start/end PAIRS (garlic and asparagus only). Verified programmatically against the JSON.
--
-- APPLY ORDER: 0a -> 0b (this file) -> 0c-validate.sql. NOT applied to any environment by the
--   authoring session — apply is Dave-gated, staging first.
--
-- ROLLBACK: 0r-rollback.sql. To revert the DATA only while keeping the columns:
--   UPDATE public.crop_types SET harvest_habit=NULL, repeat_interval_days=NULL,
--     loss_horizon_hours=NULL, set_to_first_pick_days=NULL,
--     harvest_season_start_doy=NULL, harvest_season_end_doy=NULL;
--   DELETE FROM public.schema_version WHERE version='4.15.1-harvattr-seed-001';
--   (Caution: a blanket null-out also discards hand-fixes; prefer targeted reverts.)
--
-- LOW-CONFIDENCE ROWS (flagged, provisional — see the `low` marker in the trailing comments):
--   cucamelon, bitter_melon, lemongrass, bay, peach. These are the values most likely to be wrong.

BEGIN;

-- ============================================================================
-- Harvest attribute seed. Columns, in order:
--   slug, harvest_habit, repeat_interval_days, loss_horizon_hours,
--   set_to_first_pick_days, harvest_season_start_doy, harvest_season_end_doy
-- Trailing comment on each row: authoring confidence | rationale.
-- ============================================================================
WITH seed(slug, harvest_habit, repeat_interval_days, loss_horizon_hours,
          set_to_first_pick_days, harvest_season_start_doy, harvest_season_end_doy) AS (
  VALUES
  ('arugula','cut_and_come_again',7,48,NULL,NULL,NULL),  -- high | Bolts and turns hot/pungent within days in summer heat.
  ('asparagus','repeat',1,48,NULL,115,166),  -- high | THE hard-window case. Daily spear cutting Apr 25 - Jun 15; cutting AFTER t...
  ('basil','cut_and_come_again',12,24,NULL,NULL,NULL),  -- high | Tip-pinch above a leaf node every 10-14d; pinching is what prevents bolt, ...
  ('bay','cut_and_come_again',30,168,NULL,NULL,NULL),  -- low | UNCERTAIN — arguably not schedulable at all. Bay leaves are picked as need...
  ('bean','repeat',3,72,8,NULL,NULL),  -- high | Snap bean. 2-3d cadence; pods go stringy and the plant stops setting if le...
  ('bee_balm','cut_and_come_again',14,NULL,NULL,NULL,NULL),  -- high | ADDED 2026-08-18 (V4-BEEBALMFLIP-001): pre-authored flip executed, Dave has...
  ('beet','single',NULL,336,NULL,NULL,NULL),  -- medium | Root is one terminal harvest. The GREENS are genuinely cut_and_come_again ...
  ('bitter_melon','repeat',3,72,12,NULL,NULL),  -- low | UNCERTAIN. Extrapolated from cucurbit relatives. Pick while green and firm...
  ('black_raspberry','repeat',2,48,30,NULL,NULL),  -- medium | As red raspberry, ~1-2 weeks earlier in zone 5b. NOT currently planted.
  ('blueberry','repeat',4,120,60,NULL,NULL),  -- medium | 3-5d picking over a 3-4 week window. Berries hold on the bush well once bl...
  ('broccoli','repeat',6,72,NULL,NULL,NULL),  -- high | Main head first, then side shoots every 5-7d for weeks. set_to_first_pick ...
  ('cabbage','single',NULL,720,NULL,NULL,NULL),  -- medium | One terminal head. Holds in the field for weeks in cool fall weather; spli...
  ('chard','cut_and_come_again',8,96,NULL,NULL,NULL),  -- high | 7-10d outer-leaf harvest. NOT currently planted.
  ('chives','cut_and_come_again',14,48,NULL,NULL,NULL),  -- high | Shear to ~2in; regrows fully in about 2 weeks. Flowers are edible.
  ('cilantro','cut_and_come_again',10,48,NULL,NULL,NULL),  -- high | Bolts within days of summer heat and the leaf changes character entirely. ...
  ('collard','cut_and_come_again',10,96,NULL,NULL,NULL),  -- high | Bottom-up leaf harvest, 7-10d. Improves after frost. Very forgiving — old ...
  ('cucamelon','repeat',3,72,10,NULL,NULL),  -- low | UNCERTAIN. Little zone-5b data; extrapolated from cucumber with a slower c...
  ('cucumber','repeat',2,60,8,NULL,NULL),  -- high | 2-3d cadence. An oversized fruit left on the vine suppresses further set —...
  ('culantro','cut_and_come_again',14,72,NULL,NULL,NULL),  -- medium | Outer-leaf rosette harvest. Far more bolt-resistant than cilantro; prefers...
  ('dill','cut_and_come_again',12,48,NULL,NULL,NULL),  -- medium | Frond harvest. Bolts to seed head quickly — at which point the harvest tar...
  ('eggplant','repeat',4,72,20,NULL,NULL),  -- medium | Pick at glossy skin; dull skin = seedy and bitter. 3-5d cadence in peak.
  ('endive','cut_and_come_again',10,72,NULL,NULL,NULL),  -- medium | Outer-leaf harvest. Heading types (escarole) behave closer to 'single'; th...
  ('garlic','single',NULL,336,NULL,186,211),  -- medium | Zone 5b lift window ~Jul 5 - Jul 30 (3-4 lower leaves browned). DOY window...
  ('kale','cut_and_come_again',8,96,NULL,NULL,NULL),  -- high | 7-10d bottom-up. NOT currently planted.
  ('kohlrabi','single',NULL,336,NULL,NULL,NULL),  -- medium | Pick at 2-3in; goes woody if left much past size. Modern varieties hold be...
  ('leek','single',NULL,1440,NULL,NULL,NULL),  -- medium | Stands in the ground into winter in zone 5b; the 60d horizon reflects genu...
  ('lemongrass','cut_and_come_again',30,168,NULL,NULL,NULL),  -- low | UNCERTAIN cadence. Outer stalks are cut at the base as they reach pencil t...
  ('lettuce','cut_and_come_again',7,48,NULL,NULL,NULL),  -- high | Leaf-lettuce cadence. Bolts bitter fast in July heat; the 48h horizon is a...
  ('melon','single',NULL,168,42,NULL,NULL),  -- medium | Muskmelon/cantaloupe/charentais. 'single' per fruit and effectively per pl...
  ('mint','cut_and_come_again',14,48,NULL,NULL,NULL),  -- high | Nearly unkillable; cut hard and it returns. Flavor peaks just before flowe...
  ('nasturtium','cut_and_come_again',7,24,NULL,NULL,NULL),  -- medium | JUDGMENT CALL — seeded despite category='flower'. Leaves, flowers and seed...
  ('okra','repeat',2,60,5,NULL,NULL),  -- high | Fastest-turning crop in the set. Pods go woody in 48-72h past ready; miss ...
  ('onion','single',NULL,336,NULL,NULL,NULL),  -- medium | SEEDED AS BULB ONION (long-day storage type). 2 of the 4 live plantings ar...
  ('oregano','cut_and_come_again',18,72,NULL,NULL,NULL),  -- high | Woody perennial herb, 14-21d. Best flavor just before bloom. Stop hard cut...
  ('parsley','cut_and_come_again',12,96,NULL,NULL,NULL),  -- high | Outer-stem harvest, 10-14d. Biennial: bolts and is finished in its second ...
  ('pea','repeat',3,48,7,NULL,NULL),  -- medium | Snap/snow pea cadence. Shelling peas turn starchy fastest. NOT currently p...
  ('peach','repeat',3,72,100,NULL,NULL),  -- low | UNCERTAIN. A tree ripens over ~2 weeks, so 'repeat' with a 3d cadence rath...
  ('pepper','repeat',7,168,50,NULL,NULL),  -- high | 50-55d set -> full-size green; a further 14-21d to red/colored. Holds on t...
  ('potato','single',NULL,720,NULL,NULL,NULL),  -- medium | Terminal dig after vine die-back. Tubers hold in dry ground for weeks; wet...
  ('red_raspberry','repeat',2,48,30,NULL,NULL),  -- medium | Every-other-day at peak. Ripe fruit molds/drops fast. No DOY window: summe...
  ('rosemary','cut_and_come_again',21,96,NULL,NULL,NULL),  -- high | Woody. Zone 5b is not hardy for rosemary — overwinters indoors, so the cad...
  ('sage','cut_and_come_again',18,72,NULL,NULL,NULL),  -- high | Woody perennial, 14-21d. Do not cut into old wood late in the season.
  ('shallot','single',NULL,336,NULL,NULL,NULL),  -- medium | Lifts alongside garlic; same cure-and-store pattern. No DOY window set — s...
  ('squash','repeat',2,36,5,NULL,NULL),  -- high | SEEDED AS SUMMER SQUASH. Both live plantings are summer types (Dark Green ...
  ('strawberry','repeat',2,48,28,NULL,NULL),  -- medium | Every-other-day picking through the flush. Over-ripe fruit molds on the pl...
  ('sweet_potato','single',NULL,336,NULL,NULL,NULL),  -- medium | Terminal dig, and the horizon is FROST-bounded rather than quality-bounded...
  ('tarragon','cut_and_come_again',18,48,NULL,NULL,NULL),  -- medium | French tarragon. Semi-woody; flavor is strongest in early summer and fades...
  ('thyme','cut_and_come_again',21,96,NULL,NULL,NULL),  -- high | Woody, slow-regrowing. Never cut into old wood.
  ('tomatillo','repeat',3,96,30,NULL,NULL),  -- medium | Ready when the husk splits/fills. Drops to the ground when over-ripe; grou...
  ('tomato','repeat',3,72,45,NULL,NULL),  -- medium | set->pick is size-dependent: cherry ~30d, slicer ~45d, beefsteak/large hei...
  ('watermelon','single',NULL,240,45,NULL,NULL),  -- medium | No slip cue — readiness is the dried tendril + ground-spot color. Over-rip...
  ('wineberry','repeat',2,48,30,NULL,NULL)   -- medium | Rubus phoenicolasius; behaves as a raspberry, ripening mid-July onward in ...
)
UPDATE public.crop_types c
   SET harvest_habit            = s.harvest_habit,
       repeat_interval_days     = s.repeat_interval_days::smallint,
       loss_horizon_hours       = s.loss_horizon_hours::smallint,
       set_to_first_pick_days   = s.set_to_first_pick_days::smallint,
       harvest_season_start_doy = s.harvest_season_start_doy::smallint,
       harvest_season_end_doy   = s.harvest_season_end_doy::smallint,
       updated_at               = now()
  FROM seed s
 WHERE c.slug = s.slug
   AND c.deleted_at IS NULL
   AND c.harvest_habit IS NULL;   -- first-write-wins: never clobber a hand correction

INSERT INTO public.schema_version (version, description)
VALUES ('4.15.1-harvattr-seed-001','HARVATTR data seed: harvest_habit/repeat_interval_days/loss_horizon_hours/set_to_first_pick_days/harvest_season_{start,end}_doy for 51 harvested crop_types, zone 5b western MA. Generated from src/data/harvest-attributes-v1.json (garden.harvest_attributes.v1). DOY windows set ONLY for asparagus (crown damage after ~Jun 15) and garlic (storage-quality lift window). Ornamentals/houseplants/avocado/bee_balm and 14 unplanted edible slugs left NULL by design. Idempotent, first-write-wins (guarded harvest_habit IS NULL).')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================================
-- ADDENDUM 2026-08-18 (V4-BEEBALMFLIP-001) — bee_balm row added, this file now seeds 52.
--
-- This file self-describes (line 7-9 above) as MECHANICALLY GENERATED from
-- src/data/harvest-attributes-v1.json, and src/__tests__/harvestAttributesSync.test.js asserts
-- set-equality between the JSON's by_crop_type and this file's seed VALUES block — it is the
-- ONLY SQL file that test reads. When bee_balm moved from harvest-attributes-v1.json's
-- not_harvest_tracked (conditional NULL) into by_crop_type (seeded), this file was regenerated
-- to match, per this file's own convention. The historical schema_version INSERT immediately
-- above is UNCHANGED and NOT re-run (ON CONFLICT DO NOTHING; '4.15.1-harvattr-seed-001' is
-- already applied) — its description text still describes the original 51-row, bee_balm-NULL
-- seed and is left as an accurate record of what that specific INSERT actually wrote historically.
--
-- The ACTUAL DB write for bee_balm's two columns is NOT this file — it is
-- migrations/v4-beebalmflip-001/0a-data.sql, a separate, independently gated, Dave-approved
-- migration with its own schema_version row ('4.34.0-beebalmflip-001'). This file's UPDATE...FROM
-- seed statement above is idempotent and guarded (`c.harvest_habit IS NULL`), so if this file
-- were ever re-run in an environment where v4-beebalmflip-001 has NOT yet been applied, it would
-- ALSO correctly seed bee_balm with the same values — the two migrations cannot conflict, only
-- race harmlessly to the same first-write-wins result. Do not re-run this file as a way to apply
-- the bee_balm flip; use migrations/v4-beebalmflip-001/ so the change is tracked, gated, and
-- rollback-able on its own.
-- ============================================================================
