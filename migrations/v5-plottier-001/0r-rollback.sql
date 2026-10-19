-- 0r-rollback.sql: v5-plottier-001 rollback (V5-SPACEPLOTTIER-001, multi-space Phase 3 step 3.1). Drops the six
--   triggers, public.plots and the two functions 0a made, and removes stamp 5.3.6-plottier-001. Touches no other
--   table, column, constraint or function (public.guard_space_truncate and the audit writers are
--   v5-spaceguard-001's and v4-harvestaudit-001's, and stay).
--
-- ORDER: after the rollback of every later step that references plots. 3.2a, 3.5 and 3.6 add foreign keys INTO plots; DROP
--   TABLE below has no CASCADE, so with one in place this file would fail and change nothing (one transaction).
--   Step 0 says so first, naming the key: roll that step back first. This file runs before v5-spaceguard-001's
--   0r, which drops public.audit_stmt_insert and public.guard_space_truncate with no CASCADE and refuses while
--   a trigger on another table binds them.
--
-- WHAT IT REFUSES (step 0): a plot that is not a Plot 1 exactly as 0a wrote it: one whose INSERT audit row is not
--   the migration's (someone added a plot after the apply), or one with any UPDATE, SOFT_DELETE or RESTORE audit
--   row (someone changed it). Dropping those would destroy a person's data with no copy (Soft-Delete-Only). To go
--   on, decide each deliberately, then run this file again. Do not edit the guard. A Plot 1 as written is a copy of
--   its Space's columns, so dropping it loses nothing spaces does not still hold.
--
-- WHAT IS LEFT: the audit_events rows. Every INSERT, UPDATE and DELETE row the triggers wrote is history, and audit
--   history is never deleted by a rollback; each INSERT row holds its plot's full row in after_jsonb. A re-apply
--   of 0a writes Plot 1 again (new id, new INSERT audit row). A re-run after a successful rollback finds no table
--   and no stamp and is a no-op.
--
-- No constraint or index is dropped by name: they belong to the table and go with it. No CASCADE: a dependency
--   nobody declared (a view, a later foreign key) stops the rollback instead of disappearing with it.
--
-- LOCKS: ACCESS EXCLUSIVE on plots, and SHARE ROW EXCLUSIVE on spaces (its RI triggers go with the key), held to
--   COMMIT. lock_timeout 5s; a 55P03 dropped nothing. Never at :55-:05.
--
-- Usage: psql "$URL" -X -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. The refusal guard. Nothing has changed yet. ───────────────────────────────────────────────
DO $$
DECLARE
  v_keys text;
  v_rows bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relname = 'plots' AND c.relkind = 'r') THEN
    SELECT string_agg(cn.nspname || '.' || ct.relname || ' (' || c.conname || ')', ', ' ORDER BY ct.relname, c.conname)
      INTO v_keys
      FROM pg_catalog.pg_constraint c
      JOIN pg_catalog.pg_class p      ON p.oid = c.confrelid
      JOIN pg_catalog.pg_namespace pn ON pn.oid = p.relnamespace
      JOIN pg_catalog.pg_class ct     ON ct.oid = c.conrelid
      JOIN pg_catalog.pg_namespace cn ON cn.oid = ct.relnamespace
     WHERE c.contype = 'f' AND pn.nspname = 'public' AND p.relname = 'plots';
    IF v_keys IS NOT NULL THEN
      RAISE EXCEPTION 'v5-plottier-001 0r refused, nothing dropped: foreign key(s) into plots exist: %.', v_keys
        USING HINT = 'Roll back the step that added them first (3.2a, 3.5 or 3.6).';
    END IF;

    EXECUTE $q$
      SELECT count(*) FROM public.plots p
       WHERE NOT EXISTS (SELECT 1 FROM public.audit_events a
                          WHERE a.table_name = 'plots' AND a.row_id = p.id AND a.action = 'INSERT'
                            AND a.actor_clerk_sub = 'migration:v5-plottier-001')
          OR EXISTS (SELECT 1 FROM public.audit_events a
                      WHERE a.table_name = 'plots' AND a.row_id = p.id
                        AND a.action IN ('UPDATE', 'SOFT_DELETE', 'RESTORE'))
    $q$ INTO v_rows;
    IF v_rows > 0 THEN
      RAISE EXCEPTION 'v5-plottier-001 0r refused, nothing dropped: % plot(s) were added or changed after the apply.', v_rows
        USING HINT = 'They hold data spaces does not. Decide each deliberately (copy it out; its audit rows stay), then run this file again. Do not edit this guard.';
    END IF;
  END IF;
END $$;

-- ── 1. Triggers, in reverse of 0a. ───────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relname = 'plots' AND c.relkind = 'r') THEN
    DROP TRIGGER IF EXISTS plots_truncate_guard ON public.plots;
    DROP TRIGGER IF EXISTS plots_delete_guard ON public.plots;
    DROP TRIGGER IF EXISTS plots_repoint_guard ON public.plots;
    DROP TRIGGER IF EXISTS trg_audit_plots_del ON public.plots;
    DROP TRIGGER IF EXISTS trg_audit_plots_upd ON public.plots;
    DROP TRIGGER IF EXISTS trg_audit_plots_ins ON public.plots;
  END IF;
END $$;

-- ── 2. The table, then the functions. No CASCADE. ────────────────────────────────────────────────
DROP TABLE IF EXISTS public.plots;
DROP FUNCTION IF EXISTS public.guard_plots_delete();
DROP FUNCTION IF EXISTS public.guard_plots_repoint();

-- ── 3. The stamp. ────────────────────────────────────────────────────────────────────────────────
DELETE FROM public.schema_version WHERE version = '5.3.6-plottier-001';

COMMIT;
