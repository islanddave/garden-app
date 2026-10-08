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

The counting window opens at `COUNT_FROM_SHA`, a constant in the script:
`788e8b17c528e6288a108f54823cf81d3ab7c113`, the first dev SHA whose `ci-next.yml` unit legs run vitest's `node`
project (the A3 trial). Every push before it prints as BEFORE-WINDOW and is in no tally, including every row that
counted and the two that were EXEMPT under the window it replaces (from `1564c5647f`). Any later change to what a
`ci-next.yml` leg runs moves the constant to that change's pushed head SHA, in a commit after it; the header of
`.github/workflows/ci-next.yml` lists what counts as such a change.

Two equal digests are TEST-IDS-EQUAL only when the notices also show that the shadow ran the node project and
`ci.yml` did not: `node_files` above 0 on the leg and exactly 0 on `ci.yml`. Equal digests without that are
TEST-IDS-VACUOUS, and the row says which it is: the shadow's `node_files` is 0 or missing (the key did nothing, so
both sides ran jsdom-everything), `ci.yml`'s is above 0 (both sides switched), or `ci.yml`'s is missing. VACUOUS
blocks on a green row and on a row red on both sides alike; no skipped step exempts it. Digests that differ are
TEST-IDS-DIFFER whatever `node_files` reads.

A SHA red on both sides is agreement only when both went red at the same step, which the script reads from the job
steps of the attempt it judges: `ci.yml` failed exactly one step, a `ci-next.yml` leg failed that step, and no leg
is red at a step `ci.yml` ran and passed. Each SHA with a verdict on both sides is then worth one of three things:

- **QUALIFIES**: one of the 10. Green on both sides, or red on both at the same step, with TEST-IDS-EQUAL in both
  passes.
- **EXEMPT**: not one of the 10 and not blocking. Red on both sides at the same step, and `ci.yml` stopped before a
  unit pass, so that pass printed no digest there (its step reads `skipped`) while the shadow ran it or skipped it
  too. The row prints what that rests on: the failed step, the pass never run, the leg that failed the same step
  and the shadow's own digests.

  `ci-next.yml` cancels in progress, so a red push followed quickly by its fix leaves the legs that were still
  running `cancelled`. Such a leg holds no verdict and, on a SHA red on both sides only, is left out of the
  same-step check, and its cancelled pass step reads as a skipped one. It has to be all of: concluded `cancelled`,
  no failed step, not cancelled at its timeout, and a newer `ci-next.yml` push run created before it ended. A leg
  that failed the same step is still required, and a SHA judged with a leg left out is EXEMPT at best, never one of
  the 10; its line names the legs and the run that cancelled them.
- **BLOCKS**: a DISAGREE; red on both sides where the failing step cannot be read (a job with no steps, a shadow
  run with no leg) or is read and differs; a TEST-IDS-DIFFER; a TEST-IDS-VACUOUS; a digest absent for any other reason (the pass ran
  and left no usable notice, the shadow lacks what the serial job has, the format versions differ). The row prints
  why.

The last line is `ACCEPTANCE: MET` or `NOT MET` with each thing still missing: at least 10 SHAs that qualify, none
that blocks, queue threshold not tripped. It names every exempt SHA, and a MET line ends with what it does not
cover: manifest conservation, the 10-green soak and the canary are not read here. Every SHA from the start of the
counting window is read and tallied whatever `--limit` is; `--limit` only cuts the rows printed. That line is
separate from the exit code: exit 0 = nothing disagrees, 1 = a DISAGREE or a TEST-IDS-DIFFER among the SHAs inside
the window, 2 = a reply could not be read (or a listing changed between its two reads) and nothing is concluded.
How a cancelled run is read, and why that cannot hide a disagreement, is in the docstring at the top of the script.

