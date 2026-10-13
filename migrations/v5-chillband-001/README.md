# v5-chillband-001: the weather-cue log can record a sixth cue, `cool`

One CHECK constraint, `weather_cue_impression_cue_chk` on `public.weather_cue_impression`, swapped for a
superset of itself: `freeze, cold, heat, rain, wet` becomes `freeze, cold, cool, heat, rain, wet`. `cool` is
the line for a night between 45 and 50 F (ledger `V5-CHILLBAND-001`; Dave, 2026-10-12: "A line on each cool
night"). Every weather line shown on Today writes one row to that table, and the table refuses a cue it does
not know. The decisions are in the header of `0a-widen-cue-check.sql`.

**Not applied anywhere by the lane that wrote it (2026-10-13). No SQL in this directory has been run
against PostgreSQL**: the lane had no database. The files were parsed with the PostgreSQL grammar
(libpg_query) for syntax, and `gates.yml` passes `gate_runner.py --validate-only`; that is all. Rehearse on
staging before anything else. Applying to prod is a prod database change and needs Dave's first-hand OK.

| file | what it does |
|---|---|
| `0a-widen-cue-check.sql` | Reads the constraint as it stands. Exactly the five, validated: drops it and adds the six, validated against every existing row, in one transaction. Exactly the six: nothing. Anything else: raises, changing nothing. Updates the column comment. Stamp `5.0.0-chillband-001`. Writes no rows. Idempotent. |
| `0r-rollback.sql` | Narrows back to the five, restores the comment, removes the stamp. Guarded: refuses while any row records `cool`. This is the direction that can hurt a deployed writer (see Rollback). |
| `gates.yml` | 4 `pre`, 1 `sweep`, 3 standing `post`. Every `post` gate is catalog-only and self-armed on the stamp. |

One stamp. No column, no index, no new name. `weather_cue_impression_form_chk` is not touched.

## In plain words

The app's private tally of which weather line it showed each day learns one new line, the one for a cool
night. Nothing changes on screen: the cool-night line itself arrives later, in its own release, after its
spring and fall wording has been seen.

## The name is `cool`

There was no September migration to reuse: `git log --all --oneline -- migrations | grep -i chill` returns
nothing. What shipped on 2026-09-09 (`7b43773d`) was two files, an engine rule and its tests, and it was
reverted 46 minutes later (`010caa2f`, "the `cool` cue cannot render, and it silences real cues"). That rule
returned `icon: 'cool'`. The engine and client lanes of this release are cut from the same record
(`project-state/_triage-20261012/recon-wxbands-20261012.md` B1), so the value is taken from it exactly.

Two things to know about it before it reaches prod, because after that a rename is another migration:

- `cold` (below 45 F) and `cool` (45 to 50 F) differ by one letter, and the `cold` cue's own wording begins
  "Cool night". Neither is a defect; both are easy to misread in a query.
- It is ONE value for spring and fall. Which season a row belongs to is in `shown_on`. If the engine lane
  ends up with two rules (one per season) rather than one rule with two wordings, this CHECK needs both
  names and this file is the place to say so before it is applied.

## Widening is the safe direction

`gardening-deploy.md`, "arming a CHECK is NOT backward-compatible", is about a constraint on a value only
the NEW writer sets: arm it before the code and the still-deployed OLD writer starts failing. This is that
rule read in reverse. The old writer can only send what it has always sent, and all five are still
admitted, so the widening goes **before** the code and cannot hurt it. Going back (`0r`) is the arming step.

The swap is atomic and validated: `DROP CONSTRAINT` then `ADD CONSTRAINT` with no `NOT VALID`, inside one
transaction under one lock. The `ADD` scans the table and fails the whole file if any row is outside the
six. No writer ever sees the table without a cue CHECK.

## Would the currently deployed code break on this?

No. Read on `origin/dev` `1f58a9d8`, which is what prod runs.

- **The writer**, the only one, is `lambda/daily-plan-read/cue-impression.js`. `normalizeCueImpression`
  drops any cue outside its own `CUES` set (the same five) before a statement runs. Every row it can write
  passes the new CHECK exactly as it passed the old one.
- **Readers.** None. No Lambda and no client code selects from this table.
- **The engine** (`lambda/daily-plan/engine.js` `computeCallout`) has no rule that returns `cool`.
- **The existing gates** of `ops-cueinstrument-001` stay green by reading: `post_cue_check_carries_all_five_rules`
  is five substring matches and holds on a superset; `post_check_constraints_present` asks for the two
  names. Neither file is edited here.

## Order of work

Independent of every other directory. Ships ahead of the `V5-CHILLBAND-001` code, which ships alone in its
own release.

1. **Staging apply.**
2. **Prod apply**, on Dave's first-hand OK.
3. Only then the code that can send `cool`: the engine rule, `CUE_FORM` in `src/lib/weatherCue.js` and
   `CUES` in `lambda/daily-plan-read/cue-impression.js`, together.

**Nothing enforces step 3, and that is the risk in this one.** The promote's prod schema gate checks that
the columns and relations a Lambda names exist; it does not read the values a CHECK admits. And the writer
is fail-open by design: a 23514 is caught, logged as a warning, and answered 202. Shipped the wrong way
round, Today shows the cool-night line and every impression of it is lost with nothing red anywhere. The
release checklist for the code has to carry "5.0.0-chillband-001 is on prod" as a line someone reads.

This directory by itself is safe in the tree before either database is applied: every `post` gate is
vacuous without the stamp. **By construction, not measured.**

## Applying

Run from the repo root, with the URL in the environment (never on a command line that is logged).

```bash
# --- staging -------------------------------------------------------------------------------------
python3 scripts/gate_runner.py --migration migrations/v5-chillband-001 --env staging --phase pre
python3 scripts/gate_runner.py --migration migrations/v5-chillband-001 --env staging --phase sweep
psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-chillband-001/0a-widen-cue-check.sql
python3 scripts/gate_runner.py --migration migrations/v5-chillband-001 --env staging --phase post
python3 scripts/gate_runner.py --migration migrations/ops-cueinstrument-001 --env staging --phase post

# staging only: rehearse the rollback, then put it back
psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-chillband-001/0r-rollback.sql
python3 scripts/gate_runner.py --migration migrations/v5-chillband-001 --env staging --phase pre
psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-chillband-001/0a-widen-cue-check.sql
python3 scripts/gate_runner.py --migration migrations/v5-chillband-001 --env staging --phase post
python3 scripts/gate_runner.py --all --env staging --phase post --continuous-only

# --- prod (Dave's first-hand OK; outside 07:00-08:00 UTC; after the pre-apply copy) ----------------
python3 scripts/neon_safety_branch.py --env-file .env.local create --slug chillband --days 7
python3 scripts/gate_runner.py --migration migrations/v5-chillband-001 --env prod --phase pre
python3 scripts/gate_runner.py --migration migrations/v5-chillband-001 --env prod --phase sweep
psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-chillband-001/0a-widen-cue-check.sql
python3 scripts/gate_runner.py --migration migrations/v5-chillband-001 --env prod --phase post
python3 scripts/gate_runner.py --all --env prod --phase post --continuous-only
```

Prod gets `0a` only; the rollback is rehearsed on staging and not on prod.

Do not apply prod DDL between 07:00 and 08:00 UTC (the nightly dump at 07:00 and `restore-verify` at 08:00).
This file adds no table, so it would not red that run by itself; the rule is kept so there is one rule.

Any `pre` or `sweep` failure is a stop. After `0a` the `pre` phase reads 2 of 4 by design
(`pre_cue_check_is_exactly_the_five_and_validated` and `pre_not_already_applied` are `continuous: false`
and false once applied); it is not run again except after a rollback, where it must read 4 of 4.

## What it locks, and for how long

`DROP CONSTRAINT` takes an ACCESS EXCLUSIVE lock on `weather_cue_impression` and holds it to COMMIT; the
validating scan of `ADD CONSTRAINT` runs under it. The table has grown by at most five rows per person per
day since 2026-09-02, so the scan is a few hundred rows at most (not counted by this lane) and the
transaction should be milliseconds. The one thing that waits is the impression beacon's INSERT, which is
fire-and-forget. The Today read does not touch this table. `0a` sets `lock_timeout = '5s'`: behind a
long-open transaction the file fails fast having changed nothing. Run it again.

## What the constraint does to a writer, before and after

| write | before `0a` | after `0a` |
|---|---|---|
| `freeze`, `cold`, `heat`, `rain`, `wet` | accepted | accepted |
| `cool` | 23514, caught by the writer, 202, the row is lost | accepted |
| any other value | 23514, as above (and the handler drops it before the statement) | the same |

## Rollback

`0r-rollback.sql` narrows the CHECK back to the five, restores the column comment and removes the stamp.

1. **Code back before schema back, and here the order matters more than usual.** Narrowing re-arms a CHECK
   against a value a writer may be sending. While deployed code can send `cool`, running `0r` does not
   break Today; it silently discards every `cool` impression from then on. Take the engine rule and both
   vocabularies back first.
2. **It refuses while it would lose something.** A `cool` row is the only record that the line was shown
   that day. The file stops, changing nothing, while any exists, and says how many. Getting past that is
   Dave's decision, with the rows exported first; not by editing the guard and not with `NOT VALID`.
3. **Nothing in the repo has to move first.** Every `post` gate here returns to vacuous with the stamp
   gone.
4. **It only narrows from the six.** If a later migration has widened the CHECK again, `0r` refuses; that
   one goes back first.

## Other surfaces this touches

- **The staging drift check cannot see this change.** `scripts/check-staging-drift.py` compares constraints
  by table and name, and the name does not change. Between the staging apply and the prod apply the two
  databases differ and nothing reports it. Keep the window short.
- **The next widening retires a gate here.** `post_cue_check_validated_and_exactly_the_six` is exact on
  purpose and will red on a seventh cue; the migration that adds one marks it `retired:` in the same
  commit. `ops-cueinstrument-001`'s gate did not need that for this change because it only asks that the
  original five be present.
- **The public site is not involved.** `gam-site` does not read this table.
- `ops-cueinstrument-001/0a-additive-ddl.sql` still shows the five-value CHECK and comment. That file is
  the record of what was applied on 2026-09-02 and is not edited.

## What was checked, and what was not

Checked, with no database:

- `python3 scripts/gate_runner.py --all --env prod --validate-only` (the CI step) and
  `scripts/test_gate_runner.py`: this `gates.yml` parses and meets the strict schema;
- every statement in `0a`, `0r` and every gate parses under the PostgreSQL grammar (libpg_query through
  `pglast`), the `DO` bodies as PL/pgSQL. Syntax only: no catalog, no types, no execution;
- the two expressions everything here leans on are taken from gates that already run green on prod: the
  set-of-quoted-values read is `v4-losscapture-001`'s, and the printed form
  `CHECK ((<column> = ANY (ARRAY['a'::text, ...])))` for a text column written as `IN (...)` is
  `v5-seedmultiparent-001`'s `chk_slpp_role`.

**Not rehearsed, anywhere:** `0a`, `0r`, any gate, the three branches of each `DO` block, the refusal with
a `cool` row present, a second run being a no-op, the `post` gates being vacuous on an unapplied database,
`ops-cueinstrument-001`'s gates before and after, and a schema dump after `0a` then `0r` being equal to the
one before.
