-- 0v-verify-receipts.sql
-- V5-SEEDSTATSPARENTS-001 — the apply receipts (regression seat R2-05). READ-ONLY: one transaction
--   opened READ ONLY and rolled back, SELECTs only. Run it AFTER 0a-replace-views.sql, on staging and
--   on prod, and keep the output with the apply record.
--
-- WHAT IT ANSWERS: did replacing the two views change any number the season page shows today?
--   Each new view is compared with the OLD definition (migrations/v5-seasonstats-001/0a-additive-ddl.sql
--   :283-305 and :543-576, re-stated below as plain queries) with EXCEPT ALL in both directions.
--   Both sides are evaluated by ONE statement, so they see one snapshot: a seed lot saved while this
--   runs cannot show up as a difference, which a "before" table and an "after" table read minutes
--   apart could not promise on prod.
--
-- HOW TO READ IT. One line per receipt: what was measured, the number, and what it must be.
--   * Lines 1-2 (stat_saved_lot, its 22 original columns): 0 and 0, always. Nothing about those
--     columns changed.
--   * Lines 3-4 (stat_source_card, all 12 columns): 0 and 0 WHEN line 5 IS 0. Line 5 counts plantings
--     that are a recorded seed parent of a live lot and the cached parent of none — the second and
--     later parents of pooled lots. Each one moves exactly one source card's saved_lots up by one,
--     which is the purpose of the change; then lines 3 and 4 are equal to each other and at most
--     line 5 (two such plantings on one card move one row).
--   * Line 6: lots whose cache is set and whose parent_count is below 1. Must be 0.
--   * Line 7: lots whose parent_count is not GREATEST(live seed_parent rows, cache set). Must be 0.
--   * Lines 8-9: rows and distinct lots of stat_saved_lot. Must be equal (one row per lot).
--   * Line 10: lots with parent_count above 1 — the pooled lots. Information; 0 until the first one.
--   * Lines 11-12: sum of plantings across stat_source_card, and rows of stat_planting. Must be equal:
--     no join in the card repeats a planting (the UNION in lot_parent is what keeps that true).
--
-- Usage: psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f 0v-verify-receipts.sql

BEGIN TRANSACTION READ ONLY;

WITH old_lot AS (
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
     AND (i.source_plant_id IS NOT NULL OR i.seed_stage IS NOT NULL)
), new_lot AS (
  SELECT lot_id, owner, grow_year, cultivar, crop_slug, seed_count, count_estimated, stage, saved_on,
         saved_at, parent_planting_id, parent_name, parent_lb, source_id, source_name, source_kind,
         source_locality, source_address, source_website_url, source_instagram_url,
         source_facebook_url, via_name
    FROM public.stat_saved_lot
), old_card AS (
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
   GROUP BY sp.owner, sp.grow_year, sp.eff_source_id, s.name, s.kind
), new_card AS (
  SELECT owner, grow_year, source_id, name, kind, plantings, plants, picked, lost, lb, saved_lots, crops
    FROM public.stat_source_card
), link_only AS (
  -- plantings that are a live seed_parent of a live lot and the cached parent of no live lot
  SELECT DISTINCT l.plant_id
    FROM public.seed_lot_parent_planting l
    JOIN public.inventory_items i ON i.id = l.inventory_item_id
   WHERE l.role = 'seed_parent' AND l.deleted_at IS NULL AND i.deleted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.inventory_items c
                      WHERE c.deleted_at IS NULL AND c.source_plant_id = l.plant_id)
), lot_facts AS (
  SELECT sl.lot_id, sl.parent_count,
         (i.source_plant_id IS NOT NULL) AS has_cache,
         (SELECT count(*) FROM public.seed_lot_parent_planting l
           WHERE l.inventory_item_id = i.id AND l.role = 'seed_parent' AND l.deleted_at IS NULL) AS live_links
    FROM public.stat_saved_lot sl
    JOIN public.inventory_items i ON i.id = sl.lot_id
)
SELECT n, receipt, value, must_be
  FROM (
    SELECT  1 AS n, 'stat_saved_lot, 22 original columns: old EXCEPT ALL new' AS receipt,
           (SELECT count(*) FROM (SELECT * FROM old_lot EXCEPT ALL SELECT * FROM new_lot) d) AS value,
           '0' AS must_be
    UNION ALL
    SELECT  2, 'stat_saved_lot, 22 original columns: new EXCEPT ALL old',
           (SELECT count(*) FROM (SELECT * FROM new_lot EXCEPT ALL SELECT * FROM old_lot) d), '0'
    UNION ALL
    SELECT  3, 'stat_source_card, 12 columns: old EXCEPT ALL new',
           (SELECT count(*) FROM (SELECT * FROM old_card EXCEPT ALL SELECT * FROM new_card) d),
           '0 when line 5 is 0; otherwise equal to line 4 and at most line 5'
    UNION ALL
    SELECT  4, 'stat_source_card, 12 columns: new EXCEPT ALL old',
           (SELECT count(*) FROM (SELECT * FROM new_card EXCEPT ALL SELECT * FROM old_card) d),
           '0 when line 5 is 0; otherwise equal to line 3 and at most line 5'
    UNION ALL
    SELECT  5, 'plantings that are a seed parent of a live lot and the cached parent of none',
           (SELECT count(*) FROM link_only), 'information (0 while no lot is pooled)'
    UNION ALL
    SELECT  6, 'lots with a cached parent and parent_count below 1',
           (SELECT count(*) FROM lot_facts WHERE has_cache AND parent_count < 1), '0'
    UNION ALL
    SELECT  7, 'lots whose parent_count is not GREATEST(live seed_parent rows, cache set)',
           (SELECT count(*) FROM lot_facts
             WHERE parent_count IS DISTINCT FROM GREATEST(live_links, has_cache::int)), '0'
    UNION ALL
    SELECT  8, 'rows of stat_saved_lot', (SELECT count(*) FROM public.stat_saved_lot), 'equal to line 9'
    UNION ALL
    SELECT  9, 'distinct lots in stat_saved_lot',
           (SELECT count(DISTINCT lot_id) FROM public.stat_saved_lot), 'equal to line 8'
    UNION ALL
    SELECT 10, 'lots with parent_count above 1 (pooled lots)',
           (SELECT count(*) FROM lot_facts WHERE parent_count > 1), 'information'
    UNION ALL
    SELECT 11, 'sum of plantings across stat_source_card',
           (SELECT coalesce(sum(plantings), 0) FROM public.stat_source_card), 'equal to line 12'
    UNION ALL
    SELECT 12, 'rows of stat_planting', (SELECT count(*) FROM public.stat_planting), 'equal to line 11'
  ) r
 ORDER BY n;

ROLLBACK;
