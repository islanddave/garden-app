# care-rekey-001 — Phase A additive DDL + backfill

Care re-key (`project_id` → `plant_id`) for `entity_memory`. Design: `../../../care-rekey-plantid-design-V100-20260723.md`. This is **Phase A (additive DDL) + Phase C (backfill) SQL only** — the first, reversible, non-cutover step. Dual-write, read-cutover, and the destructive column drop are later, separately-gated phases.

## ⚠ Gating

Applying either file to **live Neon is Dave-gated**. Nothing in CI/CD auto-applies `migrations/**` — `schema-audit.yml` only *reads* prod to check lambda column refs. Landing these files on `dev` changes **zero** runtime behavior (no code reads `plant_id` yet).

## Apply order (per environment: staging first, then prod)

1. **`0a-additive-ddl.sql`** — additive column + partial-unique index + relaxed constraints.
   - The `CREATE UNIQUE INDEX CONCURRENTLY` statement **must run outside a transaction block**. If your client wraps the file in one transaction, run that statement separately.
2. **`0b-backfill.sql`** — reconstruct per-planting rows from `event_log`. Idempotent; re-run to sweep the gap window. **Run + row-count-verify on a prod-cloned Neon branch first.**

## What it does / does not do

- **Does:** adds `entity_memory.plant_id` (FK→`plants`, `ON DELETE RESTRICT`), a partial unique index (one care row per planting), evolves `entity_memory_exactly_one_parent` 2-way→3-way (plant XOR project XOR location), makes `event_log.project_id` + `harvest_log.project_id` nullable, and adds `event_log_has_anchor` (`NOT VALID`).
- **Does NOT:** change any read path, dual-write, drop `project_id`, or validate `event_log_has_anchor` (a later phase VALIDATEs after a full-row sweep).

## Reversibility

Fully reversible while no plant-keyed rows are relied upon:
- `DELETE FROM entity_memory WHERE plant_id IS NOT NULL;` (undo backfill)
- `DROP INDEX CONCURRENTLY entity_memory_plant_id_key;`
- restore the 2-way `entity_memory_exactly_one_parent`; `DROP CONSTRAINT entity_memory_plant_id_fkey; ALTER TABLE entity_memory DROP COLUMN plant_id;`
- `ALTER TABLE event_log ADD ... `/`DROP CONSTRAINT event_log_has_anchor;` re-add NOT NULLs (safe — no null rows exist yet).

## Verification

`../../tests/integration/care-rekey-backfill.int.test.js` proves the **backfill reconstruction is per-plant correct** (two plantings in one project get independent cadences; project-only events don't leak into a plant row) against the real ephemeral Neon branch — WITHOUT applying the schema DDL to the shared branch (the suite shares one branch; no test mutates schema). The live schema DDL is proven when Dave applies `0a` to a prod-cloned branch and runs the full backfill row-count sweep (Phase E).
