# v4-roschemaversion-001 — make `public.schema_version` readable by read-only roles

Closes **`OPS-ROSCHEMAVERSIONBLIND-001`**. Catalog change only — **zero rows read or written**.

## Status

**APPLIED 2026-09-01 to staging then prod.** Post gates 4/4 green on both. Receipt
`4.89.0-roschemaversion-001`.

## The filed diagnosis was wrong, and that is the point of this note

The ledger row prescribed: *"GRANT SELECT on public.schema_version to garden_ro."*

Measured live on prod before touching anything:

```
has_table_privilege('garden_ro','public.schema_version','SELECT')  ->  TRUE
```

**`garden_ro` already held `SELECT`.** That GRANT would have been a no-op that looked like a fix,
and the row would have been closed with the symptom still present.

The tell was in the symptom itself: `garden_ro` got **zero rows**, not
`permission denied for table schema_version`. **A missing GRANT raises; RLS filters silently.** Any
time a read returns an empty set where a permission error was expected, the cause is row filtering,
not privilege.

## Actual cause

```
pg_class.relrowsecurity      = true      -- RLS armed
pg_class.relforcerowsecurity = false     -- so the owner still bypasses it
pg_policies                  -> 0 rows   -- and there is not one policy
```

RLS enabled with **no** matching policy is deny-all for every role that is neither the table owner
nor `BYPASSRLS`. `relforcerowsecurity = false` is why the owner DSN kept seeing all 116 rows while
every read-only session saw none — and why nobody noticed.

Near-certainly an accidental blanket "enable RLS everywhere" sweep rather than a decision:
`schema_version` is a migration-receipt ledger with no user data, no household scoping and nothing
tenant-specific, and every genuinely tenant-scoped table in this database carries policies. This one
had none at all, which is the signature of a table armed and then never given a policy.

## Why a policy rather than `DISABLE ROW LEVEL SECURITY`

Disabling would also have worked and is the more tempting one-liner, but it removes the control
outright and would silently open the table to any future write path too. A `FOR SELECT` policy is
the narrower change: reads work, and because **no INSERT/UPDATE/DELETE policy is created, writes
remain deny-all for every non-owner role** — the correct posture for a receipt table.
`post_no_write_policy_exists` holds that as a standing invariant, and it is the gate most worth
keeping.

`USING (true)` is the honest predicate: there is no row-level distinction to draw on this table. The
table GRANT stays the real access control, which is where it belongs.

## Behavioural proof — and why the gates could not provide it

`gate_runner` connects with the **owner** DSN, and `relforcerowsecurity` is false, so the owner
bypasses RLS. **No gate in this migration can prove `garden_ro` can read the table** — a
`SELECT count(*)` gate would have returned 116 both before and after, passing identically in the
broken state. That is the instrument-that-cannot-fail trap, so the gates assert catalog state
(policy present, `cmd = SELECT`, RLS still armed, no write policy) and the behavioural proof was run
separately through the `garden_ro` DSN:

| | rows visible to `garden_ro` |
|---|---|
| before | **0** |
| after | **118** (including all three of today's receipts) |

## Rollback

`0r-rollback.sql` drops the policy and deletes the receipt, returning the table to
RLS-enabled-with-zero-policies — `garden_ro` blind again, which is the exact pre-fix state.
