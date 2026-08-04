# V4-EVTANCHORDEL-001 — the delete-cascade / anchor-CHECK contradiction

**Ticket:** `BUG-EVTANCHORDEL-001` · **Status:** applied to STAGING, **NOT applied to PROD**
· **Authored:** 2026-08-04 against `dev` = `cc70cdb059d22c73849578c4cb06f60627daec99` (v3.97.0)

## The defect

`event_log` carries `CHECK event_log_has_anchor (plant_id IS NOT NULL OR project_id IS NOT NULL)`
while `event_log.plant_id` was `ON DELETE SET NULL`. Those two cannot both be honoured. Hard-deleting
a planting makes the FK's own cascade write `plant_id = NULL`; if that row's `project_id` is also
NULL, the cascade has just produced a row that violates the table's own CHECK and the whole `DELETE`
aborts with **23514** — an error naming a CHECK, with nothing pointing at the DELETE that caused it.

This is not a data problem to be cleaned up. It is a schema declaring an action it is not permitted
to perform.

**Unreachable from the app** (all three DELETE routes soft-delete: `lambda/plants/index.js:500`,
`lambda/locations/index.js:172`, `lambda/projects/index.js:624`), **reachable from admin SQL, the
staging smoke purge, and test teardowns.**

## Live inventory (prod Neon, 2026-08-04)

`garden_node` and `container` are VIEWS over `plants` / `plant_projects`; every catalog query below
was resolved against the BASE TABLE (`relkind='r'`). Querying `pg_constraint` against a view returns
clean and means nothing.

| Object | Live definition | Validated |
|---|---|---|
| `event_log_has_anchor` | `CHECK (plant_id IS NOT NULL OR project_id IS NOT NULL)` | **NOT VALID** — still enforced on INSERT/UPDATE, which is why the cascade trips it |
| `event_log_plant_id_fkey` | `(plant_id) → plants(id)` **SET NULL** | ← the bug |
| `event_log_project_id_fkey` | `(project_id) → plant_projects(id)` CASCADE | see follow-up |
| `event_log_location_id_fkey` | `(location_id) → locations(id)` SET NULL | safe — not an arm of the CHECK |
| `event_log_treatment_product_id_fkey` | `→ inventory_items(id)` NO ACTION | safe |

FKs **into** `event_log`: `photos.event_id` CASCADE · `harvest_log.event_id` RESTRICT ·
`user_achievements.trigger_event_id` SET NULL · `cultivar_weight_sample.source_event_id` NO ACTION.

**Data exposure.** 12,100 of 12,100 prod `event_log` rows carry a non-NULL `project_id`, so **zero**
plantings are undeletable today — the event_log half of this bug is *latent, not active*. It is not
theoretical either: `event_log_has_anchor` exists specifically to permit plant-anchored, project-less
events (`migrations/care-rekey-001`), `validatePostBody` now admits such a body
(`lambda/events/index.js:1374`), and prod already holds one project-less planting. The first
plant-only event makes its planting undeletable.

## Sibling instances — this is a CLASS, not an instance

Swept `pg_constraint` for every (FK column with `confdeltype IN ('n','d')`) × (CHECK referencing that
same column) pair, across the whole `public` schema, on **both** prod and staging (identical results).

| Table.column | SET-NULL FK | Anchor CHECK | Verdict |
|---|---|---|---|
| `event_log.plant_id` | → `plants` | `event_log_has_anchor` (2-way, NOT VALID) | **the reported bug** — 0 rows at risk |
| `photos.plant_id` | → `plants` | `photos_must_have_parent` (7-way, **VALIDATED**) | **real sibling — 6 live prod rows at risk** |
| `photos.location_id` | → `locations` | `photos_must_have_parent` | **real sibling — 1 live prod row at risk** |
| `preservation_log.plant_id` | → `plants` | `chk_preservation_log_source_plant` | **false positive** — predicate is `(… OR plant_id IS NULL)`, so nulling *satisfies* it |

Also checked and clean: no `SET NULL` FK anywhere sits on a `NOT NULL` column (the sibling 23502
class); `entity_memory`'s XOR anchor (`entity_memory_exactly_one_parent`) is safe because all three
of its FKs are RESTRICT/CASCADE, never SET NULL.

The photos pair is the one with **live data at risk right now**, and its CHECK is *validated* where
event_log's is not — so it is fixed here too rather than deferred.

## The fix: `SET NULL` → `RESTRICT` on all three

