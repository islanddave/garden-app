-- 0r-rollback.sql — V4-CROPTYPEALOE-001
-- An INSERT's undo is a DELETE, so this carries its own guards rather than a sibling's UPDATE
-- contract. Nothing is force-deleted: each step REFUSES and reports if the row has been adopted by
-- another writer since apply.
BEGIN;

-- 1. Un-adopt the planting FIRST — the FK from plants.variety_id would otherwise block the delete,
--    and restoring from the snapshot is the only way to know what was actually there.
UPDATE public.plants p
SET variety_id = s.prev_variety_id, updated_at = now()
FROM public.snap_croptypealoe001_planting s
WHERE p.id = s.plant_id
  AND p.variety_id = 'a10e0000-0000-4000-8000-00000000a10e'::uuid;

-- 2. The cultivar — ONLY if nothing else adopted it in the meantime. A second planting pointing at
--    it means someone used it deliberately, and silently deleting that is worse than leaving a row.
DELETE FROM public.plant_varieties v
WHERE v.id = 'a10e0000-0000-4000-8000-00000000a10e'::uuid
  AND NOT EXISTS (SELECT 1 FROM public.plants p WHERE p.variety_id = v.id AND p.deleted_at IS NULL);

-- 3. The crop type — ONLY if no cultivar still references it.
DELETE FROM public.crop_types ct
WHERE ct.slug = 'aloe'
  AND NOT EXISTS (SELECT 1 FROM public.plant_varieties v WHERE v.crop_type_slug = ct.slug AND v.deleted_at IS NULL);

DELETE FROM public.schema_version WHERE version = '4.23.6-croptypealoe-001';

-- Report what survived, so a partial rollback is visible rather than silent.
SELECT
  (SELECT count(*) FROM public.crop_types WHERE slug='aloe')                                              AS crop_type_left,
  (SELECT count(*) FROM public.plant_varieties WHERE id='a10e0000-0000-4000-8000-00000000a10e'::uuid)     AS cultivar_left,
  (SELECT count(*) FROM public.plants WHERE variety_id='a10e0000-0000-4000-8000-00000000a10e'::uuid)      AS plantings_still_linked;

COMMIT;
