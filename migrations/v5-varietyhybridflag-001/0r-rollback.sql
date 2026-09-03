-- V5-VARIETYHYBRIDFLAG-001 — rollback.
--
-- ORDER MATTERS AND IS THE OPPOSITE OF THE APPLY. The view must be narrowed BEFORE the columns are
-- dropped, because public.cultivar projects them: dropping a column a view selects fails with
-- "cannot drop column breeding_system of table plant_varieties because other objects depend on it".
--
-- AND THE NARROW CANNOT USE `CREATE OR REPLACE`. Postgres allows CREATE OR REPLACE VIEW to APPEND
-- columns only — removing one raises "cannot drop columns from view". So this is a genuine
-- DROP VIEW + CREATE VIEW, which is the one path that does NOT preserve grants.
--
-- THE GRANT HAZARD, STATED PRECISELY. Prod carries a pg_default_acl row
-- (neondb_owner | public | r | {garden_ro=r/neondb_owner}) that auto-grants garden_ro SELECT on new
-- public relations — measured 2026-09-03 with a rolled-back probe, which contradicts the older
-- "the grant is silently lost" warning in DECISION-V101 §7.2. But two things make the explicit
-- re-grant below non-optional anyway:
--   1. That default ACL does NOT cover garden_export_ro.
--   2. STAGING HAS NEITHER ROLE — no garden_ro, no garden_export_ro, no neondb_owner default ACL.
--      So a rollback rehearsal on staging passes regardless, and can never tell you which behaviour
--      prod has. Staging is structurally blind to this.
-- Do not "simplify" the re-grant away on the strength of the default ACL. It is one unowned catalog
-- row whose origin nobody has established.
--
-- Usage: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

-- 1. Narrow the view back to the 42 columns captured from prod pg_get_viewdef 2026-09-03.
DROP VIEW public.cultivar;

CREATE VIEW public.cultivar AS
SELECT id,
    name AS display_name,
    species,
    genus,
    days_to_maturity_min,
    days_to_maturity_max,
    care_notes,
    soil_notes,
    sun_requirements,
    common_diseases,
    expected_yield_notes,
    photo_id,
    source_url,
    created_by,
    created_at,
    updated_at,
    deleted_at,
    source_proj_rescope_project_id,
    origin_country,
    origin_region,
    model_version,
    crop_type_slug,
    lifecycle,
    scoville_min,
    scoville_max,
    growth_habit,
    produces_scape,
    determinacy,
    day_length_response,
    grown_as,
    start_method,
    start_indoor_weeks_min,
    start_indoor_weeks_max,
    direct_sow_timing,
    sow_depth_in,
    seed_spacing_in,
    row_spacing_in,
    days_to_germ_min,
    days_to_germ_max,
    sow_season,
    sow_notes,
    dtm_basis
   FROM plant_varieties;

-- 2. Restore the grant DROP VIEW just revoked. See the header.
GRANT SELECT ON public.cultivar TO garden_ro;

-- 3. Drop the constraints, then the columns.
ALTER TABLE public.plant_varieties
  DROP CONSTRAINT IF EXISTS chk_plant_varieties_op_requires_cultivar,
  DROP CONSTRAINT IF EXISTS chk_plant_varieties_breeding_sourced,
  DROP CONSTRAINT IF EXISTS chk_plant_varieties_variety_rank,
  DROP CONSTRAINT IF EXISTS chk_plant_varieties_breeding_confidence,
  DROP CONSTRAINT IF EXISTS chk_plant_varieties_breeding_source,
  DROP CONSTRAINT IF EXISTS chk_plant_varieties_breeding_system;

-- DATA LOSS NOTE: this discards every backfilled breeding call — 78 rows after 0b-data.sql, each
-- carrying a researched, named source. Re-applying 0a + 0b restores them from the payload, which is
-- version-controlled at
-- Projects/Gardening/project-state/_seedvault-20260902/breeding-status-backfill.json.
-- Nothing else in the database references these columns, so the loss is bounded to them.
ALTER TABLE public.plant_varieties
  DROP COLUMN IF EXISTS variety_rank,
  DROP COLUMN IF EXISTS breeding_confidence,
  DROP COLUMN IF EXISTS breeding_source,
  DROP COLUMN IF EXISTS breeding_system;

DELETE FROM public.schema_version WHERE version = '4.101.0-varietyhybridflag-001';

COMMIT;
