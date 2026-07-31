-- 0c-validate.sql
-- With 0b having eliminated the last violating rows, promote the constraint from NOT VALID to
-- VALIDATED so staging matches prod's convalidated=true. VALIDATE takes only a SHARE UPDATE
-- EXCLUSIVE lock, so concurrent reads and writes continue during the scan.
--
-- No-op-safe against prod, where the constraint is already validated.

ALTER TABLE public.plant_projects
  VALIDATE CONSTRAINT plant_projects_kind_not_null_unless_deleted;
