#!/usr/bin/env python3
"""Is it safe to push to garden-app `dev` right now? One command, run before the push.

    python3 scripts/dev-prepush-check.py --by <track>/<session-slug> [--own-run <run id>]... [--expect-dev <sha>]

WHY THIS EXISTS. Two things make a dev push harmful that nothing stops: a promote staged and awaiting Dave's word
(scripts/staged-promote.py: the push moves dev off the SHA he is holding), and a CI run on dev still going (ci.yml
cancels the run in progress on its ref, so the push throws away another session's verdict). Each had its own check,
or none, and sessions announced their pushes to each other instead. This is the one question, asked one way.

A COMMAND, NOT A HOOK. Nothing calls this for you and it stops nothing: it reads, prints a verdict and exits. It is
also not a lock: the answer is true at the moment of the read, and another session can push a second later. Pin the
push to the dev SHA printed here, so a dev that moved in between refuses the push rather than being overwritten.

SAFE only when ALL of these hold:
  1. the staged-promote marker (annotated tag refs/tags/staged-promote on the remote) is absent, or its message
     records the caller as the stager: the "by" that `staged-promote.py stage --by` wrote equals --by, character for
     character. A marker with no readable "by" (hand-made, or a lightweight tag) is held by somebody else;
  2. no run of ci.yml or ci-next.yml on branch dev is unfinished. Unfinished is any status but `completed`
     (queued, in_progress, waiting, requested, pending, and any status this file has not heard of). A cancelled run
     is completed. A run named with --own-run is the caller's own known-red or known-running run and is not counted;
  3. with --expect-dev, dev is still at that SHA.

"ON DEV" is the run's head_branch: the listing is asked for with `branch=dev` and each row's head_branch is checked
again here. A run on another branch at the same commit is not counted (this is about dev's queue, not about whether
a commit may be promoted; scripts/promote-preflight.py answers that). pull_request and pull_request_target runs are
ignored, whatever their state: a pull request FROM dev carries head_branch dev too, but it runs on the pull
request's ref and is not the verdict a promote reads. Every other event counts (push, workflow_dispatch, and any
added later). The newest 100 runs of each workflow on dev are read, one page: an unfinished run with a hundred
newer ones above it is not seen.

EXIT  0 SAFE      every read succeeded and nothing above refuses
      1 NOT SAFE  a read succeeded and names a reason; the lines say who, what, how old and what to do
      2 UNKNOWN   a read failed (network, auth, a reply that cannot be parsed) and no reason was found by the
                  others. Never SAFE: an unread marker or queue is treated as a pushing hazard
     64 usage     malformed arguments
A reason found beats a failed read: NOT SAFE is reported with the unread part listed under it. stdout is the verdict
line first (`SAFE: `, `NOT SAFE: ` or `UNKNOWN: `), then one line per reason, then `dev <sha>` as information. The
caller requires exit 0; anything else is a refusal.

READ-ONLY. It runs `git ls-remote`, `git remote get-url`, a `git fetch` that writes no ref and no FETCH_HEAD (the
marker's tag object only, into the object store), `git cat-file`, and `gh api -X GET`. It never pushes, tags,
deletes, dispatches or re-runs.

NEEDS. Python 3.10 or newer (staged-promote.py does; an older one gets UNKNOWN, not a traceback), git with read access to the remote, and the GitHub CLI `gh` logged in (`gh auth status`) for the runs
listing, the way scripts/run-status.py reads runs. The script handles no token and prints none; text taken from a
failed command has any `user:secret@` part of a URL removed before it is shown.

dev's SHA and the marker come from ONE `git ls-remote`, so they describe the same moment. The marker is NOT read
with staged-promote.py's remote_marker_sha(): that returns None both when the tag is absent and when ls-remote
failed, which is the open half of a fail-closed check. parse_marker() and age_hours() are imported from it.
"""
import argparse
import datetime
import importlib.util
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
_spec = importlib.util.spec_from_file_location("staged_promote", os.path.join(HERE, "staged-promote.py"))
staged_promote = importlib.util.module_from_spec(_spec)
try:
    _spec.loader.exec_module(staged_promote)
except Exception as _exc:  # staged-promote.py needs Python 3.10 (`float | None`); macOS's /usr/bin/python3 is 3.9
    staged_promote, IMPORT_FAILURE = None, type(_exc).__name__

