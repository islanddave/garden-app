# new-file: a new subject, scripts/share-observability.sh (OPS-LOGINJECTGUARD-001)
"""scripts/share-observability.sh holds garden-facebook-share's seven metric filters. Pins each anchored pattern as
provision sends it, with the live name and metric, and test-patterns' prefixed positives and forged-401 controls.
Trap: a quoted phrase matches anywhere in a line, and the kit's 401 line quotes a caller's token kid."""
import json
import os
import re
import subprocess

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SCRIPT_PATH = os.path.join(HERE, "share-observability.sh")
T = "\t"

# Records each call. test-metric-filter answers FAKE_ANSWER, or else evaluates the pattern the way CloudWatch reads
# a space-delimited one: fields split on whitespace, `name=value` must equal the field, a trailing `...` takes the rest.
# The LogFormat read answers FAKE_FORMAT (default Text); "refused" exits non-zero, as a denied or failed call does.
FAKE_AWS = r'''#!/usr/bin/env python3
import json, os, sys
a = sys.argv[1:]
open(os.environ["REC"], "a").write(json.dumps(a) + "\n")
def match(pat, line):
    if not pat.startswith("["):
        return pat.strip('"') in line
    fields = pat[1:-1].split(", ")
    rest = fields[-1] == "..."
    conds = fields[:-1] if rest else fields
    toks = line.split()
    if len(toks) < len(conds) or (not rest and len(toks) != len(conds)):
        return False
    return all("=" not in c or t == c.split("=", 1)[1] for c, t in zip(conds, toks))
if a[:2] == ["lambda", "get-function-configuration"]:
    if os.environ.get("FAKE_FORMAT") == "refused":
        sys.exit(254)
    print(os.environ.get("FAKE_FORMAT") or "Text")
if a[:2] == ["logs", "test-metric-filter"]:
    pat, line = a[a.index("--filter-pattern") + 1], a[a.index("--log-event-messages") + 1]
    print(os.environ.get("FAKE_ANSWER") or ("1" if match(pat, line) else "0"))
'''

# PIN: the live filters' names and metrics (describe-metric-filters); a pattern change is re-proven with test-patterns.
FILTERS = {
    "share-attempt": ("[ts, rid, level=INFO, w1=SHARE_METRIC, w2=attempt, ...]", "ShareAttempts"),
    "share-posted": ("[ts, rid, level=INFO, w1=SHARE_METRIC, w2=posted, ...]", "SharePosted"),
    "share-failed": ("[ts, rid, level=INFO, w1=SHARE_METRIC, w2=failed, ...]", "ShareFailed"),
    "share-rejected": ("[ts, rid, level=INFO, w1=SHARE_METRIC, w2=rejected, ...]", "ShareRejected"),
    "share-blocked": ("[ts, rid, level=INFO, w1=SHARE_METRIC, w2=blocked, ...]", "ShareBlocked"),
    "share-staging-retained": ("[ts, rid, level=INFO, w1=SHARE_METRIC, w2=staging_version_retained, ...]",
                               "ShareStagingRetained"),
    "share-orphan-stranded": ("[ts, rid, level=ERROR, w1=orphan, w2=cleanup, w3=FAILED, ...]", "ShareOrphanStranded"),
}
ALARMED = ("share-failed", "share-orphan-stranded", "share-staging-retained")


def _run(tmp_path, sub, answer="", fmt=""):
    bindir = tmp_path / "bin"
    bindir.mkdir(exist_ok=True)
    (bindir / "aws").write_text(FAKE_AWS)
    (bindir / "aws").chmod(0o755)
    rec = tmp_path / "rec.jsonl"
    rec.write_text("")
    env = dict(os.environ, PATH=f"{bindir}:{os.environ['PATH']}", REC=str(rec), FAKE_ANSWER=answer,
               FAKE_FORMAT=fmt, AWS_REGION="us-east-1")
    p = subprocess.run(["bash", SCRIPT_PATH, sub], capture_output=True, text=True, env=env)
    return p, [json.loads(ln) for ln in rec.read_text().splitlines()]


def _arg(call, flag):
    return call[call.index(flag) + 1]


def _words(pattern):
    return [f.split("=", 1)[1] for f in pattern[1:-1].split(", ") if f.startswith("w")]


def _checks(tmp_path):
    """(fields of the line, expected count, pattern) per test-patterns check, in order."""
    p, calls = _run(tmp_path, "test-patterns", answer="x")
    assert p.returncode == 1
    expected = re.findall(r"FAIL  .* \(expected (\d) match\(es\), got x\)$", p.stdout, re.M)
    tmf = [c for c in calls if c[:2] == ["logs", "test-metric-filter"]]
    assert len(tmf) == len(expected) >= len(FILTERS)
    return [(_arg(c, "--log-event-messages").split(T, 3), want, _arg(c, "--filter-pattern"))
            for c, want in zip(tmf, expected)]


