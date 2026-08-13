# v4-cascadesweep-001 — the last four destructive CASCADEs

Closes **four** audit rows in one apply window: `BUG-PHOTOINVCASCADE-001` (I2),
`BUG-ACHIEVECASCADE-001` (I4), `BUG-SHARELOGCASCADE-001` (I5), `BUG-FINDINGSCASCADE-001` (I6).

## What was wrong

| FK | Parent | Live rows at risk |
|---|---|---|
| `photos.inventory_item_id` | `inventory_items` | **6 photos**, across 4 of 351 items — all sole-anchored |
| `user_achievements.achievement_id` | `achievements` | **33 earned badges** against a 39-row catalog |
| `share_log.photo_id` | `photos` | 0 — latent, and a documented **contradiction** |
| `findings.garden_node_id` | `plants` | 0 — latent, defence in depth |

Each was one `DELETE FROM <parent>` away from destroying rows the application layer promises never
to remove. None is reachable from the app; all four are reachable from admin SQL, the CI purge and
test teardowns — the caller set this whole family of migrations has been about.

Per owner, never pooled: the 33 badges are Dave 24 / third sub 9.

## Why RESTRICT was the only viable action — not merely the preferred one

This sweep is unusually easy to argue, because for three of the four the alternatives don't exist:

**`NOT NULL` kills SET NULL outright** on `findings.garden_node_id`, `user_achievements.achievement_id`
and `share_log.photo_id`. A SET NULL cascade onto a NOT NULL column doesn't degrade gracefully — it
fails `23502`. The real choice on those three is CASCADE (destroy) or RESTRICT (refuse).

**The fourth is the EVTANCHORDEL class, exactly.** `photos.inventory_item_id` is an arm of the
disjunctive CHECK `photos_must_have_parent`, and **all 6 prod rows carry it as their sole anchor** —
every other arm is NULL. A SET NULL cascade there would null the last anchor and the CHECK would then
reject the row the cascade itself just produced (`23514`) — the precise defect `BUG-EVTANCHORDEL-001`
was written to eliminate, on 6 of 6 rows rather than latently. `evt-anchor-delete.int.test.js`
already carries a standing class guard forbidding SET NULL on any FK column that is an arm of a
disjunctive anchor CHECK; this column passed it only because it was CASCADE instead, which is worse.

## Why the two zero-row flips earned an apply window

`share_log` is the sharpest of the four. `lambda/photos/photoDelete.js:14-16` already states, in
prose, that a hard photo delete *"would SILENTLY DESTROY share history via share_log.photo_id (ON
DELETE CASCADE)"*, and its DD4 classification records `share_log` as the one **LEDGER** pointer:

> `share_log.photo_id` records that an image was posted to an external Facebook page. A soft delete
> inside this app cannot retract that post, so erasing the local record of it would make the ledger
> lie. RETAIN is a correctness decision, not laziness.

The code declared the invariant **and named the schema as violating it**. This migration makes the
schema agree with the prose. That is `BUG-PLANTREHOMEFK-001`'s false-comment defect inverted: there
a comment claimed a protection that didn't exist; here one correctly documented a hazard nobody had
closed.

`findings` is soft-deletable and holds diagnostic history about a planting. Hard-deleting a planting
is already refused by `event_log`/`photos`/`entity`/`entity_tag`, so this is defence in depth — it
stops `findings` being the one child still destroyed if any upstream guard were relaxed.

## Deploy boundary

**Answer: NO writer coupling.** All 27 deployed prod bundles grepped for `DELETE FROM` at prod
`5c232164616228dfce4f3e669ef8011a2cf7a456` (v4.14.0): only `DELETE FROM favorites` and
`DELETE FROM public.entity_memory` (a child-row delete). Nothing deployed hard-deletes
`inventory_items`, `achievements`, `photos` or `plants`. A repo-wide grep for
`DELETE FROM achievements` returns **zero hits anywhere** — that catalog has never had a delete path.
In-database: `archive_plant_events()` *detaches* photos before deleting events and never deletes a
photo row, so `share_log.photo_id` is untouched by it.

### Companion edits, same commit

1. **`tests/integration/_cleanup.js`** — the `photos` sweep didn't cover `inventory_item_id` while
   `inventory_items` is swept *after* it; adds that arm plus `NS_INVENTORY`. Also adds a `share_log`
   step (there was none) ahead of photos.
2. **`.github/workflows/deploy-staging.yml`** — the same two gaps in the smoke purge (photos `:595`,
   inventory_items `:605`). 0-row no-ops today; insurance.

