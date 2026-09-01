# v4-grownasdefault-001 — drop the manufactured default on `plant_varieties.grown_as`

Closes **`BUG-GROWNASDEFAULT-001`**. DDL only — **zero rows read or written**.

## Status

**APPLIED 2026-09-01 to staging then prod.** Post gates 3/3 green on both. Receipt
`4.89.0-grownasdefault-001`.

## What changed

`ALTER TABLE public.plant_varieties ALTER COLUMN grown_as DROP DEFAULT;` — that is the whole
change. The column keeps its type and stays nullable.

## What deliberately did NOT change

The **195 May+June rows already written `'annual'` by the default are untouched.** That is the
ledger row's own instruction, and the reason is specific: `sowEngine.js:375` reads
`candidate.grown_as ?? candidate.lifecycle`, so `'annual'` is currently holding 7 of 259 seed
candidates off a NULL fall-through. Mass-correcting them here would move 6 of those 7 candidates'
close dates **51–112 days later**. That correction belongs with sow-window Phase 0, with the
window consequences in view. This migration is only the bleeding-stopper: it stops *new* rows
being manufactured.

Consequently there is **no gate on the value distribution** of `grown_as`. A gate pinning today's
362-annual count would go red the moment that legitimate Phase 0 correction lands — it would be
asserting the bug rather than the fix.

## The consumer census (the precondition the ledger row demanded)

Run against `origin/dev` `dea90f5`. The row said "a NOT NULL assumption downstream would break",
so the census looked for exactly that and found none:

| Consumer | Reads it how | NOT NULL assumption? |
|---|---|---|
| `lambda/varieties/index.js:707` (INSERT) | passes `${body.grown_as ?? null}` **explicitly** | No — never used the default |
| `lambda/varieties/index.js:491` (UPDATE) | `COALESCE(new, existing)` | No |
| `lambda/varieties/validate.js:12` | nullable enum, 4 legal values | No — NULL already legal |
| `src/lib/sowEngine.js:375` | `grown_as ?? lifecycle` | No — coalesce by design |
| `src/lib/parseSowProfile.js:171` | returns `grown_as: null` for unknown | No |
| `migrations/**` | `git grep -iE "grown_as[^,)]*not null"` | **Zero matches** |

**The finding that settles it:** the app's own INSERT has always passed an explicit value. That is
why May/June are 100% `'annual'` and July onward began arriving NULL — the write path was fixed
then, and only the DB default kept manufacturing values afterwards for column-omitting writers
(hand SQL, seed/load scripts, future migrations). Those are exactly the writers that should state
their intent rather than inherit someone else's.

## Re-arming

The default was introduced twice — `v4-classify/0a-additive-ddl.sql:53` and
`v4-seedinv-001/0a-additive-ddl.sql:39` — both as
`ADD COLUMN IF NOT EXISTS grown_as text DEFAULT 'annual'`. The column now exists, so a re-run of
either is a no-op and **cannot** silently re-arm this default. `post_grown_as_default_not_rearmed`
holds that as a standing invariant regardless.

## Gates

Schema-shape only, so they are environment-symmetric and none can pass vacuously for want of a row.
Post gates are **violation-count shape** (`expect: 0`), which is load-bearing for the self-arming —
see the comment block in `gates.yml` for why `rowcount_eq: 1` breaks it.

Non-vacuity was verified after apply rather than assumed: with the receipt present, the inverted
predicate returns 1 row, proving the gate fires on a regression instead of being permanently green.

## Rollback

`0r-rollback.sql` restores `DEFAULT 'annual'` and deletes the receipt, which also disarms the post
gates. No row is put back because none was touched.
