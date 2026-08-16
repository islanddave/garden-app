-- 0a-reattribution.sql
-- V4-HARVWEIGHTEST-001 — a calibration sample follows the planting's IDENTITY, not the identity the
-- planting happened to carry on the day it was weighed.
--
-- THE DEFECT, precisely. cultivar_weight_sample.cultivar_id is a COPY of the source planting's
-- cultivar, taken at capture time by record_harvest_weight_sample, with nothing that maintains it.
-- Re-identify the planting and the copy is simply wrong, forever. Live evidence (prod, 2026-08-16):
--
--   planting "Cherry Rescue 1"  notes: 'Formerly "Beefsteak"'  re-identified 2026-08-14
--     -> its two hand-weighings, 28 g and 16 g for ONE fruit each, sit in the corpus under
--        BEEFSTEAK, whose catalogue figure is 350 g. Two cherry tomatoes are the only "evidence"
--        the corpus holds about a beefsteak.
--   planting "Blackberry"       re-identified to Allegheny Blackberry 2026-08-06
--     -> its two weighings, 0.67 and 0.71 g per drupelet, sit under ASTER — a 6 g reference. That
--        pair is confidence 'high' on two independent days, so the resolver PROMOTES it, and
--        scripts/harvest-weight-ratchet-ack.json has it ACCEPTED for propagation.
--
-- The same staleness is what the ledger row was filed against: "Cherry Rescue 1: 2ct=700g and
-- 1ct=350g weight_basis=cultivar". Those grams are Beefsteak's catalogue value, frozen into
-- harvest_log by the 2026-08-03 backfill and never re-derived after the re-identification. The
-- HARVEST half of that already has a shipped remediation — scripts/harvest-weight-ratchet.sh
-- re-derives every estimated row through resolve_harvest_weight, guarded and dry-run by default —
-- so this migration deliberately does NOT re-resolve harvest_log. It fixes the input the ratchet
-- reads. Re-deriving stored grams inline on a variety edit would move numbers Dave reads with none
-- of the ratchet's total-move guard, which is precisely what that guard exists to prevent.
--
-- WHY NOT FIX IT IN THE VIEW. cultivar_weight_derived could group by the source planting's CURRENT
-- cultivar and the stored copy would stop mattering. Rejected: it silently re-prices every
-- consumer of the view through a read path, it makes cultivar_weight_sample.cultivar_id advisory
-- against that table's append-only "raw evidence" contract, and the 9 seeded samples with no
-- source_event_id would need a second rule. The void-and-re-append protocol already exists here for
-- exactly "this sample is superseded", and it leaves a legible trail: the old row stays, the void
-- row says why, the new row names the row it supersedes.
--
-- WHY NOT A PLAUSIBILITY BAND. A per-unit weight outside a sane band for the crop would not have
-- caught any of this: 350 g/fruit is CORRECT for a beefsteak, and the row claimed to be a beefsteak.
-- A band only fires once the identity is already known to be wrong. Worse, 0b-resolver-v4's header
-- records the standing decision against a deviation-from-catalogue rejection rule — it is circular
-- and would stop CAL-1 ever correcting a wrong catalogue figure, which is the whole feature. What
-- IS added is a falsifiable invariant (gates.yml :: post_no_sample_contradicts_its_planting), which
-- states the property instead of guessing at a threshold.
--
-- SAFETY: two function bodies. No table, column, constraint, view or index is touched, and no
-- existing ROW is rewritten or deleted — cultivar_weight_sample is protected by trg_cws_immutable
-- and this migration respects it (INSERT only, on both tables). Re-runnable.

\set ON_ERROR_STOP on

BEGIN;

