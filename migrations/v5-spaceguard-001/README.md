# v5-spaceguard-001 — spaces audit, coordinate freeze, no cascade loss off a Space

Multi-space Phase 1, steps 1.1, 1.2 and 1.3b. Ledger **V5-SPACEREPOINTGUARD-001** (1.1, 1.2) and
**V4-SPACESOFTDEL-001** (1.3). Build sheet: `project-state/_multispace-20261015/multispace-phase1-buildsheet-V203-20261016.0915.md`
§2 and §3R (§3R wins). Stamp **`5.1.5-spaceguard-001`**, written by 0a in the same transaction as the DDL; every
standing gate self-arms on it.

| file | what it does |
|---|---|
| `0a-guards.sql` | One transaction: `public.audit_stmt_insert()`, three audit triggers on `spaces`, one baseline audit row per existing Space, `spaces_repoint_guard`, `spaces_delete_guard`, three BEFORE TRUNCATE guards, the stamp. |
| `0r-rollback.sql` | Drops the eight triggers and four functions in reverse and deletes the stamp. Refuses while any foreign key from `plants`/`plant_projects` to `spaces` exists, or while another trigger calls `audit_stmt_insert()`. |
| `gates.yml` | 8 `pre`; 17 `post` (16 standing, 1 apply-window receipt). |
| `rehearse_local.py` | The whole rehearsal on a local PostgreSQL 17 replica (below). |

Nothing here changes what any user sees, and nothing creates a second Space.

## What 0a adds

* **1.1 C-AUDIT.** `trg_audit_spaces_upd` (AFTER UPDATE, statement, `audit_stmt_update_no_soft_delete('name',
  'postal_code', 'weather_lat', 'weather_lng', 'featured_photo_id', 'created_by')`), `trg_audit_spaces_del`
  (`audit_stmt_delete()`), `trg_audit_spaces_ins` (the NEW `audit_stmt_insert()`). The _no_soft_delete writer because
  `spaces` has no `deleted_at` (bound to `audit_stmt_update` it raises 42703, swallowed as a WARNING: reproduced in the
  rehearsal). Every column but `id`, `created_at`, `updated_at` is watched; `created_by` too (sheet P16).
  `audit_stmt_insert()` is `audit_pv_stmt_insert()`'s body under its own name: the same error contract as every shared
  audit writer. It is never an INSERT arm on the shared update/delete writers (`v4-harvestaudit-001`
  `post_no_insert_arm_was_added`). One baseline row per existing Space (action `UPDATE`, before = after = the row, actor
  `migration:v5-spaceguard-001`), written only for a Space with no `spaces` audit row at all, so a re-apply writes none.
* **1.2 C-GUARD.** `spaces_repoint_guard`, `BEFORE UPDATE OF weather_lat, weather_lng, postal_code` FOR EACH ROW:
  P0001 `spaces_repoint_guard: …` when the triple changes (`IS DISTINCT FROM`) while any `weather_daily` or
  `weather_cold_range` row names the Space. The OF list is a recorded dependency: `ALTER TABLE spaces DROP COLUMN
  weather_lat` refuses (2BP01, rehearsed).
* **1.3b C-BLOCK.** `spaces_delete_guard`, BEFORE DELETE FOR EACH ROW: walks every foreign key whose referenced table is
  `public.spaces` (catalog joins, read at each delete) and raises P0001 `spaces_delete_guard: space … still has rows in
  public.<table> (foreign key …)` when any row, soft-deleted or not, names the Space. Single-column keys on `spaces.id`
  only; any other shape raises naming the key. BEFORE TRUNCATE FOR EACH STATEMENT on `spaces`
  (`spaces_truncate_guard`), `weather_daily` and `weather_cold_range`: always P0001.

Function bodies are schema-qualified, pin `search_path = pg_catalog, public`, never write, and never contain a delete
statement naming `plants` or `plant_projects` (the global prosrc gates `v4-plantrehomefk-001` / `v4-parentprojfk-001`).
All four functions are in `public` (restore-verify hard-compares the gv function inventory).

## The writers of `spaces` and the audit row each leaves (sheet P15 + DSA MINOR)

At garden-app 51a97146. Proven on the rehearsal (SQL of each writer, verbatim) and by
`tests/integration/spaces-guards.int.test.js` (the real photos Lambda), each delta scoped to the Space and the action.

