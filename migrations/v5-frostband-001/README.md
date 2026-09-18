# v5-frostband-001 — give two cultivars the crop type their frost band needs

**Status: WRITTEN, GATED, UNAPPLIED.** Nothing in this directory has run against staging or prod. The
apply is Dave's call; it runs on **both** environments.

Ledger rows: `BUG-STABLEUNKNOWNSLUGS-001`, `BUG-PINEAPPLESAGEBAND-001`. Code half, same branch:
`lambda/daily-plan/frostClass.js` bands `hylotelephium` hardy, `horseweed` hardy and
`pineapple_sage` tender.

| file | what it does |
|---|---|
| `0a-data.sql` | One transaction. Mints `hylotelephium` and `pineapple_sage` in `crop_types`; re-types two cultivars by id, each guarded on its old slug; sets the `cold` key of Pineapple Sage's cultivar care profile; stamps `5.0.0-frostband-001`. No DDL. |
| `0b-derive.mjs` | Runs the real `applyDerive` engine (`lambda/varieties/crop-derive.js`) on the two cultivars, so their derived `type:` tags follow the new slugs. `--env staging\|prod`; `--reconcile-only` after a rollback. |
| `0r-rollback.sql` | The inverse, guarded on what 0a wrote. Soft-deletes the two crop types (only if nothing is typed to them). |
| `gates.yml` | 7 `pre` (4 prod-only identity receipts), 2 standing `post` invariants (self-armed), 9 apply-window receipts. |

## Why

The frost email bands crop **types**. Read on prod 2026-09-18:

| planting | cultivar (id) | typed | what it is | frost email today |
|---|---|---|---|---|
| Autumn Fire Stonecrop | "Sedum spectabile" (`44907632…`) | `sedum` | Hylotelephium, zone 3 | named as "unclassified", a false alarm |
| Pineapple Sage | "Pineapple Sage" (`6b75492d…`) | `sage` | Salvia elegans, zone 8-10, killed by the first frost | never named: `sage` is banded hardy for garden sage |

`sedum` is deliberately unbanded (its other live cultivar, S. adolphii, is tender) and must stay
that way. Banding `sage` tender would page for every garden sage. Genus cannot split either pair, and a
name is not an identity. So each cultivar gets a crop type of its own, the way `v4-cropsplit-001` split
squash, onion and radish: *where the divergence is categorical, a signal that fires versus one that
never can, only a slug split works.*

Horseweed, the third plant in the ledger row, already has its own crop type (`horseweed`, minted
2026-09-07). It needed a band, not a migration; that is code only.

### The cold card had the same defect

`engine.coldFor` reads the cultivar's care profile before any crop-type default. Pineapple Sage's was
written by `cadence-backfill-20260823`, "Cloned from the sage crop baseline", and carries garden
sage's `cold: {"tender": false, "protect_below_F": 10}`. With `CARE_CADENCE_SCOPES_ENABLED=true`
(prod, per `scripts/lambda-config-expected.json`) that profile wins, and a `tender:false` profile never
produces a card, so the card was silent for this plant too. Re-typing alone would leave the email saying
"tender" and the card saying "fine to 10°F". 0a sets that one key to `{"tender": true,
"protect_below_F": 32}`, the value `cadence-data-v2.json` already carries for S. elegans
(`by_genus_fallback.Salvia`, "bring in before freeze"). It is a single-key `jsonb_set` matched on the
old value, the `v5-heatrespcabbage-001` method; every other key on the row is untouched.

## What changes for Dave

- The frost email stops naming Autumn Fire and Horseweed, and starts naming Pineapple Sage (as
  "pineapple sage") at the same 40/38/33°F trips as the tomatoes.
- Pineapple Sage gets a "bring in tonight" card on nights forecast at 32°F or colder, unless it has
  been logged as brought inside.
- The two plants show their new crop type everywhere a crop type shows: "Hylotelephium (Showy
  Stonecrop)" and "Pineapple Sage". The Garden by-type view files them there.
- Pineapple Sage's plant card loses the garden-sage harvest cue ("cut stems when the plant is just
  starting to flower"). `src/lib/ripenessCues.js` forbids unsourced entries, so no cue was copied.
- Nothing else about either plant changes. `pineapple_sage` copies every harvest and weight column
  from the live `sage` row (cut-and-come-again every 18 days, 20 g per cup), so harvest readiness and
  weights are as before. Those weights are garden-sage estimates, inherited, not measured, and they
  are inert for Pineapple Sage itself: its cultivar row carries its own (cup 18 g, count 0.5 g), which
  weight resolution reads first.

## Window — no ordering against the code, either way

- **New code, old data.** The two new bands are inert until something carries the slugs. Autumn
  Fire stays a false alarm and Pineapple Sage stays unwarned, exactly as today. Horseweed is fixed.
- **Old code, new data.** The deployed classifier has never heard of either slug. Autumn Fire counts
  as unknown (treated as tender), so it stays a false alarm until the code lands. Pineapple Sage is
  warned at once: its corrected cold block makes the handler's existing cadence promotion lift the
  unknown slug to tender, so the email names it as "pineapple sages" (checked against the base
  `frostClass.js`). The card change is data, so it works on old code too.
- No column is added or removed, so no read path can 500.

**The promote does not wait for this apply, and this apply does not wait for the promote.**

