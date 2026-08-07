# v4-carekey-001 — Care re-key Phase D (code) + Phase E (VALIDATE)

Care spine re-key, `entity_memory.project_id` → `entity_memory.plant_id`. Design:
`~/AI/Claude/Projects/Gardening/care-rekey-plantid-design-V100-20260723.md` (V100).

This directory is **Phase E** — the L-058 all-row sweep plus the one remaining `VALIDATE`. It
continues `migrations/care-rekey-001/`, which holds Phase A (additive DDL) and Phase C (backfill),
both applied to staging + prod 2026-07-24. **Phase D is code-only and carries no DDL**, so it has no
files here; its deploy precondition is stated below because Phase D and Phase E ship in the same
change.

## Design phase → what shipped

| Design phase | Where it lives | State |
|---|---|---|
| A · additive DDL | `migrations/care-rekey-001/0a-additive-ddl.sql` | APPLIED staging + prod 2026-07-24 |
| B · dual-write code | `lambda/events/index.js`, `lambda/plants/index.js` | DEPLOYED — `main` = `ed6cc2b` carries it |
| C · backfill | `migrations/care-rekey-001/0b-backfill.sql` | APPLIED staging + prod 2026-07-24 |
| **D · cutover reads** | `lambda/dashboard/handlers.js`, `lambda/plants/index.js`, `lambda/projects/index.js` | **THIS CHANGE — authored, not deployed** |
| **E · sweep + VALIDATE** | **`0a-validate.sql` + `gates.yml` here** | **THIS CHANGE — authored, NOT applied** |
| F · destructive (F1/F2/F3) | not authored | **DAVE-GATED. Deliberately out of scope.** |

## Scope is one constraint

Design §3-E says "VALIDATE the `NOT VALID` constraints", plural. Live prod
`pg_constraint.convalidated` says there is exactly one, because Phase A added the FK and the CHECK
without `NOT VALID` and Postgres validated them at `ADD` time:

| constraint | convalidated |
|---|---|
| `entity_memory_plant_id_fkey` | `t` |
| `entity_memory_exactly_one_parent` | `t` |
| `event_log_has_anchor` | **`f`** ← this file |

Live schema wins over the design text and over the migration tree (migrations lag manual `ALTER`s in
this project).

## Apply order, and the precondition on the DEPLOYED artifact before each step

Stated as artifact properties. **No step is gated on a date.**

1. **Phase D code deploy** (dashboard / plants / projects Lambdas).
   *Precondition:* the target database has `entity_memory.plant_id`, the partial unique index
   `entity_memory_plant_id_key`, and at least one plant-keyed row — i.e. Phase A + C applied. Both
   are already true of staging and prod. Verify with `--phase pre` below, which asserts exactly this.
   *Why this direction:* the read cutover is backward-compatible and forward-DEPENDENT. Rolling it
   BACK is safe at any time, because the deployed Step-B writer still dual-writes project-keyed rows
   and they are still current. Rolling it FORWARD onto a database without Phase A/C would blank every
   care tile.
2. **Phase E `0a-validate.sql`.**
   *Precondition:* the deployed events Lambda cannot write an anchorless `event_log` row. Satisfied
   by any artifact containing `validatePostBody`'s `project_id or plant_id is required` branch
   (BUG-CAPTUREFLOW400-001), which `main` = `ed6cc2b` does. The full falsifiable-test answer is in
   `gates.yml`.
   *Coupling:* none. `VALIDATE` rejects no operation the deployed code performs, so this may be
   applied before or after step 1. It is listed second only because there is no reason to arm a
   constraint before the change that motivated it is out.

Per environment: `--phase pre` → apply `0a-validate.sql` → `--phase post`. Run `--phase sweep` before
the apply. Staging first, then prod.

```
python3 scripts/gate_runner.py --migration migrations/v4-carekey-001 --env staging --phase pre
python3 scripts/gate_runner.py --migration migrations/v4-carekey-001 --env staging --phase sweep
psql "$NEON_STAGING_URL" -v ON_ERROR_STOP=1 -f migrations/v4-carekey-001/0a-validate.sql
python3 scripts/gate_runner.py --migration migrations/v4-carekey-001 --env staging --phase post
```

then the same four against `--env prod` / `$NEON_DATABASE_URL`.

## Reversibility

`VALIDATE` is reversible without data loss and without a restore:

```sql
ALTER TABLE public.event_log DROP CONSTRAINT event_log_has_anchor;
ALTER TABLE public.event_log ADD CONSTRAINT event_log_has_anchor
  CHECK (plant_id IS NOT NULL OR project_id IS NOT NULL) NOT VALID;
DELETE FROM public.schema_version WHERE version = '4.23.2-carekey-001-validate';
```

Phase D reverses by reverting the deploy. Nothing in this change is restore-only; **the only
restore-only step in the whole re-key is F3**, which is Dave-gated and not authored.

## What is deliberately NOT here

- **Phase F (all three sub-steps).** F1 stops project-keyed writes, F2 drops
  `entity_memory_project_id_key`, F3 `DELETE`s the project rows and `DROP`s the column. F3's rollback
  is a Neon branch/PITR restore, not a revert. `gates.yml` carries
  `post_project_arm_survives_phase_f_is_not_run` (marked `continuous: false`) so the absence is
  asserted rather than assumed, and so the scheduled invariant sweep does not go permanently red the
  day F actually lands.
- **A repair of the 6 drifted care rows.** Captured informationally by
  `sweep_capture_care_cache_drift_vs_event_log`, with both root causes documented there. Two
  separate pre-existing defects; neither is caused or repaired by this migration.
- **Blast-radius item B5** — the dashboard water bar drops a projectless planting. The server half is
  done (`plant_name` is now emitted); the client half is not this agent's to write. Marked in
  `lambda/dashboard/handlers.js` at the predicate that drops it.

## Verification performed

- Every `pre` (5/5) and `sweep` (8/8) gate **run green against live prod**, read-only, at authoring
  time.
- `python3 scripts/gate_runner.py --all --env prod --validate-only` → 42 files, 549 gates, schema-valid.
- Every rewritten Phase-D query was `EXPLAIN`ed against live prod inside `SET TRANSACTION READ ONLY`.
- Phase-D behaviour is pinned by `lambda/dashboard/care-rekey-reads.test.js`,
  `lambda/plants/care-rekey-byid.test.js`, `lambda/projects/care-rekey-activity.test.js`, and the
  widened `BUG-SOFTDELREAD-001` guards in `lambda/dashboard/softdel-feed.test.js`. Every assertion
  names the source mutation that turns it red, and each mutation was run.
- **Nothing has been applied.** No DDL has been executed against staging or prod.