| writer | statement | audit row | actor |
|---|---|---|---|
| upload auto-promote | `lambda/photos/index.js:180` | 1 UPDATE | `system` |
| PUT `/api/photos/space-featured/:id` | `lambda/photos/index.js:844` | 1 UPDATE (0 for a same-hero PUT: only `updated_at` moves) | `system` |
| photo soft delete clears the hero | `lambda/photos/photoDelete.js:122`, after `set_config('app.actor_clerk_sub', …)` at `:211` | 1 UPDATE | **the user** |
| photo restore replays the hero | `lambda/photos/photoDelete.js:328` | 1 UPDATE | `system` |
| hard photo DELETE (`spaces.featured_photo_id … ON DELETE SET NULL`) | RI action | 1 UPDATE | `system` |
| a new Space / a deleted Space | tests and scripts only | 1 INSERT / 1 DELETE | `system` unless set |

No deployed code writes `weather_lat`, `weather_lng` or `postal_code`, and none DELETEs or TRUNCATEs `spaces`,
`weather_daily` or `weather_cold_range` (`git grep`; DSA "checked, no finding"). So no deployed writer can meet a guard.

## Escape templates (never in a function body)

**Moving a Space under its weather history (1.2)** — one explicit transaction, with Dave's approval, recorded:

```sql
BEGIN;
SELECT set_config('app.actor_clerk_sub', 'migration:<dir>', true);
ALTER TABLE public.spaces DISABLE TRIGGER spaces_repoint_guard;   -- THIS trigger only, never USER or ALL
UPDATE public.spaces SET weather_lat = <lat>, weather_lng = <lng>, postal_code = '<zip>' WHERE id = '<space id>';
ALTER TABLE public.spaces ENABLE TRIGGER spaces_repoint_guard;
DO $x$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger g JOIN pg_class t ON t.oid = g.tgrelid JOIN pg_namespace n ON n.oid = t.relnamespace
                  WHERE n.nspname = 'public' AND t.relname = 'spaces' AND g.tgname = 'spaces_repoint_guard' AND g.tgenabled = 'O') THEN
    RAISE EXCEPTION 'spaces_repoint_guard not re-enabled';
  END IF;
END $x$;
INSERT INTO public.schema_version (version, description) VALUES ('<stamp>', '<ledger id>: <why>; approved by Dave <date>');
COMMIT;
```

`trg_audit_spaces_upd` stays on, so the move is audited with the migration actor and
`post_space_coordinates_match_newest_audit` stays green (rehearsed). `DISABLE TRIGGER USER`/`ALL` would hide the move
from the audit, and that gate reds on it (rehearsed: its positive control).

**Deleting a Space (1.3b)** — there is no switch. Remove the children first, deliberately, per referencing table
(`DELETE FROM public.<table> WHERE <column> = '<space id>'`), then the Space. Integration teardown does exactly this
(`tests/integration/_cleanup.js`, `season-stats.int.test.js`) and is held to never DISABLEing a spaces or weather trigger
by `src/__tests__/integrationCleanupTriggers.static.test.js`.

**TRUNCATE** — none in normal operation; delete by key. A weather DELETE is detected by the count gates below.

## Prerequisite on dev AND main: the code piece (step 1.3a, released as v5.2.2, dev `3b22dd9c`)

The code piece is these hunks, all reachable from dev `3b22dd9c`: `tests/integration/_cleanup.js` (`NS_SPACES` and the
weather/theme residue probes, commit `bc2daf09`), `tests/integration/season-stats.int.test.js` (own weather-row delete
and `settle()` assertion), `src/__tests__/integrationCleanupTriggers.static.test.js` (no DISABLE of a guarded trigger,
no DROP TRIGGER on a guarded table, no DROP FUNCTION of a guard) and `migrations/v5-wxcoldband-001/gates.yml`
(`post_no_trigger_and_no_row_security` tolerant of `weather_cold_range_truncate_guard`).

* `tests/integration/_cleanup.js` deletes a fixture Space's `weather_daily`, `weather_cold_range` and `spacetheme` rows
  before the Space, and probes the residue of all four; `season-stats.int.test.js` deletes its own weather rows and
  asserts its `settle()` returned `[]`. The integration suite forks staging, so this must be on dev before 0a reaches
  staging. The first dev push after the staging apply is the real positive control (a misordered landing shows as
  FIXTURE LEAK, not as a silent leak).
