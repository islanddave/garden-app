-- migrations/v4-sownow-photoperiod-001/0r-rollback.sql
-- Reverse of 0a-additive-ddl.sql.
--
-- MUST be DROP + recreate, NOT CREATE OR REPLACE: Postgres CREATE OR REPLACE VIEW cannot REMOVE a
-- trailing column. The 27-column body below is the verbatim pre-widen definition captured from LIVE
-- pg_get_viewdef on 2026-07-24 (audit §0-e).
--
-- SAFE TO DROP: pg_depend showed ZERO dependent views/matviews on v_sow_candidates (audit §0-f), so
-- the DROP cannot cascade-break another object. Re-verify before running if time has passed.
--
-- ORDER: roll the ENGINE back first (or confirm no deployed code reads growth_habit /
-- day_length_response), THEN run this — a deployed gate reading a dropped column falls back to
-- crop_type_slug and over-gates (fails safe), but leaves bunching onions wrongly suppressed.

BEGIN;

DROP VIEW public.v_sow_candidates;

CREATE VIEW public.v_sow_candidates AS
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
     v.sow_notes
    FROM inventory_items i
      JOIN plant_varieties v ON v.id = i.variety_id
   WHERE i.category = 'seeds'::text AND i.deleted_at IS NULL AND i.status = 'active'::text AND v.deleted_at IS NULL;

DELETE FROM public.schema_version WHERE version='4.14.0-sownow-photoperiod-001';

COMMIT;
