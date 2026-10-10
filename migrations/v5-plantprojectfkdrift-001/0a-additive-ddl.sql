-- 0a-additive-ddl.sql
-- v5-plantprojectfkdrift-001 — BUG-PLANTPROJECTFKDRIFT-001. The rule "an event that names a planting carries
--   that planting's project" lives in prod's database and in no migration. This file writes it down, so
--   staging gets it and the tests that fork staging run under the rule prod enforces.
--
-- WHAT PROD HAS (catalog read 2026-10-09). Both were added by hand on 2026-08-21, on Dave's go, as step 3 of
--   the BUG-EVENTPROJPLANTPAIR-001 repair, from gardening-docs _fleet_20260821/projplantpair-constraint.sql.
--   That file's own closing note said to carry the steps into a migration and apply them to staging; neither
--   happened. Staging has neither object.
--     plants     plants_id_project_uq         UNIQUE (id, project_id)                       a CONSTRAINT (contype u)
--                its index                    CREATE UNIQUE INDEX plants_id_project_uq ON public.plants USING btree (id, project_id)
--     event_log  event_log_plant_project_fk   FOREIGN KEY (plant_id, project_id) REFERENCES plants(id, project_id)
--                                             ON UPDATE CASCADE ON DELETE RESTRICT          validated
--   The three strings above are the catalog's own rendering (pg_get_constraintdef, pg_indexes.indexdef) and
--   are what this file, 0c, 0r and gates.yml compare against, character for character.
--
-- WHAT THE TWO OBJECTS DO (the reasoning is the 2026-08-21 file's, kept here because that file is not in
--   this repo):
--   * plants_id_project_uq can never refuse a row: id is already the primary key, so the pair is trivially
--     unique. It exists because a composite foreign key needs a unique key on exactly its target columns.
--   * MATCH SIMPLE (the default; pg_get_constraintdef prints nothing for it) checks a row only when BOTH
--     columns are set. An event with no planting, and an event with no project, stay legal. An event with
--     both set whose planting has NO project is checked and refused.
--   * ON UPDATE CASCADE is not the default and is the point: with NO ACTION, moving a planting to another
--     project would fail 23503 as soon as it had one event. With CASCADE the planting's events follow it.
--     No application path moves a planting (lambda/plants/index.js: container_id is not in the PUT's SET
--     list), so the cascade fires only for a hand-run UPDATE plants SET project_id, which is one of the
--     ways the bad rows repaired on 2026-08-21 were made.
--   * ON DELETE RESTRICT matches event_log_plant_id_fkey, which already refuses the same delete.
--
-- ONE FILE, BOTH ENVIRONMENTS. Postgres has no ADD CONSTRAINT IF NOT EXISTS, and a bare "skip if the name
--   exists" would accept a same-named object that means something else. So each object is looked up by
--   name in the catalog and one of three things happens:
--     absent                          -> created, and a row is written saying THIS file created it here
--     present with prod's definition  -> left exactly as it is; nothing is written about it
--     present with anything else      -> RAISE EXCEPTION, the whole transaction rolls back
--   "Anything else" includes: the name on another table, a bare index of that name with no constraint, a
--   different column list or order, MATCH FULL, another ON UPDATE or ON DELETE action, DEFERRABLE. The
--   foreign key is accepted validated or NOT VALID, because that is the one thing 0c changes.
--   After a create, the object is read back and compared with the same strings, inside the transaction:
--   this file cannot commit a constraint the catalog renders differently from prod's.
--
--   PROD: both lookups find prod's definition. No ALTER TABLE runs and no DDL lock is taken; the one
--     write is the schema_version row at the end. The only relation lock on either table is a momentary
--     ACCESS SHARE on plants from pg_get_indexdef (the lock of any SELECT), released before commit.
--   STAGING (first run): both are created. The foreign key is added NOT VALID.
--   A SECOND RUN anywhere: finds what the first run left and writes nothing (the stamp is ON CONFLICT DO
--     NOTHING and does not move applied_at).
--
-- NOT VALID, AND WHY THIS FILE NEVER VALIDATES. NOT VALID skips the scan of existing rows; it does not
--   skip enforcement. From the commit of this file every INSERT, and every UPDATE that changes plant_id or
--   project_id, is checked. Rows already in event_log are not looked at here, so this file cannot fail on
--   staging's old test rows and never deletes or rewrites one. Validation is 0c-validate.sql: a separate
--   file that counts the rows that would fail and refuses, with the count, rather than failing on the
--   first one.
--
-- IS IT SAFE TO ARM ON STAGING (the house test: would the code deployed THERE write a row this refuses?).
--   Every writer of the pair, read at dev 755099ce725a56ef0483460c0ed0486936ad032f:
--     POST /api/events, PUT /api/events/:id   deriveEventProjectId (lambda/events/validators.js): the
--                                             planting's project, whatever the body says
--     POST /api/events/batch                  SELECT p.container_id ... p.id from the planting row itself
--     planting status change (lambda/plants)  _projectId read from the same planting
--     project status change (lambda/projects) plant_id is NULL: not checked
--     nightly rain rows (lambda/daily-plan)   ct.id, gn.id with ct joined ON ct.id = gn.container_id
--     planting merge (plantMemoryRepoint.js)  rewrites plant_id only, and merge.js step 2b refuses a group
--                                             that is not all in the winner's project before any write
--   The derivation shipped on dev 2026-08-20 (94926010). What staging's Lambdas are actually running is a
--   property of the deployed artifact and was NOT read at authoring: gates.yml carries it as a manual pre
--   gate. A staging Lambda older than that commit would start answering 400 on a mismatched write, which
--   is the rule working, not data loss.
--
-- LOCKS (staging; prod takes none). lock_timeout 5s: behind a long transaction these fail fast and change
--   nothing. Run it again.
--     ADD CONSTRAINT ... UNIQUE              ACCESS EXCLUSIVE on plants while the index builds. Prod's
--                                            plants was 262 rows on 2026-08-21 and staging is test data
--                                            (its count was not read): milliseconds. Not built
--                                            CONCURRENTLY, which cannot run in a transaction and is not
--                                            needed at this size.
--     ADD CONSTRAINT ... FOREIGN KEY NOT VALID   SHARE ROW EXCLUSIVE on event_log and on plants. No scan.
--
-- THE CREATED ROWS. '5.0.0-plantprojectfkdrift-001-created-<constraint name>' is written only by the
--   branch that ran the ALTER TABLE, in the same transaction. It is how 0r-rollback.sql tells "this
--   migration made it here" from "it was already here": 0r drops a constraint only while its row exists.
--   Prod never gets one, so 0r can never drop prod's constraints. gates.yml holds prod to that
--   (post_prod_carries_no_created_row).
--
-- NO COMMENT ON CONSTRAINT: prod's carry none, and staging is being made the same.
--
-- APPLY ORDER: README.md. The reworked tests/integration/anchor-pair.int.test.js must be on dev BEFORE
--   this file is applied to staging: the old version of that test writes the row this constraint refuses.
-- ROLLBACK: 0r-rollback.sql.
--
-- Usage: psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f 0a-additive-ddl.sql

