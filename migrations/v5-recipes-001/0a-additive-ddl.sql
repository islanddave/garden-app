-- 0a-additive-ddl.sql
-- schema_version: 5.0.0-recipes-001
--
-- V5-RECIPES-001 — Put-Up release 4 (recipes), the database half. One file, one transaction, the stamp
--   written inside it. Plan: project-state/_crucible-pantry-20260928/04-design-final.md (V4) §2.6, §3.1,
--   §3.8 and §4.5, as amended by 05-release-train.md §6 ("All B releases", "4:") and 06-ferment-path.md
--   §1.5 (what a recipe carries from a batch). The line above is machine-read by the train step in
--   .github/workflows/integration-test.yml; keep it the second line and keep it equal to the INSERT at
--   the bottom.
--
-- THE STAMP IS FIXED: '5.0.0-recipes-001'. Never edit it after the first apply anywhere: every standing
--   gate in gates.yml self-arms on it.
--
-- APPLIES ON TOP OF F. v5-fermentpath-001 (stamp '5.0.0-fermentpath-001') must already be applied; the
--   guard below refuses otherwise. B′'s releases 2 and 3 (v5-pantry-001, v5-batchbuilder-001) may be
--   applied before this file; neither touches v_kitchen_batch_current (if one ever does, the fingerprint
--   guard below refuses — fold its change into this file, re-pin, re-rehearse).
--
-- WHAT IT ADDS
--   * recipe — a household recipe (V4 §2.6 / §4.5): name, kind (the batch-kind vocabulary), link_url
--     (http/https only), notes (his text, verbatim: ratio rules, day gates, serve notes and his own
--     target pH live HERE and nowhere else), the keeps line (n · day/week/month · storage kind — all
--     three or none), and what F §1.5 says a batch hands a recipe without retyping: the vessel
--     (label/size/unit/count), "No salt", mash_in_g and Made (made_g). idempotency_key (global unique
--     partial: a 23505 on uq_recipe_idempotency_key is a replay). set_updated_at, the user_id ownership
--     trigger, soft delete.
--   * recipe_ingredient — the lines (name + amount as written + the "at the end" flag), with every F
--     line fact a recipe can carry: qty/qty_unit (KITCHEN_UNITS), form, brand, role (salt/water), note,
--     the listed heat (shu_rating_low/high) and the salt facts (salt_pct, salt_base, base_g,
--     salt_method, base_from). recipe_id FK NO ACTION (no CASCADE onto a soft-deletable table,
--     v4-cascadesweep-001); an identity trigger keeps a line on its recipe. Soft delete.
--   * recipe_type — what a recipe makes (Hot sauce, Salsa & chutney, Pesto, Jam & preserve …): fifteen
--     built-ins plus types the household creates from the picker (find-or-create by lower(btrim(label)),
--     soft delete), and recipe.recipe_type_id (FK NO ACTION, household-loaded by the route). Dave,
--     2026-09-30. recipe.kind stays the batch PROCESS word, nullable.
--   * kitchen_batch.recipe_id — uuid + FK NO ACTION (the batch create route accepts it from release 4;
--     F's free-text recipe_ref stays beside it).
--   * v_kitchen_batch_current — F's 40 columns kept in order, recipe_id appended at 41 (05 §6 "4:").
--
-- NO target_ph, NO tested COLUMN, EVER (V4 §3.8). His target pH is text inside recipe.notes; no column,
--   CHECK or trigger here names a pH. gates.yml asserts the absence.
--
-- WHY THE DEPLOYED WRITER (F's) IS UNAFFECTED (the house rule). Every change is one of: two new tables
--   F never names; a new nullable column on kitchen_batch with no CHECK (F's create INSERT names its
--   columns and omits it; F's merge PUT is an explicit allowlist without it); a NO ACTION FK over that
--   column (vacuous while every row is NULL); the view with recipe_id APPENDED (F reads SELECT *, so
--   it gains one NULL key, as it gained nine from F and one from 1b). Every CHECK is created VALIDATED
--   over new columns only. NOT VALID is never the remedy.
--
-- OWNERSHIP (05 §6 "All B releases"). recipe's owner column is user_id, so its trigger executes the
--   user_id variant, public.prevent_kitchen_batch_ownership_transfer() (v5-kbownertrigger-001), reused
--   unchanged exactly as 1b reused it for preservation_log — NOT prevent_ownership_transfer(), which
--   reads created_by. The trigger is named per table (prevent_recipe_ownership_transfer) and a
--   continuous gate asserts its function names only real recipe columns. recipe_ingredient has no owner
--   column: a line takes its owner from its recipe, and prevent_recipe_ingredient_identity_change()
--   keeps it there.
--
-- THE FINGERPRINT GUARD (first statement after BEGIN) refuses unless the view is F's definition or this
--   file's own (a re-apply). If you edit the view below, re-pin its md5 here, in 0r and in gates.yml.
--
-- IDEMPOTENT: CREATE TABLE / INDEX IF NOT EXISTS; ADD COLUMN IF NOT EXISTS; every CHECK and FK is
--   DROP IF EXISTS + ADD in one statement; functions and the view CREATE OR REPLACE; triggers DROP IF
--   EXISTS + CREATE; the stamp ON CONFLICT DO NOTHING. Re-running the whole file changes nothing.
--
-- ⚠ Exactly ONE COMMIT, at the end. Do not wrap this file in BEGIN/ROLLBACK to "rehearse" it on a
--   shared database: its own COMMIT ends your transaction. Rehearse on a local PostgreSQL (README.md).
--
-- ROLLBACK: 0r-rollback.sql — guarded; refuses once a recipe exists or a batch names one.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. Guards: F is applied, and the view is F's or this file's. ─────────────────────────────────
DO $$
DECLARE
  v_view text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-fermentpath-001') THEN
    RAISE EXCEPTION 'v5-recipes-001 0a refused: v5-fermentpath-001 (5.0.0-fermentpath-001) is not applied here. Recipes apply on top of F only.';
  END IF;
  SELECT md5(pg_get_viewdef(c.oid, true)) INTO v_view
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'v_kitchen_batch_current' AND c.relkind = 'v';
  IF v_view IS DISTINCT FROM 'b70ac2f238dfc9d09e8db2017c0e7474'
     AND v_view IS DISTINCT FROM 'c5e32311816088488bcbb315e8703ae0' THEN
    RAISE EXCEPTION 'v5-recipes-001 0a refused: v_kitchen_batch_current is md5 %, neither F''s definition (b70ac2f238dfc9d09e8db2017c0e7474) nor this file''s (c5e32311816088488bcbb315e8703ae0). Someone changed it after F: fold their change into this file, re-pin, and re-rehearse.', v_view;
  END IF;
END $$;

-- ── 1. recipe_type (Dave 2026-09-30: "what the recipe makes", and he can create a type) ──────────
-- The create-a-type precedent copied: crop_types (lambda/varieties POST /api/varieties/crop-types —
-- "always-add-on-the-fly": built-in rows plus rows minted from the picker, a minted name that already
-- exists steers to the existing row, a soft-deleted one is restored rather than duplicated) crossed with
-- storage_location's household find-or-create on lower(btrim(label)) (1b's place create). Built-ins have
-- user_id NULL and a fixed id and sort_order; a household row has the minting person's user_id and is
-- visible to the household. Separate from recipe.kind, which stays the batch PROCESS word.
CREATE TABLE IF NOT EXISTS public.recipe_type (
  id         uuid        DEFAULT gen_random_uuid() NOT NULL,
  user_id    text,
  label      text        NOT NULL,
  sort_order integer     DEFAULT 1000 NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  deleted_at timestamptz,
  CONSTRAINT recipe_type_pkey PRIMARY KEY (id)
);

ALTER TABLE public.recipe_type
  DROP CONSTRAINT IF EXISTS chk_recipe_type_label_nonblank,
  ADD CONSTRAINT chk_recipe_type_label_nonblank
    CHECK (btrim(label) <> '' AND char_length(label) <= 60);

-- One live built-in per name; one live household row per (owner, name). The route finds before it
-- creates (built-ins first, then the household's), so the per-owner UNIQUE is the race backstop the
-- route's ON CONFLICT reads, exactly as uq_storage_location_user_kind_label is for places.
CREATE UNIQUE INDEX IF NOT EXISTS uq_recipe_type_builtin_label
  ON public.recipe_type (lower(btrim(label))) WHERE user_id IS NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_recipe_type_user_label
  ON public.recipe_type (user_id, lower(btrim(label))) WHERE user_id IS NOT NULL AND deleted_at IS NULL;

DROP TRIGGER IF EXISTS set_updated_at ON public.recipe_type;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.recipe_type
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS prevent_recipe_type_ownership_transfer ON public.recipe_type;
CREATE TRIGGER prevent_recipe_type_ownership_transfer
  BEFORE UPDATE ON public.recipe_type
  FOR EACH ROW EXECUTE FUNCTION public.prevent_kitchen_batch_ownership_transfer();

-- The fifteen built-ins, in Dave's order (2026-09-30). Fixed ids so every environment names them alike
-- (lambda/preservation/recipeRules.js RECIPE_BUILTIN_TYPES mirrors this list; a parity test binds it).
-- Idempotent: a built-in already present (live, by id) is left exactly as it is.
INSERT INTO public.recipe_type (id, user_id, label, sort_order)
SELECT v.id::uuid, NULL, v.label, v.sort_order
  FROM (VALUES
         ('7ec1be00-0000-4000-8000-000000000001', 'Hot sauce',                 10),
         ('7ec1be00-0000-4000-8000-000000000002', 'Chili paste',               20),
         ('7ec1be00-0000-4000-8000-000000000003', 'Salsa & chutney',           30),
         ('7ec1be00-0000-4000-8000-000000000004', 'Chili crisp & oil',         40),
         ('7ec1be00-0000-4000-8000-000000000005', 'Glaze & wing sauce',        50),
         ('7ec1be00-0000-4000-8000-000000000006', 'Pesto',                     60),
         ('7ec1be00-0000-4000-8000-000000000007', 'Jam & preserve',            70),
         ('7ec1be00-0000-4000-8000-000000000008', 'Pickle',                    80),
         ('7ec1be00-0000-4000-8000-000000000009', 'Canned vegetables',         90),
         ('7ec1be00-0000-4000-8000-000000000010', 'Canned fruit',             100),
         ('7ec1be00-0000-4000-8000-000000000011', 'Fruit leather & snacks',   110),
         ('7ec1be00-0000-4000-8000-000000000012', 'Candy',                    120),
         ('7ec1be00-0000-4000-8000-000000000013', 'Spice & powder',           130),
         ('7ec1be00-0000-4000-8000-000000000014', 'Ferment (kraut, kimchi…)', 140),
         ('7ec1be00-0000-4000-8000-000000000015', 'Other',                    150)) AS v(id, label, sort_order)
 WHERE NOT EXISTS (SELECT 1 FROM public.recipe_type t WHERE t.id = v.id::uuid);

-- ── 2. recipe ────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.recipe (
  id                 uuid        DEFAULT gen_random_uuid() NOT NULL,
  user_id            text        NOT NULL,
  name               text        NOT NULL,
  kind               text,
  recipe_type_id     uuid,
  link_url           text,
  notes              text,
  keeps_n            integer,
  keeps_unit         text,
  keeps_storage_kind text,
  vessel_label       text,
  vessel_size        numeric,
  vessel_unit        text,
  vessel_count       smallint,
  no_salt            boolean,
  mash_in_g          numeric,
  made_g             numeric,
  idempotency_key    uuid,
  created_at         timestamptz DEFAULT now() NOT NULL,
  updated_at         timestamptz DEFAULT now() NOT NULL,
  deleted_at         timestamptz,
  CONSTRAINT recipe_pkey PRIMARY KEY (id)
);

-- The CHECKs restate the Lambda's rules (lambda/preservation/recipeRules.js); the Lambda's messages are
-- the product, these are the belt.
ALTER TABLE public.recipe
  DROP CONSTRAINT IF EXISTS chk_recipe_name_nonblank,
  ADD CONSTRAINT chk_recipe_name_nonblank
    CHECK (btrim(name) <> '' AND char_length(name) <= 120),
  -- chk_kitchen_batch_kind's vocabulary (the batch-kind words). NULL = not said.
  DROP CONSTRAINT IF EXISTS chk_recipe_kind,
  ADD CONSTRAINT chk_recipe_kind
    CHECK (kind IS NULL OR kind IN ('ferment','dehydrate','candy','cure','infuse','age','other')),
  -- http/https only: a javascript: or data: link is refused here as well as in the route.
  DROP CONSTRAINT IF EXISTS chk_recipe_link_url,
  ADD CONSTRAINT chk_recipe_link_url
    CHECK (link_url IS NULL
           OR (link_url ~* '^https?://[^[:space:]]+$' AND char_length(link_url) <= 2000)),
  DROP CONSTRAINT IF EXISTS chk_recipe_notes_nonblank,
  ADD CONSTRAINT chk_recipe_notes_nonblank
    CHECK (notes IS NULL OR (btrim(notes) <> '' AND char_length(notes) <= 20000)),
  -- The keeps line: all three or none; n > 0.
  DROP CONSTRAINT IF EXISTS chk_recipe_keeps_whole,
  ADD CONSTRAINT chk_recipe_keeps_whole
    CHECK ((keeps_n IS NULL) = (keeps_unit IS NULL) AND (keeps_n IS NULL) = (keeps_storage_kind IS NULL)),
  DROP CONSTRAINT IF EXISTS chk_recipe_keeps_n,
  ADD CONSTRAINT chk_recipe_keeps_n
    CHECK (keeps_n IS NULL OR (keeps_n > 0 AND keeps_n <= 1000)),
  DROP CONSTRAINT IF EXISTS chk_recipe_keeps_unit,
  ADD CONSTRAINT chk_recipe_keeps_unit
    CHECK (keeps_unit IS NULL OR keeps_unit IN ('day','week','month')),
  -- storage_location.kind's vocabulary (chk_storage_location_kind).
  DROP CONSTRAINT IF EXISTS chk_recipe_keeps_storage_kind,
  ADD CONSTRAINT chk_recipe_keeps_storage_kind
    CHECK (keeps_storage_kind IS NULL OR keeps_storage_kind IN
           ('deep_freezer','fridge_freezer','fridge','pantry','cold_storage','other')),
  -- The vessel, as kitchen_batch carries it (F's chk_kitchen_batch_vessel_*).
  DROP CONSTRAINT IF EXISTS chk_recipe_vessel_label_nonblank,
  ADD CONSTRAINT chk_recipe_vessel_label_nonblank
    CHECK (vessel_label IS NULL OR (btrim(vessel_label) <> '' AND char_length(vessel_label) <= 120)),
  DROP CONSTRAINT IF EXISTS chk_recipe_vessel_pairing,
  ADD CONSTRAINT chk_recipe_vessel_pairing
    CHECK ((vessel_size IS NULL) = (vessel_unit IS NULL) AND (vessel_size IS NULL OR vessel_size > 0)),
  DROP CONSTRAINT IF EXISTS chk_recipe_vessel_unit,
  ADD CONSTRAINT chk_recipe_vessel_unit
    CHECK (vessel_unit IS NULL OR vessel_unit IN (
      'g','kg','oz','lb','ml','l','tsp','tbsp','fl oz','cup','pint','qt','gal',
      'count','clove','head','bunch','pinch','peck','bushel','half-bushel','flat','jar','bag','other')),
  DROP CONSTRAINT IF EXISTS chk_recipe_vessel_count,
  ADD CONSTRAINT chk_recipe_vessel_count
    CHECK (vessel_count IS NULL OR (vessel_count >= 1 AND vessel_count <= 50)),
  DROP CONSTRAINT IF EXISTS chk_recipe_no_salt_true,
  ADD CONSTRAINT chk_recipe_no_salt_true
    CHECK (no_salt IS NULL OR no_salt),
  DROP CONSTRAINT IF EXISTS chk_recipe_mash_in_g,
  ADD CONSTRAINT chk_recipe_mash_in_g
    CHECK (mash_in_g IS NULL OR mash_in_g > 0),
  DROP CONSTRAINT IF EXISTS chk_recipe_made_g,
  ADD CONSTRAINT chk_recipe_made_g
    CHECK (made_g IS NULL OR made_g > 0);

-- What the recipe makes. NO ACTION: a type is soft-deleted, never hard-deleted by the app.
ALTER TABLE public.recipe
  DROP CONSTRAINT IF EXISTS recipe_recipe_type_id_fkey,
  ADD CONSTRAINT recipe_recipe_type_id_fkey
    FOREIGN KEY (recipe_type_id) REFERENCES public.recipe_type (id) ON DELETE NO ACTION;

-- Global, partial: a 23505 on THIS name is a replay (V4 §5.2).
CREATE UNIQUE INDEX IF NOT EXISTS uq_recipe_idempotency_key
  ON public.recipe (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_recipe_user_live
  ON public.recipe (user_id) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS set_updated_at ON public.recipe;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.recipe
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- The user_id variant, reused unchanged (v5-kbownertrigger-001; 1b reused it for preservation_log).
DROP TRIGGER IF EXISTS prevent_recipe_ownership_transfer ON public.recipe;
CREATE TRIGGER prevent_recipe_ownership_transfer
  BEFORE UPDATE ON public.recipe
  FOR EACH ROW EXECUTE FUNCTION public.prevent_kitchen_batch_ownership_transfer();

-- ── 3. recipe_ingredient ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.recipe_ingredient (
  id              uuid        DEFAULT gen_random_uuid() NOT NULL,
  recipe_id       uuid        NOT NULL,
  ordinal         integer     NOT NULL,
  name            text        NOT NULL,
  amount_text     text,
  qty             numeric,
  qty_unit        text,
  at_the_end      boolean     DEFAULT false NOT NULL,
  form            text,
  brand           text,
  role            text,
  note            text,
  shu_rating_low  integer,
  shu_rating_high integer,
  salt_pct        numeric,
  salt_base       text,
  base_g          numeric,
  salt_method     text,
  base_from       text,
  created_at      timestamptz DEFAULT now() NOT NULL,
  deleted_at      timestamptz,
  CONSTRAINT recipe_ingredient_pkey PRIMARY KEY (id)
);

-- Every line CHECK mirrors F's kitchen_batch_input CHECK of the same meaning (v5-fermentpath-001),
-- NULL-safe the same way: `role IS NOT DISTINCT FROM 'salt'`, never `role = 'salt'`.
ALTER TABLE public.recipe_ingredient
  DROP CONSTRAINT IF EXISTS recipe_ingredient_recipe_id_fkey,
  ADD CONSTRAINT recipe_ingredient_recipe_id_fkey
    FOREIGN KEY (recipe_id) REFERENCES public.recipe (id) ON DELETE NO ACTION,
  DROP CONSTRAINT IF EXISTS chk_ri_name_nonblank,
  ADD CONSTRAINT chk_ri_name_nonblank
    CHECK (btrim(name) <> '' AND char_length(name) <= 200),
  DROP CONSTRAINT IF EXISTS chk_ri_amount_text_nonblank,
  ADD CONSTRAINT chk_ri_amount_text_nonblank
    CHECK (amount_text IS NULL OR (btrim(amount_text) <> '' AND char_length(amount_text) <= 500)),
  DROP CONSTRAINT IF EXISTS chk_ri_qty_pairing,
  ADD CONSTRAINT chk_ri_qty_pairing
    CHECK ((qty IS NULL) = (qty_unit IS NULL) AND (qty IS NULL OR qty > 0)),
  DROP CONSTRAINT IF EXISTS chk_ri_qty_unit,
  ADD CONSTRAINT chk_ri_qty_unit
    CHECK (qty_unit IS NULL OR qty_unit IN (
      'g','kg','oz','lb','ml','l','tsp','tbsp','fl oz','cup','pint','qt','gal',
      'count','clove','head','bunch','pinch','peck','bushel','half-bushel','flat','jar','bag','other')),
  DROP CONSTRAINT IF EXISTS chk_ri_form,
  ADD CONSTRAINT chk_ri_form
    CHECK (form IS NULL OR form IN ('fresh','frozen','dried','cooked')),
  DROP CONSTRAINT IF EXISTS chk_ri_role,
  ADD CONSTRAINT chk_ri_role
    CHECK (role IS NULL OR role IN ('salt','water')),
  DROP CONSTRAINT IF EXISTS chk_ri_form_not_on_role,
  ADD CONSTRAINT chk_ri_form_not_on_role
    CHECK (form IS NULL OR role IS NULL),
  DROP CONSTRAINT IF EXISTS chk_ri_brand_nonblank,
  ADD CONSTRAINT chk_ri_brand_nonblank
    CHECK (brand IS NULL OR (btrim(brand) <> '' AND char_length(brand) <= 120)),
  DROP CONSTRAINT IF EXISTS chk_ri_shu_rating_range,
  ADD CONSTRAINT chk_ri_shu_rating_range
    CHECK ((shu_rating_low IS NULL OR shu_rating_low >= 0)
           AND (shu_rating_high IS NULL OR (shu_rating_low IS NOT NULL AND shu_rating_high >= shu_rating_low))),
  DROP CONSTRAINT IF EXISTS chk_ri_shu_rating_not_on_role,
  ADD CONSTRAINT chk_ri_shu_rating_not_on_role
    CHECK ((shu_rating_low IS NULL AND shu_rating_high IS NULL) OR role IS NULL),
  -- 'peppers' is admitted because a 1b-era batch line can carry it and "Save as recipe" copies it.
  DROP CONSTRAINT IF EXISTS chk_ri_salt_base,
  ADD CONSTRAINT chk_ri_salt_base
    CHECK (salt_base IS NULL OR salt_base IN ('peppers','water','all','produce')),
  DROP CONSTRAINT IF EXISTS chk_ri_salt_facts_on_salt_line,
  ADD CONSTRAINT chk_ri_salt_facts_on_salt_line
    CHECK ((salt_pct IS NULL AND salt_base IS NULL AND base_g IS NULL) OR role IS NOT DISTINCT FROM 'salt'),
  DROP CONSTRAINT IF EXISTS chk_ri_salt_facts_pairing,
  ADD CONSTRAINT chk_ri_salt_facts_pairing
    CHECK ((salt_pct IS NULL) = (salt_base IS NULL) AND (salt_pct IS NULL) = (base_g IS NULL)),
  DROP CONSTRAINT IF EXISTS chk_ri_salt_facts_grams,
  ADD CONSTRAINT chk_ri_salt_facts_grams
    CHECK (salt_pct IS NULL OR qty_unit IS NOT DISTINCT FROM 'g'),
  DROP CONSTRAINT IF EXISTS chk_ri_salt_pct_range,
  ADD CONSTRAINT chk_ri_salt_pct_range
    CHECK (salt_pct IS NULL OR (salt_pct > 0 AND salt_pct <= 100)),
  DROP CONSTRAINT IF EXISTS chk_ri_base_g_positive,
  ADD CONSTRAINT chk_ri_base_g_positive
    CHECK (base_g IS NULL OR base_g > 0),
  DROP CONSTRAINT IF EXISTS chk_ri_salt_method,
  ADD CONSTRAINT chk_ri_salt_method
    CHECK (salt_method IS NULL OR salt_method IN ('dry','brine','rinsed')),
  DROP CONSTRAINT IF EXISTS chk_ri_salt_method_on_salt_line,
  ADD CONSTRAINT chk_ri_salt_method_on_salt_line
    CHECK (salt_method IS NULL OR role IS NOT DISTINCT FROM 'salt'),
  DROP CONSTRAINT IF EXISTS chk_ri_base_from,
  ADD CONSTRAINT chk_ri_base_from
    CHECK (base_from IS NULL OR base_from IN ('lines','scale')),
  DROP CONSTRAINT IF EXISTS chk_ri_base_from_needs_base,
  ADD CONSTRAINT chk_ri_base_from_needs_base
    CHECK (base_from IS NULL OR base_g IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_recipe_ingredient_recipe
  ON public.recipe_ingredient (recipe_id, ordinal) WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION public.prevent_recipe_ingredient_identity_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.recipe_id IS DISTINCT FROM NEW.recipe_id THEN
    RAISE EXCEPTION 'recipe_ingredient.recipe_id cannot change';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.prevent_recipe_ingredient_identity_change() IS 'V5-RECIPES-001. A recipe line takes its owner from its recipe (it has no owner column of its own), so it never moves to another recipe. Names only recipe_ingredient columns.';

DROP TRIGGER IF EXISTS trg_recipe_ingredient_identity ON public.recipe_ingredient;
CREATE TRIGGER trg_recipe_ingredient_identity
  BEFORE UPDATE ON public.recipe_ingredient
  FOR EACH ROW EXECUTE FUNCTION public.prevent_recipe_ingredient_identity_change();

-- ── 4. kitchen_batch.recipe_id ───────────────────────────────────────────────────────────────────
-- Nullable, no default, no CHECK. NO ACTION: a recipe is soft-deleted, never hard-deleted by the app,
-- and a batch made from it keeps pointing at it.
ALTER TABLE public.kitchen_batch
  ADD COLUMN IF NOT EXISTS recipe_id uuid,
  DROP CONSTRAINT IF EXISTS kitchen_batch_recipe_id_fkey,
  ADD CONSTRAINT kitchen_batch_recipe_id_fkey
    FOREIGN KEY (recipe_id) REFERENCES public.recipe (id) ON DELETE NO ACTION;

CREATE INDEX IF NOT EXISTS idx_kitchen_batch_recipe_id
  ON public.kitchen_batch (recipe_id) WHERE recipe_id IS NOT NULL;

-- ── 5. v_kitchen_batch_current ───────────────────────────────────────────────────────────────────
-- F's body verbatim with recipe_id appended as column 41 (05 §6 "4:"), an explicit column list.
-- CREATE OR REPLACE (the ACL survives; no GRANT).
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
    b.recipe_ref,
    b.recipe_id
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

-- ── 6. The stamp, in the same transaction as everything above. ──────────────────────────────────
INSERT INTO public.schema_version (version, description)
VALUES ('5.0.0-recipes-001',
        'V5-RECIPES-001 (Put-Up release 4, recipes): new recipe_type (15 built-ins + household-created, '
        'find-or-create by lower(btrim(label)), soft delete); new recipe (name, kind, recipe_type_id, link_url http/https, notes, '
        'the keeps line, vessel, no_salt, mash_in_g, made_g, idempotency_key; set_updated_at and the user_id '
        'ownership trigger) and recipe_ingredient (lines with amount as written, at_the_end, qty/unit, form, '
        'brand, role, note, listed heat, salt facts; FK NO ACTION; identity trigger); kitchen_batch gains '
        'recipe_id (FK NO ACTION); v_kitchen_batch_current appends recipe_id at 41. No pH column.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
