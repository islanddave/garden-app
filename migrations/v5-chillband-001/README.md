# v5-chillband-001: the weather-cue log can record a sixth cue, `cool`

One CHECK constraint, `weather_cue_impression_cue_chk` on `public.weather_cue_impression`, swapped for a
superset of itself: `freeze, cold, heat, rain, wet` becomes `freeze, cold, cool, heat, rain, wet`. `cool` is
the line for a night between 45 and 50 F (ledger `V5-CHILLBAND-001`; Dave, 2026-10-12: "A line on each cool
night"). Every weather line shown on Today writes one row to that table, and the table refuses a cue it does
not know. The decisions are in the header of `0a-widen-cue-check.sql`.

**Not applied to staging or prod.** Written 2026-10-13 by a lane with no database, then rehearsed the same
day on a throwaway local PostgreSQL 17.10 (see "What was rehearsed, and where"). The staging apply is still
the first time these files meet the real table. Applying to prod is a prod database change and needs Dave's
first-hand OK.

| file | what it does |
|---|---|
| `0a-widen-cue-check.sql` | Reads the constraint as it stands. Exactly the five, validated: drops it and adds the six, validated against every existing row, in one transaction. Exactly the six: nothing. Anything else: raises, changing nothing. Updates the column comment. Stamp `5.0.0-chillband-001`. Writes no rows. Idempotent. |
| `0r-rollback.sql` | Narrows back to the five, restores the comment, removes the stamp. Guarded: refuses while any row records `cool`. This is the direction that can hurt a deployed writer (see Rollback). |
| `gates.yml` | 4 `pre`, 1 `sweep`, 3 standing `post`. Every `post` gate is catalog-only and self-armed on the stamp. |
| `rehearse_local.py` | The three files above on a throwaway local Postgres, re-runnable: the whole sequence, the writer's INSERT before and after, and a planted defect for every gate and every refusal. `python3 migrations/v5-chillband-001/rehearse_local.py`, about 25 s. Writes only to the cluster it creates. |

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
  names. Neither file is edited here. Measured in the rehearsal: that folder's 12 standing `post` gates give
  the same 12 passes before and after this `0a`.

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
vacuous without the stamp. Measured on the rehearsal database with the DDL absent: `post` 3 of 3, and 3 of 3
under `--continuous-only`.

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
long-open transaction the file fails fast (psql exits 3, `55P03`, after 5.0 s in the rehearsal) having
changed nothing. Run it again.

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

## What was rehearsed, and where

On a throwaway local PostgreSQL 17.10 (the sibling directories record prod and staging as 17.11), loopback
only, on 2026-10-13, by `rehearse_local.py` in this directory. The starting state is the repo's own:
`schema_version` created by `v2-mvp-critter/0a-additive-ddl.sql`'s statement, and `weather_cue_impression`
made by running `ops-cueinstrument-001/0a-additive-ddl.sql` whole, so the five-value CHECK is the one that
file writes. Ten rows, two per cue, written with the deployed writer's INSERT. Gates were run through
`scripts/gate_runner.py`. 58 checks, all holding, in 22 s.

- unapplied: `pre` 4/4, `sweep` 1/1, `post` 3/3 (vacuous, none erroring), and 3/3 for the
  `--phase post --continuous-only` run `gate-invariants.yml` makes; `0a`; the CHECK validated and printing as
  `CHECK ((cue = ANY (ARRAY['freeze'::text, 'cold'::text, 'cool'::text, 'heat'::text, 'rain'::text, 'wet'::text])))`;
  `post` 3/3; `pre` 2/4, as "Applying" says; `0a` again says "already admits the six cues; nothing to do" and
  leaves the constraint's oid, the schema dump, the stamp row (`applied_at` included) and every row as they
  were;
- `0r` leaving the schema dump (the five, the old comment), `schema_version` and every row byte-equal to the
  state before `0a`; `0r` again a no-op; `pre` 4/4, `0a`, `post` 3/3 again; `0r`, `0a` and `0a` again
  arriving with an empty `search_path`, each exit 0;
- `0a` behind a reader's open transaction on the table: psql exit 3 with 55P03 after 5.0 s, nothing changed;
  the same file again, exit 0;
- every line of the table in "What the constraint does to a writer", with the writer's own statement:
  `cool` before `0a`, 23514 naming `weather_cue_impression_cue_chk`; after `0a`, accepted, and still one row
  when sent again the same day; a seventh value after `0a`, 23514 on the same name; each of the five
  accepted; `cool` in an unknown form refused by `weather_cue_impression_form_chk`, which is untouched;
- the rollback with one `cool` row present: refused ("1 impression row(s) record the cool cue"), the six,
  the stamp and every row as before. With that row deleted it narrows, and an INSERT of `cool` is 23514
  again: the rollback is the arming direction;
- 9 starting CHECKs that are neither the five nor the six (four values; seven; five with a foreign one; the
  five NOT VALID; the five AND a second condition; the five and a column in the same list; no CHECK of the
  name; the five under another name; no table): `0a` refuses each, the schema dump, the constraint and
  `schema_version` as before, and a `pre` gate is red first;
- a row outside the six under a CHECK the catalog was told is validated: `sweep` red first; `0a`'s ADD fails
  on its scan (23514) and the DROP goes back with it, the same constraint oid still there;
- a second CHECK over `cue` under another name: `pre_no_other_check_names_cue` red before; `0a` does not
  look for one and widens the named CHECK; `post_no_other_check_names_cue` red after; `cool` is still
  refused, by the other CHECK. The two gates are what stop this, not `0a`;
- 11 single defects on an applied database (the stamp deleted; the CHECK narrowed, widened to seven,
  re-added NOT VALID, dropped, given a second condition, given a column in its list, tested on `lower(cue)`,
  renamed; a second CHECK over `cue`, alone or with `form`), each turning exactly the gate written for it
  red (two for the rename); a control green;
- `0r` refusing a seventh value, the six AND a second condition, the six and a column, and no CHECK of the
  name, changing nothing each time; a no-op where `0a` never ran; exit 0 with the stamp removed where the
  table is gone;
- two mutated copies (`0a` adding the six `NOT VALID`; `0r` with its `cool`-row guard disabled): the script
  exits 1 for each. Without the guard the narrowing still fails, on the raw 23514 the `0r` header predicts.

**Found by the rehearsal and fixed here:** the constraint was read only as the set of its quoted values, and
the set is not the whole constraint. `CHECK (cue IN (<the five>) AND cue <> 'rain')` reads as the five, and
so does a list that also holds a column. `0a` widened from both (dropping the second condition without a
word), `pre_cue_check_is_exactly_the_five_and_validated` passed both, `0r` narrowed from the same two shapes
of the six, and the `post` gate (which did check a prefix) passed the six with a column in the list. `0a`,
`0r` and both gates now also require the whole definition to be one membership test on `cue` against quoted
words, matched end to end as PostgreSQL 17 prints it. That is text a major version prints: on a server that
prints it differently `0a` refuses and the `pre` gate reds, changing nothing, which is the safe failure.
The DDL `0a` and `0r` issue once past their guards is unchanged.

**Not rehearsed:** anything on staging or prod; that the CHECK on either is the one `ops-cueinstrument-001`
wrote (the `pre` gate reads that at apply time); how many rows either table holds; the Lambda (its 202 on a
23514 is read in the source, not exercised); two sessions racing the swap; the whole standing corpus
(`--all`) against a real schema.
