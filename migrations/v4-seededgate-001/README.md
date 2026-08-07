# V4-SEEDEDGATE-001 — care-profile provenance moves out of band

**Status:** authored + executed read-only against live prod. **Nothing applied.**
**Ticket:** BUG-SEEDEDGATE-001. **schema_version:** `4.23.3-seededgate-001`.
**Design:** `cadence-resolver-design-V100-20260807.md` decision **D4** (`resolved_scopes`).
**Anchor:** authored against `origin/dev` = `origin/main` = `715dd2d954ed488ec0caf974f107b61a043d1723` (v4.1.0).

## The defect

`lambda/daily-plan/engine.js:32` adopts a DB-resolved cadence only when the merged profile carries
an in-payload `_seeded` marker:

```js
if(p && p.db_cadence && p.db_cadence._seeded) return {...p.db_cadence, _via:'db'};
```

Nine cultivar `care_profile` rows carry different provenance markers — eight carry
`_source: cowork_care_audit_20260709`, and Collards carries `source: dave_confirmed` — so their
researched intervals are invisible to the resolver and their plantings water on bundled-JSON
guesses instead.

## Why "just delete the `_seeded` check" is the wrong fix

`v_resolved_care` merges `system || cultivar || leaf` with the jsonb `||` operator, which is a
**shallow, top-level, right-wins key merge**. The single `system` row carries
`water_interval_days: 3`, and **146 of 159** cultivar rows express cadence under the *different*
key names `water_interval_days_container` / `_inground`. The system value is therefore never
shadowed.

Measured on live prod 2026-08-07: **all 102 active plantings with no cultivar row resolve to a
`resolved_profile` that is `jsonb`-EQUAL to the system row.** `resolved_profile` is never NULL and
always carries a plausible 3-day interval.

So without a provenance signal, a system-only row is **indistinguishable** from a researched one.
Dropping the gate would make every planting look researched and would destroy
`DRG-CADENCEFLOOR-001`'s observability signal outright. The marker is an accident that happens to
work; this migration replaces it with a structural fact.

## Two columns, and why one is not enough

| column | meaning | role |
| --- | --- | --- |
| `resolved_scopes` | which scopes have a row at all | observability |
| `cadence_scopes` | which scopes contributed a **non-null watering-interval key** | **load-bearing** — the resolver reads this |

They diverge on exactly one live row, and that row is the reason the distinction exists.

**Collards** (`d80353c0-45bc-407d-923c-73796acdb486`) has a cultivar `care_profile` row that
deliberately carries no watering keys. Its own `_scope_note` says so:

> `container-sizing only; watering/thresholds intentionally omitted so resolution still falls to system default (no behavior change)`

A naive predicate — *"did a non-system scope contribute?"* — would adopt that row, move Collards
from **2 days** (`genus:Brassica`, real horticultural content in the bundled JSON) to **3 days**
(the naked system default wearing a DB costume), and do so **against the row author's written
intent**. A regression shipped inside the fix. `cadence_scopes` is what prevents it, and the gate
`post_collards_class_is_preserved` asserts the class survives.

`'system'` is deliberately **absent** from `cadence_scopes`. The house constant is not evidence of
knowledge. **`cadence_scopes = {}` IS the unresolved signal.**

## Classification, verified read-only on live prod

The view body was executed standalone inside `BEGIN; SET TRANSACTION READ ONLY; … COMMIT;` before
this file was written. Over all `plants` rows (the view has no soft-delete filter and never had one):

| `_seeded` | cadence-bearing | `cardinality(resolved_scopes)` | rows | meaning |
| --- | --- | --- | --- | --- |
| yes | yes | 2 | 170 | resolve today, keep resolving |
| no | no | 1 | 123 | no cultivar row at all |
| **no** | **yes** | 2 | **9** | **the fix** |
| **no** | **no** | **2** | **1** | **Collards — must stay unresolved** |

Restricted to the engine's active population (249 plantings), the same four classes are
140 / 102 / 6 / 1. **Six plantings change resolution**, not the nine profiles and not the seven
plantings that merely have an unseeded row.

## Why this is a view change and not code

The merge is **lossy**. Once `system || cultivar || leaf` has collapsed into one object, no reader
can tell which scope supplied `water_interval_days`. That loss *is* the bug. Only the view sits
above the merge, so only the view can carry the answer.

