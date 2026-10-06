-- 0r-rollback.sql — V5-SEEDMULTIPARENT-001 rollback. Drops seed_lot_parent_planting and removes both
--   stamps (5.0.0-seedmultiparent-001b, then 5.0.0-seedmultiparent-001). Touches nothing else:
--   inventory_items.source_plant_id, its foreign key and its two CHECKs were never changed by this
--   migration and are not changed back.
--
-- ⚠ BEFORE RUNNING, IN THE REPO — the row-level gates must be OUT of gates.yml FIRST.
--   Once the two gates from gates-rowlevel.yml.pending have been appended to gates.yml (the second
--   push, README.md), they name public.seed_lot_parent_planting in their SQL. Postgres resolves a
--   relation name at PARSE time, so with the table gone they do not go vacuous, they ERROR (42P01) —
--   under any WHERE, stamp or no stamp — and an erroring gate reds gate-invariants.yml on that
--   environment for every migration in the tree. Remove them from gates.yml (back to the .pending
--   file), push, and let that push reach whatever branch runs the corpus against this database (dev
--   for the push-triggered run, main for the Tuesday cron) BEFORE this file is applied.
--
--   WHAT MAY STAY, and why it is safe:
--     * the census allowlist line in migrations/v5-invrefstrand-001/gates.yml
--       (('seed_lot_parent_planting_inventory_item_id_fkey', 'r')). It sits inside a NOT IN list read
--       against pg_constraint; a name that matches no constraint excludes nothing, so the census is
--       green with the table and without it;
--     * every gate in this directory's gates.yml, including the feed gate. All of them are catalog-only
--       and self-armed on stamp 001, which this file deletes: they return to vacuous;
--     * the FOLLOWING_RELATIONS entry in lambda/inventory-items/delete-guard.js and the
--       seed_lot_parent_planting step in tests/integration/_cleanup.js (it checks the table exists
--       before it runs).
--
-- ⚠ THE WINDOW — this file is a clean undo ONLY WHILE NO DEPLOYED CODE NAMES THE TABLE. Once the Lambda
--   release that reads and writes seed_lot_parent_planting is live (or is on dev, where the promote's
--   prod schema gate reads it), dropping the table turns every seed read into a 42P01. After that point
--   the holding state is "leave the table": it is inert to code that does not name it, and the lever is
--   a code rollback followed by 0b-reconcile.sql when the new code returns.
--
-- ⚠ NEWEST FIRST — v5-seedstatsparents-001 (release 2a) made stat_saved_lot and stat_source_card read
--   this table. The DROP TABLE below has no CASCADE, so with those views in place it would abort the
--   transaction with "other objects depend on it". The first block refuses up front instead, naming the
--   views and the order: roll back migrations/v5-seedstatsparents-001/0r-rollback.sql first (it puts
--   both views back to the definitions that read inventory_items.source_plant_id only), then this
--   file. It reads pg_depend, so it also names a view nobody told this file about.
--
-- THE REFUSAL GUARD (section 0, straight after the dependency refusal). The column can rebuild exactly one link per lot: the
--   one 0b-reconcile.sql would write (role seed_parent, plant_id = the lot's source_plant_id). Every
--   OTHER live row exists only in this table — the second and later parents of a pooled lot, a
--   pollen_parent, or a row that disagrees with its lot's column — and dropping the table destroys it.
--   So this file refuses, changing nothing, while any such row is live, and says how many on how many
--   lots:
--     * if they are window drift (the old Lambda changed or cleared a parent after the backfill), run
--       0b-reconcile.sql first; it retires them and this file then proceeds;
--     * if they are real pooled lots, dropping is deliberate loss of recorded provenance. That is
--       Dave's decision, per lot, with the rows exported first — not a cleanup step, and not something
--       to get past by editing the guard.
--   Soft-deleted rows (a plant that was removed from a lot) do not stop the rollback and are lost with
--   the table. Nothing in release 1 reads them.
--   A re-run after a successful rollback finds no table and no stamps and is a no-op.
--
-- Also used by the staging rehearsal (README.md): 0a -> 0b -> post -> THIS -> 0a -> 0b -> post. That is
--   what makes the rollback tested rather than asserted. At that point the table holds only what 0b
--   wrote, so the guard passes.
--
-- No constraint or index is dropped by name: they belong to the table and go with it. No CASCADE: a
--   dependency nobody declared (a view, a foreign key from a later migration) stops the rollback
--   instead of disappearing with it.
--
-- Usage: psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── Newest first (runs before section 0): refuse while any view reads the table. ─────────────────
DO $$
DECLARE
  v_views text;
BEGIN
  -- Catalog-only, so a database where the table is already gone finds nothing and falls through.
  -- The two casts name system catalogs, which always exist.
  SELECT string_agg(DISTINCT vw.relname::text, ', ' ORDER BY vw.relname::text)
    INTO v_views
    FROM pg_depend d
    JOIN pg_rewrite r   ON r.oid = d.objid
    JOIN pg_class vw    ON vw.oid = r.ev_class
    JOIN pg_class src   ON src.oid = d.refobjid
    JOIN pg_namespace n ON n.oid = src.relnamespace
   WHERE d.classid = 'pg_catalog.pg_rewrite'::regclass
     AND d.refclassid = 'pg_catalog.pg_class'::regclass
     AND n.nspname = 'public' AND src.relname = 'seed_lot_parent_planting' AND src.relkind = 'r'
     AND vw.oid <> src.oid;

  IF v_views IS NOT NULL THEN
    RAISE EXCEPTION 'v5-seedmultiparent-001 0r refused, nothing dropped: public.seed_lot_parent_planting is still read by: %.', v_views
      USING HINT = 'Roll back v5-seedstatsparents-001 first (migrations/v5-seedstatsparents-001/0r-rollback.sql), then re-run this rollback. Newest first.';
  END IF;
END $$;

-- ── 0. The refusal guard. ────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_rows bigint;
  v_lots bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relname = 'seed_lot_parent_planting' AND c.relkind = 'r') THEN
    -- EXECUTE, so a database where the table is already gone never parses a query that names it.
    EXECUTE $q$
      SELECT count(*), count(DISTINCT l.inventory_item_id)
        FROM public.seed_lot_parent_planting l
        JOIN public.inventory_items i ON i.id = l.inventory_item_id
       WHERE l.deleted_at IS NULL
         AND NOT (l.role = 'seed_parent' AND l.plant_id IS NOT DISTINCT FROM i.source_plant_id)
    $q$ INTO v_rows, v_lots;

    IF v_rows > 0 THEN
      RAISE EXCEPTION 'v5-seedmultiparent-001 0r refused, nothing dropped: % live parent link(s) on % lot(s) exist only in seed_lot_parent_planting (a lot with more than one parent, a pollen parent, or a row that disagrees with its lot''s source_plant_id).',
        v_rows, v_lots
        USING HINT = 'If they are drift from the old Lambda, run 0b-reconcile.sql and try again. If they are real pooled lots, dropping the table loses them: that is Dave''s decision.';
    END IF;
  END IF;
END $$;

-- ── 1. The table. Its indexes and constraints go with it. ────────────────────────────────────────
DROP TABLE IF EXISTS public.seed_lot_parent_planting;

-- ── 2. Both stamps, the arming one first. ────────────────────────────────────────────────────────
DELETE FROM public.schema_version WHERE version = '5.0.0-seedmultiparent-001b';
DELETE FROM public.schema_version WHERE version = '5.0.0-seedmultiparent-001';

COMMIT;
