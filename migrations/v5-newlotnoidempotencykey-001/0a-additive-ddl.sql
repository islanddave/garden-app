-- 0a-additive-ddl.sql
-- BUG-NEWLOTNOIDEMPOTENCYKEY-001: the key a new inventory item's create is retried under.
--   Saving a NEW seed lot (POST /api/inventory-items) carries no key the server keeps, so a create
--   whose answer was lost and was saved again, or a draft closed mid-save, typed again and saved
--   before the first landed, is two lots. The add-to-a-lot form has a key and somewhere to keep it
--   (seed_lot_addition.addition_key); a create has neither. That storage cannot hold a create's key:
--   it hangs on a parent link row, and a lot saved with no planting has none.
--   The client half exists (branch lane/t3-newlotkey-20261012): the create body now carries
--   `idempotency_key`, a uuid v4, one per draft. Today's Lambda ignores it. This file is the place
--   the server half will keep it.
--
-- SCOPE: one nullable column on inventory_items, one partial unique index, one schema_version row.
--   No CHECK, no trigger, no view change, no backfill. No row is written or rewritten.
--
-- DESIGN DECISIONS THIS DDL ENCODES:
--
--   * K1. THE HOUSE SHAPE, UNCHANGED. Every keyed create in this database keeps its key on the row it
--     made, behind a unique index of one shape:
--       pantry_item     uq_pantry_item_idempotency_key      (v5-pantry-001 0a)
--       recipe          uq_recipe_idempotency_key           (v5-recipes-001 0a)
--       kitchen_batch   uq_kitchen_batch_idempotency_key    (v5-putupmake-001 0a)
--     each `idempotency_key uuid`, nullable, no default, and
--     UNIQUE (idempotency_key) WHERE idempotency_key IS NOT NULL. This is that shape with the table
--     name changed, so the handler can copy recipeRoutes.js / batchBuilderRoutes.js line for line: read
--     by key inside the household, else INSERT, and a 23505 whose err.constraint is
--     uq_inventory_items_idempotency_key is a replay.
--
--   * K2. NULLABLE, NO DEFAULT. NULL = this row was not made by a keyed create: every row that exists
--     today, every row the deployed Lambda writes, and every create by a client that sends no key.
--     A default would mint a key nobody sent.
--
--   * K3. GLOBAL, NOT SCOPED BY HOUSEHOLD. The key is a uuid v4 the phone mints; the index carries no
--     owner column, as the three above do not. Whose row a key found is the handler's question (it
--     reads inside created_by = ANY(householdIds)); a key that lands on another household's row is a
--     conflict, never a replay.
--
--   * K4. PARTIAL ON "IS NOT NULL" ONLY, NOT ON deleted_at. A soft-deleted lot still holds its key:
--     a replay of the create that made a lot since deleted must not make a second lot. Same as the
--     three above. Without the predicate the index would be the same rule at a larger size (Postgres
--     never treats two NULLs as equal); the predicate keeps it to keyed rows and keeps the name's
--     definition identical to its three siblings.
--
--   * K5. NO CHECK AND NO NOT NULL, NOW OR LATER WITHOUT A SECOND DEPLOY STEP. Either would be a
--     constraint on a value only the NEW writer sets (gardening-deploy.md, "arming a CHECK is NOT
--     backward-compatible"). gates.yml post_nothing_else_names_the_column keeps one from riding in.
--
-- WHY THE DEPLOYED CODE IS UNAFFECTED (the house test: would the currently deployed code produce a
--   row that violates this, or break on reading it?). Read on origin/dev 1f58a9d8.
--   WRITERS. One statement inserts into inventory_items (lambda/inventory-items/index.js POST arm) and
--   it is an explicit column list without this column; the wide PUT and every other UPDATE are
--   explicit SET lists. Every row they write leaves the column NULL, NULL is outside the index, so
--   nothing a deployed writer does can meet a 23505 here. validateCreate and validateUpdate do not
--   refuse unknown body keys, so the key the new client sends is ignored, as it is today.
--   READERS. The list and detail reads select i.* and POST/PUT answer RETURNING *, so from the moment
--   this is applied every lot in an API answer carries one more key, "idempotency_key": null. Nothing
--   reads it. That is the same thing every column added to this table has done (seed_stage,
--   seed_process, seed_parent_plant_count).
--   v_sow_candidates and the other views list their columns and are unchanged.
--
-- SAFETY / IDEMPOTENCY: ADD COLUMN IF NOT EXISTS, CREATE UNIQUE INDEX IF NOT EXISTS, the stamp
--   ON CONFLICT DO NOTHING. Re-running the whole file is a clean no-op and does not move applied_at.
--   IF NOT EXISTS is silent about a column or an index that is already there in another shape, so
--   the file checks before (step 0) and after (step 3) and raises, changing nothing, rather than
--   commit a shape other than the one written here.
--   LOCKS. ADD COLUMN takes ACCESS EXCLUSIVE on inventory_items (a catalog change: nullable, no
--   default, so no table rewrite) and holds it to COMMIT; the index build runs under it. The index
--   is born empty (every existing key is NULL), so the build reads the table once and writes
--   nothing. On a table of hundreds of rows the whole transaction is milliseconds, during which
--   inventory reads and writes wait.
--   lock_timeout: behind a long-open transaction the ACCESS EXCLUSIVE request would queue, and every
--   inventory read and write would queue behind IT; 5s turns that into a fast failure that changed
--   nothing. Run it again.
--   Exactly ONE COMMIT, at the end. Do not wrap this file in BEGIN/ROLLBACK to "rehearse" it on a
--   shared database: its own COMMIT ends your transaction.
--
-- APPLY ORDER (README.md has the commands). Staging: pre -> sweep -> 0a -> post -> rehearse 0r -> pre
--   -> 0a -> post. Prod: Dave's first-hand OK for a prod database change, outside 07:00-08:00 UTC,
--   after a pre-apply copy. On both databases BEFORE a commit whose Lambda names the column reaches
--   dev: the promote's prod schema gate refuses every promote from then until the column is on prod.
--
-- ROLLBACK: 0r-rollback.sql.
--
-- NOT RUN ANYWHERE by the lane that wrote it. No statement in this file has met PostgreSQL.
--
-- Usage: psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f 0a-additive-ddl.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. Refuse a database that is not the expected one. ───────────────────────────────────────────
DO $$
DECLARE
  v_type text;
  v_on   text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'public' AND c.relname = 'inventory_items' AND c.relkind = 'r') THEN
    RAISE EXCEPTION 'v5-newlotnoidempotencykey-001 0a refused, nothing changed: public.inventory_items is not a table in this database.';
  END IF;

  -- A column of this name that arrived by another route is kept by ADD COLUMN IF NOT EXISTS in
  -- whatever type it has. Only uuid is this migration's column.
  SELECT format_type(a.atttypid, a.atttypmod) INTO v_type
    FROM pg_attribute a
    JOIN pg_class c     ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'inventory_items'
     AND a.attname = 'idempotency_key' AND a.attnum > 0 AND NOT a.attisdropped;
  IF FOUND AND v_type <> 'uuid' THEN
    RAISE EXCEPTION 'v5-newlotnoidempotencykey-001 0a refused, nothing changed: inventory_items.idempotency_key already exists as %, not uuid.', v_type
      USING HINT = 'Find what created it before going on; do not edit this guard.';
  END IF;

  -- Any relation that already has the index name makes CREATE INDEX IF NOT EXISTS a silent no-op.
  SELECT t.relname INTO v_on
    FROM pg_class i
    JOIN pg_namespace n ON n.oid = i.relnamespace
    LEFT JOIN pg_index x ON x.indexrelid = i.oid
    LEFT JOIN pg_class t ON t.oid = x.indrelid
   WHERE n.nspname = 'public' AND i.relname = 'uq_inventory_items_idempotency_key';
  IF FOUND AND v_on IS DISTINCT FROM 'inventory_items' THEN
    RAISE EXCEPTION 'v5-newlotnoidempotencykey-001 0a refused, nothing changed: a relation named uq_inventory_items_idempotency_key exists and is not an index on inventory_items.'
      USING HINT = 'The replay contract is a 23505 on that name; it has to be this index.';
  END IF;
