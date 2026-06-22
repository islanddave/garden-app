-- V3-STATUS-001 — add 'preparing' project status (bed-prep: trench dug, soil amending)
-- Date: 2026-06-22
-- Scope: ADDITIVE widen of plant_projects_status_check to allow the new 'preparing' value.
-- The frontend (constants.js PROJECT_STATUSES + StatusSelect) must NOT ship before this lands
-- on prod, or writing a 'preparing' project 500s on the CHECK (L-090/L-091 latent-500 trap).
-- Safe additive: every existing row already satisfies the widened set; DROP+ADD in one txn.
-- Verified live constraint pre-change (2026-06-22): planning, seeding, sprouting, growing,
-- flowering, fruiting, harvesting, active, harvested, ended.

BEGIN;

ALTER TABLE public.plant_projects DROP CONSTRAINT IF EXISTS plant_projects_status_check;

ALTER TABLE public.plant_projects
  ADD CONSTRAINT plant_projects_status_check
  CHECK (status = ANY (ARRAY[
    'planning','preparing','seeding','sprouting','growing','flowering',
    'fruiting','harvesting','active','harvested','ended'
  ]::text[]));

COMMIT;
