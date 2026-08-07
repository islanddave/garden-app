-- 0b-data.sql
-- V4-CARECACHEUNDO-001 — repair entity_memory rows left AHEAD of the event log by event undo
-- (BUG-CARECACHEUNDO-001).
--
-- WHY: all four undo recompute arms in lambda/events/index.js (batch + single, project-keyed +
-- plant-keyed) recomputed ONLY last_watered_at, and the single-event arm ran its recompute solely
-- when the undone event was watering/rain. Undoing a harvest / fertilizing / pruning / observation
-- therefore soft-deleted the event and left the matching column — and last_event_at — pointing at a
-- date that no longer exists in the log. Every forward upsert is GREATEST(), so the cache could
-- never walk backwards on its own and nothing else repaired it: the drift was permanent.
--
-- DATA-ONLY. No DDL on any app table; no column, constraint, index or view is touched. The one
-- snap_* table is rollback scaffolding (see 0r) and is the only object created.
--
-- ═══ DIRECTION IS THE WHOLE DESIGN — READ BEFORE EDITING ═══
-- This file walks the cache BACKWARDS ONLY. A cell is rewritten if and only if it is STRICTLY AHEAD
-- of the surviving-event truth (including "cached non-NULL, truth NULL"). A cell that is BEHIND the
-- truth is left exactly as found.
--
-- That is not squeamishness, it is ticket hygiene. Cache-behind cells have a DIFFERENT cause —
-- BUG-DIRECTWRITEDRIFT-001, harvests written straight to the database bypassing the Lambda — and
-- their repair is a re-run of migrations/care-rekey-001/0b-backfill.sql, whose ON CONFLICT uses
-- GREATEST and therefore walks the cache FORWARDS ONLY. The two repairs are exact complements:
-- disjoint by construction, commutative, and each leaves the other's evidence intact. Re-running 0b
-- CANNOT fix what this file fixes (GREATEST cannot lower a value) and this file will not silently
-- close BUG-DIRECTWRITEDRIFT-001's rows out from under it.
--
-- Widening this to "set every cell to truth" would merge the two tickets, destroy the before/after
-- measurement each one owns, and — for cells where the direct-write value is the user's real data
-- and the event log is the incomplete surface — is not obviously the correct repair at all. Do not.
--
-- ═══ PER-ARM WRITER PARITY ON THE HARVEST MAPPING ═══
-- The two arms use DIFFERENT harvest filters, on purpose, because their forward writers do:
--   * plant-keyed   -> event_type IN ('harvest','first_harvest')  (0b-backfill.sql; index.js ~1717)
--   * project-keyed -> event_type = 'harvest'                     (index.js ~1673)
-- A recompute must be the exact inverse of its OWN arm's writer. Unifying them would compute a
-- "truth" for the project arm that no forward write has ever produced.
--
-- last_event_at is deliberately UNFILTERED by event_type: it means "any activity", and that includes
-- the status_change rows plants/index.js and projects/index.js write. Both of those also insert an
-- event_log row at the same instant, so last_event_at stays fully derivable from event_log alone.
--
-- ═══ NOT IN SCOPE ═══
--   * next_water_at — not a recency cache. The nightly daily-plan engine owns "due"; recomputing it
--     from last_watered + interval here would overwrite that engine's value with a fiction.
--   * last_issue_at — driven by event_log.flagged_as_issue, not by event_type, so it has no mapping
--     in 0b-backfill.sql. Same bug class (an undone flagged observation leaves it stale) but a
--     separate mapping and a separate decision; measured at authoring time and reported in README.md
--     rather than repaired blind.
--   * location-keyed entity_memory rows — no undo path writes them.
--
-- SCOPE: every entity_memory row on either arm, INCLUDING rows whose planting is archived or
-- soft-deleted and rows whose container is soft-deleted. A stale cache on a hidden row is still a
-- lie, it costs nothing to correct, and leaving it would make the post gates assert "zero except the
-- ones we chose not to look at".
--
-- SAFETY: idempotent (a second run finds nothing ahead and matches zero rows). Fully reversible via
-- 0r using the snapshot. Never widens a cell — the only possible movement is toward the event log.

BEGIN;

