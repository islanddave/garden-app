-- 0a-additive-ddl.sql
-- V4-WATCHEXCLUDEDLOG-001 — public.watch_exclusion.
-- Canon: harvest-panel-decisions-20260812.md Q2:65, the rider the panel marked MANDATORY —
-- "persist the exclusion breakdown, do not merely return it in the response."
--
-- NOT APPLIED as of authoring (2026-08-18). This lane executed no DDL anywhere — not on staging,
-- not on prod. Apply order per gates.yml: staging -> rehearse 0r -> re-apply -> prod -> dev push ->
-- promote. CI's integration job branches off STAGING WITHOUT applying migrations, so this must land
-- on staging BEFORE the dev push or the writer's integration coverage reads as infra flake rather
-- than a missing relation.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- WHAT THIS TABLE IS — THE NOT-SHOWN SET
--
-- public.watch_impression (V4-WATCHIMPRESSION-001) records what the watch list SERVED. This records
-- what it DECLINED, and why, with the same grain and the same model_version. The pair is the whole
-- census of one resolver run: every live planting is in exactly one of them on any given day.
--
-- The panel's reason for demanding it is specific and is not "more data is nice". Panel Q2
-- restricted the sibling anchor to `single`-habit crops, and that restriction removed tomato (27)
-- and pepper (21) — the ONLY two crops that have ever reached n>=20 first-picked plantings in the
-- entire database, i.e. the sole viable calibration cohorts. Those rows now leave the list as
-- `no_anchor` exclusions. Without a row-level record, the model's own false-negative region — the
-- plantings it declined to watch that then went on to be picked — is unrecoverable, and that region
-- is precisely what the dismissal table was built to measure. A resolver that silently stops
-- watching a crop looks identical, in the data, to a crop nobody grew.
--
-- WHY THE EXISTING CloudWatch LINE IS NOT THIS. watch-route.js already emits one
-- {metric:'watch_excluded', excluded:{reason:count}} line per invocation. That line is an AGGREGATE
-- CENSUS: it carries no plant_id, so it can never be joined to event_log to ask "was the model
-- right to decline this one?", it cannot be read in SQL alongside the impression and dismissal
-- tables, and it lives under a log-retention policy rather than in the database. It stays — it is
-- the cheap per-request heartbeat — but it is not persistence in the sense the rider requires.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- GRAIN, AND WHY `reason` IS IN THE UNIQUE KEY
--
-- One row = one planting DECLINED for one reason, per user, per ET civil day. UNIQUE
-- (user_id, plant_id, evaluated_on, reason) paired with the writer's ON CONFLICT DO NOTHING, exactly
-- the impression table's device: Dave opens Today many times a day and without the guard this would
-- measure phone-checking frequency rather than the resolver's verdict.
--
-- reason is IN the key for the same reason `region` is in the impression table's: a verdict
-- legitimately changes within one day. A planting that is a candidate at breakfast and is dismissed
-- at noon was genuinely both things that day, and both statements belong on the record. The analysis
-- dedupes to a per-day verdict with a rank over reasons when it needs exactly one row.
--
-- DELIBERATE OVERLAP WITH THE IMPRESSION LOG. The `dismissed` and `basis_unchanged` verdicts also
-- produce a watch_impression row with region='snoozed', because those rows ARE served (inside the
-- tail's collapsed Snoozed subgroup). That is not double-counting to be cleaned up: the impression
-- table answers "was it on the screen", this one answers "why was it not a candidate", and a snoozed
-- row is simultaneously yes to the first and excluded by the second. Keeping this table a COMPLETE
-- census of buildWatchList's verdicts is what makes "every live planting is in exactly one verdict
-- per day" a checkable invariant instead of a claim with two silent exemptions.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- GROWTH. Unlike impressions (~40-50 rows/day — only the served slice), this logs the DECLINED
-- majority: at 253 live plantings the steady state is ~200-250 rows/user/day, roughly 80k/year for
-- one user. Still small in absolute terms, and structurally capped by the UNIQUE constraint at
-- (live plantings x distinct reasons) per user per day. Sized deliberately, not by accident: if that
-- ever becomes a cost, the lever is a retention window on evaluated_on, NOT sampling — a sampled
-- denominator is not a denominator.
--
-- NO created_by COLUMN, DELIBERATELY — same absence and same rationale as watch_impression and
-- weather_daily. The V4-OWNERSHIP-001 transfer trigger fires on created_by across 9 tables and reads
-- a NULL -> value write as an ownership transfer. user_id here records WHOSE queue was evaluated,
-- which is not an ownership claim. Do not add created_by "for auditing".
--
-- CHECK BLAST RADIUS. The writer batch-inserts a whole request in ONE statement, so a CHECK
-- violation drops that request's entire batch (non-fatally — the GET is unaffected, a warning is
-- logged). Only the one closed vocabulary is pinned: reason, whose values are exhaustively the
-- `eligible: false` returns of watch.js classifyWatchCandidate. Adding a new exclusion reason there
-- requires widening this CHECK FIRST, or the log silently stops recording the day that reason starts
-- firing — which is the day it would most need recording.

