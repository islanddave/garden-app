-- 0r-rollback.sql — V4-CROPTYPEDOGWOOD-001
-- The undo of an INSERT is a DELETE and the undo of the retype is a restore-from-snapshot. Nothing
-- is forced: each step REFUSES and reports if the row has moved on since apply. In particular the
-- retype is reverted ONLY while the cultivar still carries exactly what this migration wrote — if
-- Dave has since retyped it himself, his choice is his, and clobbering it would be the worse error.
BEGIN;

-- 1. Un-type the cultivar FIRST — the FK plant_varieties.crop_type_slug -> crop_types.slug would
--    otherwise block the delete below. Restored from the snapshot, not assumed to have been NULL.
UPDATE public.plant_varieties v
SET crop_type_slug = s.prev_crop_type_slug, lifecycle = s.prev_lifecycle, updated_at = now()
FROM public.snap_croptypedogwood001_cultivar s
WHERE v.id = s.cultivar_id
  AND v.crop_type_slug = 'dogwood'
  AND v.lifecycle IS NOT DISTINCT FROM 'perennial';

-- 2. The crop type — ONLY if no cultivar still references it. Another cultivar pointing at it means
--    someone typed something dogwood deliberately, and deleting that out from under them is worse
--    than leaving a reference row behind.
DELETE FROM public.crop_types ct
WHERE ct.slug = 'dogwood'
  AND NOT EXISTS (SELECT 1 FROM public.plant_varieties v WHERE v.crop_type_slug = ct.slug AND v.deleted_at IS NULL);

DELETE FROM public.schema_version WHERE version = '4.33.0-croptypedogwood-001';

-- Report what survived, so a partial rollback is visible rather than silent.
SELECT
  (SELECT count(*) FROM public.crop_types WHERE slug = 'dogwood')                                    AS crop_type_left,
  (SELECT count(*) FROM public.plant_varieties WHERE crop_type_slug = 'dogwood'
     AND deleted_at IS NULL)                                                                         AS cultivars_still_typed,
  (SELECT crop_type_slug FROM public.plant_varieties
     WHERE id = '0189f4cd-aa30-47b7-81cc-f467ab767f6b'::uuid)                                        AS kousa_type_now;

COMMIT;

-- NOTE: rolling back leaves the cultivar's DERIVED tags (facet 'type'/'lifecycle') pointing at a
-- crop type that no longer exists. Re-run applyDerive for this cultivar after a rollback, the same
-- way apply does — see README.
