-- 0r-rollback.sql: v5-platformoperators-001 rollback (V5-SPACEISOLATION-001, step 1.16). Drops the four triggers,
--   public.platform_operators and public.guard_platform_operators_identity(), and removes stamp
--   5.1.5-platformoperators-001. Touches no other table.
--
-- ORDER ACROSS PHASE 1: M3 -> M2 -> M1. This file (and v5-tenantgates-001's 0r) first, then v5-spacefk-001, then
--   v5-spaceguard-001. v5-spaceguard-001's 0r refuses while trg_audit_platform_operators_ins calls its
--   public.audit_stmt_insert(), so running it first changes nothing and says to run this file.
--
-- CODE BACK BEFORE SCHEMA BACK. Nothing reads this table until Phase 4 step 4.7. Once a reader is on dev, this file
--   is no longer a clean undo: roll the reader back first.
--
-- THE REFUSAL GUARD (step 0). The row 0a seeded (added_by migration:v5-platformoperators-001) is re-derived from
--   public.spaces by the next 0a, so dropping it loses nothing. Any OTHER row is a grant someone made on purpose:
--   this file refuses, changing nothing, while one exists, and names how many. To go on, remove those grants
--   deliberately (DELETE FROM public.platform_operators WHERE id = '<id>'; each is recorded by the DELETE audit
--   row), then run this file again. Do not edit the guard.
--
-- WHAT IS LEFT: the audit_events rows. Every INSERT, UPDATE and DELETE row the triggers wrote is history, and audit
--   history is never deleted by a rollback; the INSERT rows hold each grant's full row in after_jsonb. A re-apply
--   of 0a seeds again (new id, new INSERT audit row). A re-run after a successful rollback finds no table and no
--   stamp and is a no-op.
--
-- No constraint or index is dropped by name: they belong to the table and go with it. No CASCADE: a dependency
--   nobody declared (a view, a later foreign key) stops the rollback instead of disappearing with it.
--
-- LOCKS: ACCESS EXCLUSIVE on platform_operators only, held to COMMIT. lock_timeout 5s; a 55P03 dropped nothing.
--   Never at :55-:05.
--
-- Usage: psql "$URL" -X -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. The refusal guard. Nothing has changed yet. ───────────────────────────────────────────────
DO $$
DECLARE
  v_rows bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relname = 'platform_operators' AND c.relkind = 'r') THEN
    EXECUTE 'SELECT count(*) FROM public.platform_operators WHERE added_by IS DISTINCT FROM ''migration:v5-platformoperators-001'''
       INTO v_rows;
    IF v_rows > 0 THEN
      RAISE EXCEPTION 'v5-platformoperators-001 0r refused, nothing dropped: % operator grant(s) were made after the seed.', v_rows
        USING HINT = 'Remove them deliberately first (DELETE by id; each DELETE is audited), then run this file again. Do not edit this guard.';
    END IF;
  END IF;
END $$;

-- ── 1. Triggers, in reverse of 0a. ───────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relname = 'platform_operators' AND c.relkind = 'r') THEN
    DROP TRIGGER IF EXISTS trg_audit_platform_operators_del ON public.platform_operators;
    DROP TRIGGER IF EXISTS trg_audit_platform_operators_upd ON public.platform_operators;
    DROP TRIGGER IF EXISTS trg_audit_platform_operators_ins ON public.platform_operators;
    DROP TRIGGER IF EXISTS platform_operators_identity_guard ON public.platform_operators;
  END IF;
END $$;

-- ── 2. The table, then the function. No CASCADE. ─────────────────────────────────────────────────
DROP TABLE IF EXISTS public.platform_operators;
DROP FUNCTION IF EXISTS public.guard_platform_operators_identity();

-- ── 3. The stamp. ────────────────────────────────────────────────────────────────────────────────
DELETE FROM public.schema_version WHERE version = '5.1.5-platformoperators-001';

COMMIT;
