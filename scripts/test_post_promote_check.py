# new-file: tests the new read-only post-promote check tool, plan V003 §9.6
"""scripts/post-promote-check.py with a stubbed `aws` and urllib: exact 401 on every URL function, zero
log counts, exit 0/1/2. Trap: it must never print a URL, token, id or log body, and no workflow may call it."""
import argparse
import datetime
import importlib.util
import io
import json
import os
import re
import socket
import subprocess
import urllib.error

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
_spec = importlib.util.spec_from_file_location("post_promote_check", os.path.join(HERE, "post-promote-check.py"))
ppc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ppc)

FNS = ppc.url_functions()
HOUSEHOLD = "user_2abcDEFghiJKLmnoPQRstu,user_3zyxWVUtsrQPOnmlKJIhgf"
UUID = "0f0f0f0f-1111-2222-3333-444444444444"


def url_of(fn):
    return f"https://{fn}-x7q2abcdefgh3ijklmn.lambda-url.us-east-1.on.aws/"


class FakeAws:
    """subprocess.run for `aws`: URL lookups and filter-log-events, overridable per function."""

    def __init__(self, counts=None, fail=None, stdout=None):
        self.counts = counts or {}      # (fn, pattern key) -> n
        self.fail = fail or {}          # (fn, aws op) -> returncode or exception
        self.stdout = stdout or {}      # (fn, aws op) -> raw stdout
        self.calls = []

    def __call__(self, cmd, **kw):
        self.calls.append(cmd)
        op = cmd[2]
        fn = cmd[cmd.index("--function-name" if op == "get-function-url-config" else "--log-group-name") + 1]
        fn = fn.rsplit("/", 1)[-1]
        f = self.fail.get((fn, op))
        if isinstance(f, BaseException):
            raise f
        # stderr quotes ids and the account, as real AWS errors do; the tool must drop it.
        err = f"An error occurred: arn:aws:lambda:us-east-1:769788341849:function:{fn} {HOUSEHOLD}"
        if f:
            return subprocess.CompletedProcess(cmd, f, "", err)
        if (fn, op) in self.stdout:
            return subprocess.CompletedProcess(cmd, 0, self.stdout[(fn, op)], err)
        if op == "get-function-url-config":
            return subprocess.CompletedProcess(cmd, 0, url_of(fn) + "\n", "")
        key = next(k for k, p in ppc.PATTERNS.items() if p == cmd[cmd.index("--filter-pattern") + 1])
        n = self.counts.get((fn, key), 0)
        return subprocess.CompletedProcess(cmd, 0, json.dumps([f"{UUID}-{i}" for i in range(n)]), "")


def fake_urlopen(statuses):
    """urlopen answering 401 by default; statuses maps a function to a status or an exception."""
    def urlopen(req, timeout):
        assert timeout == ppc.HTTP_TIMEOUT and req.get_method() == "GET"
        assert not req.has_header("Authorization")
        fn = next(f for f in FNS if req.full_url == url_of(f))
        s = statuses.get(fn, 401)
        if isinstance(s, BaseException):
            raise s
        if s >= 400:
            body = io.BytesIO(json.dumps({"error": "x", "userId": HOUSEHOLD}).encode())
            raise urllib.error.HTTPError(req.full_url, s, "status", {}, body)

        class Resp:
            status = s

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False
        return Resp()
    return urlopen


def run(monkeypatch, capsys, aws=None, statuses=None, argv=()):
    aws = aws or FakeAws()
    monkeypatch.setattr(ppc.subprocess, "run", aws)
    monkeypatch.setattr(ppc.urllib.request, "urlopen", fake_urlopen(statuses or {}))
    code = ppc.main(list(argv))
    return code, capsys.readouterr().out, aws


def line_for(out, fn):
    return next(ln for ln in out.splitlines() if re.search(rf"\s{re.escape(fn)}\s", ln))


def test_the_real_manifest_declares_exactly_the_expected_url_functions():
    assert len(FNS) == ppc.EXPECTED_URL_FUNCTIONS == 23
    assert "garden-plants" in FNS and "garden-critter" in FNS and "garden-daily-plan" not in FNS


def test_all_401_and_zero_counts_is_pass(monkeypatch, capsys):
    code, out, aws = run(monkeypatch, capsys)
    assert code == 0 and out.splitlines()[-1] == "PASS"
    assert sum(1 for ln in out.splitlines() if ln.strip().startswith("PASS ")) == 23
    assert "GET 401 denied=0 errors=0 runtime=0" in line_for(out, "garden-critter")
    assert len(aws.calls) == 23 * 4
    assert all(c[0] == "aws" and c[-2:] == ["--region", "us-east-1"] for c in aws.calls)


