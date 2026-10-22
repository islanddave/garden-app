-- 0r-rollback.sql
-- V5-SPACETENANCYKEY-001, multi-space step 2.2: undo migrations/v5-tenancystamp-001 (files 01 and 02).
--
-- WHAT: both function bodies go back byte for byte to the ones 01 and 02 were written from (md5
--   cc33df74a8d622bebe772002210f836e and d9bd4ee654ae3d2f8f9e3cae0b495640, read on prod and staging 2026-10-22), and
--   the two stamps are deleted, so the post gates disarm. Rows the stamped bodies wrote are not touched: each carries
--   its parent's Space, which the DEFAULT would also have given while there is one Space.
-- STEP 0 refuses, changing nothing, when either body is neither the original nor the one this directory writes
--   (someone changed it since: read it first). A second run is a no-op (the bodies are already the originals).
-- ORDER: only after any later file that replaced either body has been rolled back itself (the md5 refusal names
--   the body). 2.6 rewrites record_harvest_weight_sample, not these two, so its rollback is independent of this one.
-- Usage: psql "$URL" -X -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $pregate$
DECLARE
  v_void  text;
  v_reatt text;
BEGIN
  SELECT md5(p.prosrc) INTO v_void
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'void_event_weight_samples'
     AND pg_catalog.pg_get_function_identity_arguments(p.oid) = 'p_event_id uuid, p_user text, p_reason text';
  SELECT md5(p.prosrc) INTO v_reatt
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'reattribute_plant_weight_samples'
     AND pg_catalog.pg_get_function_identity_arguments(p.oid) = 'p_plant_id uuid, p_user text';
  IF v_void IS NULL OR v_void NOT IN ('cc33df74a8d622bebe772002210f836e', '886bb851e921341bc2d3af0f89f9c718') THEN
    RAISE EXCEPTION 'v5-tenancystamp-001 0r refused, nothing changed: public.void_event_weight_samples body md5 is %, neither the original nor 01''s.', coalesce(v_void, 'absent');
  END IF;
  IF v_reatt IS NULL OR v_reatt NOT IN ('d9bd4ee654ae3d2f8f9e3cae0b495640', '2b881bb13ecf5e9f0b6d0701f3f850e1') THEN
    RAISE EXCEPTION 'v5-tenancystamp-001 0r refused, nothing changed: public.reattribute_plant_weight_samples body md5 is %, neither the original nor 02''s.', coalesce(v_reatt, 'absent');
  END IF;
END $pregate$;

-- The original bodies, verbatim (v4-cal1-slicec-001 0f; v4-harvweightest-001 0a).
CREATE OR REPLACE FUNCTION public.void_event_weight_samples(
  p_event_id uuid, p_user text, p_reason text
) RETURNS integer LANGUAGE sql AS $$
  WITH voided AS (
    INSERT INTO public.cultivar_weight_void (sample_id, reason, created_by)
    SELECT s.id, p_reason, p_user
      FROM public.cultivar_weight_sample s
     WHERE s.source_event_id = p_event_id
       AND NOT EXISTS (SELECT 1 FROM public.cultivar_weight_void v WHERE v.sample_id = s.id)
    RETURNING 1
  )
  SELECT count(*)::integer FROM voided;
$$;

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

DO $postcheck$
BEGIN
  IF (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND ((p.proname = 'void_event_weight_samples' AND md5(p.prosrc) = 'cc33df74a8d622bebe772002210f836e')
           OR (p.proname = 'reattribute_plant_weight_samples' AND md5(p.prosrc) = 'd9bd4ee654ae3d2f8f9e3cae0b495640'))) <> 2 THEN
    RAISE EXCEPTION 'v5-tenancystamp-001 0r refused, nothing changed: the restored bodies are not the originals.';
  END IF;
END $postcheck$;

DELETE FROM public.schema_version
 WHERE version IN ('5.3.14-tenancystamp-001-void-event-weight-samples',
                   '5.3.14-tenancystamp-001-reattribute-plant-weight-samples');

COMMIT;
