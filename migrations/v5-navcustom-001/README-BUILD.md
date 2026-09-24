# V5-NAVCUSTOM-001 — per-person More-menu pins and tab bar on `user_notification_prefs`

Dave, 2026-09-24 (AUQ D1–D4): pins are per person, and so is the tab bar ("only my bar changes"; Jen's
never shifts). This migration adds the two per-person stores; the critter Lambda's prefs route reads and
writes them, and the SPA draws from them. Design: `project-state/design-navcustom-V100-20260924.md` §8
(binding). Contract: `project-state/_navcustom-build-20260924/CONTRACT.md` §1–§3.

## Status

| Step | State |
|---|---|
| `0a` / `0c` staging | **APPLIED** 2026-09-24 15:56:59Z — pre 6/6, sweep 2/2 (before and after 0a), post 8/8; whole corpus `--continuous-only` 0 FAIL / 0 ERROR |
| `0a` / `0c` prod | **NOT APPLIED** — needs Dave's OK |
| Critter Lambda (`lambda/critter/`) | integration branch `integ-navcustom-20260924`, **not pushed to dev** |
| SPA (`src/`) | integration branch `integ-navcustom-20260924`, **not pushed to dev** |

Rehearsed first on a throwaway local PostgreSQL 17.10 carrying prod's table definition (pg_dump
`--schema-only` as `garden_ro`): CHECK accept/reject probes, the self-armed post gates vacuous before the
apply, one gate proved non-vacuous by a planted vocabulary CHECK, `0r` then `0a`+`0c` re-applied twice, and
the critter Lambda's real PATCH upsert run through four save shapes. Detail:
`project-state/_navcustom-build-20260924/integration-report.md`.

## Files

| file | what it does |
|---|---|
| `0a-additive-ddl.sql` | One transaction: `ADD COLUMN IF NOT EXISTS more_pins jsonb` and `bar_layout jsonb` (nullable, no default); `chk_unp_more_pins_shape` and `chk_unp_bar_layout_shape` added `NOT VALID`; the `5.0.0-navcustom-001` stamp. |
| `0c-validate.sql` | `VALIDATE`s both CHECKs. Safe at once (see below). Idempotent. |
| `0r-rollback.sql` | Drops both CHECKs, both columns and the stamp. **Only once no deployed code reads the columns.** |
| `gates.yml` | 6 `pre`, 2 `sweep` (all apply-window only); 1 `post` receipt + 7 standing `post` invariants, every one self-armed on the stamp. |

The shapes, enforced in the database (the vocabulary is the Lambda validator's job, never the database's):

- `more_pins`: NULL, or an array of at most 32 entries. Written as `CASE WHEN jsonb_typeof(...)='array'
  THEN jsonb_array_length(...) <= 32 ELSE false END`, because Postgres does not promise the evaluation
  order of `AND` and `jsonb_array_length` raises on a non-array.
- `bar_layout`: NULL, or an object whose `order` and `hidden` members, where present, are arrays.

## Landing order — NOT OPTIONAL

Run from the garden-app repo root. `gate_runner.py` reads `NEON_STAGING_URL` / `NEON_DATABASE_URL`
from the environment and never takes a URL on the command line (L-067).

1. **Staging**
   1. `python3 scripts/gate_runner.py --migration migrations/v5-navcustom-001 --env staging --phase pre`
   2. `... --env staging --phase sweep`
   3. `psql "$NEON_STAGING_URL" -v ON_ERROR_STOP=1 -f migrations/v5-navcustom-001/0a-additive-ddl.sql`
   4. `... --env staging --phase sweep` again: the L-058 pre-VALIDATE sweep, now over real columns
   5. `psql "$NEON_STAGING_URL" -v ON_ERROR_STOP=1 -f migrations/v5-navcustom-001/0c-validate.sql`
   6. `... --env staging --phase post` (all 8 PASS)
