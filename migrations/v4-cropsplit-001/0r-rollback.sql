-- 0r-rollback.sql — V4-CROPSPLIT-001 rollback.
--
-- Reverses all three splits: repoints the 10 moved cultivars back to their original slugs, undoes
-- the attribute writes on the surviving parents, and soft-deletes the three new crop_types rows.
--
-- ORDER MATTERS: cultivars must be repointed BEFORE the new crop_types rows are soft-deleted.
-- plant_varieties_crop_type_slug_fkey is ON DELETE SET NULL, but a SOFT delete does not fire it —
-- so reversing that order would leave live cultivars pointing at a soft-deleted slug, which
-- applyDerive treats as "no crop type" and which emits NO type tag at all, silently.
--
-- SOFT delete, never DROP, per the project's Soft-Delete-Only rule. The rows stay recoverable, and
-- 0a's guarded un-soft-delete (scoped to created_by='v4-cropsplit-001') will revive exactly these
-- rows if the migration is re-applied.
--
-- Guarded throughout: every statement matches only the value THIS migration wrote, so a later
-- hand-correction survives the rollback rather than being destroyed.
--
-- AFTER running this, re-run 0b-redrive.mjs to swap the derived type: tags back. The redrive's
-- pre-flight asserts each cultivar is on its EXPECTED slug, so it will refuse to run until the
-- repointing below has committed — run it with the MOVED table's expected slugs inverted, or
-- simply call applyDerive over the 10 ids, which reconciles desired-vs-actual in either direction.

BEGIN;

-- 1. Repoint cultivars back (guarded on the NEW slug, so a re-run matches 0).
UPDATE public.plant_varieties SET crop_type_slug = 'squash', updated_at = now()
 WHERE crop_type_slug = 'winter_squash' AND id IN (
   'b6ffab33-afb9-4354-80a1-bfb8f61a76dd','83b3195b-8be3-4806-94c5-c5dc85a7cb58',
   'f1bbb5be-d48a-45d2-b536-b75d36860eec','feb6719d-5d8e-45a8-b7fe-0cb5a6dd1121',
   'c7d0aee5-6983-4220-9b25-db9a19f88ab5','a0f88678-9c47-4aed-899b-141448c06ca7');

UPDATE public.plant_varieties SET crop_type_slug = 'onion', updated_at = now()
 WHERE crop_type_slug = 'bunching_onion' AND id IN (
   '3d6fdd43-6fce-4c62-862c-d58f66b2845c','3127a432-af9b-405d-8144-6a3c3470956e',
   '0b640bff-ad0a-446f-92b9-993afb5cf2c0');

UPDATE public.plant_varieties SET crop_type_slug = 'radish', updated_at = now()
 WHERE crop_type_slug = 'rat_tail_radish' AND id = 'a53f78ae-aa0f-47ca-bff8-f6633048cdb8';

-- 2. Undo the species normalisation on "Scallion" (only if it still holds what 0a wrote).
UPDATE public.plant_varieties SET species = 'cepa (or fistulosum)', updated_at = now()
 WHERE id = '3127a432-af9b-405d-8144-6a3c3470956e' AND species = 'fistulosum';

-- 3. Undo the surviving-parent attribute writes.
UPDATE public.crop_types SET display_name = 'Squash', updated_at = now()
 WHERE slug = 'squash' AND display_name = 'Summer Squash';
UPDATE public.crop_types SET harvest_habit = NULL, updated_at = now()
 WHERE slug = 'radish' AND harvest_habit = 'single';
UPDATE public.crop_types SET first_year_harvest = NULL, updated_at = now()
 WHERE slug = 'radish' AND first_year_harvest = true;

-- 4. Soft-delete the three new vocabulary rows (AFTER the repointing above).
UPDATE public.crop_types SET deleted_at = now(), updated_at = now()
 WHERE slug IN ('winter_squash','bunching_onion','rat_tail_radish')
   AND deleted_at IS NULL AND created_by = 'v4-cropsplit-001';

-- 5. Sweep the now-orphaned derived type: tags (live tag rows with zero live links). Nothing else
--    in the system ever soft-deletes a `tag` row — deriveForCultivar only soft-deletes entity_tag
--    LINKS — and entity_tag_tag_id_fkey is ON DELETE RESTRICT, so a hard delete is blocked while
--    any link row (even a soft-deleted one) references it. Without this sweep the three type: tags
--    linger in the shared vocabulary with no results behind them.
--    Safe against re-applying 0a: upsertDerivedTag has a revive branch that resurrects a
--    soft-deleted tag rather than inserting a duplicate.
UPDATE public.tag SET deleted_at = now(), updated_at = now()
 WHERE facet = 'type' AND source = 'derived' AND owner_id = 'system' AND deleted_at IS NULL
   AND slug IN ('winter_squash','bunching_onion','rat_tail_radish')
   AND NOT EXISTS (
     SELECT 1 FROM public.entity_tag et WHERE et.tag_id = tag.id AND et.deleted_at IS NULL);

DELETE FROM public.schema_version WHERE version = '4.18.0-cropsplit-001';

COMMIT;
