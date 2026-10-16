# v5-tenantgates-001 — one owner until approved, the sentinel callers, photo tenancy

Multi-space Phase 1 gates with no DDL of their own. Build sheet:
`project-state/_multispace-20261015/multispace-phase1-buildsheet-V203-20261016.0915.md` §2 and §3R ("Gate tenancy",
"1.14 list", the 1.11 mapping in "Other MINORs"; §3R wins).

| step | gate | ledger |
|---|---|---|
| 1.17 | `post_no_second_owner_until_approved` | V5-SPACEISOLATION-001 |
| 1.14 (database half) | `post_sentinel_callers` | V5-SITECONSTANTS-001 |
| 1.11 | `post_photo_tenancy_no_conflict` + sweep records of the buckets | V5-PHOTOSPACEBACKFILL-001 |

Stamp **`5.1.5-tenantgates-001`**: every gate here self-arms on it (review DSA I3: a gates-only directory writes no
stamp, so it gets a `0a` that writes only the stamp and a `0r` that deletes it). 1.11 is armed on it **and**, by exact
equality, on `v5-spacefk-001`'s `5.1.5-spacefk-001-fold`.

| file | what it does |
|---|---|
| `0a-tenantgates.sql` | Refuses, changing nothing, where an armed gate would red at once (the same three predicates); otherwise writes the stamp. |
| `0r-rollback.sql` | Deletes the stamp. |
| `gates.yml` | 3 `pre`; 5 `sweep` records (1.11 buckets, never red); 3 `post`. All `env: both`. |
| `rehearse_local.py` | The whole rehearsal on a local PostgreSQL 17 replica (below). |

Nothing here changes what any user sees, and nothing creates a second Space.

## 1.17 `post_no_second_owner_until_approved`

V202 :274, violation-shaped, `env: both`, continuous:

```sql
SELECT s.id::text FROM spaces s
 CROSS JOIN (SELECT created_by FROM spaces WHERE id = '<original Space>') dave
 WHERE <stamp> AND (s.id IS DISTINCT FROM '<original Space>' OR s.created_by IS DISTINCT FROM dave.created_by)
   AND NOT EXISTS (SELECT 1 FROM schema_version WHERE version LIKE 'phase7-approved-%')
UNION ALL
SELECT 'original Space absent or ownerless'
 WHERE <stamp> AND NOT EXISTS (SELECT 1 FROM spaces WHERE id = '<original Space>' AND created_by IS NOT NULL)
```

The second arm is not waived by an approval: without the original Space the CROSS JOIN is empty and the first arm would
be vacuously green. It also covers an original Space with a NULL owner (decided here: with a NULL anchor the first arm
compares every row against nothing).

**Before arming (E3a), read 26 on both envs, read-only 2026-10-16:** one `spaces` row on each, the original Space, the
same owner (Dave's prod Clerk id). So `env: both`; no stray staging row to remove.

**Overlap, expected.** `v4-spaceowner/gates.yml` `no_space_left_without_an_owner` (`:21`) reds on any NULL-owner Space,
and `sentinel_space_owned_by_expected_sub` (`:27`) reds when the original Space is deleted or ownerless. On this gate's
throwaway controls they red alongside it (rehearsed, below): a second Space owned by someone → only this gate; a NULL-owner
Space → this gate and `:21`; the original Space deleted → this gate and `:27`; ownerless → this gate, `:21` and `:27`.

## 1.14 `post_sentinel_callers`

Function bodies (`pg_proc.prosrc`, every schema) that hold the original Space's id or call `sentinel_workspace(`,
against a **shrinking** list. Built from this read, run read-only on **prod** (`garden_ro`) and **staging** (READ ONLY
transaction) on 2026-10-16, before the list was written (sheet §3R, DSA I5):

```sql
SELECT n.nspname||'.'||p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE p.prosrc ~ '00000000-0000-0000-0000-000000000001' OR p.prosrc ~* 'sentinel_workspace\s*\('
```

| function | prod | staging | body md5 | in the gate |
|---|---|---|---|---|
| `gv.entity_cultivar_ins` | calls `gv.sentinel_workspace()` | same | `bc625f32…` | **listed**: stamps the original Space on every new cultivar entity row. Phase 4 step 4.7 rewrites it to copy its cultivar's workspace and removes the entry in the same push. |
| `gv.sentinel_workspace` | holds the literal | same | `d6b97956…` | **excluded by name: it defines the value.** Pinned by `md5(prosrc)`, so the exclusion covers that body only. |

No other body in either database matches (and none holds the nil id `…0000`). The gate reds on: an unlisted caller (any
schema, any overload of a listed name); a listed entry that no longer matches ("stale entry": shrink the list); the
definer absent or changed. `pg_attrdef` is out of scope here (`entity.workspace_id DEFAULT gv.sentinel_workspace()` and
eight literal defaults, Phase 0 read 5): Phase 5's `post_no_workspace_default` (G2). The code half (literals and env
readers under `lambda/**`, `src/**`, `scripts/**`) is lane C1's ratchet.

