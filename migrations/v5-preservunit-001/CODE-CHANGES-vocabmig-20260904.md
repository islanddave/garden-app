# Code changes required by V5-PRESERVUNIT-001 and V5-PUTUPCANDY-001

Spec only. **The vocabmig lane wrote no code** — `lambda/preservation/**` and `src/pages/PutUp.jsx`
were owned by concurrent lanes on 2026-09-04, so every edit below is described rather than made.
Line numbers are against `origin/dev` @ `1909c4e` (v4.110.0) and will drift; each item names a
searchable anchor as well.

Two migrations, two independent orderings, and **they are opposite**:

| | direction | safe order |
|---|---|---|
| V5-PRESERVUNIT-001 phase A (`0a`) | widening | apply any time, no code dependency |
| V5-PRESERVUNIT-001 phase B (`0b`) | **narrowing** | **code first**, then apply |
| V5-PUTUPCANDY-001 (`0a`) | widening | **apply first**, then code |

Getting either backwards produces a 23514 that reaches the user as
`"Couldn't update — try again."` — `put()`'s generic catch (`PutUp.jsx:1983`) swallows the status, and
there is no unit-level validation in the Lambda to turn it into a legible 400.

---

## §1 — V5-PRESERVUNIT-001. Release **R1**, which must ship BEFORE `0b` is applied.

`0a` needs none of this. `0b` needs all of it live in prod first.

### 1.1 `src/pages/PutUp.jsx` — `UNIT_GROUPS` (:122-128)

Replace the plural values with the canonical singulars. Keep the group structure and order.

```
Weight     ['lb', 'oz']
Count      ['count']
Volume     ['cup', 'pint', 'qt']
Bulk       ['bushel', 'half-bushel', 'peck', 'flat']
Containers ['jar', 'bag']
```

`'quarts' → 'qt'` and not `'quart'`: `inventory_items_unit_check` and `chk_kbi_qty_unit` both
already spell it `qt`, and `quart` would be a fourth spelling of the one unit that already has three.

**Update the comment block at :109-117 in the same edit.** It currently reads "STILL NO DB CHECK ON
quantity_unit, and that is now a considered decision rather than an omission" and gives two reasons
that this migration answers rather than ignores — both integration objections dissolve against a
singular target, because `lb`, `oz`, `count`, `pint` and `jar` are all canonical. Leaving that
comment in place after the CHECK exists makes the file lie about its own schema.

### 1.2 `src/pages/PutUp.jsx` — display pluralisation

`UNIT_GROUPS` currently doubles as pick-list **and** display string. Three sites render the stored
value straight at the user and would start reading "2 qt", "14 cup":

- `PutUp.jsx:2020` — `{rec.quantity_value} {rec.quantity_unit}`
- `PutUp.jsx:2016` — the photo `alt` text
- `src/components/PutUpUseSoonBand.jsx:44` — `` `${it.quantity_value} ${it.quantity_unit}` ``
- `src/components/planting/PutUpFromPlanting.jsx:133, 169, 172`

Add one shared helper (a `src/lib/` module, not a per-file copy — L-384) that maps a canonical unit
plus a count to a label: `1 → 'cup'`, `2 → 'cups'`, `'qt' → 'quart'/'quarts'`, `'count' → 'count'`
in both. It must pass a **legacy plural through unchanged** so a row not yet normalised still renders.

### 1.3 `src/pages/PutUp.jsx` — the two `useState` defaults

- `:855` `useState(prefill.quantity_unit || 'lbs')` → `'lb'`
- `:2092` `useState(rec.quantity_unit || 'lbs')` → `'lb'`

`:855` is the one that matters most: it means **every new put-up sends `'lbs'` by default**, so a
narrowed CHECK without this edit fails on creation, not on some edge path.

### 1.4 `src/pages/PutUp.jsx` — `RowEditor` legacy tolerance (the select at :2130)

A controlled `<select>` whose `value` matches no `<option>` renders with `selectedIndex = -1`, i.e.
**blank**. Between `0b` and a user's next hard reload that is the visible defect; before `0b` it is
what happens to any row an admin normalised by hand.

When `rec.quantity_unit` is not in `UNIT_GROUPS`, prepend a transient disabled `<option>` carrying
that exact value so the control shows the truth. Verified behaviour, not theory: the state variable
keeps the stored spelling and an untouched save round-trips it correctly, and "Mark used" bypasses
the editor entirely through `buildFullPayload` — so this is a rendering fix, not a data fix. Drop it
in R2 if you like; it is cheap to keep.

### 1.5 `src/lib/putUpPrefill.js` — `HARVEST_TO_PUTUP_UNIT` (:30-37)

Retarget the values, not the keys:

```
lb: 'lb'   oz: 'oz'   count: 'count'   cup: 'cup'   bunch: 'count'   head: 'count'
```

