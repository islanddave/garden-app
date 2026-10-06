"""tests/smoke/run-smoke.sh `mint_session_token`: the log line it gained, and proof that nothing else changed.

Run: python3 -m pytest -q scripts/test_smoke_mint_log.py

run-smoke.sh is the staging smoke gate every promote waits on, and mint_session_token is called from 65 places in
it (63 until block U gained its two for seed release 2a, 2026-10-06: one between U0 and U1, one before U7). The function now also writes `[mint] http=<code> shape=<ok|empty|malformed> caller=<function>:<line>` to
stderr (promote-path plan B6a). That is LOG-ONLY, and this file is what holds it to that:

- the function is cut out of the shell file and run under bash, with `set -euo pipefail` as the script sets it,
  against an in-process stand-in for api.clerk.com; `curl` is a shim on PATH that swaps the origin and execs the
  real curl, so -w, -s, the exit codes and the request on the wire are curl's own; jq is the real jq;
- the function AS IT WAS (ORIGINAL below, verbatim from before the change) runs against the same replies, and
  the two must agree on stdout byte for byte, on exit status, and on the request the server received;
- the server must have seen exactly one request per call.
"""
import os
import re
import shlex
import shutil
import socket
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
SMOKE = os.path.join(HERE, "..", "tests", "smoke", "run-smoke.sh")
REAL_CURL, REAL_JQ = shutil.which("curl"), shutil.which("jq")
SHELLS = sorted({p for p in (shutil.which("bash"), "/bin/bash", "/usr/bin/bash", "/opt/homebrew/bin/bash",
                             "/usr/local/bin/bash") if p and os.path.exists(p)}, key=os.path.realpath)
SHELLS = [p for i, p in enumerate(SHELLS) if os.path.realpath(p) not in {os.path.realpath(q) for q in SHELLS[:i]}]
EACH_SHELL = pytest.mark.parametrize("shell", SHELLS)
SECRET, SESSION = "sk_test_NEVER_IN_A_LOG_0123456789", "sess_2abcDEF"
JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEyMyJ9.c2lnbmF0dXJlLXdpdGgtZGFzaGVzXw"
DROP, CUT = None, "cut"  # no reply at all / the body arrives 10 bytes short of its Content-Length

# tests/smoke/run-smoke.sh:311-319 at origin/dev 1e24f61c, before B6a. The reference the new function must match.
ORIGINAL = r'''mint_session_token() {
  curl -s --max-time 30 --connect-timeout 10 \
    -X POST \
    -H "Authorization: Bearer $CLERK_SECRET_KEY_STAGING" \
    -H "Content-Type: application/json" \
    -d '{}' \
    "https://api.clerk.com/v1/sessions/${CLERK_SESSION_ID}/tokens" \
    | jq -r '.jwt // empty' 2>/dev/null || echo ""
}
'''


def current():
    """mint_session_token as tests/smoke/run-smoke.sh defines it now."""
    with open(SMOKE, encoding="utf-8") as fh:
        text = fh.read()
    found = re.findall(r"^mint_session_token\(\) \{\n.*?^\}\n", text, re.M | re.S)
    assert len(found) == 1, "expected exactly one top-level mint_session_token() in run-smoke.sh"
    return found[0]


