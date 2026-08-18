-- 0a-additive-ddl.sql
-- OPS-VARAUDIT-001 — harden the live audit trigger on public.plant_varieties.
--
--   psql "$URL" -X -v ON_ERROR_STOP=1 -f migrations/v4-varaudit-001/0a-additive-ddl.sql
--
-- PHASE 0a IS INERT. It creates three functions and attaches NOTHING. trg_audit_plant_varieties is
-- still the only audit writer on the table after this file runs, still row-level, still without a
-- handler. The swap is 0b, deliberately separate — see README.md §Deploy order.
--
-- ── WHAT IS BEING HARDENED ───────────────────────────────────────────────────────────────────────
-- trg_audit_plant_varieties has been live since 2026-05-11 and has written all 1,872 rows in
-- public.audit_events. Its function, verbatim from pg_get_functiondef on prod:
--
--   CREATE TRIGGER trg_audit_plant_varieties AFTER INSERT OR DELETE OR UPDATE
--     ON public.plant_varieties FOR EACH ROW EXECUTE FUNCTION audit_plant_varieties_trigger()
--
--   DECLARE actor TEXT := COALESCE(current_setting('app.actor_clerk_sub', true), 'system');
--   ... INSERT INTO public.audit_events (...) VALUES ('plant_varieties', NEW.id, 'INSERT', ...)
--
-- Five weaknesses, each confirmed on prod rather than inferred:
--
--   (1) NO EXCEPTION HANDLER. The audit INSERT is bare, so any failure aborts the user's
--       plant_varieties write. audit_events.actor_clerk_sub is NOT NULL with no default and
--       audit_events_action_check constrains `action`, so this is a shaped failure surface rather
--       than an abstract one. Today the actor path is in fact safe — the bare COALESCE always
--       yields a non-NULL string — but the function is SECURITY INVOKER (weakness 2), so the live
--       failure mode is a privilege one: any role that can write plant_varieties but cannot INSERT
--       into audit_events fails the user's write outright. Only neondb_owner holds INSERT today.
--
--   (2) SECURITY INVOKER WITH NO PINNED search_path. Combined with the handler added here, a
--       missing grant would degrade from a loud failure into a swallowed WARNING — a silent audit
--       gap. SECURITY DEFINER removes the failure mode; the pinned search_path is what makes
--       SECURITY DEFINER safe.
--
--   (3) ROW-LEVEL. Prod has taken single UPDATE statements of 338 and 326 rows (the
--       4.1.1-planttype-seed-001 and 4.18.0-cal1-refweight-001 backfills, matched to the
--       schema_version applied_at to the microsecond). Row-level costs 338 invocations for one
--       statement. That is tolerable TODAY only because there is no handler: adding an exception
--       block to a row-level trigger opens one SUBTRANSACTION PER ROW, and a subtransaction is not
--       free — it consumes an XID slot and, past 64 per transaction, spills the subxid cache and
--       forces every concurrent snapshot check to hit pg_subtrans. So the handler and the move to
--       statement level are not two independent improvements: the handler is what makes row-level
--       expensive, and statement level is what makes the handler free.
--
--   (4) BARE COALESCE ON THE ACTOR. current_setting(x, true) returns NULL when the GUC was never
--       set but '' when it was set to the empty string, and only the first is caught by a bare
--       COALESCE. An empty actor satisfies NOT NULL and says nothing forensically. Hardened to
--       COALESCE(NULLIF(..., ''), 'system').
--
--   (5) table_name HARDCODED as the literal 'plant_varieties'. Replaced with TG_TABLE_NAME, which
--       cannot drift from the table the trigger is actually attached to.
--
-- ── WHAT IS DELIBERATELY *NOT* CHANGED: THE RECORDED TRAIL ────────────────────────────────────────
-- The sibling lane OPS-HARVESTAUDIT-001 scopes its UPDATE arm to a watched column list, because 96%
-- of event_log updates were one backfill of `source`, a column that is part of no total. That
-- finding does NOT transfer here, and it was measured rather than assumed. Diffing before_jsonb
-- against after_jsonb across all 1,427 UPDATE audit rows on prod:
--
--     real column change              1386   97.1%
--     ONLY updated_at                   40    2.8%
--     NO COLUMN CHANGED (no-op)          1    0.1%
--
-- The bulk bursts on THIS table wrote unit_weights / weight_source / weight_confidence (the CAL-1
-- reference weights that harvest totals are computed from) and crop_type_slug / lifecycle /
-- growth_habit / species (the variety taxonomy). Column scoping would suppress 41 rows out of 1,872
-- — 2.9% — in exchange for a permanent discontinuity in a trail running since 2026-05-11 and an
-- allowlist whose vacuity mode needs its own completeness gate. The burden of proof for changing an
-- in-use trail is not met, so this migration changes HOW the audit is written and never WHAT.
--
-- Same actions, same payloads, same INSERT arm. What changes is that it can no longer take the
-- user's write down with it.
--
-- ── FUNCTION NAMING: WHY NOT REUSE THE SIBLING LANE'S ────────────────────────────────────────────
-- OPS-HARVESTAUDIT-001 defines public.audit_stmt_delete() and public.audit_stmt_update(). Reusing
-- those names here would be a live collision: both bundles use CREATE OR REPLACE, so whichever
-- applied second would silently rewrite the other lane's trigger bodies, and their audit_stmt_update
-- is column-scoped via TG_ARGV — the exact behaviour this lane measured its way out of. The
-- audit_pv_* prefix keeps the two independent and applyable in either order.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- audit_pv_stmt_insert — one audit row per inserted row, from the NEW transition table.
--
-- Kept because 426 existing audit rows depend on it and because on a 425-row catalog table the
-- INSERT row IS the provenance record of a cultivar definition. See README §The INSERT arm stays.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.audit_pv_stmt_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  BEGIN
    INSERT INTO public.audit_events
           (table_name, row_id, action, actor_clerk_sub, before_jsonb, after_jsonb)
    SELECT TG_TABLE_NAME,
           n.id,
           'INSERT',
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
      RAISE WARNING 'audit_pv_stmt_insert(%): audit write FAILED, SQLSTATE=% (%). The originating INSERT is unaffected.',
        TG_TABLE_NAME, SQLSTATE, SQLERRM;
  END;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.audit_pv_stmt_insert() IS
  'OPS-VARAUDIT-001. AFTER INSERT FOR EACH STATEMENT audit writer for plant_varieties. Requires '
  'REFERENCING NEW TABLE AS new_rows. Cannot abort the originating statement.';

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- audit_pv_stmt_update — SOFT_DELETE / RESTORE / UPDATE, from the OLD+NEW transition tables.
--
-- The deleted_at delta classifies the action exactly as the live function does. There is NO
-- WHERE clause: every row of every UPDATE statement is recorded, which is today's behaviour and is
-- the behaviour §2 of the report measured its way to keeping.
--
-- Rows are joined on id. plant_varieties has a uuid primary key named id and no write path rewrites
-- it (the app writes through the auto-updatable `cultivar` view, which does not even expose an
-- updatable id path that changes it). gates.yml pins that id is the primary key, because the join
-- is what would silently drop rows if it ever stopped being unique.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.audit_pv_stmt_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  BEGIN
    INSERT INTO public.audit_events
           (table_name, row_id, action, actor_clerk_sub, before_jsonb, after_jsonb)
    SELECT TG_TABLE_NAME,
           n.id,
           CASE
             WHEN o.deleted_at IS NULL     AND n.deleted_at IS NOT NULL THEN 'SOFT_DELETE'
             WHEN o.deleted_at IS NOT NULL AND n.deleted_at IS NULL     THEN 'RESTORE'
             ELSE 'UPDATE'
           END,
           COALESCE(NULLIF(current_setting('app.actor_clerk_sub', true), ''), 'system'),
           to_jsonb(o),
           to_jsonb(n)
      FROM new_rows n
      JOIN old_rows o ON o.id = n.id;
  EXCEPTION
    WHEN query_canceled OR admin_shutdown THEN
      RAISE;
    WHEN OTHERS THEN
      RAISE WARNING 'audit_pv_stmt_update(%): audit write FAILED, SQLSTATE=% (%). The originating UPDATE is unaffected.',
        TG_TABLE_NAME, SQLSTATE, SQLERRM;
  END;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.audit_pv_stmt_update() IS
  'OPS-VARAUDIT-001. AFTER UPDATE FOR EACH STATEMENT audit writer for plant_varieties. Requires '
  'REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows. Records EVERY updated row — no column '
  'scoping, matching the behaviour live since 2026-05-11. Cannot abort the originating statement.';

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- audit_pv_stmt_delete — one audit row per hard-deleted row, from the OLD transition table.
--
-- Hard deletes are rare here (exactly one on prod, 2026-06-26) because entity.cultivar_ref_id is a
-- FOREIGN KEY ... ON DELETE RESTRICT against plant_varieties(id), so a cultivar with a live entity
-- row cannot be deleted at all. Rare is not never, and the DELETE pre-image is the only record that
-- a variety ever existed.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.audit_pv_stmt_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  BEGIN
    INSERT INTO public.audit_events
           (table_name, row_id, action, actor_clerk_sub, before_jsonb, after_jsonb)
    SELECT TG_TABLE_NAME,
           o.id,
           'DELETE',
           COALESCE(NULLIF(current_setting('app.actor_clerk_sub', true), ''), 'system'),
           to_jsonb(o),
           NULL
      FROM old_rows o;
  EXCEPTION
    WHEN query_canceled OR admin_shutdown THEN
      RAISE;
    WHEN OTHERS THEN
      RAISE WARNING 'audit_pv_stmt_delete(%): audit write FAILED, SQLSTATE=% (%). The originating DELETE is unaffected.',
        TG_TABLE_NAME, SQLSTATE, SQLERRM;
  END;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.audit_pv_stmt_delete() IS
  'OPS-VARAUDIT-001. AFTER DELETE FOR EACH STATEMENT audit writer for plant_varieties. Requires '
  'REFERENCING OLD TABLE AS old_rows. Cannot abort the originating statement.';

INSERT INTO public.schema_version (version, description)
VALUES ('4.38.0-varaudit-001-fn',
        'OPS-VARAUDIT-001 0a: hardened audit trigger FUNCTIONS for plant_varieties. Inert — trg_audit_plant_varieties is still the live writer.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
