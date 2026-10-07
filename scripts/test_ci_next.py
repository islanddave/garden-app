"""ci-next.yml, the parallel shadow of ci.yml's `build-and-test`, held to ci.yml and to its own shape.

Run: python3 -m pytest -q scripts/test_ci_next.py

ci-next.yml splits the serial job's steps into parallel legs behind one aggregator job, `build-and-test-next`. It
gates nothing while it is a shadow, and this file is what makes that safe to believe: it runs in ci.yml's own pytest
step, so from the day ci-next.yml lands until the legs replace the serial job, "ci.yml's steps == ci-next's legs" is
a GATING test. A lane that adds, edits or removes a CI step changes it in both files in the same commit, or this
reds the dev push.

Eight things are held, each by a function that returns the problems it found (so the mutations at the end can show
every one of them is able to fail):

  conservation  every ci.yml step is in exactly one leg as the same WHOLE mapping (name, run, env, uses, with and
                any other key, so a step-level `if:` or `continue-on-error` is a difference). Five setup steps may
                repeat, one copy per leg that needs it: checkout, setup-node, npm ci, Chrome resolve, the
                origin/main fetch. ONE difference is admitted, the trial's, and only in the form `trial` holds.
  trial         the A3 trial: ci-next.yml's two unit steps carry env VITEST_NODE_PROJECT: '1' and ci.yml's same two
                do not, so the legs run the DOM-free test files in vitest's `node` project (vitest.config.ts) while
                the serial job stays jsdom-everything, and the shadow's test-ID comparison is between the two
                shapes. That key, that value, on those two steps; nowhere else in either file (an env at any level,
                or the key written into a run: body).
  order         a leg runs its steps in ci.yml's order.
  own_steps     the only steps ci-next.yml adds are one canary per leg, the PyYAML install and the TZ sentinel.
  setup         each leg has what the serial job handed its steps implicitly: checkout first; node 20.19.0 and
                node_modules for steps that run node (and neither for pytest, as in ci.yml); CHROME_PATH for the
                real-Chrome gates; origin/main for the release-version guard; PyYAML for gate_runner.py; and the
                two artefact chains kept whole (dist/, coverage/coverage-summary.json).
  shape         triggers, the one dispatch input, permissions, and the job graph: no continue-on-error, no `if:` on
                a leg, no matrix, ubuntu-24.04 and a timeout everywhere, and an aggregator that needs every other
                job, runs `always()`, and pins the same list in its step. ci.yml is held ABOVE step level too: one
                job, and no workflow or job key beyond today's, because whatever the serial job or its workflow
                gives every step (an env, a default shell, a service) is something no leg has.
  handoffs      a ci.yml step that hands something on through the runner (an action, a GITHUB_ENV or GITHUB_PATH
                write, an apt-get / pip / npm -g install) is named in HANDOFFS with the legs that need it. A new
                one is red until it is repeated where it is consumed and listed. Hand-offs through FILES are not
                visible here beyond the two chains under `setup`; the shadow's two verdicts are what catch those.
  concurrency   no two workflow files share a concurrency group. Groups are repository-wide: a shadow that shared
                ci.yml's would cancel it on every push.

Then the bodies this file introduces are executed the way GitHub's runner executes them: `bash -e` on a FILE holding
the body (as scripts/test_workflow_steps.py does; never `bash -c`). The aggregator runs against `needs` fixtures: a
leg that failed, was cancelled (which is how a timed-out leg reads) or was skipped, a leg missing from `needs`, a
job nobody pinned, and a context that is not JSON must each end it non-zero.
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
SERIAL_JOB = "build-and-test"
AGGREGATOR = "build-and-test-next"
LEGS = ("static", "pytest", "unit-utc-cov", "unit-ny", "gates-a", "gates-b", "gates-c", "gate-probes")
GATE_LEGS = ("gates-a", "gates-b", "gates-c", "gate-probes")
RESERVED_JOB_IDS = {"build-and-test", "integration-tests", "smoke-tests"}  # what promote-gate.yml reads by name
CANARY = "Canary — force this leg red (workflow_dispatch input canary_red_leg only)"
PYYAML = "Install PyYAML for the migration gate validation"
SENTINEL = "TZ sentinel — America/New_York resolves on this runner"
OWN = (CANARY, PYYAML, SENTINEL)
# THE A3 TRIAL: the one difference admitted between a ci.yml step and its leg. The two unit steps of ci-next.yml
# carry this env key at this value; ci.yml's same two steps do not. vitest.config.ts reads it and runs the test files
# that need no DOM in a `node` project, so each dev push compares that shape with ci.yml's jsdom-everything by test ID
# (scripts/ci-telemetry/shadow-agree.py). `_as_ci_writes_it` takes exactly this off before a leg step is compared
# with ci.yml's, and `trial` holds that it is on both unit steps and nowhere else. When the trial ends (the projects
# become unconditional and the key leaves the steps), all of this goes with it.
TRIAL_KEY, TRIAL_VALUE = "VITEST_NODE_PROJECT", "1"
TRIAL_STEPS = {"unit-utc-cov": "Run unit tests with coverage",
               "unit-ny": "Unit tests under America/New_York TZ (date-fragility guard)"}
UNIT_PASS = re.compile(r"(?:npm test|npx vitest run)\b")  # matched at the start of a ci.yml step's run
TRIAL_RULE = ("the A3 trial admits ONE difference between the two files: env %s: '%s' (a quoted string) on "
              "ci-next.yml's two unit steps, %r in unit-utc-cov and %r in unit-ny, and nowhere else in either file. "
              "ci.yml stays jsdom-everything, so the shadow's test-ID comparison is between the two shapes"
              % (TRIAL_KEY, TRIAL_VALUE, TRIAL_STEPS["unit-utc-cov"], TRIAL_STEPS["unit-ny"]))
# Every tracked file that names the key. `trial` reads the two workflow files; the key set anywhere else (the `test`
# script of package.json is the short way) would switch ci.yml's passes too with nothing in a workflow changing.
TRIAL_KEY_FILES = [".github/workflows/ci-next.yml", "scripts/ci-telemetry/vitest-projects.test.js",
                   "scripts/test_ci_next.py", "vitest.config.ts"]
REPEATABLE =("checkout", "setup-node", "npm-ci", "chrome", "fetch-main")
NODE_PIN = {"node-version": "20.19.0", "cache": "npm"}
DRY_RUN = "npm install --dry-run --package-lock-only"
NODE_COMMAND = re.compile(r"(?:^|[\s;&|(])(?:npm|npx|node)\s")
NODE_BY_NAME = {"Dependency audit (blocking on moderate, WS-B M6)"}  # audit-gate.py shells out to `npm audit`
PIP_PYYAML = re.compile(r"pip install[^\n|&]*\bpyyaml\b")
NY = "America/New_York"
WORKFLOW_KEYS = {"name", "on", "permissions", "concurrency", "jobs"}
SERIAL_JOB_KEYS = {"runs-on", "timeout-minutes", "steps"}
ABOVE_STEPS = ("anything the serial job or its workflow gives every step (an env, a default shell, a service, a "
               "container, a second job) is something no ci-next.yml leg has: give it to the legs that need it in "
               ".github/workflows/ci-next.yml, then widen this pin in scripts/test_ci_next.py")
# A ci.yml step that hands something to LATER steps through the runner rather than through a file. In the serial job
# every later step gets it; in ci-next.yml only the leg that holds the step does. Each one is named here (an action
# by its name without the pin) with the legs that need what it hands on.
HANDOFF = re.compile(r"GITHUB_ENV|GITHUB_PATH|\bapt-get\b|\bapt\s+install\b|\bpip3?\s+install\b"
                     r"|\bnpm\s+(?:i|install)\b[^\n;&|]*\s(?:-g|--global)\b")
HANDOFFS = {
    "actions/checkout": "the working tree: repeated in every leg",
    "actions/setup-node": "node 20.19.0 on PATH: repeated in every leg that runs node (all but pytest)",
    "Python script tests (pytest)": "pip installs pytest, requests, boto3, pyyaml: the pytest leg runs this step; "
                                    "static, where gate_runner.py needs PyYAML, has its own install step",
    "Resolve Chrome for the layout gates": "writes CHROME_PATH to GITHUB_ENV: repeated in gates-a, gates-b, gates-c "
                                           "and gate-probes",
    "Photo-tier payload budget (BUG-TIERLESSPHOTOS-001)": "pip installs pillow for its own gate only: gates-a",
}
NEW_HANDOFF = ("ci.yml step %r hands something to later steps through the runner (it uses an action, writes GITHUB_ENV "
               "or GITHUB_PATH, or installs with apt-get, pip or npm -g). The serial job gives that to every later "
               "step; in .github/workflows/ci-next.yml only the leg holding the step has it. A new hand-off must be "
               "repeated in every leg that consumes it, then added to HANDOFFS in scripts/test_ci_next.py with the "
               "legs that need it")
# The three bodies ci-next.yml adds, as written there. Changing one means changing it here in the same commit, which
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


def _on(workflow):
    return workflow.get("on", workflow.get(True))  # PyYAML reads the bare key `on` as True


def _keys(workflow):
    return {"on" if key is True else key for key in workflow}  # PyYAML reads the bare key `on` as True


def _serial(ci):
    return ci["jobs"][SERIAL_JOB]["steps"]


def _legs(nxt):
    return {job_id: job for job_id, job in nxt["jobs"].items() if job_id != AGGREGATOR}


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


def _as_ci_writes_it(step):
    """A leg step with the trial's key taken off, where it is exactly the admitted difference: TRIAL_KEY at
    TRIAL_VALUE in the env of a step named in TRIAL_STEPS. Under any other name, at any other value (an unquoted 1
    included) or by any other spelling the step comes back untouched, and conservation reports it as not ci.yml's."""
    env = step.get("env")
    if step.get("name") not in TRIAL_STEPS.values() or not isinstance(env, dict) or env.get(TRIAL_KEY) != TRIAL_VALUE:
        return step
    out = {key: value for key, value in step.items() if key != "env"}
    rest = {key: value for key, value in env.items() if key != TRIAL_KEY}
    if rest:
        out["env"] = rest
    return out


