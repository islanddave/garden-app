-- 0r-rollback.sql
-- V4-HARVWEIGHTEST-001 rollback — restore record_harvest_weight_sample to its 0f-autocapture body
-- and drop reattribute_plant_weight_samples.
--
-- WHAT THIS DOES NOT UNDO, and cannot. Any sample 0a's function already re-filed is a void row plus
-- an append, and cultivar_weight_sample is append-only under trg_cws_immutable — there is no DELETE
-- to run. That is the intended property, not a gap: the re-filed row is a correction backed by the
-- superseded row it names, and reverting the code should not erase a correction. To undo a specific
-- re-filing, void the re-filed row and re-append under the old cultivar by the same protocol.
--
-- Restoring the old guard re-opens the defect (an edit after a re-identification will again decline
-- to correct the attribution). Only run this if the FUNCTION is the problem.

\set ON_ERROR_STOP on

BEGIN;

DROP FUNCTION IF EXISTS public.reattribute_plant_weight_samples(uuid, text);

CREATE OR REPLACE FUNCTION public.record_harvest_weight_sample(
  p_event_id uuid, p_plant_id uuid, p_unit text, p_qty numeric, p_grams numeric, p_user text
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_cultivar uuid;
  v_id       uuid;
BEGIN
  IF p_grams IS NULL OR p_grams <= 0
     OR p_qty IS NULL OR p_qty <= 0
     OR p_unit IN ('g','kg','lb','oz') THEN
    PERFORM public.void_event_weight_samples(
      p_event_id, p_user, 'source harvest no longer carries both a count and a weight');
    RETURN NULL;
  END IF;

  SELECT v.id INTO v_cultivar
    FROM public.plants pl
    JOIN public.plant_varieties v ON v.id = pl.variety_id AND v.deleted_at IS NULL
   WHERE pl.id = p_plant_id AND pl.deleted_at IS NULL;
  IF v_cultivar IS NULL THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.cultivar_weight_sample s
     WHERE s.source_event_id = p_event_id
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

DELETE FROM public.schema_version
 WHERE version IN ('4.23.14-harvweightest-001-reattribute',
                   '4.23.15-harvweightest-001-backfill');

COMMIT;