SAFE, NOT_SAFE, UNKNOWN = "SAFE", "NOT SAFE", "UNKNOWN"
EXIT = {SAFE: 0, NOT_SAFE: 1, UNKNOWN: 2}
EXIT_USAGE = 64
WORKFLOWS = ("ci.yml", "ci-next.yml")
BRANCH = "dev"
DEV_REF = "refs/heads/" + BRANCH
TAG_REF = staged_promote.TAG_REF if staged_promote else "refs/tags/staged-promote"
IGNORED_EVENTS = ("pull_request", "pull_request_target")
PER_PAGE = 100
CALL_TIMEOUT_S = 30
FULL_SHA = re.compile(r"[0-9a-f]{40}")
REPO_IN_URL = re.compile(r"github\.com[:/]([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?/?$")
UTC = datetime.timezone.utc


class Unreadable(Exception):
    """A read that gave no usable answer. Carries a one-line reason with no secret in it."""


def one_line(text, limit=240):
    flat = re.sub(r"//[^/@\s]+@", "//", " ".join(str(text).split()))
    return flat if len(flat) <= limit else flat[:limit] + "..."


def safe(value):
    return re.sub(r"[^A-Za-z0-9_./-]", "?", str(value))[:60]


def _run(cmd, timeout=CALL_TIMEOUT_S):
    """The ONE place this script starts a process. (returncode, stdout, stderr), or Unreadable."""
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0")
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=ROOT, env=env)
    except subprocess.TimeoutExpired:
        raise Unreadable("`%s` gave no reply in %d s" % (" ".join(cmd[:2]), timeout))
    except OSError as exc:
        raise Unreadable("cannot run `%s` (%s)" % (cmd[0], one_line(exc)))
    return proc.returncode, proc.stdout, proc.stderr


def read_refs(remote):
    """(dev's sha, the marker's tag-object sha or None, the commit the marker points at or None), from one ls-remote.

    The peeled `^{}` ref is asked for by name: `ls-remote <remote> refs/tags/staged-promote` alone returns only the
    tag OBJECT's line for an annotated tag (the landmine recorded in staged-promote.py)."""
    code, out, err = _run(["git", "ls-remote", remote, DEV_REF, TAG_REF, TAG_REF + "^{}"])
    if code != 0:
        raise Unreadable("git ls-remote %s failed (exit %d: %s)" % (safe(remote), code, one_line(err) or "no message"))
    seen = {}
    for line in out.strip().splitlines():
        sha, _, ref = line.partition("\t")
        if not FULL_SHA.fullmatch(sha) or ref not in (DEV_REF, TAG_REF, TAG_REF + "^{}") or ref in seen:
            raise Unreadable("git ls-remote %s gave a line that is not one of the three refs asked for" % safe(remote))
        seen[ref] = sha
    if DEV_REF not in seen:
        raise Unreadable("git ls-remote %s did not list %s: the reply is not a full answer" % (safe(remote), DEV_REF))
    if TAG_REF + "^{}" in seen and TAG_REF not in seen:
        raise Unreadable("git ls-remote %s listed the marker's peeled ref without the marker" % safe(remote))
    return seen[DEV_REF], seen.get(TAG_REF), seen.get(TAG_REF + "^{}")


def read_marker_message(remote, tag_object):
    """The message of the marker's tag object. The fetch names no destination, so no local ref moves."""
    code, _, err = _run(["git", "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", remote, TAG_REF])
    if code != 0:
        raise Unreadable("git fetch of the marker failed (exit %d: %s)" % (code, one_line(err) or "no message"))
    code, out, err = _run(["git", "cat-file", "-p", tag_object])
    if code != 0:
        # The tag moved between the ls-remote and the fetch, so the object read first never arrived.
        raise Unreadable("the marker changed while it was being read (tag object %s is not here)" % tag_object[:12])
    return out


def check_marker(remote, tag_object, commit, by, now):
    """None when the marker is absent or the caller's; otherwise the reason line. Raises Unreadable."""
    if not tag_object:
        return None
    if not commit:
        return ("a staged-promote marker is on %s at %s as a lightweight tag: it has no message, so nobody can be "
                "shown to hold it. Do not push; ask Dave which session staged it." % (safe(remote), tag_object))
    meta = staged_promote.parse_marker(read_marker_message(remote, tag_object))
    holder = meta.get("by")
    if isinstance(holder, str) and holder.strip() and by and holder.strip() == by.strip():
        return None
    age = staged_promote.age_hours(meta.get("at"), now) if isinstance(meta.get("at"), str) else None
    who = "by %s" % safe(holder) if isinstance(holder, str) and holder.strip() else "by an unrecorded session"
    mine = ("you are --by %s" % safe(by)) if by else "you gave no --by"
    return ("a promote is staged and awaiting Dave's word: %s at %s, staged %s, %s (%s). Do not push: dev would "
            "move off the SHA Dave is holding. Ask the stager or Dave whether it landed or was declined; the stager "
            "clears it with `python3 scripts/staged-promote.py clear`." % (
                safe(meta.get("version", "unknown version")), commit, who,
                "%.1f h ago" % age if age is not None else "at an unreadable time", mine))