def _mirrored(job):
    """A leg's steps that must be ci.yml's: everything except the three kinds of step ci-next.yml adds, each as
    ci.yml writes it (the trial's one key off)."""
    return [_as_ci_writes_it(s) for s in job["steps"] if s.get("name") not in OWN]


def _conserved(job):
    """A leg's ci.yml steps that are not repeatable setup: the checks the leg exists to run."""
    return [s for s in _mirrored(job) if _kind(s) not in REPEATABLE]


def _uses_node(step):
    return bool(NODE_COMMAND.search(step.get("run") or "")) or step.get("name") in NODE_BY_NAME


def _chrome_gate(step):
    return "GATE_CHROME_FLAGS" in (step.get("env") or {})


def _has_key(node, key):
    if isinstance(node, dict):
        return key in node or any(_has_key(v, key) for v in node.values())
    return isinstance(node, list) and any(_has_key(v, key) for v in node)


# ── conservation ────────────────────────────────────────────────────────────────────────────────────────────────

def conservation(ci, nxt):
    want = collections.Counter(_canon(s) for s in _serial(ci))
    have = collections.Counter(_canon(s) for job in _legs(nxt).values() for s in _mirrored(job))
    out = []
    for key, count in want.items():
        step = json.loads(key)
        if count != 1:
            out.append("ci.yml carries %r %d times; this comparison needs each step once" % (_label(step), count))
        elif _kind(step) in REPEATABLE:
            if not have[key]:
                out.append("setup step %r is in no leg" % _label(step))
        elif have[key] != 1:
            out.append("ci.yml step %r is in %d legs of ci-next.yml, want exactly 1: add it to the leg it belongs "
                       "in, written as in ci.yml (or remove the extra copy)" % (_label(step), have[key]))
    out += ["a leg runs %r, which is not a ci.yml %s step as written there (name, run, env, uses, with or another "
            "key differs)" % (_label(json.loads(key)), SERIAL_JOB) for key in have if key not in want]
    return out


def trial(ci, nxt):
    out = []
    passes = [_label(s) for s in _serial(ci) if UNIT_PASS.match(s.get("run") or "")]
    if passes != list(TRIAL_STEPS.values()):
        out.append("ci.yml's unit passes (a run: that starts `npm test` or `npx vitest run`) are %s, and the trial is "
                   "pinned to %s. A pass that is renamed, added or removed changes TRIAL_STEPS in "
                   "scripts/test_ci_next.py in the same commit (and PASS_STEPS in scripts/ci-telemetry/shadow-agree.py, "
                   "which reads each pass's test IDs by its step name): %s"
                   % (passes, list(TRIAL_STEPS.values()), TRIAL_RULE))
    if TRIAL_KEY in json.dumps(ci, default=str):
        out.append("ci.yml names %s. The serial job is the jsdom-everything side of the comparison: with the key on "
                   "it both sides run the same shape and equal test IDs prove nothing. Take it out of ci.yml: %s"
                   % (TRIAL_KEY, TRIAL_RULE))
    for leg, name in TRIAL_STEPS.items():
        steps = [s for s in ((nxt.get("jobs") or {}).get(leg) or {}).get("steps") or [] if s.get("name") == name]
        envs = [s.get("env") for s in steps]
        if len(steps) != 1 or not isinstance(envs[0], dict) or envs[0].get(TRIAL_KEY) != TRIAL_VALUE:
            out.append("ci-next.yml leg %s: step %r is there %d time(s) with env %s; want it once, with %s: '%s' in "
                       "its env. Without the key that leg runs jsdom-everything, the same shape as ci.yml, and its "
                       "test IDs match for the wrong reason: %s"
                       % (leg, name, len(steps), json.dumps(envs, default=str), TRIAL_KEY, TRIAL_VALUE, TRIAL_RULE))
    count = json.dumps(nxt, default=str).count(TRIAL_KEY)
    if count != len(TRIAL_STEPS):
        out.append("ci-next.yml names %s %d time(s), want exactly %d, one in the env of each unit step. A job-level "
                   "or workflow-level env, a third step, or the key written into a run: body is outside the trial: %s"
                   % (TRIAL_KEY, count, len(TRIAL_STEPS), TRIAL_RULE))
    return out


def order(ci, nxt):
    position = {_canon(s): i for i, s in enumerate(_serial(ci))}
    out = []
    for leg, job in _legs(nxt).items():
        seen = [position[_canon(s)] for s in _mirrored(job) if _canon(s) in position]
        if seen != sorted(seen):
            out.append("%s does not run its steps in ci.yml's order" % leg)
    return out


# ── the steps ci-next.yml adds ──────────────────────────────────────────────────────────────────────────────────

def own_steps(ci, nxt):
    out = []
    for leg, job in _legs(nxt).items():
        steps = job["steps"]
        canaries = [s for s in steps if s.get("name") == CANARY]
        if len(canaries) != 1 or steps[0].get("name") != CANARY:
            out.append("%s: want exactly one canary step, first" % leg)
        for canary in canaries:
            if set(canary) != {"name", "if", "run"} or canary.get("if") != "inputs.canary_red_leg == '%s'" % leg:
                out.append("%s: its canary is not keyed to this leg alone (if: %r, keys %s)"
                           % (leg, canary.get("if"), sorted(canary)))
            if canary.get("run") != CANARY_RUN % leg:
                out.append("%s: its canary's body is not CANARY_RUN as pinned in scripts/test_ci_next.py" % leg)
        for i, step in enumerate(steps):
            if "if" in step and step.get("name") != CANARY:
                out.append("%s: step %r carries an if:" % (leg, _label(step)))
            if step.get("name") != CANARY and INPUTS_CONTEXT.search(_canon(step)):
                out.append("%s: step %r reads the inputs context; only a canary's if: may" % (leg, _label(step)))
            if step.get("name") == PYYAML and (set(step) != {"name", "run"} or not any(
                    "gate_runner.py" in (s.get("run") or "") for s in steps[i:])):
                out.append("%s: the PyYAML install wants a name and a run only, and a gate_runner.py step after it"
                           % leg)
            for name, body in ((PYYAML, PYYAML_RUN), (SENTINEL, SENTINEL_RUN)):
                if step.get("name") == name and step.get("run") != body:
                    out.append("%s: the body of %r is not the one pinned in scripts/test_ci_next.py" % (leg, name))
            if step.get("name") == SENTINEL:
                after = steps[i + 1] if i + 1 < len(steps) else {}
                zone = (after.get("env") or {}).get("TZ")
                if not zone or step.get("env") != {"TZ": zone} or set(step) != {"name", "env", "run"}:
                    out.append("%s: the TZ sentinel is not directly before a step with its own TZ" % leg)
        for name in (PYYAML, SENTINEL):
            if sum(s.get("name") == name for s in steps) > 1:
                out.append("%s: %r appears more than once" % (leg, name))
    return out


