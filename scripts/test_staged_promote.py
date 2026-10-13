"""Tests for the staged-promote marker (OPS-STAGEDPROMOTEINVALIDATED-001).

No network. The pure pieces first: message formatting, message parsing, age
arithmetic, and the ls-remote peeling rule, which is the one place a plausible
implementation is silently wrong. Then the failed-read contract
(BUG-STAGEDMARKERFAILOPEN-001), with git faked and, at the end, with the real
script run against real local remotes.
"""
import importlib.util, os, subprocess, sys

import pytest
from datetime import datetime, timezone

spec = importlib.util.spec_from_file_location(
    "sp", os.path.join(os.path.dirname(__file__), "staged-promote.py"))
sp = importlib.util.module_from_spec(spec); spec.loader.exec_module(sp)

SHA = "d395e8412ab34cd56789012345678901234abcde"
NOW = datetime(2026, 8, 28, 18, 0, 0, tzinfo=timezone.utc)


# ── round trip ───────────────────────────────────────────────────────────────────
def test_format_then_parse_round_trips():
    msg = sp.format_marker(SHA, "v4.49.0", "garden-hardparallel-20260824", "2026-08-24T14:00:00+00:00")
    got = sp.parse_marker(msg)
    assert got == {"sha": SHA, "version": "v4.49.0",
                   "by": "garden-hardparallel-20260824", "at": "2026-08-24T14:00:00+00:00"}


def test_message_is_human_readable_before_it_is_machine_readable():
    """A person paged at 2am reads the top of this, not the JSON."""
    msg = sp.format_marker(SHA, "v4.49.0", "sess", "2026-08-24T14:00:00+00:00")
    first = msg.splitlines()[0]
    assert "STAGED PROMOTE" in first and "v4.49.0" in first and SHA in first
    assert "Do not move dev off this SHA" in msg
    assert "clear" in msg  # the way out is stated in the marker itself


# ── parsing is tolerant, because an unreadable marker must still REPORT ──────────
def test_parse_returns_empty_for_absent_metadata():
    assert sp.parse_marker("just a message, no metadata") == {}
    assert sp.parse_marker("") == {}
    assert sp.parse_marker(None) == {}


def test_parse_survives_a_corrupt_metadata_block():
    # A check that crashes on a malformed marker is worse than one that says
    # "something is staged, I can't read the details" — it fails OPEN.
    assert sp.parse_marker(f"header\n{sp._JSON_START}\n{{not json") == {}
    assert sp.parse_marker(f"header\n{sp._JSON_START}\n[1,2,3]") == {}   # valid JSON, wrong shape


# ── age is reported, never used to auto-expire ───────────────────────────────────
def test_age_hours_computes_from_iso():
    assert sp.age_hours("2026-08-28T12:00:00+00:00", NOW) == 6.0


def test_age_hours_accepts_a_z_suffix_and_assumes_utc_when_naive():
    assert sp.age_hours("2026-08-28T12:00:00Z", NOW) == 6.0
    assert sp.age_hours("2026-08-28T12:00:00", NOW) == 6.0


def test_age_hours_returns_none_rather_than_guessing():
    for bad in ["", "yesterday", "2026-13-45", None]:
        assert sp.age_hours(bad, NOW) is None


def test_a_very_old_marker_is_still_a_marker():
    """No auto-expiry, deliberately. A marker that stopped mattering on a timer
    would recreate the exact defect this file exists to fix."""
    assert sp.age_hours("2026-01-01T00:00:00+00:00", NOW) > 5000


# ── the sha guard ────────────────────────────────────────────────────────────────
def test_full_sha_pattern_rejects_the_short_form_that_caused_the_incident():
    # The 2026-08-24 incident recorded only `d395e84`. actions/checkout treats a
    # 7-char sha as a ref PATTERN and pstate refuses a short prod_sha.
    assert sp.FULL_SHA.match(SHA)
    for bad in ["d395e84", SHA.upper(), SHA[:39], SHA + "f", "z" * 40, ""]:
        assert not sp.FULL_SHA.match(bad), f"{bad!r} must not pass as a full sha"