One ordering constraint, not about code: `migrations/v4-harvhabitgap-001/gates.yml` must list
`hylotelephium` before this applies (this branch adds it). Otherwise
`post_every_null_habit_is_a_recorded_decision` reds on the next gate run, because `hylotelephium` is a
crop type with no harvest habit on no recorded list (the 2026-09-15 `lamb_s_ear` red). So push the
branch first, then apply.

## Apply

URLs come from `garden-app/.env.local` by key name, never by pattern and never on a command line.

```bash
# staging
python3 scripts/gate_runner.py --migration migrations/v5-frostband-001 --env staging --phase pre
psql "$NEON_STAGING_URL" -v ON_ERROR_STOP=1 -f migrations/v5-frostband-001/0a-data.sql
node migrations/v5-frostband-001/0b-derive.mjs --env staging
python3 scripts/gate_runner.py --migration migrations/v5-frostband-001 --env staging --phase post

# prod
python3 scripts/gate_runner.py --migration migrations/v5-frostband-001 --env prod --phase pre
psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/v5-frostband-001/0a-data.sql
node migrations/v5-frostband-001/0b-derive.mjs --env prod
python3 scripts/gate_runner.py --migration migrations/v5-frostband-001 --env prod --phase post

# both, whole corpus
python3 scripts/gate_runner.py --all --env prod --phase post --continuous-only
python3 scripts/gate_runner.py --all --env staging --phase post --continuous-only
```

`0b-derive.mjs` needs `@neondatabase/serverless`. It resolves it from the repo root, else from
`lambda/varieties/node_modules` (run `npm --prefix lambda/varieties ci` first if neither has it). It
prints "absent" and moves on for a cultivar the environment does not carry.

The staging pre gates skip the four `env: prod` identity receipts. Whether staging carries the two
cultivars was not checked (this lane was cleared to read prod only); 0a's updates are id-keyed and
guarded, so where they are absent only the two crop-type rows are added.

## Rollback

```bash
psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/v5-frostband-001/0r-rollback.sql
node migrations/v5-frostband-001/0b-derive.mjs --env prod --reconcile-only
psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/v5-frostband-001/0r-rollback.sql   # sweeps the now-unlinked type tags; every other statement matches nothing
```

Rolling back puts Pineapple Sage back on `sage` and back to "hardy to 10°F": no channel can warn for
it again. Code need not be rolled back first: nothing reads a column this removes.

## Verification at authoring (2026-09-18)

**Nothing was applied to staging or prod.** Read-only against prod: `--phase pre` PASS 7/7;
`--phase post --continuous-only` PASS 2 with 9 apply-window receipts skipped, so pushing this directory
cannot red `gate-invariants.yml`. `--validate-only` clean.

Rehearsal on a throwaway local PostgreSQL 17, seeded read-only from prod (all 163 `crop_types`, 515
`plant_varieties`, 321 `plants`, the care profiles of the nine cultivars in the ledger rows plus the
system row, 144 system `type`/`lifecycle` tags and their 1,034 cultivar links), with the prod
constraints, indexes and `v_resolved_care` definition. `0b-derive.mjs` ran unmodified against it through
a local stand-in for the Neon driver.

- `pre` PASS 7 → `0a` → `0b` (2 stale `type:` links removed, 0 failures) → `post` PASS 11/11.
  After the apply, `pre` fails the 5 state-describing gates, as designed.
- Re-running `0a` changes nothing (row state identical).
- `0r` → `0b --reconcile-only` → `0r` again: every row matches the seed state; the two crop types stay
  soft-deleted and their tags are retired. `pre` then passes again, and re-applying revives both types:
  row state identical to the first apply.
- Red proofs, each restored to PASS 11 afterwards:

  | mutation | gate that goes red |
  |---|---|
  | soft-delete `pineapple_sage` while Pineapple Sage is typed to it | `post_no_cultivar_typed_to_a_dead_new_crop_type` |
  | Pineapple Sage's cold block back to the garden-sage clone | `post_no_pineapple_sage_resolves_a_hardy_cold_block` |
  | a leaf-scope profile on the planting saying hardy | `post_no_pineapple_sage_resolves_a_hardy_cold_block` |
  | whole-object replace of the care profile | `post_cold_fix_was_single_key_not_a_full_replace` |
  | `pineapple_sage` interval drifts from `sage` | `post_pineapple_sage_copies_sage` |
  | a stale `type:sage` link left live | `post_moved_cultivars_type_tag_follows_slug` |
  | `hylotelephium` dropped from v4-harvhabitgap-001's list, after the apply | `post_every_null_habit_is_a_recorded_decision` |

## Not in scope, noticed

- Pineapple Sage's watering and feeding keys are garden-sage clones too (`soak_then_dry`, drought
  tolerance high, `crop: "sage"`, which `isMedHerb` reads). The bundled S. elegans entry disagrees
  ("wants consistent moisture and moderate feeding"). Left alone here.
- The planting "Copper Stonecrop" points at the cultivar "Golden Sedum" (S. adolphii). Copper
  Stonecrop is usually S. nussbaumerianum. Both are tender, so the frost answer is the same.
- KNOWN, NOT FIXED (the v4-cropsplit-001 precedent): `migrations/v4-cal1-refweight-001/0b-seed.sql`
  sets Pineapple Sage's weights `WHERE crop_type_slug='sage' AND name='Pineapple Sage'`, generated from
  `src/data/harvest-weights-v3-reference.json`. After this re-type that UPDATE matches nothing. Not a
  live bug (the values are already applied), but a from-scratch rebuild of that seed would skip the
  row. Fix when the seed is next regenerated.
