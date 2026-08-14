# v4-archrestore-001 — the cold store learns how to give things back

Closes **`OPS-ARCHRESTORE-001`**. Two halves, one migration, **archive side first**.

## What was wrong

The ticket reads *"`event_log_archive` / `harvest_log_archive` preserve a full `row_data` jsonb
snapshot but nothing reconstitutes it"*. That is true, and it is not the interesting half.

Both archive routines **detach photos before deleting the events**:

```sql
-- archive_plant_events
UPDATE public.photos ph
   SET event_id    = NULL,                                    -- <- destroyed
       project_id  = COALESCE(ph.project_id,  e.project_id),  -- <- COALESCEd forward
       location_id = COALESCE(ph.location_id, e.location_id)
```

The severed `photos.event_id` was written **nowhere**. Not into `row_data` — that is `to_jsonb()`
over the **event** row, not the photos. Not into the archive tables. `archive_container_events()`
is worse: it also clears `project_id` and moves `plant_id` / `location_id`.

So an un-archive routine built alone would have shipped a **"restore" that silently returns less
than it took** — the exact class the soft-delete audit's own §5 keeps naming: *a guarantee that is
vacuous in the direction nobody measured.*

## Measured — live prod, 2026-08-13 (owner DSN, exact)

| Fact | Value |
|---|---|
| `event_log_archive` rows | **0** |
| `harvest_log_archive` rows | **0** |
| Deployed callers of either archive routine | **0** — operator-invoked escape hatches |
| Live `prosrc` vs `v4-archpreservguard-001/0c-guard.sql` | **byte-for-byte identical** |
| `event_log` triggers | `prevent_ownership_transfer`, `set_updated_at` — both `tgtype = 19` (ROW\|BEFORE\|**UPDATE only**) |
| `harvest_log` triggers | none |

**Nothing has ever been archived in prod.** That is what makes fixing the archive side free *now*:
no backfill is owed, no historical detach is lost by this ordering, and no existing archive row
acquires a fingerprint it did not earn. It gets strictly more expensive after the first invocation.

The trigger measurement matters: because both `event_log` triggers are **BEFORE UPDATE only**, a
reconstitution `INSERT` restoring the original `created_by` is *not* blocked by
`prevent_ownership_transfer`, and `updated_at` survives verbatim from `row_data`. Confirmed from
`pg_trigger.tgtype` rather than assumed, and pinned by a test.

## Half 1 — archiving is now lossless

`0c` `CREATE OR REPLACE`s both archive routines. **The detach `UPDATE` is unchanged term for term.**
It is now one CTE of a single statement that also records each photo's pre-detach parent set.

**Why a pre-image CTE and not `RETURNING`.** `RETURNING` yields the **new** row, and the detach's
`COALESCE`-forward is not invertible from the new state: a `project_id` the photo *gained* from its
event is indistinguishable from one it already carried. `pre` and `detached` are CTEs of one
statement and therefore share one snapshot, so `pre` reads the pre-`UPDATE` values. The inner join
makes the captured set provably identical to the detached set.

**The only diff in each body is that block.** Proven, not asserted: the two function definitions
were extracted from this file and from `v4-archpreservguard-001/0c-guard.sql` and diffed — the
hunks are confined to the detach statement, and every guard, every `RAISE ... USING` message,
`DETAIL` and `HINT`, both `DELETE ... RETURNING` → `INSERT` archive moves, the
harvest-before-events ordering and both `RETURN QUERY` shapes are byte-identical. `0r` restores
both bodies to an **md5 match with live prod**.

### The design call: a TABLE, not a column on `event_log_archive`

The recon suggested `detached_photo_ids uuid[]` or `photo_links jsonb` as a **column**. That was
re-derived and **rejected — it cannot hold the whole detach set**:

1. `archive_container_events()` detaches on the **project axis** (`ph.project_id = p_container_id`)
   for photos that have **no event in the batch**. Those photos have no `event_log_archive` row to
   hang a column off. `v4-softdelcascade-001`'s own informational capture counted **12 such photos
   in live prod on 2026-08-12** — a populated case, not a theoretical one.
2. An **event-less container** archives **zero rows** while still detaching its project-axis photos.
   A per-archive-row column has literally nowhere to write.

A column would have reproduced this ticket's own defect one level down. `photo_detach_archive`
carries the **same provenance keys** (`archived_plant_id` / `archived_project_id`), the **same
`*_has_provenance` CHECK**, and the **same no-FK policy** as the two existing archive tables
(*"an FK would make the cold store refuse the very rows it exists to hold"*). It is a member of the
family, not a new concept. Both cases are pinned by tests, and case 2 was run green locally: **0
archive rows, 1 captured link, 1 relinked on restore.**