# ── the peeling rule — the one place a plausible implementation is silently wrong ─
def _peel(stdout):
    """Mirror of remote_marker_sha's parsing, fed synthetic ls-remote output."""
    peeled, plain = None, None
    for line in stdout.strip().splitlines():
        sha, _, ref = line.partition("\t")
        if ref.endswith("^{}"):
            peeled = sha.strip()
        else:
            plain = sha.strip()
    return peeled or plain


def test_annotated_tag_resolves_to_the_COMMIT_not_the_tag_object():
    # An annotated tag's plain ls-remote line is the TAG OBJECT's sha. Comparing
    # that against a commit sha never matches, so the guard would never fire —
    # this file's own failure mode, silently.
    tag_object = "1111111111111111111111111111111111111111"
    out = f"{tag_object}\t{sp.TAG_REF}\n{SHA}\t{sp.TAG_REF}^{{}}\n"
    assert _peel(out) == SHA
    assert _peel(out) != tag_object


def test_lightweight_tag_has_no_peeled_line_and_still_resolves():
    assert _peel(f"{SHA}\t{sp.TAG_REF}\n") == SHA


def test_empty_ls_remote_means_nothing_staged():
    assert _peel("") is None


def test_ls_remote_is_ASKED_for_the_peeled_ref(monkeypatch):
    """The bug this pins was NOT in the parser — it was in the parser's INPUT.

    `ls-remote origin refs/tags/staged-promote` matches only the exact ref, so the
    peeled `^{}` line is filtered out before the parser sees it and the plain
    tag-OBJECT sha wins. The first version did exactly that: `check` fired and named
    a sha that exists nowhere in the repository. Every parser test above still
    passed. So assert the ARGUMENTS, which is where the defect actually was.
    """
    seen = {}

    class R:
        returncode, stdout, stderr = 0, "", ""

    def fake_git(*args, **kw):
        seen["args"] = args
        return R()

    monkeypatch.setattr(sp, "_git", fake_git)
    sp.remote_marker_sha("origin")
    assert sp.TAG_REF in seen["args"], "must ask for the tag ref"
    assert sp.TAG_REF + "^{}" in seen["args"], (
        "must ALSO ask for the peeled ref, or an annotated tag resolves to the tag object")


# ── the name matters ─────────────────────────────────────────────────────────────
def test_marker_name_is_outside_the_protected_tag_namespace():
    """release-tag-integrity protects refs/tags/promote-v* and refs/tags/v* against
    update AND delete. A mutable marker inside either pattern could never be
    cleared, and would burn a protected name."""
    assert sp.TAG_NAME == "staged-promote"
    assert not sp.TAG_NAME.startswith("v")
    assert not sp.TAG_NAME.startswith("promote-v")


# ── a failed read is UNKNOWN, never "nothing staged" (BUG-STAGEDMARKERFAILOPEN-001) ─
TAG_OBJECT = "1111111111111111111111111111111111111111"
ANNOTATED = f"{TAG_OBJECT}\t{sp.TAG_REF}\n{SHA}\t{sp.TAG_REF}^{{}}\n"


class _Reply:
    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode, self.stdout, self.stderr = returncode, stdout, stderr


def _fake_git(monkeypatch, ls_remote):
    """Replace sp._git. `ls_remote` is a _Reply or an exception to raise for ls-remote;
    every other git call is recorded and answered with success."""
    calls = []

    def fake(*args, **kw):
        calls.append(args)
        if args[0] == "ls-remote":
            if isinstance(ls_remote, BaseException):
                raise ls_remote
            return ls_remote
        return _Reply()

    monkeypatch.setattr(sp, "_git", fake)
    return calls


UNREADABLE = {
    "exit 128, no network": _Reply(128, "", "fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host"),
    "exit 128 with stale stdout": _Reply(128, ANNOTATED, "fatal: the remote end hung up unexpectedly"),
    "exit 1": _Reply(1, "", ""),
    "no reply in time": subprocess.TimeoutExpired(["git", "ls-remote"], 60),
    "git is not installed": FileNotFoundError("git"),
    "a page instead of refs": _Reply(0, "<html>502 Bad Gateway</html>\n", ""),
    "a ref that was not asked for": _Reply(0, f"{SHA}\trefs/heads/dev\n", ""),
    "a short sha": _Reply(0, f"{SHA[:7]}\t{sp.TAG_REF}\n", ""),
    "peeled ref without the tag": _Reply(0, f"{SHA}\t{sp.TAG_REF}^{{}}\n", ""),
}


