# V4-HARVBASIS-SAMPLE-001 — `cultivar_sample` weight basis

Adds a fourth value to the harvest `weight_basis` vocabulary so a **sample-backed** weight (derived
from Dave's own weighings) is distinguishable from a **catalogue-backed** one (a curated seed-packet
figure). Follow-up to `BUG-WEIGHTRANK-001`, deliberately held back from that session for the
sequencing reason below.

---

## 1. True current state (verified live 2026-08-04, prod + staging)

`weight_basis` is a nullable `text` column on **`public.harvest_log`**, which is a **BASE TABLE** —
`relkind = 'r'`. There are **no views over it** and **no triggers on it**. (`garden_node`,
`container` and `cultivar` *are* views; `harvest_log` is not. A prior session queried `pg_constraint`
against a view, found nothing, and concluded no constraint existed — the constraint was on the base
table and validated. The `pre_constraint_is_on_a_base_table_and_validated` gate asserts `relkind='r'`
explicitly so that mistake cannot recur.)

**Three** VALIDATED CHECK constraints govern the column — not one:

| constraint | definition | validated |
|---|---|---|
| `chk_harvest_log_weight_basis` | `weight_basis IS NULL OR weight_basis = ANY(ARRAY['measured','cultivar','crop_type'])` | ✅ |
| `chk_harvest_log_weight_basis_estimated` | `weight_basis IS NULL OR weight_estimated = (weight_basis <> 'measured')` | ✅ |
| `chk_harvest_log_weight_basis_pairing` | `(weight_grams IS NULL) = (weight_basis IS NULL)` | ✅ |

Identical on prod and staging. Data at time of writing:

| | measured | cultivar | crop_type | NULL |
|---|---|---|---|---|
| **prod** | 12 | 335 | **0** | 13 |
| **staging** | 3 | 3 | 1 | 1 |

Prod has **no `crop_type` rows at all** — which is why `ops-stgweightparity-001/verify.sql` G2
(`count(DISTINCT weight_basis) = 3`) already failed on prod before this change. Fixed to a
containment test as part of this work.

### Writers

The **only** producer of a `weight_basis` value is the Postgres function
`public.resolve_harvest_weight(uuid, text, numeric, numeric)`, at **v3**, byte-identical on prod and
staging (`md5 68ab340b…`). Both Lambda write paths are **pure pass-throughs** — they select
`rw.weight_basis` out of a `LATERAL` call and never type a basis literal:

- `lambda/events/index.js` ~1510 — POST `/api/events` create CTE
- `lambda/events/index.js` ~1113 — PUT `/api/events/:id` recompute

### Readers

**No JavaScript or TypeScript in the repo branches on `weight_basis`.** No switch, no label map, no
`.includes()`, no filter, no sort, no analytics bucket, no TS union, no zod/joi schema, no API
request validator. Verified by exhaustive `rg -uuu` across `src/`, `lambda/`, and the built bundle.
The API echoes the value in the events payload, where an unknown value is inert.

**Consequence, and it is the finding that shapes this whole migration: there is no application
deploy boundary to sequence around.** The writer is a database function; both phases are DB-only and
the deployed Lambda is version-agnostic across them.

The one read-path consequence was a *copy* bug, not a crash: `src/pages/EventDetail.jsx` branched on
`weight_estimated === true` and said the weight came from *"this variety's typical weight"* — wrong
wording for a sample-backed estimate. Now forked on `weight_basis`, **with a fallback** (§6).

---

## 2. Why the order is constraint-first — and why that is *not* a contradiction

The 2026-08-03 outage (23514 on every prod harvest save) came from arming a CHECK ahead of the
deployed writer. The rule drawn from it — *"adding a column is backward-compatible; validating a
CHECK over it is a DEPLOY, not a migration"* — is a rule about **NARROWING**: the constraint began
rejecting what the still-live writer emitted.

This change is a **WIDENING**, so the safe order is **inverted** relative to that incident. The
invariant to hold at every instant, in both directions, is:

> **{ values the constraint ACCEPTS } ⊇ { values the live writer EMITS }**

