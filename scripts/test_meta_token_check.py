"""scripts/meta-token-check.sh `check`, run whole against stand-ins for aws and curl.

Run: python3 -m pytest -q scripts/test_meta_token_check.py

BUG-METAWATCHUNVERIFIEDSILENT-001: a debug_token reply with no `data` (a Graph error body, or not JSON) used to
exit 0 with no email and no metric, so the daily job read green while it verified nothing. These hold the fix:
two replies with no data -> SNS publish, exit non-zero, no CloudWatch datapoint (MetaTokenValid feeds the
staleness alarm); one bad reply then a good one -> a normal run. The stand-ins record every call; curl answers
from numbered files in order.
"""
import json
import os
import subprocess
import time

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "meta-token-check.sh")

AWS = """#!/bin/sh
echo "aws $*" >> "${STUB}/calls.log"
case "$*" in
  *secretsmanager*) echo '{"app_id":"1","app_secret":"s","page_token":"t"}' ;;
  *"sns publish"*) [ -f "${STUB}/sns.fail" ] && exit 1 ;;
esac
exit 0
"""
CURL = """#!/bin/sh
n=$(grep -c '^curl' "${STUB}/calls.log" 2>/dev/null || true)
echo "curl $*" >> "${STUB}/calls.log"
cat "${STUB}/reply.$((n + 1))"
"""

ERROR = json.dumps({"error": {"message": "Invalid OAuth access token.", "type": "OAuthException", "code": 190}})
SCOPES = ["pages_show_list", "pages_read_engagement", "pages_manage_posts",
          "instagram_basic", "instagram_content_publish"]


def good():
    return json.dumps({"data": {"is_valid": True, "expires_at": 0, "issued_at": int(time.time()),
                                "data_access_expires_at": int(time.time()) + 80 * 86400, "scopes": SCOPES}})


def run(tmp_path, *replies, sns_fails=False):
    stub = tmp_path / "stub"
    stub.mkdir()
    for name, text in (("aws", AWS), ("curl", CURL)):
        (stub / name).write_text(text)
        (stub / name).chmod(0o755)
    for i, reply in enumerate(replies, 1):
        (stub / f"reply.{i}").write_text(reply)
    if sns_fails:
        (stub / "sns.fail").write_text("")
    out = tmp_path / "report.json"
    env = dict(os.environ, STUB=str(stub), PATH=f"{stub}:{os.environ['PATH']}", OUT=str(out), RETRY_SECS="0")
    p = subprocess.run(["bash", SCRIPT, "check"], env=env, capture_output=True, text=True, timeout=60)
    calls = (stub / "calls.log").read_text().splitlines()
    return p, calls, json.loads(out.read_text())


def kinds(calls):
    return [c for c in calls if c.startswith(("aws cloudwatch", "aws sns", "curl"))]


@pytest.mark.parametrize("bad", [ERROR, "<html>502 Bad Gateway</html>", json.dumps({"data": None}), "[]"],
                         ids=["graph-error", "not-json", "null-data", "list"])
def test_no_data_twice_is_loud(tmp_path, bad):
    p, calls, report = run(tmp_path, bad, bad)
    assert p.returncode != 0, p.stderr
    assert report["status"] == "UNVERIFIED"
    assert sum(c.startswith("curl") for c in calls) == 2, "one retry before alerting"
    sns = [c for c in calls if c.startswith("aws sns publish")]
    assert len(sns) == 1 and "UNVERIFIED" in sns[0], calls
    assert not any(c.startswith("aws cloudwatch") for c in calls), "a datapoint would quiet the staleness alarm"


def test_graph_error_object_reaches_the_report(tmp_path):
    _, _, report = run(tmp_path, ERROR, ERROR)
    assert report["graph_error"]["code"] == 190


def test_non_json_body_is_not_echoed(tmp_path):
    p, calls, report = run(tmp_path, "<html>secret-ish</html>", "<html>secret-ish</html>")
    assert report["graph_error"] == "reply is not JSON"
    assert "secret-ish" not in p.stdout + p.stderr + "".join(calls)


def test_sns_failure_still_exits_non_zero(tmp_path):
    p, _, report = run(tmp_path, ERROR, ERROR, sns_fails=True)
    assert p.returncode != 0
    assert report["status"] == "UNVERIFIED"


def test_one_bad_reply_then_good_is_a_normal_run(tmp_path):
    p, calls, report = run(tmp_path, ERROR, good())
    assert p.returncode == 0, p.stderr
    assert report["status"] == "OK"
    assert [c.split()[1] for c in kinds(calls)] == ["-sS", "-sS", "cloudwatch"], calls


def test_good_reply_emits_metrics_and_no_alert(tmp_path):
    p, calls, report = run(tmp_path, good())
    assert p.returncode == 0, p.stderr
    assert report["status"] == "OK"
    assert sum(c.startswith("curl") for c in calls) == 1
    assert any(c.startswith("aws cloudwatch put-metric-data") for c in calls)
    assert not any(c.startswith("aws sns") for c in calls)
