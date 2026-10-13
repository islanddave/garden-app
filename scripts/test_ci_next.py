"""ci.yml's parallel legs and its aggregator `build-and-test`, held to their shape; and ci-next.yml, the canary and
soak copy of those legs, held to ci.yml.

Run: python3 -m pytest -q scripts/test_ci_next.py

ci.yml is the GATING workflow: eight legs behind one aggregator job whose id, `build-and-test`, is what
promote-gate.yml reads (through scripts/promote-preflight.py). ci-next.yml holds the same legs with one canary step
on top of each, and an aggregator `build-and-test-next`; it runs on the soak branch and on a canary dispatch, never
on a dev push, and gates nothing. Until the switch (plan A2.3) ci.yml was one serial job and ci-next.yml its shadow,
and this file compared the serial job's steps with the legs. This file runs in ci.yml's own `pytest` leg, so
everything below is a GATING test. A lane that adds, edits or removes a CI step changes it in both files in the same
commit (and regenerates scripts/ci-step-manifest.json), or this reds the dev push.

Eight things are held, each by a function that returns the problems it found (so the mutations at the end can show
every one of them is able to fail). All but `mirror` are asked of EACH file on its own, so ci.yml is held to its
shape whatever ci-next.yml says:

  mirror        ci-next.yml's jobs are ci.yml's: the same ids in the same order, each leg the same WHOLE mapping
                (runs-on, timeout, and every step's name, run, env, uses, with and any other key, in the same
                order) once ci-next.yml's canary step is left out, and the aggregator the same once its id is. A
                canary or a soak run of a copy that had drifted would say nothing about the gating file.
  once          a check runs in one leg: no step other than the five repeatable setup steps (checkout, setup-node,
                npm ci, Chrome resolve, the origin/main fetch) is in a file's legs twice.
  trial         the two unit steps carry env VITEST_NODE_PROJECT: '1', so vitest runs the server-side test files
                in its `node` project and the rest under jsdom (vitest.config.ts). That key, that value, on those
                two steps of each file; nowhere else in either (an env at any level, or the key written into a
                run: body). It is the gating shape; removing the key is a later commit.
  own_steps     the steps the legs carry that the serial job did not: the PyYAML install and the TZ sentinel, by
                body and by place; and the canary, one per leg, first, keyed to its leg, in ci-next.yml ONLY. No
                ci.yml step carries an `if:` or reads the inputs context.
  setup         each leg has what the serial job handed its steps implicitly: checkout first; node 20.19.0 and
                node_modules for steps that run node (and neither for pytest); CHROME_PATH for the real-Chrome
                gates; origin/main for the release-version guard; PyYAML for gate_runner.py; and the two artefact
                chains kept whole and in order (dist/, coverage/coverage-summary.json).
  shape         triggers, permissions, concurrency and the job graph. ci.yml: push to dev and pull_request to the
                three protected branches and NOTHING else (no workflow_dispatch: a forced-red canary at dev's head
                could not be re-run green and would leave that commit unpromotable), its concurrency group, and
                the aggregator under the id the promote reads. ci-next.yml: push to ci-next-soak only (not dev),
                the one dispatch input, and no job id the promote reads. Both: no continue-on-error, no `if:`,
                needs, matrix, name or env on a leg, ubuntu-24.04 and a timeout everywhere, no workflow-level env
                or defaults, and an aggregator that needs every other job, runs `always()`, and pins the same list
                in its one step.
  handoffs      a step that hands something on through the runner (an action, a GITHUB_ENV or GITHUB_PATH write, an
                apt-get / pip / npm -g install) is named in HANDOFFS with the legs that need it. A new one is red
                until it is repeated where it is consumed and listed. Hand-offs through FILES are not visible
                here beyond the two chains under `setup`.
  concurrency   no two workflow files share a concurrency group. Groups are repository-wide: a copy that shared
                ci.yml's would cancel it.

What this file no longer holds, and where the duty went. While ci.yml was one serial job its step list was the
reference: `conservation` held every serial step to exactly one leg and `order` held each leg to the serial order.
There is no serial list now. That a step is not dropped, edited, reordered or moved between legs of ci.yml is held
by scripts/ci-step-manifest.json (scripts/test_ci_step_manifest.py), which records every job of ci.yml step for
step; `mirror` and `once` hold the rest. The trial's one admitted difference between the two files is gone with
the serial job (both files carry the key), and so is the test that bounded it.

Then the bodies the legs introduced are executed the way GitHub's runner executes them: `bash -e` on a FILE holding
the body (as scripts/test_workflow_steps.py does; never `bash -c`). Each file's aggregator runs against `needs`
fixtures: a leg that failed, was cancelled (which is how a timed-out leg reads) or was skipped, a leg missing from
`needs`, a job nobody pinned, and a context that is not JSON must each end it non-zero.
"""
import collections
import copy
import glob
import json
import os
import re
import shutil
import stat
import subprocess

import pytest
import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
WORKFLOWS = os.path.join(HERE, "..", ".github", "workflows")
RUNNER_SHELL = ["bash", "-e"]
CI, NEXT = "ci.yml", "ci-next.yml"
FILES = (CI, NEXT)
GATE = "build-and-test"                                   # ci.yml's aggregator: the job promote-gate.yml reads
AGGREGATORS = {CI: GATE, NEXT: "build-and-test-next"}
# TRIAL-ONLY (lane-ubuntu26-20261013, not for merge): ci-next.yml runs on the trial image while ci.yml stays put.
# The real move sets both to the new label, or drops this map for the one literal it replaced.
RUNNER = {CI: "ubuntu-24.04", NEXT: "ubuntu-26.04"}
LEGS = ("static", "pytest", "unit-utc-cov", "unit-ny", "gates-a", "gates-b", "gates-c", "gate-probes")
GATE_LEGS = ("gates-a", "gates-b", "gates-c", "gate-probes")
RESERVED_JOB_IDS = {"build-and-test", "integration-tests", "smoke-tests"}  # what promote-gate.yml reads by name
CI_ON = {"push": {"branches": ["dev"]}, "pull_request": {"branches": ["dev", "staging", "main"]}}
CI_CONCURRENCY = {"group": "ci-${{ github.ref }}", "cancel-in-progress": True}
NEXT_PUSH = {"branches": ["ci-next-soak"]}
NO_DISPATCH = ("ci.yml must never gain workflow_dispatch (or any trigger beyond push to dev and pull_request to dev, "
               "staging and main). scripts/promote-preflight.py counts a dispatched run on any branch at the SHA, and "
               "a forced-red canary cannot be re-run green, so one canary at dev's head would leave that commit "
               "unpromotable. The canary and the soak trigger live in .github/workflows/ci-next.yml. A change to "
               "ci.yml's triggers is a regression-reviewed change: widen CI_ON in scripts/test_ci_next.py with it")
CANARY = "Canary — force this leg red (workflow_dispatch input canary_red_leg only)"
PYYAML = "Install PyYAML for the migration gate validation"
SENTINEL = "TZ sentinel — America/New_York resolves on this runner"
# THE TRIAL KEY. The two unit steps of each file carry this env key at this value. vitest.config.ts reads it and
# runs the test files that need no DOM in a `node` project. It began as the A3 trial, on ci-next.yml's legs only,
# compared by test ID with the serial job's jsdom-everything; the owner declared the trial's exit and made the
# two-project shape the gating one (2026-10-11), so the switch carried the key into ci.yml with the legs. `trial`
# holds that it is on both unit steps of each file and nowhere else. When the projects become unconditional and the
# key leaves the steps (a later commit, with vitest.config.ts), all of this goes with it.
TRIAL_KEY, TRIAL_VALUE = "VITEST_NODE_PROJECT", "1"
TRIAL_STEPS = {"unit-utc-cov": "Run unit tests with coverage",
               "unit-ny": "Unit tests under America/New_York TZ (date-fragility guard)"}
UNIT_PASS = re.compile(r"(?:npm test|npx vitest run)\b")  # matched at the start of a step's run
TRIAL_RULE = ("env %s: '%s' (a quoted string) is on the two unit steps of ci.yml and of ci-next.yml, %r in "
              "unit-utc-cov and %r in unit-ny, and nowhere else in either file. With it vitest runs two projects "
              "(node and dom), which is the gating shape; a unit step without it runs jsdom-everything, a different "
              "suite shape from the one that was soaked. Taking the key out everywhere is its own commit"
              % (TRIAL_KEY, TRIAL_VALUE, TRIAL_STEPS["unit-utc-cov"], TRIAL_STEPS["unit-ny"]))
# Every tracked file that names the key. `trial` reads the two workflow files; the key set anywhere else (the `test`
# script of package.json is the short way) would switch other runs of the suite with nothing in a workflow changing.
TRIAL_KEY_FILES = [".github/workflows/ci-next.yml", ".github/workflows/ci.yml", "scripts/ci-step-manifest.json",
                   "scripts/ci-telemetry/vitest-projects.test.js", "scripts/ci-telemetry/vitest-side-configs.test.js",
                   "scripts/test_ci_next.py", "vitest.config.ts"]
REPEATABLE = ("checkout", "setup-node", "npm-ci", "chrome", "fetch-main")
NODE_PIN = {"node-version": "20.19.0", "cache": "npm"}
DRY_RUN = "npm install --dry-run --package-lock-only"
NODE_COMMAND = re.compile(r"(?:^|[\s;&|(])(?:npm|npx|node)\s")
NODE_BY_NAME = {"Dependency audit (blocking on moderate, WS-B M6)"}  # audit-gate.py shells out to `npm audit`
PIP_PYYAML = re.compile(r"pip install[^\n|&]*\bpyyaml\b")
NY = "America/New_York"
WORKFLOW_KEYS = {"name", "on", "permissions", "concurrency", "jobs"}
LEG_KEYS = {"runs-on", "timeout-minutes", "steps"}
# A step that hands something to LATER steps through the runner rather than through a file. Only the leg that holds
# the step has it. Each one is named here (an action by its name without the pin) with the legs that need what it
# hands on.
HANDOFF = re.compile(r"GITHUB_ENV|GITHUB_PATH|\bapt-get\b|\bapt\s+install\b|\bpip3?\s+install\b"
                     r"|\bnpm\s+(?:i|install)\b[^\n;&|]*\s(?:-g|--global)\b")