Preconditions verified live before authoring, and re-asserted as `pre` gates:

* the view has exactly 2 columns today (`leaf_id` uuid @1, `resolved_profile` jsonb @2);
* it has **zero dependent objects** — no matviews, no dependent views, no non-owner grants, no
  `security_invoker` / `security_barrier` reloptions;
* exactly one `system` row exists (the view body uses a scalar subquery with no `LIMIT`, so a
  second system row would raise on *every* nightly run).

Postgres permits `CREATE OR REPLACE VIEW` to **append** columns provided existing names, types and
order are unchanged. All three are, and `post_original_columns_unchanged` asserts it.

## Two SQL traps this file is written around

**`array_remove(arr, NULL)` does not work.** It compares with `=`, and `x = NULL` is never true, so
it returns the array unchanged. The `ARRAY(SELECT x FROM unnest(...) x WHERE x IS NOT NULL)` idiom
is the working form.

**`jsonb_typeof(...) <> 'null'` is required, not decorative.** Twenty cultivar rows carry
`water_interval_days_inground: null` — key **present**, value JSON null. The `?` containment
operator returns true for those, and `-> 'k' IS NOT NULL` does too. Either test alone would
classify a row with no usable interval as cadence-bearing. Both tests are needed.

## Apply order — the one non-negotiable constraint

**This file first, then the code.** Appending view columns cannot affect the deployed handler, which
selects `vrc.resolved_profile` by name. But the code slice that adds `vrc.cadence_scopes` to that
select **will throw** if the column does not exist yet, and that query is the nightly planting
query — an empty daily plan for every user.

1. **Migration** (this file): staging → prod, `pre` → `0a` → `post`. Dave-gated.
2. **Then code**: `handler.js` selects the new columns; `engine.js` reads `cadence_scopes` behind
   `CARE_CADENCE_SCOPES_ENABLED`, default OFF. Inert.
3. **Then deploy**, flag still OFF. Confirm with `scripts/rerun-daily-plan.sh --diff` → `no drift`.
4. **Then flip the flag** and re-diff. Expect exactly the 6-planting delta, nothing else.

Rollback (`0r`) runs in the reverse order: code first (or flag off), *then* the view — for the same
reason.

## What changes when the flag is finally flipped

Six plantings move. Five move **later** (+1 to +2 days), one moves **earlier**.

| planting | old | new | note |
| --- | --- | --- | --- |
| Christmas Cactus | 7 | 8 | inert — `status='dormant'`, skipped before any watering computation |
| Chives | 3 | 4 | |
| Echeveria | 10 | 12 | |
| Echeveria (mail order) | 10 | 12 | |
| Garlic Chives | 3 | 4 | |
| **Jade Plant** | 16 | **12** | **Jen's.** The only one that gains a task on flip day |
| ~~Collards~~ | 2 | *unchanged* | blocked by `cadence_scopes` — this is the point |

**`PLAN_SCHEMA_VERSION` is NOT bumped.** It gates the *items task-array shape*, and this changes
values inside existing fields, not the shape. Bumping it would blank the Today list for both users
for the length of the deploy wave (three readers assert it and deploy unordered).

## Not in scope, and why

* **The `crop_type` scope, `scope_slug`, and the `care_scope_id_shape` CHECK rework** — design §5.5.
  Those belong to S1, where `crop_type` rows need a non-UUID key. D4 needs none of it.
* **Deleting the naked 3-day default** (D2), **deleting the bundled JSON** (D1/S4), and the five
  open design questions — all downstream of this, none blocking.
* **`cold` block absence.** Eight of the nine unseeded profiles carry no `cold` object while their
  bundled-JSON counterparts do. Inert today *by coincidence* — every affected plant either matches
  `/houseplant|succulent|cactus/i` (which returns before the `cold` lookup) or already had
  `tender:false`. This is a data-quality gap in the `cowork_care_audit_20260709` batch, not a
  property of this design, and it will bite the first tender plant that gets an unseeded profile.
  Needs its own ledger item and a guard test.

## Files

| file | what |
| --- | --- |
| `0a-view.sql` | `CREATE OR REPLACE VIEW` appending both columns + `schema_version` row |
| `0r-rollback.sql` | `DROP VIEW` + recreate the verbatim prior 2-column definition |
| `gates.yml` | 6 `pre`, 2 `sweep` (the two provenance classes), 6 `post` |
