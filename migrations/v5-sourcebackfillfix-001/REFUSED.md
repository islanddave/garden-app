# V5-SOURCEBACKFILLFIX-001 — NOT WRITTEN. There is no migration in this directory, and there should not be.

**This directory holds one file and no SQL.** It exists so that the next person who opens
`BUG-SRCBACKFILLMISS-001` lands here, next to the migration they were about to patch, and reads why
patching it is the wrong move. There is deliberately no `gates.yml` — `gate_runner.py --all` globs
`migrations/*/gates.yml`, so this directory is invisible to the corpus run and nothing here can be
applied by accident.

The lane was briefed to author a repair migration re-pointing the rows that
`v5-sourcebackfill-001`'s `post_every_pre_existing_row_was_matched` reports as unmatched. The brief's
premise — *the backfill missed a spelling* — is **false**, and it is falsifiable from prod's own
audit trail. Every affected row **was** matched by the backfill and **lost its pointer afterwards**.
A migration re-pointing them would repair the symptom, go green, and go red again the next time Dave
edits a planting.

Everything below was measured against live prod Neon (`neondb`) on **2026-09-07**, read-only. Nothing
was applied to any database.

## The gate is right, and it is counting up

| when | `post_every_pre_existing_row_was_matched` on prod |
|---|---|
| ~2026-09-04 (as briefed) | 3 |
| 2026-09-07 17:58Z (measured) | **7** |

Four of the seven were lost on 2026-09-07 alone, three of those inside a 15-minute window
(12:36–12:51Z). This is not a static residue from a one-time backfill. It is an ongoing loss.

Staging reads 0 for the same gate, but that is vacuity, not health: staging carries **zero**
`plants` rows with `source_ref` at all (measured; receipt `5.0.0-sourcebackfill-001` applied there
2026-09-04 15:40:39Z). Staging cannot exhibit this bug because staging has no data to lose.

## The seven rows, and the proof they were matched

`public.source` totals per spelling are **unchanged** from the reviewed export
(`prod-spellings-20260903.tsv` and `-20260904.tsv` agree): Botanical Interests 31, Long River Produce
Market 26, Ojos de Luna 4, Hatley Plant Swap 1. So no new free text was typed. Of those 62 rows, 7
now carry text and no pointer.

