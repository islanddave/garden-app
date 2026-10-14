# v5-deckpots-001 — the three fall pots on the Deck: decided watering, and the Millet rename

**Status: NOT APPLIED** (ledger `DATA-FALLDECKPOTS-001`). Prod apply needs Dave's OK at the sitting.

Dave added three nursery pots on the Deck on 2026-10-12 through the app: Hardy Mums (Garden Chrysanthemum),
Prairie Sun Yellow Daisies (Prairie Sun, crop `daisy`) and Ornamental Millet (Purple Majesty Miller, crop
`millet`). The create path gives a new cultivar a placeholder care profile and a new crop type no harvest
habit, so two standing gates went red, as they are meant to:

- `v4-cadencerefill-001 :: post_no_live_planting_rests_on_an_unresearched_placeholder` (3 rows).
- `v4-harvhabitgap-001 :: post_every_null_habit_is_a_recorded_decision` (2 rows: `daisy`, `millet`).

Dave's decisions, first-hand 2026-10-14 (AskUserQuestion, T1 session `t1-stabilityreds-20261014`):

1. Daisy and millet are **not harvested**. Code, not this migration: both slugs join `not_harvest_tracked`
   in `src/data/harvest-attributes-v1.json`, the copied list in `src/lib/harvestTracked.js`, and the NOT IN
   list of the harvhabitgap gate, in the same commit as this directory.
2. The three cultivars **water every 3 days, rain counts**, `_basis: dave_decision`.
3. Rename **Purple Majesty Miller to Purple Majesty Millet**.

| file | what it does |
|---|---|
| `0a-data.sql` | One transaction. Replaces each placeholder by row id, only while it is the exact placeholder (md5). Renames the variety, only while it holds the old name. Stamps `5.0.0-deckpots-001`. |
| `0r-rollback.sql` | Puts each exact placeholder and the old name back, only while they hold what 0a wrote and the stamp exists; deletes the stamp; reports. |
| `gates.yml` | 6 `pre` (5 prod-only: identity, md5, no leaf override, reach, engine premise), the stamp, 1 standing `post` (self-armed, prod-only), 2 apply-window receipts. |

**Watering and feeding cadence do not move.** All three already resolve a 3-day container interval (the
Chrysanthemum genus entry, the default for the other two). Adopting a database row merges the system row's
14-day feed under it, which would move the mums off the genus entry's 28 (the `v5-feedinherit-001` defect), so
the chrysanthemum row carries `fertilize_interval_days: 28` explicitly; daisy and millet are 14 either way.
`lambda/daily-plan/deckpotsprofile.test.js` asserts before == after for both keys. Card text does change for
the mums (crop label, water method and moisture hint now come from this row); no alert changes.

**"Rain counts" needs no key.** Rain credit is per planting, from the location's cover (`handler.js`
`cov.state is false as rain_exposed_resolved`) or the planting's `rain_exposed` override. The Deck is
`covered = false`, the plantings' override is NULL, and a rain event was logged on each on 2026-10-13.

**Not in this change:** frost bands for `daisy` (Rudbeckia hirta, hardy) and `millet` (tender). Both are unmapped
today, which the frost engine counts as tender. Optional per the ledger row; a separate decision.

Apply: staging first (the prod-only gates read n/a there and 0a writes 0 rows plus the stamp), then prod:
`python3 scripts/gate_runner.py --migration migrations/v5-deckpots-001 --env prod --phase pre`, then
`psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/v5-deckpots-001/0a-data.sql` (owner DSN, selected
by key name), then `--phase post`. Expect `UPDATE 1` three times, `UPDATE 1` for the name, `INSERT 0 1`.