HANDOFFS = {
    "actions/checkout": "the working tree: repeated in every leg",
    "actions/setup-node": "node 20.19.0 on PATH: repeated in every leg that runs node (all but pytest)",
    "Python script tests (pytest)": "pip installs pytest, requests, boto3, pyyaml: the pytest leg runs this step and "
                                    "nothing else needs them",
    PYYAML: "pip installs pyyaml for gate_runner.py: static, the only leg that runs it",
    "Resolve Chrome for the layout gates": "writes CHROME_PATH to GITHUB_ENV: repeated in gates-a, gates-b, gates-c "
                                           "and gate-probes",
    "Photo-tier payload budget (BUG-TIERLESSPHOTOS-001)": "pip installs pillow for its own gate only: gates-a",
}
NEW_HANDOFF = ("ci.yml step %r hands something to later steps through the runner (it uses an action, writes GITHUB_ENV "
               "or GITHUB_PATH, or installs with apt-get, pip or npm -g). Only the leg holding the step has it. A new "
               "hand-off must be repeated in every leg that consumes it (in ci.yml and in ci-next.yml), then added to "
               "HANDOFFS in scripts/test_ci_next.py with the legs that need it")
# The three bodies the legs add, as written in the workflows. Changing one means changing it here in the same commit, which
# is the point: what they do is executed further down, and this holds that they do nothing else. (It is also the only
# hold on the sentinel's offset comparison: no real node reports the zone's name and then keeps another zone's
# offsets, so no fixture reaches that half of its condition.)
CANARY_RUN = ('echo "::error title=ci-next canary::canary_red_leg=%s: this leg is forced red on request, and '
              'build-and-test-next must go red with it."\nexit 1\n')
PYYAML_RUN = ("set -euo pipefail\npython3 -m pip install --quiet pyyaml \\\n"
              "  || python3 -m pip install --quiet --break-system-packages pyyaml\n")
SENTINEL_RUN = "\n".join([
    "set -euo pipefail",
    "node -e '",
    "const zone = Intl.DateTimeFormat().resolvedOptions().timeZone",
    "const jan = new Date(2026, 0, 15, 12).getTimezoneOffset()",
    "const jul = new Date(2026, 6, 15, 12).getTimezoneOffset()",
    "console.log(`TZ=${process.env.TZ} resolved as ${zone}; minutes behind UTC: January ${jan}, July ${jul}`)",
    'if (process.env.TZ !== "America/New_York" || zone !== "America/New_York" || jan !== 300 || jul !== 240) {',
    '  console.log("::error title=TZ sentinel::America/New_York did not resolve (want zone America/New_York, January '
    '300, July 240). The suite below would run in another zone and prove nothing about date fragility.")',
    "  process.exit(1)",
    "}",
    "'",
    "",
])
INPUTS_CONTEXT = re.compile(r"\binputs\.|\binputs\[|github\.event\.inputs")
# Files one step writes and a later step reads. Each chain stays in one leg, in this order.
CHAINS = {
    "dist/": (lambda s: s.get("run") == "npm run build", lambda s: "test -f dist/index.html" in s.get("run", ""),
              lambda s: "verify-window-chunk.sh" in s.get("run", "")),
    "coverage/coverage-summary.json": (lambda s: s.get("run") == "npm test",
                                       lambda s: "check-coverage-ratchet.py --measured" in s.get("run", "")),
}