`jsonb` over `uuid[]` for the pre-image, per the recon's own reasoning: a `uuid[]` records *which*
photos moved but not *what* moved, so it cannot invert a `COALESCE`. `jsonb` records every axis and
absorbs a future photo-parent column without DDL.

### The fingerprint, and why it is not the drift test

`jsonb_populate_record()` is drift-**tolerant** by design — it ignores keys with no matching column
(forward drift) and defaults columns absent from the snapshot (backward drift). That tolerance is
what makes it the right primitive *and* what makes it dangerous.

`schema_fingerprint` (defaulting to `current_schema_fingerprint()` = newest `schema_version.version`)
is the **cheap trigger**: when it still matches, the snapshot provably predates no schema change and
the comparison is skipped. The **assertion** is `archive_row_data_drift()`, which names both
directions (`missing=[…]` / `unknown=[…]`). Added **without** a default and defaulted in a second
statement, so rows predating this migration keep an honest `NULL` rather than a version they were
not taken under; `NULL` is treated as *unknown* and runs the full comparison — fail-loud, not
fail-open.

## Half 2 — `unarchive_plant_events()` / `unarchive_container_events()`

Driven off `archived_plant_id` / `archived_project_id`, which is exactly why the `*_has_provenance`
CHECK exists. Both delegate to `unarchive_events_apply()` so the guard set and the reconstitution
order exist in **one** place.

**Seven guards, every one before the first write** — the same contract the archive routines make,
in the same house style (`RAISE ... USING ERRCODE/MESSAGE/DETAIL/HINT`, naming the blocking rows):

| # | Refuses when | Why |
|---|---|---|
| entry | the referent `plants` / `plant_projects` row is gone | `event_log.plant_id` / `.project_id` are RESTRICT — mandatory, not advisory |
| 1 | `row_data` is not a JSON object | `jsonb_populate_record` would insert an all-default fabricated row |
| 2 | the schema drifted since the snapshot | otherwise a column is silently defaulted |
| 3 | an id already exists live | **never `ON CONFLICT DO NOTHING`** — that reports a partial restore as a complete one |
| 4 | a RESTRICT-class parent in `row_data` no longer resolves | matches the FK's own action |
| 5 | an archived harvest's event is neither live nor in the batch | `harvest_log.event_id` is NOT NULL + RESTRICT |
| 6 | a captured photo is missing, or was re-parented onto a different owner | skipping would under-restore; overwriting would clobber a later edit |
| 7 | a photo parent named in a captured link is gone | all of `photos`' parent FKs are RESTRICT |

**Per-column FK treatment matches each column's own action**, so an un-archive can never leave a
state the constraints would have refused:

```
event_log.plant_id             -> plants          RESTRICT   => refuse
event_log.project_id           -> plant_projects  RESTRICT   => refuse
event_log.treatment_product_id -> inventory_items NO ACTION  => refuse
harvest_log.project_id         -> plant_projects  RESTRICT   => refuse
event_log.location_id          -> locations       SET NULL   => NULLED, not refused
```

`location_id` is the **only** column nulled: if the location has since gone, SET NULL is exactly
what the database would have done to a live row.

**Reconstitution order is the exact inverse of the archive order — `event_log` BEFORE
`harvest_log`** (`harvest_log.event_id` is RESTRICT), via
`jsonb_populate_record(NULL::public.event_log, row_data)`. `(record).*` expands in table column
order, so no column list is needed and nothing skews if a column is added.

**The photo relink is link RESTORATION, not a byte-for-byte revert.** A captured value is written
back only where the live column is still `NULL`, so an edit made after archiving is never clobbered
(Guard 6 has already refused the conflicting case). A parent the detach `COALESCE`d **forward** is
deliberately left in place — it is additive and semantically true, and reverting it is the one way
this routine could destroy information rather than restore it.

**Soft-Delete-Only.** The archive rows are hard-deleted, and that is a **move, not a delete**: every
row is inserted into its live table in the *same transaction* before its archive row is removed, so
nothing user-meaningful ceases to exist at any commit boundary. It is the exact inverse of the move
`archive_*` performs. Nothing here deletes a photo, a `preservation_log` row, or a calibration
sample.

## Whole-corpus gate risk — measured, not predicted

`v4-evtanchordel-001`, `v4-softdelcascade-001` and `v4-archpreservguard-001` all carry gates over
these functions, and this repo has shipped green-per-migration / red-on-corpus **twice in one day**.
So the prediction was replaced with a measurement.

The **whole 389-gate corpus** was run with `scripts/gate_runner.py` against two identical local
restores of the live prod schema (`pg_dump --schema-only` from prod, PostgreSQL 17.10 both ends),
one with this migration applied and one without.

> **Newly-failing gates: 0. Identical status on all 389.**
> (340 PASS / 38 FAIL / 9 MANUAL / 2 RETIRED in both. The 38 are schema-only-restore artifacts —
> `post_schema_version_recorded` receipts and seeded-data assertions — not caused by this change.)

