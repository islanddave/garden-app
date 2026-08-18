-- 0c-verify-triggers.sql
-- OPS-VARAUDIT-001 — behavioural proof, against a live fixture, then ROLLBACK.
--
--   psql "$URL" -X -v ON_ERROR_STOP=1 -f migrations/v4-varaudit-001/0c-verify-triggers.sql
--
-- ROLLS BACK. Nothing is left behind, so this is safe to run on prod, and running it on prod is the
-- honest way to confirm the mechanism there rather than inferring it from staging.
--
-- WHY THE ROLLBACK IS SOUND. Every write is inside the transaction: the fixture varieties, the
-- entity rows the gv.entity_cultivar_* triggers mirror, the audit_events rows the triggers write,
-- and the two temporary triggers §S uses to inject audit failures. All of it disappears. Neither
-- table uses a sequence (both ids are uuid defaults), so there is no sequence consumption either.
--
-- WHAT IT COSTS WHILE IT RUNS. §S creates a BEFORE INSERT trigger on public.audit_events, which
-- takes SHARE ROW EXCLUSIVE on that table until the ROLLBACK. For the few milliseconds this script
-- runs, concurrent writes to audit_events — that is, concurrent plant_varieties writes — block. A
-- CHECK constraint would have been the alternative and is worse: it revalidates all 1,872 existing
-- rows. Run it when the varieties surface is quiet.
--
-- WHAT THIS PROVES THAT gates.yml CANNOT. A gate is a read-only SELECT, so gates can only prove the
-- triggers EXIST and are SHAPED correctly — a trigger whose body was gutted would keep every gate
-- green. This file proves they CAPTURE, that they capture exactly what the row-level trigger
-- captured, and that they cannot abort the write they audit.

\set ON_ERROR_STOP on
BEGIN;

-- ── preconditions ────────────────────────────────────────────────────────────────────────────────
-- Fail loudly and early rather than producing green assertions against an unarmed database. Without
-- this, running 0c before 0b would exercise the OLD trigger and report success.
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_trigger
       WHERE NOT tgisinternal
         AND tgname IN ('trg_audit_plant_varieties_ins','trg_audit_plant_varieties_upd',
                        'trg_audit_plant_varieties_del')) <> 3 THEN
    RAISE EXCEPTION '0c precondition: the three OPS-VARAUDIT-001 triggers are not all attached. Apply 0a then 0b first.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname = 'trg_audit_plant_varieties') THEN
    RAISE EXCEPTION '0c precondition: the old row-level trg_audit_plant_varieties is still attached. 0b did not complete.';
  END IF;
END $$;

-- Fixture. A crop_types row is needed because plant_varieties.crop_type_slug is a FK; it is created
-- here rather than borrowed so the script does not depend on any particular environment's data.
INSERT INTO public.crop_types(slug) VALUES ('_v0c_crop') ON CONFLICT DO NOTHING;
SELECT set_config('app.actor_clerk_sub', 'user_0c', true);

-- ── A. INSERT arm, single row ────────────────────────────────────────────────────────────────────
INSERT INTO public.plant_varieties (id, name, created_by, crop_type_slug, days_to_maturity_min)
VALUES ('0c000000-0000-0000-0000-000000000001', '_v0c A', 'user_0c', '_v0c_crop', 60);

DO $$
DECLARE n int; a text; keys int; bnull boolean;
BEGIN
  SELECT count(*), min(actor_clerk_sub),
         min((SELECT count(*) FROM jsonb_object_keys(after_jsonb))), bool_and(before_jsonb IS NULL)
    INTO n, a, keys, bnull
    FROM public.audit_events
   WHERE row_id = '0c000000-0000-0000-0000-000000000001' AND action = 'INSERT';
  IF n <> 1 THEN RAISE EXCEPTION 'A1: single-row INSERT wrote % audit rows, expected 1', n; END IF;
  IF a <> 'user_0c' THEN RAISE EXCEPTION 'A2: actor was %, expected user_0c from the GUC', a; END IF;
  IF NOT bnull THEN RAISE EXCEPTION 'A3: INSERT audit row has a non-NULL before_jsonb'; END IF;
  -- The whole row, not a projection. A trigger that recorded a subset would still pass A1.
  IF keys <> (SELECT count(*) FROM information_schema.columns
               WHERE table_schema='public' AND table_name='plant_varieties') THEN
    RAISE EXCEPTION 'A4: after_jsonb carries % keys, expected one per plant_varieties column (%)',
      keys, (SELECT count(*) FROM information_schema.columns
              WHERE table_schema='public' AND table_name='plant_varieties');
  END IF;
  RAISE NOTICE 'A PASS: INSERT arm captured 1 row, actor=%, full % -key payload.', a, keys;