# ── what the serial job handed each step implicitly ─────────────────────────────────────────────────────────────

def setup(ci, nxt):
    out = []
    for leg, job in _legs(nxt).items():
        steps = job["steps"]
        kinds = [_kind(s) for s in steps]

        def at(kind):
            return [i for i, k in enumerate(kinds) if k == kind]

        def before(kind, users, what):
            if not users:
                if at(kind):
                    out.append("%s: has %s and no step that needs it (ci.yml's step would not have had it)"
                               % (leg, what))
            elif len(at(kind)) != 1 or at(kind)[0] > min(users):
                out.append("%s: needs exactly one %s, before %r" % (leg, what, _label(steps[min(users)])))

        rest = [i for i, s in enumerate(steps) if s.get("name") != CANARY]
        if len(at("checkout")) != 1 or not rest or kinds[rest[0]] != "checkout":
            out.append("%s: wants exactly one checkout, as its first step after the canary" % leg)
        node_users = [i for i, s in enumerate(steps) if _uses_node(s) and kinds[i] != "npm-ci"]
        before("setup-node", node_users, "setup-node")
        for i in at("setup-node"):
            if steps[i].get("with") != NODE_PIN:
                out.append("%s: setup-node is not pinned %s" % (leg, NODE_PIN))
        if not node_users:
            if at("npm-ci"):
                out.append("%s: has npm ci and no step that runs node (ci.yml's step would not have had it)" % leg)
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
    everything = [s for job in _legs(nxt).values() for s in job["steps"]]
    for name, steps in ((CI, _serial(ci)), (NEXT, everything)):
        zones = [s["env"]["TZ"] for s in steps if "TZ" in (s.get("env") or {}) and s.get("name") != SENTINEL]
        if zones != [NY]:
            out.append("%s: want exactly one step that sets TZ, and to %s (the app's own zone, and the one the "
                       "sentinel proves resolved); found %s" % (name, NY, zones))
    if [(s.get("env") or {}).get("TZ") for s in everything if s.get("name") == SENTINEL] != [NY]:
        out.append("%s: want exactly one TZ sentinel, with TZ %s" % (NEXT, NY))
    for artefact, links in CHAINS.items():
        if any(sum(1 for s in _serial(ci) if link(s)) != 1 for link in links):
            out.append("the %s chain no longer matches one ci.yml step per link: update CHAINS" % artefact)
            continue
        found = [(leg, i) for link in links for leg, job in _legs(nxt).items()
                 for i, s in enumerate(job["steps"]) if link(s)]
        if len(found) != len(links) or len({leg for leg, _ in found}) != 1 or found != sorted(found):
            out.append("the steps that write and read %s are not in one leg, in order: %s" % (artefact, found))
    return out


# ── triggers and the job graph ──────────────────────────────────────────────────────────────────────────────────

def _pinned_legs(job):
    steps = job.get("steps") or [{}]
    found = re.findall(r'^EXPECTED_LEGS="([^"]*)"$', steps[0].get("run") or "", re.M)
    return found[0].split() if len(found) == 1 else None


def shape(ci, nxt):
    out = []
    if _keys(ci) != WORKFLOW_KEYS:
        out.append("ci.yml's workflow keys are %s, pinned as %s: %s"
                   % (sorted(_keys(ci)), sorted(WORKFLOW_KEYS), ABOVE_STEPS))
    if list(ci.get("jobs") or {}) != [SERIAL_JOB]:
        out.append("ci.yml's jobs are %s, pinned as [%s]: %s" % (list(ci.get("jobs") or {}), SERIAL_JOB, ABOVE_STEPS))
    serial = (ci.get("jobs") or {}).get(SERIAL_JOB) or {}
    if set(serial) != SERIAL_JOB_KEYS:
        out.append("ci.yml's %s has keys %s, pinned as %s: %s"
                   % (SERIAL_JOB, sorted(serial), sorted(SERIAL_JOB_KEYS), ABOVE_STEPS))
    if _keys(nxt) != WORKFLOW_KEYS:
        out.append("ci-next.yml's workflow keys are %s; an env or defaults block would change what every step runs "
                   "with" % sorted(_keys(nxt)))
    on = _on(nxt) or {}
    if set(on) != {"push", "workflow_dispatch"}:
        out.append("triggers are %s, want push and workflow_dispatch only (never pull_request)" % sorted(on))
    if (on.get("push") or {}) != {"branches": ["dev", "ci-next-soak"]}:
        out.append("push trigger is %r, want branches dev and ci-next-soak" % (on.get("push"),))
    inputs = (on.get("workflow_dispatch") or {}).get("inputs") or {}
    if list(inputs) != ["canary_red_leg"] or inputs["canary_red_leg"].get("default") != "" \
            or inputs["canary_red_leg"].get("type") != "string" or inputs["canary_red_leg"].get("required"):
        out.append("workflow_dispatch wants exactly one input, canary_red_leg: an optional string, empty by "
                   "default (found %s)" % json.dumps(inputs, sort_keys=True))
    if nxt.get("permissions") != {"contents": "read"} or nxt.get("permissions") != ci.get("permissions"):
        out.append("permissions are %r, want ci.yml's contents: read and no more" % (nxt.get("permissions"),))
    if _has_key(nxt, "continue-on-error"):
        out.append("continue-on-error appears: a job that fails under it reads `success` in needs")
    jobs = nxt.get("jobs") or {}
    legs = _legs(nxt)
    if tuple(legs) != LEGS or AGGREGATOR not in jobs:
        out.append("job ids are %s, want the legs %s and %s" % (list(jobs), list(LEGS), AGGREGATOR))
    if RESERVED_JOB_IDS & set(jobs):
        out.append("a job is named %s: promote-gate.yml reads that check-run name"
                   % sorted(RESERVED_JOB_IDS & set(jobs)))
    for job_id, job in jobs.items():
        if job.get("runs-on") != "ubuntu-24.04":
            out.append("%s runs on %r, want ubuntu-24.04" % (job_id, job.get("runs-on")))
        minutes = job.get("timeout-minutes")
        if not isinstance(minutes, int) or isinstance(minutes, bool) or minutes <= 0:
            out.append("%s has no timeout-minutes" % job_id)
    for leg, job in legs.items():
        extra = set(job) - {"runs-on", "timeout-minutes", "steps"}
        if extra:
            out.append("leg %s carries %s; a leg has runs-on, timeout-minutes and steps only (no if, needs, "
                       "strategy, name, uses or env)" % (leg, sorted(extra)))
    agg = jobs.get(AGGREGATOR) or {}
    if set(agg) != {"needs", "if", "runs-on", "timeout-minutes", "steps"}:
        out.append("%s has keys %s; want needs, if, runs-on, timeout-minutes and steps (no name, no uses)"
                   % (AGGREGATOR, sorted(agg)))
    needs = agg.get("needs")
    if sorted(needs if isinstance(needs, list) else [needs], key=str) != sorted(legs):
        out.append("%s needs %s, want every other job: %s" % (AGGREGATOR, needs, sorted(legs)))
    if agg.get("if") != "always()":
        out.append("%s has if: %r, want always()" % (AGGREGATOR, agg.get("if")))
    steps = agg.get("steps") or []
    if len(steps) != 1 or set(steps[0]) != {"name", "env", "run"} \
            or steps[0].get("env") != {"NEEDS": "${{ toJSON(needs) }}"}:
        out.append("%s wants ONE step: a run: that reads NEEDS = toJSON(needs) from env, no uses, no if"
                   % AGGREGATOR)
    pinned = _pinned_legs(agg)
    if pinned is None or sorted(pinned) != sorted(legs) or len(set(pinned)) != len(pinned):
        out.append("the list pinned in %s's step is %s, want the other job ids: %s"
                   % (AGGREGATOR, pinned, sorted(legs)))
    return out


