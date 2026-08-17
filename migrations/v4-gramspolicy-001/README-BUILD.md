# V4-GRAMSPOLICY-001 — per-crop `variety_grams_required`

Dave's decision, verbatim: **"Per-crop — flip only uniform crops."**

Flips `crop_types.variety_grams_required` to `false` on four crops — **arugula, bean, beet,
squash** — so `resolve_harvest_weight` tier 6 can price a harvest whose cultivar carries neither a
curated `unit_weights` entry nor any weighing samples.

All figures below were measured read-only against prod and staging Neon on **2026-08-16**. Nothing in
this directory has been applied to any database.

---

## 1. True current state (verified live 2026-08-16, prod + staging)

The live prod resolver is **v5** — `migrations/v4-cal1-indep-001/0b-resolver-v5.sql`, schema_version
`4.23.x`. It is **not** the v4 in `v4-harvbasis-sample-001`; v5 replaced `sample_n >= 5` with
`independent_n >= 5` in the corroboration predicate and left the tier ladder byte-identical. The gate
this migration targets is unchanged between them:

```sql
WHEN NOT COALESCE(ct.variety_grams_required, true)
     AND (ct.unit_weights ->> p_unit) IS NOT NULL   THEN 6
```

| fact | prod | staging |
|---|---|---|
| live crop types | 137 | 86 (pre-CROPSPLIT-001 snapshot) |
| `variety_grams_required = true` | 130 | — |
| of those, holding an unused `unit_weights` figure | **77** | — |
| live plant varieties | 411 (329 with curated weights) | 72 |
| harvest_log rows | 688 total / 661 live | — |

Two users, always disaggregated. **Dave** (`user_3D2g…`) holds 14,268 events and 683 harvests;
**Jen** (`user_3E2x…`) holds 35 events and 5 harvests. Jen's five: four are live and already weighed
(`cultivar` ×3, `cultivar_sample` ×1); her fifth is a soft-deleted project-scoped row. **Jen is
unaffected by this change in either direction.** Every figure below that is not explicitly split is
Dave's.

---

## 2. The evidence, and the two tests it produced

Three sources were used, in descending strength:

1. **Measured** — `cultivar_weight_derived` over `cultivar_weight_sample`, Dave's own weighings.
   Only 7 crops have ≥2 cultivars measured for the same unit.
2. **Differentiated catalogue** — `plant_varieties.unit_weights` where ≥2 *distinct* values exist for
   a unit.
3. **Undifferentiated catalogue** — ≥2 varieties, all carrying the same number.

**Source 3 is a trap and is treated as no evidence.** 419 of the 694 variety-unit pairs on prod
(60%) are byte-equal to their crop-type default. A crop showing "5 varieties, CV 0%" is usually
recording that nobody differentiated them, not that they are uniform.

### Variance is a property of the UNIT more than of the crop

Across every crop with ≥2 varieties curated for a unit:

| unit | crops | flat (1 distinct value) | differentiated | worst max/min |
|---|---|---|---|---|
| `cup` | 38 | 35 | 3 | 2.50 |
| `bunch` | 7 | 7 | 0 | 1.00 |
| `count` | 37 | 13 | 24 | **500.00** |
| `head` | 4 | 1 | 3 | 8.33 |

`cup` and `bunch` are volume/aggregate measures and are near-perfectly cultivar-invariant. `count`
and `head` are whole-organ measures and are cultivar-*dominated*. **The flag, however, is per-crop.**
Flipping a crop arms tier 6 for *every* unit it can price, so a crop only qualifies if its
`count`/`head` figures are defensible too. This mismatch is the single most important structural
finding of this lane and is carried as a follow-up in §7.

### Test 1 — uniformity

For every unit the crop can price: curated per-variety spread `max/min ≤ 1.25`, and any measured
spread over ≥2 cultivars `≤ 1.25`. The threshold is the observed cluster boundary on prod — the
differentiated-catalogue ratios run 1.11, 1.17, 1.20, 1.20, 1.21, 1.22 and then jump to 1.33, 1.40,
1.78, 2.00, 2.50, 2.75, 3.00, 4.44, 4.50, 6.67, 7.50, 8.33, 8.57, 10.00, 57.69, 500.00.

### Test 2 — fallback agreement

`ct_g / mean(curated variety g)` must lie in `[0.85, 1.15]` for every unit.

Test 2 was added after test 1 alone admitted `radish`, which **is** uniform (3 varieties at 10–12 g,
ratio 1.20) but whose crop-type figure is **4.5 g** — 2.5× lighter than every variety it would price.
Uniformity says the varieties agree with *each other*; it says nothing about whether the fallback
agrees with *them*.

