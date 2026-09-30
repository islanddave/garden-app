# v5-recipes-001 — Put-Up release 4 (recipes), the database half

Plan: `project-state/_crucible-pantry-20260928/04-design-final.md` (V4) §2.6, §3.1–§3.2, §3.8 and §4.5, as amended
by `05-release-train.md` §6 ("All B releases", "4:") and `06-ferment-path.md` §1.5 (what a recipe carries from a
batch). Recipe **types** (what a recipe makes) are Dave's decision of 2026-09-30, folded in here. Release 4 ships in
promote **B′** with releases 2 and 3, after F.

| file | what it does |
|---|---|
| `0a-additive-ddl.sql` | The schema, one transaction, stamp `5.0.0-recipes-001`. Applies on top of F only. |
| `0r-rollback.sql` | Guarded rollback to the exact post-F schema. **Valid only while release 4's code is off dev.** |
| `gates.yml` | 5 `pre`; no `sweep` (every CHECK is over a new table or column); 14 standing `post` + 1 apply-window receipt. |

The stamp is fixed at first apply anywhere and never edited: every standing gate self-arms on it.

## What 0a adds

* **recipe_type** — what a recipe makes. Fifteen built-ins in Dave's order (Hot sauce · Chili paste · Salsa &
  chutney · Chili crisp & oil · Glaze & wing sauce · Pesto · Jam & preserve · Pickle · Canned vegetables · Canned
  fruit · Fruit leather & snacks · Candy · Spice & powder · Ferment (kraut, kimchi…) · Other) with fixed ids
  `7ec1be00-0000-4000-8000-0000000000NN` and `user_id` NULL, plus types the household creates from the picker
  (`user_id` = who made it). Find-or-create on `lower(btrim(label))` (built-ins first, then the household's; a
  soft-deleted own type is restored), soft delete. `uq_recipe_type_builtin_label` / `uq_recipe_type_user_label` are
  the race backstop. **Precedent copied:** `crop_types` (`lambda/varieties` POST `/api/varieties/crop-types`,
  "always-add-on-the-fly": built-ins plus minted rows, an existing name steers to the existing row, a soft-deleted
  one is restored) crossed with 1b's household place find-or-create on `lower(btrim(label))`.
* **recipe** — name, `kind` (the batch-kind process word, nullable), `recipe_type_id` (FK NO ACTION), `link_url`
  (http/https only, CHECKed), `notes` (his text verbatim — ratio rules, day gates, serve notes and **his target pH
  live here and only here**), the keeps line (`keeps_n` · `keeps_unit` day/week/month · `keeps_storage_kind`, all
  three or none), and F §1.5's carried facts: `vessel_label/size/unit/count`, `no_salt`, `mash_in_g`, `made_g`.
  `idempotency_key` (global unique partial — a 23505 on `uq_recipe_idempotency_key` is a replay). `set_updated_at`,
  `prevent_recipe_ownership_transfer` (executes the user_id variant
  `prevent_kitchen_batch_ownership_transfer()`, reused unchanged as 1b did for preservation_log), soft delete.
* **recipe_ingredient** — `recipe_id` (FK NO ACTION), `ordinal`, `name`, `amount_text` (as written), `qty` +
  `qty_unit` (KITCHEN_UNITS, both or neither), `at_the_end` (NOT NULL DEFAULT false), `form`, `brand`, `role`
  (salt/water), `note`, `shu_rating_low/high`, and the salt facts (`salt_pct`, `salt_base`, `base_g`, `salt_method`,
  `base_from`) — every CHECK mirrors F's kitchen_batch_input CHECK of the same meaning. `salt_base` admits
  `peppers` because "Save as recipe" copies a 1b-era line as it is. `trg_recipe_ingredient_identity` keeps a line
  on its recipe (it has no owner column; its recipe owns it). Soft delete.
