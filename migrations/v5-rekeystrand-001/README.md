# v5-rekeystrand-001 — BUG-REKEYSTRANDSPROFILE-001, the CLASS

The Snapdragon instance is already fixed. This migration closes the class it belongs to, by arming a
standing gate that notices the next one. It ships **no data change and no DDL** — one `schema_version`
row, which is the arming switch, and `gates.yml`, which is the deliverable.

| file | what it does |
|---|---|
| `0a-arm-guard.sql` | Inserts the receipt `5.0.0-rekeystrand-20260908`. Writes nothing else. Also carries the `_retained` recipe as a comment. |
| `0r-rollback.sql` | Deletes that receipt, which disarms the gates back to vacuous. Touches no data. |
| `gates.yml` | One `pre` measurement and four `post` gates — the guard, its anti-vacuity check, the marker-quality check, and the apply receipt. |

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
from ~1,200 to **4**, and the guard to **2**. Three independent narrowings do the work:

1. **An observed re-key event**, not merely an absent planting. This is what excludes the seed-inventory
   population entirely — nobody ever re-pointed a planting off those.
2. **Zero live plantings now.** Excludes Gong Bao, the other half of a 2026-09-02 swap, which still has
   one.
3. **The `_retained` marker**, below — a deliberate retention is a decision in the data, not a finding.

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
