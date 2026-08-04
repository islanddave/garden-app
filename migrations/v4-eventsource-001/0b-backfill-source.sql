-- V4-EVENTSOURCE-001 / 0b — backfill event_log.source from the surfaces that can PROVE it.
-- DATA-ONLY. Idempotent (every UPDATE is guarded on `source IS NULL`); safe to re-run.
--
-- ┌─ APPLIED. Prod 2026-08-04 18:53:13Z, staging 18:50:53Z. ─────────────────────────────────────┐
-- READ THIS BEFORE TRUSTING ANY NUMBER BELOW IT. The block that used to sit here was a DRY-RUN
-- PROJECTION written into the header as documentation, and for the whole of v3.97.0 it was read as
-- if it were an outcome: this file was never actually run, event_log.source sat at 100% NULL
-- (12,100/12,100 in prod, 102/102 in staging), and the "166 unclassified rows" line was quoted
-- downstream as a result. A projection and a result must be labelled differently in the same file.
-- Step (4) below now writes a schema_version row so the question is answerable from the DB instead.
--
-- APPLIED OUTCOME, prod, all 12,100 rows (this file has NO deleted_at filter, so it reaches
-- soft-deleted rows too — the live-only view in the second column is what the gates assert):
--                     all rows        live only (deleted_at IS NULL)
--   app_batch          9,724            9,695   80.6%   metadata->>'batch_id', written by the batch INSERT only
--   app                2,025            1,999   16.6%   an app_events 'log_entry_created' row names the event id
--   app_status           167              167    1.4%   frozen metadata contract schema='status_change.v1'
--   NULL                 184              166    1.4%   NOT provable — left UNKNOWN, see below
--   ------------------------------------------------
--   classified        11,916           11,861   98.6%
-- Re-run immediately after: 0 / 0 / 0 rows updated — idempotent, as designed.
-- Trigger behaviour verified, not assumed: the created_by fingerprint over all 12,100 rows was
-- identical before and after (md5 053fbc2af55fc0329ade44f3409e0935), so prevent_ownership_transfer
-- was a genuine no-op; set_updated_at bumped updated_at on the 11,916 classified rows as expected.
-- Data-only rollback: 0br-rollback-backfill.sql.
-- └──────────────────────────────────────────────────────────────────────────────────────────────┘
--
-- WHY THE REMAINING 166 STAY NULL — this is the load-bearing decision in this file.
-- Measured composition (live rows): 78 observation, 75 pest_treatment, 13 harvest. None has an
-- app_events row and none has an xp_events 'event_logged' grant, which is *consistent with* a
-- direct database write — but it is NOT proof, because lambda/events wraps its app_events INSERT
-- in a non-fatal try/catch (index.js Step 5) and its XP grant in another. A telemetry failure and
-- a direct write are indistinguishable from the data alone (the packet says so itself, §5).
-- Labelling them 'direct' would manufacture a fact. NULL means UNKNOWN and that is the true value.
--
-- THE RESIDUAL IS NOT HOMOGENEOUS, AND THE SPLIT MUST SURVIVE. Grouping the 166 by identical
-- created_at gives 154 rows in exactly 5 transactions plus 12 singletons:
--     2026-07-09 14:32:49.597245+00   67 observation     67 plantings, 1 actor
--     2026-07-09 14:32:49.676390+00   70 pest_treatment  70 plantings, 1 actor
--     2026-07-09 14:32:49.724728+00    5 pest_treatment   5 plantings, 1 actor
--     2026-08-04 01:43:58.123597+00    5 harvest          5 plantings, 1 actor
--     2026-08-04 13:36:42.852667+00    7 harvest          7 plantings, 1 actor
-- Those 154 are strong 'direct' CANDIDATES. This is NOT the discredited timestamp-collision
-- heuristic: that one was 98.5% false-positive because POST /api/events/batch gives up to 500 rows
-- one created_at, and the added condition `metadata->>'batch_id' IS NULL` removes precisely that
-- entire false-positive class (all 166 residual rows carry no batch_id, verified).
-- The named falsifier was run and did NOT fire: across all 36 revisions of lambda/events/index.js
-- that carry a batch route (2026-05-24 .. 2026-08-04, spanning both candidate dates), every single
-- one builds jsonb_build_object('batch_id', …) into the batch INSERT — no historical version of
-- the batch path ever omitted it. That is source history, not deployment history, so it is
-- corroboration and not proof, and they are STILL NOT LABELLED here. 0b classifies only what it
-- can prove; promoting these needs a writer that KNOWS it bypassed the API. Candidate ids are
-- handed forward for that decision — agent-driftrepair owns the direct-write population.
-- The 12 singletons (3 pre-telemetry rows 2026-04-30..05-01, 8 observations on 2026-07-09, and one
-- 2026-07-11 harvest) have no grouping evidence at all and are permanently unknowable: they stay
-- NULL forever, and no later pass should try to resolve them.
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

-- (4) LEDGER ROW. A data-only step that writes no schema_version row is INVISIBLE to every "what
--     has been applied?" query, and that is not a hypothetical: this file was written, reviewed and
--     then never run, and nothing noticed for the whole of v3.97.0 because gates.yml licensed it to
--     lag and there was no row to be missing. event_log.source sat 100% NULL, 12,100/12,100, in
--     prod. A DDL step announces itself by the object it creates; a backfill announces itself only
--     here, so "did the backfill run?" must be answerable in one query.
--     ON CONFLICT DO NOTHING keeps the file re-runnable — a re-run that classifies 0 rows is a
--     legitimate no-op and must not fail on the ledger.
INSERT INTO public.schema_version (version, description)
VALUES ('4.21.3-eventsource-001-backfill',
        'Backfill event_log.source from provable surfaces (batch metadata / app_events telemetry / '
        'frozen status_change.v1 contract). DATA-ONLY, idempotent. Rows whose provenance is not '
        'provable stay NULL on purpose — NULL means UNKNOWN and 0b never assigns ''direct''.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- Readout — run after COMMIT to record what this migration classified.
--   SELECT COALESCE(source,'(null/unknown)') AS source, count(*)
--     FROM public.event_log WHERE deleted_at IS NULL GROUP BY 1 ORDER BY 2 DESC;