* **1.3a is ONE-WAY once this is applied:** reverting it (or a forward-undo past it) makes integration teardown leak.
  `scripts/revert-floors.json` carries it: floor `v5.2.2`, since `v5.2.3` (the release that ships this directory).
* `v5-wxcoldband-001/gates.yml` `post_no_trigger_and_no_row_security` is written tolerant: no non-internal trigger
  other than `weather_cold_range_truncate_guard` pinned by tgname, tgtype 34 and tgfoid→proname `guard_space_truncate`.
  Green before and after this DDL (read-only check on prod and staging 2026-10-16: 9/9 PASS each), and red on a second
  trigger, a rename, a re-type or a re-point (rehearsed). It must be **on main** before 0a reaches EITHER env (staging
  or prod): the Tuesday gate-invariants cron runs main's copy against both `--env prod` and `--env staging`. Without
  it, the rehearsal shows exactly that gate going newly red. Hard precondition: main's
  `migrations/v5-wxcoldband-001/gates.yml` contains `weather_cold_range_truncate_guard`; if not, no 0a on either env.

## Apply (a DDL sitting; Dave's first-hand OK naming this migration and both envs)

Window: **never at :55-:05** (daily-plan's hourly run writes `weather_daily`). **Prod 0a only after today's scheduled
restore-verify run has completed** (`gh run list --repo islanddave/garden-app --workflow restore-verify.yml -L1`) **or
before today's backup.yml run has started.** The scheduled jobs run hours after their cron strings (backup seen
11:59-14:41Z, restore-verify 13:02-17:26Z), so a fixed clock window protects nothing; between that day's backup and
that day's restore-verify, 0a reds the daily leg (see below). 0a and 0r each `SET LOCAL lock_timeout = '5s'`: a 55P03
changed nothing; run it again. A RE-RUN of 0a with the triggers already present takes ACCESS EXCLUSIVE on `spaces`,
`weather_daily` and `weather_cold_range` (each `DROP TRIGGER IF EXISTS` of a present trigger), held to COMMIT, so
readers queue behind it: a re-run belongs in the same window. A first apply takes SHARE ROW EXCLUSIVE only.

1. Prod safety copy first: `python3 scripts/neon_safety_branch.py --env-file .env.local list`, then
   `… create --slug ms1` (constant per-day slug, sheet §3R).
2. Staging: `gate_runner.py --migration migrations/v5-spaceguard-001 --env staging --phase pre` → `--phase post`
   (vacuous) → `psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-spaceguard-001/0a-guards.sql` →
   `--phase post` (all, receipt included) → 0r → `--phase pre` → 0a → `--phase post` → `--all --phase post
   --continuous-only` compared with the run before the apply (newly red must be empty).
3. Prod: `--phase pre` → 0a → `--phase post` → `--all --phase post --continuous-only` (newly red empty).
4. Push this directory.

**Staging note.** The staging Space has NULL coordinates and one `weather_cold_range` row, so the freeze is live there
too: setting coordinates on staging needs the escape template.

## Expected red elsewhere: restore-verify's snap leg (RIA I2)

`scripts/restore-verify.py` hard-compares the live public triggers with the restored dump's (`:601-624`). From the
prod apply until the next promote writes a fresh `db/snap-*`, the **snap leg is red, naming only this migration's
triggers** on `spaces`, `weather_daily` and `weather_cold_range`. Write that into the sitting record and promote soon
after. The daily leg restores the newest `db/garden-*` dump and hard-fails on a live trigger missing from it, so it
stays green only if the prod 0a lands after that day's scheduled restore-verify run has completed or before that day's
backup.yml run has started (the window rule above). The durable fix (compare against a trigger list written beside the
dump) is a follow-up, not Phase 1.

**Integration-test note.** `tests/integration/spaces-guards.int.test.js` runs its `TRUNCATE public.weather_*` cases
inside a forced-rollback transaction; the TRUNCATE takes ACCESS EXCLUSIVE before the BEFORE TRUNCATE guard raises, on
the shared fork while parallel files (season-stats) touch `weather_daily`. A short lock queue and a small flake risk,
accepted.

## Rollback and its order (sheet §3R, DSA I6)

**0r order across Phase 1: M3 → M2 → M1** — `v5-platformoperators-001` / `v5-tenantgates-001`, then `v5-spacefk-001`,
then this directory.

