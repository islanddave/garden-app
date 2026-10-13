-- 0a-widen-cue-check.sql
-- V5-CHILLBAND-001: let the Today weather-cue impression log record a sixth cue, `cool`.
--   The daily plan has a line for a night below 40 F (`freeze`) and below 45 F (`cold`) and nothing
--   from 45 F up to 50 F, the band where sweet potato, okra and peppers take chilling damage with no
--   frost in the forecast. Dave's ruling, 2026-10-12: "A line on each cool night". Every cue that
--   renders on Today writes one row to public.weather_cue_impression, and that table's CHECK
--   weather_cue_impression_cue_chk is closed at five values (migrations/ops-cueinstrument-001 0a).
--   Its own comment gives the order: "Widen BEFORE adding a sixth rule there, never after."
--   This file is that widening and nothing else.
--
-- THE NAME IS `cool`, AND IT IS NOT THIS LANE'S CHOICE. The one time this band shipped (7b43773d,
--   2026-09-09, reverted 46 minutes later by 010caa2f) the engine rule returned icon 'cool'. No
--   migration was written then, which is one of the two reasons it was reverted: the cue could not
--   render, and had it rendered this CHECK would have dropped every impression of it. The engine and
--   client lanes of this release are built from the same record, so the value is taken from it
--   exactly. Mind the neighbour: `cold` and `cool` are one letter apart, and the `cold` cue's own
--   wording begins "Cool night".
--
-- SCOPE: one CHECK constraint on public.weather_cue_impression swapped for a superset of itself, one
--   column comment, one schema_version row. No column, no index, no row written or rewritten.
--   weather_cue_impression_form_chk is not touched: the new cue has to use one of the two forms that
--   exist ('imperative', 'check').
--
-- WIDENING IS THE SAFE DIRECTION (gardening-deploy.md, "arming a CHECK is NOT backward-compatible",
--   read in reverse). That rule is about a constraint on a value only the NEW writer sets: arm it
--   early and the still-deployed OLD writer starts failing. Here it is the other way round. The old
--   writer can only send the five values it has always sent, and all five are still allowed, so this
--   goes BEFORE the code. It is the going back that is the arming step (0r-rollback.sql).
--
-- WHY THE DEPLOYED CODE IS UNAFFECTED (the house test: would the currently deployed code produce a
--   row that violates this, or break on it?). Read on origin/dev 1f58a9d8.
--   THE WRITER, the only one: lambda/daily-plan-read/cue-impression.js. normalizeCueImpression drops
--   any cue outside its own CUES set (the same five) before a statement runs, so every row it can
--   write passes the new CHECK exactly as it passed the old one.
--   READERS: none. No Lambda and no client code selects from this table; it is read by hand.
--   THE ENGINE (lambda/daily-plan/engine.js computeCallout) cannot return 'cool' today.
--   THE OLD GATES. ops-cueinstrument-001's post_cue_check_carries_all_five_rules asks only that the
--   five names appear in the definition, and post_check_constraints_present asks for the two names;
--   both hold on a superset.
--
-- THE SWAP IS ONE TRANSACTION AND THE NEW CHECK IS VALIDATED AGAINST EVERY EXISTING ROW. DROP
--   CONSTRAINT then ADD CONSTRAINT, with no NOT VALID: the ADD scans the table and refuses the whole
--   file if any row is outside the six. There is no instant at which a writer sees the table without
--   a cue CHECK, because both statements run under one lock and nothing is visible before COMMIT.
--   The table has no deleted_at, so "every row" is the whole table (L-058 needs no second sweep).
--
-- SAFETY / IDEMPOTENCY: the DO block reads the constraint as it stands and does one of three things.
--   Exactly the five, validated: swap. Exactly the six, validated: nothing (a second run is a no-op
--   and does not move applied_at). Anything else, or no such constraint: RAISE, changing nothing.
--   It never widens from a shape it does not recognise. The vocabulary is read as the SET of quoted
--   values in pg_get_constraintdef, the way v4-losscapture-001's gates read one, so it does not
--   depend on how Postgres orders or spaces the list. The set is not the whole constraint, so the
--   definition must also be ONE membership test on cue from end to end (v_plain below): a second
--   condition, or a list element that is not a quoted word, is a shape this file does not widen.
--   LOCKS. DROP CONSTRAINT takes ACCESS EXCLUSIVE on weather_cue_impression and holds it to COMMIT;
--   the validating scan runs under it. The table grows by at most five rows per person per day (it
--   was created 2026-09-02), so the scan is a few hundred rows. The one thing that waits is the
--   impression beacon's INSERT, which is fire-and-forget and answers 202 whatever happens. The Today
--   read does not touch this table.
--   lock_timeout: 5s turns a wait behind a long-open transaction into a fast failure that changed
--   nothing. Run it again.
--   Exactly ONE COMMIT, at the end. Do not wrap this file in BEGIN/ROLLBACK to "rehearse" it on a
--   shared database: its own COMMIT ends your transaction.
--
-- APPLY ORDER (README.md has the commands). Staging: pre -> sweep -> 0a -> post -> rehearse 0r -> pre
--   -> 0a -> post. Prod: Dave's first-hand OK for a prod database change, outside 07:00-08:00 UTC,
--   after a pre-apply copy. On both databases BEFORE any code that can send `cool`.
--   NOTHING ENFORCES THAT ORDER. The promote's prod schema gate checks columns and relations, not
--   the values a CHECK admits, and the writer swallows a 23514 and answers 202. Shipped the wrong
--   way round, Today works and every `cool` impression is silently lost.
--
-- ROLLBACK: 0r-rollback.sql. It narrows, so it refuses while any `cool` row exists.
--
-- REHEARSED 2026-10-13 on a throwaway local PostgreSQL 17.10 (rehearse_local.py; README.md "What was
--   rehearsed, and where"). Not applied to staging or prod.
--
-- Usage: psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f 0a-widen-cue-check.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 1. The swap, from the five to the six, or nothing. ───────────────────────────────────────────
DO $$
DECLARE
  v_vocab text[];
  v_valid boolean;
  v_plain boolean;
  v_five  CONSTANT text[] := ARRAY['freeze', 'cold', 'heat', 'rain', 'wet'];
  v_six   CONSTANT text[] := ARRAY['freeze', 'cold', 'cool', 'heat', 'rain', 'wet'];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'public' AND c.relname = 'weather_cue_impression'
                    AND c.relkind = 'r') THEN
    RAISE EXCEPTION 'v5-chillband-001 0a refused, nothing changed: public.weather_cue_impression is not a table in this database.'
      USING HINT = 'migrations/ops-cueinstrument-001 creates it; apply that first.';
  END IF;

  -- v_plain: the WHOLE definition is one membership test of cue against quoted words, as PostgreSQL
  -- prints `cue IN (...)` on a text column. The set of quoted values alone cannot tell the five from
  -- the five AND a second condition that repeats one of them, or from a list that also holds a
  -- column (the local rehearsal widened from both, and dropped the extra condition, before this).
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
    RAISE EXCEPTION 'v5-chillband-001 0a refused, nothing changed: weather_cue_impression has no CHECK named weather_cue_impression_cue_chk.'
      USING HINT = 'A cue CHECK under another name would make this widening cosmetic. Find out what happened to it; do not edit this guard.';
  END IF;

  IF v_valid AND v_plain AND v_vocab @> v_six AND v_vocab <@ v_six THEN
    RAISE NOTICE 'v5-chillband-001 0a: weather_cue_impression_cue_chk already admits the six cues; nothing to do.';

  ELSIF v_valid AND v_plain AND v_vocab @> v_five AND v_vocab <@ v_five THEN
    ALTER TABLE public.weather_cue_impression
      DROP CONSTRAINT weather_cue_impression_cue_chk;

    -- No NOT VALID: validated against every existing row, here, or the file fails whole.
    ALTER TABLE public.weather_cue_impression
      ADD CONSTRAINT weather_cue_impression_cue_chk
      CHECK (cue IN ('freeze', 'cold', 'cool', 'heat', 'rain', 'wet'));

  ELSE
    RAISE EXCEPTION 'v5-chillband-001 0a refused, nothing changed: weather_cue_impression_cue_chk is not the constraint this file widens (validated: %, one plain list on cue: %, values: %).', v_valid, v_plain, v_vocab
      USING HINT = 'Expected exactly freeze, cold, heat, rain, wet, validated, and nothing else in the CHECK. Do not edit this guard.';
  END IF;
END $$;

-- The column comment names the vocabulary; keep it true.
COMMENT ON COLUMN public.weather_cue_impression.cue IS
  'The computeCallout rule that fired: freeze | cold | cool | heat | rain | wet. Closed vocabulary — widen the CHECK before adding a rule.';

-- ── 2. The stamp. Same transaction as the swap: "applied" and "armed" are one event. ──────────────
INSERT INTO public.schema_version (version, description)
VALUES ('5.0.0-chillband-001',
        'CHILLBAND: V5-CHILLBAND-001. weather_cue_impression_cue_chk widened from five cues to six: '
        'freeze, cold, cool, heat, rain, wet. cool is the 45 to 50 F cool-night line. Dropped and '
        're-added in one transaction, validated against every existing row. A superset, so every '
        'row the deployed writer can send still passes; applied before any code that sends cool. '
        'weather_cue_impression_form_chk untouched. No column, no index, no row written.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
