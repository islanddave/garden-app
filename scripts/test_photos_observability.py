# new-file: a new subject, scripts/photos-observability.sh (OPS-LOGINJECTGUARD-001)
"""scripts/photos-observability.sh holds the photos-lambda-error filter behind garden-photos-handler-error. Pins its
anchored pattern to the catch-all line photos logs, and provision to test-patterns and the live name and metric.
Trap: a quoted phrase matches anywhere in a line, and the kit's 401 line quotes a caller's token kid."""
import json
import os
import re
import subprocess

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SCRIPT_PATH = os.path.join(HERE, "photos-observability.sh")
SCRIPT = open(SCRIPT_PATH, encoding="utf-8").read()
T = "\t"

# Records each call and answers test-metric-filter with FAKE_ANSWER, or with "1" exactly when the line is an
# ERROR-level line whose message starts with the catch-all's words (the anchored pattern's meaning). The LogFormat
# read answers FAKE_FORMAT (default Text); "refused" exits non-zero, as a denied or failed call does.
FAKE_AWS = r'''#!/usr/bin/env python3
import json, os, sys
a = sys.argv[1:]
open(os.environ["REC"], "a").write(json.dumps(a) + "\n")
if a[:2] == ["sts", "get-caller-identity"]:
    print("769788341849")
elif a[:2] == ["lambda", "get-function-configuration"]:
    if os.environ.get("FAKE_FORMAT") == "refused":
        sys.exit(254)
    print(os.environ.get("FAKE_FORMAT") or "Text")
elif a[:2] == ["logs", "test-metric-filter"]:
    line = a[a.index("--log-event-messages") + 1]
    f = line.split("\t", 3)
    model = len(f) == 4 and f[2] == "ERROR" and f[3].split()[:3] == ["photos", "lambda", "error"]
    print(os.environ.get("FAKE_ANSWER") or ("1" if model else "0"))
'''


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


def _pattern():
    return re.search(r"^PATTERN='([^']*)'$", SCRIPT, re.M).group(1)


def test_the_pattern_anchors_level_and_first_words_of_the_catch_all_line():
    m = re.fullmatch(r"\[ts, rid, level=(\w+), w1=(\w+), w2=(\w+), w3=(\w+), \.\.\.\]", _pattern())
    assert m, _pattern()
    level, *words = m.groups()
    src = open(os.path.join(ROOT, "lambda", "photos", "index.js"), encoding="utf-8").read()
    # console.error is what writes ERROR into the line's level field.
    assert level == "ERROR"
    assert src.count("console.error('%s', err);" % " ".join(words)) == 1


def test_test_patterns_has_a_positive_control_and_forged_401_controls(tmp_path):
    p, calls = _run(tmp_path, "test-patterns", answer="x")
    assert p.returncode == 1
    expected = re.findall(r"FAIL  .* \(expected (\d), got x\)$", p.stdout, re.M)
    tmf = [c for c in calls if c[:2] == ["logs", "test-metric-filter"]]
    assert len(tmf) == len(expected) >= 2
    assert all(_arg(c, "--filter-pattern") == _pattern() and _arg(c, "--region") == "us-east-1" for c in tmf)
    checks = [(_arg(c, "--log-event-messages").split(T), want) for c, want in zip(tmf, expected)]
    prefix_ok = [f for f, _ in checks if len(f) >= 4 and f[1].count("-") == 4]
    assert len(prefix_ok) == len(checks)
    assert any(f[2] == "ERROR" and f[3].startswith("photos lambda error ") and w == "1" for f, w in checks)
    forged = [w for f, w in checks if f[2] == "ERROR" and f[3].startswith("verifyToken failed: ")
              and "photos lambda error" in f[3]]
    assert forged and set(forged) == {"0"}


def test_test_patterns_passes_when_every_answer_matches_the_anchor(tmp_path):
    p, calls = _run(tmp_path, "test-patterns")
    assert p.returncode == 0, p.stdout
    reads = [c for c in calls if c[:2] != ["logs", "test-metric-filter"]]
    assert [c[:2] for c in reads] == [["lambda", "get-function-configuration"]]


def test_test_patterns_prints_the_live_log_format_OPS_LOGINJECTGUARD_001(tmp_path):
    p, calls = _run(tmp_path, "test-patterns")
    assert "  ok    log format garden-photos: Text" in p.stdout.splitlines()
    read = [c for c in calls if c[:2] == ["lambda", "get-function-configuration"]]
    assert len(read) == 1
    assert _arg(read[0], "--function-name") == "garden-photos" and _arg(read[0], "--region") == "us-east-1"
    assert _arg(read[0], "--query") == "LoggingConfig.LogFormat"


@pytest.mark.parametrize("fmt, shown", [("JSON", "JSON"), ("refused", "unreadable")])
def test_provision_refuses_unless_garden_photos_logs_in_text_OPS_LOGINJECTGUARD_001(tmp_path, fmt, shown):
    """The anchored pattern cannot read a JSON-format line, so the alarm would sit OK through real errors."""
    p, calls = _run(tmp_path, "test-patterns", fmt=fmt)
    assert p.returncode == 1 and f"  FAIL  log format garden-photos: {shown} (want Text)" in p.stdout.splitlines()
    p, calls = _run(tmp_path, "provision", fmt=fmt)
    assert p.returncode == 1 and "does not log in Text" in p.stderr
    assert not [c for c in calls if c[1] == "put-metric-filter"]


def test_provision_refuses_before_any_write_when_test_patterns_fails(tmp_path):
    p, calls = _run(tmp_path, "provision", answer="x")
    assert p.returncode == 1 and "refusing to write the filter" in p.stderr
    assert not [c for c in calls if c[1] == "put-metric-filter"]


# PIN: the live filter's name and metric (describe-metric-filters); re-prove a pattern change with test-patterns.
def test_provision_writes_the_live_filter_name_and_metric_with_the_proven_pattern(tmp_path):
    p, calls = _run(tmp_path, "provision")
    assert p.returncode == 0, p.stdout + p.stderr
    puts = [c for c in calls if c[1] == "put-metric-filter"]
    assert len(puts) == 1 and calls.index(puts[0]) == len(calls) - 1
    put = puts[0]
    assert _arg(put, "--log-group-name") == "/aws/lambda/garden-photos"
    assert _arg(put, "--filter-name") == "photos-lambda-error"
    assert _arg(put, "--filter-pattern") == _pattern()
    assert _arg(put, "--metric-transformations") == \
        "metricName=PhotosHandlerErrors,metricNamespace=Garden/Photos,metricValue=1,defaultValue=0"
    assert _arg(put, "--region") == "us-east-1"