* This 0r **refuses while any foreign key from `plants` or `plant_projects` to `spaces` exists**: with them in place,
  `spaces_truncate_guard` is all that keeps `TRUNCATE spaces CASCADE` off the garden (rehearsed with M2-shaped keys:
  0r refused, nothing dropped; both `TRUNCATE … CASCADE` controls still refused).
* A later `platform_operators` migration (M3, step 1.16) uses **`audit_stmt_insert()`** for its audit trigger. This 0r
  refuses while any trigger other than `trg_audit_spaces_ins` calls it (rehearsed), and its `DROP FUNCTION` has no
  CASCADE in any case.
* **Fermentpath ordering:** `v5-fermentpath-001/0r-rollback.sql:175` drops `audit_stmt_update_no_soft_delete()` without
  CASCADE, which fails while `trg_audit_spaces_upd` depends on it. Run THIS 0r before fermentpath's (also written in
  `migrations/v5-fermentpath-001/README.md`). The same holds for `v4-harvestaudit-001/0r-rollback.sql`
  (`audit_stmt_delete()`, `trg_audit_spaces_del`).
* Audit rows stay: the baseline and every row the triggers wrote are history. A re-apply writes no second baseline. A
  coordinate change made while this is rolled back is not audited, and after a re-apply
  `post_space_coordinates_match_newest_audit` reds on it, on purpose.

## Gates

Pre (run right before 0a; the three that 0a makes false are `continuous: false`): not applied, names free, `spaces` has
only `prevent_ownership_transfer`, no `deleted_at` on `spaces`, the shared writers present (SECURITY DEFINER, pinned
path), `audit_events_action_check` admits INSERT, every FK into `spaces` single-column on `id`, the weather tables present.

Post (each self-armed on the stamp; trigger inventories filter `NOT tgisinternal` and assert `tgenabled = 'O'`):
`post_schema_version_recorded` (armed on the objects); the six spaces triggers exact (tgtype, function, OF columns,
enabled); closed world on `spaces`; both weather truncate guards; the four functions pinned by `md5(prosrc)`, definer bit
and search_path; transition tables; `audit_stmt_insert` only on AFTER INSERT statement triggers (any table); the
deleted_at port tripwire; watched columns exist; column classification complete (ignored: `id`, `created_at`,
`updated_at`); a starting audit row for every Space older than the apply (the baseline, or its INSERT row if it was
made while the triggers were on and a 0r -> 0a cycle moved `applied_at` past it); **the 1.2 data gate**; FKs into `spaces`
single-column; the weather count gates; the apply-window receipt.

