-- V4-DTMBASISVAR-001 — promote dtm_basis to plant_varieties with COALESCE(cultivar, crop).
--
-- WHY. dtm_basis lives ONLY on crop_types, so a cultivar whose DTM is quoted on a different basis
-- than its crop has no way to say so. Live symptom on prod 2026-08-05: Rapini (crop_type_slug
-- 'broccoli', dtm_basis 'from-transplant') is direct-sown — sown_at 2026-07-30, transplanted_at
-- NULL — so plantingMaturity.js sets awaitingTransplant and the CropCard renders
-- "Est. harvest — set at transplant" with NO DATE AT ALL. Not a shifted estimate; an absent one.
--
-- WHY NOT A CROP-TYPE SPLIT. A 7-seat crucible (2026-08-05) rejected splitting Rapini/Kailaan into
-- their own slugs. Under the canonical rule (vault reference/garden-app-crop-types.md
-- §SPLIT vs FACET vs PROMOTE) zero CATEGORICAL columns diverge — harvest_habit='repeat' and
-- first_year_harvest=true are correct for both cultivars — and species is named in the Descriptive
-- row. The decisive objection: 'from-transplant' misfires for a direct-sown BELSTAR too, and
-- Belstar stays on 'broccoli' under any split. A boundary between two groups cannot fix a defect
-- present on both sides of it. The rule's own PROMOTE branch ("real divergence but >3 groups →
-- PROMOTE the column to plant_varieties with COALESCE(cultivar, crop)") is this file.
--
-- BACKWARD COMPATIBILITY — this migration is a PROVABLE NO-OP until a cultivar value is set.
-- The new column is nullable with no default, so every existing row is NULL and
-- COALESCE(v.dtm_basis, ct.dtm_basis) === ct.dtm_basis for all 407 live cultivars. There is no
-- window in which old code and new schema disagree: the OLD deployed reader selects ct.dtm_basis
-- directly and keeps working unchanged; the NEW reader selects the COALESCE and gets the identical
-- value. Per memory `arming-a-check-is-a-deploy`, note what this does NOT do: the CHECK below is
-- armed at creation, which is safe ONLY because it constrains a column no deployed writer sets.
-- Data (the actual Rapini/Kailaan basis correction) ships separately in 0b-data.sql so this file
-- stays a pure, reversible structural change.
--
-- VIEW. v_sow_candidates must expose the resolved value or sowEngine keeps reading the crop basis.
-- CREATE OR REPLACE is correct here and NOT the hazard its own sowarchive header warns about:
-- that warning is about ADDING columns and about the WHERE clause being ignored. This changes one
-- existing column's EXPRESSION while keeping its name, type, and ordinal position identical, and
-- the 4-predicate WHERE below is reproduced VERBATIM from pg_get_viewdef captured on prod
-- immediately before writing this file (33 columns). 0c-verify re-asserts both the predicate text
-- and the row count.
--
-- Usage: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 0a-additive-ddl.sql

BEGIN;

ALTER TABLE public.plant_varieties
  ADD COLUMN IF NOT EXISTS dtm_basis text;

-- Same domain as crop_types_dtm_basis_chk. NULL means "inherit the crop" and is the resting state
-- for every row, so this constrains only values a future writer sets deliberately.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plant_varieties_dtm_basis_chk') THEN
    ALTER TABLE public.plant_varieties
      ADD CONSTRAINT plant_varieties_dtm_basis_chk
      CHECK (dtm_basis IS NULL OR dtm_basis = ANY (ARRAY['from-sow'::text, 'from-transplant'::text]));
  END IF;
END $$;

COMMENT ON COLUMN public.plant_varieties.dtm_basis IS
  'Per-cultivar override for crop_types.dtm_basis. NULL = inherit the crop. Resolved as '
  'COALESCE(plant_varieties.dtm_basis, crop_types.dtm_basis) in v_sow_candidates and in the '
  'plants Lambda variety_ref projection. V4-DTMBASISVAR-001.';

-- 33 columns, byte-identical to the captured definition except dtm_basis, which becomes the
-- COALESCE. Column NAME, TYPE and POSITION are unchanged, which is what CREATE OR REPLACE validates.
CREATE OR REPLACE VIEW public.v_sow_candidates AS
 SELECT i.id AS inventory_item_id,
    i.name AS item_name,
    i.quantity_on_hand,
    i.unit,
    i.created_by,
    i.purchase_date,
    i.source,
    i.metadata,
    v.id AS variety_id,
    v.name AS variety_name,
    v.crop_type_slug,
    v.lifecycle,
    v.grown_as,
    v.sun_requirements,
    v.days_to_maturity_min,
    v.days_to_maturity_max,
    v.start_method,
    v.start_indoor_weeks_min,
    v.start_indoor_weeks_max,
    v.direct_sow_timing,
    v.sow_depth_in,
    v.seed_spacing_in,
    v.row_spacing_in,
    v.days_to_germ_min,
    v.days_to_germ_max,
    v.sow_season,
    v.sow_notes,
    v.growth_habit,
    v.day_length_response,
    ct.first_year_harvest,
    COALESCE(v.dtm_basis, ct.dtm_basis) AS dtm_basis,
    i.sow_archived_season,
    i.sow_archived_at
   FROM inventory_items i
     JOIN plant_varieties v ON v.id = i.variety_id
     LEFT JOIN crop_types ct ON ct.slug = v.crop_type_slug
  WHERE i.category = 'seeds'::text AND i.deleted_at IS NULL AND i.status = 'active'::text AND v.deleted_at IS NULL;

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('4.18.0-dtmbasisvar-001',
        'DTMBASISVAR: plant_varieties.dtm_basis text (nullable, CHECK NULL|from-sow|from-transplant) as a per-cultivar override of crop_types.dtm_basis, resolved COALESCE(variety, crop) in v_sow_candidates and in the plants Lambda variety_ref. Fixes a cultivar whose catalogue DTM is quoted on a different basis than its crop: prod Rapini (crop broccoli, from-transplant) is direct-sown with transplanted_at NULL, so plantingMaturity set awaitingTransplant and the card rendered no harvest date at all. Chosen over splitting Rapini/Kailaan into new crop_types slugs: a 7-seat crucible found zero CATEGORICAL columns diverge (harvest_habit=repeat and first_year_harvest=true are correct for both) and that from-transplant misfires for a direct-sown Belstar too, which stays on broccoli under any split - a boundary cannot fix a defect on both sides of it. Structurally a provable no-op: every existing row is NULL so COALESCE returns the crop value unchanged. View column count unchanged at 33; the 4-predicate WHERE is reproduced verbatim.',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;
-- ON CONFLICT because schema_version.version is the PRIMARY KEY, so a re-apply (after a
-- rollback rehearsal, or a retry following a partial failure) would otherwise die on a
-- duplicate-key error with the real work already done. Caught on the staging rollback
-- rehearsal 2026-08-05, which disproved this file's own earlier claim that a second row was
-- 'expected and harmless'. DO UPDATE rather than DO NOTHING so applied_at reflects the
-- latest apply.

COMMIT;
