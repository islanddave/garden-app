-- 0c-verify-triggers.sql
-- OPS-HARVESTAUDIT-001 — prove the audit MECHANISM works, on whichever environment you run it on.
--
--   psql "$URL" -X -v ON_ERROR_STOP=1 -f migrations/v4-harvestaudit-001/0c-verify-triggers.sql
--
-- Run AFTER 0b. Shape borrowed from migrations/v4-cultivarname-001/0c-verify-triggers.sql: build a
-- throwaway fixture, exercise the trigger, assert, ROLL BACK. Nothing is left behind, so it is safe
-- on prod, and running it on prod is the honest way to confirm the behaviour there rather than
-- inferring it from staging.
--
-- WHY THE ROLLBACK IS SOUND. Every write is inside the transaction — the fixture event and harvest
-- rows, and the audit_events rows the new triggers write about them. All of it disappears. The only
-- externally visible effect is sequence consumption, and neither table uses a sequence (both ids are
-- uuid defaults).
--
-- WHY THIS FILE IS NOT A GATE. gates.yml can assert that the triggers EXIST and are correctly
-- shaped; it cannot assert that they CAPTURE, because a gate is a read-only SELECT. A gate corpus
-- that only checks pg_trigger would stay green against a trigger whose body was gutted. This file is
-- the behavioural half.

BEGIN;

DO $$
DECLARE
  v_actor   text := '__v4harvestaudit001_probe__';
  v_proj    uuid;
  v_e1      uuid;
  v_e2      uuid;
  v_e3      uuid;
  v_h1      uuid;
  v_n       integer;
  v_act     text;
  v_who     text;
  v_before  jsonb;
