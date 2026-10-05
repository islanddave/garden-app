-- 0b-reconcile.sql
-- V5-SEEDMULTIPARENT-001 — make seed_lot_parent_planting agree with inventory_items.source_plant_id,
--   on every lot where the column is still the whole truth. RUN TWICE BY DESIGN, and safe to run any
--   number of times:
--     1. straight after 0a, as the BACKFILL (the table is empty; every lot that carries a parent gets
--        its one row);
--     2. again straight after the Lambda that writes both the column and the rows is live on that
--        environment, to repair what the OLD Lambda did in between. Then 0c-arm.sql.
--   And again after any Lambda revert and re-promote (a reverted fleet writes the column only).
--
-- WHY A RECONCILE AND NOT AN INSERT-IF-MISSING BACKFILL. Between 0a and the new Lambda, the deployed
--   Lambda keeps writing the column and has never heard of the table. Three things it can do, and an
--   insert-only re-run repairs only the first:
--     * save a NEW lot with a parent         -> column set, no row            (R2 inserts it)
--     * CHANGE a lot's parent from A to B    -> column B, live row A          (R1 retires A, R2 adds B)
--     * CLEAR a lot's parent                 -> column NULL, live row A       (R1 retires A)
--   Left alone, the second reads as a two-parent lot nobody recorded and the third brings a parent back
--   that Dave removed.
--
-- THE RULE: ON A LOT WITH AT MOST ONE LIVE ROW, THE COLUMN WINS. ON A LOT WITH TWO OR MORE, NOTHING IS
--   WRITTEN. The old Lambda can only ever produce lots with zero or one row, so on those the column is
--   the newer statement of what Dave meant. A lot with two or more live rows was written by the new
--   Lambda on purpose, and no rule here knows better than it does:
--     R1  the lot has EXACTLY ONE live seed_parent row and its plant_id differs from the lot's
--         source_plant_id (a NULL column differs from everything): soft-delete that row.
--     R2  the lot's source_plant_id is not NULL and the lot has NO live seed_parent row (after R1):
--         insert one — role 'seed_parent', created_by copied from the lot.
--     R3  writes nothing. It LISTS every lot that has two or more live seed_parent rows while its
--         source_plant_id is NULL or is not one of them. That is the member-cache rule broken on a pooled
--         lot, and a person decides which side is right. Expected: no rows. 0c-arm.sql refuses while
--         R3 lists anything.
--   R2 is "no live row at all", not "no live row for that plant": after R1 the two are the same on
--   every lot with at most one row, and on a lot with two or more the narrower wording would insert a
--   third parent — which R3 forbids.
--
-- NOT FILTERED BY THE LOT'S deleted_at, in any step. A soft-deleted lot that still carries
--   source_plant_id is backfilled too (2 of the 24 on prod, 2026-10-05). A link row follows its lot and
--   is not soft-deleted with it, so a lot restored later must come back already holding the invariant.
--
-- role = 'seed_parent' ON EVERY STEP. Release 1 writes no other role. A pollen_parent row, if one ever
--   exists, is never counted, retired or inserted here: the cache is a member of the SEED parents.
--
-- CONCURRENCY. One transaction, READ COMMITTED, two locks, taken in the handler's own order:
--     1. FOR KEY SHARE on every lot row that carries a source_plant_id — the lots R2 may insert for.
--        It is the weakest row lock: an ordinary UPDATE of the lot (the wide PUT, a quantity tap, the
--        old Lambda's /source-plant) is NOT blocked. It conflicts only with FOR UPDATE, which is how
--        the new handler opens every parent write (lambda/inventory-items/seed-lot-parents.js,
--        statement 0), so a parent edit on one of those lots runs wholly before this file or wholly
--        after it.
--     2. SHARE ROW EXCLUSIVE on seed_lot_parent_planting. Readers are not blocked; every writer of link
--        rows waits until this commits, so R1 can never retire a lot's "only" row at the moment the
--        new Lambda is giving that lot a second one.
--   LOT ROWS FIRST, TABLE SECOND, and the order is the point. An R2 insert takes FOR KEY SHARE on its
--   lot anyway (the foreign-key check). Taken late, behind the table lock, it can meet a handler that
--   holds FOR UPDATE on that lot and is itself waiting for the table: a deadlock, and Postgres kills
--   one of the two — possibly Dave's save. Taken first, in the handler's order, there is no cycle
--   (rehearsed both ways on local PG 17).
--   What neither lock stops: the OLD Lambda writing the column between two statements here. That
--   leaves one lot one step behind, which the "after" row shows and the next run repairs — never a
--   wrong row. lock_timeout 5s: if either lock cannot be had the whole file rolls back having written
--   nothing. Run it again.
--
-- EXPECTED, prod, measured read-only 2026-10-05: first run R1 = 0, R2 = 24 (22 live lots + 2
--   soft-deleted), R3 lists nothing; an immediate second run R1 = 0, R2 = 0. The post-deploy run writes
--   one row per lot whose parent was saved, changed or cleared in the window, and nothing else.
--   Staging, same day: no lot carries source_plant_id, so the first run there writes nothing.
--
-- REFUSES unless 0a's stamp is on this database. Writes NO schema_version row: it is a repair, not a
--   schema state, and it must stay re-runnable.
--
-- Usage: psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f 0b-reconcile.sql
--   Each step prints one row: what it did, how many rows it wrote, and the lots it touched.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-seedmultiparent-001') THEN
    RAISE EXCEPTION 'v5-seedmultiparent-001 0b refused: 0a (5.0.0-seedmultiparent-001) is not applied here. Nothing to reconcile.';
  END IF;
END $$;

-- ── Locks: lot rows first, then the table (header, CONCURRENCY). ─────────────────────────────────
SELECT 'locks' AS step, count(*) AS lot_rows_held_for_key_share
  FROM (SELECT i.id FROM public.inventory_items i
         WHERE i.source_plant_id IS NOT NULL
           FOR KEY SHARE) held;

LOCK TABLE public.seed_lot_parent_planting IN SHARE ROW EXCLUSIVE MODE;

-- ── Before. ──────────────────────────────────────────────────────────────────────────────────────
SELECT 'before' AS step,
       (SELECT count(*) FROM public.inventory_items
         WHERE source_plant_id IS NOT NULL)                         AS lots_with_source_plant_id,
       (SELECT count(*) FROM public.seed_lot_parent_planting
         WHERE role = 'seed_parent' AND deleted_at IS NULL)         AS live_seed_parent_rows;

-- ── R1. The lot's only live row names a different plant than the column: retire the row. ─────────
WITH r1 AS (
  UPDATE public.seed_lot_parent_planting l
     SET deleted_at = now(), updated_at = now()
    FROM public.inventory_items i
   WHERE i.id = l.inventory_item_id
     AND l.role = 'seed_parent'
     AND l.deleted_at IS NULL
     AND l.plant_id IS DISTINCT FROM i.source_plant_id
     AND (SELECT count(*) FROM public.seed_lot_parent_planting x
           WHERE x.inventory_item_id = l.inventory_item_id
             AND x.role = 'seed_parent'
             AND x.deleted_at IS NULL) = 1
  RETURNING l.inventory_item_id
)
SELECT 'R1 soft-deleted: the lot''s only live row disagreed with source_plant_id' AS step,
       count(*)                                                                   AS rows_written,
       coalesce(array_agg(inventory_item_id ORDER BY inventory_item_id), '{}')    AS lots
  FROM r1;

-- ── R2. The column names a parent and the lot has no live row: insert it. ────────────────────────
WITH r2 AS (
  INSERT INTO public.seed_lot_parent_planting (inventory_item_id, plant_id, role, created_by)
  SELECT i.id, i.source_plant_id, 'seed_parent', i.created_by
    FROM public.inventory_items i
   WHERE i.source_plant_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.seed_lot_parent_planting l
                      WHERE l.inventory_item_id = i.id
                        AND l.role = 'seed_parent'
                        AND l.deleted_at IS NULL)
  RETURNING inventory_item_id
)
SELECT 'R2 inserted: source_plant_id set and the lot had no live row' AS step,
       count(*)                                                                AS rows_written,
       coalesce(array_agg(inventory_item_id ORDER BY inventory_item_id), '{}') AS lots
  FROM r2;

