-- 0r-rollback.sql — v5-feedinherit-001
-- Reverses 0a. Nothing is forced: each statement removes `fertilize_interval_days` ONLY from the one row
-- 0a targets, ONLY while that key still holds exactly the value 0a wrote, and ONLY while this migration's
-- stamp exists — so running this without 0a, or twice, matches nothing, and an interval anyone has set
-- since (a different number) survives.
--
-- The inverse of "add one key" is "remove that key", nothing else: `profile - 'fertilize_interval_days'`
-- returns each row to the 8 or 9 keys it had before, byte-identical (the md5 in the gates.yml pre gate is
-- the one the post receipt checks after the apply, and the one the report below compares against).
--
-- WHAT ROLLING BACK COSTS, stated plainly: the 21 plantings go back to the house default, a feed card
-- every 14 days. This exists to unwind a bad apply, not for tidiness.
--
-- CODE IS NOT A PRECONDITION: no code change shipped with this migration.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

UPDATE public.care_profile
   SET profile = profile - 'fertilize_interval_days', updated_at = now()
 WHERE id = '58586ba5-7080-469d-bf77-3f5746cd2132'
   AND scope = 'cultivar' AND scope_id = 'a11dd600-84b4-4bd6-8611-f85336bc3c2e'   -- Alaska Mix
   AND profile->'fertilize_interval_days' = '45'::jsonb
   AND EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-feedinherit-001');

UPDATE public.care_profile
   SET profile = profile - 'fertilize_interval_days', updated_at = now()
 WHERE id = 'cf4e17cf-d3da-46c9-bf71-a014f35bf2ad'
   AND scope = 'cultivar' AND scope_id = 'b11814aa-83ed-48e4-882d-a6709e42572f'   -- Chrysanthemum
   AND profile->'fertilize_interval_days' = '28'::jsonb
   AND EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-feedinherit-001');

UPDATE public.care_profile
   SET profile = profile - 'fertilize_interval_days', updated_at = now()
 WHERE id = '834a3a15-bd59-4801-ac2d-1d58bc0c79a3'
   AND scope = 'cultivar' AND scope_id = '1b2b7bf8-0d9e-4c39-b7d7-0acd744f16f7'   -- Clemson Spineless 80
   AND profile->'fertilize_interval_days' = '21'::jsonb
   AND EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-feedinherit-001');

UPDATE public.care_profile
   SET profile = profile - 'fertilize_interval_days', updated_at = now()
 WHERE id = '9548b3f2-e86c-435e-8ef2-28f5d0e8aa8c'
   AND scope = 'cultivar' AND scope_id = '3db84405-1941-4e88-bb77-58595f47c3e7'   -- Cobaea scandens (Violet)
   AND profile->'fertilize_interval_days' = '21'::jsonb
   AND EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-feedinherit-001');

UPDATE public.care_profile
   SET profile = profile - 'fertilize_interval_days', updated_at = now()
 WHERE id = 'e43739f4-75a6-4ae4-a673-1a8aef0e0f0b'
   AND scope = 'cultivar' AND scope_id = 'd9eba456-0836-4690-b3db-02aa0fb4fb1b'   -- Contender
   AND profile->'fertilize_interval_days' = '30'::jsonb
   AND EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-feedinherit-001');

UPDATE public.care_profile
   SET profile = profile - 'fertilize_interval_days', updated_at = now()
 WHERE id = 'f807599b-f4d4-4fff-9703-ff21cbf9981f'
   AND scope = 'cultivar' AND scope_id = '219329ac-66f3-4c25-8a46-6246bb91c858'   -- Dwarf Blue Curled (Vates)
   AND profile->'fertilize_interval_days' = '21'::jsonb
   AND EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-feedinherit-001');

UPDATE public.care_profile
   SET profile = profile - 'fertilize_interval_days', updated_at = now()
 WHERE id = '04554719-e633-44d7-8791-f3e33c90ed2d'
   AND scope = 'cultivar' AND scope_id = 'ba53f113-9903-449d-81b9-7dce30ef3934'   -- Easy Wave Berry Velour
   AND profile->'fertilize_interval_days' = '7'::jsonb
   AND EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-feedinherit-001');

UPDATE public.care_profile
   SET profile = profile - 'fertilize_interval_days', updated_at = now()
 WHERE id = 'f86d0c66-7b6d-4a8e-b9de-0132d9e3332a'
   AND scope = 'cultivar' AND scope_id = 'c94e3179-b14a-4707-8ca2-1305dd0946dc'   -- Foxglove
   AND profile->'fertilize_interval_days' = '30'::jsonb
   AND EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-feedinherit-001');

UPDATE public.care_profile
   SET profile = profile - 'fertilize_interval_days', updated_at = now()
 WHERE id = '13bcffdc-ac3d-4294-a6a9-b887aa76584e'
   AND scope = 'cultivar' AND scope_id = '450c3391-b809-43e5-b7ae-de16b9cce431'   -- Gold Rush
   AND profile->'fertilize_interval_days' = '30'::jsonb
   AND EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-feedinherit-001');

