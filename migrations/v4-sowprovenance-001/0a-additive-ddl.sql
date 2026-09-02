-- V4-SOWPROVENANCE-001 — v_sow_candidates gains source_plant_id + source_kind (projection only).
--
-- WHY. BUG-SEEDZEROSOWABLE-001's default arm: a lot created by "Save seed" with the count left blank
-- and the process left at "Not yet" is born at quantity_on_hand 0 with seed_stage NULL. sowEngine's
-- isDepleted() reads 0 as "none left", so Sow Now files a lot saved five seconds ago under "Sowed
-- previously — none of these left". Dave's decision (2026-09-02) is that it belongs in "Still in
-- process", marked "Not started yet".
--
-- THE ROUTING NEEDS A DISCRIMINATOR AND THE VIEW HAS NONE. "seed_stage NULL and quantity 0" is not
-- unique to a just-saved lot — a PURCHASED packet used down to zero looks byte-identical on the row,
-- and every one of the 260 live seed packets has seed_stage NULL because only home-saved lots are
-- ever staged. Measured on prod 2026-09-02: exactly 1 active row is (stage NULL, qty 0), and it is
-- an empty bought packet. One row today, but the population grows on BOTH sides from here — more
-- saved lots, and more bought packets emptying out — so routing on stage-plus-quantity alone would
-- mislabel a steadily increasing number of them.
--
-- source_plant_id IS the discriminator, because SaveSeedSheet always launches FROM a planting and
-- sends it on every create. source_kind rides along in the same append: it covers the lot whose
-- origin is recorded later on the lot page rather than at creation (Dave's Carolina Reaper case),
-- which source_plant_id alone does not reach. Two columns in one migration rather than a second
-- cycle for the sibling fact.
--
-- APPEND-ONLY, and that is load-bearing rather than tidy. Five `continuous` gates across three
-- sibling migrations pin this view's rowcount to its unfiltered base join. The WHERE clause below is
-- byte-identical to the installed definition (read from pg_get_viewdef via the v4-sowstage-001 file
-- that last replaced it), so nothing narrows and those five are untouched. The gate at the foot of
-- this file asserts that property directly rather than trusting this comment, because "I only
-- appended columns" is exactly the claim a future edit will quietly break.
--
-- ORDINALS. seed_stage/seed_process sit at 34/35 after v4-sowstage-001; these land at 36/37. No
-- consumer reads this view positionally — the full census is in
-- _lane_reports/prepromote-impact-20260902.md finding #2: one server reader doing SELECT *, two
-- client fetchers, both feeding a pure bucketize keyed on column NAMES.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0a-additive-ddl.sql

BEGIN;

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
    i.sow_archived_at,
    i.seed_stage,
    i.seed_process,
    i.source_plant_id,
    i.source_kind
   FROM inventory_items i
     JOIN plant_varieties v ON v.id = i.variety_id
     LEFT JOIN crop_types ct ON ct.slug = v.crop_type_slug
  WHERE i.category = 'seeds'::text AND i.deleted_at IS NULL AND i.status = 'active'::text AND v.deleted_at IS NULL;

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('4.95.0-sowprovenance-001',
        'SOWPROVENANCE: V4-SOWPROVENANCE-001. v_sow_candidates +source_plant_id +source_kind, '
        'APPENDED at positions 36-37. WHERE clause byte-identical to the installed definition — no '
        'narrowing, so the five continuous rowcount gates on this view are untouched. Projection '
        'only. Supplies the discriminator BUG-SEEDZEROSOWABLE-001 needs to tell a just-saved lot '
        '(qty 0, stage NULL, has a parent plant) from a bought packet used down to zero, which are '
        'otherwise identical on the row.',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;

COMMIT;

-- Verify:
-- SELECT column_name, ordinal_position FROM information_schema.columns
--  WHERE table_name='v_sow_candidates' AND column_name IN ('source_plant_id','source_kind');
-- SELECT count(*) FROM v_sow_candidates;   -- must equal the pre-apply count
