-- 0r-rollback.sql — V5-VARIETYBLEND-001 rollback. Narrows public.cultivar back to its 47 columns, drops
--   variety_blend_component, drops plant_varieties.blend_key with its CHECK and its unique index, and
--   removes stamp 5.0.0-varietyblend-001. Touches nothing else.
--
-- ⚠ BEFORE RUNNING, IN THE REPO — the four row-level gates must be OUT of gates.yml FIRST.
--   post_keyed_row_has_rank_blend, post_blend_key_equals_live_components,
--   post_no_live_component_under_an_unkeyed_row and post_every_live_component_is_a_leaf name
--   plant_varieties.blend_key and public.variety_blend_component in their SQL. Postgres resolves a
--   column and a relation name at PARSE time, so with them gone those gates do not go vacuous under
--   their stamp guard, they ERROR (42703 / 42P01), and an erroring gate reds gate-invariants.yml on
--   that environment for every migration in the tree. Move the four to
--   `gates-rowlevel.yml.pending` (a name the runner does not load), push, and let that push reach the
--   branch whose corpus runs against this database (dev for the push-triggered run, main for the
--   Tuesday cron) BEFORE this file is applied. Every other gate in gates.yml is catalog-only and
--   self-armed on the stamp this file deletes; those may stay and return to vacuous.
--
-- ⚠ CODE BACK BEFORE SCHEMA BACK. This is a clean undo ONLY WHILE NO DEPLOYED CODE NAMES blend_key OR
--   THE TABLE. The varieties Lambda of release 2a projects blend_key through the view on every list
--   and detail read, the plants picker projects it, and the inventory-items Lambda reads it to judge a
--   pooled lot's filing: with the column gone each of those is a 42703 on every request. Once that
--   release is live (or on dev, where the promote's prod schema gate reads it) the holding state is
--   "leave the schema": the column and the table are inert to code that does not name them.
--
-- ⚠ NEWEST FIRST. A later migration that widens public.cultivar again must be rolled back before this
--   one, and migrations/v5-scovillesource-001/0r-rollback.sql (which re-creates the view at 46 columns)
--   only after this one. Section 0 enforces the first half: it refuses unless the view is exactly the
--   48 columns 0a left, blend_key last.
--
-- THE REFUSAL GUARD (first statement after BEGIN). Nothing can rebuild a named mix: its key and its
--   component rows exist only in the two objects this file drops, and every seed lot filed under the
--   mix would be left pointing at a variety row that no longer says what it is made of. So this file
--   refuses, changing nothing, while ANY plant_varieties row carries a blend_key (live or soft-deleted)
--   or ANY variety_blend_component row exists (live or soft-deleted), and says how many. Getting past
--   that is Dave's decision, with the rows exported first — not a cleanup step, and not something to
--   reach by editing the guard.
--   A re-run after a successful rollback finds no column, no table and no stamp and is a no-op.
--
-- THE VIEW NARROW CANNOT USE `CREATE OR REPLACE`: Postgres lets it APPEND columns only. So this is a
--   genuine DROP VIEW + CREATE VIEW, the one path that does NOT preserve grants. Read on staging
--   2026-10-06: nothing depends on public.cultivar, it has no trigger, no rule beyond _RETURN, no
--   reloptions, and no grant at all there. Prod's grants were not read by the lane that wrote this, so
--   section 1 does not assume them: it reads the view's own ACL before the DROP and re-issues every
--   grant after the CREATE, then the guarded garden_ro grant the sibling files carry. No CASCADE: a
--   dependent view nobody declared stops the rollback instead of disappearing with it.
--   The 47 columns are the definition 0a replaced (md5 4f70e4aac68cc4945bb70d7cae54f2b5); rehearsed:
--   after this file the view's md5 is that value again, which is what lets 0a re-apply.
--
-- Also used by the staging rehearsal (README.md): 0a -> post -> THIS -> 0a -> post. That is what makes
--   the rollback tested rather than asserted. At that point no mix exists, so the guard passes.
--
-- Usage: psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public;

-- ── 0. The refusal guards. ───────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_keyed bigint := 0;
  v_rows  bigint := 0;
  v_cols  integer;
  v_last  text;
BEGIN
  -- EXECUTE, so a database where the column or the table is already gone never parses a query that
  -- names it.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'plant_varieties'
                AND column_name = 'blend_key') THEN
    EXECUTE 'SELECT count(*) FROM public.plant_varieties WHERE blend_key IS NOT NULL' INTO v_keyed;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relname = 'variety_blend_component' AND c.relkind = 'r') THEN
    EXECUTE 'SELECT count(*) FROM public.variety_blend_component' INTO v_rows;
  END IF;

  IF v_keyed > 0 OR v_rows > 0 THEN
    RAISE EXCEPTION 'v5-varietyblend-001 0r refused, nothing dropped: % variety row(s) carry a blend_key and % component row(s) exist. Dropping them destroys the only record of what each named mix is made of.',
      v_keyed, v_rows
      USING HINT = 'A named mix cannot be rebuilt from anything else. Export the rows and take the decision to Dave; do not edit this guard.';
  END IF;

  -- Newest first. If the view carries blend_key it must be exactly what 0a left: 48 columns, blend_key
  -- last. Anything wider is a later migration's column, which the DROP + CREATE below would remove.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'cultivar' AND column_name = 'blend_key') THEN
    SELECT count(*), max(column_name) FILTER (WHERE ordinal_position = (
             SELECT max(ordinal_position) FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'cultivar'))
      INTO v_cols, v_last
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'cultivar';
    IF v_cols <> 48 OR v_last <> 'blend_key' THEN
      RAISE EXCEPTION 'v5-varietyblend-001 0r refused, nothing dropped: public.cultivar has % columns ending in %, not the 48 ending in blend_key that 0a left.', v_cols, v_last
        USING HINT = 'A later migration widened the view. Roll that one back first (newest first), then re-run this rollback.';
    END IF;
  END IF;
