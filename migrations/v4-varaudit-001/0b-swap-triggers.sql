-- 0b-swap-triggers.sql
-- OPS-VARAUDIT-001 — replace the live row-level trigger with the three hardened statement-level
-- triggers. THIS is the phase that changes behaviour.
--
--   psql "$URL" -X -v ON_ERROR_STOP=1 -f migrations/v4-varaudit-001/0b-swap-triggers.sql
--
-- Requires 0a. CREATE TRIGGER against a function that does not exist fails, so the ordering is
-- enforced by Postgres and not only by the runbook.
--
-- ── WHY ONE TRIGGER BECOMES THREE ────────────────────────────────────────────────────────────────
-- Not a stylistic choice. Postgres refuses transition tables on a multi-event trigger — verified on
-- a real 17.10 cluster, verbatim:
--
--     ERROR:  transition tables cannot be specified for triggers with more than one event
--
-- The live trigger is AFTER INSERT OR DELETE OR UPDATE, and REFERENCING is what makes a
-- statement-level trigger able to see its rows at all. So covering the same three events at
-- statement level REQUIRES three triggers. The name trg_audit_plant_varieties therefore ceases to
-- exist; nothing in the repo depends on it (the four remaining mentions are all prose comments in
-- lambda/varieties/index.js, lambda/photos/photoDelete.js, lambda/photos/photoDelete.test.js and
-- migrations/v4-cultivarname-001/0c-verify-triggers.sql, and no gate references it), but those
-- comments do go stale — see README §What needs Dave.
--
-- ── ATOMICITY OF THE SWAP, AND WRITES IN FLIGHT ──────────────────────────────────────────────────
-- This is the question a migration that REPLACES a live audit writer has to answer: is there an
-- instant in which plant_varieties is written without being audited?
--
-- No. Lock levels, measured on a real 17.10 cluster rather than recalled:
--
--     DROP TRIGGER   -> AccessExclusiveLock   on public.plant_varieties
--     CREATE TRIGGER -> ShareRowExclusiveLock on public.plant_varieties
--
-- Postgres holds locks until COMMIT, so from the DROP to the COMMIT of this transaction the
-- migration holds ACCESS EXCLUSIVE. ACCESS EXCLUSIVE conflicts with ROW EXCLUSIVE (every
-- INSERT/UPDATE/DELETE) and with ACCESS SHARE (every SELECT). Therefore:
--
--   * A write that had already ACQUIRED its lock when this transaction started keeps it; the DROP
--     waits for that transaction to finish. That in-flight write completes under the OLD trigger and
--     is audited by it.
--   * A write that arrives after the DROP has the lock BLOCKS until this transaction commits, then
--     proceeds under the THREE NEW triggers and is audited by them.
--   * There is no third case. The window in which neither writer is attached is exactly the window
--     in which no other session can write the table at all. Coverage is continuous across the swap.
--
-- If this transaction ROLLS BACK for any reason, the DROP rolls back with it and the original
-- trigger is still attached, unchanged. DDL is transactional in Postgres; this is not a two-step
-- teardown-then-rebuild with an exposed middle.
--
-- ── THE REAL RISK IS NOT COVERAGE, IT IS THE LOCK QUEUE ──────────────────────────────────────────
-- ACCESS EXCLUSIVE queues behind any open transaction holding any lock on plant_varieties, and once
-- it is QUEUED every later statement — including plain SELECTs from the app — queues behind IT. A
-- migration that waits indefinitely for the lock does not corrupt anything; it stalls the varieties
-- surface for as long as it waits. SET LOCAL lock_timeout turns that into a fast, retryable failure
-- instead: the migration aborts, nothing changes, and the operator retries when the table is quiet.
-- 5s is generous for a table this size (425 rows) and short enough that a user notices nothing.
--
-- ── NO LAMBDA DEPLOY IS NEEDED ON EITHER SIDE OF THIS ────────────────────────────────────────────
--   * The output shape is unchanged: same table, same five action values, same before/after jsonb,
--     same actor semantics. Nothing that reads audit_events can tell the difference — and nothing
--     does; no Lambda and no SPA surface queries it.
--   * The actor GUC is already set by the deployed code. lambda/varieties/index.js issues
--     `SELECT set_config('app.actor_clerk_sub', ${userId}, true)` in the same transaction as each of
--     its four write paths, and lambda/projects, lambda/plants, lambda/photos and lambda/events do
--     the same. Where it is unset the actor degrades to 'system', exactly as the live trigger has
--     behaved since 2026-05-11.
--   * The app writes plant_varieties through the auto-updatable VIEW public.cultivar, never the base
--     table directly. Postgres rewrites a view write into a base-table statement before triggers are
--     considered, so base-table statement-level triggers fire with populated transition tables.
--     0c-verify-triggers.sql proves that on a real cluster rather than asserting it, because it is
--     the actual production write path and a wrong answer here would mean auditing nothing at all.

BEGIN;

-- Fail fast rather than stalling the varieties surface behind a queued ACCESS EXCLUSIVE lock.
-- On timeout: nothing has changed, re-run when the table is quiet.
SET LOCAL lock_timeout = '5s';

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- Out with the old. The FUNCTION audit_plant_varieties_trigger() is deliberately LEFT IN PLACE: it
-- is inert once nothing references it, and keeping it makes 0r-rollback.sql an exact restore of the
-- original object rather than a re-creation of it from a copy that could drift. post_old_row_level_
-- trigger_is_detached in gates.yml pins that it stays detached.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_audit_plant_varieties ON public.plant_varieties;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- In with the three. Same three events, same recorded actions, same payloads — statement-level, and
-- unable to abort the write they audit.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_audit_plant_varieties_ins ON public.plant_varieties;
CREATE TRIGGER trg_audit_plant_varieties_ins
  AFTER INSERT ON public.plant_varieties
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.audit_pv_stmt_insert();

DROP TRIGGER IF EXISTS trg_audit_plant_varieties_upd ON public.plant_varieties;
CREATE TRIGGER trg_audit_plant_varieties_upd
  AFTER UPDATE ON public.plant_varieties
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.audit_pv_stmt_update();

DROP TRIGGER IF EXISTS trg_audit_plant_varieties_del ON public.plant_varieties;
CREATE TRIGGER trg_audit_plant_varieties_del
  AFTER DELETE ON public.plant_varieties
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.audit_pv_stmt_delete();

INSERT INTO public.schema_version (version, description)
VALUES ('4.38.0-varaudit-001',
        'OPS-VARAUDIT-001 0b: trg_audit_plant_varieties replaced by three statement-level triggers with exception handlers. Recorded trail unchanged.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
