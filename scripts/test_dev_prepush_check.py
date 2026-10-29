"""scripts/dev-prepush-check.py with the network faked at the one place it starts a process.

Run: python3 -m pytest -q scripts/test_dev_prepush_check.py

No network, no real `gh`: Fake replaces the module's _run(), answers `git ls-remote`, `git fetch`, `git cat-file`,
`git remote get-url` and `gh api` from what the test set up, and records every command so the read-only claim is
checked on each case. The marker messages are built by staged-promote.py's own format_marker(), so the "by" compared
here is the one `stage --by` writes. One test at the end uses real git against a local bare repository: it is the
only one that proves the ls-remote arguments and the ref-less fetch read an annotated tag the way the parser assumes.
"""
import datetime
import importlib.util
import io
import json
import os
import subprocess

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("dev_prepush_check", os.path.join(HERE, "dev-prepush-check.py"))
dpc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(dpc)

DEV = "1f58a9d888054b453a2ae2760ba229cc8134cc31"
MOVED = "2" * 40
TAG_OBJECT = "a" * 40
STAGED = "b" * 40
NOW = datetime.datetime(2026, 10, 13, 12, 0, 0, tzinfo=datetime.timezone.utc)
ME, PEER = "T1/prepushcheck-20261013", "T3/putup-20261012"
READ_ONLY = (["git", "ls-remote"], ["git", "fetch", "--quiet", "--no-tags", "--no-write-fetch-head"],
             ["git", "cat-file", "-p"], ["git", "remote", "get-url"], ["gh", "api", "-X", "GET"])


def run_row(run_id, status="completed", conclusion="success", event="push", branch="dev", sha=DEV,
            started="2026-10-13T11:48:00Z"):
    return {"id": run_id, "status": status, "conclusion": conclusion if status == "completed" else None,
            "event": event, "head_branch": branch, "head_sha": sha, "run_started_at": started, "created_at": started}


def listing(*rows):
    return {"total_count": len(rows), "workflow_runs": list(rows)}


class Fake:
    """_run() for one test. marker_by=None is no marker; refs_fail / runs_fail / fetch_fail break that read."""

    def __init__(self, marker_by=None, marker_at="2026-10-13T09:00:00+00:00", lightweight=False, ci=None,
                 refs_fail=False, fetch_fail=False, runs_fail=None, gh_missing=False, dev=DEV,
                 refs_out=None, url="https://github.com/islanddave/garden-app.git"):
        self.__dict__.update(locals())
        self.calls = []

    def __call__(self, cmd, timeout=None):
        self.calls.append(cmd)
        if cmd[:2] == ["git", "ls-remote"]:
            if self.refs_fail:      # with a dev line on stdout: the exit code alone has to make this unreadable
                return (128, "%s\t%s\n" % (self.dev, dpc.DEV_REF),
                        "fatal: unable to access 'https://someone:s3cret@github.com/x/y.git/': timed out")
            if self.refs_out is not None:
                return 0, self.refs_out, ""
            out = "%s\t%s\n" % (self.dev, dpc.DEV_REF)
            if self.marker_by is not None or self.lightweight:
                out += "%s\t%s\n" % (TAG_OBJECT, dpc.TAG_REF)
                if not self.lightweight:
                    out += "%s\t%s^{}\n" % (STAGED, dpc.TAG_REF)
            return 0, out, ""
        if cmd[:2] == ["git", "fetch"]:
            return (1, "", "fatal: could not read from remote") if self.fetch_fail else (0, "", "")
        if cmd[:2] == ["git", "cat-file"]:
            message = dpc.staged_promote.format_marker(STAGED, "v4.186.0", self.marker_by, self.marker_at)
            return 0, "object %s\ntype commit\ntag staged-promote\ntagger x <x@y> 0 +0000\n\n%s\n" % (STAGED, message), ""
        if cmd[:3] == ["git", "remote", "get-url"]:
            return 0, self.url + "\n", ""
        if cmd[:2] == ["gh", "api"]:
            if self.gh_missing:
                raise dpc.Unreadable("cannot run `gh` ([Errno 2] No such file or directory: 'gh')")
            workflow = cmd[-1].split("/workflows/", 1)[1].split("/", 1)[0]
            if self.runs_fail in (workflow, "all"):
                return 1, '{"message":"Bad credentials"}', "gh: Bad credentials (HTTP 401)"
            doc = {"ci.yml": self.ci}[workflow]
            return 0, doc if isinstance(doc, str) else json.dumps(listing() if doc is None else doc), ""
        raise AssertionError("unexpected command: %r" % (cmd,))


