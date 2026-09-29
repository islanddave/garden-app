-- 0r-rollback.sql — V5-FERMENTPATH-001 (Put-Up release F) rollback. Reverses 0a-additive-ddl.sql, in
--   reverse order, back to the exact post-1b schema (1b's constraints, triggers, view and audit list).
--
-- ⚠ VALID ONLY WHILE F'S CODE IS OFF DEV (the 05-release-train §4 rule, read "1b→F"). Once F's Lambda
--   names these columns, dropping them blocks every thread's promote at the prod schema gate; the
--   holding state is then "leave F's DDL applied" (it is 1a- and 1b-compatible, README.md).
--
-- THE REFUSAL GUARD (first statement after BEGIN) refuses once F's shape is in use, naming each reason
--   with its count: any pantry_use row; any value in an F column (kitchen_batch vessel/no_salt/shu/
--   recipe_ref; kitchen_batch_input brand/form/shu_rating/salt_method/base_from/edited_at;
--   kitchen_stage_log acts/mash_in_g/edited_at; preservation_log shu_est/cooked/delta_at/
--   remaining_amount); any line whose salt_base is 'produce' (1b's CHECK cannot re-admit it). A
--   refusal changes nothing: it raises inside the transaction. Rows that satisfy F's five tightened
--   CHECKs also satisfy 1b's, so dropping those five loses nothing.
--
-- THE VIEW is DROPPED and re-CREATED from 1b's definition (CREATE OR REPLACE cannot remove a column),
--   with its grants captured before the DROP and re-granted after (1b 0r's block; no hard-coded GRANT,
--   staging has no garden_ro). The file then checks the view is byte-for-byte 1b's (md5
--   c180cfc6868704fdfdf5cc4de1013d6c) and refuses to commit otherwise.
--
-- AUDIT: trg_audit_preservation_log_upd goes back to 1b's nine (tgtype 16, both transition tables).
--   audit_events rows F's triggers wrote are history and stay.
--
-- Rehearsed on local PG 17 against the prod schema + 1b: 1b → F → 0r leaves the family's
--   constraints, indexes, triggers, columns, view (+ACL), routines and stamps identical to post-1b, and
--   F re-applies cleanly twice after it (README.md).

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. The refusal guard. ────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_why   text[] := ARRAY[]::text[];
  v_check record;
  v_n     bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-fermentpath-001') THEN
    RAISE EXCEPTION 'v5-fermentpath-001 0r refused: 0a (5.0.0-fermentpath-001) is not applied here; nothing to roll back';
  END IF;

  FOR v_check IN
    SELECT * FROM (VALUES
      ('pantry_use rows',
       $q$SELECT count(*) FROM public.pantry_use$q$),
      ('batches with a value in an F column',
       $q$SELECT count(*) FROM public.kitchen_batch
           WHERE vessel_label IS NOT NULL OR vessel_size IS NOT NULL OR vessel_unit IS NOT NULL
              OR vessel_count IS NOT NULL OR no_salt IS NOT NULL OR shu_est_low IS NOT NULL
              OR shu_est_high IS NOT NULL OR shu_est_basis IS NOT NULL OR recipe_ref IS NOT NULL$q$),
      ('lines with a value in an F column',
       $q$SELECT count(*) FROM public.kitchen_batch_input
           WHERE brand IS NOT NULL OR form IS NOT NULL OR shu_rating_low IS NOT NULL
              OR shu_rating_high IS NOT NULL OR salt_method IS NOT NULL OR base_from IS NOT NULL
              OR edited_at IS NOT NULL$q$),
      ('lines with salt_base produce',
       $q$SELECT count(*) FROM public.kitchen_batch_input WHERE salt_base = 'produce'$q$),
      ('stage rows with a value in an F column',
       $q$SELECT count(*) FROM public.kitchen_stage_log
           WHERE acts IS NOT NULL OR mash_in_g IS NOT NULL OR edited_at IS NOT NULL$q$),
      ('jars with a value in an F column',
       $q$SELECT count(*) FROM public.preservation_log
           WHERE shu_est_low IS NOT NULL OR shu_est_high IS NOT NULL OR shu_est_basis IS NOT NULL
              OR cooked IS NOT NULL OR delta_at IS NOT NULL OR remaining_amount IS NOT NULL$q$)
    ) AS c(reason, q)
  LOOP
    EXECUTE v_check.q INTO v_n;
    IF v_n > 0 THEN
      v_why := v_why || format('%s %s', v_n, v_check.reason);
    END IF;
  END LOOP;

  IF cardinality(v_why) > 0 THEN
    RAISE EXCEPTION 'v5-fermentpath-001 0r refused, F''s shape is in use: %. Forward-fix only.',
      array_to_string(v_why, '; ');
  END IF;
END $$;

-- ── 1. v_kitchen_batch_current: DROP + CREATE 1b's definition, grants carried across. ────────────
CREATE TEMP TABLE fermentpath_view_acl ON COMMIT DROP AS
  SELECT a.grantee, a.privilege_type, a.is_grantable
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   CROSS JOIN LATERAL aclexplode(c.relacl) a
   WHERE n.nspname = 'public' AND c.relname = 'v_kitchen_batch_current'
     AND a.grantee <> c.relowner;

DROP VIEW public.v_kitchen_batch_current;

CREATE VIEW public.v_kitchen_batch_current AS
 SELECT b.id,
    b.user_id,
    b.label,
    b.kind,
    b.kind_other,
    b.started_at,
    b.start_precision,
    b.start_anchor_kind,
    b.start_anchor_id,
    b.first_recorded_at,
    b.expected_days_min,
    b.expected_days_max,
    b.brine_note,
    b.suspended_at,
    b.closed_at,
    b.outcome,
    b.outcome_note,
    b.cover_photo_id,
    b.notes,
    b.created_at,
    b.updated_at,
    b.deleted_at,
    s.stage_kind AS current_stage_kind,
    s.label AS current_stage_label,
    s.entered_at AS current_stage_entered_at,
    loc.storage_location_id AS current_storage_location_id,
    ( SELECT count(*) AS count
           FROM public.kitchen_batch_input i
          WHERE i.batch_id = b.id AND i.deleted_at IS NULL) AS input_count,
    ( SELECT count(*) AS count
           FROM public.preservation_log p
          WHERE p.batch_id = b.id AND p.deleted_at IS NULL) AS output_count,
    ph.ph_reading AS last_ph_reading,
    ph.ph_read_at AS last_ph_read_at,
    b.idempotency_key
   FROM public.kitchen_batch b
     LEFT JOIN LATERAL ( SELECT sl.stage_kind,
            sl.label,
            sl.entered_at
           FROM public.kitchen_stage_log sl
          WHERE sl.batch_id = b.id
            AND sl.stage_kind IN ('started','tended','moved','finished','failed')
            AND NOT EXISTS (SELECT 1 FROM public.kitchen_stage_log v WHERE v.voids_id = sl.id)
          ORDER BY sl.entered_at DESC NULLS LAST, sl.created_at DESC, sl.id DESC
         LIMIT 1) s ON true
     LEFT JOIN LATERAL ( SELECT sl.storage_location_id
           FROM public.kitchen_stage_log sl
          WHERE sl.batch_id = b.id
            AND sl.storage_location_id IS NOT NULL
            AND sl.stage_kind <> 'void'
            AND NOT EXISTS (SELECT 1 FROM public.kitchen_stage_log v WHERE v.voids_id = sl.id)
          ORDER BY sl.entered_at DESC NULLS LAST, sl.created_at DESC, sl.id DESC
         LIMIT 1) loc ON true
     LEFT JOIN LATERAL ( SELECT pl.ph_reading,
            pl.ph_read_at
           FROM public.kitchen_stage_log pl
          WHERE pl.batch_id = b.id
            AND pl.ph_reading IS NOT NULL
            AND pl.stage_kind <> 'void'
            AND NOT EXISTS (SELECT 1 FROM public.kitchen_stage_log v WHERE v.voids_id = pl.id)
          ORDER BY pl.ph_read_at DESC, pl.id DESC
         LIMIT 1) ph ON true
  WHERE b.deleted_at IS NULL;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT grantee, privilege_type, is_grantable FROM fermentpath_view_acl LOOP
    EXECUTE format('GRANT %s ON public.v_kitchen_batch_current TO %s%s',
                   r.privilege_type,
                   CASE WHEN r.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(r.grantee)) END,
                   CASE WHEN r.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
END $$;

-- ── 2. Triggers and functions on the two kitchen tables. ────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_audit_kitchen_batch_input_upd ON public.kitchen_batch_input;
DROP TRIGGER IF EXISTS trg_audit_kitchen_stage_log_upd ON public.kitchen_stage_log;
DROP TRIGGER IF EXISTS trg_kbi_identity ON public.kitchen_batch_input;
DROP TRIGGER IF EXISTS trg_ksl_identity ON public.kitchen_stage_log;
DROP FUNCTION IF EXISTS public.prevent_kbi_identity_change();
DROP FUNCTION IF EXISTS public.prevent_ksl_identity_change();
DROP FUNCTION IF EXISTS public.audit_stmt_update_no_soft_delete();

-- ── 3. pantry_use (the guard proved it empty). ──────────────────────────────────────────────────
DROP TABLE IF EXISTS public.pantry_use;

-- ── 4. preservation_log: 1b's audit list, then F's CHECKs and columns. ──────────────────────────
DROP TRIGGER IF EXISTS trg_audit_preservation_log_upd ON public.preservation_log;
CREATE TRIGGER trg_audit_preservation_log_upd
  AFTER UPDATE ON public.preservation_log
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.audit_stmt_update(
    'storage_location_id', 'use_by_target', 'use_by_basis', 'package_count', 'remaining_count',
    'label', 'is_raw', 'in_oil', 'deleted_at');

ALTER TABLE public.preservation_log
  DROP CONSTRAINT IF EXISTS chk_preservation_log_remaining_amount,
  DROP CONSTRAINT IF EXISTS chk_preservation_log_shu_est_pairing,
  DROP CONSTRAINT IF EXISTS chk_preservation_log_shu_est_basis,
  DROP CONSTRAINT IF EXISTS chk_preservation_log_shu_est_range,
  DROP COLUMN IF EXISTS remaining_amount,
  DROP COLUMN IF EXISTS delta_at,
  DROP COLUMN IF EXISTS cooked,
  DROP COLUMN IF EXISTS shu_est_basis,
  DROP COLUMN IF EXISTS shu_est_high,
  DROP COLUMN IF EXISTS shu_est_low;

-- ── 5. kitchen_stage_log. ────────────────────────────────────────────────────────────────────────
ALTER TABLE public.kitchen_stage_log
  DROP CONSTRAINT IF EXISTS chk_ksl_mash_in_g,
  DROP CONSTRAINT IF EXISTS chk_ksl_acts_on_tended,
  DROP CONSTRAINT IF EXISTS chk_ksl_acts,
  DROP COLUMN IF EXISTS edited_at,
  DROP COLUMN IF EXISTS mash_in_g,
  DROP COLUMN IF EXISTS acts;

-- ── 6. kitchen_batch_input: the salt_base CHECK back to 1b's vocabulary (validated). ─────────────
ALTER TABLE public.kitchen_batch_input
  DROP CONSTRAINT IF EXISTS uq_kbi_id_preservation_log_id,
  DROP CONSTRAINT IF EXISTS chk_kbi_base_from_needs_base,
  DROP CONSTRAINT IF EXISTS chk_kbi_base_from,
  DROP CONSTRAINT IF EXISTS chk_kbi_salt_method_on_salt_line,
  DROP CONSTRAINT IF EXISTS chk_kbi_salt_method,
  DROP CONSTRAINT IF EXISTS chk_kbi_shu_rating_not_on_role,
  DROP CONSTRAINT IF EXISTS chk_kbi_shu_rating_range,
  DROP CONSTRAINT IF EXISTS chk_kbi_form_not_on_role,
  DROP CONSTRAINT IF EXISTS chk_kbi_form,
  DROP CONSTRAINT IF EXISTS chk_kbi_brand_nonblank,
  DROP CONSTRAINT IF EXISTS chk_kbi_base_g_positive,
  DROP CONSTRAINT IF EXISTS chk_kbi_salt_pct_range,
  DROP CONSTRAINT IF EXISTS chk_kbi_salt_facts_grams,
  DROP CONSTRAINT IF EXISTS chk_kbi_salt_facts_pairing,
  DROP CONSTRAINT IF EXISTS chk_kbi_salt_facts_on_salt_line,
  DROP CONSTRAINT IF EXISTS chk_kbi_salt_base,
  ADD CONSTRAINT chk_kbi_salt_base
    CHECK (salt_base IS NULL OR salt_base IN ('peppers','water','all')),
  DROP COLUMN IF EXISTS edited_at,
  DROP COLUMN IF EXISTS base_from,
  DROP COLUMN IF EXISTS salt_method,
  DROP COLUMN IF EXISTS shu_rating_high,
  DROP COLUMN IF EXISTS shu_rating_low,
  DROP COLUMN IF EXISTS form,
  DROP COLUMN IF EXISTS brand;

-- ── 7. kitchen_batch. ────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.kitchen_batch
  DROP CONSTRAINT IF EXISTS chk_kitchen_batch_recipe_ref_nonblank,
  DROP CONSTRAINT IF EXISTS chk_kitchen_batch_shu_est_pairing,
  DROP CONSTRAINT IF EXISTS chk_kitchen_batch_shu_est_basis,
  DROP CONSTRAINT IF EXISTS chk_kitchen_batch_shu_est_range,
  DROP CONSTRAINT IF EXISTS chk_kitchen_batch_no_salt_true,
  DROP CONSTRAINT IF EXISTS chk_kitchen_batch_vessel_count,
  DROP CONSTRAINT IF EXISTS chk_kitchen_batch_vessel_unit,
  DROP CONSTRAINT IF EXISTS chk_kitchen_batch_vessel_pairing,
  DROP CONSTRAINT IF EXISTS chk_kitchen_batch_vessel_label_nonblank,
  DROP COLUMN IF EXISTS recipe_ref,
  DROP COLUMN IF EXISTS shu_est_basis,
  DROP COLUMN IF EXISTS shu_est_high,
  DROP COLUMN IF EXISTS shu_est_low,
  DROP COLUMN IF EXISTS no_salt,
  DROP COLUMN IF EXISTS vessel_count,
  DROP COLUMN IF EXISTS vessel_unit,
  DROP COLUMN IF EXISTS vessel_size,
  DROP COLUMN IF EXISTS vessel_label;

-- ── 8. Verify the view is 1b's, byte for byte, then remove the stamp. ────────────────────────────
DO $$
DECLARE
  v_view text;
BEGIN
  SELECT md5(pg_get_viewdef(c.oid, true)) INTO v_view
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'v_kitchen_batch_current' AND c.relkind = 'v';
  IF v_view IS DISTINCT FROM 'c180cfc6868704fdfdf5cc4de1013d6c' THEN
    RAISE EXCEPTION 'v5-fermentpath-001 0r: the restored view is md5 %, not 1b''s c180cfc6868704fdfdf5cc4de1013d6c. Nothing was committed.', v_view;
  END IF;
END $$;

DELETE FROM public.schema_version WHERE version = '5.0.0-fermentpath-001';

COMMIT;
