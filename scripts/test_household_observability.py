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


def _run_defs(tail, check=True):
    """Runs the script's definitions (everything above the dispatch `case`), then `tail`. No AWS call is made
    unless `tail` makes one; tails below shadow `aws` or the per-filter callback."""
    head = SCRIPT[:SCRIPT.index('\ncase "${1:-}" in')]
    return subprocess.run(["bash", "-c", head + "\n" + tail, os.path.join(HERE, "household-observability.sh")],
                          capture_output=True, text=True, check=check)


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
    rows = _run_defs('need_membership_functions\nrow() { echo "$1|$2|$3|$4"; }\neach_filter row').stdout.split()
    memb = {r.split("|")[1] for r in rows if r.startswith("household-membership-denied|")}
    assert memb == gated
    assert {r for r in rows if r.startswith("household-membership-denied|")} == {
        "household-membership-denied|%s|HouseholdMembershipDenied|household-membership-denied" % f for f in gated}
    verified = _run_defs('need_membership_functions\nverify_filter() { echo "$1|$2"; }\nverify_filters').stdout.split()
    assert {r.split("|")[1] for r in verified if r.startswith("household-membership-denied|")} == gated
    # verify_log_format drops aws's stderr, so the shadow reports the function names on fd 3.
    probed = _run_defs("need_membership_functions\nexec 3>&2\n"
                       "aws() { printf '%s\\n' \"$@\" | grep '^garden-' >&3; echo Text; }\nverify_log_format").stderr.split()
    assert set(probed) >= {"garden-" + f for f in gated} | {"garden-daily-plan"}


# Records each test-metric-filter call's pattern and line on fd 3 and answers "probe", so every check prints
# FAIL with its label and expected count, in call order.
_RECORD_TMF = (
    "exec 3>&2\n"
    "aws() { local p= l=; while [ $# -gt 0 ]; do case $1 in --filter-pattern) p=$2; shift ;; "
    "--log-event-messages) l=$2; shift ;; esac; shift; done; printf '%s\\037%s\\n' \"$p\" \"$l\" >&3; echo probe; }\n"
)


def test_membership_pattern_has_a_negative_control_for_requester_text_in_the_photos_route_line():
    """OPS-CODEREVIEW-001 sec 9: garden-photos logs `route <method> <rawPath>` before its gate runs, so a caller
    can put `{"msg":"household-membership-denied"}` at the end of the path. test-patterns must require 0
    matches on that line with the pattern provision installs."""
    run = _run_defs(_RECORD_TMF + "test_patterns", check=False)
    calls = [r.split("\x1f") for r in run.stderr.splitlines() if "\x1f" in r]
    results = re.findall(r"^  FAIL  .*\(expected (\d+), got probe\)$", run.stdout, re.M)
    assert len(calls) == len(results) > 0
    provisioned = _run_defs("pattern household-membership-denied").stdout
    forged = re.compile(r'[^\t]+\t[^\t]+\tINFO\troute GET /x\{"msg":"household-membership-denied"\}')
    controls = [want for (pat, line), want in zip(calls, results) if pat == provisioned and forged.fullmatch(line)]
    assert controls == ["0"]


_REFUSING_MANIFEST = 'def url_functions():\n    raise RuntimeError("manifest declares 24 URL functions")\n'
_AWS_SHADOW = (
    "exec 3>&2\n"
    "aws() { case \"$*\" in\n"
    "  'sts get-caller-identity'*) echo 769788341849 ;;\n"
    "  *'--metric-name HouseholdMembershipDenied'*) printf '/aws/lambda/garden-photos\\t/aws/lambda/garden-events\\n' ;;\n"
    "  *) echo \"aws $*\" >&3 ;;\n"
    "esac; }\n"
)


def test_status_and_teardown_survive_a_refused_manifest_while_provision_and_alarm_refuse_it(tmp_path):
    """OPS-CODEREVIEW-001 reg 6: only provision and alarm need the manifest's URL functions. status and teardown
    read or remove what exists, so a manifest url_functions refuses must not stop them: they use the log
    groups that hold a membership filter now."""
    (tmp_path / "post-promote-check.py").write_text(_REFUSING_MANIFEST)
    bad = 'HERE="%s"\n' % tmp_path + _AWS_SHADOW
    for cmd in ("provision", "alarm"):
        run = _run_defs(bad + cmd, check=False)
        assert run.returncode == 1, cmd
        assert "refusing: cannot read the URL functions" in run.stderr, cmd
        assert not re.search(r"^aws (logs put-metric-filter|cloudwatch put-metric-alarm|logs test-metric-filter)",
                             run.stderr, re.M), cmd
    run = _run_defs(bad + 'verify_filter() { echo "$1|$2"; }\nstatus')
    assert {r.split("|")[1] for r in run.stdout.split() if r.startswith("household-membership-denied|")} == {
        "photos", "events"}
    assert "aws cloudwatch describe-alarms" in run.stderr
    run = _run_defs(bad + "teardown")
    removed = set(re.findall(r"^aws logs delete-metric-filter .*garden-(\S+) --filter-name household-membership-denied$",
                             run.stderr, re.M))
    assert removed == {"photos", "events"}
    assert "aws cloudwatch delete-alarms" in run.stderr
    run = _run_defs(_AWS_SHADOW + 'verify_filter() { echo "$1|$2"; }\nstatus')
    assert {r.split("|")[1] for r in run.stdout.split() if r.startswith("household-membership-denied|")} == \
        _gated_functions()
