# v4-entitytagsdrop-001 — the plural table finally goes

Closes **`OPS-ENTITYTAGSDROP-001`** (audit finding M2). Completes the deploy-before-drop sequence
begun on 2026-07-28, whose code half has been live in prod for two weeks.

## Singular and plural — read this first

Two tables in this database differ by one character.

| | `entity_tags` **PLURAL** | `entity_tag` **SINGULAR** |
|---|---|---|
| What it is | the flat 2026-era tag model | the faceted M2M from `v4-tagsub` |
| Rows (prod) | **2** — May-2026 smoke debris | **1,016**, all `entity_type='cultivar'` |
| Rows (staging) | 2 | **0** |
| Live readers | **none** since 2026-07-28 | `lambda/tags/index.js`, the whole tag UI |
| Guards | 3 dead `AFTER DELETE` triggers on other tables | 4 `BEFORE DELETE` polymorphic-FK guards from `v4-entitytagorphan-001` |
| This migration | **drops it** | **does not touch it** |

Everything in this directory is spelled with the trailing `s`. Four separate mechanisms assert the
singular side survived — `0c-drop.sql`'s preflight and postflight blocks (which compare its row
count across the drop *inside the same transaction*, so a mis-drop aborts rather than commits), and
four `post_singular_entity_tag_*` gates. That redundancy is deliberate: a migration that only
asserts what it removed would ship green after removing the wrong thing.

## What was wrong

`entity_tags` was superseded by `v4-tagsub`, which said so in its own header — *"replace the flat
single-row entity_tags model with a normalized, faceted tag system"* (`0a-additive-ddl.sql:4`),
*"Supersedes flat entity_tags"* (`:124`). The frontend has routed all `/api/entity-tags` traffic to
the tags Lambda for months. The last server-side consumer, the `/api/entity-tags` block in the
locations Lambda, was removed on 2026-07-28 and replaced with an explicit 404 tombstone.

What remained was debris with teeth: a table nothing reads, and **three `AFTER DELETE` triggers that
still fire on every hard delete of a planting, container or location**.

| Table | Trigger | Function | Body |
|---|---|---|---|
| `plants` | `trg_delete_entity_tags_plant` | `delete_entity_tags_for_plant()` | `DELETE FROM entity_tags WHERE entity_type='plant' AND entity_id=OLD.id::TEXT` |
| `plant_projects` | `trg_delete_entity_tags_project` | `delete_entity_tags_for_project()` | …`'project'`… |
| `locations` | `trg_delete_entity_tags_location` | `delete_entity_tags_for_location()` | …`'location'`… |

They are **dead as guarantees** — they protect the singular table not at all, which is the entire
finding of `BUG-ENTITYTAGORPHAN-001` — but they are **live objects**. Leaving them behind a dropped
table would turn every hard parent delete into a `42P01 undefined_table`. They are not optional
tidying; they are load-bearing for this drop and go in the same transaction.

## Measured — live catalog, 2026-08-13, owner DSN (RLS-exempt), exact

| Fact | Prod | Staging |
|---|---|---|
| `entity_tags` rows | 2 | 2 |
| `entity_tags` columns / constraints / indexes / RLS policies | 7 / 3 / 5 / 3 | identical |
| Incoming FKs, dependent views, triggers **on** it | 0 / 0 / 0 | 0 / 0 / 0 |
| `garden_ro` SELECT grant on it | **present** | **role does not exist** |
| Legacy triggers / functions | 3 / 3 | 3 / 3 |
| Function overloads | **0** — all three are zero-argument | 0 |
| `entity_tag` (SINGULAR) rows | **1,016** | **0** |
| `trg_guard_entity_tag_*` guards | **4** | **4** |

Two of those rows are the reason this file has a capture section, and two of them are the reason
`gates.yml` scopes one assertion to prod.

## CAPTURE RECORD — the 2 rows, before they were destroyed

A `DROP TABLE` is the one operation Soft-Delete-Only cannot un-do. These are smoke-test rows and
nobody wants them back, but *"nobody wants them back"* is a judgement made from a report, and a
report is not the data. Captured from prod on 2026-08-13, verbatim, and re-inserted byte-for-byte
by `0r-rollback.sql`:

```
id          | e8a90807-4743-4019-be80-5865c42ddb92
entity_type | project
entity_id   | 896fd584-1e6b-4c10-a60f-dbe885a3f860
tag_key     | smoke-v2-a
tag_value   | hello
created_by  | user_3D2gM0hIl03gjW3JM2DjtPzm0jI
created_at  | 2026-05-01 14:47:40.724242+00

id          | e4a5e4e7-db91-41e7-aaca-d1071a158e63
entity_type | project
entity_id   | 896fd584-1e6b-4c10-a60f-dbe885a3f860
tag_key     | smoke-v2-b
tag_value   | world
created_by  | user_3D2gM0hIl03gjW3JM2DjtPzm0jI
created_at  | 2026-05-01 14:47:40.920969+00
```

