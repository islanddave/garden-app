# v5-plantprojectfkdrift-001 — the event/planting project rule, written down and brought to staging

Ledger: `BUG-PLANTPROJECTFKDRIFT-001`. Origin: `BUG-EVENTPROJPLANTPAIR-001` (done, 2026-08-21).

**Status: AUTHORED 2026-10-09. Applied nowhere.** Applying to staging and to prod are separate steps, each needing
the owner's yes. See "Apply".

## What was wrong

Prod's database refuses an event that names a planting together with a project that planting is not in. Staging's
does not. The rule was added to prod by hand on 2026-08-21, on Dave's go, as step 3 of the
`BUG-EVENTPROJPLANTPAIR-001` repair (43 such rows had been found and re-anchored). The SQL that ran lives in the
docs repo (`_fleet_20260821/projplantpair-constraint.sql`). It was never copied into `migrations/` and never applied
to staging, although its own closing note said to do both.

Two consequences:

- The integration suite forks staging, so no test runs under the rule. Code that prod would refuse passes CI.
  One test, `tests/integration/anchor-pair.int.test.js`, went further and wrote the forbidden row on purpose.
- No migration in this repo defines the rule. `scripts/check-staging-drift.py` compares constraint and index names,
  so it sees both objects as prod-only; by design it warns and exits 0, and nothing acted on the warning.

## The two objects (prod, catalog read 2026-10-09)

| table | name | definition as the catalog renders it |
|---|---|---|
| `plants` | `plants_id_project_uq`, a UNIQUE **constraint** | `UNIQUE (id, project_id)` |
| | its index | `CREATE UNIQUE INDEX plants_id_project_uq ON public.plants USING btree (id, project_id)` |
| `event_log` | `event_log_plant_project_fk`, validated | `FOREIGN KEY (plant_id, project_id) REFERENCES plants(id, project_id) ON UPDATE CASCADE ON DELETE RESTRICT` |

- The key can never refuse a row (`id` is already the primary key). It exists because a composite foreign key needs
  a unique key on exactly its target columns.
- **MATCH SIMPLE** (the default; the catalog prints nothing for it): a row is checked only when both columns are set.
  An event with no planting, and an event with no project, stay legal. An event with both set whose planting has no
  project is refused.
- **ON UPDATE CASCADE**: moving a planting to another project carries its events with it. With the default, the move
  would fail as soon as the planting had one event. No application path moves a planting, so this fires only for a
  hand-run `UPDATE plants SET project_id`. That includes setting it to NULL, which strips the project from the
  planting's events: see "Known: emptying a container also strips its events' project".
- **ON DELETE RESTRICT**: the same as `event_log_plant_id_fkey`, which already refuses that delete.

`lambda/plants/merge.js` already knows the foreign key: its `SURFACES` map classifies
`event_log (project_id,plant_id)` as `leave` (2026-09-29).

## Known: emptying a container also strips its events' project

Tracked separately as `BUG-PLANTPAIRCASCADENULLSHISTORY-001`. Not introduced on prod by this migration, and not a
reason to change the definition here: the constraint this directory records must equal prod's.

`migrations/v4-plantrehomefk-001/README.md` documents the supported way to empty a container before deleting it:

```sql
UPDATE plants SET project_id = NULL WHERE project_id = '<container-id>';
```

With `event_log_plant_project_fk` present, `ON UPDATE CASCADE` treats that as a move like any other. Every event of
those plantings that carried the container's project has its `event_log.project_id` set to NULL in the same
statement. The events stay, still attached to their plantings, but no longer say which container they happened in.

The second effect follows from the first. `event_log_project_id_fkey` (`ON DELETE RESTRICT`, the "history axis") is
what refuses deleting a container that events still point at. After the re-home none of those plantings' events
point at it, so the `DELETE` that RESTRICT would have refused succeeds. Events logged against the container itself,
with no planting, are not touched by the cascade and still block the delete.

| | re-home, then delete the container |
|---|---|
| without the pair (staging before 0a) | events keep their project; the delete is refused, 23503, `event_log_project_id_fkey` |
| with the pair (prod since 2026-08-21; staging from 0a, `NOT VALID` included) | events' project becomes NULL; the delete succeeds |