UPDATE public.care_profile
   SET profile = profile - 'fertilize_interval_days', updated_at = now()
 WHERE id = '5378c39e-8174-4ce9-85ad-351adc4f1486'
   AND scope = 'cultivar' AND scope_id = '3b986e62-14ca-4262-86bb-eb35c418bd19'   -- Hosta
   AND profile->'fertilize_interval_days' = '45'::jsonb
   AND EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-feedinherit-001');

UPDATE public.care_profile
   SET profile = profile - 'fertilize_interval_days', updated_at = now()
 WHERE id = '8cc55d60-10a6-468e-a9af-cfafc7731b65'
   AND scope = 'cultivar' AND scope_id = '055e3ff1-21c0-44ce-bace-d8a900f6145a'   -- Japanese Maple
   AND profile->'fertilize_interval_days' = '60'::jsonb
   AND EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-feedinherit-001');

UPDATE public.care_profile
   SET profile = profile - 'fertilize_interval_days', updated_at = now()
 WHERE id = '2d2bc039-58e4-4ce7-8930-e58a66c4cd5a'
   AND scope = 'cultivar' AND scope_id = 'd3101ac0-fd4e-456e-86b7-ebea732ac84c'   -- Jewel Mix Nasturtium
   AND profile->'fertilize_interval_days' = '45'::jsonb
   AND EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-feedinherit-001');

UPDATE public.care_profile
   SET profile = profile - 'fertilize_interval_days', updated_at = now()
 WHERE id = 'ebf1aab5-4879-4080-a8aa-4e11b454de31'
   AND scope = 'cultivar' AND scope_id = 'b1fad1e2-b2e1-40ee-ab02-1f6cf9a20a6d'   -- Lacinato (Dinosaur)
   AND profile->'fertilize_interval_days' = '21'::jsonb
   AND EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-feedinherit-001');

UPDATE public.care_profile
   SET profile = profile - 'fertilize_interval_days', updated_at = now()
 WHERE id = 'e74d95b7-df0a-4948-9bf2-d5bfd1bbeeea'
   AND scope = 'cultivar' AND scope_id = '72ebf73c-bf46-429a-bb2d-3243e3d0826d'   -- Lemon Verbena
   AND profile->'fertilize_interval_days' = '21'::jsonb
   AND EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-feedinherit-001');

UPDATE public.care_profile
   SET profile = profile - 'fertilize_interval_days', updated_at = now()
 WHERE id = 'c848cd0b-48bf-4622-be46-b65903725bc3'
   AND scope = 'cultivar' AND scope_id = '0609afc2-51ea-4045-858b-fe28060e2f20'   -- Palla Rossa Mavrik
   AND profile->'fertilize_interval_days' = '21'::jsonb
   AND EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-feedinherit-001');

UPDATE public.care_profile
   SET profile = profile - 'fertilize_interval_days', updated_at = now()
 WHERE id = '315a0e95-0469-4b88-9647-5662c0edc884'
   AND scope = 'cultivar' AND scope_id = 'f46745bf-c77e-4f42-b939-5363378a035e'   -- Petunia
   AND profile->'fertilize_interval_days' = '7'::jsonb
   AND EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-feedinherit-001');

UPDATE public.care_profile
   SET profile = profile - 'fertilize_interval_days', updated_at = now()
 WHERE id = '1d49baf7-103b-4a65-a6f5-81d1034d36a1'
   AND scope = 'cultivar' AND scope_id = '81924103-2858-408f-991e-aad591827a49'   -- Purple Vienna
   AND profile->'fertilize_interval_days' = '21'::jsonb
   AND EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-feedinherit-001');

UPDATE public.care_profile
   SET profile = profile - 'fertilize_interval_days', updated_at = now()
 WHERE id = 'ae276aeb-95c1-4dd2-8eab-159aa4dfa262'
   AND scope = 'cultivar' AND scope_id = '51da1e31-c16d-4cbc-ac3b-b3c718e7472c'   -- Redbor
   AND profile->'fertilize_interval_days' = '21'::jsonb
   AND EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-feedinherit-001');

UPDATE public.care_profile
   SET profile = profile - 'fertilize_interval_days', updated_at = now()
 WHERE id = '241d3455-8961-4c8c-a7ab-4a73e84fc002'
   AND scope = 'cultivar' AND scope_id = 'ece82bf2-6a60-4186-b031-64af0519aa49'   -- Spider Plant
   AND profile->'fertilize_interval_days' = '30'::jsonb
   AND EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-feedinherit-001');

