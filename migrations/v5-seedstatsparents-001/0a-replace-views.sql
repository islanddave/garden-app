-- 0a-replace-views.sql
-- V5-SEEDSTATSPARENTS-001 — two season-stats views learn that a saved-seed lot can have several parents.
--   v5-seedmultiparent-001 gave a lot a set of parent plantings (seed_lot_parent_planting) and kept
--   inventory_items.source_plant_id as a member cache. Both stats views still read only the cache:
--     * stat_saved_lot cannot say a lot was pooled from three plantings;
--     * stat_source_card.saved_lots credits only the ONE cached parent, so a seller whose plant was the
--       second parent of a jar gets no credit for it.
--   This migration replaces the two views. No table, no column on a table, no index, no row.
--   Canon: gardening-docs project-state/_seedmultiparent-20261005/r2/R2A-CONTRACT.md sections 1 and 5
--   (binding) and seat-data-schema-architect.md answer 8; findings R2-05 (regression seat) and I7 (QA).
--
-- WHAT CHANGES, EXACTLY:
--
--   * stat_saved_lot — its 22 columns verbatim, same order, then ONE new column LAST:
--       parent_count integer = GREATEST(number of LIVE seed_parent link rows for the lot,
--                                       (source_plant_id IS NOT NULL)::int)
--     FROM, joins and WHERE are unchanged. A scalar subquery cannot add rows, so the view stays ONE ROW
--     PER LOT. parent_planting_id, parent_name and parent_lb go on describing the CACHE parent — one
--     true parent of a pooled lot, never a wrong one. parent_count is how a reader knows there are
--     others.
--     The GREATEST is the drift arm: a lot whose cache is set and whose link row is missing (a write
--     by a Lambda that predates the table, or a revert) reads 1, not 0. With the member-cache rule
--     holding, parent_count equals the number of live seed_parent rows, and is 0 exactly for a lot
--     with no parent (a lot that is in this view because it has a seed_stage).
--     WHERE THE TWO STATES MEET (QA seat I7b), named so nobody has to guess: a live link row whose
--     PLANTING is soft-deleted or archived still counts. The count is "plantings recorded as this
--     lot's seed parents", and deleting a planting does not unsay that seed was taken from it; the
--     same lot's parent_name already keeps naming a soft-deleted cache parent. role = 'pollen_parent'
--     rows and soft-deleted link rows (a parent removed from the lot) never count. It counts
--     PLANTINGS, not plants: the number of plants is inventory_items.seed_parent_plant_count
--     (v5-seedplantcount-001), which this view does not project.
--
--   * stat_source_card — the same 12 output columns; only its lot_parent CTE changes:
--       plantings that are a LIVE seed_parent of a LIVE lot
--       UNION
--       source_plant_id of a LIVE lot
--     UNION, NEVER UNION ALL. count(*) and sum(sp.quantity) ride the LEFT JOIN to lot_parent, so the
--     CTE must stay one row per planting: a planting that is a parent of two lots, or both a link
--     parent and the cache parent of one, would otherwise double that card's plantings, plants and lb.
--     Both arms on purpose (regression seat R2-05): re-basing on link rows alone would drop today's
--     credit wherever a lot has a cache and no live link row. It is the rule the reverse read
--     ("lots this planting fed") already uses.
--
--   WITH NO POOLED LOT IN THE DATA BOTH VIEWS RETURN WHAT THEY RETURN TODAY — the old lot_parent is
--   exactly the second arm, and every link row's planting is then already in it. That is checkable:
--   0v-verify-receipts.sql compares each new view with the old definition evaluated in the same
--   statement (EXCEPT ALL, both directions).
--
-- WHAT `CREATE OR REPLACE VIEW` REQUIRES, and how this file meets it: every existing column keeps its
--   name, position and type; a new column goes last; owner and grants are kept; view options are
--   replaced by whatever the statement gives (neither view has any — gates.yml
--   post_both_views_have_no_reloptions). The definitions below are the house text of
--   migrations/v5-seasonstats-001/0a-additive-ddl.sql:283-305 and :543-576 with only the changes
--   above. The LIVE definitions were read on STAGING 2026-10-06 (PostgreSQL 17.11):
--     stat_saved_lot    md5(pg_get_viewdef(oid, true)) = 84bb54726a6f72a67374bb163167664e   22 columns
--     stat_source_card  md5(pg_get_viewdef(oid, true)) = fff2cb4c63b310668ca186902948e48b   12 columns
--   PROD WAS NOT READ by the lane that wrote this. So section 0 refuses, changing nothing, unless both
--   live definitions are those; gates.yml's two pre_*_is_the_captured_definition gates say the same
--   before the apply.
--
-- NO STANDING GATE REDS ON THE NEW COLUMN. migrations/v5-seasonstats-001/gates.yml
--   post_stat_saved_lot_columns counts 22 NAMED columns, not the view's width, so a 23rd leaves it at
--   22. That file is NOT edited: adding a 23rd name there would red on whichever database has not had
--   this file applied. parent_count is asserted in THIS directory's gates.yml, on this stamp.
--
-- WHY THE DEPLOYED READER IS UNAFFECTED. lambda/harvests selects named columns from both views; none
--   is renamed, moved or retyped, and a column it does not name is invisible to it. saved_lots can
--   only stay the same or rise, and rises only for a pooled lot's second and later parents.
--
-- NEEDS v5-seedmultiparent-001 FIRST (the views read its table). And from here on that migration's
--   rollback needs THIS one rolled back first: its DROP TABLE has no CASCADE and now refuses up front,
--   naming the order (migrations/v5-seedmultiparent-001/0r-rollback.sql).
--
-- SAFETY / IDEMPOTENCY: CREATE OR REPLACE VIEW twice is the same view; the stamp is ON CONFLICT DO
--   NOTHING. Re-running the whole file is a clean no-op and does not move applied_at (the definition
--   guard in section 0 is skipped once the stamp exists).
--   lock_timeout: each replace takes a brief ACCESS EXCLUSIVE lock on the view. Behind a long-running
--   season-stats read that request would queue, and every other read of the view behind IT; 5s turns
--   that into a fast failure that changed nothing. Run it again.
--   ⚠ Exactly ONE COMMIT, at the end. Do not wrap this file in BEGIN/ROLLBACK to "rehearse" it on a
--   shared database. Rehearse on local PostgreSQL 17 (README.md).
--
-- APPLY ORDER (README.md has the commands). Staging: pre -> 0a -> post -> receipts -> rehearse 0r ->
--   0a -> post. Prod: Dave's approval, outside 07:00-08:00 UTC, after a pre-apply copy. On both
--   databases before the push that carries this directory and the reader that selects parent_count.
--
-- ROLLBACK: 0r-rollback.sql. Code back before schema back, and newest first.
--
-- Usage: psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f 0a-replace-views.sql

