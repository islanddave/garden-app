-- 0a-additive-ddl.sql
-- V5-VARIETYBLEND-001 — a named mix: one variety row that stands for seed saved from several varieties.
--   Seed pooled from a Carmen and a Jimmy Nardello is one jar, and the jar is filed under one variety.
--   Today that variety has to be one of the parents, which is false. This migration lets a variety row
--   BE the combination: it carries a key naming the varieties it is made of, and a child table lists
--   them with foreign keys.
--   Canon: gardening-docs project-state/_seedmultiparent-20261005/r2/R2A-CONTRACT.md section 1 (binding;
--   every name below is load-bearing there) and seat-data-schema-architect.md beside it.
--
-- SCOPE: one nullable column on plant_varieties with one CHECK and one partial unique index; the
--   cultivar view widened 47 -> 48; one new table with two foreign keys, one CHECK and three indexes;
--   one schema_version row. No row is written. Nothing on inventory_items or plants changes.
--
-- DESIGN DECISIONS THIS DDL ENCODES:
--
--   * B1 — THE KEY. plant_varieties.blend_key is the mix's LEAF variety ids, lowercase text, in uuid
--     order, joined by ','. A leaf is a variety whose own blend_key IS NULL. A mix made from a mix is
--     flattened before it is keyed, so {mix of A and B, C} and {A, B, C} are the same row and a keyed
--     variety's leaves are blend_key split on ',' with no table read. One SQL fragment computes a key:
--       (SELECT string_agg(u::text, ',' ORDER BY u) FROM unnest($1::uuid[]) u)
--     uuid order and the text order of lowercase uuids are the same order. A rename never changes it.
--     NULL on every ordinary variety, and on every row that exists today. No DEFAULT.
--
--   * B2 — THE FORMAT CHECK is anchored on the WHOLE value: NULL, or 2 to 12 lowercase uuids joined by
--     ','. It does not test order or repeats; "the key equals the sorted live component ids" is a row
--     gate (gates.yml), because a CHECK cannot read the component table.
--     "A keyed row has variety_rank = 'blend'" is ALSO a row gate and deliberately not a CHECK:
--     nothing that couples two columns ships with the column, so no writer deployed today or reverted
--     to tomorrow can be refused by it (memory `arming-a-check-is-a-deploy`).
--
--   * B3 — UNIQUE PER CREATOR, LIVE ROWS ONLY. uq_plant_varieties_creator_blend_key_live is UNIQUE on
--     (created_by, blend_key) WHERE blend_key IS NOT NULL AND deleted_at IS NULL. It stops one person
--     creating a combination twice (two taps, two devices). It is NOT household uniqueness: the
--     household is an environment variable of the Lambda, not a column, so no index can express it.
--     The handler finds a mix across the household before it creates one; this index is the backstop
--     under that. A key unique across ALL users would hand one household's row to another.
--     A unique INDEX, not a constraint: a constraint cannot be partial. It has no pg_constraint row,
--     so its gate reads pg_index. Soft-deleting a mix frees its key.
--     created_by is NOT NULL on plant_varieties (read on staging 2026-10-06; gates.yml
--     pre_created_by_is_not_null checks it where this is applied): a NULL creator would make two rows
--     with one key distinct.
--
--   * B4 — THE VIEW. public.cultivar is an explicit column list and does not inherit a base column,
--     and lambda/varieties reads AND writes only through it. Without the widen blend_key is invisible
--     to the one Lambda that needs it (the V4-DTMBASISVAR-001 near-outage class). The 47 columns are
--     the live definition, read with pg_get_viewdef('public.cultivar', true) on STAGING 2026-10-06
--     (server-side md5 4f70e4aac68cc4945bb70d7cae54f2b5, PostgreSQL 17.11) and byte-equal to
--     migrations/v5-scovillesource-001/0a-additive-ddl.sql:102-149. PROD WAS NOT READ by the lane that
--     wrote this. So section 0 below refuses, changing nothing, unless the live definition is that one;
--     gates.yml pre_cultivar_view_is_the_captured_definition says the same thing before the apply.
--     blend_key is appended LAST as a plain pass-through, so no existing column moves, the view stays
--     auto-updatable and insertable, and blend_key is itself writable through it.
--     The base table is written public.plant_varieties here; the stored definition is the same.
--
--   * B5 — THE COMPONENT TABLE mirrors the key: one live row per leaf. It exists for foreign-key
--     integrity (a leaf cannot be hard-deleted out from under a mix) and for a readable ancestry; the
--     key alone answers "what is this made of".
--       - both foreign keys name the plant_varieties TABLE, never the view, and are ON DELETE RESTRICT.
--         The table carries deleted_at, and tests/integration/cascade-sweep.int.test.js forbids a
--         CASCADE into any table that does. RESTRICT blocks nothing the app does: a variety DELETE is
--         `UPDATE ... SET deleted_at`. It blocks an operator hard-delete and the integration teardown,
--         loudly (tests/integration/_cleanup.js needs a child-first step for this table).
--       - a soft-deleted variety can be a component, and stays listed.
--       - chk_vbc_not_self: a mix is not its own component.
--       - no updated_at: no route edits a component row. deleted_at is set by no route either; it is
--         kept for a hand-run variety dedup, which must prune a collision before it repoints.
--       - uq_vbc_blend_component_live UNIQUE (blend_variety_id, component_variety_id) WHERE deleted_at
--         IS NULL. idx_vbc_blend and idx_vbc_component are PLAIN, one per foreign key column: a
--         RESTRICT probe carries no deleted_at term, so a partial index cannot serve it.
--       - no trigger. created_by records who made the link; no read scopes on it.
--
-- A HAND-RUN VARIETY DEDUP (there is no merge tool for varieties; migrations/v4-varietydedup-001 is the
--   only precedent) must, in ONE transaction: prune then repoint component rows, recompute blend_key
--   on every mix it touched, and merge two mixes that now share a key. gates.yml
--   post_blend_key_equals_live_components reds if it forgets.
--
-- WHY THE DEPLOYED WRITER IS UNAFFECTED (the house test: would the currently deployed code produce a
--   row that violates this?). No deployed code names blend_key or the new table. The varieties INSERT
--   and PUT are explicit column lists through the view, so every row they write has blend_key NULL,
--   which the CHECK admits and the partial index does not hold. The view only APPENDS a column. The
--   two RESTRICT keys bind only when a component row exists, and nothing deployed writes one.
--
-- SAFETY / IDEMPOTENCY: ADD COLUMN IF NOT EXISTS, CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT
--   EXISTS, each ADD CONSTRAINT guarded by a pg_constraint lookup scoped to its own table, the stamp ON
--   CONFLICT DO NOTHING. Re-running the whole file is a clean no-op and does not move applied_at (the
--   definition guard in section 0 is skipped once the stamp exists). Every constraint is born valid:
--   the column is born NULL and the table is born empty, so there is no NOT VALID / VALIDATE pair.
--   lock_timeout: ADD COLUMN and the CHECK take a brief ACCESS EXCLUSIVE lock on plant_varieties, the
--   index a SHARE lock, the view replace an ACCESS EXCLUSIVE lock on the view, each foreign key a SHARE
--   ROW EXCLUSIVE lock on plant_varieties. Behind a long-open transaction those would queue, and every
--   variety read would queue behind THEM; 5s turns that into a fast failure that changed nothing. Run
--   it again.
--   ⚠ Exactly ONE COMMIT, at the end. Do not wrap this file in BEGIN/ROLLBACK to "rehearse" it on a
--   shared database: its own COMMIT ends your transaction. Rehearse on local PostgreSQL 17 (README.md).
--
-- APPLY ORDER (README.md has the commands). Staging: pre -> sweep -> 0a -> post -> rehearse 0r -> 0a ->
--   post. Prod: Dave's approval, outside 07:00-08:00 UTC, after a pre-apply copy. The DDL is on BOTH
--   databases before the push that carries this directory's gates.yml and the Lambda that names the
--   column: four of the post gates name the new column and table as SQL identifiers.
--
-- ROLLBACK: 0r-rollback.sql. Read its header first — code back before schema back, and newest first.
--
-- Usage: psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f 0a-additive-ddl.sql

