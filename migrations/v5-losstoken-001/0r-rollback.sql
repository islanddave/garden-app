-- 0r-rollback.sql — v5-losstoken-001
-- Puts `failed` / `given_away` back on exactly the rows 0a renamed, by the ids in its BEFORE copy and never by
-- token, so a row the new app wrote natively as reduction_lost / reduction_given_away (before or after 0a) is
-- never touched. Then removes the stamp and the copy.
--
-- All or nothing. Each snapshot id must sit in exactly one of event_log / event_log_archive, still carrying the
-- token 0a gave it (both copies, in the archive). An archive or unarchive since 0a is followed: the row is
-- restored where it is now. Anything else (the row gone, in both tables, or its token changed since) is listed
-- and the whole file aborts, restoring nothing and keeping the copy and the stamp.
--
-- Only the token goes back. Whatever legitimately changed on a renamed row since 0a — a soft-delete of the
-- loss, say — stays. updated_at moves forward again (set_updated_at): the row was edited twice, and its value
-- before 0a is in the snapshot until this file drops it, and in 0a's audit_events receipt after.
--
-- WHAT ROLLING BACK COSTS, stated plainly: the renamed rows speak `failed` / `given_away` again. With the alias
-- release live (it reads both tokens, permanently) nothing the user sees changes, and the standing gates in
-- gates.yml disarm with the stamp. This exists to unwind a bad apply, not for tidiness. It does NOT make an app
-- revert below the alias release safe: rows written natively with the new tokens stay new (README.md).
--
-- Usage: psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

SET LOCAL app.actor_clerk_sub = 'migration:v5-losstoken-001:rollback';
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-losstoken-001') THEN
    RAISE EXCEPTION 'v5-losstoken-001 is not applied (no schema_version row); nothing to roll back';
  END IF;
  IF to_regclass('public.snap_losstoken001_event_rows') IS NULL THEN
    RAISE EXCEPTION 'v5-losstoken-001: the BEFORE copy public.snap_losstoken001_event_rows is missing; nothing was restored';
  END IF;
END $$;

-- Lock every row the copy names, in whichever table it is now, for the rest of the transaction. Two
-- statements: FOR UPDATE cannot reach the nullable side of the outer joins below.
DO $$
BEGIN
  PERFORM 1 FROM public.event_log e
    JOIN public.snap_losstoken001_event_rows s ON s.id = e.id
     FOR UPDATE OF e;
  PERFORM 1 FROM public.event_log_archive a
    JOIN public.snap_losstoken001_event_rows s ON s.id = a.id
     FOR UPDATE OF a;
END $$;

-- Where each snapshot row is now, and whether it is still exactly as 0a left it.
CREATE TEMP TABLE losstoken001_where ON COMMIT DROP AS
SELECT s.source_table, s.id, s.old_event_type, s.new_event_type,
       e.id IS NOT NULL             AS in_log,
       a.id IS NOT NULL             AS in_archive,
       e.event_type                 AS log_token,
       a.event_type                 AS archive_token,
       a.row_data->>'event_type'    AS archive_row_data_token,
       COALESCE(
         (e.id IS NOT NULL AND a.id IS NULL AND e.event_type = s.new_event_type)
         OR (a.id IS NOT NULL AND e.id IS NULL
             AND a.event_type = s.new_event_type AND a.row_data->>'event_type' = s.new_event_type),
         false)                     AS restorable
  FROM public.snap_losstoken001_event_rows s
  LEFT JOIN public.event_log e         ON e.id = s.id
  LEFT JOIN public.event_log_archive a ON a.id = s.id;

\echo '=== rows that cannot be restored (0r restores all or none) ==='
SELECT w.source_table AS renamed_in, w.id, w.old_event_type, w.new_event_type,
       w.in_log, w.in_archive, w.log_token, w.archive_token, w.archive_row_data_token
  FROM losstoken001_where w
 WHERE NOT w.restorable;

DO $$
DECLARE
  n_copy    int;
  n_blocked int;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE NOT restorable) INTO n_copy, n_blocked FROM losstoken001_where;
  IF n_blocked > 0 THEN
    RAISE EXCEPTION 'v5-losstoken-001 rollback: % of % row(s) cannot be restored (listed above); nothing was restored', n_blocked, n_copy;
  END IF;
END $$;

UPDATE public.event_log e
   SET event_type = w.old_event_type
  FROM losstoken001_where w
 WHERE w.in_log
   AND e.id = w.id
   AND e.event_type = w.new_event_type;

UPDATE public.event_log_archive a
   SET event_type = w.old_event_type,
       row_data   = jsonb_set(a.row_data, '{event_type}', to_jsonb(w.old_event_type), false)
  FROM losstoken001_where w
 WHERE w.in_archive
   AND a.id = w.id
   AND a.event_type = w.new_event_type;

DO $$
DECLARE
  v_bad text;
  n_log int;
  n_arc int;
BEGIN
  SELECT string_agg(w.id::text, ', ') INTO v_bad
    FROM losstoken001_where w
    LEFT JOIN public.event_log e         ON w.in_log     AND e.id = w.id
    LEFT JOIN public.event_log_archive a ON w.in_archive AND a.id = w.id
   WHERE NOT COALESCE(
           (w.in_log AND e.event_type = w.old_event_type)
           OR (w.in_archive AND a.event_type = w.old_event_type AND a.row_data->>'event_type' = w.old_event_type),
           false);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'v5-losstoken-001 rollback: row(s) not carrying their old token after the restore: %; nothing was restored', v_bad;
  END IF;
  SELECT count(*) FILTER (WHERE in_log), count(*) FILTER (WHERE in_archive) INTO n_log, n_arc FROM losstoken001_where;
  RAISE NOTICE 'v5-losstoken-001 rollback: restored % event_log row(s) and % event_log_archive row(s)', n_log, n_arc;
END $$;

DELETE FROM public.schema_version WHERE version = '5.0.0-losstoken-001';
DROP TABLE public.snap_losstoken001_event_rows;

COMMIT;
