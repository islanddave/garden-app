-- 0a-additive-ddl.sql
-- V4-ANCHORKIND-DERIVED-001 — widen public.harvest_watch_dismissal's anchor_kind CHECK to admit
-- 'derived'.
--
-- STATUS AT AUTHORING (2026-08-13): AUTHORED, NOT APPLIED. Not applied to staging, not applied to
-- prod. The lane that wrote this file executed nothing; sequencing is the orchestrator's
-- (staging -> rehearse 0r -> re-apply -> prod).
--
-- ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────────
-- v4-harvwatch-001/0a-additive-ddl.sql:138 closed anchor_kind over the three anchor tiers that
-- existed when the dismissal table was designed:
--
--     CHECK (anchor_kind IS NULL OR anchor_kind IN ('observed', 'sibling', 'calendar'))
--
-- V4-ANCHORBASE-001 then added a FOURTH tier, `derived`. lambda/harvests/watch-route.js writes the
-- served row's anchor kind straight into that column when a user taps "not yet"
-- (buildDismissalSnapshot -> anchor_kind), so the FIRST dismissal of a derived-anchored row would
-- violate the constraint and return a 500 — on the one user action the whole dismissal table exists
-- to capture. Found by the impression lane 2026-08-12 and made a blocking prerequisite of the flip
-- by the expert consult (project-state/anchor-consult-20260812.md, flip package item 2).
--
-- public.watch_impression already got this right: its own CHECK
-- (v4-watchimpression-001/0a-additive-ddl.sql:143) lists all four kinds. This migration brings the
-- older table into line with the newer one, so the numerator (dismissals) and the denominator
-- (impressions) can both record a derived row.
--
-- ── WHY THIS IS SAFE IN EITHER DEPLOY ORDER ────────────────────────────────────────────────────
-- WIDENING a CHECK is backward-compatible in the direction that matters. The general hazard is the
-- reverse one (arming a constraint the still-deployed writer violates); here the still-deployed
-- writer emits only the three old values, all of which remain legal, and the constraint is
-- re-validated against existing rows that are by definition already within the old, narrower set.
-- So there is no ordering hazard against deploy-lambda.yml and no ordering hazard against the SPA.
--
-- It is also INERT until two further, separate decisions land: nothing can write 'derived' into
-- this column while watch.js's DERIVED_ANCHOR_ENABLED is false. Applying this migration does not
-- flip anything and does not make a derived row appear anywhere.
--
-- ── APPLY-TIME NOTE ────────────────────────────────────────────────────────────────────────────
-- ALTER TABLE ... ADD CONSTRAINT takes an ACCESS EXCLUSIVE lock and validates the whole table.
-- harvest_watch_dismissal is a young, small table (tens of rows), so the scan is instantaneous; no
-- NOT VALID / VALIDATE split is warranted and adding one would leave a period during which the
-- constraint was unenforced for no benefit.

BEGIN;

ALTER TABLE public.harvest_watch_dismissal
  DROP CONSTRAINT IF EXISTS harvest_watch_dismissal_anchor_chk;

ALTER TABLE public.harvest_watch_dismissal
  ADD CONSTRAINT harvest_watch_dismissal_anchor_chk
  CHECK (anchor_kind IS NULL OR anchor_kind IN ('observed', 'sibling', 'calendar', 'derived'));

COMMENT ON CONSTRAINT harvest_watch_dismissal_anchor_chk ON public.harvest_watch_dismissal IS
  'V4-ANCHORKIND-DERIVED-001. Closed over lambda/harvests/watch.js TIER_RANK — the four anchor '
  'tiers a served watch row can rest on. Widened from three to admit the V4-ANCHORBASE-001 '
  'derived tier; a dismissal POST on a derived-anchored row 500d against the old definition. '
  'Kept in lockstep with public.watch_impression''s watch_impression_anchor_chk.';

COMMIT;
