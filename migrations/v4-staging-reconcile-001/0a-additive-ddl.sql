-- 0a-additive-ddl.sql
-- Reconcile the STAGING Neon branch to prod's shape. Idempotent and env-agnostic: run against
-- prod and every statement is a no-op (columns exist, view definition is identical, constraints
-- exist). Authored to be safe in both directions rather than staging-only-and-dangerous.
--
-- WHY THIS EXISTS: nothing in CI keeps staging in sync with prod. integration-test.yml creates an
-- ephemeral Neon branch off staging (br-damp-frog-amdfxwrr) and runs the real Lambda handlers
-- against it WITHOUT applying migrations, so staging silently accumulates drift and any test that
-- touches a prod-only column fails for a reason unrelated to the change under test. Measured
-- 2026-07-31: 10 prod-only columns, 3 prod-only constraints, 1 staging-only constraint. Table set
-- and index set already matched exactly.
--
-- Blocks V4-SPACEPHOTO-001: Lane C's integration tests branch off staging.

-- ── 1. spaces weather/geo anchor (read nightly by lambda/daily-plan/handler.js) ────────────────
ALTER TABLE public.spaces ADD COLUMN IF NOT EXISTS postal_code text;
ALTER TABLE public.spaces ADD COLUMN IF NOT EXISTS weather_lat numeric;
ALTER TABLE public.spaces ADD COLUMN IF NOT EXISTS weather_lng numeric;

-- ── 2. CAL-8 crop_types.dtm_basis ─────────────────────────────────────────────────────────────
ALTER TABLE public.crop_types ADD COLUMN IF NOT EXISTS dtm_basis text;

-- ── 3. DRG-WXFLAGSPLIT rain_exposed trio (on plants — NOT on locations; the P0 bible was wrong) ─
ALTER TABLE public.plants ADD COLUMN IF NOT EXISTS rain_exposed boolean;
ALTER TABLE public.plants ADD COLUMN IF NOT EXISTS rain_exposed_source text DEFAULT 'derived'::text;
ALTER TABLE public.plants ADD COLUMN IF NOT EXISTS rain_exposed_set_at timestamp with time zone;

-- ── 4. garden_node view — MUST be recreated, it does not inherit ───────────────────────────────
-- The view is an EXPLICIT column list over plants, so ALTER TABLE plants ADD COLUMN does not
-- surface in it. Prod's definition carries the three rain_exposed columns appended at the END;
-- this reproduces prod byte-for-byte. (CREATE OR REPLACE VIEW can only append columns, which is
-- exactly the shape needed here — a reordering would have required DROP + CREATE and would have
-- cascaded to dependents.)
CREATE OR REPLACE VIEW public.garden_node AS
 SELECT id,
    project_id AS container_id,
    name AS display_name,
    quantity,
    notes,
    status,
    planted_at,
    created_by,
    created_at,
    updated_at,
    deleted_at,
    location_id,
    featured_image_id,
    variety_id AS cultivar_id,
    source_inventory_item_id,
    metadata,
    featured_photo_id,
    sown_at,
    germinated_at,
    transplanted_at,
    planted_out_at,
    sown_at_approx,
    germinated_at_approx,
    transplanted_at_approx,
    planted_out_at_approx,
    qty_initial,
    qty_current,
    qty_harvested,
    qty_lost,
    loss_cause,
    source_type,
    source_ref,
    source_generation,
    parent_plant_id,
    divergence_type,
    lineage_note,
    succession_group_id,
    succession_order,
    container_type,
    container_size,
    kind,
    workspace_id,
    last_seen_at,
    attr_override,
    version,
    archived_at,
    assignee_user_id,
    rain_exposed,
    rain_exposed_source,
    rain_exposed_set_at
   FROM plants;

-- ── 5. prod-only CHECK constraints ────────────────────────────────────────────────────────────
-- Added NOT VALID uniformly: existing staging rows are grandfathered, NEW writes are enforced —
-- which is what an integration test actually exercises. 0c validates the two that can be.
DO $$ BEGIN
  ALTER TABLE public.crop_types
    ADD CONSTRAINT crop_types_dtm_basis_chk
    CHECK (dtm_basis = ANY (ARRAY['from-sow'::text, 'from-transplant'::text])) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.plants
    ADD CONSTRAINT chk_plants_rain_exposed_source
    CHECK ((rain_exposed_source IS NULL) OR (rain_exposed_source = ANY (ARRAY['derived'::text, 'user'::text, 'system'::text]))) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- plant_projects: staging holds 4 rows with kind NULL and deleted_at NULL (measured 2026-07-31).
-- They are pre-existing staging test junk, not something this migration should silently delete, so
-- this constraint stays NOT VALID permanently here and is NOT validated in 0c. New writes are
-- still enforced, which is the behaviour parity that matters.
DO $$ BEGIN
  ALTER TABLE public.plant_projects
    ADD CONSTRAINT plant_projects_kind_not_null_unless_deleted
    CHECK ((kind IS NOT NULL) OR (deleted_at IS NOT NULL)) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 6. staging-only constraint prod does NOT have ─────────────────────────────────────────────
-- plants_container_type_domain pins container_type to the OLD 7-value list. Prod dropped it when
-- the enum was widened (BUG-CONTVAL-001); staging kept it, so staging REJECTS values prod accepts
-- — e.g. 'trough'. A staging-only restriction is a false-failure generator for exactly the kind of
-- write-path integration test this reconcile exists to make trustworthy. 0/12 staging rows use a
-- value outside the old list, so dropping it changes no existing row.
ALTER TABLE public.plants DROP CONSTRAINT IF EXISTS plants_container_type_domain;
