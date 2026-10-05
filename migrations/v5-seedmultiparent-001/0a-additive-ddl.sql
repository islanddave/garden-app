-- 0a-additive-ddl.sql
-- V5-SEEDMULTIPARENT-001 — a saved-seed lot may come from MORE THAN ONE planting.
--   Seed pooled from three plants of one variety is one jar and one inventory_items row, and today that
--   row can name exactly one of them: inventory_items.source_plant_id (v4-seedlink-001). That migration
--   said what would happen if a bulked lot ever became real: "seed_lot_parent_planting is added
--   additively and THIS column stays". This is that table.
--   Canon: gardening-docs project-state/_seedmultiparent-20261005/R1-CONTRACT.md (binding for the
--   release) and PLAN-V002.md; the reviewed reasoning is in the four seat-*.md files beside them.
--
-- SCOPE: ONE new table, two foreign keys, one CHECK, three indexes, one schema_version row. NOTHING on
--   inventory_items or plants changes — no column, no constraint, no index, no view, no trigger. No row
--   is written to the new table here: the backfill is 0b-reconcile.sql, a separate file because it is
--   run twice (README.md, "The window").
--
-- DESIGN DECISIONS THIS DDL ENCODES:
--
--   * D1 — inventory_items.source_plant_id STAYS, AS A MEMBER CACHE. The rule, kept by the handler in
--     one transaction with the rows: the column IS NULL exactly when the lot has no live seed_parent
--     row here; otherwise it equals the plant_id of ONE of the lot's live seed_parent rows. Membership,
--     not "the first one". Why the column is not retired:
--       (i)   three constraints hang on it and none can be restated on this table, because a CHECK
--             cannot read another table: chk_inventory_seed_source_plant (a shop/gift source_kind
--             cannot sit beside a garden parent), chk_inventory_source_plant_seeds_only (a lot with a
--             parent cannot be re-filed out of Seeds), and the RESTRICT foreign key to plants. While
--             the cache is non-NULL on every lot that has parents, all three go on protecting pooled
--             lots against EVERY writer, including the Lambda that is deployed today and has never
--             heard of this table.
--       (ii)  three views read it (stat_saved_lot, stat_source_card, v_sow_candidates — the last under
--             standing gates that pin its rowcount and its projection), and so does the public site's
--             exporter (regression seat, F08-F10 and F15). None of them needs a change for this table
--             to exist.
--     What it costs, stated plainly: a reader that has not been moved to this table shows one true
--     parent and omits the others. It never shows a wrong one.
--     gates.yml's two pre_cache_column_* gates check (i) BEFORE the apply rather than assuming it, and
--     post_cache_column_constraints_survive keeps checking it afterwards.
--
--   * D2 — NO ordinal AND NO is_primary. The feature's own premise is that no parent is "the" parent:
--     three plants went into one jar. An ordinal with no unique index names no single row, a merge of
--     two parent plantings would leave a lot with no ordinal 0, and nothing would read the number. Read
--     order is the planting's name, then its id. The cache needs no ordinal either: it is "a member",
--     and when its member is removed the handler picks the earliest remaining live row (created_at,
--     then id). gates.yml post_no_ordinal_or_is_primary_column keeps both out.
--
--   * D3 — role, AND WHY IT HAS NO DEFAULT. Dave asked (2026-10-05) that the record leave room for a
--     deliberate cross, where one seed has a SEED parent (the plant the fruit grew on) and a POLLEN
--     parent. Two values, closed: 'seed_parent', 'pollen_parent'. Release 1 writes and reads
--     'seed_parent' ONLY — nothing writes 'pollen_parent', and every read and every reconcile step
--     filters role = 'seed_parent'. The column exists now so that recording a cross later is a new
--     writer, not a migration over rows whose role would then have to be guessed.
--     NO DEFAULT, deliberately: a default is a value nobody chose. grown_as DEFAULT 'annual' stamped
--     362 of 413 cultivars before it was dropped (2026-09-01). With no default, an INSERT that forgets
--     the role raises 23502 instead of quietly recording a pollen donor as a seed parent — every writer
--     names it. To add a third role, WIDEN chk_slpp_role (DROP + ADD with the longer list); never drop
--     it and go free-text.
--     role is part of the live unique key (D5): the same planting may be both the seed parent and the
--     pollen parent of one lot (a selfed plant in a controlled cross), but never the same role twice.
--
--   * D4 — BOTH FOREIGN KEYS ARE ON DELETE RESTRICT.
--       inventory_item_id: this table carries deleted_at, and the class guard in
--         tests/integration/cascade-sweep.int.test.js forbids a CASCADE into any table that does (a
--         cascade would hard-delete rows the app only ever soft-deletes). Same call, same reason, as
--         preservation_source.preservation_log_id (BUG-PUTUPSRCCASCADE-001).
--       plant_id: RESTRICT and NOT NULL, matching inventory_items_source_plant_id_fkey — NOT the SET
--         NULL preservation_source uses. That table can afford SET NULL because display_label names the
--         row after the pointer is gone; here the planting IS the row, and provenance that nulls itself
--         reads as "saved from nowhere" rather than "the parent record is gone".
--     RESTRICT blocks nothing the app does: the inventory DELETE and the plants DELETE are both
--     `UPDATE ... SET deleted_at`, and a planting merge soft-deletes its losers. It blocks an operator
--     hard-delete and the integration teardown, loudly; tests/integration/_cleanup.js deletes these rows
--     before inventory_items and plants for that reason.
--     A LINK ROW IS NOT SOFT-DELETED WHEN ITS LOT IS. It belongs to the lot and follows it, the way the
--     lot's photos and stage rows do (lambda/inventory-items/delete-guard.js FOLLOWING_RELATIONS):
--     clearing the lot's deleted_at brings it back with its parents. So every reader joins a LIVE lot,
--     and no gate may assert "no live link row on a deleted lot".
--
--   * D5 — INDEXES. uq_slpp_item_plant_role_live is UNIQUE on (inventory_item_id, plant_id, role) and
--     PARTIAL on deleted_at IS NULL, so removing a plant from a lot (a soft delete) frees the slot and
--     it can be added back. A unique INDEX, not a constraint: a constraint cannot be partial.
--     idx_slpp_item and idx_slpp_plant are PLAIN — one per foreign key column and NOT partial, unlike
--     preservation_source's idx_ps_plant. Postgres does not index the referencing side of a foreign
--     key, and a RESTRICT probe is `... WHERE plant_id = $1` with NO deleted_at term: an index partial on
--     deleted_at IS NULL cannot serve it, and every delete on plants or inventory_items would scan this
--     table. The same two indexes serve the reads ("this lot's parents", "lots this planting fed").
--
--   * D6 — NO TRIGGER, on this table or added to inventory_items. Checked on live prod 2026-10-05
--     rather than copied from a sibling: inventory_items carries two triggers (prevent_ownership_
--     transfer, set_updated_at), but the two sibling CHILD tables, seed_lot_stage_log and
--     preservation_source, carry none. Rows here are inserted, soft-deleted and repointed by a merge,
--     and nothing else; updated_at is written by the handler in the same statement. A trigger that kept
--     the cache in step would be invisible to the mock-sql unit suites, which is how
--     BUG-KBOWNERTRIGGER-001 shipped. The cache is kept by the handler, repaired by 0b-reconcile.sql and
--     watched by the two row-level gates (gates-rowlevel.yml.pending). gates.yml
--     post_no_trigger_on_the_table keeps it that way.
--
--   * D7 — created_by, the inventory family's spelling for the owner column, copied from the lot when a
--     row is written. It is a record of who made the link. It is NOT what a read scopes on: every read
--     reaches these rows through the LOT and the lot's own owner predicate.
--
-- WHY THE DEPLOYED WRITER IS UNAFFECTED (the house test: would the currently deployed code produce a
--   row that violates this?). No deployed code names this table, and nothing is added to a table it
--   writes — no CHECK, no trigger, no column. The schema seat read every write path of the
--   inventory-items and plants Lambdas against this shape (POST, PATCH /source-plant, PATCH
--   /source-kind, the wide PUT, the soft DELETE, the planting merge — seat-data-schema-architect.md
--   Q5): none can fail. Only a HARD delete of a planting or an item can, and only tests and operators
--   do those.
--
-- SAFETY / IDEMPOTENCY: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, each ADD CONSTRAINT
--   guarded by a pg_constraint lookup scoped to THIS table (Postgres has no ADD CONSTRAINT IF NOT
--   EXISTS), the stamp ON CONFLICT DO NOTHING. Re-running the whole file is a clean no-op and does not
--   move applied_at. Every constraint is BORN VALID on an empty table: no NOT VALID / VALIDATE pair.
--   lock_timeout: adding a foreign key takes a brief SHARE ROW EXCLUSIVE lock on inventory_items and on
--   plants. Behind a long-open transaction that request would queue, and every write to those tables
--   would queue behind IT; 5s turns that into a fast failure that changed nothing. Run it again.
--   ⚠ Exactly ONE COMMIT, at the end. Do not wrap this file in BEGIN/ROLLBACK to "rehearse" it on a
--   shared database: its own COMMIT ends your transaction. Rehearse on local PG 17 (README.md).
--
-- APPLY ORDER (README.md has the commands): this directory, the widened census allowlist in
--   migrations/v5-invrefstrand-001/gates.yml and the delete-guard classification are on dev BEFORE any
--   database is touched. Then staging: pre -> sweep -> 0a -> 0b -> post. Then prod, which needs Dave's
--   approval. The Lambda that names this table ships after both.
--
-- ROLLBACK: 0r-rollback.sql. Read its header first — it has a window.
--
-- Usage: psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f 0a-additive-ddl.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 1. The table. ────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.seed_lot_parent_planting (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_item_id uuid        NOT NULL,
  plant_id          uuid        NOT NULL,
  role              text        NOT NULL,              -- no default: every writer names it (D3)
  created_by        text        NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(), -- written by the handler; no trigger (D6)
  deleted_at        timestamptz                         -- set = this plant was removed from the lot
);