**1.2 data gate** (`post_space_coordinates_match_newest_audit`, RIA I6): each Space's `(weather_lat, weather_lng,
postal_code)` equals the `after_jsonb` of its newest `spaces` audit row (INSERT or UPDATE); no audit row is a finding.
The triple only: a same-hero PUT moves `updated_at` and writes no audit row, and the gate stays green (rehearsed; a
whole-row compare would red there). Rows of one transaction share `ts`, so a Space matches if any row of its newest
group does.

**Weather count gates** (per env; baselines read read-only 2026-10-16 ~10:00 ET): prod `weather_daily` for Space
`…0001` ≥ 159 rows with the oldest day ≤ 2026-05-10; prod `weather_cold_range` ≥ 3 with the oldest night ≤ 2026-10-14;
staging `weather_cold_range` ≥ 1, oldest night ≤ 2026-10-14. Staging has 0 `weather_daily` rows, so it has no
`weather_daily` gate until it has rows. The oldest day is pinned as an **upper bound**, not an equality: a Phase 3
backfill of older days moves it earlier and must not red; deleting the oldest days moves it later and does. No
contiguity form (a missed hourly run would red it). A DELETE inside the range is detected only while the count is below
the baseline: detection, not prevention, by design (test cleanup must delete weather rows).

**Gate pre-scan (C-CONV).** Exactly one existing gate reds on this DDL: `v5-wxcoldband-001` `post_no_trigger_and_no_row_security`.
Amended tolerant in the code piece (above). Rehearsed as a set difference (`--all --phase post --json` before and after
the DDL on the same replica): newly red = {} with the amendment; = {that gate} with the base corpus at 51a97146.

## Rehearsal

Local PostgreSQL 17.10 only (`initdb … -A trust`, 127.0.0.1:55441). Replica: prod's `pg_dump --schema-only -n public -n gv
-n extensions` (read-only, `garden_ro`), prod's 180 `schema_version` rows and the `spaces` (1), `spacetheme` (1),
`weather_daily` (159) and `weather_cold_range` (3) rows as data (`pg_dump --data-only --enable-row-security`, loaded with
`session_replication_role = replica`), `CREATE EXTENSION pgcrypto, "uuid-ossp"`, and a stub `photos` row for the
Space's featured photo. Then:

```bash
git archive 51a971462daac2c5dc2fa6ef34dd9f7e1a919836 scripts/gate_runner.py migrations | tar -x -C <scratch>/basecorpus
python3 migrations/v5-spaceguard-001/rehearse_local.py --port 55441 --base-db rehearsal --base-corpus <scratch>/basecorpus
```

**Result 2026-10-16: 83/83 PASS, exit 0.** Pre 8/8; post before the apply none red (vacuous; run as `--env prod`, so
16 PASS + the staging-only gate n/a); 0a exit 0; post none red, receipt included (the three pre receipts red after it,
as designed); C-CONV newly red {} (tree) / {wxcoldband gate} (base corpus); every 1.1
writer with its actor, INSERT/DELETE deltas, same-value and unwatched 0, multi-row; mutants: `audit_stmt_update` bound
(delta 0, 42703 WARNING), `audit_stmt_insert` raising (INSERT lands, delta 0, WARNING), no REFERENCING (delta 0); 1.2:
value→value, →NULL, NULL→, cold-range-only, ON CONFLICT, multi-row all P0001; same-value, other columns, no-history move
pass; mutants `<>`, dropped cold-range EXISTS, dropped trigger each killed; DROP COLUMN weather_lat 2BP01; data gate:
green, same-hero green, trigger-off move red, escape template green, no-audit-row red; 1.3b: only-child for each of the
four referencing tables refused with the child kept, a soft-deleted child refuses, childless deletes, the real Space
refuses, a later FK covered, a two-column FK trips, guard dropped → CASCADE (killed); `TRUNCATE spaces CASCADE`,
`TRUNCATE photos CASCADE`, both weather tables refused (and again with M2-shaped keys); all three truncate guards dropped
→ TRUNCATE empties spaces (killed); a gate-level red for each of ten committed mutants; the tolerant wxcoldband gate red
on four mutants; 0r refusals (M2 keys; a foreign `audit_stmt_insert` trigger); 0r exit 0 with the catalog identical to
before; 0a twice more, the catalog identical each time with one baseline row; a further 0r → 0a with a Space made
while the triggers were on and one made while they were off (a baseline for the second only; every standing gate green,
the apply-window receipt false as designed); 0a refusals (name collision; `spaces.deleted_at`). Not run on staging or
prod.

## Integration test

`tests/integration/spaces-guards.int.test.js` self-skips while the fork lacks the stamp, and then asserts that none of
the guards is installed (so the skip hides nothing). With the stamp it drives the real photos Lambda for every writer
above and runs the 1.2 and 1.3b cases (the TRUNCATE cases in a transaction forced to roll back; TRUNCATE … CASCADE and
DROP COLUMN stay rehearsal-only because they lock tables other files use). It runs for real on the first integration
run after staging carries 0a.

Run locally 2026-10-16 against clones of the rehearsal replica, through a throwaway localhost stand-in for Neon's
SQL-over-HTTP endpoint (scratch only, not in the repo), with the real photos Lambda: stamp absent → 1 passed, 24
skipped; 0a applied → 24 passed, 1 skipped; applied plus a mutant (`trg_audit_spaces_upd` bound to
`audit_stmt_update`, `spaces_delete_guard` dropped) → 11 failed (the presence case, the five UPDATE writers, the
audited move, the four only-child cases). The step 1.3a control on the same guarded replica: `season-stats` and
`space-photos` at this commit → 69 passed, no residue; `season-stats` at the base 51a97146 → green while leaking 1 Space
and 31 `weather_daily` rows (the silent leak RIA I3 named); this commit with the weather deletes planted out → red twice
(`season-stats teardown steps failed`, and `FIXTURE LEAK … {"spaces":1,"weather_daily":31}`).

## Not built here

`set_updated_at` on `spaces` (V102 Step 2 had it; V200-V203 do not; the photos PUT sets `updated_at` itself).
