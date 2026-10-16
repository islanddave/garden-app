"""scripts/household-observability.sh (OPS-HOUSEHOLDALARMS-001) watches log lines by their `msg` literal,
on named log groups. A renamed literal or a new caller of warnRejectedFk would leave an alarm reading OK
over a metric nothing feeds, so both are pinned here to the code that emits them."""
import os
import re
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
SCRIPT = open(os.path.join(HERE, "household-observability.sh")).read()


def _filters():
    block = re.search(r'^FILTERS="\n(.*?)^"', SCRIPT, re.S | re.M).group(1)
    return [line.split("|") for line in block.splitlines() if line.strip()]


def test_fk_functions_are_exactly_the_dirs_that_call_warnRejectedFk():
    listed = set(re.search(r'^FK_FUNCTIONS="([^"]+)"', SCRIPT, re.M).group(1).split())
    out = subprocess.run(["git", "grep", "-l", "warnRejectedFk(", "--", "lambda"], cwd=ROOT,
                         capture_output=True, text=True, check=True).stdout.split()
    callers = {p.split("/")[1] for p in out
               if not p.endswith((".test.js", "/household.js")) and p.count("/") >= 2
               and os.path.isfile(os.path.join(ROOT, "lambda", p.split("/")[1], "package.json"))}
    assert listed == callers


def test_every_watched_msg_is_emitted_by_its_function():
    for name, fn, metric, msg in _filters():
        src = subprocess.run(["git", "grep", "-l", "msg: '%s'" % msg, "--", "lambda/%s/" % fn], cwd=ROOT,
                             capture_output=True, text=True).stdout.split()
        assert [p for p in src if not p.endswith(".test.js")], (name, fn, msg)
    assert "msg: 'authz-fk-reject'" in open(os.path.join(ROOT, "lambda", "household.js")).read()


def test_every_metric_has_one_alarm():
    metrics = {m for _, _, m, _ in _filters()} | {"AuthzFkReject"}
    block = re.search(r'^ALARMS="\n(.*?)^"', SCRIPT, re.S | re.M).group(1)
    alarmed = [line.split("|")[0] for line in block.splitlines() if line.strip()]
    assert sorted(alarmed) == sorted(metrics)
