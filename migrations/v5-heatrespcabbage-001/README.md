# v5-heatrespcabbage-001 — NOT APPLIED

**Status: WRITTEN, GATED, UNAPPLIED.** Nothing in this directory has been run against any database.
The apply decision belongs to whoever owns the `V5-HEATRESPONSEDISPLAY-001` ship, and it must run on
**both staging and prod**.

## Why

`V5-HEATRESPONSEDISPLAY-001` puts `care_profile.heat_response` in front of a human for the first
time. Three cabbage cultivar rows say **`>85F daily; heat causes bolting; afternoon shade`**, and
that is horticulturally wrong: cabbage bolting is **vernalization** — flowering induced by sustained
*cold* on a plant past its juvenile stem diameter, expressed later when it warms. Heat does not
cause it. Heat loosens the head, raises the split risk, and makes prompt cutting the right move.

Shipping the display surface without this correction tells Dave to shade a cabbage that wants
harvesting. The correction therefore lands **before** the surface, not after.

## Scope (measured read-only on prod, 2026-09-02)

Exactly three `care_profile` rows carry the string. All `scope='cultivar'`, all
`crop_type_slug='cabbage'`, resolving to **3 live plantings**:

| scope_id | cultivar | provenance | source file in this repo? |
|---|---|---|---|
| `48c55703-8ddf-46bf-a7e9-7187319d1046` | Cabbage (unknown) | `_seeded: true` | yes — `migrations/care-cadence-001-seed.sql` |
| `622ad02d-7f06-4bc6-a0bb-e0ca0943257c` | Copenhagen Market | `_source: cadence-backfill-20260823` | no |
| `691c2afb-f950-497f-88ff-c6398c732265` | Red Acre | `_source: cadence-backfill-20260823` | no |

Only the first has a source file here, which is the whole reason this migration exists: correcting
`lambda/daily-plan/cadence-data-v2.json` alone would leave **two of Dave's three cabbages** still
asserting the wrong cause.

## The corrected string

```
>85F daily; heat loosens heads and worsens splitting; harvest promptly; afternoon shade; bolting here is cold-triggered (vernalization), not heat
```

Written in the corpus's own register (threshold first, semicolon-separated, imperative). The
corrective clause is carried *in the string* on purpose — without it the next author re-derives the
same error from the same intuition.

## It is a single-key update, not a jsonb full-replace

`0a-data-fix.sql` is one statement:

```sql
SET profile = jsonb_set(profile, '{heat_response}', to_jsonb('…'::text), false)
```

`jsonb_set` rewrites one key and returns the rest of the object untouched. Nothing else on the row is
read, re-typed or reconstructed — watering intervals, the `cold` block, `confidence`, `notes`, the
`_seeded` / `_source` provenance markers `v_resolved_care`'s seededgate resolver reads, and any
overwintering or suppression key a later writer added all survive byte-identically. A
`SET profile = '{…}'::jsonb` would drop whichever of those the author forgot, which is the known
failure mode for `care_profile` edits in this codebase.

`gates.yml` asserts this rather than trusting the comment: `post_correction_was_single_key_not_a_full_replace`
goes red if a corrected cabbage row is missing any of its pre-existing keys, and
`post_cabbage_still_resolves_a_watering_cadence` goes red if the edit disturbed what the watering
engine reads.

Matched on the **old value** rather than a scope_id list, so the migration is self-limiting
(a second run matches zero rows), cannot clobber a hand-edit made in the meantime, and corrects any
future cultivar that inherits the same sentence. `0r-rollback.sql` is its exact inverse.

## Also changed outside this directory

`migrations/care-cadence-001-seed.sql` carries the same one-string correction. That file is a
**full-object upsert** (`ON CONFLICT … SET profile = excluded.profile`), so re-running it against a
corrected prod would silently restore the wrong claim. The `post_no_row_claims_heat_causes_cabbage_bolting`
gate is what catches that if it ever happens.

## Not in scope

`heat_response` is **display prose only**. It is not wired into any watering or care threshold, and
this migration does not change that. The engine-input disposition was explicitly rejected: 43% of the
corpus strings carry no numeric °F threshold at all, the ones that do span five conflicting hot
thresholds *plus four cold ones a naive hot-branch would mis-fire on*, and 31 of the 54 strings
asking for more frequency already sit at `water_interval_days_container = 1`.
`lambda/daily-plan/heat-response-not-an-engine-input.test.js` is the standing guard on that.
