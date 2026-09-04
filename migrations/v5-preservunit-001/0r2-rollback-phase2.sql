-- V5-PRESERVUNIT-001 — 0r2: rollback of phase B (0b). Run this BEFORE 0r1.
--
-- ⚠ THE DATA NORMALISATION IS NOT REVERSIBLE, AND THIS FILE DOES NOT PRETEND OTHERWISE.
-- 0b's UPDATE is lossy by construction: after R1 has shipped, a row spelling 'qt' may have been
-- rewritten from 'quarts' by 0b OR written natively by the new bundle, and nothing on the row
-- distinguishes the two. Re-pluralising would corrupt the second population to "restore" the first.
-- So this rollback restores the CONSTRAINT state and leaves the DATA canonical.
--
-- THAT IS A COMPLETE ROLLBACK, not a partial one, and the reason is the direction of the change:
-- re-widening the CHECK back to phase A's 22-value union makes the canonical rows still valid (the
-- union is a superset of the canonical 12) AND makes the legacy plurals writable again, which is the
-- only thing a stale bundle needs. The state after this file is byte-identical to the state after 0a
-- except that some rows are spelled better than they were. Nothing downstream reads the plural
-- spelling as a signal — PutUpUseSoonBand.jsx:44 and PutUpFromPlanting.jsx:172 interpolate whatever
-- string is stored, and lambda/daily-plan/ledger.js:89 already accepts both 'quart…' and 'qt'.
--
-- WHEN THIS IS THE RIGHT MOVE: R1 turned out to be broken or had to be reverted, and a bundle that
-- emits plurals is live again. Re-widening un-breaks every save immediately. Re-apply 0b once R1 is
-- back.
--
-- The union below is a verbatim copy of 0a's. It must stay that way: if 0a's list ever changes, this
-- one changes with it, or a rollback lands on a vocabulary no phase of this migration ever declared.
-- post_a_check_admits_every_live_writer_spelling in gates.yml re-asserts the union after this file
-- runs, so a divergence is caught rather than discovered later.

BEGIN;

ALTER TABLE public.preservation_log DROP CONSTRAINT IF EXISTS chk_preservation_log_quantity_unit;
ALTER TABLE public.preservation_log
  ADD CONSTRAINT chk_preservation_log_quantity_unit
  CHECK (quantity_unit IN (
    -- CANONICAL (12)
    'lb','oz','count',
    'cup','pint','qt',
    'bushel','half-bushel','peck','flat',
    'jar','bag',
    -- LEGACY (10) — re-admitted, because a stale bundle emits them
    'lbs','cups','pints','quarts',
    'bushels','half-bushels','pecks','flats',
    'jars','bags'
  ));

DELETE FROM public.schema_version WHERE version = '5.0.0-preservunit-20260904-narrow';

COMMIT;

-- Verify:
--   SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
--     JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
--    WHERE n.nspname='public' AND t.relname='preservation_log'
--      AND c.conname='chk_preservation_log_quantity_unit';   -- expect 22 values incl. the plurals
--   SELECT count(*) FROM public.schema_version
--    WHERE version='5.0.0-preservunit-20260904-narrow';      -- expect 0
--   SELECT count(*) FROM public.schema_version
--    WHERE version='5.0.0-preservunit-20260904';             -- expect 1 (phase A still applied)
