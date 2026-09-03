# V5-SOURCEENTITY-001 — design note

**Status 2026-09-03: NOT APPLIED ANYWHERE.** Substrate only — no backfill, no Lambda, no UI. Every
number below was measured against live prod Neon (`neondb`, PostgreSQL 17.11) on 2026-09-03.

| File | What it is |
|---|---|
| `0a-additive-ddl.sql` | The migration. New `public.source`; two nullable FK columns on each of `plants` and `inventory_items`. Nothing dropped, nothing altered, nothing backfilled. |
| `0r-rollback.sql` | Rehearsable rollback to greenfield. |
| `gates.yml` | 25 gates (6 pre / 2 sweep / 17 post). No `env:` key anywhere, so every gate runs on **both** staging and prod. |
| `dedupe-mapping.csv` | **For Dave.** All 73 free-text spellings on the left, proposed canonical source on the right, with confidence and a one-line reason. |
| `proposed-sources.csv` | **For Dave.** The 53 catalogue rows that mapping implies — the labels that live in the picker forever after. |
| `dedupe-mapping.gen.py` | Reproduces `dedupe-mapping.csv`. Hard-fails if its left column drifts from prod. |
| `proposed-sources.gen.py` | Reproduces `proposed-sources.csv` from the mapping. |
| `prod-spellings-20260903.tsv` | The verbatim prod export both generators join against. |

Both CSVs are **generated and byte-reproducible** from the co-located `.tsv`. `proposed-sources.csv`
counts a source's rows twice over — `rows_affected` (as the originator, `source_id`) and
`rows_as_acquired_from` (as the shop, `acquired_from_source_id`) — because a source that is *only*
ever a shop would otherwise read as "0 rows" and look ignorable. `Gardener's Supply Company` is
exactly that row: 0 as originator, **12 as shop**.

---

## The problem, in numbers

"Where did this come from" is free text in **five** places, with no shared vocabulary between any two:

| Surface | Rows | Distinct spellings |
|---|---|---|
| `plants.source_ref` | 182 (166 live, 16 soft-deleted) | 41 |
| `inventory_items.source` | 385 | 32 |
| `inventory_items.metadata->>'vendor'` | 202 | 10 |
| `inventory_items.metadata->>'purchase_location'` | 12 | 1 |
| `inventory_items.metadata->>'retailer'` | 10 | 1 |

73 strings across the two columns → ~53 canonical places (fewer once Dave rules on the flagged
merges). Four strings appear verbatim in *both* columns; nine real places appear in both.

**The drift has already reached the layer that was supposed to be clean.** `metadata.vendor` was
populated by hand as the deduplicated brand name — and it already holds *both* `High Mowing Organic
Seeds` and `High Mowing`. A free-text field cannot hold a vocabulary, however carefully it is
populated the first time. That is the whole argument.

---

## 1. Why one shared entity, not one table per parent

Three reasons, in order of weight.

**It is the same object.** Nine real places already appear in both columns — Amazon, Home Depot,
Botanical Interests, High Mowing Organic Seeds, Seed Savers Exchange, Greenfield Farmers Co-op,
Belchertown Plant Swap, and the Gardener's Supply and Lake Valley pairs. Two tables means two rows
for Botanical Interests, two websites to keep in step, and two places for Dave's note about whether
they are reliable — which is the field most likely to be written once and then looked for in the
other table.

**One question stops being answerable.** "What have I ever got from Long River Produce Market" spans
26 plantings and (separately) seed lots. With two tables that is a UNION over two unrelated id
spaces, so nothing in the UI will ever ask it. With one table it is one index scan on
`idx_plants_source_id` / `idx_inventory_source_id`.

**The code already bridges them.** `src/components/PlantingEditor.jsx:167-180` (V4-SOWSOURCE-001)
copies a seed packet's provenance onto the planting it grows into, with precedence
`metadata.vendor → brand → source` truncated at the first `;`. The sow-from-packet flow already
treats these as one concept and hand-marshals between the two spellings. A shared entity replaces
that marshalling with a foreign key.

The counter-argument — a nursery and a hardware retailer are different kinds of thing — is real and
is answered by `source.kind`, not by a second table.

## 2. `source.kind` is a third **axis**, not a third **vocabulary**

