# V4-CROPTYPEDOGWOOD-001 — the dogwood crop type, and typing the Kousa cultivar

Data-only. Adds `crop_types.dogwood` and types the existing `Kousa` cultivar that Dave created
untyped on 2026-08-17.

## Why it exists

Dave added a Kousa dogwood and could not add a type. Confirmed against prod: zero dogwood rows out
of 141 `crop_types`, and the cultivar `Kousa` (`0189f4cd…`, created 13:47:06Z) carried
`crop_type_slug` NULL — 32 seconds before the planting `Kousa Dogwood` that references it.

The write path was not broken. The reference data never existed, and the affordance that would have
created it was the 143rd row of an unfiltered chooser. `V4-CROPTYPEREACH-001` fixes the
reachability; this fixes the data.

## Shape — one row plus a retype, NOT the two-row aloe shape

`V4-CROPTYPEALOE-001` had to mint a cultivar as well, because Dave's Aloe planting had
`variety_id` NULL. Here the cultivar already exists and the planting already points at it, so
minting a second one would duplicate what the picker lists.

Modelled on `japanese_maple`, the only other `tree`: both are woody ornamental trees, hardy at this
site, grown for form and flower. `harvest_habit` stays NULL to match it — *Cornus kousa* does bear
edible fruit, but Dave planted a landscape tree, and asserting a harvest habit he has not claimed
would push it into harvest-facing surfaces he did not ask for.

Values mirror exactly what `POST /api/varieties/crop-types` would have written, so the row is
indistinguishable from an in-app mint.

## Apply — THREE steps, in order

The third is not optional. Every cultivar write through the API is followed by `applyDerive`
(`lambda/varieties/index.js:395`), which reconciles the system-owned `type` / `lifecycle` facets.
That is not expressible in SQL; running only the `.sql` file is the "direct DB write skips the
Lambda side effects" failure mode.

```bash
export NEON_STAGING_URL=...        # from .env.local; never pass a URL on the command line (L-067)
export NEON_DATABASE_URL=...

python3 scripts/gate_runner.py --migration migrations/v4-croptypedogwood-001 --env staging --phase pre
psql "$NEON_STAGING_URL" -v ON_ERROR_STOP=1 -f migrations/v4-croptypedogwood-001/0a-data.sql
python3 scripts/gate_runner.py --migration migrations/v4-croptypedogwood-001 --env staging --phase post

python3 scripts/gate_runner.py --migration migrations/v4-croptypedogwood-001 --env prod --phase pre
psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/v4-croptypedogwood-001/0a-data.sql
node migrations/v4-croptypedogwood-001/0c-derive.mjs
python3 scripts/gate_runner.py --migration migrations/v4-croptypedogwood-001 --env prod --phase post
```

`0c-derive.mjs` exits 0 with "cultivar absent" on staging — the crop type applies to both
environments, the retype is prod-only, and the prod-only gate `post_kousa_is_typed` carries
`env: prod` for the same reason.

## Applied

| env | when | result |
|---|---|---|
| staging | 2026-08-17 | pre 3/3, post 3/3 (+1 n/a, the prod-only receipt). Crop type only — no Kousa cultivar there. |
| prod | 2026-08-17 | pre 3/3, post 4/4. `UPDATE 1` on the cultivar. `applyDerive`: 2 tags upserted, 2 links added, 0 failures → `type:dogwood`, `lifecycle:perennial`. |

## Rollback

`0r-rollback.sql`. Guarded throughout: the retype is reverted only while the cultivar still carries
exactly what this migration wrote, so a later retype by Dave is never clobbered, and the crop type is
deleted only if no cultivar still references it. **Re-run `0c-derive.mjs` after a rollback** to clear
the facets that would otherwise dangle.