# ── hand-offs through the runner ────────────────────────────────────────────────────────────────────────────────

def _handoff_key(step):
    return (step.get("uses") or "").split("@")[0] or step.get("name")


def _hands_on(step):
    return "uses" in step or bool(HANDOFF.search(step.get("run") or ""))


def handoffs(ci, nxt):
    found = [_handoff_key(s) for s in _serial(ci) if _hands_on(s)]
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

CHECKS = {"conservation": conservation, "trial": trial, "order": order, "own_steps": own_steps, "setup": setup,
          "shape": shape, "handoffs": handoffs}


@pytest.mark.parametrize("check", list(CHECKS.values()), ids=list(CHECKS))
def test_ci_next_holds(check):
    found = check(*_both())
    assert not found, (
        "ci.yml and .github/workflows/ci-next.yml disagree. ci-next.yml runs ci.yml's %s steps as parallel legs; its "
        "header says what it mirrors, what it adds and where each hand-off lives. A CI step changes in BOTH files in "
        "one commit (and scripts/ci-step-manifest.json is regenerated):\n  " % SERIAL_JOB) + "\n  ".join(found)


def test_no_two_workflow_files_share_a_concurrency_group():
    workflows = _all_workflows()
    groups = _groups(workflows)
    assert len(workflows) > 2 and len(groups) > 2, "scanned too little: the workflow glob or loader is broken"
    assert all(any(name in files for files in groups.values()) for name in (CI, NEXT))  # both were really read
    assert concurrency(workflows) == []


def test_the_comparison_reads_both_files_and_is_not_empty():
    ci, nxt = _both()
    assert len(_serial(ci)) > 30 and sum(len(_conserved(job)) for job in _legs(nxt).values()) > 30
    assert {_kind(s) for s in _serial(ci)} - {None} == set(REPEATABLE)  # every setup kind still names a ci.yml step
    assert all(any(_uses_node(s) for s in job["steps"]) for leg, job in _legs(nxt).items() if leg != "pytest")


def test_the_trial_key_is_taken_off_only_where_it_is_exactly_the_admitted_difference():
    """conservation compares what `_as_ci_writes_it` returns, so this is the whole of what the trial loosened: one
    key, at one value, under two step names. Everything else must come back as the same object."""
    utc, ny = TRIAL_STEPS["unit-utc-cov"], TRIAL_STEPS["unit-ny"]
    assert _as_ci_writes_it({"name": utc, "run": "npm test", "env": {TRIAL_KEY: "1"}}) == {
        "name": utc, "run": "npm test"}                                     # ci.yml's step has no env at all
    assert _as_ci_writes_it({"name": ny, "run": "x", "env": {"TZ": NY, TRIAL_KEY: "1"}}) == {
        "name": ny, "run": "x", "env": {"TZ": NY}}
    assert _as_ci_writes_it({"name": ny, "run": "x", "env": {TRIAL_KEY: "1", "ADDED": "1"}})["env"] == {"ADDED": "1"}
    for kept in (
            {"name": "Some other step", "run": "npm test", "env": {TRIAL_KEY: "1"}},     # not a unit step
            {"run": "npm test", "env": {TRIAL_KEY: "1"}},                                # no name
            {"name": utc, "run": "npm test", "env": {TRIAL_KEY: "0"}},
            {"name": utc, "run": "npm test", "env": {TRIAL_KEY: 1}},                     # unquoted in the YAML
            {"name": utc, "run": "npm test", "env": {TRIAL_KEY: True}},
            {"name": utc, "run": "npm test", "env": {TRIAL_KEY: ""}},
            {"name": utc, "run": "npm test", "env": {TRIAL_KEY + "S": "1"}},
            {"name": utc, "run": "npm test", "env": {TRIAL_KEY.lower(): "1"}},
            {"name": utc, "run": "npm test", "env": "%s=1" % TRIAL_KEY},
            {"name": utc, "run": "%s=1 npm test" % TRIAL_KEY},
            {"name": utc, "run": "npm test"},
    ):
        assert _as_ci_writes_it(kept) is kept, kept
    ci, nxt = _both()
    carrying = [s for job in _legs(nxt).values() for s in job["steps"] if _as_ci_writes_it(s) is not s]
    assert [s["name"] for s in carrying] == list(TRIAL_STEPS.values())       # today it changes two steps, these


def test_the_trial_key_is_named_by_four_tracked_files_and_not_by_package_json():
    """`trial` holds the key to two steps of one workflow file. This holds it out of everything else: an npm script
    that sets it (`"test": "VITEST_NODE_PROJECT=1 vitest run --coverage"`) switches ci.yml's own UTC pass, both
    sides of the shadow then run the two-project shape, and every test ID is equal for the wrong reason."""
    repo = os.path.join(HERE, "..")
    named = subprocess.run(["git", "-C", repo, "grep", "-l", "-F", TRIAL_KEY], capture_output=True, text=True)
    assert named.returncode == 0, "git grep found no tracked file naming %s: %r" % (TRIAL_KEY, named.stderr)
    with open(os.path.join(repo, "package.json"), encoding="utf-8") as fh:
        assert TRIAL_KEY not in fh.read(), (
            "package.json names %s. An npm script that sets the key switches every run of that script, ci.yml's "
            "unit pass included, and the serial job stops being the jsdom-everything side of the comparison. Take "
            "it out: %s" % (TRIAL_KEY, TRIAL_RULE))
    assert sorted(named.stdout.split()) == TRIAL_KEY_FILES, (
        "the tracked files that name %s are no longer the four the trial is made of (the config that reads it, the "
        "workflow that sets it, and the two tests that hold it). A file that SETS or READS the key elsewhere "
        "changes which runs are two-project: take it out. A file that only mentions it: reword it, or add it to "
        "TRIAL_KEY_FILES in scripts/test_ci_next.py in the same commit: %s" % (TRIAL_KEY, TRIAL_RULE))


def test_the_legs_hold_what_their_names_say():
    ci, nxt = _both()
    if conservation(ci, nxt):
        pytest.skip("a step is missing, extra or changed; test_ci_next_holds[conservation] says which and how")
    legs = {leg: [_label(s) for s in _conserved(job)] for leg, job in _legs(nxt).items()}

    def named(test, count, what):
        found = [_label(s) for s in _serial(ci) if test(s)]
        assert len(found) == count, (
            "ci.yml has %d step(s) that are %s, and this test expects %d: %s. It finds them by their command, so if "
            "a command or env changed, update the matcher in test_the_legs_hold_what_their_names_say; if the step was "
            "removed or one was added, change the count with it." % (len(found), what, count, found))
        return found

    def holds(leg, want, what):
        assert legs[leg] == want, (
            "leg `%s` of .github/workflows/ci-next.yml should hold exactly %s.\n  it holds: %s\n  want:     %s\n"
            "Move the step that differs to the leg it belongs in (the comment above each leg says what the leg is "
            "for). If the split itself is meant to change, change this test in the same commit."
            % (leg, what, legs[leg], want))

    gates = [_label(s) for s in _serial(ci) if _chrome_gate(s)]
    assert len(gates) > 10, (
        "only %d ci.yml steps carry env GATE_CHROME_FLAGS, which is how this test recognises a real-Chrome gate: "
        "update _chrome_gate in scripts/test_ci_next.py" % len(gates))
    in_gate_legs = sum((legs[leg] for leg in GATE_LEGS), [])
    assert sorted(in_gate_legs) == sorted(gates), (
        "the four gate legs of .github/workflows/ci-next.yml (%s) should hold every real-Chrome gate of ci.yml and "
        "no other step.\n  gates in no gate leg: %s\n  in a gate leg, not a gate: %s\nA new gate goes in gates-a or "
        "gates-b, whichever is shorter (page-scroll stays alone in gates-c; the Today V2 probe steps are "
        "gate-probes). A step that drives no browser goes in static."
        % (", ".join(GATE_LEGS), sorted(set(gates) - set(in_gate_legs)), sorted(set(in_gate_legs) - set(gates))))
    holds("gates-c", named(lambda s: s.get("run") == "npm run gate:page-scroll", 1, "`npm run gate:page-scroll`"),
          "the page-scroll gate, alone: it is the longest gate and the one that grows")
    holds("gate-probes", named(lambda s: "probe-nothing" in (s.get("run") or ""), 2, "gates that run a probe-nothing"),
          "the two Today V2 steps that run their gate and then its probe-nothing proof")
    holds("pytest", named(lambda s: "pytest -q scripts/test_*.py" in (s.get("run") or ""), 1, "the pytest run"),
          "the pytest step and nothing else (ci.yml runs it before setup-node and npm ci)")
    holds("unit-ny", named(lambda s: "TZ" in (s.get("env") or {}), 1, "run with an env TZ"),
          "the unit suite under TZ, behind its sentinel")
    holds("unit-utc-cov", named(lambda s: s.get("run") == "npm test" or "check-coverage-ratchet.py" in (
        s.get("run") or ""), 3, "`npm test` or a check-coverage-ratchet.py call"),
          "the coverage ratchet, `npm test`, and the measured floor that reads the coverage `npm test` wrote")


