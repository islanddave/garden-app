-- 0a-additive-ddl.sql
-- V4-WATCHIMPRESSION-001 — public.watch_impression.
-- Canon: harvest-panel-decisions-20260812.md Q3 ("The highest-value missing piece in the whole
-- design") and its filing instruction: "one insert per render, same model_version, distinguishing
-- top-5 from tail; the positive label derives from event_log with no new UI."
--
-- NOT APPLIED as of authoring (2026-08-12). This lane executed no DDL anywhere — not on staging,
-- not on prod. Apply order per gates.yml: staging -> rehearse 0r -> re-apply -> prod -> dev push ->
-- promote. CI's integration job branches off STAGING WITHOUT applying migrations, so this must land
-- on staging BEFORE the dev push or the writer's integration coverage reads as infra flake rather
-- than a missing relation.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- WHAT THIS TABLE IS — THE DENOMINATOR
--
-- public.harvest_watch_dismissal records every "not yet" tap with the model's claim frozen at the
-- moment of observation. It is exemplary as a NUMERATOR. But nothing anywhere records which rows
-- were SHOWN — so every rate the §4.4 dismissal-calibration refit wants to compute has an
-- unrecoverable denominator: a row that was correct-but-not-tapped is indistinguishable from a row
-- that was never seen. Both look like "no dismissal". The panel called this the highest-value
-- missing piece in the whole design, and it cannot be reconstructed retroactively — the watch list
-- is computed fresh per request from mutable state (plantings, dismissals, reference data all
-- move), so yesterday's queue is gone unless it was written down when it was served.
--
-- One row here = one planting SERVED in one region of one GET /api/harvests/watch response on one
-- ET civil day. The positive label needs no new capture: join to event_log's eventual first-pick
-- date, exactly as the dismissal table does. The three-way join (impressions x dismissals x picks)
-- is what turns "11.8% calibrated" from an anecdote into a rate with a real denominator.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- REGION SEMANTICS — SERVED, NOT SEEN, AND THAT IS WRITTEN DOWN HONESTLY
--
-- The writer runs SERVER-side in the GET path. The server knows what it SERVED, not what a human
-- looked at. The region column is what keeps the analysis honest about that gap:
--
--   top5     in the 5 visible slots after the client's slot allocation (MAX_WATCH_ROWS=5 with the
--            panel-Q2 per-project cap of 2, mirrored deterministically server-side from
--            src/lib/harvestWatch.js selectWatchDisplay). These render without any user action —
--            served ~= seen is a fair reading for this region only.
--   tail     served in the response but landing in the collapsed overflow (past slot 5, or
--            capped-out by the per-project quota). SERVED-IN-RESPONSE, NOT NECESSARILY SEEN — the
--            client expands the tail on tap, and there is NO client beacon in v1 to say whether it
--            ever did. Any rate computed over 'tail' impressions is a rate over opportunities, not
--            over views, and must say so.
--   snoozed  in the response's snoozed payload (an active "not yet" suppression). Rendered only
--            inside the tail's collapsed "Snoozed" subgroup; recorded because a dismissal that
--            returns and is re-dismissed needs its intervening suppressed days in the denominator
--            story too.
--
-- A v2 client beacon could upgrade 'tail' to a real view event; the region vocabulary leaves room
-- for that without lying about v1.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- WHY THE UNIQUENESS GUARD EXISTS, AND WHY region IS PART OF IT
--
-- UNIQUE (user_id, plant_id, shown_on, region), paired with the writer's ON CONFLICT DO NOTHING.
-- Dave opens Today many times a day; without the guard, every open would mint another row and
-- "impressions per day" would measure phone-checking frequency, not exposure. The DAY is the
-- honest exposure grain — the queue only re-ranks daily (days_watching moves at midnight ET) — so
-- N same-day opens collapse to one row.
--
-- region is IN the key deliberately: a mid-day dismissal legitimately moves rows between regions
-- within one day (a top5 row gets dismissed -> reappears as 'snoozed'; the first tail row is
-- promoted to 'top5'). One row per region per day records that both statements were true that day.
-- The analysis dedupes to a per-day verdict with a rank over regions when it needs one row.
--
-- The guard also caps table growth structurally: at most (live plantings x 3) rows per user per
-- day, in practice ~40-50/day for Dave — ~15k rows/year. Small forever.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- SURROGATE id IS bigint IDENTITY, NOT uuid — deliberately unlike harvest_watch_dismissal. That
-- table's uuid PK is addressed from the client (DELETE /watch/dismissals/:id). Impression rows are
-- never addressed individually by anything: no undo, no client route, no cross-system reference.
-- An 8-byte ascending key keeps the PK index half the size and append-friendly on the highest-row-
-- count table this feature family will ever own. The natural key is the UNIQUE constraint above;
-- the surrogate exists so the row has a stable identity in ad-hoc analysis joins.
--
-- NO created_by COLUMN, DELIBERATELY — same absence as weather_daily. The V4-OWNERSHIP-001
-- transfer trigger fires on created_by across 9 tables and treats a NULL -> value write as an
-- ownership transfer. user_id here records WHO WAS SERVED the list (matching the dismissal table's
-- "who observed" convention), which is not an ownership claim, and naming it user_id keeps this
-- table entirely outside that machinery. Do not add created_by "for auditing" — created_at plus
-- user_id already say everything an audit could ask.
--
-- CHECK BLAST RADIUS NOTE. The writer batch-inserts a whole response in ONE statement, so a CHECK
-- violation drops the entire day's batch (non-fatally — the GET is unaffected, a warning is
-- logged). That is why only two vocabularies are pinned and nothing speculative: region (this
-- table's own contract) and anchor_kind (closed at watch.js TIER_RANK). anchor_kind includes
-- 'derived' even though DERIVED_ANCHOR_ENABLED is false today — flipping that flag must not
-- silently zero the impression log. (harvest_watch_dismissal's CHECK predates the derived tier and
-- omits it; flagged separately, not this migration's problem to fix.) Adding a fifth tier to
-- TIER_RANK requires widening this CHECK first.

BEGIN;

CREATE TABLE IF NOT EXISTS public.watch_impression (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- WHO WAS SERVED the list. Clerk sub. Not created_by — see the ownership note above. The watch
  -- queue is per-user (dismissals are user-scoped, so Dave's and Jen's queues genuinely differ),
  -- which is why the impression is too.
  user_id       text        NOT NULL,
  plant_id      uuid        NOT NULL REFERENCES public.plants(id),

  -- The ET CIVIL DAY the row was served — America/New_York, NOT UTC, and not the write instant.
  -- Stamped from the same bounds-CTE et_today the candidate query computes, so an impression and a
  -- dismissal recorded in the same request agree on what day it was. A UTC day here would split
  -- one evening's queue across two "days" for five hours every night, exactly the boundary bug the
  -- weather_daily "date" column documents.
  shown_on      date        NOT NULL,

  -- 1-based display position WITHIN the region: 1..5 for top5, 1..N in rank order for tail (tail
  -- position governs how many reveal-taps stand between the row and a human — a tail row at
  -- position 60 is three taps deep). NULL for snoozed: that list orders by return date, and a rank
  -- there would imply a priority that does not exist.
  slot          smallint,

  region        text        NOT NULL,

  -- Same constant the dismissal table records (watch.js WATCH_MODEL_VERSION), written by the same
  -- request — the partition key that lets the refit join numerator to denominator within one model
  -- generation and never across two.
  model_version text        NOT NULL,

  -- The anchor tier the model cited for the served row, frozen at serve time for the same
  -- leakage/drift reasons the dismissal table freezes its snapshot: recomputing later would read
  -- corrected reference data. NULL for snoozed rows — a suppressed row's frozen anchor already
  -- lives on its dismissal row; duplicating it here would let the two drift apart.
  anchor_kind   text,

  -- When the model said the watch opened, as served. With shown_on this gives the row's watch age
  -- on the day it was served — the ranking coordinate — without re-deriving it from mutable state.
  -- NULL for snoozed rows, same reason as anchor_kind.
  check_from    date,

  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT watch_impression_region_chk
    CHECK (region IN ('top5', 'tail', 'snoozed')),
  -- Closed at watch.js TIER_RANK. Includes 'derived' ahead of the flag flip — see the blast-radius
  -- note above for why an out-of-vocabulary value must fail loudly here and not silently.
  CONSTRAINT watch_impression_anchor_chk
    CHECK (anchor_kind IS NULL OR anchor_kind IN ('observed', 'sibling', 'calendar', 'derived')),

  -- The dedupe guard the writer's ON CONFLICT names. A plain UNIQUE constraint, not a partial
  -- index: nothing here is soft-deleted, so the natural key needs no WHERE clause — and a
  -- constraint keeps the conflict target a column list, which cannot be quietly re-arbitrated by a
  -- second index the way an index-name target can.
  CONSTRAINT uq_watch_impression_day UNIQUE (user_id, plant_id, shown_on, region)
);

-- LEAN INDEXING, one secondary index only. The read shape is the refit's per-plant time series —
-- "every day planting P was served, joined to its dismissals and its eventual event_log pick" —
-- which is exactly (plant_id, shown_on). The UNIQUE constraint's index (user_id leading) serves
-- the writer's conflict check and any per-user scan. NO model_version index on purpose: the refit
-- reads through the per-plant join and filters model_version after it, and an unused index on the
-- table with the highest write rate in this family is pure write cost — the dismissal table's
-- (model_version, observed_on) index can be mirrored here later WITH a query plan to justify it,
-- not on a guess.
CREATE INDEX IF NOT EXISTS idx_watch_impression_plant_day
  ON public.watch_impression (plant_id, shown_on);

COMMENT ON TABLE public.watch_impression IS
  'V4-WATCHIMPRESSION-001. One row per planting SERVED per region of a GET /api/harvests/watch '
  'response per user per ET civil day — the DENOMINATOR the dismissal-calibration refit was '
  'missing (panel Q3: a correct-but-not-tapped row was indistinguishable from a never-seen row). '
  'Written non-fatally by the watch GET path; deduped per day by uq_watch_impression_day + ON '
  'CONFLICT DO NOTHING. region=tail/snoozed means served-in-response, NOT necessarily seen (the '
  'client expands on tap; no view beacon in v1). Join plant_id to event_log first picks for the '
  'positive label; partition by model_version, never across.';

COMMENT ON COLUMN public.watch_impression.shown_on IS
  'ET civil day (America/New_York) the row was served — the queue''s et_today, not UTC, not the write instant.';
COMMENT ON COLUMN public.watch_impression.region IS
  'top5 = in the 5 visible slots post slot-cap (served ~= seen). tail = in the collapsed overflow '
  '(served, not necessarily seen). snoozed = in the suppressed payload.';
COMMENT ON COLUMN public.watch_impression.slot IS
  '1-based position within the region (top5/tail); NULL for snoozed, whose order is a return date, not a rank.';
COMMENT ON COLUMN public.watch_impression.model_version IS
  'watch.js WATCH_MODEL_VERSION as served — the same constant the dismissal row records, joining '
  'numerator to denominator within one model generation.';

COMMIT;