def test_each_function_reads_its_own_log_group_since_the_start(monkeypatch, capsys):
    _, _, aws = run(monkeypatch, capsys, argv=["--since", "2026-10-30T12:00:00Z"])
    logs = [c for c in aws.calls if c[2] == "filter-log-events"]
    assert {c[c.index("--log-group-name") + 1] for c in logs} == {f"/aws/lambda/{fn}" for fn in FNS}
    assert {c[c.index("--start-time") + 1] for c in logs} == {"1793361600000"}
    assert all(c[c.index("--query") + 1] == "events[].eventId" for c in logs)


@pytest.mark.parametrize("status", [403, 500, 502, 404, 200])
def test_anything_but_401_is_fail(monkeypatch, capsys, status):
    code, out, _ = run(monkeypatch, capsys, statuses={"garden-favorites": status})
    assert code == 1 and out.splitlines()[-1].startswith("FAIL (1 failed")
    assert line_for(out, "garden-favorites").strip().startswith(f"FAIL") and f"GET {status} " in out
    assert line_for(out, "garden-plants").strip().startswith("PASS")


@pytest.mark.parametrize("exc", [urllib.error.URLError(socket.timeout("timed out")), socket.timeout("timed out"),
                                 urllib.error.URLError(ConnectionRefusedError())])
def test_a_timeout_or_no_answer_is_fail(monkeypatch, capsys, exc):
    code, out, _ = run(monkeypatch, capsys, statuses={"garden-tags": exc})
    assert code == 1 and "GET no answer" in line_for(out, "garden-tags")


@pytest.mark.parametrize("key", ["denied", "errors", "runtime"])
def test_any_nonzero_log_count_is_fail(monkeypatch, capsys, key):
    code, out, _ = run(monkeypatch, capsys, aws=FakeAws(counts={("garden-shared-state", key): 3}))
    assert code == 1 and f"{key}=3" in line_for(out, "garden-shared-state")


@pytest.mark.parametrize("fail", [
    {("garden-events", "filter-log-events"): 254},
    {("garden-events", "get-function-url-config"): 253},
    {("garden-events", "filter-log-events"): subprocess.TimeoutExpired("aws", 120)},
    {("garden-events", "get-function-url-config"): FileNotFoundError("aws")},
])
def test_a_read_failure_is_exit_2(monkeypatch, capsys, fail):
    code, out, _ = run(monkeypatch, capsys, aws=FakeAws(fail=fail))
    assert code == 2 and out.splitlines()[-1] == "COULD NOT VERIFY (1 could not be read)"
    assert line_for(out, "garden-events").strip().startswith("UNREAD")


@pytest.mark.parametrize("op, raw", [("filter-log-events", "not json"), ("filter-log-events", '{"events": 1}'),
                                     ("get-function-url-config", "None\n")])
def test_unusable_aws_output_is_exit_2(monkeypatch, capsys, op, raw):
    code, _, _ = run(monkeypatch, capsys, aws=FakeAws(stdout={("garden-photos", op): raw}))
    assert code == 2


def test_a_null_event_list_counts_zero(monkeypatch, capsys):
    code, _, _ = run(monkeypatch, capsys, aws=FakeAws(stdout={("garden-photos", "filter-log-events"): "null"}))
    assert code == 0


def test_a_fail_outranks_an_unread_function(monkeypatch, capsys):
    aws = FakeAws(fail={("garden-events", "filter-log-events"): 254})
    code, out, _ = run(monkeypatch, capsys, aws=aws, statuses={"garden-tags": 403})
    assert code == 1 and out.splitlines()[-1] == "FAIL (1 failed, 1 could not be read)"


def _manifest(tmp_path, monkeypatch, mutate):
    with open(ppc.MANIFEST, encoding="utf-8") as fh:
        raw = json.load(fh)
    mutate(raw)
    p = tmp_path / "manifest.json"
    p.write_text(json.dumps(raw))
    monkeypatch.setattr(ppc, "MANIFEST", str(p))


