-- 0b-data.sql
-- V4-CACHEFWDGAP-001 — repair entity_memory rows left BEHIND the surviving event log
-- (BUG-CACHEFWDGAP-001).
--
-- WHY: every forward writer in this codebase is GREATEST() and every recompute was gated, so a cell
-- that falls behind the log can never catch up on its own. Four distinct doors put 15 rows / 28
-- cells behind on prod, and NONE of them could ever trip the canonical detector, because that
-- detector tests `cached > truth` only:
--   A (4 rows/6 cells)  the events PUT moved event_date FORWARD. The DEPLOYED gate is
--                       `projectChanged || plantChanged`; a date-only edit moves nothing, so no arm
--                       runs. Fixed forward by BUG-CACHEGATE-001 (dev e9d8909, cacheDirty over four
--                       axes + direct-assignment arms) -- NOT YET PROMOTED.
--   B (5 rows/15 cells) the BUG-DIRECTWRITEDRIFT-001 reversal script (2026-08-04 17:16:30) INSERTed
--                       five plant-keyed rows with only three of the six recency columns in its
--                       column list, and computed even those over the direct-write SUBSET of the
--                       log rather than the whole log. Rows born behind. No code path involved.
--   C (4 rows/5 cells)  commit 78419e8 (2026-05-25 00:44Z) corrected 13 midnight-UTC event_date
--                       rows to noon UTC and did not recompute the cache.
--   D (2 rows/2 cells)  a harvest was written project-anchored and acquired event_log.plant_id out
--                       of band afterwards. The POST's plant arm self-guards on plant_id, so the
--                       project arm is correct and the plant arm never saw the event.
--
-- Three of those four doors were opened by hand-run SQL, not by the application. The writer fix
-- closes the application door; only the standing post gate closes the other three.
--
-- DATA-ONLY. No DDL on any app table; no column, constraint, index or view is touched. The one
-- snap_* table is rollback scaffolding (see 0r) and is the only object created.
--
-- ═══ DIRECTION IS THE WHOLE DESIGN — READ BEFORE EDITING ═══
-- This file walks the cache FORWARDS ONLY, and it is the exact complement of
-- migrations/v4-carecacheundo-001/0b-data.sql, which walks it BACKWARDS ONLY. A cell is rewritten
-- if and only if it is STRICTLY BEHIND the surviving-event truth (including "cached NULL, truth
-- non-NULL"). A cell AHEAD of the truth is left exactly as found -- that is
-- BUG-CARECACHEUNDO-001's population, repaired on prod 2026-08-07 14:47:59Z, and re-openable by
-- the deployed undo path.
--
-- The movement is expressed as GREATEST, and that is load-bearing rather than shorthand.
-- carecacheundo could NOT use LEAST, because Postgres LEAST ignores NULL inputs and
-- LEAST(ts, NULL) = ts would have skipped its worst row. The SAME NULL-ignoring behaviour makes
-- GREATEST exactly right here:
--     GREATEST(NULL, truth)  = truth   -> repairs Door B's ten never-written cells
--     GREATEST(cached, NULL) = cached  -> leaves an AHEAD cell with NULL truth untouched
--     GREATEST(ahead, truth) = ahead   -> leaves an AHEAD cell untouched
-- So this file CANNOT lower a value and therefore CANNOT annex carecacheundo's rows. That is an
-- algebraic property of the expression, not of the WHERE clause, and it survives a future edit that
-- widens the predicate. Verified empirically too: applying this predicate to the six pre-repair rows
-- still stored in snap_carecacheundo001_entity_memory matches ZERO of them.
--
-- Do NOT rewrite this as "set every cell to truth". That would merge the two tickets, destroy the
-- before/after measurement each one owns, and silently lower any cell the deployed undo path has
-- put ahead since carecacheundo was applied.
--
-- ═══ WHY NOT JUST RE-RUN care-rekey-001/0b-backfill.sql ═══
-- Because it repairs at most 5 of the 15. It writes ONLY the plant arm (so all five project rows --
-- Asparagus, Broccoli, Peppers, Smoke Child 2, Tomatoes -- are invisible to it), and its
-- `WHERE p.deleted_at IS NULL AND p.archived_at IS NULL` excludes every Door B row, all five of
-- which were archived on 2026-07-20. The remedy named in v4-carecacheundo-001/gates.yml and
-- v4-carekey-001/gates.yml is insufficient for the population those gates describe.
--
-- ═══ PER-ARM WRITER PARITY ON THE HARVEST MAPPING ═══
-- Unchanged from carecacheundo, and for the same reason -- a recompute must be the exact inverse of
-- its OWN arm's forward writer:
--   * plant-keyed   -> event_type IN ('harvest','first_harvest')
--   * project-keyed -> event_type = 'harvest'
-- last_event_at is deliberately UNFILTERED (it means "any activity", including the status_change
-- rows plants/index.js and projects/index.js write -- which is precisely what Door B's
-- last_event_at truth is for Candlelight, Lemon Drop and Santaka).
-- last_issue_at has NO per-arm split: BUG-LASTISSUEPLANT-001 (4.23.3, applied 2026-08-07 19:08Z)
-- ships `flagged_as_issue = true` identically on both arms. It is IN scope here (carecacheundo
-- excluded it only because the mapping did not exist yet); it currently measures 0 behind and 0
-- ahead, so including it costs nothing and closes the "the gate asserts zero except the column we
-- chose not to look at" hole.
--
-- ═══ NOT IN SCOPE ═══
--   * next_water_at -- not a recency cache. The nightly daily-plan engine owns "due".
--   * location-keyed entity_memory rows (6 on prod) -- no writer in any route touches them.
--
-- SCOPE: every entity_memory row on either arm, INCLUDING archived and soft-deleted parents. Ten of
-- the 28 cells belong to five ARCHIVED plantings (Door B); excluding them would make the post gate
-- assert "zero except the ones we chose not to look at", and would leave the gate unable to run as
-- a durable invariant.
--
-- SAFETY: idempotent (a second run finds nothing behind and matches zero rows). Fully reversible via
-- 0r using the snapshot. Never lowers a cell -- the only possible movement is toward the event log.

BEGIN;

-- Rollback snapshot, captured BEFORE any write. CREATE ... IF NOT EXISTS ... AS SELECT is a no-op on
-- re-run, which preserves the ORIGINAL pre-repair capture rather than overwriting it with the
-- post-repair (empty) state. Predicate is character-for-character the UPDATE's, so
-- post_every_repaired_row_is_snapshotted cannot fail through drift between the two.
CREATE TABLE IF NOT EXISTS public.snap_cachefwdgap001_entity_memory AS
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
         (SELECT MAX(e.event_date) FROM public.event_log e
           WHERE e.deleted_at IS NULL
             AND (CASE WHEN em.plant_id IS NOT NULL THEN e.event_type IN ('harvest','first_harvest')
                       ELSE e.event_type = 'harvest' END)
             AND (CASE WHEN em.plant_id IS NOT NULL THEN e.plant_id = em.plant_id
                       ELSE e.project_id = em.project_id END)) AS t_harv,
         (SELECT MAX(e.event_date) FROM public.event_log e
           WHERE e.deleted_at IS NULL AND e.flagged_as_issue = true
             AND (CASE WHEN em.plant_id IS NOT NULL THEN e.plant_id = em.plant_id
                       ELSE e.project_id = em.project_id END)) AS t_issue
    FROM public.entity_memory em
   WHERE em.plant_id IS NOT NULL OR em.project_id IS NOT NULL
)
SELECT em.id, t.arm,
       em.last_event_at, em.last_watered_at, em.last_fertilized_at,
       em.last_pruned_at, em.last_observed_at, em.last_harvested_at, em.last_issue_at
  FROM public.entity_memory em
  JOIN truth t ON t.id = em.id
 WHERE (t.t_any   IS NOT NULL AND (em.last_event_at      IS NULL OR em.last_event_at      < t.t_any))
    OR (t.t_water IS NOT NULL AND (em.last_watered_at    IS NULL OR em.last_watered_at    < t.t_water))
    OR (t.t_fert  IS NOT NULL AND (em.last_fertilized_at IS NULL OR em.last_fertilized_at < t.t_fert))
    OR (t.t_prune IS NOT NULL AND (em.last_pruned_at     IS NULL OR em.last_pruned_at     < t.t_prune))
    OR (t.t_obs   IS NOT NULL AND (em.last_observed_at   IS NULL OR em.last_observed_at   < t.t_obs))
    OR (t.t_harv  IS NOT NULL AND (em.last_harvested_at  IS NULL OR em.last_harvested_at  < t.t_harv))
    OR (t.t_issue IS NOT NULL AND (em.last_issue_at      IS NULL OR em.last_issue_at      < t.t_issue));