BEGIN;

SET LOCAL lock_timeout = '5s';
-- pg_get_viewdef prints a relation unqualified only when its schema is on the search_path, and the md5
-- values below were taken with public on it. A pooled connection can arrive with another client's
-- search_path (scripts/gate_runner.py, OPS-GATEINVARIANTSFLAKE-001); pin it for this transaction.
SET LOCAL search_path = public;

-- ── 0. The guards. Refuse unless the table is there and the views are the ones this file captured. ─
DO $$
DECLARE
  v_lot  text;
  v_card text;
BEGIN
  IF to_regclass('public.seed_lot_parent_planting') IS NULL THEN
    RAISE EXCEPTION 'v5-seedstatsparents-001 0a refused, nothing changed: public.seed_lot_parent_planting does not exist.'
      USING HINT = 'Apply migrations/v5-seedmultiparent-001 first; both views read its table.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-seedstatsparents-001') THEN
    SELECT md5(pg_get_viewdef('public.stat_saved_lot'::regclass, true)),
           md5(pg_get_viewdef('public.stat_source_card'::regclass, true))
      INTO v_lot, v_card;
    IF v_lot IS DISTINCT FROM '84bb54726a6f72a67374bb163167664e'
       OR v_card IS DISTINCT FROM 'fff2cb4c63b310668ca186902948e48b' THEN
      RAISE EXCEPTION 'v5-seedstatsparents-001 0a refused, nothing changed: a view is not the definition this file was written against (stat_saved_lot md5 % , expected 84bb54726a6f72a67374bb163167664e; stat_source_card md5 % , expected fff2cb4c63b310668ca186902948e48b).', v_lot, v_card
        USING HINT = 'Diff pg_get_viewdef(..., true) against migrations/v5-seasonstats-001/0a-additive-ddl.sql. A server upgrade that only re-formats the text is the benign cause; a change made to the view since is the real one, and replacing it from this file would silently undo it.';
    END IF;
  END IF;
END $$;

-- ── 1. stat_saved_lot: the 22 columns verbatim, then parent_count LAST. ──────────────────────────
-- Saved-seed lots with their lineage: the parent planting (and its season's pounds) and one source
-- row — the lot's own source (or acquired-from), else the parent planting's source. via = where the
-- parent planting was acquired from. The chain stops there on purpose (limit chain_stops_at_nursery).
-- parent_* describe the lot's CACHE parent; parent_count says how many parent plantings there are.
CREATE OR REPLACE VIEW public.stat_saved_lot AS
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
       pa.name AS via_name,
       GREATEST((SELECT count(*) FROM public.seed_lot_parent_planting l
                  WHERE l.inventory_item_id = i.id
                    AND l.role = 'seed_parent'
                    AND l.deleted_at IS NULL),
                (i.source_plant_id IS NOT NULL)::int)::int AS parent_count
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

-- ── 2. stat_source_card: same 12 columns; lot_parent gains the link arm. ─────────────────────────
-- Report card per effective source (seller, nursery, person), plus one row with source_id NULL for
-- plantings that name no source. lb counts picks in the planting's own grow-year. saved_lots counts
-- plantings that are a parent of at least one live saved-seed lot — a recorded seed parent of it, or
-- its cached parent.
CREATE OR REPLACE VIEW public.stat_source_card AS
WITH lot_parent AS (
  SELECT l.plant_id AS planting_id
    FROM public.seed_lot_parent_planting l
    JOIN public.inventory_items i ON i.id = l.inventory_item_id
   WHERE l.role = 'seed_parent' AND l.deleted_at IS NULL AND i.deleted_at IS NULL
  UNION
  SELECT source_plant_id
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

-- ── 3. The stamp. Same transaction as the DDL: "applied" and "armed" are one event. ───────────────
INSERT INTO public.schema_version (version, description)
VALUES ('5.0.0-seedstatsparents-001',
        'SEEDSTATSPARENTS: V5-SEEDSTATSPARENTS-001. Two stat views read seed_lot_parent_planting. '
        'stat_saved_lot: its 22 columns verbatim, then parent_count integer LAST = GREATEST(live '
        'seed_parent link rows for the lot, (source_plant_id IS NOT NULL)::int); still one row per '
        'lot; parent_* keep describing the cache parent. stat_source_card: same 12 columns; lot_parent '
        '= plantings that are a live seed_parent of a live lot UNION source_plant_id of a live lot '
        '(never UNION ALL), so a pooled lot credits every parent''s source. With no pooled lot both '
        'views return what they returned before. No table, no column on a table, no row. '
        'v5-seasonstats-001/gates.yml is not edited: its 22-name gate counts named columns.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
