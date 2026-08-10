-- 0b-data.sql
-- V4-CACHEMISSINGROW-001 — create the entity_memory rows that never existed
-- (plantings with surviving events and NO plant-keyed cache row).
--
-- WHY THIS POPULATION WAS INVISIBLE. Both shipped drift detectors --
-- post_no_cache_behind_event_log (v4-cachefwdgap-001) and post_no_cache_ahead_of_event_log
-- (v4-carecacheundo-001) -- enumerate FROM entity_memory. A planting with no row is neither ahead
-- nor behind: it is not a row. That is why the paired invariant has always carried the qualifier
-- "for every entity that HAS a cache row". This file exists to delete that qualifier, and the
-- generalisable rule it teaches is in gates.yml's header: an invariant of the form "for every X,
-- P holds" must be enumerated FROM the relation that defines X, never from the relation carrying P.
--
-- ROOT CAUSE, and it is in the tree. migrations/care-rekey-001/0b-backfill.sql created the plant
-- arm with `WHERE p.deleted_at IS NULL AND p.archived_at IS NULL`. Every planting that was already
-- non-live at care-rekey time was skipped and has been rowless since. No writer has run on them
-- since either, because they are archived -- so nothing ever papered over it. Forward exposure is
-- closed: BUG-CACHEGATE-001's arm (lambda/events/index.js, inside v4.3.0, events Lambda deployed
-- 2026-08-07 20:59:56Z) creates the row on the next plant-anchored edit.
--
-- DATA-ONLY. No DDL on any app table. The two snap_* tables are rollback scaffolding (see 0r).
--
-- ═══ SCOPE: ARCHIVED YES, SOFT-DELETED NO -- READ BEFORE WIDENING ═══
-- Prod at authoring measured 14 rowless plantings: 8 archived (deleted_at IS NULL), 6 soft-deleted.
-- This file repairs the 8 and deliberately EXCLUDES the 6, and the reason is not caution, it is
-- that the system already declares the excluded state invalid:
--
--   scripts/integrity-weekly-check.sh's `entity_memory_orphans` metric counts, as an ORPHAN,
--   exactly `em.plant_id IS NOT NULL AND NOT EXISTS (plants p WHERE p.id = em.plant_id
--   AND p.deleted_at IS NULL)`. A cache row on a soft-deleted planting IS that predicate.
--
-- Backfilling the 6 would therefore manufacture six rows that a shipped alert metric names as
-- defects, taking it from 5 to 11 against a committed baseline of 4 (integrity-baselines.json) and
-- turning the Monday integrity-weekly cron red -- to no benefit, because a soft-deleted planting is
-- excluded from every rollup (`gp.deleted_at IS NULL`) and 404s on the by-id read
-- (lambda/plants/index.js, `p.deleted_at IS NULL`). Zero read surface, 100% of the monitor breach.
--
-- The semantics agree with the metric: an ARCHIVE is a completion of a record, a SOFT-DELETE is a
-- RETRACTION of it. A repudiated planting should have no care memory at all.
--
-- The excluded 6 are MEASURED, not ignored -- sweep_capture_soft_deleted_plantings_with_events_and_
-- no_cache_row owns them. Leaving a defect population uncounted is precisely how the population
-- THIS file repairs went unowned for three months, and that lesson is the reason for the sweep.
--
-- ═══ THE COLUMN SET MIRRORS THE DEPLOYED PLANT-KEYED WRITER ═══
-- Seven recency columns, computed exactly as lambda/events/index.js's row-creating arm computes
-- them, including its harvest mapping IN ('harvest','first_harvest') -- which differs from the
-- PROJECT arm's = 'harvest'. That asymmetry is real, deployed, and already encoded in the shipped
-- gates; do not "unify" it here.
--
-- next_water_at / location_type / watering_interval_days are left NULL because the plant-keyed
-- writer does not carry them (only the project-keyed arm does); post_backfilled_rows_carry_no_
-- engine_columns asserts it rather than trusting it.
--
-- ONE DELIBERATE DIVERGENCE from the writer, and it is not "byte-for-byte": the writer's conflict
-- action is DO UPDATE SET, this file's is DO NOTHING. DO UPDATE would rewrite every pre-existing
-- plant-keyed row and could annex both v4-carecacheundo-001's AHEAD population and
-- v4-cachefwdgap-001's BEHIND population, destroying the before/after evidence each owns.
-- post_no_preexisting_cache_row_was_touched exists to catch that edit.
--
-- DO NOT rewrite the SELECT to "set every cell to truth for all rows". This file may only CREATE.
--
-- ═══ WHY THE ROLLUP FIX MUST BE DEPLOYED FIRST ═══
-- BUG-ROLLUPLIFECYCLE-001 (code) makes the dashboard's ACTIONABLE entity_memory rollups exclude
-- non-live plantings. Until it is live, adding 8 archived-planting cache rows drags the legacy
-- water-due MIN(COALESCE(next_water_at, last_watered_at + interval)) backwards and flips the
-- Lettuce container from not-due (2026-08-12) to falsely water-due (2026-06-26). Measured.
-- pre_rollup_lifecycle_fix_is_deployed refuses to run without it.

