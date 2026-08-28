"""Tests for scripts/secret_key_merge.py — the decision layer of secret-key-set.sh.

The failure this guards is not subtle-but-rare, it is catastrophic-and-easy: a merge that drops
CLERK_SECRET_KEY or NEON_DATABASE_URL from garden-app/secrets takes the entire Lambda fleet down
(401 on every authenticated request, 500 on the rest), and `put-secret-value` reports success
either way. So the cases below are mostly about what the helper REFUSES to do.
"""
import json
import subprocess
import sys
from pathlib import Path

import pytest

HELPER = str(Path(__file__).resolve().parent / "secret_key_merge.py")
REQUIRED = ["CLERK_SECRET_KEY", "NEON_DATABASE_URL"]
BUNDLE = {"CLERK_SECRET_KEY": "sk_test_clerk", "NEON_DATABASE_URL": "postgres://x"}


def run(args, stdin_bytes):
    return subprocess.run([sys.executable, HELPER, *args], input=stdin_bytes,
                          capture_output=True)


def merge(bundle, key, mode, newval=""):
    payload = json.dumps(bundle).encode() + b"\0" + newval.encode()
    return run(["merge", key, mode], payload)


class TestCheck:
    def test_accepts_a_complete_bundle(self):
        r = run(["check", *REQUIRED], json.dumps(BUNDLE).encode())
        assert r.returncode == 0

    @pytest.mark.parametrize("bundle", [
        {"CLERK_SECRET_KEY": "a"},                       # one required key missing
        {},                                              # empty read
        {"ANTHROPIC_API_KEY": "sk-ant-x"},               # unrelated key only
    ])
    def test_refuses_an_incomplete_bundle(self, bundle):
        r = run(["check", *REQUIRED], json.dumps(bundle).encode())
        assert r.returncode != 0
        assert b"REFUSING" in r.stderr

    @pytest.mark.parametrize("raw", [b"", b"not json", b'"a string"', b"[1,2]", b"null"])
    def test_refuses_non_object_input(self, raw):
        # A throttled read returning an empty body must not be treated as an empty bundle.
        r = run(["check", *REQUIRED], raw)
        assert r.returncode != 0
        assert b"REFUSING" in r.stderr


class TestMerge:
    def test_adds_a_key_and_preserves_the_others(self):
        r = merge(BUNDLE, "ANTHROPIC_API_KEY", "set", "sk-ant-secret")
        assert r.returncode == 0
        out = json.loads(r.stdout)
        assert out["ANTHROPIC_API_KEY"] == "sk-ant-secret"
        # The whole point of the script.
        for k in REQUIRED:
            assert out[k] == BUNDLE[k]

    def test_the_secret_value_never_reaches_stderr(self):
        r = merge(BUNDLE, "ANTHROPIC_API_KEY", "set", "sk-ant-supersecret")
        assert b"sk-ant-supersecret" not in r.stderr

    def test_removing_a_key_keeps_the_required_ones(self):
        full = {**BUNDLE, "ANTHROPIC_API_KEY": "sk-ant-x"}
        r = merge(full, "ANTHROPIC_API_KEY", "remove")
        assert r.returncode == 0
        out = json.loads(r.stdout)
        assert "ANTHROPIC_API_KEY" not in out
        assert sorted(out) == sorted(REQUIRED)

    def test_noop_exits_3_and_writes_nothing(self):
        full = {**BUNDLE, "ANTHROPIC_API_KEY": "same"}
        r = merge(full, "ANTHROPIC_API_KEY", "set", "same")
        assert r.returncode == 3
        assert r.stdout == b""

    def test_removing_an_absent_key_is_a_noop(self):
        r = merge(BUNDLE, "NOT_THERE", "remove")
        assert r.returncode == 3

    def test_a_value_containing_nul_delimiter_edge(self):
        # partition() splits on the FIRST NUL, so a value may itself contain anything else,
        # including JSON braces and newlines, without corrupting the bundle.
        weird = '{"looks":"like json"}\nsecond line'
        r = merge(BUNDLE, "ANTHROPIC_API_KEY", "set", weird)
        assert r.returncode == 0
        assert json.loads(r.stdout)["ANTHROPIC_API_KEY"] == weird

    def test_refuses_to_merge_into_a_non_object(self):
        r = run(["merge", "K", "set"], b'["a"]\x00v')
        assert r.returncode != 0


class TestVerify:
    def test_passes_when_the_key_landed_and_required_survived(self):
        full = {**BUNDLE, "ANTHROPIC_API_KEY": "sk-ant-x"}
        r = run(["verify", "ANTHROPIC_API_KEY", "set", *REQUIRED], json.dumps(full).encode())
        assert r.returncode == 0

    def test_fails_loudly_when_a_required_key_was_destroyed(self):
        # The outage case. This assertion is the reason the file exists.
        r = run(["verify", "ANTHROPIC_API_KEY", "set", *REQUIRED],
                json.dumps({"ANTHROPIC_API_KEY": "sk-ant-x"}).encode())
        assert r.returncode != 0
        assert b"AWSPREVIOUS" in r.stderr

    def test_fails_when_the_key_was_not_stored(self):
        r = run(["verify", "ANTHROPIC_API_KEY", "set", *REQUIRED], json.dumps(BUNDLE).encode())
        assert r.returncode != 0

    def test_fails_when_a_removal_did_not_remove(self):
        full = {**BUNDLE, "ANTHROPIC_API_KEY": "sk-ant-x"}
        r = run(["verify", "ANTHROPIC_API_KEY", "remove", *REQUIRED], json.dumps(full).encode())
        assert r.returncode != 0
