# ci-telemetry

How long CI, staging and promote runs take, from GitHub's own run data. Two commands; both only read.

```sh
# 1. Fetch runs, jobs and steps for a date range (UTC days, inclusive) into a directory OUTSIDE the repo.
python3 scripts/ci-telemetry/collect.py --since 2026-09-18 --until 2026-10-02 --out ~/ci-telemetry/20261002 --logs 3

# 2. Print the tables as markdown.
python3 scripts/ci-telemetry/report.py --in ~/ci-telemetry/20261002 > baseline.md
```

`collect.py` needs an authenticated `gh` on PATH and makes `gh api -X GET` calls only: one run listing per day
plus one job listing per completed run (about 500 calls for two weeks). Job files are cached, so running the
same command again fetches only what is missing. It exits 1 and lists the problems in `meta.json` if any listing
could not be read or looks truncated; `report.py` then prints **INCOMPLETE DATA** at the top. `--logs N` also
downloads the job logs of the N newest successful ci.yml dev pushes, which is what the silent-tail table is
measured from.

`report.py` reads that directory and nothing else. It prints:

- **ci.yml per dev push**: median and p90 wall, the 10 newest successful runs, success / failure / cancelled,
  re-runs, first-push-green rate, time to first red, queue time, the same by week, and ci.yml by trigger.
- **ci.yml per-step medians**, over successful first-attempt dev pushes.
- **promote-gate.yml** and **deploy-staging.yml**: wall, and the split by job (span and runner-seconds).
- **Runner-minutes by workflow**, with the minutes spent on cancelled runs, failed runs and superseded attempts,
  and any run with a job queued more than 300 s.
- **Per workflow, by week**: median, p90 and outcome counts.
- **Silent tails**, when logs were collected: per step, the time between its last output line and the next step.

What each figure means (which attempt a "wall" covers, what counts as an executed job, how a first attempt is
read after a re-run) is defined once, in the docstring at the top of `report.py`. Compare two reports only when
they were produced by the same definitions.

The pure functions are tested in `scripts/test_ci_telemetry.py`.

## `preflight-dual.py` — is the name-based promote check safe to remove yet?

promote-gate's preflight decides "CI green on dev_sha" twice and prints each pair as a `preflight-dual` notice.
`python3 scripts/ci-telemetry/preflight-dual.py` reads those notices off every promote-gate run attempt since the
dual preflight landed (2026-10-03) and answers the one question push 2 of the promote-path plan waits on. Exit 0 =
READY (at least 5 promotes on record, no line where the name-based check refused and the run-based check passed,
every record readable); 1 = NOT READY, with the reason; 2 = GitHub unreadable. Read-only. The rules are in its
docstring; `scripts/test_preflight_dual.py` holds them, and takes the notice text from the real step.

## The shadow's acceptance instruments

`ci-next.yml` runs `ci.yml`'s serial job as parallel legs and replaces it only after agreeing with it over at least
10 dev pushes. Two files here measure that; neither changes what CI gates on.

```sh
python3 scripts/ci-telemetry/shadow-agree.py          # one row per dev push since ci-next.yml landed
python3 scripts/ci-telemetry/shadow-agree.py --json
```

`shadow-agree.py` needs an authenticated `gh` and makes `gh api -X GET` calls only (each of two listings read
twice, then up to five calls per SHA, two more for a run that was re-run). Per SHA it sets `ci.yml`'s
`build-and-test` verdict against `ci-next.yml`'s `build-and-test-next`: AGREE-GREEN, AGREE-RED, DISAGREE or
NOT-COUNTED. A run that was re-run is judged on its FIRST attempt, and the row says what the latest one did. It
compares the test-ID digest of each unit pass and, when two differ, says whether it is the file set, the test names
or only the states. It prints the `runs-on` labels of each side, and lists each `ci-next.yml` job's wait for a
runner against the plan's threshold (a job over 120 s in 3 of 10 runs).

The last line is `ACCEPTANCE: MET` or `NOT MET` with each thing still missing: at least 10 SHAs counted, no
DISAGREE, no TEST-IDS-DIFFER, TEST-IDS-EQUAL in both passes on every counted SHA, queue threshold not tripped. That
line is separate from the exit code: exit 0 = nothing disagrees, 1 = a DISAGREE or a TEST-IDS-DIFFER among the
counted SHAs, 2 = a reply could not be read (or a listing changed between its two reads) and nothing is concluded.
How a cancelled run is read, and why that cannot hide a disagreement, is in the docstring at the top of the script.
Tested in `scripts/test_shadow_agree.py` against the replies recorded under `scripts/fixtures/shadow-agree/`.

`vitest-test-ids-reporter.mjs` is where the test-ID digests come from. On a GitHub Actions runner (and nowhere
else: `vitest.config.ts` adds it under `GITHUB_ACTIONS`) every vitest run ends with one notice,
`test-ids <zone>: sha256=... files_sha256=... names_sha256=... tests=... passed=... failed=... skipped=... v=2`.
`sha256` is that of the sorted `file :: full test name :: state` list; the other two are of the file list alone and
of the names without their states. It cannot fail a run. The list itself is not stored anywhere: two runs can be
told apart, and how they differ, but not which test. Tested in `vitest-test-ids-reporter.test.js`, which also asks
the installed vitest for its default reporters and holds `vitest.config.ts` to restating exactly those.