`public.audit_events` carries whole-row before/after snapshots on `plants`
(`trg_audit_plants_upd`, added by V5-SOURCEAUDITLOG-001's generic pair). It settles it:

| ts (UTC) | plant | `before.source_id` | `after.source_id` |
|---|---|---|---|
| 2026-09-05 19:41:14 | Belstar Broccoli | `510c3fe0…` Botanical Interests | **absent** |
| 2026-09-05 19:41:29 | Purple Vienna Kohlrabi | `510c3fe0…` Botanical Interests | **absent** |
| 2026-09-06 16:25:55 | Cantaloupe | `66cc22a1…` **Hadley Plant Swap** | **absent** |
| 2026-09-07 12:36:51 | Silver Helichrysum | `db3b919a…` Long River Produce Market | **absent** |
| 2026-09-07 12:50:40 | Pinto Premium White Geranium | `db3b919a…` Long River Produce Market | **absent** |
| 2026-09-07 12:51:12 | Purple Heart | `32e02e30…` Ojos de Luna | **absent** |
| 2026-09-07 12:51:30 | Wishbone Flower (Torenia) | `db3b919a…` Long River Produce Market | **absent** |

Every one held the **correct** pointer before the write that removed it. The backfill did its job on
all seven, including the Cantaloupe: `before.source_id` is Hadley Plant Swap, which is exactly what
`0b-backfill.sql`'s `'Hatley Plant Swap'` → `'Hadley Plant Swap'` rename statement was written to do.

Attribution over every post-apply `plants` UPDATE (2026-09-04 15:39:42Z onward):

| actor | erased a pointer | preserved one |
|---|---|---|
| `user_3D2gM0hIl03gjW3JM2DjtPzm0jI` | **7** | 18 |
| `system` | 0 | 6 |

Every erasure is a signed-in user editing a planting through the app. No cron, no Lambda internal, no
migration.

## Root cause

Five links. The first four are read directly from `origin/dev` at `9dde7539`; the fifth is the
observed effect. What has **not** been done is driving the editor end-to-end in a browser to watch it
happen — the chain is established from source and from the audit trail, not from a reproduction.

1. **The GET projections do not select the column.** `lambda/plants/index.js` has three
   `SELECT … FROM plants` blocks (≈275, ≈339, ≈605). All three carry `p.source_type, p.source_ref,
   p.source_generation`; **none** carries `p.source_id` or `p.acquired_from_source_id`. The only
   place either appears in a projection is the PUT's own `RETURNING` clause (1173).
2. **The form seeds from that projection.** `PlantingEditor.formFromPlant` reads
   `plant.source_id ?? ''` (:90). An absent key is `undefined`, so the form field seeds to `''` —
   indistinguishable from "the user cleared it".
3. **The field is always submitted.** `PLANT_FORM_FIELDS` (:37) lists `source_id` and
   `acquired_from_source_id` deliberately, so a planting whose only edit is its provenance reads as
   dirty. Correct on its own terms, and it means the key is in every patch.
4. **The submit binds it through `||`.** `PlantingEditor.jsx:249` and `:302`:
   `source_id: form.source_id || null`. `'' || null` is `null`, so the request carries an explicit
   present null.
5. **The Lambda obeys, because presence is the clear channel.** `hasSourceId =
   hasOwnProperty(body,'source_id')` (:863) arms the `CASE` at :1157. Present-and-null means CLEAR.

The Lambda comment at :855 **names this exact failure in advance**: *"A form binding `source_id:
form.source_id || null` therefore says 'clear' with a plain null."* The sentinel design is fine; the
client half was written the one way the comment warned against, and the projection gap is what makes
it fire on rows the user never touched. `source_ref` survives every one of these writes because it is
COALESCE-merged (:1103) rather than sentinel-gated — which is precisely why the row lands in the
gate's violation shape: text present, pointer gone.

**Why 18 writes preserved the pointer:** the PUT's `RETURNING` (1173) *does* include `source_id`, so
a row that has just been saved is repaired in client state and a second save from that same object
carries the real id. The exposure is per-row-first-edit, not per-edit.

**Scope, measured:** `inventory_items` is clean — 0 unmatched rows, 0 erasures. `acquired_from_source_id`
has 0 recorded erasures, but that is luck rather than safety: all seven affected rows had a NULL
`acquired_from` to begin with. The 12 `Jen from Four Phantoms` plantings carry a real
`acquired_from_source_id` and step 4 clears it by the same `||` on the same submit. That loss is
latent, not absent — and unlike `source_id`, the shop half is **not** recoverable from
`post_no_orphan_shop_without_an_originator`, which only catches the inverse shape.

**Nothing guards the projection.** `lambda/plants/select-columns.test.js:53` asserts all three GET
blocks carry `source_type, source_ref, source_generation`. It does not list the two FK columns, so
the suite is green and the omission is unasserted.

## Why no repair migration

1. **It would repair the symptom while the writer that causes it is live.** 3 → 7 in three days. A
   migration that applied today would be stale by the next editing session.
2. **The repair already exists and is already idempotent.** `v5-sourcebackfill-001/0b-backfill.sql`
   guards every UPDATE with `AND t.source_id IS NULL`, so re-running it verbatim re-points exactly
   the rows whose pointer is missing and is a no-op for everything else. A new migration would be a
   narrower duplicate of a file that already does the job — and narrower is *worse* here, because the
   brief scoped it to two rows and the real answer is currently seven and moving.
3. **There is no outstanding ruling to make.** The brief asked for evidence so Dave could rule on
   "Hatley Plant Swap". He already ruled it, on 2026-09-03: `dedupe-mapping.csv:28` records
   *"DAVE RULED 2026-09-03: 'hadley (not hatley)'"* — a `rename` to `Hadley Plant Swap`, high
   confidence, kept separate from Hatfield, with `Whately Plant Swap` ruled separately at :75/:76.
   `Hadley Plant Swap` exists on prod as `66cc22a1-bd48-4e6f-bc40-9f07ad06396b`, and the audit trail
   above shows the Cantaloupe *was* pointed at it. The premise that no entity exists came from
   testing `LIKE '%atley%'`, which cannot match `Hadley` — the ruled spelling. **Nothing here needs
   Dave's judgement; it needs the writer fixed.**

## The correct fix, in order

1. **Fix the client half** (`src/` — another lane's write partition, untouched here): stop sending a
   bare `null` for a field the form never loaded. Either send the key only when the picker was
   actually touched, or seed the form from a projection that carries the column.
2. **Close the projection gap** (`lambda/` — likewise): add `p.source_id, p.acquired_from_source_id`
   to the three GET `SELECT` blocks, and add both to
   `lambda/plants/select-columns.test.js:53` so the omission cannot come back green.
3. **Only then, re-run the existing backfill** — `v5-sourcebackfill-001/0b-backfill.sql`, unmodified.
   It is idempotent by construction and repairs whatever the count is at that moment.
4. Re-run `scripts/gate_runner.py --migration migrations/v5-sourcebackfill-001 --env prod`.

Doing 3 before 1 and 2 produces a green gate and a repeat of this bug.

## Dry-run receipt (prod, ABORTED transaction, 2026-09-07)

The four `0b-backfill.sql` statements matching the affected spellings, run verbatim inside
`BEGIN; … ROLLBACK;`:

```
BEFORE|7
UPDATE 2      -- 'Botanical Interests'
UPDATE 3      -- 'Long River Produce Market'
UPDATE 1      -- 'Ojos de Luna'
UPDATE 1      -- 'Hatley Plant Swap' -> Hadley Plant Swap
AFTER|0
ROLLBACK
POST_ROLLBACK|7
```

Read back after the rollback as a separate read-only statement: still 7. Nothing was committed.

This doubles as the **can-it-move** proof for the gate. `post_every_pre_existing_row_was_matched` is
not a stuck instrument: it read 7, then 0 under a repair, then 7 again when that repair was thrown
away — all in one session, on the real database, through the same predicate the corpus run uses.

## Provenance

Prod `neondb` via `NEON_DATABASE_URL` (owner role — `garden_ro` cannot read `schema_version` and so
cannot evaluate a self-arming gate at all). Repo state: `origin/dev` @
`9dde7539e1ffc6abec46794914562a9993d19c96`. Gate result reproduced with
`scripts/gate_runner.py --migration migrations/v5-sourcebackfill-001 --env prod --json`:
`post_every_pre_existing_row_was_matched … expected rowcount_eq=0, got rowcount=7`.

Also observed in that run and **out of this lane's scope**: `pre_catalogue_empty` reports FAIL on
prod. It is a `continuous: false` apply-window gate whose own note says it is "false forever once 0b
lands", so a `--phase pre` run after an apply is expected to red — noise from the phase selection,
not drift. Flagged, not touched.
