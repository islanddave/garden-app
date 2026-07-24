-- care-rekey-001/0a-additive-ddl.sql
-- Care re-key (project_id -> plant_id), Phase A: ADDITIVE schema only. Design V100.
--
-- ⚠ APPLYING THIS TO LIVE NEON IS DAVE-GATED. No pipeline auto-applies migrations/**
--   (schema-audit.yml only READS prod to verify lambda column refs). Apply manually,
--   prod + staging, BEFORE any code that reads entity_memory.plant_id ships.
--
-- All changes are ADDITIVE or RELAXATIONS — nothing reads plant_id yet, and existing
-- rows keep satisfying every (relaxed) constraint:
--   * entity_memory.plant_id starts all-NULL  -> FK + partial-unique trivially hold
--   * 2-way -> 3-way exactly-one-parent       -> every existing row still has exactly
--     one of {project_id, location_id}; the new plant arm is unused (all NULL)
--   * event_log.project_id DROP NOT NULL       -> relaxation; every existing row still
--     carries project_id, so event_log_has_anchor (NOT VALID) holds for all of them
--   * harvest_log.project_id DROP NOT NULL      -> relaxation (needed so a harvest on a
--     future projectless planting doesn't fail harvest_log's NOT NULL — design §4 miss)
--
-- Grounded in live prod Neon introspection (pg_constraint / information_schema), NOT the
-- migration tree: entity_memory / event_log / harvest_log base-table constraints are not
-- present in tracked migrations (live Neon is the sole schema authority).
--
-- ORDER OF OPERATIONS: run the CONCURRENTLY index statement OUTSIDE a transaction block
-- (it cannot run inside one). The DO-block guards make every statement idempotent/re-runnable.

-- 1. entity_memory: additive plant parent -----------------------------------------------
ALTER TABLE entity_memory ADD COLUMN IF NOT EXISTS plant_id uuid;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entity_memory_plant_id_fkey') THEN
    ALTER TABLE entity_memory
      ADD CONSTRAINT entity_memory_plant_id_fkey
      FOREIGN KEY (plant_id) REFERENCES plants(id) ON DELETE RESTRICT;
  END IF;
END $$;

-- Partial unique: one care row per planting, but the project/location arms stay unconstrained.
-- MUST be its own statement, run OUTSIDE a transaction (CREATE INDEX CONCURRENTLY).
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS entity_memory_plant_id_key
  ON entity_memory (plant_id) WHERE plant_id IS NOT NULL;

-- 2. entity_memory: 2-way -> 3-way exactly-one-parent (plant XOR project XOR location) ----
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entity_memory_exactly_one_parent') THEN
    ALTER TABLE entity_memory DROP CONSTRAINT entity_memory_exactly_one_parent;
  END IF;
  ALTER TABLE entity_memory ADD CONSTRAINT entity_memory_exactly_one_parent
    CHECK ( ( (plant_id IS NOT NULL)::int
            + (project_id IS NOT NULL)::int
            + (location_id IS NOT NULL)::int ) = 1 );
END $$;

-- 3. event_log: allow plant-only events (project_id nullable + anchor guard) -------------
ALTER TABLE event_log ALTER COLUMN project_id DROP NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'event_log_has_anchor') THEN
    -- NOT VALID: skip the full-table scan now; VALIDATE in a later phase (L-058 pattern).
    -- Every existing row has project_id, so it already satisfies this.
    ALTER TABLE event_log ADD CONSTRAINT event_log_has_anchor
      CHECK (plant_id IS NOT NULL OR project_id IS NOT NULL) NOT VALID;
  END IF;
END $$;

-- 4. harvest_log: allow harvest on a (future) projectless planting ----------------------
ALTER TABLE harvest_log ALTER COLUMN project_id DROP NOT NULL;