- **Prod** has behaved this way since 2026-08-21. Applying this migration to prod changes nothing about it.
- **Staging** starts behaving this way at the commit of 0a, and stops again if 0r is run.
- `CASCADE` cannot tell a move from a detach. Whether a re-home should strip the events' project is the owner's
  question, in that ledger row. Until it is answered, anyone running the re-home `UPDATE` on a container with
  history should expect this.
- Each cascaded row is an `UPDATE` of `event_log`, so the table's update triggers (`set_updated_at`, the audit
  trigger) fire for it (per the pre-apply review; the rehearsal fixture has no triggers).
- No test against the real tables asserts either row of the table (`plant-rehome-fk.int.test.js` re-homes plantings
  that have no events). `rehearse_local.py` section G pins both rows on its fixture, so this is recorded as known.

## What this migration does

One set of files, safe on both environments. Each object is looked up by name in the catalog.

| found | 0a does |
|---|---|
| absent | creates it (the foreign key `NOT VALID`) and writes a `-created-` row saying this migration made it here |
| present, exactly prod's definition | nothing |
| present, anything else | `RAISE EXCEPTION`; the transaction rolls back |

| | prod | staging |
|---|---|---|
| `0a-additive-ddl.sql` | finds both. No `ALTER TABLE`, no DDL lock. Writes one `schema_version` row. | creates both, the foreign key `NOT VALID`. Three rows. |
| `0c-validate.sql` | finds it validated. No `VALIDATE`, no lock. Writes one row. | refuses if row security hides rows from the role running it. Otherwise counts the rows in the way over the whole table. 0: `VALIDATE`, one row. More: refuses with the count; nothing changes. |
| `0r-rollback.sql` | **no-op by design**: no `-created-` row, so nothing is dropped and nothing is deleted. | drops both and clears its four rows. |

No file in this directory reads, changes or deletes an `event_log` or `plants` row, apart from the count in 0c.

"On prod it changes nothing" means exactly: no schema change and no application data. It does write two
`schema_version` rows (`5.0.0-plantprojectfkdrift-001`, `-validate`), which is what arms the standing gates there.

### Locks

Every file sets `lock_timeout = '5s'`: behind a long transaction it fails fast and changes nothing. Run it again.