This schema has fragmented a provenance vocabulary once already (`plants.source_type` lost its CHECK
on 2026-07-07, `v4-source-freetext`), and V4-SEEDORIGIN-001 exists partly to prevent a second. So
this has to be argued, not assumed.

The two existing vocabularies describe **the transaction** — how one row was acquired:

- `plants.source_type` — free text. Live: `nursery_transplant` 114, NULL 95, `seed_packet` 49,
  `rescued` 37, `gift` 12, `division` 4, `plant_swap` 4, `unknown` 2, `volunteer` 1.
- `inventory_items.source_kind` — CHECK-constrained to `VALID_SOURCE_KINDS`
  (`lambda/preservation/provenance.js`). **100% NULL on prod** — substrate only.

`source.kind` describes **the place** — stable across every transaction with it. They are measurably
independent in Dave's own rows:

- *Long River Produce Market* is `rescued` on 26 plants and `volunteer` on 1.
- *Belchertown Plant Swap* carries `plant_swap`, `gift` **and** `nursery_transplant` across its three
  spellings — one place, three acquisition types.
- *Whatley Plant Swap* is `rescued`; *Whatley Giving Garden* is `plant_swap`.

Neither existing column is touched and neither vocabulary is extended. Where a value name coincides
(`own_garden`, `plant_swap`, `farm_stand`) the two still mean different things and neither constrains
the other. **`gift` is deliberately absent** from `source.kind`: a gift is a transaction, which
`plants.source_type` already records; the giver is a `person`.

The 12 values are derived from language already in the data — "trust stand" (×4 distinct stands),
"Plant Swap" (×5), "(retail store)", "Gardens"/"Farm"/"Flower Farm", "packet"/"online order",
"Home-saved". Every one is used by at least one row of `proposed-sources.csv`. If Dave wants a
different set, the CHECK in `0a` and the regex in `post_kind_vocabulary_exact` change together, in
one commit. That is the intended cost of a vocabulary change, and it is the mechanism that stops
`source.kind` going the way of `source_type`.

## 3. Two FK columns per parent — forced by the data, not a preference

Dave asked whether *"Botanical Interests (via Gardener's Supply Company, Hadley MA)"* is the same
source as *"Botanical Interests"*. **His own data already answers: it is two facts, and the schema
already stores both.** All 12 `(via …)` rows carry

```
metadata->>'vendor'            = 'Botanical Interests' | 'Seed Savers Exchange' | 'High Mowing Organic Seeds'
metadata->>'purchase_location' = 'Gardener's Supply Company, Hadley MA'
```

Someone separated the brand from the shop by hand. Four more rows do the same thing in prose, across
both parent tables: `"…(originally Lake Valley Seed, item #233)"`, `"Magic Wings Inc (via Belchertown
Plant Swap)"`, `"Amazon (GoveeLife)"`, `"Liz Young via Belchertown Plant Swap June"`.

So a single FK would force the dedupe to **destroy one of two facts on ~20 rows** — either "which
seed company bred this" or "which shop can I walk into". Hence:

- **`source_id`** — the originator: who grew, bred, packed or gave it.
- **`acquired_from_source_id`** — the shop, market or event where it changed hands, set **only** when
  it differs. NULL means *not recorded, or not distinct* — it does **not** mean "same as `source_id`".

For the large majority of rows only `source_id` is ever set. A `CHECK` forbids a row naming the same
source twice. This is the minimum shape that does not lose a distinction the data already draws.

## 4. What happens to order numbers and dates

**They stay exactly where they are.** `plants.source_ref` and `inventory_items.source` are not
dropped, altered, or emptied by this migration or by the backfill that follows it, and
`post_free_text_columns_not_dropped` makes that promise enforceable against a *later* migration too.

That is not caution for its own sake — those strings are the **sole home** of facts that have no
column anywhere in this design:

| Welded into the string | Where it goes |
|---|---|
| `#350019`, `#152165`, `item #233` | **Nowhere. Stays.** No order-number column exists. |
| `(HOMESTEAD discount)` | **Nowhere. Stays.** |
| `confirmed 2026-07-08`, `received 2026-07-18`, `Received 2026-07-17` | **Stays.** `inventory_items.purchase_date` is a different, single date. |
| `July 2026 intake`, `August 2026 intake` | Partly duplicated by `metadata.origin` (`BI-order-350019-2026-07-18`, `MHS-order-2026-07-17`), which is the closest thing to a structured batch id. Stays. |
| `June`, `June 2026`, `2026.06.13` (the day of a gift or swap) | **Stays.** `plants` has no acquisition-date column distinct from `created_at`. |
| `397 Greenfield Rd Deerfield MA` | → `source.address` + `source.locality`. **Dave's named example; fully resolved.** |
| `Deerfield, MA, USA` | → `source.locality`. |
| `packet`, `online order`, `sale`, `(souvenir)`, `Free` | Dropped from identity — item format or circumstance, not the vendor's name. |
| `trust stand` | → `source.kind = 'farm_stand'`. |

The `residue_stays_in_free_text` column of `dedupe-mapping.csv` records this per spelling, so nothing
is lost silently. **An order-number/receipt model is a separate, later decision** — until it exists,
the honest place for an order number is the string a human typed it into.

## 5. How a future writer is stopped from adding a 74th spelling

Four layers, weakest to strongest. The honest summary is that **the schema alone is not enough** —
layer 3 is the one that actually does the work, and it already exists in this codebase.

**1. The FK itself.** Once a writer sets `source_id`, "type anything" stops being an option — the
value must be a row that already exists or one deliberately created.

**2. `match_key` + `uq_source_match_key_live`.** A generated, stored fold of `name` (lowercase, then
every non-`[a-z0-9]` stripped), unique among live rows. Collapses case, punctuation, spacing and
accents, so `Greenfield Co-op` / `greenfield coop` / `Greenfield  Co-Op` collide on insert.
Collation-stable because accented characters are stripped after folding either way.
**It cannot catch an omitted or transposed word** — `Starview` vs `Starview Gardens`, `Shawski` vs
`Skawski` are different keys, and no unique index can fix that. Saying otherwise would overclaim.

**3. The picker — the real mechanism, and it is already built.** The repo has a mature
type-ahead-with-mint-and-steer pattern in production for crop types:
`src/lib/comboboxInput.js` (`useComboboxInput`, `looseKey`, `looseIncludes`),
`src/hooks/useCropTypes.js` (`createCropType`, returning `{ error, existing, reason }` where `reason`
is `exists | plural | coupled_synonym`), and `lambda/varieties/index.js:168-180`, which rate-limits
creation and runs `resolveCropTypeName` **against soft-deleted rows too**, returning *"here is the
existing one you meant"* rather than minting a near-duplicate. Six components already consume it.
**A source picker should reuse this, not re-derive it.** Fuzzy matching is what catches `Starview`
→ `Starview Gardens`; the schema never will.

**4. An alias table, later.** The residue layer 3 misses — a name Dave types differently every time —
is exactly what `V5-VOICEALIAS-001` solved for misheard cultivars: correct it once, right forever.
Named here as the next slice, deliberately **not** built now.

### The writer's one hard constraint — BUG-INVSEEDPUT400-001

**Do not add `source_id` or `acquired_from_source_id` to the inventory PUT's SET list as a bare
assignment.** `lambda/inventory-items/index.js:807-866` is a static full-row overwrite; 23 of its
columns use `= ${body.x ?? null}`, so a client that omits a key **nulls that column**. Four columns
already carry the escape hatch — `featured_photo_id`, `variety_id`, `seed_process`, `seed_stage` —
via `hasOwnProperty` flags at lines 727–739 feeding a `CASE WHEN … ELSE <col> END`. `metadata` is
excluded from the SET list entirely for the same reason. **Any new FK must use that
`hasOwnProperty` → `CASE` pattern.** The precedent, the reason and four working examples are all
already in that file. Nothing in this migration touches Lambda.

---

## Review checklist for Dave

Two files, two questions. Neither is applied; the backfill is gated on both
(`post_dedupe_mapping_reviewed_by_dave`).

**`dedupe-mapping.csv` — 73 rows.** 52 high confidence, 15 medium, 6 low. **17 marked `REVIEW`.**
The ones that matter most:

- **`Hatfield Plant Swap` vs `Hatley Plant Swap`** — two days apart (2026-06-01 / 2026-05-30).
  Hatfield MA is real; "Hatley" is not, and could be a mistyping of Hadley (real, adjacent) *or* of
  Hatfield. **Not merged.** Only Dave knows which swap he drove to.