COMMENT ON TABLE public.seed_lot_parent_planting IS
  'The plantings a saved-seed lot came from, one row per (lot, planting, role). A live row = that planting is a parent of the lot; deleted_at set = it was removed from the lot. inventory_items.source_plant_id is a MEMBER CACHE of the live seed_parent rows: NULL exactly when the lot has none, otherwise one of them. Rows follow their lot into soft-deletion and are not soft-deleted with it, so every read joins a live lot.';
COMMENT ON COLUMN public.seed_lot_parent_planting.role IS
  'seed_parent = the plant the seed was taken from; pollen_parent = the pollen donor of a deliberate cross. No default: every writer names it. Release 1 writes and reads seed_parent only.';

-- ── 2. Constraints. Guarded, born valid on an empty table. ───────────────────────────────────────
DO $$
BEGIN
  -- D4. The lot. RESTRICT: this table carries deleted_at, so a CASCADE into it is forbidden.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.seed_lot_parent_planting'::regclass
                    AND conname = 'seed_lot_parent_planting_inventory_item_id_fkey') THEN
    ALTER TABLE public.seed_lot_parent_planting
      ADD CONSTRAINT seed_lot_parent_planting_inventory_item_id_fkey
      FOREIGN KEY (inventory_item_id) REFERENCES public.inventory_items(id) ON DELETE RESTRICT;
  END IF;

  -- D4. The planting. RESTRICT, matching inventory_items_source_plant_id_fkey.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.seed_lot_parent_planting'::regclass
                    AND conname = 'seed_lot_parent_planting_plant_id_fkey') THEN
    ALTER TABLE public.seed_lot_parent_planting
      ADD CONSTRAINT seed_lot_parent_planting_plant_id_fkey
      FOREIGN KEY (plant_id) REFERENCES public.plants(id) ON DELETE RESTRICT;
  END IF;

  -- D3. Closed two-value vocabulary. Widen it, never drop it.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.seed_lot_parent_planting'::regclass
                    AND conname = 'chk_slpp_role') THEN
    ALTER TABLE public.seed_lot_parent_planting
      ADD CONSTRAINT chk_slpp_role
      CHECK (role IN ('seed_parent','pollen_parent'));
  END IF;
