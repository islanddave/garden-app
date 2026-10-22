"""tests/smoke/run-smoke.sh Phase 1 `spa:build-sha`: staging must serve the SPA build the smoke was dispatched for.

Run: python3 -m pytest -q scripts/test_smoke_spa_build_sha.py

deploy-staging's Build step stamps public/sw.js with CACHE_VERSION = 'vstg-<short sha>' and hands that exact short
SHA to the smoke as STAGING_BUILD_SHORT_SHA (OPS-STAGINGSURFACEGAP-001). The block re-reads
$STAGING_CF_ORIGIN/sw.js up to six times, 10 s apart, and counts one FAIL unless the stamp is there. It runs in
every promote's staging gate, so it can red a promote by itself; this file holds it to failing only when it should.

- the block is cut out of the shell file and run under bash with `set -euo pipefail`, as the script sets it,
  against an in-process stand-in for the CloudFront origin; curl is the real curl;
- `sleep` is a stub on PATH that records its argument, so the 10 s waits cost nothing and are counted;
- the wiring that feeds the block (Build step -> job output -> smoke env) is read from deploy-staging.yml.
"""
import os
import re
import shutil
import socket
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parent.parent
SMOKE = ROOT / "tests" / "smoke" / "run-smoke.sh"
DEPLOY_STAGING = ROOT / ".github" / "workflows" / "deploy-staging.yml"
BASH = shutil.which("bash")
SHA = "abc1234"
TRIES, PAUSE = 6, "10"


def stamped(short_sha):
    """sw.js as the Build step leaves it: the sed replaces only the quoted value, the trailing comment stays."""
    return ("const CACHE_VERSION = 'vstg-%s' // base default — deploy workflows rewrite this\n"
            "const STATIC_CACHE  = `static-${CACHE_VERSION}`\n" % short_sha)


def block():
    text = SMOKE.read_text(encoding="utf-8")
    found = re.findall(r"^# SPA build identity .*?^fi\n", text, re.M | re.S)
    assert len(found) == 1, "expected exactly one `# SPA build identity` block in run-smoke.sh"
    assert 'if [[ -n "${STAGING_BUILD_SHORT_SHA:-}" && -n "${STAGING_CF_ORIGIN:-}" ]]; then' in found[0]
    return found[0]


class Origin:
    """The CloudFront origin for one test: replies served in order (the last repeats), every request recorded."""

    def __init__(self, replies):
        self.requests = []
        origin = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_args):
                pass

            def do_GET(self):
                n = len(origin.requests)
                origin.requests.append({"path": self.path, "cache_control": self.headers.get("Cache-Control")})
                status, body = replies[min(n, len(replies) - 1)]
                payload = body.encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/javascript")
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(payload)
                self.close_connection = True

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = "http://127.0.0.1:%d/" % self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def origin():
    servers = []

    def serve(*replies):
        servers.append(Origin(list(replies)))
        return servers[-1]

    yield serve
    for server in servers:
        server.close()


def refused_origin():
    """An origin nothing listens on: the port is bound once to reserve the number, then closed."""
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return "http://127.0.0.1:%d" % sock.getsockname()[1]


def run(tmp_path, short_sha, cf_origin):
    """The block under `set -euo pipefail` with PASS/FAIL/TEST_RUN_ID as the script has them by Phase 1.
    Returns (CompletedProcess, the arguments `sleep` was called with)."""
    assert BASH and shutil.which("curl"), "bash and curl must be on PATH: the block needs both"
    bindir = tmp_path / "bin"
    bindir.mkdir()
    sleeps = tmp_path / "sleeps"
    (bindir / "sleep").write_text('#!/bin/bash\nprintf "%%s\\n" "$*" >> %s\n' % sleeps)
    (bindir / "sleep").chmod(0o755)
    driver = tmp_path / "driver.sh"
    driver.write_text('set -euo pipefail\nPASS=0\nFAIL=0\nTEST_RUN_ID=run-1\n' + block()
                      + 'printf "PASS=%s FAIL=%s\\n" "$PASS" "$FAIL"\n')
    env = {k: v for k, v in os.environ.items()
           if not k.lower().endswith("_proxy") and k not in ("STAGING_BUILD_SHORT_SHA", "STAGING_CF_ORIGIN")}
    env.update(PATH=f"{bindir}{os.pathsep}{os.environ['PATH']}", NO_PROXY="*")
    if short_sha is not None:
        env["STAGING_BUILD_SHORT_SHA"] = short_sha
    if cf_origin is not None:
        env["STAGING_CF_ORIGIN"] = cf_origin
    proc = subprocess.run([BASH, str(driver)], cwd=tmp_path, env=env, capture_output=True, text=True, timeout=300)
    return proc, (sleeps.read_text().splitlines() if sleeps.exists() else [])


def counts(proc):
    assert proc.returncode == 0, proc.stdout + proc.stderr     # the block counts a FAIL; it never ends the script
    return proc.stdout.splitlines()[-1]


def test_the_stamp_on_the_first_read_is_one_pass_and_no_wait(tmp_path, origin):
    cf = origin((200, stamped(SHA)))
    proc, sleeps = run(tmp_path, SHA, cf.url)
    assert counts(proc) == "PASS=1 FAIL=0" and sleeps == []
    assert "✅ PASS [spa:build-sha]" in proc.stdout and "proves the SPA build only" in proc.stdout
    assert "Lambda code identity on staging is not asserted" in proc.stdout
    assert len(cf.requests) == 1
    assert cf.requests[0]["path"] == "/sw.js?smoke=run-1-1" and cf.requests[0]["cache_control"] == "no-cache"