BEGIN;

CREATE TABLE public.snap_cachemissingrow001_inserted (
  id                   uuid PRIMARY KEY,
  plant_id             uuid NOT NULL,
  recorded_updated_at  timestamptz NOT NULL
);

-- The ledger is written by the INSERT's own RETURNING, in the same statement. It cannot be
-- reconstructed afterwards: once these rows exist they are indistinguishable from rows the app
-- created, so there is no predicate that could find them again. That is the whole reason 0r needs
-- an IDENTITY snapshot rather than the sibling migrations' VALUE snapshot -- an INSERT's undo is a
-- DELETE, and there is no prior value to restore.
WITH created AS (
  INSERT INTO public.entity_memory
    (plant_id, last_event_at, last_watered_at, last_fertilized_at,
     last_pruned_at, last_observed_at, last_harvested_at, last_issue_at)
  SELECT p.id,
    (SELECT MAX(e.event_date) FROM public.event_log e
      WHERE e.plant_id = p.id AND e.deleted_at IS NULL),
    (SELECT MAX(e.event_date) FROM public.event_log e
      WHERE e.plant_id = p.id AND e.event_type IN ('watering','rain') AND e.deleted_at IS NULL),
    (SELECT MAX(e.event_date) FROM public.event_log e
      WHERE e.plant_id = p.id AND e.event_type = 'fertilizing' AND e.deleted_at IS NULL),
    (SELECT MAX(e.event_date) FROM public.event_log e
      WHERE e.plant_id = p.id AND e.event_type = 'pruning' AND e.deleted_at IS NULL),
    (SELECT MAX(e.event_date) FROM public.event_log e
      WHERE e.plant_id = p.id AND e.event_type = 'observation' AND e.deleted_at IS NULL),
    (SELECT MAX(e.event_date) FROM public.event_log e
      WHERE e.plant_id = p.id AND e.event_type IN ('harvest','first_harvest') AND e.deleted_at IS NULL),
    (SELECT MAX(e.event_date) FROM public.event_log e
      WHERE e.plant_id = p.id AND e.flagged_as_issue = true AND e.deleted_at IS NULL)
    FROM public.plants p
   -- deleted_at IS NULL is the SCOPE decision above, not a lifecycle habit. archived_at is
   -- deliberately absent: filtering it is the care-rekey-001 mistake that created this population.
   WHERE p.deleted_at IS NULL
     AND EXISTS (SELECT 1 FROM public.event_log e
                  WHERE e.plant_id = p.id AND e.deleted_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM public.entity_memory em WHERE em.plant_id = p.id)
  ON CONFLICT (plant_id) WHERE plant_id IS NOT NULL DO NOTHING
  RETURNING id, plant_id, updated_at
)
INSERT INTO public.snap_cachemissingrow001_inserted (id, plant_id, recorded_updated_at)
SELECT id, plant_id, updated_at FROM created;

INSERT INTO public.schema_version (version, description)
VALUES ('4.23.5-cachemissingrow-001',
  'CACHEMISSINGROW repair (data-only): CREATE the plant-keyed entity_memory rows that never '
  'existed for plantings carrying surviving event_log rows. Root cause is in the tree -- '
  'care-rekey-001/0b-backfill.sql built the plant arm with `p.deleted_at IS NULL AND '
  'p.archived_at IS NULL`, so every already-archived planting was skipped and, being archived, '
  'never had a forward write come along to create it. Invisible to BOTH drift detectors because '
  'both enumerate FROM entity_memory: a missing row is neither ahead nor behind. Scoped to '
  'deleted_at IS NULL -- a cache row on a SOFT-DELETED planting is what '
  'integrity-weekly-check.sh already counts as an entity_memory_orphan, so backfilling those '
  'would manufacture rows a shipped alert metric names as defects; that population is measured '
  'by its own sweep gate instead. Column set mirrors the deployed plant-keyed writer (7 recency '
  'columns, harvest = harvest|first_harvest); conflict action deliberately DO NOTHING, not the '
  'writer''s DO UPDATE. Rollback ledger in snap_cachemissingrow001_inserted.')
ON CONFLICT DO NOTHING;

COMMIT;
