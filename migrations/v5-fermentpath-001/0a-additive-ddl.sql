-- 0a-additive-ddl.sql
-- schema_version: 5.0.0-fermentpath-001
--
-- V5-FERMENTPATH-001 — Put-Up release F (the ferment path), the database half. One file, one
--   transaction, the stamp written inside it. Plan: project-state/_crucible-pantry-20260928/
--   06-ferment-path.md (V1) §2 and §3, with boss-technical F1-F3; the frozen column contract is
--   _putupbuild_20260929/contract-F.md. The line above is machine-read by the train step in
--   .github/workflows/integration-test.yml; keep it the second line and keep it equal to the INSERT at
--   the bottom.
--
-- THE STAMP IS FIXED: '5.0.0-fermentpath-001'. Never edit it after the first apply anywhere: every
--   standing gate in gates.yml self-arms on it, and so does the one leg added to 1b's
--   post_audit_watches_exactly_the_nine.
--
-- APPLIES ON TOP OF 1b ONLY. v5-putupmake-001 (stamp '5.0.0-putupmake-001') must already be applied;
--   the guard below refuses otherwise. 1b's 0a, 0r and stamp are untouched by this release.
--
-- WHY THE DEPLOYED WRITER IS UNAFFECTED (the house rule). When this lands on prod the deployed Lambda
--   is release 1a's (promote A). Every change here is one of:
--     (a) a column 1a never names, with CHECKs only over new columns — vacuous for 1a;
--     (b) a RELAXATION kept under its own name: chk_kbi_salt_base admits 'produce' as well;
--     (c) a TIGHTENING of a 1b column 1a never writes (the five chk_kbi_salt_* / base_g CHECKs below):
--         1a has no salt route (README proves it statically), and gates.yml's sweep_* rows measure the
--         data immediately before the apply;
--     (d) triggers 1a cannot trip: the identity triggers freeze columns 1a never changes (1a's only kbi
--         write is INSERT and hard DELETE; its only ksl write is INSERT), and the audit triggers cannot
--         abort a statement (both functions turn any failure into a WARNING);
--     (e) the view: 1b's 31 columns kept in order, nine appended (1a reads SELECT *, so it gains nine
--         NULL keys, as it gained one from 1b).
--   Every CHECK is created VALIDATED. NOT VALID is never the remedy.
--
-- FIVE CHECKS TIGHTEN 1b COLUMNS (06 §2 legend T): chk_kbi_salt_facts_on_salt_line,
--   chk_kbi_salt_facts_pairing, chk_kbi_salt_facts_grams, chk_kbi_salt_pct_range,
--   chk_kbi_base_g_positive. Each has a sweep_* gate that returns the violating rows.
--
-- NO F CHECK NAMES kitchen_batch.kind. Kind gating is UI-only (06 §3.10); gates.yml asserts it.
--
-- STOCK MODE IS NOT A CHECK (06 §1.4). "Weighed" (package_count = 1, mass unit) is decided by the
--   route at draw time. A CHECK over package_count would turn the 1a legacy PUT's count edit into a
--   23514. Likewise "0 g => count 0" is a route rule (boss-technical F2), not a CHECK.
--
-- AUDIT (06 §3.7, DS-B2). audit_stmt_update() reads o.deleted_at / n.deleted_at, and
--   kitchen_stage_log has no deleted_at: attached there, its WHEN OTHERS would swallow the 42703 and
--   write nothing. So this file adds audit_stmt_update_no_soft_delete() (the same body without the
--   deleted_at legs) for kitchen_stage_log; kitchen_batch_input (which has deleted_at) takes
--   audit_stmt_update. preservation_log's trigger is re-created watching 1b's nine plus four.
--
-- IDENTITY (06 §3.7, DS-B4). One function per table, each naming only its own table's columns (1b's
--   post_trigger_functions_name_real_columns_on_other_touched_tables reads every trigger on these
--   tables). kbi.plant_id is deliberately NOT frozen: its FK is SET NULL, so the RI action and the
--   planting merge repoint both UPDATE it. deleted_at is the soft delete itself.
--
-- pantry_use (06 §2.5). Insert-only ledger. Two same-jar composite FKs make a use impossible to point
--   at a jar other than its line's or its forward use's, and the biconditional CHECKs make "negative
--   = reversal" and "'batch' = has a line" both directions (contract-F.md §4).
--
-- THE FINGERPRINT GUARD (first statement after BEGIN) refuses unless the view is 1b's definition or
--   this file's own (a re-apply). If you edit the view below, re-pin its md5 here and in gates.yml.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS; every CHECK and FK is DROP IF EXISTS + ADD in one statement;
--   UNIQUE constraints other things depend on are created only if absent; CREATE TABLE / INDEX IF NOT
--   EXISTS; functions and the view CREATE OR REPLACE; triggers DROP IF EXISTS + CREATE; the stamp ON
--   CONFLICT DO NOTHING. Re-running the whole file on an applied database changes nothing.
--
-- ⚠ Exactly ONE COMMIT, at the end. Do not wrap this file in BEGIN/ROLLBACK to "rehearse" it on a
--   shared database: its own COMMIT ends your transaction. Rehearse on local PG 17 (README.md).
--
-- ROLLBACK: 0r-rollback.sql — guarded; refuses once F's shape is in use.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. Guards: 1b is applied, and the view is 1b's or this file's. ───────────────────────────────
DO $$
DECLARE
  v_view text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-putupmake-001') THEN
    RAISE EXCEPTION 'v5-fermentpath-001 0a refused: v5-putupmake-001 (5.0.0-putupmake-001) is not applied here. F applies on top of 1b only.';
  END IF;
  SELECT md5(pg_get_viewdef(c.oid, true)) INTO v_view
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'v_kitchen_batch_current' AND c.relkind = 'v';
  IF v_view IS DISTINCT FROM 'c180cfc6868704fdfdf5cc4de1013d6c'
     AND v_view IS DISTINCT FROM 'b70ac2f238dfc9d09e8db2017c0e7474' THEN
    RAISE EXCEPTION 'v5-fermentpath-001 0a refused: v_kitchen_batch_current is md5 %, neither 1b''s definition (c180cfc6868704fdfdf5cc4de1013d6c) nor this file''s (b70ac2f238dfc9d09e8db2017c0e7474). Someone changed it after 1b: fold their change into this file, re-pin, and re-rehearse.', v_view;
  END IF;
