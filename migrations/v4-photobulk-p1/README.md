# v4-photobulk-p1 — additive intake columns on `photos` (V4-PHOTOBULK-001 P1)

Extends `photos` with bulk-upload intake metadata and widens `photos_must_have_parent` to admit
one new legal parentless state (`intake_status = 'pending_tag'`). Rationale and the `photo_inbox`
supersession are in `0a-additive-ddl.sql`'s own header — that header is load-bearing
documentation, not commentary. Design pass:
`../../../photobulk-scope-union-design-V100-20260803.md`.

## ✅ APPLIED — prod, on or before 2026-07-31

The DDL in `0a-additive-ddl.sql` **is applied to prod Neon** (`br-delicate-sea-amum92c2`). Do not
re-apply it expecting it to do work; it is now a no-op there by construction (see below).

**The exact apply date is not recoverable** and is deliberately not invented anywhere in this
directory. The evidenced bounds are:

- **not before 2026-07-16** — the migration was authored that day (commit `a408285`) and its
  header records the `COALESCE` NULL-safety bug being caught on staging on 2026-07-16.
- **not after 2026-07-31** — `../v4-spacephoto-001/0a-additive-ddl.sql:16-19` records the live
  prod constraint on 2026-07-31 as *already carrying* the intake arm.
- corroborating: `schema_version` row `4.18.0-spacephoto-001` describes itself as widening
  `photos_must_have_parent` **6 → 7** clauses. The "6" is this migration's post-widen shape, which
  fixes the ordering — photobulk ran **first**, spacephoto second.

The `schema_version` marker's `applied_at` is **2026-08-04**, which is the marker's *backfill*
date, not the DDL's apply date. Read the bounds above, not that timestamp.

## Live constraint shape — verified 2026-08-04 against prod

```sql
-- SELECT conname, convalidated, pg_get_constraintdef(oid) FROM pg_constraint
--  WHERE conrelid='public.photos'::regclass AND contype='c';

photos_must_have_parent  (convalidated = true)  -- SEVEN arms
CHECK (((event_id IS NOT NULL)
     OR (project_id IS NOT NULL)
     OR (location_id IS NOT NULL)
     OR (plant_id IS NOT NULL)
     OR (inventory_item_id IS NOT NULL)
     OR (space_id IS NOT NULL)                                     -- V4-SPACEPHOTO-001
     OR COALESCE((intake_status = 'pending_tag'::text), false)))   -- this migration

photos_intake_status_valid  (convalidated = true)
CHECK (((intake_status IS NULL)
     OR (intake_status = ANY (ARRAY['pending_tag'::text, 'upload_failed'::text]))))
```

**Seven arms is the floor.** Both `space_id IS NOT NULL` and the `COALESCE(...)` intake term must
survive every future edit. The `COALESCE` wrapper is load-bearing and must never be simplified to
a bare equality: a CHECK rejects only on FALSE and *passes* on NULL, so a bare
`intake_status = 'pending_tag'` on a NULL row yields NULL, the whole OR-chain yields NULL, and the
row is **accepted** — silently re-admitting the accidental-orphan class this constraint exists to
stop. See `0a-additive-ddl.sql` §2.

## Why the `schema_version` marker exists

This migration originally wrote **no** `schema_version` row, breaking the convention every other
2026 migration follows (`INSERT ... ON CONFLICT (version) DO NOTHING` at the tail — cf.
`../v4-putupprov-001/0a`, and `../v4-spacephoto-001/0c:12-18`, which backfilled itself for exactly
this reason). Prod therefore carried the columns, the three indexes and the widened constraint with
**no recorded fact that the migration had run** — applied-state was recoverable only by
hand-reading `pg_constraint`.

That is not a bookkeeping nit; it was a live hazard. An unmarked migration reads as an *unapplied*
one, and the obvious next move on an unapplied migration is to replay it. Replaying the original
`0a` against prod would have:

1. hit a hard error on `ADD CONSTRAINT photos_intake_status_valid` (PostgreSQL has no
   `ADD CONSTRAINT IF NOT EXISTS`) — and **that accident was the only thing protecting prod**;
2. and if that error were "fixed" the obvious way, fallen through to a bare `DROP` + `ADD` of a
   **six-arm** predicate with **no `space_id` term**, silently narrowing the constraint.

Both replay outcomes were reproduced on a throwaway PostgreSQL 17 instance against a prod-shaped
fixture, using the original block extracted verbatim from commit `a408285`:

- **with no space-only row present** (prod's state today: 1 row has `space_id`, and 0 rows would
  violate the six-arm predicate) — the block applies **cleanly, exit 0, no error, no warning**, and
  every subsequent space-only `INSERT` fails `23514`. Silent narrowing.
- **with a space-only row present** (prod's state as soon as `SPACE_PHOTOS_ENABLED` produces one) —
  the `DROP` succeeds, the `ADD` fails on the existing row, and the table is left with **no parent
  constraint at all**. Fail-open.

Marker + guard together retire both.

## Replay safety

`0a-additive-ddl.sql` is now idempotent and replay-safe. The constraint block derives its widening
from the **live** predicate (`pg_get_constraintdef`) instead of hardcoding an arm list, so whatever
arms exist are carried forward verbatim and a future eighth arm needs no edit here. Exactly three
outcomes, no fourth:

| Live state | Outcome |
|---|---|
| constraint already carries the intake arm (**prod today**) | **no-op**, `RAISE NOTICE` |
| constraint lacks it (fresh/rebuilt staging replaying in order) | widen, preserving every live arm, via `ADD NOT VALID` → `VALIDATE` → `DROP` → `RENAME` |
| `photos.space_id` exists but the predicate lost it, **or** the constraint is absent | **`RAISE EXCEPTION`**, loudly |

Silent narrowing is not reachable from any of the three. Verified on PostgreSQL 17 across six
scenarios: fresh widen, double replay, prod-shaped 7-arm no-op (byte-identical constraint before
and after; space-only `INSERT` still accepted), narrowed-DB tripwire, absent-constraint tripwire,
and a `NOT VALID` live constraint (suffix-strip path). The null-safety invariant is asserted
functionally in the fresh-widen case: a parentless non-intake row is rejected, a `pending_tag` row
is accepted.

The widen branch runs its `ADD NOT VALID` → `VALIDATE` → `DROP` → `RENAME` inside one `DO` block,
i.e. one transaction holding `ACCESS EXCLUSIVE`. That is fine for the small table that branch
targets. **If a genuine hot-table widening is ever needed, split it across `0a`/`0c` like
`../v4-spacephoto-001` does** so `VALIDATE` gets its own transaction.

## Known state (as of 2026-08-04)

- Backend shipped in prod (v3.55.0): batch presign, content-hash dedupe, inbox drain on tag.
- **Client never wired** — `src/lib/imagePipeline.js` has no importer, so `0/989` prod rows carry
  `content_hash` or `taken_at`.
- `idx_photos_intake_pending` is on `(created_by, taken_at)` and is **inert today** because nothing
  writes `taken_at` and no query orders by it. It was authored for the not-yet-landed inbox list
  route. **Do not "clean it up"** as an unused index.
- **Staging parity is UNVERIFIED.** Neither the constraint shape nor this marker has been checked
  or applied against `NEON_STAGING_URL`. Do that before any photobulk slice is dispatched to
  staging, and require the identical seven-arm string.
