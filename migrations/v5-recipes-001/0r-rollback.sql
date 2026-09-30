-- 0r-rollback.sql — V5-RECIPES-001 (Put-Up release 4, recipes) rollback. Reverses 0a-additive-ddl.sql, in
--   reverse order, back to the exact post-F schema (F's view, kitchen_batch without recipe_id, no recipe
--   tables).
--
-- ⚠ VALID ONLY WHILE RELEASE 4's CODE IS OFF DEV (the 05-release-train §4 rule). Once the recipes Lambda
--   names these tables, dropping them blocks every thread's promote at the prod schema gate; the holding
--   state is then "leave the DDL applied" (it is F-compatible, README.md). Chain order is 4r → 3r → 2r.
--
-- THE REFUSAL GUARD (first statement after BEGIN) refuses once the shape is in use, naming each reason with
--   its count: any recipe row (live or soft-deleted), any recipe line, any household-created recipe type
--   (user_id set), any batch that names a recipe. The fifteen built-in types are 0a's own data and go
--   with the table. A refusal changes nothing: it raises inside the transaction.
--
-- THE VIEW is DROPPED and re-CREATED from F's definition (CREATE OR REPLACE cannot remove a column), with
--   its grants captured before the DROP and re-granted after (F 0r's block; no hard-coded GRANT). The file
--   then checks the view is byte-for-byte F's (md5 b70ac2f238dfc9d09e8db2017c0e7474) and refuses to commit
--   otherwise.
--
-- Rehearsed on a local PostgreSQL against a replica of the kitchen family's post-F shape (README.md): 0a →
--   0r leaves the view md5 at F's and no recipe relation, function or trigger behind; 0a re-applies cleanly
--   twice after it.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. The refusal guard. ────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_why   text[] := ARRAY[]::text[];
  v_check record;
  v_n     bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-recipes-001') THEN
    RAISE EXCEPTION 'v5-recipes-001 0r refused: 0a (5.0.0-recipes-001) is not applied here; nothing to roll back';
  END IF;

  FOR v_check IN
    SELECT * FROM (VALUES
      ('recipe rows',               $q$SELECT count(*) FROM public.recipe$q$),
      ('recipe lines',              $q$SELECT count(*) FROM public.recipe_ingredient$q$),
      ('household recipe types',    $q$SELECT count(*) FROM public.recipe_type WHERE user_id IS NOT NULL$q$),
      ('batches that name a recipe', $q$SELECT count(*) FROM public.kitchen_batch WHERE recipe_id IS NOT NULL$q$)
    ) AS c(reason, q)
  LOOP
    EXECUTE v_check.q INTO v_n;
    IF v_n > 0 THEN
      v_why := v_why || format('%s %s', v_n, v_check.reason);
    END IF;
  END LOOP;

  IF cardinality(v_why) > 0 THEN
    RAISE EXCEPTION 'v5-recipes-001 0r refused, the recipe shape is in use: %. Forward-fix only.',
      array_to_string(v_why, '; ');
  END IF;
END $$;

-- ── 1. v_kitchen_batch_current: DROP + CREATE F's definition, grants carried across. ─────────────
CREATE TEMP TABLE recipes_view_acl ON COMMIT DROP AS
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
    b.idempotency_key,
    b.vessel_label,
    b.vessel_size,
    b.vessel_unit,
    b.vessel_count,
    b.no_salt,
    b.shu_est_low,
    b.shu_est_high,
    b.shu_est_basis,
    b.recipe_ref
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
  FOR r IN SELECT grantee, privilege_type, is_grantable FROM recipes_view_acl LOOP
    EXECUTE format('GRANT %s ON public.v_kitchen_batch_current TO %s%s',
                   r.privilege_type,
                   CASE WHEN r.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(r.grantee)) END,
                   CASE WHEN r.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
END $$;

-- ── 2. kitchen_batch.recipe_id (the guard proved every row NULL). ────────────────────────────────
DROP INDEX IF EXISTS public.idx_kitchen_batch_recipe_id;
ALTER TABLE public.kitchen_batch
  DROP CONSTRAINT IF EXISTS kitchen_batch_recipe_id_fkey,
  DROP COLUMN IF EXISTS recipe_id;

-- ── 3. recipe_ingredient, recipe, recipe_type (the guard proved them empty of household data). ──
DROP TABLE IF EXISTS public.recipe_ingredient;
DROP FUNCTION IF EXISTS public.prevent_recipe_ingredient_identity_change();
DROP TABLE IF EXISTS public.recipe;
DROP TABLE IF EXISTS public.recipe_type;

-- ── 4. Verify the view is F's, byte for byte, then remove the stamp. ─────────────────────────────
DO $$
DECLARE
  v_view text;
BEGIN
  SELECT md5(pg_get_viewdef(c.oid, true)) INTO v_view
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'v_kitchen_batch_current' AND c.relkind = 'v';
  IF v_view IS DISTINCT FROM 'b70ac2f238dfc9d09e8db2017c0e7474' THEN
    RAISE EXCEPTION 'v5-recipes-001 0r: the restored view is md5 %, not F''s b70ac2f238dfc9d09e8db2017c0e7474. Nothing was committed.', v_view;
  END IF;
END $$;

DELETE FROM public.schema_version WHERE version = '5.0.0-recipes-001';

COMMIT;