| state | accepts | emits | safe |
|---|---|---|---|
| today | 3 | 3 | ✅ |
| after 0a only | 4 | 3 | ✅ superset |
| after 0a + 0b | 4 | 4 | ✅ |
| **0b without 0a** | **3** | **4** | ❌ **23514 on every tier-3/5 harvest save** |

"Writer-first" would be correct if we were *removing* a value. For *adding* one it is precisely the
outage ordering. The generalisation that survives both cases is the superset invariant above, not a
fixed phase order.

**`NOT VALID` is not a safety valve here — common misreading.** `NOT VALID` only skips the scan of
*existing* rows; new `INSERT`/`UPDATE` are checked immediately either way. So deferring `VALIDATE`
buys nothing for a widening — and for a widening `VALIDATE` can never fail anyway, since the new
predicate is strictly weaker than the old one. We validate inline. (Kept as a note in `0a` in case
the table ever grows enough for the scan to matter.)

---

## 3. Phase sequence

Two phases, two transactions, both DB-only, **each independently safe to stop at**.

| | file | what | parkable? |
|---|---|---|---|
| **1** | `0a-widen-check.sql` | widen the CHECK to 4 values, `VALIDATE` | ✅ indefinitely |
| **2** | `0b-resolver-v4.sql` | `CREATE OR REPLACE` resolver v4, starts emitting | ✅ indefinitely |

**Boundary safety argument, per phase:**

- **Stop after phase 1** — the constraint accepts a value nothing produces. Zero rows change, no
  writer changes, every pre-existing gate still passes. Fully consistent and indefinitely parkable.
  The only cost is that the constraint temporarily over-documents the vocabulary; the constraint
  `COMMENT` covers this.
- **Stop after phase 2** — the intended end state. New sample-backed harvests are labelled
  precisely; historical rows keep `'cultivar'` (see §4).
- **Phase 1 with phase 2's code deployed** — that *is* the target state. ✅
- **Phase 2 with phase 1 rolled back** — 23514. Blocked by a guard in `0r1` (§5).

`0b` carries a hard precondition check that raises with a pointed HINT if `0a` is absent. It is not
decorative — it is the thing that makes the forbidden ordering impossible rather than merely
documented.

---

## 4. What `cultivar_sample` means, and why v4 was needed

**Yes, the resolver needed a v4.** The value cannot be produced anywhere else — the function is the
single derivation locus.

v3 reported `'cultivar'` for tiers 3, 4 **and** 5, collapsing two different kinds of evidence. v4
splits on the **source of the number**, which is the only split that makes the label mean anything:

| tier | source | v3 | **v4** |
|---|---|---|---|
| 1 | user-typed grams | `measured` | `measured` |
| 2 | weight-unit quantity | `measured` | `measured` |
| 3 | `cultivar_weight_derived`, **corroborated** | `cultivar` | **`cultivar_sample`** |
| 4 | `plant_varieties.unit_weights` (**curated catalogue**) | `cultivar` | `cultivar` |
| 5 | `cultivar_weight_derived`, provisional | `cultivar` | **`cultivar_sample`** |
| 6 | `crop_types.unit_weights` (gated) | `crop_type` | `crop_type` |

**Demote-don't-discard is untouched.** The promotion predicate is byte-identical
(`confidence IN ('high','medium') OR sample_n >= 5`) and the tier *order* is unchanged. Both the
promoted (3) and demoted (5) sample tiers report `cultivar_sample` because **both are sample-backed**
— the new value is a *provenance* label, not a ranking. The promoted/demoted distinction already
lives in `cultivar_weight_derived.confidence` / `.sample_n`; duplicating it into the basis vocabulary
would create a second competing threshold. Celebrity (n=3) and San Marzano Roma (n=2) keep their
promotion; the 16 provisional groups stay demoted.

No "reject derived if it deviates >X% from curated" guard was added — that was explicitly rejected as
circular, since it would stop CAL-1 ever correcting a wrong catalogue number.

### Gram values are provably unchanged

v3 computed `factor` as a 4-arm `COALESCE` and `basis` as a *separate, independent* `CASE`. v4
resolves the **tier once** and derives both from it. Equivalent by `COALESCE` precedence, and
**measured**, not assumed:

- **staging**, applied: 198 (plant × unit) cells → **0** gram changes, **0** estimated changes;
  4 cells `cultivar → cultivar_sample`, 2 held at `cultivar`.
- **prod**, read-only simulation (no DDL): **2421** cells → **0** gram mismatches, **0** estimated
  mismatches, **0** basis/grams nullness desyncs.

### Latent v3 desync, closed in passing

v3's basis `CASE` opened with `WHEN c.corroborated` and **no** `d.grams_per_unit IS NOT NULL`
conjunct, while the factor `COALESCE` had one. Unreachable today — `cultivar_weight_derived` is a
VIEW doing `SUM(total_grams)/SUM(unit_count)` over `NOT NULL`, `>0`-checked columns, so a group
exists only if `grams_per_unit` is non-null (verified: 0 offending rows, prod and staging). Under v3
it was invisible anyway, since tiers 3 and 4 shared a label. **Under v4 it would stop being
invisible** — it would stamp a catalogue number as `cultivar_sample`, exactly the lie this feature
exists to prevent, or produce a non-NULL basis with a NULL `weight_grams` and 23514 the pairing
check. Deriving both from one tier makes it structurally impossible.

### History was deliberately NOT backfilled

A backfill phase was designed and **cut**. Reasons, in order of severity:

1. **It would invent provenance, not recover it.** The original tier is recorded nowhere. Re-running
   the resolver assigns the tier *today's* data implies — and `cultivar_weight_derived` is a live
   view over an append-only sample table, so a row's tier legitimately changes as samples accrue. A
   June row that was sample-backed but whose cultivar has since gained a curated reference would be
   stamped `cultivar` and become permanently indistinguishable from a genuine catalogue row.
2. **The only available template re-values weights.** `v4-cal1-slicec-001/0c-backfill-basis.sql`
   writes `weight_grams` and `weight_estimated` too, against drifted samples, with no snapshot — an
   irreversible mass re-valuation of every stored prod weight. `0c`'s own header says to re-run it
   "after any new sample lands".
3. It is not reversible: re-running v3 does not restore prior state, because v3 also reads today's
   view.

Forward-only accrual is the honest option. **Read pre-2026-08 `'cultivar'` as "catalogue OR legacy
sample", never as "catalogue".** The constraint `COMMENT` says so on the table itself, and the
`post_history_was_not_backfilled` gate stops a later session quietly reversing the decision.

---

## 5. Rollback

**Strictly LIFO: `0r2` before `0r1`. Always.**

| file | undoes | notes |
|---|---|---|
| `0r2-rollback-phase2.sql` | phase 2 | restores byte-exact v3. **Safe stopping point.** |
| `0r1-rollback-phase1.sql` | phase 1 | squashes + re-narrows. Lossy. Usually unnecessary. |

**After `0r2` alone:** new writes revert to `cultivar`; any `cultivar_sample` rows already written
**remain and are inert** — the widened CHECK still accepts them, the estimated coupling holds
(`cultivar_sample <> 'measured'` → `weight_estimated` stays `true`, unchanged), the pairing check
holds, and no reader branches on the value. **This is the lower-risk place to stop.** You do not need
`0r1`.

**The `0r1` hazard, and the required intervening step.** Once any `cultivar_sample` row exists,
re-adding the 3-value constraint fails outright:

```
ERROR: check constraint "chk_harvest_log_weight_basis" of relation "harvest_log"
       is violated by some row      SQLSTATE 23514
```

so `0r1` **squashes first**, in the same transaction:

```sql
UPDATE public.harvest_log SET weight_basis = 'cultivar' WHERE weight_basis = 'cultivar_sample';
```

Constraint-safe by inspection: both values are `<> 'measured'`, so the required `weight_estimated =
true` is unchanged and no row flips; `weight_grams`/`weight_estimated` are deliberately **absent from
the `SET` list**, so it is a relabel and never a re-valuation. `harvest_log` has no triggers, so the
ownership-transfer trigger family guarding 9 other tables is not in play on this mass UPDATE
(re-check if a trigger is ever added). **The squash is lossy and one-way** — afterwards you cannot
tell which `cultivar` rows were sample-backed.

`0r1` **refuses to run** while v4 is installed, with a HINT pointing at `0r2`. Verified live.