BEGIN;

SET LOCAL lock_timeout = '5s';
-- pg_get_viewdef prints a relation unqualified only when its schema is on the search_path, and the md5
-- below was taken with public on it. A pooled connection can arrive with another client's search_path
-- (scripts/gate_runner.py, OPS-GATEINVARIANTSFLAKE-001); pin it for this transaction.
SET LOCAL search_path = public;

-- ── 0. The definition guard. Refuses unless the view being replaced is the one this file captured. ─
DO $$
DECLARE
  v_md5 text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-varietyblend-001') THEN
    SELECT md5(pg_get_viewdef('public.cultivar'::regclass, true)) INTO v_md5;
    IF v_md5 IS DISTINCT FROM '4f70e4aac68cc4945bb70d7cae54f2b5' THEN
      RAISE EXCEPTION 'v5-varietyblend-001 0a refused, nothing changed: public.cultivar is not the 47-column definition this file was written against (md5 % , expected 4f70e4aac68cc4945bb70d7cae54f2b5).', v_md5
        USING HINT = 'Diff pg_get_viewdef(''public.cultivar'', true) against the list in this file. A server upgrade that only re-formats the text is the benign cause; another widen of the view is the real one, and replacing it from this file would silently undo that widen.';
    END IF;
  END IF;
END $$;