def repo_of(remote):
    code, out, _ = _run(["git", "remote", "get-url", remote])
    found = REPO_IN_URL.search(out.strip()) if code == 0 else None
    if not found:
        raise Unreadable("cannot tell the GitHub repository from remote %s: pass --repo owner/name" % safe(remote))
    return "%s/%s" % found.groups()


def gh_get(path):
    """One `gh api -X GET`, read as a JSON object. Anything else is Unreadable."""
    try:
        code, out, err = _run(["gh", "api", "-X", "GET", path])
    except Unreadable as exc:
        raise Unreadable("%s; the runs listing needs the GitHub CLI `gh`, logged in (`gh auth status`)" % exc)
    if code != 0:
        raise Unreadable("GET %s failed (gh exit %d: %s); `gh` must be logged in (`gh auth status`)" % (
            path.split("?", 1)[0], code, one_line(err) or "no message"))
    try:
        doc = json.loads(out)
    except ValueError:
        raise Unreadable("GET %s: the reply is not JSON" % path.split("?", 1)[0])
    if not isinstance(doc, dict):
        raise Unreadable("GET %s: the reply is JSON but not an object" % path.split("?", 1)[0])
    return doc


def age_of(run, now):
    try:
        when = datetime.datetime.strptime(run.get("run_started_at") or run.get("created_at"), "%Y-%m-%dT%H:%M:%SZ")
    except (TypeError, ValueError):
        return "of unreadable age"
    minutes = (now - when.replace(tzinfo=UTC)).total_seconds() / 60.0
    return "started %.0f min ago" % minutes if minutes < 120 else "started %.1f h ago" % (minutes / 60.0)


def unfinished_runs(repo, workflow):
    """The runs of `workflow` on dev that are not completed, pull_request runs left out. Raises Unreadable."""
    doc = gh_get("repos/%s/actions/workflows/%s/runs?branch=%s&per_page=%d" % (repo, workflow, BRANCH, PER_PAGE))
    runs, total = doc.get("workflow_runs"), doc.get("total_count")
    if not isinstance(runs, list) or not isinstance(total, int) or isinstance(total, bool) or total < len(runs):
        raise Unreadable("the %s runs listing has no usable workflow_runs and total_count" % workflow)
    going = []
    for run in runs:
        if not isinstance(run, dict) or not isinstance(run.get("id"), int) or isinstance(run.get("id"), bool) \
                or not isinstance(run.get("status"), str) or not isinstance(run.get("event"), str) \
                or not isinstance(run.get("head_branch"), (str, type(None))):
            raise Unreadable("a row of the %s runs listing has no id, status, event or head_branch" % workflow)
        if run["head_branch"] != BRANCH or run["event"] in IGNORED_EVENTS:
            continue
        if run["status"] != "completed":
            going.append(run)
    return going


def check_runs(repo, own_runs, now):
    """(reason lines, unreadable lines, information lines) for the two workflows' runs on dev."""
    reasons, unread, info = [], [], []
    for workflow in WORKFLOWS:
        try:
            going = unfinished_runs(repo, workflow)
        except Unreadable as exc:
            unread.append("the %s runs on %s could not be read: %s" % (workflow, BRANCH, exc))
            continue
        for run in going:
            what = "%s run %d on %s is %s (%s, %s, at %s)" % (
                workflow, run["id"], BRANCH, safe(run["status"]), safe(run["event"]), age_of(run, now),
                safe(run.get("head_sha"))[:12])
            if run["id"] in own_runs:
                info.append("not counted (--own-run): %s" % what)
            else:
                reasons.append("%s. Do not push: wait for it to finish and run this again (https://github.com/%s/"
                               "actions/runs/%d). If it is your own known run, pass --own-run %d." % (
                                   what, repo, run["id"], run["id"]))
    return reasons, unread, info