@pytest.mark.parametrize("stale", [1, 2], ids=["new-on-try-2", "new-on-try-3"])
def test_an_old_stamp_that_turns_over_inside_the_window_passes(tmp_path, origin, stale):
    cf = origin(*[(200, stamped("0ld0000"))] * stale + [(200, stamped(SHA))])
    proc, sleeps = run(tmp_path, SHA, cf.url)
    assert counts(proc) == "PASS=1 FAIL=0", proc.stdout
    assert len(cf.requests) == stale + 1 and sleeps == [PAUSE] * stale
    assert "try 1/6: sw.js has CACHE_VERSION = 'vstg-0ld0000', want 'vstg-abc1234'" in proc.stdout


@pytest.mark.parametrize("served,wanted", [
    (stamped("abc1234"), "abc123"),                # a shorter SHA that is a prefix of the stamp is not the stamp
    (stamped("abc1234"), "abc12345"),              # nor is a longer one the stamp is a prefix of
    (stamped("fedcba9"), "abc1234"),               # another build
    ("self.addEventListener('install', () => {})\n", "abc1234"),   # an sw.js with no CACHE_VERSION at all
], ids=["shorter-prefix", "longer", "other-build", "no-stamp"])
def test_a_stamp_that_never_matches_is_one_fail_after_six_reads(tmp_path, origin, served, wanted):
    cf = origin((200, served))
    proc, sleeps = run(tmp_path, wanted, cf.url)
    assert counts(proc) == "PASS=0 FAIL=1", proc.stdout
    assert len(cf.requests) == TRIES and sleeps == [PAUSE] * (TRIES - 1)
    assert [r["path"] for r in cf.requests] == ["/sw.js?smoke=run-1-%d" % i for i in range(1, TRIES + 1)]
    fail = [ln for ln in proc.stdout.splitlines() if "FAIL [spa:build-sha]" in ln]
    assert len(fail) == 1 and f"never carried 'vstg-{wanted}' in {TRIES} tries" in fail[0]
    assert "SPA only; Lambda identity is not asserted" in fail[0]


@pytest.mark.parametrize("reply", [(404, "<html>NoSuchKey</html>"), (503, stamped(SHA))], ids=["404", "503"])
def test_an_error_reply_is_a_failed_read_even_with_the_stamp_in_its_body(tmp_path, origin, reply):
    cf = origin(reply)
    proc, sleeps = run(tmp_path, SHA, cf.url)
    assert counts(proc) == "PASS=0 FAIL=1" and len(cf.requests) == TRIES and sleeps == [PAUSE] * (TRIES - 1)
    assert "(last: no readable CACHE_VERSION)" in proc.stdout


def test_an_origin_that_does_not_answer_is_one_fail_after_six_tries(tmp_path):
    proc, sleeps = run(tmp_path, SHA, refused_origin())
    assert counts(proc) == "PASS=0 FAIL=1" and sleeps == [PAUSE] * (TRIES - 1)
    assert "❌ FAIL [spa:build-sha]" in proc.stdout


@pytest.mark.parametrize("short_sha,cf_origin", [(None, "ORIGIN"), ("", "ORIGIN"), (SHA, None), (SHA, ""), (None, None)],
                         ids=["sha-unset", "sha-empty", "origin-unset", "origin-empty", "both-unset"])
def test_either_value_unset_is_a_skip_that_sends_nothing(tmp_path, origin, short_sha, cf_origin):
    cf = origin((200, stamped("fedcba9")))               # a mismatch, were it read
    proc, sleeps = run(tmp_path, short_sha, cf.url if cf_origin == "ORIGIN" else cf_origin)
    assert counts(proc) == "PASS=0 FAIL=0" and sleeps == [] and cf.requests == []
    assert "(spa:build-sha skipped — STAGING_BUILD_SHORT_SHA or STAGING_CF_ORIGIN unset" in proc.stdout


def test_deploy_staging_feeds_the_block_the_short_sha_it_stamped():
    wf = yaml.safe_load(DEPLOY_STAGING.read_text(encoding="utf-8"))
    frontend, smoke = wf["jobs"]["deploy-frontend"], wf["jobs"]["smoke-tests"]
    build = next(s for s in frontend["steps"] if s.get("id") == "build")
    lines = [ln.strip() for ln in build["run"].splitlines()]
    assert "SW_SHORT_SHA=$(git rev-parse --short HEAD)" in lines
    stamp = [ln for ln in lines if ln.startswith("sed ") and "public/sw.js" in ln]
    assert stamp == ["""sed -i -E "s/const CACHE_VERSION = '[^']*'/const CACHE_VERSION = 'vstg-${SW_SHORT_SHA}'/" public/sw.js"""]
    assert 'echo "sw-short-sha=$SW_SHORT_SHA"    >> "$GITHUB_OUTPUT"' in lines
    assert frontend["outputs"]["sw-short-sha"] == "${{ steps.build.outputs.sw-short-sha }}"
    assert "deploy-frontend" in smoke["needs"]
    env = next(s for s in smoke["steps"] if s.get("run") == "bash tests/smoke/run-smoke.sh")["env"]
    assert env["STAGING_BUILD_SHORT_SHA"] == "${{ needs.deploy-frontend.outputs.sw-short-sha }}"
    assert env["STAGING_CF_ORIGIN"] == "${{ env.STAGING_CF_ORIGIN }}" and wf["env"]["STAGING_CF_ORIGIN"].startswith("https://")
