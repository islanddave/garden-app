-- V4-SOURCEFREE-001 (2026-07-07): make plants.source_type FREE-TEXT (like event_type).
-- Drops the value-allowlist CHECK so new source options (e.g. 'plant_swap', and 'rescued'/'cutting_taken'
-- on the create path) store without a schema change. NON-DESTRUCTIVE: DROP CONSTRAINT removes a
-- constraint only — no data is touched, fully reversible by re-adding the CHECK. Idempotent (IF EXISTS).
-- Apply to prod AND staging BEFORE the frontend that offers new options goes live (paired with the
-- lambda/plants free-text change + dropdownRegistry plant_swap option). No dependent code requires
-- this constraint after the V4-SOURCEFREE-001 lambda ships.
ALTER TABLE plants DROP CONSTRAINT IF EXISTS plants_source_type_check;
