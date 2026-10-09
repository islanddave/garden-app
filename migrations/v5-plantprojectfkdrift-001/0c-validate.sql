-- 0c-validate.sql
-- v5-plantprojectfkdrift-001 — VALIDATE event_log_plant_project_fk, or refuse and say why.
--
-- 0a adds the foreign key NOT VALID where it is missing: new writes are checked, the rows already there
-- are not. This file is the second half, kept apart on purpose. It asks one question of the WHOLE table
-- and does one of three things:
--
--   already validated (prod; a re-run)   -> issues no ALTER TABLE, takes no table lock, writes the stamp
--   NOT VALID and no row would fail      -> VALIDATE CONSTRAINT, then writes the stamp
--   NOT VALID and N rows would fail      -> RAISE EXCEPTION carrying N. Nothing is changed and no stamp
--                                           is written. The constraint stays NOT VALID, which is a safe
--                                           place to stop: new writes are still refused.
--
-- THE COUNT is exactly what VALIDATE would trip on, over every row: an event with a planting AND a
--   project for which no plants row has that id and that project. NO deleted_at filter (the all-row sweep
--   rule, L-058): VALIDATE reads soft-deleted rows, and so does this. It is the same query as gates.yml
--   sweep_no_event_names_a_project_its_planting_is_not_in, so `gate_runner.py --phase sweep` says ahead of
--   time which way this file will go.
--   An event with NO project on a planting that has one is not counted and is not a violation: MATCH
--   SIMPLE checks a row only when both columns are set.
--
-- WHAT A REFUSAL MEANS, AND WHAT THIS FILE WILL NOT DO. Staging's count was not measured at authoring. It
--   holds smoke and test rows from before the 2026-08-20 writers derived the pair, so a count above zero
--   there is plausible. This file never deletes or rewrites a row, and neither does anything else in this
--   directory. Whether failing rows are repaired, removed or left is the owner's decision; the listing
--   query is in the message's HINT and in README.md ("If 0c refuses"). Do not edit the count, add a
--   deleted_at filter, or drop-and-re-add the constraint to get past it.
--
-- WHY THERE IS NO RACE between the count and the VALIDATE: the constraint is already enforcing. A write
--   that would add a failing row is refused whether it lands before or after the count.
--
-- LOCKS: VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE on event_log and ROW SHARE on plants. Reads and
--   ordinary writes continue; only other schema changes wait. lock_timeout 5s. On prod the VALIDATE is
--   not issued at all.
--
-- THE STAMP 5.0.0-plantprojectfkdrift-001-validate arms the two gates that say "validated" and "no row
--   disagrees". It is written only when the constraint is validated at the end of this transaction, so a
--   database where this file refused carries no stamp and those two gates stay vacuous there.
--
-- IDEMPOTENT: a second run finds the constraint validated and changes nothing.
--
-- Usage: psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f 0c-validate.sql

BEGIN;

SET LOCAL lock_timeout = '5s';
-- Same reason as 0a: pg_get_constraintdef's rendering of the referenced table depends on the search_path.
SET LOCAL search_path = public;

