"""ci.yml's parallel legs and its aggregator `build-and-test`, held to their shape.

Run: python3 -m pytest -q scripts/test_ci_legs.py

ci.yml is the GATING workflow: twelve legs behind one aggregator job whose id, `build-and-test`, is what
promote-gate.yml reads (through scripts/promote-preflight.py). This file runs in ci.yml's own `pytest` leg, so
everything below is a GATING test.

Eight things are held, each by a function that returns the problems it found (so the mutations at the end can show
every one of them is able to fail):

  once          a check runs in one leg: no step other than the six repeatable setup steps (checkout, setup-node,
                npm ci, Chrome resolve, the origin/main fetch, the TZ sentinel) is in the legs twice.
  unit_passes   the unit passes (a run: that starts `npm test` or `npx vitest run`) are the five steps named in
                UNIT_STEPS, one in each shard leg. And the file does not name VITEST_NODE_PROJECT, the A3 trial's env
                key (an env at any level, or the key written into a run: body): vitest.config.ts runs two projects
                in every run and reads no key, so the key would read as a switch that switches nothing.
  shards        plan A4's split of the two unit passes (OPS-CICOVERAGESHARDS-001): the three coverage shards each
                run their own third with no threshold and no report and upload that third's blob; the merge leg
                `unit-utc-cov` needs exactly those three, downloads them, refuses any other set of blobs, merges them
                with the thresholds, and holds the two halves of the coverage ratchet; the two NY shards each run
                their own half. Step for step, as pinned below, so a shard count or a blob name changes everywhere
                at once or reds here.
  own_steps     the steps the legs carry that the serial job did not: the PyYAML install and the TZ sentinel, by
                body and by place. No step carries an `if:` or reads the inputs context.
  setup         each leg has what the serial job handed its steps implicitly: checkout first; node 22.23.3 and
                node_modules for steps that run node (and neither for pytest); CHROME_PATH for the real-Chrome
                gates; origin/main for the release-version guard; PyYAML for gate_runner.py; and the two artefact
                chains kept whole and in order (dist/, coverage/coverage-summary.json).
  shape         triggers, permissions, concurrency and the job graph: push to dev and pull_request to the three
                protected branches and NOTHING else (no workflow_dispatch: see NO_DISPATCH), its concurrency group,
                and the aggregator under the id the promote reads; no continue-on-error, no `if:`, matrix, name or
                env on a leg, and no needs but on the merge leg, ubuntu-26.04 and a timeout everywhere, no
                workflow-level env or defaults, and an aggregator that needs every other job, runs `always()`, and
                pins the same list in its one step.
  handoffs      a step that hands something on through the runner (an action, a GITHUB_ENV or GITHUB_PATH write, an
                apt-get / pip / npm -g install) is named in HANDOFFS with the legs that need it. A new one is red
                until it is repeated where it is consumed and listed. Hand-offs through FILES are not visible
                here beyond the two chains under `setup` and the coverage blobs under `shards`.
  concurrency   no two workflow files share a concurrency group. Groups are repository-wide: a file that shared
                ci.yml's would cancel it.

That a step is not dropped, edited, reordered or moved between legs is held by scripts/ci-step-manifest.json
(scripts/test_ci_step_manifest.py), which records every job of ci.yml step for step.

Then the bodies the legs introduced are executed the way GitHub's runner executes them: `bash -e` on a FILE holding
the body (as scripts/test_workflow_steps.py does; never `bash -c`). The aggregator runs against `needs` fixtures: a
leg that failed, was cancelled (which is how a timed-out leg reads) or was skipped, a leg missing from `needs`, a job
nobody pinned, and a context that is not JSON must each end it non-zero. That is the proof that a red leg reds the
aggregate; nothing forces a real leg red on a runner.
"""
import collections
import copy
import glob
import hashlib
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
CI = "ci.yml"
GATE = "build-and-test"                                   # ci.yml's aggregator: the job promote-gate.yml reads
LEGS = ("static", "pytest", "unit-utc-cov-1", "unit-utc-cov-2", "unit-utc-cov-3", "unit-utc-cov", "unit-ny-1",
        "unit-ny-2", "gates-a", "gates-b", "gates-c", "gate-probes")
GATE_LEGS = ("gates-a", "gates-b", "gates-c", "gate-probes")
RESERVED_JOB_IDS = {"build-and-test", "integration-tests", "smoke-tests"}  # what promote-gate.yml reads by name
CI_ON = {"push": {"branches": ["dev"]}, "pull_request": {"branches": ["dev", "staging", "main"]}}
CI_CONCURRENCY = {"group": "ci-${{ github.ref }}", "cancel-in-progress": True}
NO_DISPATCH = ("ci.yml must never gain workflow_dispatch (or any trigger beyond push to dev and pull_request to dev, "
               "staging and main). scripts/promote-preflight.py counts a dispatched run on any branch at the SHA, so "
               "a run dispatched red on purpose at dev's head would leave that commit unpromotable. A change to "
               "ci.yml's triggers is a regression-reviewed change: widen CI_ON in scripts/test_ci_legs.py with it")
PYYAML = "Install PyYAML for the migration gate validation"
SENTINEL = "TZ sentinel — America/New_York resolves on this runner"
# THE UNIT PASSES, and the key that is gone. The unit steps run the suite as vitest.config.ts has it: two projects,
# `node` for the test files that need no DOM and `dom` for the rest. That began as the A3 trial, behind an env key;
# OPS-A3TRIALKEYREMOVE-001 took the key out and made the projects unconditional. `unit_passes` holds the passes to
# their names and the key out of ci.yml. Plan A4 (OPS-CICOVERAGESHARDS-001) split each pass into shards, so a pass is
# one step per shard leg: three for UTC with coverage, two for America/New_York.
RETIRED_KEY = "VITEST_NODE_PROJECT"
# THE SHARDS (plan A4; gardening-docs project-state/_promotepath-20261002/A4-PROOF-20261018.md). The coverage pass is
# three shard legs and a merge leg; the NY pass, two shard legs and no merge (no coverage to merge). `shards` holds
# every step of these legs that is not repeatable setup, as written here: change the count or a name here and in
# ci.yml, in one commit.
MERGE_LEG = "unit-utc-cov"
COV_SHARDS = ("unit-utc-cov-1", "unit-utc-cov-2", "unit-utc-cov-3")
NY_SHARDS = ("unit-ny-1", "unit-ny-2")
BLOB_DIR = "vitest-blobs"
COV_PASS = "Unit tests with coverage, shard %d of %d (no threshold, no report)"
COV_PASS_RUN = ("npx vitest run --coverage --shard=%d/%d --coverage.reporter=none \\\n"
                "  --coverage.thresholds.lines=0 --coverage.thresholds.functions=0 \\\n"
                "  --coverage.thresholds.branches=0 --coverage.thresholds.statements=0 \\\n"
                "  --reporter=default --reporter=github-actions --reporter=blob --outputFile.blob=" + BLOB_DIR
                + "/blob-%d-%d.json\n")
UPLOAD, DOWNLOAD = "actions/upload-artifact", "actions/download-artifact"
UPLOAD_STEP = "Upload shard %d of %d's blob for the merge"
DOWNLOAD_STEP = "Download the three shards' blobs"
MERGE_STEP = "Merge the three shards, with the coverage thresholds"
RATCHET = "Coverage ratchet enforcement"
MEASURED = "Coverage ratchet — measured floor (WS-B M4)"
NY_PASS = "Unit tests under America/New_York TZ (date-fragility guard), shard %d of %d"
UNIT_STEPS = dict([(leg, COV_PASS % (i, len(COV_SHARDS))) for i, leg in enumerate(COV_SHARDS, 1)]
                  + [(leg, NY_PASS % (i, len(NY_SHARDS))) for i, leg in enumerate(NY_SHARDS, 1)])
UNIT_PASS = re.compile(r"(?:npm test|npx vitest run)\b")  # matched at the start of a step's run
UNIT_RULE = ("the unit passes of ci.yml are one step in each shard leg, %s, and the file does not name %s, the A3 "
             "trial's env key. vitest.config.ts runs its two projects (node and dom) in every run and reads no key "
             "since OPS-A3TRIALKEYREMOVE-001, so a key set in a workflow switches nothing and reads as though it did"
             % (json.dumps(UNIT_STEPS, ensure_ascii=False), RETIRED_KEY))
