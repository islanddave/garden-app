-- 0r-rollback.sql
-- V4-SPACEPHOTO-001 — reverse 0a + 0c.
--
-- ⚠ NOT SAFE UNCONDITIONALLY. Dropping photos.space_id destroys the parent link of any
--   space-only photo, and restoring the narrow constraint fails outright if such a row exists.
--   Run the guard first; if it returns > 0, reassign or delete those photos before rolling back.
--
--   GUARD:  SELECT count(*) FROM public.photos
--            WHERE space_id IS NOT NULL
--              AND event_id IS NULL AND project_id IS NULL AND location_id IS NULL
--              AND plant_id IS NULL AND inventory_item_id IS NULL
--              AND COALESCE(intake_status = 'pending_tag', false) = false;
--
-- Order is the reverse of apply: restore the narrow constraint BEFORE dropping the column
-- the widened one references, else the ADD CONSTRAINT below has nothing to disagree with.

ALTER TABLE public.spaces DROP CONSTRAINT IF EXISTS spaces_featured_photo_id_fkey;
ALTER TABLE public.spaces DROP COLUMN IF EXISTS featured_photo_id;

ALTER TABLE public.photos DROP CONSTRAINT IF EXISTS photos_must_have_parent;

ALTER TABLE public.photos
  ADD CONSTRAINT photos_must_have_parent CHECK (
    (event_id IS NOT NULL)
    OR (project_id IS NOT NULL)
    OR (location_id IS NOT NULL)
    OR (plant_id IS NOT NULL)
    OR (inventory_item_id IS NOT NULL)
    OR COALESCE((intake_status = 'pending_tag'::text), false)
  );

DROP INDEX IF EXISTS public.idx_photos_space_id;
ALTER TABLE public.photos DROP COLUMN IF EXISTS space_id;