def test_provision_writes_each_filter_with_its_anchored_pattern_name_and_metric(tmp_path):
    p, calls = _run(tmp_path, "provision")
    assert p.returncode == 0, p.stdout + p.stderr
    puts = {_arg(c, "--filter-name"): c for c in calls if c[1] == "put-metric-filter"}
    assert set(puts) == set(FILTERS) and [c[1] for c in calls[-len(FILTERS):]] == ["put-metric-filter"] * len(FILTERS)
    before = [c[:2] for c in calls[:-len(FILTERS)]]
    assert ["lambda", "get-function-configuration"] in before and ["logs", "test-metric-filter"] in before
    assert all(c in (["logs", "test-metric-filter"], ["lambda", "get-function-configuration"]) for c in before)
    for name, (pattern, metric) in FILTERS.items():
        put = puts[name]
        assert _arg(put, "--filter-pattern") == pattern, name
        assert _arg(put, "--log-group-name") == "/aws/lambda/garden-facebook-share"
        assert _arg(put, "--metric-transformations") == \
            f"metricName={metric},metricNamespace=Garden/Share,metricValue=1,defaultValue=0"
        assert _arg(put, "--region") == "us-east-1"


def test_each_pattern_names_words_the_handler_logs_first():
    src = open(os.path.join(ROOT, "lambda", "facebook-share", "index.js"), encoding="utf-8").read()
    orphans = open(os.path.join(ROOT, "lambda", "facebook-share", "orphans.js"), encoding="utf-8").read()
    assert "const SHARE_METRIC_PREFIX = 'SHARE_METRIC';" in src
    # The levels the patterns anchor on are these console methods (OPS-LOGINJECTGUARD-001): a console.warn here
    # would move the line to WARN and silence the alarm with nothing else red.
    assert src.count("try { console.log(`${SHARE_METRIC_PREFIX} ") == 1
    assert src.count("log: (msg, detail) => console.error(") == 1
    for name, (pattern, _) in FILTERS.items():
        words = _words(pattern)
        if words[0] == "SHARE_METRIC":
            # shareMetric() is console.log (INFO); 'failed' also comes from outcomeForStatus.
            assert len(words) == 2 and ("shareMetric('%s'" % words[1] in src or "return '%s'" % words[1] in src), name
            assert "level=INFO," in pattern
        else:
            assert "log(`%s " % " ".join(words) in orphans and "level=ERROR," in pattern, name


def test_test_patterns_proves_what_provision_installs_on_prefixed_lines(tmp_path):
    checks = _checks(tmp_path)
    assert {pat for _, _, pat in checks} == {pat for pat, _ in FILTERS.values()}
    assert all(len(f) == 4 and f[1].count("-") == 4 for f, _, _ in checks)
    for pattern, _ in FILTERS.values():
        level = re.search(r"level=(\w+)", pattern).group(1)
        assert any(pat == pattern and want == "1" and f[2] == level and f[3].split()[:len(_words(pattern))] ==
                   _words(pattern) for f, want, pat in checks), pattern


def test_each_alarmed_filter_has_a_forged_401_control(tmp_path):
    checks = _checks(tmp_path)
    for name in ALARMED:
        pattern = FILTERS[name][0]
        phrase = " ".join(_words(pattern))
        forged = [want for f, want, pat in checks if pat == pattern and f[2] == "ERROR"
                  and f[3].startswith("verifyToken failed: ") and phrase in f[3]]
        assert forged == ["0"], name


def test_test_patterns_passes_when_answers_follow_the_patterns(tmp_path):
    p, calls = _run(tmp_path, "test-patterns")
    assert p.returncode == 0, p.stdout
    reads = [c for c in calls if c[:2] != ["logs", "test-metric-filter"]]
    assert len(calls) > len(reads) and [c[:2] for c in reads] == [["lambda", "get-function-configuration"]]


def test_test_patterns_prints_the_live_log_format_OPS_LOGINJECTGUARD_001(tmp_path):
    p, calls = _run(tmp_path, "test-patterns")
    assert "  ok    log format garden-facebook-share: Text" in p.stdout.splitlines()
    read = [c for c in calls if c[:2] == ["lambda", "get-function-configuration"]]
    assert len(read) == 1
    assert _arg(read[0], "--function-name") == "garden-facebook-share" and _arg(read[0], "--region") == "us-east-1"
    assert _arg(read[0], "--query") == "LoggingConfig.LogFormat"


@pytest.mark.parametrize("fmt, shown", [("JSON", "JSON"), ("refused", "unreadable")])
def test_provision_refuses_unless_the_function_logs_in_text_OPS_LOGINJECTGUARD_001(tmp_path, fmt, shown):
    """The anchored patterns cannot read a JSON-format line, so three alarms would sit OK through real failures."""
    p, calls = _run(tmp_path, "test-patterns", fmt=fmt)
    assert p.returncode == 1 and f"  FAIL  log format garden-facebook-share: {shown} (want Text)" in p.stdout.splitlines()
    p, calls = _run(tmp_path, "provision", fmt=fmt)
    assert p.returncode == 1 and "does not log in Text" in p.stderr
    assert not [c for c in calls if c[1] == "put-metric-filter"]


def test_provision_runs_test_patterns_first_and_refuses_on_a_failure_OPS_LOGINJECTGUARD_001(tmp_path):
    p, calls = _run(tmp_path, "provision", answer="x")
    assert p.returncode == 1 and "refusing to write the filters" in p.stderr
    assert [c for c in calls if c[:2] == ["logs", "test-metric-filter"]]
    assert not [c for c in calls if c[1] == "put-metric-filter"]
