-- 0b-backfill-reattribute.sql
-- V4-HARVWEIGHTEST-001 — the DATA correction. NOT APPLIED. Requires Dave's explicit approval.
--
-- 0a fixes the mechanism going forward; it does not touch a single existing row. This file re-files
-- the samples that were already misattributed before 0a existed. It is separated on purpose: 0a is
-- reviewable as a code change, this one changes what the app reports.
--
-- WHAT IT MOVES (measured on prod, 2026-08-16, read-only). Four live samples out of 299:
--
--   sample 07a890eb  28 g / 1 count   filed BEEFSTEAK   -> Cherry                (Cherry Rescue 1)
--   sample 6ccefa67  16 g / 1 count   filed BEEFSTEAK   -> Cherry                (Cherry Rescue 1)
--   sample 4c802c19  12 g / 18 count  filed ASTER       -> Allegheny Blackberry  (Blackberry)
--   sample 15ab2945  15 g / 21 count  filed ASTER       -> Allegheny Blackberry  (Blackberry)
--
-- WHAT THAT DOES TO THE RESOLVER, simulated read-only against the live corpus before writing this:
--
--   Beefsteak  22.00 g/count (n=2, 'low')  -> no derived row; falls back to its 350 g catalogue
--                                             figure, which is what a beefsteak weighs
--   Aster      0.69 g/count (n=2, 'high')  -> no derived row; falls back to its 6 g catalogue figure
--   Cherry     no derived row              -> 20.25 g/count (n=4, cv 0.297, 'medium' => PROMOTED)
--   Allegheny  0.74 g/count (n=6)          -> 0.71 g/count (n=8) against a 0.70 g reference
--
-- Aster is the one that was actively dangerous: at 'high' confidence on two independent days the
-- resolver PROMOTES it, and scripts/harvest-weight-ratchet-ack.json had it reviewed and ACCEPTED
-- for propagation. The review was honest and wrong — it compared two agreeing samples against a
-- catalogue figure, a binary that cannot express "these are blackberries".
--
-- STORED harvest_log GRAMS ARE NOT TOUCHED HERE. The 7 "Cherry Rescue 1" rows that hold Beefsteak's
-- 350 g/fruit (3 850 g stored against ~203 g of actual cherry tomatoes) are re-derived by
-- scripts/harvest-weight-ratchet.sh, which already exists for exactly this and carries the
-- total-move guard this correction has no business bypassing. Run this file FIRST so the ratchet
-- reads a corrected corpus, then run the ratchet dry, read its report, then --apply.
--
-- SAFETY: INSERT-only on both cultivar_weight_sample and cultivar_weight_void. No row is updated or
-- deleted (trg_cws_immutable forbids it). Re-runnable: reattribute_plant_weight_samples is a no-op
-- once the corpus agrees with the planting.

\set ON_ERROR_STOP on

BEGIN;

-- Refuse to run without the mechanism. Backfilling against the old function would leave the corpus
-- corrected and the writer still unable to keep it that way.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.schema_version WHERE version = '4.23.14-harvweightest-001-reattribute'
  ) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'REFUSING TO BACKFILL: 0a-reattribution.sql is not applied on this database.',
      HINT    = 'Apply migrations/v4-harvweightest-001/0a-reattribution.sql first.';
  END IF;
END $$;

-- One call per affected planting. The function itself decides what (if anything) moves, so this
-- driver cannot disagree with the live write path about which samples are misattributed.
SELECT p.plant_id,
       public.reattribute_plant_weight_samples(p.plant_id, 'migration:v4-harvweightest-001') AS refiled
  FROM (
    SELECT DISTINCT e.plant_id
      FROM public.cultivar_weight_sample s
      JOIN public.event_log e ON e.id = s.source_event_id AND e.deleted_at IS NULL
      LEFT JOIN public.plants pl ON pl.id = e.plant_id AND pl.deleted_at IS NULL
      LEFT JOIN public.plant_varieties cv ON cv.id = pl.variety_id AND cv.deleted_at IS NULL
     WHERE s.cultivar_id IS DISTINCT FROM cv.id
       AND NOT EXISTS (SELECT 1 FROM public.cultivar_weight_void z WHERE z.sample_id = s.id)
  ) p;

INSERT INTO public.schema_version (version, description)
VALUES ('4.23.15-harvweightest-001-backfill',
  'V4-HARVWEIGHTEST-001 data correction: re-file the calibration samples captured before their '
  'planting was re-identified. 4 live samples move — 2 cherry-tomato weighings off Beefsteak onto '
  'Cherry, 2 blackberry weighings off Aster onto Allegheny Blackberry. Void-and-re-append, so every '
  'original row survives and names its successor. harvest_log is untouched; the stored estimates '
  'are re-derived by scripts/harvest-weight-ratchet.sh AFTER this lands.')
ON CONFLICT DO NOTHING;

COMMIT;
