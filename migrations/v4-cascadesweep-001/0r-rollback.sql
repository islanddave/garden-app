-- 0r-rollback.sql
-- V4-CASCADESWEEP-001 — restores the four pre-migration referential actions byte-for-byte.
--
-- WHAT ROLLING BACK RE-ARMS, stated plainly:
--   * one `DELETE FROM inventory_items` again destroys the 6 photos hanging off it — irreplaceable
--     user content, every one of them sole-anchored to the item being deleted;
--   * deleting a single row from the 39-row `achievements` catalog again destroys every badge
--     earned against it (33 live across two subs);
--   * a hard photo delete again silently destroys share history, the exact act
--     lambda/photos/photoDelete.js:14-16 documents as a hazard and DD4 classifies as RETAIN;
--   * hard-deleting a planting again destroys its soft-deletable diagnostic findings.
--
-- Roll back only to unblock a caller that MUST perform one of those deletes, and prefer removing
-- the children explicitly first — that is the supported path and it makes the destruction a stated
-- act rather than an inferred one.
--
-- SAFE AT ANY TIME. Widening a referential action never fails on existing data: every row that
-- satisfies RESTRICT satisfies CASCADE. No validation scan can reject, and no row is read, written
-- or moved.
--
-- REHEARSAL CONTRACT: run on STAGING before 0c is applied anywhere — apply 0c, run this, confirm
-- all four read confdeltype = 'c' again, then re-apply 0c. A rollback path that has never been
-- executed is a rollback path that does not exist.
--
-- The schema_version row is left in place on purpose: it is an applied-history log, not a state
-- flag. gates.yml keys on confdeltype, so a rolled-back database reports honestly.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.photos
  DROP CONSTRAINT IF EXISTS photos_inventory_item_id_fkey,
  ADD  CONSTRAINT photos_inventory_item_id_fkey
       FOREIGN KEY (inventory_item_id) REFERENCES public.inventory_items(id) ON DELETE CASCADE;

ALTER TABLE public.user_achievements
  DROP CONSTRAINT IF EXISTS user_achievements_achievement_id_fkey,
  ADD  CONSTRAINT user_achievements_achievement_id_fkey
       FOREIGN KEY (achievement_id) REFERENCES public.achievements(id) ON DELETE CASCADE;

ALTER TABLE public.share_log
  DROP CONSTRAINT IF EXISTS share_log_photo_id_fkey,
  ADD  CONSTRAINT share_log_photo_id_fkey
       FOREIGN KEY (photo_id) REFERENCES public.photos(id) ON DELETE CASCADE;

ALTER TABLE public.findings
  DROP CONSTRAINT IF EXISTS findings_garden_node_id_fkey,
  ADD  CONSTRAINT findings_garden_node_id_fkey
       FOREIGN KEY (garden_node_id) REFERENCES public.plants(id) ON DELETE CASCADE;

INSERT INTO public.schema_version (version, description)
VALUES ('4.23.9-cascadesweep-001-rollback',
  'ROLLBACK of 4.23.9-cascadesweep-001: photos.inventory_item_id, '
  'user_achievements.achievement_id, share_log.photo_id and findings.garden_node_id RESTRICT -> '
  'CASCADE. Re-arms silent destruction of 6 photos, 33 earned badges, share history and diagnostic '
  'findings. No row data touched.')
ON CONFLICT DO NOTHING;

COMMIT;
