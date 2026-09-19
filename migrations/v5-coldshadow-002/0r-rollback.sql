-- 0r-rollback.sql — v5-coldshadow-002
-- Reverses 0a. Nothing is forced: each statement removes the `cold` key ONLY from the one row 0a targets,
-- ONLY while that key still holds exactly the value 0a wrote, and ONLY while this migration's stamp
-- exists — so running this without 0a, or twice, matches nothing, and a cold block anyone has curated
-- since (a different threshold) survives.
--
-- The inverse of "add one key" is "remove that key", nothing else: `profile - 'cold'` returns each row to
-- the 8 keys it had before, byte-identical (the md5 in the gates.yml pre gate is the one the post receipt
-- checks after the apply).
--
-- WHAT ROLLING BACK COSTS, stated plainly: the eight plantings go back to no bring-inside card at any
-- temperature, except Spider Plant, which goes back to the crop-type fallback's 45F. The frost email is
-- not affected either way. This exists to unwind a bad apply, not for tidiness.
--
-- CODE IS NOT A PRECONDITION: no code change shipped with this migration.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

UPDATE public.care_profile
   SET profile = profile - 'cold', updated_at = now()
 WHERE id = '9548b3f2-e86c-435e-8ef2-28f5d0e8aa8c'
   AND scope = 'cultivar' AND scope_id = '3db84405-1941-4e88-bb77-58595f47c3e7'   -- Cobaea scandens (Violet)
   AND profile->'cold' = '{"tender": true, "protect_below_F": 40}'::jsonb
   AND EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-coldshadow-002');

UPDATE public.care_profile
   SET profile = profile - 'cold', updated_at = now()
 WHERE id = '04554719-e633-44d7-8791-f3e33c90ed2d'
   AND scope = 'cultivar' AND scope_id = 'ba53f113-9903-449d-81b9-7dce30ef3934'   -- Easy Wave Berry Velour
   AND profile->'cold' = '{"tender": true, "protect_below_F": 35}'::jsonb
   AND EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-coldshadow-002');

UPDATE public.care_profile
   SET profile = profile - 'cold', updated_at = now()
 WHERE id = '2d2bc039-58e4-4ce7-8930-e58a66c4cd5a'
   AND scope = 'cultivar' AND scope_id = 'd3101ac0-fd4e-456e-86b7-ebea732ac84c'   -- Jewel Mix Nasturtium
   AND profile->'cold' = '{"tender": true, "protect_below_F": 32}'::jsonb
   AND EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-coldshadow-002');

UPDATE public.care_profile
   SET profile = profile - 'cold', updated_at = now()
 WHERE id = '315a0e95-0469-4b88-9647-5662c0edc884'
   AND scope = 'cultivar' AND scope_id = 'f46745bf-c77e-4f42-b939-5363378a035e'   -- Petunia
   AND profile->'cold' = '{"tender": true, "protect_below_F": 35}'::jsonb
   AND EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-coldshadow-002');

UPDATE public.care_profile
   SET profile = profile - 'cold', updated_at = now()
 WHERE id = '54187824-9ea7-4c5c-9fbf-da5f2326b84e'
   AND scope = 'cultivar' AND scope_id = '4379ae45-51ac-49f2-8205-aea13c3c64ad'   -- Silver (Licorice Plant)
   AND profile->'cold' = '{"tender": true, "protect_below_F": 40}'::jsonb
   AND EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-coldshadow-002');

UPDATE public.care_profile
   SET profile = profile - 'cold', updated_at = now()
 WHERE id = '241d3455-8961-4c8c-a7ab-4a73e84fc002'
   AND scope = 'cultivar' AND scope_id = 'ece82bf2-6a60-4186-b031-64af0519aa49'   -- Spider Plant
   AND profile->'cold' = '{"tender": true, "protect_below_F": 50}'::jsonb
   AND EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-coldshadow-002');

UPDATE public.care_profile
   SET profile = profile - 'cold', updated_at = now()
 WHERE id = 'f9a3ca14-5a9e-4cd9-8294-babd6e90279f'
   AND scope = 'cultivar' AND scope_id = 'eb7e7347-26f2-42aa-b042-967511a31c0d'   -- Sunny Susy White Halo
   AND profile->'cold' = '{"tender": true, "protect_below_F": 45}'::jsonb
   AND EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-coldshadow-002');

UPDATE public.care_profile
   SET profile = profile - 'cold', updated_at = now()
 WHERE id = '19c81d1a-c313-4ae2-bc82-5069eee72fe6'
   AND scope = 'cultivar' AND scope_id = 'a3d41b0a-f79e-4301-b710-587b6d8544bf'   -- Wishbone Flower
   AND profile->'cold' = '{"tender": true, "protect_below_F": 45}'::jsonb
   AND EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-coldshadow-002');

DELETE FROM public.schema_version WHERE version = '5.0.0-coldshadow-002';

-- Report what survived, so a partial rollback is visible rather than silent. After a clean rollback on
-- prod: every cold_now NULL and every md5_now equal to md5_before (the pre-apply rows).
SELECT v.variety, cp.profile->'cold' AS cold_now, md5(cp.profile::text) AS md5_now, v.md5_before
  FROM (VALUES
         ('9548b3f2-e86c-435e-8ef2-28f5d0e8aa8c', 'Cobaea scandens (Violet)', 'be58c910eab3470432bdb296f2030a59'),
         ('04554719-e633-44d7-8791-f3e33c90ed2d', 'Easy Wave Berry Velour', '3b18f320614cab469d3d77b307fbf342'),
         ('2d2bc039-58e4-4ce7-8930-e58a66c4cd5a', 'Jewel Mix Nasturtium', 'b28ed671a8f656396c90e430f4cabe8a'),
         ('315a0e95-0469-4b88-9647-5662c0edc884', 'Petunia', '3b18f320614cab469d3d77b307fbf342'),
         ('54187824-9ea7-4c5c-9fbf-da5f2326b84e', 'Silver (Licorice Plant)', 'a47d1659be4e527f5cbdbca0036dd13a'),
         ('241d3455-8961-4c8c-a7ab-4a73e84fc002', 'Spider Plant', 'fcfeab4ddf82c6c28c6897def61fb06f'),
         ('f9a3ca14-5a9e-4cd9-8294-babd6e90279f', 'Sunny Susy White Halo', '5307458bac412b8785a7eb669f632a72'),
         ('19c81d1a-c313-4ae2-bc82-5069eee72fe6', 'Wishbone Flower', '3e69cae72b72b3918608ece93b07cde2')
       ) AS v(row_id, variety, md5_before)
  LEFT JOIN public.care_profile cp ON cp.id = v.row_id::uuid
 ORDER BY v.variety;

COMMIT;
