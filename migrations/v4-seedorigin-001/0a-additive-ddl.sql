-- V4-SEEDORIGIN-001 — where did this seed lot come from, when it did NOT come from a planting?
--
-- WHY THIS EXISTS. v4-seedlink-001 shipped inventory_items.source_plant_id, which answers "which of
-- MY plants did this lot come from". It cannot answer the other half: seed scraped out of a
-- store-bought Carolina Reaper, a gift packet, a u-pick fruit. Today that provenance is encoded by
-- hand in the item's name — a real prod row reads "Money Plant (self-saved, variety unrecorded)".
--
-- NO NEW VOCABULARY. THIS IS THE WHOLE DESIGN DECISION.
-- A six-seat panel on 2026-09-02 produced FOUR competing new vocabularies for this one concept
-- (purchased_packet|saved_own|…, own_plant|external_fruit|…, own_plant|purchased_produce|…). Three
-- of six seats independently minted one while a shipped, constrained, drift-gated vocabulary for the
-- identical concept sat one table over. lambda/preservation/provenance.js exports VALID_SOURCE_KINDS
-- (own_garden|u_pick|farm_stand|csa|store|gift|foraged|other), is dependency-free on purpose so the
-- blocking CI suite can import it, is mirrored in src/lib/dropdownRegistry.js as
-- PUTUP_SOURCE_OPTIONS, and carries its own dated warning that THIS schema already fragmented a
-- provenance vocabulary once (plants.source_type, v4-source-freetext, 2026-07-07). Minting
-- `seed_origin` would rebuild a module, a registry entry and two drift gates that exist and are green.
--
-- The vocabulary is reused verbatim. The three-place sync (this CHECK / provenance.js /
-- dropdownRegistry.js) is the same one preservationProvenance.test.js already guards.
--
-- AND IT LOSES NOTHING. The objection to reuse is that `store` conflates "I bought a seed packet"
-- with "I bought a pepper and scraped it". True — and that axis is ALREADY a shipped column.
-- seed_process is non-NULL exactly when a human extracted seed, so two orthogonal columns answer the
-- whole matrix with zero new vocabulary:
--
--                      seed_process IS NULL        seed_process IS NOT NULL
--   'own_garden'       packet mis-tagged           saved from my own plant (+ source_plant_id)
--   'store'            purchased seed packet       the Carolina Reaper case
--   'gift'             gifted packet               gifted fruit, seed extracted
--   NULL               not recorded                extracted, origin not recorded
--
-- Do NOT reuse the word "origin" for the column: inventory_items.metadata.origin is populated on
-- 178 of 260 seed rows meaning INTAKE BATCH ('BI-order-2026-06-09'). Hence source_kind.
--
-- NO DEFAULT, DELIBERATELY. grown_as DEFAULT 'annual' stamped 362 of 413 cultivars with a value
-- nobody chose and had to be dropped on 2026-09-01. NULL here means "not recorded", which is the
-- honest state of every existing row.
--
-- CHECKS ADDED VALID, NOT `NOT VALID`. Same exception both sibling migrations documented: the
-- NOT-VALID-then-VALIDATE pattern (L-058) guards against a scan tripping on historical rows and
-- against a still-deployed old writer. source_kind is created in this statement so every row is
-- NULL, and the two category CHECKs are asserted against a population the handlers already refuse
-- to violate. Leaving an unvalidated constraint for someone to arm later is its own trap — arming a
-- CHECK is a deploy against the still-live old writer (2026-08-03 incident).
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0a-additive-ddl.sql

BEGIN;

ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS source_kind text;

-- 1. Membership. Mirrors VALID_SOURCE_KINDS in lambda/preservation/provenance.js AND
--    PUTUP_SOURCE_OPTIONS in src/lib/dropdownRegistry.js. Changing this list means changing all
--    three in the same commit — src/__tests__/preservationProvenance.test.js asserts the JS halves
--    equal each other, and the post gate below asserts this constraint's exact membership.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_inventory_source_kind') THEN
    ALTER TABLE public.inventory_items
      ADD CONSTRAINT chk_inventory_source_kind
      CHECK (source_kind IS NULL OR source_kind = ANY (ARRAY[
        'own_garden','u_pick','farm_stand','csa','store','gift','foraged','other'
      ]));
  END IF;
END
$$;

-- 2. Mutual exclusion — a verbatim port of chk_preservation_log_source_plant, which is the exact
--    rule this surface lacks in the exact shape it needs: a lot cannot claim a parent PLANT while
--    also claiming it came from a shop. The first arm admits NULL, so the constraint is satisfiable
--    at every population and never gets more expensive to add. (The alternative shape proposed by
--    one seat — source_plant_id IS NULL OR source_kind = 'own_garden' — REQUIRES the discriminator
--    whenever a parent is set, which narrows an existing column's admissible values. Strictly worse.)
--    The JS half of this rule already exists at provenance.js:92-95 for preservation_log.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_inventory_seed_source_plant') THEN
    ALTER TABLE public.inventory_items
      ADD CONSTRAINT chk_inventory_seed_source_plant
      CHECK (source_kind IS NULL OR source_kind = 'own_garden' OR source_plant_id IS NULL);
  END IF;
END
$$;

-- 3. source_kind is a seed concept. A shovel does not have a provenance kind.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_inventory_source_kind_seeds_only') THEN
    ALTER TABLE public.inventory_items
      ADD CONSTRAINT chk_inventory_source_kind_seeds_only
      CHECK (source_kind IS NULL OR category = 'seeds');
  END IF;
END
$$;

-- 4. NOT new vocabulary — an unenforced rule the code already asserts in two places, closed at the
--    only layer that cannot be bypassed. Both the PATCH /source-plant UPDATE and the POST INSERT
--    carry category='seeds'; this stops a future writer from being the exception. Zero violations
--    on prod at time of authoring (0 of 388 rows carry source_plant_id at all).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_inventory_source_plant_seeds_only') THEN
    ALTER TABLE public.inventory_items
      ADD CONSTRAINT chk_inventory_source_plant_seeds_only
      CHECK (source_plant_id IS NULL OR category = 'seeds');
  END IF;
END
$$;

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('4.94.0-seedorigin-001',
        'SEEDORIGIN: V4-SEEDORIGIN-001. inventory_items +source_kind text NULL, no default. Four '
        'CHECKs added VALID: membership reusing preservation_log''s shipped VALID_SOURCE_KINDS '
        'vocabulary (no new vocabulary minted); mutual exclusion ported verbatim from '
        'chk_preservation_log_source_plant; source_kind seeds-only; source_plant_id seeds-only '
        '(closes a declared-but-unenforced rule, 0 violations). Additive and expand-only: no view '
        'widened, no column altered, no backfill, no default. Substrate only.',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;

COMMIT;

-- Verify:
-- SELECT column_name, is_nullable, column_default FROM information_schema.columns
--  WHERE table_name='inventory_items' AND column_name='source_kind';
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--  WHERE conname LIKE 'chk_inventory_source%' OR conname='chk_inventory_seed_source_plant';