| statement | where it runs | lock |
|---|---|---|
| `ADD CONSTRAINT ... UNIQUE` (0a) | staging | ACCESS EXCLUSIVE on `plants` while the index builds. Not built `CONCURRENTLY` (that cannot run in a transaction, and the table is small). |
| `ADD CONSTRAINT ... FOREIGN KEY ... NOT VALID` (0a) | staging | SHARE ROW EXCLUSIVE on `event_log` and on `plants`. No scan. |
| `VALIDATE CONSTRAINT` (0c) | staging, only when the count is 0 | SHARE UPDATE EXCLUSIVE on `event_log`, ROW SHARE on `plants`. Reads and ordinary writes continue. |
| `DROP CONSTRAINT` x2 (0r) | staging | ACCESS EXCLUSIVE on `event_log` and on `plants`. |
| anything | prod | no DDL. The only relation lock on `plants` or `event_log` is a momentary ACCESS SHARE on `plants` from `pg_get_indexdef` in 0a (the lock of any `SELECT`; behind another session's ACCESS EXCLUSIVE it waits, up to the 5 s timeout), released before commit. Plus the catalog reads and two single-row inserts into `schema_version`. The gates that call `pg_get_indexdef` take the same momentary lock. |

### NOT VALID is not "off"

`NOT VALID` skips the scan of rows already in the table. It does not skip enforcement: from the commit of 0a, every
insert and every update that changes `plant_id` or `project_id` is checked. That is the protection the integration
suite needs, and it is in place whether or not 0c can validate.

## The integration test (land this before staging is touched)

`tests/integration/anchor-pair.int.test.js` used to create an event, then run
`UPDATE event_log SET project_id = <another project>` to manufacture a mismatch and prove that an edit repairs it.
With the foreign key, that statement is a 23503. In this change:

- **Kept, in the shape the rule still allows:** an event with NO project on a planting that has one. An edit
  re-derives the project from the planting, and the container it arrives at picks it up in the care cache.
- **Retired:** the stale-project fixture and "the container the event LEFT is vacated". Both need a row neither prod
  nor (after this) staging can hold. The vacate arm itself is still covered by the block below it, which moves an
  event off a project onto a project-less planting.
- **Added:** a block that runs only when the fork has the constraint: the same direct write is refused, 23503, by
  name. And one check that runs only when the fork has this migration's stamp: the constraint is there.

The file passes with the constraint and without it, so it can and must reach dev first.

## Is it safe to arm on staging

The house test (`gardening-deploy.md`, "arming a CHECK is NOT backward-compatible"): would the code deployed there
write a row this refuses? Every writer of the pair, read at dev `755099ce725a56ef0483460c0ed0486936ad032f`:

| writer | how it picks `project_id` | under the rule |
|---|---|---|
| `POST /api/events`, `PUT /api/events/:id` | `deriveEventProjectId` (`lambda/events/validators.js`): the planting's | safe |
| `POST /api/events/batch` | `SELECT p.container_id ... p.id` from the planting row | safe |
| planting status change (`lambda/plants/index.js`) | `_projectId` read from the same planting | safe |
| project status change (`lambda/projects/index.js`) | `plant_id` is NULL | not checked |
| nightly rain rows (`lambda/daily-plan/handler.js`) | `ct.id, gn.id` with `ct` joined `ON ct.id = gn.container_id` | safe |
| planting merge (`lambda/plants/plantMemoryRepoint.js`) | rewrites `plant_id` only; `merge.js` step 2b refuses a group not all in the winner's project | safe |

The derivation reached dev on 2026-08-20 (`94926010`). **What staging's Lambdas are running was not read at
authoring**; `gates.yml` carries it as a manual pre gate. An older artifact would answer 400 on a mismatched write
rather than store it.

Every direct `INSERT INTO event_log` under `tests/` was read (19 files; 12 of them write both columns), and every
direct `UPDATE` of `event_log.plant_id`, `event_log.project_id` or `plants.project_id`: each uses a planting and that
planting's own project, or leaves one of the two NULL. The only row the rule refuses was
`anchor-pair.int.test.js:126`. `tests/integration/plant-rehome-fk.int.test.js` runs
`UPDATE plants SET project_id = NULL` on plantings that have no events, so nothing cascades there.

## Apply

Each apply is a database write and needs the owner's yes at the time: staging first, then prod. URLs come from
`garden-app/.env.local` by key name, never on a command line. 0a, 0c and 0r write `schema_version`, which is
owner-write only: run them under the owner DSN. Run from a checkout that contains this directory.

**Order matters, and it is not the usual one.** The reworked test must be on dev before staging gets the constraint;
otherwise the next push by anyone runs the old test against a fork that refuses its fixture. Pushing this directory
first is safe: every continuous gate arms itself on a stamp, so an unapplied database cannot turn
`gate-invariants.yml` red.

### Conditions (each is a stop, not advice)

A red Integration run on dev HEAD, or a red smoke inside a promote, refuses every session's promote. Staging is
shared, so the window between 0a and the first green run under the constraint is everyone's.

**Before this branch goes to dev**

- Push the lane ref as its own branch (not dev) and dispatch `integration-test.yml` on it. A run on a non-dev SHA
  cannot block dev. Required: green, with `tests/integration/anchor-pair.int.test.js` at **10 passed, 5 skipped**
  (15 cases; the five skipped are the stamp check and the four in the foreign-key block, which need the constraint
  on the fork). Only then push the same SHA to dev. The reworked file has never run against the real handlers.
- A push that touches `migrations/**` makes `gate-invariants.yml` run the whole corpus against prod and staging
  from the pushed SHA. Unapplied, every continuous gate here is vacuous or PASS. Watch that run: no new red.

**Before step 3 (0a on staging)**

- `python3 scripts/staged-promote.py check` exits 0, and no promote is in flight. If either is not so, wait.
- Step 2's `pre_row_security_does_not_hide_rows_from_this_role` is PASS under the DSN the apply will use.
- Say in the session log that staging is about to get the constraint. An unmerged lane whose integration test
  still writes a disagreeing pair goes red on its next push; that is the rule working, and it should not read as
  someone else's breakage.

**Immediately after step 3**

- Dispatch `integration-test.yml` on dev HEAD (step 3a). Required: green, with anchor-pair at **15 passed**, none
  skipped.
- If it is red for a constraint reason (a 23503 naming `event_log_plant_project_fk`, or anything else that traces
  to the two new objects): run `0r-rollback.sql` on staging at once, then re-run that same run. A red dispatched
  run on dev HEAD refuses promotes until it is re-run green.
- If it is red for another reason, the constraint stays; treat the red as its own problem.

```bash
# 0. This change is on dev and the Integration workflow is green on it. (The foreign-key block is skipped there:
#    anchor-pair 10 passed, 5 skipped.) The lane-ref run under "Conditions" came first.

# 1. offline. Expect "OK: 141 gate file(s), 1872 gate(s)" at this commit (the corpus count moves with dev), and
#    "91/91 checks hold".
python3 scripts/gate_runner.py --all --env prod --validate-only
python3 migrations/v5-plantprojectfkdrift-001/rehearse_local.py     # throwaway local Postgres, no network

# ---- STAGING ---------------------------------------------------------------------------------------
# 2. Conditions first: no promote staged or in flight.
python3 scripts/staged-promote.py check
#    read-only. pre: 3 PASS, 1 not applicable (the prod gate), 1 MANUAL (do it: which build staging's Lambdas run).
#    pre_row_security_does_not_hide_rows_from_this_role must be PASS under THIS DSN: it is the one 0c will use.
python3 scripts/gate_runner.py --migration migrations/v5-plantprojectfkdrift-001 --env staging --phase pre
#    sweep: PASS, or FAIL with a count. A FAIL does not block step 3. It means step 4 will refuse.
python3 scripts/gate_runner.py --migration migrations/v5-plantprojectfkdrift-001 --env staging --phase sweep
#    post, dry run: require ZERO ERROR. Expected: the two receipts FAIL, everything else PASS or not applicable.
python3 scripts/gate_runner.py --migration migrations/v5-plantprojectfkdrift-001 --env staging --phase post

# 3. 0a. Must print two "CREATED" notices; the foreign key shows valid = f; three schema_version rows.
psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-plantprojectfkdrift-001/0a-additive-ddl.sql

# 3a. AT ONCE: Integration on dev HEAD, under the constraint. Required green, anchor-pair 15 passed.
#     Red for a constraint reason: run 0r (the command in "Rollback") now, then re-run THIS run.
gh workflow run integration-test.yml --ref dev

# 4. 0c. Either "VALIDATED", or it refuses with a count and psql exits non-zero. Both are acceptable outcomes.
#    A refusal that says "row security is active" is NOT one of them: wrong role, see "If 0c refuses".
psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-plantprojectfkdrift-001/0c-validate.sql

# 5. post. Validated: 6 PASS, 1 not applicable. Refused: the same with post_validation_recorded FAIL.
python3 scripts/gate_runner.py --migration migrations/v5-plantprojectfkdrift-001 --env staging --phase post

# 6. rehearse the rollback, then put it back. After 0r: no constraint rows, no schema_version rows, pre green.
psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-plantprojectfkdrift-001/0r-rollback.sql
python3 scripts/gate_runner.py --migration migrations/v5-plantprojectfkdrift-001 --env staging --phase pre
psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-plantprojectfkdrift-001/0a-additive-ddl.sql
psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-plantprojectfkdrift-001/0c-validate.sql   # as step 4

# 7. whole corpus on staging: no new red.
python3 scripts/gate_runner.py --all --env staging --phase post --continuous-only

# 8. Integration on dev again, now that step 6 dropped and re-created the constraint (dispatch as in 3a). In
#    anchor-pair.int.test.js the foreign-key block RUNS instead of being skipped (15 passed), the suite is green.

# ---- PROD (the owner's yes for this apply; not between 07:00 and 08:00 UTC) ---------------------------
# 9. read-only. pre: 4 PASS, 1 MANUAL (staging-only, nothing to do). If
#    pre_prod_already_carries_both_and_the_apply_changes_nothing fails: STOP. Prod is not what this was written against.
python3 scripts/gate_runner.py --migration migrations/v5-plantprojectfkdrift-001 --env prod --phase pre
#    post, dry run: ZERO ERROR; the two receipts FAIL, five PASS.
python3 scripts/gate_runner.py --migration migrations/v5-plantprojectfkdrift-001 --env prod --phase post

# 10. 0a. Must print two "is already here" notices and NO "CREATED"; valid = t; exactly ONE schema_version row.
psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-plantprojectfkdrift-001/0a-additive-ddl.sql

# 11. 0c. Must print "already validated here. No VALIDATE issued, no lock taken."; two schema_version rows.
psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-plantprojectfkdrift-001/0c-validate.sql

# 12. post: 7 PASS. Then the whole corpus on both.
python3 scripts/gate_runner.py --migration migrations/v5-plantprojectfkdrift-001 --env prod --phase post
python3 scripts/gate_runner.py --all --env prod --phase post --continuous-only
python3 scripts/gate_runner.py --all --env staging --phase post --continuous-only

# 13. once: the same gates under the CI secret's role, not only the local DSN. Expect green on both environments.
gh workflow run gate-invariants.yml --ref dev
```

**A "CREATED" notice on prod in step 10 means a constraint was missing there.** The transaction has committed and prod
now carries a `-created-` row. Do not run 0r. Find out what dropped the constraint; `post_prod_carries_no_created_row`
stays red until a person has decided.

A pre-apply copy of prod is not needed while the prod pre gate passes, because no DDL runs. If one is wanted anyway,
make it with `scripts/neon_safety_branch.py` so it carries an expiry.

### After staging is applied, also check

```bash
python3 scripts/check-staging-drift.py          # the two constraints and the index are no longer listed as prod-only
NEON_DATABASE_URL="$NEON_STAGING_URL" python3 scripts/merge-surface-inventory.py   # exit 0
```

The second is not in CI. By reading it, it exits 1 against staging today ("policy entries with no matching live
column": `event_log.project_id,plant_id`) because `merge.js` classifies a foreign key staging does not have. It was
not run at authoring.

## If 0c refuses

**If the message says "row security is active":** this is not about rows in the way. The role running the file
cannot see every row of `event_log` or `plants`, so its count would be of the visible rows only, and a count of 0
would mean nothing (rehearsed: a table owner under `FORCE ROW LEVEL SECURITY` counted 0 with three rows in the way,
and without this check 0c validated). Run it as the owner of both tables, or a role with BYPASSRLS. If the owner
itself is refused, the tables have `FORCE ROW LEVEL SECURITY`; that is a finding for the owner, not something to
switch off for the apply. Nothing was changed.

**Otherwise** it prints how many rows are in the way and changes nothing. The count, over every row, soft-deleted included (the
all-row sweep rule: `VALIDATE` reads them too):

```sql
SELECT count(*)
  FROM public.event_log e
 WHERE e.plant_id IS NOT NULL
   AND e.project_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.plants p
                    WHERE p.id = e.plant_id AND p.project_id = e.project_id);
```

The rows themselves:

```sql
SELECT e.id, e.plant_id, e.project_id AS event_project_id, p.project_id AS planting_project_id,
       e.event_type, e.event_date, e.created_by, e.deleted_at
  FROM public.event_log e
  LEFT JOIN public.plants p ON p.id = e.plant_id
 WHERE e.plant_id IS NOT NULL
   AND e.project_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.plants q
                    WHERE q.id = e.plant_id AND q.project_id = e.project_id)
 ORDER BY e.created_at;
```

Staging then stands at: constraint present and enforcing new writes, `NOT VALID`, no `-validate` stamp. That is a
safe place to stay. The integration suite has the protection it needs, the weekly gate run is green, and
`check-staging-drift.py` (which compares names) reports no difference. The one recorded difference from prod is
`convalidated`. One thing does stop working there: a planting merge whose losing planting has one of those rows is
refused (the repoint rewrites `plant_id` only, the row becomes the winner with the wrong project, 23503, the handler
answers 400) until the rows are dealt with.

What to do with the rows is the owner's decision and is not part of this migration: leave them; repair them (set
each event's project to its planting's, which is what the 2026-08-21 repair did on prod); or remove them as test
debris. Afterwards, run 0c again. Do not edit the count, add a `deleted_at` filter, or drop and re-add the constraint
to get past it.

## Rollback

```bash
psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-plantprojectfkdrift-001/0r-rollback.sql
python3 scripts/gate_runner.py --migration migrations/v5-plantprojectfkdrift-001 --env staging --phase pre
```

0r drops a constraint only while the `-created-` row for it exists, and only if it still has the definition this
migration records. It never uses CASCADE.

- **Staging:** both constraints go, and the four `schema_version` rows with them. Staging stops refusing mismatched
  events again, so the integration suite loses the protection. The test file needs no change.
- **Prod: a no-op, by design.** Prod's constraints predate this migration, so there is no `-created-` row and 0r
  returns before it touches anything, the stamps included. This directory offers no way to remove the rule from
  prod. That would be its own decision and its own migration.
  It also means no file here disarms the standing gates on prod. If one ever reds there after 0a has armed it, the
  only ways out are a hand `DELETE` of the stamp or a change to `gates.yml`, and the scheduled run reads main's
  copy, so the second is a promote. The prod pre gate checks the same strings before arming, which keeps this
  small; step 13 shows the CI role renders them the same way.

No code needs to be rolled back either way: nothing deployed depends on the constraint being absent.

## The standing gates, and what would turn them red

- **`post_unique_key_is_prods`**, **`post_foreign_key_is_prods`** (armed on 0a's stamp). Red if either constraint is
  dropped, re-created with another definition (a foreign key without `ON UPDATE CASCADE` is the likely one), or the
  key becomes a bare index. The foreign-key gate accepts `NOT VALID`.
- **`post_foreign_key_is_validated`**, **`post_no_event_names_a_project_its_planting_is_not_in`** (armed on 0c's
  stamp). Red if the foreign key is re-added `NOT VALID`, or a mismatched row appears despite it, which takes a
  restore or bulk load with triggers off. Vacuous on a staging where 0c refused.
- **`post_prod_carries_no_created_row`** (prod only). Red if 0a ever had to create a constraint on prod.

Two known blind spots, both left as they are (see "Review follow-up"): the sweep and the data gate count the rows
the runner's role may see, so under row security they can pass with rows in the way (the pre gate says so for the
apply; nothing says so for the scheduled run); and `post_prod_carries_no_created_row` passes if `schema_version`
is unreadable to the runner.

## Verification at authoring (2026-10-09)

No staging or prod connection was made. What was run:

- `rehearse_local.py`, on a throwaway local PostgreSQL 17.10 (unix socket, no listener, deleted on exit): the three
  shipped SQL files through `psql` and the shipped `gates.yml` through `scripts/gate_runner.py`, against a small
  fixture. 75/75 checks. It covers a prod-like database (the 2026-08-21 statements, then 0a, 0c and 0r: same
  constraint oids, no row touched, one stamp per file, 0r changes nothing), a clean staging, a staging with three
  rows in the way (one soft-deleted), nine "same name, different definition" cases that 0a must refuse, the
  rollback's mixed cases, and a pooled connection arriving with an empty `search_path`.
- 26 single-edit mutants of the SQL files and `gates.yml`, each run through the rehearsal: 25 killed. The one that
  survives drops `c.convalidated` from the prod pre gate, which is equivalent: the catalog's definition string
  already carries `NOT VALID`.
- `lambda/events/plantprojectfk-migration.static.test.js` (25 cases) pins the definitions in every file here to the
  three strings above, and the shape of each file: nothing skipped by name alone, nothing validated blind, no row
  deleted, no drop outside its `-created-` branch. 72 single-edit mutants of the files it reads: 72 killed.
- The 101 unit test files that read `migrations/` or a `gates.yml`, plus `lambda/events` and `scripts/ci-telemetry`:
  4037 tests, 0 failed. ESLint clean on the two changed JavaScript files.
- `gates.yml`: PyYAML load, `yamllint -d relaxed` (line-length warnings only, as in the rest of the corpus),
  `gate_runner.py --all --env prod --validate-only`, and `python3 -m pytest scripts/test_gate_runner.py
  scripts/test_count_ratchets.py` (77 passed).
- `tests/integration/anchor-pair.int.test.js` was NOT run: the integration suite needs a fork of staging. Step 0 and
  step 8 of "Apply" are its first two runs, without and with the constraint.

What the rehearsal cannot show, and the apply must:

1. That prod's catalog still reads as the three strings above. Step 9's prod pre gate checks exactly this.
2. Staging's count of rows in the way. Step 2's sweep.
3. Which build staging's Lambdas run. Step 2's manual gate.
4. That the real tables' triggers do not interfere. The fixture has none. Prod has run with the constraint since
   2026-08-21, which is the evidence for the app; staging's first Integration run (step 8) is the evidence there.
5. That the integration suite is green with the constraint. It cannot run without a database. Step 8.

## Review follow-up (2026-10-09, pre-apply review)

Still no staging or prod connection. Changed after the review, and re-run locally:

- **Row security.** 0c refuses before its count when `row_security_active()` is true for `event_log` or `plants`;
  `gates.yml` gained `pre_row_security_does_not_hide_rows_from_this_role` (both environments). The review's finding
  was reproduced: with the check removed, a non-superuser owner under FORCE got "0 rows would fail; VALIDATED" with
  three rows in the way. Whether either environment forces row security on these tables is NOT known (it needs a
  connection); the pre gate answers it for the apply role.
- **`rehearse_local.py`: 91/91** (was 75): section F (row security: owner, another role, FORCE on both and on each
  table alone, a superuser, the clean and the already-validated paths) and section G (the re-home, with and
  without the pair).
- **Static test: 28 cases** (was 25): the row-security check and its gate, and the two README sections above.
- The mutation counts in the section above (26 and 72) are from authoring and were not re-run. One new mutant was:
  0c without the row-security check fails 5 of the 91.
- Apply conditions, the re-home section, the lock wording, the merge sentence, the prod-stamps note and the two
  post-push/post-apply dispatches were added to this file.

Left as they are, with the reason:

- **0r binds a `-created-` row to the constraint's oid** (so a copied or hand-typed row authorises nothing). A
  change to what 0a writes and what 0r decides on, with its own rehearsal and mutants. The bad path needs two human
  errors, and the prod pre gate is red before the first. Optional before prod.
- **`pre_schema_version_readable`, and a fail-closed form of `post_prod_carries_no_created_row`.** New gate SQL on
  the standing prod gate, and the rehearsal fixture's `schema_version` starts empty. Not a comment-level change.
- **Row security in the sweep and the standing data gate.** Same blind spot as 0c's count had; making them fail
  under row security changes what the weekly run can red on, under a role that was not read.
- **A cross-reference from `migrations/v4-plantrehomefk-001/README.md`** to the "Known" section here: another
  migration's file.
- **The branch base.** This branch was cut from dev `755099ce`; dev has moved. Not rebased here; the rebase happens
  at push time, and the static test, the pytest pair and the corpus count in step 1 are re-run then.

## Not in scope, noticed

- `scripts/revert-to.py` fails its rehearsal on `plants` for a related reason (the restore target starts as a copy of
  today's prod). This migration does not fix that; see `OPS-REVERTRESTORE-001`.
- `scripts/check-staging-drift.py` compares names, not definitions. Once staging has both names it reports "in sync"
  whatever the definitions are. The gates above are what compare definitions.
- No test exercises `ON UPDATE CASCADE` against the real tables. The rehearsal does, on its fixture (a move, and
  the move to NULL in section G).
