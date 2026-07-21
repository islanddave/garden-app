-- V4-RADICCHIO-001 — additive + data correction. Non-destructive, idempotent, re-runnable.
--
-- Bug: cultivar "Palla Rossa Mavrik" (Cichorium intybus, a radicchio) carried crop_type_slug='endive'.
-- Chain: seeds/seed-load-dataset-V1.json authored crop_type_slug_guess='endive' for the Radicchio packet
-- (nearest catalog neighbour — Cichorium, but the WRONG species: endive is C. endivia); packetToVarietyCols
-- kept it because 'endive' is a valid slug, so the wrong-but-valid guess passed the whitelist gate
-- unchallenged and loaded as fact. crop_types had no 'radicchio' row to land on.
-- Downstream damage beyond the label: endive is harvest_habit='cut_and_come_again' (repeat 10d), radicchio
-- heads are cut once — so the harvest model was wrong too, and the derived facet tag read type:endive.
--
-- Fix: create the missing crop_types row, repoint the cultivar, then re-run applyDerive (see redrive.mjs)
-- to swap the derived type: tag. Harvest timing attrs (loss_horizon/set_to_first_pick/season) are left NULL,
-- matching the v4-seedinv-002 intake precedent — only harvest_habit is asserted, since single-cut is
-- definitional for a heading radicchio.

INSERT INTO crop_types (slug, display_name, category, default_lifecycle, harvest_habit, sort_order, created_by)
VALUES ('radicchio', 'Radicchio', 'vegetable', 'biennial', 'single', 0, 'v4-radicchio-001')
ON CONFLICT (slug) DO NOTHING;

UPDATE plant_varieties
   SET crop_type_slug = 'radicchio', updated_at = now()
 WHERE id = '0609afc2-51ea-4045-858b-fe28060e2f20'
   AND crop_type_slug = 'endive';

-- Verify: expects radicchio/Cichorium intybus, and Tres Fine (C. endivia) still on endive.
-- SELECT name, species, crop_type_slug FROM plant_varieties
--  WHERE crop_type_slug IN ('radicchio','endive') AND deleted_at IS NULL;
