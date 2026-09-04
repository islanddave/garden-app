-- V5-KBOWNERTRIGGER-001 — BUG-KBOWNERTRIGGER-001: every UPDATE to kitchen_batch raises 42703.
--
-- THE DEFECT, verified against live prod by two independent sessions. V5-INFLIGHTBATCH-001 attaches
-- the shared trigger function public.prevent_ownership_transfer() to kitchen_batch
-- (0a-additive-ddl.sql:183-184). That function's body is:
--
--     IF OLD.created_by IS DISTINCT FROM NEW.created_by THEN
--       RAISE EXCEPTION 'created_by cannot be changed after creation';
--
-- and kitchen_batch HAS NO created_by COLUMN. Its owner column is user_id, and the same migration
-- says so deliberately at its line 69 — "user_id, matching preservation_log and storage_location —
-- NOT created_by, which is the inventory/event family's spelling". Line 69 names the difference;
-- line 183 then attaches a trigger hard-coded to the other spelling. PL/pgSQL resolves OLD.<field> at
-- EXECUTION time, so every row-level BEFORE UPDATE raises `record "old" has no field "created_by"`,
-- SQLSTATE 42703. The trigger has no WHEN clause, so it fires on every UPDATE of every row.
--
-- BLAST RADIUS — three routes, two of them ALREADY SHIPPED AND LIVE:
--   * PUT    /api/kitchen-batches/:id        — LIVE, called by GoingNowView.jsx (SetStartDate). 500s.
--   * DELETE /api/kitchen-batches/:id        — LIVE, called by CaptureFlow.jsx's Undo, which is a
--                                              soft delete and therefore an UPDATE. 500s.
--   * POST   /api/kitchen-batches/:id/close  — and, with this release, /reopen and /outputs. All 500.
-- INSERT paths are unaffected (BEFORE UPDATE only), which is why creating a batch works and why
-- kitchen_stage_log and kitchen_batch_input (no triggers) work.
--
-- WHY NOTHING CAUGHT IT, each verified rather than assumed:
--   * kitchenRoutes.test.js executes against a MOCK sql driver (its own header says so). A mock has
--     no triggers, so 300+ green tests cannot see this.
--   * v5-inflightbatch-001/gates.yml pre_trigger_functions_exist asserts only that the two functions
--     EXIST BY NAME. It never checks that the columns a function's body references exist on the table
--     being triggered — an existence gate standing where a compatibility gate was needed.
--   * deploy-staging.yml's write-path smoke has zero "kitchen" matches.
--   * prod holds 0 kitchen_batch rows, so no user has reached it.
--
-- ── WHY THE SHARED FUNCTION IS NOT TOUCHED ───────────────────────────────────────────────────────
-- public.prevent_ownership_transfer() is attached to TEN tables. Nine of them HAVE created_by and the
-- function is CORRECT for all nine; kitchen_batch is the single outlier (measured on prod: the count
-- of tables carrying this trigger that lack created_by is 1, and that probe is the instrument check —
-- had it returned 9 the reading of the trigger would have been wrong). Rewriting the shared body to
-- be spelling-agnostic (to_jsonb(OLD)->>'…') would put nine correct, working enforcement points at
-- risk to fix one broken one, and would silently weaken the nine from a compile-time column reference
-- to a runtime string lookup. FIX THE OUTLIER, NOT THE SHARED FUNCTION. This file therefore detaches
-- the trigger from kitchen_batch ONLY and gives that one table its own function guarding user_id.
--
-- ── WHY NO COUNT GATE MOVES ──────────────────────────────────────────────────────────────────────
-- THIS MIGRATION ADDS NO COLUMNS TO ANY TABLE. It creates one function and one trigger and drops
-- another trigger. Specifically:
--   * v4-putupsession-001 :: post_column_count_is_25 and v4-putupprov-001 :: post_column_count_is_25
--     pin preservation_log at 25 columns. Untouched — this file does not name preservation_log.
--   * v5-phrecord-001 :: post_view_gained_exactly_two asserts
--     cols(v_kitchen_batch_current) = cols(kitchen_batch) + 8. It LOOKS self-maintaining because it
--     is a delta and it is NOT: the view is `SELECT b.*` and Postgres expands b.* at CREATE time, so
--     ANY column added to kitchen_batch raises the right-hand side while the stored view stays
--     frozen, and the gate reds on the CONTINUOUS sweep against BOTH prod and staging. That is
--     exactly why the fix here is a trigger swap and not "add a created_by column to kitchen_batch":
--     the column would satisfy the shared function AND red a gate on a migration this work never
--     touched, on both databases, with a message naming neither. It would also duplicate user_id with
--     no distinct meaning.
--   All three of those gates carry continuous: true and are swept by a workflow that has been
--   BLOCKING since 2026-08-10. None of them can move because of this file.
--
-- ── ORDERING: PRE-DEPLOY, and both halves are backward-compatible ────────────────────────────────
-- The falsifiable test is "would the CURRENTLY DEPLOYED code produce a row that violates this?"
--   * DROP TRIGGER is a pure RELAXATION. No deployed writer depends on it firing successfully — it
--     cannot, it always errors.
--   * The new trigger guards user_id. The deployed updateBatch SET list is a fixed 13-column literal,
--     deleteBatch sets only deleted_at, and closeBatch sets closed_at/outcome/outcome_note/
--     suspended_at. NONE of them writes user_id, so no currently-deployed writer can violate it.
-- Both halves are therefore safe to apply BEFORE the Lambda ships, in one file, with no post-deploy
-- companion. Old Lambda + this schema is strictly BETTER than today (the live PUT and Undo start
-- working); new Lambda + old schema is HARD (reopen/outputs/close all 500 on the 42703). The DDL goes
-- to prod ahead of the promote, as with every file in this family.

