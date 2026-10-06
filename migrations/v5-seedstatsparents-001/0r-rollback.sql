-- 0r-rollback.sql — V5-SEEDSTATSPARENTS-001 rollback. Puts stat_saved_lot and stat_source_card back to
--   the definitions migrations/v5-seasonstats-001/0a-additive-ddl.sql created (22 and 12 columns, the
--   lot_parent CTE reading inventory_items.source_plant_id only) and removes stamp
--   5.0.0-seedstatsparents-001. Touches nothing else. No data is lost: the views hold none.
--
-- IN THE REPO: nothing has to move first. Every gate in this directory's gates.yml is catalog-only and
--   armed on the stamp this file deletes, except post_stat_saved_lot_one_row_per_lot, which names only
--   the view and its lot_id column — both still there after this file. (That one gate WOULD have to
--   move to a .pending file before a rollback of v5-seasonstats-001 itself, which drops the view.)
--
-- ⚠ CODE BACK BEFORE SCHEMA BACK. The harvests Lambda of release 2a selects parent_count from
--   stat_saved_lot: with the column gone GET /api/harvests/season-stats is a 42703. Once that release
--   is live (or on dev, where the promote's prod schema gate reads it) the holding state is "leave the
--   views": the extra column is invisible to code that does not name it.
--
-- ⚠ NEWEST FIRST, both ways.
--     * A later migration that appends another column to stat_saved_lot must be rolled back before
--       this one. Section 0 enforces it: it refuses unless the view is exactly the 23 columns 0a left,
--       parent_count last (or already the 22).
--     * This file is what migrations/v5-seedmultiparent-001/0r-rollback.sql waits for. While these
--       two views read seed_lot_parent_planting that rollback refuses up front; after this file they
--       no longer do.
--
-- stat_saved_lot CANNOT BE NARROWED WITH `CREATE OR REPLACE`: Postgres lets it APPEND columns only.
--   So it is a genuine DROP VIEW + CREATE VIEW, the one path that does NOT preserve grants. Read on
--   staging 2026-10-06: nothing depends on either view, neither has reloptions, and neither carries a
--   grant there. Prod's grants were not read by the lane that wrote this, so section 1 does not assume
--   them: it reads the view's own ACL before the DROP and re-issues every grant after the CREATE. No
--   CASCADE: a dependent view nobody declared stops the rollback instead of disappearing with it.
--   stat_source_card keeps its 12 columns, so it IS a CREATE OR REPLACE and keeps its grants.
--   Rehearsed: after this file both views' md5 are the values 0a's guard expects
--   (84bb54726a6f72a67374bb163167664e, fff2cb4c63b310668ca186902948e48b), which is what lets 0a re-apply.
--
-- A re-run after a successful rollback finds the 22-column view and no stamp, replaces stat_source_card
--   with the definition it already has, and changes nothing.
--
-- Also used by the staging rehearsal (README.md): 0a -> post -> receipts -> THIS -> 0a -> post.
--
-- Usage: psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public;

-- ── 0. The refusal guard: newest first. ──────────────────────────────────────────────────────────
DO $$
DECLARE
  v_cols integer;
  v_last text;
BEGIN
  IF to_regclass('public.stat_saved_lot') IS NULL OR to_regclass('public.stat_source_card') IS NULL THEN
    RAISE EXCEPTION 'v5-seedstatsparents-001 0r refused, nothing changed: stat_saved_lot or stat_source_card does not exist.'
      USING HINT = 'v5-seasonstats-001 has been rolled back already; there is nothing here to restore. Delete the stamp by hand only after confirming that.';
  END IF;

  SELECT count(*), max(column_name) FILTER (WHERE ordinal_position = (
           SELECT max(ordinal_position) FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'stat_saved_lot'))
    INTO v_cols, v_last
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'stat_saved_lot';

  IF NOT ((v_cols = 23 AND v_last = 'parent_count') OR (v_cols = 22 AND v_last = 'via_name')) THEN
    RAISE EXCEPTION 'v5-seedstatsparents-001 0r refused, nothing changed: public.stat_saved_lot has % columns ending in %, not the 23 ending in parent_count that 0a left (nor the 22 ending in via_name it replaced).', v_cols, v_last
      USING HINT = 'A later migration changed the view. Roll that one back first (newest first), then re-run this rollback.';
  END IF;
END $$;

-- ── 1. stat_saved_lot back to 22 columns. Skipped when it is already narrow. ─────────────────────
DO $$
DECLARE
  v_grants text[];
  v_grant  text;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'stat_saved_lot'
                AND column_name = 'parent_count') THEN

    -- Every grant on the view to anyone but its owner, as the statement that re-issues it.
    SELECT array_agg(format('GRANT %s ON public.stat_saved_lot TO %s%s',
                            a.privilege_type,
                            CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                                 ELSE quote_ident(pg_get_userbyid(a.grantee)) END,
                            CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END))
      INTO v_grants
      FROM pg_class c
     CROSS JOIN LATERAL aclexplode(c.relacl) a
     WHERE c.oid = 'public.stat_saved_lot'::regclass
       AND a.grantee <> c.relowner;

    DROP VIEW public.stat_saved_lot;

    -- migrations/v5-seasonstats-001/0a-additive-ddl.sql:543-576, verbatim.
    CREATE VIEW public.stat_saved_lot AS
    SELECT i.id AS lot_id,
           i.created_by AS owner,
           (extract(year FROM x.saved_on)::int + (extract(month FROM x.saved_on) >= 11)::int) AS grow_year,
           coalesce(v.name, i.name) AS cultivar,
           v.crop_type_slug AS crop_slug,
           i.seed_count,
           coalesce(i.seed_count_estimated, false) AS count_estimated,
           coalesce(i.seed_stage, '') AS stage,
           x.saved_on,
           i.created_at AS saved_at,
           pp.id AS parent_planting_id,
           coalesce(pv.name, pp.name) AS parent_name,
           (SELECT sum(ph.lb) FROM public.stat_planting_harvest ph WHERE ph.planting_id = pp.id) AS parent_lb,
           src.id AS source_id,
           src.name AS source_name,
           coalesce(src.kind, nullif(i.source_kind, '')) AS source_kind,
           src.locality AS source_locality,
           src.address AS source_address,
           src.website_url AS source_website_url,
           src.instagram_url AS source_instagram_url,
           src.facebook_url AS source_facebook_url,
           pa.name AS via_name
      FROM public.inventory_items i
      LEFT JOIN public.plant_varieties v ON v.id = i.variety_id
      LEFT JOIN public.plants pp ON pp.id = i.source_plant_id
      LEFT JOIN public.plant_varieties pv ON pv.id = pp.variety_id
      LEFT JOIN public.source s ON s.id = coalesce(i.source_id, i.acquired_from_source_id)
      LEFT JOIN public.source ps ON ps.id = pp.source_id
      LEFT JOIN public.source src ON src.id = coalesce(s.id, ps.id)
      LEFT JOIN public.source pa ON pa.id = pp.acquired_from_source_id
     CROSS JOIN LATERAL (SELECT (i.created_at AT TIME ZONE 'America/New_York')::date AS saved_on) x
     WHERE i.deleted_at IS NULL
       AND (i.source_plant_id IS NOT NULL OR i.seed_stage IS NOT NULL);

    -- Put back what DROP VIEW just revoked.
    IF v_grants IS NOT NULL THEN
      FOREACH v_grant IN ARRAY v_grants LOOP
        EXECUTE v_grant;
      END LOOP;
    END IF;
  END IF;