- **`Whatley Plant Swap` vs `Whatley Giving Garden`** — one day apart. A giving garden is a standing
  thing; a swap is an event. Plausibly two places, plausibly one visit typed twice. **Not merged.**
- **`Greenfield Farmers Market` vs `Greenfield Farmers Co-op`** — deliberately **kept separate**. A
  farmers market and a co-op store share two words and are different places. This is the near-name a
  careless pass would fuse.
- **`Shawski Farm` / `Shawski Farms` / `Skawski Farms`** — the *merge* is high confidence (all three
  rows created 2026-05-31, one shopping trip). The *canonical spelling* is not: an h/k transposition
  with a 2–1 majority. Confirm before it becomes the label on 4 plants.
- **`Jen from Four Phantoms`** (12 rows) — may be two facts (person + place), and it is unclear
  whether this Jen is Dave's partner. Left as one verbatim row so no wrong split is baked in.
- **`Class Grass Garden Canter`** — almost certainly a garbled "… Garden Center", with the signature
  of the speech-recognition mishearing V5-VOICEALIAS-001 documents. Kept verbatim; **not guessed.**
- **`Ojos de Luna`** (4 rows), **`Gardens at Mathews`**, **`Jen's uncle`** — unidentified. Kind is a
  placeholder.
- **`Home-saved (source not recorded)`** — probably belongs on `source_plant_id` /
  `source_kind='own_garden'` (V4-SEEDLINK-001 / V4-SEEDORIGIN-001) rather than here; those can name
  the parent plant, which a source row cannot.

**`proposed-sources.csv` — 53 rows.** The labels that will appear in the picker. Note
**`Gardener's Supply Company`** has *no spelling of its own* — it exists only inside three
`(via …)` parentheticals and in `metadata.purchase_location`. It is the row that makes the
brand-vs-shop split expressible, and the backfill must create it.

**`proposed_website` is filled on only 4 of 53 rows** — the four URLs actually present in prod
(`johnnyseeds.com`, `magicwings.com`, the UMass guide, `amazon.com`). Every other vendor's URL was
left blank **on purpose**: writing one from memory would put an unverified fact into a column Dave
will treat as authoritative. Filling them is a separate, verified pass.

---

## Verification performed (2026-09-03)

- `python3 -c "import yaml; yaml.safe_load(...)"` — parses; `pre` 6 / `sweep` 2 / `post` 17.
- `yamllint -d relaxed` — exit 0, line-length warnings only (consistent with the corpus).
- `scripts/gate_runner.py :: load_gate_file` — all 25 gates load under the runner's own strict
  schema check; all pass `validate_sql_readonly`; **every gate is `env: both`.**
- **Instrument check.** All 19 `continuous` gates executed against live prod (read-only) on the
  unapplied database: every one returns its expected value and **none raises** — no `42703`
  (missing column) and no `42P01` (missing relation). Self-arming confirmed.
- **Mutation proof.** A gate that is green on an absent table has only proven it does not error. All
  13 continuous post gates were re-run with their arming conjunct or asserted fact inverted; **all 13
  reported a violation**, so none is vacuous. `post_substrate_only_catalogue_empty` is the one gate
  that names `public.source` directly — it is `continuous: false` for that reason and must be run
  only in the apply window.
- `dedupe-mapping.csv` is **generated**, and `dedupe-mapping.gen.py` hard-fails on any spelling
  present in prod but not in the mapping, or vice versa. Re-verified: 73 rows, exact verbatim match
  with the prod export, 567 prod rows covered (182 + 385).
- Blast radius checked on live prod, not assumed: no view widened (`v_sow_candidates`, `garden_node`,
  `v_container_recency`, `v_resolved_care` — `*` is expanded at definition time); RLS policies on
  both parents are column-agnostic; `audit_stmt_update`/`_delete` capture the whole row via
  `to_jsonb` so they pick the columns up additively; `gv.entity_planting_*` and `gv.bump_version`
  reference named columns only; `prevent_ownership_transfer` fires on `created_by`/`user_id` and is
  not installed on `public.source` (and `post_ownership_trigger_not_installed` keeps it that way).

**No DDL was executed against any database, and nothing was pushed.**
