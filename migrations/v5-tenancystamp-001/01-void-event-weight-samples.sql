-- 01-void-event-weight-samples.sql
-- schema_version: 5.3.14-tenancystamp-001-void-event-weight-samples
-- V5-SPACETENANCYKEY-001, multi-space step 2.2 (plan V204 §2.1 "DB functions that stamp the key", §2.4 "Writers",
--   §3.0, §3 row 2.2): parent-derived stamps. File 1 of 2.
--
-- WHAT: public.void_event_weight_samples(uuid, text, text) gets one change. Its INSERT into
--   public.cultivar_weight_void names workspace_id and copies it from the sample row it voids (s.workspace_id),
--   the row the statement already reads. A void lives in its sample's Space. Before this file the INSERT left
--   workspace_id to the column DEFAULT (the original Space), which is right only while there is one Space.
--   Nothing else in the body moves: same signature, same LANGUAGE sql, same volatility, same owner, grants and
--   comment (CREATE OR REPLACE keeps them). No Space literal and no sentinel_workspace() call in the body (N12).
--
-- WHY THE DEPLOYED CODE IS UNAFFECTED (the arming test, V204 §3.0, DSA-25): every live sample and every live void
--   names the original Space today (2.1's DEFAULT; prod and staging have one Space), and every void row's
--   workspace_id already equals its sample's (README "Arming check", read-only on prod and staging). So the value
--   this body writes is the value the DEFAULT wrote. Callers (record_harvest_weight_sample, the events and plants
--   Lambdas through it) pass the same three arguments and read the same integer.
--
-- STEP 0, in the same transaction, changes nothing and refuses when:
--   * 2.1's column is absent (stamp 5.3.13-tenancykey-001-cultivar-weight-void and -cultivar-weight-sample, and
--     workspace_id on both tables);
--   * the definition pre-gate (V204 §3.0, DSA-18): md5(prosrc) of today's body is not the one this file was written
--     from (cc33df74a8d622bebe772002210f836e, read on prod and staging 2026-10-22, = migrations/v4-cal1-slicec-001/
--     0f-autocapture.sql), or, on a re-apply after this file's stamp, the body this file writes.
--   After the CREATE OR REPLACE the body's md5 must be the one gates.yml pins (post-check), or the file aborts.
--
-- LOCKS: CREATE OR REPLACE FUNCTION takes a lock on the function's catalog row only; a concurrent call keeps the
--   body it started with. lock_timeout 5s. Exactly ONE COMMIT, at the end.
-- ROLLBACK: 0r-rollback.sql (restores the body byte for byte and deletes this file's stamp).
-- Usage: psql "$URL" -X -v ON_ERROR_STOP=1 -f 01-void-event-weight-samples.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $pregate$
DECLARE
  v_applied boolean := EXISTS (SELECT 1 FROM public.schema_version
                                WHERE version = '5.3.14-tenancystamp-001-void-event-weight-samples');
  v_md5     text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.3.13-tenancykey-001-cultivar-weight-void')
     OR NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.3.13-tenancykey-001-cultivar-weight-sample')
     OR (SELECT count(*) FROM pg_catalog.pg_attribute a
           JOIN pg_catalog.pg_class t     ON t.oid = a.attrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = 'public' AND t.relname IN ('cultivar_weight_void', 'cultivar_weight_sample')
            AND a.attname = 'workspace_id' AND a.attnum > 0 AND NOT a.attisdropped) <> 2 THEN
    RAISE EXCEPTION 'v5-tenancystamp-001 01 refused, nothing changed: 2.1 has not given cultivar_weight_void and cultivar_weight_sample their workspace_id (stamps 5.3.13-tenancykey-001-cultivar-weight-void, -cultivar-weight-sample).';
  END IF;

  SELECT md5(p.prosrc) INTO v_md5
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'void_event_weight_samples'
     AND pg_catalog.pg_get_function_identity_arguments(p.oid) = 'p_event_id uuid, p_user text, p_reason text';
  IF v_md5 IS NULL
     OR NOT (v_md5 = 'cc33df74a8d622bebe772002210f836e'
             OR (v_applied AND v_md5 = '886bb851e921341bc2d3af0f89f9c718')) THEN
    RAISE EXCEPTION 'v5-tenancystamp-001 01 refused, nothing changed: public.void_event_weight_samples body md5 is %, not the one this file was written from (cc33df74a8d622bebe772002210f836e, v4-cal1-slicec-001 0f).', coalesce(v_md5, 'absent')
      USING HINT = 'Someone changed the body since 2026-10-22 (2.6 shares this surface). Read the live body and rewrite this file against it.';
  END IF;
END $pregate$;

CREATE OR REPLACE FUNCTION public.void_event_weight_samples(
  p_event_id uuid, p_user text, p_reason text
) RETURNS integer LANGUAGE sql AS $$
  -- V5-SPACETENANCYKEY-001 (2.2): a void lives in its sample's Space, copied from the sample row it voids.
  WITH voided AS (
    INSERT INTO public.cultivar_weight_void (sample_id, reason, created_by, workspace_id)
    SELECT s.id, p_reason, p_user, s.workspace_id
      FROM public.cultivar_weight_sample s
     WHERE s.source_event_id = p_event_id
       AND NOT EXISTS (SELECT 1 FROM public.cultivar_weight_void v WHERE v.sample_id = s.id)
    RETURNING 1
  )
  SELECT count(*)::integer FROM voided;
$$;

DO $postcheck$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'void_event_weight_samples'
                    AND md5(p.prosrc) = '886bb851e921341bc2d3af0f89f9c718') THEN
    RAISE EXCEPTION 'v5-tenancystamp-001 01 refused, nothing changed: the body written is not the one gates.yml pins (886bb851e921341bc2d3af0f89f9c718).';
  END IF;
END $postcheck$;

INSERT INTO public.schema_version (version, description)
VALUES ('5.3.14-tenancystamp-001-void-event-weight-samples',
        'TENANCYSTAMP 01: V5-SPACETENANCYKEY-001 (multi-space 2.2). public.void_event_weight_samples stamps each '
        'cultivar_weight_void row with its sample''s workspace_id (parent-derived) instead of the column DEFAULT.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
