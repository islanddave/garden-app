-- V5-KBOWNERTRIGGER-001 — ROLLBACK. Returns kitchen_batch's trigger set to its V5-INFLIGHTBATCH-001
-- shape.
--
-- ⚠ THIS ROLLBACK RESTORES A KNOWN DEFECT. It is not a neutral undo. Re-attaching
-- prevent_ownership_transfer to kitchen_batch re-creates BUG-KBOWNERTRIGGER-001 in full: the function
-- names OLD.created_by, kitchen_batch has no such column, and EVERY UPDATE to the table starts
-- raising 42703 again — including the two LIVE routes (the SetStartDate PUT and the CaptureFlow Undo
-- soft delete). Run this only to restore the exact pre-apply state, and only alongside rolling the
-- Lambda back too.
--
-- NO DATA IS LOST EITHER WAY. This file and its forward half touch triggers and one function; no
-- column, constraint, index or row is created or destroyed by either direction.
--
-- Idempotent on both statements so a partially-applied forward run can be cleaned up: IF EXISTS on
-- the drops, and the CREATE TRIGGER is guarded by the drop above it.

BEGIN;

DROP TRIGGER IF EXISTS prevent_kitchen_batch_ownership_transfer ON public.kitchen_batch;
DROP FUNCTION IF EXISTS public.prevent_kitchen_batch_ownership_transfer();

-- The broken binding, restored verbatim from v5-inflightbatch-001/0a-additive-ddl.sql:183-184.
DROP TRIGGER IF EXISTS prevent_ownership_transfer ON public.kitchen_batch;
CREATE TRIGGER prevent_ownership_transfer BEFORE UPDATE ON public.kitchen_batch
  FOR EACH ROW EXECUTE FUNCTION public.prevent_ownership_transfer();

DELETE FROM public.schema_version WHERE version = '5.0.0-kbownertrigger-20260904';

COMMIT;

-- Verify:
--   SELECT tgname FROM pg_trigger
--    WHERE tgrelid = 'public.kitchen_batch'::regclass AND NOT tgisinternal ORDER BY tgname;
--   -- expect: prevent_ownership_transfer, set_updated_at
--   SELECT count(*) FROM public.schema_version WHERE version = '5.0.0-kbownertrigger-20260904';
--   -- expect: 0
