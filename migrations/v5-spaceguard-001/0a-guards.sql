-- 0a-guards.sql
-- schema_version: 5.1.5-spaceguard-001
-- V5-SPACEREPOINTGUARD-001 (multi-space Phase 1 steps 1.1, 1.2) and V4-SPACESOFTDEL-001 (step 1.3b):
--   an audit trail on public.spaces, a freeze on a Space's coordinates while weather is recorded against
--   them, and no cascade loss off a Space. Build sheet:
--   project-state/_multispace-20261015/multispace-phase1-buildsheet-V203-20261016.0915.md §2 and §3R.
--
-- SCOPE: four new functions in public, eight new triggers (six on spaces, one on each weather table), one
--   audit_events baseline row per existing spaces row, one schema_version row. No table, column,
--   constraint, index, grant or row security is changed. Nothing here changes what any user sees.
--
-- WHAT IT ADDS
--   1.1 C-AUDIT on spaces. Three AFTER ... FOR EACH STATEMENT triggers with transition tables:
--         trg_audit_spaces_upd  -> public.audit_stmt_update_no_soft_delete('name', 'postal_code',
--                                  'weather_lat', 'weather_lng', 'featured_photo_id', 'created_by')
--         trg_audit_spaces_del  -> public.audit_stmt_delete()
--         trg_audit_spaces_ins  -> public.audit_stmt_insert()   (NEW, below)
--       The _no_soft_delete variant, never audit_stmt_update: spaces has no deleted_at, and
--       audit_stmt_update reads o.deleted_at, which raises 42703 there and is swallowed as a WARNING
--       (an audit that installs cleanly and records nothing; v5-fermentpath-001 DS-B2). The step 0
--       precondition refuses if spaces has gained a deleted_at; the port is to swap this trigger to
--       audit_stmt_update and add deleted_at to the list, in the migration that adds the column.
--       Watched: every column except id, created_at and updated_at. created_by is watched although
--       prevent_ownership_transfer already refuses a change to it: watching it costs nothing, and the
--       classification gate then has no unclassified column (sheet P16).
--       audit_stmt_insert is a NEW function, never an INSERT arm on audit_stmt_update/audit_stmt_delete:
--       v4-harvestaudit-001 post_no_insert_arm_was_added forbids that globally. Its body is
--       audit_pv_stmt_insert's (v4-varaudit-001) with its own name in the WARNING: the same error
--       contract as every shared audit writer (SECURITY DEFINER, pinned search_path, cancellation and
--       shutdown re-raised, anything else a WARNING that never aborts the originating INSERT).
--       Baseline: one audit row per existing spaces row (action UPDATE, before = after = the row, actor
--       migration:v5-spaceguard-001), written only for a row with no spaces audit row at all, so a
--       re-apply writes nothing. It is what the 1.2 data gate compares against for the rows that exist
--       today.
--   1.2 C-GUARD: spaces_repoint_guard, BEFORE UPDATE OF weather_lat, weather_lng, postal_code FOR EACH
--       ROW -> public.guard_spaces_repoint(). Raises P0001 when the triple changes (IS DISTINCT FROM, so
--       a NULL on either side counts) while any weather_daily or weather_cold_range row names the Space.
--       Weather is recorded for a place; re-pointing the place under its history would silently
--       re-attribute every row. The OF list is a recorded dependency, so ALTER TABLE spaces DROP COLUMN
--       weather_lat refuses instead of leaving a body that raises 42703 on every UPDATE. The one sanctioned
--       way round it is the escape template in COMMENT ON FUNCTION public.guard_spaces_repoint() and
--       README.md: it disables this one trigger only, so the audit still records the move.
--   1.3b C-BLOCK: spaces_delete_guard, BEFORE DELETE FOR EACH ROW -> public.guard_spaces_delete(). It
--       walks every foreign key whose referenced table is public.spaces (pg_constraint joined to
--       pg_class/pg_namespace by name, read at each delete, so a later foreign key is covered without
--       an edit here) and raises P0001 when any row of the referencing table names the Space. All rows,
--       not only live ones: a foreign key does not know what a soft delete is. Today that is photos
--       (RESTRICT), spacetheme, weather_daily and weather_cold_range (CASCADE, which this replaces as the
--       effective behaviour: a Space's history no longer goes with it). Single-column keys only: a key
--       of any other column count, or one that does not reference spaces.id, raises, naming the key.
--       BEFORE TRUNCATE FOR EACH STATEMENT -> public.guard_space_truncate() on spaces
--       (spaces_truncate_guard), weather_daily (weather_daily_truncate_guard) and weather_cold_range
--       (weather_cold_range_truncate_guard). TRUNCATE skips DELETE triggers and, with CASCADE, takes
--       every referencing table; the BEFORE TRUNCATE triggers of every table in the set fire first, so
--       spaces_truncate_guard also stops TRUNCATE photos CASCADE (spaces.featured_photo_id) and, once
--       v5-spacefk-001 lands, TRUNCATE spaces CASCADE reaching plants and plant_projects.
--       A direct DELETE on a weather table is DETECTED, not prevented: the per-env count gates. Test
--       cleanup has to delete those rows, so a DELETE guard there would break the suite.
--
-- THE GUARD BODIES never contain a write statement, and never the text the global prosrc gates grep for
--   (v4-plantrehomefk-001 / v4-parentprojfk-001, a delete statement naming plants or plant_projects). The
--   escape statements live in COMMENT ON FUNCTION and README.md. Every relation in a body is
--   schema-qualified and every function pins search_path = pg_catalog, public.
--
-- WHY THE DEPLOYED CODE IS UNAFFECTED (the house test), read at garden-app 51a97146 (v5.1.4):
--   * The only writers of spaces are four UPDATEs of featured_photo_id (lambda/photos/index.js:180,
--     :844; lambda/photos/photoDelete.js:122, :328) plus the ON DELETE SET NULL of
--     spaces.featured_photo_id when a photo row is hard-deleted. None sets a coordinate column, so the
--     repoint guard (UPDATE OF those three) never fires for them; the audit triggers cannot abort them.
--   * No deployed code DELETEs or TRUNCATEs spaces, weather_daily or weather_cold_range (git grep).
--     daily-plan writes weather_daily by INSERT ... ON CONFLICT and the Mac job weather_cold_range by
--     INSERT; neither fires a DELETE, UPDATE OF or TRUNCATE trigger here.
--   * Integration teardown deleted spaces and let the CASCADE take the weather rows. The code piece
--     (step 1.3a, already on dev before this file is applied anywhere) deletes them first and probes
--     their residue. Once this file is on staging that change is ONE-WAY: reverting it makes teardown
--     leak (README.md).
--
-- SAFETY / IDEMPOTENCY: one transaction; CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS + CREATE
--   TRIGGER, the baseline WHERE NOT EXISTS, the stamp ON CONFLICT DO NOTHING. A second apply leaves the
--   database as the first did. Step 0 refuses, changing nothing, on a database this file does not fit.
--   LOCKS: on a FIRST apply, CREATE TRIGGER takes SHARE ROW EXCLUSIVE on spaces, weather_daily and
--   weather_cold_range, held to COMMIT: readers do not wait; a writer (daily-plan's weather_daily write
--   at :00, the photos Lambda's featured-photo UPDATE, the Mac job's morning INSERT) waits milliseconds.
--   A RE-RUN with the triggers present takes ACCESS EXCLUSIVE on all three (DROP TRIGGER IF EXISTS of a
--   present trigger), held to COMMIT, so readers queue: a re-run belongs in the same window. lock_timeout
--   5s turns a wait behind a long transaction into a fast failure that changed nothing: run it again.
--   APPLY WINDOW: never at :55-:05 (daily-plan's hourly run). Prod: only after today's scheduled
--   restore-verify run has completed (gh run list --repo islanddave/garden-app --workflow
--   restore-verify.yml -L1) or before today's backup.yml run has started (README.md).
--   Exactly ONE COMMIT, at the end. Do not wrap this file in BEGIN/ROLLBACK on a shared database.
--
-- ROLLBACK: 0r-rollback.sql. Order across Phase 1 is M3 -> M2 -> M1 (README.md).
--
-- REHEARSED on a throwaway local PostgreSQL 17.10 loaded with prod's schema (public, gv, extensions),
--   prod's schema_version rows and the spaces / spacetheme / weather rows as data (README.md
--   "Rehearsal"). Not applied to staging or prod.
--
-- Usage: psql "$URL" -X -v ON_ERROR_STOP=1 -f 0a-guards.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. Refuse a database this file does not fit. Nothing has changed yet. ─────────────────────────
DO $$
DECLARE
  v_missing text;
BEGIN
  -- Names this migration owns, present without its stamp: something else made them.
  IF NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.1.5-spaceguard-001') THEN
    SELECT string_agg(x, ', ') INTO v_missing FROM (
      SELECT 'function ' || p.proname AS x
        FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('audit_stmt_insert', 'guard_spaces_repoint', 'guard_spaces_delete', 'guard_space_truncate')
      UNION ALL
      SELECT 'trigger ' || g.tgname
        FROM pg_catalog.pg_trigger g
       WHERE NOT g.tgisinternal
         AND g.tgname IN ('trg_audit_spaces_upd', 'trg_audit_spaces_del', 'trg_audit_spaces_ins',
                          'spaces_repoint_guard', 'spaces_delete_guard', 'spaces_truncate_guard',
                          'weather_daily_truncate_guard', 'weather_cold_range_truncate_guard')) s;
    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION 'v5-spaceguard-001 0a refused, nothing changed: % already exist(s) and this migration has no stamp.', v_missing
        USING HINT = 'CREATE OR REPLACE would silently take them over. Find what created them; do not edit this guard.';
    END IF;
  END IF;

  -- What the triggers and bodies below name.
  SELECT string_agg(want, ', ') INTO v_missing
    FROM unnest(ARRAY['spaces', 'weather_daily', 'weather_cold_range', 'spacetheme', 'photos', 'audit_events']) AS want
   WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                      WHERE n.nspname = 'public' AND c.relname = want AND c.relkind = 'r');
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'v5-spaceguard-001 0a refused, nothing changed: table(s) % missing from public.', v_missing;
  END IF;

  SELECT string_agg(want, ', ') INTO v_missing
    FROM unnest(ARRAY['audit_stmt_update_no_soft_delete', 'audit_stmt_delete', 'audit_watched_slice']) AS want
   WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                      WHERE n.nspname = 'public' AND p.proname = want);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'v5-spaceguard-001 0a refused, nothing changed: function(s) public.% missing (v4-harvestaudit-001 / v5-fermentpath-001).', v_missing;
  END IF;

  -- The _no_soft_delete writer is right only while spaces has no deleted_at (header, 1.1).
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'spaces' AND column_name = 'deleted_at') THEN
    RAISE EXCEPTION 'v5-spaceguard-001 0a refused, nothing changed: public.spaces has a deleted_at column.'
      USING HINT = 'trg_audit_spaces_upd must then call audit_stmt_update with deleted_at watched; rewrite step 2 on purpose.';
  END IF;

  -- audit_stmt_insert writes action 'INSERT'; a CHECK without it would make every write a swallowed WARNING.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
                   JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
                   JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
                  WHERE n.nspname = 'public' AND t.relname = 'audit_events'
                    AND c.conname = 'audit_events_action_check'
                    AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%''INSERT''%') THEN
    RAISE EXCEPTION 'v5-spaceguard-001 0a refused, nothing changed: audit_events_action_check does not admit INSERT.';
  END IF;

  -- spaces_delete_guard reads single-column keys on spaces.id only; refuse rather than install a guard that
  -- would refuse every delete.
  SELECT string_agg(c.conname, ', ') INTO v_missing
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_class p      ON p.oid = c.confrelid
    JOIN pg_catalog.pg_namespace pn ON pn.oid = p.relnamespace
    LEFT JOIN pg_catalog.pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = c.confkey[1]
   WHERE c.contype = 'f' AND pn.nspname = 'public' AND p.relname = 'spaces'
     AND (cardinality(c.conkey) <> 1 OR cardinality(c.confkey) <> 1 OR pa.attname IS DISTINCT FROM 'id');
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'v5-spaceguard-001 0a refused, nothing changed: foreign key(s) % into spaces are not single-column keys on spaces.id.', v_missing;
  END IF;
