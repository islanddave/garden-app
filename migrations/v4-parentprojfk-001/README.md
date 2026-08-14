# v4-parentprojfk-001 — container hierarchy axis: SET NULL → RESTRICT

Closes **`V4-PARENTPROJFK-001`**. Flips `plant_projects.parent_project_id` from `ON DELETE SET NULL`
to `ON DELETE RESTRICT` — the **last SET NULL foreign key on `plant_projects`**, and the one
`v4-plantrehomefk-001` deliberately deferred pending a product decision.

**Schema version taken: `4.23.11-parentprojfk-001`** (latest in live prod at authoring time was
`4.23.10-archpreservguard-001`). A sibling lane in the same fleet is also authoring a migration —
if it took `4.23.11` too, one of the two must move before either applies.

## What was wrong

```
plant_projects_parent_project_id_fkey
  plant_projects.parent_project_id -> plant_projects(id)   ON DELETE SET NULL
```

`DELETE FROM plant_projects WHERE id = '<parent>'` — one statement, no warning, no error — silently
promoted every child **container** to top-level. The hierarchy was not archived, not logged and not
recoverable: `parent_project_id` is the only place the structure is stored, and `container_closure`
is *derived from it* and CASCADEs away with the deleted parent, so it cannot reconstruct what
`parent_project_id` itself forgot.

Every other axis off this same parent already refuses that act with a `23503` — `plants.project_id`
and `tasks.project_id` since `v4-plantrehomefk-001`, `event_log`/`photos`/`harvest_log`
`.project_id` since `V4-SOFTDELCASCADE-001` and `BUG-EVTANCHORDEL-001`. This was the lone silent
flatten.

## Why this reverses a prior deliberate decision — recorded, not allow-listed away

`v4-plantrehomefk-001` excluded this column on purpose and pinned the exclusion in **two** places: a
gate (`post_parent_project_id_deliberately_still_set_null`) and a test
(`tests/integration/plant-rehome-fk.int.test.js`). This migration reverses that. Per the precedent
`V4-CASCADESWEEP-001` set over `v4-fbshare-p1`'s `post_photo_fk_cascade` (commit `219f6b2`), the
reversal is written down in the open.

**What did not change: the measurement.** The *first* draft of `v4-plantrehomefk-001` excluded this
column on a technical claim — *"RESTRICT is checked immediately, so the same-statement parent+child
delete every teardown performs would be refused."* That claim was measured on an ephemeral branch off
staging, 2026-08-13, and is **false**. It stays false:

| Case | SET NULL | RESTRICT | NO ACTION |
|---|---|---|---|
| same-statement parent + child | succeeds | **succeeds** | succeeds |
| same-statement 3-level chain | succeeds | **succeeds** | succeeds |
| parent alone, child surviving | flattens silently | **refuses 23503** | refuses 23503 |

RESTRICT and NO ACTION are **behaviourally indistinguishable** for this column, and the full
integration suite was re-run with it flipped: **zero pre-existing failures**. The only two reds were
`v4-plantrehomefk-001`'s own pins asserting the deviation — the two artefacts this migration now
supersedes on purpose.

**What changed: the policy.** `v4-plantrehomefk-001` recorded, correctly, that the residue was a
*product* question and not a safety one: *"should deleting a parent container be refused while it
still has child containers, or should its children correctly be promoted to top-level? … That is
Dave's call."* Dave answered on **2026-08-13**, on the evidence-backed recommendation in the
soft-delete closeout recon §5b: **flip to RESTRICT**. The exclusion is not being overturned by a
later session that decided it knew better — it is being closed by the decision it was explicitly
waiting for. *Excluded on policy; included on the policy answer.*

## Measured blast radius — live prod, 2026-08-13, owner DSN

Re-measured at authoring time, not inherited. Deliberately **unfiltered by `deleted_at`**: a foreign
key does not know what a soft delete is, and 12 of 86 containers are soft-deleted, so the filter
would hide 14% of the population rather than a rounding error. A **moving** population — re-measure
at apply time.

