-- V5-PRESERVUNIT-001 — 0r1: rollback of phase A (0a).
--
-- Drops chk_preservation_log_quantity_unit entirely, returning the column to the unconstrained
-- free-text state BUG-PRESERVUNITNOCHECK-001 describes. Removing a CHECK is a WIDENING to the
-- unbounded set, so it cannot break any writer — this rollback is safe at any moment, which is the
-- opposite of 0b's risk profile and is why it needs no deploy coordination.
--
-- ⚠ RUN 0r2 FIRST IF PHASE B IS APPLIED. This file removes the constraint that
-- '5.0.0-preservunit-20260904-narrow' asserts the shape of; running it alone leaves that
-- schema_version row claiming a canonical-12 vocabulary that no longer exists anywhere, and the
-- phase-B post gates would then be self-armed against a dropped constraint and go red on both live
-- databases. The check is one query — it is the first line of Verify below.
--
-- NOT DESTRUCTIVE TO DATA. No row is read or written here; only the catalog changes.
--
-- REHEARSED BEFORE THE REAL APPLY, per the house sequence: staging apply -> gates -> rehearse
-- rollback -> re-apply -> deploy-staging -> prod apply -> gates.

BEGIN;

ALTER TABLE public.preservation_log
  DROP CONSTRAINT IF EXISTS chk_preservation_log_quantity_unit;

DELETE FROM public.schema_version WHERE version = '5.0.0-preservunit-20260904';

COMMIT;

-- Verify:
--   SELECT 1 FROM public.schema_version
--    WHERE version='5.0.0-preservunit-20260904-narrow';           -- MUST be 0 rows before running
--   SELECT count(*) FROM pg_constraint c
--     JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
--    WHERE n.nspname='public' AND t.relname='preservation_log'
--      AND c.conname='chk_preservation_log_quantity_unit';        -- expect 0
--   SELECT count(*) FROM public.schema_version
--    WHERE version='5.0.0-preservunit-20260904';                  -- expect 0