-- ── 1. The key column (B1). Nullable, no DEFAULT. ────────────────────────────────────────────────
ALTER TABLE public.plant_varieties
  ADD COLUMN IF NOT EXISTS blend_key text;

COMMENT ON COLUMN public.plant_varieties.blend_key IS
  'V5-VARIETYBLEND-001. NULL on an ordinary variety. On a named mix: its LEAF variety ids (a leaf is a variety whose own blend_key IS NULL), lowercase, in uuid order, joined by a comma — 2 to 12 of them. A mix made from a mix is flattened first. Set once when the mix is created; a rename never changes it. The live rows of variety_blend_component for this variety mirror it. chk_plant_varieties_blend_key_format matches the WHOLE value, not a fragment of it.';

-- ── 2. The format CHECK (B2). Guarded; born valid, the column is all NULL. ────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.plant_varieties'::regclass
                    AND conname = 'chk_plant_varieties_blend_key_format') THEN
    ALTER TABLE public.plant_varieties
      ADD CONSTRAINT chk_plant_varieties_blend_key_format
      CHECK (blend_key IS NULL OR blend_key ~
        '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}(,[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}){1,11}$');
  END IF;
END $$;

-- ── 3. One live mix per (creator, key) (B3). ─────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS uq_plant_varieties_creator_blend_key_live
  ON public.plant_varieties (created_by, blend_key)
  WHERE blend_key IS NOT NULL AND deleted_at IS NULL;

-- ── 4. WIDEN public.cultivar 47 -> 48 (B4). The 47 columns verbatim, same order; blend_key LAST. ──
CREATE OR REPLACE VIEW public.cultivar AS
SELECT id,
    name AS display_name,
    species,
    genus,
    days_to_maturity_min,
    days_to_maturity_max,
    care_notes,
    soil_notes,
    sun_requirements,
    common_diseases,
    expected_yield_notes,
    photo_id,
    source_url,
    created_by,
    created_at,
    updated_at,
    deleted_at,
    source_proj_rescope_project_id,
    origin_country,
    origin_region,
    model_version,
    crop_type_slug,
    lifecycle,
    scoville_min,
    scoville_max,
    growth_habit,
    produces_scape,
    determinacy,
    day_length_response,
    grown_as,
    start_method,
    start_indoor_weeks_min,
    start_indoor_weeks_max,
    direct_sow_timing,
    sow_depth_in,
    seed_spacing_in,
    row_spacing_in,
    days_to_germ_min,
    days_to_germ_max,
    sow_season,
    sow_notes,
    dtm_basis,
    breeding_system,
    breeding_source,
    breeding_confidence,
    variety_rank,
    scoville_source,
    blend_key
   FROM public.plant_varieties;

-- Re-grant explicitly, GUARDED ON THE ROLE EXISTING — as v5-scovillesource-001 and
-- v5-varietyhybridflag-001 do. CREATE OR REPLACE preserves grants, so this is belt-and-braces here; an
-- unguarded GRANT fails on staging, which has no garden_ro role (re-read 2026-10-06).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'garden_ro') THEN
    EXECUTE 'GRANT SELECT ON public.cultivar TO garden_ro';
  END IF;
