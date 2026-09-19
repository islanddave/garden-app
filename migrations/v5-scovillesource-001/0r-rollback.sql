-- V5-SEEDCARDS-001 (v5-scovillesource-001) — rollback.
--
-- CODE BACK BEFORE SCHEMA BACK. The inventory-items and plants Lambdas that ship with this
-- migration project pv.scoville_source unconditionally, so running this file under them 500s the
-- seed list, the seed detail page, the planting page and both planting lists. On prod, first
-- promote a main that predates the pv.scoville_source projections and redeploy those two Lambdas,
-- THEN run this. On staging (the rehearsal) the order does not matter.
--
-- ORDER WITHIN THE FILE IS THE OPPOSITE OF THE APPLY. The view must be narrowed BEFORE the column
-- is dropped, because public.cultivar projects it: dropping a column a view selects fails with
-- "cannot drop column scoville_source of table plant_varieties because other objects depend on it".
--
-- AND THE NARROW CANNOT USE `CREATE OR REPLACE`. Postgres allows CREATE OR REPLACE VIEW to APPEND
-- columns only — removing one raises "cannot drop columns from view". So this is a genuine
-- DROP VIEW + CREATE VIEW, which is the one path that does NOT preserve grants. Read on prod
-- 2026-09-19 before writing this: nothing else depends on public.cultivar (no dependent view), it
-- has no triggers, no rules beyond _RETURN, no reloptions and no comments, so DROP + CREATE loses
-- nothing except the grant restored below. Owner is neondb_owner; apply as that role.
--
-- THE GRANT HAZARD — v5-varietyhybridflag-001/0r-rollback.sql states it in full and it holds
-- unchanged: prod's pg_default_acl would auto-restore garden_ro's SELECT, but that default ACL does
-- not cover garden_export_ro and STAGING HAS NEITHER ROLE, so a staging rehearsal passes regardless
-- and can never tell you which behaviour prod has. Do not "simplify" the re-grant away.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

-- 1. Narrow the view back to the 46 columns captured from prod pg_get_viewdef 2026-09-19 (the
--    pre-migration definition, md5 12daf78b11fb90953fba3d4d7f31b858).
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
    dtm_basis,
    breeding_system,
    breeding_source,
    breeding_confidence,
    variety_rank
   FROM plant_varieties;

-- 2. Restore the grant DROP VIEW just revoked. See the header.
-- GUARDED ON THE ROLE EXISTING, for the same reason 0a's copy is: staging has no garden_ro, and an
-- unguarded GRANT there fails the statement and rolls back the whole rollback.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'garden_ro') THEN
    EXECUTE 'GRANT SELECT ON public.cultivar TO garden_ro';
  END IF;
END $$;

-- 3. Drop the constraint, then the column.
ALTER TABLE public.plant_varieties
  DROP CONSTRAINT IF EXISTS chk_plant_varieties_scoville_source;

-- DATA LOSS NOTE: this discards every recorded scoville_source. This migration backfills none, so
-- whatever is lost was written after the apply — by whichever load recorded the estimates. Re-apply
-- that load after re-applying 0a to restore it. scoville_min/scoville_max are NOT touched: the
-- numbers survive the rollback and simply lose their provenance, which renders them exactly as
-- before this migration (an estimate would then read as a plain figure again — the state this
-- migration exists to end, so do not leave prod here longer than the incident needs).
ALTER TABLE public.plant_varieties
  DROP COLUMN IF EXISTS scoville_source;

DELETE FROM public.schema_version WHERE version = '5.0.0-scovillesource-001';

COMMIT;