END $$;

-- ── 1. The INSERT audit writer. ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.audit_stmt_insert() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  BEGIN
    INSERT INTO public.audit_events
           (table_name, row_id, action, actor_clerk_sub, before_jsonb, after_jsonb)
    SELECT TG_TABLE_NAME,
           n.id,
           'INSERT',
           -- NULLIF before COALESCE: an actor set to '' satisfies NOT NULL and is useless forensically.
           COALESCE(NULLIF(current_setting('app.actor_clerk_sub', true), ''), 'system'),
           NULL,
           to_jsonb(n)
      FROM new_rows n;
  EXCEPTION
    -- Cancellation and shutdown are the operator asking the statement to stop. Swallowing them
    -- would make this trigger un-cancellable, so they are re-raised BEFORE the catch-all.
    WHEN query_canceled OR admin_shutdown THEN
      RAISE;
    WHEN OTHERS THEN
      RAISE WARNING 'audit_stmt_insert(%): audit write FAILED, SQLSTATE=% (%). The originating INSERT is unaffected.',
        TG_TABLE_NAME, SQLSTATE, SQLERRM;
  END;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.audit_stmt_insert() IS 'V5-SPACEREPOINTGUARD-001 (v5-spaceguard-001). The shared AFTER INSERT FOR EACH STATEMENT audit writer: one audit_events row per inserted row (action INSERT, before NULL, after the row, actor app.actor_clerk_sub else system). Requires REFERENCING NEW TABLE AS new_rows and a uuid id column on the audited table (a table without one gets a swallowed 42703 and no audit row). Same contract as audit_stmt_update/audit_stmt_delete: SECURITY DEFINER, pinned search_path, cancellation re-raised, any other failure a WARNING that never aborts the INSERT. Never add an INSERT arm to the shared update/delete writers instead (v4-harvestaudit-001 post_no_insert_arm_was_added). Used by trg_audit_spaces_ins; a later platform_operators migration depends on it.';