-- The repair. Per column: raise to truth if BEHIND, otherwise keep exactly what is there.
-- GREATEST does BOTH halves of that sentence on its own (see header) -- the WHERE clause only
-- decides which ROWS are worth touching, it is not what makes the direction safe.
UPDATE public.entity_memory em
   SET last_event_at      = GREATEST(em.last_event_at,      t.t_any),
       last_watered_at    = GREATEST(em.last_watered_at,    t.t_water),
       last_fertilized_at = GREATEST(em.last_fertilized_at, t.t_fert),
       last_pruned_at     = GREATEST(em.last_pruned_at,     t.t_prune),
       last_observed_at   = GREATEST(em.last_observed_at,   t.t_obs),
       last_harvested_at  = GREATEST(em.last_harvested_at,  t.t_harv),
       last_issue_at      = GREATEST(em.last_issue_at,      t.t_issue),
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
                         ELSE e.project_id = em2.project_id END)) AS t_harv,
           (SELECT MAX(e.event_date) FROM public.event_log e
             WHERE e.deleted_at IS NULL AND e.flagged_as_issue = true
               AND (CASE WHEN em2.plant_id IS NOT NULL THEN e.plant_id = em2.plant_id
                         ELSE e.project_id = em2.project_id END)) AS t_issue
      FROM public.entity_memory em2
     WHERE em2.plant_id IS NOT NULL OR em2.project_id IS NOT NULL
  ) t
 WHERE t.id = em.id
   AND ((t.t_any   IS NOT NULL AND (em.last_event_at      IS NULL OR em.last_event_at      < t.t_any))
     OR (t.t_water IS NOT NULL AND (em.last_watered_at    IS NULL OR em.last_watered_at    < t.t_water))
     OR (t.t_fert  IS NOT NULL AND (em.last_fertilized_at IS NULL OR em.last_fertilized_at < t.t_fert))
     OR (t.t_prune IS NOT NULL AND (em.last_pruned_at     IS NULL OR em.last_pruned_at     < t.t_prune))
     OR (t.t_obs   IS NOT NULL AND (em.last_observed_at   IS NULL OR em.last_observed_at   < t.t_obs))
     OR (t.t_harv  IS NOT NULL AND (em.last_harvested_at  IS NULL OR em.last_harvested_at  < t.t_harv))
     OR (t.t_issue IS NOT NULL AND (em.last_issue_at      IS NULL OR em.last_issue_at      < t.t_issue)));

INSERT INTO public.schema_version (version, description)
VALUES ('4.23.4-cachefwdgap-001',
  'CACHEFWDGAP repair (data-only): raise entity_memory recency columns left BEHIND the surviving '
  'event log, on both the plant-keyed and project-keyed arms. Forwards-only by construction -- the '
  'movement is GREATEST, which cannot lower a cell, so the AHEAD population repaired by '
  '4.23.2-carecacheundo-001 is untouched and the two remain exact complements. Four causes on prod: '
  'the events PUT running no recompute on a forward event_date edit (BUG-CACHEGATE-001, fixed '
  'forward on dev e9d8909); the BUG-DIRECTWRITEDRIFT-001 reversal script inserting five plant rows '
  'with a partial column list and a subset-scoped recompute; commit 78419e8 renormalising 13 '
  'event_date values midnight->noon UTC; and a harvest acquiring event_log.plant_id out of band. '
  'Rollback snapshot in snap_cachefwdgap001_entity_memory.')
ON CONFLICT DO NOTHING;

COMMIT;