### Thin-evidence rule, and its defence

**A crop with n = 1 variety and no samples is KEPT gated. Absence of measured variance is not low
variance.** 47 of the 84 crops carrying a crop-type figure fall here.

The defence is the asymmetry of the two errors:

- **Keeping a uniform crop gated** costs an *unweighed* harvest. It renders as unweighed, contributes
  0 g, and is visibly missing. It is recoverable at any later date — adding a curated weight or two
  weighings fixes it, and `scripts/harvest-weight-ratchet.sh` re-derives estimates in place
  (precedent: 144 rows re-derived 2026-08-06, ruled legitimate by Dave on 2026-08-10 on the grounds
  that an estimate is a current best guess, not a historical fact).
- **Flipping a non-uniform crop** costs a *confidently wrong* weight. It looks identical to a right
  one, silently inflates or deflates Dave's totals, and nothing surfaces it.

A gap announces itself; a wrong number does not. On thin evidence the rule therefore defaults to the
recoverable error.

**Botanical judgment is admitted, and labelled.** `arugula` is flipped on judgment, not on
measurement: its 3 varieties all carry the same number, so the catalogue proves nothing about it. It
qualifies because its crop-type figure covers **only `cup` and `bunch`** — it has no `count` or
`head` key at all, so tier 6 can never price a whole-organ unit for it — and because the class-level
measurement above shows `bunch` flat in 7 of 7 crops and `cup` flat in 35 of 38. That is a structural
argument backed by class-level data, and it is still judgment about *this* crop. Four further
volume-only crops (`althaea`, `borage`, `chervil`, `vietnamese_coriander`) have the same structure
but were **excluded** because their crop-type figures are `weight_source = 'estimate'`,
`weight_confidence = 'low'` — flipping to enable a number nobody has confidence in is not a win.
`arugula` is `usda` / `high`.

---

## 3. FLIP list — four crops

| crop | evidence tier | units armed | spread | fallback vs variety mean | harvest history (Dave) |
|---|---|---|---|---|---|
| **squash** | **measured + differentiated catalogue** | count 200 g, cup 113 g | measured **1.11×** over 2 cultivars (17 samples); curated **1.22×** over 3 varieties (180/200/220 g) | 1.000 | **56 rows, 11,928 g** |
| **beet** | differentiated catalogue | count 82 g, cup 136 g | curated **1.21×** over 5 varieties (70–85 g) | 1.007 | 5 rows, 2,918 g |
| **bean** | differentiated catalogue | count 6 g, cup 110 g | curated **1.20×** over 7 varieties (5–6 g), all `catalog`-sourced | 1.077 | 0 rows |
| **arugula** | **judgment** (class-level data) | cup 20 g, bunch 25 g | no `count`/`head` key exists; 3 varieties agree | 1.000 | 0 rows |

Ranked by impact: **squash** is the only one with material harvest history, and it is also the only
one with measured cross-cultivar evidence. `bean` and `arugula` are zero-stakes today — they are
forward insurance, cheap either way.

**squash is safe only because of CROPSPLIT-001.** That migration (4.18.0) moved the winter cultivars
out to `winter_squash`; prod's `squash` is Summer Squash (zucchini 220 g, straightneck 200 g, Zephyr
180 g). `winter_squash` holds Howden 9000 g, Cinderella 7000 g, Pink Banana 6800 g — a 6.4× spread —
and carries **no** `unit_weights`, so it is both correctly gated and inert.

## 4. KEEP list — the same rigor

| crop | why kept | evidence |
|---|---|---|
| **pepper** | measured **154.67×** over 22 cultivars (0.50 g – 77.33 g); curated 500× over 107 varieties | measured |
| **tomato** | measured **68.41×** over 31 cultivars (4.40 g – 301 g); curated 57.69× over 51 varieties | measured |
| **tomatillo** | measured **20.71×** over 3 cultivars | measured |
| **strawberry** | curated 10.00× over 4 varieties | differentiated catalogue |
| **blackberry** | curated 8.57× (0.7 g vs 6 g) | differentiated catalogue |
| **eggplant** | curated 6.67× over 2 varieties | differentiated catalogue |
| **carrot** | curated 4.50× over 5 varieties | differentiated catalogue |
| **potato** | curated 4.44× over 5 varieties | differentiated catalogue |
| **melon**, **onion**, **watermelon** | curated 2.00–2.75× | differentiated catalogue |
| **cabbage**, **shallot**, **cucumber**, **leek**, **bok_choy** | curated 1.33–1.78× — above threshold, below alarming | differentiated catalogue |
| **radish** | uniform (1.20×) but crop figure **4.5 g vs 11.33 g variety mean = 0.40×** | fails test 2 |
| **pea** | uniform (1.17×) but crop figure **5 g vs 6.25 g variety mean = 0.80×** | fails test 2 |
| **sage** | 1.11× but only n = 2 varieties | thin |
| **althaea, borage, chervil, vietnamese_coriander** | volume-only structure, but crop figure is `estimate`/`low` | thin + low-confidence fallback |
| 47 further crops | n ≤ 1 curated variety, no samples | thin-evidence rule |
| **winter_squash, rat_tail_radish** and 51 others | no `crop_types.unit_weights` at all — a flip would be inert | not applicable |