def check(monkeypatch, fake, *argv):
    monkeypatch.setattr(dpc, "_run", fake)
    out = io.StringIO()
    code = dpc.main(list(argv), now=NOW, stdout=out)
    for cmd in fake.calls:
        assert any(cmd[:len(prefix)] == prefix for prefix in READ_ONLY), "not a read: %r" % (cmd,)
    return code, out.getvalue()


def test_no_marker_and_no_runs_is_safe_and_prints_dev(monkeypatch):
    fake = Fake(ci=listing(run_row(1), run_row(2, conclusion="failure")))
    code, out = check(monkeypatch, fake, "--by", ME)
    assert code == 0 and out.startswith("SAFE: ")
    assert "dev %s" % DEV in out
    assert sum(cmd[:2] == ["git", "ls-remote"] for cmd in fake.calls) == 1      # dev is read once
    assert fake.calls[0][-1] == dpc.TAG_REF + "^{}"                             # the peeled ref is asked for by name
    asked = [cmd[-1] for cmd in fake.calls if cmd[0] == "gh"]
    assert asked == ["repos/islanddave/garden-app/actions/workflows/ci.yml/runs?branch=dev&per_page=100"]


def test_empty_listings_are_safe(monkeypatch):
    code, out = check(monkeypatch, Fake())
    assert code == 0 and out.startswith("SAFE: ")


def test_marker_held_by_caller_is_safe(monkeypatch):
    code, out = check(monkeypatch, Fake(marker_by=ME), "--by", ME)
    assert code == 0 and out.startswith("SAFE: ")
    assert "marker at %s is yours" % STAGED in out and "dev is NOT at that SHA" in out


def test_marker_held_by_another_is_not_safe_and_says_who_what_how_old(monkeypatch):
    code, out = check(monkeypatch, Fake(marker_by=PEER), "--by", ME)
    assert code == 1 and out.startswith("NOT SAFE: ")
    for must in (PEER, "v4.186.0", STAGED, "3.0 h ago", "staged-promote.py clear", "Do not push"):
        assert must in out


@pytest.mark.parametrize("argv", [[], ["--by", "T1"], ["--by", ME + "x"], ["--by", ME.upper()]])
def test_a_marker_refuses_without_an_exact_by(monkeypatch, argv):
    code, out = check(monkeypatch, Fake(marker_by=ME), *argv)
    assert code == 1 and out.startswith("NOT SAFE: ")


def test_a_marker_with_an_empty_by_is_nobodys(monkeypatch):
    code, out = check(monkeypatch, Fake(marker_by=""), "--by", "")
    assert code == 1 and "an unrecorded session" in out


def test_a_lightweight_marker_is_not_safe(monkeypatch):
    code, out = check(monkeypatch, Fake(lightweight=True), "--by", ME)
    assert code == 1 and "lightweight tag" in out


def test_marker_read_fails_is_unknown_and_prints_no_secret(monkeypatch):
    code, out = check(monkeypatch, Fake(refs_fail=True), "--by", ME)
    assert code == 2 and out.startswith("UNKNOWN: ")
    assert "s3cret" not in out and "someone" not in out and "SAFE: no" not in out


@pytest.mark.parametrize("refs_out", ["", "\n", "garbage\n", "%s\trefs/heads/main\n" % DEV,
                                      "%s\t%s\n" % (TAG_OBJECT, "refs/tags/staged-promote"),
                                      "%s\trefs/heads/dev\n%s\trefs/tags/staged-promote^{}\n" % (DEV, STAGED)])
def test_an_ls_remote_reply_that_is_not_a_full_answer_is_unknown(monkeypatch, refs_out):
    code, out = check(monkeypatch, Fake(refs_out=refs_out), "--by", ME)
    assert code == 2 and out.startswith("UNKNOWN: ")


def test_marker_present_but_message_unfetchable_is_unknown(monkeypatch):
    code, out = check(monkeypatch, Fake(marker_by=ME, fetch_fail=True), "--by", ME)
    assert code == 2 and out.startswith("UNKNOWN: ") and STAGED in out


@pytest.mark.parametrize("status", ["in_progress", "queued", "waiting", "requested", "pending", "some_new_status"])
def test_an_unfinished_ci_run_on_dev_is_not_safe(monkeypatch, status):
    code, out = check(monkeypatch, Fake(ci=listing(run_row(77, status=status), run_row(1))), "--by", ME)
    assert code == 1 and out.startswith("NOT SAFE: ")
    for must in ("ci.yml run 77", "12 min ago", "actions/runs/77", "--own-run 77", DEV[:12]):
        assert must in out


