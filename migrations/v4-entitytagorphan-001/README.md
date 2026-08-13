# v4-entitytagorphan-001 — a polymorphic foreign key, spelled as a trigger

Closes **`BUG-ENTITYTAGORPHAN-001`** (audit finding I3).

## What was wrong

`entity_tag` is polymorphic: `(entity_type, entity_id)`, where `entity_type` is CHECK-constrained to
`plant | cultivar | location | project` and `entity_id` is a bare uuid. **No foreign key is
possible** — the referent table is chosen by a sibling column, which Postgres cannot express — so
nothing at the database level ever stopped a parent being deleted out from under its tags.

Three `AFTER DELETE` triggers looked like cover:

| Table | Trigger | Deletes from |
|---|---|---|
| `plants` | `trg_delete_entity_tags_plant` | `entity_tags` ← **legacy plural, 2 rows** |
| `plant_projects` | `trg_delete_entity_tags_project` | `entity_tags` ← **legacy plural** |
| `locations` | `trg_delete_entity_tags_location` | `entity_tags` ← **legacy plural** |

None of them touches `entity_tag` (singular), the live table. They are no-ops wearing the costume of
a guarantee — and the inversion is sharper than that: they cover the three entity types that hold
**zero** tags, while **cultivar**, which holds **all 1,016**, had no trigger at all.

## Measured — live prod, 2026-08-13, owner DSN, unfiltered by `deleted_at`