Both were written by one v2 smoke run 196 milliseconds apart, both point at the same container, and
nothing has written to the table since. Re-run `0a-evidence.sql` block 1 against staging and paste
its output here too if the staging pair ever differs from prod's.

## The fix

`0c-drop.sql`, one transaction, in dependency order:

1. **preflight** — every precondition re-asserted against the live catalog, including the exact
   function signatures and the singular side's row count (stashed for comparison).
2. **3 triggers** — first, because a function cannot be dropped while a trigger depends on it.
3. **3 functions** — by exact zero-argument identity signature.
4. **`DROP TABLE public.entity_tags`** — plain. This takes its 3 constraints, 5 indexes and 3 RLS
   policies with it.
5. **postflight** — plural residue gone, **singular row count unchanged**, 4/4 guards still there.
6. `schema_version` row `4.23.11-entitytagsdrop-001`.

### Two spellings this file deliberately does *not* use

**No `CASCADE`.** The dependency sweep says nothing depends on this table. The plain form is the
*assertion* that the sweep was right. If it fails with `2BP01`, that is **information** — stop, read
what Postgres names, amend the migration. It is not an obstacle to route around.

**No `IF EXISTS`**, and this is the more important of the two — a deliberate deviation from the
recon's spelling. `DROP TRIGGER IF EXISTS trg_delete_entity_tag_plant` — one character short —
succeeds silently and ships green with the real trigger still armed against a dropped table. Bare
`DROP`s make every name in the file a checked claim. Idempotence is not lost: the preflight passes
again after `0r` restores the objects, which is exactly when re-running is legitimate.

## ENV PARITY — the two databases legitimately differ, in two ways

1. **Staging's singular `entity_tag` holds ZERO rows.** Prod holds 1,016. The ticket asked for a
   gate asserting *"`entity_tag` row count unchanged and > 1000"* — written the obvious way, that
   gate is **red on staging forever**, and a permanently-red gate trains everyone to ignore the
   runner, which is the exact failure `scripts/gate_runner.py` was built to end. It is scoped
   `env: prod`. The env-independent half of the same protection — table present, 4 guards present,
   guard function present — runs on both. **Do not "fix" the scoping.**
2. **`garden_ro` exists only on prod.** A bare `GRANT ... TO garden_ro` in `0r-rollback.sql` would
   abort a staging rollback mid-file with `42704`. It is wrapped in a role-existence check.

## Deploy boundary

**Answer: NO writer coupling, and the code half already shipped.** The plural name was swept across
the whole repo (`rg -uuu`, `node_modules` and `.git` excluded) at
`c509fff4aec0225553228d8169dde77e68ae2903` = `main` = prod v4.16.0. Every remaining hit is a
comment, a test asserting the name's *absence*, or a historical migration. Zero live SQL in any of
the 26 Lambda directories.

`lambda/locations/entity-tags-removed.test.js:6` states the ordering this migration completes:

> `// Removal ships BEFORE the entity_tags table drop (P1-data), per plan deploy-before-drop order.`

That test is **kept, not retired** — it costs nothing and keeps the tombstone pinned, which is what
stops the debris-table dependency silently resurrecting. It gains one comment line noting the table
is now actually gone. Its assertions get *greener* from this drop, never redder.

## Whole-corpus obligation — and a recon claim this migration falsified

Three other migrations name the dropped triggers in `post_no_new_triggers_on_touched_tables`
allow-lists. The full `rg -uuu` sweep found **six** sites, not the one the recon listed:

| File | Line | Nature |
|---|---|---|
| `migrations/v4-evtanchordel-001/gates.yml` | 213–214 | allow-list (`plant`, `location`) |
| `migrations/v4-plantrehomefk-001/gates.yml` | 216, 218 | allow-list (`project`, `plant`) |
| `migrations/v4-softdelcascade-001/gates.yml` | 507 | allow-list (`project`) |
| `migrations/v4-plantrehomefk-001/0c-constraint.sql` | 167 | prose comment |
| `migrations/v4-plantrehomefk-001/README.md` | 113 | prose |
| `migrations/v4-entitytagorphan-001/**` | several | historical rationale (read-only by boundary) |

**The recon expected these to break. They do not, and the reason is directional.** Each is a
`tgname NOT IN (...)` allow-list asserting `rowcount_eq 0`: an allow-list reds when a trigger
**appears** unlisted, not when a listed one **disappears**. Dropping a named trigger simply removes
a row from `pg_trigger` and the gate still returns 0.

That was verified mechanically, not reasoned about — all four affected gate queries were re-run
against live prod with `AND g.tgname NOT LIKE 'trg\_delete\_entity\_tags\_%'` appended to simulate
the post-drop catalog. **All four returned 0 rows.**

