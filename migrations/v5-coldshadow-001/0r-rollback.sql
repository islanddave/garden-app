-- 0r-rollback.sql — v5-coldshadow-001
-- Reverses 0a. Nothing is forced: each statement removes the `cold` key ONLY from the two rows 0a
-- targets, ONLY while that key still holds exactly the value 0a wrote, and ONLY while this migration's
-- stamp exists — so running this without 0a, or twice, matches nothing, and a cold block anyone has
-- curated since (a different threshold) survives.
--
-- The inverse of "add one key" is "remove that key", nothing else: `profile - 'cold'` returns the row
-- to the 13 keys it had before, byte-identical (the md5 in gates.yml pre gates is the same one the
-- post receipt checks after the apply).
--
-- WHAT ROLLING BACK COSTS, stated plainly: Graptosedum and Pachyphytum go back to no bring-inside card
-- at any temperature, and the frost email goes back to counting them inside "unclassified (treated as
-- tender)" — named, same trip temperatures. This exists to unwind a bad apply, not for tidiness.
--
-- CODE IS NOT A PRECONDITION: no code change shipped with this migration.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

UPDATE public.care_profile
   SET profile = profile - 'cold', updated_at = now()
 WHERE id = 'bdbf05dd-0239-4ac0-b0d1-b0cbc816a62c'
   AND scope = 'cultivar' AND scope_id = 'f4919a6f-eb7e-4c03-bc0f-b158f8ef51fd'   -- Graptosedum
   AND profile->'cold' = '{"tender": true, "protect_below_F": 40}'::jsonb
   AND EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-coldshadow-001');

UPDATE public.care_profile
   SET profile = profile - 'cold', updated_at = now()
 WHERE id = '5a179436-7feb-4e3d-9f29-bbf5272b9414'
   AND scope = 'cultivar' AND scope_id = 'b3666254-9b71-478b-bf9e-2f2bb97dd8a9'   -- Pachyphytum
   AND profile->'cold' = '{"tender": true, "protect_below_F": 40}'::jsonb
   AND EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-coldshadow-001');

DELETE FROM public.schema_version WHERE version = '5.0.0-coldshadow-001';

-- Report what survived, so a partial rollback is visible rather than silent. After a clean rollback on
-- prod: both *_cold_now NULL and both *_md5_now 5a9cf94b4257eaed1cbf17042cc9387a (the pre-apply rows).
SELECT
  (SELECT profile->'cold' FROM public.care_profile
     WHERE id = 'bdbf05dd-0239-4ac0-b0d1-b0cbc816a62c')          AS graptosedum_cold_now,
  (SELECT md5(profile::text) FROM public.care_profile
     WHERE id = 'bdbf05dd-0239-4ac0-b0d1-b0cbc816a62c')          AS graptosedum_md5_now,
  (SELECT profile->'cold' FROM public.care_profile
     WHERE id = '5a179436-7feb-4e3d-9f29-bbf5272b9414')          AS pachyphytum_cold_now,
  (SELECT md5(profile::text) FROM public.care_profile
     WHERE id = '5a179436-7feb-4e3d-9f29-bbf5272b9414')          AS pachyphytum_md5_now;

COMMIT;
