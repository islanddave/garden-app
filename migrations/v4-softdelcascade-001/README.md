# V4-SOFTDELCASCADE-001 — close the container delete axis

Finishes the job `BUG-EVTANCHORDEL-001` started. That ticket hardened the **planting** delete axis
(`event_log.plant_id`, `photos.plant_id`, `photos.location_id` → `ON DELETE RESTRICT`, live in prod).
The **container** axis immediately beside it was left on `CASCADE`.

**Nothing in this directory has been applied.** Authored, parse-verified and gate-validated only.

---

## The defect, as read from live prod `pg_constraint`

```
event_log_project_id_fkey  FOREIGN KEY (project_id) REFERENCES plant_projects(id) ON DELETE CASCADE
photos_project_id_fkey     FOREIGN KEY (project_id) REFERENCES plant_projects(id) ON DELETE CASCADE
photos_event_id_fkey       FOREIGN KEY (event_id)   REFERENCES event_log(id)      ON DELETE CASCADE
```

One statement — `DELETE FROM plant_projects WHERE id = '…'` — silently deletes every `event_log` row
anchored to that container, and that deletion **cascades a second hop** through
`photos_event_id_fkey` into those events' photos. No error, no warning, no recovery.

`photos_event_id_fkey` is not merely risky, it **contradicts every other layer of the system**: the
single-event undo, the batch undo and `archive_plant_events()` all deliberately *detach and
re-parent* a photo, each with a fail-loud guard against leaving it parentless. The FK quietly does
the opposite.

### Blast radius (live prod, read-only, FULL tables — no `deleted_at` filter)

| Measure | Value |
|---|---|
| `event_log` rows carrying a `project_id` | **12,447 — 100.0% of the table** |
| …by owner (3 subs) | 12,393 / 36 / 18 |
| `photos` carrying a `project_id` | 976 |
| `photos` carrying an `event_id` | 742 |
| Containers with events | 76 |
| …incidentally protected | 27 |
| **…wholly unprotected** | **49** |
| **Events one `DELETE` away from silent destruction** | **2,432** |
| Photos destroyed alongside them | 199 |

The 27 "protected" containers are protected only as a **side effect** of unrelated tickets — a
`harvest_log` row (`project_id` or `event_id`, both already `RESTRICT`) or a
`cultivar_weight_sample` (`NO ACTION`) happens to block the delete. That is not a policy.

**Not reachable from the app, which is exactly why it survived.** Every app `DELETE` route
soft-deletes (`lambda/projects/index.js:637`). It is reachable from admin SQL, backfill scripts and
test teardown — the same caller set that made EVTANCHORDEL real.

---

## The falsifiable test, answered

> Would the **currently deployed prod code** perform an operation that this `RESTRICT` would now
> reject?

Asked of the deployed artifact, not of the branch in hand. The live Lambda bundles were downloaded
(`aws lambda get-function --query Code.Location`) for `garden-projects`, `garden-events`,
`garden-plants`, `garden-photos`, `garden-harvests` and grepped for `DELETE FROM`.

The only `DELETE FROM` in the deployed bundles are `DELETE FROM favorites` (unrelated), a source
**comment** at `garden-plants/index.js:378` that predicts this very ticket, and an assertion
**string** inside `garden-events/undo-route.test.js` that exists to forbid the thing.

| Flip | Deployed writer affected? |
|---|---|
| `event_log.project_id` → RESTRICT | **No** |
| `photos.project_id` → RESTRICT | **No** |
| `photos.event_id` → RESTRICT | **No** |

`0c` changes only the referential action taken on a parent `DELETE`; `INSERT` and `UPDATE` are
untouched, so no deployed writer's behaviour changes at all. **There is no writer coupling with the
deployed artifact, so this ships as ONE file — no pre-deploy/post-deploy split.**

`0a`'s `has_provenance` CHECK gets the same test in its in-database form: its only pre-existing
writer is `archive_plant_events()`, which always supplies `archived_plant_id`, and both archive
tables are empty in prod and staging. Arming it cannot reject anything.