END $$;

-- ── 1. kitchen_batch ─────────────────────────────────────────────────────────────────────────────
-- Nine columns, all nullable with no default. "About ___ in it" is NOT a column (the started row's
-- amount). no_salt is true-or-NULL: "No salt" is a chip, and its absence is NULL, not false.
ALTER TABLE public.kitchen_batch
  ADD COLUMN IF NOT EXISTS vessel_label  text,
  ADD COLUMN IF NOT EXISTS vessel_size   numeric,
  ADD COLUMN IF NOT EXISTS vessel_unit   text,
  ADD COLUMN IF NOT EXISTS vessel_count  smallint,
  ADD COLUMN IF NOT EXISTS no_salt       boolean,
  ADD COLUMN IF NOT EXISTS shu_est_low   integer,
  ADD COLUMN IF NOT EXISTS shu_est_high  integer,
  ADD COLUMN IF NOT EXISTS shu_est_basis text,
  ADD COLUMN IF NOT EXISTS recipe_ref    text,
  DROP CONSTRAINT IF EXISTS chk_kitchen_batch_vessel_label_nonblank,
  ADD CONSTRAINT chk_kitchen_batch_vessel_label_nonblank
    CHECK (vessel_label IS NULL OR (btrim(vessel_label) <> '' AND char_length(vessel_label) <= 120)),
  DROP CONSTRAINT IF EXISTS chk_kitchen_batch_vessel_pairing,
  ADD CONSTRAINT chk_kitchen_batch_vessel_pairing
    CHECK ((vessel_size IS NULL) = (vessel_unit IS NULL) AND (vessel_size IS NULL OR vessel_size > 0)),
  DROP CONSTRAINT IF EXISTS chk_kitchen_batch_vessel_unit,
  ADD CONSTRAINT chk_kitchen_batch_vessel_unit
    CHECK (vessel_unit IS NULL OR vessel_unit IN (
      'g','kg','oz','lb','ml','l','tsp','tbsp','fl oz','cup','pint','qt','gal',
      'count','clove','head','bunch','pinch','peck','bushel','half-bushel','flat','jar','bag','other')),
  DROP CONSTRAINT IF EXISTS chk_kitchen_batch_vessel_count,
  ADD CONSTRAINT chk_kitchen_batch_vessel_count
    CHECK (vessel_count IS NULL OR (vessel_count >= 1 AND vessel_count <= 50)),
  DROP CONSTRAINT IF EXISTS chk_kitchen_batch_no_salt_true,
  ADD CONSTRAINT chk_kitchen_batch_no_salt_true
    CHECK (no_salt IS NULL OR no_salt),
  DROP CONSTRAINT IF EXISTS chk_kitchen_batch_shu_est_range,
  ADD CONSTRAINT chk_kitchen_batch_shu_est_range
    CHECK ((shu_est_low IS NULL OR shu_est_low >= 0)
           AND (shu_est_high IS NULL OR (shu_est_low IS NOT NULL AND shu_est_high >= shu_est_low))),
  DROP CONSTRAINT IF EXISTS chk_kitchen_batch_shu_est_basis,
  ADD CONSTRAINT chk_kitchen_batch_shu_est_basis
    CHECK (shu_est_basis IS NULL OR shu_est_basis IN ('computed','typed')),
  DROP CONSTRAINT IF EXISTS chk_kitchen_batch_shu_est_pairing,
  ADD CONSTRAINT chk_kitchen_batch_shu_est_pairing
    CHECK ((shu_est_low IS NULL) = (shu_est_basis IS NULL)),
  DROP CONSTRAINT IF EXISTS chk_kitchen_batch_recipe_ref_nonblank,
  ADD CONSTRAINT chk_kitchen_batch_recipe_ref_nonblank
    CHECK (recipe_ref IS NULL OR (btrim(recipe_ref) <> '' AND char_length(recipe_ref) <= 500));