## 1.11 `post_photo_tenancy_no_conflict` (check, no backfill)

Every live photo's parents resolve to **one** workspace. The mapping (sheet §3R, DSA MINOR):

| parent | resolves to |
|---|---|
| `plant_id` | `plants.workspace_id` |
| `project_id` | `plant_projects.workspace_id` |
| `event_id` | the event's `plant_id` → `plants.workspace_id` **and** its `project_id` → `plant_projects.workspace_id` |
| `space_id` | that Space |
| `location_id`, `inventory_item_id` | nothing (no workspace column) |

A **conflict** is a live photo whose resolved values are two or more. A live photo with no workspace-bearing parent is in
a bucket (sweep records, `rowcount_gte 0`, never red; the count is in the runner's detail):

* `tenancy_person_bound`: an `inventory_item_id` (an item belongs to a person wherever it sits);
* `tenancy_location_only`: else a location, its own or its event's;
* `tenancy_unresolved`: else nothing at all, i.e. the `pending_tag` intake rows `photos_must_have_parent` allows (renamed
  from V102's `pending_tag`, which is already the intake status name: sheet P17).

Armed on this stamp and on `5.1.5-spacefk-001-fold` by exact equality (`v5-spacefk-001` is lane M2; its stamps were read
from `t3-ms1-m2:migrations/v5-spacefk-001/gates.yml` and `README.md`). `env: both`: staging has 8 live photos, all
resolved, so the check tests something there too.

### The pre-fold state, recorded read-only (2026-10-16)

**Phase 0 read 9** (it took a planting's workspace from its **container**): 4 conflicts — `0040dc42`, `ed031cc3`,
`216b86aa`, `a50e7580` — and 8 photos whose parent lands in the nil workspace `…0000` — `a50e7580`, `a7174c18`,
`d0c04a4d`, `00dce7f9`, `2427f996`, `01a2a463`, `1341128e`, `a86b7de3`.

**Re-read with the §3R mapping** (a planting resolves to `plants.workspace_id`, which is `…0001` for every planting,
Phase 0 read 6), prod, `NEON_DATABASE_URL` in a READ ONLY transaction: 2,096 photos, 2,078 live. Live buckets:
resolved 1,584 (all `…0001`), **conflict 7**, `tenancy_person_bound` 331, `tenancy_location_only` 156,
`tenancy_unresolved` 0. The 7 conflicts are 7 of Phase 0's 8 nil-workspace photos, each a photo on a `…0000` container
whose event's planting is in `…0001`:

```
00dce7f9-35df-4819-9b66-f8c6f00a535f   01a2a463-faf9-4c7b-a67a-5997e1f8ce3a   1341128e-180e-413a-a3e6-6d3573425f1f
2427f996-1ebc-4489-9ca8-235b027f05df   a7174c18-bfc4-4372-b7ed-2b65ea37a7c4   a86b7de3-2a0d-4d95-8c87-67c9bfc7aebc
d0c04a4d-84fb-474d-adcd-ae97b2593cf2
```

Phase 0's four (`0040dc42-3c47-4adc-9905-871f6803accb`, `ed031cc3-0e12-4b2c-96e2-907c14292a80`,
`216b86aa-413e-4e8c-994c-98c1c6825101`, `a50e7580-834c-4751-9297-be3a4e059532`) resolve under this mapping: their
parents are a `…0001` planting (and, for three, a `…0001` container). All 11 photos touching a `…0000` container are live.
Staging: 8 photos, 8 live, all resolved to `…0001`, 0 conflicts.

**After the fold, 0.** Rehearsed on prod's own photo graph (below): `v5-spacefk-001`'s real `0a-fold.sql` takes the 7
conflicts to 0 and leaves the buckets otherwise unchanged (resolved 1,591). That is why the gate arms on the fold
stamp: before it, armed, it would red on prod at once (RIA MINOR, DSA I2).

**Dormant on the live envs during Phase 1.** After `v5-spacefk-001` every parent's workspace is FK-bound to `spaces`
(`plants`, `plant_projects`; `photos.space_id` already), and each env has one Space, so a conflict needs a second Space,
which 1.17 already reds on. This gate's Phase 1 coverage is the rehearsal control with a planted second Space; do not
count it as a live tripwire until a second Space exists.

## Apply (a DDL sitting; Dave's first-hand OK naming this migration and both envs)

Order M1 → M2 → M3; this file after `v5-spacefk-001` in the sitting. It has no object dependency: applied earlier, 1.11
just stays vacuous until the fold. 0a takes one row lock in `schema_version`; the house window applies anyway (never
at :55-:05; `lock_timeout` 5s).

1. Staging: `gate_runner.py --migration migrations/v5-tenantgates-001 --env staging --phase pre` → `--phase sweep`
   (records the buckets) → `--phase post` (vacuous) → `psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f
   migrations/v5-tenantgates-001/0a-tenantgates.sql` → `--phase post` → 0r → `--phase pre` → 0a → `--phase post` → `--all
   --phase post --continuous-only` compared with the run before (newly red must be empty).
2. Prod: `--phase pre` → `--phase sweep` → 0a → `--phase post` → `--all --phase post --continuous-only` (newly red empty).
3. Push this directory.

## Rollback and its order

**0r order across Phase 1: M3 → M2 → M1**: this directory and `v5-platformoperators-001`, then `v5-spacefk-001`, then
`v5-spaceguard-001`. This 0r deletes the stamp; every gate goes vacuous. `v5-spacefk-001`'s 0r deletes the fold stamp in
the same transaction that puts the ten containers back in `…0000`, so 1.11 is vacuous either way; running this first
keeps it so without relying on that. A re-apply re-checks every predicate before it re-arms.

## Gates

Pre: not applied (`continuous: false`); the 1.17 predicate unarmed (E3a); the 1.14 list unarmed. 0a refuses on the same
predicates, plus the stale and definer arms of 1.14 and, when the fold stamp exists, the 1.11 conflicts.

Sweep (records): `sweep_record_photo_tenancy_conflicts` (prod pre-fold 7), `…_resolved_per_space`, `…_person_bound`,
`…_location_only`, `…_unresolved`.

Post: the three gates above. No `::regclass`; relations by catalog joins; every relation named exists on both envs.

**C-CONV.** `--all --phase post --json` before and after this 0a on the same replica: newly red {}. And for the whole of
Phase 1 (M1 base → `v5-spacefk-001` 0a-0d → both M3 directories): newly red {} (rehearsed).

## Rehearsal

Local PostgreSQL 17.10 only (`initdb … -A trust`, 127.0.0.1:55443). Replica `rh_base`: prod's `pg_dump --schema-only -n
public -n gv -n extensions` (read-only, `garden_ro`); `pgcrypto` and `uuid-ossp` in `public` as on prod; prod's 180
`schema_version` rows and the `spaces`, `spacetheme`, `weather_daily` and `weather_cold_range` rows as data; **prod's
photo parent graph** as data, key columns only (`\copy` in a READ ONLY transaction; names and person ids replaced by
placeholders): `plant_projects` 86, `plants` 327, the 875 `event_log` rows photos point at, `photos` 2,096 (id, the six
parent columns, `deleted_at`, `intake_status`). Its bucket read equals prod's. Then `v5-spaceguard-001/0a-guards.sql`.
`v5-spacefk-001`'s files from `git show t3-ms1-m2:migrations/v5-spacefk-001/<file>` into a scratch dir.

```bash
python3 migrations/v5-tenantgates-001/rehearse_local.py --port 55443 --base-db rh_base --m2-dir <scratch>/m2
```

**Result 2026-10-16: 45/45 PASS, exit 0.** Sweep records on the pre-fold graph = prod's (7 / 331 / 156 / 0 / 1,584); pre
3/3; post vacuous; 0a exit 0; post green **with the 7 conflicts present: 1.11 vacuous without the fold stamp**; the
receipt red as designed; C-CONV newly red {}.
**1.17** (committed clones, through `gate_runner`): a second Space owned by someone else reds, an approval row turns it
green; a second Space owned by the same person reds, approval green; **a NULL-owner Space reds** (with `:21`), approval
green; **the original Space deleted** (children removed first, through `spaces_delete_guard`) **reds** (with `:27`), and
the approval does not help; the original Space ownerless reds (with `:21`, `:27`), approval does not help.
**1.14**: **a planted function calling `gv.sentinel_workspace()` reds** naming it; one holding the literal reds; an
overload of the listed name reds; the listed function rewritten without the call reds ("stale entry"); the definer
edited reds; the unplanted replica is green.
**1.11**: the fold stamp without the fold reds with the 7 conflicts; `v5-spacefk-001`'s real `0a-fold.sql` → green, 0
conflicts, buckets unchanged but resolved 1,591; **a planted two-parent photo on the folded graph reds** (a `…0001`
container plus a second Space's `space_id`; a `…0001` container plus a planting in a second Space), each 1 photo; green
once removed; `v5-spacefk-001` 0b-0d on top → its gates and these green.
Refusals, each changing nothing: 0a with a second Space; with an unlisted caller; with a stale entry; with the fold
stamp on the unfolded graph. 0r exit 0 with the catalog identical to before; post vacuous; 0r again a no-op; 0a twice
more, catalog = the first apply. **Phase 1 end to end** on one clone: M1 base → `v5-spacefk-001` 0a-0d →
`v5-platformoperators-001` 0a → this 0a, every post gate of the four directories green, C-CONV newly red {};
`v5-spaceguard-001`'s 0r first refuses; then 0r in the order M3 (this, then `v5-platformoperators-001`) → M2 → M1, each
exit 0, and the catalog equals a pre-M1 clone's. Not run on staging or prod.