| Fact | Value |
|---|---|
| `plant_projects` rows | **86** (74 live, 12 soft-deleted) |
| …carrying a `parent_project_id` | **76 (88.4%)** |
| Depth distribution | 10 roots / 70 at depth 2 / 6 at depth 3 — **max depth 3** |
| Containers that **have** children (i.e. become undeletable) | **7** |
| …of those, **mid-level** nodes (a parent *and* children) | **1** |
| Dangling `parent_project_id` values | **0** |
| Self-referencing rows (`parent_project_id = id`) | **0** |
| FK `convalidated` | **`t`** |

Only **7** containers change deletability. The one mid-level node is the case that decides the
ticket: flattening it scatters a real three-level hierarchy in a single unlogged statement.

## What the silent flatten actually costs

- **Structure — the whole harm.** `parent_project_id` is the only record of the hierarchy. Unlike
  `BUG-PLANTREHOMEFK-001` there is no "project-less arm" to land in and no second key to fall back
  on. Nulled is gone.
- **Authorization — unchanged, and saying so matters.** Flattening does **not** move a row across an
  ownership boundary: a container's read/write predicate keys on its own `created_by` whether or not
  it has a parent. This is a **data-loss** defect, not an authz defect. The ticket stands on the
  first ground alone; claiming the second would be the "a guard already covers this" inversion run
  in reverse.
- **Exposure — no app path can trigger it.** `lambda/projects/index.js` contains **zero**
  `DELETE FROM`; the container delete route sets `deleted_at`. Every reachable caller is an operator
  running admin SQL — precisely the caller RESTRICT is for. "The app is careful" protects nothing
  when the app is not the writer.

## Does any live row make RESTRICT fail? No

The FK is already `convalidated = 't'`, Postgres's own catalog-level proof that every child value
resolves to a live parent. This migration keeps the same column and the same parent table and changes
only the referential action, so the validation scan `ADD CONSTRAINT` runs is guaranteed to succeed.
Independently swept for 0 dangling and 0 self-referencing rows.

## Escape hatch — why there is no `0a`

Matching `v4-plantrehomefk-001`, and for the same reason: `SOFTDELCASCADE` shipped
`archive_container_events()` because those rows had to be **preserved** before deletion. A subtree
needs no cold store — it needs a **decision**. Each supported path is one explicit statement an
operator now has to type:

```sql
-- (a) promote to top-level — exactly what SET NULL did implicitly, now stated
UPDATE plant_projects SET parent_project_id = NULL WHERE parent_project_id = '<parent-id>';

-- (b) re-home the subtree to the grandparent — which SET NULL could never do
UPDATE plant_projects SET parent_project_id =
         (SELECT parent_project_id FROM plant_projects WHERE id = '<parent-id>')
 WHERE parent_project_id = '<parent-id>';

-- (c) remove the subtree — soft-delete it, or hard-delete depth-first (each level's plants/tasks/
--     event/photo axes will RESTRICT in turn unless emptied first)
UPDATE plant_projects SET deleted_at = NOW() WHERE parent_project_id = '<parent-id>';
```

(b) is the interesting one. SET NULL's implicit answer was **always** "promote to top-level", which
for the one live mid-level node is the wrong answer and always was. RESTRICT removes no capability;
it forces the choice between (a) and (b) to be made rather than assumed.

## Deploy boundary

**Answer: no writer coupling — safe to apply before or after any code deploy, and not split into
pre/post-deploy files.**

Inherited from `v4-plantrehomefk-001`'s sweep of all 27 deployed prod Lambda bundles (2026-08-13,
prod at `5c232164616228dfce4f3e669ef8011a2cf7a456` = v4.14.0) and **re-asserted at apply time by the
gates rather than trusted**. The only real DELETE statements in deployed prod code are
`DELETE FROM favorites` and `DELETE FROM public.entity_memory` (a child-row delete). There is no
`DELETE FROM plant_projects` in any deployed bundle. `lambda/projects/index.js` soft-deletes via
`UPDATE public.container SET deleted_at = NOW()` — and `container` is a **view** over this table
(`relkind = 'v'`), so a view write cannot bypass the FK.

