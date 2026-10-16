-- 0a-platform-operators.sql
-- schema_version: 5.1.5-platformoperators-001
-- V5-SPACEISOLATION-001 (multi-space Phase 1 step 1.16): public.platform_operators, the list of people who may
--   later write the shared catalog. Build sheet:
--   project-state/_multispace-20261015/multispace-phase1-buildsheet-V203-20261016.0915.md §2 and §3R ("1.16 shape").
--
-- SCOPE: one new table, one new function, four new triggers on that table, one seeded row, one schema_version row.
--   No existing table, column, constraint, index, grant or row security is changed. Nothing reads the table until
--   Phase 4 step 4.7, so nothing here changes what any user sees.
--
-- WHAT IT ADDS
--   * public.platform_operators (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), clerk_user_id text NOT NULL UNIQUE
--     CHECK (clerk_user_id ~ '^user_[A-Za-z0-9]+$'), added_by text NOT NULL, created_at timestamptz NOT NULL
--     DEFAULT now()). The uuid id is what the shared audit writers read: they insert n.id / o.id into
--     audit_events.row_id (uuid). Keyed by clerk_user_id alone, every audit write would raise 42703, be swallowed as
--     a WARNING, and the table that grants shared-catalog authority would look audited with an empty trail
--     (v5-sourcekind-001 met exactly that; review DSA BLOCKING).
--   * C-AUDIT, statement level with transition tables:
--       trg_audit_platform_operators_ins -> public.audit_stmt_insert()     (v5-spaceguard-001)
--       trg_audit_platform_operators_upd -> public.audit_stmt_update_no_soft_delete('clerk_user_id', 'added_by')
--       trg_audit_platform_operators_del -> public.audit_stmt_delete()
--     The _no_soft_delete writer because the table has no deleted_at, on purpose: removing an operator is a hard
--     DELETE, recorded by the DELETE audit row (README.md, the named Soft-Delete-Only exception). Watched: every
--     column but id (it IS audit_events.row_id) and created_at (never changes).
--   * platform_operators_identity_guard, BEFORE UPDATE OF id, clerk_user_id FOR EACH ROW ->
--     public.guard_platform_operators_identity(): P0001 when either changes. A grant is never re-pointed at another
--     person: remove it and add a new one, both audited. id too, because the audit trail is keyed on it and the
--     update writer joins old to new rows on it.
--   * The seed: INSERT ... SELECT created_by FROM public.spaces WHERE id = the original Space, under the migration
--     actor, so the seed carries its own INSERT audit row. No literal person id anywhere in this file. Step 3
--     refuses unless it wrote exactly one row. On staging the original Space's owner is the PROD sub (Phase 0
--     read 1); Phase 4 step 4.7 adds the staging person, not this file.
--
-- WHY THE DEPLOYED CODE IS UNAFFECTED (the house test), read at garden-app 51a97146: no code names
--   platform_operators (recon headline 2), and the seed only reads spaces. The new triggers are on the new table.
--
-- SAFETY / IDEMPOTENCY: one transaction. CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE FUNCTION, DROP TRIGGER IF
--   EXISTS + CREATE TRIGGER, the seed only on the first apply (stamp absent), the stamp ON CONFLICT DO NOTHING. A
--   second apply leaves the database as the first did. Step 0 refuses, changing nothing, on a database this file
--   does not fit.
--   LOCKS: the seed reads one spaces row (ACCESS SHARE); everything else touches only the new table. lock_timeout 5s
--   turns a wait behind a long transaction into a fast failure that changed nothing: run it again.
--   APPLY WINDOW: never at :55-:05 (daily-plan's hourly run).
--   Exactly ONE COMMIT, at the end. Do not wrap this file in BEGIN/ROLLBACK on a shared database.
--
-- DEPENDS ON v5-spaceguard-001 (public.audit_stmt_insert). ROLLBACK: 0r-rollback.sql. Order across Phase 1 is
--   M3 -> M2 -> M1 (README.md); v5-spaceguard-001's 0r refuses while trg_audit_platform_operators_ins exists.
--
-- REHEARSED on a throwaway local PostgreSQL 17.10 loaded with prod's schema and stamps, v5-spaceguard-001's 0a
--   applied first (README.md "Rehearsal"). Not applied to staging or prod.
--
-- Usage: psql "$URL" -X -v ON_ERROR_STOP=1 -f 0a-platform-operators.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

-- The seed is written by this migration, and its audit row says so.
SELECT set_config('app.actor_clerk_sub', 'migration:v5-platformoperators-001', true);

-- ── 0. Refuse a database this file does not fit. Nothing has changed yet. ─────────────────────────
DO $$
DECLARE
  v_missing text;
BEGIN
  -- Names this migration owns, present without its stamp: something else made them.
  IF NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.1.5-platformoperators-001') THEN
    SELECT string_agg(x, ', ') INTO v_missing FROM (
      SELECT 'relation ' || c.relname AS x
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'platform_operators'
      UNION ALL
      SELECT 'function ' || p.proname
        FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'guard_platform_operators_identity'
      UNION ALL
      SELECT 'trigger ' || g.tgname
        FROM pg_catalog.pg_trigger g
       WHERE NOT g.tgisinternal
         AND g.tgname IN ('trg_audit_platform_operators_ins', 'trg_audit_platform_operators_upd',
                          'trg_audit_platform_operators_del', 'platform_operators_identity_guard')) s;
    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION 'v5-platformoperators-001 0a refused, nothing changed: % already exist(s) and this migration has no stamp.', v_missing
        USING HINT = 'CREATE ... IF NOT EXISTS / OR REPLACE would silently take them over. Find what created them; do not edit this guard.';
    END IF;
  END IF;

  -- v5-spaceguard-001 first: its stamp and the INSERT writer it made.
  IF NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.1.5-spaceguard-001')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                     WHERE n.nspname = 'public' AND p.proname = 'audit_stmt_insert' AND p.pronargs = 0 AND p.prosecdef) THEN
    RAISE EXCEPTION 'v5-platformoperators-001 0a refused, nothing changed: v5-spaceguard-001 is not applied (stamp 5.1.5-spaceguard-001 and SECURITY DEFINER public.audit_stmt_insert()).'
      USING HINT = 'Apply migrations/v5-spaceguard-001 first (Phase 1 order M1 -> M2 -> M3).';
  END IF;

  SELECT string_agg(want, ', ') INTO v_missing
    FROM unnest(ARRAY['audit_stmt_update_no_soft_delete', 'audit_stmt_delete', 'audit_watched_slice']) AS want
   WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                      WHERE n.nspname = 'public' AND p.proname = want);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'v5-platformoperators-001 0a refused, nothing changed: function(s) public.% missing (v4-harvestaudit-001 / v5-fermentpath-001).', v_missing;
  END IF;

  -- audit_events.row_id must be the uuid the writers insert, and the action CHECK must admit INSERT.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'audit_events' AND column_name = 'row_id'
                    AND data_type = 'uuid') THEN
    RAISE EXCEPTION 'v5-platformoperators-001 0a refused, nothing changed: public.audit_events.row_id is not a uuid column.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
                   JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
                   JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
                  WHERE n.nspname = 'public' AND t.relname = 'audit_events'
                    AND c.conname = 'audit_events_action_check'
                    AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%''INSERT''%') THEN
    RAISE EXCEPTION 'v5-platformoperators-001 0a refused, nothing changed: audit_events_action_check does not admit INSERT.';
  END IF;

  -- The seed's source, on the first apply: the original Space, owned by a person id the CHECK below admits.
  IF NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.1.5-platformoperators-001')
     AND NOT EXISTS (SELECT 1 FROM public.spaces s
                      WHERE s.id = '00000000-0000-0000-0000-000000000001'
                        AND s.created_by ~ '^user_[A-Za-z0-9]+$') THEN
    RAISE EXCEPTION 'v5-platformoperators-001 0a refused, nothing changed: the original Space is absent or its created_by is not a person id; the seed would write no operator.'
      USING HINT = 'v4-spaceowner sets the owner. Read SELECT id, created_by IS NULL FROM public.spaces before going on.';
  END IF;
