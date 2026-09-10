"""Tests for the rehearsal GitHub-API failure reporter.

Pure-core plus a CLI exercise through main() — no network, no subprocess.
The load-bearing assertions are the ones that prove a failure is LEGIBLE: the
status and the body text must both appear in the emitted annotation. A
diagnostic that cannot be shown to fire is the bug it was written to fix.
"""
import importlib.util
import json
import os
import sys

import pytest

spec = importlib.util.spec_from_file_location(
    "gh_api_check", os.path.join(os.path.dirname(__file__), "gh_api_check.py"))
gac = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gac)

REF_URL = "https://api.github.com/repos/islanddave/garden-app/git/refs/heads/dev"
GOOD_REF = json.dumps({
    "ref": "refs/heads/dev",
    "object": {"sha": "6204e2b348185a677057d437eb7f57e4b35bca13", "type": "commit"},
})
NOT_FOUND = json.dumps({
    "message": "Not Found",
    "documentation_url": "https://docs.github.com/rest/git/refs#get-a-reference",
    "status": "404",
})
BAD_CREDS = json.dumps({"message": "Bad credentials", "status": "401"})


# --- extract_ref_sha: the call site that produced KeyError: 'object' ---------

def test_valid_ref_body_returns_sha():
    assert gac.extract_ref_sha("200", GOOD_REF, REF_URL) == \
        "6204e2b348185a677057d437eb7f57e4b35bca13"


def test_404_names_status_and_message():
    with pytest.raises(gac.GhApiFailure) as exc:
        gac.extract_ref_sha("404", NOT_FOUND, REF_URL)
    msg = str(exc.value)
    assert "404" in msg and "Not Found" in msg and REF_URL in msg


def test_401_names_status_and_message():
    with pytest.raises(gac.GhApiFailure) as exc:
        gac.extract_ref_sha("401", BAD_CREDS, REF_URL)
    msg = str(exc.value)
    assert "401" in msg and "Bad credentials" in msg


def test_401_403_404_are_distinguishable():
    """The whole point: three statuses that used to collapse into one KeyError."""
    msgs = []
    for code, body in (("401", BAD_CREDS),
                       ("403", json.dumps({"message": "Resource not accessible"})),
                       ("404", NOT_FOUND)):
        with pytest.raises(gac.GhApiFailure) as exc:
            gac.extract_ref_sha(code, body, REF_URL)
        msgs.append(str(exc.value))
    assert len(set(msgs)) == 3
    for code, msg in zip(("401", "403", "404"), msgs):
        assert code in msg


def test_200_with_no_object_key_names_the_keys():
    body = json.dumps({"message": "Not Found"})
    with pytest.raises(gac.GhApiFailure) as exc:
        gac.extract_ref_sha("200", body, REF_URL)
    assert "no usable 'object' key" in str(exc.value)
    assert "message" in str(exc.value)


def test_200_list_body_is_named_as_a_prefix_match():
    body = json.dumps([{"ref": "refs/heads/dev", "object": {"sha": "a" * 40}},
                       {"ref": "refs/heads/dev2", "object": {"sha": "b" * 40}}])
    with pytest.raises(gac.GhApiFailure) as exc:
        gac.extract_ref_sha("200", body, REF_URL)
    assert "LIST of 2 refs" in str(exc.value)


def test_200_non_json_body_is_reported_verbatim():
    with pytest.raises(gac.GhApiFailure) as exc:
        gac.extract_ref_sha("200", "<html>502 Bad Gateway</html>", REF_URL)
    assert "not JSON" in str(exc.value) and "502 Bad Gateway" in str(exc.value)


def test_200_with_empty_sha_is_rejected():
    body = json.dumps({"object": {"sha": "", "type": "commit"}})
    with pytest.raises(gac.GhApiFailure):
        gac.extract_ref_sha("200", body, REF_URL)


def test_curl_transport_failure_000_is_explained():
    with pytest.raises(gac.GhApiFailure) as exc:
        gac.extract_ref_sha("000", "", REF_URL)
    assert "curl transport failure" in str(exc.value)


# --- check_status ------------------------------------------------------------

def test_check_status_accepts_listed_code():
    assert gac.check_status("201", "{}", REF_URL, "POST", ["201"]) is None


def test_check_status_accepts_any_of_several():
    assert gac.check_status(422, "{}", REF_URL, "POST", [201, "422"]) is None


def test_check_status_reports_status_and_body_on_mismatch():
    out = gac.check_status("403", json.dumps({"message": "Tag protected"}),
                           REF_URL, "DELETE", ["204"])
    assert out is not None and "403" in out and "Tag protected" in out and "DELETE" in out


# --- annotation shape --------------------------------------------------------

def test_annotate_escapes_percent(capsys):
    gac.annotate("error", "100% blocked")
    assert capsys.readouterr().out.strip() == "::error::100%25 blocked"


def test_one_line_collapses_and_truncates():
    assert gac.one_line("a\n  b\tc") == "a b c"
    assert gac.one_line("x" * 900).endswith("...<truncated>")
    assert gac.one_line("") == "<empty body>"
    assert gac.one_line(None) == "<no body>"


def test_summarize_body_prefers_github_message():
    assert "Not Found" in gac.summarize_body(NOT_FOUND)


def test_summarize_body_falls_back_to_raw_for_html():
    assert "Bad Gateway" in gac.summarize_body("<html>Bad Gateway</html>")


# --- CLI: the shape the workflow actually invokes ----------------------------

def _body(tmp_path, text, name="body.json"):
    p = tmp_path / name
    p.write_text(text, encoding="utf-8")
    return str(p)