-- ── 2. kitchen_batch_input (lines) ───────────────────────────────────────────────────────────────
-- F writes input_kind 'harvest' for the optional pick link (06 §2.2, DS-I5): 1b 0a's "'harvest' ...
-- new UI never writes it" no longer holds; the README records the correction.
-- chk_kbi_salt_base is WIDENED IN PLACE (superset): 'produce' joins, 'peppers' stays for any 1b-era
-- row. The five T CHECKs tighten 1b's salt columns; gates.yml sweeps them first.
-- ⚠ `role IS NOT DISTINCT FROM 'salt'`, never `role = 'salt'`: a CHECK passes on NULL, so the `=`
-- spelling admits salt facts on every role-less line (caught by the rehearsal's planted violations).
ALTER TABLE public.kitchen_batch_input
  ADD COLUMN IF NOT EXISTS brand           text,
  ADD COLUMN IF NOT EXISTS form            text,
  ADD COLUMN IF NOT EXISTS shu_rating_low  integer,
  ADD COLUMN IF NOT EXISTS shu_rating_high integer,
  ADD COLUMN IF NOT EXISTS salt_method     text,
  ADD COLUMN IF NOT EXISTS base_from       text,
  ADD COLUMN IF NOT EXISTS edited_at       timestamptz,
  DROP CONSTRAINT IF EXISTS chk_kbi_salt_base,
  ADD CONSTRAINT chk_kbi_salt_base
    CHECK (salt_base IS NULL OR salt_base IN ('peppers','water','all','produce')),
  DROP CONSTRAINT IF EXISTS chk_kbi_salt_facts_on_salt_line,
  ADD CONSTRAINT chk_kbi_salt_facts_on_salt_line
    CHECK ((salt_pct IS NULL AND salt_base IS NULL AND base_g IS NULL) OR role IS NOT DISTINCT FROM 'salt'),
  DROP CONSTRAINT IF EXISTS chk_kbi_salt_facts_pairing,
  ADD CONSTRAINT chk_kbi_salt_facts_pairing
    CHECK ((salt_pct IS NULL) = (salt_base IS NULL) AND (salt_pct IS NULL) = (base_g IS NULL)),
  DROP CONSTRAINT IF EXISTS chk_kbi_salt_facts_grams,
  ADD CONSTRAINT chk_kbi_salt_facts_grams
    CHECK (salt_pct IS NULL OR qty_unit IS NOT DISTINCT FROM 'g'),
  DROP CONSTRAINT IF EXISTS chk_kbi_salt_pct_range,
  ADD CONSTRAINT chk_kbi_salt_pct_range
    CHECK (salt_pct IS NULL OR (salt_pct > 0 AND salt_pct <= 100)),
  DROP CONSTRAINT IF EXISTS chk_kbi_base_g_positive,
  ADD CONSTRAINT chk_kbi_base_g_positive
    CHECK (base_g IS NULL OR base_g > 0),
  DROP CONSTRAINT IF EXISTS chk_kbi_brand_nonblank,
  ADD CONSTRAINT chk_kbi_brand_nonblank
    CHECK (brand IS NULL OR (btrim(brand) <> '' AND char_length(brand) <= 120)),
  DROP CONSTRAINT IF EXISTS chk_kbi_form,
  ADD CONSTRAINT chk_kbi_form
    CHECK (form IS NULL OR form IN ('fresh','frozen','dried','cooked')),
  DROP CONSTRAINT IF EXISTS chk_kbi_form_not_on_role,
  ADD CONSTRAINT chk_kbi_form_not_on_role
    CHECK (form IS NULL OR role IS NULL),
  -- The rating typed on a line is the FRESH pepper's (Dave 2026-09-29 17:1x); a dried line is
  -- counted x7-x10 by the estimator, never by storing a scaled number here.
  DROP CONSTRAINT IF EXISTS chk_kbi_shu_rating_range,
  ADD CONSTRAINT chk_kbi_shu_rating_range
    CHECK ((shu_rating_low IS NULL OR shu_rating_low >= 0)
           AND (shu_rating_high IS NULL OR (shu_rating_low IS NOT NULL AND shu_rating_high >= shu_rating_low))),
  DROP CONSTRAINT IF EXISTS chk_kbi_shu_rating_not_on_role,
  ADD CONSTRAINT chk_kbi_shu_rating_not_on_role
    CHECK ((shu_rating_low IS NULL AND shu_rating_high IS NULL) OR role IS NULL),
  DROP CONSTRAINT IF EXISTS chk_kbi_salt_method,
  ADD CONSTRAINT chk_kbi_salt_method
    CHECK (salt_method IS NULL OR salt_method IN ('dry','brine','rinsed')),
  DROP CONSTRAINT IF EXISTS chk_kbi_salt_method_on_salt_line,
  ADD CONSTRAINT chk_kbi_salt_method_on_salt_line
    CHECK (salt_method IS NULL OR role IS NOT DISTINCT FROM 'salt'),
  DROP CONSTRAINT IF EXISTS chk_kbi_base_from,
  ADD CONSTRAINT chk_kbi_base_from
    CHECK (base_from IS NULL OR base_from IN ('lines','scale')),
  DROP CONSTRAINT IF EXISTS chk_kbi_base_from_needs_base,
  ADD CONSTRAINT chk_kbi_base_from_needs_base
    CHECK (base_from IS NULL OR base_g IS NOT NULL);

-- The target of pantry_use's same-jar composite FK. Trivially unique (id is the key); created only if
-- absent because the FK depends on it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                   JOIN pg_class t ON t.oid = c.conrelid
                   JOIN pg_namespace n ON n.oid = t.relnamespace
                  WHERE n.nspname = 'public' AND t.relname = 'kitchen_batch_input'
                    AND c.conname = 'uq_kbi_id_preservation_log_id') THEN
    ALTER TABLE public.kitchen_batch_input
      ADD CONSTRAINT uq_kbi_id_preservation_log_id UNIQUE (id, preservation_log_id);
  END IF;