END $$;

-- ── 1. The table. ─────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.platform_operators (
  id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  clerk_user_id text        NOT NULL,
  added_by      text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_operators_pkey PRIMARY KEY (id),
  CONSTRAINT platform_operators_clerk_user_id_key UNIQUE (clerk_user_id),
  CONSTRAINT chk_platform_operators_clerk_user_id_shape CHECK (clerk_user_id ~ '^user_[A-Za-z0-9]+$')
);

COMMENT ON TABLE public.platform_operators IS 'V5-SPACEISOLATION-001 (v5-platformoperators-001, multi-space Phase 1 step 1.16). One row per person allowed to write the shared catalog once Phase 4 step 4.7 reads this table; nothing reads it before then. No deleted_at: removal is a hard DELETE, recorded by trg_audit_platform_operators_del (a named Soft-Delete-Only exception: a grant carries no user-authored content). clerk_user_id and id never change (platform_operators_identity_guard): re-pointing a grant is a DELETE plus an INSERT, both audited.';
COMMENT ON COLUMN public.platform_operators.clerk_user_id IS 'The person (Clerk user id, user_...). One row per person.';
COMMENT ON COLUMN public.platform_operators.added_by IS 'Who granted it: a Clerk user id, or migration:<dir> for a row a migration wrote.';

