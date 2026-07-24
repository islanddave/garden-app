-- care-rekey-001/0b-backfill.sql
-- Care re-key Phase C: reconstruct per-planting entity_memory rows from event_log.
-- Design V100 §3-C. Requires 0a applied first (entity_memory.plant_id + partial unique index).
--
-- ⚠ APPLYING THIS TO LIVE NEON IS DAVE-GATED. Idempotent + re-runnable (ON CONFLICT ... GREATEST)
--   so it can sweep the gap window before a read cutover. Run against a Neon branch cloned from
--   prod and row-count-verify (Phase E) BEFORE running on prod.
--
-- KEY SEMANTICS (why this is a reconstruction, never a copy of the project row):
--   * each planting's care row is computed from ITS OWN plant-keyed events
--     (event_log.plant_id = plant.id) — so two plantings in one former project get
--     INDEPENDENT cadences (the 44/65 fan-out the design calls out).
--   * next_water_at is left NULL on purpose: the nightly engine owns "due"; do not bake
--     the legacy last_watered + 4d fiction into the cache.
--   * event_type -> column mapping mirrors the live project-keyed upsert
--     (lambda/events/index.js:255-289): watering|rain -> watered, fertilizing -> fertilized,
--     pruning -> pruned, observation -> observed. harvest|first_harvest -> harvested is added
--     (the reconstruction can populate it; the live batch upsert leaves it NULL).
--   * project-only events (plant_id IS NULL) do NOT attribute to any planting — the JOIN is on
--     e.plant_id, so the 52 legacy plantless project events stay project-level, untouched.

INSERT INTO entity_memory
  (plant_id, last_event_at, last_watered_at, last_fertilized_at,
   last_pruned_at, last_observed_at, last_harvested_at, next_water_at)
SELECT
  p.id,
  MAX(e.event_date),
  MAX(e.event_date) FILTER (WHERE e.event_type IN ('watering','rain')),
  MAX(e.event_date) FILTER (WHERE e.event_type = 'fertilizing'),
  MAX(e.event_date) FILTER (WHERE e.event_type = 'pruning'),
  MAX(e.event_date) FILTER (WHERE e.event_type = 'observation'),
  MAX(e.event_date) FILTER (WHERE e.event_type IN ('harvest','first_harvest')),
  NULL::timestamptz
FROM plants p
JOIN event_log e ON e.plant_id = p.id AND e.deleted_at IS NULL
WHERE p.deleted_at IS NULL AND p.archived_at IS NULL
GROUP BY p.id
ON CONFLICT (plant_id) WHERE plant_id IS NOT NULL DO UPDATE SET
  last_event_at     = GREATEST(entity_memory.last_event_at,      EXCLUDED.last_event_at),
  last_watered_at   = GREATEST(entity_memory.last_watered_at,    EXCLUDED.last_watered_at),
  last_fertilized_at= GREATEST(entity_memory.last_fertilized_at, EXCLUDED.last_fertilized_at),
  last_pruned_at    = GREATEST(entity_memory.last_pruned_at,     EXCLUDED.last_pruned_at),
  last_observed_at  = GREATEST(entity_memory.last_observed_at,   EXCLUDED.last_observed_at),
  last_harvested_at = GREATEST(entity_memory.last_harvested_at,  EXCLUDED.last_harvested_at),
  updated_at        = NOW();