In-database writers, which a grep of Lambda bundles cannot see (the trap `SOFTDELCASCADE`'s audit
hit): catalog sweep returns **zero** routines in any non-system schema that delete from
`plant_projects`. The only `BEFORE DELETE` trigger on the table is `trg_guard_entity_tag_project`, a
read-only guard; the `AFTER DELETE` trigger `trg_delete_entity_tags_project` writes to a child table
and is unaffected. The reparent path (`PATCH` → `SET parent_project_id = …` and the
`container_reparent_after` trigger it fires) is an UPDATE and is untouched.

**CI/staging needs no companion workflow edit** — verified, not assumed. `deploy-staging.yml`'s smoke
purge ends at `DELETE FROM plant_projects WHERE name ILIKE '%smoke%'` (`:612`) — **one statement**, so
a smoke parent and its smoke children go together, which the matrix above measures as succeeding
under RESTRICT. `tests/integration/_cleanup.js:146` has the same single-statement shape. All 26
integration files that delete `plant_projects` were re-swept: every one deletes by `created_by` /
namespace in a single statement, and **none creates a parent/child container pair at all** —
`parent_project_id` appears in no integration fixture anywhere.

## Whole-corpus impact — MEASURED

This repo shipped green-per-migration / red-on-corpus **twice on 2026-08-13**, so this was measured
rather than reasoned about.

**Method.** `pg_dump --schema-only` of live prod (read-only) restored into a throwaway local
PostgreSQL 17 cluster — 7,603 lines, **0 restore errors** — then the whole gate corpus
(`gate_runner.py --all --phase post --continuous-only`, 57 gate files) run three times against it:
un-migrated, migrated **with** the companion patch, and migrated **without** it. The database has no
rows, so ~55 data-count gates fail in every run; the signal is the **delta between runs**, not the
absolute count.

| Run | PASS | FAIL | Delta vs baseline |
|---|---|---|---|
| Baseline (un-migrated) | 348 | 58 | — |
| `0c` applied **+ companion patch** | **351** | **55** | **zero new failures**; fixes exactly the 3 this migration's own gates raise pre-apply |
| `0c` applied, **patch NOT applied** | 350 | 56 | **exactly one new failure**: `post_parent_project_id_deliberately_still_set_null` |

No gate that passed before this migration fails after it, in either configuration. The only corpus
casualty is the one pin this migration is designed to supersede, and the companion patch closes it.

Independently, the **live prod** corpus was run read-only before any of this: `PASS=403, FAIL=3`,
where the 3 are this migration's own continuous post gates failing pre-apply, exactly as designed
(`post_parent_project_id_is_restrict`, `post_no_setnull_fk_remains_on_plant_projects`,
`post_container_delete_axis_is_uniformly_restrict`). Prod is otherwise green, so there is no
pre-existing corpus red for this apply to hide behind.

Per-gate classification, all confirmed by the measurement above:

| Gate | File | Prediction |
|---|---|---|
| `post_parent_project_id_deliberately_still_set_null` | `v4-plantrehomefk-001` | **FAILS** — asserts `confdeltype='n'` on this exact constraint, continuous. See below. |
| `post_containment_fks_are_restrict`, `post_containment_fks_are_validated` | `v4-plantrehomefk-001` | PASSES — name lists cover `plants`/`tasks` only. |
| `post_no_writing_before_delete_trigger_on_touched_tables`, `post_no_new_triggers_on_touched_tables` | `v4-plantrehomefk-001` | PASSES — no trigger added or removed. |
| `post_no_indb_routine_hard_deletes_plantings_or_containers` | `v4-plantrehomefk-001` | PASSES — **but vacuously**; see the `\b` note below. |
| `post_no_setnull_fk_inside_an_anchor_check` | `v4-evtanchordel-001` | PASSES — its result set can only *shrink* when a SET NULL FK is removed, and `plant_projects` carries no anchor CHECK. |
| `post_no_cascade_onto_a_soft_deletable_table` | `v4-cascadesweep-001` | PASSES — keys on CASCADE; this flip removes a SET NULL and adds no CASCADE. |
| `post_trigger_event_id_deliberately_still_set_null` | `v4-cascadesweep-001` | PASSES — different constraint (`user_achievements`). |
| `post_no_cascade_*`, `post_plant_axis_still_restrict`, `post_anchor_checks_survive` | `v4-softdelcascade-001` | PASSES — unrelated constraint names; no CASCADE introduced. |
| `confdeltype='n'` gates (`preservation_log.*`) | `v4-archpreservguard-001`, `v4-putup-001` | PASSES — different columns, untouched. |

