-- 0c-cachearms.sql
-- V4-RAINAUTOLOG-001 — repair for a defect in 0b step 4, caught by the scheduled gate-invariants
-- sweep within minutes of the apply. 0b is otherwise correct and is NOT re-run by this file.
--
-- ═══ WHAT 0b GOT WRONG ═══
--
-- entity_memory has TWO arms — a plant-keyed row and a project-keyed row — and they are not
-- interchangeable. 0b's step 4 was written by mirroring the batch writer in lambda/events/index.js,
-- but that writer maintains the PROJECT arm (its INSERT is `INSERT INTO entity_memory (project_id,
-- ...) SELECT DISTINCT p.container_id`). Step 4 took that statement's COLUMN LIST and applied it to
-- the PLANT arm. The result was wrong in both directions at once:
--
--   (a) It SET next_water_at on plant rows. That column is project-arm-only: v4-carekey-001 pins
--       `SELECT 1 FROM entity_memory WHERE plant_id IS NOT NULL AND next_water_at IS NOT NULL` at
--       zero, and v4-carecacheundo-001 states the ownership plainly — "next_water_at belongs to the
--       nightly daily-plan engine". An event writer must not bake it at all, and 0b's flat
--       +4 days was not even the engine's formula (which reads watering_interval_days and falls back
--       per location_type). 14 plant rows on prod, 11 on staging.
--
--   (b) It never advanced the PROJECT arm. 0b inserted 1,696 rain events carrying
--       project_id = the planting's container, so every one of those containers' latest event moved
--       — while their project-keyed cache row did not. That left the cache BEHIND the log, tripping
--       post_no_cache_behind_event_log in v4-cachefwdgap-001 and v4-cachemissingrow-001.
--
-- Neither is a data-loss defect and neither affected a user-visible number: last_water is computed
-- directly from event_log in daily-plan/handler.js, not read from these columns. It is a cache
-- consistency defect, and the invariants are what make that distinction cheap to notice.
--
-- ═══ WHY next_water_at IS SET TO NULL RATHER THAN RECOMPUTED ═══
-- NULL is the correct resting state for the plant arm — it is what the invariant asserts and what
-- every one of these rows held before 0b. Recomputing "the right value" here would be this file
-- making the same category error 0b made: writing a column it does not own. The daily-plan engine
-- owns it and will set it on the project arm on its next run.
--
-- The 14 rows are known to be entirely 0b's: the scheduled gate-invariants sweep was GREEN on
-- 2026-08-27 (run on e480847b) and red on the very next run, which was 0b's commit. So an
-- unconditional NULL over plant rows restores exactly the prior state and cannot catch a row that
-- was someone else's.
--
-- DESTRUCTIVE STEPS: none. Nulling a derived, regenerable cache column is covered by the
-- Soft-Delete-Only Rule's ephemeral carve-out, and 0r captured these rows before 0b ran.

BEGIN;

SELECT set_config('app.actor_clerk_sub', 'user_3D2gM0hIl03gjW3JM2DjtPzm0jI', true);

-- ── (a) the plant arm must not carry next_water_at ──────────────────────────────────────────────
UPDATE public.entity_memory
   SET next_water_at = NULL,
       updated_at    = now()
 WHERE plant_id IS NOT NULL
   AND next_water_at IS NOT NULL;

-- ── (b) BOTH arms, as UPSERTS — a missing cache row must be CREATED, not skipped ────────────────
-- Second correction, 2026-08-28. The first version of this file used plain UPDATEs and passed every
-- gate on PROD, where every affected planting and container already had a cache row. STAGING then
-- failed post_every_non_deleted_planting_with_events_has_a_cache_row: one planting there had NO
-- events at all before 0b, so 0b gave it 8 rain rows and there was no cache row to update. An UPDATE
-- cannot create one. Prod's data hid the defect; staging's exposed it — which is the whole reason
-- both environments are gated.
--
-- The shape below mirrors the deployed batch writer in lambda/events/index.js (project arm
-- ON CONFLICT (project_id), plant arm ON CONFLICT (plant_id) WHERE plant_id IS NOT NULL), and its
-- comment states the column rule this file's part (a) enforces: "no next_water_at — the plant cache
-- is a pure recency cache; the daily-plan engine owns 'due'."
--
-- Derived FROM event_log, not from 0b's date list, so it is correct regardless of which rows 0b's
-- re-run guard skipped, and FORWARD ONLY (GREATEST) so it can never walk the cache backwards into
-- V4-CARECACHEUNDO-001's territory.

-- ALL SIX recency columns, not just the two rain touches. Third correction, same session: a version
-- of this insert that populated only last_event_at and last_watered_at left every NEWLY CREATED row
-- NULL on the other four while the plant had matching events — so it satisfied
-- post_every_planting_with_events_has_a_cache_row and immediately broke
-- post_no_cache_behind_event_log, on prod, by one row (a plant with fertilizing history). Creating a
-- PARTIAL cache row is worse than creating none: it converts an absent-row finding into a
-- stale-value finding, which is harder to see. If you create the row, fill it.
--
-- The harvest filter differs PER ARM on purpose — plant arm takes ('harvest','first_harvest'), the
-- project arm below takes 'harvest' only. That asymmetry mirrors the two forward writers in
-- lambda/events/index.js exactly; unifying them would compute a "truth" no writer has ever produced
-- (v4-carecacheundo-001 records the same rule).
INSERT INTO public.entity_memory
  (plant_id, last_event_at, last_watered_at, last_fertilized_at, last_pruned_at, last_observed_at, last_harvested_at)