def test_an_unfinished_dispatched_run_on_dev_is_not_safe(monkeypatch):
    fake = Fake(ci=listing(run_row(88, status="in_progress", event="workflow_dispatch")))
    code, out = check(monkeypatch, fake, "--by", ME)
    assert code == 1 and "ci.yml run 88" in out and "workflow_dispatch" in out


def test_own_run_is_not_counted_but_another_still_is(monkeypatch):
    fake = Fake(ci=listing(run_row(77, status="in_progress"), run_row(88, status="queued")))
    code, out = check(monkeypatch, fake, "--own-run", "77", "--own-run", "88")
    assert code == 0 and out.startswith("SAFE: ") and out.count("not counted (--own-run)") == 2
    code, out = check(monkeypatch, fake, "--own-run", "77")
    assert code == 1 and "ci.yml run 88" in out and "not counted (--own-run): ci.yml run 77" in out


def test_cancelled_and_failed_runs_are_finished(monkeypatch):
    fake = Fake(ci=listing(run_row(1, conclusion="cancelled"), run_row(2, conclusion="failure"),
                           run_row(3, conclusion="timed_out")))
    assert check(monkeypatch, fake)[0] == 0


def test_runs_off_dev_and_pull_request_runs_are_not_counted(monkeypatch):
    fake = Fake(ci=listing(run_row(5, status="in_progress", branch="lane-x"),
                           run_row(6, status="in_progress", event="pull_request"),
                           run_row(7, status="queued", event="pull_request_target"),
                           run_row(8, status="in_progress", branch=None)))
    assert check(monkeypatch, fake)[0] == 0


@pytest.mark.parametrize("which", ["ci.yml", "all"])
def test_runs_read_fails_is_unknown(monkeypatch, which):
    code, out = check(monkeypatch, Fake(runs_fail=which), "--by", ME)
    assert code == 2 and out.startswith("UNKNOWN: ") and "gh auth status" in out
    assert "dev %s" % DEV in out


def test_gh_missing_is_unknown_and_says_what_is_needed(monkeypatch):
    code, out = check(monkeypatch, Fake(gh_missing=True))
    assert code == 2 and "needs the GitHub CLI `gh`" in out


@pytest.mark.parametrize("doc", ["<html>", "[]", '{"message": "rate limited"}', '{"workflow_runs": []}',
                                 '{"total_count": 0, "workflow_runs": [{"id": 1}]}',
                                 '{"total_count": 1, "workflow_runs": [{"id": "1", "status": "completed", '
                                 '"event": "push", "head_branch": "dev"}]}',
                                 '{"total_count": 1, "workflow_runs": ["x"]}'])
def test_an_unparseable_runs_reply_is_unknown(monkeypatch, doc):
    code, out = check(monkeypatch, Fake(ci=doc))
    assert code == 2 and out.startswith("UNKNOWN: ")


def test_a_repository_that_cannot_be_named_is_unknown_unless_given(monkeypatch):
    fake = Fake(url="https://example.org/mirror/garden-app.git")
    assert check(monkeypatch, fake)[0] == 2
    assert check(monkeypatch, fake, "--repo", "islanddave/garden-app")[0] == 0


def test_expect_dev(monkeypatch):
    code, out = check(monkeypatch, Fake(), "--expect-dev", DEV)
    assert code == 0
    code, out = check(monkeypatch, Fake(dev=MOVED), "--expect-dev", DEV)
    assert code == 1 and "dev has moved" in out and DEV in out and MOVED in out


def test_a_reason_beats_a_failed_read_and_both_are_shown(monkeypatch):
    code, out = check(monkeypatch, Fake(marker_by=PEER, runs_fail="all"), "--by", ME)
    assert code == 1 and out.startswith("NOT SAFE: ") and "could not be read" in out


def test_a_crash_inside_the_check_is_unknown(monkeypatch):
    def boom(cmd, timeout=None):
        raise RuntimeError("no")
    monkeypatch.setattr(dpc, "_run", boom)
    out = io.StringIO()
    assert dpc.main([], now=NOW, stdout=out) == 2 and out.getvalue().startswith("UNKNOWN: ")


