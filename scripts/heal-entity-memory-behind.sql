-- BUG-ENTITYMEMSTALE-001 — heal entity_memory rows left BEHIND the surviving event log.
--
-- WHAT PUT THEM THERE. scripts/merge-run.mjs repointed each loser planting's event_log rows onto
-- the merge winner (lambda/plants/merge.js). A repoint moves history without INSERTing anything,
-- so every forward writer's GREATEST(...) was bypassed and the winner's cache kept describing only
-- its own events. merge.js claimed "the inference job recomputes the winner's"; no such job exists.
-- On prod that left five winners from the 2026-08-14 run behind — Cilantro, Ghost, French Tarragon,
-- Serranos, Habanero — which is exactly the population
-- migrations/v4-cachefwdgap-001/gates.yml:post_no_cache_behind_event_log reports.
--
-- The code fix (lambda/plants/plantMemoryRepoint.js) stops NEW drift. This heals the existing rows.
--
-- HOW TO RUN (a human runs this; it is not wired into any pipeline):
--   psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/heal-entity-memory-behind.sql
-- Must run as the table owner (neondb_owner). entity_memory has RLS enabled but not FORCEd, and
-- its write policy needs current_user_id() IS NOT NULL — a non-owner session would silently update
-- zero rows. The post-check below turns that silence into a failed transaction rather than a
-- "looks like it worked".
--
-- PROPERTIES
--   Idempotent — the write set is derived from the gate predicate itself, so a second run finds an
--     empty set and updates nothing. Verified safe on staging, where the set is already empty
--     (20 cache rows, 87 events, zero merges: the gate has never failed there).
--   Bounded — refuses to run if more than MAX_HEAL rows are behind. A larger population means a
--     cause this script was not written for, and a blind mass-rewrite of a cache is not a repair.
--   Atomic — one transaction, and the verification runs INSIDE it, so a heal that does not reach
--     zero rolls back instead of half-landing.
--   One definition of truth — the column expressions below are the app's own plant-keyed rebuild
--     (lambda/events/index.js, the PUT's newPlantId arm, mirrored in
--     lambda/plants/plantMemoryRepoint.js) and its project-keyed sibling (the undo path), with the
--     bind parameter replaced by the row's own key. Note the arms differ and that is deliberate,
--     not an oversight: the plant arm counts 'first_harvest' as a harvest and the project arm does
--     not — matching both the app and the gate, which encode the same asymmetry.
--   next_water_at is NOT touched. It is owned by the daily-plan engine, no gate reads it, and a
--     cache repair has no business inventing a schedule.

\set ON_ERROR_STOP on

BEGIN;

