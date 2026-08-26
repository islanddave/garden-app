#!/usr/bin/env python3
"""Release-version guard — prevents a version/tag skew from reaching a promote.

WHY THIS EXISTS
---------------
v3.81.0 was promoted from a dev SHA whose package.json said 3.80.0 (and whose
releases.json[0] also said 3.80.0 — internally consistent, so the existing
vitest assertion `releases.json[0].version === package.json.version`
(src/__tests__/releaseNotes.test.js) passed). The bump had simply been omitted
from the feature commit. Nothing cross-checked the human-typed promote-gate
`snap_version` against the code being promoted, so tag v3.81.0 was consumed on
content that called itself 3.80.0, forcing a second promote as v3.81.1.
The `release-tag-integrity` ruleset now blocks tag delete/update on v* and
promote-v*, so recovery-by-retag is gone — the tag burn is permanent.

WHAT THIS FILE COVERS (and what it does NOT)
--------------------------------------------
Tier 1 (hard fail, exit 1) + Tier 2 (advisory, never fails) run inside CI on
dev. They catch shape errors, releases.json corruption, version regressions,
and a bump onto an already-consumed tag.

They do NOT catch the original failure. That skew lived between the code and
the promote-gate dispatch input, which is invisible from inside a CI run on
dev. The keystone is the Tier-3 step in .github/workflows/promote-gate.yml,
which asserts snap_version == "v" + package.json@dev_sha BEFORE main is
fast-forwarded.

WHY TIER 1.C IS CONDITIONALLY ARMED
-----------------------------------
The invariant is "a version, once promoted, is never reused" — NOT "every
commit bumps". Commits ad14213, b747648 and 00558fe all legitimately landed on
dev and shipped as one version; a rule demanding a bump per commit would be
intolerable and bypassed within a week. Also, the steady state immediately
after every promote is dev.version == main.version with tag v<version> already
existing — so an unconditionally-armed tag-collision check would be red on
every single commit until the next bump, the worst possible false-positive
profile. Therefore: the advance/tag checks arm ONLY when package.json has
moved ahead of origin/main. When it is equal, Tier 2 emits a non-blocking
reminder instead.

EXIT CODES (house convention, cf. scripts/check-coverage-ratchet.py)
  0  all armed assertions pass (an advisory may still have been printed)
  1  an assertion was violated
  2  script/input error — a required file or git/network fact was unreadable.
     Never a silent pass: an unreachable origin/main or tag list is exit 2.

Note on the asymmetry: an unparseable package.json is exit 2 (the script
cannot even obtain a version to assert on), while an unparseable
public/releases.json or public/releases-latest.json is exit 1 ("parses as a
non-empty array" / "parses as an object" are themselves assertions B and C).

Waivers: scripts/release-version-allowlist.json, consulted ONLY by the Tier-1.C
tag-collision check. There is deliberately no env-var or commit-trailer bypass.
"""
import json
import os
import re
import subprocess
import sys
from collections import namedtuple
from pathlib import Path, PurePosixPath

REPO_ROOT = Path(__file__).resolve().parent.parent
ALLOWLIST = REPO_ROOT / "scripts" / "release-version-allowlist.json"

# scripts/add-release.mjs:16 — the only writer of package.json version.
PKG_VERSION_RE = re.compile(r"^\d+\.\d+(\.\d+)?$")
# promote-gate.yml:103-105 — the only validation snap_version currently gets.
SNAP_TAG_RE = re.compile(r"^v[0-9]+(\.[0-9]+){0,2}$")

FETCH_MAIN_CMD = "git fetch --depth=1 origin +refs/heads/main:refs/remotes/origin/main"

Violation = namedtuple("Violation", "rule detail fix")


# --- pure core (no git, no network, no filesystem) ---------------------------

def parse_semver(value):
    """'3.81.1' / '3.81' -> (3, 81, 1) / (3, 81, 0). None if unparseable."""
    if not isinstance(value, str) or not PKG_VERSION_RE.match(value):
        return None
    parts = [int(p) for p in value.split(".")]
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts)