| Fact | Value |
|---|---|
| `entity_tag` rows | **1,016** (989 live — the audit's headline was the live count) |
| …with `entity_type='cultivar'` | **1,016 — all of them.** Zero plant, location or project rows |
| Distinct cultivars tagged | 412 of 424 |
| Orphans today | **0**, across all four types |

**Why zero orphans is not reassuring.** Hard-deleting a cultivar is currently refused only because
`entity.cultivar_ref_id` is `ON DELETE RESTRICT` — from **DRG-ENGINE-002, an unrelated ticket** — and
a trigger auto-registers an `entity` row for every cultivar. That is *incidental protection*, the
same pattern `V4-SOFTDELCASCADE-001` refused to count when it found 29 of 74 containers accidentally
covered. It is also routinely defeated in two statements, and **the staging smoke purge does exactly
that today**:

```sql
DELETE FROM entity WHERE entity_type='cultivar' AND cultivar_ref_id IN (...);  -- :606
DELETE FROM plant_varieties WHERE name ILIKE '%smoke%';                        -- :607
```

Delete the registry row first and the cultivar becomes freely deletable, taking its tags' referents
with it.

The integration suite then supplied the sharpest evidence: `crop-types.int.test.js` **started
failing** on this migration, because creating a variety through `POST /api/varieties` mirrors its
crop type into the tag vocabulary and links it via `entity_tag`. **Every cultivar created through
the API carries a tag** — which is why 412 of 424 are tagged, and why the one unguarded type was the
one that mattered.

## The fix

One read-only function and four `BEFORE DELETE` triggers that raise **`23503`** — deliberately the
same SQLSTATE a real foreign key raises, so callers and suites already handling an FK refusal treat
this identically.

**It counts ALL rows, not just live ones.** A foreign key does not know what a soft delete is. A
soft-deleted association still names a parent, and `V4-SOFTDEL-001`'s second promise is that data
stays *recoverable* — an association whose referent is gone cannot be restored, only resurrected as
a dangling pointer. Guarding only `deleted_at IS NULL` would let the orphan count creep up invisibly
and would make `post_no_orphaned_entity_tag_rows` untrue over time.

### Escape hatch

```sql
DELETE FROM public.entity_tag WHERE entity_type = '<type>' AND entity_id = '<id>';
```

The guard's `HINT` points at this without spelling it, so that `post_guard_function_is_read_only` can
grep `prosrc` for write statements without tripping over its own error message.

## Why not the alternatives

- **Fix the three existing triggers to target `entity_tag`** — the tempting wrong answer. It would
  turn three dead no-ops into three live destroyers of 1,016 rows, cascading user-authored content
  on a parent delete, which is exactly what Soft-Delete-Only forbids.
- **`AFTER DELETE` trigger that soft-deletes the associations** — rejected for the reason
  `V4-SOFTDELCASCADE-001` rejected auto-archiving: it leaves the destructive action in place and
  merely makes the damage tidier. It still produces orphans; they just carry a `deleted_at`.
- **Split `entity_id` into four typed nullable FK columns with a one-of CHECK** — the genuinely
  correct schema, rejected on proportionality, not merit. It needs a data migration of 1,016 rows
  and a rewrite of every read path in `lambda/tags/index.js`, where the polymorphic shape is
  load-bearing (GARDENIA bulk mode joins on `entity_type`/`entity_id` directly). Worth revisiting if
  a fifth entity type is ever added.
- **Rely on `entity.cultivar_ref_id` RESTRICT** — covers one of four types, by accident, and the
  purge already routes around it.
- **Drop the legacy `entity_tags` table and its three dead triggers** — correct, but it belongs to
  `OPS-ENTITYTAGSDROP-001` with its own deploy-before-drop ordering. A table drop is not reversible
  the way a trigger is, and this migration stays revertible by dropping four triggers and a function.

## Deploy boundary

**Answer: NO writer coupling.** All 27 deployed prod bundles grepped for `DELETE FROM` at prod
`5c232164616228dfce4f3e669ef8011a2cf7a456` (v4.14.0): the only real statements are
`DELETE FROM favorites` and `DELETE FROM public.entity_memory`, **neither a parent of `entity_tag`**.
Every app DELETE route on the four parents soft-deletes. Safe to apply before or after a code deploy.

### Companion edits, same commit — the callers that *do* hard-delete

1. **`deploy-staging.yml`** smoke purge — gains an `entity_tag` sweep before the parent deletes.
   0-row no-op today; insurance against a future smoke path that tags something.
2. **`tests/integration/_cleanup.js`** — the namespace sweep never included `entity_tag` at all.
   Added before `plants`, which precedes all four parents. Also adds `NS_LOCATIONS`.
3. **`crop-types.int.test.js`** — clears the auto-created cultivar tag before hard-deleting the
   cultivar. Found by running the suite, not by reading it.

`tags-authz.int.test.js` needed nothing: it already deletes `entity_tag` first, forced there by
`entity_tag.tag_id -> tag(id)` being RESTRICT.

## Runbook

> **Push order is load-bearing.** `gate-invariants.yml` runs `--phase post --continuous-only` against
> both prod and staging on `migrations/**` pushes. Apply to **staging and prod before pushing**.

```bash
export NEON_DATABASE_URL=$(grep -m1 '^NEON_DATABASE_URL=' .env.local | sed 's/^NEON_DATABASE_URL=//' | tr -d '"')
```

1. Staging `pre` + `sweep` → all green.
2. Staging: apply `0c`, rehearse `0r`, re-apply `0c`. Confirm the guard count reads 4 → 0 → 4.
3. Run the full integration suite against a **fresh** ephemeral branch. Not a reused one — a reused
   branch accumulates fixture residue across runs and produces unrelated slug-collision failures
   that look like migration breakage. (Cost me one false red; recorded so it costs nobody else one.)
4. Staging `post` → 6/6.
5. Prod: `pre` + `sweep`, apply `0c`, `post` → 6/6.
6. Push, then confirm `gate-invariants.yml` green on both.

**Rollback:** `0r-rollback.sql` — drops four triggers and a function, safe at any time. It re-arms
the defect; read its header first.

## Verification record

- Staging `0r` rehearsed round-trip: guards 4 → 0 → 4.
- `entity-tag-orphan.int.test.js`: **14/14**, including the `cultivar` VIEW spelling and the
  soft-deleted-association case.
- Full integration suite on a fresh branch with the guard live: **34 files, 524 passing, 0 failures.**
- Gates: staging 6/6, prod 6/6; `v4-plantrehomefk-001` still 7/7 after its BEFORE-DELETE gate was
  amended (see below).

## Consequence for `v4-plantrehomefk-001`

That migration's `post_no_before_delete_trigger_on_touched_tables` **banned `BEFORE DELETE` triggers
on `plants`/`plant_projects` outright**, which would have blocked the correct fix for a defect on the
same tables. It banned the *mechanism* rather than the *hazard*. It is amended to
`post_no_writing_before_delete_trigger_on_touched_tables`: every `BEFORE DELETE` trigger there must
be a known guard **and** its function must be read-only. This migration's
`post_guard_function_is_read_only` checks the same body independently, so the two corroborate rather
than one trusting the other.
