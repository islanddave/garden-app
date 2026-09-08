-- 0a-arm-guard.sql
-- BUG-INVREFSTRAND-001 — arm the standing inventory-reference guard.
--
-- ┌─ THE DEFECT ─────────────────────────────────────────────────────────────────────────────────┐
-- │ Four foreign keys point at inventory_items, two of them ON DELETE RESTRICT. NONE of them can  │
-- │ fire, because the app never hard-deletes: lambda/inventory-items/index.js implements DELETE   │
-- │ as `UPDATE inventory_items SET deleted_at = NOW()`, and a foreign key guards DELETEs, not     │
-- │ UPDATEs. The parent survives, its children keep technically-valid pointers, and every read    │
-- │ path filters `deleted_at IS NULL` — so the reference stops resolving with no error and a 200. │
-- │                                                                                               │
-- │ Concretely: /seed-stage returns HTTP 200 + [] for a lot whose parent was deleted, which is    │
-- │ indistinguishable from "this lot has no history"; and a planting keeps a                      │
-- │ source_inventory_item_id that resolves to nothing, breaking seed -> plant provenance quietly. │
-- └──────────────────────────────────────────────────────────────────────────────────────────────┘
--
-- THIS FILE WRITES NO DATA. It inserts one schema_version row and nothing else. That row is the
-- ARMING SWITCH: every standing gate in gates.yml carries
--     AND EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-invrefstrand-20260908')
-- so the guard is vacuously green until this runs and a real invariant forever after. Self-arming is
-- mandatory, not stylistic: gate-invariants.yml fires on any migrations/** push and would red the
-- job the moment these gates landed if they asserted before being applied (gate-invariants.yml:166-171).
--
-- ┌─ READ BEFORE APPLYING ───────────────────────────────────────────────────────────────────────┐
-- │ APPLYING THIS MAKES TWO EXISTING FINDINGS VISIBLE. Measured on live prod 2026-09-08 through   │
-- │ gate_runner against the owner DSN:                                                            │
-- │                                                                                               │
-- │   plants 7ca159f5-3dc5-4d3e-9f5b-c6676ecd454c  "Hungarian" (Black Hungarian), status failed,  │
-- │       archived 2026-07-20  ->  inventory_items 5ea890a3-b0f0-44ae-ae36-cd1cbfb15ded           │
-- │   seed_lot_stage_log 4bb986e7-c977-4b85-9884-3a92724ca820  stage 'fermenting',                │
-- │       entered 2026-09-07 12:23  ->  inventory_items 4074e59e-c9be-4762-af59-c28ebd9c73d6      │
-- │                                                                                               │
-- │ The second one is the documented cost happening in production: that lot's stage history is    │
-- │ already answering 200 with an empty array.                                                    │
-- │                                                                                               │
-- │ That is the point of the guard, not a bug in it — but it means gate-invariants.yml goes RED   │
-- │ on the next run after apply unless each is resolved first. Two ways, and BOTH are Dave's      │
-- │ call, not this migration's:                                                                   │
-- │                                                                                               │
-- │   RESTORE   the parent was deleted by mistake and the reference is the evidence of it ->      │
-- │             clear its deleted_at. The child resolves again and the row comes back to the      │
-- │             drawer, quantity and all. Prefer this when the child is real history.             │
-- │   DETACH    the parent was correctly deleted and the child should not have pointed at it ->   │
-- │             NULL the pointer (plants: the PUT already supports it via its `clear` array), or  │
-- │             delete the child row if it is itself an artifact.                                 │
-- │                                                                                               │
-- │ Nothing is decided here. A migration that guessed would be making a data decision under cover │
-- │ of a schema change — and one of the two candidates is a fermenting seed lot.                  │
-- └──────────────────────────────────────────────────────────────────────────────────────────────┘
--
-- PREVENTION IS ELSEWHERE AND ALREADY LANDED. lambda/inventory-items/delete-guard.js adds a
-- pre-delete reference count to the DELETE arm, so the app now answers 409 naming what is in the
-- way instead of stranding it. This migration is the DETECTOR: it covers hand-written SQL, the two
-- findings that predate the handler change, and any future write path that forgets.
--
-- REVERSIBLE: 0r-rollback.sql deletes exactly this receipt, which disarms the gates back to vacuous.
-- No data is touched in either direction.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0a-arm-guard.sql

BEGIN;

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('5.0.0-invrefstrand-20260908',
        'INVREFSTRAND: BUG-INVREFSTRAND-001 standing guard. Arms three post gates that detect live '
        'rows pointing at a soft-deleted inventory_items row — the strand the four foreign keys '
        'cannot prevent, because the app soft-deletes (UPDATE) and an FK guards DELETE. Covers '
        'plants.source_inventory_item_id, photos.inventory_item_id, '
        'seed_lot_stage_log.inventory_item_id and event_log.treatment_product_id, plus a '
        'pg_constraint census in both directions so a fifth FK cannot silently escape the guard and '
        'a dropped FK cannot silently disarm the census. Predicate is parent-side '
        '(i.deleted_at IS NOT NULL), NOT an anti-join: the runner connects as the RLS-exempt owner, '
        'for whom the parent is visible and an anti-join reads zero forever. Writes NO data. Two '
        'findings are live on prod at arming time — see the header of this file.',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;

COMMIT;