`findings` and `user_achievements` already precede their parents in both sweeps — verified, not
assumed.

**Not affected, checked rather than assumed:** `scripts/preflight-photodelete.sh` compares the
`table.column` **set** of FKs referencing `photos` against `PHOTO_POINTERS` and does **not** compare
`confdeltype`. Flipping `share_log.photo_id`'s action leaves both its prod↔staging parity check and
its constant-sync check untouched. `PHOTO_POINTERS`' `action: 'retain'` is the app-level
classification — unchanged, and now *enforced* by the schema rather than merely described by it.

## This migration REVERSES a prior deliberate decision — say it out loud

`v4-fbshare-p1/gates.yml` carried `post_photo_fk_cascade`, asserting `share_log.photo_id` **is**
CASCADE, with the rationale *"a purged photo takes its share log with it."* That was a real choice,
not an oversight, so reversing it is not a tidy-up and it is not allow-listed away. The gate is
rewritten to `post_photo_fk_restrict` with the supersession recorded in place.

Why the reversal holds:

- **`photoDelete.js` DD4 already said the opposite**, and said it with reasons: `share_log` is the
  one LEDGER pointer that must RETAIN, because a post to an external page cannot be retracted by
  deleting our record of it. The schema and the handler disagreed; the handler is right.
- **The purge the old rationale assumed does not exist.** Repo-wide, every `DELETE FROM photos` is a
  test teardown — there is no photo-purge job in any deployed bundle. `orphan_cleaned` is reached by
  `UPDATE` in `lambda/facebook-share/index.js`, never by deleting a photo. Nothing was relying on the
  cascade.
- **`share_log` holds 0 rows in prod**, so the flip changes no behaviour today.
- The supported path is untouched: `photoDelete.js` soft-deletes and retains the share row. RESTRICT
  only ever refuses a *hard* delete — pinned by a test.

Only the whole-corpus gate run surfaced this conflict; the per-migration run was green. Same lesson
as the trigger-inventory allow-lists (L-372).

## The class gate, and an honest note on its scope

`post_no_cascade_onto_a_soft_deletable_table`: **no FK in `public` may CASCADE into a table carrying
`deleted_at`.** Such a table has declared itself soft-delete-only, so a CASCADE into it is a
contradiction inside the schema, whatever the app does.

**It covers only two of this migration's four flips**, and saying so is the point — an overstated
gate is how "a guard already covers this" becomes false. `findings` and `photos` carry `deleted_at`;
`share_log` and `user_achievements` do not (append-only ledger/award tables). Those two are pinned
individually.

A broader criterion was **measured and rejected**: keying on `deleted_at OR created_by OR user_id`
matches 8 FKs, needs a five-entry allow-list of things that *should* cascade
(`notification_subscriptions.user_id`, `plant_anchor_derivation.plant_id`, `spacetheme.space_id`,
`inactive_project_dismissals` ×2) — and still misses `share_log`, which carries none of the three. A
gate with more exemptions than findings asserts less, not more.

Out of scope and still open: `spacetheme.space_id` cascades off `spaces`, which has no `deleted_at`
at all — that's `V4-SPACESOFTDEL-001` (audit I8).

## Runbook

> **Push order is load-bearing.** `gate-invariants.yml` runs `--phase post --continuous-only` against
> both prod and staging on `migrations/**` pushes. Apply to **staging and prod before pushing**.

1. Staging `pre` + `sweep` → green.
2. Staging: apply `0c`, rehearse `0r`, re-apply `0c`. Confirm the four actions read `rrrr` → `cccc` →
   `rrrr`.
3. Full integration suite against a **fresh** ephemeral branch (never a reused one — see L-373).
4. Staging `post` → 5/5.
5. Prod: `pre` + `sweep`, apply `0c`, `post` → 5/5.
6. Whole gate corpus, both envs, then push.

**Rollback:** `0r-rollback.sql`, safe at any time — widening a referential action never fails on
existing data. It re-arms all four; read its header first.

## Verification record

- Staging `0r` rehearsed round-trip: `cccc → rrrr → cccc → rrrr`.
- `cascade-sweep.int.test.js`: **14/14**, including the sole-anchor pin, the "soft delete still
  works" case, and the NOT-NULL pin that keeps the *argument* honest and not just the conclusion.
- Full integration suite on a fresh branch: **35 files, 538 passing, 0 failures.**
- Gates: staging 5/5, prod 5/5; whole corpus green on both envs.
