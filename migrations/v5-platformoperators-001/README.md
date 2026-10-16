# v5-platformoperators-001 — who may later write the shared catalog

Multi-space Phase 1, step 1.16. Ledger **V5-SPACEISOLATION-001**. Build sheet:
`project-state/_multispace-20261015/multispace-phase1-buildsheet-V203-20261016.0915.md` §2 and §3R ("1.16 shape"; §3R
wins). Stamp **`5.1.5-platformoperators-001`**, written by 0a in the same transaction as the DDL; every standing gate
self-arms on it.

| file | what it does |
|---|---|
| `0a-platform-operators.sql` | One transaction: `public.platform_operators`, `public.guard_platform_operators_identity()`, four triggers, the seed row, the stamp. |
| `0r-rollback.sql` | Refuses while a grant made after the seed exists; otherwise drops the triggers, the table and the function, and deletes the stamp. |
| `gates.yml` | 6 `pre`; 11 `post` (10 standing, 1 apply-window receipt). |
| `rehearse_local.py` | The whole rehearsal on a local PostgreSQL 17 replica (below). |

Nothing reads the table until Phase 4 step 4.7, so nothing here changes what any user sees, and nothing creates a
second Space.

## What 0a adds

* **The table** (§3R shape, review DSA BLOCKING):

  ```sql
  platform_operators (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    clerk_user_id text        NOT NULL UNIQUE CHECK (clerk_user_id ~ '^user_[A-Za-z0-9]+$'),
    added_by      text        NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now())
  ```

  The uuid `id` is not decoration. The shared audit writers insert `n.id` / `o.id` into `audit_events.row_id` (uuid).
  Keyed by `clerk_user_id` alone, every audit write would raise 42703, be swallowed as a WARNING, and the one table
  that grants shared-catalog authority would look audited with an empty trail. `v5-sourcekind-001` shipped exactly that
  once; the rehearsal reproduces it on a text-keyed table (below).
* **C-AUDIT**, statement level with transition tables: `trg_audit_platform_operators_ins` → `audit_stmt_insert()`
  (made by `v5-spaceguard-001`), `trg_audit_platform_operators_upd` → `audit_stmt_update_no_soft_delete('clerk_user_id',
  'added_by')`, `trg_audit_platform_operators_del` → `audit_stmt_delete()`. Watched: every column but `id` (it is
  `row_id`) and `created_at` (never changes).
* **`platform_operators_identity_guard`**, BEFORE UPDATE OF `id, clerk_user_id` FOR EACH ROW: P0001 when either changes.
  A grant is never re-pointed at another person; remove it and add a new one, both audited. `id` is in the list too
  (decided here, beyond the sheet's "UPDATE of `clerk_user_id` refused"): the audit trail is keyed on it and the
  UPDATE writer joins old rows to new rows on it.
* **The seed**: `INSERT … SELECT created_by FROM public.spaces WHERE id = '<the original Space>'` with
  `added_by = 'migration:v5-platformoperators-001'`, under that same actor, so the seed has its own INSERT audit row. No
  literal person id in this directory. 0a refuses, changing nothing, unless exactly one row is seeded: step 0 refuses an
  absent or ownerless original Space, and the seed step re-checks the count itself.

### No `deleted_at`: removal is an audited hard DELETE (a named Soft-Delete-Only exception)

Removing an operator is a hard `DELETE`, recorded by `trg_audit_platform_operators_del` with the whole row in
`before_jsonb`. This is the exception build sheet §3R names (review DSA MINOR). It answers the Soft-Delete-Only Rule's
falsifiable test this way: a grant carries no user-authored content (a person id, who granted it, when); the DELETE
audit row keeps the full row, so nothing becomes unrecoverable; and nothing has a foreign key to the table, so no child
is orphaned. It is not one of `gardening.md`'s three listed carve-outs, so the Phase 4 change that ships the first
code path that deletes a grant names it again. The table has no such path in Phase 1.

## Staging seeds Dave's prod person id

The original Space has the same `created_by` on both envs: Dave's **prod** Clerk id (Phase 0 read 1, re-read
read-only 2026-10-16). So on staging the one operator is a person who never signs in there. That is expected: Phase 4
step 4.7 adds the staging person (Dave-dev) when it adds the first reader. Phase 1 does not.

