-- V4-HARVHABITGAP-001 — bee_balm: harvest_habit NULL -> cut_and_come_again, repeat_interval_days 14.
--
-- DATA ONLY. No DDL, no view change, no code change, no deploy. crop_types.harvest_habit is read
-- client-side (src/lib/harvestReadiness.js) and by lambda/harvests/watch.js, both of which already
-- handle this vocabulary, so the value takes effect with no promote.
--
-- THIS EXECUTES A PRE-AUTHORED CONDITION; IT DOES NOT MAKE A NEW HORTICULTURAL CALL. The values are
-- transcribed from src/data/harvest-attributes-v1.json's not_harvest_tracked.contested entry, which
-- has read since 2026-07-21:
--
--   "bee_balm": "Monarda is a real culinary/tea herb (category='herb' in the vocab) but is grown
--    here as a pollinator ornamental. Left NULL per brief; flip to cut_and_come_again/14d if Dave
--    actually picks it."
--
-- He has. The Wild Bergamot planting carries 1 harvest event — which is also the "1 of 51" in
-- lambda/harvests/watch.js:24's "51 live plantings with harvest_habit IS NULL, of which 50 have
-- zero picks". So the condition is MET and the answer was already written down. Nothing here was
-- decided by the session that wrote this file.
--
-- WHY A SEPARATE MIGRATION RATHER THAN A RE-RUN OF v4-harvattr-001/0b-data.sql. Both work — 0b is
-- idempotent and first-write-wins (`AND c.harvest_habit IS NULL`), so re-running it after the
-- authoring JSON gained bee_balm applies exactly this one row and nothing else. 0b DID gain that
-- row in the same commit, because the sync gate (src/__tests__/harvestAttributesSync.test.js)
-- requires the JSON and the seed to agree. This file exists because 0b has ALREADY been applied to
-- both environments, so "re-run 0b" is an instruction someone has to know about and remember;
-- a dated migration directory is the discoverable, gated vehicle. Applying either one, or both in
-- either order, converges: this UPDATE carries the same IS NULL guard.
--
-- WHAT IT CHANGES FOR THE USER: bee_balm becomes eligible for the harvest-readiness band on a 14-day
-- cadence, and — the cost, stated rather than discovered — populating a habit REMOVES the displayed
-- harvest-end-date estimate for that planting (src/lib/plantingMaturity.js:68). One live planting.
--
-- SCOPE: exactly one crop_types row. The three other slugs in V4-HARVHABITGAP-001 (aloe,
-- calibrachoa, lantana) are LIST changes only — they stay deliberately NULL — and ginger is
-- recorded in establishing_not_yet_harvestable, also deliberately NULL. None of them is touched
-- here, and no other habit-NULL crop becomes seeded by this file.
--
-- Usage: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 0a-data.sql

BEGIN;

-- Scoped by slug, matching v4-harvattr-001/0b-data.sql (the crop_types vocabulary is slug-keyed and
-- slug is unique among live rows). The IS NULL guard is the same first-write-wins convention: a
-- re-run, or an environment where 0b was re-run first, is a clean no-op and no hand correction is
-- ever clobbered.
UPDATE public.crop_types
   SET harvest_habit        = 'cut_and_come_again',
       repeat_interval_days = 14::smallint,
       updated_at           = now()
 WHERE slug = 'bee_balm'
   AND deleted_at IS NULL
   AND harvest_habit IS NULL;

-- loss_horizon_hours, set_to_first_pick_days and the DOY bounds are DELIBERATELY not written. The
-- pre-authored condition named a habit and a cadence; NULL means UNKNOWN and no predicate may fire
-- on it, and loss_horizon_hours has no runtime consumer at all (it records post-harvest shelf life,
-- cf. lambda/harvests/watch.js:88). Writing a number would be inventing one.

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('4.35.0-harvhabitgap-001',
        'HARVHABITGAP: bee_balm harvest_habit NULL -> cut_and_come_again, repeat_interval_days 14. '
        'Executes the pre-authored condition recorded in harvest-attributes-v1.json since '
        '2026-07-21 ("flip to cut_and_come_again/14d if Dave actually picks it") — the Wild '
        'Bergamot planting carries 1 harvest event, so the condition fired. Not a new call. '
        'loss_horizon_hours/set_to_first_pick/DOY stay NULL: the condition named neither, and NULL '
        'is UNKNOWN. One row, guarded harvest_habit IS NULL (first-write-wins). Data only: no DDL, '
        'no view, no deploy.',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;

COMMIT;