-- ── 2. The audit triggers on spaces. ──────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_audit_spaces_upd ON public.spaces;
CREATE TRIGGER trg_audit_spaces_upd
  AFTER UPDATE ON public.spaces
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.audit_stmt_update_no_soft_delete(
    'name', 'postal_code', 'weather_lat', 'weather_lng', 'featured_photo_id', 'created_by');

DROP TRIGGER IF EXISTS trg_audit_spaces_del ON public.spaces;
CREATE TRIGGER trg_audit_spaces_del
  AFTER DELETE ON public.spaces
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.audit_stmt_delete();

DROP TRIGGER IF EXISTS trg_audit_spaces_ins ON public.spaces;
CREATE TRIGGER trg_audit_spaces_ins
  AFTER INSERT ON public.spaces
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.audit_stmt_insert();

-- ── 3. The baseline: one audit row per existing Space, never a second. ─────────────────────────────
INSERT INTO public.audit_events (table_name, row_id, action, actor_clerk_sub, before_jsonb, after_jsonb)
SELECT 'spaces', s.id, 'UPDATE', 'migration:v5-spaceguard-001', to_jsonb(s), to_jsonb(s)
  FROM public.spaces s
 WHERE NOT EXISTS (SELECT 1 FROM public.audit_events a
                    WHERE a.table_name = 'spaces' AND a.row_id = s.id);