BEGIN;

CREATE TABLE IF NOT EXISTS public.watch_exclusion (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- WHOSE queue was evaluated. Clerk sub. Not created_by — see the ownership note above. Dismissals
  -- are user-scoped, so Dave's and Jen's exclusion sets genuinely differ.
  user_id       text        NOT NULL,
  plant_id      uuid        NOT NULL REFERENCES public.plants(id),

  -- The ET CIVIL DAY (America/New_York) the resolver declined this planting — stamped from the same
  -- bounds-CTE et_today the candidate query computes, so an exclusion, an impression and a dismissal
  -- recorded in one request all agree on what day it was. A UTC day would split one evening's queue
  -- across two "days" for five hours every night.
  evaluated_on  date        NOT NULL,

  -- The verdict. Closed at watch.js classifyWatchCandidate — see the CHECK below.
  reason        text        NOT NULL,

  -- The same constant the dismissal and impression rows carry (watch.js WATCH_MODEL_VERSION),
  -- written by the same request. The partition key that keeps the refit inside one model generation
  -- and never across two.
  model_version text        NOT NULL,

  created_at    timestamptz NOT NULL DEFAULT now(),

  -- Exhaustively the `eligible: false` reasons of classifyWatchCandidate as of 2026-08-18. Widen
  -- BEFORE adding a reason there, never after.
  CONSTRAINT watch_exclusion_reason_chk
    CHECK (reason IN ('no_today', 'habit_not_watched', 'already_harvested', 'dismissed',
                      'no_anchor', 'not_yet_open', 'basis_unchanged')),

  -- The dedupe guard the writer's ON CONFLICT names. A plain UNIQUE constraint, not a partial index:
  -- nothing here is soft-deleted, so the natural key needs no WHERE clause — and a constraint keeps
  -- the conflict target a column list, which cannot be quietly re-arbitrated by a second index the
  -- way an index-name target can.
  CONSTRAINT uq_watch_exclusion_day UNIQUE (user_id, plant_id, evaluated_on, reason)
);

-- LEAN INDEXING, one secondary index only, mirroring watch_impression. The read shape is the refit's
-- per-plant time series — "every day planting P was declined, joined to its eventual event_log
-- pick" — which is exactly (plant_id, evaluated_on). The UNIQUE constraint's index (user_id leading)
-- serves the writer's conflict check and any per-user scan. NO reason or model_version index on
-- purpose: the refit reads through the per-plant join and filters after it, and an unused index on
-- the highest-write-rate table in this family is pure write cost. Add one later WITH a query plan,
-- not on a guess.
CREATE INDEX IF NOT EXISTS idx_watch_exclusion_plant_day
  ON public.watch_exclusion (plant_id, evaluated_on);

COMMENT ON TABLE public.watch_exclusion IS
  'V4-WATCHEXCLUDEDLOG-001. One row per planting DECLINED by the watch resolver, per reason, per '
  'user, per ET civil day — the NOT-SHOWN counterpart to watch_impression''s served set (panel Q2 '
  'mandatory rider: persist the exclusion breakdown, do not merely return it). Written non-fatally '
  'by the watch GET path; deduped per day by uq_watch_exclusion_day + ON CONFLICT DO NOTHING. '
  'Together with watch_impression it is the complete census of one resolver run. Join plant_id to '
  'event_log first picks to measure the model''s false-negative region — the plantings it declined '
  'to watch that were picked anyway. Partition by model_version, never across.';

COMMENT ON COLUMN public.watch_exclusion.evaluated_on IS
  'ET civil day (America/New_York) the resolver declined the planting — the queue''s et_today, not UTC, not the write instant.';
COMMENT ON COLUMN public.watch_exclusion.reason IS
  'classifyWatchCandidate verdict: no_today | habit_not_watched | already_harvested | dismissed | '
  'no_anchor | not_yet_open | basis_unchanged. dismissed/basis_unchanged rows ALSO carry a '
  'watch_impression region=snoozed row — deliberate, the two tables answer different questions.';
COMMENT ON COLUMN public.watch_exclusion.model_version IS
  'watch.js WATCH_MODEL_VERSION as evaluated — the same constant the dismissal and impression rows '
  'record, joining the declined set to the served set within one model generation.';

COMMIT;
