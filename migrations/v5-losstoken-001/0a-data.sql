-- 0a-data.sql
-- v5-losstoken-001 — V5-LOSSTOKEN-001: move the stored plant-reduction event tokens out of the status and
-- outcome vocabularies. Every stored copy of the token is rewritten, soft-deleted rows included:
--     event_log.event_type                                   failed     -> reduction_lost
--     event_log_archive.event_type + row_data->'event_type'  given_away -> reduction_given_away
-- Data-only: no DDL on an app table. The one table this creates, public.snap_losstoken001_event_rows, is the
-- BEFORE copy 0r restores from (the house pattern: v5-cacheorphan-001, v4-rainbackfill-001).
--
-- NOT APPLIED as of authoring (2026-09-29, lane losstokenmig). Nothing in this directory has run against
-- staging or prod. Rehearsed on a throwaway local Postgres 17 by rehearse_local.py (README.md).
--
-- Usage: psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f 0a-data.sql
--
-- ─── APPLY ORDER (README.md) ─────────────────────────────────────────────────────────────────────────────
-- NEVER before the app release that reads BOTH tokens and WRITES the new ones is live on the prod events
-- Lambda AND the prod frontend, and never before gam-site reads both tokens. Code that knows only `failed`
-- cannot read what this file writes: its DELETE reverses no counter for a renamed loss (readReductionPlan on
-- the stored row, lambda/events/index.js:2640), its PUT lets a renamed loss be edited (the
-- REDUCTION_EVENT_IMMUTABLE guard reads the stored type, :1662), and its feed prints the raw token. gates.yml
-- carries both prerequisites as MANUAL pre gates; gate_runner prints them and never counts them as passes.
--
-- ─── THE ROWS (read on prod 2026-09-29, owner DSN, read-only) ────────────────────────────────────────────
-- 7 live `failed` rows, each on its own planting, logged 2026-08-21 (4), 2026-09-01 (2) and 2026-09-29 (1),
-- each carrying plant_id, an integer qty_reduced and a loss_reason and no other metadata key. 0 soft-deleted,
-- 0 `given_away`, 0 in event_log_archive (494 rows), 0 in event_batches, 0 achievements keyed on either
-- token. The count grows whenever Dave logs a loss, so NOTHING below names a count or an id: the target set
-- is whatever carries a legacy token when this file runs, fixed by the snapshot under row locks.
--
-- ─── WHAT RUNS, IN ORDER ─────────────────────────────────────────────────────────────────────────────────
-- 1. Refuse a second apply (the stamp). A leftover BEFORE copy is refused too: CREATE TABLE fails on it.
-- 2. SET LOCAL app.actor_clerk_sub, so trg_audit_event_log_upd attributes every rename to this migration,
--    and a lock_timeout, so a row held by an in-flight edit stops the apply instead of stalling it.
-- 3. Refuse two states the rename cannot express as one decision per row: an archive row whose two copies of
--    the token disagree (unarchive rebuilds the event from row_data; the column is a denormalised copy), and
--    a legacy token in event_batches (the batch route refuses both tokens, so one there is an anomaly to read,
--    and gates.yml's standing gate covers that table).
-- 4. The BEFORE copy: every row carrying a legacy token, in either table, soft-deleted included, captured
--    with SELECT ... FOR UPDATE — table name, id, old token, new token and the whole row as jsonb. ONE CASE
--    maps both tokens, here and nowhere else. This is the target set; the UPDATEs are keyed on it.
-- 5. The rename, by snapshot id, never by token.
-- 6. All or nothing: every snapshot row carries exactly its mapped token (the pairs are written out again
--    rather than read back from the snapshot, so a swapped CASE fails here instead of being copied), nothing
--    but the token moved, and no legacy token is left anywhere. Any miss RAISEs and the whole file rolls back.
-- 7. The report and the stamp.
--
-- ─── TRIGGERS ON event_log (pg_get_triggerdef on prod 2026-09-29) ────────────────────────────────────────
--   prevent_ownership_transfer  BEFORE UPDATE, row   compares created_by only; nothing here writes it.
--   set_updated_at              BEFORE UPDATE, row   sets updated_at = now() on each renamed row. Expected:
--                                                    every comparison here and in gates.yml excludes it.
--   trg_audit_event_log_upd     AFTER UPDATE, stmt   one audit_events row per renamed row (event_type is a
--                                                    watched column), actor from step 2. Best effort: it
--                                                    downgrades its own failure to a WARNING, so gates.yml
--                                                    checks the receipts instead of assuming them.
--   trg_audit_event_log_del     AFTER DELETE, stmt   not reached; nothing is deleted.
-- event_log_archive and event_batches carry no triggers. No CHECK, index, view, function or policy names
-- either token (read on prod), so nothing is armed or disarmed.
--
-- SAFETY: on a database with no legacy row the snapshot and both UPDATEs match nothing and only an empty
-- snapshot and the stamp land. Staging is one: cut from prod on 2026-08-11, before the first loss on
-- 2026-08-21, and read-only on 2026-09-29 it held no reduction row of either spelling. On PROD expect
-- `INSERT 0 N` with N >= 7 for the snapshot: 0 there means the wrong host. ROLLBACK: 0r-rollback.sql.

BEGIN;

SET LOCAL app.actor_clerk_sub = 'migration:v5-losstoken-001';
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-losstoken-001') THEN
    RAISE EXCEPTION 'v5-losstoken-001 is already applied (its schema_version row exists); nothing was changed';
  END IF;
END $$;

DO $$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(a.id::text || ' (column=' || COALESCE(a.event_type, 'NULL')
                    || ', row_data=' || COALESCE(a.row_data->>'event_type', 'NULL') || ')', '; ')
    INTO v_bad
    FROM public.event_log_archive a
   WHERE (a.event_type IN ('failed', 'given_away') OR a.row_data->>'event_type' IN ('failed', 'given_away'))
     AND a.event_type IS DISTINCT FROM a.row_data->>'event_type';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'v5-losstoken-001: event_log_archive row(s) whose two copies of the token disagree: %; nothing was changed', v_bad;
  END IF;

  SELECT string_agg(b.id::text || ' (' || b.event_type || ')', '; ') INTO v_bad
    FROM public.event_batches b
   WHERE b.event_type IN ('failed', 'given_away');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'v5-losstoken-001: event_batches row(s) carry a legacy token, which the batch route never writes: %; nothing was changed', v_bad;
  END IF;
END $$;

-- The BEFORE copy. (source_table, id) is the key: archive and unarchive move a row between the two tables
-- under the same id.
CREATE TABLE public.snap_losstoken001_event_rows (
  source_table   text        NOT NULL CHECK (source_table IN ('event_log', 'event_log_archive')),
  id             uuid        NOT NULL,
  old_event_type text        NOT NULL,
  new_event_type text        NOT NULL,
  row_before     jsonb       NOT NULL,
  snapped_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_table, id)
);