BEGIN;

SET LOCAL lock_timeout = '5s';
-- pg_get_constraintdef prints the referenced table unqualified only when its schema is on the search_path,
-- and the definitions below are prod's as read with public on it. A pooled connection can arrive with
-- another client's search_path (scripts/gate_runner.py, OPS-GATEINVARIANTSFLAKE-001); pin it for this
-- transaction.
SET LOCAL search_path = public;

DO $$
DECLARE
  c_uq_def CONSTANT text := 'UNIQUE (id, project_id)';
  c_uq_idx CONSTANT text := 'CREATE UNIQUE INDEX plants_id_project_uq ON public.plants USING btree (id, project_id)';
  c_fk_def CONSTANT text := 'FOREIGN KEY (plant_id, project_id) REFERENCES plants(id, project_id) ON UPDATE CASCADE ON DELETE RESTRICT';
  v_n    integer;
  v_tbl  text;
  v_type text;
  v_def  text;
  v_idx  text;
BEGIN
  -- ── 0. Wrong-database guard. ───────────────────────────────────────────────────────────────────
  IF to_regclass('public.plants') IS NULL OR to_regclass('public.event_log') IS NULL
     OR to_regclass('public.schema_version') IS NULL THEN
    RAISE EXCEPTION 'v5-plantprojectfkdrift-001 0a refused, nothing changed: public.plants, public.event_log or public.schema_version does not exist here. Wrong database?';
  END IF;

  -- ── 1. plants_id_project_uq: the key the foreign key points at. ────────────────────────────────
  -- Looked up by name across the whole schema, not only on plants: the name on another table is a
  -- finding, not an absence.
  SELECT count(*) INTO v_n
    FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
   WHERE n.nspname = 'public' AND c.conname = 'plants_id_project_uq';

  IF v_n = 0 THEN
    -- A constraint's index takes the constraint's name. A relation already holding it (a bare unique
    -- index is the likely one) would make the ADD below fail on the name, or worse be mistaken for
    -- the constraint by a check that compares index names only.
    IF EXISTS (SELECT 1 FROM pg_class r JOIN pg_namespace n ON n.oid = r.relnamespace
                WHERE n.nspname = 'public' AND r.relname = 'plants_id_project_uq') THEN
      RAISE EXCEPTION 'v5-plantprojectfkdrift-001 0a refused, nothing changed: a relation named plants_id_project_uq exists in public but no constraint of that name does.'
        USING HINT = 'Prod has a UNIQUE CONSTRAINT of this name, not a bare index. Read what is there (pg_class, pg_get_indexdef) before deciding; this file will not adopt or replace it.';
    END IF;

    ALTER TABLE public.plants
      ADD CONSTRAINT plants_id_project_uq UNIQUE (id, project_id);

    INSERT INTO public.schema_version (version, description)
    VALUES ('5.0.0-plantprojectfkdrift-001-created-plants_id_project_uq',
            'PLANTPROJECTFKDRIFT provenance: plants_id_project_uq was CREATED on this database by '
            'migrations/v5-plantprojectfkdrift-001/0a-additive-ddl.sql; it did not exist before. '
            '0r-rollback.sql drops the constraint only while this row exists. Prod must never carry '
            'this row: its constraint dates from 2026-08-21.')
    ON CONFLICT (version) DO NOTHING;

    RAISE NOTICE 'v5-plantprojectfkdrift-001 0a: CREATED plants_id_project_uq.';
  ELSE
    RAISE NOTICE 'v5-plantprojectfkdrift-001 0a: plants_id_project_uq is already here; checking it is prod''s, changing nothing.';
  END IF;

  -- Whether it was found or just made, it must be exactly prod's. LEFT JOIN: a row with no table
  -- (a domain constraint of this name) reads as a mismatch, not as nothing.
  SELECT count(*), max(t.relname::text), max(c.contype::text),
         max(pg_get_constraintdef(c.oid)), max(pg_get_indexdef(c.conindid))
    INTO v_n, v_tbl, v_type, v_def, v_idx
    FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    LEFT JOIN pg_class t ON t.oid = c.conrelid
   WHERE n.nspname = 'public' AND c.conname = 'plants_id_project_uq';

  IF v_n <> 1 OR v_tbl IS DISTINCT FROM 'plants' OR v_type IS DISTINCT FROM 'u'
     OR v_def IS DISTINCT FROM c_uq_def OR v_idx IS DISTINCT FROM c_uq_idx THEN
    RAISE EXCEPTION 'v5-plantprojectfkdrift-001 0a refused, nothing changed: plants_id_project_uq is not prod''s definition. Found % constraint(s) of that name in public; table %, type %, definition "%", index "%". Expected 1 on plants, type u, "%", "%".',
      v_n, coalesce(v_tbl, '(none)'), coalesce(v_type, '(none)'), coalesce(v_def, '(none)'),
      coalesce(v_idx, '(none)'), c_uq_def, c_uq_idx
      USING HINT = 'A same-named object that means something else is a decision for a person. Do not rename, drop or edit around it from this file.';
  END IF;

  -- ── 2. event_log_plant_project_fk: the rule. ───────────────────────────────────────────────────
  SELECT count(*) INTO v_n
    FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
   WHERE n.nspname = 'public' AND c.conname = 'event_log_plant_project_fk';

  IF v_n = 0 THEN
    ALTER TABLE public.event_log
      ADD CONSTRAINT event_log_plant_project_fk
      FOREIGN KEY (plant_id, project_id)
      REFERENCES public.plants (id, project_id)
      MATCH SIMPLE
      ON UPDATE CASCADE
      ON DELETE RESTRICT
      NOT VALID;

    INSERT INTO public.schema_version (version, description)
    VALUES ('5.0.0-plantprojectfkdrift-001-created-event_log_plant_project_fk',
            'PLANTPROJECTFKDRIFT provenance: event_log_plant_project_fk was CREATED on this database by '
            'migrations/v5-plantprojectfkdrift-001/0a-additive-ddl.sql, NOT VALID; it did not exist '
            'before. 0r-rollback.sql drops the constraint only while this row exists. Prod must never '
            'carry this row: its constraint dates from 2026-08-21.')
    ON CONFLICT (version) DO NOTHING;

    RAISE NOTICE 'v5-plantprojectfkdrift-001 0a: CREATED event_log_plant_project_fk, NOT VALID. New writes are checked from this commit; existing rows are not scanned until 0c-validate.sql.';
  ELSE
    RAISE NOTICE 'v5-plantprojectfkdrift-001 0a: event_log_plant_project_fk is already here; checking it is prod''s, changing nothing.';
  END IF;

  SELECT count(*), max(t.relname::text), max(c.contype::text), max(pg_get_constraintdef(c.oid))
    INTO v_n, v_tbl, v_type, v_def
    FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    LEFT JOIN pg_class t ON t.oid = c.conrelid
   WHERE n.nspname = 'public' AND c.conname = 'event_log_plant_project_fk';

  -- Validated (prod; staging after 0c) or NOT VALID (staging after this file) are the same constraint.
  IF v_n <> 1 OR v_tbl IS DISTINCT FROM 'event_log' OR v_type IS DISTINCT FROM 'f'
     OR v_def IS NULL OR v_def NOT IN (c_fk_def, c_fk_def || ' NOT VALID') THEN
    RAISE EXCEPTION 'v5-plantprojectfkdrift-001 0a refused, nothing changed: event_log_plant_project_fk is not prod''s definition. Found % constraint(s) of that name in public; table %, type %, definition "%". Expected 1 on event_log, type f, "%" (with or without a trailing NOT VALID).',
      v_n, coalesce(v_tbl, '(none)'), coalesce(v_type, '(none)'), coalesce(v_def, '(none)'), c_fk_def
      USING HINT = 'A different ON UPDATE action is not a detail: without CASCADE, moving a planting between projects fails as soon as it has an event. Do not drop and re-add from this file; a person decides.';
  END IF;

  -- ── 3. The stamp. Same transaction as the DDL: "applied" and "armed" are one event. ────────────
  INSERT INTO public.schema_version (version, description)
  VALUES ('5.0.0-plantprojectfkdrift-001',
          'PLANTPROJECTFKDRIFT: BUG-PLANTPROJECTFKDRIFT-001. Records in the migrations the two objects '
          'added to prod by hand on 2026-08-21 (BUG-EVENTPROJPLANTPAIR-001 step 3): plants_id_project_uq '
          'UNIQUE (id, project_id) and event_log_plant_project_fk FOREIGN KEY (plant_id, project_id) '
          'REFERENCES plants(id, project_id) ON UPDATE CASCADE ON DELETE RESTRICT. Each is looked up by '
          'name: absent = created (the foreign key NOT VALID) and a -created- row written; present '
          'with exactly this definition = untouched; present with any other definition = the apply '
          'raises. On prod both predate this row and nothing but this row was written. No event_log '
          'or plants row is read, changed or deleted. Validation is 0c-validate.sql, stamp '
          '5.0.0-plantprojectfkdrift-001-validate.')
  ON CONFLICT (version) DO NOTHING;
END $$;

-- What this database now carries. Prod: two constraints, valid = t on the foreign key, and ONE
-- schema_version row. Staging after a first run: valid = f on the foreign key and THREE rows.
SELECT t.relname AS tbl, c.conname, c.contype, c.convalidated AS valid, pg_get_constraintdef(c.oid) AS definition
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
 WHERE n.nspname = 'public' AND c.conname IN ('plants_id_project_uq', 'event_log_plant_project_fk')
 ORDER BY c.conname;

SELECT version, applied_at
  FROM public.schema_version
 WHERE version IN ('5.0.0-plantprojectfkdrift-001',
                   '5.0.0-plantprojectfkdrift-001-created-plants_id_project_uq',
                   '5.0.0-plantprojectfkdrift-001-created-event_log_plant_project_fk',
                   '5.0.0-plantprojectfkdrift-001-validate')
 ORDER BY version;

COMMIT;