## Apply (a DDL sitting; Dave's first-hand OK naming this migration and both envs)

**After `v5-spaceguard-001`** (0a refuses without its stamp and `audit_stmt_insert()`). Phase 1 order M1 → M2 → M3.

Window: **never at :55-:05** (daily-plan's hourly run). 0a and 0r each
`SET LOCAL lock_timeout = '5s'`; 0a reads one `spaces` row and otherwise touches only the new table. A 55P03 changed
nothing; run it again.

1. Prod safety copy first: `python3 scripts/neon_safety_branch.py --env-file .env.local list`, then `… create --slug ms1`.
2. Staging: `gate_runner.py --migration migrations/v5-platformoperators-001 --env staging --phase pre` → `--phase post`
   (vacuous) → `psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-platformoperators-001/0a-platform-operators.sql`
   → `--phase post` (receipt included) → 0r → `--phase pre` → 0a → `--phase post` → `--all --phase post
   --continuous-only` compared with the run before the apply (newly red must be empty).
3. Prod: `--phase pre` → 0a → `--phase post` → `--all --phase post --continuous-only` (newly red empty).
4. Push this directory.

**Expected elsewhere.** `scripts/check-staging-drift.py` shows the new table as drift between the staging and the prod
apply (recon 1.16); it is advisory. **No restore-verify red from this directory:** `scripts/restore-verify.py` drops
triggers on tables the dump does not list from its missing set (`:609-610`) and treats a table added after the dump as
info (`:513`, `:521`), so `platform_operators`' four triggers red neither the daily nor the snap leg. If one appears,
the dump's `tables.json` is missing: investigate it, do not wave it off. Write the drift note into the sitting record.

## Rollback and its order (sheet §3R, DSA I6)

**0r order across Phase 1: M3 → M2 → M1**: this directory and `v5-tenantgates-001`, then `v5-spacefk-001`, then
`v5-spaceguard-001`. `v5-spaceguard-001`'s 0r refuses while `trg_audit_platform_operators_ins` calls its
`audit_stmt_insert()` (rehearsed against this directory's real trigger).

This 0r **refuses while any grant other than the seed exists** (`added_by` not this migration): a later grant is a
decision someone made, so remove it deliberately first (each DELETE is audited). The seed is re-derived from `spaces` by
the next 0a. Audit rows stay: every INSERT/UPDATE/DELETE row is history, and the INSERT rows hold each grant's full row.
A re-run after a rollback is a no-op.

## Gates

Pre (right before 0a): not applied and names free (`continuous: false`); `v5-spaceguard-001` applied
(`audit_stmt_insert()` SECURITY DEFINER with the pinned path); the shared writers present; `audit_events.row_id` uuid and
`audit_events_action_check` admitting INSERT; the original Space owned by a `user_` id.

Post (self-armed on the stamp; trigger inventories filter `NOT tgisinternal` and assert `tgenabled = 'O'`):

* `post_schema_version_recorded` (armed on the objects);
* columns exact and closed (types, NOT NULL, defaults; a `deleted_at` reds it), constraints exact (PK on `id`, UNIQUE
  `clerk_user_id`, the `user_` CHECK, all validated);
* the four triggers exact (tgtype, function, OF columns, enabled), no other trigger, transition tables present;
* column classification complete (every column watched or ignored, every watched name a real column);
* the identity guard pinned by `md5(prosrc)` (`a370878b…`, PostgreSQL 17.10), not SECURITY DEFINER, pinned path;
* **`post_every_operator_has_its_insert_audit_row`**: every grant has its INSERT audit row for the same person, and a
  row this migration wrote has the migration actor. `audit_stmt_insert` swallows its own failures as WARNINGs, so this
  is what sees a grant with no trail;
* **`post_audited_tables_have_a_uuid_id`** (the new continuous gate, DSA BLOCKING): every public table carrying a
  trigger bound to a shared audit writer (`public.audit_stmt_*`, and the `audit_<x>_stmt_*` family with the same
  `row_id` contract) has an `id` column of type uuid, NOT NULL. Read-only 2026-10-16, identical on prod and staging:
  `event_log`, `harvest_log`, `kitchen_batch_input`, `kitchen_stage_log`, `plant_varieties`, `plants`,
  `preservation_log`, `source` (14 triggers), plus `spaces` once `v5-spaceguard-001` lands. All uuid. Catalog joins only;
* **receipt** `post_receipt_seeded_set_is_the_space_owner` (`continuous: false`): the operators are exactly the original
  Space's owner, seeded by this migration, and that Space exists with an owner (so it cannot pass as ∅ = ∅). The
  positive control's planted second row, and every later grant, make it false by design.

The two gates that read the table's rows read them through `query_to_xml` inside a `CASE` on the stamp (the
`v5-recipes-001` idiom): a relation named in plain SQL is resolved at parse time, so before the apply and after 0r a
plain `FROM public.platform_operators` would ERROR 42P01 instead of passing vacuously (rehearsed: vacuous and no
ERROR, before and after).

## Rehearsal

Local PostgreSQL 17.10 only (`initdb … -A trust`, 127.0.0.1:55443). Replica `rh_base`: prod's `pg_dump --schema-only -n
public -n gv -n extensions` (read-only, `garden_ro`), `pgcrypto` and `uuid-ossp` in `public` as on prod, prod's 180
`schema_version` rows and the `spaces`, `spacetheme`, `weather_daily` and `weather_cold_range` rows as data, the photo
parent graph's key columns (for `v5-tenantgates-001`), then `v5-spaceguard-001/0a-guards.sql` applied. (The same
replica as `v5-tenantgates-001`'s rehearsal; the 52/52 run below is the one on that final replica.)

```bash
python3 migrations/v5-platformoperators-001/rehearse_local.py --port 55443 --base-db rh_base
```

**Result 2026-10-16: 52/52 PASS, exit 0.** Pre 6/6 and post 11/11 before the apply (vacuous, no ERROR); 0a exit 0; post
all green, the two pre receipts red as designed; C-CONV over this tree (`--all --phase post --json`, 1235 post gates):
newly red {}. Behaviour: the seeded set is the original Space's owner with the migration as `added_by` and as the
actor of its INSERT audit row; **a planted second operator appears in `audit_events` (INSERT, actor = the session's
`app.actor_clerk_sub`, after = the row)** and reds the receipt only; UPDATE of `clerk_user_id` and of `id` refused
(P0001); UPDATE of `added_by` audited with its actor, a same-value UPDATE not; DELETE audited with the whole row; the
`user_` CHECK (23514) and the UNIQUE (23505) hold. Gate mutants, each red on its gate: UPDATE audit bound to
`audit_stmt_update` (and it audits nothing: 42703 WARNING), identity guard dropped / disabled, an extra trigger, no
transition table, the guard body edited, a watched column dropped, a typo in the watched list, a `deleted_at` added,
the UNIQUE / CHECK dropped, a grant written with the INSERT audit off, the seed's audit row deleted, the stamp deleted.
**The uuid-id gate reds on a planted text-keyed audited table, a bigint `id`, and a nullable uuid `id`**, and the
text-keyed table's UPDATE writes no audit row (42703 WARNING). Refusals, each changing nothing: 0r with a later grant;
`v5-spaceguard-001`'s 0r while this is applied; 0a without `v5-spaceguard-001`; 0a with a name collision; 0a with the
original Space ownerless or absent (0 would be seeded); a copy of 0a with step 0 cut out still refuses on "the seed
wrote 0 row(s)". 0r exit 0 with the catalog identical to before and the audit rows kept; post vacuous after it; 0r again
a no-op; 0a twice more, the catalog identical to the first apply with one operator. Not run on staging or prod.

## Not built here

No reader or writer of the table (Phase 4 step 4.7), no Space steward flag (E4, D24), no RLS and no GRANT (as
`source_kind`/`crop_types`: a shared list nobody owns; the Lambdas' role owns the table).
