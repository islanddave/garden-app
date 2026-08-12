-- 0a-additive-ddl.sql
-- V4-HARVSURFACE-001 slice 1 — public.harvest_watch_dismissal.
-- Canon: harvest-two-section-design-V100-20260811.md §3.5 (persistence queue) and §8 (negative class).
--
-- NOT APPLIED as of authoring (2026-08-12). Apply order per gates.yml: staging -> rehearse 0r ->
-- re-apply -> dev push -> prod -> promote. CI's integration job branches off STAGING WITHOUT
-- applying migrations, so this must land on staging BEFORE the dev push or the new route's
-- integration coverage reads as infra flake rather than a missing relation.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- WHY THIS TABLE EXISTS, AND WHY IT IS NOT A UI HIDE
--
-- The "not yet" control on a watch-list row looks like a dismissal and is really a MEASUREMENT.
--
-- The harvest dataset has never held a single negative-class sample. Every label in it is of the
-- form "Dave picked crop C on date D" — there is no record anywhere of a moment when he looked at a
-- plant and it was NOT ready. You cannot calibrate a ripeness model from positives alone, and that
-- is precisely why the shipped estimate sits at 11.8% calibrated with a 22-day median error (30 of
-- 34 picks landed BEFORE the predicted window opened) and has no mechanism to improve. Every
-- proposal to fix the estimate has died on the same rock: there is nothing to fit against.
--
-- A "not yet" tap is the first negative label this system can ever collect. At a KNOWN instant, on
-- a KNOWN planting, a human LOOKED and reported not-ready. One tap, at the moment of an actual
-- observation, is the cheapest labelled sample the garden will ever produce.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- WHY THE MODEL SNAPSHOT COLUMNS ARE HERE AND NOT DERIVED LATER
--
-- The obvious cheap design is three columns (user_id, plant_id, dismissed_at) — the shape
-- public.inactive_project_dismissals already uses — and then recompute the model's features later
-- when you want to train. That design produces samples that CANNOT be used, for two independent
-- reasons, and this is the single most important paragraph in this file:
--
--   1. LABEL LEAKAGE. By the time you recompute, the planting's eventual first-harvest date is in
--      the data. Any feature recomputed from current state is contaminated by the answer.
--   2. FEATURE DRIFT. The inputs are not stable. crop_types.days_to_maturity_min, dtm_basis and
--      set_to_first_pick_days get edited as Dave corrects the reference data; plants.sown_at and
--      transplanted_at get corrected too; and the derivation constants in lambda/harvests/watch.js
--      move by design. A sample whose features change after collection is not a sample.
--
-- So the anchor_* / expected_days / lead_days / check_from / days_watching columns freeze the model's
-- CLAIM AS IT STOOD at the observation. They are written SERVER-SIDE from the server's own candidate
-- row — never from client-supplied fields, because a client that could post its own snapshot could
-- poison the calibration set, and a stale PWA bundle would post an old model's numbers stamped with
-- the current version string.
--
-- model_version partitions the set so a constant change in watch.js cannot silently mix labels
-- produced by incompatible models. Without it the first tuning pass corrupts every prior sample.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- HOW A ROW BECOMES A TRAINING SAMPLE
--
-- Features: this row (frozen at observation).
-- Label:    supplied later, from event_log — the planting's eventual first harvest date. NO new
--           capture is needed; that data already exists and keeps arriving on its own.
-- Target:   days_from_observation_to_first_pick = first_pick_date - observed_on, which is > 0 by
--           construction for every dismissal (Dave said not-ready, and the pick came afterwards).
--           The current model's error on that sample is (check_from - first_pick_date).
--
-- A dismissal on a planting that is NEVER harvested is not waste either — it is a RIGHT-CENSORED
-- observation ("not ready as of observed_on, outcome unobserved"), which survival-style calibration
-- consumes directly. This is why undone_at is a soft-undo and rows are never hard-deleted: an undo
-- is itself signal (the user changed their mind), and deleting samples biases the set toward the
-- observations someone felt confident about.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- CROSS-DEVICE BY CONSTRUCTION. Dave's standing rule: user-meaningful state is server-side, never
-- device-local. A dismissal tapped on the phone in the garden must be gone from the tablet on the
-- kitchen counter. localStorage would also have destroyed the calibration value entirely — samples
-- would be scattered across devices, unqueryable, and lost on cache clear.
--
-- OWNERSHIP COLUMN IS user_id, NOT created_by — deliberately, matching the
-- inactive_project_dismissals precedent. The V4-OWNERSHIP-001 transfer trigger fires on created_by
-- across 9 tables and treats NULL -> value as a transfer; naming this column user_id keeps this
-- table entirely outside that machinery. It is also semantically right: this records WHO OBSERVED,
-- which is not a claim of ownership over the planting. Jen dismissing a row must not touch Dave's
-- queue, and both observations are independently valid calibration samples.

