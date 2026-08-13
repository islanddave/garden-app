# v4-plantrehomefk-001 — containment axis: SET NULL → RESTRICT

Closes **`BUG-PLANTREHOMEFK-001`**. Folds **`BUG-TASKDETACHFK-001`** (zero-row flip; rationale in
`0c-constraint.sql` §SCOPE).

## What was wrong

`plants.project_id` and `tasks.project_id` referenced `plant_projects(id)` **`ON DELETE SET NULL`**.
One statement — `DELETE FROM plant_projects WHERE id = '<container>'` — silently stripped every
child planting out of its container and dropped it into the **project-less arm**, where the
read/write predicate keys on the planting's own `created_by` instead of the container's.

The history axis off the same parent (`event_log.project_id`, `photos.project_id`,
`harvest_log.project_id`) has refused that act with a `23503` since `V4-SOFTDELCASCADE-001` and
`BUG-EVTANCHORDEL-001`. The containment axis beside it was named in `SOFTDELCASCADE/0c` and
deferred. This finishes it.

`lambda/plants/index.js:463` claimed *"Tracked as a separate FK ticket."* The soft-delete audit
verified no such row existed. It exists now, and this migration closes it.

## Measured blast radius — live prod, 2026-08-13, owner DSN

Unfiltered by `deleted_at` on purpose: a foreign key does not know what a soft delete is.

| Fact | Value |
|---|---|
| `plants` rows | 310 |
| …carrying a `project_id` | **305 (98.4%)** |
| …already project-less | 5 |
| `plant_projects` rows | 86 |
| …holding at least one planting | 76 |
| Plantings in someone else's container | **24** — all the `rescue-intake-longriver-20260712` sentinel, inside Dave's containers |
| `tasks` rows | **0** (dormant feature: `src/pages/Tasks.jsx` exists, no Lambda route serves it) |
| Both FKs `convalidated` | `t` |

