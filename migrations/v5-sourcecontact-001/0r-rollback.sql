-- Roll back v5-seasonstats-001 first: stat_saved_lot depends on these columns
-- 0r-rollback.sql
-- Reverses V5-SOURCECONTACT-001: re-arms trg_audit_source_upd with the ORIGINAL nine-column watched
-- set, drops both CHECKs, drops both columns, and deletes the receipt so the post gates return to
-- vacuously green.
--
--   psql "$URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-sourcecontact-001/0r-rollback.sql
--
-- ── WHAT THIS DESTROYS ──────────────────────────────────────────────────────────────────────────
-- Every Instagram and Facebook link entered after the apply. CHECK BEFORE RUNNING:
--
--   SELECT count(*) FROM public.source WHERE instagram_url IS NOT NULL OR facebook_url IS NOT NULL;
--
-- Non-zero means a person typed those in. Export them first (the audit_events after_jsonb snapshots
-- also carry them for any row edited after the apply, but a row CREATED with them and never edited
-- has no audit row — there is no INSERT trigger on public.source).
--
-- ── ORDER ───────────────────────────────────────────────────────────────────────────────────────
-- The Lambda that names these columns must be rolled back FIRST, or every source read 42703s the
-- moment the columns go.
--
-- The trigger is re-armed BEFORE the columns are dropped. Postgres does not track trigger-argument
-- column names as dependencies, so dropping the columns under the 11-name trigger would succeed and
-- leave it watching two names that no longer exist; re-arming first keeps the list and the table in
-- step at every point inside the transaction.
--
-- The nine names below are v5-sourceentity-001's list, verbatim and in order — the live set before
-- this migration, asserted by pre_audit_trigger_list_is_the_known_nine.
--
-- v5-seasonstats-001's stat_saved_lot selects instagram_url and facebook_url (pg_depend on prod,
-- 2026-09-29), so the DROP COLUMN below would abort the transaction with "other objects depend on
-- it". The guard refuses up front with the order to follow instead.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.stat_saved_lot') IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'raise_exception',
      MESSAGE = 'sourcecontact 0r: public.stat_saved_lot still exists and depends on source.instagram_url / facebook_url',
      HINT    = 'Roll back v5-seasonstats-001 first (migrations/v5-seasonstats-001/0r-rollback.sql), then re-run this rollback.';
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_audit_source_upd ON public.source;
CREATE TRIGGER trg_audit_source_upd
  AFTER UPDATE ON public.source
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.audit_stmt_update(
    'name', 'kind', 'locality', 'address', 'website_url', 'notes',
    'created_by', 'created_at', 'deleted_at');

ALTER TABLE public.source DROP CONSTRAINT IF EXISTS chk_source_instagram_url;
ALTER TABLE public.source DROP CONSTRAINT IF EXISTS chk_source_facebook_url;

ALTER TABLE public.source
  DROP COLUMN IF EXISTS instagram_url,
  DROP COLUMN IF EXISTS facebook_url;

DELETE FROM public.schema_version WHERE version = '5.0.0-sourcecontact-001';

COMMIT;