def check_shape(pkg_version):
    """A. package.json version shape. Always armed."""
    if parse_semver(pkg_version) is None:
        return [Violation(
            "package.json version shape",
            f"version {pkg_version!r} does not match ^\\d+\\.\\d+(\\.\\d+)?$",
            'set it with: node scripts/add-release.mjs <version> "<highlight>"',
        )]
    # Defence against the two regexes drifting apart: a version that add-release
    # accepts but promote-gate's snap_version regex would reject is unshippable.
    if not SNAP_TAG_RE.match("v" + pkg_version):
        return [Violation(
            "snap_version compatibility",
            f"'v{pkg_version}' fails promote-gate's ^v[0-9]+(\\.[0-9]+){{0,2}}$ "
            "— this version can never be promoted",
            'use a plain numeric version: node scripts/add-release.mjs <version> "<highlight>"',
        )]
    return []


def check_releases(releases, pkg_version):
    """B. public/releases.json integrity. Always armed.

    Load-bearing: ReleaseNotes.jsx renders slice(0, 10) of this list, and
    public/releases-latest.json is derived from [0] (check C), so a mis-ordered
    or duplicated list silently shows users the wrong release.
    """
    fix_cmd = 'rebuild the head entry with: node scripts/add-release.mjs <version> "<highlight>"'
    if not isinstance(releases, list):
        return [Violation("releases.json integrity",
                          f"public/releases.json is {type(releases).__name__}, not an array",
                          fix_cmd)]
    if not releases:
        return [Violation("releases.json integrity", "public/releases.json is empty", fix_cmd)]

    out = []
    keys = []
    for i, entry in enumerate(releases):
        if not isinstance(entry, dict):
            out.append(Violation("releases.json integrity",
                                 f"entry[{i}] is {type(entry).__name__}, not an object", fix_cmd))
            keys.append(None)
            continue
        key = parse_semver(entry.get("version"))
        keys.append(key)
        if key is None:
            out.append(Violation("releases.json integrity",
                                 f"entry[{i}] version {entry.get('version')!r} is not a semver",
                                 fix_cmd))
        highlights = entry.get("highlights")
        if not isinstance(highlights, list) or not highlights:
            out.append(Violation("releases.json integrity",
                                 f"entry[{i}] ({entry.get('version')}) has no highlights", fix_cmd))

    for i in range(len(keys) - 1):
        a, b = keys[i], keys[i + 1]
        if a is None or b is None:
            continue
        if a == b:
            out.append(Violation(
                "releases.json ordering",
                f"duplicate version {releases[i].get('version')} at entries [{i}] and [{i + 1}]",
                "remove the duplicate entry — versions must be unique",
            ))
        elif a < b:
            out.append(Violation(
                "releases.json ordering",
                f"entry[{i}] ({releases[i].get('version')}) sorts BELOW "
                f"entry[{i + 1}] ({releases[i + 1].get('version')}); the list must be "
                "strictly semver-descending (the app reads [0] as newest)",
                "re-sort newest-first; add-release.mjs prepends, it does not sort",
            ))

    head = releases[0].get("version") if isinstance(releases[0], dict) else None
    if head != pkg_version:
        out.append(Violation(
            "releases.json head vs package.json",
            f"releases.json[0].version={head!r} != package.json version={pkg_version!r}",
            f'node scripts/add-release.mjs {pkg_version} "<highlight>"',
        ))
    return out