def evaluate(args, now):
    """(verdict, reason lines, unreadable lines, information lines)."""
    reasons, unread, info = [], [], []
    dev = None
    try:
        dev, tag_object, commit = read_refs(args.remote)
    except Unreadable as exc:
        unread.append("%s and the staged-promote marker could not be read: %s" % (DEV_REF, exc))
    if dev:
        info.append("dev %s (read once from %s; pin your push to it)" % (dev, safe(args.remote)))
        if args.expect_dev and args.expect_dev != dev:
            reasons.append("dev has moved: you expected %s and it is at %s. Do not push: fetch, put your work on the "
                           "new head, and start again from this check." % (args.expect_dev, dev))
        try:
            reason = check_marker(args.remote, tag_object, commit, args.by, now)
        except Unreadable as exc:
            unread.append("a staged-promote marker is on %s at %s but who holds it could not be read: %s" % (
                safe(args.remote), commit or tag_object, exc))
        else:
            if reason:
                reasons.append(reason)
            elif tag_object:
                info.append("the staged-promote marker at %s is yours (--by %s)%s" % (
                    commit, safe(args.by), "" if commit == dev else "; note dev is NOT at that SHA"))
    try:
        repo = args.repo or repo_of(args.remote)
    except Unreadable as exc:
        unread.append("the runs on %s could not be read: %s" % (BRANCH, exc))
    else:
        run_reasons, run_unread, run_info = check_runs(repo, set(args.own_run), now)
        reasons += run_reasons
        unread += run_unread
        info += run_info
    verdict = NOT_SAFE if reasons else UNKNOWN if unread else SAFE
    return verdict, reasons, unread, info


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        self.print_usage(sys.stderr)
        self.exit(EXIT_USAGE, "%s: error: %s\n" % (self.prog, message))


def pattern(regex, what):
    def check(value):
        if not re.fullmatch(regex, value):
            raise argparse.ArgumentTypeError("%s must match %s" % (what, regex))
        return value
    return check


def build_parser():
    parser = _Parser(
        description="Is it safe to push to garden-app dev right now? Read-only; a command, not a hook.",
        epilog="exit codes: 0 SAFE; 1 NOT SAFE (a reason is named); 2 UNKNOWN (a read failed: never SAFE); "
               "64 malformed arguments. Needs git read access to the remote and `gh` logged in.")
    parser.add_argument("--by", default="", metavar="TRACK/SESSION-SLUG",
                        help="who you are: the exact --by you gave `staged-promote.py stage`. A marker whose "
                             "recorded \"by\" equals it is yours; without --by any marker refuses")
    parser.add_argument("--own-run", action="append", default=[], type=int, metavar="RUN_ID",
                        help="a ci.yml or ci-next.yml run on dev that is your own known-red or known-running run "
                             "and is not to be counted (repeatable)")
    parser.add_argument("--expect-dev", metavar="SHA", type=pattern(r"[0-9a-f]{40}", "--expect-dev"),
                        help="refuse if dev is not at this full 40-hex SHA")
    parser.add_argument("--repo", metavar="OWNER/NAME", type=pattern(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", "--repo"),
                        help="the GitHub repository (default: read from the remote's URL)")
    parser.add_argument("--remote", default="origin", type=pattern(r"[A-Za-z0-9_.-]+", "--remote"),
                        help="the git remote (default: %(default)s)")
    return parser


def main(argv=None, now=None, stdout=None):
    stdout = stdout or sys.stdout
    args = build_parser().parse_args(argv)
    if staged_promote is None:
        print("%s: scripts/staged-promote.py could not be loaded (%s), so the marker cannot be read: do not push to "
              "%s. It needs Python 3.10 or newer; this is %d.%d." % (UNKNOWN, IMPORT_FAILURE, BRANCH,
                                                                     *sys.version_info[:2]), file=stdout)
        return EXIT[UNKNOWN]
    try:
        verdict, reasons, unread, info = evaluate(args, now or datetime.datetime.now(UTC))
    except Exception as exc:  # whatever it is, the caller gets a verdict line and exit 2, never a bare traceback
        verdict, reasons, unread, info = UNKNOWN, [], ["the check itself failed (%s)" % type(exc).__name__], []
    if verdict == SAFE:
        head = "no staged promote in your way and no unfinished %s run on %s" % (" or ".join(WORKFLOWS), BRANCH)
    elif verdict == NOT_SAFE:
        head = "do not push to %s (%d reason%s)" % (BRANCH, len(reasons), "" if len(reasons) == 1 else "s")
    else:
        head = "could not read everything, so this is not SAFE: do not push to %s; fix the read and run again" % BRANCH
    print("%s: %s" % (verdict, head), file=stdout)
    for line in reasons:
        print("  - %s" % line, file=stdout)
    for line in unread:
        print("  ? %s" % line, file=stdout)
    for line in info:
        print("  %s" % line, file=stdout)
    return EXIT[verdict]


if __name__ == "__main__":
    sys.exit(main())
