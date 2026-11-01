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
    metrics = {m for _, _, m, _ in _filters()} | {"AuthzFkReject", "HouseholdMembershipDenied"}
    block = re.search(r'^ALARMS="\n(.*?)^"', SCRIPT, re.S | re.M).group(1)
    alarmed = [line.split("|")[0] for line in block.splitlines() if line.strip()]
    assert sorted(alarmed) == sorted(metrics)


def _run_defs(tail):
    """Runs the script's definitions (everything above the dispatch `case`), then `tail`. No AWS call is made
    unless `tail` makes one; tails below shadow `aws` or the per-filter callback."""
    head = SCRIPT[:SCRIPT.index('\ncase "${1:-}" in')]
    return subprocess.run(["bash", "-c", head + "\n" + tail, os.path.join(HERE, "household-observability.sh")],
                          capture_output=True, text=True, check=True)


def _gated_functions():
    """Dirs whose request-context.js runs householdGate, which logs household-membership-denied."""
    out = subprocess.run(["git", "grep", "-l", "householdGate(", "--", "lambda/*/request-context.js"], cwd=ROOT,
                         capture_output=True, text=True, check=True).stdout.split()
    return {p.split("/")[1] for p in out}


def test_membership_filter_is_made_verified_and_format_checked_on_every_gated_function():
    """OPS-CODEREVIEW-001 L7: every URL function's gate can log household-membership-denied, so a filter on
    garden-shared-state alone leaves 22 functions' refusals unalarmed."""
    gated = _gated_functions()
    assert len(gated) == 23
    for fn in gated:
        assert "msg: 'household-membership-denied'" in open(os.path.join(ROOT, "lambda", fn, "household.js")).read(), fn
    rows = _run_defs('row() { echo "$1|$2|$3|$4"; }\neach_filter row').stdout.split()
    memb = {r.split("|")[1] for r in rows if r.startswith("household-membership-denied|")}
    assert memb == gated
    assert {r for r in rows if r.startswith("household-membership-denied|")} == {
        "household-membership-denied|%s|HouseholdMembershipDenied|household-membership-denied" % f for f in gated}
    verified = _run_defs('verify_filter() { echo "$1|$2"; }\nverify_filters').stdout.split()
    assert {r.split("|")[1] for r in verified if r.startswith("household-membership-denied|")} == gated
    # verify_log_format drops aws's stderr, so the shadow reports the function names on fd 3.
    probed = _run_defs("exec 3>&2\naws() { printf '%s\\n' \"$@\" | grep '^garden-' >&3; echo Text; }\nverify_log_format").stderr.split()
    assert set(probed) >= {"garden-" + f for f in gated} | {"garden-daily-plan"}