SELECT t.plant_id, t.mx_any, t.mx_water, t.mx_fert, t.mx_prune, t.mx_obs, t.mx_harv
  FROM (
        SELECT e.plant_id,
               MAX(e.event_date)                                                              AS mx_any,
               MAX(e.event_date) FILTER (WHERE e.event_type IN ('watering','rain'))           AS mx_water,
               MAX(e.event_date) FILTER (WHERE e.event_type = 'fertilizing')                  AS mx_fert,
               MAX(e.event_date) FILTER (WHERE e.event_type = 'pruning')                      AS mx_prune,
               MAX(e.event_date) FILTER (WHERE e.event_type = 'observation')                  AS mx_obs,
               MAX(e.event_date) FILTER (WHERE e.event_type IN ('harvest','first_harvest'))   AS mx_harv
          FROM public.event_log e
         WHERE e.deleted_at IS NULL AND e.plant_id IS NOT NULL
         GROUP BY e.plant_id
       ) t
 WHERE t.mx_water IS NOT NULL
ON CONFLICT (plant_id) WHERE plant_id IS NOT NULL DO UPDATE SET
  last_event_at      = GREATEST(COALESCE(entity_memory.last_event_at,      excluded.last_event_at),      excluded.last_event_at),
  last_watered_at    = GREATEST(COALESCE(entity_memory.last_watered_at,    excluded.last_watered_at),    excluded.last_watered_at),
  last_fertilized_at = GREATEST(COALESCE(entity_memory.last_fertilized_at, excluded.last_fertilized_at), excluded.last_fertilized_at),
  last_pruned_at     = GREATEST(COALESCE(entity_memory.last_pruned_at,     excluded.last_pruned_at),     excluded.last_pruned_at),
  last_observed_at   = GREATEST(COALESCE(entity_memory.last_observed_at,   excluded.last_observed_at),   excluded.last_observed_at),
  last_harvested_at  = GREATEST(COALESCE(entity_memory.last_harvested_at,  excluded.last_harvested_at),  excluded.last_harvested_at),
  updated_at         = now();

-- BUG-EMPROJGUARD-001: container_id is NULLABLE, so a project-less planting would contribute a
-- ZERO-parent row and violate entity_memory_exactly_one_parent, aborting the whole transaction. The
-- IS NOT NULL in the subquery is what makes that a no-op instead.
INSERT INTO public.entity_memory
  (project_id, last_event_at, last_watered_at, last_fertilized_at, last_pruned_at, last_observed_at, last_harvested_at)
SELECT t.project_id, t.mx_any, t.mx_water, t.mx_fert, t.mx_prune, t.mx_obs, t.mx_harv
  FROM (
        SELECT e.project_id,
               MAX(e.event_date)                                                    AS mx_any,
               MAX(e.event_date) FILTER (WHERE e.event_type IN ('watering','rain')) AS mx_water,
               MAX(e.event_date) FILTER (WHERE e.event_type = 'fertilizing')        AS mx_fert,
               MAX(e.event_date) FILTER (WHERE e.event_type = 'pruning')            AS mx_prune,
               MAX(e.event_date) FILTER (WHERE e.event_type = 'observation')        AS mx_obs,
               -- 'harvest' ONLY on this arm — see the per-arm note above.
               MAX(e.event_date) FILTER (WHERE e.event_type = 'harvest')            AS mx_harv
          FROM public.event_log e
         WHERE e.deleted_at IS NULL AND e.project_id IS NOT NULL
         GROUP BY e.project_id
       ) t
 WHERE t.mx_water IS NOT NULL
ON CONFLICT (project_id) DO UPDATE SET
  last_event_at      = GREATEST(COALESCE(entity_memory.last_event_at,      excluded.last_event_at),      excluded.last_event_at),
  last_watered_at    = GREATEST(COALESCE(entity_memory.last_watered_at,    excluded.last_watered_at),    excluded.last_watered_at),
  last_fertilized_at = GREATEST(COALESCE(entity_memory.last_fertilized_at, excluded.last_fertilized_at), excluded.last_fertilized_at),
  last_pruned_at     = GREATEST(COALESCE(entity_memory.last_pruned_at,     excluded.last_pruned_at),     excluded.last_pruned_at),
  last_observed_at   = GREATEST(COALESCE(entity_memory.last_observed_at,   excluded.last_observed_at),   excluded.last_observed_at),
  last_harvested_at  = GREATEST(COALESCE(entity_memory.last_harvested_at,  excluded.last_harvested_at),  excluded.last_harvested_at),
  updated_at         = now();

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('4.63.0-rainbackfill-001-cachearms',
        'V4-RAINAUTOLOG-001: repair 0b step 4 — clear next_water_at from the plant arm (project-arm-only '
        'column) and advance the project arm that 0b left behind the event log.',
        now())
ON CONFLICT DO NOTHING;

COMMIT;