-- ── 2. The identity guard and the audit triggers. ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.guard_platform_operators_identity() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.clerk_user_id IS DISTINCT FROM OLD.clerk_user_id THEN
    RAISE EXCEPTION 'platform_operators_identity_guard: operator row % cannot change its id or clerk_user_id', OLD.id
      USING ERRCODE = 'P0001',
            TABLE   = 'platform_operators',
            HINT    = 'A grant is never re-pointed at another person. Delete it and insert a new one; both are audited.';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.guard_platform_operators_identity() IS 'V5-SPACEISOLATION-001 (v5-platformoperators-001). platform_operators_identity_guard: BEFORE UPDATE OF id, clerk_user_id FOR EACH ROW on public.platform_operators. Raises P0001 when either changes. Read-only: it never writes. ESCAPE: none; remove the grant (DELETE) and add the new one (INSERT).';

DROP TRIGGER IF EXISTS platform_operators_identity_guard ON public.platform_operators;
CREATE TRIGGER platform_operators_identity_guard
  BEFORE UPDATE OF id, clerk_user_id ON public.platform_operators
  FOR EACH ROW EXECUTE FUNCTION public.guard_platform_operators_identity();

DROP TRIGGER IF EXISTS trg_audit_platform_operators_ins ON public.platform_operators;
CREATE TRIGGER trg_audit_platform_operators_ins
  AFTER INSERT ON public.platform_operators
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.audit_stmt_insert();

DROP TRIGGER IF EXISTS trg_audit_platform_operators_upd ON public.platform_operators;
CREATE TRIGGER trg_audit_platform_operators_upd
  AFTER UPDATE ON public.platform_operators
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.audit_stmt_update_no_soft_delete('clerk_user_id', 'added_by');

DROP TRIGGER IF EXISTS trg_audit_platform_operators_del ON public.platform_operators;
CREATE TRIGGER trg_audit_platform_operators_del
  AFTER DELETE ON public.platform_operators
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.audit_stmt_delete();

-- ── 3. The seed: the original Space's owner, once, with its INSERT audit row. ─────────────────────
DO $$
DECLARE
  v_n bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.1.5-platformoperators-001') THEN
    INSERT INTO public.platform_operators (clerk_user_id, added_by)
    SELECT s.created_by, 'migration:v5-platformoperators-001'
      FROM public.spaces s
     WHERE s.id = '00000000-0000-0000-0000-000000000001';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'v5-platformoperators-001 0a refused, nothing changed: the seed wrote % row(s), expected exactly 1.', v_n;
    END IF;
  END IF;
END $$;

-- ── 4. The stamp. Same transaction as the DDL: "applied" and "armed" are one event. ───────────────
INSERT INTO public.schema_version (version, description)
VALUES ('5.1.5-platformoperators-001',
        'PLATFORMOPERATORS: V5-SPACEISOLATION-001 (multi-space Phase 1 1.16). New public.platform_operators '
        '(id uuid PK, clerk_user_id text UNIQUE with a user_ shape CHECK, added_by, created_at), no deleted_at '
        '(removal is an audited hard DELETE); audit triggers trg_audit_platform_operators_ins (audit_stmt_insert), '
        '_upd (audit_stmt_update_no_soft_delete: clerk_user_id, added_by), _del (audit_stmt_delete); '
        'platform_operators_identity_guard (BEFORE UPDATE OF id, clerk_user_id -> '
        'guard_platform_operators_identity); seeded with the original Space''s owner (added_by '
        'migration:v5-platformoperators-001). No reader until Phase 4 step 4.7.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
