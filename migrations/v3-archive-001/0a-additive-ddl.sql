-- 0a-additive-ddl.sql
-- V3-ARCHIVE-001 — soft-archive: additive archived_at on plantings + projects.
--
-- Archive is a SEPARATE state from delete: archived_at = active data intentionally hidden
-- from active lists (recoverable); deleted_at = removed (recoverable). Mutually exclusive in
-- practice (the archive write keeps deleted_at IS NULL in its WHERE; DELETE ignores archived_at).
-- Active-list predicate becomes (deleted_at IS NULL AND archived_at IS NULL); by-id detail reads
-- still filter only deleted_at, so an archived item still opens. (Soft-Delete-Only rule honored.)
--
-- Additive, nullable, idempotent (IF NOT EXISTS). L-058 sweep: NOT REQUIRED — nullable column,
-- no CHECK / NOT VALID / VALIDATE step, no 0c. Base tables: plants (view garden_node),
-- plant_projects (view container). The canonical views use EXPLICIT column lists (verified via
-- pg_get_viewdef on prod 2026-06-12) so 0b-views.sql MUST widen them — the column does not
-- auto-passthrough. Expand-only: apply DDL, then ship code that reads/writes archived_at.

ALTER TABLE public.plants
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE public.plant_projects
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- Partial indexes for the new active-list predicate (deleted_at IS NULL AND archived_at IS NULL).
CREATE INDEX IF NOT EXISTS idx_plants_active
  ON public.plants(project_id) WHERE deleted_at IS NULL AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_plant_projects_active
  ON public.plant_projects(created_by) WHERE deleted_at IS NULL AND archived_at IS NULL;

INSERT INTO public.schema_version (version, description)
VALUES ('3.0.0-archive-001',
        'ARCHIVE: additive archived_at (timestamptz) on plants + plant_projects — soft-archive, distinct from deleted_at (V3-ARCHIVE-001)')
ON CONFLICT (version) DO NOTHING;