@pytest.mark.parametrize("mutate, said", [
    (lambda m: m["garden-tags"].update(url=None), "manifest declares 22 URL functions, this check expects 23"),
    (lambda m: m.update({"garden-new": {"url": {}}}), "manifest declares 24 URL functions, this check expects 23"),
    (lambda m: m["garden-tags"].pop("url"), "manifest gives no url sentinel for garden-tags"),
])
def test_a_manifest_count_mismatch_is_exit_2_before_any_aws_call(monkeypatch, capsys, tmp_path, mutate, said):
    _manifest(tmp_path, monkeypatch, mutate)
    code, out, aws = run(monkeypatch, capsys)
    assert code == 2 and said in out and out.splitlines()[-1] == "COULD NOT VERIFY"
    assert aws.calls == []


def test_an_unreadable_manifest_is_exit_2(monkeypatch, capsys, tmp_path):
    monkeypatch.setattr(ppc, "MANIFEST", str(tmp_path / "absent.json"))
    code, out, aws = run(monkeypatch, capsys)
    assert code == 2 and "cannot read the manifest (FileNotFoundError)" in out and aws.calls == []


@pytest.mark.parametrize("scenario", ["pass", "fail", "unread"])
def test_no_id_url_or_body_is_ever_printed(monkeypatch, capsys, scenario):
    unread = {("garden-events", "filter-log-events"): 254}
    aws, statuses = {
        "pass": (FakeAws(), {}),
        "fail": (FakeAws(counts={("garden-critter", "denied"): 2}, fail=unread), {"garden-favorites": 403}),
        "unread": (FakeAws(fail=unread), {}),
    }[scenario]
    _, out, _ = run(monkeypatch, capsys, aws=aws, statuses=statuses)
    for leak in ("user_", "769788341849", "arn:", "https://", "lambda-url", "x7q2", "userId", "An error occurred"):
        assert leak not in out
    assert not re.search(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", out)


NOW = datetime.datetime(2026, 10, 30, 12, 0, tzinfo=datetime.timezone.utc)


@pytest.mark.parametrize("value, want", [
    ("30", NOW - datetime.timedelta(minutes=30)),
    ("2026-10-30T11:00:00Z", datetime.datetime(2026, 10, 30, 11, tzinfo=datetime.timezone.utc)),
    ("2026-10-30T11:00:00", datetime.datetime(2026, 10, 30, 11, tzinfo=datetime.timezone.utc)),
    ("2026-10-30T07:00:00-04:00", datetime.datetime(2026, 10, 30, 11, tzinfo=datetime.timezone.utc)),
])
def test_parse_since(value, want):
    assert ppc.parse_since(value, now=NOW) == int(want.timestamp() * 1000)


@pytest.mark.parametrize("value", ["0", "yesterday", "2026-10-30T13:00:00Z", "-5"])
def test_parse_since_refuses(value):
    with pytest.raises(argparse.ArgumentTypeError):
        ppc.parse_since(value, now=NOW)


def test_a_bad_since_exits_2_through_argparse(monkeypatch, capsys):
    with pytest.raises(SystemExit) as e:
        run(monkeypatch, capsys, argv=["--since", "soon"])
    assert e.value.code == 2


def test_the_patterns_name_the_lines_the_handlers_log():
    """The denied pattern is the alarm's, on the shared-state gate's msg; the errors pattern excludes the
    401 line, which every URL handler must log as exactly 'verifyToken failed' or each probe counts as an error."""
    with open(os.path.join(REPO, "scripts", "household-observability.sh"), encoding="utf-8") as fh:
        assert "pattern() { printf '{ $.msg = \"%s\" }' \"$1\"; }" in fh.read()
    assert ppc.PATTERNS["denied"] == '{ $.msg = "household-membership-denied" }'
    with open(os.path.join(REPO, "lambda", "shared-state", "index.js"), encoding="utf-8") as fh:
        assert "msg: 'household-membership-denied'" in fh.read()
    assert ppc.PATTERNS["errors"] == 'ERROR -"verifyToken failed"'
    for fn in FNS:
        with open(os.path.join(REPO, "lambda", fn.removeprefix("garden-"), "index.js"), encoding="utf-8") as fh:
            assert "console.error('verifyToken failed:'" in fh.read(), fn


def test_no_workflow_calls_the_check():
    wf_dir = os.path.join(REPO, ".github", "workflows")
    names = [n for n in os.listdir(wf_dir) if n.endswith((".yml", ".yaml"))]
    assert names
    for n in names:
        with open(os.path.join(wf_dir, n), encoding="utf-8") as fh:
            assert "post-promote-check" not in fh.read(), n