The four that could plausibly have broken all **PASS** with this migration applied:

| Gate | Owner | Why it survives |
|---|---|---|
| `post_archive_functions_detach_photos_before_deleting_events` | `v4-softdelcascade-001` | positional over `prosrc`; the detach keeps its `event_id = NULL` / `= CASE` SET clause and stays above the delete, and the pre-image CTE contains no `event_id =` NULL/CASE form |
| `post_preservation_guard_precedes_the_harvest_delete` | `v4-archpreservguard-001` | uses `position()`, which returns 0 when absent; the literal `DELETE FROM public.harvest_log` is untouched |
| `post_both_archive_routines_guard_preservation` | `v4-archpreservguard-001` | both bodies still name `preservation_log` |
| `post_archive_has_no_foreign_keys` | `v4-softdelcascade-001` | scoped to the two existing archive tables; `photo_detach_archive` carries no FKs either, asserted separately |

`restore-verify.py`'s `table:trigger:function` inventory is unaffected: this migration adds **no
triggers**, and its function inventory covers the `gv.*` and extensions schemas, not `public`.

### Pre-existing defect found in passing — reported, not repaired

`v4-archpreservguard-001`'s `pre_only_the_two_archive_routines_delete_harvest_log` matches `prosrc`
against `'delete\s+from\s+(public\.)?harvest_log\b'`. In a PostgreSQL ARE, **`\b` is a
character-entry escape for BACKSPACE, not a word boundary**, so that pattern matches nothing:

```sql
SELECT 'DELETE FROM public.harvest_log h WHERE' ~* 'delete\s+from\s+(public\.)?harvest_log\b';
-- false
```

The gate is **vacuous and passes for the wrong reason**. It is left alone here because
`v4-archpreservguard-001` is outside this migration's file boundary. (Independently, the correct
spelling `\y` would also not match `harvest_log_archive`, so the new un-archive functions are safe
under either reading — they delete only from `harvest_log_archive`.)

## Files

| File | Applies |
|---|---|
| `0a-additive-ddl.sql` | **first** — helpers, `schema_fingerprint` columns, `photo_detach_archive`. Purely additive. |
| `0c-routines.sql` | **second** — both halves. `0c` before `0a` leaves the archive routines raising `42P01`. |
| `0r-rollback.sql` | rollback. **Refuses if `photo_detach_archive` is non-empty** — dropping it would destroy captured links irrecoverably, since the live photo rows no longer carry those values. |
| `gates.yml` | 5 pre / 1 sweep / 24 post. All 30 run green (pre + sweep against an un-migrated restore, post against a migrated one). |
| `verify.sql` | manual SQL scenario, **not applied by anything** — the evidence behind this migration, runnable on any throwaway PG 17. |
| `tests/integration/archive-restore.int.test.js` | the real suite. **Written but UNRUN** — see below. |

## Verification status — read this before trusting the green

**What was actually executed.** The full prod schema was dumped read-only and restored into a
throwaway local PostgreSQL 17.10 cluster; `0a` + `0c` applied cleanly; **17 scenarios** run green,
covering archive→unarchive round trip (0 differing columns across `event_log` and `harvest_log`,
including every column that lives *only* in `row_data`), photo relink, duplicate-id refusal,
missing-parent refusal, photo-conflict refusal, RESTRICT-parent refusal, drift refusal **and** its
documented escape hatch, dangling-`location_id` nulling, idempotent second call, the project-axis-
only container photo, the event-less container, and the preserved guards. `0r` restored both
archive bodies to an **md5 match with live prod**, and correctly **refused** to run with a captured
link present. All 30 of this migration's gates pass; the 389-gate corpus shows zero new failures.

**What was NOT executed.** `tests/integration/archive-restore.int.test.js` is **written but unrun**.
The integration harness drives `@neondatabase/serverless` (HTTP-only — it cannot reach a local
cluster) and `assertEphemeralDatabase()` fail-closes on anything that is not a disposable Neon
branch, so the suite needs a fresh ephemeral Neon branch, the integration vitest config and the 5
CI-only packages. It has never been run. `verify.sql` asserts the same behaviours in SQL and *was*
run, but a green `verify.sql` is not evidence that the JS suite passes — its fixtures, its cleanup
ordering against `_cleanup.js`, and its `directSql` type coercions are untested.

**Nothing was applied to prod, staging, or any Neon branch.** The only Neon access was
read-only: catalog queries and one `pg_dump --schema-only`.

## Apply order

```
0a-additive-ddl.sql  ->  0c-routines.sql        (staging AND prod, in that order)
```

Migrations apply to **both** environments **before** the `migrations/**` push:
`gate-invariants.yml` runs `--phase post --continuous-only` against prod *and* staging and fires on
`migrations/**`. Run the **whole corpus** on both, not just this directory's gates.
