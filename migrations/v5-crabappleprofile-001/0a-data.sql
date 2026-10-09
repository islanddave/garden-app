-- 0a-data.sql
-- v5-crabappleprofile-001 — the site crabapple gets a decided care profile and a decided harvest habit.
-- Two writes, one transaction, both Dave's decisions of 2026-10-09 (DATA-CRABAPPLEPROFILE-001):
--   CADENCE  the cultivar care profile stops being the create-time placeholder and becomes the Peach
--            tree's shape: no calendar watering, no calendar feeding, rainfall only.
--   HABIT    crop_types.harvest_habit for `crabapple` goes NULL -> 'single'.
--
-- NOT APPLIED as of authoring (2026-10-09, lane crabprofile). No statement in this directory has run
-- against staging or prod. Apply order: README.md.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0a-data.sql
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- THE DEFECT, read on prod 2026-10-09 ~12:30 ET (read-only role) and traced in source at dev e0894f51
--
-- The crabapple was entered in the app on 2026-10-09 (crop type minted 12:23:48Z). The create path
-- gives a new cultivar a placeholder care profile and a new crop type no harvest habit, so two standing
-- gates went red, each by design:
--   v4-cadencerefill-001 :: post_no_live_planting_rests_on_an_unresearched_placeholder
--       the cultivar row says _basis "unresearched" and v_resolved_care.cadence_scopes is {} for the
--       planting, so nothing in the database holds an opinion and the engine resolves the bundled
--       default for a mature tree in the ground: a 3-day watering interval (inferred from source and
--       cadence-data-v2.json; the prod plan row was not read).
--   v4-harvhabitgap-001 :: post_every_null_habit_is_a_recorded_decision
--       crabapple's harvest_habit is NULL and the slug is on none of the three recorded-NULL lists.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- THE ROWS
--
--   care_profile c59f1b2f-fec6-4e17-aea5-5260700f1235  cultivar scope (care_scope = system | cultivar | leaf)
--       cultivar "Crabapple" (2680ddd1…), genus Malus, crop type crabapple
--       -> Crabapple (fbf317f9…), in_ground, Drive (not covered, not heated), status harvested
--       md5(profile::text) at authoring = d5335984e4af2339fe6ee7b4f4946436: the three-key placeholder
--       lambda/varieties/index.js NEW_CULTIVAR_PROFILE writes (notes, _basis "unresearched", _source
--       "cultivar-create"). That constant, rendered as jsonb text, hashes to the same value, so the row
--       is the placeholder byte for byte. No leaf-scope row exists on the planting.
--   crop_types slug crabapple  display_name Crabapple, category tree, default_lifecycle perennial,
--       harvest_habit NULL, repeat_interval_days NULL.
--
-- A cultivar row reaches every planting of its variety: this one reaches exactly that one planting.
-- THE CULTIVAR IS NOT IDENTIFIED (Knowledge Library f-6f276f54, 2026-10-09). "Crabapple" is a stand-in
-- name, so the profile's note says it belongs to the mature tree at the site, not to crabapples.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- THE CADENCE HALF — what is written, and why each key
--
-- The model is the in-ground Peach tree (care_profile d9690105…, _tier P): deliberately unmanaged,
-- rainfall only. Dave, 2026-10-09: no watering reminders and never feed, "same as the Peach tree".
--   no_calendar_water true   engine.waterSuppression: the planting leaves water_due / no_history /
--                            rain_skipped and is listed under dormancy_suppressed with its reason.
--   no_calendar_feed true    engine.feedSuppression: fertilizeRec returns no card; listed under
--                            feed_suppressed.
--   water_method             rainfall_only, the Peach's value. Descriptive: it rides on a watering card,
--                            and suppression means there is none.
--   water_interval_days_inground / _container  14, the Peach's fallback. NOT what suppresses. Both
--                            suppression reads take the RAW database profile (engine.js: srcs = [c,
--                            p.db_cadence]; handler.js selects vrc.resolved_profile as db_cadence on
--                            every row), so the two keys above work with no interval at all and with
--                            CARE_CADENCE_SCOPES_ENABLED on or off. What the interval does: a non-null
--                            water_interval_days* key is the only thing that puts 'cultivar' in
--                            v_resolved_care.cadence_scopes (v4-seededgate-001/0a-view.sql), and the
--                            engine adopts a database profile whole only then. Adopted, the plan row
--                            carries this row's own crop label, and if no_calendar_water is ever removed
--                            the tree falls to 14 days rather than the 3-day house default. It is never
--                            expected to fire. Nothing bundled is shadowed by adopting: cadence-data-v2
--                            has no Crabapple variety, no Malus genus entry, and its default has no cold.
--   crop, _tier              "crabapple tree" and "P", the Peach's labels for the legacy in-ground class.
--   _basis, confidence       "dave_decision" and "low": the v4-cadencerefill-001 label for a ratified
--                            judgement. Nothing here is a measurement. _basis leaving "unresearched" is
--                            also what the placeholder gate reads.
--   _source                  names this migration.
-- NOT WRITTEN: `cold` (the crop type is banded hardy in frostClass.js by the same change, and a hardy
-- tree in the ground gets no bring-in card); drought_tolerance (the Peach carries "high", but nobody
-- decided it for this tree and its one reader is on the branch suppression closes);
-- fertilize_interval_days (no_calendar_feed is read first and wins).
--
-- A WHOLE-OBJECT REPLACE, on purpose, and not the single-key jsonb_set of v5-coldshadow-001 and
-- v5-baycold-001. That method exists to keep keys somebody curated. Here all three keys on the row are
-- machine-written placeholder text and all three are superseded, and the md5 guard below proves nothing
-- else is on the row at the moment of the write. A merge would give the same row and hide that.
--
-- Keyed by care_profile row id AND its (scope, scope_id) pair, guarded on the row still being the exact
-- placeholder: a re-run matches nothing, and a profile anyone has written since is never clobbered. No
-- app route UPDATES an existing cultivar row (the Lambda writers insert a new row with ON CONFLICT DO
-- NOTHING or touch a leaf row's `overwintering` key only), so this file is the path, not a bypass.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- THE HABIT HALF
--
-- Dave, 2026-10-09: track the harvest, ONE gathering per season. He first said "do not track it", then
-- chose this when told a harvest event is already logged on the planting. 'single' is the field
-- contract's value for one harvest; picks are counted per grow year (Nov 1 - Oct 31, watch-route.js).
-- The shape of v4-harvhabitgap-001/0a-data.sql: scoped by slug, guarded harvest_habit IS NULL (first
-- write wins, a re-run is a no-op, a hand-set habit is never clobbered).
-- repeat_interval_days stays NULL: chk_crop_types_repeat_interval forbids 'single' with an interval.
-- loss_horizon_hours, set_to_first_pick_days and the DOY bounds are DELIBERATELY not written, the
-- bee_balm precedent: the decision named a habit and nothing else, NULL means UNKNOWN and no predicate
-- may fire on it. No day-of-year window (Dave: none). first_year_harvest is not touched.
-- The value is also in src/data/harvest-attributes-v1.json by_crop_type and in
-- v4-harvattr-001/0b-data.sql, which harvestAttributesSync.test.js holds equal. crabapple goes on NO
-- recorded-NULL list and is NOT added to src/lib/harvestTracked.js: it is harvest-tracked.
--
-- LANDING ORDER: none. Data only, no DDL. The engine reads both suppression keys today (the Peach tree
-- is listed under dormancy_suppressed and feed_suppressed in the 2026-09-24 prod plan dump,
-- tests/harness/_todaymeasure/dailyplan.dave.json), and the readers of harvest_habit already handle
-- 'single'. The frostClass.js banding in the same change ships with the next promote and neither needs
-- nor is needed by this file. The build running on prod was not read.
--
-- SAFETY: idempotent and non-clobbering. On a database without these rows both UPDATEs match zero rows
-- and only the stamp is written, the safe direction. STAGING HAS NO CRABAPPLE ROWS (the crop type was
-- minted in the app on prod on 2026-10-09): expect UPDATE 0, UPDATE 0, INSERT 0 1 there. If the staging
-- branch has been re-cut from prod since, expect UPDATE 1, UPDATE 1. Both are correct. On PROD the file
-- must print UPDATE 1, UPDATE 1: an UPDATE 0 there means the wrong host or a changed row, and the stamp
-- has still committed — run 0r, then read the pre gates.
-- ROLLBACK: 0r-rollback.sql.

BEGIN;

UPDATE public.care_profile
   SET profile = '{
         "crop": "crabapple tree", "_tier": "P", "confidence": "low",
         "_basis": "dave_decision", "_source": "v5-crabappleprofile-001",
         "water_method": "rainfall_only",
         "no_calendar_water": true, "no_calendar_feed": true,
         "water_interval_days_inground": 14, "water_interval_days_container": 14,
         "notes": "The mature in-ground crabapple at the site, cultivar not identified. This profile belongs to that one tree, not to crabapples in general. Deliberately unmanaged, rainfall only, the same class as the Peach tree: no_calendar_water suppresses routine watering tasks and no_calendar_feed suppresses routine feeding tasks. Both are decisions Dave made on 2026-10-09, not measurements. The 14-day interval is a fallback copied from the Peach tree row so that the engine adopts this profile. It is never expected to fire. If the tree is identified and re-pointed to a named cultivar, this profile has to move with it."
       }'::jsonb,
       updated_at = now()
 WHERE id = 'c59f1b2f-fec6-4e17-aea5-5260700f1235'
   AND scope = 'cultivar' AND scope_id = '2680ddd1-9f6a-400b-9c3b-2645fb4a39a8'   -- Crabapple -> the site crabapple
   AND md5(profile::text) = 'd5335984e4af2339fe6ee7b4f4946436';

UPDATE public.crop_types
   SET harvest_habit = 'single',
       updated_at    = now()
 WHERE slug = 'crabapple'
   AND deleted_at IS NULL
   AND harvest_habit IS NULL;

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('5.0.0-crabappleprofile-001',
        'CRABAPPLEPROFILE-001 (data-only, no DDL). (1) Replaces the cultivar-create placeholder on the '
        'Crabapple cultivar care_profile row with a decided profile in the Peach tree shape: '
        'no_calendar_water, no_calendar_feed, rainfall only, a 14-day fallback interval so the engine '
        'adopts it, _basis dave_decision. Whole-object replace keyed by row id and guarded on the md5 of '
        'the placeholder. No cold key. (2) crop_types crabapple harvest_habit NULL -> single, guarded '
        'IS NULL; interval, loss horizon, set-to-pick and DOY stay NULL. Dave decisions 2026-10-09 (no '
        'watering reminders, never feed, track the harvest as one gathering per season). Reversible '
        'via 0r.',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;

COMMIT;