END $$;

-- ── 1. Narrow the view back to the 47 columns 0a replaced. Skipped when it is already narrow. ────
DO $$
DECLARE
  v_grants text[];
  v_grant  text;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'cultivar' AND column_name = 'blend_key') THEN

    -- Every grant on the view to anyone but its owner, as the statement that re-issues it.
    SELECT array_agg(format('GRANT %s ON public.cultivar TO %s%s',
                            a.privilege_type,
                            CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                                 ELSE quote_ident(pg_get_userbyid(a.grantee)) END,
                            CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END))
      INTO v_grants
      FROM pg_class c
     CROSS JOIN LATERAL aclexplode(c.relacl) a
     WHERE c.oid = 'public.cultivar'::regclass
       AND a.grantee <> c.relowner;

    DROP VIEW public.cultivar;

    CREATE VIEW public.cultivar AS
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
        scoville_source
       FROM public.plant_varieties;

    -- Put back what DROP VIEW just revoked.
    IF v_grants IS NOT NULL THEN
      FOREACH v_grant IN ARRAY v_grants LOOP
        EXECUTE v_grant;
      END LOOP;
    END IF;

    -- And the sibling files' guarded grant, in case the ACL read above found the role missing its
    -- SELECT already. Staging has no garden_ro; an unguarded GRANT there fails the whole rollback.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'garden_ro') THEN
      EXECUTE 'GRANT SELECT ON public.cultivar TO garden_ro';
    END IF;
  END IF;
END $$;

-- ── 2. The component table. Its indexes and constraints go with it. No CASCADE. ───────────────────
DROP TABLE IF EXISTS public.variety_blend_component;

-- ── 3. The key: index, CHECK, column. The guard above proved the column holds no value. ───────────
DROP INDEX IF EXISTS public.uq_plant_varieties_creator_blend_key_live;

ALTER TABLE public.plant_varieties
  DROP CONSTRAINT IF EXISTS chk_plant_varieties_blend_key_format;

ALTER TABLE public.plant_varieties
  DROP COLUMN IF EXISTS blend_key;

-- ── 4. The stamp. ────────────────────────────────────────────────────────────────────────────────
DELETE FROM public.schema_version WHERE version = '5.0.0-varietyblend-001';

COMMIT;