`--json` (`schema_version` 2) carries the same reading. Per SHA: `counted` (a verdict on both sides, inside the
window), `acceptance` (`QUALIFIES`, `EXEMPT`, `BLOCKS`, or null when not counted) and `acceptance_why`; the facts
they rest on, `ci_failed_steps`, `ci_ran_steps`, `next_legs`, `next_red_legs`, `next_superseded_legs` (each leg the
next push cancelled, with `superseded_by`, that run's id); and per pass in `test_ids`, `ci_step` and `next_step`, the conclusion of the step that runs the pass on each side, and `ci_node_files` and `next_node_files`, each side's
`node_files` (a number, or null when that side has no usable notice or its notice has no such count). A pass's
`class` is `EQUAL`, `DIFFER`, `VACUOUS` or `ABSENT`, and `summary.test_ids` counts each. `schema_version` stayed 2
when `VACUOUS` and the two `node_files` fields were added: no field that was there changed what it means. `acceptance` holds `met`, `missing`,
`counted`, `qualifying` (the number set against the 10), `counted_red` (qualifying SHAs red on both sides), `exempt`
(SHAs) and `blocking` (`sha` and `why`). `summary.window_met` is `qualifying >= 10`.
Tested in `scripts/test_shadow_agree.py` against the replies recorded under `scripts/fixtures/shadow-agree/`.

`vitest-test-ids-reporter.mjs` is where the test-ID digests come from. On a GitHub Actions runner (and nowhere
else: `vitest.config.ts` adds it under `GITHUB_ACTIONS`) every vitest run ends with one notice,
`test-ids <zone>: sha256=... files_sha256=... names_sha256=... tests=... passed=... failed=... skipped=...
files=... node_files=... v=2`.
`sha256` is that of the sorted `file :: full test name :: state` list; the other two are of the file list alone and
of the names without their states. `node_files` is how many of the files ran in vitest's `node` project (the A3
trial, `.github/workflows/ci-next.yml`): above 0 in ci-next's unit legs, 0 in ci.yml's passes. It cannot fail a run. The list itself is not stored anywhere: two runs can be
told apart, and how they differ, but not which test. Tested in `vitest-test-ids-reporter.test.js`, which also asks
the installed vitest for its default reporters and holds `vitest.config.ts` to restating exactly those.

`vitest-node-project.mjs` says which test files that `node` project runs: the `*.test.*` files under `lambda/`,
`scripts/`, `migrations/` and `tests/parity/` that load nothing under `src/`. `vitest.config.ts` builds both
projects from its `nodeProjectFiles()`. `LOADS_SRC` in it is the sorted list of test files under those roots that
do load SPA code and so stay in the `dom` project. `vitest-projects.test.js` holds the list to the tree in both
directions: it follows the imports of every node-project file and fails, with the chain, when one reaches `src/`
and is not listed; and it fails when a listed file no longer does. When it asks for a file to be added, add the
path to `LOADS_SRC` in sorted order.

`coverage-rows.py SERIAL_LOG SHADOW_LOG` is the A3 trial's coverage comparison. Neither workflow uploads a coverage
artefact, so it reads the coverage table out of two unit-pass job logs of one commit
(`gh api repos/islanddave/garden-app/actions/jobs/<job id>/logs`, or a local `npm test` log) and compares every
directory row but `All files` and `lambda/daily-plan` on % Funcs and % Lines. Exit 0 `COVERAGE-SAME`, 1
`COVERAGE-DIFFERS` with the rows, 2 `COVERAGE-UNREADABLE`. Tested in `scripts/test_coverage_rows.py` against the
table of a real job log under `scripts/fixtures/coverage-rows/`.

`a3-exit.sh OUT_DIR` makes the A3 trial's two exit checks at the current checkout, the ones its header in
`.github/workflows/ci-next.yml` says are to be made again at the last counted SHA. It runs the node project's
files under jsdom (with the repo setup file) and under node through `a3-exit.config.mjs`, a vitest config of its own
that imports `vitest.config.ts` for everything outside the environment and changes nothing about `npm test`; it
leaves out `vitest-projects.test.js`, whose guard fails by design outside the trial's own two shapes. `a3-exit.py e1
JSDOM.jsonl NODE.jsonl` (E1, assertion parity) compares, test by test, the state and the number of `expect`
assertions that `a3-exit-count.mjs` and `a3-exit-recorder.mjs` wrote: `E1-SAME` or `E1-DIFFER`. A test that asserts
only through `node:assert` reads 0 on both sides. `a3-exit.py e2 JSDOM_A JSDOM_B NODE_A NODE_B --setup-loads
CONTROL` (E2, loaded-module coverage parity) reads four `coverage-final.json`, two per environment because v8 does
not count every file the same twice, and counts a statement, function or branch arm as a difference only when both
runs of each environment agree on it and the environments do not: `E2-SAME` or `E2-DIFFER (n stable differences in m
files)`. Items are matched by source extent, then by kind and start line (`extent-only`, printed, not counted); a
covered item or file that only one environment has counts, except a jsdom-only file the control run
(`a3-exit.control.mjs`) shows the setup file loading. Both exit 0 / 1, and 2 when an input is missing or empty. Seven
vitest runs, no network, output outside the checkout. Tested in `scripts/test_a3_exit.py`.
