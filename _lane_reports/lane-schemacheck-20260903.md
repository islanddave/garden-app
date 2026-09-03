# OPS-SCHEMACHECKAPT-001 — remove the ship-time Postgres client fetch

Lane: `lane-schemacheck-20260903`, worktree `schemacheck-20260903`, base `origin/dev@c68b940`.
Scope: `.github/workflows/` and scripts those workflows call. No push, no dispatch — commit only.

## 1. Census — every site that fetches a Postgres client at run time

Searched all 20 files in `.github/workflows/` for `apt-get|apt install|psql|pg_dump|pg_restore|pg-client|libpq|postgres|actions/cache`, then narrowed to files with real install steps (`ACCC4CF8` pgdg-key-fetch count, and separately `apt-get install.*postgres`/`apt-get install.*psql`). `integration-test.yml` matched the broad grep but only in comments/name (no install step) — not a site.

**6 sites still fetching a client at gate time (before this change), all `postgresql-client-17` from the PGDG apt repo, one apt-get install step per file:**

| File | Line (pre-edit) | Job | Tool needed | On critical path |
|---|---|---|---|---|
| `.github/workflows/backup.yml` | 17–32 | `backup` | `pg_dump`/`pg_dumpall` | Daily backup, not a gate, but the backup itself fails if this hangs |
| `.github/workflows/revert-gate.yml` | 95–102 | `revert` | `pg_restore`+`psql` (via `scripts/revert-to.py`) | **Real prod incident revert** |
| `.github/workflows/promote-gate.yml` | 425–432 | `promote` | `pg_dump` (via `scripts/snap.py`) | **Real ship path** — runs *after* the fast-forward of `main`, i.e. exactly the step that hung 46 min on 2026-08-18 |
| `.github/workflows/snap-rehearsal.yml` | 47–54 | `rehearse` | `pg_dump` (via `scripts/snap.py`) | Rehearsal of the promote-gate snap leg |
| `.github/workflows/restore-verify.yml` | 126–136 | `verify` (matrix) | `pg_restore` | Daily backup-restorability proof |
| `.github/workflows/revert-rehearsal.yml` | 103–110 | `rehearse` | `pg_restore`+`psql` (via `scripts/revert-to.py`) | Rehearsal of the incident-revert path |

Confirmed via `scripts/revert-to.py` (subprocess calls to `psql` and `pg_restore --clean --if-exists --no-owner`) that the revert path genuinely needs the full client, not just `psql` — it can't take the psql-only shortcut deploy-staging.yml and harvest-weight-ratchet.yml used.

**Already fixed — 3 sites in 2 files, landed 2026-08-20 (commits `9e20274`, `2afe2f9`, both pre-existing on `dev`, both before this lane started):**

- `.github/workflows/deploy-staging.yml` — two sites: the `db-schema-check` job (~line 687) and the "L-058 smoke-residue sweep" job (~line 802). Both removed their apt-get install entirely.
- `.github/workflows/harvest-weight-ratchet.yml` — one site (~line 53). Removed its plain `apt-get install postgresql-client` entirely.

**Pattern that already landed:** these three jobs only ever call `psql` (never `pg_dump`/`pg_restore`), and `psql` — unlike `pg_dump`/`pg_restore` — has no major-version-match requirement against the server. So the fix there was pure removal: delete the apt-get step, rely on the runner's own `psql` (16.14 on ubuntu-24.04 / 18.4 on ubuntu-26.04), no replacement mechanism needed. That pattern does **not** transfer to the 6 remaining sites — every one of them calls `pg_dump` and/or `pg_restore`, which do enforce a strict major-version match (proven 2026-05-05: pg16 client refused a pg17 server dump), and the runners never ship pg17.