So the three entries are **stale but harmless, and they are deliberately LEFT IN PLACE**:
`0r-rollback.sql` re-creates all three triggers, and a corpus run during a rollback window with the
entries stripped would red three migrations at once. Each site gains a comment pointing here.
Run `--all` on both environments anyway — the obligation is to *measure* that, not assume it.

## Runbook

> **Push order is load-bearing.** `gate-invariants.yml` runs `--phase post --continuous-only`
> against both prod and staging on `migrations/**` pushes. Apply to **staging and prod before
> pushing**.

```bash
export NEON_DATABASE_URL=$(grep -m1 '^NEON_DATABASE_URL=' .env.local | sed 's/^NEON_DATABASE_URL=//' | tr -d '"')
export NEON_STAGING_URL=$(grep -m1 '^NEON_STAGING_URL=' .env.local | sed 's/^NEON_STAGING_URL=//' | tr -d '"')
```

1. **Staging** — `0a-evidence.sql`. Read block 1 (the rows), block 6 (the singular BEFORE numbers).
   Then `gate_runner.py --migration migrations/v4-entitytagsdrop-001 --env staging --phase pre`
   and `--phase sweep` → 4/4 and 4/4.
2. **Staging** — apply `0c-drop.sql`. Watch for both `PREFLIGHT OK` and both `POSTFLIGHT OK`
   notices; the postflight prints the singular row count, which must equal block 6's.
3. **Staging** — `--phase post` → 8 pass, 2 `n/a` (the prod-scoped pair).
4. **Staging** — rehearse `0r-rollback.sql`. It self-verifies (2 rows / 7 cols / 3 constraints /
   5 indexes / 3 policies / RLS on / 3 functions / 3 triggers) and prints the `garden_ro` skip.
   Re-apply `0c-drop.sql`. The round trip is the proof the rollback exists.
5. **Staging** — `--all --env staging --phase post --continuous-only`. Compare against the
   pre-change baseline below. The three allow-list migrations must stay green.
6. **Prod** — repeat 1, 2, 3, 5. **Do not rehearse `0r` on prod**; that is what staging is for.
7. Push, then confirm `gate-invariants.yml` green on both.

**Rollback:** `0r-rollback.sql`. Unlike `v4-entitytagorphan-001`'s rollback, which re-arms a real
defect, this one restores a table nothing reads and three triggers that protect nothing — there is
no hazard in running it. The reason to rehearse it is that a rollback path which has never been
executed is a rollback path that does not exist.

## Verification record — pre-apply, read-only

Everything below was run against the **live** databases with `gate_runner.py`, which is read-only in
two independent layers (single-statement `SELECT`/`WITH` check at load time; `psycopg` `read_only =
True` at connection time). **Nothing in this migration has been applied to any database.**

- `gate_runner.py --validate-only` on this directory: **18 gates parsed and schema-valid**.
- Corpus sweep of the whole class (`migrations/*/gates.yml`), both under `--validate-only --all`
  and under a raw `yaml.safe_load`: **57 files, 731 gates, 0 parse failures, all schema-valid** —
  no copy-propagated defect found. (Gates copy-propagate; touching one obliges sweeping the class.)
- **The gates fail against the pre-drop state, which is the point.** `--env prod` (all phases):
  **13 PASS / 5 FAIL**. The five reds are exactly the five post gates asserting the removal, and
  their actual values are exactly the inventory: table `rowcount=1`, triggers `rowcount=3`,
  functions `rowcount=3`, index+policy residue `rowcount=8` (5 + 3), `schema_version` `rowcount=0`.
  All four `post_singular_entity_tag_*` gates, all 4 `pre` and all 4 `sweep` gates **PASS**.
- Same on `--env staging`: **11 PASS / 5 FAIL / 2 n/a** — the two prod-scoped gates correctly report
  `NOT_APPLICABLE` rather than failing, which is the env-parity fix working.
- **Whole-corpus baseline, prod, `--all --phase post --continuous-only` (what CI runs):**
  `PASS=405, FAIL=4, MANUAL=11, RETIRED=2, APPLY_WINDOW_ONLY=54`. **All four failures are this
  migration's own pre-apply reds.** The rest of the corpus is green, so any red after the apply is
  attributable.
- Allow-list post-drop simulation (see above): **all four affected gate queries return 0 rows.**

### Not verified, and stated as such

- **`0c-drop.sql` and `0r-rollback.sql` have never been executed.** Their preflight/postflight logic
  is reviewed, not run. The staging apply in step 1–4 of the runbook is the first execution.
- The 5-index / 3-policy cascade behaviour of the plain `DROP TABLE` is Postgres-documented and is
  asserted by `post_no_plural_entity_tags_index_or_policy_residue`, but has not been observed here.
- Staging's `entity_tags` **row contents** were not captured — only its row count (2) and its
  identical structure. If staging's two rows differ from prod's, `0r-rollback.sql` will restore
  prod's values there. Run `0a-evidence.sql` block 1b on staging before the rehearsal if that
  matters.
