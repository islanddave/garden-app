-- 0b-verify-triggers.sql
-- BUG-NOPLANTINGAUDIT-001 — the BEHAVIOURAL half. Requires 0a to have been applied.
--
--   psql "$URL" -X -v ON_ERROR_STOP=1 -f migrations/v4-plantingaudit-001/0b-verify-triggers.sql
--
-- Safe on prod: it creates one fixture planting, exercises four cases against it, and ROLLBACKs.
-- Nothing here is durable, and this file contains NO COMMIT — see the warning below for why that
-- is load-bearing rather than incidental.
--
-- ⚠️ DO NOT REHEARSE 0a BY WRAPPING IT. `BEGIN; \i 0a-arm-triggers.sql; …; ROLLBACK;` APPLIES THE
--    MIGRATION FOR REAL. Postgres has no nested transactions, so 0a's own COMMIT ends the outer
--    transaction and everything to that point is durable; the trailing ROLLBACK then only discards
--    whatever a fresh implicit transaction did afterwards. Done exactly that on prod on 2026-08-26
--    while building this migration: the fixture rows disappeared (making the rehearsal LOOK like it
--    had rolled back) while the two triggers and the schema_version row stayed. It was caught only
--    by re-querying pg_trigger and schema_version afterwards, and undone with 0r-rollback.sql; no
--    real audit rows had been written in the window. To rehearse the DDL, use an ephemeral Neon
--    branch, or inline 0a's two CREATE TRIGGERs without its BEGIN/COMMIT. And whatever you do,
--    verify the post-state with a fresh query — a printed `ROLLBACK` is not evidence.
--
-- WHY A FIXTURE AND NOT A READ-ONLY CHECK. gates.yml proves the triggers EXIST and are correctly
-- SHAPED — statement-level, with transition tables, pointing at the right functions. None of that
-- can prove they CAPTURE: a gutted function body, a watched set that matched nothing, or a
-- swallowed exception would leave every gate in that file green. Only a write proves a write.
BEGIN;

-- The actor the trigger records. `true` = transaction-local, so it evaporates with the ROLLBACK.
SELECT set_config('app.actor_clerk_sub', 'verify_0b_actor', true);

-- Data-modifying CTE, not `RETURNING … INTO`: that form is PL/pgSQL-only and this is plain SQL.
CREATE TEMP TABLE _v (id uuid) ON COMMIT DROP;
WITH ins AS (
  INSERT INTO public.plants (name, created_by, sown_at)
  VALUES ('ZZ_VERIFY_0B_DO_NOT_KEEP', 'verify_0b_actor', DATE '2026-05-03')
  RETURNING id
)
INSERT INTO _v (id) SELECT id FROM ins;

DO $$
DECLARE
  v_id uuid := (SELECT id FROM _v);
  n    bigint;
  r    record;
BEGIN
  -- (1) INSERT writes NOTHING. There is no INSERT arm, deliberately (see 0a) — and if one were
  --     ever added by accident this is where the doubling would first show.
  SELECT count(*) INTO n FROM public.audit_events WHERE row_id = v_id;
  IF n <> 0 THEN RAISE EXCEPTION 'INSERT wrote % audit row(s), expected 0', n; END IF;

  -- (2) A WATCHED DATE CHANGE IS CAPTURED, with before, after and actor. This is BD-022's literal
  --     ask — "a planting's date edits cannot be reconstructed or attributed" — so it is asserted
  --     on the values, not merely on a rowcount.
  UPDATE public.plants SET sown_at = DATE '2026-05-10' WHERE id = v_id;
  SELECT count(*) INTO n FROM public.audit_events WHERE row_id = v_id;
  IF n <> 1 THEN RAISE EXCEPTION 'watched date change wrote % audit row(s), expected 1', n; END IF;
  SELECT action, before_jsonb->>'sown_at' AS b, after_jsonb->>'sown_at' AS a, actor_clerk_sub AS who
    INTO r FROM public.audit_events WHERE row_id = v_id;
  IF r.action <> 'UPDATE'          THEN RAISE EXCEPTION 'action was %, expected UPDATE', r.action; END IF;
  IF r.b <> '2026-05-03'           THEN RAISE EXCEPTION 'before_jsonb.sown_at was %, expected 2026-05-03', r.b; END IF;
  IF r.a <> '2026-05-10'           THEN RAISE EXCEPTION 'after_jsonb.sown_at was %, expected 2026-05-10', r.a; END IF;
  IF r.who <> 'verify_0b_actor'    THEN RAISE EXCEPTION 'actor was %, expected verify_0b_actor', r.who; END IF;

  -- (3) AN UNWATCHED-ONLY CHANGE IS NOT CAPTURED. This is the case that makes column-scoping mean
  --     something. Without it the audit becomes a full write log of a table the app touches
  --     constantly, and every other assertion here would still pass.
  UPDATE public.plants SET last_seen_at = now() WHERE id = v_id;
  SELECT count(*) INTO n FROM public.audit_events WHERE row_id = v_id;
  IF n <> 1 THEN RAISE EXCEPTION 'unwatched-only change took the count to %, expected it to stay 1', n; END IF;

  -- (4) A SOFT DELETE IS CAPTURED AS SOFT_DELETE, not as a plain UPDATE. plants soft-deletes, so
  --     this — not the DELETE arm — is the path a disappearing planting actually takes.
  UPDATE public.plants SET deleted_at = now() WHERE id = v_id;
  SELECT count(*) INTO n FROM public.audit_events WHERE row_id = v_id;
  IF n <> 2 THEN RAISE EXCEPTION 'soft delete took the count to %, expected 2', n; END IF;
  PERFORM 1 FROM public.audit_events WHERE row_id = v_id AND action = 'SOFT_DELETE';
  IF NOT FOUND THEN RAISE EXCEPTION 'no SOFT_DELETE row — the soft delete was recorded as a plain UPDATE'; END IF;

  RAISE NOTICE 'v4-plantingaudit-001 0b: all four behavioural checks PASSED';
END $$;

ROLLBACK;
