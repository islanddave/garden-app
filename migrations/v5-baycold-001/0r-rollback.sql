-- 0r-rollback.sql — v5-baycold-001
-- Reverses 0a. Nothing is forced: the statement removes the `cold` key ONLY from the one row 0a targets,
-- ONLY while that key still holds exactly the value 0a wrote, and ONLY while this migration's stamp
-- exists — so running this without 0a, or twice, matches nothing, and a cold block anyone has curated
-- since (a different threshold) survives.
--
-- The inverse of "add one key" is "remove that key", nothing else: `profile - 'cold'` returns the row to
-- the 8 keys it had before, byte-identical (the md5 in the gates.yml pre gate is the one the post receipt
-- checks after the apply).
--
-- WHAT ROLLING BACK COSTS, stated plainly: the Sweet Bay Laurel goes back to no bring-inside card at any
-- temperature, and the frost email goes back to counting it as "unclassified" instead of naming it. The
-- nights the email fires are the same either way. This exists to unwind a bad apply, not for tidiness.
--
-- CODE IS NOT A PRECONDITION: no code change shipped with this migration.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

UPDATE public.care_profile
   SET profile = profile - 'cold', updated_at = now()
 WHERE id = 'd4c8c7e3-320c-4019-8827-b39894cf02b8'
   AND scope = 'cultivar' AND scope_id = 'e890276d-43e6-41cd-9dfe-1fa8e05fcfc1'   -- Sweet Bay
   AND profile->'cold' = '{"tender": true, "protect_below_F": 32}'::jsonb
   AND EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-baycold-001');

DELETE FROM public.schema_version WHERE version = '5.0.0-baycold-001';

-- Report what survived, so a partial rollback is visible rather than silent. After a clean rollback on
-- prod: cold_now NULL and md5_now equal to md5_before (the pre-apply row). On a database without the row
-- (staging, if it does not carry it) cold_now and md5_now are both NULL.
SELECT v.variety, cp.profile->'cold' AS cold_now, md5(cp.profile::text) AS md5_now, v.md5_before
  FROM (VALUES
         ('d4c8c7e3-320c-4019-8827-b39894cf02b8', 'Sweet Bay', 'ae1f9608920cf706635dc726cdd44fe8')
       ) AS v(row_id, variety, md5_before)
  LEFT JOIN public.care_profile cp ON cp.id = v.row_id::uuid
 ORDER BY v.variety;

COMMIT;
