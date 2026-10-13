-- 0r-rollback.sql: V5-CHILLBAND-001 rollback. Narrows weather_cue_impression_cue_chk from the six
--   cues back to the five (drops `cool`), puts the column comment back, and removes stamp
--   5.0.0-chillband-001. Touches nothing else.
--
-- THIS IS THE ARMING DIRECTION. 0a was safe before its code because a superset breaks no writer. This
--   file is the reverse: it re-arms a CHECK that refuses a value a writer may by now be sending
--   (gardening-deploy.md, "arming a CHECK is NOT backward-compatible"). Ask the house question of
--   whatever is DEPLOYED when you run it: can it send `cool`?
--
-- CODE BACK BEFORE SCHEMA BACK. While any deployed engine can return the `cool` cue and any deployed
--   client can render it, this file does not break Today: the impression writer catches the 23514,
--   logs a warning and answers 202. What it does is lose every `cool` impression from then on, with
--   nothing on screen to show for it. That is the silent hole the table exists to prevent. Take the
--   engine rule and both vocabularies back first.
--
-- IN THE REPO: nothing has to move first. Every gate in this directory's gates.yml is self-armed on
--   the stamp this file deletes and returns to vacuous.
--
-- THE REFUSAL GUARD. A `cool` row is the only record that the line was on screen that day: the plan
--   it came from is overwritten by the next run, and no endpoint or log can give the row back
--   (ops-cueinstrument-001 0r says the same of every row here). Narrowing with such a row present
--   would fail anyway, on the validating scan, with a raw 23514; the guard says so first, says how
--   many, and changes nothing. Getting past it means deciding what happens to those rows, which is
--   Dave's decision, with the rows exported first. It is not something to reach by editing the guard
--   or by adding NOT VALID.
--   A re-run after a successful rollback finds the five and no stamp and is a no-op.
--
-- Also used by the staging rehearsal (README.md): 0a -> post -> THIS -> pre -> 0a -> post. At that
--   point nothing can have written `cool`, so the guard passes.
--
-- LOCKS: as 0a. ACCESS EXCLUSIVE on weather_cue_impression to COMMIT, one scan of a small table.
--
-- REHEARSED 2026-10-13 on a throwaway local PostgreSQL 17.10 (rehearse_local.py; README.md "What was
--   rehearsed, and where"). Not run on staging or prod.
--
-- Usage: psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 1. The guard, then the swap back, or nothing. ────────────────────────────────────────────────
DO $$
DECLARE
  v_vocab text[];
  v_valid boolean;
  v_plain boolean;
  v_cool  bigint := 0;
  v_five  CONSTANT text[] := ARRAY['freeze', 'cold', 'heat', 'rain', 'wet'];
  v_six   CONSTANT text[] := ARRAY['freeze', 'cold', 'cool', 'heat', 'rain', 'wet'];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'public' AND c.relname = 'weather_cue_impression'
                    AND c.relkind = 'r') THEN
    RAISE NOTICE 'v5-chillband-001 0r: public.weather_cue_impression is not here; nothing to narrow.';
    RETURN;
  END IF;

  -- v_plain, as in 0a: the whole definition is one membership test of cue against quoted words.
  SELECT (SELECT array_agg(m[1])
            FROM regexp_matches(pg_get_constraintdef(c.oid), '''([^'']+)''::text', 'g') AS m),
         c.convalidated,
         pg_get_constraintdef(c.oid) ~ '^CHECK \(\(cue = ANY \(ARRAY\[''[a-z]+''::text(, ''[a-z]+''::text)*\]\)\)\)$'
    INTO v_vocab, v_valid, v_plain
    FROM pg_constraint c
    JOIN pg_class t     ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
   WHERE t.relname = 'weather_cue_impression' AND c.contype = 'c'
     AND c.conname = 'weather_cue_impression_cue_chk';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'v5-chillband-001 0r refused, nothing changed: weather_cue_impression has no CHECK named weather_cue_impression_cue_chk.'
      USING HINT = 'Find out what happened to it; do not edit this guard.';
  END IF;

  IF v_valid AND v_plain AND v_vocab @> v_five AND v_vocab <@ v_five THEN
    RAISE NOTICE 'v5-chillband-001 0r: weather_cue_impression_cue_chk is already the five cues; nothing to narrow.';

  ELSIF v_valid AND v_plain AND v_vocab @> v_six AND v_vocab <@ v_six THEN
    -- EXECUTE, to keep the count out of the block's parse; the table is known to exist here.
    EXECUTE 'SELECT count(*) FROM public.weather_cue_impression WHERE cue = ''cool''' INTO v_cool;

    IF v_cool > 0 THEN
      RAISE EXCEPTION 'v5-chillband-001 0r refused, nothing changed: % impression row(s) record the cool cue, and each is the only record that the line was shown that day.', v_cool
        USING HINT = 'Export those rows and take the decision to Dave; do not edit this guard and do not add NOT VALID.';
    END IF;

    ALTER TABLE public.weather_cue_impression
      DROP CONSTRAINT weather_cue_impression_cue_chk;

    ALTER TABLE public.weather_cue_impression
      ADD CONSTRAINT weather_cue_impression_cue_chk
      CHECK (cue IN ('freeze', 'cold', 'heat', 'rain', 'wet'));

  ELSE
    RAISE EXCEPTION 'v5-chillband-001 0r refused, nothing changed: weather_cue_impression_cue_chk is neither the six cues nor the five (validated: %, one plain list on cue: %, values: %).', v_valid, v_plain, v_vocab
      USING HINT = 'A later migration may have widened it again; that one goes back first.';
  END IF;

  -- The comment exactly as ops-cueinstrument-001 0a wrote it. Inside the block, so a database where
  -- the table is gone (the RETURN above) never reaches a statement that names it.
  COMMENT ON COLUMN public.weather_cue_impression.cue IS
    'The computeCallout rule that fired: freeze | cold | heat | rain | wet. Closed vocabulary — widen the CHECK before adding a rule.';
END $$;

-- ── 2. The stamp. ────────────────────────────────────────────────────────────────────────────────
DELETE FROM public.schema_version WHERE version = '5.0.0-chillband-001';

COMMIT;