END $$;

-- ── B. one statement, many rows — the 338-row seed-migration shape ───────────────────────────────
INSERT INTO public.plant_varieties (id, name, created_by, crop_type_slug)
VALUES ('0c000000-0000-0000-0000-000000000002', '_v0c B1', 'user_0c', '_v0c_crop'),
       ('0c000000-0000-0000-0000-000000000003', '_v0c B2', 'user_0c', '_v0c_crop'),
       ('0c000000-0000-0000-0000-000000000004', '_v0c B3', 'user_0c', '_v0c_crop');

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.audit_events
   WHERE action = 'INSERT' AND after_jsonb ->> 'name' IN ('_v0c B1','_v0c B2','_v0c B3');
  IF n <> 3 THEN RAISE EXCEPTION 'B1: 3-row INSERT statement wrote % audit rows, expected 3', n; END IF;
  RAISE NOTICE 'B PASS: one 3-row INSERT statement produced 3 audit rows from a single trigger call.';
END $$;

-- ── C. UPDATE through the auto-updatable VIEW public.cultivar — the real Lambda write path ───────
-- lambda/varieties/index.js writes public.cultivar, never plant_varieties directly. If a base-table
-- statement-level trigger did not see rows from a view-routed write, this migration would audit
-- nothing in production while every gate stayed green. That is why it is asserted rather than
-- assumed.
UPDATE public.cultivar SET days_to_maturity_min = 75
 WHERE id = '0c000000-0000-0000-0000-000000000001';

DO $$
DECLARE n int; bf text; af text;
BEGIN
  -- No min(jsonb) aggregate exists, so the payload is read with ->> (text) rather than aggregated.
  SELECT count(*) INTO n FROM public.audit_events
   WHERE row_id = '0c000000-0000-0000-0000-000000000001' AND action = 'UPDATE';
  SELECT before_jsonb ->> 'days_to_maturity_min', after_jsonb ->> 'days_to_maturity_min'
    INTO bf, af
    FROM public.audit_events
   WHERE row_id = '0c000000-0000-0000-0000-000000000001' AND action = 'UPDATE';
  IF n <> 1 THEN RAISE EXCEPTION 'C1: view-routed UPDATE wrote % audit rows, expected 1', n; END IF;
  IF bf <> '60' OR af <> '75' THEN
    RAISE EXCEPTION 'C2: before/after were %/%, expected 60/75', bf, af;
  END IF;
  RAISE NOTICE 'C PASS: an UPDATE through the cultivar view is audited, before=60 after=75.';
END $$;

-- ── D. SOFT_DELETE and RESTORE, and per-ROW classification inside one statement ──────────────────
-- One statement soft-deletes B1 and plainly updates B2/B3. A statement-level trigger that classified
-- per STATEMENT rather than per ROW would label all three the same; this is the assertion that
-- catches it.
UPDATE public.plant_varieties
   SET deleted_at = CASE WHEN name = '_v0c B1' THEN now() ELSE deleted_at END,
       species    = 'Solanum _v0c'
 WHERE created_by = 'user_0c' AND name LIKE '\_v0c B%';