def test_cli_ref_sha_writes_sha_and_exits_zero(tmp_path, capsys):
    sha_file = str(tmp_path / "base.sha")
    rc = gac.main(["ref-sha", "--endpoint", REF_URL, "--method", "GET",
                   "--status", "200", "--body-file", _body(tmp_path, GOOD_REF),
                   "--sha-file", sha_file])
    assert rc == 0
    assert open(sha_file).read() == "6204e2b348185a677057d437eb7f57e4b35bca13"
    assert "::error::" not in capsys.readouterr().out


def test_cli_ref_sha_404_emits_error_and_exits_nonzero(tmp_path, capsys):
    """THE fire proof: a 404 body must produce a ::error:: naming the status and
    the message, and a non-zero exit. Mutating cmd_ref_sha's failure branch to a
    no-op (return 0 without annotating) must turn this test RED."""
    sha_file = str(tmp_path / "base.sha")
    rc = gac.main(["ref-sha", "--endpoint", REF_URL, "--method", "GET",
                   "--status", "404", "--body-file", _body(tmp_path, NOT_FOUND),
                   "--sha-file", sha_file])
    out = capsys.readouterr().out
    assert rc != 0, "a 404 must exit non-zero"
    assert out.startswith("::error::"), "a 404 must emit a ::error:: annotation"
    assert "404" in out, "the annotation must name the HTTP status"
    assert "Not Found" in out, "the annotation must carry the response body"
    assert REF_URL in out, "the annotation must name the endpoint"
    assert not os.path.exists(sha_file), "no sha file may be written on failure"


def test_cli_status_fatal_exits_nonzero(tmp_path, capsys):
    rc = gac.main(["status", "--endpoint", REF_URL, "--method", "POST",
                   "--status", "403", "--body-file", _body(tmp_path, BAD_CREDS),
                   "--ok", "201", "--fatal"])
    out = capsys.readouterr().out
    assert rc == 1 and out.startswith("::error::") and "403" in out


def test_cli_status_non_fatal_annotates_but_exits_zero(tmp_path, capsys):
    """Teardown/tolerated call sites must stay tolerated: annotation, exit 0."""
    rc = gac.main(["status", "--endpoint", REF_URL, "--method", "DELETE",
                   "--status", "403", "--body-file", _body(tmp_path, BAD_CREDS),
                   "--ok", "204", "--severity", "warning"])
    out = capsys.readouterr().out
    assert rc == 0
    assert out.startswith("::warning::") and "403" in out and "Bad credentials" in out


def test_cli_status_ok_is_quiet_and_zero(tmp_path, capsys):
    rc = gac.main(["status", "--endpoint", REF_URL, "--method", "POST",
                   "--status", "201", "--body-file", _body(tmp_path, "{}"),
                   "--ok", "201", "--fatal"])
    assert rc == 0 and "::" not in capsys.readouterr().out


def test_cli_missing_body_file_still_reports(tmp_path, capsys):
    """A body file that never got written must not mask the status."""
    rc = gac.main(["ref-sha", "--endpoint", REF_URL, "--method", "GET",
                   "--status", "500", "--body-file", str(tmp_path / "nope.json"),
                   "--sha-file", str(tmp_path / "x.sha")])
    out = capsys.readouterr().out
    assert rc != 0 and "500" in out


# --- the workflow's own wiring, asserted against the YAML --------------------

WORKFLOWS = os.path.join(os.path.dirname(__file__), "..", ".github", "workflows")


def _wf(name):
    with open(os.path.join(WORKFLOWS, name), encoding="utf-8") as fh:
        return fh.read()


def _code(name):
    """Workflow text with whole-line comments dropped. The comments in these
    files quote the old broken pattern verbatim, so a naive substring guard
    matches its own documentation instead of live code."""
    return "\n".join(ln for ln in _wf(name).splitlines()
                     if not ln.lstrip().startswith("#"))


def test_comment_stripper_actually_strips():
    """Guard on the guard: if _code() stopped stripping, the two tests below
    would go vacuously green against their own explanatory comments."""
    assert "| python3 -c" in _wf("revert-rehearsal.yml")
    assert "| python3 -c" not in _code("revert-rehearsal.yml")


@pytest.mark.parametrize("name", ["revert-rehearsal.yml", "snap-rehearsal.yml"])
def test_no_workflow_pipes_curl_into_bare_python(name):
    """The regression guard for the original bug shape: a body piped straight
    into python3 discards the status. Neither rehearsal workflow may do it."""
    code = _code(name)
    assert "| python3 -c" not in code
    assert "|python3 -c" not in code


@pytest.mark.parametrize("name", ["revert-rehearsal.yml", "snap-rehearsal.yml"])
def test_every_github_api_curl_captures_its_status(name):
    """Every api.github.com curl must write the body somewhere and ask curl for
    the HTTP code. `>/dev/null` on a GitHub API call is the blind spot itself."""
    code = _code(name)
    for line in code.splitlines():
        if "api.github.com" not in line:
            continue
        assert ">/dev/null" not in line, "discarded body: %s" % line.strip()
    assert code.count("%{http_code}") == code.count("curl -sS -o")


def test_revert_rehearsal_checks_every_call_it_makes():
    """Structural invariant: every captured HTTP status is handed to the
    reporter. One un-checked ghcurl is one more invisible failure."""
    text = _wf("revert-rehearsal.yml")
    calls = text.count("CODE=$(ghcurl")
    checks = text.count("$CHK ")
    assert calls == 7, "expected 7 GitHub API calls, found %d" % calls
    assert checks == calls, "%d calls but %d checks" % (calls, checks)


def test_snap_rehearsal_preflights_the_shared_secret():
    text = _wf("snap-rehearsal.yml")
    assert "scripts/gh_api_check.py" in text
    assert "RULESET_READ_PAT" in text