2. **Prod**: the same six steps with `--env prod` and `"$NEON_DATABASE_URL"`. Cite the PASS of
   `post_more_pins_is_nullable_jsonb_without_default` and `post_bar_layout_is_nullable_jsonb_without_default`
   (information_schema reads on prod) wherever the ship is recorded: design §5 asks for exactly that read
   before any Lambda selects the columns.
3. **Both environments, whole corpus** (memory `garden-migration-gates-both-envs`):
   `python3 scripts/gate_runner.py --all --env prod --phase post --continuous-only`, then `--env staging`.
4. **THEN push the code** (critter Lambda + SPA) to `dev` → CI → staging deploy and smoke → promote →
   `deploy-lambda` (critter) and the web deploy.

**Why the order is load-bearing.** `readUserPrefs` in `lambda/critter/index.js` lists its columns by
name, and it runs on every user's boot. A critter Lambda that selects `more_pins` before this DDL exists
in its environment 500s **every user's boot prefs read**: PrefsProvider then gets null and every
per-person preference silently resets (Garden grouping, today's skips, the What's-New dot, the Log-many
default). The PATCH's INSERT column list names both columns too, so every prefs save 500s as well.
The same order is what keeps CI honest:

- the L-081 schema audit (`schema-audit.yml`, Phase 2) checks every INSERT column list under `lambda/`
  against **prod's** information_schema, so the dev push reds it if prod lacks the columns;
- the integration job forks its Neon branch from **staging**;
- `deploy-staging.yml` deploys the critter Lambda to staging and its smoke (`tests/smoke/run-smoke.sh`,
  block L) writes and reads back both fields there, so staging must carry the DDL first.

**Old code + new schema is inert**, so steps 1–3 can land any time before step 4 and the gap can be as
long as needed. The deployed critter Lambda names neither column (explicit SELECT, INSERT and RETURNING
lists), `lambda/events/critterAward.js` reads the table by an explicit list without them, and nothing
selects `*` from it. Both columns simply stay NULL.

## Why VALIDATE in 0c is safe immediately

The test for arming a writer-coupled CHECK (gardening-deploy, after the 2026-08-03 harvest outage) is:
*would the currently deployed code produce a row that violates it?* No. No deployed code writes either
column, so every row holds NULL, and NULL is the first arm of both CHECKs. The table held 2 rows on prod
at design time.

## Rollback

Code back before schema back. First promote a `main` that predates the V5-NAVCUSTOM-001 critter change and
redeploy the critter Lambda; confirm it no longer selects the columns; THEN run `0r-rollback.sql`. The
reverse order is the boot-prefs outage described above. `0r` loses every pin and bar layout set since the
apply; its header carries the snapshot query. An SPA that still sends the new keys to a reverted Lambda gets
400 "no updatable fields present" on a pins-only or bar-only save, which it reports as not saved.

## Design decisions

- **This table, not `app_config` or `favorites`.** `app_config` is global and admin-only to write, the scope
  D4 ruled out. `favorites.entity_id` is uuid and its type CHECK admits four types. `user_notification_prefs`
  is keyed on the Clerk sub, is read at every boot, and already carries `today_skipped`, the jsonb template.
- **Nullable, no DEFAULT, no 0b.** NULL is "never set" = the shipped menu and bar. There is no prior
  server-side value to migrate. A PATCH cannot write NULL back (the route merges with COALESCE); `[]` and
  the shipped-default object are the cleared values and read the same as NULL.
- **Shape only.** A vocabulary CHECK would turn a retired More row id into a 23514 on every later save.
  `post_only_the_shape_checks_touch_the_navcustom_columns` pins that.
- **No view widen.** The table is a plain table (`relkind 'r'`), re-checked by a pre gate.
- **Self-arming post gates, values through `to_jsonb`.** Nothing here reds `gate-invariants.yml` before the
  apply, and no gate names the new columns as columns (the parse-time hazard).

## Verification performed at authoring (2026-09-24)

Nothing was applied to staging or prod, and no Neon connection was opened. See the lane report
(`project-state/_navcustom-build-20260924/lane-api-report.md`) for the exact checks and counts.