def test_the_file_is_lf_only_with_no_tabs():
    with open(os.path.join(WORKFLOWS, NEXT), "rb") as fh:
        raw = fh.read()
    assert b"\r" not in raw and b"\t" not in raw and raw.endswith(b"\n")


# ── the bodies ci-next.yml adds, run as the runner runs them ────────────────────────────────────────────────────

def _run_as_runner(tmp_path, body, env):
    """`bash -e` on a file, the runner's default for a step that declares no shell. shape and own_steps hold that
    none of the steps run here can declare one: their keys are pinned, and the workflow and jobs carry no defaults."""
    script = tmp_path / "step.sh"
    script.write_text(body)
    return subprocess.run(RUNNER_SHELL + [str(script)], cwd=tmp_path, env=env, capture_output=True, text=True)


def _errors(proc):
    return [ln.lstrip() for ln in (proc.stdout + "\n" + proc.stderr).splitlines() if ln.lstrip().startswith("::error")]


def _own(nxt, job_id, name):
    return next(s for s in nxt["jobs"][job_id]["steps"] if s.get("name") == name)


def test_the_harness_runs_with_errexit_on_like_the_runner(tmp_path):
    proc = _run_as_runner(tmp_path, "set -uo pipefail\nfalse\necho reached\n", dict(os.environ))
    assert proc.returncode == 1 and "reached" not in proc.stdout


def _aggregate(tmp_path, needs_json):
    step = _load(NEXT)["jobs"][AGGREGATOR]["steps"][0]
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


def test_aggregator_passes_when_every_pinned_leg_succeeded(tmp_path):
    proc = _aggregate(tmp_path, json.dumps(_needs(), indent=2))
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "all %d legs succeeded" % len(LEGS) in proc.stdout and _errors(proc) == []
    shuffled = dict(reversed(list(_needs().items())))  # key order is not part of the contract
    assert _aggregate(tmp_path, json.dumps(shuffled)).returncode == 0


@pytest.mark.parametrize("leg", LEGS)
@pytest.mark.parametrize("result", ["failure", "cancelled", "skipped"])
def test_aggregator_fails_when_any_leg_did_not_succeed(tmp_path, leg, result):
    """`cancelled` is what a timed-out leg reads as; `skipped` is a leg an `if:` or a failed need kept from running."""
    proc = _aggregate(tmp_path, json.dumps(_needs(**{leg: result})))
    assert proc.returncode == 1
    assert _errors(proc) and "%s=%s" % (leg, result) in _errors(proc)[0]


@pytest.mark.parametrize("leg", LEGS)
def test_aggregator_fails_when_a_pinned_leg_is_missing_from_needs(tmp_path, leg):
    proc = _aggregate(tmp_path, json.dumps(_needs(**{leg: None})))
    assert proc.returncode == 1 and "expected exactly" in _errors(proc)[0]


def test_aggregator_fails_on_a_job_nobody_pinned(tmp_path):
    needs = dict(_needs(), **{"gates-d": {"result": "success", "outputs": {}}})
    proc = _aggregate(tmp_path, json.dumps(needs))
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
def test_aggregator_fails_closed_on_anything_that_is_not_the_expected_context(tmp_path, needs_json):
    proc = _aggregate(tmp_path, needs_json)
    assert proc.returncode == 1, proc.stdout + proc.stderr
    assert len(_errors(proc)) == 1 and "Traceback" not in proc.stderr


def test_aggregator_takes_its_list_from_the_step_and_nowhere_else(tmp_path):
    """EXPECTED_LEGS set in the job's environment must not widen or narrow the pinned list."""
    step = _load(NEXT)["jobs"][AGGREGATOR]["steps"][0]
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
def test_tz_sentinel_passes_only_when_node_resolved_new_york(tmp_path, zone, want):
    assert shutil.which("node"), "node is required: the sentinel asks node what the zone resolved to"
    env = {k: v for k, v in os.environ.items() if k != "TZ"}
    if zone is not None:
        env["TZ"] = zone
    proc = _run_as_runner(tmp_path, _own(_load(NEXT), "unit-ny", SENTINEL)["run"], env)
    assert proc.returncode == want, proc.stdout + proc.stderr
    assert len(_errors(proc)) == want
    if want == 0:
        assert "resolved as America/New_York; minutes behind UTC: January 300, July 240" in proc.stdout