class Clerk:
    """api.clerk.com for one test: every request is recorded, then answered with `reply`."""

    def __init__(self, reply):
        self.requests = []
        clerk = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_args):
                pass

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                clerk.requests.append({"method": self.command, "path": self.path, "body": body,
                                       "authorization": self.headers.get("Authorization"),
                                       "content_type": self.headers.get("Content-Type"),
                                       "headers": sorted(k.lower() for k in self.headers.keys())})
                self.close_connection = True
                if reply is DROP:
                    return
                payload = reply[1].encode()
                self.send_response(reply[0])
                self.send_header("Content-Length", str(len(payload) + (10 if reply[2:] == (CUT,) else 0)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(payload)

            do_GET = do_PUT = do_DELETE = do_POST

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def refused_port():
    """A port nothing listens on: bound once to reserve the number, then closed."""
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@pytest.fixture
def clerk():
    servers = []

    def serve(reply):
        servers.append(Clerk(reply))
        return servers[-1]

    yield serve
    for server in servers:
        server.close()


def run(tmp_path, shell, function, port, script="mint_session_token\n", name="run"):
    """`script` under `set -euo pipefail` with `function` defined, curl pointed at 127.0.0.1:`port`.
    Returns (CompletedProcess with bytes stdout/stderr, the argv the function gave curl)."""
    assert REAL_CURL and REAL_JQ, "curl and jq must be on PATH: run-smoke.sh needs both, and so does this test"
    work = tmp_path / name
    bindir = work / "bin"
    bindir.mkdir(parents=True)
    argv_log = work / "curl-argv"
    (bindir / "curl").write_text(
        "#!/bin/bash\n"
        f'printf "%s\\n" "$@" > {shlex.quote(str(argv_log))}\n'
        f'a=()\nfor x in "$@"; do a+=("${{x/https:\\/\\/api.clerk.com\\//http://127.0.0.1:{port}/}}"); done\n'
        f'exec {shlex.quote(REAL_CURL)} -q "${{a[@]}}"\n')
    (bindir / "curl").chmod(0o755)
    driver = work / "driver.sh"
    driver.write_text("set -euo pipefail\n" + function + script)
    env = {k: v for k, v in os.environ.items() if not k.lower().endswith("_proxy")}
    env.update(PATH=f"{bindir}{os.pathsep}{os.environ['PATH']}", NO_PROXY="*", CLERK_SECRET_KEY_STAGING=SECRET,
               CLERK_SESSION_ID=SESSION)
    proc = subprocess.run([shell, str(driver)], cwd=work, env=env, capture_output=True, timeout=120)
    return proc, (argv_log.read_text().splitlines() if argv_log.exists() else None)


def mint_lines(proc):
    return [ln for ln in proc.stderr.decode().splitlines() if ln.startswith("[mint] ")]


def both(tmp_path, shell, clerk, reply):
    """The same reply served to the old function and to the new one. Returns (old, new) as
    (proc, curl argv, requests the server saw)."""
    out = []
    for name, function in (("old", ORIGINAL), ("new", current())):
        if reply == "refused":
            proc, argv = run(tmp_path, shell, function, refused_port(), name=name)
            out.append((proc, argv, []))
        else:
            server = clerk(reply)
            proc, argv = run(tmp_path, shell, function, server.port, name=name)
            out.append((proc, argv, server.requests))
    return out


def test_bash_curl_and_jq_are_present():
    assert SHELLS and REAL_CURL and REAL_JQ


# ── the five cases the change is specified by ──────────────────────────────────────────────────────────────────

SPECIFIED = {
    "200 valid jwt": ((200, '{"object":"token","jwt":"%s"}' % JWT), JWT, "http=200 shape=ok"),
    "500": ((500, '{"errors":[{"code":"internal_clerk_error","message":"Oops"}]}'), "", "http=500 shape=empty"),
    "200 empty object": ((200, "{}"), "", "http=200 shape=empty"),
    "200 two-part string": ((200, '{"jwt":"only.two"}'), "only.two", "http=200 shape=malformed"),
    "connection refused": ("refused", "", "http=000 shape=empty"),
}


@EACH_SHELL
@pytest.mark.parametrize("reply,token,logged", list(SPECIFIED.values()), ids=list(SPECIFIED))
def test_a_caller_gets_what_it_got_before_and_stderr_gains_one_line(tmp_path, shell, clerk, reply, token, logged):
    """The call as all 65 call sites make it: X=$(mint_session_token)."""
    script = 'CLERK_JWT=$(mint_session_token)\nprintf "rc=%s token=[%s]\\n" "$?" "$CLERK_JWT"\n'
    if reply == "refused":
        proc, _ = run(tmp_path, shell, current(), refused_port(), script)
        requests = []
    else:
        server = clerk(reply)
        proc, _ = run(tmp_path, shell, current(), server.port, script)
        requests = server.requests
        assert len(requests) == 1                                   # exactly one HTTP request per call
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.decode() == "rc=0 token=[%s]\n" % token      # the token, or the empty string, as before
    lines = mint_lines(proc)
    assert len(lines) == 1 and lines[0].startswith("[mint] %s caller=" % logged), proc.stderr
    assert proc.stderr.decode() == lines[0] + "\n"                  # and nothing else on stderr


@EACH_SHELL
def test_the_log_line_names_the_calling_function_and_line(tmp_path, shell, clerk):
    server = clerk((200, '{"jwt":"%s"}' % JWT))
    script = ("cleanup() {\n  local t\n  t=$(mint_session_token)\n  echo \"cleanup=$t\"\n}\n"
              "CLERK_JWT=$(mint_session_token)\necho \"main=$CLERK_JWT\"\ncleanup\n")
    function = current()
    proc, _ = run(tmp_path, shell, function, server.port, script)
    first = 1 + function.count("\n")                                # the driver is `set` + the function + script
    assert proc.returncode == 0 and proc.stdout.decode() == "main=%s\ncleanup=%s\n" % (JWT, JWT)
    assert mint_lines(proc) == ["[mint] http=200 shape=ok caller=main:%d" % (first + 6),
                                "[mint] http=200 shape=ok caller=cleanup:%d" % (first + 3)]
    assert len(server.requests) == 2


# ── old and new, side by side ──────────────────────────────────────────────────────────────────────────────────

REPLIES = {
    "200 valid jwt": ((200, '{"object":"token","jwt":"%s"}' % JWT), "200", "ok"),
    "200 pretty-printed": ((200, '{\n  "jwt": "%s"\n}\n' % JWT), "200", "ok"),
    "200 empty object": ((200, "{}"), "200", "empty"),
    "200 jwt null": ((200, '{"jwt":null}'), "200", "empty"),
    "200 jwt empty string": ((200, '{"jwt":""}'), "200", "empty"),
    "200 two-part string": ((200, '{"jwt":"only.two"}'), "200", "malformed"),
    "200 one-part client token": ((200, '{"jwt":"dvb_2abc"}'), "200", "malformed"),
    "200 four parts": ((200, '{"jwt":"a.b.c.d"}'), "200", "malformed"),
    "200 empty middle part": ((200, '{"jwt":"a..c"}'), "200", "malformed"),
    "200 jwt is a number": ((200, '{"jwt":12345}'), "200", "malformed"),
    "200 jwt with a space": ((200, '{"jwt":"a.b c.d"}'), "200", "malformed"),
    "200 jwt ends in the sentinel letter": ((200, '{"jwt":"x.y.x"}'), "200", "ok"),
    "200 jwt of printf directives": ((200, r'{"jwt":"%s%n.%d.\\n\\c"}'), "200", "ok"),
    "200 jwt of echo options": ((200, '{"jwt":"-n.-e.-E"}'), "200", "ok"),
    "200 jwt holding the unit separator": ((200, r'{"jwt":"a\u001fb.c.d"}'), "200", "ok"),
    "200 jwt of non-ascii": ((200, '{"jwt":"h\u00e9.\u2713.z"}'), "200", "ok"),
    "200 html": ((200, "<html><body>maintenance</body></html>"), "200", "empty"),
    "200 json string": ((200, '"nope"'), "200", "empty"),
    "200 json array": ((200, "[1,2]"), "200", "empty"),
    "200 two documents": ((200, '{"jwt":"a.b.c"}{"jwt":"d.e.f"}'), "200", "malformed"),
    "200 jwt then garbage": ((200, '{"jwt":"%s"} <oops' % JWT), "200", "ok"),
    "200 body is a bare status-like number": ((200, "200"), "200", "empty"),
    "200 cut short": ((200, '{"jwt":"%s"}' % JWT, CUT), "200", "ok"),
    "204 no body": ((204, ""), "204", "empty"),
    "401": ((401, '{"errors":[{"code":"authentication_invalid"}]}'), "401", "empty"),
    "404 session gone": ((404, '{"errors":[{"code":"resource_not_found"}]}'), "404", "empty"),
    "429": ((429, '{"errors":[{"code":"too_many_requests"}]}'), "429", "empty"),
    "500 json": ((500, '{"errors":[{"code":"internal_clerk_error"}]}'), "500", "empty"),
    "502 html": ((502, "<html><h1>502 Bad Gateway</h1></html>"), "502", "empty"),
    "500 body that looks like a token": ((500, '{"jwt":"%s"}' % JWT), "500", "ok"),
    "no reply": (DROP, "000", "empty"),
    "connection refused": ("refused", "000", "empty"),
}


@EACH_SHELL
@pytest.mark.parametrize("reply,code,shape", list(REPLIES.values()), ids=list(REPLIES))
def test_old_and_new_agree_on_stdout_exit_status_and_the_request(tmp_path, shell, clerk, reply, code, shape):
    (old, old_argv, old_requests), (new, new_argv, new_requests) = both(tmp_path, shell, clerk, reply)
    assert new.stdout == old.stdout                                 # byte for byte, trailing newlines included
    assert new.returncode == old.returncode == 0
    assert new_requests == old_requests and len(new_requests) == (0 if reply == "refused" else 1)
    for request in new_requests:
        assert (request["method"], request["path"]) == ("POST", "/v1/sessions/%s/tokens" % SESSION)
        assert request["authorization"] == "Bearer " + SECRET and request["content_type"] == "application/json"
        assert request["body"] == b"{}"
    # curl gets the same arguments in the same order, plus the write-out pair just before the URL
    assert new_argv == old_argv[:-1] + ["-w", "%{stderr}%{http_code}"] + old_argv[-1:]
    assert old.stderr == b""                                        # the old function said nothing, ever
    lines = mint_lines(new)
    assert new.stderr.decode() == "".join(line + "\n" for line in lines) and len(lines) == 1
    assert lines[0] == "[mint] http=%s shape=%s caller=main:%d" % (code, shape, 1 + current().count("\n") + 1)


@EACH_SHELL
def test_the_token_and_the_secret_never_reach_stderr(tmp_path, shell, clerk):
    """The comparison above already pins stderr to the one [mint] line; this says what that is for."""
    proc, _ = run(tmp_path, shell, current(), clerk((200, '{"jwt":"%s"}' % JWT)).port)
    err = proc.stderr.decode()
    assert proc.stdout.decode() == JWT + "\n" and "[mint] http=200 shape=ok" in err
    assert SECRET not in err and SESSION not in err
    assert not any(part in err for part in [JWT] + JWT.split(".") + [JWT[:8], JWT[-8:]])


@EACH_SHELL
def test_a_nul_in_the_token_reaches_callers_exactly_as_before(tmp_path, shell, clerk):
    """The one place the raw bytes can differ: jq -r writes a NUL as a NUL, and a shell variable cannot hold one.
    No caller could ever see it (each takes the token through $(...), which drops it), so what is compared here
    is what a caller gets."""
    script = 'X=$(mint_session_token) 2>/dev/null\nprintf "[%s]" "$X"\n'
    seen = []
    for name, function in (("old", ORIGINAL), ("new", current())):
        server = clerk((200, r'{"jwt":"a\u0000b.c.d"}'))
        proc, _ = run(tmp_path, shell, function, server.port, script, name=name)
        seen.append((proc.returncode, proc.stdout, len(server.requests)))
    assert seen[0] == seen[1] == (0, b"[ab.c.d]", 1)


@EACH_SHELL
def test_what_else_reaches_curls_stderr_still_reaches_the_scripts(tmp_path, shell, clerk):
    """curl is silent under -s, so the only thing the status can share its stream with is noise from the
    environment (a verbose ~/.curlrc, a wrapper). It is passed on as before and the status is still read."""
    server = clerk((200, '{"jwt":"%s"}' % JWT))
    noisy = tmp_path / "noisy"
    (noisy / "bin").mkdir(parents=True)
    (noisy / "bin" / "curl").write_text(
        "#!/bin/bash\necho 'curl: (wrapper) note 1' >&2\n"
        f'a=()\nfor x in "$@"; do a+=("${{x/https:\\/\\/api.clerk.com\\//http://127.0.0.1:{server.port}/}}"); done\n'
        f'exec {shlex.quote(REAL_CURL)} -q "${{a[@]}}"\n')
    (noisy / "bin" / "curl").chmod(0o755)
    (noisy / "driver.sh").write_text("set -euo pipefail\n" + current() + "mint_session_token\n")
    env = dict(os.environ, PATH=f"{noisy / 'bin'}{os.pathsep}{os.environ['PATH']}", NO_PROXY="*",
               CLERK_SECRET_KEY_STAGING=SECRET, CLERK_SESSION_ID=SESSION)
    proc = subprocess.run([shell, str(noisy / "driver.sh")], env=env, capture_output=True, timeout=120)
    assert proc.returncode == 0 and proc.stdout.decode() == JWT + "\n" and len(server.requests) == 1
    assert proc.stderr.decode() == ("curl: (wrapper) note 1\n[mint] http=200 shape=ok caller=main:%d\n"
                                    % (1 + current().count("\n") + 1))


@EACH_SHELL
def test_without_curl_the_function_still_returns_empty_and_exit_0(tmp_path, shell):
    """Both functions, with no curl to run: same stdout, same status; the shell's own complaint is kept."""
    results = {}
    for name, function in (("old", ORIGINAL), ("new", current())):
        work = tmp_path / name
        (work / "bin").mkdir(parents=True)
        os.symlink(REAL_JQ, work / "bin" / "jq")
        (work / "driver.sh").write_text("set -euo pipefail\n" + function + "mint_session_token\n")
        env = {"PATH": str(work / "bin"), "CLERK_SECRET_KEY_STAGING": SECRET, "CLERK_SESSION_ID": SESSION}
        results[name] = subprocess.run([shell, str(work / "driver.sh")], env=env, capture_output=True, timeout=60)
    old, new = results["old"], results["new"]
    assert new.stdout == old.stdout == b"\n" and new.returncode == old.returncode == 0
    assert b"curl: command not found" in old.stderr and b"curl: command not found" in new.stderr
    assert mint_lines(new) == ["[mint] http=000 shape=empty caller=main:%d" % (1 + current().count("\n") + 1)]


# ── the text of the change ─────────────────────────────────────────────────────────────────────────────────────

def test_the_function_makes_one_request_and_has_no_retry_and_no_exit_path():
    body = current()
    code = "\n".join(re.sub(r"\s{2,}# .*$", "", line) for line in body.splitlines()
                     if not line.lstrip().startswith("#"))             # comments, whole-line and trailing, dropped
    assert len(re.findall(r"\bcurl\b", code)) == 1 and len(re.findall(r"\bjq\b", code)) == 1
    assert not re.search(r"\b(while|until|for|retry|sleep|exit|return|kill)\b", code)
    for unchanged in ("curl -s --max-time 30 --connect-timeout 10 \\", "-X POST \\",
                      '-H "Authorization: Bearer $CLERK_SECRET_KEY_STAGING" \\', '-H "Content-Type: application/json" \\',
                      "-d '{}' \\", '"https://api.clerk.com/v1/sessions/${CLERK_SESSION_ID}/tokens"',
                      "| jq -r '.jwt // empty' 2>/dev/null || echo \"\""):
        assert unchanged in code and unchanged in ORIGINAL, unchanged
    assert code.rstrip().splitlines()[-2].strip() == "printf '%s' \"$mint_tok\""   # stdout is the last thing it does


def test_every_call_site_is_still_a_plain_capture():
    with open(SMOKE, encoding="utf-8") as fh:
        text = fh.read()
    uses = [line.strip() for line in text.splitlines()
            if "mint_session_token" in line and not line.lstrip().startswith("#")]
    calls = [line for line in uses if line != "mint_session_token() {"]
    assert len(uses) == len(calls) + 1 and len(calls) == 65
    assert all(re.fullmatch(r"[A-Za-z_]+=\$\(mint_session_token\)", line) for line in calls), calls
