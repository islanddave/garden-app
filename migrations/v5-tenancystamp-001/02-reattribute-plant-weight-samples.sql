-- 02-reattribute-plant-weight-samples.sql
-- schema_version: 5.3.14-tenancystamp-001-reattribute-plant-weight-samples
-- V5-SPACETENANCYKEY-001, multi-space step 2.2 (plan V204 §2.1 "DB functions that stamp the key", §2.4 "Writers",
--   §3.0, §3 row 2.2): parent-derived stamps. File 2 of 2.
--
-- WHAT: public.reattribute_plant_weight_samples(uuid, text) gets its two INSERTs stamped from rows it already reads:
--   * the void of a misattributed sample (INSERT INTO cultivar_weight_void) takes that sample's workspace_id
--     (m.workspace_id, read in the mis CTE): a void lives in its sample's Space, as file 01's;
--   * the re-filed sample (INSERT INTO cultivar_weight_sample) takes the planting's workspace_id (v_workspace,
--     read in the same SELECT that already reads the planting for v_cultivar, same join, same predicate): a
--     sample is a child of the planting it was weighed from, the rule 2.6 gives the autocapture writer.
--   Before this file both INSERTs left workspace_id to the column DEFAULT (the original Space). Nothing else moves:
--   same signature, LANGUAGE plpgsql, volatility, owner, grants and COMMENT ON FUNCTION (CREATE OR REPLACE keeps
--   them); the join that decides a planting's cultivar is unchanged, so this function and
--   record_harvest_weight_sample still agree on it. No Space literal and no sentinel_workspace() call (N12).
--   record_harvest_weight_sample (the autocapture INSERT, 0f-autocapture.sql:94-98) is NOT touched: step 2.6.
--
-- WHY THE DEPLOYED CODE IS UNAFFECTED (the arming test, V204 §3.0, DSA-25): every planting, sample and void names
--   the original Space today (one Space on prod and staging), every void's workspace_id equals its sample's and
--   every sample's equals its planting's (README "Arming check", read-only on both envs), so each value this body
--   writes is the value the DEFAULT wrote. The one caller (lambda/plants/index.js, after a variety change) passes
--   the same two arguments and reads the same integer.
--
-- STEP 0, in the same transaction, changes nothing and refuses when:
--   * 2.1's column is absent (stamps 5.3.13-tenancykey-001-cultivar-weight-void, -cultivar-weight-sample, and
--     workspace_id on both tables);
--   * the definition pre-gate (V204 §3.0, DSA-18): md5(prosrc) of today's body is not the one this file was written
--     from (d9bd4ee654ae3d2f8f9e3cae0b495640, read on prod and staging 2026-10-22, = migrations/v4-harvweightest-001/
--     0a-reattribution.sql), or, on a re-apply after this file's stamp, the body this file writes.
--   After the CREATE OR REPLACE the body's md5 must be the one gates.yml pins (post-check), or the file aborts.
--
-- LOCKS: the function's catalog row only; lock_timeout 5s. Exactly ONE COMMIT, at the end.
-- ROLLBACK: 0r-rollback.sql (restores the body byte for byte and deletes this file's stamp).
-- Usage: psql "$URL" -X -v ON_ERROR_STOP=1 -f 02-reattribute-plant-weight-samples.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $pregate$
DECLARE
  v_applied boolean := EXISTS (SELECT 1 FROM public.schema_version
                                WHERE version = '5.3.14-tenancystamp-001-reattribute-plant-weight-samples');
  v_md5     text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.3.13-tenancykey-001-cultivar-weight-void')
     OR NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.3.13-tenancykey-001-cultivar-weight-sample')
     OR (SELECT count(*) FROM pg_catalog.pg_attribute a
           JOIN pg_catalog.pg_class t     ON t.oid = a.attrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = 'public' AND t.relname IN ('cultivar_weight_void', 'cultivar_weight_sample')
            AND a.attname = 'workspace_id' AND a.attnum > 0 AND NOT a.attisdropped) <> 2 THEN
    RAISE EXCEPTION 'v5-tenancystamp-001 02 refused, nothing changed: 2.1 has not given cultivar_weight_void and cultivar_weight_sample their workspace_id (stamps 5.3.13-tenancykey-001-cultivar-weight-void, -cultivar-weight-sample).';
  END IF;

  SELECT md5(p.prosrc) INTO v_md5
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'reattribute_plant_weight_samples'
     AND pg_catalog.pg_get_function_identity_arguments(p.oid) = 'p_plant_id uuid, p_user text';
  IF v_md5 IS NULL
     OR NOT (v_md5 = 'd9bd4ee654ae3d2f8f9e3cae0b495640'
             OR (v_applied AND v_md5 = '2b881bb13ecf5e9f0b6d0701f3f850e1')) THEN
    RAISE EXCEPTION 'v5-tenancystamp-001 02 refused, nothing changed: public.reattribute_plant_weight_samples body md5 is %, not the one this file was written from (d9bd4ee654ae3d2f8f9e3cae0b495640, v4-harvweightest-001 0a).', coalesce(v_md5, 'absent')
      USING HINT = 'Someone changed the body since 2026-10-22 (2.6 shares this surface). Read the live body and rewrite this file against it.';
  END IF;
END $pregate$;

CREATE OR REPLACE FUNCTION public.reattribute_plant_weight_samples(
  p_plant_id uuid, p_user text
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_cultivar  uuid;
  v_workspace uuid;
  v_moved     integer;
BEGIN
  -- Same join as record_harvest_weight_sample above, deliberately: the two must agree on what a
  -- planting's cultivar IS, or re-attribution and capture fight each other on alternate saves.
  -- V5-SPACETENANCYKEY-001 (2.2): the same read gives the planting's Space, which a re-filed sample takes.
  SELECT v.id, pl.workspace_id INTO v_cultivar, v_workspace
    FROM public.plants pl
    JOIN public.plant_varieties v ON v.id = pl.variety_id AND v.deleted_at IS NULL
   WHERE pl.id = p_plant_id AND pl.deleted_at IS NULL;

  -- Note v_cultivar may be NULL — the variety was CLEARED. A sample whose cultivar is unknown must
  -- still stop describing the one it no longer belongs to, so it is voided and not re-appended.
  -- cultivar_weight_sample.cultivar_id is NOT NULL, so there is no honest row to append.
  WITH mis AS (
    SELECT s.id, s.cultivar_id, s.unit, s.total_grams, s.unit_count, s.sampled_at,
           s.seed_batch, s.source_event_id, s.workspace_id
      FROM public.cultivar_weight_sample s
      JOIN public.event_log e ON e.id = s.source_event_id
     WHERE e.plant_id = p_plant_id
       AND e.deleted_at IS NULL
       AND s.cultivar_id IS DISTINCT FROM v_cultivar
       AND NOT EXISTS (SELECT 1 FROM public.cultivar_weight_void z WHERE z.sample_id = s.id)
  ),
  voided AS (
    -- A void lives in its sample's Space.
    INSERT INTO public.cultivar_weight_void (sample_id, reason, created_by, workspace_id)
    SELECT m.id,
           'planting re-identified: this sample no longer describes cultivar ' || m.cultivar_id,
           p_user, m.workspace_id
      FROM mis m
    RETURNING sample_id
  ),
  refiled AS (
    -- Every column carried across verbatim. sampled_at especially: it is the observation's date,
    -- not this correction's, and cultivar_weight_derived counts DISTINCT (sampled_at, ratio) to
    -- decide independence — stamping now() here would fuse two days of weighings into one.
    -- workspace_id is the planting's (v_workspace): the sample's parent, as for the autocapture writer.
    INSERT INTO public.cultivar_weight_sample
      (cultivar_id, unit, total_grams, unit_count, sampled_at, seed_batch, note, created_by,
       source_event_id, workspace_id)
    SELECT v_cultivar, m.unit, m.total_grams, m.unit_count, m.sampled_at, m.seed_batch,
           're-filed after the source planting was re-identified; supersedes sample ' || m.id,
           p_user, m.source_event_id, v_workspace
      FROM mis m
     WHERE v_cultivar IS NOT NULL
    RETURNING id
  )
  SELECT count(*)::integer INTO v_moved FROM voided;

  RETURN v_moved;
END $$;

DO $postcheck$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'reattribute_plant_weight_samples'
                    AND md5(p.prosrc) = '2b881bb13ecf5e9f0b6d0701f3f850e1') THEN
    RAISE EXCEPTION 'v5-tenancystamp-001 02 refused, nothing changed: the body written is not the one gates.yml pins (2b881bb13ecf5e9f0b6d0701f3f850e1).';
  END IF;
END $postcheck$;

INSERT INTO public.schema_version (version, description)
VALUES ('5.3.14-tenancystamp-001-reattribute-plant-weight-samples',
        'TENANCYSTAMP 02: V5-SPACETENANCYKEY-001 (multi-space 2.2). public.reattribute_plant_weight_samples stamps '
        'its void from the sample (m.workspace_id) and its re-filed sample from the planting (pl.workspace_id) '
        'instead of the column DEFAULT.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