COMMENT ON TABLE public.snap_losstoken001_event_rows IS
  'v5-losstoken-001 BEFORE copy: every event_log / event_log_archive row that carried failed or given_away '
  'when 0a ran, whole row as jsonb. 0r restores the token by these ids and drops the table.';

WITH locked_log AS (
  SELECT e.id, e.event_type, to_jsonb(e) AS row_before
    FROM public.event_log e
   WHERE e.event_type IN ('failed', 'given_away')
     FOR UPDATE
), locked_archive AS (
  SELECT a.id, a.event_type, to_jsonb(a) AS row_before
    FROM public.event_log_archive a
   WHERE a.event_type IN ('failed', 'given_away')
     FOR UPDATE
), targets AS (
  SELECT 'event_log' AS source_table, id, event_type, row_before FROM locked_log
  UNION ALL
  SELECT 'event_log_archive', id, event_type, row_before FROM locked_archive
)
INSERT INTO public.snap_losstoken001_event_rows (source_table, id, old_event_type, new_event_type, row_before)
SELECT t.source_table, t.id, t.event_type,
       CASE t.event_type
         WHEN 'failed'     THEN 'reduction_lost'
         WHEN 'given_away' THEN 'reduction_given_away'
       END,
       t.row_before
  FROM targets t;

UPDATE public.event_log e
   SET event_type = s.new_event_type
  FROM public.snap_losstoken001_event_rows s
 WHERE s.source_table = 'event_log'
   AND s.id = e.id;

-- create_missing is false on purpose: step 3 proved row_data carries the key, and the check block below reads
-- it back, so a jsonb_set that silently wrote nothing would abort the apply rather than pass.
UPDATE public.event_log_archive a
   SET event_type = s.new_event_type,
       row_data   = jsonb_set(a.row_data, '{event_type}', to_jsonb(s.new_event_type), false)
  FROM public.snap_losstoken001_event_rows s
 WHERE s.source_table = 'event_log_archive'
   AND s.id = a.id;

DO $$
DECLARE
  v_bad      text;
  v_live     int;
  v_deleted  int;
  v_archive  int;