END $$;

-- ── 3. kitchen_stage_log ─────────────────────────────────────────────────────────────────────────
-- acts: what he did at a check-in (Dave 16:30). mash_in_g: drained solids at a bottling. No
-- deleted_at is added (1b 0a §2), which is why its audit uses the _no_soft_delete function.
ALTER TABLE public.kitchen_stage_log
  ADD COLUMN IF NOT EXISTS acts      text[],
  ADD COLUMN IF NOT EXISTS mash_in_g numeric,
  ADD COLUMN IF NOT EXISTS edited_at timestamptz,
  DROP CONSTRAINT IF EXISTS chk_ksl_acts,
  ADD CONSTRAINT chk_ksl_acts
    CHECK (acts IS NULL
           OR (cardinality(acts) > 0 AND acts <@ ARRAY['topped_up','pushed_under','skimmed']::text[])),
  DROP CONSTRAINT IF EXISTS chk_ksl_acts_on_tended,
  ADD CONSTRAINT chk_ksl_acts_on_tended
    CHECK (acts IS NULL OR stage_kind = 'tended'),
  DROP CONSTRAINT IF EXISTS chk_ksl_mash_in_g,
  ADD CONSTRAINT chk_ksl_mash_in_g
    CHECK (mash_in_g IS NULL OR (mash_in_g > 0 AND stage_kind = 'put_up'));

