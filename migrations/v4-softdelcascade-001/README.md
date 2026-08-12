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

**RE-MEASURED 2026-08-12** in the pre-apply audit. The authored figures were taken some days earlier
and the tables have grown; both columns are shown because the *drift itself* is the point — these
numbers are a moving population, so re-measure at apply time rather than citing either column.

| Measure | At authoring | **Live prod 2026-08-12** |
|---|---|---|
| `event_log` rows carrying a `project_id` | 12,447 — "100.0% of the table" | **14,193 of 14,195 — 99.99%** |
| …by owner | 12,393 / 36 / 18 (3 subs) | **14,158 / 35 (2 subs)** |
| `photos` carrying a `project_id` | 976 | **1,104** |
| `photos` carrying an `event_id` | 742 | **868** |
| `photos` total | 1,094 | **1,253** |
| Containers with events | 76 | **74** |
| …incidentally protected | 27 | **29** |
| **…wholly unprotected** | 49 | **45** |
| **Events one `DELETE` away from silent destruction** | 2,432 | **2,333** |
| Photos destroyed alongside them | 199 | **154** |

The "100.0% of the table" claim was true when written and is now marginally false (2 of 14,195 rows
carry a `plant_id` but no `project_id`). The conclusion is unchanged: this axis is the whole event
log, not a corner of it. **No live row makes `RESTRICT` fail** — all three FKs are already
`convalidated = t`, so `0c`'s validation scan is guaranteed to succeed (see gates.yml §VACUITY NOTE).

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

> **RE-RUN AND WIDENED 2026-08-12 (pre-apply audit). The verdict below is confirmed, but the original
> method had two blind spots and both had to be closed before it could be trusted.**
>
> **Blind spot 1 — it covered 5 Lambdas out of 26.** `deploy-lambda` ships all 26 in one matrix, so
> five bundles are not "the deployed artifact". All **27 prod (non-`-staging`) functions** were
> re-downloaded and grepped. Result: the only real `DELETE FROM` statements anywhere in deployed prod
> code are `DELETE FROM favorites` (`garden-favorites/index.js:99`, unrelated) and
> `DELETE FROM public.entity_memory` (`garden-plants/index.js:664` — a *child* row delete, which no
> parent-side `RESTRICT` can block). Everything else that matched is a comment, a test assertion
> string, or a `method === 'DELETE'` HTTP branch that soft-deletes. **Verdict unchanged.**
>
> **Blind spot 2 — grepping Lambdas is structurally blind to IN-DATABASE writers, and there is one.**
> `archive_plant_events()`, shipped into the database by `BUG-EVTANCHORDEL-001`, genuinely executes
> `DELETE FROM public.event_log`. It is a deployed writer that no bundle grep can ever see. Under
> flip 3 that delete is refused with `23503` for any event still carrying a photo.
>
> **It survives — but only by an ordering property that was undocumented and ungated.** The live
> function body (read from `pg_get_functiondef`, not from a migration file) detaches photos with
> `UPDATE public.photos SET event_id = NULL …` **before** it deletes the events, and that detach is
> unconditional over every photo pointing at a dying event. So at `DELETE` time no photo references
> those events and `RESTRICT` has nothing to refuse. Verified positionally on live prod: detach at
> `prosrc` offset 2262, delete at 3022.
>
> A future edit reordering those two statements — or narrowing the detach predicate — would break
> **both** archive functions against their own new constraint, and nothing in this migration would
> have noticed. That hole is now closed by a new gate,
> `post_archive_functions_detach_photos_before_deleting_events`, which asserts the ordering for both
> functions and is mutation-tested (reversed order → fail, detach removed → fail).
>
> A full catalog sweep confirms `archive_plant_events` is the **only** routine in any non-system
> schema that deletes from `event_log`/`photos`/`plant_projects`/`harvest_log`, and that there is no
> `BEFORE DELETE` trigger on any of the three tables that could interfere.

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

## Pre-apply audit, 2026-08-12 — what changed in this directory

The migration was authored and never applied. This audit re-derived every claim from live prod
(`information_schema` / `pg_constraint` / `pg_proc`, never from migration files) and found **one
migration-blocking defect in the gates**, plus several gates that passed for the wrong reason.
Nothing was executed; no DDL was run.

**Live prod state, re-verified.** All three FKs are still `ON DELETE CASCADE`
(`confdeltype = 'c'`): `event_log_project_id_fkey`, `photos_project_id_fkey`, `photos_event_id_fkey`.
`archive_container_events()` does **not** exist (only `archive_plant_events()` does). Both archive
tables are still 0 rows. The defect and the premise are intact.