# Every tracked file that names the retired key: this file, which holds it out. `unit_passes` reads ci.yml; the key
# set anywhere else (the `test` script of package.json is the short way) would read as a switch in a config that has
# none.
RETIRED_KEY_FILES = ["scripts/test_ci_legs.py"]
# The TZ sentinel is setup since A4: each NY shard repeats it, directly before its pass (`setup` holds that).
REPEATABLE = ("checkout", "setup-node", "npm-ci", "chrome", "fetch-main", "tz-sentinel")
NODE_PIN = {"node-version": "22.23.3", "cache": "npm"}
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
    "actions/setup-node": "node 22.23.3 on PATH: repeated in every leg that runs node (all but pytest)",
    "Python script tests (pytest)": "pip installs pytest, requests, boto3, pyyaml: the pytest leg runs this step and "
                                    "nothing else needs them",
    PYYAML: "pip installs pyyaml for gate_runner.py: static, the only leg that runs it",
    "Resolve Chrome for the layout gates": "writes CHROME_PATH to GITHUB_ENV: repeated in gates-a, gates-b, gates-c "
                                           "and gate-probes",
    "Photo-tier payload budget (BUG-TIERLESSPHOTOS-001)": "pip installs pillow for its own gate only: gates-a",
    UPLOAD: "each coverage shard's blob, as an artifact, for the merge leg: the one hand-off BETWEEN legs (plan A4), "
            "held by `shards`",
    DOWNLOAD: "the three coverage shards' blobs, in the merge leg unit-utc-cov, the one leg with needs",
}
NEW_HANDOFF = ("ci.yml step %r hands something to later steps through the runner (it uses an action, writes GITHUB_ENV "
               "or GITHUB_PATH, or installs with apt-get, pip or npm -g). Only the leg holding the step has it. A new "
               "hand-off must be repeated in every leg that consumes it, then added to HANDOFFS in "
               "scripts/test_ci_legs.py with the legs that need it")
# The two bodies the legs add, as written in ci.yml. Changing one means changing it here in the same commit, which is
# the point: what they do is executed further down, and this holds that they do nothing else. (It is also the only
# hold on the sentinel's offset comparison: no real node reports the zone's name and then keeps another zone's
# offsets, so no fixture reaches that half of its condition.)
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
    "coverage/coverage-summary.json": (lambda s: "npx vitest run --merge-reports=" in s.get("run", ""),
                                       lambda s: "check-coverage-ratchet.py --measured" in s.get("run", "")),
}
# The merge's body (plan A4). vitest merges every blob it finds and knows nothing of the shard count, so the body first
# holds the directory to exactly the three shards' blobs; after the merge it holds the files the shards ran to the
# suite's (`vitest list --filesOnly`), by the merge's test-ids notice. Run as the runner runs it further down.
MERGE_RUN = "\n".join([
    "set -euo pipefail",
    'FOUND=""',
    "[ ! -d %s ] || FOUND=\"$(cd %s && printf '%%s ' *)\"" % (BLOB_DIR, BLOB_DIR),
    'if [ "$FOUND" != "blob-1-3.json blob-2-3.json blob-3-3.json " ]; then',
    '  echo "::error title=Coverage merge::want exactly the blobs of shards 1, 2 and 3 of 3 in vitest-blobs, found: '
    '${FOUND:-none}. Two would pass two thirds of the suite as the whole. Blobs are kept 3 days: on an older run, '
    're-run all jobs."',
    "  exit 1",
    "fi",
    'npx vitest run --merge-reports=%s --coverage | tee "$RUNNER_TEMP/merge.log"' % BLOB_DIR,
    "npx vitest list --filesOnly | sed -nE 's/^\\[[a-z]+\\] //p' > \"$RUNNER_TEMP/listed.txt\"",
    'LISTED="$(wc -l < "$RUNNER_TEMP/listed.txt" | tr -d \' \')"',
    'WANT="files_sha256=$(LC_ALL=C sort -u "$RUNNER_TEMP/listed.txt" | sha256sum | cut -d\' \' -f1) files=$LISTED"',
    "GOT=\"$(sed -nE 's/^::notice title=test-ids UTC::.* (files_sha256=[0-9a-f]{64}) .* (files=[0-9]+) .*$/\\1 \\2/p' "
    "\"$RUNNER_TEMP/merge.log\")\"",
    'if [ "$GOT" != "$WANT" ]; then',
    '  echo "::error title=Coverage merge::the merged run\'s test files are not the suite\'s: merged ${GOT:-with no '
    'test-ids notice}, vitest list --filesOnly $WANT. The shards lost or repeated a file."',
    "  exit 1",
    "fi",
    'echo "Coverage merge: the three shards ran the suite\'s $LISTED test files, each once."',
    "",
])
BLOB_NAMES = ["blob-%d-%d.json" % (i, len(COV_SHARDS)) for i in range(1, len(COV_SHARDS) + 1)]
PINNED_ACTION = re.compile(r"[\w.-]+/[\w.-]+@[0-9a-f]{40}")