-- ── 4. 1.2: the coordinate freeze. ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.guard_spaces_repoint() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF (OLD.weather_lat, OLD.weather_lng, OLD.postal_code)
       IS DISTINCT FROM (NEW.weather_lat, NEW.weather_lng, NEW.postal_code)
     AND (EXISTS (SELECT 1 FROM public.weather_daily w WHERE w.space_id = OLD.id)
          OR EXISTS (SELECT 1 FROM public.weather_cold_range c WHERE c.space_id = OLD.id)) THEN
    RAISE EXCEPTION 'spaces_repoint_guard: space % has weather recorded at its current place; weather_lat, weather_lng and postal_code cannot change while it does', OLD.id
      USING ERRCODE = 'P0001',
            TABLE   = 'spaces',
            HINT    = 'Moving a Space under its weather history is a migration with the owner''s approval, not an UPDATE. '
                   || 'See COMMENT ON FUNCTION public.guard_spaces_repoint() for the escape template.';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.guard_spaces_repoint() IS 'V5-SPACEREPOINTGUARD-001 (v5-spaceguard-001). spaces_repoint_guard: BEFORE UPDATE OF weather_lat, weather_lng, postal_code FOR EACH ROW. Raises P0001 when the triple changes (IS DISTINCT FROM) while any weather_daily or weather_cold_range row names the Space. ESCAPE TEMPLATE, the only sanctioned way round it, one explicit transaction with the owner''s approval: BEGIN; SELECT set_config(''app.actor_clerk_sub'', ''migration:<dir>'', true); ALTER TABLE public.spaces DISABLE TRIGGER spaces_repoint_guard; UPDATE public.spaces SET weather_lat = <lat>, weather_lng = <lng>, postal_code = <zip> WHERE id = <space id>; ALTER TABLE public.spaces ENABLE TRIGGER spaces_repoint_guard; DO $x$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger g JOIN pg_class t ON t.oid = g.tgrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = ''public'' AND t.relname = ''spaces'' AND g.tgname = ''spaces_repoint_guard'' AND g.tgenabled = ''O'') THEN RAISE EXCEPTION ''spaces_repoint_guard not re-enabled''; END IF; END $x$; INSERT INTO public.schema_version (version, description) VALUES (''<stamp>'', ''<ledger id>: <why>; approved by Dave <date>''); COMMIT; Disable THIS trigger only, never DISABLE TRIGGER USER or ALL: trg_audit_spaces_upd must still record the move, or post_space_coordinates_match_newest_audit goes red.';

