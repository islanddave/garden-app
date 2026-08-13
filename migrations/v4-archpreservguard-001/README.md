# v4-archpreservguard-001 — the archive routines learn about put-ups

Closes **`BUG-ARCHPRESERVGUARD-001`** (audit finding I7). Resolves **M3** as *no change, with reasons*.

## What was wrong

`archive_plant_events()` and `archive_container_events()` both **DELETE `harvest_log` rows** as a
deliberate step, moving them to `harvest_log_archive`. `preservation_log.harvest_log_id` is
`ON DELETE SET NULL`, so that delete silently stripped the provenance from every put-up made from
those harvests: **the jar stayed, its source vanished.**

Both routines already refused to touch the other two evidence classes, each with a *named* error
raised **before** any write:

| Guard | Class | Message |
|---|---|---|
| 1 | `cultivar_weight_sample` | *"they are evidence, not derived data"* |
| 2/3 | `photos` | *"Photos are never deleted by this function"* |
| **new** | **`preservation_log`** | *"archiving would strip their provenance"* |

A preservation record is the same kind of thing — user-authored evidence, not data derived from the
harvest — and it had no guard at all.

## Measured — live prod, 2026-08-13

`preservation_log` holds 1 row: 0 carry a `harvest_log_id`, 1 carries a `plant_id`. Both archive
routines have **never been run in prod** (both archive tables hold 0 rows). So this is latent — the
cheapest possible moment to close it.

`harvest_log_archive` preserves the **original** harvest id, so a preservation row's
`harvest_log_id` value would still be meaningful after archiving. The only thing destroying it is
the FK's own SET NULL.

## Scope: the routines only — and that is a correction to my own first draft

The first version of this migration **also** flipped `preservation_log.harvest_log_id` and
`.plant_id` from SET NULL to RESTRICT, as a backstop for callers a routine cannot see.
`v4-putup-001`'s gates caught it — and reading that migration showed the SET NULL was a **stated
design choice**, not an oversight:

```sql
plant_id       uuid REFERENCES plants(id)      ON DELETE SET NULL,  -- planting deleted -> keep put-up history
harvest_log_id uuid REFERENCES harvest_log(id) ON DELETE SET NULL,  -- OPTIONAL provenance (L8)
```

A jar of pickles outlives its planting record, and a NULL provenance link is a **legitimate state**
on a column documented as optional.

That is materially different from the `share_log` case `V4-CASCADESWEEP-001` reversed hours earlier.
There, `photoDelete.js`'s own prose contradicted the schema, so one of the two had to be wrong. Here
nothing contradicts anything: a considered design chose SET NULL and said why. RESTRICT would
preserve strictly more — the provenance as well as the record — but at the cost of making a planting
undeletable for as long as any put-up made from it exists. **That is a product decision about how
long a jar should pin a planting, not a defect.**

So this migration closes exactly what the audit filed (I7 is about the *routines'* guard list), and
the FK question is filed separately as **`V4-PRESERVFKACTION-001`** with both arguments, for Dave.
`v4-putup-001`'s `post_plant_fk_set_null` / `post_harvest_fk_set_null` remain the authority on the
FK action, and this migration's own gates assert the FKs are **still SET NULL**.

## M3 — `user_achievements.trigger_event_id`: no change, and that is the finding

The audit folded M3 into this row. Re-examined, it is not a defect:

- It is standing policy (`V4-EVTCASCADE-001`, restated by `V4-SOFTDELCASCADE-001`): *"nulling a
  reward's provenance pointer costs no user-visible data; rewards are never clawed back."*
  `V4-CASCADESWEEP-001` pins it, so guarding it here would put two migrations in contradiction.
- It is **strictly less harmful** than the case this file closes: `archive_*` preserves the event in
  `event_log_archive` with full `row_data`, so that provenance stays recoverable — whereas a
  preservation record whose harvest is archived has no other record of its source.
- The badge itself *is* protected: `V4-CASCADESWEEP-001` flipped `user_achievements.achievement_id`
  to RESTRICT. Badge protected, provenance pointer not — an intended asymmetry, now asserted in two
  places.

## Deploy boundary

**Answer: NO writer coupling.** All 27 deployed prod bundles grepped for `DELETE FROM` at prod
`5c232164616228dfce4f3e669ef8011a2cf7a456` (v4.14.0): nothing deployed hard-deletes `harvest_log`,
and **nothing deployed calls either archive routine** — they are operator-invoked escape hatches by
design. The only in-database writer that deletes `harvest_log` *is* these two routines, which this
migration edits.

**Companion edits: none required**, verified rather than assumed. `_cleanup.js` already sweeps
`preservation_log` before `harvest_log` and `plants`; both preservation suites delete it first; the
staging smoke purge never touches it.

## Cross-migration risk, checked

`V4-SOFTDELCASCADE-001` carries `post_archive_functions_detach_photos_before_deleting_events`, which
asserts **positionally** against `prosrc` that the photo DETACH precedes the event DELETE in both
routines — and is mutation-tested. The new guard is inserted *above* the detach, so the two keep
their relative order. Verified: that migration still passes **16/16** after this one applied. This
is why the whole corpus must be re-run on both envs, not just this directory's gates.

## Runbook

Same shape as its siblings: staging `pre`+`sweep` → apply `0c` → rehearse `0r` → re-apply → staging
`post` → fresh-branch integration suite → prod `pre`+`sweep`+apply+`post` → whole corpus both envs →
**then** push.

**Rollback:** `0r-rollback.sql` restores both function bodies byte-for-byte. It touches no constraint
and no row.

## Verification record

- Staging `0r` rehearsed round-trip: guards 2 → 0 → 2.
- `archive-preservation-guard.int.test.js`: **7/7**, including the escape hatch actually unblocking
  the archive and the positional guard-before-delete pin.
- Full integration suite on a fresh branch: **36 files, 545 passing, 0 failures.**
- Gates: staging 4/4, prod 4/4. Whole corpus **400 prod / 397 staging, zero failures**;
  `v4-softdelcascade-001` still 16/16.