-- ── 4. preservation_log (jars) ───────────────────────────────────────────────────────────────────
-- delta_at and remaining_amount are server-set only (never in PRESERVATION_EDITABLE_COLUMNS or
-- buildFullPayload). remaining_amount is grams; >= 0 is what turns an over-draw into a 23514 on this
-- name (the route maps it to 409 only_g_left).
ALTER TABLE public.preservation_log
  ADD COLUMN IF NOT EXISTS shu_est_low      integer,
  ADD COLUMN IF NOT EXISTS shu_est_high     integer,
  ADD COLUMN IF NOT EXISTS shu_est_basis    text,
  ADD COLUMN IF NOT EXISTS cooked           boolean,
  ADD COLUMN IF NOT EXISTS delta_at         timestamptz,
  ADD COLUMN IF NOT EXISTS remaining_amount numeric,
  DROP CONSTRAINT IF EXISTS chk_preservation_log_shu_est_range,
  ADD CONSTRAINT chk_preservation_log_shu_est_range
    CHECK ((shu_est_low IS NULL OR shu_est_low >= 0)
           AND (shu_est_high IS NULL OR (shu_est_low IS NOT NULL AND shu_est_high >= shu_est_low))),
  DROP CONSTRAINT IF EXISTS chk_preservation_log_shu_est_basis,
  ADD CONSTRAINT chk_preservation_log_shu_est_basis
    CHECK (shu_est_basis IS NULL OR shu_est_basis IN ('computed','typed')),
  DROP CONSTRAINT IF EXISTS chk_preservation_log_shu_est_pairing,
  ADD CONSTRAINT chk_preservation_log_shu_est_pairing
    CHECK ((shu_est_low IS NULL) = (shu_est_basis IS NULL)),
  DROP CONSTRAINT IF EXISTS chk_preservation_log_remaining_amount,
  ADD CONSTRAINT chk_preservation_log_remaining_amount
    CHECK (remaining_amount IS NULL OR remaining_amount >= 0);

-- 1b's nine plus the four F columns a person moves: thirteen. Same shape as 1b's (tgtype 16, both
-- transition tables). 1b's post_audit_watches_exactly_the_nine stands down on this file's stamp;
-- gates.yml's post_audit_watches_exactly_the_thirteen takes over.
DROP TRIGGER IF EXISTS trg_audit_preservation_log_upd ON public.preservation_log;
CREATE TRIGGER trg_audit_preservation_log_upd
  AFTER UPDATE ON public.preservation_log
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.audit_stmt_update(
    'storage_location_id', 'use_by_target', 'use_by_basis', 'package_count', 'remaining_count',
    'label', 'is_raw', 'in_oil', 'deleted_at', 'remaining_amount', 'shu_est_low', 'shu_est_high',
    'cooked');

-- ── 5. pantry_use (new) ──────────────────────────────────────────────────────────────────────────
-- The use ledger (V4 §4.3, as narrowed by 06 §1.3). A use-route row carries the tap's key; a
-- line-driven row (draw, reversal, re-draw) carries NULL — the event and its key live on the line.
CREATE TABLE IF NOT EXISTS public.pantry_use (
  id                     uuid        DEFAULT gen_random_uuid() NOT NULL,
  created_by             text        NOT NULL,
  preservation_log_id    uuid        NOT NULL,
  count_used             integer     NOT NULL,
  fate                   text,
  kitchen_batch_input_id uuid,
  reverses_use_id        uuid,
  idempotency_key        uuid,
  used_at                timestamptz DEFAULT now() NOT NULL,
  note                   text,
  created_at             timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT pantry_use_pkey PRIMARY KEY (id)
);