DROP TRIGGER IF EXISTS spaces_repoint_guard ON public.spaces;
CREATE TRIGGER spaces_repoint_guard
  BEFORE UPDATE OF weather_lat, weather_lng, postal_code ON public.spaces
  FOR EACH ROW EXECUTE FUNCTION public.guard_spaces_repoint();

-- ── 5. 1.3b: no delete of a Space anything still names. ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.guard_spaces_delete() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  r       record;
  v_found boolean;
BEGIN
  IF TG_TABLE_SCHEMA <> 'public' OR TG_TABLE_NAME <> 'spaces' THEN
    RAISE EXCEPTION 'spaces_delete_guard: guard_spaces_delete() guards public.spaces only, not %.%', TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = 'P0001';
  END IF;

  FOR r IN
    SELECT c.conname::text                AS conname,
           cn.nspname::text               AS child_schema,
           ct.relname::text               AS child_table,
           cardinality(c.conkey)          AS n_cols,
           cardinality(c.confkey)         AS n_ref,
           ca.attname::text               AS child_col,
           pa.attname::text               AS ref_col
      FROM pg_catalog.pg_constraint c
      JOIN pg_catalog.pg_class p           ON p.oid = c.confrelid
      JOIN pg_catalog.pg_namespace pn      ON pn.oid = p.relnamespace
      JOIN pg_catalog.pg_class ct          ON ct.oid = c.conrelid
      JOIN pg_catalog.pg_namespace cn      ON cn.oid = ct.relnamespace
      LEFT JOIN pg_catalog.pg_attribute ca ON ca.attrelid = c.conrelid  AND ca.attnum = c.conkey[1]
      LEFT JOIN pg_catalog.pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = c.confkey[1]
     WHERE c.contype = 'f' AND pn.nspname = 'public' AND p.relname = 'spaces'
     ORDER BY ct.relname, c.conname
  LOOP
    IF r.n_cols <> 1 OR r.n_ref <> 1 OR r.ref_col IS DISTINCT FROM 'id' THEN
      RAISE EXCEPTION 'spaces_delete_guard: foreign key % on %.% has % column(s) referencing spaces; this guard reads single-column keys on spaces.id only', r.conname, r.child_schema, r.child_table, r.n_cols
        USING ERRCODE = 'P0001', TABLE = r.child_table;
    END IF;
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I WHERE %I = $1)', r.child_schema, r.child_table, r.child_col)
       INTO v_found USING OLD.id;
    IF v_found THEN
      RAISE EXCEPTION 'spaces_delete_guard: space % still has rows in %.% (foreign key %); a Space is not deleted out from under them', OLD.id, r.child_schema, r.child_table, r.conname
        USING ERRCODE = 'P0001',
              TABLE   = r.child_table,
              HINT    = 'Remove or move those rows first, on purpose. See COMMENT ON FUNCTION public.guard_spaces_delete().';
    END IF;
  END LOOP;

  RETURN OLD;
END;
$$;