-- ── After. Both must read 0 before 0c-arm.sql will stamp. ────────────────────────────────────────
SELECT 'after' AS step,
       (SELECT count(*) FROM public.inventory_items i
         WHERE i.source_plant_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM public.seed_lot_parent_planting l
                            WHERE l.inventory_item_id = i.id
                              AND l.plant_id = i.source_plant_id
                              AND l.role = 'seed_parent'
                              AND l.deleted_at IS NULL))    AS lots_whose_cache_is_not_a_live_parent,
       (SELECT count(DISTINCT l.inventory_item_id)
          FROM public.seed_lot_parent_planting l
          JOIN public.inventory_items i ON i.id = l.inventory_item_id
         WHERE l.role = 'seed_parent'
           AND l.deleted_at IS NULL
           AND i.source_plant_id IS NULL)                   AS lots_with_parents_and_no_cache;

-- ── R3. NOT WRITTEN, LISTED: a pooled lot whose cache is NULL or is not one of its parents. ──────
-- Expected: (0 rows). Anything here is for a person. With no writer racing this file, the lots listed
-- here are exactly the lots the two counts above are counting.
SELECT 'R3 needs a person: 2+ live parents, cache NULL or not one of them' AS step,
       i.id                                         AS lot_id,
       i.name                                       AS lot_name,
       (i.deleted_at IS NOT NULL)                   AS lot_deleted,
       i.source_plant_id                            AS cache,
       array_agg(l.plant_id ORDER BY l.created_at, l.id) AS live_seed_parents
  FROM public.inventory_items i
  JOIN public.seed_lot_parent_planting l
    ON l.inventory_item_id = i.id
   AND l.role = 'seed_parent'
   AND l.deleted_at IS NULL
 GROUP BY i.id, i.name, i.deleted_at, i.source_plant_id
HAVING count(*) >= 2
   AND count(*) FILTER (WHERE l.plant_id = i.source_plant_id) = 0
 ORDER BY i.id;

COMMIT;