### The writers that *do* break are non-app and CI-only

1. **`.github/workflows/deploy-staging.yml` smoke purge** — deletes `event_log` (lines 560, 562)
   **before** `photos` (line 569), and the photos sweep covers `plant_id`/`location_id`/`project_id`
   but **not `event_id`**. Under flip 3, a smoke photo hanging off a smoke event refuses the event
   delete and `ON_ERROR_STOP=1` reds the deploy. **0-row no-op against staging today** (verified
   live: zero smoke photos carry an `event_id`, zero smoke residue rows) — latent, not firing.
2. **`tests/integration/**` teardowns** — audited file by file against all three flips. **None breaks
   today.** Three are green by property rather than by construction (below).

---

## Required companion edits — NOT made here

These are edits to existing files, which this migration deliberately does not touch. They are
**preconditions**, not suggestions.

### Blocking (must land before staging apply)

**`.github/workflows/deploy-staging.yml`** — move the `photos` sweep (line 569) **above** the
`event_log` sweeps (lines 560, 562), and widen it to cover `event_id`:

```sql
DELETE FROM photos WHERE event_id IN (
  SELECT id FROM event_log WHERE project_id IN (
    SELECT id FROM plant_projects WHERE name ILIKE '%smoke%'));
```

Without this the purge is correct only while no smoke photo is attached to a smoke event.

### Defensive (recommended, same commit)

Three teardowns pass today only because of a property that could change silently. Each is one line:

- `tests/integration/plants.int.test.js` — clears `event_log` by `plant_id` only. Add before line 60:
  `DELETE FROM event_log WHERE project_id IN (SELECT id FROM plant_projects WHERE created_by IN (${USER}, ${FOREIGN_USER}))`
- `tests/integration/authz-matrix.int.test.js` — safe only because the matrix's `write` body never
  sends `status`. Add the equivalent before line 56.
- `tests/integration/preservation-authz.int.test.js` — same shape, before line 81.

### Ordering note (load-bearing)

`.github/workflows/integration-test.yml` branches CI off **staging** and **applies no migrations**.
The moment `0c` lands on staging, every subsequent CI run gets `RESTRICT` — there is no separate
window in which to stage the test fixes. They must be in before, not after.

`tests/integration/evt-anchor-delete.int.test.js:213-219` already pins the *plant* axis to
`confdeltype = 'r'`. It does **not** cover these three, so there is no conflict — but extending that
`conname IN (…)` list is the natural companion, and its own comment sets the rule: **staging gets
the migration before the pinning test lands on dev**, or CI reds.

---

## Runbook — apply order and preconditions

Preconditions are stated as **properties of the artifact**, never as dates.

| # | Step | Precondition that must hold |
|---|---|---|
| 1 | `0a-additive-ddl.sql` → **staging** | `event_log_archive` + `harvest_log_archive` exist and `archive_plant_events()` is present (EVTANCHORDEL applied). Both archive tables empty. Purely additive — safe at any time, independent of any deploy. |
| 2 | Companion edits merged to `dev` | The deployed-staging workflow's photos sweep precedes its event_log sweeps and covers `event_id`. |
| 3 | `0c-constraint.sql` → **staging** | Step 2's workflow is the one that will run next. Gates `pre` + `sweep` green against staging. |
| 4 | Soak: one full staging deploy + smoke, one full CI integration run | Both green **with the new constraints already live on staging** — this is the real test of the teardowns, and it is the step that substitutes for an ephemeral-branch dry run. |
| 5 | `0a-additive-ddl.sql` → **prod** | Same as step 1, against prod. Additive; needs no deploy coordination. |
| 6 | `0c-constraint.sql` → **prod** | The deployed prod artifact contains no hard `DELETE FROM` against `plant_projects`, `event_log`, `photos` or `harvest_log` — re-verify against the bundles at the then-current prod SHA, exactly as §The falsifiable test did. Gates `pre` + `sweep` green against prod. |
| 7 | Gates `post` → prod | All green. |

