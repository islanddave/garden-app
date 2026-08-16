# V4-HARVWEIGHTEST-001 — a calibration sample follows the planting's IDENTITY

Ledger row (type: bug): *"Cherry-tomato harvests carry 350-700g cultivar-average weight estimates on
a slicer basis."*

The numbers in that row are exact. Its diagnosis is not, and the corrected diagnosis is what this
migration is built against. **NOT APPLIED** — needs the both-environments gate (staging AND prod)
before `migrations/**` ships.

---

## 1. The premise, verified live (prod, read-only, 2026-08-16)

| ledger claim | verdict |
|---|---|
| `Cherry Rescue 1: 2ct=700g and 1ct=350g weight_basis=cultivar` | ✅ **exact.** 7 live rows, 350 g/fruit |
| `269-row cultivar_weight_sample corpus` | ⚠️ **stale.** 325 rows total, 299 live (18 voided, 8 from soft-deleted harvests) |
| *"cultivar-average weight estimates"* | ❌ **wrong tier.** `weight_basis='cultivar'` is resolver **tier 4**, the CURATED CATALOGUE figure in `plant_varieties.unit_weights`. A cultivar *average* would report `cultivar_sample` (tiers 3/5). No average was involved |
| *"on a slicer basis"* | ✅ in substance — 350 g is **Beefsteak's** catalogue value — but not because a cherry inherited a slicer's average |
| *"pollutes the cultivar_weight_sample corpus"* | ✅ real, ❌ not by that route. The 350 g estimates never enter the corpus: `isUserSuppliedWeight()` gates capture to user-typed weights and holds. The pollution is **4 real weighings filed under the wrong cultivar** |

The premise holds well enough to build on. The mechanism is different from the one the title implies,
so the fix is different too.

## 2. What actually happened

`plants.notes` for the planting says it outright: **`Formerly "Beefsteak"`**.

```
planting "Cherry Rescue 1"   created 2026-07-11, variety Beefsteak (catalogue 350 g/count)
  2026-08-03 18:24:51  v4-cal1-slicec-001/0c-backfill-basis re-derives every stored weight.
                       7 harvests resolve through tier 4 -> 350 g/fruit, basis 'cultivar'.
                       Correct, for a beefsteak.
  2026-08-03 23:43     Dave weighs one fruit: 28 g. Auto-capture files the sample under BEEFSTEAK.
  2026-08-05           16 g. Same.
  2026-08-10           variety "Cherry" created.
  2026-08-14 16:38     planting re-identified to Cherry.
                       Nothing re-resolves harvest_log. Nothing re-files the two samples.
```

Every stored gram and every sample was correct *at the moment it was written*. What has no mechanism
is the moment the identification changes.

`cultivar_weight_sample.cultivar_id` is a **copy** of the source planting's cultivar, taken at
capture time by `record_harvest_weight_sample`, with nothing that maintains it. Same for
`harvest_log.weight_grams`, which materialises the resolver's answer.

### It is not a one-off

A second planting has the same defect in the opposite direction:

```
planting "Blackberry"   re-identified to Allegheny Blackberry on 2026-08-06
  2026-08-04  12 g / 18 fruit  -> filed under ASTER  (0.67 g/drupelet)
  2026-08-05  15 g / 21 fruit  -> filed under ASTER  (0.71 g/drupelet)
```

That pair is `confidence='high'` on two independent days, so the resolver **promotes** it (tier 3) —
and `scripts/harvest-weight-ratchet-ack.json` had it **reviewed and ACCEPTED for propagation** on
2026-08-06. The review is honest and wrong: it weighed two agreeing samples against a catalogue
figure, a binary with no way to express *"these are blackberries"*. Revoked in this branch.

### Why nothing caught it

- **The resolver can't.** It answers "what does this cultivar weigh", never "is this the right
  cultivar". Given Beefsteak, 350 g is the correct answer.
- **The capture guard actively prevented the cure.** `record_harvest_weight_sample`'s
  unchanged-re-save guard tested `unit + total_grams + unit_count` and **not** `cultivar_id`. After a
  re-identification, editing the harvest matched the guard, returned early, and skipped the
  void-and-replace the function exists to perform. The one event that could have corrected the
  attribution was the one event guaranteed not to.
- **The only detector asks the wrong question.** The ratchet's outlier scan compares a promoted
  factor to its catalogue reference and puts *measurement vs catalogue* to a human. There is no third
  answer for *"the sample belongs to a different cultivar"*, so the reviewer picked one of two wrong
  options and armed it.
- **No audit trail exists.** `audit_events` covers `plant_varieties` only — **zero** rows for either
  re-identification. Any fix keyed on an observed old→new transition would have missed both.

## 3. The fix

`0a-reattribution.sql` — mechanism, function bodies only, no row touched:

1. `record_harvest_weight_sample` — add `AND s.cultivar_id = v_cultivar` to the unchanged-re-save
   guard. Same grams under a different variety is not an unchanged re-save; it is the correction.
2. `public.reattribute_plant_weight_samples(p_plant_id uuid, p_user text) RETURNS integer` — voids
   every live sample captured from this planting whose `cultivar_id` no longer matches, and
   re-appends it under the current one. Void-and-append, never edit: `trg_cws_immutable` forbids
   UPDATE/DELETE, and the retire-don't-destroy precedent is `plant_anchor_derivation`'s
   `superseded_at`/`superseded_by` pair in the same PUT handler. Idempotent — the mismatch *is* the
   trigger, so it heals a variety changed by any writer, including psql.

`lambda/plants/index.js` — call it after the PUT transaction when the body carries `variety_id`,
inside a `try/catch` that logs and continues (satellite correction must not roll back the user's
edit). Gated on `hasVariety`, not on an observed transition, for the no-audit-trail reason above.

`scripts/harvest-weight-ratchet-ack.json` — remove Aster from `reviewed_cultivar_ids`; the review
entry stays, marked REVOKED with the traced reason. **Fails closed**: the ratchet blocks on the
factor again instead of propagating blackberry weights onto Aster harvests.

`gates.yml` — the invariant, stated rather than approximated:
`post_no_sample_contradicts_its_planting` must return 0 rows.

### Rejected

- **A plausibility band on per-unit weight.** Would not have caught any of this: 350 g/fruit is
  *correct* for a beefsteak and the row claimed to be one. A band only fires once the identity is
  already known to be wrong — and it needs a per-crop threshold spanning 0.7 g (blackberry) to
  11 000 g (watermelon), which is what `plant_varieties.unit_weights` already is. `0b-resolver-v4`'s
  header also records the standing decision against a deviation-from-catalogue rejection rule: it is
  circular and would stop CAL-1 ever correcting a wrong catalogue figure, which is the whole feature.
- **Changing how a cultivar average is chosen** (e.g. samples always outrank the catalogue). The
  resolver picked the right average for the cultivar it was given. Re-ranking would not have moved
  the Cherry Rescue rows and would undo `demote-don't-discard`, a documented decision.
- **Re-attributing in the `cultivar_weight_derived` view** (group by the source planting's *current*
  cultivar, ignore the stored copy). Genuinely tempting — self-healing, no write path involved — and
  rejected on three counts: it silently re-prices every consumer through a read path whose blast
  radius spans several migrations' gate corpora; it makes `cultivar_weight_sample.cultivar_id`
  advisory, against that table's append-only raw-evidence contract; and the 9 seeded samples with no
  `source_event_id` would need a second rule. The void-and-re-append protocol already exists here for
  exactly "this sample is superseded" and leaves a legible trail.
- **DELETE the polluted samples.** `trg_cws_immutable` forbids it, and the corpus is evidence.
- **Re-resolving `harvest_log` inline on a variety change.** `scripts/harvest-weight-ratchet.sh`
  already does this, weekly, dry-run by default, behind a `--max-total-drop-pct` guard that exists
  precisely so stored totals never move under Dave unattended. Doing it inline would bypass that
  guard. Out of scope by design, not by omission.

## 4. Data correction — `0b-backfill-reattribute.sql`, **NOT APPLIED**

Moves 4 live samples out of 299. Simulated read-only against the live corpus before writing it:

| cultivar | before | after |
|---|---|---|
| Beefsteak | 22.00 g/count (n=2, `low`) | no derived row → 350 g catalogue |
| Aster | 0.69 g/count (n=2, `high`, **promoted**) | no derived row → 6 g catalogue |
| Cherry | no derived row | 20.25 g/count (n=4, cv 0.297, `medium` → promoted) |
| Allegheny Blackberry | 0.74 g/count (n=6) | 0.71 g/count (n=8), reference 0.70 |

Then, and only then, the ratchet: `scripts/harvest-weight-ratchet.sh` dry → read the report →
`--apply`. That is what moves the 7 Cherry Rescue rows from 3 850 g of stored beefsteak to ~203 g of
actual cherry tomatoes.

## 5. Apply order

```
0a-reattribution.sql          gates: pre -> sweep      (mechanism; safe alone, no-op on clean data)
0b-backfill-reattribute.sql   gates: sweep -> post     (data; needs Dave's approval)
deploy lambda/plants          any time after 0a
scripts/harvest-weight-ratchet.sh --dry-run, then --apply, separately
```

Rollback: `0r-rollback.sql`. It restores the old function body and drops the new function; it cannot
un-append a re-filed sample (append-only table), which is the intended property — reverting the code
should not erase a correction.