def _load(name):
    with open(os.path.join(WORKFLOWS, name), encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def _both():
    return _load(CI), _load(NEXT)


def _pair(ci, nxt):
    return ((CI, ci), (NEXT, nxt))


def _on(workflow):
    return workflow.get("on", workflow.get(True))  # PyYAML reads the bare key `on` as True


def _keys(workflow):
    return {"on" if key is True else key for key in workflow}  # PyYAML reads the bare key `on` as True


def _legs(workflow, name):
    """Every job of the file `name` but its aggregator."""
    return {job_id: job for job_id, job in (workflow.get("jobs") or {}).items() if job_id != AGGREGATORS[name]}


def _all_steps(workflow, name):
    return [s for job in _legs(workflow, name).values() for s in job["steps"]]


def _label(step):
    return step.get("name") or step.get("uses") or "unnamed"


def _canon(step):
    return json.dumps(step, sort_keys=True, ensure_ascii=False)


def _kind(step):
    """Which repeatable setup step this is, or None."""
    uses = step.get("uses") or ""
    if uses.startswith("actions/checkout@"):
        return "checkout"
    if uses.startswith("actions/setup-node@"):
        return "setup-node"
    run = step.get("run") or ""
    if run == "npm ci --legacy-peer-deps":
        return "npm-ci"
    if 'echo "CHROME_PATH=$BIN" >> "$GITHUB_ENV"' in run:
        return "chrome"
    if run.startswith("git fetch ") and "refs/remotes/origin/main" in run:
        return "fetch-main"
    return None


def _mirrored(job):
    """A ci-next.yml leg's steps that must be ci.yml's: everything except the canary."""
    return [s for s in job["steps"] if s.get("name") != CANARY]


def _conserved(job):
    """A leg's steps that are not the canary or repeatable setup: the checks the leg exists to run."""
    return [s for s in _mirrored(job) if _kind(s) not in REPEATABLE]


def _uses_node(step):
    return bool(NODE_COMMAND.search(step.get("run") or "")) or step.get("name") in NODE_BY_NAME


def _chrome_gate(step):
    return "GATE_CHROME_FLAGS" in (step.get("env") or {})


def _has_key(node, key):
    if isinstance(node, dict):
        return key in node or any(_has_key(v, key) for v in node.values())
    return isinstance(node, list) and any(_has_key(v, key) for v in node)


# ── the two files against each other ────────────────────────────────────────────────────────────────────────────

def _above_steps(job):
    return {key: value for key, value in job.items() if key != "steps"}


def _as_ci_runner(job):
    """TRIAL-ONLY: a ci-next.yml job's keys above its steps, with the trial label read as ci.yml's."""
    above = _above_steps(job)
    return dict(above, **{"runs-on": RUNNER[CI]}) if above.get("runs-on") == RUNNER[NEXT] else above


def mirror(ci, nxt):
    out = []
    mine, theirs = list(ci.get("jobs") or {}), list(nxt.get("jobs") or {})
    if [AGGREGATORS[NEXT] if job_id == GATE else job_id for job_id in mine] != theirs:
        out.append("ci.yml's jobs are %s and ci-next.yml's are %s: want the same ids in the same order, but for the "
                   "aggregator (%s in ci.yml, %s in ci-next.yml)" % (mine, theirs, GATE, AGGREGATORS[NEXT]))
    copies = _legs(nxt, NEXT)
    for leg, job in _legs(ci, CI).items():
        if leg not in copies:
            continue
        if _above_steps(job) != _as_ci_runner(copies[leg]):  # TRIAL-ONLY: was _above_steps(copies[leg])
            out.append("leg %s: ci.yml has %s above its steps and ci-next.yml has %s"
                       % (leg, _canon(_above_steps(job)), _canon(_above_steps(copies[leg]))))
        want, have = [_canon(s) for s in job["steps"]], [_canon(s) for s in _mirrored(copies[leg])]
        if want == have:
            continue
        out += ["leg %s: ci.yml step %r is not in ci-next.yml's %s as written in ci.yml (name, run, env, uses, with "
                "or another key differs, or it is missing): make the same change there"
                % (leg, _label(json.loads(key)), leg) for key in want if key not in have]
        out += ["leg %s: ci-next.yml runs %r, which is not a step of ci.yml's %s as written there: the only step "
                "ci-next.yml adds is the canary" % (leg, _label(json.loads(key)), leg)
                for key in have if key not in want]
        if set(want) == set(have):
            out.append("leg %s: the two files run the same steps %s" % (leg, "in a different order" if sorted(
                want) == sorted(have) else "a different number of times"))
    gate, copy_ = (ci.get("jobs") or {}).get(GATE), (nxt.get("jobs") or {}).get(AGGREGATORS[NEXT])
    # TRIAL-ONLY: the second replace (the trial label read as ci.yml's)
    if gate is None or copy_ is None or _canon(gate) != _canon(copy_).replace(AGGREGATORS[NEXT], GATE).replace(
            RUNNER[NEXT], RUNNER[CI]):
        out.append("ci-next.yml's %s is not ci.yml's %s with the id changed (needs, if, runs-on, timeout and the one "
                   "step, whole)" % (AGGREGATORS[NEXT], GATE))
    return out


def once(ci, nxt):
    out = []
    for name, workflow in _pair(ci, nxt):
        seen = collections.Counter(_label(s) for job in _legs(workflow, name).values() for s in _conserved(job))
        out += ["%s: step %r is in its legs %d times, want once: a check runs in one leg (only checkout, setup-node, "
                "npm ci, the Chrome resolve and the origin/main fetch repeat)" % (name, label, count)
                for label, count in seen.items() if count != 1]
    return out


def trial(ci, nxt):
    out = []
    for name, workflow in _pair(ci, nxt):
        passes = [_label(s) for s in _all_steps(workflow, name) if UNIT_PASS.match(s.get("run") or "")]
        if passes != list(TRIAL_STEPS.values()):
            out.append("%s's unit passes (a run: that starts `npm test` or `npx vitest run`) are %s, and the key is "
                       "pinned to %s. A pass that is renamed, added or removed changes TRIAL_STEPS in "
                       "scripts/test_ci_next.py in the same commit (and PASS_STEPS in "
                       "scripts/ci-telemetry/shadow-agree.py, which reads each pass's test IDs by its step name): %s"
                       % (name, passes, list(TRIAL_STEPS.values()), TRIAL_RULE))
        for leg, step_name in TRIAL_STEPS.items():
            steps = [s for s in ((workflow.get("jobs") or {}).get(leg) or {}).get("steps") or []
                     if s.get("name") == step_name]
            envs = [s.get("env") for s in steps]
            if len(steps) != 1 or not isinstance(envs[0], dict) or envs[0].get(TRIAL_KEY) != TRIAL_VALUE:
                out.append("%s leg %s: step %r is there %d time(s) with env %s; want it once, with %s: '%s' in its "
                           "env. Without the key that leg runs jsdom-everything: %s"
                           % (name, leg, step_name, len(steps), json.dumps(envs, default=str), TRIAL_KEY, TRIAL_VALUE,
                              TRIAL_RULE))
        count = json.dumps(workflow, default=str).count(TRIAL_KEY)
        if count != len(TRIAL_STEPS):
            out.append("%s names %s %d time(s), want exactly %d, one in the env of each unit step. A job-level or "
                       "workflow-level env, a third step, or the key written into a run: body is outside the rule: %s"
                       % (name, TRIAL_KEY, count, len(TRIAL_STEPS), TRIAL_RULE))
    return out


# ── the steps the legs carry that the serial job did not ────────────────────────────────────────────────────────

def own_steps(ci, nxt):
    out = []
    for name, workflow in _pair(ci, nxt):
        for leg, job in _legs(workflow, name).items():
            at = "%s leg %s" % (name, leg)
            steps = job["steps"]
            canaries = [s for s in steps if s.get("name") == CANARY]
            if name == CI and canaries:
                out.append("%s: carries a canary step. The canary stays in ci-next.yml: %s" % (at, NO_DISPATCH))
            if name == NEXT and (len(canaries) != 1 or steps[0].get("name") != CANARY):
                out.append("%s: want exactly one canary step, first" % at)
            for canary in canaries:
                if set(canary) != {"name", "if", "run"} or canary.get("if") != "inputs.canary_red_leg == '%s'" % leg:
                    out.append("%s: its canary is not keyed to this leg alone (if: %r, keys %s)"
                               % (at, canary.get("if"), sorted(canary)))
                if canary.get("run") != CANARY_RUN % leg:
                    out.append("%s: its canary's body is not CANARY_RUN as pinned in scripts/test_ci_next.py" % at)
            for i, step in enumerate(steps):
                if "if" in step and step.get("name") != CANARY:
                    out.append("%s: step %r carries an if:" % (at, _label(step)))
                if step.get("name") != CANARY and INPUTS_CONTEXT.search(_canon(step)):
                    out.append("%s: step %r reads the inputs context; only a ci-next.yml canary's if: may"
                               % (at, _label(step)))
                if step.get("name") == PYYAML and (set(step) != {"name", "run"} or not any(
                        "gate_runner.py" in (s.get("run") or "") for s in steps[i:])):
                    out.append("%s: the PyYAML install wants a name and a run only, and a gate_runner.py step after it"
                               % at)
                for own, body in ((PYYAML, PYYAML_RUN), (SENTINEL, SENTINEL_RUN)):
                    if step.get("name") == own and step.get("run") != body:
                        out.append("%s: the body of %r is not the one pinned in scripts/test_ci_next.py" % (at, own))
                if step.get("name") == SENTINEL:
                    after = steps[i + 1] if i + 1 < len(steps) else {}
                    zone = (after.get("env") or {}).get("TZ")
                    if not zone or step.get("env") != {"TZ": zone} or set(step) != {"name", "env", "run"}:
                        out.append("%s: the TZ sentinel is not directly before a step with its own TZ" % at)
            for own in (PYYAML, SENTINEL):
                if sum(s.get("name") == own for s in steps) > 1:
                    out.append("%s: %r appears more than once" % (at, own))
    return out


# ── what the serial job handed each step implicitly ─────────────────────────────────────────────────────────────

def _setup_of(name, workflow):
    out = []
    for leg, job in _legs(workflow, name).items():
        leg, steps = "%s leg %s" % (name, leg), job["steps"]
        kinds = [_kind(s) for s in steps]

        def at(kind):
            return [i for i, k in enumerate(kinds) if k == kind]

        def before(kind, users, what):
            if not users:
                if at(kind):
                    out.append("%s: has %s and no step that needs it" % (leg, what))
            elif len(at(kind)) != 1 or at(kind)[0] > min(users):
                out.append("%s: needs exactly one %s, before %r" % (leg, what, _label(steps[min(users)])))

        rest = [i for i, s in enumerate(steps) if s.get("name") != CANARY]
        if len(at("checkout")) != 1 or not rest or kinds[rest[0]] != "checkout":
            out.append("%s: wants exactly one checkout, as its first step (after the canary, in ci-next.yml)" % leg)
        node_users = [i for i, s in enumerate(steps) if _uses_node(s) and kinds[i] != "npm-ci"]
        before("setup-node", node_users, "setup-node")
        for i in at("setup-node"):
            if steps[i].get("with") != NODE_PIN:
                out.append("%s: setup-node is not pinned %s" % (leg, NODE_PIN))
        if not node_users:
            if at("npm-ci"):
                out.append("%s: has npm ci and no step that runs node" % leg)
        elif len(at("npm-ci")) != 1 or (at("setup-node") and at("setup-node")[0] > at("npm-ci")[0]):
            out.append("%s: needs exactly one npm ci, after setup-node" % leg)
        else:
            for i in node_users:
                dry = steps[i].get("run") == DRY_RUN
                if dry != (i < at("npm-ci")[0]):
                    out.append("%s: %r is on the wrong side of npm ci (the manifest dry-run goes before it, where no "
                               "node_modules exists; everything else that runs node goes after)"
                               % (leg, _label(steps[i])))
        before("chrome", [i for i, s in enumerate(steps) if _chrome_gate(s)], "Chrome resolve")
        before("fetch-main", [i for i, s in enumerate(steps) if "check-release-version.py" in (s.get("run") or "")],
               "origin/main fetch")
        for i, step in enumerate(steps):
            if "gate_runner.py" in (step.get("run") or "") and not any(
                    PIP_PYYAML.search(s.get("run") or "") for s in steps[:i]):
                out.append("%s: gate_runner.py runs with no PyYAML install before it" % leg)
            if "TZ" in (step.get("env") or {}) and step.get("name") != SENTINEL and (
                    i == 0 or steps[i - 1].get("name") != SENTINEL):
                out.append("%s: %r sets TZ with no sentinel directly before it" % (leg, _label(step)))
    everything = _all_steps(workflow, name)
    zones = [s["env"]["TZ"] for s in everything if "TZ" in (s.get("env") or {}) and s.get("name") != SENTINEL]
    if zones != [NY]:
        out.append("%s: want exactly one step that sets TZ, and to %s (the app's own zone, and the one the sentinel "
                   "proves resolved); found %s" % (name, NY, zones))
    if [(s.get("env") or {}).get("TZ") for s in everything if s.get("name") == SENTINEL] != [NY]:
        out.append("%s: want exactly one TZ sentinel, with TZ %s" % (name, NY))
    for artefact, links in CHAINS.items():
        found = [(list(_legs(workflow, name)).index(leg), i) for link in links
                 for leg, job in _legs(workflow, name).items() for i, s in enumerate(job["steps"]) if link(s)]
        if len(found) != len(links) or len({leg for leg, _ in found}) != 1 or found != sorted(found):
            out.append("%s: the steps that write and read %s are not one per link, in one leg, in order (found at "
                       "(leg, step) %s; if a link's command changed, update CHAINS)" % (name, artefact, found))
    return out


def setup(ci, nxt):
    return _setup_of(CI, ci) + _setup_of(NEXT, nxt)


# ── triggers and the job graph ──────────────────────────────────────────────────────────────────────────────────

def _pinned_legs(job):
    steps = job.get("steps") or [{}]
    found = re.findall(r'^EXPECTED_LEGS="([^"]*)"$', steps[0].get("run") or "", re.M)
    return found[0].split() if len(found) == 1 else None


def _triggers_of_ci(ci):
    out = []
    if _on(ci) != CI_ON:
        out.append("ci.yml's triggers are %s, pinned as %s: %s"
                   % (json.dumps(_on(ci), sort_keys=True, default=str), json.dumps(CI_ON, sort_keys=True), NO_DISPATCH))
    if ci.get("concurrency") != CI_CONCURRENCY:
        out.append("ci.yml's concurrency is %r, pinned as %r: with another group, or without cancel-in-progress, a "
                   "superseded push keeps its runners" % (ci.get("concurrency"), CI_CONCURRENCY))
    if GATE not in (ci.get("jobs") or {}):
        out.append("ci.yml has no job with the id %s: promote-gate.yml asks scripts/promote-preflight.py for the job "
                   "of that name, and with none every promote refuses" % GATE)
    if (RESERVED_JOB_IDS - {GATE}) & set(ci.get("jobs") or {}):
        out.append("ci.yml: a job is named %s, which promote-gate.yml reads from another workflow"
                   % sorted((RESERVED_JOB_IDS - {GATE}) & set(ci.get("jobs") or {})))
    return out


def _triggers_of_next(nxt):
    out = []
    on = _on(nxt) or {}
    if set(on) != {"push", "workflow_dispatch"}:
        out.append("ci-next.yml: triggers are %s, want push and workflow_dispatch only (never pull_request)" % sorted(on))
    if (on.get("push") or {}) != NEXT_PUSH:
        out.append("ci-next.yml: push trigger is %r, want %r. Not dev: ci.yml runs these legs on every dev push, and "
                   "a second copy beside it doubles the runners a push takes" % (on.get("push"), NEXT_PUSH))
    inputs = (on.get("workflow_dispatch") or {}).get("inputs") or {}
    if list(inputs) != ["canary_red_leg"] or inputs["canary_red_leg"].get("default") != "" \
            or inputs["canary_red_leg"].get("type") != "string" or inputs["canary_red_leg"].get("required"):
        out.append("ci-next.yml: workflow_dispatch wants exactly one input, canary_red_leg: an optional string, empty "
                   "by default (found %s)" % json.dumps(inputs, sort_keys=True))
    if RESERVED_JOB_IDS & set(nxt.get("jobs") or {}):
        out.append("ci-next.yml: a job is named %s: promote-gate.yml reads that job name"
                   % sorted(RESERVED_JOB_IDS & set(nxt.get("jobs") or {})))
    return out


def _graph_of(name, workflow):
    out = []
    aggregator = AGGREGATORS[name]
    if _keys(workflow) != WORKFLOW_KEYS:
        out.append("%s's workflow keys are %s, pinned as %s; an env or defaults block would change what every step "
                   "runs with" % (name, sorted(_keys(workflow)), sorted(WORKFLOW_KEYS)))
    if workflow.get("permissions") != {"contents": "read"}:
        out.append("%s: permissions are %r, want contents: read and no more" % (name, workflow.get("permissions")))
    if _has_key(workflow, "continue-on-error"):
        out.append("%s: continue-on-error appears: a job that fails under it reads `success` in needs" % name)
    jobs = workflow.get("jobs") or {}
    legs = _legs(workflow, name)
    if tuple(legs) != LEGS or aggregator not in jobs:
        out.append("%s: job ids are %s, want the legs %s and %s" % (name, list(jobs), list(LEGS), aggregator))
    for job_id, job in jobs.items():
        if job.get("runs-on") != RUNNER[name]:  # TRIAL-ONLY: was the literal "ubuntu-24.04" for both files
            out.append("%s: %s runs on %r, want %s" % (name, job_id, job.get("runs-on"), RUNNER[name]))
        minutes = job.get("timeout-minutes")
        if not isinstance(minutes, int) or isinstance(minutes, bool) or minutes <= 0:
            out.append("%s: %s has no timeout-minutes" % (name, job_id))
    for leg, job in legs.items():
        extra = set(job) - LEG_KEYS
        if extra:
            out.append("%s: leg %s carries %s; a leg has runs-on, timeout-minutes and steps only (no if, needs, "
                       "strategy, name, uses, env, defaults, services or container)" % (name, leg, sorted(extra)))
    agg = jobs.get(aggregator) or {}
    if set(agg) != {"needs", "if", "runs-on", "timeout-minutes", "steps"}:
        out.append("%s: %s has keys %s; want needs, if, runs-on, timeout-minutes and steps (no name, no uses)"
                   % (name, aggregator, sorted(agg)))
    needs = agg.get("needs")
    if sorted(needs if isinstance(needs, list) else [needs], key=str) != sorted(legs):
        out.append("%s: %s needs %s, want every other job: %s" % (name, aggregator, needs, sorted(legs)))
    if agg.get("if") != "always()":
        out.append("%s: %s has if: %r, want always()" % (name, aggregator, agg.get("if")))
    steps = agg.get("steps") or []
    if len(steps) != 1 or set(steps[0]) != {"name", "env", "run"} \
            or steps[0].get("env") != {"NEEDS": "${{ toJSON(needs) }}"}:
        out.append("%s: %s wants ONE step: a run: that reads NEEDS = toJSON(needs) from env, no uses, no if"
                   % (name, aggregator))
    pinned = _pinned_legs(agg)
    if pinned is None or sorted(pinned) != sorted(legs) or len(set(pinned)) != len(pinned):
        out.append("%s: the list pinned in %s's step is %s, want the other job ids: %s"
                   % (name, aggregator, pinned, sorted(legs)))
    return out


def shape(ci, nxt):
    return _triggers_of_ci(ci) + _graph_of(CI, ci) + _triggers_of_next(nxt) + _graph_of(NEXT, nxt)


# ── hand-offs through the runner ────────────────────────────────────────────────────────────────────────────────

def _handoff_key(step):
    return (step.get("uses") or "").split("@")[0] or step.get("name")


def _hands_on(step):
    return "uses" in step or bool(HANDOFF.search(step.get("run") or ""))


def handoffs(ci, nxt):
    found = list(dict.fromkeys(_handoff_key(s) for s in _all_steps(ci, CI) if _hands_on(s)))
    out = [NEW_HANDOFF % key for key in found if key not in HANDOFFS]
    out += ["HANDOFFS in scripts/test_ci_next.py names %r, which is no longer a hand-off step of ci.yml: rename or "
            "remove the entry" % key for key in HANDOFFS if key not in found]
    return out


# ── concurrency groups across every workflow file ───────────────────────────────────────────────────────────────

def _all_workflows():
    paths = sorted(glob.glob(os.path.join(WORKFLOWS, "*.y*ml")))
    return {os.path.basename(path): _load(os.path.basename(path)) for path in paths}


def _groups(workflows):
    """{group expression: {file, ...}} over workflow-level and job-level concurrency in every file."""
    found = collections.defaultdict(set)
    for name, workflow in workflows.items():
        blocks = [workflow.get("concurrency")] + [(job or {}).get("concurrency")
                                                  for job in (workflow.get("jobs") or {}).values()]
        for block in blocks:
            group = block.get("group") if isinstance(block, dict) else block
            if group is not None:
                found[str(group)].add(name)
    return found


def concurrency(workflows):
    out = []
    # A group built from github.workflow is qualified by the workflow's own name, so two files may spell it alike.
    for group, files in sorted(_groups(workflows).items()):
        if len(files) > 1 and "github.workflow" not in group:
            out.append("concurrency group %r is used by %s: the runs would queue behind and cancel each other"
                       % (group, sorted(files)))
    mine = (workflows.get(NEXT) or {}).get("concurrency")
    if not isinstance(mine, dict) or not str(mine.get("group") or "").startswith("ci-next-"):
        out.append("ci-next.yml wants a workflow-level concurrency group of its own, named ci-next-...")
    return out


# ── the tree as committed ───────────────────────────────────────────────────────────────────────────────────────

CHECKS = {"mirror": mirror, "once": once, "trial": trial, "own_steps": own_steps, "setup": setup, "shape": shape,
          "handoffs": handoffs}


@pytest.mark.parametrize("check", list(CHECKS.values()), ids=list(CHECKS))
def test_ci_and_ci_next_hold(check):
    found = check(*_both())
    assert not found, (
        "ci.yml (the gating legs and their aggregator `%s`) or .github/workflows/ci-next.yml (the canary and soak "
        "copy of them) is out of shape. The headers of the two files say what each holds. A CI step changes in BOTH "
        "files in one commit (and scripts/ci-step-manifest.json is regenerated):\n  " % GATE) + "\n  ".join(found)


def test_no_two_workflow_files_share_a_concurrency_group():
    workflows = _all_workflows()
    groups = _groups(workflows)
    assert len(workflows) > 2 and len(groups) > 2, "scanned too little: the workflow glob or loader is broken"
    assert all(any(name in files for files in groups.values()) for name in (CI, NEXT))  # both were really read
    assert concurrency(workflows) == []


@pytest.mark.parametrize("name", FILES)
def test_the_checks_read_both_files_and_are_not_empty(name):
    workflow = _load(name)
    assert sum(len(_conserved(job)) for job in _legs(workflow, name).values()) > 30
    assert {_kind(s) for s in _all_steps(workflow, name)} - {None} == set(REPEATABLE)  # every setup kind is in use
    assert all(any(_uses_node(s) for s in job["steps"]) for leg, job in _legs(workflow, name).items() if leg != "pytest")
    assert sum(s.get("name") == CANARY for s in _all_steps(workflow, name)) == (len(LEGS) if name == NEXT else 0)


def test_the_trial_key_is_named_by_seven_tracked_files_and_not_by_package_json():
    """`trial` holds the key to two steps of each workflow file. This holds it out of everything else: an npm
    script that sets it (`"test": "VITEST_NODE_PROJECT=1 vitest run --coverage"`) switches every run of that
    script, local ones and other workflows' included, with nothing in ci.yml changing."""
    repo = os.path.join(HERE, "..")
    named = subprocess.run(["git", "-C", repo, "grep", "-l", "-F", TRIAL_KEY], capture_output=True, text=True)
    assert named.returncode == 0, "git grep found no tracked file naming %s: %r" % (TRIAL_KEY, named.stderr)
    with open(os.path.join(repo, "package.json"), encoding="utf-8") as fh:
        assert TRIAL_KEY not in fh.read(), (
            "package.json names %s. An npm script that sets the key switches every run of that script. Take it out: "
            "%s" % (TRIAL_KEY, TRIAL_RULE))
    assert sorted(named.stdout.split()) == TRIAL_KEY_FILES, (
        "the tracked files that name %s are no longer the seven it is made of (the config that reads it, the two "
        "workflows that set it, the manifest that records ci.yml's steps, and the three tests that hold it). A file "
        "that SETS or READS the key elsewhere changes which runs are two-project: take it out. A file that only "
        "mentions it: reword it, or add it to TRIAL_KEY_FILES in scripts/test_ci_next.py in the same commit: %s"
        % (TRIAL_KEY, TRIAL_RULE))


@pytest.mark.parametrize("name", FILES)
def test_the_legs_hold_what_their_names_say(name):
    workflow = _load(name)
    if once(*_both()) or mirror(*_both()):
        pytest.skip("a step is repeated, or the two files differ; test_ci_and_ci_next_hold says which and how")
    everything = _all_steps(workflow, name)
    legs = {leg: [_label(s) for s in _conserved(job)] for leg, job in _legs(workflow, name).items()}

    def named(test, count, what):
        found = [_label(s) for s in everything if test(s)]
        assert len(found) == count, (
            "%s has %d step(s) that are %s, and this test expects %d: %s. It finds them by their command, so if a "
            "command or env changed, update the matcher in test_the_legs_hold_what_their_names_say; if the step was "
            "removed or one was added, change the count with it." % (name, len(found), what, count, found))
        return found

    def holds(leg, want, what):
        assert legs[leg] == want, (
            "leg `%s` of .github/workflows/%s should hold exactly %s.\n  it holds: %s\n  want:     %s\n"
            "Move the step that differs to the leg it belongs in (the comment above each leg says what the leg is "
            "for), in both files. If the split itself is meant to change, change this test in the same commit."
            % (leg, name, what, legs[leg], want))

    gates = [_label(s) for s in everything if _chrome_gate(s)]
    assert len(gates) > 10, (
        "only %d %s steps carry env GATE_CHROME_FLAGS, which is how this test recognises a real-Chrome gate: "
        "update _chrome_gate in scripts/test_ci_next.py" % (len(gates), name))
    in_gate_legs = sum((legs[leg] for leg in GATE_LEGS), [])
    assert sorted(in_gate_legs) == sorted(gates), (
        "the four gate legs of .github/workflows/%s (%s) should hold every real-Chrome gate and no other step.\n"
        "  gates in no gate leg: %s\n  in a gate leg, not a gate: %s\nA new gate goes in gates-a or gates-b, "
        "whichever is shorter (page-scroll stays alone in gates-c; the Today V2 probe steps are gate-probes). A step "
        "that drives no browser goes in static."
        % (name, ", ".join(GATE_LEGS), sorted(set(gates) - set(in_gate_legs)), sorted(set(in_gate_legs) - set(gates))))
    holds("gates-c", named(lambda s: s.get("run") == "npm run gate:page-scroll", 1, "`npm run gate:page-scroll`"),
          "the page-scroll gate, alone: it is the longest gate and the one that grows")
    holds("gate-probes", named(lambda s: "probe-nothing" in (s.get("run") or ""), 2, "gates that run a probe-nothing"),
          "the two Today V2 steps that run their gate and then its probe-nothing proof")
    holds("pytest", named(lambda s: "pytest -q scripts/test_*.py" in (s.get("run") or ""), 1, "the pytest run"),
          "the pytest step and nothing else (no setup-node, no npm ci)")
    holds("unit-ny", [SENTINEL] + named(lambda s: "TZ" in (s.get("env") or {}) and s.get("name") != SENTINEL, 1,
                                        "run with an env TZ (the sentinel aside)"),
          "the TZ sentinel, then the unit suite under that TZ")
    holds("unit-utc-cov", named(lambda s: s.get("run") == "npm test" or "check-coverage-ratchet.py" in (
        s.get("run") or ""), 3, "`npm test` or a check-coverage-ratchet.py call"),
          "the coverage ratchet, `npm test`, and the measured floor that reads the coverage `npm test` wrote")


@pytest.mark.parametrize("name", FILES)
def test_the_file_is_lf_only_with_no_tabs(name):
    with open(os.path.join(WORKFLOWS, name), "rb") as fh:
        raw = fh.read()
    assert b"\r" not in raw and b"\t" not in raw and raw.endswith(b"\n")


# ── the bodies the legs add, run as the runner runs them ────────────────────────────────────────────────────────

@pytest.fixture(params=FILES)
def workflow_file(request):
    """Each body is run from ci.yml, the gating file, and from ci-next.yml, the copy a canary dispatch runs."""
    return request.param


def _run_as_runner(tmp_path, body, env):
    """`bash -e` on a file, the runner's default for a step that declares no shell. shape and own_steps hold that
    none of the steps run here can declare one: their keys are pinned, and the workflow and jobs carry no defaults."""
    script = tmp_path / "step.sh"
    script.write_text(body)
    return subprocess.run(RUNNER_SHELL + [str(script)], cwd=tmp_path, env=env, capture_output=True, text=True)


def _errors(proc):
    return [ln.lstrip() for ln in (proc.stdout + "\n" + proc.stderr).splitlines() if ln.lstrip().startswith("::error")]


def _own(workflow, job_id, name):
    return next(s for s in workflow["jobs"][job_id]["steps"] if s.get("name") == name)


def test_the_harness_runs_with_errexit_on_like_the_runner(tmp_path):
    proc = _run_as_runner(tmp_path, "set -uo pipefail\nfalse\necho reached\n", dict(os.environ))
    assert proc.returncode == 1 and "reached" not in proc.stdout


def _aggregate(tmp_path, name, needs_json):
    step = _load(name)["jobs"][AGGREGATORS[name]]["steps"][0]
    env = {k: v for k, v in os.environ.items() if k not in ("NEEDS", "EXPECTED_LEGS")}
    if needs_json is not None:
        env["NEEDS"] = needs_json
    return _run_as_runner(tmp_path, step["run"], env)


def _needs(**results):
    """`toJSON(needs)` with every leg successful, then overridden: a result string, or None to drop the leg."""
    needs = {leg: {"result": "success", "outputs": {}} for leg in LEGS}
    for leg, result in results.items():
        leg = leg.replace("_", "-")
        if result is None:
            del needs[leg]
        else:
            needs[leg] = {"result": result, "outputs": {}}
    return needs


def test_aggregator_passes_when_every_pinned_leg_succeeded(tmp_path, workflow_file):
    proc = _aggregate(tmp_path, workflow_file, json.dumps(_needs(), indent=2))
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "all %d legs succeeded" % len(LEGS) in proc.stdout and _errors(proc) == []
    assert AGGREGATORS[workflow_file] + ":" in proc.stdout
    shuffled = dict(reversed(list(_needs().items())))  # key order is not part of the contract
    assert _aggregate(tmp_path, workflow_file, json.dumps(shuffled)).returncode == 0


@pytest.mark.parametrize("leg", LEGS)
@pytest.mark.parametrize("result", ["failure", "cancelled", "skipped"])
def test_aggregator_fails_when_any_leg_did_not_succeed(tmp_path, workflow_file, leg, result):
    """`cancelled` is what a timed-out leg reads as; `skipped` is a leg an `if:` or a failed need kept from running."""
    proc = _aggregate(tmp_path, workflow_file, json.dumps(_needs(**{leg: result})))
    assert proc.returncode == 1
    assert _errors(proc) and "%s=%s" % (leg, result) in _errors(proc)[0]
    assert _errors(proc)[0].startswith("::error title=%s::" % AGGREGATORS[workflow_file])


@pytest.mark.parametrize("leg", LEGS)
def test_aggregator_fails_when_a_pinned_leg_is_missing_from_needs(tmp_path, workflow_file, leg):
    proc = _aggregate(tmp_path, workflow_file, json.dumps(_needs(**{leg: None})))
    assert proc.returncode == 1 and "expected exactly" in _errors(proc)[0]


def test_aggregator_fails_on_a_job_nobody_pinned(tmp_path, workflow_file):
    needs = dict(_needs(), **{"gates-d": {"result": "success", "outputs": {}}})
    proc = _aggregate(tmp_path, workflow_file, json.dumps(needs))
    assert proc.returncode == 1 and "gates-d" in _errors(proc)[0]


@pytest.mark.parametrize("needs_json", [
    None,                                                    # the env var never arrived
    "",
    "{",
    "not json",
    "null",
    "[]",
    '"success"',
    "{}",
    json.dumps({leg: "success" for leg in LEGS}),            # results that are not objects
    json.dumps({leg: {"outputs": {}} for leg in LEGS}),      # no result at all
    json.dumps({leg: {"result": "Success"} for leg in LEGS}),
    json.dumps({leg: {"result": "success "} for leg in LEGS}),
    json.dumps({leg: {"result": None} for leg in LEGS}),
    json.dumps({leg: {"result": True} for leg in LEGS}),
])
def test_aggregator_fails_closed_on_anything_that_is_not_the_expected_context(tmp_path, workflow_file, needs_json):
    proc = _aggregate(tmp_path, workflow_file, needs_json)
    assert proc.returncode == 1, proc.stdout + proc.stderr
    assert len(_errors(proc)) == 1 and "Traceback" not in proc.stderr


def test_aggregator_takes_its_list_from_the_step_and_nowhere_else(tmp_path, workflow_file):
    """EXPECTED_LEGS set in the job's environment must not widen or narrow the pinned list."""
    step = _load(workflow_file)["jobs"][AGGREGATORS[workflow_file]]["steps"][0]
    env = dict(os.environ, NEEDS=json.dumps(_needs(static=None)), EXPECTED_LEGS=" ".join(LEGS[1:]))
    assert _run_as_runner(tmp_path, step["run"], env).returncode == 1


@pytest.mark.parametrize("leg", LEGS)
def test_a_canary_step_ends_its_leg_non_zero_and_says_which(tmp_path, leg):
    proc = _run_as_runner(tmp_path, _own(_load(NEXT), leg, CANARY)["run"], dict(os.environ))
    assert proc.returncode == 1
    assert len(_errors(proc)) == 1 and "canary_red_leg=%s:" % leg in _errors(proc)[0]


@pytest.mark.parametrize("zone,want", [
    ("America/New_York", 0),
    ("UTC", 1),                      # what an unresolved zone falls back to
    ("Europe/London", 1),
    ("America/Chicago", 1),
    ("Not/AZone", 1),
    ("", 1),
    (None, 1),                       # TZ never set: the machine's own zone, even when that IS New York
])
def test_tz_sentinel_passes_only_when_node_resolved_new_york(tmp_path, workflow_file, zone, want):
    assert shutil.which("node"), "node is required: the sentinel asks node what the zone resolved to"
    env = {k: v for k, v in os.environ.items() if k != "TZ"}
    if zone is not None:
        env["TZ"] = zone
    proc = _run_as_runner(tmp_path, _own(_load(workflow_file), "unit-ny", SENTINEL)["run"], env)
    assert proc.returncode == want, proc.stdout + proc.stderr
    assert len(_errors(proc)) == want
    if want == 0:
        assert "resolved as America/New_York; minutes behind UTC: January 300, July 240" in proc.stdout


@pytest.mark.parametrize("plain_rc,fallback_rc,want_rc,want_calls", [
    (0, 0, 0, 1),        # the plain form works: one install
    (1, 0, 0, 2),        # a PEP-668 image: the fallback carries it
    (1, 1, 1, 2),        # neither installs: the leg stops here, not at gate_runner.py's "PyYAML is required"
])
def test_pyyaml_install_tries_the_plain_form_then_the_pep668_one(tmp_path, workflow_file, plain_rc, fallback_rc, want_rc,
                                                                 want_calls):
    bindir = tmp_path / "bin"
    bindir.mkdir()
    called = tmp_path / "called"
    stub = bindir / "python3"
    stub.write_text('#!/bin/sh\necho "$@" >> "%s"\ncase " $* " in *" --break-system-packages "*) exit %d ;; esac\n'
                    'exit %d\n' % (called, fallback_rc, plain_rc))
    stub.chmod(stub.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    env = dict(os.environ, PATH="%s:%s" % (bindir, os.environ["PATH"]))
    proc = _run_as_runner(tmp_path, _own(_load(workflow_file), "static", PYYAML)["run"], env)
    calls = called.read_text().splitlines()
    assert (proc.returncode != 0) == bool(want_rc), proc.stderr
    assert len(calls) == want_calls and all(c.endswith(" pyyaml") and "pip install" in c for c in calls)
    assert "--break-system-packages" not in calls[0]


# ── every check can fail ────────────────────────────────────────────────────────────────────────────────────────
# Each mutation is applied to today's two files in memory and must be reported by the named check. A mutation is
# written against ONE workflow, `w`, with `o` the other file, and is made twice: once with w = ci.yml and once with
# w = ci-next.yml, each time leaving the other file as committed. So every single-file check is shown to fail on
# the gating file by itself. A third element narrows that: CI or NEXT when the mutation only makes sense in that
# file, BOTH when it edits the two files alike (what a lane that knows the mirror rule would do).

BOTH = "both files"


def _steps(workflow, leg):
    return workflow["jobs"][leg]["steps"]


def _find(workflow, leg, test):
    return next(i for i, s in enumerate(_steps(workflow, leg)) if test(s))


def _gate(workflow, leg="gates-a"):
    return _steps(workflow, leg)[_find(workflow, leg, _chrome_gate)]


def _drop(workflow, leg, test):
    _steps(workflow, leg).pop(_find(workflow, leg, test))


def _move(workflow, src, dst, test):
    _steps(workflow, dst).append(_steps(workflow, src).pop(_find(workflow, src, test)))


def _swap(steps, i, j):
    steps[i], steps[j] = steps[j], steps[i]


def _named(name):
    return lambda s: s.get("name") == name


def _kinded(kind):
    return lambda s: _kind(s) == kind


def _agg(workflow):
    return next(workflow["jobs"][job_id] for job_id in AGGREGATORS.values() if job_id in workflow["jobs"])


def _repin(workflow, old, new):
    step = _agg(workflow)["steps"][0]
    step["run"] = step["run"].replace(old, new)


def _to_both(w, o, change):
    """The same change made in each file: what a lane that knows the mirror rule would do."""
    change(w)
    change(o)


def _add_to_both(w, o, step, leg="static"):
    _to_both(w, o, lambda workflow: _steps(workflow, leg).append(copy.deepcopy(step)))


def _edit_own(workflow, leg, name, old, new):
    step = _own(workflow, leg, name)
    step["run"] = step["run"].replace(old, new)
    assert new in step["run"]


def _tz_steps(workflow):
    return [s for s in _steps(workflow, "unit-ny") if "TZ" in (s.get("env") or {})]


def _pass(workflow, leg):
    """A unit leg's pass: the step the trial's key rides on."""
    return _steps(workflow, leg)[_find(workflow, leg, _named(TRIAL_STEPS[leg]))]


def _canary_step(leg):
    return {"name": CANARY, "if": "inputs.canary_red_leg == '%s'" % leg, "run": CANARY_RUN % leg}


MUTATIONS = {
    # mirror: one file changes and the other does not
    "a gate is dropped from its leg": ("mirror", lambda w, o: _drop(w, "gates-a", _chrome_gate)),
    "page-scroll is dropped": ("mirror", lambda w, o: _drop(w, "gates-c", _chrome_gate)),
    "a run body gains a line": ("mirror", lambda w, o: _gate(w).update(run=_gate(w)["run"] + "\ntrue")),
    "a run body loses its last character": ("mirror", lambda w, o: _gate(w).update(run=_gate(w)["run"][:-1])),
    "an env value changes": ("mirror", lambda w, o: _gate(w)["env"].update(GATE_CHROME_FLAGS="")),
    "an env gains a key": ("mirror", lambda w, o: _gate(w)["env"].update(ADDED_BY_TEST="1")),
    "a step is renamed": ("mirror", lambda w, o: _gate(w).update(name="renamed by the test")),
    "a step gains continue-on-error": ("mirror", lambda w, o: _gate(w).update({"continue-on-error": True})),
    "a step gains a timeout": ("mirror", lambda w, o: _gate(w).update({"timeout-minutes": 5})),
    "a step gains a shell": ("mirror", lambda w, o: _gate(w).update(shell="sh")),
    "a step gains a working-directory": ("mirror", lambda w, o: _gate(w).update({"working-directory": "lambda"})),
    "a checkout is repinned": ("mirror", lambda w, o: _steps(w, "pytest")[
        _find(w, "pytest", _kinded("checkout"))].update(uses="actions/checkout@v0")),
    "a setup-node moves off the pin": ("mirror", lambda w, o: _steps(w, "unit-ny")[
        _find(w, "unit-ny", _kinded("setup-node"))]["with"].update({"node-version": "22"})),
    "a step is added": ("mirror", lambda w, o: _steps(w, "static").append(
        {"name": "added by the test", "run": "true"})),
    "the last step of a leg is removed": ("mirror", lambda w, o: _steps(w, "static").pop()),
    "the origin/main fetch is dropped": ("mirror", lambda w, o: _drop(w, "static", _kinded("fetch-main"))),
    "two steps swap inside a leg": ("mirror", lambda w, o: _swap(_steps(w, "gates-b"), -1, -2)),
    "a step moves to another leg": ("mirror", lambda w, o: _move(w, "gates-a", "gates-b", _chrome_gate)),
    "a setup step is repeated in a leg": ("mirror", lambda w, o: _steps(w, "gates-b").append(
        copy.deepcopy(_steps(w, "gates-b")[_find(w, "gates-b", _kinded("npm-ci"))]))),
    "a leg's timeout changes": ("mirror", lambda w, o: w["jobs"]["gates-c"].update({"timeout-minutes": 60})),
    "a leg's runner changes": ("mirror", lambda w, o: w["jobs"]["gates-c"].update({"runs-on": "ubuntu-22.04"})),
    "a leg is dropped": ("mirror", lambda w, o: w["jobs"].pop("gates-c")),
    "two legs swap places": ("mirror", lambda w, o: w["jobs"].update({"static": w["jobs"].pop("static")})),
    "the aggregator's timeout changes": ("mirror", lambda w, o: _agg(w).update({"timeout-minutes": 6})),
    "the aggregator's body gains a line": ("mirror", lambda w, o: _repin(w, "set -euo pipefail\n",
                                                                         "set -euo pipefail\ntrue\n")),
    "the aggregator's step is renamed": ("mirror", lambda w, o: _agg(w)["steps"][0].update(name="Verdict")),
    "a unit pass's trial key changes value": ("mirror", lambda w, o: _pass(w, "unit-utc-cov")["env"].update(
        {TRIAL_KEY: "0"})),
    "a unit pass's env gains a key": ("mirror", lambda w, o: _pass(w, "unit-utc-cov")["env"].update(
        ADDED_BY_TEST="1")),
    "the NY pass loses its TZ": ("mirror", lambda w, o: _pass(w, "unit-ny")["env"].pop("TZ")),
    "a unit pass's run changes": ("mirror", lambda w, o: _pass(w, "unit-utc-cov").update(run="npm test -- --silent")),
    "ci-next.yml's canary step is copied into ci.yml": ("mirror", lambda w, o: _steps(w, "static").insert(
        0, _canary_step("static")), CI),
    # once
    "a gate runs in two legs": ("once", lambda w, o: _steps(w, "gates-b").append(copy.deepcopy(_gate(w)))),
    "a gate runs in two legs of both files": ("once", lambda w, o: _to_both(
        w, o, lambda f: _steps(f, "gates-b").append(copy.deepcopy(_gate(f)))), BOTH),
    "a check is repeated inside its leg, edited": ("once", lambda w, o: _steps(w, "gates-a").append(
        dict(copy.deepcopy(_gate(w)), run="true"))),
    "the PyYAML install is repeated in another leg of both files": ("once", lambda w, o: _to_both(
        w, o, lambda f: _steps(f, "gates-a").append(copy.deepcopy(_own(f, "static", PYYAML)))), BOTH),
    # own_steps
    "a leg loses its canary": ("own_steps", lambda w, o: _drop(w, "gates-c", _named(CANARY)), NEXT),
    "a leg has two canaries": ("own_steps", lambda w, o: _steps(w, "pytest").append(
        copy.deepcopy(_steps(w, "pytest")[0])), NEXT),
    "a canary is keyed to another leg": ("own_steps", lambda w, o: _steps(w, "static")[0].update(
        {"if": "inputs.canary_red_leg == 'pytest'"}), NEXT),
    "a canary fires on every run": ("own_steps", lambda w, o: _steps(w, "static")[0].pop("if"), NEXT),
    "a canary fires unless named": ("own_steps", lambda w, o: _steps(w, "static")[0].update(
        {"if": "inputs.canary_red_leg != 'static'"}), NEXT),
    "a canary is not the first step": ("own_steps", lambda w, o: _swap(_steps(w, "unit-ny"), 0, 1), NEXT),
    "a canary is made advisory": ("own_steps", lambda w, o: _steps(w, "static")[0].update(
        {"continue-on-error": True}), NEXT),
    "a canary exits with another status": ("own_steps", lambda w, o: _edit_own(
        w, "gates-a", CANARY, "exit 1", "exit 2"), NEXT),
    "a canary names another leg in its message": ("own_steps", lambda w, o: _edit_own(
        w, "gates-a", CANARY, "canary_red_leg=gates-a:", "canary_red_leg=gates-b:"), NEXT),
    "ci.yml gains a canary step": ("own_steps", lambda w, o: _steps(w, "static").insert(
        0, _canary_step("static")), CI),
    "ci.yml gains a canary step in every leg": ("own_steps", lambda w, o: [
        _steps(w, leg).insert(0, _canary_step(leg)) for leg in LEGS], CI),
    "a second step reads the dispatch input": ("own_steps", lambda w, o: _steps(w, "static").append(
        {"name": "Canary two", "if": "inputs.canary_red_leg == 'static'", "run": "exit 1"})),
    "a step reads the dispatch input in its body": ("own_steps", lambda w, o: _gate(w).update(
        run='test "${{ github.event.inputs.canary_red_leg }}" = ""\n' + _gate(w)["run"])),
    "a step gains an if": ("own_steps", lambda w, o: _gate(w).update({"if": "always()"})),
    "a step gains an if in both files": ("own_steps", lambda w, o: _to_both(
        w, o, lambda f: _gate(f).update({"if": "github.event_name == 'push'"})), BOTH),
    "the PyYAML install is added where nothing needs it": ("own_steps", lambda w, o: _steps(w, "pytest").append(
        copy.deepcopy(_own(w, "static", PYYAML)))),
    "the TZ sentinel checks a different zone": ("own_steps", lambda w, o: _own(w, "unit-ny", SENTINEL)["env"].update(
        TZ="UTC")),
    "the TZ sentinel runs after the suite": ("own_steps", lambda w, o: _swap(_steps(w, "unit-ny"), -1, -2)),
    "the PyYAML install also writes GITHUB_ENV": ("own_steps", lambda w, o: _edit_own(
        w, "static", PYYAML, "pyyaml\n", 'pyyaml\necho "PIP_INDEX_URL=https://example.invalid" >> "$GITHUB_ENV"\n')),
    "the TZ sentinel's January offset changes": ("own_steps", lambda w, o: _edit_own(
        w, "unit-ny", SENTINEL, "jan !== 300", "jan !== 240")),
    "the TZ sentinel drops its offset comparison": ("own_steps", lambda w, o: _edit_own(
        w, "unit-ny", SENTINEL, " || jan !== 300 || jul !== 240", " ")),
    "the TZ sentinel drops its offset comparison in both files": ("own_steps", lambda w, o: _to_both(
        w, o, lambda f: _edit_own(f, "unit-ny", SENTINEL, " || jan !== 300 || jul !== 240", " ")), BOTH),
    # setup
    "a leg loses its checkout": ("setup", lambda w, o: _drop(w, "gates-b", _kinded("checkout"))),
    "a leg loses setup-node": ("setup", lambda w, o: _drop(w, "gates-c", _kinded("setup-node"))),
    "a leg loses npm ci": ("setup", lambda w, o: _drop(w, "unit-utc-cov", _kinded("npm-ci"))),
    "a leg installs node twice": ("setup", lambda w, o: _steps(w, "gates-a").append(
        copy.deepcopy(_steps(w, "gates-a")[_find(w, "gates-a", _kinded("setup-node"))]))),
    "setup-node is repinned in a leg": ("setup", lambda w, o: _steps(w, "gate-probes")[
        _find(w, "gate-probes", _kinded("setup-node"))].update({"with": {"node-version": "22", "cache": "npm"}})),
    "setup-node is repinned in a leg of both files": ("setup", lambda w, o: _to_both(w, o, lambda f: _steps(
        f, "gate-probes")[_find(f, "gate-probes", _kinded("setup-node"))].update(
        {"with": {"node-version": "22", "cache": "npm"}})), BOTH),
    "pytest gains setup-node": ("setup", lambda w, o: _steps(w, "pytest").append(
        copy.deepcopy(_steps(w, "static")[_find(w, "static", _kinded("setup-node"))]))),
    "pytest gains npm ci": ("setup", lambda w, o: _steps(w, "pytest").append(
        copy.deepcopy(_steps(w, "static")[_find(w, "static", _kinded("npm-ci"))]))),
    "npm ci moves ahead of setup-node": ("setup", lambda w, o: _swap(
        _steps(w, "unit-ny"), _find(w, "unit-ny", _kinded("setup-node")), _find(w, "unit-ny", _kinded("npm-ci")))),
    "the manifest dry-run moves after npm ci": ("setup", lambda w, o: _swap(
        _steps(w, "static"), _find(w, "static", lambda s: s.get("run") == DRY_RUN),
        _find(w, "static", _kinded("npm-ci")))),
    "a gate leg loses the Chrome resolve": ("setup", lambda w, o: _drop(w, "gate-probes", _kinded("chrome"))),
    "a gate leg loses the Chrome resolve in both files": ("setup", lambda w, o: _to_both(
        w, o, lambda f: _drop(f, "gate-probes", _kinded("chrome"))), BOTH),
    "a leg with no gate resolves Chrome": ("setup", lambda w, o: _steps(w, "unit-ny").append(
        copy.deepcopy(_steps(w, "gates-a")[_find(w, "gates-a", _kinded("chrome"))]))),
    "the release-version guard loses its fetch": ("setup", lambda w, o: _drop(w, "static", _kinded("fetch-main"))),
    "gate_runner.py loses its PyYAML": ("setup", lambda w, o: _drop(w, "static", _named(PYYAML))),
    "the NY suite loses its sentinel": ("setup", lambda w, o: _drop(w, "unit-ny", _named(SENTINEL))),
    "the NY suite loses its sentinel in both files": ("setup", lambda w, o: _to_both(
        w, o, lambda f: _drop(f, "unit-ny", _named(SENTINEL))), BOTH),
    "the build moves after the check that reads it": ("setup", lambda w, o: _swap(
        _steps(w, "static"), _find(w, "static", CHAINS["dist/"][0]), _find(w, "static", CHAINS["dist/"][2]))),
    "the build moves after the check that reads it in both files": ("setup", lambda w, o: _to_both(
        w, o, lambda f: _swap(_steps(f, "static"), _find(f, "static", CHAINS["dist/"][0]),
                              _find(f, "static", CHAINS["dist/"][2]))), BOTH),
    "the chunk check leaves the build's leg": ("setup", lambda w, o: _move(w, "static", "unit-ny", CHAINS["dist/"][2])),
    "the measured floor leaves the coverage leg": ("setup", lambda w, o: _move(
        w, "unit-utc-cov", "unit-ny", CHAINS["coverage/coverage-summary.json"][1])),
    "the measured floor leaves the coverage leg in both files": ("setup", lambda w, o: _to_both(w, o, lambda f: _move(
        f, "unit-utc-cov", "unit-ny", CHAINS["coverage/coverage-summary.json"][1])), BOTH),
    "the build is dropped from both files": ("setup", lambda w, o: _to_both(
        w, o, lambda f: _drop(f, "static", CHAINS["dist/"][0])), BOTH),
    "the NY suite moves to another zone in both files": ("setup", lambda w, o: _to_both(
        w, o, lambda f: [s["env"].update(TZ="America/Chicago") for s in _tz_steps(f)]), BOTH),
    "the NY suite loses its zone in both files": ("setup", lambda w, o: _to_both(
        w, o, lambda f: [s["env"].pop("TZ") for s in _tz_steps(f) if s.get("name") != SENTINEL]), BOTH),
    "a second step sets TZ in both files": ("setup", lambda w, o: _add_to_both(
        w, o, {"name": "added by the test", "env": {"TZ": "UTC"}, "run": "true"}), BOTH),
    # shape: the job graph, in either file
    "a leg gains continue-on-error": ("shape", lambda w, o: w["jobs"]["gates-a"].update({"continue-on-error": True})),
    "a leg gains an if": ("shape", lambda w, o: w["jobs"]["gates-a"].update({"if": "github.ref == 'refs/heads/dev'"})),
    "a leg gains an if in both files": ("shape", lambda w, o: _to_both(
        w, o, lambda f: f["jobs"]["gates-a"].update({"if": "github.event_name == 'push'"})), BOTH),
    "a leg gains a matrix": ("shape", lambda w, o: w["jobs"]["gates-a"].update(strategy={"matrix": {"n": [1, 2]}})),
    "a leg gains needs": ("shape", lambda w, o: w["jobs"]["gates-b"].update(needs=["gates-a"])),
    "a leg gains a name": ("shape", lambda w, o: w["jobs"]["static"].update(name="Static checks")),
    "a leg gains an env": ("shape", lambda w, o: w["jobs"]["static"].update(env={"ADDED_BY_TEST": "1"})),
    "a leg gains services": ("shape", lambda w, o: w["jobs"]["static"].update(services={"db": {"image": "pg:17"}})),
    "a leg gains a container": ("shape", lambda w, o: w["jobs"]["static"].update(container="node:20")),
    "a leg gains a default shell": ("shape", lambda w, o: w["jobs"]["static"].update(
        defaults={"run": {"shell": "sh"}})),
    "a leg loses its timeout": ("shape", lambda w, o: w["jobs"]["unit-ny"].pop("timeout-minutes")),
    "a leg floats to ubuntu-latest": ("shape", lambda w, o: w["jobs"]["pytest"].update({"runs-on": "ubuntu-latest"})),
    "a leg is added and nobody lists it": ("shape", lambda w, o: w["jobs"].update(
        {"gates-d": copy.deepcopy(w["jobs"]["gates-c"])})),
    "a leg is added to both files and nobody lists it": ("shape", lambda w, o: _to_both(
        w, o, lambda f: f["jobs"].update({"gates-d": copy.deepcopy(f["jobs"]["gates-c"])})), BOTH),
    "a leg is dropped, needs and pinned list with it, in both files": ("shape", lambda w, o: _to_both(w, o, lambda f: (
        f["jobs"].pop("gates-c"), _agg(f)["needs"].remove("gates-c"), _repin(f, " gates-c", ""))), BOTH),
    "the aggregator drops a need": ("shape", lambda w, o: _agg(w)["needs"].remove("gates-c")),
    "the aggregator drops a need in both files": ("shape", lambda w, o: _to_both(
        w, o, lambda f: _agg(f)["needs"].remove("gates-c")), BOTH),
    "the aggregator loses always()": ("shape", lambda w, o: _agg(w).pop("if")),
    "the aggregator loses always() in both files": ("shape", lambda w, o: _to_both(
        w, o, lambda f: _agg(f).pop("if")), BOTH),
    "the aggregator runs only on success": ("shape", lambda w, o: _agg(w).update({"if": "success()"})),
    "the aggregator gains a name": ("shape", lambda w, o: _agg(w).update(name="Verdict")),
    "the aggregator becomes a reusable-workflow call": ("shape", lambda w, o: _agg(w).update(
        uses="./.github/workflows/x.yml")),
    "the aggregator loses its timeout": ("shape", lambda w, o: _agg(w).pop("timeout-minutes")),
    "the aggregator is made advisory": ("shape", lambda w, o: _agg(w).update({"continue-on-error": True})),
    "the aggregator gains a second step": ("shape", lambda w, o: _agg(w)["steps"].append({"run": "true"})),
    "the aggregator's step gains an if": ("shape", lambda w, o: _agg(w)["steps"][0].update({"if": "failure()"})),
    "the aggregator's step uses an action": ("shape", lambda w, o: _agg(w)["steps"][0].update(
        uses="actions/checkout@v0")),
    "the aggregator reads something other than needs": ("shape", lambda w, o: _agg(w)["steps"][0]["env"].update(
        NEEDS="${{ toJSON(needs.static) }}")),
    "the pinned list loses a leg": ("shape", lambda w, o: _repin(w, " gates-c", "")),
    "the pinned list loses a leg in both files": ("shape", lambda w, o: _to_both(
        w, o, lambda f: _repin(f, " gates-c", "")), BOTH),
    "the pinned list gains a leg": ("shape", lambda w, o: _repin(w, " gate-probes\"", " gate-probes gates-d\"")),
    "the pinned list is no longer one literal line": ("shape", lambda w, o: _repin(
        w, 'EXPECTED_LEGS="', 'EXPECTED_LEGS="$X ')),
    "permissions widen": ("shape", lambda w, o: w["permissions"].update(actions="read")),
    "permissions widen in both files": ("shape", lambda w, o: _to_both(
        w, o, lambda f: f["permissions"].update(actions="read")), BOTH),
    "permissions are dropped": ("shape", lambda w, o: w.pop("permissions")),
    "the workflow gains an env": ("shape", lambda w, o: w.update(env={"ADDED_BY_TEST": "1"})),
    "the workflow gains a default shell": ("shape", lambda w, o: w.update(defaults={"run": {"shell": "sh"}})),
    # shape: ci.yml's triggers, group and the name the promote reads
    "ci.yml gains workflow_dispatch": ("shape", lambda w, o: _on(w).update(workflow_dispatch=None), CI),
    "ci.yml gains workflow_dispatch with the canary input": ("shape", lambda w, o: _on(w).update(
        workflow_dispatch=copy.deepcopy(_on(o)["workflow_dispatch"])), CI),
    "ci.yml gains workflow_call": ("shape", lambda w, o: _on(w).update(workflow_call=None), CI),
    "ci.yml gains a schedule": ("shape", lambda w, o: _on(w).update(schedule=[{"cron": "0 5 * * *"}]), CI),
    "ci.yml's push trigger widens to the soak branch": ("shape", lambda w, o: _on(w)["push"]["branches"].append(
        "ci-next-soak"), CI),
    "ci.yml's push trigger gains a paths filter": ("shape", lambda w, o: _on(w)["push"].update(paths=["src/**"]), CI),
    "ci.yml loses its dev push": ("shape", lambda w, o: _on(w).pop("push"), CI),
    "ci.yml loses pull_request": ("shape", lambda w, o: _on(w).pop("pull_request"), CI),
    "ci.yml's pull_request narrows": ("shape", lambda w, o: _on(w)["pull_request"]["branches"].remove("main"), CI),
    "ci.yml's concurrency group changes": ("shape", lambda w, o: w["concurrency"].update(group="ci-${{ github.sha }}"),
                                           CI),
    "ci.yml stops cancelling superseded runs": ("shape", lambda w, o: w["concurrency"].update(
        {"cancel-in-progress": False}), CI),
    "ci.yml loses its concurrency": ("shape", lambda w, o: w.pop("concurrency"), CI),
    "ci.yml's aggregator is renamed": ("shape", lambda w, o: w["jobs"].update(
        {"verdict": w["jobs"].pop(GATE)}), CI),
    "ci.yml's aggregator takes ci-next.yml's id": ("shape", lambda w, o: w["jobs"].update(
        {AGGREGATORS[NEXT]: w["jobs"].pop(GATE)}), CI),
    "ci.yml gains a job named integration-tests": ("shape", lambda w, o: w["jobs"].update(
        {"integration-tests": copy.deepcopy(w["jobs"]["pytest"])}), CI),
    "ci.yml is the single serial job again": ("shape", lambda w, o: w.update(jobs={GATE: {
        "runs-on": "ubuntu-24.04", "timeout-minutes": 90, "steps": _all_steps(w, CI)}}), CI),
    # shape: ci-next.yml's triggers and ids
    "the shadow comes back: ci-next.yml runs on dev pushes": ("shape", lambda w, o: _on(w)["push"]["branches"].insert(
        0, "dev"), NEXT),
    "ci-next.yml gains a pull_request trigger": ("shape", lambda w, o: _on(w).update(
        pull_request={"branches": ["dev"]}), NEXT),
    "ci-next.yml's push trigger widens": ("shape", lambda w, o: _on(w)["push"]["branches"].append("main"), NEXT),
    "ci-next.yml loses its soak branch": ("shape", lambda w, o: _on(w).pop("push"), NEXT),
    "the dispatch gains a second input": ("shape", lambda w, o: _on(w)["workflow_dispatch"]["inputs"].update(
        skip_leg={"type": "string"}), NEXT),
    "the dispatch input is renamed": ("shape", lambda w, o: _on(w)["workflow_dispatch"].update(
        inputs={"red_leg": {"type": "string", "default": ""}}), NEXT),
    "the dispatch input gains a default leg": ("shape", lambda w, o: _on(w)["workflow_dispatch"]["inputs"][
        "canary_red_leg"].update(default="static"), NEXT),
    "a ci-next.yml leg takes a name the promote reads": ("shape", lambda w, o: w["jobs"].update(
        {"integration-tests": w["jobs"].pop("static")}), NEXT),
    "ci-next.yml's aggregator takes the name the promote reads": ("shape", lambda w, o: w["jobs"].update(
        {GATE: w["jobs"].pop(AGGREGATORS[NEXT])}), NEXT),
    # handoffs: each of these is mirrored correctly as far as mirror, once and setup can tell
    "a step that writes GITHUB_ENV is added to both files": ("handoffs", lambda w, o: _add_to_both(
        w, o, {"name": "More heap", "run": 'echo "NODE_OPTIONS=--max-old-space-size=8192" >> "$GITHUB_ENV"'}), BOTH),
    "a step that writes GITHUB_PATH is added to both files": ("handoffs", lambda w, o: _add_to_both(
        w, o, {"name": "Tool on PATH", "run": 'echo "$HOME/bin" >> "$GITHUB_PATH"'}), BOTH),
    "an apt-get install is added to both files": ("handoffs", lambda w, o: _add_to_both(
        w, o, {"name": "Fonts", "run": "sudo apt-get install -y fonts-roboto"}), BOTH),
    "a pip install is added to both files": ("handoffs", lambda w, o: _add_to_both(
        w, o, {"name": "Deps", "run": "pip install --quiet psycopg"}), BOTH),
    "a python3 -m pip install is added to both files": ("handoffs", lambda w, o: _add_to_both(
        w, o, {"name": "Deps", "run": "python3 -m pip install --quiet psycopg"}), BOTH),
    "an npm install -g is added to both files": ("handoffs", lambda w, o: _add_to_both(
        w, o, {"name": "Global tool", "run": "npm install -g some-cli"}), BOTH),
    "an npm i --global is added to both files": ("handoffs", lambda w, o: _add_to_both(
        w, o, {"name": "Global tool", "run": "npm i some-cli --global"}), BOTH),
    "an action is added to both files": ("handoffs", lambda w, o: _add_to_both(
        w, o, {"uses": "actions/setup-python@v5", "with": {"python-version": "3.12"}}), BOTH),
    "a listed hand-off step is renamed in both files": ("handoffs", lambda w, o: _to_both(w, o, lambda f: [
        s.update(name="Resolve Chrome") for leg in GATE_LEGS for s in _steps(f, leg) if _kind(s) == "chrome"]), BOTH),
    # trial: the key, and each way it can drift
    "the trial key leaves the UTC pass": ("trial", lambda w, o: _pass(w, "unit-utc-cov").pop("env")),
    "the trial key leaves the NY pass": ("trial", lambda w, o: _pass(w, "unit-ny")["env"].pop(TRIAL_KEY)),
    "the trial key leaves both passes of both files": ("trial", lambda w, o: _to_both(w, o, lambda f: [
        _pass(f, leg)["env"].pop(TRIAL_KEY) for leg in TRIAL_STEPS]), BOTH),
    "the trial key's value changes": ("trial", lambda w, o: _pass(w, "unit-ny")["env"].update({TRIAL_KEY: "0"})),
    "the trial key's value is true": ("trial", lambda w, o: _pass(w, "unit-utc-cov")["env"].update(
        {TRIAL_KEY: "true"})),
    "the trial key's value is an unquoted 1": ("trial", lambda w, o: _pass(w, "unit-utc-cov")["env"].update(
        {TRIAL_KEY: 1})),
    "the trial key's value is an unquoted 1 in both files": ("trial", lambda w, o: _to_both(
        w, o, lambda f: _pass(f, "unit-utc-cov")["env"].update({TRIAL_KEY: 1})), BOTH),
    "the trial key is misspelled": ("trial", lambda w, o: _pass(w, "unit-ny")["env"].update(
        {TRIAL_KEY + "S": _pass(w, "unit-ny")["env"].pop(TRIAL_KEY)})),
    "a third step takes the trial key": ("trial", lambda w, o: _gate(w)["env"].update({TRIAL_KEY: "1"})),
    "a third step takes the trial key in both files": ("trial", lambda w, o: _to_both(
        w, o, lambda f: _gate(f)["env"].update({TRIAL_KEY: "1"})), BOTH),
    "the TZ sentinel takes the trial key": ("trial", lambda w, o: _own(w, "unit-ny", SENTINEL)["env"].update(
        {TRIAL_KEY: "1"})),
    "the trial key moves from a unit step to its leg's env": ("trial", lambda w, o: w["jobs"]["unit-ny"].update(
        env={TRIAL_KEY: _pass(w, "unit-ny")["env"].pop(TRIAL_KEY)})),
    "the trial key is also set for the whole workflow": ("trial", lambda w, o: w.update(env={TRIAL_KEY: "1"})),
    "a step also sets the trial key inside its run": ("trial", lambda w, o: _gate(w).update(
        run="export %s=1\n%s" % (TRIAL_KEY, _gate(w)["run"]))),
    "a unit pass is renamed in both files": ("trial", lambda w, o: _to_both(
        w, o, lambda f: _pass(f, "unit-utc-cov").update(name="Unit tests")), BOTH),
    "a third unit pass is added to both files": ("trial", lambda w, o: _add_to_both(
        w, o, {"name": "A third pass", "run": "npx vitest run --no-coverage"}, leg="unit-ny"), BOTH),
}


def _mutation_cases():
    for name, entry in MUTATIONS.items():
        check, mutate, where = entry if len(entry) == 3 else entry + (None,)
        for target in ((CI, NEXT) if where is None else (CI,) if where == BOTH else (where,)):
            yield pytest.param(check, mutate, target, id="%s [%s]" % (name, BOTH if where == BOTH else target))


@pytest.mark.parametrize("check,mutate,target", list(_mutation_cases()))
def test_every_kind_of_drift_is_reported_by_the_check_that_owns_it(check, mutate, target):
    """A check that cannot fail holds nothing: each of these, made in memory, must be reported. `target` is the
    file the mutation is made in (ci.yml for one made in both)."""
    ci, nxt = copy.deepcopy(_both())
    if CHECKS[check](ci, nxt):
        pytest.skip("the tree as committed fails `%s`; test_ci_and_ci_next_hold[%s] says how" % (check, check))
    before = repr([ci, nxt])
    mutate(*((ci, nxt) if target == CI else (nxt, ci)))
    assert repr([ci, nxt]) != before, "the mutation changed nothing: fix the mutation"
    assert CHECKS[check](ci, nxt) != []


def test_the_mutations_reach_every_check_in_the_gating_file():
    """Every check is shown to fail on a change made to ci.yml alone or to both files alike, never only on a change
    to the non-gating copy (mirror aside, which is about the copy)."""
    reached = {check for check, _, target in (case.values for case in _mutation_cases()) if target == CI}
    assert reached == set(CHECKS)


def test_an_ordinary_new_check_mirrored_in_one_leg_passes_every_check():
    """The pins above must not turn "add a check to CI" into a puzzle: a new step that hands nothing on, added to
    the same leg of both files, is green everywhere. (`npm install --dry-run` is the near miss for the hand-off
    pattern: an install that writes nothing.)"""
    ci, nxt = copy.deepcopy(_both())
    if any(check(ci, nxt) for check in CHECKS.values()):
        pytest.skip("the tree as committed fails a check; test_ci_and_ci_next_hold says which and how")
    _add_to_both(ci, nxt, {"name": "A new check",
                           "run": "npm run check:new && npm install --dry-run --package-lock-only"})
    _add_to_both(ci, nxt, {"name": "A new script check", "run": "python3 scripts/check-something.py"}, leg="static")
    _add_to_both(ci, nxt, {"name": "A new gate", "env": {"GATE_CHROME_FLAGS": "--headless=new"},
                           "run": "npm run gate:new"}, leg="gates-b")
    assert [found for check in CHECKS.values() for found in check(ci, nxt)] == []


CONCURRENCY_MUTATIONS = {
    "ci-next shares ci.yml's group": lambda w: w[NEXT]["concurrency"].update(group=w[CI]["concurrency"]["group"]),
    "ci-next shares another file's group, as a bare string": lambda w: w[NEXT].update(
        concurrency=w["integration-test.yml"]["concurrency"]["group"]),
    "ci-next has no group": lambda w: w[NEXT].pop("concurrency"),
    "ci-next's group is not its own name": lambda w: w[NEXT]["concurrency"].update(group="shadow-${{ github.ref }}"),
    "a job in another file takes ci-next's group": lambda w: next(iter(w["schema-audit.yml"]["jobs"].values())).update(
        concurrency={"group": w[NEXT]["concurrency"]["group"]}),
    "a job in ci-next takes ci.yml's group": lambda w: w[NEXT]["jobs"]["static"].update(
        concurrency=w[CI]["concurrency"]["group"]),
}


@pytest.mark.parametrize("name", list(CONCURRENCY_MUTATIONS))
def test_a_shared_or_missing_concurrency_group_is_reported(name):
    workflows = copy.deepcopy(_all_workflows())
    CONCURRENCY_MUTATIONS[name](workflows)
    assert concurrency(workflows) != []