BEGIN
  SELECT string_agg(s.source_table || ' ' || s.id::text, ', ') INTO v_bad
    FROM public.snap_losstoken001_event_rows s
    LEFT JOIN public.event_log e         ON s.source_table = 'event_log'         AND e.id = s.id
    LEFT JOIN public.event_log_archive a ON s.source_table = 'event_log_archive' AND a.id = s.id
   WHERE NOT COALESCE(
           (s.old_event_type, COALESCE(e.event_type, a.event_type))
             IN (('failed', 'reduction_lost'), ('given_away', 'reduction_given_away'))
           AND s.new_event_type = COALESCE(e.event_type, a.event_type)
           AND (s.source_table = 'event_log' OR a.row_data->>'event_type' = a.event_type),
           false);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'v5-losstoken-001: row(s) not carrying their mapped token after the rename: %; nothing was changed', v_bad;
  END IF;

  -- Same transaction, same TimeZone, so the jsonb renderings compare exactly. updated_at is set_updated_at's.
  SELECT string_agg(s.source_table || ' ' || s.id::text, ', ') INTO v_bad
    FROM public.snap_losstoken001_event_rows s
    LEFT JOIN public.event_log e         ON s.source_table = 'event_log'         AND e.id = s.id
    LEFT JOIN public.event_log_archive a ON s.source_table = 'event_log_archive' AND a.id = s.id
   WHERE (s.source_table = 'event_log'
          AND (to_jsonb(e) - 'event_type' - 'updated_at') IS DISTINCT FROM (s.row_before - 'event_type' - 'updated_at'))
      OR (s.source_table = 'event_log_archive'
          AND ((to_jsonb(a) - 'event_type' - 'row_data') IS DISTINCT FROM (s.row_before - 'event_type' - 'row_data')
               OR (a.row_data - 'event_type') IS DISTINCT FROM ((s.row_before->'row_data') - 'event_type')));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'v5-losstoken-001: row(s) where something other than the token moved: %; nothing was changed', v_bad;
  END IF;

  -- A row that took a legacy token after the snapshot (a writer still on the old code) lands here.
  SELECT string_agg(x.src || ' ' || x.id::text, ', ') INTO v_bad
    FROM (SELECT 'event_log' AS src, e.id FROM public.event_log e
           WHERE e.event_type IN ('failed', 'given_away')
          UNION ALL
          SELECT 'event_log_archive', a.id FROM public.event_log_archive a
           WHERE a.event_type IN ('failed', 'given_away') OR a.row_data->>'event_type' IN ('failed', 'given_away')
          UNION ALL
          SELECT 'event_batches', b.id FROM public.event_batches b
           WHERE b.event_type IN ('failed', 'given_away')) x;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'v5-losstoken-001: legacy token(s) still stored after the rename (a writer on the old code?): %; nothing was changed', v_bad;
  END IF;

  SELECT count(*) FILTER (WHERE s.source_table = 'event_log' AND s.row_before->>'deleted_at' IS NULL),
         count(*) FILTER (WHERE s.source_table = 'event_log' AND s.row_before->>'deleted_at' IS NOT NULL),
         count(*) FILTER (WHERE s.source_table = 'event_log_archive')
    INTO v_live, v_deleted, v_archive
    FROM public.snap_losstoken001_event_rows s;
  RAISE NOTICE 'v5-losstoken-001: renamed % live and % soft-deleted event_log row(s) and % event_log_archive row(s); BEFORE copy in public.snap_losstoken001_event_rows',
    v_live, v_deleted, v_archive;
END $$;

\echo '=== renamed (the BEFORE copy; an archive row reports its row_data) ==='
SELECT s.source_table, s.id, s.old_event_type, s.new_event_type,
       r.ev->>'plant_id'                                                  AS plant_id,
       r.ev->'metadata'->>'qty_reduced'                                   AS qty_reduced,
       COALESCE(r.ev->'metadata'->>'loss_reason', r.ev->'metadata'->>'giveaway_reason') AS reason,
       r.ev->>'deleted_at' IS NOT NULL                                    AS soft_deleted
  FROM public.snap_losstoken001_event_rows s
  CROSS JOIN LATERAL (SELECT CASE s.source_table WHEN 'event_log' THEN s.row_before
                                                 ELSE s.row_before->'row_data' END AS ev) r
 ORDER BY s.source_table, r.ev->>'created_at', s.id;

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('5.0.0-losstoken-001',
        'LOSSTOKEN-001: V5-LOSSTOKEN-001 (data-only; BEFORE copy in snap_losstoken001_event_rows). Renames the stored '
        'plant-reduction event tokens out of the status/outcome vocabularies, Dave''s decision 2026-09-29: '
        'event_log.event_type failed -> reduction_lost and given_away -> reduction_given_away on every row, '
        'soft-deleted included, and both copies in event_log_archive (event_type and row_data). Target set fixed '
        'at apply time under row locks; all or nothing. Apply only after the app release that reads both tokens '
        'and writes the new ones is live. Reversible via 0r, by snapshot id.',
        now());

COMMIT;
