-- 0r-rollback.sql — v5-frostband-001
-- Reverses 0a in the opposite order. Nothing is forced: every statement matches only the value 0a
-- WROTE, so a later hand-edit (Dave re-typing a cultivar, a curated cold block) survives.
--
-- WHAT ROLLING BACK COSTS, stated plainly: Pineapple Sage goes back to `sage`, which the frost alert
-- bands hardy, and to a cold block that says hardy to 10F — neither channel can warn for it again.
-- Autumn Fire goes back to being named as "unclassified" on frost nights. This exists to unwind a bad
-- apply, not for tidiness.
--
-- CODE IS NOT A PRECONDITION. The deployed classifier bands `hylotelephium` / `pineapple_sage` if it
-- carries this branch, and simply never sees them again once nothing is typed to them. No read path
-- names a column this file removes (it removes none).
--
-- AFTER running this: node migrations/v5-frostband-001/0b-derive.mjs --env <env> --reconcile-only
-- to swap the derived type tags back to sedum / sage.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

SELECT set_config('app.actor_clerk_sub', 'migration:v5-frostband-001-rollback', true);

-- 1. The cold block back to the value 0a matched on — only while it still holds what 0a wrote.
UPDATE public.care_profile
   SET profile = jsonb_set(profile, '{cold}', '{"tender": false, "protect_below_F": 10}'::jsonb, false),
       updated_at = now()
 WHERE scope = 'cultivar'
   AND scope_id = '6b75492d-b08c-4f66-9de9-18157fc1bdaa'
   AND profile->'cold' = '{"tender": true, "protect_below_F": 32}'::jsonb;

-- 2. Re-type the cultivars back, guarded on the NEW slug (a re-run matches nothing).
UPDATE public.plant_varieties SET crop_type_slug = 'sedum', updated_at = now()
 WHERE id = '44907632-80f4-4f8d-bbdd-e7143e0bea7a' AND crop_type_slug = 'hylotelephium';

UPDATE public.plant_varieties SET crop_type_slug = 'sage', updated_at = now()
 WHERE id = '6b75492d-b08c-4f66-9de9-18157fc1bdaa' AND crop_type_slug = 'pineapple_sage';

-- 3. Soft-delete the two vocabulary rows AFTER the re-typing (a soft delete does not fire the ON DELETE
--    SET NULL FK, so the reverse order would strand live cultivars on a dead slug that derives no type
--    tag). SOFT, per the Soft-Delete-Only rule, and only rows this migration minted that no live
--    cultivar still uses: a cultivar Dave has typed there since keeps its type.
UPDATE public.crop_types ct SET deleted_at = now(), updated_at = now()
 WHERE ct.slug IN ('hylotelephium', 'pineapple_sage')
   AND ct.deleted_at IS NULL AND ct.created_by = 'v5-frostband-001'
   AND NOT EXISTS (SELECT 1 FROM public.plant_varieties v
                    WHERE v.crop_type_slug = ct.slug AND v.deleted_at IS NULL);

-- 4. Retire the now-orphaned derived type tags (live tag, zero live links). Nothing else soft-deletes a
--    `tag` row, and entity_tag_tag_id_fkey blocks a hard delete (v4-cropsplit-001/0r). upsertDerivedTag
--    revives a soft-deleted tag, so a re-apply is unaffected. Run AFTER 0b --reconcile-only has
--    unlinked them if you want this sweep to catch them in the same pass; re-running this file after
--    that is safe (every statement above then matches nothing).
UPDATE public.tag SET deleted_at = now(), updated_at = now()
 WHERE facet = 'type' AND source = 'derived' AND owner_id = 'system' AND deleted_at IS NULL
   AND slug IN ('hylotelephium', 'pineapple_sage')
   AND NOT EXISTS (SELECT 1 FROM public.entity_tag et WHERE et.tag_id = tag.id AND et.deleted_at IS NULL);

DELETE FROM public.schema_version WHERE version = '5.0.0-frostband-001';

-- Report what survived, so a partial rollback is visible rather than silent.
SELECT
  (SELECT count(*) FROM public.crop_types WHERE slug IN ('hylotelephium','pineapple_sage')
     AND deleted_at IS NULL)                                                           AS new_types_still_live,
  (SELECT crop_type_slug FROM public.plant_varieties
     WHERE id = '44907632-80f4-4f8d-bbdd-e7143e0bea7a')                                AS autumn_fire_type_now,
  (SELECT crop_type_slug FROM public.plant_varieties
     WHERE id = '6b75492d-b08c-4f66-9de9-18157fc1bdaa')                                AS pineapple_sage_type_now,
  (SELECT profile->'cold' FROM public.care_profile
     WHERE scope = 'cultivar' AND scope_id = '6b75492d-b08c-4f66-9de9-18157fc1bdaa')   AS pineapple_sage_cold_now;

COMMIT;
