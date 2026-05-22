-- 0a-additive-ddl.sql
-- V1.3 — project_types.deleted_at (soft-delete column)
-- Retro-records the 2026-05-22 prod+staging HOTFIX (claude-ops/scripts/project-types-deleted-at-fix-20260522.sql).
--
-- INCIDENT (L-096): lambda/projects/index.js soft-deletes/filters project_types by deleted_at
--   (UPDATE project_types SET deleted_at = NOW(); WHERE deleted_at IS NULL), but the column never
--   existed (absent on PROD *and* STAGING; no prior migration). Unit tests mock the SQL → stayed
--   green (green-tests-broken-prod class, cf. L-088 //-in-sql, L-089 import-bundling). GET/DELETE
--   /api/projects/types 500'd; broke the Project Types admin page + silently emptied the ProjectNew
--   type picker. Did NOT affect the projects list (plant_projects already has deleted_at).
--
-- FIX: additive nullable timestamptz, matches plant_projects.deleted_at. Idempotent (IF NOT EXISTS).
--   Already live on prod + staging via the hotfix; this file is the durable repo record so a fresh
--   env / migration replay converges. Re-running is a no-op.
--
-- L-058 sweep status: NOT REQUIRED — column is nullable, no CHECK / NOT VALID constraint, no 0c.

ALTER TABLE public.project_types
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

INSERT INTO public.schema_version (version, description)
VALUES ('1.3.0-project-types-deleted-at',
        'PROJECT-TYPES: additive deleted_at (timestamptz) on project_types — retro-records 2026-05-22 hotfix; code soft-deletes/filters it (L-096)')
ON CONFLICT (version) DO NOTHING;