-- The two UNIQUE constraints a composite FK depends on are created only if absent.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                   JOIN pg_class t ON t.oid = c.conrelid
                   JOIN pg_namespace n ON n.oid = t.relnamespace
                  WHERE n.nspname = 'public' AND t.relname = 'pantry_use'
                    AND c.conname = 'uq_pantry_use_id_preservation_log_id') THEN
    ALTER TABLE public.pantry_use
      ADD CONSTRAINT uq_pantry_use_id_preservation_log_id UNIQUE (id, preservation_log_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                   JOIN pg_class t ON t.oid = c.conrelid
                   JOIN pg_namespace n ON n.oid = t.relnamespace
                  WHERE n.nspname = 'public' AND t.relname = 'pantry_use'
                    AND c.conname = 'uq_pantry_use_reverses_use_id') THEN
    ALTER TABLE public.pantry_use
      ADD CONSTRAINT uq_pantry_use_reverses_use_id UNIQUE (reverses_use_id);
  END IF;
END $$;

ALTER TABLE public.pantry_use
  DROP CONSTRAINT IF EXISTS chk_pantry_use_count_nonzero,
  ADD CONSTRAINT chk_pantry_use_count_nonzero
    CHECK (count_used <> 0),
  DROP CONSTRAINT IF EXISTS chk_pantry_use_negative_is_reversal,
  ADD CONSTRAINT chk_pantry_use_negative_is_reversal
    CHECK ((count_used < 0) = (reverses_use_id IS NOT NULL)),
  DROP CONSTRAINT IF EXISTS chk_pantry_use_fate,
  ADD CONSTRAINT chk_pantry_use_fate
    CHECK (fate IS NULL OR fate IN ('batch','discarded','given_away')),
  DROP CONSTRAINT IF EXISTS chk_pantry_use_batch_line,
  ADD CONSTRAINT chk_pantry_use_batch_line
    CHECK ((kitchen_batch_input_id IS NOT NULL) = (fate IS NOT DISTINCT FROM 'batch')),
  DROP CONSTRAINT IF EXISTS pantry_use_preservation_log_id_fkey,
  ADD CONSTRAINT pantry_use_preservation_log_id_fkey
    FOREIGN KEY (preservation_log_id) REFERENCES public.preservation_log (id) ON DELETE NO ACTION,
  DROP CONSTRAINT IF EXISTS pantry_use_kitchen_batch_input_id_fkey,
  ADD CONSTRAINT pantry_use_kitchen_batch_input_id_fkey
    FOREIGN KEY (kitchen_batch_input_id) REFERENCES public.kitchen_batch_input (id) ON DELETE NO ACTION,
  -- A line's use names the line's own jar (MATCH SIMPLE: enforced whenever the line id is set, and
  -- preservation_log_id is NOT NULL here).
  DROP CONSTRAINT IF EXISTS pantry_use_line_same_jar_fkey,
  ADD CONSTRAINT pantry_use_line_same_jar_fkey
    FOREIGN KEY (kitchen_batch_input_id, preservation_log_id)
    REFERENCES public.kitchen_batch_input (id, preservation_log_id) ON DELETE NO ACTION,
  -- A reversal names the same jar as the use it reverses.
  DROP CONSTRAINT IF EXISTS pantry_use_reverses_same_jar_fkey,
  ADD CONSTRAINT pantry_use_reverses_same_jar_fkey
    FOREIGN KEY (reverses_use_id, preservation_log_id)
    REFERENCES public.pantry_use (id, preservation_log_id) ON DELETE NO ACTION;