Own gates, dry-run read-only against **live prod** before apply: `pre` **2/2**, `sweep` **2/2**,
`post` **2/6** — the 4 reds being exactly the four post-apply assertions
(`post_parent_project_id_is_restrict`, `post_no_setnull_fk_remains_on_plant_projects`,
`post_container_delete_axis_is_uniformly_restrict`, `post_schema_version_recorded`). The two that
already pass are `post_parent_project_id_fk_is_validated` (the FK is `convalidated`) and
`post_no_indb_routine_hard_deletes_containers` (zero routines) — i.e. the apply-safety premises hold
before the apply, which is what they are for.

### ⚠️ REQUIRED COMPANION EDIT — one gate outside this migration must be superseded

`migrations/v4-plantrehomefk-001/gates.yml` carries
`post_parent_project_id_deliberately_still_set_null`, a **continuous** post gate asserting
`confdeltype = 'n'` on this exact constraint. It **will fail on both prod and staging the moment
`0c` is applied**, and `gate-invariants.yml` runs `--phase post --continuous-only` against both.

That is not a defect in either file. The pin exists *precisely* so that a silent tidy-up of "the last
SET NULL on this parent" reds instead of ships, and demands an answer on the record first. This
migration is that answer.

The authoring lane's file boundary was `migrations/v4-parentprojfk-001/**` plus
`tests/integration/plant-rehome-fk.int.test.js`, so **it did not edit the sibling gates file**.
The exact replacement — gate renamed to `post_parent_project_id_is_restrict`, value flipped, reversal
recorded in a comment block, in the `V4-CASCADESWEEP-001`/`post_photo_fk_cascade` shape — is prepared
and verified to apply cleanly:

```bash
git apply migrations/v4-parentprojfk-001/COMPANION-EDIT-plantrehomefk-gates.patch
python3 -c "import yaml; yaml.safe_load(open('migrations/v4-plantrehomefk-001/gates.yml'))"
```

**Apply it before the whole-corpus gate run.** Without it the corpus reds on both environments.

### Reported, not fixed — a vacuous gate in the same class

`post_no_indb_routine_hard_deletes_plantings_or_containers`
(`v4-plantrehomefk-001/gates.yml:171`) and
`pre_only_the_two_archive_routines_delete_harvest_log`
(`v4-archpreservguard-001/gates.yml:66`) both use `\b` as a word boundary inside a **PostgreSQL
Advanced Regular Expression**, where `\b` is a **backspace character**. The pattern therefore requires
a literal backspace in the routine source and **matches nothing** — vacuous while looking armed.
Verified live 2026-08-13 against this exact pattern shape:

```
SELECT 1 WHERE 'delete from plant_projects where' ~* '…plant_projects\y'  -> 1 row
SELECT 1 WHERE 'delete from plant_projects where' ~* '…plant_projects\b'  -> 0 rows
```

Then proved decisively against a **real routine** on the local restore — a function whose body
contains `DELETE FROM plant_projects WHERE false`:

```
\y form -> 1 match      \b form -> 0 matches
```

So `v4-plantrehomefk-001`'s gate would **not** have caught that routine. Both are **outside this
lane's file boundary and were not touched**. This migration's own
`post_no_indb_routine_hard_deletes_containers` uses `\y`, returns 0 against live prod for the right
reason, and reds when that routine exists.

## Mutation testing

Gates were killed deliberately on the local restore, then restored to green:

| Mutation | Expected red | Result |
|---|---|---|
| Constraint set to `NO ACTION` instead of `RESTRICT` (behaviourally identical, but not what `0c` says it does) | `post_parent_project_id_is_restrict`, `post_container_delete_axis_is_uniformly_restrict` | **RED 2**, then 6/6 green on restore |
| New child table with `ON DELETE SET NULL` referencing `plant_projects` | `post_no_setnull_fk_remains_on_plant_projects` | **RED**, then green on drop — the class gate fires on a table that did not exist |
| In-DB routine containing `DELETE FROM plant_projects` | `post_no_indb_routine_hard_deletes_containers` | **RED**, then green on drop |
| Self-referencing container row | `sweep_no_self_referencing_container` | **could not be set up** — an existing DB trigger, `gv.container_reparent()`, refuses it with *"container reparent would create a cycle"*. Reported honestly: that gate is a cheap checked precondition, not coverage. The undeletability hazard itself *was* demonstrated by forcing the state and watching the single-row `DELETE` get refused until `parent_project_id` was nulled. |