def check_releases_latest(latest, releases):
    """C. public/releases-latest.json == public/releases.json[0]. Always armed.

    V4-PERFTHEMEA-001 split the version probe off the 141,722 B history file:
    useAppUpdate.js and useWhatsNew.js now read releases-latest.json, while
    ReleaseNotes.jsx still reads the full releases.json. That is only safe while
    the two agree — a stale -latest is a client that never learns it is out of
    date, which is BUG-STALECLIENT-002 rebuilt on purpose.

    DEEP equality, not just the version field. Both files are written in one
    step by scripts/add-release.mjs and neither is meant to be hand-edited; a
    version-only check would pass on a head entry whose date or highlights had
    been edited in one file and not the other, which is the same drift one field
    later. The complementary runtime check is scripts/smoke-prod.py, which reads
    the DEPLOYED copy — this one only proves the repo is consistent.
    """
    fix_cmd = 'regenerate BOTH: node scripts/add-release.mjs <version> "<highlight>"'
    if not isinstance(latest, dict):
        return [Violation("releases-latest.json integrity",
                          f"public/releases-latest.json is {type(latest).__name__}, not an object "
                          "(it is releases.json[0] alone, not the array)",
                          fix_cmd)]
    head = releases[0] if isinstance(releases, list) and releases else None
    if not isinstance(head, dict):
        # check_releases already reported this; nothing further to say.
        return []
    if latest != head:
        return [Violation(
            "releases-latest.json vs releases.json[0]",
            f"releases-latest.json (v{latest.get('version')!r}) differs from "
            f"releases.json[0] (v{head.get('version')!r}) — the version probe and the "
            "release-notes history would disagree about the current release",
            fix_cmd,
        )]
    return []


def next_free_version(pkg_version, tags):
    """Lowest patch bump of pkg_version whose v-tag is not already taken."""
    parsed = parse_semver(pkg_version)
    if parsed is None:
        return None
    major, minor, patch = parsed
    for _ in range(1000):
        patch += 1
        candidate = f"{major}.{minor}.{patch}"
        if f"v{candidate}" not in tags:
            return candidate
    return None


def check_vs_main(pkg_version, main_version, tags, waived=()):
    """C. package.json vs origin/main. Conditionally armed — see module docstring.

    Returns (state, violations) where state is 'equal' | 'advanced' |
    'regressed' | 'unparseable'. 'unparseable' is the caller's cue to exit 2.
    `tags` is a collection of tag NAMES ('v3.81.1'); `waived` a collection of
    waived version strings ('3.81.1').
    """
    pkg = parse_semver(pkg_version)
    main = parse_semver(main_version)
    if pkg is None or main is None:
        return "unparseable", []

    if pkg == main:
        return "equal", []

    if pkg < main:
        return "regressed", [Violation(
            "version regression vs main",
            f"package.json version {pkg_version} is BELOW origin/main {main_version}",
            f'bump forward: node scripts/add-release.mjs {main_version} "<highlight>" '
            "(or higher) — a promoted version is never walked back",
        )]

    # pkg > main: the bump is real, so the tag it implies must still be free.
    tag = "v" + pkg_version
    if tag in set(tags) and pkg_version not in set(waived):
        nxt = next_free_version(pkg_version, tags)
        return "advanced", [Violation(
            "tag collision",
            f"tag {tag} already exists — that version has already been promoted; "
            "the release-tag-integrity ruleset forbids moving or deleting it",
            f'node scripts/add-release.mjs {nxt} "<highlight>"'
            if nxt else "pick a version whose v-tag is unused",
        )]
    return "advanced", []


# --- Tier 2: release-relevance classification (advisory only) ----------------

_NON_RELEASE_EXACT = frozenset({"public/releases.json", "public/releases-latest.json"})
_NON_RELEASE_PREFIXES = ("docs/", ".github/ISSUE_TEMPLATE/")
_TEST_SUFFIXES = (".test.js", ".test.jsx", ".test.ts", ".test.tsx")


def is_release_relevant(path):
    """Relevance by EXCLUSION — anything not explicitly non-shipping counts."""
    p = (path or "").strip()
    if not p:
        return False
    if p in _NON_RELEASE_EXACT:
        return False
    if p.endswith(".md"):
        return False
    if p.startswith(_NON_RELEASE_PREFIXES):
        return False
    if p.startswith("src/"):
        if "/__tests__/" in p or p.endswith(_TEST_SUFFIXES):
            return False
    if p.startswith("scripts/") and p.endswith(".py") and PurePosixPath(p).name.startswith("test_"):
        return False
    return True