* **kitchen_batch.recipe_id** — uuid, nullable, no default, FK NO ACTION, partial index.
* **v_kitchen_batch_current** — F's 40 columns in order, `recipe_id` appended at 41 (05 §6 "4:"); md5
  `c5e32311816088488bcbb315e8703ae0` (the guard also accepts F's `b70ac2f238dfc9d09e8db2017c0e7474`).

**No target_ph, no tested column, ever** (V4 §3.8): `post_no_ph_column_on_recipe_tables` and
`post_no_ph_check_on_recipe_tables` assert it.

## Apply order (B′'s sitting — 05-release-train §3, releases 2 → 3 → 4)

1. **Pre-checks, immediately before every apply** (Neon branch of prod, staging, prod):
   `python3 scripts/gate_runner.py --migration migrations/v5-recipes-001 --env <env> --phase pre`.
   A `pre_view_is_f_definition` mismatch means someone re-created the view after F (0a would refuse anyway): fold
   their change into 0a, re-pin the md5 in 0a / 0r / gates.yml, re-rehearse.
2. **0a** — `psql -X -v ON_ERROR_STOP=1 -f 0a-additive-ddl.sql`. Never inside BEGIN/ROLLBACK on a shared database.
3. **Right after**: `--migration migrations/v5-recipes-001 --phase post` (all of it, including the receipt
   `post_no_recipe_shaped_row_yet`), then the three corpora `--all --phase post --continuous-only`.
4. **Post-deploy** (05 §3 step 12): the recipe seed runs LAST, and only after Dave has seen the list
   (`project-state/_crucible-pantry-20260928/seed-recipes/SEED-REVIEW.md`):
   ```bash
   (cd lambda/preservation && npm ci)
   export RECIPE_SEED_DATABASE_URL="$NEON_DATABASE_URL"   # by key name; never on a command line
   export GARDEN_HOUSEHOLD_IDS="<dave>,<jen>"               # the household the handler scopes by
   node scripts/seed-recipes.mjs --user <dave's clerk id> --file recipes-seed-v1.json               # dry run
   node scripts/seed-recipes.mjs --user <dave's clerk id> --file recipes-seed-v1.json --i-mean-it  # write
   ```

**Partial-apply policy:** if the apply fails, stop; releases 2 and 3 stay applied and this file is fixed forward.
0r is for "applied, release 4's code not yet on dev" only (chain 4r → 3r → 2r).

## Why the deployed writer (F's) is compatible

Two new tables F never names; `kitchen_batch.recipe_id` is nullable with no default and no CHECK — F's create
INSERT names its columns and omits it, and F's merge PUT is an explicit allowlist without it; the NO ACTION FK is
vacuous while every row is NULL; the view gains one appended NULL key, which F's `SELECT *` readers pass through
(as they did for 1b's one and F's nine). F's create route refuses a non-null `recipe_id`, so nothing F serves can
write one.

## Rehearsal (local PostgreSQL 16, a throwaway cluster; no shared database)

A replica of the kitchen family's post-F shape (kitchen_batch with every F column, kitchen_stage_log,
kitchen_batch_input, preservation_log, schema_version with 1b's and F's stamps, `set_updated_at`,
`prevent_kitchen_batch_ownership_transfer`), then F's view copied verbatim from `v5-fermentpath-001/0a` —
**its md5 reproduced F's pinned `b70ac2f238dfc9d09e8db2017c0e7474` exactly**, so the replica's `pg_get_viewdef`
agrees with the one F pinned. Then:

| step | result |
|---|---|
| `pre` before 0a | 5/5 PASS |
| `post --continuous-only` before 0a | 13 PASS + 1 apply-window-only, 0 ERROR (vacuous) |
| 0a | exit 0; view md5 `c5e32311816088488bcbb315e8703ae0`; recipe_id at 41, recipe_ref still 40 |
| 0a × 2 more | exit 0, nothing changed (15 built-ins, same md5) |
| `post` after 0a | 14/14 PASS |
| planted cases | refused as expected: `javascript:` and `ftp:` links (`chk_recipe_link_url`); a keeps line with n only (`chk_recipe_keeps_whole`); a blank name; kind `sauce`; salt facts on a role-less line; form on a water line; a line moved to another recipe (P0001 from the identity trigger); a recipe re-owned (P0001, the user_id variant); an unknown recipe from a line or a batch (FK); a duplicate household type differing only in case and spaces (`uq_recipe_type_user_label`) and a duplicate built-in (`uq_recipe_type_builtin_label`). Accepted: an https link with a query string, a full keeps line, a salt line with all three facts in g, a household type whose name matches a built-in (the route finds the built-in first) |
| gate mutation | a built-in relabelled → `post_builtin_recipe_types_present` FAIL (1 row) |
| 0r with a recipe row | refused ("1 recipe rows"), nothing changed |
| 0r on an unused apply | exit 0; view md5 back to F's `b70ac2f…`, its ACL (`=r` PUBLIC) carried across; no recipe relation; stamp gone |
| `post --continuous-only` after 0r / `pre` after 0r | vacuous again (13 PASS + 1 window-only) / 5/5 PASS |
| 0a after 0r | exit 0, md5 `c5e32311…` again |

Not run here (needs the real schema, at the sitting): the three corpora `--all --phase post --continuous-only` on the
Neon branch of prod after 1b → F → 2 → 3 → 4.