def _load(name):
    with open(os.path.join(WORKFLOWS, name), encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def _on(workflow):
    return workflow.get("on", workflow.get(True))  # PyYAML reads the bare key `on` as True


def _keys(workflow):
    return {"on" if key is True else key for key in workflow}  # PyYAML reads the bare key `on` as True


def _legs(workflow):
    """Every job but the aggregator."""
    return {job_id: job for job_id, job in (workflow.get("jobs") or {}).items() if job_id != GATE}


def _all_steps(workflow):
    return [s for job in _legs(workflow).values() for s in job["steps"]]


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
    if step.get("name") == SENTINEL:
        return "tz-sentinel"
    return None


def _conserved(job):
    """A leg's steps that are not repeatable setup: the checks the leg exists to run."""
    return [s for s in job["steps"] if _kind(s) not in REPEATABLE]


def _uses_node(step):
    return bool(NODE_COMMAND.search(step.get("run") or "")) or step.get("name") in NODE_BY_NAME


def _chrome_gate(step):
    return "GATE_CHROME_FLAGS" in (step.get("env") or {})


def _has_key(node, key):
    if isinstance(node, dict):
        return key in node or any(_has_key(v, key) for v in node.values())
    return isinstance(node, list) and any(_has_key(v, key) for v in node)


# ── each check, on ci.yml ───────────────────────────────────────────────────────────────────────────────────────────

def once(ci):
    seen = collections.Counter(_label(s) for job in _legs(ci).values() for s in _conserved(job))
    return ["step %r is in the legs %d times, want once: a check runs in one leg (only checkout, setup-node, npm ci, "
            "the Chrome resolve, the origin/main fetch and the TZ sentinel repeat)" % (label, count)
            for label, count in seen.items() if count != 1]


def unit_passes(ci):
    out = []
    passes = [_label(s) for s in _all_steps(ci) if UNIT_PASS.match(s.get("run") or "")]
    if passes != list(UNIT_STEPS.values()):
        out.append("the unit passes (a run: that starts `npm test` or `npx vitest run`) are %s, and they are pinned "
                   "to %s. A pass that is renamed, added or removed changes UNIT_STEPS in scripts/test_ci_legs.py in "
                   "the same commit: %s" % (passes, list(UNIT_STEPS.values()), UNIT_RULE))
    for leg, step_name in UNIT_STEPS.items():
        steps = [s for s in ((ci.get("jobs") or {}).get(leg) or {}).get("steps") or [] if s.get("name") == step_name]
        if len(steps) != 1:
            out.append("leg %s: step %r is there %d time(s); want it once: %s"
                       % (leg, step_name, len(steps), UNIT_RULE))
    count = json.dumps(ci, default=str).count(RETIRED_KEY)
    if count:
        out.append("ci.yml names %s %d time(s), want none: a step env, a job-level or workflow-level env, or the key "
                   "written into a run: body. Take it out: %s" % (RETIRED_KEY, count, UNIT_RULE))
    return out


# ── plan A4: the shards and the merge ───────────────────────────────────────────────────────────────────────────

def _bare(step):
    """A step with its action's pin left out: bumping a pin is not a change of shape (the pin is checked apart)."""
    return dict(step, uses=str(step["uses"]).split("@")[0]) if "uses" in step else step


def _want_cov_shard(i, n):
    return [{"name": COV_PASS % (i, n), "run": COV_PASS_RUN % (i, n, i, n)},
            {"name": UPLOAD_STEP % (i, n), "uses": UPLOAD,
             "with": {"name": "vitest-blob-utc-%d" % i, "path": "%s/blob-%d-%d.json" % (BLOB_DIR, i, n),
                      "if-no-files-found": "error", "retention-days": 3, "overwrite": True}}]


def _want_merge():
    return [{"name": RATCHET, "run": "python3 scripts/check-coverage-ratchet.py"},
            {"name": DOWNLOAD_STEP, "uses": DOWNLOAD,
             "with": {"pattern": "vitest-blob-utc-*", "path": BLOB_DIR, "merge-multiple": True}},
            {"name": MERGE_STEP, "run": MERGE_RUN},
            {"name": MEASURED, "run": "python3 scripts/check-coverage-ratchet.py --measured"}]


def _want_ny_shard(i, n):
    return [{"name": NY_PASS % (i, n), "run": "npx vitest run --no-coverage --shard=%d/%d" % (i, n), "env": {"TZ": NY}}]


def shards(ci):
    out = []
    if '"%s "' % " ".join(BLOB_NAMES) not in MERGE_RUN:
        out.append("MERGE_RUN in scripts/test_ci_legs.py does not check for the blobs of %d shards (%s)"
                   % (len(COV_SHARDS), BLOB_NAMES))
    legs = _legs(ci)
    wants = [(leg, _want_cov_shard(i, len(COV_SHARDS))) for i, leg in enumerate(COV_SHARDS, 1)]
    wants += [(MERGE_LEG, _want_merge())]
    wants += [(leg, _want_ny_shard(i, len(NY_SHARDS))) for i, leg in enumerate(NY_SHARDS, 1)]
    for leg, want in wants:
        if leg not in legs:
            out.append("has no leg %s" % leg)
            continue
        want, have = [_canon(s) for s in want], [_canon(_bare(s)) for s in _conserved(legs[leg])]
        if want == have:
            continue
        out += ["leg %s: step %r is not there as pinned in scripts/test_ci_legs.py (name, run, env, uses or with "
                "differs, or it is missing)" % (leg, _label(json.loads(key))) for key in want if key not in have]
        out += ["leg %s: runs %r, which is not one of the steps pinned for it in scripts/test_ci_legs.py"
                % (leg, _label(json.loads(key))) for key in have if key not in want]
        if sorted(want) == sorted(have):
            out.append("leg %s: its pinned steps are in another order" % leg)
    for leg, job in legs.items():
        for step in job["steps"]:
            action = str(step.get("uses") or "").split("@")[0]
            if action not in (UPLOAD, DOWNLOAD):
                continue
            if leg not in (COV_SHARDS if action == UPLOAD else (MERGE_LEG,)):
                out.append("leg %s: uses %s, which belongs in %s only"
                           % (leg, action, "the coverage shards" if action == UPLOAD else MERGE_LEG))
            if not PINNED_ACTION.fullmatch(str(step["uses"])):
                out.append("leg %s: %r is not pinned to a commit SHA" % (leg, step["uses"]))
    needs = (legs.get(MERGE_LEG) or {}).get("needs")
    if needs != list(COV_SHARDS):
        out.append("%s needs %r, want exactly the coverage shards %s: a merge that does not wait for a shard would "
                   "merge without its blob, or before it" % (MERGE_LEG, needs, list(COV_SHARDS)))
    return out


# ── the steps the legs carry that the serial job did not ────────────────────────────────────────────────────────

def own_steps(ci):
    out = []
    for leg, job in _legs(ci).items():
        at = "leg %s" % leg
        steps = job["steps"]
        for i, step in enumerate(steps):
            if "if" in step:
                out.append("%s: step %r carries an if:" % (at, _label(step)))
            if INPUTS_CONTEXT.search(_canon(step)):
                out.append("%s: step %r reads the inputs context; ci.yml has no inputs (no workflow_dispatch)"
                           % (at, _label(step)))
            if step.get("name") == PYYAML and (set(step) != {"name", "run"} or not any(
                    "gate_runner.py" in (s.get("run") or "") for s in steps[i:])):
                out.append("%s: the PyYAML install wants a name and a run only, and a gate_runner.py step after it"
                           % at)
            for own, body in ((PYYAML, PYYAML_RUN), (SENTINEL, SENTINEL_RUN)):
                if step.get("name") == own and step.get("run") != body:
                    out.append("%s: the body of %r is not the one pinned in scripts/test_ci_legs.py" % (at, own))
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

def setup(ci):
    out = []
    for leg, job in _legs(ci).items():
        leg, steps = "leg %s" % leg, job["steps"]
        kinds = [_kind(s) for s in steps]

        def at(kind):
            return [i for i, k in enumerate(kinds) if k == kind]

        def before(kind, users, what):
            if not users:
                if at(kind):
                    out.append("%s: has %s and no step that needs it" % (leg, what))
            elif len(at(kind)) != 1 or at(kind)[0] > min(users):
                out.append("%s: needs exactly one %s, before %r" % (leg, what, _label(steps[min(users)])))

        if len(at("checkout")) != 1 or not steps or kinds[0] != "checkout":
            out.append("%s: wants exactly one checkout, as its first step" % leg)
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
    every = [(leg, s) for leg, job in _legs(ci).items() for s in job["steps"]]
    want = [[leg, NY] for leg in NY_SHARDS]
    zones = [[leg, s["env"]["TZ"]] for leg, s in every if "TZ" in (s.get("env") or {}) and s.get("name") != SENTINEL]
    if zones != want:
        out.append("want exactly one step that sets TZ in each NY shard (%s), and to %s (the app's own zone, and the "
                   "one the sentinel proves resolved); found %s" % (", ".join(NY_SHARDS), NY, zones))
    if [[leg, (s.get("env") or {}).get("TZ")] for leg, s in every if s.get("name") == SENTINEL] != want:
        out.append("want exactly one TZ sentinel in each NY shard (%s), with TZ %s" % (", ".join(NY_SHARDS), NY))
    for artefact, links in CHAINS.items():
        found = [(list(_legs(ci)).index(leg), i) for link in links
                 for leg, job in _legs(ci).items() for i, s in enumerate(job["steps"]) if link(s)]
        if len(found) != len(links) or len({leg for leg, _ in found}) != 1 or found != sorted(found):
            out.append("the steps that write and read %s are not one per link, in one leg, in order (found at "
                       "(leg, step) %s; if a link's command changed, update CHAINS)" % (artefact, found))
    return out


# ── triggers and the job graph ──────────────────────────────────────────────────────────────────────────────────

def _pinned_legs(job):
    steps = job.get("steps") or [{}]
    found = re.findall(r'^EXPECTED_LEGS="([^"]*)"$', steps[0].get("run") or "", re.M)
    return found[0].split() if len(found) == 1 else None


def _triggers(ci):
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


def _graph(ci):
    out = []
    if _keys(ci) != WORKFLOW_KEYS:
        out.append("the workflow keys are %s, pinned as %s; an env or defaults block would change what every step "
                   "runs with" % (sorted(_keys(ci)), sorted(WORKFLOW_KEYS)))
    if ci.get("permissions") != {"contents": "read"}:
        out.append("permissions are %r, want contents: read and no more" % ci.get("permissions"))
    if _has_key(ci, "continue-on-error"):
        out.append("continue-on-error appears: a job that fails under it reads `success` in needs")
    jobs = ci.get("jobs") or {}
    legs = _legs(ci)
    if tuple(legs) != LEGS or GATE not in jobs:
        out.append("job ids are %s, want the legs %s and %s" % (list(jobs), list(LEGS), GATE))
    for job_id, job in jobs.items():
        if job.get("runs-on") != "ubuntu-26.04":
            out.append("%s runs on %r, want ubuntu-26.04" % (job_id, job.get("runs-on")))
        minutes = job.get("timeout-minutes")
        if not isinstance(minutes, int) or isinstance(minutes, bool) or minutes <= 0:
            out.append("%s has no timeout-minutes" % job_id)
    for leg, job in legs.items():
        # The merge leg alone may carry `needs` (its value is held by `shards`), and never an `if:`: without one, a red
        # shard leaves it `skipped`, which the aggregator reads as red.
        extra = set(job) - LEG_KEYS - ({"needs"} if leg == MERGE_LEG else set())
        if extra:
            out.append("leg %s carries %s; a leg has runs-on, timeout-minutes and steps only (no if, needs, strategy, "
                       "name, uses, env, defaults, services or container; the merge leg %s may also have needs)"
                       % (leg, sorted(extra), MERGE_LEG))
    agg = jobs.get(GATE) or {}
    if set(agg) != {"needs", "if", "runs-on", "timeout-minutes", "steps"}:
        out.append("%s has keys %s; want needs, if, runs-on, timeout-minutes and steps (no name, no uses)"
                   % (GATE, sorted(agg)))
    needs = agg.get("needs")
    if sorted(needs if isinstance(needs, list) else [needs], key=str) != sorted(legs):
        out.append("%s needs %s, want every other job: %s" % (GATE, needs, sorted(legs)))
    if agg.get("if") != "always()":
        out.append("%s has if: %r, want always()" % (GATE, agg.get("if")))
    steps = agg.get("steps") or []
    if len(steps) != 1 or set(steps[0]) != {"name", "env", "run"} \
            or steps[0].get("env") != {"NEEDS": "${{ toJSON(needs) }}"}:
        out.append("%s wants ONE step: a run: that reads NEEDS = toJSON(needs) from env, no uses, no if" % GATE)
    pinned = _pinned_legs(agg)
    if pinned is None or sorted(pinned) != sorted(legs) or len(set(pinned)) != len(pinned):
        out.append("the list pinned in %s's step is %s, want the other job ids: %s" % (GATE, pinned, sorted(legs)))
    return out


def shape(ci):
    return _triggers(ci) + _graph(ci)


# ── hand-offs through the runner ────────────────────────────────────────────────────────────────────────────────

def _handoff_key(step):
    return (step.get("uses") or "").split("@")[0] or step.get("name")


def _hands_on(step):
    return "uses" in step or bool(HANDOFF.search(step.get("run") or ""))


def handoffs(ci):
    found = list(dict.fromkeys(_handoff_key(s) for s in _all_steps(ci) if _hands_on(s)))
    out = [NEW_HANDOFF % key for key in found if key not in HANDOFFS]
    out += ["HANDOFFS in scripts/test_ci_legs.py names %r, which is no longer a hand-off step of ci.yml: rename or "
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
    # A group built from github.workflow is qualified by the workflow's own name, so two files may spell it alike.
    return ["concurrency group %r is used by %s: the runs would queue behind and cancel each other"
            % (group, sorted(files)) for group, files in sorted(_groups(workflows).items())
            if len(files) > 1 and "github.workflow" not in group]


# ── the tree as committed ───────────────────────────────────────────────────────────────────────────────────────

CHECKS = {"once": once, "unit_passes": unit_passes, "shards": shards, "own_steps": own_steps, "setup": setup,
          "shape": shape, "handoffs": handoffs}


@pytest.mark.parametrize("check", list(CHECKS.values()), ids=list(CHECKS))
def test_ci_holds(check):
    found = check(_load(CI))
    assert not found, (
        "ci.yml (the gating legs and their aggregator `%s`) is out of shape. Its header says what it holds. A CI step "
        "edit regenerates scripts/ci-step-manifest.json in the same commit:\n  " % GATE) + "\n  ".join(found)


def test_no_two_workflow_files_share_a_concurrency_group():
    workflows = _all_workflows()
    groups = _groups(workflows)
    assert len(workflows) > 2 and len(groups) > 2, "scanned too little: the workflow glob or loader is broken"
    assert any(CI in files for files in groups.values())  # ci.yml was really read
    assert concurrency(workflows) == []


def test_the_checks_read_the_file_and_are_not_empty():
    workflow = _load(CI)
    assert sum(len(_conserved(job)) for job in _legs(workflow).values()) > 30
    assert {_kind(s) for s in _all_steps(workflow)} - {None} == set(REPEATABLE)  # every setup kind is in use
    assert all(any(_uses_node(s) for s in job["steps"]) for leg, job in _legs(workflow).items() if leg != "pytest")


def test_the_retired_trial_key_is_named_only_by_this_file():
    """`unit_passes` holds the key out of ci.yml. This holds it out of everything else: an npm script that sets it
    (`"test": "VITEST_NODE_PROJECT=1 vitest run --coverage"`), or a config that reads it, would make a switch again
    where the owner's decision (row `switch-unit-shape`) left one shape."""
    repo = os.path.join(HERE, "..")
    named = subprocess.run(["git", "-C", repo, "grep", "-l", "-F", RETIRED_KEY], capture_output=True, text=True)
    assert named.returncode == 0, "git grep found no tracked file naming %s: %r" % (RETIRED_KEY, named.stderr)
    with open(os.path.join(repo, "package.json"), encoding="utf-8") as fh:
        assert RETIRED_KEY not in fh.read(), (
            "package.json names %s. Take it out: %s" % (RETIRED_KEY, UNIT_RULE))
    assert sorted(named.stdout.split()) == RETIRED_KEY_FILES, (
        "the tracked files that name %s are no longer the one that may (this file). A file that SETS or READS the "
        "key makes a switch that vitest.config.ts no longer has: take it out. A file that only mentions it: reword "
        "it, or add it to RETIRED_KEY_FILES in scripts/test_ci_legs.py in the same commit: %s" % (RETIRED_KEY,
                                                                                                    UNIT_RULE))


def test_the_legs_hold_what_their_names_say():
    workflow = _load(CI)
    if once(workflow):
        pytest.skip("a step is repeated; test_ci_holds[once] says which")
    everything = _all_steps(workflow)
    legs = {leg: [_label(s) for s in _conserved(job)] for leg, job in _legs(workflow).items()}

    def named(test, count, what):
        found = [_label(s) for s in everything if test(s)]
        assert len(found) == count, (
            "ci.yml has %d step(s) that are %s, and this test expects %d: %s. It finds them by their command, so if a "
            "command or env changed, update the matcher in test_the_legs_hold_what_their_names_say; if the step was "
            "removed or one was added, change the count with it." % (len(found), what, count, found))
        return found

    def holds(leg, want, what):
        assert legs[leg] == want, (
            "leg `%s` of .github/workflows/ci.yml should hold exactly %s.\n  it holds: %s\n  want:     %s\n"
            "Move the step that differs to the leg it belongs in (the comment above each leg says what the leg is "
            "for). If the split itself is meant to change, change this test in the same commit."
            % (leg, what, legs[leg], want))

    gates = [_label(s) for s in everything if _chrome_gate(s)]
    assert len(gates) > 10, (
        "only %d ci.yml steps carry env GATE_CHROME_FLAGS, which is how this test recognises a real-Chrome gate: "
        "update _chrome_gate in scripts/test_ci_legs.py" % len(gates))
    in_gate_legs = sum((legs[leg] for leg in GATE_LEGS), [])
    assert sorted(in_gate_legs) == sorted(gates), (
        "the four gate legs of .github/workflows/ci.yml (%s) should hold every real-Chrome gate and no other step.\n"
        "  gates in no gate leg: %s\n  in a gate leg, not a gate: %s\nA new gate goes in gates-a or gates-b, "
        "whichever is shorter (page-scroll stays alone in gates-c; the Today V2 probe steps are gate-probes). A step "
        "that drives no browser goes in static."
        % (", ".join(GATE_LEGS), sorted(set(gates) - set(in_gate_legs)), sorted(set(in_gate_legs) - set(gates))))
    holds("gates-c", named(lambda s: s.get("run") == "npm run gate:page-scroll", 1, "`npm run gate:page-scroll`"),
          "the page-scroll gate, alone: it is the longest gate and the one that grows")
    holds("gate-probes", named(lambda s: "probe-nothing" in (s.get("run") or ""), 2, "gates that run a probe-nothing"),
          "the two Today V2 steps that run their gate and then its probe-nothing proof")
    holds("pytest", named(lambda s: "pytest -q scripts/test_*.py" in (s.get("run") or ""), 1, "the pytest run"),
          "the pytest step and nothing else (no setup-node, no npm ci)")
    zoned = named(lambda s: "TZ" in (s.get("env") or {}) and s.get("name") != SENTINEL, len(NY_SHARDS),
                  "run with an env TZ (the sentinels aside)")
    for leg, step in zip(NY_SHARDS, zoned):
        holds(leg, [step], "its share of the unit suite under that TZ (the sentinel before it is setup)")
    shard_runs = named(lambda s: "--shard=" in (s.get("run") or "") and "--coverage " in (s.get("run") or ""),
                       len(COV_SHARDS), "a coverage pass over one shard")
    uploads = named(lambda s: str(s.get("uses") or "").startswith(UPLOAD + "@"), len(COV_SHARDS), "an artifact upload")
    for leg, pass_, upload in zip(COV_SHARDS, shard_runs, uploads):
        holds(leg, [pass_, upload], "its shard of the coverage pass, then the upload of that shard's blob")
    holds(MERGE_LEG, named(lambda s: "check-coverage-ratchet.py" in (s.get("run") or "") or "--merge-reports" in (
        s.get("run") or "") or str(s.get("uses") or "").startswith(DOWNLOAD + "@"), 4,
        "a check-coverage-ratchet.py call, the blobs' download or the merge"),
          "the coverage ratchet, the download of the shards' blobs, their merge, and the measured floor that reads "
          "the coverage the merge wrote")


def test_the_shard_flags_are_the_ones_the_provider_test_runs():
    """What a shard's coverage flags DO (no threshold, no report) and what the merge does (the thresholds, the report)
    is held by a real run in scripts/vitest/coverage-v8-two-forms.test.js, under CI_SHARD_COVERAGE_FLAGS. Those
    must be the flags ci.yml gives its shards, or that run proves something about another command."""
    flags = sorted(re.findall(r"--coverage\.[\w.]+=\S+", COV_PASS_RUN))
    with open(os.path.join(HERE, "vitest", "coverage-v8-two-forms.test.js"), encoding="utf-8") as fh:
        found = re.findall(r"^const CI_SHARD_COVERAGE_FLAGS = \[(.*?)\]$", fh.read(), re.M | re.S)
    assert len(flags) == 5 and len(found) == 1, (flags, found)
    assert sorted(re.findall(r"'([^']+)'", found[0])) == flags


def test_the_file_is_lf_only_with_no_tabs():
    with open(os.path.join(WORKFLOWS, CI), "rb") as fh:
        raw = fh.read()
    assert b"\r" not in raw and b"\t" not in raw and raw.endswith(b"\n")


# ── the bodies the legs add, run as the runner runs them ────────────────────────────────────────────────────────

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


def _aggregate(tmp_path, needs_json):
    step = _load(CI)["jobs"][GATE]["steps"][0]
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
    assert GATE + ":" in proc.stdout
    shuffled = dict(reversed(list(_needs().items())))  # key order is not part of the contract
    assert _aggregate(tmp_path, json.dumps(shuffled)).returncode == 0


@pytest.mark.parametrize("leg", LEGS)
@pytest.mark.parametrize("result", ["failure", "cancelled", "skipped"])
def test_aggregator_fails_when_any_leg_did_not_succeed(tmp_path, leg, result):
    """`cancelled` is what a timed-out leg reads as; `skipped` is a leg an `if:` or a failed need kept from running."""
    proc = _aggregate(tmp_path, json.dumps(_needs(**{leg: result})))
    assert proc.returncode == 1
    assert _errors(proc) and "%s=%s" % (leg, result) in _errors(proc)[0]
    assert _errors(proc)[0].startswith("::error title=%s::" % GATE)


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
    step = _load(CI)["jobs"][GATE]["steps"][0]
    env = dict(os.environ, NEEDS=json.dumps(_needs(static=None)), EXPECTED_LEGS=" ".join(LEGS[1:]))
    assert _run_as_runner(tmp_path, step["run"], env).returncode == 1


@pytest.mark.parametrize("zone,want", [
    ("America/New_York", 0),
    ("UTC", 1),                      # what an unresolved zone falls back to
    ("Europe/London", 1),
    ("America/Chicago", 1),
    ("Not/AZone", 1),
    ("", 1),
    (None, 1),                       # TZ never set: the machine's own zone, even when that IS New York
])
@pytest.mark.parametrize("leg", NY_SHARDS)
def test_tz_sentinel_passes_only_when_node_resolved_new_york(tmp_path, leg, zone, want):
    assert shutil.which("node"), "node is required: the sentinel asks node what the zone resolved to"
    env = {k: v for k, v in os.environ.items() if k != "TZ"}
    if zone is not None:
        env["TZ"] = zone
    proc = _run_as_runner(tmp_path, _own(_load(CI), leg, SENTINEL)["run"], env)
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
    proc = _run_as_runner(tmp_path, _own(_load(CI), "static", PYYAML)["run"], env)
    calls = called.read_text().splitlines()
    assert (proc.returncode != 0) == bool(want_rc), proc.stderr
    assert len(calls) == want_calls and all(c.endswith(" pyyaml") and "pip install" in c for c in calls)
    assert "--break-system-packages" not in calls[0]


SUITE = ["lambda/a.test.js", "src/__tests__/b.test.jsx", "scripts/c.test.js"]


def _notice(files, count=None):
    """The merge's test-ids notice (scripts/vitest/vitest-test-ids-reporter.mjs) for a run of these files."""
    unique = sorted(set(files))
    digest = hashlib.sha256("".join("%s\n" % f for f in unique).encode()).hexdigest()
    return ("::notice title=test-ids UTC::sha256=%s files_sha256=%s names_sha256=%s tests=9 passed=9 failed=0 "
            "skipped=0 pending=0 files=%d node_files=1 reason=passed v=2" % ("0" * 64, digest, "1" * 64,
                                                                             len(files) if count is None else count))


def _merge_in(tmp_path, blobs, merged="default", listed=None, merge_rc=0, list_rc=0):
    """The merge step's body, run as the runner runs it, in a directory holding `blobs` (None: no blob directory),
    with a stub npx: `vitest run` prints `merged` (by default the notice of SUITE) and exits merge_rc; `vitest list`
    prints `listed` (by default SUITE, as vitest prints it) and exits list_rc. Returns the process and npx's calls."""
    bindir = tmp_path / "bin"
    bindir.mkdir()
    called = tmp_path / "npx-called"
    (tmp_path / "run.out").write_text(("Test Files  3 passed (3)\n%s\n" % _notice(SUITE)) if merged == "default"
                                      else merged)
    (tmp_path / "list.out").write_text("".join("[%s] %s\n" % ("node" if f.startswith("lambda/") else "dom", f)
                                               for f in (SUITE if listed is None else listed)))
    stub = bindir / "npx"
    stub.write_text('#!/bin/sh\necho "$@" >> "%s"\ncase "$2" in\n  run) cat "%s"; exit %d ;;\n'
                    '  list) echo "Both esbuild and oxc options were set." >&2; cat "%s"; exit %d ;;\nesac\nexit 99\n'
                    % (called, tmp_path / "run.out", merge_rc, tmp_path / "list.out", list_rc))
    stub.chmod(stub.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    if blobs is not None:
        (tmp_path / BLOB_DIR).mkdir()
        for blob in blobs:
            (tmp_path / BLOB_DIR / blob).write_text("{}")
    runner_temp = tmp_path / "runner-temp"
    runner_temp.mkdir()
    env = dict(os.environ, PATH="%s:%s" % (bindir, os.environ["PATH"]), RUNNER_TEMP=str(runner_temp))
    proc = _run_as_runner(tmp_path, _own(_load(CI), MERGE_LEG, MERGE_STEP)["run"], env)
    return proc, (called.read_text().splitlines() if called.exists() else [])


MERGE_CALL = "vitest run --merge-reports=%s --coverage" % BLOB_DIR
LIST_CALL = "vitest list --filesOnly"


def test_the_merge_runs_on_exactly_the_three_blobs_and_finds_the_suite_whole(tmp_path):
    proc, calls = _merge_in(tmp_path, BLOB_NAMES)
    assert proc.returncode == 0 and _errors(proc) == [], proc.stdout + proc.stderr
    assert calls == [MERGE_CALL, LIST_CALL]
    assert "the three shards ran the suite's 3 test files, each once" in proc.stdout


@pytest.mark.parametrize("blobs", [
    None,                                                       # the download made no directory
    [],                                                         # it made one and put nothing in it
    BLOB_NAMES[:2],                                             # a shard's blob is missing
    BLOB_NAMES[1:],
    BLOB_NAMES + ["blob-4-4.json"],                             # a blob of another split
    ["blob-1-2.json", "blob-2-2.json"],                         # a two-shard split: complete, but not this one
    ["blob-1-3.json", "blob-2-3.json", "blob-3-3.json.zip"],    # an archive the download did not unpack
])
def test_the_merge_refuses_any_other_set_of_blobs_before_it_merges(tmp_path, blobs):
    proc, calls = _merge_in(tmp_path, blobs)
    assert proc.returncode == 1 and calls == [], proc.stdout + proc.stderr
    assert len(_errors(proc)) == 1 and _errors(proc)[0].startswith("::error title=Coverage merge::want exactly")


@pytest.mark.parametrize("merged,listed", [
    (_notice(SUITE[:2]), None),                                 # a file no shard ran
    (_notice(SUITE + [SUITE[0]]), None),                        # a file two shards ran: same files, one more run
    (_notice(SUITE[:2] + ["src/other.test.js"]), None),         # as many files, not the same ones
    (_notice(SUITE), SUITE + ["lambda/new.test.js"]),           # the suite has a file the shards did not run
    ("Test Files  3 passed (3)\n", None),                       # no test-ids notice at all
    (_notice(SUITE) + "\n" + _notice(SUITE), None),             # two notices: not one merged run
    (_notice(SUITE).replace("test-ids UTC", "test-ids America/New_York"), None),
])
def test_the_merge_refuses_a_run_whose_files_are_not_the_suites(tmp_path, merged, listed):
    proc, calls = _merge_in(tmp_path, BLOB_NAMES, merged=merged + "\n", listed=listed)
    assert proc.returncode == 1 and calls == [MERGE_CALL, LIST_CALL], proc.stdout + proc.stderr
    assert len(_errors(proc)) == 1 and "the merged run's test files are not the suite's" in _errors(proc)[0]


@pytest.mark.parametrize("merge_rc,list_rc,want_calls", [
    (1, 0, [MERGE_CALL]),            # a failed test in a blob, a missed threshold or the provider's ERROR
    (0, 1, [MERGE_CALL, LIST_CALL]),  # the suite could not be listed: never a pass
])
def test_a_red_merge_or_list_reds_the_step(tmp_path, merge_rc, list_rc, want_calls):
    proc, calls = _merge_in(tmp_path, BLOB_NAMES, merge_rc=merge_rc, list_rc=list_rc)
    assert proc.returncode == 1 and calls == want_calls, proc.stdout + proc.stderr


# ── every check can fail ────────────────────────────────────────────────────────────────────────────────────────
# Each mutation is applied to today's ci.yml in memory and must be reported by the named check.

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
    return workflow["jobs"][GATE]


def _repin(workflow, old, new):
    step = _agg(workflow)["steps"][0]
    step["run"] = step["run"].replace(old, new)


def _add(workflow, step, leg="static"):
    _steps(workflow, leg).append(copy.deepcopy(step))


def _edit_own(workflow, leg, name, old, new):
    step = _own(workflow, leg, name)
    step["run"] = step["run"].replace(old, new)
    assert new in step["run"]


def _tz_steps(workflow):
    return [s for leg in NY_SHARDS for s in _steps(workflow, leg) if "TZ" in (s.get("env") or {})]


def _pass(workflow, leg):
    """A unit leg's pass: the step that runs the suite."""
    return _steps(workflow, leg)[_find(workflow, leg, _named(UNIT_STEPS[leg]))]


MUTATIONS = {
    # once
    "a gate runs in two legs": ("once", lambda w: _steps(w, "gates-b").append(copy.deepcopy(_gate(w)))),
    "a check is repeated inside its leg, edited": ("once", lambda w: _steps(w, "gates-a").append(
        dict(copy.deepcopy(_gate(w)), run="true"))),
    "the PyYAML install is repeated in another leg": ("once", lambda w: _steps(w, "gates-a").append(
        copy.deepcopy(_own(w, "static", PYYAML)))),
    # own_steps
    "a step reads the dispatch input in its if": ("own_steps", lambda w: _steps(w, "static").append(
        {"name": "Gated on an input", "if": "inputs.canary_red_leg == 'static'", "run": "exit 1"})),
    "a step reads the dispatch input in its body": ("own_steps", lambda w: _gate(w).update(
        run='test "${{ github.event.inputs.canary_red_leg }}" = ""\n' + _gate(w)["run"])),
    "a step gains an if": ("own_steps", lambda w: _gate(w).update({"if": "always()"})),
    "a step gains an if on the event": ("own_steps", lambda w: _gate(w).update({"if": "github.event_name == 'push'"})),
    "the PyYAML install is added where nothing needs it": ("own_steps", lambda w: _steps(w, "pytest").append(
        copy.deepcopy(_own(w, "static", PYYAML)))),
    "the TZ sentinel checks a different zone": ("own_steps", lambda w: _own(w, "unit-ny-1", SENTINEL)["env"].update(
        TZ="UTC")),
    "the TZ sentinel runs after the suite": ("own_steps", lambda w: _swap(_steps(w, "unit-ny-1"), -1, -2)),
    "the PyYAML install also writes GITHUB_ENV": ("own_steps", lambda w: _edit_own(
        w, "static", PYYAML, "pyyaml\n", 'pyyaml\necho "PIP_INDEX_URL=https://example.invalid" >> "$GITHUB_ENV"\n')),
    "the TZ sentinel's January offset changes": ("own_steps", lambda w: _edit_own(
        w, "unit-ny-1", SENTINEL, "jan !== 300", "jan !== 240")),
    "the TZ sentinel drops its offset comparison": ("own_steps", lambda w: _edit_own(
        w, "unit-ny-1", SENTINEL, " || jan !== 300 || jul !== 240", " ")),
    # setup
    "a leg loses its checkout": ("setup", lambda w: _drop(w, "gates-b", _kinded("checkout"))),
    "a leg loses setup-node": ("setup", lambda w: _drop(w, "gates-c", _kinded("setup-node"))),
    "a leg loses npm ci": ("setup", lambda w: _drop(w, "unit-utc-cov", _kinded("npm-ci"))),
    "a leg installs node twice": ("setup", lambda w: _steps(w, "gates-a").append(
        copy.deepcopy(_steps(w, "gates-a")[_find(w, "gates-a", _kinded("setup-node"))]))),
    "setup-node is repinned in a leg": ("setup", lambda w: _steps(w, "gate-probes")[
        _find(w, "gate-probes", _kinded("setup-node"))].update({"with": {"node-version": "22", "cache": "npm"}})),
    "pytest gains setup-node": ("setup", lambda w: _steps(w, "pytest").append(
        copy.deepcopy(_steps(w, "static")[_find(w, "static", _kinded("setup-node"))]))),
    "pytest gains npm ci": ("setup", lambda w: _steps(w, "pytest").append(
        copy.deepcopy(_steps(w, "static")[_find(w, "static", _kinded("npm-ci"))]))),
    "npm ci moves ahead of setup-node": ("setup", lambda w: _swap(
        _steps(w, "unit-ny-1"), _find(w, "unit-ny-1", _kinded("setup-node")), _find(w, "unit-ny-1", _kinded("npm-ci")))),
    "the manifest dry-run moves after npm ci": ("setup", lambda w: _swap(
        _steps(w, "static"), _find(w, "static", lambda s: s.get("run") == DRY_RUN),
        _find(w, "static", _kinded("npm-ci")))),
    "a gate leg loses the Chrome resolve": ("setup", lambda w: _drop(w, "gate-probes", _kinded("chrome"))),
    "a leg with no gate resolves Chrome": ("setup", lambda w: _steps(w, "unit-ny-1").append(
        copy.deepcopy(_steps(w, "gates-a")[_find(w, "gates-a", _kinded("chrome"))]))),
    "the release-version guard loses its fetch": ("setup", lambda w: _drop(w, "static", _kinded("fetch-main"))),
    "gate_runner.py loses its PyYAML": ("setup", lambda w: _drop(w, "static", _named(PYYAML))),
    "the NY suite loses its sentinel": ("setup", lambda w: _drop(w, "unit-ny-1", _named(SENTINEL))),
    "the build moves after the check that reads it": ("setup", lambda w: _swap(
        _steps(w, "static"), _find(w, "static", CHAINS["dist/"][0]), _find(w, "static", CHAINS["dist/"][2]))),
    "the chunk check leaves the build's leg": ("setup", lambda w: _move(w, "static", "unit-ny-1", CHAINS["dist/"][2])),
    "the measured floor leaves the coverage leg": ("setup", lambda w: _move(
        w, "unit-utc-cov", "unit-ny-1", CHAINS["coverage/coverage-summary.json"][1])),
    "the build is dropped": ("setup", lambda w: _drop(w, "static", CHAINS["dist/"][0])),
    "the NY suite moves to another zone": ("setup", lambda w: [
        s["env"].update(TZ="America/Chicago") for s in _tz_steps(w)]),
    "the NY suite loses its zone": ("setup", lambda w: [
        s["env"].pop("TZ") for s in _tz_steps(w) if s.get("name") != SENTINEL]),
    "a second step sets TZ": ("setup", lambda w: _add(w, {"name": "added by the test", "env": {"TZ": "UTC"},
                                                         "run": "true"})),
    # shape: the job graph
    "a leg gains continue-on-error": ("shape", lambda w: w["jobs"]["gates-a"].update({"continue-on-error": True})),
    "a leg gains an if": ("shape", lambda w: w["jobs"]["gates-a"].update({"if": "github.ref == 'refs/heads/dev'"})),
    "a leg gains an if on the event": ("shape", lambda w: w["jobs"]["gates-a"].update(
        {"if": "github.event_name == 'push'"})),
    "a leg gains a matrix": ("shape", lambda w: w["jobs"]["gates-a"].update(strategy={"matrix": {"n": [1, 2]}})),
    "a leg gains needs": ("shape", lambda w: w["jobs"]["gates-b"].update(needs=["gates-a"])),
    "a leg gains a name": ("shape", lambda w: w["jobs"]["static"].update(name="Static checks")),
    "a leg gains an env": ("shape", lambda w: w["jobs"]["static"].update(env={"ADDED_BY_TEST": "1"})),
    "a leg gains services": ("shape", lambda w: w["jobs"]["static"].update(services={"db": {"image": "pg:17"}})),
    "a leg gains a container": ("shape", lambda w: w["jobs"]["static"].update(container="node:20")),
    "a leg gains a default shell": ("shape", lambda w: w["jobs"]["static"].update(defaults={"run": {"shell": "sh"}})),
    "a leg loses its timeout": ("shape", lambda w: w["jobs"]["unit-ny-1"].pop("timeout-minutes")),
    "a leg floats to ubuntu-latest": ("shape", lambda w: w["jobs"]["pytest"].update({"runs-on": "ubuntu-latest"})),
    "a leg is added and nobody lists it": ("shape", lambda w: w["jobs"].update(
        {"gates-d": copy.deepcopy(w["jobs"]["gates-c"])})),
    "a leg is dropped, needs and pinned list with it": ("shape", lambda w: (
        w["jobs"].pop("gates-c"), _agg(w)["needs"].remove("gates-c"), _repin(w, " gates-c", ""))),
    "the aggregator drops a need": ("shape", lambda w: _agg(w)["needs"].remove("gates-c")),
    "the aggregator loses always()": ("shape", lambda w: _agg(w).pop("if")),
    "the aggregator runs only on success": ("shape", lambda w: _agg(w).update({"if": "success()"})),
    "the aggregator gains a name": ("shape", lambda w: _agg(w).update(name="Verdict")),
    "the aggregator becomes a reusable-workflow call": ("shape", lambda w: _agg(w).update(
        uses="./.github/workflows/x.yml")),
    "the aggregator loses its timeout": ("shape", lambda w: _agg(w).pop("timeout-minutes")),
    "the aggregator is made advisory": ("shape", lambda w: _agg(w).update({"continue-on-error": True})),
    "the aggregator gains a second step": ("shape", lambda w: _agg(w)["steps"].append({"run": "true"})),
    "the aggregator's step gains an if": ("shape", lambda w: _agg(w)["steps"][0].update({"if": "failure()"})),
    "the aggregator's step uses an action": ("shape", lambda w: _agg(w)["steps"][0].update(
        uses="actions/checkout@v0")),
    "the aggregator reads something other than needs": ("shape", lambda w: _agg(w)["steps"][0]["env"].update(
        NEEDS="${{ toJSON(needs.static) }}")),
    "the pinned list loses a leg": ("shape", lambda w: _repin(w, " gates-c", "")),
    "the pinned list gains a leg": ("shape", lambda w: _repin(w, " gate-probes\"", " gate-probes gates-d\"")),
    "the pinned list is no longer one literal line": ("shape", lambda w: _repin(
        w, 'EXPECTED_LEGS="', 'EXPECTED_LEGS="$X ')),
    "permissions widen": ("shape", lambda w: w["permissions"].update(actions="read")),
    "permissions are dropped": ("shape", lambda w: w.pop("permissions")),
    "the workflow gains an env": ("shape", lambda w: w.update(env={"ADDED_BY_TEST": "1"})),
    "the workflow gains a default shell": ("shape", lambda w: w.update(defaults={"run": {"shell": "sh"}})),
    # shape: the triggers, the group and the name the promote reads
    "ci.yml gains workflow_dispatch": ("shape", lambda w: _on(w).update(workflow_dispatch=None)),
    "ci.yml gains workflow_dispatch with an input": ("shape", lambda w: _on(w).update(
        workflow_dispatch={"inputs": {"canary_red_leg": {"type": "string", "default": ""}}})),
    "ci.yml gains workflow_call": ("shape", lambda w: _on(w).update(workflow_call=None)),
    "ci.yml gains a schedule": ("shape", lambda w: _on(w).update(schedule=[{"cron": "0 5 * * *"}])),
    "ci.yml's push trigger widens to another branch": ("shape", lambda w: _on(w)["push"]["branches"].append("staging")),
    "ci.yml's push trigger gains a paths filter": ("shape", lambda w: _on(w)["push"].update(paths=["src/**"])),
    "ci.yml loses its dev push": ("shape", lambda w: _on(w).pop("push")),
    "ci.yml loses pull_request": ("shape", lambda w: _on(w).pop("pull_request")),
    "ci.yml's pull_request narrows": ("shape", lambda w: _on(w)["pull_request"]["branches"].remove("main")),
    "ci.yml's concurrency group changes": ("shape", lambda w: w["concurrency"].update(group="ci-${{ github.sha }}")),
    "ci.yml stops cancelling superseded runs": ("shape", lambda w: w["concurrency"].update(
        {"cancel-in-progress": False})),
    "ci.yml loses its concurrency": ("shape", lambda w: w.pop("concurrency")),
    "ci.yml's aggregator is renamed": ("shape", lambda w: w["jobs"].update({"verdict": w["jobs"].pop(GATE)})),
    "ci.yml gains a job named integration-tests": ("shape", lambda w: w["jobs"].update(
        {"integration-tests": copy.deepcopy(w["jobs"]["pytest"])})),
    "ci.yml is the single serial job again": ("shape", lambda w: w.update(jobs={GATE: {
        "runs-on": "ubuntu-26.04", "timeout-minutes": 90, "steps": _all_steps(w)}})),
    # handoffs: each of these passes once and setup
    "a step that writes GITHUB_ENV is added": ("handoffs", lambda w: _add(
        w, {"name": "More heap", "run": 'echo "NODE_OPTIONS=--max-old-space-size=8192" >> "$GITHUB_ENV"'})),
    "a step that writes GITHUB_PATH is added": ("handoffs", lambda w: _add(
        w, {"name": "Tool on PATH", "run": 'echo "$HOME/bin" >> "$GITHUB_PATH"'})),
    "an apt-get install is added": ("handoffs", lambda w: _add(
        w, {"name": "Fonts", "run": "sudo apt-get install -y fonts-roboto"})),
    "a pip install is added": ("handoffs", lambda w: _add(w, {"name": "Deps", "run": "pip install --quiet psycopg"})),
    "a python3 -m pip install is added": ("handoffs", lambda w: _add(
        w, {"name": "Deps", "run": "python3 -m pip install --quiet psycopg"})),
    "an npm install -g is added": ("handoffs", lambda w: _add(
        w, {"name": "Global tool", "run": "npm install -g some-cli"})),
    "an npm i --global is added": ("handoffs", lambda w: _add(
        w, {"name": "Global tool", "run": "npm i some-cli --global"})),
    "an action is added": ("handoffs", lambda w: _add(
        w, {"uses": "actions/setup-python@v5", "with": {"python-version": "3.12"}})),
    "a listed hand-off step is renamed": ("handoffs", lambda w: [
        s.update(name="Resolve Chrome") for leg in GATE_LEGS for s in _steps(w, leg) if _kind(s) == "chrome"]),
    # unit_passes: the passes, and each way the retired key can come back
    "the retired key comes back on the UTC pass": ("unit_passes", lambda w: _pass(w, "unit-utc-cov-1").update(
        env={RETIRED_KEY: "1"})),
    "the retired key comes back on the NY pass": ("unit_passes", lambda w: _pass(w, "unit-ny-1")["env"].update(
        {RETIRED_KEY: "1"})),
    "the retired key comes back on every pass": ("unit_passes", lambda w: [
        _pass(w, leg).setdefault("env", {}).update({RETIRED_KEY: "1"}) for leg in UNIT_STEPS]),
    "the retired key comes back as an unquoted 1": ("unit_passes", lambda w: _pass(w, "unit-ny-1")["env"].update(
        {RETIRED_KEY: 1})),
    "a gate step takes the retired key": ("unit_passes", lambda w: _gate(w)["env"].update({RETIRED_KEY: "1"})),
    "the TZ sentinel takes the retired key": ("unit_passes", lambda w: _own(w, "unit-ny-1", SENTINEL)["env"].update(
        {RETIRED_KEY: "1"})),
    "the retired key is set for a unit leg": ("unit_passes", lambda w: w["jobs"]["unit-ny-1"].update(
        env={RETIRED_KEY: "1"})),
    "the retired key is set for the whole workflow": ("unit_passes", lambda w: w.update(env={RETIRED_KEY: "1"})),
    "a step sets the retired key inside its run": ("unit_passes", lambda w: _gate(w).update(
        run="export %s=1\n%s" % (RETIRED_KEY, _gate(w)["run"]))),
    "a unit pass is renamed": ("unit_passes", lambda w: _pass(w, "unit-utc-cov-1").update(name="Unit tests")),
    "a third unit pass is added": ("unit_passes", lambda w: _add(
        w, {"name": "A third pass", "run": "npx vitest run --no-coverage"}, leg="unit-ny-1")),
    # shards (plan A4)
    "two coverage shards run the same third": ("shards", lambda w: _pass(w, "unit-utc-cov-2").update(
        run=_pass(w, "unit-utc-cov-2")["run"].replace("--shard=2/3", "--shard=1/3"))),
    "a coverage shard enforces a threshold on its third": ("shards", lambda w: _pass(w, "unit-utc-cov-1").update(
        run=_pass(w, "unit-utc-cov-1")["run"].replace("--coverage.thresholds.branches=0 ", ""))),
    "a coverage shard writes the reports": ("shards", lambda w: _pass(w, "unit-utc-cov-3").update(
        run=_pass(w, "unit-utc-cov-3")["run"].replace("--coverage.reporter=none ", ""))),
    "a coverage shard writes its blob where the upload does not look": ("shards", lambda w: _pass(
        w, "unit-utc-cov-2").update(run=_pass(w, "unit-utc-cov-2")["run"].replace(
            "vitest-blobs/blob-2-3.json", ".vitest-reports/blob-2-3.json"))),
    "a shard uploads under another shard's name": ("shards", lambda w: _steps(w, "unit-utc-cov-2")[_find(
        w, "unit-utc-cov-2", _named(UPLOAD_STEP % (2, 3)))]["with"].update(name="vitest-blob-utc-1")),
    "a shard's upload passes with no blob": ("shards", lambda w: _steps(w, "unit-utc-cov-1")[_find(
        w, "unit-utc-cov-1", _named(UPLOAD_STEP % (1, 3)))]["with"].update({"if-no-files-found": "warn"})),
    "a shard's upload floats to a tag": ("shards", lambda w: _steps(w, "unit-utc-cov-3")[_find(
        w, "unit-utc-cov-3", _named(UPLOAD_STEP % (3, 3)))].update(uses=UPLOAD + "@v7")),
    "the download looks for other artifacts": ("shards", lambda w: _steps(w, MERGE_LEG)[_find(
        w, MERGE_LEG, _named(DOWNLOAD_STEP))]["with"].update(pattern="vitest-blob-*")),
    "the merge loses its blob count": ("shards", lambda w: _steps(w, MERGE_LEG)[_find(
        w, MERGE_LEG, _named(MERGE_STEP))].update(run="npx vitest run --merge-reports=vitest-blobs --coverage\n")),
    "the merge accepts two blobs": ("shards", lambda w: _edit_own(
        w, MERGE_LEG, MERGE_STEP, "blob-1-3.json blob-2-3.json blob-3-3.json ", "blob-1-3.json blob-2-3.json ")),
    "the merge drops the thresholds": ("shards", lambda w: _edit_own(
        w, MERGE_LEG, MERGE_STEP, "--coverage |", "--coverage --coverage.thresholds.lines=0 |")),
    "the merge stops holding the shards' files to the suite's": ("shards", lambda w: _edit_own(
        w, MERGE_LEG, MERGE_STEP, 'if [ "$GOT" != "$WANT" ]', 'if false')),
    "the merge stops waiting for a shard": ("shards", lambda w: w["jobs"][MERGE_LEG]["needs"].remove("unit-utc-cov-3")),
    "the merge waits on a leg that is not a shard": ("shards", lambda w: w["jobs"][MERGE_LEG]["needs"].append(
        "unit-ny-1")),
    "the merge leg loses its needs": ("shards", lambda w: w["jobs"][MERGE_LEG].pop("needs")),
    "the config's ratchet check moves into a shard": ("shards", lambda w: _move(
        w, MERGE_LEG, "unit-utc-cov-1", _named(RATCHET))),
    "a gate leg uploads an artifact": ("shards", lambda w: _steps(w, "gates-a").append(
        dict(copy.deepcopy(_steps(w, "unit-utc-cov-1")[_find(w, "unit-utc-cov-1", _named(UPLOAD_STEP % (1, 3)))]),
             name="Upload the gate's output"))),
    "a coverage shard is dropped, with its need and its pin": ("shards", lambda w: (
        w["jobs"].pop("unit-utc-cov-3"), _agg(w)["needs"].remove("unit-utc-cov-3"),
        w["jobs"][MERGE_LEG]["needs"].remove("unit-utc-cov-3"), _repin(w, " unit-utc-cov-3", ""))),
    "the two NY shards run the same half": ("shards", lambda w: _pass(w, "unit-ny-2").update(
        run="npx vitest run --no-coverage --shard=1/2")),
    "a NY shard runs the whole suite": ("shards", lambda w: _pass(w, "unit-ny-1").update(
        run="npx vitest run --no-coverage")),
    # shape: the merge leg's one exception, and nothing more
    "the merge leg gains an if": ("shape", lambda w: w["jobs"][MERGE_LEG].update({"if": "always()"})),
    "a shard gains needs": ("shape", lambda w: w["jobs"]["unit-utc-cov-2"].update(needs=["unit-utc-cov-1"])),
    "a NY shard gains needs": ("shape", lambda w: w["jobs"]["unit-ny-2"].update(needs=["unit-ny-1"])),
}


@pytest.mark.parametrize("check,mutate", list(MUTATIONS.values()), ids=list(MUTATIONS))
def test_every_kind_of_drift_is_reported_by_the_check_that_owns_it(check, mutate):
    """A check that cannot fail holds nothing: each of these, made in memory, must be reported."""
    ci = copy.deepcopy(_load(CI))
    if CHECKS[check](ci):
        pytest.skip("the tree as committed fails `%s`; test_ci_holds[%s] says how" % (check, check))
    before = repr(ci)
    mutate(ci)
    assert repr(ci) != before, "the mutation changed nothing: fix the mutation"
    assert CHECKS[check](ci) != []


def test_the_mutations_reach_every_check():
    assert {check for check, _ in MUTATIONS.values()} == set(CHECKS)


def test_an_ordinary_new_check_in_one_leg_passes_every_check():
    """The pins above must not turn "add a check to CI" into a puzzle: a new step that hands nothing on, added to
    one leg, is green everywhere. (`npm install --dry-run` is the near miss for the hand-off pattern: an install
    that writes nothing.)"""
    ci = copy.deepcopy(_load(CI))
    if any(check(ci) for check in CHECKS.values()):
        pytest.skip("the tree as committed fails a check; test_ci_holds says which and how")
    _add(ci, {"name": "A new check", "run": "npm run check:new && npm install --dry-run --package-lock-only"})
    _add(ci, {"name": "A new script check", "run": "python3 scripts/check-something.py"}, leg="static")
    _add(ci, {"name": "A new gate", "env": {"GATE_CHROME_FLAGS": "--headless=new"}, "run": "npm run gate:new"},
         leg="gates-b")
    assert [found for check in CHECKS.values() for found in check(ci)] == []


CONCURRENCY_MUTATIONS = {
    "another file takes ci.yml's group": lambda w: w["integration-test.yml"]["concurrency"].update(
        group=w[CI]["concurrency"]["group"]),
    "ci.yml takes another file's group, as a bare string": lambda w: w[CI].update(
        concurrency=w["integration-test.yml"]["concurrency"]["group"]),
    "a job in another file takes ci.yml's group": lambda w: next(iter(w["schema-audit.yml"]["jobs"].values())).update(
        concurrency={"group": w[CI]["concurrency"]["group"]}),
    "a job in ci.yml takes another file's group": lambda w: w[CI]["jobs"]["static"].update(
        concurrency=w["integration-test.yml"]["concurrency"]["group"]),
}


@pytest.mark.parametrize("name", list(CONCURRENCY_MUTATIONS))
def test_a_shared_concurrency_group_is_reported(name):
    workflows = copy.deepcopy(_all_workflows())
    CONCURRENCY_MUTATIONS[name](workflows)
    assert concurrency(workflows) != []
