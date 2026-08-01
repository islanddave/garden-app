-- 0r-rollback.sql
-- V4-SPACEPHOTO-001 — reverse 0a + 0c.
--
-- ⚠ NOT SAFE UNCONDITIONALLY. Dropping photos.space_id destroys the parent link of any
--   space-only photo, and restoring the narrow constraint fails outright if such a row exists.
--   The guard is now ENFORCED below (a DO block that RAISEs), not a comment the operator is
--   trusted to have run first. Prod carries 0 such rows as of 2026-08-01, so it passes for
--   free — which is exactly when a guard is cheap to add.
--
-- ⚠ THIS IS NOT THE ROLLBACK FOR THE SPACE_PHOTOS_ENABLED FLAG. Turning the feature off is an
--   env-var change on the garden-photos Lambda and nothing more. Dropping the columns is a
--   strictly larger, one-way operation, and running it while the Lambda's gate is ON would
--   42703 every upload. Reach for this ONLY to reverse the schema itself.
--
-- REWRITTEN 2026-08-01. The prior version had two defects, both in the one script a go-live
-- decision leans on as its schema rollback lever:
--
--   1. It DROPPED photos_must_have_parent and then ADDed the narrow one — the exact
--      drop-then-add anti-pattern 0a-additive-ddl.sql's own header forbids ("ADD NOT VALID ->
--      VALIDATE -> DROP old, never drop-then-add ... The older migrations/v4-photo-parent-widen/0a
--      dropped first — do not copy it."). 0r copied it anyway, in the same migration set.
--   2. There was no BEGIN/COMMIT. Under psql autocommit, if the ADD CONSTRAINT failed — which is
--      precisely what the guard exists to predict — the table was left with NO parent constraint
--      at all, live and accepting writes. A rollback that can fail OPEN is worse than no rollback,
--      because it is trusted.
--
-- Now: one transaction, and the same ADD NOT VALID -> VALIDATE -> DROP -> RENAME swap the forward
-- direction uses. Either the whole revert lands or nothing changes.
--
-- ORDER: restore the narrow constraint BEFORE dropping the column the widened one references.
--   The narrow predicate does not mention space_id, so VALIDATE is where a space-only row would
--   surface; the guard just turns that into a legible error before any DDL runs.

BEGIN;

-- ── Guard: no photo may depend on space_id as its ONLY parent. ───────────────────────────────
DO $$
DECLARE orphan_count bigint;
BEGIN
  SELECT count(*) INTO orphan_count
    FROM public.photos
   WHERE space_id IS NOT NULL
     AND event_id IS NULL
     AND project_id IS NULL
     AND location_id IS NULL
     AND plant_id IS NULL
     AND inventory_item_id IS NULL
     AND COALESCE(intake_status = 'pending_tag', false) = false;

  IF orphan_count > 0 THEN
    RAISE EXCEPTION
      'V4-SPACEPHOTO-001 rollback ABORTED: % photo(s) carry space_id as their only parent. '
      'Reassign or delete them first. List them with: SELECT id, storage_path FROM public.photos '
      'WHERE space_id IS NOT NULL AND event_id IS NULL AND project_id IS NULL '
      'AND location_id IS NULL AND plant_id IS NULL AND inventory_item_id IS NULL '
      'AND COALESCE(intake_status = ''pending_tag'', false) = false;', orphan_count;
  END IF;
END $$;

-- ── Constraint swap — forward-direction discipline, run in reverse. ──────────────────────────
ALTER TABLE public.photos
  ADD CONSTRAINT photos_must_have_parent_narrow CHECK (
    (event_id IS NOT NULL)
    OR (project_id IS NOT NULL)
    OR (location_id IS NOT NULL)
    OR (plant_id IS NOT NULL)
    OR (inventory_item_id IS NOT NULL)
    OR COALESCE((intake_status = 'pending_tag'::text), false)
  ) NOT VALID;

ALTER TABLE public.photos VALIDATE CONSTRAINT photos_must_have_parent_narrow;

ALTER TABLE public.photos DROP CONSTRAINT photos_must_have_parent;

ALTER TABLE public.photos
  RENAME CONSTRAINT photos_must_have_parent_narrow TO photos_must_have_parent;

-- ── Columns, FKs and index. Dropping space_id cascades its FK and partial index anyway; they
--    are named explicitly so a partial hand-run stays legible. ─────────────────────────────────
ALTER TABLE public.spaces DROP CONSTRAINT IF EXISTS spaces_featured_photo_id_fkey;
ALTER TABLE public.spaces DROP COLUMN IF EXISTS featured_photo_id;

DROP INDEX IF EXISTS public.idx_photos_space_id;
ALTER TABLE public.photos DROP COLUMN IF EXISTS space_id;

-- ── Retract the applied-state record so the ledger cannot claim a migration that is gone. ────
DELETE FROM public.schema_version WHERE version = '4.18.0-spacephoto-001';

COMMIT;