UPDATE public.care_profile
   SET profile = profile - 'fertilize_interval_days', updated_at = now()
 WHERE id = 'd44d911e-b57c-40d2-88e9-d35ae16b1c87'
   AND scope = 'cultivar' AND scope_id = '21a8596d-f689-4028-a1dc-a34ae94c128b'   -- Tavera
   AND profile->'fertilize_interval_days' = '30'::jsonb
   AND EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-feedinherit-001');

UPDATE public.care_profile
   SET profile = profile - 'fertilize_interval_days', updated_at = now()
 WHERE id = '43162747-b27c-4ac3-bbd8-eadddd48cffc'
   AND scope = 'cultivar' AND scope_id = 'bc79d915-69a3-4945-8293-27314d83a29b'   -- Tendersweet
   AND profile->'fertilize_interval_days' = '30'::jsonb
   AND EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-feedinherit-001');

DELETE FROM public.schema_version WHERE version = '5.0.0-feedinherit-001';

-- Report what survived, so a partial rollback is visible rather than silent. After a clean rollback on
-- prod: every feed_now NULL and every md5_now equal to md5_before (the pre-apply rows).
SELECT v.variety, cp.profile->'fertilize_interval_days' AS feed_now, md5(cp.profile::text) AS md5_now, v.md5_before
  FROM (VALUES
         ('58586ba5-7080-469d-bf77-3f5746cd2132', 'Alaska Mix', '56232db6edd44008c0036b319237ec12'),
         ('cf4e17cf-d3da-46c9-bf71-a014f35bf2ad', 'Chrysanthemum', '95a27bbffd9bbeb5c89a2407d6d02551'),
         ('834a3a15-bd59-4801-ac2d-1d58bc0c79a3', 'Clemson Spineless 80', '0d9731f506b43f422c9055cc0b2d2870'),
         ('9548b3f2-e86c-435e-8ef2-28f5d0e8aa8c', 'Cobaea scandens (Violet)', '3fb6b9b305e417724b087ebd42d606cc'),
         ('e43739f4-75a6-4ae4-a673-1a8aef0e0f0b', 'Contender', '7d54f17db6de625fc7ccf3018d4f162a'),
         ('f807599b-f4d4-4fff-9703-ff21cbf9981f', 'Dwarf Blue Curled (Vates)', 'c851db18b63f8b19612ce9300af574de'),
         ('04554719-e633-44d7-8791-f3e33c90ed2d', 'Easy Wave Berry Velour', '5f2027fd1ff9e33e8bbbb1ebe0a6fa78'),
         ('f86d0c66-7b6d-4a8e-b9de-0132d9e3332a', 'Foxglove', '43e034ff6ab7011b3d6fd6e8aecdb2ee'),
         ('13bcffdc-ac3d-4294-a6a9-b887aa76584e', 'Gold Rush', '7d54f17db6de625fc7ccf3018d4f162a'),
         ('5378c39e-8174-4ce9-85ad-351adc4f1486', 'Hosta', '378cd2587ff37d625fbfd7b8c8c9948f'),
         ('8cc55d60-10a6-468e-a9af-cfafc7731b65', 'Japanese Maple', '12c1d516c75c3cbdfba2e90bca267794'),
         ('2d2bc039-58e4-4ce7-8930-e58a66c4cd5a', 'Jewel Mix Nasturtium', 'a83395305590751cc6f2ddd03a6cf20f'),
         ('ebf1aab5-4879-4080-a8aa-4e11b454de31', 'Lacinato (Dinosaur)', 'c851db18b63f8b19612ce9300af574de'),
         ('e74d95b7-df0a-4948-9bf2-d5bfd1bbeeea', 'Lemon Verbena', 'a626e28a0675a5892506e1fbf5160ce0'),
         ('c848cd0b-48bf-4622-be46-b65903725bc3', 'Palla Rossa Mavrik', '5831719141b1265afb0e269a71c3c358'),
         ('315a0e95-0469-4b88-9647-5662c0edc884', 'Petunia', '5f2027fd1ff9e33e8bbbb1ebe0a6fa78'),
         ('1d49baf7-103b-4a65-a6f5-81d1034d36a1', 'Purple Vienna', '76525dcf00834fc2e91268173b5d66d3'),
         ('ae276aeb-95c1-4dd2-8eab-159aa4dfa262', 'Redbor', 'c851db18b63f8b19612ce9300af574de'),
         ('241d3455-8961-4c8c-a7ab-4a73e84fc002', 'Spider Plant', '81e03e75f3e41f00829efc350ef319db'),
         ('d44d911e-b57c-40d2-88e9-d35ae16b1c87', 'Tavera', '7d54f17db6de625fc7ccf3018d4f162a'),
         ('43162747-b27c-4ac3-bbd8-eadddd48cffc', 'Tendersweet', 'b7c570259a428cb046b14e49c1032dad')
       ) AS v(row_id, variety, md5_before)
  LEFT JOIN public.care_profile cp ON cp.id = v.row_id::uuid
 ORDER BY v.variety;

COMMIT;
