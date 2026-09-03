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

-- THIS INSERT WAS MISSING and its absence was not cosmetic. Without it the migration left NO durable
-- record it had run, on either environment — so after both envs were genuinely applied on 2026-09-03,
-- `SELECT count(*) FROM schema_version WHERE version ILIKE '%seedfresh%'` still returned 0 on both,
-- and an applied environment was indistinguishable from an unapplied one. Two sessions independently
-- read that 0 as "not applied"; one of them was right about prod and wrong about staging, and neither
-- could tell from the ledger which.
--
-- Two further things it costs, beyond the record itself:
--   · a `pre_not_already_applied` guard cannot be written at all, so nothing detects a re-apply;
--   · no post gate can SELF-ARM through the house's
--     `WHERE EXISTS (SELECT 1 FROM public.schema_version WHERE version = ...)` idiom — which is why
--     this directory's standing post gates went red the moment it landed on dev, before anything had
--     been applied anywhere. A gate that fires against an unmigrated database is not a strict gate,
--     it is a false alarm that teaches people to ignore the gate run.
--
-- ON CONFLICT because `schema_version.version` is the PRIMARY KEY: a re-apply after a rollback
-- rehearsal or a partial failure would otherwise die on a duplicate key with the real work already
-- done. DO UPDATE rather than DO NOTHING so `applied_at` reflects the latest apply. Pattern and
-- reasoning follow v4-dtmbasisvar-001, which learned it on a staging rollback rehearsal.
INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('4.104.0-seedfreshprocess-001',
        'SEEDFRESHPROCESS: inventory_items.seed_process CHECK widened from (wet|dry) to (wet|dry|fresh). ''fresh'' is seed scraped from a ripe fruit, rinsed and dried — no ferment and no dried pod — which neither existing value described. Peppers fell in the gap: the wet option advertised "washed" while routing to the fermenting stage, so a pepper saved that way got a permanent seed_lot_stage_log row asserting a ferment that never happened, and the dry option claimed a pod dried on the plant. Enters at the same drying stage as ''dry''; the distinction is provenance, not routing. A pure widening — every pre-existing row stays valid, and at authoring time prod held 260 seed rows with seed_process NULL and exactly one set to ''dry'', so nothing was reinterpreted.',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;
