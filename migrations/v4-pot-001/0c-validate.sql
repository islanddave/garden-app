-- V4-POT-001 S1 — 0c validate
-- Date: 2026-06-18
-- Scope: VALIDATE chk_plants_container_type added NOT VALID in 0a.
-- Pre-condition: pre-VALIDATE sweep (runner-enforced) confirmed all existing rows
--                have container_type IS NULL (columns were unpopulated before PLANT-CONTAINER-001).

BEGIN;

ALTER TABLE public.plants
  VALIDATE CONSTRAINT chk_plants_container_type;

COMMIT;
