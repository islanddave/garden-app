# v5-oprankchecknull-001 — the Open-pollinated CHECK, made NULL-safe

Ledger: `BUG-OPRANKCHECKNULL-001`. Follows `V5-VARIETYFACTSEDIT-001` (v4.142.0).

## What was wrong

`v5-varietyhybridflag-001` added

```sql
CHECK (breeding_system IS DISTINCT FROM 'open_pollinated' OR variety_rank = 'cultivar')
```

to say that an Open-pollinated claim needs a single named cultivar under it. On an unranked row
`variety_rank = 'cultivar'` is NULL, so the whole predicate is NULL, and a CHECK passes on NULL. The rule
therefore held only on rows that already had a rank. On prod that is 79 of 517 varieties; 438 have none
(read 2026-09-23). Measured on a staging fork on 2026-09-21: Open-pollinated on an unranked row was
accepted by the database.

Until now only two things held the rule on those rows: the variety editor's preflight and its fill
(Dave, 2026-09-21: choosing Open-pollinated on an unranked variety records it as a single named
cultivar, in the same UPDATE), and the weekly gate
`v5-varietyhybridflag-001::post_no_op_claim_without_cultivar_rank`, which reports a violation after the
fact.

## The change

One constraint, same name, NULL-safe comparison:

```sql
CHECK (breeding_system IS DISTINCT FROM 'open_pollinated' OR variety_rank IS NOT DISTINCT FROM 'cultivar')
```

DROP and ADD run in one transaction, so there is never a moment with no constraint. A guard counts the
rows the new form would refuse (soft-deleted included) and raises instead of forcing. No data changes.

## Why it is safe to arm

Asked of what is deployed, not of a branch (`claude-ops/project-rules/gardening-deploy.md`, "arming a
CHECK is not backward-compatible"):

| Writer of `breeding_system` | Can it produce a row the new form refuses? |
|---|---|
| `lambda/varieties` PUT, v4.142.0 | No. Open-pollinated on an unranked row fills `variety_rank = 'cultivar'` in the same UPDATE (`fillsCultivarRank`); on a recorded non-cultivar rank the preflight answers 400 before any write. |
| `lambda/varieties` PUT, v4.141.1 and earlier | No. It had no breeding arm. |
| `POST /api/varieties` | No. It writes no breeding column. |
| `lambda/plants`, `lambda/inventory-items` | No. They only read it. |
| `Projects/Gardening/_seedpacket_20260919/apply_fills.py` | No. Its UPDATE carries `AND (%s <> 'open_pollinated' OR variety_rank = 'cultivar')`, which never matches an unranked row. |
| `v5-varietyhybridflag-001/0b-data.sql` | History (applied 2026-09-03). |

Census at dev `dc253a127ef940970f9252dedaf38dfb65ce4f77` (grep of `breeding_system` across the repo) plus
the two out-of-repo scripts that mention the column. Live rows the new form refuses: 0 on prod, 0 on
staging (2026-09-23).

## Order

Per `gardening-deploy.md` and the gate-invariants workflow (post gates must hold before this directory
reaches `dev`):

1. staging: `--phase pre` -> apply `0a` -> rehearse `0r` -> re-apply `0a` -> `--phase post`
2. `gate_runner.py --all --env staging --phase post --continuous-only`
3. prod, **with Dave's approval for this apply** (a prod constraint change): `--phase pre` -> apply `0a`
   -> `--phase post` -> `gate_runner.py --all --env prod --phase post --continuous-only`
4. push this directory to `dev`

```bash
cd <worktree>
export NEON_STAGING_URL=...   # read by key name from garden-app/.env.local
python3 scripts/gate_runner.py --migration migrations/v5-oprankchecknull-001 --env staging --phase pre
psql "$NEON_STAGING_URL" -v ON_ERROR_STOP=1 -f migrations/v5-oprankchecknull-001/0a-rearm-check.sql
python3 scripts/gate_runner.py --migration migrations/v5-oprankchecknull-001 --env staging --phase post
```

## Rolling back

`0r-rollback.sql` puts the `= 'cultivar'` form back under the same name and deletes the stamp. It costs
the database-level rule on unranked rows; the editor's fill and the weekly gate stay.

## Status

AUTHORED 2026-09-23 (seedstab7-20260923).

- Pre gates 3/3 on staging AND prod before any apply; post on the unapplied databases: the standing
  gate PASS (vacuous), the stamp receipt APPLY_WINDOW_ONLY — so this directory cannot red
  gate-invariants.yml before it is applied.
- STAGING, 2026-09-23: applied `0a`, rehearsed `0r` (old definition back, stamp gone), re-applied `0a`.
  Post 2/2. `--all --env staging --phase post --continuous-only`: 0 FAIL (755 PASS, 160 window-only,
  13 manual not run, 23 not applicable, 4 retired). Behaviour, each in a rolled-back transaction: Open-
  pollinated on an unranked row raised 23514 on this constraint; the same claim with the rank filled in
  one UPDATE through `public.cultivar` (the editor's statement shape) succeeded.
- PROD, 2026-09-23 12:21:27Z, Dave-approved for this apply (AskUserQuestion "Apply it now"): pre 3/3,
  `0a` applied, post 2/2, the constraint validated with the NULL-safe definition. `--all --env prod
  --phase post --continuous-only`: 0 FAIL (778 PASS, 160 window-only, 13 manual not run, 4 retired).
- Then this directory went to `dev`.