@pytest.mark.parametrize("plain_rc,fallback_rc,want_rc,want_calls", [
    (0, 0, 0, 1),        # the plain form works: one install
    (1, 0, 0, 2),        # a PEP-668 image: the fallback carries it
    (1, 1, 1, 2),        # neither installs: the leg stops here, not at gate_runner.py's "PyYAML is required"
])
def test_pyyaml_install_tries_the_plain_form_then_the_pep668_one(tmp_path, plain_rc, fallback_rc, want_rc, want_calls):
    bindir = tmp_path / "bin"
    bindir.mkdir()
    called = tmp_path / "called"
    stub = bindir / "python3"
    stub.write_text('#!/bin/sh\necho "$@" >> "%s"\ncase " $* " in *" --break-system-packages "*) exit %d ;; esac\n'
                    'exit %d\n' % (called, fallback_rc, plain_rc))
    stub.chmod(stub.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    env = dict(os.environ, PATH="%s:%s" % (bindir, os.environ["PATH"]))
    proc = _run_as_runner(tmp_path, _own(_load(NEXT), "static", PYYAML)["run"], env)
    calls = called.read_text().splitlines()
    assert (proc.returncode != 0) == bool(want_rc), proc.stderr
    assert len(calls) == want_calls and all(c.endswith(" pyyaml") and "pip install" in c for c in calls)
    assert "--break-system-packages" not in calls[0]


# ── every check can fail ────────────────────────────────────────────────────────────────────────────────────────
# Each mutation is applied to today's two files in memory and must be reported by the named check. `c` is ci.yml,
# `n` is ci-next.yml.

def _steps(nxt, leg):
    return nxt["jobs"][leg]["steps"]


def _find(nxt, leg, test):
    return next(i for i, s in enumerate(_steps(nxt, leg)) if test(s))


def _gate(nxt, leg="gates-a"):
    return _steps(nxt, leg)[_find(nxt, leg, _chrome_gate)]


def _drop(nxt, leg, test):
    _steps(nxt, leg).pop(_find(nxt, leg, test))


def _move(nxt, src, dst, test):
    _steps(nxt, dst).append(_steps(nxt, src).pop(_find(nxt, src, test)))


def _swap(steps, i, j):
    steps[i], steps[j] = steps[j], steps[i]


def _named(name):
    return lambda s: s.get("name") == name


def _kinded(kind):
    return lambda s: _kind(s) == kind


def _agg(nxt):
    return nxt["jobs"][AGGREGATOR]


def _repin(nxt, old, new):
    step = _agg(nxt)["steps"][0]
    step["run"] = step["run"].replace(old, new)


def _job(ci):
    return ci["jobs"][SERIAL_JOB]


def _add_to_both(ci, nxt, step, leg="static"):
    """A new step at the end of ci.yml, mirrored at the end of one leg: what a lane that knows the rule would do."""
    _serial(ci).append(copy.deepcopy(step))
    _steps(nxt, leg).append(copy.deepcopy(step))


def _edit_own(nxt, leg, name, old, new):
    step = _own(nxt, leg, name)
    step["run"] = step["run"].replace(old, new)
    assert new in step["run"]


def _rezone(ci, nxt, zone):
    for step in _serial(ci) + _steps(nxt, "unit-ny"):
        if "TZ" in (step.get("env") or {}):
            step["env"]["TZ"] = zone


def _pass(nxt, leg):
    """A unit leg's pass: the step the trial's key rides on."""
    return _steps(nxt, leg)[_find(nxt, leg, _named(TRIAL_STEPS[leg]))]


def _serial_pass(ci, leg):
    """ci.yml's copy of that leg's pass."""
    return next(s for s in _serial(ci) if s.get("name") == TRIAL_STEPS[leg])


MUTATIONS = {
    # conservation
    "a gate is dropped from its leg": ("conservation", lambda c, n: _drop(n, "gates-a", _chrome_gate)),
    "page-scroll is dropped": ("conservation", lambda c, n: _drop(n, "gates-c", _chrome_gate)),
    "a step runs in two legs": ("conservation", lambda c, n: _steps(n, "gates-b").append(copy.deepcopy(_gate(n)))),
    "a leg's run body gains a line": ("conservation", lambda c, n: _gate(n).update(run=_gate(n)["run"] + "\ntrue")),
    "a leg's run body loses its last character": ("conservation", lambda c, n: _gate(n).update(
        run=_gate(n)["run"][:-1])),
    "a leg's env value changes": ("conservation", lambda c, n: _gate(n)["env"].update(GATE_CHROME_FLAGS="")),
    "a leg's env gains a key": ("conservation", lambda c, n: _gate(n)["env"].update(ADDED_BY_TEST="1")),
    "a leg step is renamed": ("conservation", lambda c, n: _gate(n).update(name="renamed by the test")),
    "a leg step gains an if": ("conservation", lambda c, n: _gate(n).update({"if": "always()"})),
    "a leg step gains continue-on-error": ("conservation", lambda c, n: _gate(n).update({"continue-on-error": True})),
    "a leg step gains a timeout": ("conservation", lambda c, n: _gate(n).update({"timeout-minutes": 5})),
    "a leg step gains a shell": ("conservation", lambda c, n: _gate(n).update(shell="sh")),
    "a leg step gains a working-directory": ("conservation", lambda c, n: _gate(n).update(
        {"working-directory": "lambda"})),
    "a leg's checkout is repinned": ("conservation", lambda c, n: _steps(n, "pytest")[1].update(
        uses="actions/checkout@v0")),
    "a leg's setup-node moves off the pin": ("conservation", lambda c, n: _steps(n, "unit-ny")[
        _find(n, "unit-ny", _kinded("setup-node"))]["with"].update({"node-version": "22"})),
    "a leg adds a step ci.yml does not have": ("conservation", lambda c, n: _steps(n, "static").append(
        {"name": "added by the test", "run": "true"})),
    "ci.yml gains a step": ("conservation", lambda c, n: _serial(c).append(
        {"name": "added by the test", "run": "true"})),
    "ci.yml loses a step": ("conservation", lambda c, n: _serial(c).pop()),
    "ci.yml edits a step's body": ("conservation", lambda c, n: _serial(c)[-1].update(run=_serial(c)[-1]["run"] + " ")),
    "ci.yml edits a step's env": ("conservation", lambda c, n: next(
        s for s in _serial(c) if _chrome_gate(s))["env"].update(GATE_CHROME_FLAGS="--headless")),
    "ci.yml repins an action": ("conservation", lambda c, n: _serial(c)[0].update(uses="actions/checkout@v0")),
    "the origin/main fetch is in no leg": ("conservation", lambda c, n: _drop(n, "static", _kinded("fetch-main"))),
    # order
    "two steps swap inside a leg": ("order", lambda c, n: _swap(_steps(n, "gates-b"), -1, -2)),
    "npm ci moves ahead of setup-node": ("order", lambda c, n: _swap(
        _steps(n, "unit-ny"), _find(n, "unit-ny", _kinded("setup-node")), _find(n, "unit-ny", _kinded("npm-ci")))),
    "the build moves after the check that reads it": ("order", lambda c, n: _swap(
        _steps(n, "static"), _find(n, "static", CHAINS["dist/"][0]), _find(n, "static", CHAINS["dist/"][2]))),
    # own_steps
    "a leg loses its canary": ("own_steps", lambda c, n: _drop(n, "gates-c", _named(CANARY))),
    "a leg has two canaries": ("own_steps", lambda c, n: _steps(n, "pytest").append(
        copy.deepcopy(_steps(n, "pytest")[0]))),
    "a canary is keyed to another leg": ("own_steps", lambda c, n: _steps(n, "static")[0].update(
        {"if": "inputs.canary_red_leg == 'pytest'"})),
    "a canary fires on every run": ("own_steps", lambda c, n: _steps(n, "static")[0].pop("if")),
    "a canary fires unless named": ("own_steps", lambda c, n: _steps(n, "static")[0].update(
        {"if": "inputs.canary_red_leg != 'static'"})),
    "a canary is not the first step": ("own_steps", lambda c, n: _swap(_steps(n, "unit-ny"), 0, 1)),
    "a canary is made advisory": ("own_steps", lambda c, n: _steps(n, "static")[0].update({"continue-on-error": True})),
    "a second step reads the dispatch input": ("own_steps", lambda c, n: _steps(n, "static").append(
        {"name": "Canary two", "if": "inputs.canary_red_leg == 'static'", "run": "exit 1"})),
    "the PyYAML install is added where nothing needs it": ("own_steps", lambda c, n: _steps(n, "pytest").append(
        copy.deepcopy(_own(n, "static", PYYAML)))),
    "the TZ sentinel checks a different zone": ("own_steps", lambda c, n: _own(n, "unit-ny", SENTINEL)["env"].update(
        TZ="UTC")),
    "the TZ sentinel runs after the suite": ("own_steps", lambda c, n: _swap(_steps(n, "unit-ny"), -1, -2)),
    # setup
    "a leg loses its checkout": ("setup", lambda c, n: _drop(n, "gates-b", _kinded("checkout"))),
    "a leg loses setup-node": ("setup", lambda c, n: _drop(n, "gates-c", _kinded("setup-node"))),
    "a leg loses npm ci": ("setup", lambda c, n: _drop(n, "unit-utc-cov", _kinded("npm-ci"))),
    "a leg installs node twice": ("setup", lambda c, n: _steps(n, "gates-a").insert(
        3, copy.deepcopy(_steps(n, "gates-a")[_find(n, "gates-a", _kinded("setup-node"))]))),
    "setup-node is repinned in a leg": ("setup", lambda c, n: _steps(n, "gate-probes")[
        _find(n, "gate-probes", _kinded("setup-node"))].update({"with": {"node-version": "22", "cache": "npm"}})),
    "pytest gains setup-node": ("setup", lambda c, n: _steps(n, "pytest").insert(
        2, copy.deepcopy(_steps(n, "static")[_find(n, "static", _kinded("setup-node"))]))),
    "pytest gains npm ci": ("setup", lambda c, n: _steps(n, "pytest").insert(
        2, copy.deepcopy(_steps(n, "static")[_find(n, "static", _kinded("npm-ci"))]))),
    "the manifest dry-run moves after npm ci": ("setup", lambda c, n: _swap(
        _steps(n, "static"), _find(n, "static", lambda s: s.get("run") == DRY_RUN),
        _find(n, "static", _kinded("npm-ci")))),
    "a gate leg loses the Chrome resolve": ("setup", lambda c, n: _drop(n, "gate-probes", _kinded("chrome"))),
    "a leg with no gate resolves Chrome": ("setup", lambda c, n: _steps(n, "unit-ny").insert(
        4, copy.deepcopy(_steps(n, "gates-a")[_find(n, "gates-a", _kinded("chrome"))]))),
    "the release-version guard loses its fetch": ("setup", lambda c, n: _drop(n, "static", _kinded("fetch-main"))),
    "gate_runner.py loses its PyYAML": ("setup", lambda c, n: _drop(n, "static", _named(PYYAML))),
    "the NY suite loses its sentinel": ("setup", lambda c, n: _drop(n, "unit-ny", _named(SENTINEL))),
    "the chunk check leaves the build's leg": ("setup", lambda c, n: _move(n, "static", "unit-ny", CHAINS["dist/"][2])),
    "the measured floor leaves the coverage leg": ("setup", lambda c, n: _move(
        n, "unit-utc-cov", "unit-ny", CHAINS["coverage/coverage-summary.json"][1])),
    # shape
    "a leg gains continue-on-error": ("shape", lambda c, n: n["jobs"]["gates-a"].update({"continue-on-error": True})),
    "a leg gains an if": ("shape", lambda c, n: n["jobs"]["gates-a"].update({"if": "github.ref == 'refs/heads/dev'"})),
    "a leg gains a matrix": ("shape", lambda c, n: n["jobs"]["gates-a"].update(strategy={"matrix": {"n": [1, 2]}})),
    "a leg gains needs": ("shape", lambda c, n: n["jobs"]["gates-b"].update(needs=["gates-a"])),
    "a leg gains a name": ("shape", lambda c, n: n["jobs"]["static"].update(name="Static checks")),
    "a leg gains an env": ("shape", lambda c, n: n["jobs"]["static"].update(env={"ADDED_BY_TEST": "1"})),
    "a leg loses its timeout": ("shape", lambda c, n: n["jobs"]["unit-ny"].pop("timeout-minutes")),
    "a leg floats to ubuntu-latest": ("shape", lambda c, n: n["jobs"]["pytest"].update({"runs-on": "ubuntu-latest"})),
    "a leg takes a name the promote reads": ("shape", lambda c, n: n["jobs"].update(
        {"build-and-test": n["jobs"].pop("static")})),
    "a leg is added and nobody lists it": ("shape", lambda c, n: n["jobs"].update(
        {"gates-d": copy.deepcopy(n["jobs"]["gates-c"])})),
    "the aggregator drops a need": ("shape", lambda c, n: _agg(n)["needs"].remove("gates-c")),
    "the aggregator loses always()": ("shape", lambda c, n: _agg(n).pop("if")),
    "the aggregator runs only on success": ("shape", lambda c, n: _agg(n).update({"if": "success()"})),
    "the aggregator gains a name": ("shape", lambda c, n: _agg(n).update(name="build-and-test")),
    "the aggregator becomes a reusable-workflow call": ("shape", lambda c, n: _agg(n).update(
        uses="./.github/workflows/x.yml")),
    "the aggregator loses its timeout": ("shape", lambda c, n: _agg(n).pop("timeout-minutes")),
    "the aggregator is made advisory": ("shape", lambda c, n: _agg(n).update({"continue-on-error": True})),
    "the aggregator gains a second step": ("shape", lambda c, n: _agg(n)["steps"].append({"run": "true"})),
    "the aggregator's step gains an if": ("shape", lambda c, n: _agg(n)["steps"][0].update({"if": "failure()"})),
    "the aggregator's step uses an action": ("shape", lambda c, n: _agg(n)["steps"][0].update(
        uses="actions/checkout@v0")),
    "the aggregator reads something other than needs": ("shape", lambda c, n: _agg(n)["steps"][0]["env"].update(
        NEEDS="${{ toJSON(needs.static) }}")),
    "the pinned list loses a leg": ("shape", lambda c, n: _repin(n, " gates-c", "")),
    "the pinned list gains a leg": ("shape", lambda c, n: _repin(n, " gate-probes\"", " gate-probes gates-d\"")),
    "the pinned list is no longer one literal line": ("shape", lambda c, n: _repin(
        n, 'EXPECTED_LEGS="', 'EXPECTED_LEGS="$X ')),
    "a pull_request trigger is added": ("shape", lambda c, n: _on(n).update(pull_request={"branches": ["dev"]})),
    "the push trigger widens": ("shape", lambda c, n: _on(n)["push"]["branches"].append("main")),
    "the dispatch gains a second input": ("shape", lambda c, n: _on(n)["workflow_dispatch"]["inputs"].update(
        skip_leg={"type": "string"})),
    "the dispatch input is renamed": ("shape", lambda c, n: _on(n)["workflow_dispatch"].update(
        inputs={"red_leg": {"type": "string", "default": ""}})),
    "the dispatch input gains a default leg": ("shape", lambda c, n: _on(n)["workflow_dispatch"]["inputs"][
        "canary_red_leg"].update(default="static")),
    "permissions widen": ("shape", lambda c, n: n["permissions"].update(actions="read")),
    "permissions are dropped": ("shape", lambda c, n: n.pop("permissions")),
    "the workflow gains an env": ("shape", lambda c, n: n.update(env={"ADDED_BY_TEST": "1"})),
    "the workflow gains a default shell": ("shape", lambda c, n: n.update(defaults={"run": {"shell": "sh"}})),
    # shape, ci.yml above step level
    "ci.yml gains a second job": ("shape", lambda c, n: c["jobs"].update(
        extra={"runs-on": "ubuntu-latest", "steps": [{"run": "true"}]})),
    "ci.yml's job is renamed": ("shape", lambda c, n: c["jobs"].update(ci=c["jobs"].pop(SERIAL_JOB))),
    "ci.yml's job gains an env": ("shape", lambda c, n: _job(c).update(env={"NODE_OPTIONS": "--no-warnings"})),
    "ci.yml's job gains services": ("shape", lambda c, n: _job(c).update(services={"db": {"image": "postgres:17"}})),
    "ci.yml's job gains a container": ("shape", lambda c, n: _job(c).update(container="node:20")),
    "ci.yml's job gains a default shell": ("shape", lambda c, n: _job(c).update(defaults={"run": {"shell": "sh"}})),
    "ci.yml's job gains an if": ("shape", lambda c, n: _job(c).update({"if": "github.event_name == 'push'"})),
    "ci.yml's workflow gains an env": ("shape", lambda c, n: c.update(env={"TZ": "America/New_York"})),
    "ci.yml's workflow gains a default shell": ("shape", lambda c, n: c.update(defaults={"run": {"shell": "sh"}})),
    # own_steps, the bodies by text
    "the PyYAML install also writes GITHUB_ENV": ("own_steps", lambda c, n: _edit_own(
        n, "static", PYYAML, "pyyaml\n", 'pyyaml\necho "PIP_INDEX_URL=https://example.invalid" >> "$GITHUB_ENV"\n')),
    "a canary exits with another status": ("own_steps", lambda c, n: _edit_own(
        n, "gates-a", CANARY, "exit 1", "exit 2")),
    "a canary names another leg in its message": ("own_steps", lambda c, n: _edit_own(
        n, "gates-a", CANARY, "canary_red_leg=gates-a:", "canary_red_leg=gates-b:")),
    "the TZ sentinel's January offset changes": ("own_steps", lambda c, n: _edit_own(
        n, "unit-ny", SENTINEL, "jan !== 300", "jan !== 240")),
    "the TZ sentinel drops its offset comparison": ("own_steps", lambda c, n: _edit_own(
        n, "unit-ny", SENTINEL, " || jan !== 300 || jul !== 240", " ")),
    # setup, the zone itself
    "the NY suite moves to another zone in both files": ("setup", lambda c, n: _rezone(c, n, "America/Chicago")),
    "the NY suite loses its zone in both files": ("setup", lambda c, n: [
        s.pop("env") for s in _serial(c) + _steps(n, "unit-ny") if "TZ" in (s.get("env") or {})
        and s.get("name") != SENTINEL]),
    "a second step sets TZ in both files": ("setup", lambda c, n: _add_to_both(
        c, n, {"name": "added by the test", "env": {"TZ": "UTC"}, "run": "true"})),
    # handoffs: each of these is mirrored correctly as far as conservation, order and setup can tell
    "a step that writes GITHUB_ENV is added to both files": ("handoffs", lambda c, n: _add_to_both(
        c, n, {"name": "More heap", "run": 'echo "NODE_OPTIONS=--max-old-space-size=8192" >> "$GITHUB_ENV"'})),
    "a step that writes GITHUB_PATH is added to both files": ("handoffs", lambda c, n: _add_to_both(
        c, n, {"name": "Tool on PATH", "run": 'echo "$HOME/bin" >> "$GITHUB_PATH"'})),
    "an apt-get install is added to both files": ("handoffs", lambda c, n: _add_to_both(
        c, n, {"name": "Fonts", "run": "sudo apt-get install -y fonts-roboto"})),
    "a pip install is added to both files": ("handoffs", lambda c, n: _add_to_both(
        c, n, {"name": "Deps", "run": "pip install --quiet psycopg"})),
    "a python3 -m pip install is added to both files": ("handoffs", lambda c, n: _add_to_both(
        c, n, {"name": "Deps", "run": "python3 -m pip install --quiet psycopg"})),
    "an npm install -g is added to both files": ("handoffs", lambda c, n: _add_to_both(
        c, n, {"name": "Global tool", "run": "npm install -g some-cli"})),
    "an npm i --global is added to both files": ("handoffs", lambda c, n: _add_to_both(
        c, n, {"name": "Global tool", "run": "npm i some-cli --global"})),
    "an action is added to both files": ("handoffs", lambda c, n: _add_to_both(
        c, n, {"uses": "actions/setup-python@v5", "with": {"python-version": "3.12"}})),
    "a listed hand-off step is renamed in both files": ("handoffs", lambda c, n: [
        s.update(name="Resolve Chrome") for s in _serial(c) + sum((_steps(n, leg) for leg in GATE_LEGS), [])
        if _kind(s) == "chrome"]),
    # trial: the one admitted difference, and each way it can drift
    "the trial key leaves the UTC leg": ("trial", lambda c, n: _pass(n, "unit-utc-cov").pop("env")),
    "the trial key leaves the NY leg": ("trial", lambda c, n: _pass(n, "unit-ny")["env"].pop(TRIAL_KEY)),
    "the trial key's value changes": ("trial", lambda c, n: _pass(n, "unit-ny")["env"].update({TRIAL_KEY: "0"})),
    "the trial key's value is true": ("trial", lambda c, n: _pass(n, "unit-utc-cov")["env"].update(
        {TRIAL_KEY: "true"})),
    "the trial key's value is an unquoted 1": ("trial", lambda c, n: _pass(n, "unit-utc-cov")["env"].update(
        {TRIAL_KEY: 1})),
    "the trial key is misspelled on a leg": ("trial", lambda c, n: _pass(n, "unit-ny")["env"].update(
        {TRIAL_KEY + "S": _pass(n, "unit-ny")["env"].pop(TRIAL_KEY)})),
    "a third step takes the trial key": ("trial", lambda c, n: _gate(n)["env"].update({TRIAL_KEY: "1"})),
    "the TZ sentinel takes the trial key": ("trial", lambda c, n: _own(n, "unit-ny", SENTINEL)["env"].update(
        {TRIAL_KEY: "1"})),
    "the trial key moves from a unit step to its leg's env": ("trial", lambda c, n: n["jobs"]["unit-ny"].update(
        env={TRIAL_KEY: _pass(n, "unit-ny")["env"].pop(TRIAL_KEY)})),
    "the trial key is also set for the whole workflow": ("trial", lambda c, n: n.update(env={TRIAL_KEY: "1"})),
    "a leg step also sets the trial key inside its run": ("trial", lambda c, n: _gate(n).update(
        run="export %s=1\n%s" % (TRIAL_KEY, _gate(n)["run"]))),
    "ci.yml's UTC pass takes the trial key": ("trial", lambda c, n: _serial_pass(c, "unit-utc-cov").update(
        env={TRIAL_KEY: "1"})),
    "ci.yml's NY pass takes the trial key": ("trial", lambda c, n: _serial_pass(c, "unit-ny")["env"].update(
        {TRIAL_KEY: "1"})),
    "ci.yml's job env takes the trial key": ("trial", lambda c, n: _job(c).update(env={TRIAL_KEY: "1"})),
    "ci.yml's workflow env takes the trial key": ("trial", lambda c, n: c.update(env={TRIAL_KEY: "1"})),
    "a ci.yml step sets the trial key inside its run": ("trial", lambda c, n: _serial(c)[-1].update(
        run="export %s=1\n%s" % (TRIAL_KEY, _serial(c)[-1]["run"]))),
    "a unit pass is renamed in both files": ("trial", lambda c, n: [s.update(name="Unit tests") for s in (
        _serial_pass(c, "unit-utc-cov"), _pass(n, "unit-utc-cov"))]),
    "a third unit pass is added to both files": ("trial", lambda c, n: _add_to_both(
        c, n, {"name": "A third pass", "run": "npx vitest run --no-coverage"}, leg="unit-ny")),
    # conservation with the trial's key in play: taking that one key off loosened nothing else
    "a gate takes the trial key": ("conservation", lambda c, n: _gate(n)["env"].update({TRIAL_KEY: "1"})),
    "a unit leg's trial key changes value": ("conservation", lambda c, n: _pass(n, "unit-utc-cov")["env"].update(
        {TRIAL_KEY: "0"})),
    "a unit leg's trial key is an unquoted 1": ("conservation", lambda c, n: _pass(n, "unit-ny")["env"].update(
        {TRIAL_KEY: 1})),
    "a unit leg's env gains a key beside the trial's": ("conservation", lambda c, n: _pass(
        n, "unit-utc-cov")["env"].update(ADDED_BY_TEST="1")),
    "the NY leg loses its TZ beside the trial key": ("conservation", lambda c, n: _pass(n, "unit-ny")["env"].pop("TZ")),
    "a unit leg's run changes beside the trial key": ("conservation", lambda c, n: _pass(n, "unit-utc-cov").update(
        run="npm test -- --silent")),
    "the trial key is mirrored into ci.yml's UTC pass": ("conservation", lambda c, n: _serial_pass(
        c, "unit-utc-cov").update(env={TRIAL_KEY: "1"})),
    "the trial key is mirrored into ci.yml's NY pass": ("conservation", lambda c, n: _serial_pass(
        c, "unit-ny")["env"].update({TRIAL_KEY: "1"})),
}


@pytest.mark.parametrize("name", list(MUTATIONS))
def test_every_kind_of_drift_is_reported_by_the_check_that_owns_it(name):
    """A check that cannot fail holds nothing: each of these, made in memory, must be reported."""
    check, mutate = MUTATIONS[name]
    ci, nxt = copy.deepcopy(_both())
    if CHECKS[check](ci, nxt):
        pytest.skip("the tree as committed fails `%s`; test_ci_next_holds[%s] says how" % (check, check))
    mutate(ci, nxt)
    assert CHECKS[check](ci, nxt) != []


def test_an_ordinary_new_check_mirrored_in_one_leg_passes_every_check():
    """The pins above must not turn "add a check to CI" into a puzzle: a new step that hands nothing on, added to
    ci.yml and to the leg it belongs in, is green everywhere. (`npm install --dry-run` is the near miss for the
    hand-off pattern: an install that writes nothing.)"""
    ci, nxt = copy.deepcopy(_both())
    if any(check(ci, nxt) for check in CHECKS.values()):
        pytest.skip("the tree as committed fails a check; test_ci_next_holds says which and how")
    _add_to_both(ci, nxt, {"name": "A new check",
                           "run": "npm run check:new && npm install --dry-run --package-lock-only"})
    _add_to_both(ci, nxt, {"name": "A new script check", "run": "python3 scripts/check-something.py"}, leg="static")
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
