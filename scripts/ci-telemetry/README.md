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
measured from: one log per job, so thirteen a run since plan A4, nine since the switch (plan A2.3) and one before it.

`report.py` reads that directory and nothing else. It prints:

- **ci.yml per dev push**: median and p90 wall, the 10 newest successful runs, success / failure / cancelled,
  re-runs, first-push-green rate, time to first red, queue time, the same by week, and ci.yml by trigger.
- **ci.yml per-step medians**, over successful first-attempt dev pushes, one row per (job, step) and one sum per
  job. Since the switch a run is eight legs and the aggregator `build-and-test`, and since plan A4 twelve: a setup
  step that every leg repeats has a row per leg, the serial job of before the switch keeps its own rows under
  `build-and-test`, and the aggregator's are under `build-and-test (aggregator)`. The legs run side by side, so a
  run's work time is its slowest leg's sum, not the total, except that the merge leg `unit-utc-cov` starts only when
  the three coverage shards have finished: that path is the slowest shard plus the merge. A report made before this
  change pooled by step name alone: do not set its step table against one made after.
- **promote-gate.yml** and **deploy-staging.yml**: wall, and the split by job (span and runner-seconds).
- **Runner-minutes by workflow**, with the minutes spent on cancelled runs, failed runs and superseded attempts,
  and any run with a job queued more than 300 s.
- **Per workflow, by week**: median, p90 and outcome counts.
- **Silent tails**, when logs were collected: per step, the time between its last output line and the next step,
  one table per job log, headed by the file and the job's name.

The aggregator runs under `always()` and reads `failure` when a leg failed and when a leg was cancelled. Where a
job beside it did not succeed, the report leaves it out of "time to first red" and of the first-attempt reading, so
a red leg is one red and a superseded first attempt reads cancelled. With every leg green it is read as any job.

What each figure means (which attempt a "wall" covers, what counts as an executed job, how a first attempt is
read after a re-run) is defined once, in the docstring at the top of `report.py`. Compare two reports only when
they were produced by the same definitions.

The pure functions are tested in `scripts/test_ci_telemetry.py`.

## The vitest helpers

`vitest-test-ids-reporter.mjs` prints the test-ids notice. On a GitHub Actions runner (and nowhere else:
`vitest.config.ts` adds it under `GITHUB_ACTIONS`) every vitest run ends with one notice,
`test-ids <zone>: sha256=... files_sha256=... names_sha256=... tests=... passed=... failed=... skipped=...
files=... node_files=... v=2`.
`sha256` is that of the sorted `file :: full test name :: state` list; the other two are of the file list alone and
of the names without their states. `node_files` is how many of the files ran in vitest's `node` project. ci.yml's
coverage merge holds `files_sha256` and `files` of the merged UTC run to `vitest list --filesOnly`, and reds with no
notice. The reporter cannot fail a run. Tested in `vitest-test-ids-reporter.test.js`, which also asks the installed
vitest for its default reporters and holds `vitest.config.ts` to restating exactly those.

`vitest-node-project.mjs` says which test files that `node` project runs: the `*.test.*` files under `lambda/`,
`scripts/`, `migrations/` and `tests/parity/` that load nothing under `src/`. `vitest.config.ts` builds both
projects from its `nodeProjectFiles()`. `LOADS_SRC` in it is the sorted list of test files under those roots that
do load SPA code and so stay in the `dom` project. `vitest-projects.test.js` holds the list to the tree in both
directions: it follows the imports of every node-project file and fails, with the chain, when one reaches `src/`
and is not listed; and it fails when a listed file no longer does. When it asks for a file to be added, add the
path to `LOADS_SRC` in sorted order.

`vitest-side-config.mjs` is what the configs that build on `vitest.config.ts` use (`vitest.stress.config.ts` and the
three flag-off configs): vitest does not hand `--dir` to a project, and a `setupFiles` beside `projects` loads in the
`node` project too. `vitest-side-configs.test.js` holds each `test:flag-off*` script to the files the unit run
collects under the same filters, and the stress config to its setup file in the jsdom project only.

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
`@vitest/coverage-v8` themselves; with `vitest.config.ts`'s two projects every worker evaluates this module too and
gets the stock module's own three functions from it.

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
To take the provider out, take out the module, its test and `scripts/fixtures/coverage-two-forms/` together with
`provider: 'v8'` in `vitest.config.ts`. Putting `provider: 'v8'` back in `vitest.config.ts` alone does not recover:
this module's own test holds the config to it and fails in the same unit step. And if a coverage threshold or `coverage-ratchet.json`'s `active_target` has since been raised above what the
stock provider reads (branches read about one point lower on it), the revert fails the measured floor.

Re-read the header on any vitest or `@vitest/coverage-v8` upgrade (the test pins the version, so an upgrade is one
deliberate edit), and when the fixture run goes red after a vite or `@vitejs/plugin-react` upgrade or on another
Node. To see what the stock provider makes of the same fixture, and whether an upgrade has fixed it upstream:
`D=$(mktemp -d) && npx vitest run --config scripts/fixtures/coverage-two-forms/vitest.config.mjs --coverage
--coverage.provider=v8 --coverage.reportsDirectory="$D"` (the directory is named so that the run does not replace
`./coverage`; the cases pass either way; read `$D/coverage-final.json`, where stock gives `byNode` 0 hits for 3
calls and reads `notCalled` of `only-node.js`, which nothing calls, as entered).
