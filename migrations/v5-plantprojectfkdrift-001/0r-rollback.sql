-- 0r-rollback.sql — v5-plantprojectfkdrift-001 rollback.
--
-- Drops what THIS migration created on THIS database, and nothing it merely found.
--
-- HOW IT TELLS THE TWO APART. 0a writes a schema_version row
--   '5.0.0-plantprojectfkdrift-001-created-<constraint name>' in the same transaction as the ALTER TABLE
--   that creates a constraint, and writes no such row for a constraint that was already there. This file
--   drops a constraint only while its row exists.
--
-- ⚠ ON PROD THIS FILE IS A NO-OP, BY DESIGN. Prod's two constraints date from 2026-08-21. 0a found them
--   and wrote no -created- row, so neither branch below can run: nothing is dropped, and nothing is
--   deleted from schema_version either. The stamps stay, so the standing gates keep watching prod's
--   definitions. There is no supported way to remove prod's constraints from this directory. Removing the
--   rule from prod would be its own decision and its own migration.
--   (gates.yml post_prod_carries_no_created_row is red if a -created- row ever appears on prod. If it is
--   red, do not run this file there.)
--
-- ON STAGING, after a normal apply: drops event_log_plant_project_fk, then plants_id_project_uq, and
--   deletes the four rows this migration can write. Staging is then as it was before 0a.
--   Mixed cases follow the same rule per object: a constraint with no -created- row is left where it is.
--   The stamps are removed whenever at least one -created- row was found, because a stamp left behind
--   would arm gates that describe objects this file has just dropped.
--
-- EVERY DROP IS CHECKED FIRST. A constraint is dropped only if it still has the definition this migration
--   records. If someone has since replaced it with something else under the same name, this file raises
--   and changes nothing: that object is theirs, not ours. If it is simply gone already, there is nothing
--   to drop and the rows are still cleared.
--   plants_id_project_uq is refused while ANY foreign key still rests on its index, named in the message.
--   No CASCADE anywhere: a dependency nobody declared stops the rollback instead of vanishing with it.
--
-- WHAT ROLLING BACK COSTS. Staging stops refusing an event whose project is not its planting's, so the
--   integration suite (which forks staging) can no longer catch code that would be refused on prod.
--   tests/integration/anchor-pair.int.test.js needs no change: its foreign-key block is skipped when the
--   constraint is absent, and its stamp check is skipped when the stamp is.
--   No row of event_log or plants is touched either way: 0a and 0c changed constraints, never data.
--
-- LOCKS (staging): DROP CONSTRAINT takes ACCESS EXCLUSIVE on event_log and on plants (the foreign key's
--   triggers live on both), then ACCESS EXCLUSIVE on plants again for the unique constraint.
--   lock_timeout 5s.
--
-- A re-run after a successful rollback finds no -created- row and does nothing.
--
-- Usage: psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

SET LOCAL lock_timeout = '5s';
-- Same reason as 0a: pg_get_constraintdef's rendering of the referenced table depends on the search_path.
SET LOCAL search_path = public;

DO $$
DECLARE
  c_uq_def CONSTANT text := 'UNIQUE (id, project_id)';
  c_uq_idx CONSTANT text := 'CREATE UNIQUE INDEX plants_id_project_uq ON public.plants USING btree (id, project_id)';
  c_fk_def CONSTANT text := 'FOREIGN KEY (plant_id, project_id) REFERENCES plants(id, project_id) ON UPDATE CASCADE ON DELETE RESTRICT';
  c_fk_row CONSTANT text := '5.0.0-plantprojectfkdrift-001-created-event_log_plant_project_fk';
  c_uq_row CONSTANT text := '5.0.0-plantprojectfkdrift-001-created-plants_id_project_uq';
  v_made_fk boolean;
  v_made_uq boolean;
  v_n       integer;
  v_def     text;
  v_idx     text;
  v_users   text;
