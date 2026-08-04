-- 0a-widen-check.sql
-- V4-HARVBASIS-SAMPLE-001 PHASE 1 of 2 — widen chk_harvest_log_weight_basis to admit
-- 'cultivar_sample'. NO WRITER CHANGE. Nothing emits the new value after this file runs.
--
-- ORDERING — READ THIS BEFORE MOVING ANY STATEMENT
-- The governing incident (2026-08-03, 23514 on every prod harvest save) was a NARROWING: a CHECK
-- was armed over a column ahead of the deployed writer, so the still-live writer emitted a value
-- the constraint rejected. The rule drawn from it — "adding a column is backward-compatible;
-- validating a CHECK over it is a DEPLOY, not a migration" — is a rule about NARROWING.
--
-- This change is a WIDENING, and the safe order is therefore INVERTED relative to that incident:
--
--   widen the constraint FIRST (0a, this file)  ->  then the writer (0b-resolver-v4.sql)
--
-- The invariant to preserve at every instant, in both directions, is:
--       { values the constraint ACCEPTS }  is a superset of  { values the live writer EMITS }
--   after 0a alone:  {measured,cultivar,crop_type,cultivar_sample} ⊇ {measured,cultivar,crop_type}  OK
--   after 0a + 0b:   {measured,cultivar,crop_type,cultivar_sample} ⊇ {…,cultivar_sample}            OK
--   0b WITHOUT 0a:   {measured,cultivar,crop_type} ⊉ {…,cultivar_sample}   -> 23514 on every save
--                    resolving through tier 3 or tier 5. This is the forbidden ordering.
--
-- NOT VALID IS NOT A SAFETY VALVE HERE — COMMON MISREADING. NOT VALID only skips the scan of
-- EXISTING rows; it does NOT make the constraint permissive for new INSERT/UPDATE, which are
-- checked immediately either way. So deferring VALIDATE buys nothing for a widening, and for a
-- widening VALIDATE can never fail: the new predicate is strictly weaker than the old one, so every
-- row that satisfied the old list satisfies the new list by construction. We validate inline.
--
-- WHY DROP+ADD RATHER THAN A SECOND CONSTRAINT. Constraints AND together, so leaving the 3-value
-- constraint in place and adding a 4-value one still rejects 'cultivar_sample'. The narrow one must
-- go. ALTER TABLE ... DROP CONSTRAINT takes ACCESS EXCLUSIVE and holds it to COMMIT, so wrapping
-- DROP+ADD+VALIDATE in ONE transaction leaves no window in which a concurrent Lambda write can
-- observe an unprotected table — concurrent writers block on the lock and then run against the
-- committed 4-value constraint. Do not split this into separate transactions.
--
-- SAFETY: constraint definition only. No row, column, function, view or index is touched.
-- Re-runnable. Stopping here permanently is a consistent, supported end state (see README-BUILD.md).

\set ON_ERROR_STOP on

BEGIN;

-- Do not let the ACCESS EXCLUSIVE request sit behind a long-running reader while every harvest save
-- queues behind it. Fail fast and retry instead of stalling the write path for the Lambda timeout.
SET LOCAL lock_timeout = '3s';

-- Guard: this file assumes the pre-state it was written against. If the constraint is already the
-- 4-value form the whole transaction is a no-op (re-run); if it is some THIRD shape, stop rather
-- than clobber it.
DO $$
DECLARE
  def text;
BEGIN
  SELECT pg_get_constraintdef(con.oid) INTO def
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid AND rel.relkind = 'r'
   WHERE rel.relname = 'harvest_log' AND con.conname = 'chk_harvest_log_weight_basis';

  IF def IS NULL THEN
    RAISE EXCEPTION 'chk_harvest_log_weight_basis not found on TABLE public.harvest_log — refusing to guess. (harvest_log is a base table; there are no views over it.)';
  END IF;

  IF def LIKE '%cultivar_sample%' THEN
    RAISE NOTICE 'chk_harvest_log_weight_basis already admits cultivar_sample — 0a is a no-op.';
  ELSIF def NOT LIKE '%crop_type%' OR def NOT LIKE '%measured%' OR def NOT LIKE '%cultivar%' THEN
    RAISE EXCEPTION 'chk_harvest_log_weight_basis has an unexpected definition: %', def;
  END IF;
END $$;

ALTER TABLE public.harvest_log
  DROP CONSTRAINT IF EXISTS chk_harvest_log_weight_basis;

ALTER TABLE public.harvest_log
  ADD CONSTRAINT chk_harvest_log_weight_basis
  CHECK (weight_basis IS NULL
         OR weight_basis IN ('measured','cultivar','crop_type','cultivar_sample'));

COMMENT ON CONSTRAINT chk_harvest_log_weight_basis ON public.harvest_log IS
  'weight_basis vocabulary. measured = user-supplied grams or a weight-unit quantity. '
  'cultivar_sample = derived from Dave''s own weighings via cultivar_weight_derived (resolver '
  'tiers 3 and 5). cultivar = the CURATED plant_varieties.unit_weights reference (tier 4). '
  'crop_type = crop-level average (tier 6). NOTE: rows written before v4-harvbasis-sample-001 '
  'carry ''cultivar'' for ALL of tiers 3/4/5 and were deliberately NOT backfilled — the original '
  'tier is not recorded anywhere and cannot be recovered, only re-guessed from today''s sample '
  'set. Treat pre-2026-08 ''cultivar'' as "catalogue OR legacy sample", not as "catalogue".';

-- Adding a value to a CHECK list can never invalidate an existing row, so this scan is a formality.
-- It is here so the constraint does not linger in the NOT VALID state that ADD would otherwise
-- leave if someone later converts this file to the two-step pattern. ~360 rows: microseconds.
ALTER TABLE public.harvest_log
  VALIDATE CONSTRAINT chk_harvest_log_weight_basis;

INSERT INTO public.schema_version (version, description)
VALUES ('4.20.7-harvbasis-sample-001-widen',
  'V4-HARVBASIS-SAMPLE-001 phase 1/2: widen chk_harvest_log_weight_basis from '
  '(measured|cultivar|crop_type) to admit cultivar_sample, so a sample-backed harvest weight is '
  'distinguishable from a catalogue-backed one. WIDENING ONLY — no writer emits the new value yet; '
  'resolve_harvest_weight stays at v3 until phase 2 (0b-resolver-v4.sql). This ordering is the '
  'inverse of the 2026-08-03 narrowing incident: a widened constraint is backward-compatible with '
  'the deployed writer, so constraint-first is the safe direction here. Single transaction, '
  'DROP+ADD+VALIDATE under one ACCESS EXCLUSIVE lock, no row touched, indefinitely parkable.')
ON CONFLICT DO NOTHING;

COMMIT;