DO $$
DECLARE
  c_fk_def CONSTANT text := 'FOREIGN KEY (plant_id, project_id) REFERENCES plants(id, project_id) ON UPDATE CASCADE ON DELETE RESTRICT';
  v_n     integer;
  v_def   text;
  v_valid boolean;
  v_bad   bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-plantprojectfkdrift-001') THEN
    RAISE EXCEPTION 'v5-plantprojectfkdrift-001 0c refused, nothing changed: 0a (5.0.0-plantprojectfkdrift-001) is not applied here. Nothing to validate.';
  END IF;

  -- The constraint must be the one 0a records. This file validates that definition and no other.
  SELECT count(*), max(pg_get_constraintdef(c.oid)), bool_and(c.convalidated)
    INTO v_n, v_def, v_valid
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public' AND t.relname = 'event_log' AND c.contype = 'f'
     AND c.conname = 'event_log_plant_project_fk';

  IF v_n <> 1 OR v_def IS NULL OR v_def NOT IN (c_fk_def, c_fk_def || ' NOT VALID') THEN
    RAISE EXCEPTION 'v5-plantprojectfkdrift-001 0c refused, nothing changed: event_log_plant_project_fk is missing from event_log or is not the definition 0a records (found %: "%").',
      v_n, coalesce(v_def, '(none)')
      USING HINT = 'Run 0a-additive-ddl.sql; it creates the constraint or says exactly how the one here differs.';
  END IF;

  IF v_valid THEN
    RAISE NOTICE 'v5-plantprojectfkdrift-001 0c: event_log_plant_project_fk is already validated here. No VALIDATE issued, no lock taken.';
  ELSE
    -- Every row, soft-deleted included. This is what VALIDATE would refuse.
    SELECT count(*) INTO v_bad
      FROM public.event_log e
     WHERE e.plant_id IS NOT NULL
       AND e.project_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.plants p
                        WHERE p.id = e.plant_id AND p.project_id = e.project_id);

    IF v_bad > 0 THEN
      RAISE EXCEPTION 'v5-plantprojectfkdrift-001 0c refused, nothing changed: % event_log row(s) name a planting together with a project that planting is not in (every row counted, soft-deleted included). event_log_plant_project_fk stays NOT VALID: new writes are still refused, these rows are untouched.',
        v_bad
        USING HINT = 'List them: SELECT e.id, e.plant_id, e.project_id AS event_project_id, p.project_id AS planting_project_id, e.event_type, e.event_date, e.created_by, e.deleted_at FROM public.event_log e LEFT JOIN public.plants p ON p.id = e.plant_id WHERE e.plant_id IS NOT NULL AND e.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.plants q WHERE q.id = e.plant_id AND q.project_id = e.project_id) ORDER BY e.created_at; -- what to do with them is the owner''s decision (README.md, "If 0c refuses"). Do not edit this file to get past it.';
    END IF;

    ALTER TABLE public.event_log VALIDATE CONSTRAINT event_log_plant_project_fk;

    RAISE NOTICE 'v5-plantprojectfkdrift-001 0c: 0 rows would fail; event_log_plant_project_fk VALIDATED.';
  END IF;

  -- Read it back rather than assume: the stamp below certifies this.
  SELECT bool_and(c.convalidated) INTO v_valid
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public' AND t.relname = 'event_log' AND c.contype = 'f'
     AND c.conname = 'event_log_plant_project_fk';

  IF v_valid IS NOT TRUE THEN
    RAISE EXCEPTION 'v5-plantprojectfkdrift-001 0c: event_log_plant_project_fk is still NOT VALID after VALIDATE. Nothing stamped.';
  END IF;

  INSERT INTO public.schema_version (version, description)
  VALUES ('5.0.0-plantprojectfkdrift-001-validate',
          'PLANTPROJECTFKDRIFT validate: BUG-PLANTPROJECTFKDRIFT-001. Written by 0c-validate.sql only '
          'with event_log_plant_project_fk validated at the end of its transaction: either it already '
          'was (prod, where no VALIDATE was issued), or the whole of event_log, soft-deleted rows '
          'included, held no row naming a planting together with a project that planting is not in, '
          'and VALIDATE CONSTRAINT ran. Arms post_foreign_key_is_validated and '
          'post_no_event_names_a_project_its_planting_is_not_in. Writes no data.')
  ON CONFLICT (version) DO NOTHING;
END $$;

-- What this database now carries. valid = t and the -validate row = done.
SELECT c.conname, c.convalidated AS valid, pg_get_constraintdef(c.oid) AS definition
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
 WHERE n.nspname = 'public' AND t.relname = 'event_log' AND c.conname = 'event_log_plant_project_fk';

SELECT version, applied_at
  FROM public.schema_version
 WHERE version IN ('5.0.0-plantprojectfkdrift-001', '5.0.0-plantprojectfkdrift-001-validate')
 ORDER BY version;

COMMIT;
