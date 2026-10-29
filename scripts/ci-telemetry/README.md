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