def relevant_paths(paths):
    return [p for p in (paths or []) if is_release_relevant(p)]


def build_advisory(pkg_version, changed, commits=None, commits_exact=True):
    """Tier 2 message, or None when nothing release-relevant is unreleased.

    Advisory FOREVER by construction: it encodes a convention (bump before you
    promote), and a convention that goes red on legitimate work gets bypassed.

    `commits_exact=False` marks the count as a lower bound — under the shallow
    CI clone `rev-list origin/main..HEAD` can only see the grafted history.
    """
    rel = relevant_paths(changed)
    if not rel:
        return None
    if commits:
        prefix = "" if commits_exact else "at least "
        scope = f"{prefix}{commits} unreleased commit(s) / {len(rel)} release-relevant file(s)"
    else:
        scope = f"{len(rel)} release-relevant file(s)"
    nxt = next_free_version(pkg_version, {f"v{pkg_version}"}) or "<next>"
    sample = ", ".join(rel[:5]) + (f" (+{len(rel) - 5} more)" if len(rel) > 5 else "")
    return (
        f"Unreleased work on dev with no version bump: {scope} differ from origin/main "
        f"while package.json is still {pkg_version}. As things stand the next promote's "
        f"snap_version MUST be v{pkg_version} — but tag v{pkg_version} is already consumed, "
        f"so that promote would burn a second tag. Bump before promoting: "
        f'node scripts/add-release.mjs {nxt} "<highlight>". '
        f"Changed: {sample}"
    )


# --- impure edges: filesystem + git ------------------------------------------

def _fatal2(detail, fix=None):
    print(f"FATAL: {detail}", file=sys.stderr)
    if fix:
        print(f"  Fix: {fix}", file=sys.stderr)
    sys.exit(2)


def _git(*args):
    return subprocess.run(["git", "-C", str(REPO_ROOT), *args],
                          capture_output=True, text=True)


def _git_err(res):
    """First line of git's stderr — the diagnostic one; later lines are hints."""
    for line in res.stderr.splitlines():
        if line.strip():
            return line.strip()
    return "no output"


def load_json(relpath, on_error_exit):
    path = REPO_ROOT / relpath
    try:
        raw = path.read_text()
    except OSError as exc:
        _fatal2(f"cannot read {relpath}: {exc}")
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        if on_error_exit == 2:
            _fatal2(f"{relpath} is not valid JSON: {exc}")
        print(f"FATAL: {relpath} integrity violated", file=sys.stderr)
        print(f"  {relpath} is not valid JSON: {exc}", file=sys.stderr)
        print('  Fix: node scripts/add-release.mjs <version> "<highlight>" rewrites both '
              "release files from scratch", file=sys.stderr)
        sys.exit(1)


def load_waivers():
    if not ALLOWLIST.exists():
        return []
    try:
        data = json.loads(ALLOWLIST.read_text())
    except json.JSONDecodeError as exc:
        _fatal2(f"{ALLOWLIST.name} is not valid JSON: {exc}")
    entries = data.get("waived_versions", [])
    if not isinstance(entries, list):
        _fatal2(f"{ALLOWLIST.name}: waived_versions must be an array")
    return [e.get("version") for e in entries if isinstance(e, dict) and e.get("version")]


def main_package_version():
    res = _git("show", "origin/main:package.json")
    if res.returncode != 0:
        _fatal2(
            "origin/main:package.json is unreachable — cannot compare versions "
            f"(git: {_git_err(res)})",
            FETCH_MAIN_CMD,
        )
    try:
        return json.loads(res.stdout)["version"]
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        _fatal2(f"could not read version from origin/main:package.json: {exc}")