END $$;

-- ── 2. stat_source_card: lot_parent back to the cache column alone. Same 12 columns. ─────────────
-- migrations/v5-seasonstats-001/0a-additive-ddl.sql:283-305, verbatim.
CREATE OR REPLACE VIEW public.stat_source_card AS
WITH lot_parent AS (
  SELECT DISTINCT source_plant_id AS planting_id
    FROM public.inventory_items
   WHERE deleted_at IS NULL AND source_plant_id IS NOT NULL
)
SELECT sp.owner,
       sp.grow_year,
       sp.eff_source_id AS source_id,
       s.name,
       s.kind,
       count(*)::int AS plantings,
       sum(sp.quantity) AS plants,
       count(ph.planting_id)::int AS picked,
       (count(*) FILTER (WHERE sp.status = 'failed'))::int AS lost,
       coalesce(sum(ph.lb), 0) AS lb,
       count(lp.planting_id)::int AS saved_lots,
       count(DISTINCT sp.crop_slug)::int AS crops
  FROM public.stat_planting sp
  LEFT JOIN public.stat_planting_harvest ph ON ph.planting_id = sp.planting_id AND ph.grow_year = sp.grow_year
  LEFT JOIN public.source s ON s.id = sp.eff_source_id
  LEFT JOIN lot_parent lp ON lp.planting_id = sp.planting_id
 GROUP BY sp.owner, sp.grow_year, sp.eff_source_id, s.name, s.kind;

-- ── 3. The stamp. ────────────────────────────────────────────────────────────────────────────────
DELETE FROM public.schema_version WHERE version = '5.0.0-seedstatsparents-001';

COMMIT;