-- ── The write set: the gate's own BEHIND predicate, materialised once ─────────────────────────
-- Deriving the set from the predicate rather than from a pasted list of ids is what makes this
-- both idempotent and portable across environments. It also means the script cannot touch a row
-- that was already correct.
CREATE TEMP TABLE _behind ON COMMIT DROP AS
WITH truth AS (
  SELECT em.id, em.plant_id, em.project_id,
         em.last_event_at, em.last_watered_at, em.last_fertilized_at,
         em.last_pruned_at, em.last_observed_at, em.last_harvested_at, em.last_issue_at,
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
SELECT id, plant_id, project_id FROM truth
 WHERE (t_any   IS NOT NULL AND (last_event_at      IS NULL OR last_event_at      < t_any))
    OR (t_water IS NOT NULL AND (last_watered_at    IS NULL OR last_watered_at    < t_water))
    OR (t_fert  IS NOT NULL AND (last_fertilized_at IS NULL OR last_fertilized_at < t_fert))
    OR (t_prune IS NOT NULL AND (last_pruned_at     IS NULL OR last_pruned_at     < t_prune))
    OR (t_obs   IS NOT NULL AND (last_observed_at   IS NULL OR last_observed_at   < t_obs))
    OR (t_harv  IS NOT NULL AND (last_harvested_at  IS NULL OR last_harvested_at  < t_harv))
    OR (t_issue IS NOT NULL AND (last_issue_at      IS NULL OR last_issue_at      < t_issue));

-- ── Bound ────────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE n int; max_heal CONSTANT int := 100;
BEGIN
  SELECT count(*) INTO n FROM _behind;
  RAISE NOTICE 'entity_memory rows BEHIND: % (plant-keyed %, project-keyed %)',
    n,
    (SELECT count(*) FROM _behind WHERE plant_id IS NOT NULL),
    (SELECT count(*) FROM _behind WHERE plant_id IS NULL);
  IF n > max_heal THEN
    RAISE EXCEPTION 'REFUSING: % rows behind exceeds the % cap. That is not the merge-repoint '
                    'population this script was written for — find the cause first.', n, max_heal;
  END IF;
END $$;

-- ── Plant-keyed arm ──────────────────────────────────────────────────────────────────────────
-- Absolute, not GREATEST: a rebuild must be able to move a column DOWN as well as up, which is
-- also why running this cannot leave a row AHEAD of truth and trip the sibling gate.
UPDATE public.entity_memory em SET
  last_event_at      = (SELECT MAX(e.event_date) FROM public.event_log e WHERE e.plant_id = em.plant_id AND e.deleted_at IS NULL),
  last_watered_at    = (SELECT MAX(e.event_date) FROM public.event_log e WHERE e.plant_id = em.plant_id AND e.event_type IN ('watering','rain') AND e.deleted_at IS NULL),
  last_fertilized_at = (SELECT MAX(e.event_date) FROM public.event_log e WHERE e.plant_id = em.plant_id AND e.event_type = 'fertilizing' AND e.deleted_at IS NULL),
  last_pruned_at     = (SELECT MAX(e.event_date) FROM public.event_log e WHERE e.plant_id = em.plant_id AND e.event_type = 'pruning' AND e.deleted_at IS NULL),
  last_observed_at   = (SELECT MAX(e.event_date) FROM public.event_log e WHERE e.plant_id = em.plant_id AND e.event_type = 'observation' AND e.deleted_at IS NULL),
  last_harvested_at  = (SELECT MAX(e.event_date) FROM public.event_log e WHERE e.plant_id = em.plant_id AND e.event_type IN ('harvest','first_harvest') AND e.deleted_at IS NULL),
  last_issue_at      = (SELECT MAX(e.event_date) FROM public.event_log e WHERE e.plant_id = em.plant_id AND e.flagged_as_issue = true AND e.deleted_at IS NULL),
  updated_at = NOW()
WHERE em.id IN (SELECT id FROM _behind WHERE plant_id IS NOT NULL);

-- ── Project-keyed arm ────────────────────────────────────────────────────────────────────────
-- Empty on prod today (all five behind rows are plant-keyed — a repoint rewrites plant_id and
-- leaves event_log.project_id alone, so no project's event set changed). Present because the gate
-- covers both arms and a heal that only knows one of them is a trap for whoever runs it next.
UPDATE public.entity_memory em SET
  last_event_at      = (SELECT MAX(e.event_date) FROM public.event_log e WHERE e.project_id = em.project_id AND e.deleted_at IS NULL),
  last_watered_at    = (SELECT MAX(e.event_date) FROM public.event_log e WHERE e.project_id = em.project_id AND e.event_type IN ('watering','rain') AND e.deleted_at IS NULL),
  last_fertilized_at = (SELECT MAX(e.event_date) FROM public.event_log e WHERE e.project_id = em.project_id AND e.event_type = 'fertilizing' AND e.deleted_at IS NULL),
  last_pruned_at     = (SELECT MAX(e.event_date) FROM public.event_log e WHERE e.project_id = em.project_id AND e.event_type = 'pruning' AND e.deleted_at IS NULL),
  last_observed_at   = (SELECT MAX(e.event_date) FROM public.event_log e WHERE e.project_id = em.project_id AND e.event_type = 'observation' AND e.deleted_at IS NULL),
  last_harvested_at  = (SELECT MAX(e.event_date) FROM public.event_log e WHERE e.project_id = em.project_id AND e.event_type = 'harvest' AND e.deleted_at IS NULL),
  last_issue_at      = (SELECT MAX(e.event_date) FROM public.event_log e WHERE e.project_id = em.project_id AND e.flagged_as_issue = true AND e.deleted_at IS NULL),
  updated_at = NOW()
WHERE em.id IN (SELECT id FROM _behind WHERE plant_id IS NULL);

-- ── Verification — the gate's own SQL, in-transaction ────────────────────────────────────────
-- Not a report at the end: a RAISE here rolls the whole thing back, so the script cannot leave the
-- database in a state it just claimed to have fixed. It also catches an RLS-blocked no-op write.
DO $$
DECLARE still int;
BEGIN
  WITH truth AS (
    SELECT em.id,
           em.last_event_at, em.last_watered_at, em.last_fertilized_at,
           em.last_pruned_at, em.last_observed_at, em.last_harvested_at, em.last_issue_at,
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
  SELECT count(*) INTO still FROM truth
   WHERE (t_any   IS NOT NULL AND (last_event_at      IS NULL OR last_event_at      < t_any))
      OR (t_water IS NOT NULL AND (last_watered_at    IS NULL OR last_watered_at    < t_water))
      OR (t_fert  IS NOT NULL AND (last_fertilized_at IS NULL OR last_fertilized_at < t_fert))
      OR (t_prune IS NOT NULL AND (last_pruned_at     IS NULL OR last_pruned_at     < t_prune))
      OR (t_obs   IS NOT NULL AND (last_observed_at   IS NULL OR last_observed_at   < t_obs))
      OR (t_harv  IS NOT NULL AND (last_harvested_at  IS NULL OR last_harvested_at  < t_harv))
      OR (t_issue IS NOT NULL AND (last_issue_at      IS NULL OR last_issue_at      < t_issue));

  IF still <> 0 THEN
    RAISE EXCEPTION 'post_no_cache_behind_event_log still returns % row(s) — rolling back', still;
  END IF;
  RAISE NOTICE 'post_no_cache_behind_event_log: 0 rows. Healed.';
END $$;

COMMIT;
