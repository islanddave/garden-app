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

## `preflight-dual.py` — was the name-based promote check safe to remove?

From 2026-10-03 until push 2 of the promote-path plan, promote-gate's preflight decided "CI green on dev_sha" twice
and printed each pair as a `preflight-dual` notice. `python3 scripts/ci-telemetry/preflight-dual.py` reads those
notices off every promote-gate run attempt since the dual preflight landed and answers the one question push 2
waited on. Exit 0 = READY (at least 5 promotes on record, no line where the name-based check refused and the
run-based check passed, every record readable); 1 = NOT READY, with the reason; 2 = GitHub unreadable. Read-only.

Push 2 removed the name-based check; the step now prints one `preflight-run-based` notice per check. From the first
promote-gate attempt that ran that step (told by the step's name) the script exits 3 and its last line starts
`CLOSED: name-based check removed at run ...`: neither READY nor NOT READY, with the dual record before it given as
history and each later attempt's run-based lines listed. The rules are in its docstring;
`scripts/test_preflight_dual.py` holds them, and takes the step name and the notice text from the real step.

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
`234efd21b3a57f705a4d0d15b76f184fdf31b348`, the dev push after which `vitest.config.ts` carries the two-forms
coverage provider and the 80 floor (before it: `788e8b17c5`, the first whose unit legs run vitest's `node` project
in its final shape, the A3 trial). Every push before it prints as BEFORE-WINDOW and is in no tally, including every row that
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
table of a real job log under `scripts/fixtures/coverage-rows/`. The two rows were left out because the stock
provider did not read `lambda/daily-plan` the same way twice; with `coverage-v8-two-forms.mjs` (next) it does, so
that reason is gone. They are still left out: the script does what it did, and putting them back in (its `EXCLUDED`,
with the pin in the test) is the trial owner's call.

`coverage-v8-two-forms.mjs` is the unit run's coverage provider (`vitest.config.ts`, `coverage.customProviderModule`):
the installed `@vitest/coverage-v8` provider, subclassed, with one thing changed. A module under `lambda/daily-plan/`
reaches V8 in two forms under one URL, vite's text of it in a test file that imports it and the file's own text
wherever `handler.js` or a `createRequire` loads it, and the stock provider converts both against vite's text at one
start offset, taken from whichever per-test-file result it read last. One tree therefore read `engine.js` as 1,214
or 1,257 covered items by draw where 1,325 were covered (the 59 test files that load it), and `handler.js` `run()` as
never entered (BUG-ENGINECOVERAGETWOREADINGS-001). A module only Node loads was misread too, the same way every
time, and not always downwards: `rainLog.js` read 103 covered items in those files where this module reads 94 (93 by
the review's hand count). The module converts each form against the text it was compiled from and merges the two
item for item. It changes no test. Its worker side is the stock one: with one project the workers load
`@vitest/coverage-v8` themselves; with the A3 trial's env key set every worker evaluates this module too and gets
the stock module's own three functions from it.

It fails the run (an `ERROR: coverage-v8-two-forms:` line and exit 1, like a missed threshold, and one `::error`
annotation on a runner) in two cases. One: a file loaded both ways whose two conversions are not one list, item for
item, in order and each over the other's own place in the file; what Node ran of that file is then left out of the
report. That check is a filter, not a proof. Of lists made wrong in the thirteen real pairs it refuses every item
exchanged for one elsewhere (8,652; the order alone, which was the rule before OPS-COVPROVIDERMAPADOPT-001, took
8,164 of them), 83.5% of one-item shifts in the case kindest to them (1.3% before; 87.2% against 2.0% by the seeded
script the earlier figures came from) and all but five of 8,446 two-item shifts. Those one-item shifts are an upper
bound on what is open, not the exposure: 1,026 of the 1,405 still taken are statement lists that hold one extent
twice, which the converter never emits. It still takes an item exchanged for another that lies over its own place
(one that starts after the start of the item before it and before its own end, so before the item as well as
inside it), and one item under its neighbour's number where one of the two lies inside the other: the comment above
`whyNotSameItems` says why each cannot be closed without refusing correct files, and which two tighter ties were
measured and not taken.

It also refuses two kinds of correct file, loudly (the ERROR line and exit 1, never a wrong count), and no file
loaded both ways is of either kind today. New with OPS-COVPROVIDERMAPADOPT-001: an ES module with an item that ends
in a call of an imported binding (`const { a } = useThing()`), which vite's text ends a column short. The places
were measured on CommonJS modules only. 34 files under `coverage.include` have the shape (`src/hooks` 21,
`src/components` 9, `src/lib` 4) and none is loaded both ways: `lambda/daily-plan` is the only CommonJS directory,
and the first test to load one of the 34 with `createRequire` reds the unit step. The test file pins that refusal
as a known limit. As before that change: a class with a valued field after a method or with a function-valued
field before another valued one, and a destructuring or parameter default that is a function
(`{ now = () => Date.now() } = ctx`, as in `lambda/harvests/season-stats.js:150`). The comment above
`whyNotSameItems` has both under WHAT IT REFUSES THAT IS RIGHT. The test file holds each of those shapes, and three
of the wrong pairs still taken, to what the rule does today, on lists the converter gave in a real run of
`scripts/fixtures/coverage-two-forms/limits` (its `known limit` rows): a change to the rule that moves one reds its
row.

Two: any hit count below zero. That
second check is a tripwire for one symptom of a gross misreading (ranges read against the wrong text, or a
wrapper's length off). It does not show that a conversion is right: in review, every Node script read one character
off gave 16 more covered items on 59 test files and no negative count. So never read "0 negative counts" as proof
of the figures. What holds
the figures is `coverage-v8-two-forms.test.js`: it asks the installed package for its version and for each member
the module leans on (its header lists them), and it runs `scripts/fixtures/coverage-two-forms/` (one module loaded
through vite, by Node, and both ways in one worker; one a worker leaves half loaded; one only vite loads; one only
Node loads) through a real `vitest run --coverage`, as one project and as two, and holds every hit count to the
calls the cases make.

When that ERROR appears on a commit that did not touch the module: the file it names has changed in a way the two
conversions disagree on, or vite, `@vitejs/plugin-react` or Node has. Read the reason in the line, then the header.
If the item it names is one of the two correct kinds above, the file is right and the rule is short: that is the
rule owner's decision, not a pair that has come apart.
To take the provider out, revert the whole commit that brought it in. The A3 exit tooling landed in the commit after
it and names the module (`a3-exit.config.mjs`, and a test that holds that config to it), so revert that commit
first: the two revert cleanly in that order, and the exit tooling can land again with `provider: 'v8'`. Putting
`provider: 'v8'` back in `vitest.config.ts` alone does not recover: this module's own test holds the config to it
and fails in the same unit step. And if a coverage threshold or `coverage-ratchet.json`'s `active_target` has since been raised above what the
stock provider reads (branches read about one point lower on it), the revert fails the measured floor.

Re-read the header on any vitest or `@vitest/coverage-v8` upgrade (the test pins the version, so an upgrade is one
deliberate edit), and when the fixture run goes red after a vite or `@vitejs/plugin-react` upgrade or on another
Node. To see what the stock provider makes of the same fixture, and whether an upgrade has fixed it upstream:
`D=$(mktemp -d) && npx vitest run --config scripts/fixtures/coverage-two-forms/vitest.config.mjs --coverage
--coverage.provider=v8 --coverage.reportsDirectory="$D"` (the directory is named so that the run does not replace
`./coverage`; the cases pass either way; read `$D/coverage-final.json`, where stock gives `byNode` 0 hits for 3
calls and reads `notCalled` of `only-node.js`, which nothing calls, as entered).

What the first gating run had to show, for the record: when the provider landed, CI's Node with the one-project
shape (ci.yml's `build-and-test`) was the one combination it had run on nowhere (local runs were Node 26 in both
shapes, the shadow legs Node 20.19.0 with two projects). That job's first run on dev is its acceptance: `Run unit
tests with coverage` green with a `Coverage report from v8` table and no `ERROR: coverage-v8-two-forms:` line, and
`Coverage ratchet — measured floor` green, read by head SHA.

Those four cannot see a wrong reading in that one combination: the thresholds sit 9 to 18 points under the figures,
the ERROR line needs a refused file or a count below zero, and `coverage-rows.py` leaves out exactly `All files` and
`lambda/daily-plan`. So the
acceptance has a fifth part, made by command and not by eye: every `lambda/**` row of `build-and-test`'s table
equals the same row of ci-next's `unit-utc-cov` for the same head SHA. Take each job's raw log, where every line
starts with its timestamp (`gh api repos/OWNER/REPO/actions/jobs/JOB_ID/logs > LOG`; `gh run view --log` puts the
job and step names first and the command below then prints nothing), cut the rows out of each, and `diff` the two
outputs. No line may differ (bash, zsh or ksh: `$'…'` is not POSIX, and under `dash` the command prints nothing and
exits 1):

```bash
rows() { sed -E $'s/^[0-9T:.Z-]+ //; s/\x1b\\[[0-9;]*m//g' "$1" | awk '/^-+\|/{p=0} /^ [^ ]/{p=($1 ~ /^lambda/)} p'; }
rows BUILD-AND-TEST.log > a.rows && rows UNIT-UTC-COV.log > b.rows && test -s a.rows && diff a.rows b.rows && echo LAMBDA-ROWS-SAME
```

`test -s` is there because two empty outputs are equal too. No rows from a log (exit 1 in silence, or every row of
the other printed as a deletion) means that job's unit step wrote no table, which is what a failed test leaves: no
reading, not a difference, so run the job again. To find the table in a raw log search for `Coverage report from`;
colour codes sit between that and `v8`. Reference, ci-next run 37843185895 on `20097a1b`: 36
rows; `lambda/daily-plan` 91.93, 88.76, 90.51, 92.81; `engine.js` 98.76, 95.21, 100, 100; `handler.js` 97.53, 94.97,
100, 99.12; `rainLog.js` 92.72, 91.37, 87.5, 92.68. `All files` is not among the rows and may differ in the second
decimal between two runs of one tree (`src/` files whose tests move with timing). The same holds for the first
gating run of any later change to the module.

`a3-exit.sh OUT_DIR` makes the A3 trial's two exit checks at the current checkout, the ones its header in
`.github/workflows/ci-next.yml` says are to be made again at the last counted SHA. Its last line is the result:
`A3-EXIT-PASS (…)` and exit 0, or `A3-EXIT-FAIL (e1=…, e2=…, red=…, node=…, tree=…)` and exit 1. It refuses (exit 2)
a Node other than the one `.nvmrc` names and a tree with uncommitted paths; `A3_EXIT_ANY_NODE=1` and
`A3_EXIT_ANY_TREE=1` run it anyway and the result is then never a pass. It runs the node project's files under jsdom
(with the repo setup file) and under node through `a3-exit.config.mjs`, a vitest config of its own that imports
`vitest.config.ts` for everything outside the environment (what it carries and leaves behind is listed in
`a3-exit-carry.mjs`, and an unlisted key stops it) and changes nothing about `npm test`; it leaves out
`vitest-projects.test.js`, whose guard fails by design outside the trial's own two shapes.

`a3-exit.py e1 JSDOM.jsonl NODE.jsonl` (E1, assertion parity) compares, test by test, the state and the number of
`expect` assertions that `a3-exit-count.mjs` and `a3-exit-recorder.mjs` wrote: `E1-SAME` or `E1-DIFFER`. A test that
asserts only through `node:assert` reads 0 on both sides. A side whose counter did not run (a test that ran with no
count, or 0 assertions in all) is `E1-UNREADABLE`; two sides not shown to be two environments (each test line says
whether its file had a `document`) are `E1-VACUOUS`.

`a3-exit.py e2 JSDOM_A JSDOM_B NODE_A NODE_B --setup-loads CONTROL --root DIR` (E2, loaded-module coverage parity)
reads four `coverage-final.json`. Two per environment, because one tree can give one file two whole readings:
`lambda/daily-plan/engine.js` came back with 1,214 or 1,257 of its 1,374 items covered in both environments, each
reading the same in jsdom and node hit for hit (ledger row `BUG-ENGINECOVERAGETWOREADINGS-001`). That was the stock
coverage provider. `a3-exit.config.mjs` now reads coverage through `coverage-v8-two-forms.mjs`, as the unit run
does, and in the one run made since (Node 26) the four files held `engine.js` hit for hit the same; the two runs
per environment and the rule for readings are kept, and are what would show it if that stopped. A file whose two
runs agree inside each environment is compared item by item (statement, function, branch arm; matched by source
extent, then by kind and start line: `extent-only`, printed, not counted). A file whose runs disagree is compared
reading to reading: `same under a shared reading` when one jsdom run and one node run agree item for item, `not
compared` when none do. Limit: when both runs of each environment give one reading and the environments' readings
are not the same one, that reads `E2-DIFFER`; four files cannot tell it from code that ran differently. Printed and
not counted: `generated import glue` (the line-1 statements vite's client transform makes of `import { a } from
'node:x'`, only when there are exactly as many as the source has such bindings), `hit count differs, covered-ness the
same`, and an uncovered item only one map holds. A covered item or file that only one environment has counts, except
what the control run (`a3-exit.control.mjs`) shows the setup file covering in a module it loads; the control's files
also have to be in both jsdom runs and in neither node run, or the verdict is `E2-VACUOUS`. Last line `E2-SAME`,
`E2-DIFFER (n differences in m files; k items in f files not compared)` or, with no difference and anything not
compared, `E2-INCONCLUSIVE (k items in f files not compared)`.

`a3-exit.py` exits 0 / 1, 2 when an input is missing, empty or not the reporter's shape (never a traceback) and 3
for `E2-INCONCLUSIVE`. Seven vitest runs, no network, output outside the checkout. Tested in
`scripts/test_a3_exit.py` (the comparers, on built inputs and on real output cut into `scripts/fixtures/a3-exit/`),
`scripts/test_a3_exit_sh.py` (the wrapper, against a stand-in vitest) and `a3-exit-fixture.test.js` (the counter,
the recorder and the config, by running `a3-exit.fixture.mjs` in both environments).