BEGIN;

CREATE TABLE IF NOT EXISTS public.harvest_watch_dismissal (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- WHO OBSERVED. Clerk sub. See the ownership note above for why this is not created_by.
  user_id               text        NOT NULL,
  plant_id              uuid        NOT NULL REFERENCES public.plants(id),
  project_id            uuid,

  -- WHEN THE EYES WERE ON THE PLANT, in America/New_York, computed server-side. Separate from
  -- dismissed_at because this codebase already enforces that distinction for harvests: event_date
  -- is the truth, created_at is bookkeeping, and ~30% of harvests are backdated. The same will be
  -- true here — Dave's workflow is read the list, walk out, come back, then log. observed_on is the
  -- ONLY time coordinate the calibration math may use.
  observed_on           date        NOT NULL,
  dismissed_at          timestamptz NOT NULL DEFAULT now(),

  -- Soft undo. NEVER hard-delete a row: an undo is signal, and deleting samples biases the set.
  undone_at             timestamptz,

  -- Why the row left the queue. 'not_yet' is the calibration-bearing case — the others are data
  -- corrections and must be EXCLUDED when fitting, which is exactly why they are distinguishable
  -- rather than all collapsed into one dismissal. A row dismissed as 'wrong_target' is not evidence
  -- that the crop was unripe.
  reason                text        NOT NULL DEFAULT 'not_yet',
  note                  text,

  -- ── Frozen model snapshot (server-written; see the leakage/drift note above) ──────────────────
  model_version         text        NOT NULL,
  crop_type_slug        text,
  variety_id            uuid,
  anchor_kind           text,
  anchor_date           date,
  anchor_basis          text,
  anchor_basis_shifted  boolean,
  expected_days         smallint,
  lead_days             smallint,
  check_from            date,
  days_watching         smallint,

  -- RESERVED, and read by the route from day one so it is not dead weight. NULL means "suppress for
  -- the rest of this grow year", which is what the design canon specifies (§3.5 makes dismissal a
  -- queue EXIT). A date means "re-open the watch on that day".
  --
  -- Flagged for Dave, because the canon may not have thought this through: under the NULL default,
  -- one "not yet" tap on a melon in early August silently ends that planting's watch for the entire
  -- season — including the three weeks when the fruit actually arrives. That is the same
  -- trains-disbelief failure the persistence queue was designed to replace, just triggered by the
  -- user instead of by a 7-day window. Flipping the default to a bounded re-check needs only a
  -- constant change in the route, NOT another migration. The column exists so that decision is
  -- cheap.
  suppressed_until      date,

  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT harvest_watch_dismissal_reason_chk
    CHECK (reason IN ('not_yet', 'not_mine', 'wrong_target')),
  CONSTRAINT harvest_watch_dismissal_anchor_chk
    CHECK (anchor_kind IS NULL OR anchor_kind IN ('observed', 'sibling', 'calendar'))
);

-- ONE sample per user per planting per OBSERVATION DAY, active rows only.
--
-- Deliberately NOT unique on (user_id, plant_id): that would cap the table at one sample per
-- planting per season and SILENTLY SWALLOW a genuine second observation a week later, which is the
-- most valuable kind of sample there is (same planting, same model, two labelled time points). Per
-- DAY is the right grain — it dedupes a double-tap without discarding a real re-check. The route
-- pairs this with ON CONFLICT DO NOTHING and returns the existing row, so a double-tap is a 200
-- rather than a 409 the UI would have to explain.
CREATE UNIQUE INDEX IF NOT EXISTS uq_harvest_watch_dismissal_active_day
  ON public.harvest_watch_dismissal (user_id, plant_id, observed_on)
  WHERE undone_at IS NULL;

-- Suppression lookup on the watch route: "which of this household's plantings are dismissed?"
CREATE INDEX IF NOT EXISTS idx_harvest_watch_dismissal_user_active
  ON public.harvest_watch_dismissal (user_id, plant_id)
  WHERE undone_at IS NULL;

-- Calibration extraction: scan a model generation's samples in observation order.
CREATE INDEX IF NOT EXISTS idx_harvest_watch_dismissal_model_observed
  ON public.harvest_watch_dismissal (model_version, observed_on);

COMMENT ON TABLE public.harvest_watch_dismissal IS
  'V4-HARVSURFACE-001. "Not yet" dismissals from the Today watch list. Dual purpose: (1) removes the '
  'row from the persistence queue cross-device; (2) the FIRST negative-class samples the harvest '
  'dataset has ever held. anchor_*/expected_days/lead_days/check_from/days_watching freeze the '
  'model claim at observation time — recomputing them later would leak the label and drift. Pair '
  'observed_on with the planting eventual first-harvest date in event_log to get a supervised '
  'sample; rows with no eventual harvest are right-censored, not waste. Never hard-delete; use '
  'undone_at.';

COMMIT;