END $$;

-- ── 5. The component table (B5). ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.variety_blend_component (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  blend_variety_id     uuid        NOT NULL,              -- the mix
  component_variety_id uuid        NOT NULL,              -- one of its leaves
  created_by           text        NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz                         -- no route sets it; for a hand-run dedup
);

COMMENT ON TABLE public.variety_blend_component IS
  'The leaf varieties a named mix is made of, one live row per (mix, leaf). Mirrors plant_varieties.blend_key of the mix, which is the same ids sorted and joined; the rows exist for foreign-key integrity and a readable ancestry. Written once, in the transaction that creates the mix; no route edits or soft-deletes them. A component may be a soft-deleted variety. It is never itself a mix: a mix made from a mix is flattened to leaves first.';

DO $$
BEGIN
  -- The mix. RESTRICT: this table carries deleted_at, so a CASCADE into it is forbidden.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.variety_blend_component'::regclass
                    AND conname = 'variety_blend_component_blend_variety_id_fkey') THEN
    ALTER TABLE public.variety_blend_component
      ADD CONSTRAINT variety_blend_component_blend_variety_id_fkey
      FOREIGN KEY (blend_variety_id) REFERENCES public.plant_varieties(id) ON DELETE RESTRICT;
  END IF;

  -- The leaf. RESTRICT: a mix whose component could be hard-deleted would name a variety that is gone.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.variety_blend_component'::regclass
                    AND conname = 'variety_blend_component_component_variety_id_fkey') THEN
    ALTER TABLE public.variety_blend_component
      ADD CONSTRAINT variety_blend_component_component_variety_id_fkey
      FOREIGN KEY (component_variety_id) REFERENCES public.plant_varieties(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.variety_blend_component'::regclass
                    AND conname = 'chk_vbc_not_self') THEN
    ALTER TABLE public.variety_blend_component
      ADD CONSTRAINT chk_vbc_not_self
      CHECK (blend_variety_id <> component_variety_id);
  END IF;
END $$;

-- One live row per (mix, leaf). Partial, so a row a dedup retired does not block its replacement.
CREATE UNIQUE INDEX IF NOT EXISTS uq_vbc_blend_component_live
  ON public.variety_blend_component (blend_variety_id, component_variety_id)
  WHERE deleted_at IS NULL;

-- One per foreign key column, PLAIN: a RESTRICT probe carries no deleted_at term.
CREATE INDEX IF NOT EXISTS idx_vbc_blend
  ON public.variety_blend_component (blend_variety_id);

CREATE INDEX IF NOT EXISTS idx_vbc_component
  ON public.variety_blend_component (component_variety_id);

-- ── 6. The stamp. Same transaction as the DDL: "applied" and "armed" are one event. ───────────────
INSERT INTO public.schema_version (version, description)
VALUES ('5.0.0-varietyblend-001',
        'VARIETYBLEND: V5-VARIETYBLEND-001. A named mix is a variety row. plant_varieties.blend_key '
        '(nullable text, no DEFAULT) = the mix''s leaf variety ids, lowercase, in uuid order, joined by '
        'a comma; chk_plant_varieties_blend_key_format (NULL or 2-12 lowercase uuids, whole value); '
        'uq_plant_varieties_creator_blend_key_live UNIQUE (created_by, blend_key) WHERE blend_key IS NOT '
        'NULL AND deleted_at IS NULL. public.cultivar widened 47 -> 48, blend_key appended last as a '
        'pass-through so the view stays auto-updatable. New table variety_blend_component (id, '
        'blend_variety_id, component_variety_id, created_by, created_at, deleted_at), one live row per '
        'leaf: both foreign keys to plant_varieties ON DELETE RESTRICT, chk_vbc_not_self, '
        'uq_vbc_blend_component_live UNIQUE (blend_variety_id, component_variety_id) WHERE deleted_at IS '
        'NULL, plain idx_vbc_blend and idx_vbc_component. No trigger, no backfill, no row written. '
        '"A keyed row has rank blend" and "the key equals the live components" are row gates, not CHECKs.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