BEGIN;

-- ── 1. detach the shared function from the one table it is wrong for ─────────────────────────────
-- Not DROP FUNCTION. The function stays exactly as it is and stays attached to its other nine
-- tables; only kitchen_batch's binding to it goes.
DROP TRIGGER prevent_ownership_transfer ON public.kitchen_batch;

-- ── 2. the same guard, spelled for this table's owner column ─────────────────────────────────────
-- Byte-for-byte the shared function's logic with created_by -> user_id, deliberately rather than
-- generalized: a column reference is resolved by PL/pgSQL against the row type, so this function can
-- only ever be attached to a table that HAS user_id — which is the property whose absence caused the
-- defect. A jsonb-based spelling-agnostic version would attach cleanly to anything and fail at
-- runtime, reproducing the bug class one level up.
--
-- The message keeps the shared function's wording pattern so the two read alike in a log, and names
-- the column this table actually has.
CREATE OR REPLACE FUNCTION public.prevent_kitchen_batch_ownership_transfer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.user_id IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'user_id cannot be changed after creation';
  END IF;
  RETURN NEW;
END;
$$;

-- Same shape as the trigger it replaces: BEFORE UPDATE, FOR EACH ROW, no WHEN clause. A WHEN clause
-- would be a second place the predicate lives.
--
-- TRIGGER ORDER IS ALPHABETICAL within a timing/event class, and it matters here: the old name sorted
-- BEFORE set_updated_at, so the broken trigger fired first and nothing downstream ever ran. The new
-- name also sorts before set_updated_at ('p' < 's'), so ordering is unchanged — stated because it is
-- the kind of incidental property a rename silently breaks.
CREATE TRIGGER prevent_kitchen_batch_ownership_transfer BEFORE UPDATE ON public.kitchen_batch
  FOR EACH ROW EXECUTE FUNCTION public.prevent_kitchen_batch_ownership_transfer();

-- schema_version.description is NOT NULL with no default — omitting it fails the apply
-- mid-transaction.
INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('5.0.0-kbownertrigger-20260904',
        'KBOWNERTRIGGER: detach prevent_ownership_transfer from kitchen_batch (its body names '
        'OLD.created_by and this table has none, so every UPDATE raised 42703) and attach '
        'prevent_kitchen_batch_ownership_transfer, guarding user_id. No columns added; the shared '
        'function is untouched and still guards its other nine tables.',
        now())
ON CONFLICT (version) DO UPDATE
  SET description = EXCLUDED.description, applied_at = EXCLUDED.applied_at;

COMMIT;

-- Verify:
--   SELECT tgname, pg_get_triggerdef(oid) FROM pg_trigger
--    WHERE tgrelid = 'public.kitchen_batch'::regclass AND NOT tgisinternal ORDER BY tgname;
--   SELECT pg_get_functiondef('public.prevent_kitchen_batch_ownership_transfer()'::regprocedure);
--   -- the shared function still guards the other nine:
--   SELECT count(DISTINCT tgrelid) FROM pg_trigger
--    WHERE tgfoid = 'public.prevent_ownership_transfer()'::regprocedure AND NOT tgisinternal;
--   -- and the thing this file exists for, on STAGING (never prod):
--   BEGIN;
--     INSERT INTO public.kitchen_batch (user_id, label) VALUES ('probe','probe') RETURNING id \gset
--     UPDATE public.kitchen_batch SET notes = 'x' WHERE id = :'id';   -- must report UPDATE 1
--     UPDATE public.kitchen_batch SET user_id = 'other' WHERE id = :'id';  -- must RAISE
--   ROLLBACK;
