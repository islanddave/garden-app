#!/usr/bin/env python3
"""Staged-promote marker — makes "handed to Dave, awaiting his word" a visible state.

WHY THIS EXISTS
---------------
OPS-STAGEDPROMOTEINVALIDATED-001 (BD-064). On 2026-08-24 a session staged
v4.49.0 at a dev SHA, got all three CI checks green, bumped the version, and
handed that SHA to Dave to dispatch promote-gate against. Before Dave gave the
approval phrase, a DIFFERENT session pushed to dev, moving dev off the staged
SHA. The SHA Dave was holding was no longer dev head.

THE PUSHER WAS NOT NEGLIGENT. It checked for an in-flight promote and correctly
saw none — because there wasn't one. Nothing was executing, nothing was queued,
and nothing anywhere marked a SHA as "staged, do not move dev". A release
awaiting a human's word is, to every automated check that existed, entirely
indistinguishable from an idle repository.

That window is unguarded and can be arbitrarily long: it lasts exactly as long
as it takes Dave to read a message and reply. This file makes the window
observable.

WHAT IT IS
----------
One annotated tag on the origin, `refs/tags/staged-promote`, pointing at the
staged commit and carrying who/what/when in its message. Chosen over the
alternatives on purpose:

  * A tag is readable with a single `git ls-remote` — no clone, no API token, no
    GitHub Actions permission. That matters because the sessions that need to
    check it are frequently sandboxed and api.github.com is not always reachable
    (see the ship-garden.sh history), while git-over-HTTPS is.
  * It lives in the garden-app repo, so it cannot drift from the thing it
    describes, and setting it does NOT move `dev` — which would defeat the
    purpose.
  * `staged-promote` matches NEITHER pattern in the `release-tag-integrity`
    ruleset (`refs/tags/promote-v*`, `refs/tags/v*`), so it is force-updatable
    and deletable, which a mutable marker has to be. Do not rename it to
    anything starting with `v` or `promote-v` — that would make it permanent and
    unclearable, and burn a protected name.

WHAT IT IS NOT
--------------
NOT a lock. It cannot stop a push and does not try to. It converts a silent
failure into a loud one: `check` exits non-zero and prints what is staged, so a
session about to push to dev is told, and can then coordinate instead of
discovering the problem afterwards. A lock would need enforcement nobody can
apply from a sandbox, and would strand dev the moment a session died holding it
— the same failure the retired single-writer ledger role produced.

DELIBERATE STALENESS BEHAVIOUR
------------------------------
`check` reports the marker's AGE and never auto-expires it. A marker that
silently stopped mattering after N hours would recreate the exact defect this
file exists to fix, just on a timer. Clearing is an act, not a timeout:
`clear` after the promote lands, or after Dave declines.
"""
import argparse
import json
import re
import subprocess
import sys
from datetime import datetime, timezone

TAG_REF = "refs/tags/staged-promote"
TAG_NAME = "staged-promote"
FULL_SHA = re.compile(r"^[0-9a-f]{40}$")

# The tag message is a one-line human sentence followed by a JSON object. Both, on
# purpose: the sentence is what `git ls-remote`-adjacent tooling and a human see, and
# the JSON is what a machine parses. Parsing the sentence would be brittle; showing
# only JSON to a person at 2am is unkind.
_JSON_START = "---8<--- staged-promote metadata"


def parse_marker(message: str) -> dict:
    """Extract the metadata object from a tag message. Returns {} when absent.

    Tolerant by design: a marker written by an older version of this script, or
    hand-made in a hurry during an incident, must still be REPORTABLE even if it
    is not fully parseable. A check that crashes on a malformed marker is worse
    than one that says "something is staged, I can't read the details".
    """
    if not message or _JSON_START not in message:
        return {}
    blob = message.split(_JSON_START, 1)[1].strip()
    try:
        out = json.loads(blob)
        return out if isinstance(out, dict) else {}
    except (ValueError, TypeError):
        return {}


def format_marker(sha: str, version: str, by: str, when: str) -> str:
    """Build the tag message. Pure so it can be tested without a repository."""
    return (
        f"STAGED PROMOTE — {version} at {sha} is awaiting Dave's approval word.\n"
        f"Staged by {by} at {when}.\n"
        f"\n"
        f"Do not move dev off this SHA. If you must push, coordinate first: the\n"
        f"SHA Dave is holding will stop being dev head and his approval will\n"
        f"apply to a commit that is no longer current.\n"
        f"\n"
        f"Clear with: python3 scripts/staged-promote.py clear\n"
        f"{_JSON_START}\n"
        + json.dumps({"sha": sha, "version": version, "by": by, "at": when}, indent=1)
    )


