-- Rollback for v5-deckpots-001. Puts each exact placeholder back and the old variety name back, each
-- only while the row still holds what 0a wrote and only while the stamp exists; then reports.
-- The placeholder literal is the one v5-crabappleprofile-001's 0r carries: its jsonb text hashes to
-- d5335984e4af2339fe6ee7b4f4946436, the md5 0a and the pre gate pin.

BEGIN;

UPDATE public.care_profile
   SET profile = $placeholder${"notes": "Auto-created with the cultivar so its variety has a cadence profile row (DRG-CADENCEFLOOR-001). Carries NO watering keys, so cadence still resolves through the bundled fallback exactly as it did before. _basis:\"unresearched\" means NOBODY HAS DECIDED YET — the opposite of a deliberately watering-free row like Collards.", "_basis": "unresearched", "_source": "cultivar-create"}$placeholder$::jsonb,
       updated_at = now()
 WHERE (id, scope_id) IN (('63463242-7d45-43cb-821a-55450f8320bd'::uuid, 'f1588cbd-0861-45ef-8c5a-42687839e218'::uuid),
                          ('737964e9-f583-49af-bf1c-34058376e934'::uuid, '0f89c33f-8c9a-479f-8e80-aca9091b3622'::uuid),
                          ('f61237a4-1868-4cfe-9710-7916b42dcf77'::uuid, '7a61c3e5-b90a-4f32-a21f-ba08d7daa3d3'::uuid))
   AND scope = 'cultivar'
   AND profile->>'_source' = 'v5-deckpots-001'
   AND profile->>'_basis' = 'dave_decision'
   AND EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-deckpots-001');

UPDATE public.plant_varieties
   SET name = 'Purple Majesty Miller',
       updated_at = now()
 WHERE id = '7a61c3e5-b90a-4f32-a21f-ba08d7daa3d3'
   AND name = 'Purple Majesty Millet'
   AND deleted_at IS NULL
   AND EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-deckpots-001');

DELETE FROM public.schema_version WHERE version = '5.0.0-deckpots-001';

SELECT v.variety,
       cp.profile->>'_basis' AS basis_now,
       md5(cp.profile::text) AS md5_now,
       v.md5_before,
       pv.name               AS name_now
  FROM (VALUES
         ('63463242-7d45-43cb-821a-55450f8320bd', 'f1588cbd-0861-45ef-8c5a-42687839e218', 'Garden Chrysanthemum', 'd5335984e4af2339fe6ee7b4f4946436'),
         ('737964e9-f583-49af-bf1c-34058376e934', '0f89c33f-8c9a-479f-8e80-aca9091b3622', 'Prairie Sun',          'd5335984e4af2339fe6ee7b4f4946436'),
         ('f61237a4-1868-4cfe-9710-7916b42dcf77', '7a61c3e5-b90a-4f32-a21f-ba08d7daa3d3', 'Purple Majesty',       'd5335984e4af2339fe6ee7b4f4946436')
       ) AS v(row_id, variety_id, variety, md5_before)
  LEFT JOIN public.care_profile cp ON cp.id = v.row_id::uuid
  LEFT JOIN public.plant_varieties pv ON pv.id = v.variety_id::uuid
 ORDER BY v.variety;

COMMIT;
