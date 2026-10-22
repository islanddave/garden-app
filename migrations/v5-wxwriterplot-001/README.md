# v5-wxwriterplot-001: the cold-range job may name its plot

Ledger **V5-SPACEPLOTTIER-001**, multi-space plan V204 step **3.2c** ("Dave OK (prod role + off-repo code): W3 grant
gains `plot_id` on staging, then prod; then `wn3_send.py` sends `PLOT_ID` (and `SPACE_ID`) from its config by key
name; `wx-writer-role.py` probes updated; revert floor"; plan of record
`project-state/_multispace-20261015/multispace-prep-plan-V204-20261019.0900.md` §2.2, §3.0, row 3.2c). Stamp
**`5.3.14-wxwriterplot-001`**, written by `0a-writer-plot-grant.sql` in the same transaction as the grant (named for
the expected next release, v5.3.14; rename it here, in `1a-writer-role.sql`'s W3b, in
`v5-wxplotnotnull-001/0b-weather-cold-range.sql` and its gates if the release differs). Class: **prod role +
off-repo code**, Dave's first-hand OK for prod.

| File | What |
|---|---|
| `0a-writer-plot-grant.sql` | `GRANT INSERT (plot_id) ON public.weather_cold_range TO garden_wx_writer`, the stamp; step 0 refuses unless the role holds exactly 1a's seven (or, re-applied, the eight); an assertion that it then holds exactly the eight |
| `0r-rollback.sql` | revokes it and deletes the stamp; refuses while `weather_cold_range.plot_id` is NOT NULL (3.2d) |
| `gates.yml` | 3 pre gates (one is the role's starting state), 2 post gates self-armed on the stamp |
| `rehearse_local.py` | the local PostgreSQL 17 rehearsal (below) |

Also changed for this step: `migrations/v5-wxcoldband-001/1a-writer-role.sql` (**W3b**), `scripts/wx-writer-role.py`
(`reassert`, `grant`, `ungrant`, the plot probe), `scripts/revert-floors.json`, and, staged and not live,
`project-state/_multispace-20261015/lanes-p2/3.2c-wn3_send.patch` (the job). Not applied to staging or prod.

## Why a new file AND a line in 1a

`1a` is the role's one re-runnable definition: it revokes every privilege the role holds in `public` and grants the
seven again, so it converges. A `plot_id` grant made anywhere else would be **revoked by the next run of 1a** (a
restore, `wx-writer-role.py apply`'s password rotation, the by-hand path), and the switched job would then be
refused (42501) every night with a blank card, which looks like a sleeping Mac. So:

- **this directory** is the additive, stamped step the sitting applies and the gates arm on (1a has no stamp by
  design, and its own pre-conditions are 3.2a-era);
- **1a's W3b** grants and asserts `plot_id` as an eighth column *only while this step's stamp exists*. Without the
  stamp 1a behaves exactly as before (rehearsed: a `plot_id` granted by hand without the stamp is revoked; with it,
  kept; the stamp deleted, revoked again). A restore keeps `schema_version`'s rows, so re-running 1a after a restore
  re-grants it.

No password rotation is needed anywhere in this step: `grant` and `reassert` never touch it.

## The job's Space and plot: by key name, written by the owner

The job (`project-state/tools/wn3_send.py`, off-repo, launchd `com.davenichols.claude.wn3-send`, `--env prod
--if-due` hourly) has no SELECT, so it cannot look its plot up. `wx-writer-role.py grant`, running as the owner,
reads **the one `public.spaces` row and that Space's live default plot** (`plots WHERE workspace_id = … AND
is_default AND deleted_at IS NULL`; it refuses unless there is exactly one of each) and writes them into
`.env.local` as `WX_WRITER_SPACE_ID_<ENV>` and `WX_WRITER_PLOT_ID_<ENV>`, beside the job's URL line. No person
copies a UUID, and no UUID is written in the job or the script (N12; tested). The database checks the pair: a plot
of another Space is 23503 (`weather_cold_range_plot_id_space_id_fkey`).

The patched job (`3.2c-wn3_send.patch`, made against `wn3_send.py` sha256 `2164d0a3…228e2e` and `test_wn3_send.py`
`e5d143c0…db5e56`): the `SPACE_ID` literal is gone; `job_ids()` reads the two keys by name, and a missing key or a
non-uuid value stops with exit **2 USAGE** before any gcloud pull; the INSERT names eight columns (`space_id,
plot_id, night_date, …`), still a bare `ON CONFLICT DO NOTHING`; `--dry-run` needs the keys too and prints the row
it would send. Its tests: 36 passed on a scratch copy with the patch applied (26 before; the new tests fail 12 of 36
against the unpatched job).

## Staging (read 2026-10-21, read-only)

`garden_wx_writer` exists on staging (LOGIN, NOINHERIT, limit 2, USAGE on `public`, a member of nothing) but holds
**no INSERT on any column** of `weather_cold_range` (no `relacl`, no `attacl`). Prod holds exactly the seven. The
plot grant alone would leave staging's job refused, so the staging sitting re-runs 1a first (`reassert`), which is
also what makes the staging control meaningful: before the grant the job's eight-column INSERT is refused for
`plot_id` alone. `pre_writer_holds_exactly_1a_seven` is red on staging until then. Cause not established (a table
re-create after 1a, or a `--no-privileges` restore, both do it). If the staging writer URL no longer logs in,
`apply --env staging` instead (a rotation is harmless there: nothing runs the job against staging on a schedule).

## Sitting (exact order; every command from the main checkout with `.env.local`)

**S0. Before either sitting:** this directory, 1a's W3b, `wx-writer-role.py`, `revert-floors.json` reach main by
the v5.3.14 promote. No existing gate is edited for this step (C-CONV below), so there is no tolerant gate to wait
for; the latest gate-invariants run is green.

**S1. Staging.**
1. `python3 scripts/wx-writer-role.py verify --env staging` — today: FAIL on the identity line (no INSERT at all).
2. `python3 scripts/gate_runner.py --migration migrations/v5-wxwriterplot-001 --env staging --phase pre` — today:
   `pre_writer_holds_exactly_1a_seven` red, the rest PASS.
3. `python3 scripts/wx-writer-role.py reassert --env staging` — 1a, no new password; every probe PASS and the line
   `INSERT naming plot_id … : denied (42501)`: **the control's "fails before"**.
4. The pre gates again: all PASS.
5. `python3 scripts/wx-writer-role.py grant --env staging` — the grant, the two staging keys, the probes with
   `INSERT naming plot_id … is allowed`: **the control's "succeeds after"**. (The job's exact statement, end to
   end: a scratch copy of the job with the patch applied, `--env staging --night <tonight>`, sends one row; it is
   what the rehearsal ran through the job's own `send()`.)
6. `python3 scripts/gate_runner.py --migration migrations/v5-wxwriterplot-001 --env staging --phase post`: PASS.

**S2. Prod (Dave's first-hand OK).** Any time of day: the grant is one transaction and the deployed job's
seven-column INSERT is unaffected by it (rehearsed).
1. `python3 scripts/wx-writer-role.py verify --env prod --i-have-daves-ok` — identity PASS; the plot line
   `denied (42501)` (the "before").
2. `python3 scripts/gate_runner.py --migration migrations/v5-wxwriterplot-001 --env prod --phase pre`: all PASS
   (read 2026-10-21).
3. `python3 scripts/wx-writer-role.py grant --env prod --i-have-daves-ok` — the plot line `is allowed`;
   `WX_WRITER_SPACE_ID_PROD` / `WX_WRITER_PLOT_ID_PROD` written.
4. The post gates on prod: PASS.

**S3. The job switch, only after S1 and S2 are both green** (off-repo; launchd is not touched: the next hourly tick
runs the new text).
1. From the Gardening root: `git apply --check project-state/_multispace-20261015/lanes-p2/3.2c-wn3_send.patch`,
   then `git apply` it.
2. `python3 -m pytest -q project-state/tools/test_wn3_send.py` — 36 passed.
3. `python3 project-state/tools/wn3_send.py --env prod --dry-run` — the row shows the prod Space and plot.
4. The next night: the job's log says `sent`, and the newest `weather_cold_range` row carries `plot_id` (read-only;
   it is 3.2d's pre gate `pre_newest_cold_range_row_carries_plot_id`).

**Rollback, in reverse:** `git apply -R` the patch (the job names seven columns again); then
`wx-writer-role.py ungrant --env prod --i-have-daves-ok` and `--env staging` (refused while 3.2d's 0b is applied:
roll that back first). A full teardown of the role is this directory's 0r, then 1a's `1r` (`rollback` verb).

## C-CONV pre-scan (V204 §2.8, §3.0)

Every `migrations/*/gates.yml` at the base (`3c081fa4`) searched for `garden_wx_writer`, `has_column_privilege`,
`has_table_privilege`, `attacl`, `relacl`, `column_privileges`, `table_privileges` and `role_column_grants`: one
hit, `v4-cal1-indep-001/gates.yml:70` (the ACL of the view `cultivar_weight_derived`, unrelated), so **no gate pins
the writer's privileges** (`v5-wxcoldband-001/gates.yml` says so in its header: "The WRITER's grant is not asserted
either"). The gates that
pin `weather_cold_range`'s column set (`post_no_column_outside_the_eight`, already tolerant for `plot_id` since 3.2a;
`post_columns_have_these_shapes`; `post_only_created_at_has_a_default`) read columns, not grants, and this step
adds no column. **Expected newly red: {}**, and that is what the rehearsal measured on the whole corpus, prod and
staging. Nothing here needs a tolerant edit or a promote ahead of the sitting. No (c) gate file is touched.

## Revert floor

`scripts/revert-floors.json` gains `{floor: v5.3.14, since: v5.3.14}`: once the job names `plot_id`, code below
v5.3.14 carries a 1a without W3b that strips the grant on any re-run, and the job is not reverted with the code.
(3.2d's `{floor: v5.3.13, since: v5.3.14}` sits beside it.) `scripts/test_revert_floors.py` refuses a target below
each floor (red against the old file, green with the entries).

## Rehearsal

```
python3 migrations/v5-wxwriterplot-001/rehearse_local.py --port <port> --base-db <prod-shaped db> \
  --wn3-send <scratch copy of wn3_send.py with the patch applied>
```

On a local PostgreSQL 17.10 loaded with prod's schema-only dump (owned by a NOSUPERUSER CREATEROLE role) and a
read-only copy of prod's spaces, plots, weather rows and stamps: **39/39 PASS**. The staging control through the
patched job's own `send()` as `garden_wx_writer` over TCP: before the grant **exit 5, SQLSTATE 42501**; after it **1
row, on Plot 1**, the same night again 0. The deployed seven-column INSERT is written before and after. C-CONV:
newly red {} and newly green {} on both envs, 0 ERROR. The new gates each red on a planted defect. **1a as it was
before this step**, re-run after the grant, exits 0 and strips `plot_id` (the floor's reason); this tree's 1a puts it
back. Staging's shape (no grant): the pre gate and 0a refuse, `reassert` restores the seven, 0a applies. The script
end to end: `verify`, `grant` (keys = the one Space and Plot 1), `verify`, `reassert` (password line untouched),
`ungrant`, `grant`; a second Space makes `grant` refuse and write no key. 0r refuses while `plot_id` is NOT NULL,
then applies; re-applies are idempotent. `migrations/v5-wxcoldband-001/rehearse_writer_role.py` (W3b): 78/78.