## Runbook

> **Push order is load-bearing.** `gate-invariants.yml` runs `--phase post --continuous-only` against
> **both** prod and staging and fires on `migrations/**` pushes. The post gates assert the
> *post-apply* state, so **apply to staging AND prod before pushing this directory.** Pushing first
> reds gate-invariants on whichever environment is still unmigrated.

```bash
export NEON_DATABASE_URL=$(grep -m1 '^NEON_DATABASE_URL=' .env.local | sed 's/^NEON_DATABASE_URL=//' | tr -d '"')
```

0. **Apply the companion patch** (above). Nothing else is coherent until it lands.
1. **Staging — pre + sweep.**
   `python3 scripts/gate_runner.py --migration migrations/v4-parentprojfk-001 --env staging --phase pre`
   then `--phase sweep`. All-green before anything is applied.
2. **Staging — apply `0c`, rehearse `0r`, re-apply `0c`.** A rollback path that has never been
   executed is a rollback path that does not exist. Confirm `confdeltype` reads `n` after `0r` and
   `r` after each `0c`.
3. **Staging — integration suite** on a fresh ephemeral branch. This is the real test of the teardown
   sweep, not the grep — it is what would catch a parent-first container teardown the file scan
   missed. Expect `plant-rehome-fk.int.test.js` green with its updated pin and REVIEWED map.
4. **Staging — post gates (6/6) AND the whole gate corpus.** The corpus run is not optional here; it
   is the step that converts the prediction table above into a measurement.
5. **Prod — pre + sweep, apply `0c`, post gates 6/6, whole corpus.**
6. **Only now push.** Then confirm `gate-invariants.yml` green on both environments.

**Rollback:** `0r-rollback.sql`, safe at any time — widening a referential action never fails on
existing data. It re-arms the silent flatten; read its header before running it. Note a rollback
*after* the companion patch has landed reds the superseding gate, which is correct: the corpus should
never be silently satisfied in either state without someone choosing which state is intended.

## Gates

`pre` 2 · `sweep` 2 · `post` 6. Two are `continuous: false` (the pre-state assertion and the
schema_version receipt); the other eight are standing invariants and run in CI on every
`migrations/**` push.

The load-bearing one is **`post_no_setnull_fk_remains_on_plant_projects`** — with this flip there is
**no `SET NULL` (or `SET DEFAULT`) foreign key left anywhere pointing at `plant_projects`**. All
eleven either refuse a container delete (6) or cascade a derived cache/closure row rebuilt from live
data (5). The invariant it asserts is the one the soft-delete audit was chasing on this parent: *a
container delete may be refused, or may take derived data with it, but it may never silently discard
user structure.* A new child table added with `ON DELETE SET NULL` reds there, in a table that does
not exist yet.

## Not shipped by this lane — an integration test for the behaviour

`v4-plantrehomefk-001`'s behaviour is covered by `tests/integration/plant-rehome-fk.int.test.js`.
This migration ships only the **schema pin** in that file (updated value + REVIEWED map); the
authoring lane's boundary did not permit creating a new test file. A ready-to-move behavioural suite
is parked at **`PROPOSED-TEST-parent-proj-fk.int.test.js.txt`** in this directory — it proves the
refusal, the 23503 naming, the no-half-done property, that a childless container still deletes, that
the same-statement parent+child (and 3-level chain) delete still succeeds, and both escape hatches.

**Move it to `tests/integration/parent-proj-fk.int.test.js` and run it as part of step 3.** It has
not been executed against a database.

> The `.txt` suffix is load-bearing, not decoration. `vitest.config.ts` excludes only
> `tests/integration/**` and `**/.claude/**`, so a file named `*.test.js` anywhere under
> `migrations/` is swept into the **unit** run, where its `./_harness.js` import does not resolve and
> the whole run reds. Strip `.txt` only at the moment you move it into `tests/integration/`.
