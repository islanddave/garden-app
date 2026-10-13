-- 0a-additive-ddl.sql
-- V5-WXCOLDBAND-001: public.weather_cold_range, tonight's forecast cold range, one row per night per
--   forecast run.
--   Today prints one low for tonight. Dave approved showing how cold the forecast ensemble says it
--   could get beside it ("Yes — show the ensemble low", handoff 2026-09-15). The number exists in one place:
--   a Google forecast archive only his own Google sign-in can read, from his Mac
--   (project-state/tools/wn3_pull.py). He declined putting that sign-in on the server. His ruling on
--   how it reaches the app, 2026-10-12: "Mac sends it every morning". A background job on the Mac
--   pulls each morning and writes one row here; the card is blank when it did not run. This file is
--   the table. The job and the read are other lanes.
--
-- SCOPE: one new table, its primary key, one foreign key to public.spaces, three CHECKs, one
--   schema_version row. No change to any existing table, no index beyond the primary key's, no
--   trigger, no row security, no grant, no row written.
--
-- ONE WRITER, AND IT IS NOT A LAMBDA. Every other table here is written by code that runs in AWS as
--   the database owner, behind a handler that validates. This one is written from outside AWS by a
--   scheduled script, and (if the README's recommendation is taken) by a role that can do nothing
--   but INSERT into it. There is no handler between that script and the Today card, so the CHECKs
--   below are the only validation the row ever gets. That is why this small table has three.
--
-- DESIGN DECISIONS THIS DDL ENCODES:
--
--   * C1. THE KEY IS (space_id, night_date, init_time). (night_date, init_time) is the September
--     decision (handoff 2026-09-15, Decision 5): a night-only key would keep one forecast per night
--     and foreclose "how did the forecast for this night change from run to run" behind a disruptive
--     migration. space_id leads it because that is how the one existing weather series is scoped
--     (public.weather_daily, PRIMARY KEY (space_id, "date")): the forecast is for a place, and the
--     read finds the caller's place through spaces.created_by = ANY(householdIds), which is the
--     predicate lambda/daily-plan-read/household.js loadOwnedSpace already uses. A table with no
--     place in its key would be served to whoever asked.
--     A natural composite key, no surrogate id, for weather_daily's reason: nothing addresses a row
--     any other way, and the key stays the only possible conflict arbiter.
--
--   * C2. night_date IS THE ET CIVIL DAY THE NIGHT BEGINS ON. The night of 2026-10-13 runs from 18:00
--     that day to 08:00 on the 14th, America/New_York. It is the tool's `night` and the day the plan
--     calls "tonight". A date, never a timestamp: a timestamptz would re-anchor the night to UTC.
--
--   * C3. init_time IS WHEN THE FORECAST RUN STARTED, as an instant (timestamptz). The morning job
--     uses the 00:00 UTC run of the night's own date, which the recon estimates is readable from
--     about 04:10 ET (an inference there, not measured). It is not when the row was written
--     (created_at) and not when the night begins.
--
--   * C4. p10_min_f AND p50_min_f, FAHRENHEIT. Each is the LOWEST value, over the night's hourly
--     forecast steps, of that percentile of the ensemble's 2 m temperature. p10 is the cold end (one
--     run in ten is colder) and is the number the feature exists for: NOT NULL, no row without it.
--     p50 is the middle and is nullable: NULL = the job did not pull it. The names are the tool's
--     (`..._p10_min_f`). They are deliberately not "low_p10": the minimum of an hourly percentile is
--     not the percentile of the night's minimum, and the name should not claim the second.
--     No p90: it is the warm side, the tool does not pull it by default, and each percentile is
--     about 0.9 GB of download a day (the recon's estimate). A nullable column later is an additive
--     migration.
--     numeric(5,2): the tool rounds to two places.
--
--   * C5. leads_read AND leads_expected. A night is 15 hourly forecast steps (14 or 16 on the two
--     clock-change nights). A step the archive did not have yet is skipped by the tool, and a
--     minimum over fewer steps can miss the coldest hour and read warm. leads_expected is how many
--     steps of the night this run covers; leads_read is how many went into the minimum (the fewest,
--     if the two percentiles differ). The read shows a row only when they are equal. Kept as two
--     numbers and not a boolean so that "14 of 15" is on the record.
--
--   * C6. created_at DEFAULT now() IS THE CARD'S FRESHNESS STAMP, on the database's clock. The
--     September design gives this number its own freshness field and forbids borrowing the plan's.
--     The writer does not send it: a laptop's clock is not evidence.
--
--   * C7. ROWS ARE NEVER UPDATED AND NEVER SOFT-DELETED. No updated_at, no deleted_at. A forecast
--     run does not change after it is published; a later run is a new init_time, a new row. This is
--     derived, regenerable data (the tool records the archive as holding every run back to
--     2026-01-01), which is the Soft-Delete-Only Rule's first carve-out ("ephemeral / regenerable /
--     derived data"); nothing here is user-authored. How long Google keeps that archive is not
--     verified (OPS-WN3ARCHIVERETENTION-001), which is why 0r still refuses to drop rows.
--     So the writer needs INSERT and nothing else, and the first row for a key stands.
--
--   * C8. THE FOREIGN KEY CASCADES, as weather_daily's does. A forecast for a place that no longer
--     exists is nothing. This table has no deleted_at, so the cascade removes only derived rows.
--     No deployed code deletes a space.
--
--   * C9. NO created_by AND NO USER COLUMN, for weather_daily's reason: the V4-OWNERSHIP-001 transfer
--     trigger fires on created_by and reads a NULL -> value write as an ownership transfer. A forecast
--     has no owner. Do not add one "for auditing".
--
--   * C10. NO TRIGGER, NO ROW SECURITY, NO POLICY AND NO GRANT IN THIS FILE, as
--     v5-seedlotaddition-001 A7. Row security in particular: enabled with no policy it is deny-all
--     for every role that is not the owner (v4-roschemaversion-001), which here would silently stop
--     the one writer. gates.yml holds it off. The grant the writer needs is described in README.md
--     and is NOT made here: whether to create that role is not this lane's decision.
--
--   * C11. THE THREE CHECKS, one rule each, named so a violation says which:
--       weather_cold_range_leads_chk        leads_read >= 1 AND leads_read <= leads_expected
--       weather_cold_range_p10_le_p50_chk   p50_min_f IS NULL OR p10_min_f <= p50_min_f
--       weather_cold_range_fahrenheit_chk   p10_min_f > -100 AND p10_min_f < 150
--                                           AND (p50_min_f IS NULL OR p50_min_f < 150)
--     The second holds by arithmetic when both percentiles were read over the same steps; a row
--     that breaks it has its columns swapped or was read over different steps. The third is a UNIT
--     guard and nothing finer: the archive is in Kelvin, and every Kelvin temperature at the ground
--     is above 150. It is not a claim about what a plausible New England low is.
--
-- WHY THE DEPLOYED CODE IS UNAFFECTED (the house test). Read on origin/dev 1f58a9d8. No deployed
--   code names this table (`git grep weather_cold_range` returns nothing), and nothing is added to a
--   table it reads or writes except the foreign key's hold on public.spaces. A foreign key constrains
--   deletes of a space and updates of its id. No deployed code does either: the only writes to
--   spaces are UPDATEs of featured_photo_id (lambda/photos), which no key check touches. So the
--   CHECKs are armed at birth on an empty table with no deployed writer to break.
--
-- SAFETY / IDEMPOTENCY: CREATE TABLE IF NOT EXISTS with every constraint inside the one statement
--   (the table arrives whole or not at all), the stamp ON CONFLICT DO NOTHING. Re-running the whole
--   file is a clean no-op and does not move applied_at. IF NOT EXISTS is silent about a relation of
--   the same name that is something else, so step 0 refuses one that this migration did not make.
--   LOCKS. Creating the table locks nothing that exists. The foreign key takes a brief
--   SHARE ROW EXCLUSIVE lock on public.spaces, held to COMMIT: a write to spaces (setting a featured
--   photo) waits for milliseconds, reads do not wait at all.
--   lock_timeout: 5s turns a wait behind a long-open transaction into a fast failure that changed
--   nothing. Run it again.
--   Exactly ONE COMMIT, at the end. Do not wrap this file in BEGIN/ROLLBACK to "rehearse" it on a
--   shared database: its own COMMIT ends your transaction.
--
-- APPLY ORDER (README.md has the commands and the reason for each step):
--   1. Staging: pre -> sweep -> 0a -> post -> rehearse 0r -> pre -> 0a -> post.
--   2. Prod: Dave's first-hand OK for a prod database change, outside 07:00-08:00 UTC, after a
--      pre-apply copy: pre -> sweep -> 0a -> post.
--   3. ONLY THEN may a commit that names weather_cold_range under lambda/** reach dev. Once one is on
--      dev, the promote's prod schema gate refuses every promote by every session until this table is
--      on prod, and a missing relation cannot be waived.
--
-- ROLLBACK: 0r-rollback.sql. It refuses while any row exists.
--
-- NOT RUN ANYWHERE by the lane that wrote it. No statement in this file has met PostgreSQL.
--
-- Usage: psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f 0a-additive-ddl.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. Refuse a relation of this name that this migration did not make. ──────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relname = 'weather_cold_range')
     AND NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-wxcoldband-001') THEN
    RAISE EXCEPTION 'v5-wxcoldband-001 0a refused, nothing changed: a relation named public.weather_cold_range exists and this migration has no stamp.'
      USING HINT = 'CREATE TABLE IF NOT EXISTS would keep it silently in whatever shape it has. Find what created it; do not edit this guard.';
  END IF;
END $$;

-- ── 1. The table, whole. ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.weather_cold_range (
  space_id       uuid         NOT NULL,                -- the place the forecast is for (C1)
  night_date     date         NOT NULL,                -- ET civil day the night BEGINS on (C2)
  init_time      timestamptz  NOT NULL,                -- when the forecast run started (C3)
  p10_min_f      numeric(5,2) NOT NULL,                -- cold end: lowest hourly 10th percentile, F (C4)
  p50_min_f      numeric(5,2),                         -- middle: lowest hourly median, F; NULL = not pulled (C4)
  leads_read     smallint     NOT NULL,                -- hourly steps that went into the minimum (C5)
  leads_expected smallint     NOT NULL,                -- hourly steps of the night this run covers (C5)
  created_at     timestamptz  NOT NULL DEFAULT now(),  -- the freshness stamp, database clock (C6)

  CONSTRAINT weather_cold_range_pkey PRIMARY KEY (space_id, night_date, init_time),

  -- C8. Derived rows go with their place; this table has no deleted_at to protect.
  CONSTRAINT weather_cold_range_space_id_fkey
    FOREIGN KEY (space_id) REFERENCES public.spaces(id) ON DELETE CASCADE,

  -- C11. The only validation between the writer and the Today card.
  CONSTRAINT weather_cold_range_leads_chk
    CHECK (leads_read >= 1 AND leads_read <= leads_expected),
  CONSTRAINT weather_cold_range_p10_le_p50_chk
    CHECK (p50_min_f IS NULL OR p10_min_f <= p50_min_f),
  CONSTRAINT weather_cold_range_fahrenheit_chk
    CHECK (p10_min_f > -100 AND p10_min_f < 150 AND (p50_min_f IS NULL OR p50_min_f < 150))
);

-- The primary key (space_id, night_date, init_time) already serves the one read there is: this
-- place, tonight, newest run first. No secondary index, for weather_daily's reason: an unused index
-- on a table written every morning is pure write cost, and a second UNIQUE index could become the
-- conflict arbiter nobody named.

COMMENT ON TABLE public.weather_cold_range IS
  'V5-WXCOLDBAND-001. The forecast cold range for a night at a Space: the lowest hourly 10th and 50th percentile of the WeatherNext 3 ensemble 2 m temperature between 18:00 and 08:00 America/New_York, one row per night per forecast run. Written each morning by ONE job on the owner''s Mac (INSERT only; rows are never updated or soft-deleted: derived, regenerable data) and read by the daily-plan read for the Today card, which shows nothing when tonight has no complete row. Display only: nothing alerts off this table.';
COMMENT ON COLUMN public.weather_cold_range.night_date IS
  'ET civil day (America/New_York) the night BEGINS on: the night of 2026-10-13 runs 18:00 that day to 08:00 on the 14th. Not UTC, not the day the row was written.';
COMMENT ON COLUMN public.weather_cold_range.init_time IS
  'When the forecast run started (its initialisation instant). A later run for the same night is another row. The read takes the newest for tonight.';
COMMENT ON COLUMN public.weather_cold_range.p10_min_f IS
  'Fahrenheit. The LOWEST value, over the night''s hourly forecast steps, of the ensemble''s 10th percentile 2 m temperature: the cold end of the range. The minimum of an hourly percentile, which is not the 10th percentile of the night''s minimum.';
COMMENT ON COLUMN public.weather_cold_range.p50_min_f IS
  'Fahrenheit. The same for the 50th percentile: the middle of the range. NULL = the job did not pull it.';
COMMENT ON COLUMN public.weather_cold_range.leads_read IS
  'How many hourly forecast steps went into the minimum (the fewest, if the two percentiles differ). Complete only when equal to leads_expected; a minimum over fewer steps can miss the coldest hour.';
COMMENT ON COLUMN public.weather_cold_range.leads_expected IS
  'How many hourly steps of the night window (18:00 to 08:00 America/New_York) this run covers: 15, or 14 and 16 on the two clock-change nights, fewer for a run that started after the night began.';
COMMENT ON COLUMN public.weather_cold_range.created_at IS
  'When the row landed, on the database clock. The Today card''s freshness stamp for this number; never sent by the writer.';

-- ── 2. The stamp. Same transaction as the DDL: "applied" and "armed" are one event. ───────────────
INSERT INTO public.schema_version (version, description)
VALUES ('5.0.0-wxcoldband-001',
        'WXCOLDBAND: V5-WXCOLDBAND-001. New table weather_cold_range, the forecast cold range for a '
        'night at a Space, one row per night per forecast run: space_id, night_date (ET civil day the '
        'night begins on), init_time, p10_min_f, p50_min_f (nullable), leads_read, leads_expected, '
        'created_at DEFAULT now(). PRIMARY KEY (space_id, night_date, init_time). ONE foreign key, '
        'space_id to spaces(id) ON DELETE CASCADE. Three CHECKs armed at birth: '
        'weather_cold_range_leads_chk, weather_cold_range_p10_le_p50_chk, '
        'weather_cold_range_fahrenheit_chk. Written by one job on the owner''s Mac, INSERT only; '
        'read by the daily-plan read for the Today card. No created_by, no deleted_at, no '
        'updated_at, no trigger, no row security, no grant, no row written. ZERO changes to any '
        'existing table.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