DO $$
DECLARE nsd int; nupd int;
BEGIN
  SELECT count(*) FILTER (WHERE action = 'SOFT_DELETE'),
         count(*) FILTER (WHERE action = 'UPDATE')
    INTO nsd, nupd
    FROM public.audit_events
   WHERE after_jsonb ->> 'species' = 'Solanum _v0c';
  IF nsd <> 1 THEN RAISE EXCEPTION 'D1: mixed statement produced % SOFT_DELETE rows, expected 1', nsd; END IF;
  IF nupd <> 2 THEN RAISE EXCEPTION 'D2: mixed statement produced % UPDATE rows, expected 2', nupd; END IF;
  RAISE NOTICE 'D PASS: one statement classified per row — 1 SOFT_DELETE + 2 UPDATE.';
END $$;

UPDATE public.cultivar SET deleted_at = NULL WHERE id = '0c000000-0000-0000-0000-000000000002';
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.audit_events
   WHERE row_id = '0c000000-0000-0000-0000-000000000002' AND action = 'RESTORE';
  IF n <> 1 THEN RAISE EXCEPTION 'D3: restore wrote % RESTORE rows, expected 1', n; END IF;
  RAISE NOTICE 'D PASS: RESTORE captured.';
END $$;

-- ── E. the actor idiom, including the empty-string case the old bare COALESCE missed ─────────────
SELECT set_config('app.actor_clerk_sub', '', true);
UPDATE public.plant_varieties SET care_notes = '_v0c empty actor'
 WHERE id = '0c000000-0000-0000-0000-000000000003';

DO $$
DECLARE a text;
BEGIN
  SELECT actor_clerk_sub INTO a FROM public.audit_events
   WHERE after_jsonb ->> 'care_notes' = '_v0c empty actor';
  IF a IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'E1: empty GUC recorded actor %, expected the literal system (NULLIF hardening)',
      coalesce(quote_literal(a), 'NULL');
  END IF;
  RAISE NOTICE 'E PASS: an empty app.actor_clerk_sub degrades to system, not to the empty string.';
END $$;
SELECT set_config('app.actor_clerk_sub', 'user_0c', true);

-- ── F. hard DELETE ───────────────────────────────────────────────────────────────────────────────
-- entity rows go first: entity.cultivar_ref_id is ON DELETE RESTRICT, which is why prod has exactly
-- one DELETE audit row in three months.
DELETE FROM public.entity WHERE cultivar_ref_id IN (
  '0c000000-0000-0000-0000-000000000001','0c000000-0000-0000-0000-000000000002',
  '0c000000-0000-0000-0000-000000000003','0c000000-0000-0000-0000-000000000004');
DELETE FROM public.plant_varieties WHERE created_by = 'user_0c';

DO $$
DECLARE n int; nm text;
BEGIN
  SELECT count(*), min(before_jsonb ->> 'name') INTO n, nm
    FROM public.audit_events
   WHERE action = 'DELETE' AND before_jsonb ->> 'created_by' = 'user_0c';
  IF n <> 4 THEN RAISE EXCEPTION 'F1: 4-row DELETE statement wrote % audit rows, expected 4', n; END IF;
  IF nm IS NULL THEN RAISE EXCEPTION 'F2: DELETE audit row has no before_jsonb pre-image'; END IF;
  RAISE NOTICE 'F PASS: one 4-row DELETE produced 4 audit rows, pre-image intact (first name=%).', nm;
END $$;

-- ── S. THE SAFETY PROPERTY: the audit can never abort the write it audits ────────────────────────
-- Failure is injected with a temporary BEFORE INSERT trigger on audit_events that raises a chosen
-- SQLSTATE. That is the only way to exercise the handler, since after 0a the functions are
-- SECURITY DEFINER and a privilege failure — the live failure mode this migration closes — can no
-- longer occur.
CREATE FUNCTION pg_temp._v0c_break() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'injected audit failure' USING ERRCODE = current_setting('_v0c.errcode', true);
END $$;

CREATE TRIGGER _v0c_break_audit BEFORE INSERT ON public.audit_events
  FOR EACH ROW EXECUTE FUNCTION pg_temp._v0c_break();

