-- 0r-rollback.sql
-- BUG-INVREFSTRAND-001 (option C) — disarm the standing inventory-reference guard.
--
-- 0a wrote exactly one row and touched no data, so the rollback is exactly one delete. Removing the
-- receipt makes every self-armed gate in gates.yml vacuously true again (their
-- `EXISTS (SELECT 1 FROM schema_version WHERE version = ...)` clause stops matching), which returns
-- gate-invariants.yml to green without weakening or deleting any assertion.
--
-- WHAT THIS DOES NOT UNDO, and must not: any strand you RESOLVED while the guard was armed. A restored
-- deleted_at or a re-pointed reference is a data decision recorded in the row itself, not an artifact
-- of this migration, and reversing it here would silently discard a judgement.
--
-- WHAT THIS DOES NOT DISARM: the pre-delete reference check in
-- lambda/inventory-items/delete-guard.js. That is application code and is unaffected by the receipt
-- either way — disarming the detector does not re-open the app-side path that creates strands.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

DELETE FROM public.schema_version WHERE version = '5.0.0-invrefstrand-20260924';

COMMIT;
