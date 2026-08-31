-- 0r-rollback.sql — V4-PUTUPSESSION-001 slice 1 rollback.
--
-- THE DROP IS LIVE IN THIS FILE, AND THAT IS A DEPARTURE FROM v4-putupprov-001/0r. Read why before
-- running it, and read the window condition below before running it a second time.
--
-- v4-putupprov-001 left its columns in place because dropping them destroyed recorded provenance —
-- "Warner Farms", "u_pick / Clarkdale" — text nothing could reconstruct. This column is different in
-- kind: it holds one bit, and that bit is re-derivable for exactly as long as the walk rows are
-- recent enough for Dave to say "those were the freezer-walk ones". It is still USER-AUTHORED (it
-- records an answer he gave), so it is not free to destroy — but it is not the irreplaceable text
-- that made the provenance columns undroppable.
--
-- SO THE WINDOW MATTERS, and the guard below is not decoration:
--   BEFORE the feature has been used once — SELECT count(*) FROM preservation_log
--   WHERE preserved_at_approx IS NOT NULL  -> 0 — this file is lossless and is the honest rollback.
--   AFTER it is non-zero, dropping the column is DELIBERATE DATA LOSS and a Dave-gated decision,
--   not a cleanup step. Prefer a CODE rollback: the column is nullable with no default and no
--   constraint, so an older Lambda simply never mentions it and an older frontend never renders it.
--   Leaving it in place is completely inert.
--
-- The DO block enforces that distinction rather than trusting the operator to have read this header,
-- because a rollback is run under exactly the conditions where headers do not get read.
--
-- ALSO USED BY the gates.yml step-2 rehearsal: run 0r on staging, re-apply 0a, re-run post gates.
-- That is what makes the rollback tested rather than asserted — and on staging, immediately after
-- the apply, the window condition holds, so the rehearsal exercises the real path.
--
-- REMEMBER THE SIBLING GATE. v4-putupprov-001/gates.yml is re-pinned to 24 columns by this change.
-- Rolling this migration back on an environment takes it back to 23 and that gate will red there
-- until the code is rolled back too. That is the pair working as designed; do not "fix" it by
-- loosening the gate.

BEGIN;

DO $$
DECLARE
  v_used bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='preservation_log'
                AND column_name='preserved_at_approx') THEN
    EXECUTE 'SELECT count(*) FROM public.preservation_log WHERE preserved_at_approx IS NOT NULL'
      INTO v_used;
    IF v_used > 0 THEN
      RAISE EXCEPTION 'REFUSING TO DROP preserved_at_approx: % row(s) carry a recorded value. This is user-authored data (an answer Dave gave in the freezer walk), so dropping it is a deliberate loss and a Dave-gated decision — not a rollback step. Roll the CODE back instead; the column is inert to an older deploy. To proceed anyway, drop the column by hand.', v_used;
    END IF;
    ALTER TABLE public.preservation_log DROP COLUMN preserved_at_approx;
  END IF;
END $$;

DELETE FROM public.schema_version WHERE version = '4.88.0-putupsession-001';

COMMIT;