-- S1: a generic failure is swallowed. The user's write must still commit.
SELECT set_config('_v0c.errcode', '23514', true);   -- check_violation
INSERT INTO public.plant_varieties (id, name, created_by, crop_type_slug)
VALUES ('0c000000-0000-0000-0000-000000000005', '_v0c S1', 'user_0c', '_v0c_crop');

DO $$
DECLARE nrow int; naudit int;
BEGIN
  SELECT count(*) INTO nrow FROM public.plant_varieties
   WHERE id = '0c000000-0000-0000-0000-000000000005';
  SELECT count(*) INTO naudit FROM public.audit_events
   WHERE row_id = '0c000000-0000-0000-0000-000000000005';
  IF nrow <> 1 THEN
    RAISE EXCEPTION 'S1: the audit failure ABORTED the user INSERT — the exact defect this migration closes';
  END IF;
  IF naudit <> 0 THEN RAISE EXCEPTION 'S1: expected 0 audit rows (the write was injected to fail), got %', naudit; END IF;
  RAISE NOTICE 'S1 PASS: audit write failed (0 audit rows) and the user INSERT still landed.';
END $$;

-- S1b: same for UPDATE, which is the 1,427-row-per-quarter path.
UPDATE public.plant_varieties SET care_notes = '_v0c S1b'
 WHERE id = '0c000000-0000-0000-0000-000000000005';
DO $$
DECLARE v text;
BEGIN
  SELECT care_notes INTO v FROM public.plant_varieties
   WHERE id = '0c000000-0000-0000-0000-000000000005';
  IF v IS DISTINCT FROM '_v0c S1b' THEN
    RAISE EXCEPTION 'S1b: the audit failure ABORTED the user UPDATE (care_notes=%)', coalesce(v,'NULL');
  END IF;
  RAISE NOTICE 'S1b PASS: audit write failed and the user UPDATE still committed.';
END $$;

-- S2: cancellation must NOT be swallowed. query_canceled has to propagate out of the trigger and
-- abort the statement, or a runaway audit write becomes un-cancellable.
DO $$
DECLARE got boolean := false;
BEGIN
  PERFORM set_config('_v0c.errcode', '57014', true);   -- query_canceled
  BEGIN
    INSERT INTO public.plant_varieties (id, name, created_by, crop_type_slug)
    VALUES ('0c000000-0000-0000-0000-000000000006', '_v0c S2', 'user_0c', '_v0c_crop');
  EXCEPTION WHEN query_canceled THEN
    got := true;
  END;
  IF NOT got THEN
    RAISE EXCEPTION 'S2: query_canceled was SWALLOWED by the audit handler — the trigger is un-cancellable';
  END IF;
  IF EXISTS (SELECT 1 FROM public.plant_varieties WHERE id = '0c000000-0000-0000-0000-000000000006') THEN
    RAISE EXCEPTION 'S2: cancellation propagated but the row survived, so the statement was not aborted';
  END IF;
  RAISE NOTICE 'S2 PASS: query_canceled propagated out of the audit handler and aborted the statement.';
END $$;

-- S3: the same for admin_shutdown, the other re-raised condition.
DO $$
DECLARE got boolean := false;
BEGIN
  PERFORM set_config('_v0c.errcode', '57P01', true);   -- admin_shutdown
  BEGIN
    INSERT INTO public.plant_varieties (id, name, created_by, crop_type_slug)
    VALUES ('0c000000-0000-0000-0000-000000000007', '_v0c S3', 'user_0c', '_v0c_crop');
  EXCEPTION WHEN admin_shutdown THEN
    got := true;
  END;
  IF NOT got THEN
    RAISE EXCEPTION 'S3: admin_shutdown was SWALLOWED by the audit handler';
  END IF;
  RAISE NOTICE 'S3 PASS: admin_shutdown propagated out of the audit handler.';
END $$;

DROP TRIGGER _v0c_break_audit ON public.audit_events;

DO $$ BEGIN RAISE NOTICE '0c: all checks passed. Rolling back.'; END $$;

ROLLBACK;