**The rule this encodes:** *an FK column that is an arm of a disjunctive "must have at least one
parent" CHECK must never be `ON DELETE SET NULL`.* SET NULL asserts "this parent is optional"; the
CHECK asserts "some parent is mandatory". They are compatible only when a sibling anchor is
guaranteed non-null — and a disjunctive CHECK is precisely the statement that no such guarantee
exists. The legal actions for an anchor column are RESTRICT or CASCADE.

Full argument, including every rejected alternative, is in the header of `0c-constraint.sql`.
Summary of the rejections:

- **CASCADE** — destroys history, and *more* of it than the bug does: it would delete events that
  carry a project anchor and would otherwise survive untouched.
- **Relax/drop the anchor CHECK** — legalises the damage instead of fixing it. Every read path in
  `lambda/events/index.js` resolves both ownership and visibility through
  `JOIN public.container pp ON pp.id = e.project_id`, so an anchorless event is invisible to the app
  *and* has no authorization path. Nulling the last anchor doesn't orphan a row, it silently deletes
  it from the user's point of view while leaving it on disk. The CHECK is the thing correctly
  refusing.
- **Re-anchor plant → project via trigger** — the trap. `plant_projects` hold **multiple sibling
  plantings**, so `plant_id` and `project_id` are not interchangeable scopes. Promoting a
  planting-scoped observation to project scope re-attributes it across every sibling and corrupts
  exactly the per-planting harvest/maturity queries the split exists to serve. Looks like
  preservation; is corruption.
- **`BEFORE DELETE` trigger that auto-archives** — rejected *as the primary fix*. It leaves the
  contradictory SET NULL in place and merely ensures no rows are present for it to act on: the defect
  survives, defused by a side effect, and returns the moment the predicate is narrowed. It also makes
  `DELETE FROM plants` silently move user history — the same silent-lossy-choice failure the bug is
  made of. The archive is the right *idea*; it ships as an **explicit operator call** instead.
- **Soft-delete-only enforcement** — not a fix: the app already soft-deletes exclusively. Every
  reachable caller (admin SQL, smoke purge, teardowns) bypasses the app.

**Why RESTRICT is right here:** the delete is *refused* (23503, naming `event_log`) rather than
half-performed and rejected by an unrelated-looking CHECK. Nothing is lost by accident and the error
names the actual obstacle. It also aligns `event_log.plant_id` with the three FKs that **already**
guard `plants` this way — `entity.planting_ref_id`, `entity_memory.plant_id`,
`evidence.garden_node_id` are all RESTRICT. SET NULL was the outlier, not the norm. (The repo already
tracked this direction: `lambda/plants/index.js:364-371` flags the sibling
`plants_project_id_fkey` hazard as "a separate FK ticket (ON DELETE RESTRICT)".)

## Are orphaned events archived? Yes — explicitly, never implicitly

`event_log` is the user's garden observation history (12,027 live rows) and the sole record that a
watering/harvest/germination happened. `0a` ships the cold store and the supported path:

- **`public.event_log_archive` / `public.harvest_log_archive`** — `row_data jsonb` holds the complete
  original row (`to_jsonb`), so the archive can never drift as `event_log` gains columns; a
  `LIKE`-shaped mirror would silently desynchronise on the next `ADD COLUMN`. **No FKs and no anchor
  CHECK**, deliberately: the whole point is to hold rows whose parent is gone, and an FK here would
  re-create the coupling this migration removes.