BEGIN
  PERFORM set_config('app.actor_clerk_sub', v_actor, true);

  ---------------------------------------------------------------------------
  -- Preconditions. Fail with a readable message rather than a bare 23502/23503
  -- if the environment cannot host the fixture or 0b has not been applied.
  ---------------------------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_audit_event_log_del') THEN
    RAISE EXCEPTION 'precondition: trg_audit_event_log_del is absent — apply 0b-arm-triggers.sql first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_audit_harvest_log_del') THEN
    RAISE EXCEPTION 'precondition: trg_audit_harvest_log_del is absent — apply 0b-arm-triggers.sql first';
  END IF;

  -- event_log_has_anchor requires plant_id OR project_id, and both FKs are ON DELETE RESTRICT, so the
  -- fixture borrows an existing container rather than constructing one.
  SELECT id INTO v_proj FROM public.plant_projects WHERE deleted_at IS NULL LIMIT 1;
  IF v_proj IS NULL THEN
    RAISE EXCEPTION 'precondition: no live plant_projects row to anchor the probe event to';
  END IF;

  ---------------------------------------------------------------------------
  -- A — a HARD DELETE is captured, with the complete pre-image.
  -- This is the defect OPS-HARVESTAUDIT-001 was filed for.
  ---------------------------------------------------------------------------
  INSERT INTO public.event_log (project_id, event_type, event_date, quantity_numeric, created_by, source)
       VALUES (v_proj, 'harvest', now(), 12.5, v_actor, 'direct')
    RETURNING id INTO v_e1;

  -- INSERT is deliberately not audited; assert that, so the decision is pinned rather than assumed.
  SELECT count(*) INTO v_n FROM public.audit_events WHERE row_id = v_e1;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'A0: INSERT wrote % audit row(s); the INSERT arm is not supposed to exist', v_n;
  END IF;

  DELETE FROM public.event_log WHERE id = v_e1;

  SELECT count(*), max(action), max(actor_clerk_sub), max(before_jsonb)
    INTO v_n, v_act, v_who, v_before
    FROM public.audit_events WHERE row_id = v_e1;

  IF v_n <> 1 THEN
    RAISE EXCEPTION 'A1: hard DELETE wrote % audit rows (expected exactly 1)', v_n;
  END IF;
  IF v_act <> 'DELETE' THEN
    RAISE EXCEPTION 'A2: action is % (expected DELETE)', v_act;
  END IF;
  IF v_who <> v_actor THEN
    RAISE EXCEPTION 'A3: actor_clerk_sub is % (expected %) — the app.actor_clerk_sub GUC was not read', v_who, v_actor;
  END IF;
  -- The pre-image must be the whole row, not a stub: this is what makes a deleted row
  -- reconstructable. quantity_numeric is the value a disputed crop total would turn on.
  IF (v_before ->> 'quantity_numeric')::numeric <> 12.5 THEN
    RAISE EXCEPTION 'A4: before_jsonb.quantity_numeric is % (expected 12.5)', v_before ->> 'quantity_numeric';
  END IF;
  IF (v_before ->> 'created_at') IS NULL THEN
    RAISE EXCEPTION 'A5: before_jsonb has no created_at — a deleted row cannot be placed in time';
  END IF;

  ---------------------------------------------------------------------------
  -- B — a MULTI-ROW delete is captured per row, from ONE statement.
  -- The hard-delete path in prod is archive_plant_events, which issues a single
  -- `DELETE FROM public.event_log e WHERE e.id = ANY(v_ids)`.
  ---------------------------------------------------------------------------
  INSERT INTO public.event_log (project_id, event_type, event_date, created_by)
       VALUES (v_proj, 'observation', now(), v_actor) RETURNING id INTO v_e2;
  INSERT INTO public.event_log (project_id, event_type, event_date, created_by)
       VALUES (v_proj, 'observation', now(), v_actor) RETURNING id INTO v_e3;

  DELETE FROM public.event_log WHERE id = ANY(ARRAY[v_e2, v_e3]);

  SELECT count(*) INTO v_n
    FROM public.audit_events WHERE row_id = ANY(ARRAY[v_e2, v_e3]) AND action = 'DELETE';
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'B1: two-row DELETE wrote % audit rows (expected 2) — transition table not per-row', v_n;
  END IF;

  ---------------------------------------------------------------------------
  -- C — SOFT_DELETE and RESTORE. This is the app's own delete path:
  -- lambda/events/index.js sets the actor GUC and issues
  -- `UPDATE event_log SET deleted_at = NOW() ...` in one transaction.
  ---------------------------------------------------------------------------
  INSERT INTO public.event_log (project_id, event_type, event_date, created_by)
       VALUES (v_proj, 'harvest', now(), v_actor) RETURNING id INTO v_e1;

  UPDATE public.event_log SET deleted_at = now() WHERE id = v_e1;
  SELECT count(*) INTO v_n FROM public.audit_events WHERE row_id = v_e1 AND action = 'SOFT_DELETE';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'C1: soft delete wrote % SOFT_DELETE rows (expected 1)', v_n;
  END IF;

  UPDATE public.event_log SET deleted_at = NULL WHERE id = v_e1;
  SELECT count(*) INTO v_n FROM public.audit_events WHERE row_id = v_e1 AND action = 'RESTORE';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'C2: restore wrote % RESTORE rows (expected 1)', v_n;
  END IF;

  ---------------------------------------------------------------------------
  -- D — the column scoping is real, in BOTH directions. This pair is the whole
  -- write-amplification argument: without D2 the design is the unfiltered one
  -- that would have written 11,201 rows for 4.21.3-eventsource-001-backfill.
  ---------------------------------------------------------------------------
  UPDATE public.event_log SET quantity_numeric = 99.5 WHERE id = v_e1;      -- watched
  SELECT count(*) INTO v_n FROM public.audit_events WHERE row_id = v_e1 AND action = 'UPDATE';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'D1: watched-column UPDATE wrote % UPDATE rows (expected 1)', v_n;
  END IF;

  UPDATE public.event_log SET source = 'import' WHERE id = v_e1;            -- ignored
  SELECT count(*) INTO v_n FROM public.audit_events WHERE row_id = v_e1 AND action = 'UPDATE';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'D2: ignored-column UPDATE wrote an audit row (now % UPDATE rows, expected still 1)', v_n;
  END IF;

  -- updated_at moves on every UPDATE via set_updated_at. If it were watched, D2 could not pass —
  -- so D2 also proves updated_at is correctly excluded.

  ---------------------------------------------------------------------------
  -- E — harvest_log, the table crop totals are summed from. It had NO triggers
  -- of any kind before this migration.
  ---------------------------------------------------------------------------
  INSERT INTO public.harvest_log (event_id, project_id, quantity, unit, created_by)
       VALUES (v_e1, v_proj, 3.25, 'lb', v_actor) RETURNING id INTO v_h1;

  UPDATE public.harvest_log SET quantity = 1.00 WHERE id = v_h1;
  SELECT count(*), max(before_jsonb ->> 'quantity') INTO v_n, v_act
    FROM public.audit_events WHERE row_id = v_h1 AND action = 'UPDATE';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'E1: harvest quantity edit wrote % UPDATE rows (expected 1)', v_n;
  END IF;
  IF v_act::numeric <> 3.25 THEN
    RAISE EXCEPTION 'E2: before_jsonb.quantity is % (expected 3.25) — the prior total is not recoverable', v_act;
  END IF;

  UPDATE public.harvest_log SET notes = 'annotation only' WHERE id = v_h1;  -- ignored
  SELECT count(*) INTO v_n FROM public.audit_events WHERE row_id = v_h1 AND action = 'UPDATE';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'E3: ignored-column UPDATE on harvest_log wrote an audit row (now %)', v_n;
  END IF;

  DELETE FROM public.harvest_log WHERE id = v_h1;
  SELECT count(*) INTO v_n FROM public.audit_events WHERE row_id = v_h1 AND action = 'DELETE';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'E4: harvest_log hard DELETE wrote % audit rows (expected 1)', v_n;
  END IF;

  DELETE FROM public.event_log WHERE id = v_e1;

  RAISE NOTICE 'OPS-HARVESTAUDIT-001 0c: all checks passed (A1-A5, B1, C1-C2, D1-D2, E1-E4). Rolling back.';
END;
$$;

ROLLBACK;
