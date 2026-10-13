-- 0r-rollback.sql: BUG-NEWLOTNOIDEMPOTENCYKEY-001 rollback. Drops uq_inventory_items_idempotency_key
--   and inventory_items.idempotency_key and removes stamp 5.0.0-newlotnoidempotencykey-001. Touches
--   nothing else.
--
-- IN THE REPO: nothing has to move first. Every gate in this directory's gates.yml is catalog-only and
--   self-armed on the stamp this file deletes; with the column gone they return to vacuous.
--
-- CODE BACK BEFORE SCHEMA BACK. This is a clean undo ONLY WHILE NO CODE ON DEV NAMES THE COLUMN. The
--   server half of this fix names idempotency_key in the create's INSERT and in its replay read: with
--   the column gone both are a 42703 and no inventory item can be created. The holding state "leave
--   the column" starts when that handler is ON DEV, not when it is live, because the promote's prod
--   schema gate reads dev's handlers against prod. The column is inert to code that does not name it.
--
-- THE PUBLIC SITE. gam-site's export gate reads the live columns of inventory_items and fails on a
--   column its manifest names that the table no longer has. If public-export.yaml has since listed
--   idempotency_key (under excluded:), take it out there and publish that BEFORE running this file.
--
-- NO REFUSAL GUARD, AND WHY. The sibling rollbacks refuse while they would lose something a person
--   typed. A key is not that: it is a random uuid the phone made, it names nothing, and the client
--   lets go of it ten minutes after its create last went out. It falls under the Soft-Delete-Only
--   Rule's carve-out by name ("idempotency keys"). What dropping it costs is replay protection for a
--   create that is still being retried, which the first paragraph above already rules out: by the
--   time this file may run, no deployed code reads a key. The file says how many keys it dropped.
--   A re-run after a successful rollback finds no column and no stamp and is a no-op.
--
-- Also used by the staging rehearsal (README.md): 0a -> post -> THIS -> pre -> 0a -> post.
--
-- No view reads the column (0a header), so DROP COLUMN needs no CASCADE; if a later view has started
--   to, the DROP stops instead of taking the view with it. The index is NOT dropped by name: it is on
--   this column alone and goes with it, and a DROP INDEX by name would also drop a same-named index
--   on some other table.
--
-- LOCKS: ACCESS EXCLUSIVE on inventory_items, to COMMIT. A catalog change; the table is not rewritten.
--
-- REHEARSED 2026-10-13 on a throwaway local PostgreSQL 17.10 (rehearse_local.py; README.md "What was
--   rehearsed, and where"). Not run on staging or prod.
--
-- Usage: psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. Say what is about to go. ──────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_keys bigint := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'inventory_items'
                AND column_name = 'idempotency_key') THEN
    -- EXECUTE, so a database where the column is already gone never parses a query that names it.
    EXECUTE 'SELECT count(*) FROM public.inventory_items WHERE idempotency_key IS NOT NULL'
       INTO v_keys;
    RAISE NOTICE 'v5-newlotnoidempotencykey-001 0r: dropping inventory_items.idempotency_key; % row(s) had a key.', v_keys;
  END IF;
END $$;

-- ── 1. The column. Its index goes with it. ───────────────────────────────────────────────────────
ALTER TABLE public.inventory_items
  DROP COLUMN IF EXISTS idempotency_key;

-- ── 2. The stamp. ────────────────────────────────────────────────────────────────────────────────
DELETE FROM public.schema_version WHERE version = '5.0.0-newlotnoidempotencykey-001';

COMMIT;