-- ── 1. the capture-time no-op guard must compare the CULTIVAR too ───────────────────────────────
--
-- Byte-identical to the 0f-autocapture body except for the s.cultivar_id conjunct below.
--
-- The guard's job is "an unchanged re-save must not append a duplicate", because a duplicate
-- inflates sample_n and collapses CV to 0, faking the confidence tier. It tested unit + grams +
-- count and NOT the cultivar, so after a re-identification an edit to the harvest matched the
-- guard, returned early, and skipped the void-and-replace this function exists to perform. The one
-- event that could have corrected the attribution was the one event guaranteed not to.
CREATE OR REPLACE FUNCTION public.record_harvest_weight_sample(
  p_event_id uuid, p_plant_id uuid, p_unit text, p_qty numeric, p_grams numeric, p_user text
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_cultivar uuid;
  v_id       uuid;
BEGIN
  -- A weight-UNIT harvest ("3 lb") carries no count, so there is no grams-per-item ratio to learn.
  -- No weight, or no count, likewise. In all three cases any sample this event produced earlier is
  -- now wrong and must be retired.
  IF p_grams IS NULL OR p_grams <= 0
     OR p_qty IS NULL OR p_qty <= 0
     OR p_unit IN ('g','kg','lb','oz') THEN
    PERFORM public.void_event_weight_samples(
      p_event_id, p_user, 'source harvest no longer carries both a count and a weight');
    RETURN NULL;
  END IF;

  -- An unattributed harvest (no planting, or a planting with no variety) has nothing to calibrate.
  SELECT v.id INTO v_cultivar
    FROM public.plants pl
    JOIN public.plant_varieties v ON v.id = pl.variety_id AND v.deleted_at IS NULL
   WHERE pl.id = p_plant_id AND pl.deleted_at IS NULL;
  IF v_cultivar IS NULL THEN
    RETURN NULL;
  END IF;

  -- Unchanged re-save: leave the existing sample alone. See the header — appending a duplicate
  -- would inflate sample_n and fake up the confidence tier.
  --
  -- V4-HARVWEIGHTEST-001: "unchanged" now includes the CULTIVAR. Same grams, same count, same unit
  -- but a different variety is not an unchanged re-save — it is the correction this function was
  -- built to make, and without this conjunct it was the one case it silently declined.
  IF EXISTS (
    SELECT 1 FROM public.cultivar_weight_sample s
     WHERE s.source_event_id = p_event_id
       AND s.cultivar_id = v_cultivar
       AND s.unit = p_unit AND s.total_grams = p_grams AND s.unit_count = p_qty
       AND NOT EXISTS (SELECT 1 FROM public.cultivar_weight_void v WHERE v.sample_id = s.id)
  ) THEN
    RETURN NULL;
  END IF;

  PERFORM public.void_event_weight_samples(
    p_event_id, p_user, 'superseded by an edit to the source harvest');

  INSERT INTO public.cultivar_weight_sample
    (cultivar_id, unit, total_grams, unit_count, sampled_at, note, created_by, source_event_id)
  SELECT v_cultivar, p_unit, p_grams, p_qty, e.event_date,
         'auto-captured: harvest logged with both a count and a weight', p_user, p_event_id
    FROM public.event_log e WHERE e.id = p_event_id
  RETURNING id INTO v_id;

  RETURN v_id;
END $$;

-- ── 2. re-file a planting's samples when its identification changes ─────────────────────────────
--
-- Idempotent by construction: the mismatch predicate IS the change detector, so this is a no-op
-- whenever the corpus already agrees with the planting. That matters more than it looks — the two
-- live re-identifications left NO audit_events row (audit coverage is plant_varieties only), so a
-- hook that fired on an observed old->new transition would have missed both. This one heals a
-- change made by any writer, including a psql session, on the next planting save.
--
-- Returns the number of samples re-filed.
CREATE OR REPLACE FUNCTION public.reattribute_plant_weight_samples(
  p_plant_id uuid, p_user text
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_cultivar uuid;
  v_moved    integer;
BEGIN
  -- Same join as record_harvest_weight_sample above, deliberately: the two must agree on what a
  -- planting's cultivar IS, or re-attribution and capture fight each other on alternate saves.
  SELECT v.id INTO v_cultivar
    FROM public.plants pl
    JOIN public.plant_varieties v ON v.id = pl.variety_id AND v.deleted_at IS NULL
   WHERE pl.id = p_plant_id AND pl.deleted_at IS NULL;

  -- Note v_cultivar may be NULL — the variety was CLEARED. A sample whose cultivar is unknown must
  -- still stop describing the one it no longer belongs to, so it is voided and not re-appended.
  -- cultivar_weight_sample.cultivar_id is NOT NULL, so there is no honest row to append.
  WITH mis AS (
    SELECT s.id, s.cultivar_id, s.unit, s.total_grams, s.unit_count, s.sampled_at,
           s.seed_batch, s.source_event_id
      FROM public.cultivar_weight_sample s
      JOIN public.event_log e ON e.id = s.source_event_id
     WHERE e.plant_id = p_plant_id
       AND e.deleted_at IS NULL
       AND s.cultivar_id IS DISTINCT FROM v_cultivar
       AND NOT EXISTS (SELECT 1 FROM public.cultivar_weight_void z WHERE z.sample_id = s.id)
  ),
  voided AS (
    INSERT INTO public.cultivar_weight_void (sample_id, reason, created_by)
    SELECT m.id,
           'planting re-identified: this sample no longer describes cultivar ' || m.cultivar_id,
           p_user
      FROM mis m
    RETURNING sample_id
  ),
  refiled AS (
    -- Every column carried across verbatim. sampled_at especially: it is the observation's date,
    -- not this correction's, and cultivar_weight_derived counts DISTINCT (sampled_at, ratio) to
    -- decide independence — stamping now() here would fuse two days of weighings into one.
    INSERT INTO public.cultivar_weight_sample
      (cultivar_id, unit, total_grams, unit_count, sampled_at, seed_batch, note, created_by,
       source_event_id)
    SELECT v_cultivar, m.unit, m.total_grams, m.unit_count, m.sampled_at, m.seed_batch,
           're-filed after the source planting was re-identified; supersedes sample ' || m.id,
           p_user, m.source_event_id
      FROM mis m
     WHERE v_cultivar IS NOT NULL
    RETURNING id
  )
  SELECT count(*)::integer INTO v_moved FROM voided;

  RETURN v_moved;
END $$;

COMMENT ON FUNCTION public.reattribute_plant_weight_samples(uuid, text) IS
  'V4-HARVWEIGHTEST-001. Re-files every live calibration sample captured from this planting under '
  'the cultivar the planting is identified as NOW, voiding the misattributed row rather than '
  'editing or deleting it (cultivar_weight_sample is append-only under trg_cws_immutable). A '
  'cleared variety voids without re-appending. Idempotent: the mismatch itself is the trigger, so '
  'it is a no-op once the corpus agrees, and it heals a variety change made outside the API.';

INSERT INTO public.schema_version (version, description)
VALUES ('4.23.14-harvweightest-001-reattribute',
  'V4-HARVWEIGHTEST-001: a calibration sample follows the planting IDENTITY. '
  'reattribute_plant_weight_samples() voids and re-appends every live cultivar_weight_sample whose '
  'stored cultivar_id no longer matches its source planting''s cultivar; '
  'record_harvest_weight_sample''s unchanged-re-save guard now compares cultivar_id too, so an edit '
  'after a re-identification performs the void-and-replace it previously skipped. Function bodies '
  'only — no row rewritten, no row deleted, harvest_log untouched (stored estimates are the '
  'harvest-weight-ratchet job''s remit).')
ON CONFLICT DO NOTHING;

COMMIT;