@pytest.mark.parametrize("case", sorted(UNREADABLE))
def test_a_failed_read_raises_and_is_never_None(monkeypatch, case):
    _fake_git(monkeypatch, UNREADABLE[case])
    with pytest.raises(sp.MarkerUnreadable):
        sp.remote_marker_sha("origin")


def test_the_real_reader_answers_absent_annotated_and_lightweight(monkeypatch):
    _fake_git(monkeypatch, _Reply(0, "", ""))
    assert sp.remote_marker_sha("origin") is None, "exit 0 with nothing listed is the remote saying: no tag"
    _fake_git(monkeypatch, _Reply(0, ANNOTATED, ""))
    assert sp.remote_marker_sha("origin") == SHA
    _fake_git(monkeypatch, _Reply(0, f"{SHA}\t{sp.TAG_REF}\n", ""))
    assert sp.remote_marker_sha("origin") == SHA


def test_the_ls_remote_is_bounded(monkeypatch):
    seen = {}

    def fake(*args, **kw):
        seen.update(kw)
        return _Reply()

    monkeypatch.setattr(sp, "_git", fake)
    sp.remote_marker_sha("origin")
    assert seen.get("timeout") == sp.LS_REMOTE_TIMEOUT_S and 0 < sp.LS_REMOTE_TIMEOUT_S <= 120


@pytest.mark.parametrize("case", sorted(UNREADABLE))
def test_check_says_UNKNOWN_and_exits_2_on_a_failed_read(monkeypatch, capsys, case):
    _fake_git(monkeypatch, UNREADABLE[case])
    code = sp.main(["check"])
    out, err = capsys.readouterr()
    assert code == 2 == sp.EXIT_UNKNOWN
    assert "Safe" not in out + err and "No staged promote" not in out + err, "a failed read must never say safe"
    assert out == "" and err.startswith("UNKNOWN: could not read the staged-promote marker")
    assert "NOT safe to push to dev" in err


def test_check_still_says_safe_only_when_the_remote_answered_with_no_marker(monkeypatch, capsys):
    _fake_git(monkeypatch, _Reply(0, "", ""))
    assert sp.main(["check"]) == 0
    assert capsys.readouterr().out == "No staged promote. Safe to push to dev.\n"


def test_check_still_exits_1_when_a_marker_is_staged(monkeypatch, capsys):
    _fake_git(monkeypatch, _Reply(0, ANNOTATED, ""))
    assert sp.main(["check"]) == 1
    assert SHA in capsys.readouterr().err


def test_clear_does_not_claim_nothing_is_staged_and_deletes_nothing_on_a_failed_read(monkeypatch, capsys):
    calls = _fake_git(monkeypatch, UNREADABLE["exit 128, no network"])
    code = sp.main(["clear"])
    out, err = capsys.readouterr()
    assert code == 2 and "Nothing staged" not in out + err and "Nothing was cleared" in err
    assert [c[0] for c in calls] == ["ls-remote"], "no push and no tag delete after a failed read"


def test_stage_refuses_and_writes_nothing_when_it_cannot_see_an_existing_marker(monkeypatch, capsys):
    calls = _fake_git(monkeypatch, UNREADABLE["exit 128, no network"])
    code = sp.main(["stage", "--sha", SHA, "--version", "v9.9.9", "--by", "T1/test"])
    out, err = capsys.readouterr()
    assert code == 2 and "STAGED" not in out and "Nothing was staged" in err
    assert [c[0] for c in calls] == ["cat-file", "ls-remote"], "no tag and no push after a failed read"
    # --force replaces a marker it can SEE; it is not a way past a read that failed.
    calls = _fake_git(monkeypatch, UNREADABLE["exit 128, no network"])
    assert sp.main(["stage", "--sha", SHA, "--version", "v9.9.9", "--by", "T1/test", "--force"]) == 2
    assert [c[0] for c in calls] == ["cat-file", "ls-remote"]


