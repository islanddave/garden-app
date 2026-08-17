# V4-USERPREFS-001 — per-device UI state becomes per-user server state

Closes **V4-TODAYLOC-002**, **V4-LOGMANY-001**, **V4-WHATSNEW-002**.

## Status

| Step | State |
|---|---|
| `0a-additive-ddl.sql` staging | **APPLIED** 2026-08-17 |
| `0c-validate.sql` staging | **APPLIED** 2026-08-17 |
| `0a` / `0c` prod | **NOT APPLIED — held for Dave** |
| Lambda (`lambda/critter/`) | Built, tests green, **NOT pushed to dev** |
| Client call sites | **NOT BUILT** — see Remaining |

Staging gates: pre 5/5, sweep 1/1, post 5/5. Under CI's own invocation
(`--continuous-only`) this migration is 8 pass / 3 correctly excluded as
apply-window-only, **0 fail**.

**This branch must not reach dev until prod is applied.** An unapplied migration
directory on dev reds `gate-invariants.yml` by design, and the Lambda's SELECT
names the three new columns.

## Why there is no 0b

There is no prior server-side value to migrate — the previous values live in
browser storage this migration cannot reach. A NULL column means "this user has
not set it", which is byte-identical to current behavior, so the DDL is inert
until client code prefers the server.

## Why no new table

`user_notification_prefs` already **is** the per-user cross-device store. It is
keyed on `created_by` (the Clerk sub — per-identity, **not** per-household,
which matters because every other write path is `created_by = ANY(householdIds)`
and would make Dave and Jen interchangeable), and it already carries five
columns of pure UI state: `garden_group_by`, `garden_sort_order`,
`garden_expanded`, `garden_bloom_seen`, `garden_helper_rung1_seen`.
`saveGardenGroupBy()` is the working template.

## The care row is worse than its ledger entry says

`V4-TODAYLOC-002` is filed as a cross-device gap. It is also a **same-device**
one: `CareNeeded.jsx:44` keys the suppress set into `sessionStorage`, which does
not survive a tab close. Skipping a watering row in the garden and finding it
back minutes later is the actual reported experience. This fixes both halves.

## Verified, not assumed

- `user_notification_prefs` is a plain table (`relkind='r'`), **not** a view — so
  the `garden_node` failure mode from `V4-ACQMATURE-001` (column added to the
  base table, invisible to the app because an explicit-column-list view was never
  widened) cannot occur. A pre gate pins that it stays a table.
- Arming the `today_skipped` CHECK in `0c` is **not** the
  `V4-EVENTANCHORVALIDATE-001` hazard. That one validates a constraint over a
  column the currently-deployed writer can still violate; this covers a column no
  deployed code writes at all.

## Known gap recorded, not closed

`lambda/critter/select-columns.test.js` audits only `critter_state`, so the three
new columns in this Lambda's SELECT are **unaudited** by the L-081 Phase-1 schema
audit. It cannot simply be extended: `dev-main-schema-audit.py` cross-products
every `*_COLUMNS` array against every `AUDIT_TABLES` entry, so adding a second
table would require `species_id`/`earned_at` to exist on `user_notification_prefs`
too. Auditing both needs a per-table mapping in the auditor — `OPS-L081COLS-001`'s
scope. A comment in that file records this so its green result is not misread.

## Remaining (client half, not built)

1. **`V4-TODAYLOC-002`** — `CareNeeded.jsx` reads `today_skipped` on mount
   (ignoring it when `date !== today`), merges with the local set, and PATCHes on
   skip. Needs optimistic local-first writes so a skip still works offline.
2. **`V4-LOGMANY-001`** — `ScopeChecklist.jsx` `defaultAllSelected`.
3. **`V4-WHATSNEW-002`** — `whatsNew.js` / `WhatsNewDot.jsx` last-seen version.
4. Retire the corresponding keys from `src/lib/clientPrefs.js`, which exists only
   to scrub per-device keys at sign-out.

## Rollback

`0r-rollback.sql`. Destructive but bounded: every value here is UI state with a
working client-side fallback. Rolling back the *code* is nearly always the
cheaper reversal — the columns are inert to any client that does not name them.