**Reconciling against the ledger's counts:**
- **"2 of 8 workflows landed"** — matches exactly. 8 distinct workflow *files* ever carried an install site (the 6 above + deploy-staging.yml + harvest-weight-ratchet.yml); 2 of those files (deploy-staging.yml, harvest-weight-ratchet.yml) are fully landed.
- **"7 sites not 3"** — does **not** match under any site-counting convention I could construct. Total sites (fixed + unfixed, counting deploy-staging.yml's two jobs separately) = 9 (6 open + 3 landed). If deploy-staging.yml is counted as one site instead of two, total = 8, still not 7. I also chased a red herring: `neon-restore.yml` had a `postgresql-client-17` install step in history, but it's an unrelated one-day-lived DB-migration utility added and removed entirely on 2026-04-28 — months before OPS-SCHEMACHECKAPT-001 existed — so it isn't part of this count. I could not reconstruct a "7" from the current or historical state with confidence; flagging this rather than forcing a match, per instructions. The **6 open / 8 total files** figures are the ones I'd trust.

## 2. The pg_dump-17 constraint — options weighed

GitHub-hosted `ubuntu-24.04`/`ubuntu-26.04` runners ship PostgreSQL 16.15/18.x client tools on PATH (confirmed against `actions/runner-images`' own Ubuntu 24.04 readme — no pg17 anywhere in the default image). `pg_dump`/`pg_restore` refuse to operate against a newer-major-version server, so none of the 6 sites can take the "just use what's already there" shortcut.

- **Container image (chosen, see below).**
- **`actions/cache` alone, no image fallback.** Rejected as the *sole* mechanism — a cold cache (first run, or 7+ days of total inactivity across every site sharing the key) has to come from *somewhere*, and "nothing" isn't an option. This is exactly the "fallback is fetch-from-the-internet, SPOF hidden not removed" trap the brief warns about, if the fallback source is unexamined.
- **Vendored static binary.** Rejected. The Debian/Ubuntu `postgresql-client-17` build is dynamically linked (libpq, OpenSSL, LDAP, GSSAPI, zlib/zstd/lz4, ICU, …); a byte-copy of the binary without vendoring every shared-library dependency at matching ABI versions is not portable across runner-image bumps, and building a genuinely static binary is a real build-pipeline project, not something to improvise inside this scoped lane. Also would mean committing a multi-binary artifact into a shared repo other lanes are actively working in.
- **Job-level `container: postgres:17`.** Rejected. It would run the *entire* job inside the image, not just the DB steps — these jobs also run `aws-actions/configure-aws-credentials`, `pip install boto3/requests`, and `python3 scripts/*.py`, none of which the bare `postgres` image ships (no Python, no AWS tooling). Containerizing the whole job either means installing those too (replacing one apt fetch with another, larger one, inside a foreign image) or a much bigger, harder-to-review change to how OIDC/AWS auth and Python execution work in six gating jobs. Higher blast radius for no benefit over the narrower option below.

**Chosen: extract the client binaries from the official `postgres:17` Docker image via a throwaway, never-started `docker create` + `docker cp`, fronted by `actions/cache`.**

- `docker create postgres:17` materializes the image's filesystem without ever running `docker-entrypoint.sh`/starting a server (no `POSTGRES_PASSWORD` needed, no side effects).
- `docker cp <cid>:/usr/lib/postgresql/17/bin/. /usr/lib/postgresql/17/bin/` copies out `pg_dump`/`pg_restore`/`psql`/`pg_dumpall` matching the exact major version, onto the exact same PATH location (`/usr/lib/postgresql/17/bin`) the old PGDG install used — so every existing downstream `export PATH="/usr/lib/postgresql/17/bin:$PATH"` line in these files (there are several, in later steps of each job) needed **zero edits**.
- `actions/cache@v6.1.0` (SHA `55cc8345863c7cc4c66a329aec7e433d2d1c52a9` — resolved live against the GitHub API, not guessed) fronts the whole thing under a single static key (`pg17-client-postgres17-image-v1`) shared across all 6 sites. Restores at step start; its own post-job hook auto-saves the result under the same key, but **only if the job succeeds** (`post-if: success()`), so a failed fetch never poisons the cache with a partial extraction.

**Why not treat this as "just moved the fetch to Docker Hub"?** It substantively is a different, more defensible risk than before:
1. **In the common case there is no external fetch at all.** `backup.yml` and `restore-verify.yml` both run on a **daily schedule** and share this cache key, so in practice the key almost never goes cold — most runs across all 6 sites hit GitHub's own cache backend, not any third-party mirror.
2. **On a genuine cache miss, the fallback is Docker Hub's official `postgres` image, not PGDG.** I checked, rather than assumed, whether GitHub pre-caches this image on hosted runners — it does **not** (confirmed against the current `actions/runner-images` Ubuntu 24.04 readme; no "cached Docker images" section lists it), so a miss is a real network pull, not a free local hit. I'm reporting that plainly rather than overstating it.
3. That Docker Hub pull is not a *new* dependency for this pipeline — `restore-verify.yml` already pulls this exact image unconditionally, every day, as a `services:` container, with no incident reported. This reuses an already-relied-upon, larger, more redundant piece of infrastructure instead of introducing a second one.
4. `restore-verify.yml` specifically now gets the client from the *same* image its `services:` block already needs — one image dependency instead of two.

**Honest bottom line on the cache-miss path:** it is still "fetch from the internet," just from Docker Hub rather than apt.postgresql.org. I did not achieve a zero-network-dependency fix — I judged that unattainable within this scoped lane without either a much larger container-image redesign (rejected above) or an unvendorable static-binary project (rejected above). What changed is the *reliability profile* of that fallback (empirically-proven-in-this-repo, large-scale CDN vs. a single third-party apt mirror) and, in the common case, removing the need to hit it at all.

## 3. What changed — same 4-step pattern at all 6 sites

1. `Make /usr/lib/postgresql/17 writable` — `sudo mkdir -p` + `sudo chown` so the non-root steps that follow (cache restore, docker cp) can write into a normally root-owned path. Does not touch `/usr/lib/postgresql/16` (the runner's stock client), only creates the `17` subtree.
2. `pg17 client cache` (`actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0`) — restore attempt, `id: pg17-cache`.
3. `Fetch pg17 client from the postgres:17 image (cache miss only)` — `if: steps.pg17-cache.outputs.cache-hit != 'true'`; the `docker create`/`docker cp`/`docker rm` sequence.
4. `Verify pg17 client` — explicit-path `pg_dump --version` (or `pg_restore --version` in `restore-verify.yml`, matching what that file originally checked), unconditional, so a broken extraction fails loudly right here instead of much later inside `scripts/snap.py`/`revert-to.py`/`restore-verify.py`.

Also fixed a now-stale comment in `restore-verify.yml` ("matches Neon (PG 17) and the PGDG pg17 client below") that referenced the removed PGDG step.

No script changes were needed (`scripts/snap.py`, `scripts/revert-to.py`, `scripts/restore-verify.py` all invoke bare `pg_dump`/`pg_restore`/`psql` via PATH — that resolution is unaffected by *how* the binary got onto PATH).

Considered and rejected a `.github/actions/` composite action to de-duplicate the 4-step block — this repo has no existing composite-action directory or usage anywhere in `.github/workflows/`, and the original PGDG-era code was itself structured as repeated near-identical blocks per file. Introducing a new repo convention as a side effect of a SPOF-removal fix, while 7 other lanes are concurrently active, seemed like unnecessary scope/risk; repetition matches the file's own established idiom.

## 4. Validator output (both required, per L-053) — every touched file

PyYAML `yaml.safe_load` and `yamllint -d relaxed`, run after every edit and again as a final pass:

```
backup.yml           :: PyYAML=OK :: yamllint_exit=0 :: error_lines=0
revert-gate.yml       :: PyYAML=OK :: yamllint_exit=0 :: error_lines=0
promote-gate.yml      :: PyYAML=OK :: yamllint_exit=0 :: error_lines=0
snap-rehearsal.yml    :: PyYAML=OK :: yamllint_exit=0 :: error_lines=0
restore-verify.yml    :: PyYAML=OK :: yamllint_exit=0 :: error_lines=0
revert-rehearsal.yml  :: PyYAML=OK :: yamllint_exit=0 :: error_lines=0
```

`yamllint -d relaxed` reports only pre-existing `line-length` (>80 char) warnings — advisory tier, not errors, and endemic to this codebase's already heavily-narrative comment style (present before my edits, e.g. `backup.yml`'s original comment block was already over 80 chars per line). No new warning categories introduced by my changes (checked: zero non-line-length warnings across all 6 files).

A final repo-wide sweep (`grep -rn 'apt-get install.*postgres\|apt-get install.*psql\|ACCC4CF8' .github/workflows/*.yml`) after all edits returns nothing — no live apt-based Postgres client fetch remains anywhere in `.github/workflows/`.

## 5. What I deliberately left alone, and why

- **`promote-gate.yml`'s step order (fast-forward `main` *before* the pg17-client/snap step).** This is the exact ordering that turned a 46-minute apt hang into a stranded `main` on 2026-08-18. Removing the apt fetch (this fix) makes that step overwhelmingly less likely to hang — but the *ordering hazard itself* (main can still move before the snap step runs, for any reason a step might fail: transient Docker Hub outage, GH cache-service hiccup, `scripts/snap.py` bug) is unchanged and out of scope for "remove the network fetch." I flagged it inline in `promote-gate.yml`'s new comment and am flagging it here explicitly: reordering "Fast-forward main" to run *after* a successful snap, instead of before, would close this residual gap, but it's a job-flow change I wasn't asked to make and didn't want to improvise without understanding why the current author sequenced it this way (possible reasons I didn't rule out: `deploy-lambdas`/`deploy` needing `main` moved early, or output-availability constraints from the `resolve` job). Recommend a follow-up ticket.
- **`deploy-staging.yml` and `harvest-weight-ratchet.yml`** — already landed (see §1), untouched, confirmed their comments don't reference anything my changes made stale.
- **`neon-restore.yml`** — doesn't exist (deleted 2026-04-28, unrelated migration utility). Not a site.
- Nothing was left *broken* or *blocked* — all 6 open sites got the same fix.

## 6. Unverified — what would prove this actually works

Per instructions, I did not push, dispatch, or run any workflow. Everything above is static verification (YAML structure via two parsers, `docker`/`actions/cache` semantics confirmed by reading the pinned action's real `action.yml` from GitHub — not assumed — and cross-checked `postgres:17`'s client-binary layout matches the path both the old code and Neon/restore-verify.yml already assumed). Unverified at runtime:
- That `docker create postgres:17` actually succeeds on a live GH-hosted runner today (network conditions, Docker Hub anonymous-pull limits from the runner's shared IP pool).
- That the extracted binaries run correctly (no missing shared library under `ubuntu-24.04`/`26.04` that the runner's own libc/openssl doesn't provide — the official `postgres` image is Debian-based like the runner, but not bit-identical).
- That `actions/cache` hit/miss and the post-job auto-save behave as documented across a real multi-run sequence (first run = miss + save, second run = hit).
- The exact wording GH's own workflow-file parser accepts vs. PyYAML (L-053's specific hazard is inline `run:` with quoted colons, which I avoided by using block-scalar `run: |` throughout, but GH's parser is still the only ground truth for GH-Actions-specific YAML semantics like `if:` expression syntax).

Recommended verification: a `workflow_dispatch` of `snap-rehearsal.yml` (lowest-blast-radius of the 6 — staging-pointed, no prod writes) against this branch once it's reachable, watching for (a) a genuine cache miss + successful docker-cp on the first run, (b) a cache hit + skip on a second run. That's Dave's call, not mine, per the "do not dispatch anything" instruction.
