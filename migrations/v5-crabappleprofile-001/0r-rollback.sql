-- 0r-rollback.sql — v5-crabappleprofile-001
-- Reverses 0a. Nothing is forced. Each statement matches ONLY the row 0a targets, ONLY while that row
-- still holds exactly what 0a wrote, and ONLY while this migration's stamp exists — so running this
-- without 0a, or twice, matches nothing, and anything curated since (a different interval, an edited
-- note, a habit Dave set himself) survives.
--
-- CADENCE: the inverse of "replace the placeholder" is "put the placeholder back". The literal below is
-- the three-key row lambda/varieties/index.js NEW_CULTIVAR_PROFILE wrote, byte for byte: jsonb text is
-- canonical, so md5(profile::text) returns to d5335984e4af2339fe6ee7b4f4946436, the value the gates.yml
-- pre gate pins (lambda/daily-plan/crabappleprofile.test.js hashes this literal and fails if it stops
-- matching). It is dollar-quoted because the text carries \" escapes, which a dollar-quoted body passes
-- through whatever standard_conforming_strings is set to. The one non-ASCII character in the stored text,
-- an em dash, is written as its JSON unicode escape (backslash, u, 2014), so the literal is pure ASCII and
-- no client encoding can change what it restores; jsonb stores the character itself either way.
-- HABIT: 'single' goes back to NULL.
--
-- WHAT ROLLING BACK COSTS, stated plainly: the tree goes back to the bundled 3-day watering default and
-- loses its no-feed mark, and both gates this migration cleared go red again on the next run
-- (v4-cadencerefill-001 post_no_live_planting_rests_on_an_unresearched_placeholder and v4-harvhabitgap-001
-- post_every_null_habit_is_a_recorded_decision). This exists to unwind a bad apply, not for tidiness.
--
-- ONE EDGE, ruled out on prod by the pre gates: on a database where crabapple already read 'single'
-- before 0a ran, 0a's IS NULL guard wrote nothing but still stamped, and this file would then clear a
-- habit 0a did not write.
--
-- CODE IS NOT A PRECONDITION: the frostClass.js banding and the seed row that shipped beside this
-- migration do not read either value.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

UPDATE public.care_profile
   SET profile = $placeholder${"notes": "Auto-created with the cultivar so its variety has a cadence profile row (DRG-CADENCEFLOOR-001). Carries NO watering keys, so cadence still resolves through the bundled fallback exactly as it did before. _basis:\"unresearched\" means NOBODY HAS DECIDED YET \u2014 the opposite of a deliberately watering-free row like Collards.", "_basis": "unresearched", "_source": "cultivar-create"}$placeholder$::jsonb,
       updated_at = now()
 WHERE id = 'c59f1b2f-fec6-4e17-aea5-5260700f1235'
   AND scope = 'cultivar' AND scope_id = '2680ddd1-9f6a-400b-9c3b-2645fb4a39a8'   -- Crabapple
   AND profile = '{
         "crop": "crabapple tree", "_tier": "P", "confidence": "low",
         "_basis": "dave_decision", "_source": "v5-crabappleprofile-001",
         "water_method": "rainfall_only",
         "no_calendar_water": true, "no_calendar_feed": true,
         "water_interval_days_inground": 14, "water_interval_days_container": 14,
         "notes": "The mature in-ground crabapple at the site, cultivar not identified. This profile belongs to that one tree, not to crabapples in general. Deliberately unmanaged, rainfall only, the same class as the Peach tree: no_calendar_water suppresses routine watering tasks and no_calendar_feed suppresses routine feeding tasks. Both are decisions Dave made on 2026-10-09, not measurements. The 14-day interval is a fallback copied from the Peach tree row so that the engine adopts this profile. It is never expected to fire. If the tree is identified and re-pointed to a named cultivar, this profile has to move with it."
       }'::jsonb
   AND EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-crabappleprofile-001');

UPDATE public.crop_types
   SET harvest_habit = NULL,
       updated_at    = now()
 WHERE slug = 'crabapple'
   AND deleted_at IS NULL
   AND harvest_habit = 'single'
   AND EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-crabappleprofile-001');

DELETE FROM public.schema_version WHERE version = '5.0.0-crabappleprofile-001';

-- Report what survived, so a partial rollback is visible rather than silent. After a clean rollback on
-- prod: basis_now 'unresearched', md5_now equal to md5_before, habit_now NULL. On a database without the
-- rows (staging) basis_now, md5_now and habit_now are all NULL.
SELECT v.variety,
       cp.profile->>'_basis' AS basis_now,
       md5(cp.profile::text) AS md5_now,
       v.md5_before,
       ct.harvest_habit      AS habit_now
  FROM (VALUES
         ('c59f1b2f-fec6-4e17-aea5-5260700f1235', 'Crabapple', 'd5335984e4af2339fe6ee7b4f4946436', 'crabapple')
       ) AS v(row_id, variety, md5_before, slug)
  LEFT JOIN public.care_profile cp ON cp.id = v.row_id::uuid
  LEFT JOIN public.crop_types ct ON ct.slug = v.slug AND ct.deleted_at IS NULL
 ORDER BY v.variety;

COMMIT;