def test_staged_promote_not_loadable_is_unknown(monkeypatch):
    monkeypatch.setattr(dpc, "staged_promote", None)
    monkeypatch.setattr(dpc, "IMPORT_FAILURE", "TypeError", raising=False)
    out = io.StringIO()
    assert dpc.main(["--by", ME], stdout=out) == 2 and out.getvalue().startswith("UNKNOWN: ")


@pytest.mark.parametrize("argv", [["--expect-dev", "1f58a9d"], ["--own-run", "abc"], ["--repo", "nope"], ["--nope"]])
def test_malformed_arguments_exit_64(argv, capsys):
    with pytest.raises(SystemExit) as stop:
        dpc.main(argv)
    assert stop.value.code == 64
    assert "SAFE" not in capsys.readouterr().out


def test_help_documents_the_exit_codes(capsys):
    with pytest.raises(SystemExit):
        dpc.main(["--help"])
    text = " ".join(capsys.readouterr().out.split())
    for must in ("0 SAFE", "1 NOT SAFE", "2 UNKNOWN", "64 malformed", "--own-run", "--expect-dev", "--by"):
        assert must in text


def test_exit_codes_are_distinct():
    assert sorted(list(dpc.EXIT.values()) + [dpc.EXIT_USAGE]) == [0, 1, 2, 64]


# --- real git, local bare repository: no network ----------------------------------------------------------------

def _git(cwd, *args):
    done = subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "tag.gpgSign=false",
                           "-c", "commit.gpgSign=false", *args], cwd=cwd, capture_output=True, text=True)
    assert done.returncode == 0, done.stderr
    return done.stdout.strip()


@pytest.fixture
def repos(tmp_path, monkeypatch):
    origin, work, reader = str(tmp_path / "origin.git"), str(tmp_path / "work"), str(tmp_path / "reader")
    _git(str(tmp_path), "init", "--quiet", "--object-format=sha1", "--bare", origin)
    _git(str(tmp_path), "init", "--quiet", "--object-format=sha1", "-b", "dev", work)
    _git(work, "commit", "--quiet", "--allow-empty", "-m", "one")
    _git(work, "push", "--quiet", origin, "dev")
    _git(str(tmp_path), "init", "--quiet", "--object-format=sha1", reader)
    _git(reader, "remote", "add", "origin", origin)
    monkeypatch.setattr(dpc, "ROOT", reader)
    real = dpc._run
    monkeypatch.setattr(dpc, "_run", lambda cmd, timeout=30: (0, "{\"total_count\": 0, \"workflow_runs\": []}", "")
                        if cmd[0] == "gh" else real(cmd, timeout))
    return origin, work, reader, _git(work, "rev-parse", "HEAD")


def _stage(origin, work, sha, by):
    when = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat()
    _git(work, "tag", "-f", "-a", "staged-promote", sha, "-m", dpc.staged_promote.format_marker(sha, "v9.9.9", by, when))
    _git(work, "push", "--quiet", "--force", origin, "refs/tags/staged-promote")


def test_real_git_reads_an_annotated_marker_and_writes_no_ref(repos):
    origin, work, reader, sha = repos
    out = io.StringIO()
    assert dpc.main(["--repo", "o/r"], stdout=out) == 0 and "dev %s" % sha in out.getvalue()

    _stage(origin, work, sha, PEER)
    out = io.StringIO()
    assert dpc.main(["--repo", "o/r", "--by", ME], stdout=out) == 1
    assert PEER in out.getvalue() and "v9.9.9 at %s" % sha in out.getvalue()      # the COMMIT, not the tag object
    out = io.StringIO()
    assert dpc.main(["--repo", "o/r", "--by", PEER], stdout=out) == 0
    assert "marker at %s is yours" % sha in out.getvalue() and "NOT at that SHA" not in out.getvalue()
    assert _git(reader, "for-each-ref") == ""                                     # the read moved no local ref
    assert not os.path.exists(os.path.join(reader, ".git", "FETCH_HEAD"))

    _git(work, "push", "--quiet", origin, ":refs/tags/staged-promote")
    assert dpc.main(["--repo", "o/r", "--by", ME], stdout=io.StringIO()) == 0


def test_real_git_unreachable_remote_is_unknown(repos):
    origin, work, reader, sha = repos
    _git(reader, "remote", "set-url", "origin", os.path.join(os.path.dirname(origin), "gone.git"))
    out = io.StringIO()
    assert dpc.main(["--repo", "o/r"], stdout=out) == 2 and out.getvalue().startswith("UNKNOWN: ")