END $$;

-- ── 3. Indexes (D5). ─────────────────────────────────────────────────────────────────────────────
-- One live row per (lot, planting, role). Partial, so a removed plant can be added back.
CREATE UNIQUE INDEX IF NOT EXISTS uq_slpp_item_plant_role_live
  ON public.seed_lot_parent_planting (inventory_item_id, plant_id, role)
  WHERE deleted_at IS NULL;

-- One per foreign key column, PLAIN: a RESTRICT probe carries no deleted_at term.
CREATE INDEX IF NOT EXISTS idx_slpp_item
  ON public.seed_lot_parent_planting (inventory_item_id);

CREATE INDEX IF NOT EXISTS idx_slpp_plant
  ON public.seed_lot_parent_planting (plant_id);

-- ── 4. The stamp. Same transaction as the DDL: "applied" and "armed" are one event. ───────────────
INSERT INTO public.schema_version (version, description)
VALUES ('5.0.0-seedmultiparent-001',
        'SEEDMULTIPARENT: V5-SEEDMULTIPARENT-001. New table seed_lot_parent_planting — the plantings a '
        'saved-seed lot came from, one row per (lot, planting, role): id, inventory_item_id, plant_id, '
        'role, created_by, created_at, updated_at, deleted_at. Both foreign keys ON DELETE RESTRICT '
        '(inventory_items, plants); chk_slpp_role (seed_parent | pollen_parent, no default — release 1 '
        'writes and reads seed_parent only); uq_slpp_item_plant_role_live UNIQUE (inventory_item_id, '
        'plant_id, role) WHERE deleted_at IS NULL; plain idx_slpp_item and idx_slpp_plant for the two '
        'RESTRICT probes. No ordinal, no is_primary, no trigger. ZERO changes to inventory_items: '
        'source_plant_id stays as a MEMBER CACHE (NULL exactly when the lot has no live seed_parent row, '
        'otherwise one of them), which keeps chk_inventory_seed_source_plant, '
        'chk_inventory_source_plant_seeds_only and the RESTRICT foreign key in force on pooled lots. A '
        'link row follows its lot into soft-deletion and is not soft-deleted with it. No rows written '
        'here: the backfill is 0b-reconcile.sql; stamp 5.0.0-seedmultiparent-001b is written by '
        '0c-arm.sql once the dual-writing Lambda is live.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