`kg`/`g` stay absent for the reason the header already gives — mapping them needs an arithmetic
conversion, and `mapHarvestUnit` returning `null` makes the caller drop the quantity **pair** rather
than write a guess. Note the pleasant consequence of the singular target: four of the six mappings
become identity, and the harvest and put-up vocabularies finally agree on the units they share.

### 1.6 `lambda/preservation/index.js` — add `VALID_UNITS` (beside `VALID_METHODS`, :36-52)

Today `validateCommon` (:164) only tests non-blank:

```js
if (!body.quantity_unit || !String(body.quantity_unit).trim()) return 'quantity_unit is required';
```

Add a vocabulary list and check membership, in the shape `VALID_METHODS` already uses at :160 so the
error names the field and the allowed set. **This is what turns a DB 23514 into a legible 400**, and
it is why the Lambda half of R1 is not optional.

**Ship the 22-value UNION here, not the canonical 12** — R1's own frontend is not the only writer;
a service-worker-cached bundle emitting `'lbs'` must still get a 200 until `0b` lands. Narrow it to
12 in R2, after `0b`.

### 1.7 `src/__tests__/` — a units parity test

Model on `putUpMethodParity.test.js`. Bind: `UNIT_GROUPS` (already exported for exactly this),
`HARVEST_TO_PUTUP_UNIT`'s value set, the Lambda's new `VALID_UNITS`, and the CHECK in
`migrations/v5-preservunit-001/0a-additive-ddl.sql` and `0b-normalise-and-narrow.sql`.

Two hazards specific to this vocabulary:

- **The method extractor's regex will silently miss two values.** `checkConstraintValues` uses
  `/'([a-z_]+)'/g`, which does not match `'half-bushel'` or `'half-bushels'`. Widen the class to
  include the hyphen, or the test certifies parity over 20 of 22 values while reporting success.
- **Assert the mapping, not just the sets.** `0b`'s `CASE` must be exhaustive over the 10 legacy
  values and every arm must land in the canonical 12; a set-equality test passes with the arms
  scrambled.

Prove non-vacuity per the house rule: state the mutation that turned each assertion red.

### 1.8 Test fixtures that hardcode plural units

These pass today and are not wrong, but they encode the old vocabulary. Update in the same commit or
they become the reason a later reader believes plurals are still canonical:

`src/__tests__/PutUpRecentHarvest.test.jsx:191-192` (asserts `'cups'` and explicitly *not* `'cup'` —
that assertion **inverts** under this change), `putUpPrefill.test.js:107` (`'cups', // mapped, NOT
the entry's 'cup'` — same inversion), `PutUp.test.jsx:46`, `PutUpFromPlanting.test.jsx:25, 33, 117,
119, 167`, `PutUpUseSoonBand.test.jsx:29, 41`.

`tests/integration/preservation*.js` needs **no change**: its 31 × `'lb'`, 2 × `'pint'`, 1 × `'oz'`
and 1 × `'jar'` are all canonical already. That is the objection at `PutUp.jsx:114` answered rather
than dodged.

### 1.9 R2 (optional, after `0b`)

Narrow `VALID_UNITS` to the canonical 12; drop 1.4's legacy tolerance. Nothing breaks if this never
happens — the DB is the binding gate by then.

---

## §2 — V5-PUTUPCANDY-001. Ships AFTER `0a` is applied to prod.

Within the release, the **Lambda half must not trail the frontend half** — `deploy-lambda.yml` and
`deploy.yml` are separate workflows, and a picker offering an option the API rejects is a dead
control that 400s. If they cannot be ordered, ship the Lambda in one release and the picker in the
next.

### 2.1 `lambda/preservation/index.js` — `VALID_METHODS` (:36-52)

Add `'candy'` before `'other'`.

### 2.2 `lambda/preservation/index.js` — `SHELF_LIFE_MONTHS` (:64-114)

```js
// V5-PUTUPCANDY-001. ⚠ THE FIRST ENTRY IN THIS TABLE WITH NO PUBLISHED SOURCE. The session
// food-safety research (project-state/_build-inflight-20260904/foodsafety-research.md §6.3, §9.1)
// searched NCHFP, UGA, Penn State, OSU, UMN, USU, MSU and NC State and found NO home guidance on
// candied-fruit endpoints, storage or shelf life — "there is nothing to cite". Every figure below
// comes from Dave's own house guide, unsweet-watermelon-guide-V100-20260811.html, and must NEVER be
// described as Extension- or USDA-backed the way the rows above legitimately can be.
//   deep_freezer 6   — guide Part 5 "Candied rind, uncoated ... ~6 months"; Part 6 "undusted 6
//                      months frozen". The one figure the guide states directly.
//   fridge_freezer 4 — NOT stated by the guide. Derived by this table's own existing convention
//                      (header: deep_freezer takes the upper end, fridge_freezer the lower, being
//                      not held at 0°F) plus the guide's "self-defrost cycling is the specific
//                      enemy". Marked as derived, not measured.
//   default 1        — the room-temperature case, and it is THE TABLE'S FLOOR rather than an answer.
//                      The guide says 2-3 weeks; months are the unit and addMonths() takes an
//                      integer, so 1 is the shortest expressible non-zero and it OVERRUNS the guide
//                      by about a week. 0 would read "past use by" on day one (a false alarm the
//                      contract forbids); null would make the row invisible to use-soon forever,
//                      which is the failure this whole change exists to prevent. Anything above 1
//                      would be invention.
candy: { deep_freezer: 6, fridge_freezer: 4, default: 1 },
```

