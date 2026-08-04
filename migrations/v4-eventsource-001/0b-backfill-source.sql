-- V4-EVENTSOURCE-001 / 0b — backfill event_log.source from the surfaces that can PROVE it.
-- DATA-ONLY. Idempotent (every UPDATE is guarded on `source IS NULL`); safe to re-run.
--
-- MEASURED LIVE 2026-08-04 against prod Neon, 12,025 live event_log rows:
--   app_batch     9,695   80.6%   provable: metadata->>'batch_id' is written by the batch INSERT only
--   app           1,997   16.6%   provable: an app_events 'log_entry_created' row names the event id
--   app_status      167    1.4%   provable: frozen metadata contract schema='status_change.v1'
--   NULL            166    1.4%   NOT provable — left UNKNOWN, see below
--   ------------------------------------
--   classified   11,859   98.6%
--
-- WHY THE REMAINING 166 STAY NULL — this is the load-bearing decision in this file.
-- They are 75 observation + 75 pest_treatment written on a single day (2026-07-09), 13 harvest
-- rows (2026-07-11..2026-08-04), and 3 pre-telemetry rows (2026-04-30..05-01). None has an
-- app_events row and none has an xp_events 'event_logged' grant, which is *consistent with* a
-- direct database write — but it is NOT proof, because lambda/events wraps its app_events INSERT
-- in a non-fatal try/catch (index.js Step 5) and its XP grant in another. A telemetry failure and
-- a direct write are indistinguishable from the data alone (the packet says so itself, §5).
-- Labelling them 'direct' would manufacture a fact. NULL means UNKNOWN and that is the true value.
-- agent-driftrepair owns the direct-write population (measured elsewhere at 154 rows /
-- 5 transactions / 81 plantings) and may promote specific ids to 'direct' with evidence.
--
-- TRIGGER NOTE: public.event_log carries BEFORE UPDATE triggers `set_updated_at` and
-- `prevent_ownership_transfer`. This backfill does not touch created_by, so the ownership-transfer
-- trigger is a no-op; `set_updated_at` WILL bump updated_at on all 11,859 rows. That is accepted —
-- event_log.updated_at is not read as a business fact anywhere (grep: no reader) — but it is
-- stated here rather than discovered later.

BEGIN;

-- (1) Batch path. metadata.batch_id is written ONLY by the batch INSERT
--     (lambda/events/index.js, jsonb_build_object('batch_id', …, 'batch_v', 1)) and there is a
--     matching event_batches row for every value, so this is exact, not heuristic.
UPDATE public.event_log e
   SET source = 'app_batch'
 WHERE e.source IS NULL
   AND e.metadata ->> 'batch_id' IS NOT NULL;

-- (2) Single POST path, proven by its own telemetry row. app_events is the ONLY provenance surface
--     in the schema today; moving this into a column is what later makes dropping it safe.
UPDATE public.event_log e
   SET source = 'app'
 WHERE e.source IS NULL
   AND EXISTS (
         SELECT 1 FROM public.app_events a
          WHERE a.event_name = 'log_entry_created'
            AND a.metadata ->> 'event_id' = e.id::text
       );

-- (3) Server-emitted status_change audit rows. These are app-path writes from a DIFFERENT Lambda
--     (lambda/plants/statusEvents.js, lambda/projects/statusEvents.js), which is why they have no
--     lambda/events telemetry and no XP. Keyed on the FROZEN metadata contract, not on the
--     event_type string alone — event_type is user-facing text, the schema key is a code contract.
--     Verified live: 167 of 167 status_change rows carry schema='status_change.v1'.
--     Both validators REJECT a client-supplied status_change, so this cannot be forged via the API.
UPDATE public.event_log e
   SET source = 'app_status'
 WHERE e.source IS NULL
   AND e.event_type = 'status_change'
   AND e.metadata ->> 'schema' = 'status_change.v1';

COMMIT;

-- Readout — run after COMMIT to record what this migration classified.
--   SELECT COALESCE(source,'(null/unknown)') AS source, count(*)
--     FROM public.event_log WHERE deleted_at IS NULL GROUP BY 1 ORDER BY 2 DESC;