# ── the same contract with the real script, real git and real local remotes ──────
SCRIPT = os.path.join(os.path.dirname(__file__), "staged-promote.py")
# A git that runs this file (a hook, `rebase -x`) exports GIT_DIR and friends; with them set, the fixture's
# `git init` and `git commit` would act on THAT repository. Same list as scripts/test_forward_undo.py.
LEAKY_GIT_ENV = ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX",
                 "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE")
GIT_ENV = {**{k: v for k, v in os.environ.items() if k not in LEAKY_GIT_ENV}, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid",
           "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.invalid",
           "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull, "GIT_TERMINAL_PROMPT": "0"}


def _g(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, env=GIT_ENV, capture_output=True, text=True, check=True).stdout.strip()


def _run(cwd, *args):
    return subprocess.run([sys.executable, SCRIPT, *args], cwd=cwd, env=GIT_ENV, capture_output=True, text=True)


@pytest.fixture
def repo(tmp_path):
    bare, work = tmp_path / "origin.git", tmp_path / "work"
    _g(tmp_path, "init", "--quiet", "--bare", str(bare))
    _g(tmp_path, "init", "--quiet", str(work))
    _g(work, "remote", "add", "origin", str(bare))
    _g(work, "commit", "--quiet", "--allow-empty", "-m", "one")
    _g(work, "push", "--quiet", "origin", "HEAD:refs/heads/dev")
    return work, bare


def test_real_git_absent_staged_cleared_and_an_unreachable_remote(repo, tmp_path):
    work, bare = repo
    head = _g(work, "rev-parse", "HEAD")

    r = _run(work, "check")
    assert (r.returncode, r.stdout) == (0, "No staged promote. Safe to push to dev.\n"), r.stderr

    r = _run(work, "stage", "--sha", head, "--version", "v9.9.9", "--by", "T1/test")
    assert r.returncode == 0, r.stderr
    r = _run(work, "check")
    assert r.returncode == 1 and head in r.stderr and "T1/test" in r.stderr

    # The remote stops answering while a marker is staged: the old code said "Safe to push to dev" here.
    gone = tmp_path / "moved-away.git"
    os.rename(bare, gone)
    for verb, says in (("check", "NOT safe to push to dev"), ("clear", "Nothing was cleared")):
        r = _run(work, verb)
        assert r.returncode == 2 and r.stdout == "", (verb, r.stdout, r.stderr)
        assert r.stderr.startswith("UNKNOWN: ") and says in r.stderr and "Safe to push" not in r.stderr
    r = _run(work, "stage", "--sha", head, "--version", "v9.9.10", "--by", "T1/other", "--force")
    assert r.returncode == 2 and "Nothing was staged" in r.stderr

    os.rename(gone, bare)
    assert _g(work, "ls-remote", "origin", sp.TAG_REF) != "", "the failed clear left the marker in place"
    r = _run(work, "clear")
    assert r.returncode == 0 and head in r.stdout, r.stderr
    assert _run(work, "check").returncode == 0


def test_bytes_that_are_not_utf8_from_git_are_UNKNOWN_not_a_traceback(repo, tmp_path):
    """A traceback exits 1, and 1 means "staged"."""
    work, _ = repo
    fake = tmp_path / "bin"
    fake.mkdir()
    (fake / "git").write_text("#!/bin/sh\nprintf 'fatal: caf\\351 unreachable\\n' >&2\nexit 128\n")
    os.chmod(fake / "git", 0o755)
    env = {**GIT_ENV, "PATH": f"{fake}{os.pathsep}{GIT_ENV.get('PATH', '')}"}
    for verb in ("check", "clear"):
        r = subprocess.run([sys.executable, SCRIPT, verb], cwd=work, env=env, capture_output=True, text=True)
        assert r.returncode == 2 and r.stderr.startswith("UNKNOWN: ") and "Traceback" not in r.stderr, r.stderr


def test_real_git_a_remote_name_that_does_not_exist_is_UNKNOWN(repo):
    work, _ = repo
    r = _run(work, "check", "--remote", "no-such-remote")
    assert r.returncode == 2 and r.stderr.startswith("UNKNOWN: ") and r.stdout == ""
