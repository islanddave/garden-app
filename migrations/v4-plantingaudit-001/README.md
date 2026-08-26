# v4-plantingaudit-001 — audit_events coverage for plantings

**BUG-NOPLANTINGAUDIT-001 (BD-022).** `public.plants` — the table holding every planting — has no
audit trail. Measured on prod 2026-08-26:

| table | audit_events rows | since |
|---|---|---|
| `plant_varieties` | 1878 | 2026-05-11 |
| `event_log` | 167 | 2026-08-20 (OPS-HARVESTAUDIT-001) |
| `harvest_log` | 11 | 2026-08-20 (OPS-HARVESTAUDIT-001) |
| **`plants`** | **0** | never |

`SELECT tgname FROM pg_trigger … WHERE relname='plants' AND NOT tgisinternal` returns seven
triggers, none of them auditing. BD-022's named consequence: a planting's **date** edits cannot be
reconstructed or attributed. `plants` carries five dates (`planted_at`, `sown_at`, `germinated_at`,
`transplanted_at`, `planted_out_at`) plus four `_approx` flags, all freely editable, all feeding
maturity estimates and the care engine.

## The row names a view

BD-022 says "garden_node has NO audit trail". **`garden_node` is a VIEW** (`pg_class.relkind='v'`);
the table is `public.plants`. This is not pedantry — `AFTER … FOR EACH STATEMENT` cannot be attached
to a view, so a migration written to the row's wording fails on apply. The premise survives the
correction: zero audit rows under either name. Gate `pre_plants_is_a_table_not_a_view` pins it.

## Deploy order

| phase | file | effect |
|---|---|---|
| 0a | `0a-arm-triggers.sql` | **the only DDL.** Attaches two triggers, records `schema_version`. |
| 0b | `0b-verify-triggers.sql` | behavioural proof. Fixture + assertions + `ROLLBACK`. Safe on prod. Requires 0a. |
| 0r | `0r-rollback.sql` | detaches the two arms by name. Leaves the shared functions alone. |

Gates: `python3 scripts/gate_runner.py --migration migrations/v4-plantingaudit-001 --env <env>`
(needs `NEON_DATABASE_URL` in the environment — never on the command line, L-067).
Per the standing rule, apply to **staging AND prod** before pushing `migrations/**`.

## No new functions

`audit_stmt_delete`, `audit_stmt_update` and `audit_watched_slice` are live on prod already
(OPS-HARVESTAUDIT-001) and are generic — table name from `TG_TABLE_NAME`, watched set from
`TG_ARGV`. This migration attaches them to a third table and creates nothing. That is also why
`0r` must **not** drop them: `plant_varieties`, `event_log` and `harvest_log` all depend on them, so
dropping them "to roll back" would silently disarm three other tables.

## ⚠️ Do not rehearse 0a by wrapping it

`BEGIN; \i 0a-arm-triggers.sql; …; ROLLBACK;` **applies the migration for real.** Postgres has no
nested transactions: 0a's own `COMMIT` ends the outer transaction, everything to that point is
durable, and the trailing `ROLLBACK` discards only what a fresh implicit transaction did afterwards.

This happened on **prod** while building this migration (2026-08-26). The fixture rows vanished —
making the rehearsal look like it had rolled back — while the two triggers and the `schema_version`
row stayed. It was caught only by re-querying `pg_trigger` and `schema_version` afterwards, and
undone with `0r-rollback.sql`; zero real audit rows had been written in the window, so nothing was
lost. A printed `ROLLBACK` is not evidence that nothing persisted.

To rehearse: use an ephemeral Neon branch, or inline 0a's two `CREATE TRIGGER`s **without** its
`BEGIN`/`COMMIT`. Then verify the post-state with a fresh query. Verified working that way —
0b reports all four checks passed and `pg_trigger` / fixture / `audit_events` counts all return to 0.

## What the watched set excludes, and why

`audit_stmt_update` writes a row when `deleted_at` changed **or** the watched slice differs. A
column that changes on every update collapses column-scoping into "always", turning the audit into a
full write log of a table the app touches constantly. Six columns are excluded for that reason —
`updated_at` (maintained by the `set_updated_at` trigger), `version` (optimistic-lock counter),
`last_seen_at` (presence stamp), the two `_set_at` stamps (move only with flags that are watched),
and `id` (the join key). The other 46 are watched.

`before_jsonb`/`after_jsonb` capture the **whole row** regardless, so the watched set decides only
*when* a row is written, never what it contains. Gate
`post_plants_watched_set_excludes_updated_at` asserts the exclusion as an absence, because adding
`updated_at` would make the audit look healthier — far more rows — while making it useless.