Per owner (never pool these — a pooled figure here is one user's): Dave 269 own-in-own; sentinel 24
in Dave's; second sub 11 own-in-own; third sub 1 own-in-own. **There is no user-to-user crossing
today.**

## What the re-home actually costs

The ledger row calls this *ownership-widening*. That is the right name for the mechanism but it
overstates today's exposure, and the distinction changed how hard this was scoped:

- **Exposure, today — effectively nil.** The project-less arm resolves through `householdScope()`,
  which is membership-gated and fail-closed; household members already read and write each other's
  project-less plantings. A genuinely foreign user can no longer manufacture the crossing case
  either: `POST /api/plants` gates `body.project_id` through `loadOwnedProject()` and returns 400
  (`index.js:999`).
- **Availability, today — the real live harm.** The 24 sentinel-owned rows have a `created_by`
  matching *no* caller, so re-homing them makes them permanently unreachable through the API:
  present in the table, invisible to every user, with nothing pointing them back at a container.
- **Containment, today.** 305 plantings silently lose the grouping every project-scoped query, the
  watch band and the harvest roll-ups are built on. Nothing is deleted — which is exactly why it
  would go unnoticed.
- **Exposure, tomorrow.** The mechanism is still a live authorization defect, one dropped ownership
  check on any future write path away from mattering. The FK is the layer that should not depend on
  that check being right.

## Three inherited claims, re-tested and found false

This ticket exists *because* a comment claimed a ticket covered it and none did. In that spirit
every inherited claim was re-tested. Three did not survive (L-367 — "a guard already covers this" is
the class of claim most likely to be wrong):

1. **`SOFTDELCASCADE/0c`:** *"the integration teardowns at `plants.int.test.js:60` and
   `cal1-indep.int.test.js:130` currently DEPEND on that SET NULL. Flipping it without fixing them
   first reds CI."* — **False, and it names the wrong two files.** Both already delete `plants`
   before `plant_projects` (`plants.int.test.js:63 < :64`; `cal1-indep.int.test.js:134 < :139`).
   All 21 integration files that delete `plant_projects` were swept: **15 child-first, 5 create no
   plantings, 1 parent-first** — `preservation.int.test.js` (`:80` before `:83`), which passed only
   because its 5 fixture plantings carry no `project_id`. Green by property, not construction;
   reordered in this commit.
2. **`lambda/plants/index.js:451`:** *"the POST path does not verify that `body.project_id` is a
   container you own, so a foreign user can create such a row today."* — **False.** Gated at
   `:999-1002`, returns 400. Corrected in this commit.
3. **`lambda/plants/index.js:463`:** *"Tracked as a separate FK ticket."* — **False when written.**
   Now true. Corrected in this commit.

## Escape hatch — why there is no `0a`

`SOFTDELCASCADE` shipped `archive_container_events()` because those rows had to be **preserved**
somewhere before deletion. A planting needs no cold store — it needs a **decision**. Both supported
ways through a blocked delete are one explicit statement, and the point is that an operator now has
to type one:

```sql
-- (a) re-home on purpose — the same act SET NULL performed implicitly, now stated
UPDATE plants SET project_id = NULL WHERE project_id = '<container-id>';

-- (b) remove the contents — soft-delete, or hard-delete (which the event/photo axis will itself
--     RESTRICT unless that history is archived first via archive_container_events())
UPDATE plants SET deleted_at = NOW() WHERE project_id = '<container-id>';
```

## Deploy boundary

**Answer: NO writer coupling — safe to apply before or after any code deploy, and not split into
pre/post-deploy files.**

Re-run 2026-08-13 against prod at `5c232164616228dfce4f3e669ef8011a2cf7a456` (v4.14.0) — *not*
inherited from the `SOFTDELCASCADE` audit, which predates three prod ships. All 27 deployed prod
Lambda bundles downloaded (`aws lambda get-function Code.Location`, staging excluded) and grepped
for `DELETE FROM`. The only real statements are `DELETE FROM favorites` (unrelated) and
`DELETE FROM public.entity_memory` (`garden-plants/index.js:709` — a child-row delete, unblockable
by a parent-side RESTRICT). The `DELETE FROM plant_projects` the grep reports in the deployed
`garden-plants` bundle is the **source comment at `:463`** predicting this ticket — verified line by
line, not assumed.

A grep of Lambda bundles **cannot see in-database writers** (the trap the `SOFTDELCASCADE` audit hit
and recorded). Catalog sweep: zero routines in any non-system schema delete from `plants` or
`plant_projects`; no `BEFORE DELETE` trigger on either table. The one `AFTER DELETE` trigger,
`trg_delete_entity_tags_project`, deletes from a child and is unaffected.

**CI/staging needs no companion edit.** `deploy-staging.yml`'s smoke purge already deletes `plants`
(`:604`, predicate covers `project_id IN (smoke projects)`) **before** `plant_projects` (`:610`),
and never touches `tasks`. Verified against the file — this is the exact class of latent breakage
`SOFTDELCASCADE` had to fix in its own window.

## Runbook

> **Push order is load-bearing.** `gate-invariants.yml` runs `--phase post --continuous-only`
> against **both** prod and staging and fires on `migrations/**` pushes. The post gates assert the
> *post-apply* state, so **apply to staging AND prod before pushing this directory.** Pushing first
> reds gate-invariants on whichever environment is still unmigrated.

```bash
export NEON_DATABASE_URL=$(grep -m1 '^NEON_DATABASE_URL=' .env.local | sed 's/^NEON_DATABASE_URL=//' | tr -d '"')
```

1. **Staging — pre + sweep.**
   `python3 scripts/gate_runner.py --migration migrations/v4-plantrehomefk-001 --env staging --phase pre`
   then `--phase sweep`. Both must be all-green before anything is applied.
2. **Staging — apply `0c`, then rehearse `0r`, then re-apply `0c`.** A rollback path that has never
   been executed is a rollback path that does not exist. Confirm `confdeltype` reads `n` after `0r`
   and `r` after each `0c`.
3. **Staging — run the integration suite.** This is the real test of the teardown sweep, not the
   grep. It is the step that would catch a parent-first teardown the file scan missed.
4. **Staging — post gates.** 7/7.
5. **Prod — pre + sweep, apply `0c`, post gates.** 7/7.
6. **Only now push.** Then confirm `gate-invariants.yml` is green on both environments.

**Rollback:** `0r-rollback.sql`, safe at any time — widening a referential action never fails on
existing data. It re-arms the defect; read its header before running it.

## Pre-apply gate results (prod, 2026-08-13, before apply)

- `pre` **2/2 PASS** — defect confirmed present (both FKs `confdeltype = 'n'`), history axis already
  RESTRICT.
- `sweep` **2/2 PASS** — no dangling child rows on either column.
- `post` **5/7** — the only two failures are `post_containment_fks_are_restrict` and
  `post_schema_version_recorded`, i.e. exactly the two that assert the post-apply state. The other
  five (FK validation, the `parent_project_id` exclusion, no in-DB routine, no `BEFORE DELETE`
  trigger, no new triggers) already hold.

## What is deliberately NOT in this migration

**`plant_projects.parent_project_id`** (SET NULL, **76 live rows**) — named alongside the other two
by `SOFTDELCASCADE`, and excluded here on a **policy question, not a technical one**.

This file's first draft excluded it for a technical reason that testing destroyed, and the record is
kept because it is the same failure mode the ticket is about — asserting a mechanism instead of
measuring it. **The claim:** *"it is self-referential, and RESTRICT is checked immediately, so a
same-statement parent+child delete — what every teardown does — would be refused."*

**Measured** on an ephemeral branch off staging, 2026-08-13, all three actions, seeds verified
present before each delete (the probe's first run silently inserted nothing and returned a confident
zero — these are the corrected numbers):

| Case | SET NULL | RESTRICT | NO ACTION |
|---|---|---|---|
| same-statement parent + child | succeeds | **succeeds** | succeeds |
| same-statement 3-level chain | succeeds | **succeeds** | succeeds |
| parent alone, child surviving | flattens silently | **refuses 23503** | refuses 23503 |

RESTRICT and NO ACTION are **behaviourally identical** for this column, and neither breaks a
teardown. Confirmed end to end: the full integration suite was re-run with `parent_project_id`
flipped to RESTRICT — **32 of 33 files pass, and the only two failures are this migration's own pins
asserting the deviation. Zero pre-existing tests break.** The CI risk originally claimed does not
exist.

**Why it is still excluded:** the remaining question is a product decision. Should deleting a parent
container be *refused* while it still has child containers, or should its children correctly be
promoted to top-level? Flattening a hierarchy is not self-evidently a defect the way silently moving
user content across an ownership boundary is — SET NULL may well be right here. That is Dave's call,
so it gets its own row carrying this evidence.

`post_parent_project_id_deliberately_still_set_null` exists so a future sweep tidying up "the last
SET NULL on this parent" reds instead of shipping.