-- Rollback snapshot, captured BEFORE any write. CREATE ... IF NOT EXISTS ... AS SELECT is a no-op on
-- re-run, which preserves the ORIGINAL pre-repair capture rather than overwriting it with the
-- post-repair (empty) state.
CREATE TABLE IF NOT EXISTS public.snap_carecacheundo001_entity_memory AS
WITH truth AS (
  SELECT em.id,
         CASE WHEN em.plant_id IS NOT NULL THEN 'plant' ELSE 'project' END AS arm,
         (SELECT MAX(e.event_date) FROM public.event_log e
           WHERE e.deleted_at IS NULL
             AND (CASE WHEN em.plant_id IS NOT NULL THEN e.plant_id = em.plant_id
                       ELSE e.project_id = em.project_id END)) AS t_any,
         (SELECT MAX(e.event_date) FROM public.event_log e
           WHERE e.deleted_at IS NULL AND e.event_type IN ('watering','rain')
             AND (CASE WHEN em.plant_id IS NOT NULL THEN e.plant_id = em.plant_id
                       ELSE e.project_id = em.project_id END)) AS t_water,
         (SELECT MAX(e.event_date) FROM public.event_log e
           WHERE e.deleted_at IS NULL AND e.event_type = 'fertilizing'
             AND (CASE WHEN em.plant_id IS NOT NULL THEN e.plant_id = em.plant_id
                       ELSE e.project_id = em.project_id END)) AS t_fert,
         (SELECT MAX(e.event_date) FROM public.event_log e
           WHERE e.deleted_at IS NULL AND e.event_type = 'pruning'
             AND (CASE WHEN em.plant_id IS NOT NULL THEN e.plant_id = em.plant_id
                       ELSE e.project_id = em.project_id END)) AS t_prune,
         (SELECT MAX(e.event_date) FROM public.event_log e
           WHERE e.deleted_at IS NULL AND e.event_type = 'observation'
             AND (CASE WHEN em.plant_id IS NOT NULL THEN e.plant_id = em.plant_id
                       ELSE e.project_id = em.project_id END)) AS t_obs,
         -- per-arm writer parity, see header
         (SELECT MAX(e.event_date) FROM public.event_log e
           WHERE e.deleted_at IS NULL
             AND (CASE WHEN em.plant_id IS NOT NULL THEN e.event_type IN ('harvest','first_harvest')
                       ELSE e.event_type = 'harvest' END)
             AND (CASE WHEN em.plant_id IS NOT NULL THEN e.plant_id = em.plant_id
                       ELSE e.project_id = em.project_id END)) AS t_harv
    FROM public.entity_memory em
   WHERE em.plant_id IS NOT NULL OR em.project_id IS NOT NULL
)
SELECT em.id, t.arm,
       em.last_event_at, em.last_watered_at, em.last_fertilized_at,
       em.last_pruned_at, em.last_observed_at, em.last_harvested_at
  FROM public.entity_memory em
  JOIN truth t ON t.id = em.id
 WHERE (em.last_event_at      IS NOT NULL AND (t.t_any   IS NULL OR em.last_event_at      > t.t_any))
    OR (em.last_watered_at    IS NOT NULL AND (t.t_water IS NULL OR em.last_watered_at    > t.t_water))
    OR (em.last_fertilized_at IS NOT NULL AND (t.t_fert  IS NULL OR em.last_fertilized_at > t.t_fert))
    OR (em.last_pruned_at     IS NOT NULL AND (t.t_prune IS NULL OR em.last_pruned_at     > t.t_prune))
    OR (em.last_observed_at   IS NOT NULL AND (t.t_obs   IS NULL OR em.last_observed_at   > t.t_obs))
    OR (em.last_harvested_at  IS NOT NULL AND (t.t_harv  IS NULL OR em.last_harvested_at  > t.t_harv));

