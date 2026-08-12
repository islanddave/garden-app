-- 0a-additive-ddl.sql
-- V4-ANCHORBASE-001 (BD-001a + BD0806-27) — public.plant_anchor_derivation.
-- Logic: lambda/harvests/anchorDerive.js. Measurement: scripts/measure-anchor-coverage.sql.
--
-- NOT APPLIED as of authoring (2026-08-12). Not on staging, not on prod. No DDL has been executed
-- anywhere by the authoring lane, and no derived anchor has been written to any environment.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- WHY A SEPARATE TABLE AND NOT derived_anchor_* COLUMNS ON public.plants
--
-- Columns on plants were the obvious design and they are the wrong one, for a reason that is
-- specific to this table rather than stylistic. public.plants carries FOUR row-level UPDATE
-- triggers, and a bulk backfill fires all of them on every touched row:
--
--   * set_updated_at            BEFORE UPDATE, every row -> plants.updated_at is rewritten. Every
--                               "what changed recently" read, cache-invalidation key and sync
--                               comparison in the app would see 64 plantings as freshly edited by
--                               Dave. They were not; a batch job wrote a guess about them.
--   * garden_node_bump          BEFORE UPDATE WHEN (old.* IS DISTINCT FROM new.*) -> plants.version
--                               increments. That column is an optimistic-concurrency token; bumping
--                               it wholesale invalidates client state and can surface as spurious
--                               write conflicts on rows nobody edited.
--   * prevent_ownership_transfer BEFORE UPDATE, every row. It passes here (it raises only when
--                               created_by actually changes, which this backfill never does), but a
--                               backfill that has to reason about an ownership trigger at all is
--                               already in a blast radius it does not need to be in.
--   * plants_entity_rename / plants_entity_softdel are column-scoped and would not fire, which is
--                               precisely the point: two of the four WOULD.
--
-- A standalone table has none of that. It also gives the marking rule its strongest possible form —
-- a derived anchor is not merely a flagged column beside sown_at, it is not in the same relation as
-- sown_at at all, so no query can select one while believing it selected the other. Rollback is a
-- DROP, and no row of user data is ever touched, before or after.
--
-- Precedent for the shape: public.inactive_project_dismissals and public.harvest_watch_dismissal —
-- standalone, `user_id` rather than `created_by`, and therefore entirely outside the
-- V4-OWNERSHIP-001 transfer trigger that guards created_by across nine tables.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- WHAT A ROW MEANS, AND WHAT IT DOES NOT
--
-- "For this planting, which has NO sown_at, transplanted_at or planted_out_at, here is the best
-- anchor date the system could infer, what it was inferred from, and how much to trust it."
--
-- It is NOT an observation, NOT something Dave entered, and NOT a substitute for one. The instant a
-- real date arrives on the planting, the derived row becomes stale by definition — the partial index
-- and the 0c validation both check for that, and the app path (never raw SQL) is what writes the
-- real date.
--
-- HONEST ACCOUNTING OF WHAT THIS TABLE WILL HOLD, measured read-only against live prod 2026-08-12
-- by running lambda/harvests/anchorDerive.js over live rows (scripts/measure-anchor-coverage.{sql,
-- mjs}). Household = Dave; Jen has zero live plantings, so these are Dave's figures, not a
-- household average. Of the 64 anchorless live plantings:
--       sow events        0   (event_log holds zero 'sowing' and zero 'seed_soak' rows)
--       transplant events 0   (all 110 plantings with a transplant event already have the column —
--                              the app writes it when the event is logged, so this tier cannot fire)
--       nursery proxies   7   (potting_up / hardening_off / brought_outside)
--       add-date baseline 57  -> 89% of every row this table will hold is the baseline guess.
-- And the baseline is not the ~98% Dave estimated: over his 112 non-deleted plantings holding both
-- an add-date and a transplant date, only 53 (47.3%) fall within +/-7 days — median +9, p25 +2,
-- p75 +22, range -17..+48. Anything consuming `confidence='baseline'` is consuming a coin flip with
-- a date attached, which is why confidence is a stored column and not an inferred one.
--
-- The residual after all three tiers is ZERO, and that is the uncomfortable part: every planting has
-- a created_at, so the floor never fails and "anchor coverage" hits 100% the moment this is applied.
-- Coverage therefore stops being a quality signal. Read the baseline SHARE instead.

BEGIN;