def age_hours(when: str, now: datetime) -> float | None:
    """Hours since `when` (ISO-8601). None if unparseable — never a guess."""
    try:
        t = datetime.fromisoformat(when.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    return (now - t).total_seconds() / 3600.0


def _git(*args, check=True, timeout=None):
    # errors="replace": a byte git prints that is not UTF-8 (a path or a host in an error) must not
    # become a traceback, which exits 1, the code that means "staged". A replaced character in a
    # ref line fails the line check in remote_marker_sha() and reads UNKNOWN on its own.
    return subprocess.run(["git", *args], capture_output=True, text=True, errors="replace",
                          check=check, timeout=timeout)


class MarkerUnreadable(Exception):
    """The remote did not give a usable answer about the marker.

    BUG-STAGEDMARKERFAILOPEN-001. This is NOT "no marker". Until 2026-10-13 a failed
    `git ls-remote` (no network, an expired credential, a wrong remote name) and an
    absent tag both came back as None, so `check` printed "Safe to push to dev" and
    exited 0 in exactly the conditions where it knew nothing, `clear` said "Nothing
    staged" over a marker it never looked at, and `stage` skipped its "a different
    promote is already staged" refusal. A gate that cannot read says so; it never
    says safe.
    """


LS_REMOTE_TIMEOUT_S = 60
# The fetch and push after a good ls-remote are bounded too: a remote that answers the
# ls-remote and then stalls must end the verb with a verdict, not hang it.
REMOTE_TIMEOUT_S = 60
EXIT_UNKNOWN = 2


def remote_marker_sha(remote="origin") -> str | None:
    """The commit the remote marker points at, or None when the remote ANSWERED and
    has no marker. Raises MarkerUnreadable when the remote gave no usable answer.
    Uses ls-remote so this works without fetching and without a full clone."""
    # The glob is LOAD-BEARING, not tidiness. `ls-remote origin refs/tags/staged-promote`
    # matches only the exact ref and therefore returns ONLY the tag-object line; the
    # peeled `refs/tags/staged-promote^{}` line does not match the pattern and is
    # filtered out before we ever see it. The first version of this file did exactly
    # that and reported the TAG OBJECT sha as the staged commit — the guard fired, and
    # named a sha that appears nowhere in the repository. Caught by running it against
    # the real remote; the unit test covered the parser but not its input, which is the
    # whole reason parser-only coverage is not enough here.
    try:
        r = _git("ls-remote", remote, TAG_REF, TAG_REF + "^{}", check=False, timeout=LS_REMOTE_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        raise MarkerUnreadable(f"`git ls-remote {remote}` gave no reply in {LS_REMOTE_TIMEOUT_S} s")
    except OSError as exc:
        raise MarkerUnreadable(f"could not run git: {type(exc).__name__}")
    if r.returncode != 0:
        err = " ".join((r.stderr or "").split())[:200] or "no message"
        raise MarkerUnreadable(f"`git ls-remote {remote}` failed (exit {r.returncode}: {err})")
    # Exit 0 with nothing listed is the remote's own answer: the tag is not there.
    if not r.stdout.strip():
        return None
    # An ANNOTATED tag's plain line is the TAG OBJECT's sha; the peeled `<ref>^{}` line
    # carries the commit. Prefer peeled — comparing a tag-object sha against a commit
    # sha never matches, so a guard built on it would silently never fire.
    peeled, plain = None, None
    for line in r.stdout.strip().splitlines():
        sha, _, ref = line.partition("\t")
        sha, ref = sha.strip(), ref.strip()
        # Anything but the two refs asked for, each with a full sha, is not an answer
        # about the marker (a proxy's error page on stdout, a truncated reply).
        if ref not in (TAG_REF, TAG_REF + "^{}") or not FULL_SHA.match(sha):
            raise MarkerUnreadable(f"`git ls-remote {remote}` gave a line that is not the marker: {line[:80]!r}")
        if ref.endswith("^{}"):
            peeled = sha
        else:
            plain = sha
    if peeled and not plain:
        raise MarkerUnreadable(f"`git ls-remote {remote}` listed the marker's peeled ref without the marker")
    return peeled or plain


def _unknown(verb_line: str, exc: MarkerUnreadable) -> int:
    print(f"UNKNOWN: could not read the staged-promote marker: {exc}.\n"
          f"  {verb_line}\n"
          "  This is a failed read, not an absent marker. Fix the read (network, credential,\n"
          "  remote name) and run it again.", file=sys.stderr)
    return EXIT_UNKNOWN


def cmd_stage(args) -> int:
    sha = args.sha.strip().lower()
    if not FULL_SHA.match(sha):
        print(f"FATAL: --sha must be a full 40-hex commit sha, got {args.sha!r}.\n"
              "  A 7-char sha is a ref PATTERN to actions/checkout and is refused by pstate;\n"
              "  recover the full sha from CI or `git rev-parse` before staging.", file=sys.stderr)
        return 2
    if _git("cat-file", "-e", f"{sha}^{{commit}}", check=False).returncode != 0:
        print(f"FATAL: {sha} is not a commit in this repository. Fetch it first.", file=sys.stderr)
        return 2

    try:
        existing = remote_marker_sha(args.remote)
    except MarkerUnreadable as exc:
        return _unknown("Nothing was staged: a different promote may already be staged, and this "
                        "could not check.", exc)
    if existing and existing != sha and not args.force:
        print(f"REFUSING: a different promote is already staged at {existing}.\n"
              "  Two staged promotes at once is the ambiguity this marker exists to remove.\n"
              "  Clear the old one first, or pass --force if you are deliberately replacing it.",
              file=sys.stderr)
        return 1

    when = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    msg = format_marker(sha, args.version, args.by, when)
    _git("tag", "-f", "-a", TAG_NAME, sha, "-m", msg)
    try:
        push = _git("push", "--force", args.remote, f"{TAG_REF}", check=False, timeout=REMOTE_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        print(f"UNKNOWN: `git push {args.remote}` gave no reply in {REMOTE_TIMEOUT_S} s, so the marker may\n"
              "  or may not be on the remote. Run `python3 scripts/staged-promote.py check` to see.",
              file=sys.stderr)
        return EXIT_UNKNOWN
    if push.returncode != 0:
        print(f"FATAL: could not push the marker: {push.stderr.strip()}", file=sys.stderr)
        return 1
    print(f"STAGED {args.version} at {sha}\n"
          f"  Peers running `staged-promote.py check` before a dev push will now be told.\n"
          f"  Clear it once the promote lands, or if Dave declines.")
    return 0


def cmd_check(args) -> int:
    """Exit 0 when nothing is staged; exit 1 when something is; exit 2 (UNKNOWN)
    when the marker could not be read.

    Non-zero-on-staged is what lets this drop into a shell `&&` chain before a
    push without any extra plumbing. UNKNOWN is non-zero for the same reason: a
    read that failed is never "safe".
    """
    try:
        sha = remote_marker_sha(args.remote)
    except MarkerUnreadable as exc:
        return _unknown("NOT safe to push to dev on this answer: a promote may be staged.", exc)
    if not sha:
        print("No staged promote. Safe to push to dev.")
        return 0

    # A fetch that fails or stalls leaves the details unreadable; the verdict is still "staged".
    meta = {}
    try:
        fetched = _git("fetch", args.remote, "--force", f"{TAG_REF}:{TAG_REF}", check=False,
                       timeout=REMOTE_TIMEOUT_S).returncode == 0
    except subprocess.TimeoutExpired:
        fetched = False
    if fetched:
        show = _git("cat-file", "-p", TAG_NAME, check=False)
        if show.returncode == 0:
            meta = parse_marker(show.stdout)

    ver = meta.get("version", "(unknown version)")
    by = meta.get("by", "(unknown session)")
    at = meta.get("at", "")
    age = age_hours(at, datetime.now(timezone.utc)) if at else None
    age_s = f"{age:.1f}h ago" if age is not None else "at an unknown time"

    print("⚠ A PROMOTE IS STAGED AND AWAITING DAVE'S APPROVAL.\n"
          f"    version : {ver}\n"
          f"    sha     : {sha}\n"
          f"    staged  : by {by}, {age_s}\n"
          "\n"
          "  Pushing to dev now moves dev off that SHA. Dave's approval would then apply\n"
          "  to a commit that is no longer dev head, and the promote has to be re-staged.\n"
          "  Coordinate with the staging session first — see ListAgents/SendMessage.\n"
          "  If the promote already landed or Dave declined, clear it:\n"
          "    python3 scripts/staged-promote.py clear", file=sys.stderr)
    return 1


def cmd_clear(args) -> int:
    try:
        sha = remote_marker_sha(args.remote)
    except MarkerUnreadable as exc:
        return _unknown("Nothing was cleared: a marker may still be staged.", exc)
    if not sha:
        print("Nothing staged; nothing to clear.")
        return 0
    try:
        r = _git("push", args.remote, f":{TAG_REF}", check=False, timeout=REMOTE_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        print(f"UNKNOWN: `git push {args.remote}` gave no reply in {REMOTE_TIMEOUT_S} s, so the marker may\n"
              f"  still be staged (was {sha}). Run `python3 scripts/staged-promote.py check` to see.",
              file=sys.stderr)
        return EXIT_UNKNOWN
    if r.returncode != 0:
        print(f"FATAL: could not delete the marker: {r.stderr.strip()}", file=sys.stderr)
        return 1
    _git("tag", "-d", TAG_NAME, check=False)
    print(f"Cleared the staged-promote marker (was {sha}).")
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Staged-promote marker (OPS-STAGEDPROMOTEINVALIDATED-001).")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("stage", help="mark a SHA as handed to Dave and awaiting approval")
    s.add_argument("--sha", required=True, help="full 40-hex dev SHA being staged")
    s.add_argument("--version", required=True, help="e.g. v4.49.0")
    s.add_argument("--by", required=True, help="session slug doing the staging")
    s.add_argument("--force", action="store_true", help="replace a different existing marker")
    s.add_argument("--remote", default="origin")
    s.set_defaults(fn=cmd_stage)

    c = sub.add_parser("check", help="exit 1 if a promote is staged, 2 if the marker could not be read "
                                     "(run before pushing to dev)")
    c.add_argument("--remote", default="origin")
    c.set_defaults(fn=cmd_check)

    d = sub.add_parser("clear", help="remove the marker once the promote landed or was declined")
    d.add_argument("--remote", default="origin")
    d.set_defaults(fn=cmd_clear)

    args = p.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
