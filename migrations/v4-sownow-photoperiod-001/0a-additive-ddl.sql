-- migrations/v4-sownow-photoperiod-001/0a-additive-ddl.sql
-- V4-SOWNOW-PHOTOPERIOD-001 — widen public.v_sow_candidates with the two variety columns the
-- /sow viability gate needs: growth_habit (bunching-vs-bulbing exclusion signal) and
-- day_length_response (informational only — ~all-NULL in prod, NEVER a gate condition).
--
-- IDEMPOTENT: CREATE OR REPLACE VIEW; schema_version INSERT is ON CONFLICT DO NOTHING.
--
-- APPEND-ONLY CONSTRAINT (why the column list below is verbatim): Postgres CREATE OR REPLACE VIEW
-- may only ADD columns at the END. Reordering, renaming, retyping or dropping any existing column
-- makes the apply FAIL. The 27 columns below were transcribed from LIVE pg_get_viewdef on
-- 2026-07-24 (the v4-seedinv-001/0a file lags manual ALTERs and is NOT the authority here).
--
-- ZERO READ-IMPACT: the sole consumer is lambda/inventory-items/index.js
-- `SELECT * FROM v_sow_candidates` -> object-property access. No consumer reads by ordinal, so the
-- two appended columns are inert until the engine references them. Apply this BEFORE deploying the
-- engine (the engine's gate additionally fails SAFE on an undefined column).

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
     v.day_length_response
    FROM inventory_items i
      JOIN plant_varieties v ON v.id = i.variety_id
   WHERE i.category = 'seeds'::text AND i.deleted_at IS NULL AND i.status = 'active'::text AND v.deleted_at IS NULL;

INSERT INTO public.schema_version (version, description)
VALUES ('4.14.0-sownow-photoperiod-001',
        'v_sow_candidates += growth_habit, day_length_response for the /sow allium viability gate')
ON CONFLICT DO NOTHING;

COMMIT;