`fridge`, `pantry` and `cold_storage` are deliberately **not** listed: they fall through to
`default: 1`, which is the same number without implying a per-kind judgement nothing supports.

**Also amend the table's own header comment at :33-39.** It currently asserts every figure is
NCHFP/USDA-sourced and "must NOT be one-person hand-invented". After `candy` lands that sentence is
false as written; it needs a clause admitting one house-sourced entry, or the comment misrepresents
the table to the next reader.

### 2.3 The three client vocabulary maps — all in one commit

- `src/pages/PutUp.jsx` `METHOD_GROUPS` (:57-95) — add `{ value: 'candy', label: 'Candied' }`.
  Highest-consequence of the three: an unmapped stored method makes the row editor's `<select>` show
  a different option, and saving that row **rewrites the method**.
- `src/components/PutUpUseSoonBand.jsx` `METHOD_LABELS` (:33) — `candy: 'candied'`. Unmapped methods
  are silently dropped from the detail line.
- `src/components/planting/PutUpFromPlanting.jsx` `METHOD_LABELS` (:51) — `candy: 'Candied'`.
  Unmapped falls back to the raw slug.

### 2.4 `src/__tests__/putUpMethodParity.test.js` — **this WILL go red; budget for it**

Not optional and not one line. The test currently reads its expected vocabulary out of
`migrations/v4-putupmethod-001/0a-additive-ddl.sql` (:59) and carries a **hardcoded size guard**:

```js
])('%s parsed to a populated vocabulary', (_label, set) => { expect(set.size).toBe(18) })
```

Adding `candy` to the four code surfaces makes **six** of those `toBe(18)` assertions fail at 19,
while `DB_VOCAB` stays at 18 and every set-equality assertion fails too. Required edits:

1. Point `migrationSql` / `rollbackSql` / `gatesYml` at `migrations/v5-putupcandy-001/`.
2. `18 → 19`, and add a `ROLLBACK_VOCAB.size` expectation of **18** (the new `0r` narrows to 18, not
   to 14).
3. Keep `PRE_BD034` and `ADDED_BY_BD034` as they are and add `ADDED_BY_PUTUPCANDY = ['candy']`. Both
   existing lists are pinned rather than derived on purpose — deriving them from the source under
   test would assert nothing.
4. Extend `SHELF_ENTRIES` coverage so `candy` having a `SHELF_LIFE_MONTHS` entry is asserted. **This
   is the only guard anywhere on the precondition that makes this migration worth doing**; no SQL
   gate can see it, and `v5-putupcandy-001/gates.yml` says so explicitly.

This is the frozen-count-gate class: a count baked into a test that a later widening invalidates.
Whoever ships §2 owns it, and CI blocks until they do.

### 2.5 Prompt for `use_by_target` on a candy row — recommended, not required

The research's structural finding (§9.3) is that every affordance the published corpus supports is
"either a prompt to go do something or a clock that starts after someone else has made the
determination. Not one of them is an assessment of the batch." A silently computed 1-month use-by on
a candy row is an assessment, and it is the one figure in the table with nothing behind it.

So on `method === 'candy'`, surface the `use_by_target` field pre-filled from the default and
labelled as a house estimate ("about a month — set the real date if you know it"), rather than
computing it invisibly. `use_by_target` is already per-row and user-overridable (L6), so this needs
no schema change; what is missing is the ask. This converts an unsourceable claim into a question,
which is the only defensible shape available here.

### 2.6 Not built, deliberately — the per-output shelf-life attribute

Recorded in `v5-putupcandy-001/0a-additive-ddl.sql`'s header and repeated here so it is not lost:
`finish_kind text` + `shelf_life_days int` on `preservation_log`, write-once at close-out, absent
from `PRESERVATION_EDITABLE_COLUMNS`. One batch legitimately spans ~3 weeks to ~6 months across its
outputs depending on which dust was used, and a per-method constant cannot express that. The
per-output **structure** already exists — `preservation_log.batch_id` from V5-INFLIGHTBATCH-001 fans
one batch out to N rows — so only the shelf-life axis is missing. A column with no writer is inert,
and the writer is the batch close-out route being built this week.
