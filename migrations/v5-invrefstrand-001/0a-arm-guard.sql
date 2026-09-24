-- 0a-arm-guard.sql
-- BUG-INVREFSTRAND-001 (option C) — arm the standing inventory-reference guard.
--
-- ┌─ THE DEFECT ─────────────────────────────────────────────────────────────────────────────────┐
-- │ Four foreign keys point at inventory_items, two of them ON DELETE RESTRICT. NONE of them can  │
-- │ fire, because the app never hard-deletes: lambda/inventory-items/index.js implements DELETE   │
-- │ as `UPDATE inventory_items SET deleted_at = NOW()`, and a foreign key guards DELETEs, not     │
-- │ UPDATEs. The parent survives, the pointer stays technically valid, and every read path        │
-- │ filters `deleted_at IS NULL` — so the reference stops resolving with no error and a 200.      │
-- │ A planting sown from a deleted packet keeps a source_inventory_item_id that resolves to       │
-- │ nothing, and seed -> plant provenance breaks with nothing to see.                             │
-- └──────────────────────────────────────────────────────────────────────────────────────────────┘
--
-- THIS FILE WRITES NO DATA. It inserts one schema_version row and nothing else. That row is the
-- ARMING SWITCH: every standing gate in gates.yml carries
--     AND EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-invrefstrand-20260924')
-- so the guard is vacuously green until this runs and a real invariant forever after. Self-arming is
-- mandatory, not stylistic: gate-invariants.yml fires on any migrations/** push and would red the job
-- the moment these gates landed if they asserted before being applied.
--
-- WHAT IT ARMS: a live planting (archived included) or a live treatment event pointing at a
-- soft-deleted inventory item — exactly the two references lambda/inventory-items/delete-guard.js
-- refuses a delete over. The item's own photos, stage history and seed_saved pointer are NOT counted:
-- they follow the item into soft-deletion by design (README §What counts).
--
-- ┌─ READ BEFORE APPLYING ───────────────────────────────────────────────────────────────────────┐
-- │ APPLYING IS A PROD WRITE AND NEEDS DAVE'S APPROVAL — this lane did not apply it anywhere.     │
-- │ Run the pre gate first:                                                                       │
-- │   python3 scripts/gate_runner.py --migration migrations/v5-invrefstrand-001 --env <env>       │
-- │     --phase pre                                                                               │
-- │ It must read 0 rows (it did on both envs on 2026-09-24). Any row it finds is a strand this    │
-- │ file would make visible, and gate-invariants.yml goes RED on its next run until it is         │
-- │ resolved — RESTORE the parent (clear its deleted_at) when the reference is real history, or   │
-- │ re-point it at the right live item. Never answer a strand by clearing a planting's seed       │
-- │ source: that destroys the provenance the guard exists to protect. Those are Dave's calls.     │
-- └──────────────────────────────────────────────────────────────────────────────────────────────┘
--
-- REVERSIBLE: 0r-rollback.sql deletes exactly this receipt, which disarms the gates back to vacuous.
-- No data is touched in either direction.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0a-arm-guard.sql

BEGIN;

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('5.0.0-invrefstrand-20260924',
        'INVREFSTRAND (option C): BUG-INVREFSTRAND-001 standing guard. Arms a post gate that detects '
        'a live planting (archived included) or a live treatment event pointing at a soft-deleted '
        'inventory_items row — the two references the app refuses a delete over, which the foreign '
        'keys cannot enforce because the app soft-deletes (UPDATE) and an FK guards DELETE. The item''s '
        'own photos, seed_lot_stage_log rows and seed_saved pointer follow it and are not counted. '
        'Plus a pg_constraint census in both directions so a fifth FK cannot silently escape '
        'classification and a dropped FK cannot silently disarm the census. Predicate is parent-side '
        '(i.deleted_at IS NOT NULL), NOT an anti-join: the runner connects as the RLS-exempt owner. '
        'Writes NO data.',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;

COMMIT;