`radish` and `pea` are the two most valuable follow-ups: both are genuinely uniform crops that fail
only on a correctable crop-type number. Fix those two figures (radish `count` 4.5 → ~11, pea `count`
5 → ~6) and both become clean flips under the same tests.

---

## 5. Measured effect — zero rows, zero grams, and why

**The resolver is `STABLE` and runs at WRITE time.** `lambda/events/index.js` calls it in the POST
CTE (~1653) and the PUT recompute (~2566); the returned `weight_grams` / `weight_basis` are stored on
the row. Nothing re-resolves on read. A policy change therefore cannot move a stored row by itself.

The only re-derivation path is the manual `scripts/harvest-weight-ratchet.sh`. Simulated read-only
against prod over that script's exact scope predicate:

| metric | value |
|---|---|
| rows in ratchet scope | 368 |
| rows newly priced by the flip | **0** |
| grams added by the flip | **0** |
| rows re-priced by the flip | **0** |
| rows still unpriced after the flip | 1 |
| rows that would move on a ratchet run *regardless* of the flip | **0** |

Cross-checked by calling the **live** function over the same 368 rows: it disagrees with the stored
value on **0** of them, so the ratchet is already at a fixed point and this migration does not move
it off one. The simulation was also run with an empty flip list (identical output — no false
positives) and probed with an extended crop list (returns the 11 combos below — so it is not
vacuous).

### The brief's "4 grams-policy rows" do not survive checking

15 `harvest_log` rows carry `weight_basis IS NULL`. **14 of the 15 are soft-deleted**; only one is
live, and that one is project-scoped with `plant_id` NULL — no tier can price it
(BUG-PROJHARVWEIGHT-001, out of scope). The four plant-linked rows re-resolve **today, with no policy
change at all**:

| row | crop / variety | now resolves to | via |
|---|---|---|---|
| `3b83eab5` | bitter_melon / Bitter Melon | 200 g | tier 4 `cultivar` |
| `29f11886` | beet / Beet, cup ×4 | 544 g | tier 4 `cultivar` |
| `e4b5ccbe` | beet / Beet, cup ×4 | 544 g | tier 4 `cultivar` |
| `d746d48e` | tomato / Cherry | 20.25 g | tier 5 `cultivar_sample` |

They are unweighed because they were written before that reference and sample data existed — a
write-time-staleness case, not a grams-policy case. All four are also soft-deleted.

### The one live win the flag *could* deliver today, and why it is declined

Exactly 11 (live plant, unit) combinations resolve to NULL where the crop type holds a figure:

| crop | unit | plants | crop figure | why not flipped |
|---|---|---|---|---|
| carrot | bunch | 3 | 450 g | `count` spread 4.50× |
| onion | bunch | 3 | 300 g | `count` spread 2.00× |
| leek | bunch | 2 | 270 g | `count` spread 1.33× |
| asparagus | bunch | 1 | 340 g | n = 1 variety, thin |
| pepper | cup | 1 (Cowhorn) | 149 g | `count` spread 154.67× |
| tomato | cup | 1 (Cherry) | 180 g | `count` spread 68.41× |

Every one of them is a `bunch` or `cup` — the cultivar-invariant units — and every one belongs to a
crop whose `count` is high-variance. **The per-crop flag cannot deliver any of these without also
arming a high-variance unit.** That is the whole case for the follow-up in §7.

### Forward exposure — what the flip is actually buying

All 25 varieties across the four flipped crops currently carry curated weights, which is why the
immediate effect is zero. The value is prospective: **51 of the 205 varieties added in 2026-07
arrived with no curated `unit_weights`, and 5 of the 8 added so far in 2026-08.** Roughly one new
variety in four lands unpriced. In a flipped crop it now prices at the crop average instead of
reading 0 g.

---

## 6. Prod vs staging — the divergence is the migration working

`0a-flip.sql` does **not** hardcode a flip. Its `WHERE` clause re-derives both tests per unit against
the database being applied to, and withholds any nominated crop that fails, with a `RAISE WARNING`
naming the crop, the unit and the reason. Verified read-only on both databases:

| | prod | staging |
|---|---|---|
| arugula | flips | flips (vacuously — no curated varieties there) |
| bean | flips | crop type absent, clean no-op |
| beet | flips | flips (1.00×, 0.965) |
| squash | flips (1.22×, 1.000) | **WITHHELD** — `count: test1 curated spread 4.25x over 3 varieties` |
| rows changed | **4** | **2** |

Staging is a pre-CROPSPLIT-001 snapshot and still files Pink Banana 6800 g, PA Dutch Crookneck
4500 g and Red Kuri 1600 g under `squash`, against a 200 g crop figure that is 0.047× the variety
mean. A hardcoded flip would have armed a 200 g fallback for a 6.8 kg squash there. **This case is
the reason the predicate is data-driven rather than a slug list.**

Gates naming a per-env row count are `env:`-scoped accordingly.

## 7. Rollback

`0r-rollback.sql` restores from `public.crop_types_vgr_snapshot_gramspolicy_001`, which `0a` writes
in the same transaction *before* the UPDATE — so it restores the **exact prior per-crop value**, not
a blanket `true`. Seven crops were already `false` before this migration existed (basil, blueberry,
broccoli, bunching_onion, lettuce, red_raspberry, wineberry); none is nominated, so none is captured
or touched. If a future edit adds an already-`false` slug to the list, the snapshot still restores it
to `false` — a blanket reset would silently re-arm it.

The rollback refuses to run if the snapshot table is absent, drops it last inside the same
transaction, and deliberately does **not** touch `harvest_log`: `0a` wrote no weight (0 rows
re-priced, measured), so there is nothing to un-derive. If a `harvest-weight-ratchet.sh` run happened
between `0a` and the rollback, that run has its own `harvest_log_weight_snapshot_*` table and must be
undone with its own statement.

## 8. Verification performed

- `python3 -c "import yaml; yaml.safe_load(...)"` on `gates.yml` — parses, 5 `pre` + 14 `post`.
- `yamllint -d relaxed` — line-length warnings only, matching every existing `gates.yml` in this repo.
- `0a`'s UPDATE predicate extracted verbatim and run as a read-only `SELECT` against **both** prod and
  staging; output in §6.
- Every gate executed read-only against both databases pre-apply. All `pre` gates green on both. The
  `post` gates that are invariants (`post_tomato_and_pepper_still_gated`,
  `post_only_nominated_crops_moved`, `post_no_stored_weight_moved`,
  `post_weight_pairing_invariant_intact`, `post_staging_drift_is_still_only_the_known_fixtures`)
  are already green pre-apply, which is correct — they must hold on both sides. The rest fail or
  error pre-apply because they assert post-apply state.
- Full vitest suite run under `TZ=America/New_York`; counts in the lane report.

**No SQL in this directory has been executed against any database.** Every number above comes from a
`SELECT`.

## 9. Known follow-ups — NOT done here, deliberately

1. **Make the gate per-(crop, unit), not per-crop.** The data in §2 says uniformity is mostly a
   property of the unit. A `crop_types.variety_grams_required_units jsonb` (or a per-unit exclusion
   list) would let `carrot`/`onion`/`leek`/`asparagus` price a `bunch` and `tomato`/`pepper` price a
   `cup` — the 11 live combos in §5 — while keeping their `count` gated. This is the change that
   actually delivers a win today; the present migration is the safe subset available under the
   current schema.
2. **Three pre-existing flips fail this migration's own test.** On prod, `broccoli` (head 8.33×
   curated, 1.57× measured over 2 cultivars, 12 harvests / 4,045 g), `lettuce` (count+head 3.00× over
   12 varieties) and `bunching_onion` (count 2.00× over 3 varieties) are already `false`. Three more
   (`blueberry`, `red_raspberry`, `wineberry`) were flipped on a single curated variety. Only `basil`
   would qualify today. `post_preexisting_flips_are_out_of_scope` is **deliberately red on prod** to
   keep this visible. Reverting them is a different decision from the one Dave made and would strand
   weights that currently resolve — it needs its own call.
3. **Correct two crop-type figures**, then re-run these tests: `radish.count` 4.5 g → ~11 g,
   `pea.count` 5 g → ~6 g. Both crops then pass cleanly.
4. **BUG-PROJHARVWEIGHT-001** — the 11 project-scoped harvests with `plant_id` NULL that no tier can
   price. Filed separately, untouched here.
5. **53 crop types hold no `unit_weights` at all**, and 49 of the 51 varieties that have live plants
   but no curated weight sit in them. No flip can help those; they need catalogue coverage.