def known_tags():
    """Local refs first, then origin. A network failure is exit 2, never a pass."""
    tags = set()
    local = _git("tag", "--list")
    if local.returncode == 0:
        tags.update(t.strip() for t in local.stdout.splitlines() if t.strip())
    # `--exit-code` returns 2 when the remote genuinely has no matching refs.
    remote = _git("ls-remote", "--exit-code", "--tags", "origin")
    if remote.returncode not in (0, 2):
        _fatal2(
            "could not list remote tags — a tag collision cannot be ruled out "
            f"(git: {_git_err(remote)})",
            "check network/credentials, then re-run: git ls-remote --tags origin",
        )
    for line in remote.stdout.splitlines():
        parts = line.split("\trefs/tags/")
        if len(parts) == 2:
            tags.add(parts[1].removesuffix("^{}").strip())
    return tags


def diff_vs_main():
    """(changed_paths, commit_count, count_is_exact). Advisory input only.

    TWO-dot on purpose. CI checks out at fetch-depth 1 and we fetch main at
    depth 1 too, so there is no merge base — `origin/main...HEAD` dies with
    "fatal: no merge base" (verified against a real shallow clone). A two-dot
    tree diff needs only the two commit objects, and for "what differs from
    what shipped" it is the more honest comparison anyway.

    The commit count DOES need history, so on a shallow clone it undercounts;
    it is returned with count_is_exact=False and phrased as a lower bound.
    """
    res = _git("diff", "--name-only", "origin/main", "HEAD")
    changed = ([p.strip() for p in res.stdout.splitlines() if p.strip()]
               if res.returncode == 0 else None)
    cnt = _git("rev-list", "--count", "origin/main..HEAD")
    commits = None
    if cnt.returncode == 0 and cnt.stdout.strip().isdigit():
        commits = int(cnt.stdout.strip()) or None
    shallow = _git("rev-parse", "--is-shallow-repository")
    exact = not (shallow.returncode == 0 and shallow.stdout.strip() == "true")
    return changed, commits, exact


def emit_advisory(message):
    print(f"::warning title=Release version not bumped::{message}")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        try:
            with open(summary, "a") as fh:
                fh.write(f"\n> **Release-version advisory** — {message}\n")
        except OSError as exc:  # advisory must never break the build
            print(f"  (could not write step summary: {exc})")


def report(violations):
    for v in violations:
        print(f"FATAL: {v.rule} violated", file=sys.stderr)
        print(f"  {v.detail}", file=sys.stderr)
        print(f"  Fix: {v.fix}", file=sys.stderr)


def main():
    pkg = load_json("package.json", on_error_exit=2)
    if not isinstance(pkg, dict):
        _fatal2("package.json is not a JSON object")
    pkg_version = pkg.get("version")

    violations = check_shape(pkg_version)
    if violations:
        report(violations)
        return 1
    print(f"OK: package.json version {pkg_version} (shape + snap_version-compatible)")

    releases = load_json("public/releases.json", on_error_exit=1)
    violations = check_releases(releases, pkg_version)
    if violations:
        report(violations)
        return 1
    print(f"OK: releases.json — {len(releases)} entries, strictly descending, head == {pkg_version}")

    latest = load_json("public/releases-latest.json", on_error_exit=1)
    violations = check_releases_latest(latest, releases)
    if violations:
        report(violations)
        return 1
    print(f"OK: releases-latest.json — matches releases.json[0] ({pkg_version})")

    main_version = main_package_version()
    main_parsed = parse_semver(main_version)
    if main_parsed is None:
        _fatal2(f"origin/main package.json version {main_version!r} is not a semver")
    # Only reach for the remote tag list when the bump is real — the equal case
    # is the common one and must not need the network.
    tags = known_tags() if parse_semver(pkg_version) > main_parsed else ()
    state, violations = check_vs_main(pkg_version, main_version, tags, load_waivers())
    if violations:
        report(violations)
        return 1

    if state == "equal":
        changed, commits, exact = diff_vs_main()
        if changed is None:
            print("NOTE: could not diff against origin/main; advisory skipped")
        else:
            advisory = build_advisory(pkg_version, changed, commits, exact)
            if advisory:
                emit_advisory(advisory)
        print(f"OK: version unchanged vs main ({pkg_version}); "
              "advance/tag checks not armed")
        return 0

    print(f"OK: version advanced {main_version} -> {pkg_version}; "
          "tag-collision check passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