### Unsafe orderings, enumerated

| ordering | result |
|---|---|
| `0b` before `0a` | ❌ 23514 on every tier-3/5 harvest save — the 2026-08-03 outage |
| `0r1` before `0r2` | ❌ same 23514, from the other direction — **blocked by the `0r1` guard** |
| `0r1` while `cultivar_sample` rows exist, without the squash | ❌ `ADD CONSTRAINT` errors 23514 — loud, transactional, safe |
| `0a` → `0b` → `0r2` → `0r1` | ✅ the supported round trip |

---

## 6. Read-path enum audit

The one branch that mattered is `src/pages/EventDetail.jsx`. It now uses `estimateSourceCopy(basis)`,
a **map with an explicit fallback** rather than a switch or a bare lookup:

| basis | copy |
|---|---|
| `cultivar_sample` | "Currently estimated from your own weighings of this variety." |
| `cultivar` | "Currently estimated from this variety's typical weight." |
| `crop_type` | "Currently estimated from a typical weight for this crop." |
| **anything else** (unknown / null / future) | **"Currently estimated."** |

The fallback is the point: `weight_basis` is a server-derived enum widened by *migration*, not by a
frontend deploy, so a browser on a cached bundle can legitimately receive a value it was never built
to know about. A map miss rendering `undefined` into the sentence is the classic silent failure.
Covered by 11 unit tests in `src/__tests__/estimateSourceCopy.test.js`, including unknown future
values, `null`, `undefined`, and non-strings.

---

## 7. Verification performed

- ✅ **Negative control** — writing `cultivar_sample` to staging *before* `0a` fails 23514 (proves
  the constraint was real, validated, and on the base table).
- ✅ `0a` applied to staging; constraint widened and `convalidated = t`.
- ✅ `0a` alone is **inert to the writer** — resolver matrix byte-identical before/after.
- ✅ `0b` applied; 198-cell staging matrix → **0** gram/estimated changes, 4 cells relabelled.
- ✅ **Prod read-only simulation** — 2421 cells → **0** gram mismatches, **0** estimated mismatches,
  **0** nullness desyncs. *(No DDL or DML was run against prod.)*
- ✅ `0r1` **refuses** to run while v4 is installed (guard fires with the HINT).
- ✅ Full round trip `0a → 0b → 0r2 → 0r1` returns staging to its **exact** baseline: resolver
  byte-exact v3, 3-value CHECK, original row counts, zero leftover `schema_version` rows.
- ✅ Integration tests **29/29 green at v4 AND 29/29 green at pre-feature** — the capability-detect
  pattern works in both directions (this is the CI chicken-and-egg fix, §8).
- ✅ `ops-stgweightparity-001/verify.sql` — all 8 gates PASS on staging with the G2 fix.
- ✅ Build clean; eslint clean; **3271 frontend unit tests pass**; both `gates.yml` files
  strict-`yaml.safe_load` clean and `yamllint -d relaxed` clean.

**Staging was returned to its pre-feature baseline** and is *not* left with this migration applied —
see the sequencing note in §8.

---

## 8. Prod runbook

> **Prod state as of writing: NOT APPLIED.** Nothing in this migration has been run against prod.
> `dev→main` is a hard gate; this runbook is a deliverable, not an authorisation.

### Blast radius on prod, measured

`cultivar_sample` will apply to **exactly two cultivars**: **Celebrity** (n=3, medium) and **San
Marzano Roma** (n=2, high) — the only two corroborated groups. All 16 provisional cultivars also
carry a curated reference, so they resolve at **tier 4** and keep `'cultivar'`. **Prod's tier 5 is
currently empty.** That is demote-don't-discard working as designed, and it means the initial
user-visible change is small — 3 (plant × unit) cells.

### Order of operations

**CI/staging first — this ordering is load-bearing.** `integration-test.yml` branches CI off
`staging` and does **not** apply migrations, so schema and test expectations move independently.

1. **Land the test + gate commit on `dev` first.** The tests capability-detect `schema_version
   4.20.8` and are green on **both** sides of the apply (verified), so this commit is safe against a
   staging that has *not* been migrated. Landing it first is what prevents an unrelated dev push
   from red-lining. Do **not** apply to staging before this lands — a concurrent agent's push would
   go red against hardcoded expectations still in `main`.
