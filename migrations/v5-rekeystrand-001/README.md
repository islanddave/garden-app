# v5-rekeystrand-001 — BUG-REKEYSTRANDSPROFILE-001, the CLASS

The Snapdragon instance is already fixed. This migration closes the class it belongs to, by arming a
standing gate that notices the next one. It ships **no data change and no DDL** — one `schema_version`
row, which is the arming switch, and `gates.yml`, which is the deliverable.

| file | what it does |
|---|---|
| `0a-arm-guard.sql` | Inserts the receipt `5.0.0-rekeystrand-20260908`. Writes nothing else. Also carries the `_retained` recipe as a comment. |
| `0r-rollback.sql` | Deletes that receipt, which disarms the gates back to vacuous. Touches no data. |
| `gates.yml` | One `pre` measurement and four `post` gates — the guard, its anti-vacuity check, the marker-quality check, and the apply receipt. |
| `preview_armed.py` | READ-ONLY. What the gates would say on prod or staging if 0a were applied, with every row the guard would count. Run it before arming (§Arming). |
| `rehearse_local.py` | The red/green rehearsal on a throwaway local Postgres, re-runnable (§Verification 2026-09-21). Writes only to the cluster it creates. |
| `placeholder-vocabulary.test.js` | Vitest, runs in CI. Pins the placeholder exclusion to the keys and `_basis` labels of `NEW_CULTIVAR_PROFILE` and `BLEND_PROFILE` (§Placeholders, §A mix's birth profile). |

## The defect

An agent researches a cultivar and writes a `care_profile` keyed to its variety id. A human then changes
that planting's Variety through the app. That is **not** a rename — two surfaces look identical and have
opposite data semantics:

- `src/components/forms/VarietyEditor.jsx` mutates the variety row **in place**. The id survives, and so
  does everything keyed to it. Safe.
- `src/components/VarietyPicker.jsx` — which is what `PlantForm` actually embeds — **mints a new
  `plant_varieties` row** (`submitCreate`, lines 306-332) and re-points the form at it (line 330).

The planting PUT then writes the new id as a bare column assignment:

```
UPDATE public.garden_node p SET
  cultivar_id = CASE WHEN <hasVariety> THEN <new id> ELSE p.cultivar_id END
-- lambda/plants/index.js:1098-1101
```

No dependent-row logic of any kind. The research is now attached to a variety nothing is growing, and
`care_profile.scope_id` carries **no foreign key**, so the database cannot see the reference in order to
complain about it. Nothing warns; nothing carries it forward.

## Why the predicate is "lost a planting to an observed re-key"

The obvious predicate — "keyed to a variety with no live planting" — is unusable as a standing gate.
Measured on live prod 2026-09-08 it holds for roughly **1,200 rows**: 640 `entity_tag`, 253
`inventory_items` (seed packets owned but not sown — entirely correct), and 34 `care_profile` of which 30
are a legitimate 2026-06-18 bulk write for unplanted seed cultivars. A gate red at 1,200 findings trains
everyone to ignore the runner, which is the disease `gate-invariants.yml:32-42` documents at length.

Scoping instead to varieties that an `audit_events` row **proves** lost a planting takes the candidate set
from ~1,200 to **4**, and the guard to **2**. Three independent narrowings do the work, and a fourth was
added on 2026-09-21:

1. **An observed re-key event**, not merely an absent planting. This is what excludes the seed-inventory
   population entirely — nobody ever re-pointed a planting off those.
2. **Zero live plantings now.** Excludes Gong Bao, the other half of a 2026-09-02 swap, which still has
   one.
3. **The `_retained` marker**, below — a deliberate retention is a decision in the data, not a finding.
4. **Not a bare app placeholder** — §Placeholders. Dave's decision, 2026-09-21. Since 2026-10-06 the same
   narrowing also covers a named mix's bare birth profile — §A mix's birth profile.

## The `_retained` marker

**This is the release valve, and it is load-bearing.** Without it the only way to clear a real finding is
to delete research that may be worth keeping — the Snapdragon profile is still correct research about
snapdragons, and Dave may plant an actual snapdragon. The marker makes "orphaned" and "wrong" genuinely
different states, so the gate can go green without anyone weakening it.

**Meaning:** a top-level string key on `care_profile.profile` recording that this profile is deliberately
kept against a cultivar that no longer has a planting. Any non-empty JSON string clears that row.

```sql
UPDATE public.care_profile
   SET profile = profile || jsonb_build_object(
         '_retained',
         'Kept 2026-09-08 on Dave''s decision: the research describes snapdragons correctly and this '
         'cultivar is expected to be planted again. Its last planting was re-keyed to Penstemon '
         '1565a553 on 2026-09-08.')
 WHERE scope = 'cultivar' AND scope_id = '<variety uuid>'::uuid;
```

**It cannot degrade into a mute off-switch.** The cheapest way to silence a real finding would be
`"_retained": true`, and `post_retained_marker_states_a_reason` reds on exactly that — the marker must be
a JSON **string**, non-empty after trimming, so a boolean, a number, a null or `""` fails. That is the
same laundering `v4-cadencerefill-001`'s judgement-label gate exists to prevent.

**What the gate cannot check, and a reviewer must:** whether the sentence is any good. "x" passes the
machine test. The convention this README sets is that the sentence names *who* decided, *when*, and *why
the row should outlive its planting*. That part is human.

To withdraw a retention, `profile = profile - '_retained'`. `0r-rollback.sql` deliberately does **not**
strip markers, because they are Dave's decisions rather than artifacts of this migration.

## Placeholders are not strands — Dave's decision, 2026-09-21

**What changed underneath the guard.** v4.137.0 (BUG-CULTIVARNOPROFILE-001) made the create-cultivar path
write a care_profile with every cultivar it mints, in the same transaction — `NEW_CULTIVAR_PROFILE` in
`lambda/varieties/index.js`: `{_source: 'cultivar-create', _basis: 'unresearched', notes}` and nothing
else. VarietyPicker re-identifies a planting by minting a new cultivar, so from then on **every**
correction strands one of these. Found by preship-qa I4 (2026-09-18), which asked for the case to be
decided and rehearsed before this guard is armed anywhere.

**The decision.** Put to Dave as an AskUserQuestion on 2026-09-21. He chose **"Ignore placeholders"**,
whose text read: *"It flags only when researched care info gets left behind. A placeholder holds
nothing. Flagging it would fire on every correction you make (renaming Unknown Sweet Long would be the
first), and that teaches everyone to ignore the detector."*

**The rule, by property — never by name, never by writer.** A stranded row is a placeholder, and is not
counted, only while **both** hold:

- `_basis` is `'unresearched'` — the create path's label. Keyed on the meaning, not on `_source`, so a
  placeholder written by a later backfill is excluded too (the same choice v4-cadencerefill-001's
  sibling gate made); and
- the row carries **no key beyond `_source`, `_basis` and `notes`** — the create path's own keys.

Anything added makes it count again: a cadence, a feed flag, a drought note, any key at all, or a
relabelled `_basis`. That is the half that matters, because the likeliest way research lands on a
placeholder is a merge (`profile || '{…}'`), which leaves `_basis: 'unresearched'` behind.

```sql
AND ((cp.profile->>'_basis' IS DISTINCT FROM 'unresearched'
      AND cp.profile->>'_basis' IS DISTINCT FROM 'blend')
     OR (cp.profile - ARRAY['_source', '_basis', 'notes']) <> '{}'::jsonb)
```

(The second label was added 2026-10-06 — §A mix's birth profile. Until then the clause was the first
label alone, and every result in §Verification 2026-09-21 was measured on that form.)

Written as `IS DISTINCT FROM … OR`, never `NOT (… = … AND …)`: with no `_basis` at all the conjunction is
NULL, `NOT NULL` is NULL, and the row silently leaves the guard (mutant M5 below). The `pre` gate carries
the identical clause so it keeps measuring what the guard counts.

**Unknown Sweet Long is NOT a placeholder by this rule, and re-identifying it will flag — once.** The
option text above cites it as the first placeholder that would fire. Its row (lane
`cultivar-cadence-fix-20260917`, measured 2026-09-21) says `_basis: 'unresearched'` about the cultivar's
identity, but also carries the Dave-approved Capsicum fallback — `water_interval_days_container: 2`,
`fertilize_interval_days: 17` — plus `crop` and `confidence`. That is care info, and a label-only rule
that silenced it would equally silence real research merged onto a placeholder (mutant M2). When it is
re-identified, clear it on purpose: a `_retained` sentence, or delete the stub profile. It is the only
`unresearched` row on prod; there are no create-path placeholders on prod yet (0 rows, 2026-09-21).

**Known limit.** A writer who puts research into `notes` alone and leaves `_basis: 'unresearched'` has, in
the house vocabulary, declared the row still undecided, and it is treated as a placeholder. Measured
2026-09-21: 0 of 267 prod cultivar profiles carry `notes` as their only non-underscore key. Relabel
`_basis` when you research a placeholder.

**What holds it in place.** `placeholder-vocabulary.test.js` (CI) fails if `NEW_CULTIVAR_PROFILE` gains or
loses a key, renames its `_basis`, or if the `pre` and guard clauses drift apart — any of which would
bring the per-correction noise back or hide research. `rehearse_local.py` proves the SQL's behaviour.

## A mix's birth profile is not a strand either — Dave's decision, 2026-10-06

**What changed underneath the guard.** Seed release 2a (V5-VARIETYBLEND-001) added
`POST /api/varieties/blend`, which makes one variety row for "seed saved from these varieties together"
and writes a care_profile with it in the same transaction — `BLEND_PROFILE` in
`lambda/varieties/blend.js`: `{_source: 'blend-create', _basis: 'blend', notes}` and nothing else. It
cannot use the placeholder's label: `v4-cadencerefill-001`'s
`post_no_live_planting_rests_on_an_unresearched_placeholder` counts every live planting whose cultivar
says `_basis = 'unresearched'`, so a mix labelled that way would red that gate the day it is sown. No
single label satisfied both gates, and this guard counted the mix: re-key a mix's only planting to
another variety and its birth profile read as stranded research. Predicted by the varieties lane,
observed on real PostgreSQL 2026-10-06 (a fork of staging, the guard's own SQL with its receipt conjunct
removed; `tests/integration/variety-blend.int.test.js`), and raised by the pre-push QA review as F8.

**The decision.** Put to Dave as an AskUserQuestion on 2026-10-06. He chose **"Teach the check about
mixes"**. A mix has no care of its own to research — it is seed from several varieties, and whatever is
known is known about them — so its birth profile holds nothing, exactly as a placeholder holds nothing.

**The rule — the same exemption, by the same property.** A stranded row is a mix's birth profile, and is
not counted, only while **both** hold:

- `_basis` is `'blend'` — the blend route's label; and
- the row carries **no key beyond `_source`, `_basis` and `notes`** — the same list the placeholder is
  held to, because the two constants have the same keys (the vocabulary test fails if they ever differ).

Anything added makes it count again, as it does for a placeholder: a cadence, a feed flag, any key at
all, or a relabelled `_basis`. A mix that somebody gives real care content is research, and stranding it
flags. `_retained` still clears a row either way.

**Why it is safe where the guard is already armed.** The change only widens an exclusion. Every row the
new predicate counts, the old one counted too; no row can enter the count because of it. A database on
which the guard was green stays green, the receipt is not touched, and nothing has to be re-applied: the
runner reads `gates.yml` from the checkout. (Removing the label again would be the opposite case — it
can add rows — and would need a preview first.)

**What holds it in place.** `placeholder-vocabulary.test.js` now reads `BLEND_PROFILE` beside
`NEW_CULTIVAR_PROFILE` and fails if the gate's labels are not exactly those two constants' `_basis`
values, if either constant's keys differ from the stripped list (or from each other), or if `pre` and the
guard drift apart. `rehearse_local.py` was not changed: its seventeen cases carry no mix and must read as
they did. The mix cases themselves — a bare birth profile excused, the same profile with one key added
counted — run on real PostgreSQL against a mix the route made, in the integration file above.

## Environment — verified, not assumed

`gate-invariants.yml` runs post-gates against **both** prod and staging, so a gate that errors on staging
reds the job. The recon could not reach staging and recommended `env: prod` as the safe choice. Staging
**was** reachable from this lane (`NEON_STAGING_URL`) and was checked directly:

- `audit_events`, `care_profile`, `plants`, `schema_version` all exist as real tables (`relkind='r'`).
- `trg_audit_plants_upd` and `trg_audit_plants_del` are both installed on `public.plants`, and the update
  trigger's tracked-column list includes `variety_id`.
- Staging carries **39** re-key events (the integration suite re-keys plantings), so the guard is
  non-vacuous there too — but **zero** of those 39 varieties has a cultivar `care_profile`, so the guard's
  violation count on staging is 0 and it runs green.

So these gates take no `env:` and run on both. Only the `pre` gate is `env: prod`, because it asserts a
prod-specific starting state that staging has no equivalent of.

*Residual risk, stated rather than left to be discovered:* staging's green depends on the integration
suite not writing cultivar `care_profile` rows. If that ever changes, staging could red here. The fix
would be a cleanup in `tests/integration/_cleanup.js`, not a weakening of this gate.

*Update 2026-09-21.* Since v4.137 the deploy-staging smoke's variety POST writes a create-path placeholder,
and smoke block D re-keys its planting to NULL — exactly this guard's shape. Two things now keep that off
the guard: the sweep deletes smoke profiles before their varieties (OPS-SMOKECAREPROFILE-001,
`deploy-staging.yml`), and a stranded placeholder is not counted anyway (§Placeholders; rehearsal case
A2). Staging was **not** re-measured by the 2026-09-21 lane — run `preview_armed.py --env staging` before
arming it.

## RLS

`plants`, `entity_tag` and `schema_version` carry row-level security; `care_profile` and `audit_events` do
not. Read these predicates as `garden_ro` and you can under-count live plantings and therefore **over**-report
strands — the same trap `v4-entitytagorphan-001`'s header records. `gate_runner` connects as the owner
(`NEON_DATABASE_URL` / `NEON_STAGING_URL`, RLS-exempt, `conn.read_only = True`) and gets the true answer.
Every count here was confirmed through the runner on the owner DSN, not only via `psql-ro.sh`.

## Historical blind spot

The `plants` audit trigger was armed **2026-08-27 00:27:29**. No re-key before that date is detectable, so
this guard is **forward-looking by construction**. It is not a sweep of history and cannot be made into
one.

The recon flagged three older `care_profile` rows (`_source: cowork_care_audit_20260709`) as
"the same class, two months older". Checked against prod 2026-09-08, **none of the three is a re-key
strand**:

| variety | plantings ever | state |
|---|---|---|
| Vietnamese Coriander `418668ee` | 0 | never planted — research written without a planting |
| Dracaena `33dec2de` | 0 | never planted — same |
| Lithops `62ebb3d1` | 1 | planting `f586305f` archived 2026-07-09, status `failed` — the plant died |

They are three of a healthy batch of 13 written that day, the other 10 of which have live plantings. None
would ever trip this gate (no re-key event exists for any of them), so they cost nothing left alone. They
are a one-time decision for Dave, not a gate's business.

## Surfaces deliberately not covered

`care_profile` is the only table this guard watches, and that is a decision rather than an oversight.

- **`entity_tag` (`entity_type='cultivar'`) — NOT covered, premise fails.** The recon nominated this as the
  largest unprotected surface (1,208 rows, no FK) and left the retention-marker carrier as an open design
  question, since `entity_tag` has no JSONB column. The question dissolves: **every one of those 1,208 rows
  is machine-derived**, not authored. `lambda/varieties/crop-derive.js` materializes `type` / `lifecycle` /
  `heat` / `determinacy` / `day_length` / `allium_type` / `basil_use` / `bean_*` tags **from the cultivar's
  own structured columns**, as system-owned rows, and reconciles them on write. Measured on prod: all 166
  tags are `source='derived'`, `owner_id='system'`, `visibility='shared'`; zero user-authored cultivar tags
  exist. The 7 tags on the three candidate varieties each match their still-present variety's current
  columns exactly. So nothing is stranded — the variety row still exists, the tags still describe it
  correctly, the new variety gets its own tags from `applyDerive`, and there is no human judgement in an
  `entity_tag` row for a `_retained` marker to carry. A gate here would fire on rows that are correct by
  construction. *If user-authored cultivar tags ever land (`VALID_USER_FACETS` = `group`, `freeform`,
  `issue` exists in `lambda/tags/validate.js` but has produced nothing in prod), this analysis needs
  revisiting.* The real `entity_tag` risk — a parent hard-delete orphaning rows — is already covered by
  `v4-entitytagorphan-001`'s four guard triggers and its standing `post_no_orphaned_entity_tag_rows`.
- **`cultivar_weight_sample` — already handled at the source.** V4-HARVWEIGHTEST-001 re-files calibration
  samples when a planting is re-identified (`lambda/plants/index.js:1325+`). A gate would duplicate it.
- **`inventory_items`, `preservation_log`, `preservation_source`, `voice_alias`, `proj_rescope_events`** —
  each has a real FK, and on the four re-keyed varieties each is empty or legitimate. A gate on them would
  be vacuous today, and a gate that has never been shown to fire is not a guard.

## Prevention is a separate decision

This detects; it does not prevent. The three candidate prevention options — widen the 409 duplicate check
(`lambda/varieties/index.js:878-893`, whose `COALESCE(species,'')` comparison is anti-correlated with agent
enrichment), carry dependents forward at the planting PUT, or warn in the picker — are a product decision
for the ticket owner and are deliberately not made here.

## Verification performed 2026-09-08

- `python3 -m pytest scripts/test_gate_runner.py -q` → **52 passed**.
- `gate_runner.py --all --env prod --validate-only` → 114 gate files, 1411 gates, schema-valid.
- Full corpus `--phase post --continuous-only`: **prod 763 PASS / 0 FAIL / 0 ERROR**, **staging 744 PASS /
  0 FAIL / 0 ERROR**.
- YAML validated with both PyYAML `safe_load` and `yamllint -d relaxed` (0 errors; only line-length
  warnings, matching the rest of the corpus).
- Red → green → red proven end-to-end on a throwaway local Postgres seeded with the **real prod rows**,
  driving the **shipped** `gates.yml` through the **shipped** runner. Six states: unapplied (all pass —
  self-arming), applied (**fail, rowcount 2 — matches prod exactly**), both marked `_retained` (all pass),
  marker downgraded to boolean (marker gate fails), a **fresh strand after clearing** (fails again), and
  the audit trigger dropped (the strand gate goes silently green while the anti-vacuity gate catches it).

## Verification performed 2026-09-21 (the placeholder exclusion)

The 2026-09-08 harness was not kept, so the rehearsal is now a file: `python3 rehearse_local.py`. It
builds a throwaway PG 17 cluster on a unix socket, loads the **shipped** audit machinery
(`v4-harvestaudit-001/0a`, `v4-plantingaudit-001/0a`), issues every re-key through `garden_node` the way
the plants PUT does (so `audit_events` rows come from the real trigger, and each case asserts its re-key
wrote exactly one), arms with the **shipped** `0a`, evaluates `NEW_CULTIVAR_PROFILE` out of the Lambda
source rather than retyping it, and drives the **shipped** `gates.yml` through the **shipped** runner.
One database per case, plus one holding all non-destructive cases at once so the counts must add up.

| case | stranded profile | guard | pre |
|---|---|---|---|
| U0 | researched, receipt absent | 0 (vacuous) | 1 |
| **A** | **app placeholder, VarietyPicker re-key — Dave: not a strand** | **0** | **0** |
| A2 | placeholder, re-key to NULL (staging smoke block D) | 0 | 0 |
| A3 | placeholder from another writer | 0 | 0 |
| **B** | **researched (`_seeded` key shape)** | **1** | **1** |
| **C** | **placeholder + Unknown Sweet Long's research, `_basis` still 'unresearched'** | **1** | **1** |
| C2 | placeholder + feed flag and drought note only | 1 | 1 |
| C3 | placeholder relabelled `_basis: dave_decision`, nothing added | 1 | 1 |
| C4 | placeholder + one cadence key | 1 | 1 |
| D | `{_source, notes}` with no `_basis` | 1 | 1 |
| E | `{}` (an empty row is a decision) | 1 | 1 |
| F | researched, cultivar still planted | 0 | 0 |
| G | researched, `_retained` sentence | 0 | 0 |
| H | researched, `_retained: true` | 0, marker gate **1** | 0 |
| I | trigger dropped before the re-key | 0 (blind), feed gate **1** | 0 |
| J | fresh strand after clearing one | 1 | 1 |
| ALL | all of A–G and J in one database | 8 | 8 |

**17/17 as expected.** Every mutant below was run on a copy of `gates.yml` and killed:

| mutant | cases that went wrong |
|---|---|
| M1 no exclusion (= the 2026-09-08 predicate) | A, A2, A3, ALL |
| M1p / M1g exclusion in only one of pre / guard | A, A2, A3, ALL (the other gate) |
| M2 `_basis` label only | C, C2, C4, ALL |
| M3 `_source = 'cultivar-create'` only | A3, C2, C3, C4, ALL |
| M4 "create-path row with no watering key" | A3, C2, C3, ALL |
| M5 `NOT (… AND …)` | D, E, ALL |
| M6 key-set emptiness only | C3, D, E, ALL |
| M7 key list widened by `water_interval_days_container` | C4, ALL |
| M8 guard's receipt clause dropped | U0 |
| M10 `IS DISTINCT FROM` flipped to `=` | A, A2, A3, C3, D, E |

Also: M1 written over the real file reds the harness (exit 1) and restoring it byte-for-byte greens it;
the harness with the audit triggers left out exits 2 naming the unaudited re-key, never a pass.
`placeholder-vocabulary.test.js`: 3 pass; five in-place mutants (placeholder gains a key, placeholder
`_basis` renamed, guard key list drops `notes`, pre clause removed, guard label changed) each red it.
`pytest scripts/test_gate_runner.py` 52 passed; `gate_runner --all --validate-only` 119 files / 1484
gates; yamllint relaxed 0 errors.

## Verification performed 2026-10-06 (a mix's birth profile)

**The seventeen cases above read as they did.** `python3 rehearse_local.py`, unchanged, against the
widened `gates.yml`: exit 0, 17/17 (A, A2, A3 excused; B, C, C2, C3, C4, D, E, J counted; ALL 8 and 8).
Three mutants of the new clause, each a copy handed to `--gates` and each killed (exit 1):

| mutant | cases that went wrong |
|---|---|
| `AND` between the two labels turned into `OR` (the exclusion vanishes) | A, A2, A3, ALL |
| only the `'blend'` label tested (the placeholder no longer excused) | A, A2, A3, ALL |
| `NOT (_basis IN (…) AND bare)` in place of `IS DISTINCT FROM … OR` | D, E, ALL |

**The mix cases, on real PostgreSQL 17.11** (a throwaway fork of staging;
`tests/integration/variety-blend.int.test.js`, "a planting sown under a mix, and the standing care
gates"). The guard is unarmed on staging, so the test runs its SQL as shipped with the receipt conjunct
removed, pointed at the rows under test. A mix made by `POST /api/varieties/blend`, an ordinary new
cultivar on its placeholder, and a cultivar with a researched profile each have their only planting
re-keyed away by the same statement:

| stranded profile | guard |
|---|---|
| the mix's birth profile, as the route wrote it | **0** |
| the ordinary placeholder | 0 |
| the researched profile (the control: the re-key was seen) | 1 |
| the mix's profile + one cadence key (`profile \|\| '{…}'`, `_basis` still 'blend') | 1 |
| …that key removed again | 0 |
| the mix's three keys relabelled `_basis: dave_decision` | 1 |
| the mix's profile with no `_basis` at all | 1 |

Before the change the first row read 1 (the same file, the same day, asserted as the known cost). With
the label taken back out of a copy of `gates.yml` the first row reds; with `'blend'` excused by label
alone (no bare-row test) the fourth does.

`placeholder-vocabulary.test.js`: 4 pass; seven in-place mutants each red it (the guard without the mix
label, the `pre` gate without it, `BLEND_PROFILE` gains a key, `BLEND_PROFILE._basis` renamed, a third
label in both gates, the key list without `notes`, `NEW_CULTIVAR_PROFILE` gains a key).
`pytest scripts/test_gate_runner.py` 58 passed; `gate_runner --all --env prod --validate-only` 137 files /
1817 gates; yamllint relaxed 0 errors.

## Arming — what it is and how to do it (authored 2026-09-21, NOT applied anywhere)

**Arming is one row.** `0a-arm-guard.sql` inserts `schema_version` `5.0.0-rekeystrand-20260908`; every
standing gate here keys on it, so the guard is vacuous until it exists and a real invariant after. It is
per environment: `gate-invariants.yml` runs these gates against prod **and** staging, and each is armed
only by applying `0a` there. Nothing else is written. `0r-rollback.sql` deletes the row.

**It is a prod write**, so the prod apply needs Dave's explicit OK. Approving this code is not approving
the apply.

**Order, and why:**

1. **This predicate reaches `main` first.** The Tuesday cron runs `main`'s copy of `gates.yml`. Arm prod
   while `main` still has the 2026-09-08 predicate and the first app-minted placeholder stranded by a
   VarietyPicker correction reds the cron.
2. **Resolve today's findings.** `preview_armed.py --env prod` on 2026-09-21: **NOT ARM-SAFE, 3 rows**, all
   2026-06-18 `_seeded` profiles (the same under the old predicate — no placeholder exists on prod):

   | variety | stranded by | today |
   |---|---|---|
   | `81951ffd-71fc-4a77-87a1-01ea07e96357` Palmetto Punch | 2026-09-02, planting `2b1f722f` → Gong Bao (Kung Pao) | no live planting, no packet |
   | `c03b71ce-963d-482c-ad1d-19ddcdb69b9b` Bulgarian Carrot (Shipka) | 2026-09-10, planting `71eb286b` → Sweet Orange Pepper (Unknown) | no planting, no packet |
   | `f0f2ed77-d3a5-418b-975c-fca44c11cd4c` Sunbright | 2026-09-17, planting `2a78b09a` → Unknown Sweet Long | no planting, **1 packet** |

   Each is Dave's call: RETAIN (a `_retained` sentence — recipe in §The `_retained` marker) or RESOLVE
   (delete the profile). They are the same kind of row as the ~30 bulk-seeded profiles for unplanted
   cultivars this guard never counts; only the re-key makes them findings.
3. **Preview must say ARM-SAFE, then apply, then verify executed-not-vacuous:**

```bash
cd <garden-app checkout at a commit carrying this README>
export NEON_DATABASE_URL="$(/usr/bin/grep -m1 '^NEON_DATABASE_URL=' /Users/davenichols/AI/Claude/Projects/Gardening/garden-app/.env.local | cut -d= -f2-)"
python3 migrations/v5-rekeystrand-001/preview_armed.py --env prod          # must print ARM-SAFE, exit 0
psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-rekeystrand-001/0a-arm-guard.sql
python3 scripts/gate_runner.py --migration migrations/v5-rekeystrand-001 --env prod --phase post
#   expect: all 4 post gates PASS — post_receipt_written rowcount=1 proves the guard is armed, not vacuous
python3 scripts/gate_runner.py --all --env prod --phase post --continuous-only   # whole corpus, no new FAIL
```

Staging, only if wanted (unarmed on 2026-09-18 per the smokeprofile lane; not measured on 2026-09-21):
the same three steps with `NEON_STAGING_URL`, `--env staging`. Rollback on either:
`psql "$URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-rekeystrand-001/0r-rollback.sql`.
