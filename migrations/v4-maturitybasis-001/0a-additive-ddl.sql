-- migrations/v4-maturitybasis-001/0a-additive-ddl.sql
-- V4-MATURITYBASIS-001 Slice C — widen public.v_sow_candidates with crop_types.dtm_basis.
--
-- WHY: sowEngine's fall indoor pass computes the last date seed may be STARTED INDOORS by
-- subtracting days_to_maturity straight off the fall frost anchor, which assumes DTM counts from
-- that indoor sow. For a crop whose catalogue DTM is quoted FROM TRANSPLANT that omits the entire
-- nursery period. Measured on live prod 2026-08-04: 16 fall_indoor windows read OPEN, 14 of them
-- from-transplant crops (kale, collard, broccoli, kohlrabi, lettuce) whose real latest-start had
-- already passed, between 2026-06-23 and 2026-07-17. The engine was inviting Dave to start fall
-- brassicas that cannot beat a Sep-28 frost.
--
-- IDEMPOTENT: CREATE OR REPLACE VIEW; schema_version INSERT is ON CONFLICT DO NOTHING.
-- ENV-AGNOSTIC: prod and staging carry byte-identical view definitions (md5-compared 2026-08-04),
-- and crop_types.dtm_basis exists on BOTH (staging got it via v4-staging-reconcile-001, verified
-- applied in full on 2026-08-04). The same statement is correct against either.
--
-- APPEND-ONLY CONSTRAINT (why the column list below is verbatim): Postgres CREATE OR REPLACE VIEW
-- may only ADD columns at the END. Reordering, renaming, retyping or dropping any existing column
-- makes the apply FAIL. The 30 columns below were transcribed from LIVE pg_get_viewdef on
-- 2026-08-04. NOTE the drift trap flagged in v4-sownow-photoperiod-001/0a: that file's body is
-- STALE (28 columns, no crop_types join). Live pg_get_viewdef is the authority, not the newest
-- migration file.
--
-- ZERO READ-IMPACT: the sole consumer is lambda/inventory-items/index.js
-- `SELECT * FROM v_sow_candidates` -> object-property access. No consumer reads by ordinal, and the
-- DEPLOYED frontend bundle ignores unknown JSON keys, so the appended column is inert until the
-- Slice C engine ships. Apply this BEFORE deploying the engine: the engine treats an absent/NULL
-- dtm_basis as from-sow, i.e. today's exact behaviour, so it fails SAFE either way.
--
-- ORDER: staging (pre gates -> 0a -> post gates -> deploy-staging regression) THEN prod, THEN the
-- engine deploy.

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
     ct.dtm_basis
    FROM inventory_items i
      JOIN plant_varieties v ON v.id = i.variety_id
      LEFT JOIN crop_types ct ON ct.slug = v.crop_type_slug
   WHERE i.category = 'seeds'::text AND i.deleted_at IS NULL AND i.status = 'active'::text AND v.deleted_at IS NULL;

INSERT INTO public.schema_version (version, description)
VALUES ('4.20.5-maturitybasis-001',
        'v_sow_candidates += crop_types.dtm_basis, so sowEngine''s fall indoor pass can subtract the nursery period for from-transplant crops')
ON CONFLICT DO NOTHING;

COMMIT;