CREATE TABLE IF NOT EXISTS public.plant_anchor_derivation (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Ownership is `user_id`, matching inactive_project_dismissals and harvest_watch_dismissal, and
  -- deliberately NOT `created_by` — that name is what the V4-OWNERSHIP-001 trigger guards, and a
  -- backfilled table has no business inside that guard's blast radius.
  user_id           text NOT NULL,
  plant_id          uuid NOT NULL REFERENCES public.plants(id),

  -- ── the derived value ──
  anchor_date       date NOT NULL,
  -- Which observed column this anchor STANDS IN FOR. Never written to that column.
  anchor_field      text NOT NULL,

  -- ── the marking (storage layer of the marking rule) ──
  source            text NOT NULL,
  confidence        text NOT NULL,
  model_version     text NOT NULL,
  -- The raw evidence the anchor was computed from, kept separate from anchor_date so an offset or a
  -- clamp can be audited or recomputed without re-reading event_log at a later, drifted state.
  evidence_date     date NOT NULL,
  offset_days       smallint NOT NULL DEFAULT 0,
  offset_source     text,
  offset_sample_n   smallint,
  clamped_to_today  boolean NOT NULL DEFAULT false,

  derived_on        date NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- Soft-retract rather than delete, matching this codebase's convention everywhere else. A derived
  -- anchor that was later contradicted by a real date is EVIDENCE about the derivation's accuracy —
  -- the only ground truth this model will ever get for tier 3 — so it is retired, never erased.
  superseded_at     timestamptz,
  superseded_by     text
);

-- The vocabulary is constrained rather than free text: a calibration query that has to guess whether
-- 'baseline' and 'add_date' mean the same thing is a query that will silently mix them.
ALTER TABLE public.plant_anchor_derivation
  DROP CONSTRAINT IF EXISTS plant_anchor_derivation_source_chk;
ALTER TABLE public.plant_anchor_derivation
  ADD CONSTRAINT plant_anchor_derivation_source_chk
  CHECK (source IN ('sow_event', 'transplant_event', 'nursery_proxy_event', 'add_date_baseline'));

ALTER TABLE public.plant_anchor_derivation
  DROP CONSTRAINT IF EXISTS plant_anchor_derivation_confidence_chk;
ALTER TABLE public.plant_anchor_derivation
  ADD CONSTRAINT plant_anchor_derivation_confidence_chk
  CHECK (confidence IN ('event', 'proxy', 'baseline'));

ALTER TABLE public.plant_anchor_derivation
  DROP CONSTRAINT IF EXISTS plant_anchor_derivation_field_chk;
ALTER TABLE public.plant_anchor_derivation
  ADD CONSTRAINT plant_anchor_derivation_field_chk
  CHECK (anchor_field IN ('sown_at', 'transplanted_at', 'planted_out_at'));

-- An offset only exists for the baseline tier; an event date is a date something happened on.
ALTER TABLE public.plant_anchor_derivation
  DROP CONSTRAINT IF EXISTS plant_anchor_derivation_offset_chk;
ALTER TABLE public.plant_anchor_derivation
  ADD CONSTRAINT plant_anchor_derivation_offset_chk
  CHECK ((source = 'add_date_baseline') OR (offset_days = 0 AND offset_source IS NULL));

-- One LIVE derived anchor per planting. Partial on superseded_at so the history of retired
-- derivations survives — that history is the tier-3 accuracy record.
CREATE UNIQUE INDEX IF NOT EXISTS uq_plant_anchor_derivation_live
  ON public.plant_anchor_derivation (plant_id)
  WHERE superseded_at IS NULL;

-- The route's lookup shape: live rows for one household, joined per plant_id.
CREATE INDEX IF NOT EXISTS idx_plant_anchor_derivation_user_live
  ON public.plant_anchor_derivation (user_id, plant_id)
  WHERE superseded_at IS NULL;

-- Extraction shape for calibration: partition by model, then by tier.
CREATE INDEX IF NOT EXISTS idx_plant_anchor_derivation_model_source
  ON public.plant_anchor_derivation (model_version, source);

COMMENT ON TABLE public.plant_anchor_derivation IS
  'V4-ANCHORBASE-001. INFERRED planting anchors for plantings with no sown_at/transplanted_at/'
  'planted_out_at. Every row is a derivation, never an observation. ~89% rest on the add-date '
  'baseline, measured 47.3% accurate to within a week. Never write these values into public.plants.';

COMMIT;