COMMENT ON FUNCTION public.guard_spaces_delete() IS 'V4-SPACESOFTDEL-001 (v5-spaceguard-001). spaces_delete_guard: BEFORE DELETE FOR EACH ROW on public.spaces. Walks every foreign key whose referenced table is public.spaces (read from the catalog at each delete) and raises P0001 naming the first referencing table that still has a row for the Space, soft-deleted rows included. Single-column keys on spaces.id only; any other shape raises naming the key. Read-only: it never writes. ESCAPE: there is no switch. Remove the children deliberately first, per referencing table: DELETE FROM public.<table> WHERE <column> = <space id>; then delete the Space. Never DISABLE this trigger; integration cleanup is held to that by src/__tests__/integrationCleanupTriggers.static.test.js.';

DROP TRIGGER IF EXISTS spaces_delete_guard ON public.spaces;
CREATE TRIGGER spaces_delete_guard
  BEFORE DELETE ON public.spaces
  FOR EACH ROW EXECUTE FUNCTION public.guard_spaces_delete();

-- ── 6. 1.3b: no TRUNCATE of a Space or its weather. ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.guard_space_truncate() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  RAISE EXCEPTION '%: TRUNCATE of %.% is refused; it skips the delete guard and, with CASCADE, every table that references it', TG_NAME, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'P0001',
          TABLE   = TG_TABLE_NAME,
          HINT    = 'Delete the rows you mean, by key. See COMMENT ON FUNCTION public.guard_space_truncate().';
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.guard_space_truncate() IS 'V4-SPACESOFTDEL-001 (v5-spaceguard-001). BEFORE TRUNCATE FOR EACH STATEMENT on public.spaces (spaces_truncate_guard), public.weather_daily (weather_daily_truncate_guard) and public.weather_cold_range (weather_cold_range_truncate_guard): always raises P0001. TRUNCATE ... CASCADE fires the BEFORE TRUNCATE triggers of every table it reaches before it empties any, so this also stops a TRUNCATE of photos (spaces.featured_photo_id) or of any table that reaches spaces. ESCAPE: none in normal operation. Delete by key instead (a weather DELETE is caught by the count gates in migrations/v5-spaceguard-001/gates.yml). A truly intended wipe is a migration with the owner''s approval that disables the one trigger, truncates, re-enables it and checks tgenabled = O in the same transaction.';

DROP TRIGGER IF EXISTS spaces_truncate_guard ON public.spaces;
CREATE TRIGGER spaces_truncate_guard
  BEFORE TRUNCATE ON public.spaces
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_space_truncate();

DROP TRIGGER IF EXISTS weather_daily_truncate_guard ON public.weather_daily;
CREATE TRIGGER weather_daily_truncate_guard
  BEFORE TRUNCATE ON public.weather_daily
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_space_truncate();

-- v5-wxcoldband-001 post_no_trigger_and_no_row_security allows exactly this trigger by name, type (34) and
-- function; rename or re-point it and that gate reds.
DROP TRIGGER IF EXISTS weather_cold_range_truncate_guard ON public.weather_cold_range;
CREATE TRIGGER weather_cold_range_truncate_guard
  BEFORE TRUNCATE ON public.weather_cold_range
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_space_truncate();

-- ── 7. The stamp. Same transaction as the DDL: "applied" and "armed" are one event. ───────────────
INSERT INTO public.schema_version (version, description)
VALUES ('5.1.5-spaceguard-001',
        'SPACEGUARD: V5-SPACEREPOINTGUARD-001 + V4-SPACESOFTDEL-001 (multi-space Phase 1 1.1, 1.2, 1.3b). '
        'New public.audit_stmt_insert(); spaces audit triggers trg_audit_spaces_upd '
        '(audit_stmt_update_no_soft_delete: name, postal_code, weather_lat, weather_lng, featured_photo_id, '
        'created_by), trg_audit_spaces_del (audit_stmt_delete), trg_audit_spaces_ins (audit_stmt_insert); one '
        'baseline audit row per existing Space (actor migration:v5-spaceguard-001); spaces_repoint_guard '
        '(BEFORE UPDATE OF weather_lat, weather_lng, postal_code -> guard_spaces_repoint); spaces_delete_guard '
        '(BEFORE DELETE -> guard_spaces_delete, every FK into spaces); BEFORE TRUNCATE guard_space_truncate on '
        'spaces, weather_daily, weather_cold_range. No table, column, constraint or grant changed.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
