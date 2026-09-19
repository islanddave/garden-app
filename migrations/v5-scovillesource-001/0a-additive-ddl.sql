-- V5-SEEDCARDS-001 (scoville provenance, Dave-approved 2026-09-19 by AUQ) — record WHERE a
-- cultivar's Scoville number came from, so a best-guess heat value can be stored AND shown as a
-- guess ("est. 100K–350K SHU") instead of passing as a supplier figure.
--
-- NOT APPLIED as of authoring (2026-09-19). The authoring lane executed no DDL anywhere — not on
-- staging, not on prod. Sequencing is in gates.yml's header.
--
-- WHY. src/lib/varietySpec.js carries a "No fabrication" contract: absent data => null, chip hidden.
-- It holds only while every stored scoville_min/max is a figure somebody read off a packet or a
-- catalogue. The moment an estimate is stored in those same two columns, the chip renders it with
-- exactly the authority of a vendor figure and the contract is silently false. This column is what
-- lets the reader tell the two apart; shuLabel prefixes the WORD "est. " when it reads 'inference'
-- (a word, not a glyph: the chip is 0.75rem, and commit 4382da4 set that house rule for a 0.78rem
-- line — a leading symbol at that size reads as a smudge).
--
-- VOCABULARY. The same six values as chk_plant_varieties_breeding_source
-- (v5-varietyhybridflag-001), which is the provenance vocabulary this table already speaks. Read on
-- prod 2026-09-19: packet_label, vendor_catalog, breeder, reference_work, grower_record, inference.
--
-- NULL = never recorded, and it renders exactly as today. 104 live cultivars (111 counting
-- soft-deleted) carry scoville numbers on prod as of 2026-09-19 and every one of them is born NULL
-- here. NULL is NOT a claim that the figure is sourced; it is the absence of any claim, which is
-- the state all 104 are actually in.
--
-- NO PAIRING CHECK between scoville_min/max and scoville_source, deliberately — the sibling
-- breeding_system IS paired (chk_plant_varieties_breeding_sourced), so a later reader will want
-- symmetry here, and must not add it:
--   * "numbers => source" cannot be created VALIDATED over the 104 unsourced rows, and created
--     NOT VALID it still refuses any UPDATE of a violating row (measured on this table by the
--     V5-HEIRLOOMSTATUS-001 panel, per hybridflag's header) — so it would 23514 Dave's own next
--     edit of any of them.
--   * the varieties PUT (lambda/varieties/index.js, an explicit SET list) and
--     VarietyEditor.buildVarietyPatch (a declared FIELDS list) both edit scoville_min/max WITHOUT
--     naming this column, so no deployed writer could ever satisfy a pairing in either direction.
-- gates.yml pins that decision (post_no_check_couples_scoville_source).
--
-- THE CHECK IS CREATED VALIDATED, NOT `NOT VALID` — hybridflag's reasoning, which holds unchanged:
-- a NOT VALID CHECK defers nothing about writer coupling (it is armed the instant it exists) and
-- leaves a permanent convalidated=false that a later reader cannot tell from "known violators
-- exist". The column is born NULL and the CHECK is NULL-tolerant, so there is nothing to scan.
-- Per memory `arming-a-check-is-a-deploy`: arming is safe here ONLY because no deployed writer
-- names this column — every one of them writes NULL, which the CHECK admits.
--
-- NO DEFAULT, deliberately. A DEFAULT of any vocabulary value would stamp a provenance claim on
-- every cultivar created afterwards with nobody having looked — the `grown_as` failure (a bulk
-- default that set 'annual' on 362 of 413 cultivars and made the column worthless as evidence).
--
-- VIEW. public.cultivar is an EXPLICIT column list, not SELECT *, and it does not inherit a new
-- base-table column. lambda/inventory-items (the seed list + seed detail) and lambda/plants
-- (planting.variety_ref, which CropCard renders the SHU chip from) both read scoville through it,
-- and lambda/varieties both READS and WRITES through it. Without the widen below the column is
-- invisible to every app surface — the V4-DTMBASISVAR-001 near-outage class. The 46-column list was
-- captured from pg_get_viewdef('public.cultivar', true) on PROD 2026-09-19 immediately before
-- writing this file (server-side md5 12daf78b11fb90953fba3d4d7f31b858, byte-identical on staging);
-- scoville_source is appended LAST as a plain pass-through so the view stays auto-updatable for the
-- varieties INSERT/UPDATE and the new column is itself updatable through it.
--
-- KNOWN CONSEQUENCE, the safe direction: because the PUT does not name this column, replacing an
-- estimate with a packet figure in VarietyEditor leaves scoville_source='inference', so the chip
-- keeps its "est." until the source is updated. That UNDER-claims. The opposite failure — an estimate
-- read as a supplier figure — is the one this migration exists to prevent.
--
-- No backfill ships here. The estimates this column labels are loaded separately, with
-- scoville_source='inference' set in the same statement as the numbers.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0a-additive-ddl.sql

BEGIN;

ALTER TABLE public.plant_varieties
  -- Provenance OF scoville_min/scoville_max. Nullable, no DEFAULT (header).
  ADD COLUMN IF NOT EXISTS scoville_source text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_plant_varieties_scoville_source') THEN
    -- The six values of chk_plant_varieties_breeding_source, in the same order.
    ALTER TABLE public.plant_varieties ADD CONSTRAINT chk_plant_varieties_scoville_source
      CHECK (scoville_source IS NULL OR scoville_source = ANY (ARRAY[
        'packet_label'::text,
        'vendor_catalog'::text,
        'breeder'::text,
        'reference_work'::text,
        'grower_record'::text,
        -- A best guess (from the pod type, a sibling cultivar, a range typical of the class).
        -- The ONLY value the client renders differently: shuLabel prefixes "est. ".
        'inference'::text]));
  END IF;
END $$;

COMMENT ON COLUMN public.plant_varieties.scoville_source IS
  'V5-SEEDCARDS-001. Where scoville_min/scoville_max came from; same vocabulary as breeding_source. '
  'NULL = never recorded (renders as today). inference = a best guess, which the app labels '
  '"est. ... SHU" so it never passes as a supplier figure. Deliberately NOT paired with the numbers '
  'by a CHECK: the varieties PUT edits scoville_min/max without naming this column. See '
  'migrations/v5-scovillesource-001/0a-additive-ddl.sql.';

-- WIDEN public.cultivar. 46 columns captured verbatim from pg_get_viewdef on PROD 2026-09-19, with
-- scoville_source appended LAST. Omitting this is the whole-surface outage: the inventory-items and
-- plants Lambdas project pv.scoville_source through this view.
CREATE OR REPLACE VIEW public.cultivar AS
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
    variety_rank,
    scoville_source
   FROM plant_varieties;

-- Re-grant explicitly, GUARDED ON THE ROLE EXISTING — copied from v5-varietyhybridflag-001, whose
-- header carries the full reasoning. In short: CREATE OR REPLACE preserves grants, so this is
-- belt-and-braces here, but 0r narrows the view with DROP + CREATE, which does not. And an
-- unguarded GRANT FAILED hybridflag's staging apply (`role "garden_ro" does not exist`), because
-- staging has neither garden_ro nor garden_export_ro (re-read 2026-09-19: still no garden_ro).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'garden_ro') THEN
    EXECUTE 'GRANT SELECT ON public.cultivar TO garden_ro';
  END IF;
END $$;

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('5.0.0-scovillesource-001',
        'SCOVILLESOURCE: V5-SEEDCARDS-001. plant_varieties.scoville_source (nullable text, no DEFAULT) '
        'recording where scoville_min/scoville_max came from, with chk_plant_varieties_scoville_source '
        'created VALIDATED over the six breeding_source values (packet_label, vendor_catalog, breeder, '
        'reference_work, grower_record, inference). inference renders as "est. ... SHU" so a best '
        'guess never passes as a supplier figure (varietySpec.js No-fabrication contract). NO pairing '
        'CHECK '
        'with the numbers: 104 live cultivars carry unsourced scoville on prod and the varieties PUT '
        'edits the numbers without naming this column, so a pairing would 23514 the next edit. '
        'public.cultivar widened 46 -> 47, scoville_source appended last as a pass-through so the view '
        'stays auto-updatable. No backfill.',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;
-- ON CONFLICT because schema_version.version is the PRIMARY KEY, so a re-apply after a rollback
-- rehearsal or a partial-failure retry would otherwise die on duplicate key with the real work
-- already committed. That failure was found on the v4-dtmbasisvar-001 staging rehearsal.

COMMIT;