**BLOCKER, now fixed — `post_no_cascade_fk_out_of_a_user_history_table` would have failed on a
successful apply.** The gate asserts no `CASCADE` FK out of `event_log`/`photos`/`harvest_log`/
`preservation_log`, but `photos_inventory_item_id_fkey` (`photos.inventory_item_id ->
inventory_items(id) ON DELETE CASCADE`) is exactly that and is **not** one of the three FKs this
migration flips. Because the gate is guarded on its own `schema_version` row, it passed vacuously
before apply and would have flipped to FAIL the instant `0c` succeeded — the migration would apply
cleanly and then red its own post phase. Simulated against live prod: 1 row returned, expected 0.
Fixed with an exact-`conname` carve-out (not by widening the table list), so the gate still catches
any newly-introduced cascade and any regression of the three it owns.

**Gates that passed for the wrong reason** (all kept, all now carrying a `note` saying so, so a PASS
is not mistaken for coverage):

- `post_no_parentless_photos_introduced` — **vacuous**. `photos_must_have_parent` is
  `convalidated = t` and this query is its exact negation across all seven arms, so Postgres makes a
  matching row impossible to store. It reports constraint enforcement, not migration correctness.
- `sweep_capture_unprotected_containers`, `sweep_capture_photos_with_a_single_dying_parent` —
  **cannot fail by construction** (`rowcount_gte: 0` admits every result). Informational captures,
  not assertions. The second carried no note at all and read like a real guard.
- `sweep_no_dangling_*` (three gates) — belt-and-braces. All three FKs are already
  `convalidated = t`, which is catalog-level proof no dangling row exists; `0c` keeps the same
  columns and parent and changes only the referential action, so the validation scan cannot fail for
  a reason these would catch.

**A gate that is real, for an undocumented reason.** `post_no_anchorless_events_introduced` is
genuinely non-vacuous: `event_log_has_anchor` is `convalidated = f` (**NOT VALIDATED**), so the
pre-existing population was never scanned and the database does *not* guarantee that predicate.
Its apparent twin above is vacuous for precisely the opposite reason. Both are now annotated.

**New gate.** `post_archive_functions_detach_photos_before_deleting_events` — see §The falsifiable
test. It covers the one property that actually keeps the in-database writers compatible with flip 3,
and which nothing gated before.

**RLS trap, recorded so it costs nobody else an hour.** `event_log`, `photos` and `plant_projects`
all have `relrowsecurity = t`. Run the dangling-ref sweeps as an RLS-subject role (`garden_ro`, via
`scripts/psql-ro.sh`) and they report 1 and 2 dangling rows — pure visibility artifacts, since parent
rows are filtered from that role while child rows are not. `gate_runner` connects with
`NEON_DATABASE_URL` (owner, RLS-exempt, `conn.read_only = True`) and gets the true answer.

**Gate runs against live prod, this audit:** `pre` **6/6 PASS**, `sweep` **6/6 PASS**, `post`
**15/16** — the single failure being `post_schema_version_recorded` (expected `2`, got `0`), which is
the correct and expected reading for a migration that has not been applied.

Gate count is now **28** (was 27). Unrelated pre-existing defect noticed in passing and **not**
touched, as it belongs to another item: `migrations/v4-harvwatch-001/gates.yml` has an unknown
top-level key `rollback`, so it fails `--validate-only` schema loading and its gates are **not
skipped but unreadable** — that file's gates do not run at all today.

## Not closed here

- **`photos_inventory_item_id_fkey` is `ON DELETE CASCADE`** — found during this audit. A hard
  `DELETE FROM inventory_items` destroys every photo of that item with no archive: the same defect
  class as this ticket, on a different parent axis. Deliberately not folded in — it needs its own
  deployed-writer test, and it is latent and small: the deployed `garden-inventory-items` Lambda
  soft-deletes (`UPDATE inventory_items SET deleted_at = NOW()`, verified in the live bundle) and only
  **6** prod photos carry an `inventory_item_id`. Carved out of the post gate by name, with rationale.
  Worth its own ticket.

- **`plants.project_id` / `tasks.project_id` / `plant_projects.parent_project_id` are `ON DELETE SET
  NULL`.** A hard container delete silently re-homes child plantings into the project-less ownership
  arm, handing each to its own `created_by`. Flagged in-code at `lambda/plants/index.js:378`. This is
  an **authorization** defect, not a history-destruction one, and
  `tests/integration/plants.int.test.js:60` and `cal1-indep.int.test.js:130` currently **depend** on
  that `SET NULL` — flipping it without fixing them first reds CI. Separate ticket.
- `entity_memory.project_id`, `container_closure.*`, `inactive_project_dismissals.project_id` remain
  `CASCADE` **by design** — derived caches and closure rows, rebuilt from live data.