END $$;

-- ── 1. The column (K1, K2). uuid, nullable, no DEFAULT. ──────────────────────────────────────────
ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS idempotency_key uuid;

COMMENT ON COLUMN public.inventory_items.idempotency_key IS
  'BUG-NEWLOTNOIDEMPOTENCYKEY-001. The client key of the create that made this row (POST /api/inventory-items), sent again with every retry of that create. NULL = not made by a keyed create. Unique across ALL rows that have one, soft-deleted rows included (uq_inventory_items_idempotency_key): a 23505 on that index is a replay, and the handler answers with the row the key already made. Never a default, never a CHECK: every older writer leaves it NULL.';

-- ── 2. The index (K1, K3, K4). One row per key, for ever. ────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_items_idempotency_key
  ON public.inventory_items (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ── 3. Refuse to commit any shape but the one above. ─────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'inventory_items'
                    AND column_name = 'idempotency_key' AND data_type = 'uuid'
                    AND is_nullable = 'YES' AND column_default IS NULL) THEN
    RAISE EXCEPTION 'v5-newlotnoidempotencykey-001 0a refused, rolled back: inventory_items.idempotency_key is not a nullable uuid without a default.';
  END IF;

  IF NOT EXISTS (SELECT 1
                   FROM pg_index x
                   JOIN pg_class i     ON i.oid = x.indexrelid
                   JOIN pg_class t     ON t.oid = x.indrelid
                   JOIN pg_namespace n ON n.oid = t.relnamespace
                  WHERE n.nspname = 'public' AND t.relname = 'inventory_items'
                    AND i.relname = 'uq_inventory_items_idempotency_key'
                    AND x.indisunique AND x.indisvalid
                    AND strpos(pg_get_indexdef(x.indexrelid),
                               '(idempotency_key) WHERE (idempotency_key IS NOT NULL)') > 0) THEN
    RAISE EXCEPTION 'v5-newlotnoidempotencykey-001 0a refused, rolled back: uq_inventory_items_idempotency_key is not a valid unique index on (idempotency_key) WHERE idempotency_key IS NOT NULL.';
  END IF;
END $$;

-- ── 4. The stamp. Same transaction as the DDL: "applied" and "armed" are one event. ───────────────
INSERT INTO public.schema_version (version, description)
VALUES ('5.0.0-newlotnoidempotencykey-001',
        'NEWLOTNOIDEMPOTENCYKEY: BUG-NEWLOTNOIDEMPOTENCYKEY-001. inventory_items.idempotency_key '
        '(uuid, nullable, no DEFAULT): the client key of the create that made the row, so a retried '
        'create answers with the first lot instead of making a second. '
        'uq_inventory_items_idempotency_key UNIQUE (idempotency_key) WHERE idempotency_key IS NOT '
        'NULL: global, not scoped by household, not partial on deleted_at; the same shape as '
        'pantry_item, recipe and kitchen_batch. No CHECK, no trigger, no view change, no backfill, '
        'no row written: every deployed writer leaves the column NULL.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
