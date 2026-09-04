# V5-SEEDQTY-001 — what ships with this migration, and in what order

Read this before promoting. The ordering is not optional and one step happens AFTER prod is live.

## State as of writing

| thing | state |
|---|---|
| `0a-additive-ddl.sql` | **APPLIED to prod AND staging** 2026-09-04, both shape-gate verified |
| `0b-backfill-and-arm.sql` | **NOT APPLIED anywhere.** Post-deploy only — see below |
| code | on `dev`, not promoted |

## Why 0a was applied before the code, and why 0b must not be

`0a` is vacuous under the deployed writer, and that was verified rather than assumed: the Lambda
uses explicit column lists in both `INSERT INTO inventory_items (…)` (`index.js:1175-1190`) and
`UPDATE inventory_items SET …` (`:881-896`), with no dynamic column construction. The deployed code
therefore cannot emit the three new columns, they stay NULL, and every new CHECK passes on NULL.

`0b` is the opposite. It arms `chk_inventory_seed_count_basis_pairing`, which constrains a column
only the NEW writer sets. Arming it before the writing release is live is the 2026-08-03 incident
verbatim — that one took harvest logging down until the constraints were dropped.

It was also applied to **both** databases before the migration directory was pushed, because
`.github/workflows/gate-invariants.yml` runs `gate_runner.py --phase post --continuous-only` against
prod AND staging on every `migrations/**` push plus a weekly cron, and treats UNKNOWN as a third,
FAILING outcome. One environment un-applied = a red sweep that reads like a broken gate.

## Promote sequence

1. **Confirm both databases still carry 0a.** Receipt `5.0.0-seedqty-001` in `public.schema_version`,
   and the four `chk_inventory_seed_*` constraints present. If a database was branched or reset in
   between, re-apply `0a` there FIRST.
2. **Promote normally.** `deploy-lambda` is a 26-function matrix and an explicit predecessor of the
   SPA deploy job, so the Lambda (which owns the new `/seed-measure` route) cannot land after the
   client that calls it. Keep the Lambda and client changes in ONE dev SHA — an SPA-only follow-up
   promote would ship a caller against whatever Lambda is already live.
3. **Verify prod is actually serving the new code** before step 4. Probe the deployed bundle for a
   string unique to this feature rather than trusting the SHA — `seed_count` and `seed-measure` are
   the obvious needles. A tokenless API probe cannot substitute: it 401s whether or not the route
   exists, so it cannot distinguish the two.
4. **THEN apply `0b` to prod and staging.** It backfills the six rows whose `quantity_on_hand` holds
   a seed count and arms the pairing CHECK. It is idempotent (its predicate stops matching once it
   has run) and it self-guards: it raises if `0a`'s receipt is absent, and sweeps the full table
   before `VALIDATE` so a violating row fails loudly rather than during the validate scan.
5. **Re-run the gates** for this directory against both databases. `post_backfill_conservation` and
   `post_pairing_check_validated` are `continuous: false` and are RED between steps 2 and 4 **by
   design** — that is the window, not a fault.

## Rollback

- After step 4: `0r2-rollback-phase2.sql` first (restores `quantity_on_hand` from `seed_count`,
  disarms the pairing CHECK), THEN `0r1-rollback-phase1.sql` if the schema must go too.
- `0r1` DROPs the columns, which destroys every value in them — run `0r2` first, always.
- `0r1` DROPs and recreates `v_sow_candidates` (replace cannot remove columns) and re-`GRANT`s
  SELECT to `garden_ro`, which `DROP` does not preserve.
- `0r2` has a stated limit: once the writing release has created new lots, it cannot distinguish a
  backfilled row from a new one at `quantity_on_hand=1`. In that window, restrict it to the six ids
  recorded in `0b`'s header.

## The six backfilled rows (prod, measured 2026-09-04)

| id | name | before | after |
|---|---|---|---|
| `69832d29` | 1884 — saved 2026 | 185.000 packet | 1 packet + seed_count 185 |
| `181627da` | Sugar Baby — saved 2026 | 175.000 packet | 1 packet + seed_count 175 |
| `099cfba0` | Ukrainian Purple — saved 2026 | 121.000 packet | 1 packet + seed_count 121 |
| `2d6df841` | Green Flesh Honeydew | 100.000 each | 1 each + seed_count 100 |
| `0bd5f450` | Marshmallow | 15.000 each | 1 each + seed_count 15 |
| `8fc07941` | Alaska Mix Nasturtium | 10.000 each | 1 each + seed_count 10 |

`unit` is deliberately not rewritten — the bug is a count wearing a container unit, not the choice of
container, and "1 each" is odd but not false.

**NOT in the backfill:** `74ae4058` Pinto Beans (Quincy), `unit='oz' quantity_on_hand=1.000`. That is
one ounce of seed — a weight correctly expressed in vocabulary that predates this migration. Moving
it into `seed_weight_g` while `oz` remains a legal unit would create the two-encodings problem this
migration exists to avoid. Recorded, not silently skipped.

**Nothing backfilled from `metadata.seeds_per_packet`** — 39 of its 85 non-null prod values are the
literal `1`. See ledger `OPS-SEEDSPERPACKET-001`.
