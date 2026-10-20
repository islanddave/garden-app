-- 0r-rollback.sql: v5-tenancykey-001 rollback, the whole directory in reverse (25 -> 01), in ONE transaction.
-- V5-SPACETENANCYKEY-001, multi-space step 2.1.
--
-- WHAT, per table whose stamp is present (a partly applied run is rolled back as far as it went):
--   files 23-25 (key only): DROP CONSTRAINT <table>_workspace_id_fkey; the column stays (it predates 2.1).
--   files 01-22: DROP CONSTRAINT <table>_workspace_id_fkey, then DROP COLUMN workspace_id.
--   file 21 also: trg_audit_source_upd back to its eleven watched names (DROP + CREATE), before the column goes.
--   then DELETE the stamp.
--
-- DESTRUCTIVE (DROP COLUMN on up to 22 tables). It is a rollback for the window before any code names these
--   columns. It REFUSES, changing nothing, when:
--   * any row of a table it would drop the column from names a Space other than the one the DEFAULT names:
--     a later writer (2.2, 4.3) stamped it, and dropping the column would lose that row's Space;
--   * a workspace_id column on one of the 22, or a key of the name it drops, exists without its stamp
--     (something other than this directory made it; this file drops only what the directory made).
--   It never uses CASCADE: an object that depends on a column (a view, a later step's index) makes the
--   DROP fail and the whole transaction roll back. Undo that object's step first.
--   Run 2.3's rollback first if 2.3 has run (dropping a validated key is the same statement; the order keeps
--   2.3's stamp from outliving its keys).
-- ENV. None needed: it changes only what the stamps say this directory did.
-- LOCKS. ACCESS EXCLUSIVE on each table touched and on spaces (dropping a key removes its RI triggers from
--   spaces), to COMMIT. lock_timeout 5s. Same windows as the apply: never at :58-:02 or 07:00-08:00 UTC.
-- RE-RUN. A second run finds no stamp and changes nothing.
-- Usage: psql "$URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-tenancykey-001/0r-rollback.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $rollback$
DECLARE
  r record;
  v_has_col boolean;
  v_has_key boolean;
  v_n bigint;
  v_bad text := '';
  v_def text;
  v_done int := 0;
BEGIN
  CREATE TEMP TABLE tenancykey_tables (n int, relname text, stamp text, adds_column boolean) ON COMMIT DROP;
  INSERT INTO tenancykey_tables VALUES
    -- BEGIN tenancykey tables
    (1, 'locations', '5.3.13-tenancykey-001-locations', true),
    (2, 'photos', '5.3.13-tenancykey-001-photos', true),
    (3, 'inventory_items', '5.3.13-tenancykey-001-inventory-items', true),
    (4, 'storage_location', '5.3.13-tenancykey-001-storage-location', true),
    (5, 'preservation_log', '5.3.13-tenancykey-001-preservation-log', true),
    (6, 'kitchen_batch', '5.3.13-tenancykey-001-kitchen-batch', true),
    (7, 'pantry_item', '5.3.13-tenancykey-001-pantry-item', true),
    (8, 'recipe', '5.3.13-tenancykey-001-recipe', true),
    (9, 'tag', '5.3.13-tenancykey-001-tag', true),
    (10, 'critter_state', '5.3.13-tenancykey-001-critter-state', true),
    (11, 'findings', '5.3.13-tenancykey-001-findings', true),
    (12, 'tasks', '5.3.13-tenancykey-001-tasks', true),
    (13, 'event_batches', '5.3.13-tenancykey-001-event-batches', true),
    (14, 'daily_plan', '5.3.13-tenancykey-001-daily-plan', true),
    (15, 'favorites', '5.3.13-tenancykey-001-favorites', true),
    (16, 'voice_alias', '5.3.13-tenancykey-001-voice-alias', true),
    (17, 'proj_rescope_events', '5.3.13-tenancykey-001-proj-rescope-events', true),
    (18, 'weather_cue_impression', '5.3.13-tenancykey-001-weather-cue-impression', true),
    (19, 'cultivar_weight_sample', '5.3.13-tenancykey-001-cultivar-weight-sample', true),
    (20, 'cultivar_weight_void', '5.3.13-tenancykey-001-cultivar-weight-void', true),
    (21, 'source', '5.3.13-tenancykey-001-source', true),
    (22, 'slug_redirects', '5.3.13-tenancykey-001-slug-redirects', true),
    (23, 'treatment_association', '5.3.13-tenancykey-001-fk-treatment-association', false),
    (24, 'garden_shared_state', '5.3.13-tenancykey-001-fk-garden-shared-state', false),
    (25, 'seen_event', '5.3.13-tenancykey-001-fk-seen-event', false)
    -- END tenancykey tables
    ;

  -- ── Pass 1: every refusal, before anything is dropped. ───────────────────────────────────────────────
  FOR r IN SELECT k.*, EXISTS (SELECT 1 FROM public.schema_version sv WHERE sv.version = k.stamp) AS stamped
             FROM tenancykey_tables k ORDER BY k.n DESC LOOP
    SELECT EXISTS (SELECT 1 FROM pg_attribute a
                     JOIN pg_class c ON c.oid = a.attrelid
                     JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public' AND c.relname = r.relname
                      AND a.attname = 'workspace_id' AND NOT a.attisdropped),
           EXISTS (SELECT 1 FROM pg_constraint k
                     JOIN pg_class c ON c.oid = k.conrelid
                     JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public' AND c.relname = r.relname
                      AND k.conname = r.relname || '_workspace_id_fkey')
      INTO v_has_col, v_has_key;
    IF NOT r.stamped THEN
      IF v_has_key THEN
        v_bad := v_bad || format(' %s_workspace_id_fkey exists without stamp %s;', r.relname, r.stamp);
      END IF;
      IF r.adds_column AND v_has_col THEN
        v_bad := v_bad || format(' %I.workspace_id exists without stamp %s;', r.relname, r.stamp);
      END IF;
      CONTINUE;
    END IF;
    IF r.adds_column AND v_has_col THEN
      EXECUTE format('SELECT count(*) FROM public.%I WHERE workspace_id IS DISTINCT FROM %L::uuid',
                     r.relname, '00000000-0000-0000-0000-000000000001') INTO v_n;
      IF v_n > 0 THEN
        v_bad := v_bad || format(' %s row(s) of %I name another Space;', v_n, r.relname);
      END IF;
    END IF;
  END LOOP;
  -- File 21 re-created trg_audit_source_upd with workspace_id watched. Put the eleven-name definition back only
  -- over the definition file 21 wrote (fingerprint 109d579d...); the eleven-name one (6680e278...) needs nothing.
  IF EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.3.13-tenancykey-001-source') THEN
    SELECT md5(concat_ws('|', t.tgtype::text, t.tgenabled::text, pn.nspname, p.proname,
                         pg_get_function_identity_arguments(p.oid), coalesce(t.tgoldtable, ''), coalesce(t.tgnewtable, ''),
                         t.tgnargs::text, encode(t.tgargs, 'escape'), (t.tgqual IS NULL)::text, t.tgattr::text,
                         t.tgdeferrable::text, t.tginitdeferred::text))
      INTO v_def
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_proc p ON p.oid = t.tgfoid
      JOIN pg_namespace pn ON pn.oid = p.pronamespace
     WHERE n.nspname = 'public' AND c.relname = 'source' AND t.tgname = 'trg_audit_source_upd';
    IF v_def IS DISTINCT FROM '109d579db13a5f4b329bf2b60dd3c1d4' AND v_def IS DISTINCT FROM '6680e278331fbcc28bbb5242b10a2f35' THEN
      v_bad := v_bad || format(' trg_audit_source_upd fingerprint is %s, neither file 21''s nor the one it replaced;', coalesce(v_def, 'absent'));
    END IF;
  END IF;

  IF v_bad <> '' THEN
    RAISE EXCEPTION 'v5-tenancykey-001 0r refused, nothing changed:%', v_bad;
  END IF;

  -- ── Pass 2: reverse order, key, then column, then stamp. ─────────────────────────────────────────────
  FOR r IN SELECT k.* FROM tenancykey_tables k
            WHERE EXISTS (SELECT 1 FROM public.schema_version sv WHERE sv.version = k.stamp)
            ORDER BY k.n DESC LOOP
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', r.relname, r.relname || '_workspace_id_fkey');
    IF r.relname = 'source' AND v_def = '109d579db13a5f4b329bf2b60dd3c1d4' THEN
      DROP TRIGGER trg_audit_source_upd ON public.source;
      CREATE TRIGGER trg_audit_source_upd
        AFTER UPDATE ON public.source
        REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
        FOR EACH STATEMENT EXECUTE FUNCTION public.audit_stmt_update('name', 'kind', 'locality', 'address', 'website_url', 'notes', 'created_by', 'created_at', 'deleted_at', 'instagram_url', 'facebook_url');
    END IF;
    IF r.adds_column THEN
      EXECUTE format('ALTER TABLE public.%I DROP COLUMN IF EXISTS workspace_id', r.relname);
    END IF;
    DELETE FROM public.schema_version WHERE version = r.stamp;
    v_done := v_done + 1;
  END LOOP;
  RAISE NOTICE 'v5-tenancykey-001 0r: rolled back % file(s).', v_done;
END $rollback$;

COMMIT;
