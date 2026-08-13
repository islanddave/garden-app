-- 0r-rollback.sql
-- BUG-PLANTREHOMEFK-001 — restores the PRE-MIGRATION referential actions byte-for-byte.
--
-- WHAT THIS UNDOES: 0c flipped plants.project_id and tasks.project_id from ON DELETE SET NULL to
-- ON DELETE RESTRICT. This file puts both back to SET NULL. Nothing else in 0c touches data, so
-- there is nothing else to reverse.
--
-- WHAT ROLLING BACK RE-ARMS — say it plainly, because this file is the one that reintroduces the
-- defect: after running this, `DELETE FROM plant_projects WHERE id = '<container>'` once again
-- silently strips every child planting into the project-less arm and re-keys its authorization to
-- its own created_by, with no error and no record of where the row used to live. Roll back only to
-- unblock a caller that MUST hard-delete a container, and prefer the supported escape hatch first:
--   UPDATE plants SET project_id = NULL WHERE project_id = '<id>';   -- the same act, stated
--
-- SAFE AT ANY TIME. Widening a referential action never fails on existing data: every row that
-- satisfies RESTRICT satisfies SET NULL. No validation scan can reject, and no row is read,
-- written or moved.
--
-- REHEARSAL CONTRACT: this file is run on STAGING BEFORE 0c is applied anywhere, per the house
-- 0r-rehearse rule — apply 0c, run this, confirm both constraints read confdeltype = 'n' again,
-- then re-apply 0c. A rollback path that has never been executed is a rollback path that does not
-- exist.
--
-- The schema_version row is left in place on purpose. It is an applied-history log, not a state
-- flag; deleting it would erase the record that the migration ran at all. The post gates in
-- gates.yml key on confdeltype, not on this row, so a rolled-back database reports honestly.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.plants
  DROP CONSTRAINT IF EXISTS plants_project_id_fkey,
  ADD  CONSTRAINT plants_project_id_fkey
       FOREIGN KEY (project_id) REFERENCES public.plant_projects(id) ON DELETE SET NULL;

ALTER TABLE public.tasks
  DROP CONSTRAINT IF EXISTS tasks_project_id_fkey,
  ADD  CONSTRAINT tasks_project_id_fkey
       FOREIGN KEY (project_id) REFERENCES public.plant_projects(id) ON DELETE SET NULL;

INSERT INTO public.schema_version (version, description)
VALUES ('4.23.7-plantrehomefk-001-rollback',
  'ROLLBACK of 4.23.7-plantrehomefk-001: plants.project_id and tasks.project_id RESTRICT -> SET '
  'NULL. Re-arms the silent container re-home. No row data touched.')
ON CONFLICT DO NOTHING;

COMMIT;
