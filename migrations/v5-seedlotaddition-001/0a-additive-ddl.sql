-- 0a-additive-ddl.sql
-- V5-SEEDLOTADDITION-001: seed picked on a later day goes INTO a seed lot that already exists.
--   Today a second picking of the same variety has to be saved as a second lot, or typed over the
--   first lot's total with nothing recording that it happened. This table is the record of each later
--   picking: which parent planting it came off, the day, and the amounts as they were typed. The lot's
--   own total (inventory_items.seed_count / seed_weight_g) is moved by the handler in the same
--   statement that writes the row here.
--   Canon: gardening-docs project-state/_seedmultiparent-20261005/r3/R3-CONTRACT.md section 1
--   (binding for the release; the names below are load-bearing there) and R3-PLAN-V002.md section 0.
--
-- SCOPE: ONE new table, one foreign key, five CHECKs, two indexes, one schema_version row. NOTHING on
--   inventory_items, plants or seed_lot_parent_planting changes: no column, no constraint, no index,
--   no view, no trigger. No row is written. There is no 0b and no 0c.
--
-- DESIGN DECISIONS THIS DDL ENCODES:
--
--   * A1. THE TABLE CARRIES parent_link_id ONLY. No inventory_item_id, no plant_id. The lot and the
--     planting are both functionally dependent on the link row (seed_lot_parent_planting.id names one
--     lot and one planting), and each extra reference would cost a standing surface:
--       (i)   a foreign key to inventory_items would be the SIXTH (live prod, 2026-10-07: five). It
--             reds migrations/v5-invrefstrand-001 post_inventory_fk_census_is_unchanged, needs a
--             FOLLOWING_RELATIONS entry in lambda/inventory-items/delete-guard.js, and the widened
--             census would have to be on dev before any database is touched;
--       (ii)  a plant_id column, foreign key or not, is matched by scripts/merge-surface-inventory.py
--             (uuid column whose name contains `plant`) and would have to be classified in
--             lambda/plants/merge.js SURFACES as a repoint, shipped with the first writer.
--     With the link only, a planting merge does NOT repoint this table and never needs to: merge
--     soft-deletes a colliding link row and repoints every link row, live or retired, and never
--     hard-deletes one. A picking follows its link row to the winner. So "this planting's pickings in
--     this lot" is read by joining link rows on (inventory_item_id, plant_id), NEVER on a link id.
--     No uuid column here may be named so that merge-surface-inventory.py reads it as a planting
--     surface (plant, target_id, subject_id, entity_id, node_id, leaf_id). gates.yml
--     post_no_fk_to_inventory_items_or_plants and post_no_planting_shaped_uuid_column keep both out.
--
--   * A2. THE FOREIGN KEY IS ON DELETE RESTRICT. This table carries deleted_at, and the class guard in
--     tests/integration/cascade-sweep.int.test.js forbids a CASCADE into any table that does (a
--     cascade would hard-delete rows the app only ever soft-deletes). Same call, same reason, as both
--     foreign keys of seed_lot_parent_planting (v5-seedmultiparent-001 0a header D4).
--     RESTRICT blocks nothing the app does: a parent is removed from a lot by `UPDATE ... SET
--     deleted_at`, and a merge soft-deletes. It blocks an operator hard-delete of a link row and a test
--     teardown, loudly (23503): delete the pickings first.
--     A PICKING IS NOT SOFT-DELETED WHEN ITS LINK ROW IS. It belongs to the link row and follows it,
--     the way a link row follows its lot. So a reader that wants a live lot's pickings joins a live
--     lot, and no gate may assert "no live picking under a retired link row".
--
--   * A3. addition_key, UNIQUE AND NOT PARTIAL. The phone makes one key per Save intent and sends it
--     with every retry, so a replay finds its own row instead of adding the amount twice. The unique
--     index has NO `WHERE deleted_at IS NULL`: a picking that is later taken back (soft-deleted) must
--     still block a replay of the request that wrote it. This is the deliberate opposite of
--     uq_slpp_item_plant_role_live, where a retired row has to free its slot.
--
--   * A4. idx_sla_parent_link IS PLAIN. Postgres does not index the referencing side of a foreign key,
--     and a RESTRICT probe is `... WHERE parent_link_id = $1` with no deleted_at term: an index
--     partial on deleted_at IS NULL could not serve it. The same index serves "this link's pickings".
--
--   * A5. THE AMOUNTS ARE WHAT WAS TYPED, AND NULL MEANS NOT GIVEN. seed_count, seed_count_estimated
--     and seed_weight_g are today's amounts for this one picking, never the lot's running total. Five
--     named CHECKs, one rule each, so a 23514 names which rule:
--       chk_sla_seed_count_positive          seed_count IS NULL OR seed_count >= 1
--       chk_sla_count_basis_pairing          (seed_count IS NULL) = (seed_count_estimated IS NULL)
--       chk_sla_seed_weight_positive         seed_weight_g IS NULL OR seed_weight_g > 0
--       chk_sla_count_applied_needs_count    NOT count_applied OR seed_count IS NOT NULL
--       chk_sla_weight_applied_needs_weight  NOT weight_applied OR seed_weight_g IS NOT NULL
--     >= 1 and > 0, not >= 0: a picking of nothing is not a picking, and "not given" is NULL. This is
--     the deliberate opposite of chk_inventory_seed_count_nonneg / _weight_nonneg on the lot, where 0
--     is a measured fact. The pairing rule is the lot's own (chk_inventory_seed_count_basis_pairing)
--     without its deleted_at arm: a count always says whether it was counted or estimated.
--     seed_weight_g is numeric(10,3). Postgres ROUNDS to the scale before the CHECK runs, so 0.0004
--     arrives as 0.000 and is refused by chk_sla_seed_weight_positive; the handler rounds first and
--     answers that itself.
--     No CHECK requires an amount. Both are optional in the request, and a picking with neither is a
--     legal row: the planting and the day are still recorded.
--
--   * A6. count_applied AND weight_applied HAVE NO DEFAULT. true = this picking moved the lot's total
--     of that kind WHEN IT WAS WRITTEN. It is a record of what the write did, not a claim about the
--     total now (the total can be re-measured later). false with an amount = the amount was recorded
--     and the total was left alone (the lot had no total of that kind to add to). A default would be
--     an answer nobody gave: with none, an INSERT that forgets either flag raises 23502. The two
--     needs_ CHECKs stop the one combination that cannot be true: "moved the total" with no amount.
--     gates.yml post_applied_flags_have_no_default keeps it that way.
--
--   * A7. NO TRIGGER, NO RLS, NO POLICY, AND NO GRANT IN THIS FILE. updated_at is written by the
--     handler in the same statement (a trigger would be invisible to the mock-sql unit suites, which
--     is how BUG-KBOWNERTRIGGER-001 shipped). The sibling table has no RLS and no policy (live prod,
--     2026-10-07) and this one matches it. On prod a default ACL (neondb_owner, relations, garden_ro
--     SELECT) gives garden_ro SELECT on this table at birth; staging has no such default ACL, so the
--     two databases differ on that one grant from the first minute. Accepted, same as the sibling
--     table. The public site does not read this table in this release, and no gate asserts the grant
--     or its absence.
--
--   * A8. created_by IS THE CALLER, the person who added the picking, as the link table writes it
--     (lambda/inventory-items/seed-lot-parents.js). It is NOT what a read scopes on: every read
--     reaches these rows through the LOT and the lot's own owner predicate.
--     deleted_at is reserved for a later "take this picking back". Nothing in this release sets it.
--
-- WHY THE DEPLOYED WRITER IS UNAFFECTED (the house test: would the currently deployed code produce a
--   row that violates this?). No deployed code names this table (`git grep seed_lot_addition` on dev
--   returns nothing before this release), and nothing is added to a table it writes: no CHECK, no
--   trigger, no column. So all five CHECKs are armed at birth on an empty table, with no NOT VALID /
--   VALIDATE pair, no arm step and one stamp. The only thing a deployed path can newly meet is the
--   RESTRICT, and only once a picking exists: a HARD delete of a link row. Only tests and operators
--   do those.
--
-- SAFETY / IDEMPOTENCY: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, each ADD CONSTRAINT
--   guarded by a pg_constraint lookup scoped to THIS table (Postgres has no ADD CONSTRAINT IF NOT
--   EXISTS), the stamp ON CONFLICT DO NOTHING. Re-running the whole file is a clean no-op and does not
--   move applied_at.
--   lock_timeout: adding the foreign key takes a brief SHARE ROW EXCLUSIVE lock on
--   seed_lot_parent_planting. Behind a long-open transaction that request would queue, and every
--   parent edit would queue behind IT; 5s turns that into a fast failure that changed nothing. Run
--   it again.
--   Exactly ONE COMMIT, at the end. Do not wrap this file in BEGIN/ROLLBACK to "rehearse" it on a
--   shared database: its own COMMIT ends your transaction. Rehearse on local PostgreSQL 17 (README.md).
--
-- APPLY ORDER (README.md has the commands and the reason for each step):
--   1. Staging: pre -> sweep -> 0a -> post -> rehearse 0r -> pre -> 0a -> post. Before the server lane.
--   2. Prod: Dave's first-hand OK for a prod database change, outside 07:00-08:00 UTC, after a
--      pre-apply copy: pre -> sweep -> 0a -> post.
--   3. ONLY THEN may a commit that names seed_lot_addition under lambda/** reach dev. Once one is on
--      dev, the promote's prod schema gate refuses every promote by every session until this table is
--      on prod. The table is inert before its code: nothing names it and it is empty.
--
-- ROLLBACK: 0r-rollback.sql. It refuses while any picking exists, and it goes BEFORE
--   migrations/v5-seedmultiparent-001/0r-rollback.sql.
--
-- Usage: psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f 0a-additive-ddl.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 1. The table. ────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.seed_lot_addition (
  id                   uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  addition_key         uuid          NOT NULL,               -- the phone's key, one per Save intent (A3)
  parent_link_id       uuid          NOT NULL,               -- seed_lot_parent_planting.id (A1)
  picked_on            date          NOT NULL,               -- the phone's local day
  seed_count           integer,                              -- today's amounts as typed; NULL = not given (A5)
  seed_count_estimated boolean,
  seed_weight_g        numeric(10,3),
  count_applied        boolean       NOT NULL,               -- no default: every writer says (A6)
  weight_applied       boolean       NOT NULL,               -- no default: every writer says (A6)
  created_by           text          NOT NULL,               -- the caller, who added it (A8)
  created_at           timestamptz   NOT NULL DEFAULT now(),
  updated_at           timestamptz   NOT NULL DEFAULT now(), -- written by the handler; no trigger (A7)
  deleted_at           timestamptz                           -- reserved: a later "take this picking back"
);

COMMENT ON TABLE public.seed_lot_addition IS
  'V5-SEEDLOTADDITION-001. One row per later picking put into a seed lot that already exists: the parent link it came off (seed_lot_parent_planting.id, which names the lot and the planting), the day, and the amounts as typed. The lot total on inventory_items is moved by the handler in the same statement. A picking follows its link row and is not soft-deleted with it, so read through a live lot; join link rows on (inventory_item_id, plant_id), never on a link id, because a planting merge repoints link rows.';
COMMENT ON COLUMN public.seed_lot_addition.addition_key IS
  'The client key for one Save intent, sent with every retry. Unique across ALL rows, soft-deleted ones included: a picking that was taken back still blocks a replay of its own request.';
COMMENT ON COLUMN public.seed_lot_addition.count_applied IS
  'true = this picking moved the lot seed_count when it was written. A record of what the write did, not a claim about the total now. No default: every writer says.';
COMMENT ON COLUMN public.seed_lot_addition.weight_applied IS
  'true = this picking moved the lot seed_weight_g when it was written. A record of what the write did, not a claim about the total now. No default: every writer says.';

-- ── 2. Constraints. Guarded, born valid on an empty table. ───────────────────────────────────────
DO $$
BEGIN
  -- A2. The parent link. RESTRICT: this table carries deleted_at, so a CASCADE into it is forbidden.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.seed_lot_addition'::regclass
                    AND conname = 'seed_lot_addition_parent_link_id_fkey') THEN
    ALTER TABLE public.seed_lot_addition
      ADD CONSTRAINT seed_lot_addition_parent_link_id_fkey
      FOREIGN KEY (parent_link_id) REFERENCES public.seed_lot_parent_planting(id) ON DELETE RESTRICT;
  END IF;

  -- A5. A count, when given, is at least one seed.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.seed_lot_addition'::regclass
                    AND conname = 'chk_sla_seed_count_positive') THEN
    ALTER TABLE public.seed_lot_addition
      ADD CONSTRAINT chk_sla_seed_count_positive
      CHECK (seed_count IS NULL OR seed_count >= 1);
  END IF;

  -- A5. A count always says whether it was counted or estimated, and the basis never stands alone.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.seed_lot_addition'::regclass
                    AND conname = 'chk_sla_count_basis_pairing') THEN
    ALTER TABLE public.seed_lot_addition
      ADD CONSTRAINT chk_sla_count_basis_pairing
      CHECK ((seed_count IS NULL) = (seed_count_estimated IS NULL));
  END IF;

  -- A5. A weight, when given, is more than nothing.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.seed_lot_addition'::regclass
                    AND conname = 'chk_sla_seed_weight_positive') THEN
    ALTER TABLE public.seed_lot_addition
      ADD CONSTRAINT chk_sla_seed_weight_positive
      CHECK (seed_weight_g IS NULL OR seed_weight_g > 0);
  END IF;

  -- A6. "Moved the count total" needs a count.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.seed_lot_addition'::regclass
                    AND conname = 'chk_sla_count_applied_needs_count') THEN
    ALTER TABLE public.seed_lot_addition
      ADD CONSTRAINT chk_sla_count_applied_needs_count
      CHECK (NOT count_applied OR seed_count IS NOT NULL);
  END IF;

  -- A6. "Moved the weight total" needs a weight.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.seed_lot_addition'::regclass
                    AND conname = 'chk_sla_weight_applied_needs_weight') THEN
    ALTER TABLE public.seed_lot_addition
      ADD CONSTRAINT chk_sla_weight_applied_needs_weight
      CHECK (NOT weight_applied OR seed_weight_g IS NOT NULL);
  END IF;
END $$;

-- ── 3. Indexes. ──────────────────────────────────────────────────────────────────────────────────
-- A3. One row per Save intent, for ever. NOT partial: a soft-deleted picking still blocks its replay.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sla_addition_key
  ON public.seed_lot_addition (addition_key);

-- A4. The foreign key column, PLAIN: a RESTRICT probe carries no deleted_at term.
CREATE INDEX IF NOT EXISTS idx_sla_parent_link
  ON public.seed_lot_addition (parent_link_id);

-- ── 4. The stamp. Same transaction as the DDL: "applied" and "armed" are one event. ───────────────
INSERT INTO public.schema_version (version, description)
VALUES ('5.0.0-seedlotaddition-001',
        'SEEDLOTADDITION: V5-SEEDLOTADDITION-001. New table seed_lot_addition, one row per later '
        'picking put into a seed lot that already exists: id, addition_key, parent_link_id, picked_on, '
        'seed_count, seed_count_estimated, seed_weight_g numeric(10,3), count_applied, weight_applied, '
        'created_by, created_at, updated_at, deleted_at. ONE foreign key, parent_link_id to '
        'seed_lot_parent_planting(id) ON DELETE RESTRICT; no inventory_item_id and no plant_id (lot and '
        'planting are read through the link row, and a planting merge repoints link rows, never this '
        'table). Five CHECKs armed at birth: chk_sla_seed_count_positive (NULL or >= 1), '
        'chk_sla_count_basis_pairing (count and basis NULL together), chk_sla_seed_weight_positive '
        '(NULL or > 0), chk_sla_count_applied_needs_count, chk_sla_weight_applied_needs_weight. '
        'uq_sla_addition_key UNIQUE (addition_key), not partial; plain idx_sla_parent_link for the '
        'RESTRICT probe. count_applied and weight_applied have no default. No trigger, no RLS, no '
        'grant, no backfill, no row written. ZERO changes to inventory_items, plants or '
        'seed_lot_parent_planting.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