`0a` before `0c` in both environments, always: `0c`'s `RESTRICT` is only operable if the escape hatch
exists. Applying `0c` first leaves an operator with a blocked delete and no supported way through.

**Rollback:** `0r-rollback.sql`, two independent halves, reverse order. Part 1 (the FK reversal) is
lossless and unconditional — but it **re-arms the defect**, so treat the window as one in which no
hard container delete may run. Part 2 is guarded and non-destructive: per the Soft-Delete-Only rule
it drops no column and no data, leaves `archived_project_id` in place, does not drop the shared cold
store (that belongs to EVTANCHORDEL's own `0r`), and refuses to restore the `NOT NULL` while any
container-archived row exists.

---

## The escape hatch

`archive_container_events(container_id, reason)` — sibling of `archive_plant_events()`, modelled on
it directly and reusing its cold store rather than inventing a parallel one.

- Full `to_jsonb(row)` of every archived row, so the archive cannot drift as `event_log` gains
  columns.
- Photos are **detached, never deleted**, re-parented by `COALESCE` from the dying event's
  `plant_id`/`location_id` — deliberately **not** its `project_id`, since that project is the
  container being deleted.
- **Raises, never guesses**, on: immutable `cultivar_weight_sample` calibration evidence; a
  `harvest_log` row whose event belongs to a different container; and any photo the detach would
  leave parentless.

It cannot early-return the way `archive_plant_events()` does: a container has **two** independent
`RESTRICT` axes after `0c` (`event_log.project_id` *and* `photos.project_id`), so a container with
zero events but one project-anchored photo still blocks the delete.

---

## Verification performed (nothing applied, nothing written)

- **Gate schema** — `python3 scripts/gate_runner.py --all --env prod --validate-only` → exit **0**,
  41 files / 527 gates.
- **SQL parse** — each file run against live prod in a session with
  `SET default_transaction_read_only = on`. Every write statement refused by the server with
  `25006 read_only_sql_transaction`; **zero** syntax or undefined-object errors. (`0a`: 4 ALTER, 2
  CREATE INDEX, 3 COMMENT, 1 CREATE FUNCTION, 1 INSERT. `0c`: 3 ALTER, 1 INSERT. `0r`: 7 ALTER,
  1 DROP FUNCTION, 2 DELETE.)
- **plpgsql body compiled and exercised** — `CREATE FUNCTION` is refused *before* the validator runs,
  so the body was extracted into a `DO` block and run against live prod in the same read-only
  session. It compiled, executed all three guards against real data, and:
  - on container `88513b10-…`, **Guard 3 fired correctly**, naming a real photo whose only parent is
    that container;
  - on a clean container, it reached the photo-detach `UPDATE` at body line 85 and the **server**
    refused it (`25006`).
- **Prod confirmed untouched afterwards** — all three FKs still `CASCADE`, archives still 0/0,
  `archive_container_events` not created, `event_log` 12,447 rows, `photos` 1,094 rows.

No gate is marked `continuous: true`. `gate-invariants.yml` runs `--phase post --continuous-only`
against live prod and staging on a schedule; marking the "constraint is armed" gates continuous
before apply would report a standing failure for a migration that has not run. Zero gates repo-wide
use the flag today. Promoting the durable invariants after prod apply is a deliberate follow-up.

---

## Not closed here

- **`plants.project_id` / `tasks.project_id` / `plant_projects.parent_project_id` are `ON DELETE SET
  NULL`.** A hard container delete silently re-homes child plantings into the project-less ownership
  arm, handing each to its own `created_by`. Flagged in-code at `lambda/plants/index.js:378`. This is
  an **authorization** defect, not a history-destruction one, and
  `tests/integration/plants.int.test.js:60` and `cal1-indep.int.test.js:130` currently **depend** on
  that `SET NULL` — flipping it without fixing them first reds CI. Separate ticket.
- `entity_memory.project_id`, `container_closure.*`, `inactive_project_dismissals.project_id` remain
  `CASCADE` **by design** — derived caches and closure rows, rebuilt from live data.