- **`public.archive_plant_events(plant_id, reason)`** — moves the events (and their `harvest_log`
  detail rows), **detaches rather than deletes** any photo hanging off them (COALESCE re-parent,
  mirroring `V4-EVTCASCADE-001`'s policy), and **raises** rather than guessing when a
  `cultivar_weight_sample` (immutable calibration evidence) or a would-be-parentless photo is in the
  way. Fail-loud is the whole ethic: the original bug existed because the schema made a silent lossy
  choice on the operator's behalf; a different silent choice would repeat it.
- Nothing calls it automatically. `0a` is inert until an operator invokes it.
- **No ownership-transfer trigger dance is needed.** `prevent_ownership_transfer` is BEFORE **UPDATE**
  only (verified live on `event_log`/`photos`/`plants`), the function never writes `created_by`, and
  its only UPDATE is the photo detach. No `DISABLE TRIGGER` is performed and none is required.

Restore recipe (`jsonb_populate_record`) is at the bottom of `0r-rollback.sql`.

## Sequencing / deploy boundary

Adding a column is backward-compatible; **arming a constraint over it is a deploy**. Applied here:

`0c` changes only the referential action on a **parent DELETE**. It does not affect INSERT or UPDATE,
so **the currently-deployed Lambdas are entirely unaffected** — there is no writer-first requirement
of the "arming a CHECK breaks the old writer" kind, because no app path hard-deletes a planting or a
location. **A prod apply therefore needs no code deploy and can land independently of any promote.**

The old writers that *do* break are the non-app hard-delete callers, and they ship in this commit
**ahead of** the migration:

1. `.github/workflows/deploy-staging.yml` smoke purge — swept `event_log` by `project_id` only
   (missing plant-only-anchored events) and **never swept `photos` at all**. Both widened. 0-row
   no-ops against staging today; they exist so the sweep stays correct the first time smoke creates
   such a row.
2. `tests/integration/**` teardowns — verified sufficient **as-is** by running the full suite against
   a migrated branch (see Verification).

**`0a` must be applied before `0c`.** RESTRICT is only operable if the escape hatch exists; applying
`0c` first strands an operator with a blocked delete and no supported way through.

## Does this remove the integration-teardown workaround?

**No — it makes it MANDATORY, and that is stated in the code.** The `DELETE FROM event_log WHERE
plant_id IN (...)` lines in `plants.int.test.js` and `authz-matrix.int.test.js` were added to *dodge*
the 23514. Under RESTRICT the DB now **requires** that ordering — and requires it for *every*
planting, not just project-less ones. Removing those lines turns a green teardown into a 23503. Both
comments were rewritten from "here is a hazard we are stepping around" to "this is enforced ordering;
do not delete it". That is the correct outcome: the fix converts an implicit, discovered-by-failure
ordering into an explicit, enforced one.

## Files changed

| File | Change |
|---|---|
| `migrations/v4-evtanchordel-001/0a-additive-ddl.sql` | **new** — archive tables + `archive_plant_events()` |
| `migrations/v4-evtanchordel-001/0c-constraint.sql` | **new** — the fix (3 FK flips) |
| `migrations/v4-evtanchordel-001/0r-rollback.sql` | **new** — guarded reversal + restore recipe |
| `migrations/v4-evtanchordel-001/gates.yml` | **new** — 5 pre / 11 post, incl. the class gate |
| `migrations/v4-evtanchordel-001/README.md` | **new** — this file |
| `tests/integration/evt-anchor-delete.int.test.js` | **new** — 14 tests; reproduces the 23514 |
| `.github/workflows/deploy-staging.yml` | smoke purge widened (plant-scoped events + photos) |
| `tests/integration/plants.int.test.js` | teardown comment: workaround → enforced ordering |
| `tests/integration/authz-matrix.int.test.js` | same, + photos RESTRICT note |

No Lambda or frontend source was changed. No file under `lambda/household/**`,
`lambda/preservation/**`, `lambda/events/**`, `src/data/harvest-weights-v3-reference.json`,
`migrations/v4-cal1-refweight-001/**` or `scripts/cal1/**` was touched.

## Verification record

| Check | Result |
|---|---|
| Baseline integration suite, ephemeral branch off staging, **pre**-migration | 26 files / 385 passed, 1 skipped |
| Same branch, **post**-migration, teardowns unchanged | 26 files / **385 passed** — zero teardown breakage |
| **Test fails without the fix** (FKs reverted to SET NULL on a live branch) | **5 failures**, incl. `expected '23514' to be '23503'` — the literal reported bug, and `expected null to be '23503'` (a projected planting deleted *successfully*, silently detaching its history) |
| New test file on migrated branch | 14/14 passed |
| Full suite on a **fresh branch off migrated staging** (true CI simulation) | **27 files / 399 passed**, 1 skipped |
| Unit suite (`vitest.config.ts`) | **376 files / 5130 passed**, 2 skipped |
| `deploy-staging.yml` — PyYAML `safe_load` + `yamllint -d relaxed` | both pass (only pre-existing house-style warnings) |
| New purge SQL executed against staging | valid, 0 rows matched (no-op today) |
| **STAGING** pre-gates → apply `0a`+`0c` → post-gates | 5/5 pre, **11/11 post** |
| **PROD** pre-gates, read-only dry run | **5/5 pass** — migration would apply cleanly; **nothing applied** |
| `scripts/restore-verify.py` impact | none — its table/trigger/function inventories are live-vs-live with no fixtures, and `post_no_new_triggers_on_touched_tables` asserts this migration adds no trigger |

Prod and staging schemas were confirmed **identical** for every object in scope before any change, so
the prod apply is not extrapolated from staging — both were surveyed directly.

## PROD RUNBOOK

Not applied by the authoring session. Requires Dave's approval. Read-only, non-destructive: **no row
is read, written, moved or deleted by either file.**

```bash
cd ~/AI/Claude/Projects/Gardening/garden-app
PROD=$(grep -E '^NEON_DATABASE_URL=' .env.local | cut -d= -f2-)
```

**1. Snapshot first.** Neon PITR is only 7 days, and a named branch is a stable restore point that
does not age out mid-incident.

```bash
# Neon console → Branches → New branch from `main` (prod), name: snap-pre-evtanchordel-001
# or: scripts/snap.py, per the repo's existing prod-snap convention.
```

**2. Pre-gates — must be 5/5.** A failure here means the schema is not what this migration was
written against; stop and re-survey rather than forcing it.

```bash
python3 <gate-runner> migrations/v4-evtanchordel-001/gates.yml pre "$PROD"
```

**3. Apply, in this order.** Each file is a single transaction with `lock_timeout = '5s'`; a
`55P03 lock_not_available` is a safe, complete no-op — retry when prod is quieter.

```bash
psql "$PROD" -v ON_ERROR_STOP=1 -f migrations/v4-evtanchordel-001/0a-additive-ddl.sql
psql "$PROD" -v ON_ERROR_STOP=1 -f migrations/v4-evtanchordel-001/0c-constraint.sql
```

**4. Post-gates — must be 11/11.**

```bash
python3 <gate-runner> migrations/v4-evtanchordel-001/gates.yml post "$PROD"
```

**5. Confirm.** No deploy, promote or Lambda restart is required — no application code changed.

```bash
psql "$PROD" -At -c "SELECT conname, confdeltype FROM pg_constraint
  WHERE conname IN ('event_log_plant_id_fkey','photos_plant_id_fkey','photos_location_id_fkey');"
# expect all three = r
```

**Expected user-visible impact: none.** No app path hard-deletes a planting or a location, so no
route changes behaviour. The only behavioural change is that admin SQL doing
`DELETE FROM plants/locations` now gets a 23503 naming the blocking child instead of a 23514 (or,
worse, a silent success that detached history).

**Post-apply operator note.** `DELETE FROM plants WHERE …` in a psql session will now be refused if
the planting has any event or photo. That is the fix working. The supported path is:

```sql
SELECT * FROM archive_plant_events('<plant-uuid>'::uuid, 'why you are deleting it');
-- then clear entity / entity_memory / evidence (all pre-existing RESTRICT), then DELETE the plant.
```

## ROLLBACK

`0r-rollback.sql`, run **constraints first, substrate second** (the file is ordered that way and is
split into two independent transactions — run only the halves you need).

- The `0c` half is **unconditional and lossless**: it restores the three FKs to the exact live
  definitions captured from prod before the change (`SET NULL` on all three). No row was touched, so
  there is nothing to reconcile.
- The `0a` half is **guarded**: it refuses to drop the archive tables while any archived row exists,
  because after `archive_plant_events()` has run those rows are the *only* surviving copy. Restore or
  export first (recipe at the bottom of `0r`), then re-run.

```bash
psql "$PROD" -v ON_ERROR_STOP=1 -f migrations/v4-evtanchordel-001/0r-rollback.sql
```

Rolling back re-opens the bug. It does not create damage.

⚠ **If rolling back PROD while `dev`/CI carry the new test:**
`tests/integration/evt-anchor-delete.int.test.js` pins the three FKs as RESTRICT and CI runs against a
branch off **staging**, so a prod-only rollback leaves CI green. A rollback of *staging* would red it —
revert the test file in the same change. The same applies if staging is ever re-seeded from a
pre-migration prod.

## Follow-up (deliberately NOT in this migration)

1. **`event_log_project_id_fkey` is `ON DELETE CASCADE`.** Hard-deleting a container silently
   destroys every event in it. There is no *contradiction* there, so it is out of scope for this
   ticket — but it is the same history-destroying family and arguably worse, because it fails
   silently rather than loudly.
2. **`plants_project_id_fkey` is `ON DELETE SET NULL`**, so hard-deleting a container silently moves
   its plantings into the project-less arm — handing each to its own `created_by`. Already documented
   as a known authz caveat at `lambda/plants/index.js:364-371` and tracked as a separate FK ticket.
3. **`event_log_has_anchor` is still `NOT VALID`.** All 12,100 prod rows satisfy it, so a
   `VALIDATE CONSTRAINT` would succeed today and is cheap. Left alone here to keep this migration
   strictly about the cascade contradiction — validating a CHECK is its own deploy-boundary decision.
