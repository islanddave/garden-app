-- 0r-rollback.sql
-- V4-PARENTPROJFK-001 — restores the PRE-MIGRATION referential action byte-for-byte.
--
-- WHAT THIS UNDOES: 0c flipped plant_projects.parent_project_id from ON DELETE SET NULL to
-- ON DELETE RESTRICT. This file puts it back to SET NULL. Nothing else in 0c touches data, so there
-- is nothing else to reverse.
--
-- WHAT ROLLING BACK RE-ARMS — say it plainly, because this file is the one that reintroduces the
-- defect: after running this, `DELETE FROM plant_projects WHERE id = '<parent>'` once again silently
-- promotes every child container to top-level, with no error and no record anywhere of what the row
-- used to hang off. parent_project_id is the ONLY place the hierarchy is stored — container_closure
-- is derived from it and CASCADEs away with the deleted parent, so it cannot reconstruct what
-- parent_project_id forgot. Roll back only to unblock a caller that MUST hard-delete a parent
-- container, and prefer the supported escape hatches first — both are one explicit statement:
--   UPDATE plant_projects SET parent_project_id = NULL WHERE parent_project_id = '<id>';  -- promote
--   UPDATE plant_projects SET parent_project_id =
--     (SELECT parent_project_id FROM plant_projects WHERE id = '<id>')
--    WHERE parent_project_id = '<id>';                                                    -- re-home
--
-- SAFE AT ANY TIME. Widening a referential action never fails on existing data: every row that
-- satisfies RESTRICT satisfies SET NULL. No validation scan can reject, and no row is read, written
-- or moved.
--
-- ROLLING BACK ALSO RE-SATISFIES v4-plantrehomefk-001's original
-- post_parent_project_id_deliberately_still_set_null. If that gate was superseded per this
-- migration's COMPANION-EDIT patch (as it must be for 0c to ship), a rollback reds the superseding
-- gate instead — which is correct and is the point: the corpus should never be silently satisfied by
-- a database in either state without someone having chosen which state is intended.
--
-- REHEARSAL CONTRACT: this file is run on STAGING BEFORE 0c is applied anywhere, per the house
-- 0r-rehearse rule — apply 0c, run this, confirm the constraint reads confdeltype = 'n' again, then
-- re-apply 0c. A rollback path that has never been executed is a rollback path that does not exist.
--
-- The schema_version row is left in place on purpose. It is an applied-history log, not a state
-- flag; deleting it would erase the record that the migration ran at all. The post gates in
-- gates.yml key on confdeltype, not on this row, so a rolled-back database reports honestly.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.plant_projects
  DROP CONSTRAINT IF EXISTS plant_projects_parent_project_id_fkey,
  ADD  CONSTRAINT plant_projects_parent_project_id_fkey
       FOREIGN KEY (parent_project_id) REFERENCES public.plant_projects(id) ON DELETE SET NULL;

INSERT INTO public.schema_version (version, description)
VALUES ('4.23.11-parentprojfk-001-rollback',
  'ROLLBACK of 4.23.11-parentprojfk-001: plant_projects.parent_project_id RESTRICT -> SET NULL. '
  'Re-arms the silent flatten of a container subtree. No row data touched.')
ON CONFLICT DO NOTHING;

COMMIT;
