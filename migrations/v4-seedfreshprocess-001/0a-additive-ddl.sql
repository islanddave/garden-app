-- V4-SEEDFRESHPROCESS-001 — seed_process gains 'fresh'.
--
-- WHY. The vocabulary was `wet | dry` and neither describes a pepper. Dave, 2026-09-03: "wet / dry
-- don't give any option for peppers, which just goes from fresh plant to drying for a few days then
-- saved. None of these two options works here."
--
-- He is right, and the copy made it worse in both directions: the wet option advertised "seed WASHED
-- or fermented out of wet pulp" while routing to the `fermenting` stage, so a user who read "washed"
-- and picked it would have had peppers filed as fermenting AND a permanent seed_lot_stage_log row
-- asserting a ferment that never happened. The dry option said "threshed from a pod dried ON THE
-- PLANT", which a fresh pepper also is not. Peppers fell in the gap between two labels.
--
-- 'fresh' is seed scraped from a ripe fruit, rinsed, and dried — no ferment, no dried pod. It enters
-- at the SAME `drying` stage 'dry' does; the distinction is provenance, not routing. That matters
-- here because peppers are this garden's largest seed crop (36 Capsicum cultivars, ~175 plants) and
-- recording them as "threshed from a dried pod" would be false on every one.
--
-- WIDENING, NOT NARROWING, so this is safe on live data by construction: every existing row is still
-- valid under the new CHECK. The reverse would not be. Live population at authoring time: 260 seed
-- rows with seed_process NULL and exactly ONE row set ('dry'), so nothing is reinterpreted.
--
-- DEPLOY ORDER IS LOAD-BEARING AND IS NOT OPTIONAL:
--   1. this migration (widens the DB CHECK)
--   2. lambda/inventory-items deploy (TWO SEED_PROCESSES arrays in one file, both must move)
--   3. client
-- Ship the client first and a 'fresh' write is refused by the Lambda validator with a 400. Ship the
-- Lambda first and it is refused by this CHECK. Neither failure is silent, but both are avoidable.

ALTER TABLE public.inventory_items
  DROP CONSTRAINT IF EXISTS inventory_items_seed_process_check;

ALTER TABLE public.inventory_items
  ADD CONSTRAINT inventory_items_seed_process_check
  CHECK (seed_process IS NULL OR seed_process = ANY (ARRAY['wet'::text, 'dry'::text, 'fresh'::text]));
