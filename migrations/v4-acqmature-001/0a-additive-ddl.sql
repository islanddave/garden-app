-- 0a-additive-ddl.sql
-- V4-ACQMATURE-001 — the acquired-mature flag on plantings.
--
-- PURPOSE: give the "this plant ARRIVED already grown" class an explicit column, so the
--   from-transplant site calibration can exclude it by PREDICATE instead of by the hand-maintained
--   name list in src/lib/maturityCalibration.js (STRUCTURAL_OUTLIERS). transplanted_at on such a
--   planting records the day it entered Dave's garden, not a growth start, so its observed
--   time-to-first-harvest is not a measurement of this site and silently drags the fit down.
--
-- WHY A NEW COLUMN AND NOT A PREDICATE OVER EXISTING ONES. Measured read-only against live prod
--   2026-08-16 (_lane_reports/acqmature-recon-20260816b.md §5): nine candidate predicates were
--   tested against the 41-row calibration cohort and NONE reaches usable recall. source_type is
--   ANTI-correlated — nursery_transplant's mean ratio is 0.763 against a cohort mean of 0.717, i.e.
--   nursery stock is BETTER behaved than average. The decisive case is a pair that no query can
--   separate: King Richard (leek, ratio 0.707) and Shallots (0.122) share source_type
--   'nursery_transplant', source_ref 'Shawski Farm(s)', a NULL sown_at, container 'in_ground' and
--   empty notes. Do not try to infer this from source_type, a missing sow date, or the
--   sow-to-transplant gap; all three were measured and all three fail.
--
-- SAFETY: fully additive + idempotent. ADD COLUMN IF NOT EXISTS, all NULLABLE with NO DEFAULT;
--   the source CHECK is added NOT VALID (no full-table lock on apply) then VALIDATEd in
--   0c-validate.sql (L-058). Re-running the whole file is a clean no-op. NO destructive DDL.
--
-- NULLABLE, NO DEFAULT, DELIBERATELY. A `DEFAULT false` would write an assertion about all 261 live
--   plantings that nobody made: Ghost and Shallots would be stamped "did not arrive mature" the
--   instant this applies, and the calibration predicate would then read that as truth and silently
--   re-admit the exact two rows the flag exists to exclude — contamination laundered through a
--   column that looks authoritative. NULL means "never asked", false means "asked and told no", and
--   only the second is evidence. Same call, and the same shape, as rain_exposed
--   (migrations/drg-wxwater-001) — nullable boolean + a `_source` provenance tag + a `_set_at`
--   stamp. The provenance tag is what lets a future re-fit tell a Dave-asserted value from this
--   migration's backfilled one, which is precisely the distinction the name list cannot express.
--
-- NO CHECK IS ARMED OVER acquired_mature ITSELF. Adding a nullable column is backward-compatible
--   with the currently-deployed writer; constraining its values would not be. The only CHECK here
--   is on acquired_mature_source, a column no deployed writer emits at all, so it is born valid
--   over an empty column rather than armed over live traffic (cf. the 2026-08-03 harvest 23514).
--
-- VIEW WIDEN IS MANDATORY, NOT OPTIONAL. public.garden_node is a VIEW over base public.plants with
--   an EXPLICIT column list (verified via pg_get_viewdef on prod 2026-08-17 — 50 columns), and the
--   plants Lambda binds the VIEW for every read AND for the INSERT. CREATE OR REPLACE VIEW can only
--   ADD columns at the END, so a new base column does NOT auto-appear. Omitting this step is how
--   this migration would apply cleanly and do nothing. Every existing column + alias-back
--   (container_id, display_name, cultivar_id) is preserved BYTE-FOR-BYTE in order, to keep the view
--   auto-updatable and the wire contract intact; the three acquired_mature* columns are appended
--   last. lambda/daily-plan/handler.js reads base `plants` directly and needs no view change; both
--   consumer shapes coexist.
--
-- ROLLBACK: 0r-rollback.sql (restores the 50-column view, then drops constraint + columns).
-- BACKFILL: 0b-backfill.sql — 2 rows, by id. A SEPARATE decision; see its header.

-- 1. New nullable state columns on base plants. NO DEFAULT on any of the three.
ALTER TABLE public.plants
  ADD COLUMN IF NOT EXISTS acquired_mature        boolean,
  ADD COLUMN IF NOT EXISTS acquired_mature_source text,
  ADD COLUMN IF NOT EXISTS acquired_mature_set_at timestamptz;

-- 2. Value CHECK on the provenance column (NOT VALID; validated in 0c). NULL allowed (= not set).
--    Two values only, and the vocabulary is closed on purpose: 'user' is Dave answering the
--    question, 'backfill' is 0b seeding what the retired hand-maintained list already asserted.
--    There is deliberately NO 'derived'/'inferred' member — §5 of the recon measured that nothing
--    CAN derive this, and a vocabulary slot for an inference nobody can make is an invitation to
--    fabricate one. Widen it later if a real detector ever exists; never drop it (v4-source-freetext).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_plants_acquired_mature_source') THEN
    ALTER TABLE public.plants ADD CONSTRAINT chk_plants_acquired_mature_source
      CHECK (acquired_mature_source IS NULL OR acquired_mature_source IN ('user','backfill')) NOT VALID;
  END IF;
END $$;

-- 3. Widen garden_node — full current column list preserved byte-for-byte + 3 new columns appended
--    last. Diff this against 0r-rollback.sql: the two lists must be identical up to line 50.
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
    rain_exposed_set_at,
    acquired_mature,
    acquired_mature_source,
    acquired_mature_set_at
   FROM plants;

INSERT INTO public.schema_version (version, description)
VALUES ('4.31.0-acqmature-001','ACQMATURE: plants +acquired_mature(bool, NULLABLE, NO DEFAULT — NULL=never asked)/+acquired_mature_source(text, CHECK user|backfill, NOT VALID here, validated in 0c)/+acquired_mature_set_at(timestamptz); garden_node view widened 50 -> 53 columns, existing list byte-for-byte. Retires the hand-maintained STRUCTURAL_OUTLIERS name list in src/lib/maturityCalibration.js as the site-calibration exclusion mechanism. Additive, nullable, no CHECK armed over acquired_mature itself.')
ON CONFLICT (version) DO NOTHING;