2. **Apply to staging**, in order, checking gates between:
   ```sh
   psql "$NEON_STAGING_URL" -f migrations/v4-harvbasis-sample-001/0a-widen-check.sql
   #   run gates.yml `mid` — these AUTHORISE phase 2
   psql "$NEON_STAGING_URL" -f migrations/v4-harvbasis-sample-001/0b-resolver-v4.sql
   #   run gates.yml `post`
   psql "$NEON_STAGING_URL" -f migrations/ops-stgweightparity-001/verify.sql   # 8 gates, all PASS
   ```
3. Push to `dev`; confirm integration CI green against the migrated staging.
4. **Prod, on Dave's explicit approval only.** Same two commands against `$NEON_DATABASE_URL`, with
   `gates.yml` `pre` → `mid` → `post` run at the boundaries. **Snapshot first** (cheap insurance,
   ~360 rows):
   ```sql
   CREATE TABLE ctas_20260804_harvest_log_prebasis AS SELECT * FROM public.harvest_log;
   ```
5. **No Lambda deploy and no frontend deploy is required for correctness** at either phase. The
   `EventDetail.jsx` copy change is cosmetic and ships on its own schedule — safe in any order
   relative to the DB phases. Shipping it *before* the DB phases simply means no row is labelled
   `cultivar_sample` yet, so the new wording never appears.

### Rollback, prod

| symptom | action |
|---|---|
| anything unexpected after phase 2 | `psql "$NEON_DATABASE_URL" -f .../0r2-rollback-phase2.sql` — restores v3, **stop here** |
| feature abandoned, vocabulary must not linger | run `0r2`, *then* `0r1` (squashes, lossy) |
| 23514 on harvest saves | you are in the forbidden ordering — run `0r2` immediately; it is the fast path back |

Byte-exact restore assets:
`~/AI/Claude/Projects/Gardening/directwritedrift-reversal-20260804/resolve_harvest_weight-v3-prod-20260804.sql`
(and the pre-existing `…-v2-…sql`).

---

## 9. Known follow-ups — NOT done here, deliberately

1. **The PUT drip (`lambda/events/index.js` ~1113).** The edit path recomputes and overwrites
   `weight_grams`, `weight_estimated` **and** `weight_basis` on every save, preserving only a
   *user-typed* weight. So after phase 2, editing a quality star on an old harvest silently rewrites
   that row to `cultivar_sample` **and re-values its grams against today's samples**. This means
   "don't backfill" is only partly in our control — history mutates at an unbounded, uneven rate.
   Pre-existing behaviour, not introduced here, but it is the strongest argument for either fixing
   the PUT to preserve basis/grams when quantity+unit are unchanged, or accepting the drift
   explicitly. **Recommend a follow-up ticket.**
2. **`chk_harvest_log_weight_basis_estimated` fails OPEN.** It derives estimated-ness from
   `weight_basis <> 'measured'`, an *inequality*, so any future value is auto-classified as
   estimated. Correct for `cultivar_sample`. But add a future non-estimated provenance
   (`measured_scale`, `user_entered`) and it will silently force `weight_estimated = true` on a
   genuine measurement. The fail-closed form is an enumeration:
   ```sql
   CHECK (weight_basis IS NULL
          OR (weight_basis = 'measured' AND weight_estimated = false)
          OR (weight_basis IN ('cultivar','cultivar_sample','crop_type') AND weight_estimated = true))
   ```
   **Deliberately not folded in** — it is a *narrowing* of a validated constraint, i.e. the dangerous
   class, and out of scope for this change. Worth its own migration.
3. **`src/lib/cal1Weights.js` is a stale JS mirror** of the resolver (a non-runtime reference impl
   feeding the seed generator). It was already stale vs **v3** — it has no corroboration predicate
   and no tier-5 slot — so it is left alone rather than made half-accurate for v4. Porting v3+v4
   semantics is its own task. Nothing fails loudly if it drifts, which is precisely why it should be
   ticketed.
4. **`migrations/v4-cal1-slicec-001/gates.yml`** is already marked RETIRED and was not touched.