-- The repair. Per column: lower to truth if AHEAD, otherwise keep exactly what is there.
--
-- Written as an explicit CASE and NOT as LEAST(em.col, t.truth): in Postgres LEAST ignores NULL
-- inputs, so LEAST(timestamp, NULL) returns the timestamp. The single worst row on prod is precisely
-- the NULL-truth case — a planting whose only harvest was undone, leaving a cached harvest date with
-- no surviving harvest at all — and LEAST would leave it untouched while looking correct.
UPDATE public.entity_memory em
   SET last_event_at      = CASE WHEN em.last_event_at      IS NOT NULL AND (t.t_any   IS NULL OR em.last_event_at      > t.t_any)   THEN t.t_any   ELSE em.last_event_at      END,
       last_watered_at    = CASE WHEN em.last_watered_at    IS NOT NULL AND (t.t_water IS NULL OR em.last_watered_at    > t.t_water) THEN t.t_water ELSE em.last_watered_at    END,
       last_fertilized_at = CASE WHEN em.last_fertilized_at IS NOT NULL AND (t.t_fert  IS NULL OR em.last_fertilized_at > t.t_fert)  THEN t.t_fert  ELSE em.last_fertilized_at END,
       last_pruned_at     = CASE WHEN em.last_pruned_at     IS NOT NULL AND (t.t_prune IS NULL OR em.last_pruned_at     > t.t_prune) THEN t.t_prune ELSE em.last_pruned_at     END,
       last_observed_at   = CASE WHEN em.last_observed_at   IS NOT NULL AND (t.t_obs   IS NULL OR em.last_observed_at   > t.t_obs)   THEN t.t_obs   ELSE em.last_observed_at   END,
       last_harvested_at  = CASE WHEN em.last_harvested_at  IS NOT NULL AND (t.t_harv  IS NULL OR em.last_harvested_at  > t.t_harv)  THEN t.t_harv  ELSE em.last_harvested_at  END,
       updated_at         = NOW()
  FROM (
    SELECT em2.id,
           (SELECT MAX(e.event_date) FROM public.event_log e
             WHERE e.deleted_at IS NULL
               AND (CASE WHEN em2.plant_id IS NOT NULL THEN e.plant_id = em2.plant_id
                         ELSE e.project_id = em2.project_id END)) AS t_any,
           (SELECT MAX(e.event_date) FROM public.event_log e
             WHERE e.deleted_at IS NULL AND e.event_type IN ('watering','rain')
               AND (CASE WHEN em2.plant_id IS NOT NULL THEN e.plant_id = em2.plant_id
                         ELSE e.project_id = em2.project_id END)) AS t_water,
           (SELECT MAX(e.event_date) FROM public.event_log e
             WHERE e.deleted_at IS NULL AND e.event_type = 'fertilizing'
               AND (CASE WHEN em2.plant_id IS NOT NULL THEN e.plant_id = em2.plant_id
                         ELSE e.project_id = em2.project_id END)) AS t_fert,
           (SELECT MAX(e.event_date) FROM public.event_log e
             WHERE e.deleted_at IS NULL AND e.event_type = 'pruning'
               AND (CASE WHEN em2.plant_id IS NOT NULL THEN e.plant_id = em2.plant_id
                         ELSE e.project_id = em2.project_id END)) AS t_prune,
           (SELECT MAX(e.event_date) FROM public.event_log e
             WHERE e.deleted_at IS NULL AND e.event_type = 'observation'
               AND (CASE WHEN em2.plant_id IS NOT NULL THEN e.plant_id = em2.plant_id
                         ELSE e.project_id = em2.project_id END)) AS t_obs,
           (SELECT MAX(e.event_date) FROM public.event_log e
             WHERE e.deleted_at IS NULL
               AND (CASE WHEN em2.plant_id IS NOT NULL THEN e.event_type IN ('harvest','first_harvest')
                         ELSE e.event_type = 'harvest' END)
               AND (CASE WHEN em2.plant_id IS NOT NULL THEN e.plant_id = em2.plant_id
                         ELSE e.project_id = em2.project_id END)) AS t_harv
      FROM public.entity_memory em2
     WHERE em2.plant_id IS NOT NULL OR em2.project_id IS NOT NULL
  ) t
 WHERE t.id = em.id
   AND ((em.last_event_at      IS NOT NULL AND (t.t_any   IS NULL OR em.last_event_at      > t.t_any))
     OR (em.last_watered_at    IS NOT NULL AND (t.t_water IS NULL OR em.last_watered_at    > t.t_water))
     OR (em.last_fertilized_at IS NOT NULL AND (t.t_fert  IS NULL OR em.last_fertilized_at > t.t_fert))
     OR (em.last_pruned_at     IS NOT NULL AND (t.t_prune IS NULL OR em.last_pruned_at     > t.t_prune))
     OR (em.last_observed_at   IS NOT NULL AND (t.t_obs   IS NULL OR em.last_observed_at   > t.t_obs))
     OR (em.last_harvested_at  IS NOT NULL AND (t.t_harv  IS NULL OR em.last_harvested_at  > t.t_harv)));

INSERT INTO public.schema_version (version, description)
VALUES ('4.23.2-carecacheundo-001',
  'CARECACHEUNDO repair (data-only): lower entity_memory recency columns that event undo left AHEAD '
  'of the surviving event log, on both the plant-keyed and project-keyed arms. Backwards-only by '
  'construction — a cell BEHIND the log is untouched, because that is BUG-DIRECTWRITEDRIFT-001 and '
  'its repair is a re-run of care-rekey-001/0b-backfill.sql (GREATEST, forwards-only). The two are '
  'exact complements. Ships with the Lambda fix that extends all four undo recompute arms from '
  'last_watered_at to every recency column. Rollback snapshot in '
  'snap_carecacheundo001_entity_memory.')
ON CONFLICT DO NOTHING;

COMMIT;