-- Global, partial: a 23505 on THIS name is a replay (V4 §5.2).
CREATE UNIQUE INDEX IF NOT EXISTS uq_pantry_use_idempotency_key
  ON public.pantry_use (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pantry_use_jar
  ON public.pantry_use (preservation_log_id, used_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_pantry_use_line
  ON public.pantry_use (kitchen_batch_input_id) WHERE kitchen_batch_input_id IS NOT NULL;

-- The created_by variant, reused unchanged (this table's owner column IS created_by).
DROP TRIGGER IF EXISTS prevent_pantry_use_ownership_transfer ON public.pantry_use;
CREATE TRIGGER prevent_pantry_use_ownership_transfer
  BEFORE UPDATE ON public.pantry_use
  FOR EACH ROW EXECUTE FUNCTION public.prevent_ownership_transfer();

-- ── 6. Functions: the soft-delete-free audit writer and the two identity guards ──────────────────
-- audit_stmt_update's body (v4-harvestaudit-001) minus the deleted_at legs: action is always
-- 'UPDATE', and the WHERE compares only the watched slice. Same contract otherwise: SECURITY DEFINER,
-- a pinned search_path, and a failure is a WARNING that never aborts the originating statement.
CREATE OR REPLACE FUNCTION public.audit_stmt_update_no_soft_delete() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  v_watched text[] := TG_ARGV;
BEGIN
  BEGIN
    INSERT INTO public.audit_events
           (table_name, row_id, action, actor_clerk_sub, before_jsonb, after_jsonb)
    SELECT TG_TABLE_NAME,
           n.id,
           'UPDATE',
           COALESCE(NULLIF(current_setting('app.actor_clerk_sub', true), ''), 'system'),
           to_jsonb(o),
           to_jsonb(n)
      FROM new_rows n
      JOIN old_rows o ON o.id = n.id
     WHERE public.audit_watched_slice(to_jsonb(o), v_watched)
           IS DISTINCT FROM
           public.audit_watched_slice(to_jsonb(n), v_watched);
  EXCEPTION
    WHEN query_canceled OR admin_shutdown THEN
      RAISE;
    WHEN OTHERS THEN
      RAISE WARNING 'audit_stmt_update_no_soft_delete(%): audit write FAILED, SQLSTATE=% (%). The originating UPDATE is unaffected.',
        TG_TABLE_NAME, SQLSTATE, SQLERRM;
  END;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.audit_stmt_update_no_soft_delete() IS 'V5-FERMENTPATH-001. audit_stmt_update() for a table with NO deleted_at column (kitchen_stage_log): the same AFTER UPDATE FOR EACH STATEMENT writer without the SOFT_DELETE/RESTORE legs, which would raise 42703 there and be swallowed as a WARNING. Requires REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows and the watched column list as trigger arguments. Cannot abort the originating statement.';

CREATE OR REPLACE FUNCTION public.prevent_ksl_identity_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.batch_id IS DISTINCT FROM NEW.batch_id THEN
    RAISE EXCEPTION 'kitchen_stage_log.batch_id cannot change';
  END IF;
  IF OLD.stage_kind IS DISTINCT FROM NEW.stage_kind THEN
    RAISE EXCEPTION 'kitchen_stage_log.stage_kind cannot change';
  END IF;
  IF OLD.voids_id IS DISTINCT FROM NEW.voids_id THEN
    RAISE EXCEPTION 'kitchen_stage_log.voids_id cannot change';
  END IF;
  IF OLD.created_by IS DISTINCT FROM NEW.created_by THEN
    RAISE EXCEPTION 'kitchen_stage_log.created_by cannot change';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.prevent_ksl_identity_change() IS 'V5-FERMENTPATH-001. A stage row is edited in place (06 §3.7) but never re-kinded, moved to another batch, re-pointed as a void or re-owned. Names only kitchen_stage_log columns.';

-- plant_id is NOT here on purpose: its FK is ON DELETE SET NULL, so a planting hard delete and the
-- planting merge repoint both UPDATE it. deleted_at is the soft delete itself.
CREATE OR REPLACE FUNCTION public.prevent_kbi_identity_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.batch_id IS DISTINCT FROM NEW.batch_id THEN
    RAISE EXCEPTION 'kitchen_batch_input.batch_id cannot change';
  END IF;
  IF OLD.created_by IS DISTINCT FROM NEW.created_by THEN
    RAISE EXCEPTION 'kitchen_batch_input.created_by cannot change';
  END IF;
  IF OLD.input_kind IS DISTINCT FROM NEW.input_kind THEN
    RAISE EXCEPTION 'kitchen_batch_input.input_kind cannot change';
  END IF;
  IF OLD.preservation_log_id IS DISTINCT FROM NEW.preservation_log_id THEN
    RAISE EXCEPTION 'kitchen_batch_input.preservation_log_id cannot change';
  END IF;
  IF OLD.harvest_log_id IS DISTINCT FROM NEW.harvest_log_id THEN
    RAISE EXCEPTION 'kitchen_batch_input.harvest_log_id cannot change';
  END IF;
  IF OLD.put_up_stage_id IS DISTINCT FROM NEW.put_up_stage_id THEN
    RAISE EXCEPTION 'kitchen_batch_input.put_up_stage_id cannot change';
  END IF;
  IF OLD.output_id IS DISTINCT FROM NEW.output_id THEN
    RAISE EXCEPTION 'kitchen_batch_input.output_id cannot change';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.prevent_kbi_identity_change() IS 'V5-FERMENTPATH-001. A line is edited in place (06 §3.7) but what it IS (its batch, owner, kind, the jar/pick it draws, its sitting and row) is changed only by taking it out and adding it again. plant_id and deleted_at stay mutable (SET NULL RI action, merge repoint, soft delete). Names only kitchen_batch_input columns.';

-- ── 7. Triggers on the two kitchen tables ────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_ksl_identity ON public.kitchen_stage_log;
CREATE TRIGGER trg_ksl_identity
  BEFORE UPDATE ON public.kitchen_stage_log
  FOR EACH ROW EXECUTE FUNCTION public.prevent_ksl_identity_change();

DROP TRIGGER IF EXISTS trg_kbi_identity ON public.kitchen_batch_input;
CREATE TRIGGER trg_kbi_identity
  BEFORE UPDATE ON public.kitchen_batch_input
  FOR EACH ROW EXECUTE FUNCTION public.prevent_kbi_identity_change();

DROP TRIGGER IF EXISTS trg_audit_kitchen_stage_log_upd ON public.kitchen_stage_log;
CREATE TRIGGER trg_audit_kitchen_stage_log_upd
  AFTER UPDATE ON public.kitchen_stage_log
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.audit_stmt_update_no_soft_delete(
    'note', 'cue_observed', 'acts', 'ph_reading', 'ph_read_at', 'amount', 'amount_unit',
    'mash_in_g', 'entered_at', 'entered_precision', 'storage_location_id', 'label', 'photo_id');

DROP TRIGGER IF EXISTS trg_audit_kitchen_batch_input_upd ON public.kitchen_batch_input;
CREATE TRIGGER trg_audit_kitchen_batch_input_upd
  AFTER UPDATE ON public.kitchen_batch_input
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.audit_stmt_update(
    'label', 'qty', 'qty_unit', 'form', 'brand', 'note', 'role', 'salt_pct', 'salt_base', 'base_g',
    'salt_method', 'base_from', 'shu_rating_low', 'shu_rating_high', 'ordinal', 'deleted_at');

-- ── 8. v_kitchen_batch_current ───────────────────────────────────────────────────────────────────
-- 1b's body verbatim with kitchen_batch's nine F columns appended as 32-40. CREATE OR REPLACE (the
-- ACL survives; no GRANT). View = kitchen_batch + 8 still holds (v5-phrecord-001
-- post_view_gained_exactly_two). B''s recipe_id goes to 41.
CREATE OR REPLACE VIEW public.v_kitchen_batch_current AS
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

-- ── 9. The stamp, in the same transaction as everything above. ──────────────────────────────────
INSERT INTO public.schema_version (version, description)
VALUES ('5.0.0-fermentpath-001',
        'V5-FERMENTPATH-001 (Put-Up release F, the ferment path): kitchen_batch gains vessel_label/size/unit/'
        'count, no_salt, shu_est_low/high/basis, recipe_ref; kitchen_batch_input gains brand, form, '
        'shu_rating_low/high, salt_method, base_from, edited_at, salt_base admits produce, five salt-fact '
        'CHECKs; kitchen_stage_log gains acts, mash_in_g, edited_at; preservation_log gains shu_est_*, '
        'cooked, delta_at, remaining_amount and its audit watches thirteen; new pantry_use; identity '
        'triggers on kitchen_stage_log and kitchen_batch_input; both audited (kitchen_stage_log through the '
        'new audit_stmt_update_no_soft_delete); v_kitchen_batch_current appends the nine batch columns.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