BEGIN
  IF to_regclass('public.schema_version') IS NULL THEN
    RAISE EXCEPTION 'v5-plantprojectfkdrift-001 0r refused, nothing changed: public.schema_version does not exist here. Wrong database?';
  END IF;

  v_made_fk := EXISTS (SELECT 1 FROM public.schema_version WHERE version = c_fk_row);
  v_made_uq := EXISTS (SELECT 1 FROM public.schema_version WHERE version = c_uq_row);

  IF NOT v_made_fk AND NOT v_made_uq THEN
    RAISE NOTICE 'v5-plantprojectfkdrift-001 0r: no -created- row on this database. Nothing here was made by this migration (prod, a database it was never applied to, or one already rolled back). Nothing dropped, nothing deleted.';
    RETURN;
  END IF;

  -- ── 1. The foreign key first: it rests on the unique key. ──────────────────────────────────────
  IF v_made_fk THEN
    SELECT count(*), max(pg_get_constraintdef(c.oid)) INTO v_n, v_def
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public' AND t.relname = 'event_log'
       AND c.conname = 'event_log_plant_project_fk';

    IF v_n = 0 THEN
      RAISE NOTICE 'v5-plantprojectfkdrift-001 0r: event_log_plant_project_fk was created here by 0a and is already gone. Nothing to drop.';
    ELSIF v_def IS NULL OR v_def NOT IN (c_fk_def, c_fk_def || ' NOT VALID') THEN
      RAISE EXCEPTION 'v5-plantprojectfkdrift-001 0r refused, nothing changed: event_log_plant_project_fk is no longer the constraint 0a created (found "%").', coalesce(v_def, '(none)')
        USING HINT = 'Someone replaced it under the same name. That object is not this migration''s to drop; a person decides.';
    ELSE
      ALTER TABLE public.event_log DROP CONSTRAINT event_log_plant_project_fk;
      RAISE NOTICE 'v5-plantprojectfkdrift-001 0r: DROPPED event_log_plant_project_fk (created here by 0a).';
    END IF;
  ELSE
    RAISE NOTICE 'v5-plantprojectfkdrift-001 0r: event_log_plant_project_fk has no -created- row here: it was not made by this migration. Left exactly as it is.';
  END IF;

  -- ── 2. The unique key. ─────────────────────────────────────────────────────────────────────────
  IF v_made_uq THEN
    SELECT count(*), max(pg_get_constraintdef(c.oid)), max(pg_get_indexdef(c.conindid)) INTO v_n, v_def, v_idx
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public' AND t.relname = 'plants'
       AND c.conname = 'plants_id_project_uq';

    IF v_n = 0 THEN
      RAISE NOTICE 'v5-plantprojectfkdrift-001 0r: plants_id_project_uq was created here by 0a and is already gone. Nothing to drop.';
    ELSIF v_def IS DISTINCT FROM c_uq_def OR v_idx IS DISTINCT FROM c_uq_idx THEN
      RAISE EXCEPTION 'v5-plantprojectfkdrift-001 0r refused, nothing changed: plants_id_project_uq is no longer the constraint 0a created (found "%", index "%").',
        coalesce(v_def, '(none)'), coalesce(v_idx, '(none)')
        USING HINT = 'Someone replaced it under the same name. That object is not this migration''s to drop; a person decides.';
    ELSE
      -- Any foreign key still resting on this index: ours when it was NOT made here (step 1 left it),
      -- or one a later migration added. Named, rather than left to "other objects depend on it".
      SELECT string_agg(t.relname::text || '.' || f.conname::text, ', ' ORDER BY t.relname::text, f.conname::text)
        INTO v_users
        FROM pg_constraint f
        JOIN pg_class t ON t.oid = f.conrelid
        JOIN pg_constraint u ON u.conindid = f.conindid
        JOIN pg_class ut ON ut.oid = u.conrelid
        JOIN pg_namespace un ON un.oid = ut.relnamespace
       WHERE f.contype = 'f'
         AND un.nspname = 'public' AND ut.relname = 'plants'
         AND u.conname = 'plants_id_project_uq' AND u.contype = 'u';

      IF v_users IS NOT NULL THEN
        RAISE EXCEPTION 'v5-plantprojectfkdrift-001 0r refused, nothing changed: plants_id_project_uq is still the target of: %.', v_users
          USING HINT = 'A foreign key this migration did not create rests on the key it did. Dropping the key would need CASCADE, which this file never uses. Roll back whatever added that foreign key first.';
      END IF;

      ALTER TABLE public.plants DROP CONSTRAINT plants_id_project_uq;
      RAISE NOTICE 'v5-plantprojectfkdrift-001 0r: DROPPED plants_id_project_uq (created here by 0a).';
    END IF;
  ELSE
    RAISE NOTICE 'v5-plantprojectfkdrift-001 0r: plants_id_project_uq has no -created- row here: it was not made by this migration. Left exactly as it is.';
  END IF;

  -- ── 3. The rows. Reached only when at least one -created- row existed. ─────────────────────────
  DELETE FROM public.schema_version
   WHERE version IN ('5.0.0-plantprojectfkdrift-001-validate', c_fk_row, c_uq_row, '5.0.0-plantprojectfkdrift-001');
END $$;

-- What is left. After a staging rollback: no constraint rows and no schema_version rows.
-- On prod: both constraints and both stamps, unchanged.
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
