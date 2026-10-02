# v5-pantryitemamount-001 — Put-Up R2a (B1): a Pantry item gains an amount and where it came from

Plan: `project-state/_putuplogretire_20261002/PLAN-R2-V2.md` section 5 as replaced by
`PLAN-R2-V3-AMENDMENTS.md` E, contract 5 as amended by C2 (V5-PUTUPLOGRETIRE-001; absorbs
V5-PANTRYITEMWHEREFROM-001). The three SQL / gate files are the data-schema seat's section 6
(`seat-data-schema-architect.md`), unchanged. The routes are in `lambda/preservation/pantryRoutes.js` and
`pantryItems.js`.

| file | what it does |
|---|---|
| `0a-additive-ddl.sql` | The schema, one transaction, stamp `5.0.0-pantryitemamount-001` (line 2). Applies on top of v5-pantry-001 only. |
| `0r-rollback.sql` | Guarded rollback to the exact post-v5-pantry-001 `pantry_item`. **Valid only while R2a's code is off dev.** |
| `gates.yml` | 4 `pre`; no `sweep` (nothing can meet existing data); 8 `post` (7 standing + 1 apply-window receipt). |

## What 0a adds

Four nullable columns on `public.pantry_item`, no default, and nine CHECKs, each created VALIDATED:

* **quantity_value** `numeric(10,2)`, **quantity_unit** `text` — the amount AS LOGGED. Not stock: `pantry_item`
  has no count and no remaining, no route decrements this pair, and no `pantry_use` row can name an item. The
  list row stays `stock_mode: 'item'` with null `count_left`, `count_made` and `grams_left`, whatever the unit.
  A reader never presents the pair as what is left.
  `chk_pantry_item_quantity_pairing` (both or neither), `_quantity_value` (above 0, and not NaN: numeric NaN
  sorts above every number, so `> 0` alone admits it), `_quantity_unit` (the 25 `KITCHEN_UNITS`; none of
  `preservation_log`'s ten legacy plurals, which exist only for rows the shipped jar picker wrote).
* **source_kind**, **source_label** `text` — where it came from, the put-up's eight words.
  `chk_pantry_item_source_kind`, `_source_label_nonblank`, `_source_label_len` (120), `_source_other` (Other
  needs a name; the NULL-safe `IS DISTINCT FROM` form) and `_source_plant` (a source that is not our garden
  forbids a planting) are the put-up's five, word for word; `_source_label_kind` (a name needs a source) is
  new here — on a put-up that rule is the validator's only.

No trigger, no foreign key, no index, no count column. `pantry_item` stays unaudited.

## Registry — where each item landed

* Route: `ITEM_CREATE_KEYS` / `ITEM_PATCH_KEYS` take the four; `amountOf` / `sourceOf` validate them
  (`pantryItems.js`); the create INSERT, its RETURNING, the replay SELECT, the PATCH's presence map / SET /
  RETURNING and the list's items arm carry them; `projectItem` and `itemRow` return them as stored
  (`quantity_value` as a JSON number). The list's put-ups arm adds `p.source_kind`, so both row kinds hold the
  same four keys.
* `ITEM_CONSTRAINT_MESSAGES` (`pantryRoutes.js`) has words for all nine names. The validators pre-empt eight;
  `chk_pantry_item_source_plant` on a PATCH is decided by the database (the stored `plant_id` is not in a PATCH
  body) and answered from that map.
* `*-columns.test.js`: NEW `lambda/preservation/pantryitemamount-columns.test.js`, pinned both directions to
  this 0a, its unit and source lists bound to `KITCHEN_UNITS` and `VALID_SOURCE_KINDS`. `pantry-columns.test.js`
  is untouched (it pins its list equal to v5-pantry-001's CREATE TABLE) and so is `batchbuilder-columns.test.js`
  (the batch builder, the line routes and the line search read none of the four).
* Train: `.github/workflows/integration-test.yml` lists this directory LAST, pinned by
  `src/__tests__/integrationPutUpTrain.static.test.js`; static guards in
  `src/__tests__/pantryItemAmountMigration.static.test.js`.
* merge.js: untouched. A merge repoints `plant_id` only on rows that have a planting, which by
  `_source_plant` carry no non-garden source. A future merge RESTORE that puts a planting back on an item since
  given a non-garden source would be refused by `_source_plant` (rehearsed below). No such route exists today.
* Audit, archive routines, PHOTO_POINTERS, api.js prefix, router delegation: no change.

## Apply order (amendment E)

The prod apply is its own ask of Dave, separate from the ship phrase, and it comes BEFORE the train reaches dev.

1. **Local PostgreSQL 17 rehearsal** — done, table below.
2. **Integration on the train branch.** The fork applies this directory by the workflow's own list. Read the
   log: `applying: migrations/v5-pantryitemamount-001/0a-additive-ddl.sql (5.0.0-pantryitemamount-001)` and
   `Put-Up train files applied to the ephemeral branch: 1` (0 once staging carries the stamp).
3. **Staging.**
   ```bash
   python3 scripts/gate_runner.py --migration migrations/v5-pantryitemamount-001 --env staging --phase pre
   psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-pantryitemamount-001/0a-additive-ddl.sql
   python3 scripts/gate_runner.py --migration migrations/v5-pantryitemamount-001 --env staging --phase post
   python3 scripts/gate_runner.py --all --env staging --phase post --continuous-only
   ```
   0r is rehearsed on an ephemeral fork only, never on staging itself.
4. **Staging deploy of the train SHA, and smoke.**
5. **Prod, on Dave's own word for the DDL, a snapshot branch first.**
   ```bash
   python3 scripts/gate_runner.py --migration migrations/v5-pantryitemamount-001 --env prod --phase pre
   psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-pantryitemamount-001/0a-additive-ddl.sql
   python3 scripts/gate_runner.py --migration migrations/v5-pantryitemamount-001 --env prod --phase post
   python3 scripts/gate_runner.py --all --env prod --phase post --continuous-only
   python3 scripts/gate_runner.py --all --env staging --phase post --continuous-only
   ```
6. **Only then does the train reach dev.** From the moment the route's INSERT list is on dev, the prod schema
   gate (`scripts/dev-main-schema-audit.py --gate`, Phase 2) refuses every promote of dev until prod has the four
   columns — that would also stop every other session's ship. 0r is closed from here.
7. CI, `schema-audit` green, the ship ask, the promote.

Never wrap the 0a in BEGIN/ROLLBACK on a shared database: its own COMMIT ends your transaction. No Lambda
deploy is needed around steps 3 and 5. **Partial-apply policy:** the 0a is one transaction; if it fails nothing
is applied, stop and fix forward.

**The dispatched schema audit before the prod apply is RED on exactly these four `pantry_item` columns and
nothing else.** That red is the proof the audit covers them. No waiver is added for it. After the apply it is
green.

## Why the deployed writer is compatible

The house test (2026-08-03): *would the currently deployed code produce a row that violates this?* No.

The statements that write `pantry_item` in the deployed code — `pantryRoutes.js`'s create INSERT (ten named
columns), its PATCH UPDATE and its soft delete, and `lambda/plants/merge.js`'s repoint — name their columns, and
none names these four. Every row they produce therefore carries NULL in all four, and every one of the nine
CHECKs passes on that row.

Eight of the nine read only the four new columns. **The ninth, `chk_pantry_item_source_plant`, also reads
`plant_id`, an EXISTING column the deployed code writes and an `ON DELETE SET NULL` foreign key.** It is safe on
both counts: its first arm is `source_kind IS NULL`, true of every row the deployed code writes, whatever
`plant_id` holds; and the SET NULL action can only make its third arm true. It is the put-up's exact text and
has no `IS NOT NULL) OR` arm, so `v4-evtanchordel-001 post_no_setnull_fk_inside_an_anchor_check` stays green
(rehearsed: 0 rows; a control CHECK of that shape, 1 row). Never rewrite it with a `(plant_id IS NOT NULL) OR …`
arm.

The CHECKs are created VALIDATED with no NOT VALID step and no sweep: the columns are born NULL on every existing
row, so there is nothing for a sweep to read. (v5-pantry-001, v5-putupmake-001 and v4-putupprov-001 did the same.)

## Undoing the release

Additive and nullable: older code never writes the four and reads `pantry_item` by named columns only, so no
revert-floor entry is needed and none is added. **After a forward undo of the Lambdas, a phone still on the
cached R2a bundle gets a 400 from the older item route on an as-is save, or an item edit, that carries an amount
or a source** (the older route refuses a key it does not know). Nothing is written, the sheet stays open, and
the save goes through once the amount and source are taken off or the app reloads. Say so in the landing note.

The DDL stays applied through a forward undo. 0r is not an undo: once the route's code is on dev, dropping the
columns refuses every promote and 500s `GET /api/pantry` — the whole Pantry, put-ups included, because the list
SELECT names them.

## Reading a gate against a schema dump

The gates match `pg_get_constraintdef`'s **fully parenthesised, un-pretty** text, for example
`CHECK (((source_kind IS NULL) OR (source_kind = 'own_garden'::text) OR (plant_id IS NULL)))`. A pretty-printed
dump (`pg_dump`, or a recon document) drops parentheses and casts; reasoning about a gate's pattern from one gives
the wrong answer. Read the live definition.

What the gates do NOT read: the definitions of `chk_pantry_item_quantity_pairing`, `_quantity_value` and
`_source_label_kind`. A loosened form of any of the three passes `post` (measured below); the other six are
caught. Their text is pinned in `lambda/preservation/pantryitemamount-columns.test.js`, which reds in CI if the
0a is loosened, but nothing watches the live database for them.

## Rehearsal

Local PostgreSQL 17.10 on 127.0.0.1, a throwaway data directory, **against a stub schema** (schema_version with
the two earlier train stamps, storage_location, plants, garden_node, crop_types, cultivar, preservation_log,
preservation_source, kitchen_batch_input, pantry_use, the two trigger functions) plus this repo's real
`migrations/v5-pantry-001/0a-additive-ddl.sql` and the real five source CHECKs out of
`migrations/v4-putupprov-001/0a-additive-ddl.sql`. **Not a prod dump** — the lane has no database access. Gates
were run with `scripts/gate_runner.py --env staging`, its URL variable pointed at the local database.

| step | result |
|---|---|
| `pre` on the pre-state (15 columns, 3 CHECKs; two rows in the deployed INSERT's shape, one soft-deleted) | 4/4 PASS |
| `post`, and `post --continuous-only`, on the UNAPPLIED database | 8/8 PASS; 7 PASS + 1 apply-window-only. No ERROR: vacuous, not broken |
| 0a, twice | applies (psql exit 0); 19 columns, 12 CHECKs all validated, one stamp row; the second run is a no-op |
| 0a with v5-pantry-001's stamp absent | refused by its guard; nothing changed |
| `post` after 0a | 8/8 PASS |
| `pre` again on the applied database | RED on `pre_not_already_applied` and `pre_no_item_amount_shape_yet` |
| the other two pre gates | `pre_pantry_applied` RED with the pantry stamp removed; `pre_put_up_source_checks_present` RED with one put-up CHECK dropped |
| census: `migrations/v5-pantry-001` `post` on the applied database | 12/12 PASS |
| census: `v4-evtanchordel-001 post_no_setnull_fk_inside_an_anchor_check`, its SQL verbatim | 0 rows; with a control CHECK of the anchor shape, 1 row |
| each of the nine CHECKs dropped | `post_item_amount_checks_present_and_validated` RED for every one (and the gate that reads its definition, where one does) |
| a CHECK left NOT VALID | `post_item_amount_checks_present_and_validated` RED |
| a column dropped; bare `numeric`; a default on `source_kind`; `varchar` for the unit | `post_item_amount_columns` RED |
| the stamp row deleted | `post_schema_version_recorded` RED |
| `pinch` removed from the unit CHECK; `lbs` added to it | `post_item_unit_check_carries_the_kitchen_units` RED; `post_item_unit_check_admits_no_legacy_plural` RED |
| the put-up's vocabulary widened alone | `post_item_source_checks_match_put_up` RED |
| the naive `source_kind <> 'other' OR …` form | `post_item_source_checks_match_put_up` and `post_item_source_other_is_null_safe` RED |
| a row carrying an amount | `post_no_item_amount_row_yet` RED |
| each CHECK's DEFINITION loosened in a scratch copy of the 0a | 6 of 9 RED (`quantity_unit`, `source_kind`, `source_label_nonblank`, `source_label_len`, `source_other`, `source_plant`); **3 pass `post`**: `quantity_pairing`, `quantity_value`, `source_label_kind` (see above) |
| rows that must be refused, by direct SQL: value only, unit only, 0, −1, `0.004`, NaN, `lbs`, `quart`, `quarts`, kind `swap`, 121 characters, a blank name, a name with no source, Other with no name, Other with a blank name, a planting with `store` | each 23514, naming its constraint |
| `100000000 lb` | 22003 numeric field overflow (the route's validator refuses it first) |
| rows that must be accepted: all four NULL with and without a planting, `2 lb`, `0.005` (stored `0.01`), `6 count`, `6 fl oz`, `99999999.99 g`, `store` alone, `farm_stand` + a name, Other + a name, a 120-character name, `own_garden` with and without a planting | all accepted |
| deployed-writer shapes on the applied database: the deployed PATCH's SET, merge.js's repoint, a hard delete of the planting under an `own_garden` item | all accepted |
| a planting put back on an item with `store` (a future merge restore) | 23514 `chk_pantry_item_source_plant` |
| 0r while two rows (one soft-deleted) carry a value | refused, naming "2 pantry_item row(s)"; 19 columns, 12 CHECKs and the stamp still there |
| 0r clean | psql exit 0; columns, constraints and `schema_version` equal the snapshot taken before 0a; `pre` 4/4 |
| 0r again, with 0a no longer applied | refused: "not applied here; nothing to roll back" |
| 0a re-applied after the 0r | `post` 8/8 PASS |
| the item route's own handler, run against this database through a bridge that sends every parameter as untyped text (create with all four, replay, today's keys, each PATCH pair, the two clears, the planting refusal on the real CHECK, a stranger, the list, the soft delete) | 29 of 29 as the unit tests assert |

**Still owed** (not runnable in the lane): `tests/integration/pantry-items.int.test.js`'s R2a cases on the train
fork (written, unrun); `pre` / `post` and the three corpora `--all --phase post --continuous-only` against a Neon
fork of staging, staging and prod; the route's SQL through the real neon driver; the 0r rehearsal on an ephemeral
fork. Prod's PostgreSQL major version was not read: the definitions above were printed by 17.10.
