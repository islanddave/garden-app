#!/usr/bin/env python3
"""forward-undo.py — undo a shipped garden-app release with a normal FORWARD release.

WHY THIS EXISTS
---------------
Dave's decision, 2026-09-28 (OPS-REVERTRESTORE-001): "Undo code, keep data." A bad release is undone
by a new release that switches the change off or backs it out, pushed to dev and promoted after his
"ship it" through every normal promote gate. Nothing rewinds the database. revert-gate.yml /
revert-to.py is a different tool — it rewinds the whole database to an older snapshot — and stays an
unarmed emergency tool. Undoing the latest release that way would erase every entry made since.

This script builds that forward release on a NEW local branch in a throwaway worktree, and stops.

WHAT IT DOES
------------
1. Fetches <remote>'s dev and main, and lists its v* release tags with `git ls-remote` (snap.py makes
   one on every promote; promote-v* tags are only an older trigger path). N = the version in main's
   package.json, and tag vN must point at main's head: that is "what prod runs". --release vN is an
   interlock: it refuses unless N is still what main ships.
2. Refuses when dev is not main, because the unshipped dev commits would ship with the undo, unless
   --allow-dev-ahead; then it lists exactly those commits and builds on dev. A revert that collides
   with dev only on the release files (dev's own bump) resolves to dev's side; any other conflict
   refuses.
3. Chooses the undo from scripts/revert-floors.json in dev's tree (scripts/revert_floors.py):
   FLAG    the floor entries N's promote put in force (vPREV < since <= vN: one promote can ship
           several versions) all name a switch in undo_instead: set each `export const <FLAG> = true`
           to false. That is the ROLLBACK RUNBOOK above SCROLL_MANAGER_ENABLED in
           src/lib/featureFlags.js ("a forward flag-off build, never a revert"). N's other changes stay.
   REVERT  otherwise, `git revert` N's own commits, newest first. "N's own" = one parent path from vN
           back to the previous release tag, each merge reverted against the parent on that path
           (-m <n>). The diffs along any such path add up to exactly vPREV..vN, so nothing that
           shipped before N is touched, even where the previous tag is not on vN's first-parent line
           (5 of 68 consecutive release pairs since v4.45.0; a first-parent walk would also have
           reverted the previous release there). Refused when the revert floor in force is above
           vPREV: putting vPREV's code back is exactly what the floor forbids.
4. Keeps the history files as dev has them — public/releases.json, and scripts/revert-floors.json,
   because a floor is never removed and reverting the release that added one must not drop it — and
   bumps the version with the repo's own tool, scripts/add-release.mjs, with one plain highlight:
   "Undoes vN: ...". Default version: dev's version with the patch number raised past any tag.
5. Commits once, on the new branch.

DRY RUN is the default: steps 1-3 run read-only (git fetch's remote-tracking refs are its only write)
and the plan is printed. --write builds the branch in a throwaway `git worktree` from dev, commits,
and removes the worktree (--keep-worktree keeps it); the branch stays in this repo. On any failure it
removes both the worktree and the branch it created. It NEVER pushes, never creates or moves a tag,
never dispatches a workflow and never touches a database. The operator's next steps are printed.

EXIT CODES
  0  plan printed (dry run) or branch written (--write)
  1  refused: the reason is printed and nothing is left behind
  2  error: git, node or an input could not be read; nothing is left behind
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import revert_floors  # noqa: E402  (co-located in scripts/, stdlib only)

FLOORS_PATH = "scripts/revert-floors.json"
RELEASE_TOOL = "scripts/add-release.mjs"
RELEASES = "public/releases.json"
RELEASES_LATEST = "public/releases-latest.json"
PACKAGE = "package.json"
KEPT_FROM_DEV = (RELEASES, RELEASES_LATEST, FLOORS_PATH)  # history, never reverted
SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+$")
TAG_REF_RE = re.compile(r"^refs/tags/(v\d+\.\d+\.\d+)(\^\{\})?$")
PROTECTED_BRANCHES = ("dev", "main")


class Refused(Exception):
    """The undo cannot be built as asked. Exit 1; nothing is left behind."""


class UndoError(Exception):
    """git, node or an input could not be read. Exit 2; nothing is left behind."""


def say(msg):
    print(f"[forward-undo] {msg}", flush=True)


def git(repo, *args, ok=(0,), input=None):
    r = subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, input=input)
    if r.returncode not in ok:
        raise UndoError(f"git {' '.join(args)} exited {r.returncode}: {(r.stderr or r.stdout).strip()[:800]}")
    return r


def out(repo, *args):
    return git(repo, *args).stdout.strip()


def show(repo, commit, path):
    """A file's text at `commit`, or None when the path does not exist there."""
    if git(repo, "cat-file", "-e", f"{commit}:{path}", ok=(0, 1, 128)).returncode != 0:
        return None
    return git(repo, "show", f"{commit}:{path}").stdout


def is_ancestor(repo, a, b):
    """True when commit a is an ancestor of (or equal to) b. A commit this repo does not have cannot be
    an ancestor of b, whose whole history was fetched."""
    r = git(repo, "merge-base", "--is-ancestor", a, b, ok=(0, 1, 128))
    if r.returncode == 128:
        if git(repo, "cat-file", "-e", f"{a}^{{commit}}", ok=(0, 1, 128)).returncode != 0:
            return False
        raise UndoError(f"git merge-base --is-ancestor {a} {b}: {r.stderr.strip()[:300]}")
    return r.returncode == 0


def package_version(repo, commit):
    text = show(repo, commit, PACKAGE)
    try:
        version = json.loads(text)["version"]
        if not SEMVER_RE.match(version):
            raise ValueError(f"{version!r} is not X.Y.Z")
    except (TypeError, ValueError, KeyError) as e:
        raise UndoError(f"cannot read the version in {PACKAGE} at {commit}: {e}")
    return version


def key(v):
    return revert_floors.version_key(v)


# --- step 1: what prod runs --------------------------------------------------------------------

def fetch(repo, remote):
    git(repo, "fetch", "--quiet", "--no-tags", remote,
        f"+refs/heads/dev:refs/remotes/{remote}/dev", f"+refs/heads/main:refs/remotes/{remote}/main")


def remote_refs(repo, remote):
    """({'dev': sha, 'main': sha}, {'vX.Y.Z': commit}) as the remote reports them now. Tags are read
    from the remote, not from local tags, which can be stale or made by hand."""
    heads, direct, peeled = {}, {}, {}
    for line in out(repo, "ls-remote", remote, "refs/heads/dev", "refs/heads/main", "refs/tags/v*").splitlines():
        sha, _, ref = line.partition("\t")
        if ref in ("refs/heads/dev", "refs/heads/main"):
            heads[ref.rsplit("/", 1)[1]] = sha
            continue
        m = TAG_REF_RE.match(ref)
        if m:
            (peeled if m.group(2) else direct)[m.group(1)] = sha
    if set(heads) != {"dev", "main"}:
        raise UndoError(f"{remote} did not report both dev and main (got {sorted(heads)})")
    for name in ("dev", "main"):
        local = out(repo, "rev-parse", f"refs/remotes/{remote}/{name}^{{commit}}")
        if local != heads[name]:
            raise Refused(f"{remote}/{name} moved while this ran ({local} fetched, {heads[name]} now); re-run")
    return heads, {t: peeled.get(t, sha) for t, sha in direct.items()}


def previous_release(repo, tags, n, n_commit):
    """The highest release tag below N whose commit is a strict ancestor of vN's."""
    for t in sorted((t for t in tags if key(t) < key(n)), key=key, reverse=True):
        c = tags[t]
        if c != n_commit and is_ancestor(repo, c, n_commit):
            return t, c
    raise Refused(f"no earlier release tag is an ancestor of {n}; there is no release to go back to")


def parent_path(repo, prev_commit, n_commit):
    """[(commit, mainline or None)], newest first: one parent path from vN back to vPREV. At a merge
    the first parent that descends from vPREV (or is it) is taken, and the merge is reverted against
    it, so the path's diffs add up to exactly vPREV..vN."""
    parents = {}
    for line in out(repo, "rev-list", "--parents", f"{prev_commit}..{n_commit}").splitlines():
        shas = line.split()
        parents[shas[0]] = shas[1:]
    between = set(out(repo, "rev-list", "--ancestry-path", f"{prev_commit}..{n_commit}").split())
    path, c = [], n_commit
    while c != prev_commit:
        ps = parents.get(c)
        idx = None if ps is None else next(
            (i for i, p in enumerate(ps, 1) if p == prev_commit or p in between), None)
        if idx is None or len(path) > len(parents):
            raise UndoError(f"no parent path from {n_commit} back to {prev_commit} (stuck at {c})")
        path.append((c, idx if len(ps) > 1 else None))
        c = ps[idx - 1]
    return path


# --- step 3: which undo ------------------------------------------------------------------------

def flag_off(text, flag, where):
    """`export const <flag> = true` -> false, exactly once."""
    on = re.compile(rf"^(export const {re.escape(flag)}\s*=\s*)true\b", re.M)
    hits = len(on.findall(text))
    if hits == 1:
        return on.sub(r"\1false", text, count=1)
    if hits == 0 and len(re.findall(rf"^export const {re.escape(flag)}\s*=\s*false\b", text, re.M)) == 1:
        raise Refused(f"{flag} is already false in {where}: there is nothing to switch off")
    raise Refused(f"expected exactly one `export const {flag} = true` in {where}, found {hits}")


def choose_version(base_version, n, tags, requested=None):
    floor = max(key(base_version), key(n))
    if requested is not None:
        if not SEMVER_RE.match(requested):
            raise Refused(f"--version {requested!r} must be X.Y.Z")
        if key(requested) <= floor:
            raise Refused(f"--version {requested} must be above {'.'.join(map(str, floor))}")
        if f"v{requested}" in tags:
            raise Refused(f"--version {requested}: tag v{requested} already exists (a shipped version)")
        return requested
    major, minor, patch = floor
    patch += 1
    while f"v{major}.{minor}.{patch}" in tags:
        patch += 1
    return f"{major}.{minor}.{patch}"


def compose_note(n, prev, mode, note=None):
    prefix = f"Undoes {n}:"
    if note is not None:
        note = note.strip()
        if not note or "\n" in note:
            raise Refused("--note must be one non-empty line")
        if note.startswith("Undoes "):
            if not note.startswith(prefix + " "):
                raise Refused(f"--note starts 'Undoes' but not {prefix!r}")
            return note
        return f"{prefix} {note}"
    if mode == "flag":
        return f"{prefix} turns the change it made back off."
    return f"{prefix} the app works the way it did in {prev} again."


def build_plan(repo, remote="origin", release=None, allow_dev_ahead=False, version=None, note=None):
    fetch(repo, remote)
    heads, tags = remote_refs(repo, remote)
    main_c, dev_c = heads["main"], heads["dev"]
    n = "v" + package_version(repo, main_c)
    if release is not None:
        rel = release if release.startswith("v") else f"v{release}"
        if not revert_floors.RELEASE_RE.match(rel):
            raise Refused(f"--release {release!r} must be vX.Y.Z")
        if key(rel) != key(n):
            raise Refused(f"--release {rel}, but main ships {n} ({main_c}); undo only what prod runs")
    if n not in tags:
        raise Refused(f"main ({main_c}) calls itself {n} but {remote} has no {n} release tag: that promote "
                      "never finished (no snapshot, no tag), so there is no shipped release to undo")
    if tags[n] != main_c:
        raise Refused(f"tag {n} is {tags[n]} but main is {main_c}: main moved past its release without a "
                      "new version. Resolve that first")
    ahead = []
    if dev_c != main_c:
        if not is_ancestor(repo, main_c, dev_c):
            raise Refused(f"dev ({dev_c}) does not contain main ({main_c}); refusing")
        ahead = [line.split(" ", 1) for line in
                 out(repo, "log", "--format=%H %s", f"{main_c}..{dev_c}").splitlines()]
        if not allow_dev_ahead:
            listing = "\n".join(f"    {sha} {subj}" for sha, subj in ahead)
            raise Refused(f"dev is {len(ahead)} commit(s) ahead of main; they would ship with the undo:\n"
                          f"{listing}\n  Re-run with --allow-dev-ahead to build on dev anyway, or wait until "
                          "dev == main")
    base_c = dev_c
    floors_text = show(repo, base_c, FLOORS_PATH)
    if floors_text is None:
        raise Refused(f"{FLOORS_PATH} is missing at dev {base_c}; without it no undo can be judged safe")
    try:
        entries = revert_floors.parse(floors_text, source=f"{FLOORS_PATH} at dev {base_c}")
    except revert_floors.FloorError as e:
        raise Refused(f"the revert floor is unreadable: {e}")
    prev, prev_c = previous_release(repo, tags, n, main_c)
    in_release = int(out(repo, "rev-list", "--count", f"{prev_c}..{main_c}"))
    mine = revert_floors.entries_shipped(entries, prev, n)
    plan = {"remote": remote, "n": n, "main": main_c, "dev": dev_c, "base": base_c, "ahead": ahead,
            "prev": prev, "prev_commit": prev_c, "in_release": in_release}
    if mine and all(e["undo_instead"] for e in mine):
        flags = []
        for e in mine:
            u = e["undo_instead"]
            text = show(repo, base_c, u["file"])
            if text is None:
                raise Refused(f"{u['file']} (named by the {e['floor']} floor) is missing at dev {base_c}")
            flag_off(text, u["flag"], f"{u['file']} at dev {base_c}")
            if (u["file"], u["flag"]) not in [(f["file"], f["flag"]) for f in flags]:
                flags.append({"file": u["file"], "flag": u["flag"], "floor": e["floor"], "ledger": e["ledger"]})
        plan.update(mode="flag", flags=flags)
    else:
        gov = revert_floors.governing_entry(entries, n)
        if gov is not None and key(prev) < key(gov["floor"]):
            unswitched = [e["ledger"] for e in mine if not e["undo_instead"]]
            why = (f"{n}'s promote shipped a floor with no switch to turn off: {', '.join(unswitched)}"
                   if unswitched else f"in force since {gov['since']}")
            raise Refused(f"reverting {n}'s commits would put {prev}'s code back, below the revert floor "
                          f"{gov['floor']} ({gov['ledger']}; {why}): {gov['reason']}. Undo it with a "
                          "hand-written forward fix instead")
        plan.update(mode="revert", path=parent_path(repo, prev_c, main_c))
    for needed in (RELEASE_TOOL, RELEASES):
        if show(repo, base_c, needed) is None:
            raise Refused(f"{needed} is missing at dev {base_c}")
    plan["version"] = choose_version(package_version(repo, base_c), n, tags, version)
    plan["note"] = compose_note(n, prev, plan["mode"], note)
    return plan


def print_plan(repo, plan):
    say(f"prod runs {plan['n']}: main {plan['main']} = tag {plan['n']}")
    if plan["ahead"]:
        say(f"dev {plan['dev']} is {len(plan['ahead'])} commit(s) ahead of main. These unshipped commits "
            "would ship with the undo:")
        for sha, subj in plan["ahead"]:
            print(f"    {sha} {subj}")
    else:
        say("dev = main: nothing unshipped rides along")
    say(f"previous release: {plan['prev']} ({plan['prev_commit']}); {plan['in_release']} commit(s) shipped in "
        f"{plan['n']}")
    if plan["mode"] == "flag":
        for f in plan["flags"]:
            say(f"undo = FLAG OFF: {f['flag']} true -> false in {f['file']} (floor {f['floor']}, {f['ledger']})")
        say(f"the {plan['in_release']} commit(s) of {plan['n']} otherwise stay; only the switch changes")
    else:
        say(f"undo = REVERT {len(plan['path'])} commit(s), newest first, along one parent path from "
            f"{plan['n']} to {plan['prev']}:")
        for c, m in plan["path"]:
            subj = out(repo, "log", "-1", "--format=%s", c)
            print(f"    {c}" + (f" (merge, against parent {m})" if m else "") + f" {subj}")
    say(f"new release {plan['version']}: \"{plan['note']}\"")


def next_steps(repo, plan, branch, head):
    sha = head or "<the branch's head SHA>"
    return "\n".join([
        "Next steps (this script does none of them):",
        "  1. python3 scripts/staged-promote.py check      # exit 0 = no other release is staged",
        f"  2. git -C {repo} push {plan['remote']} {branch}:dev      # fast-forwards dev; CI starts on {sha}",
        f"  3. wait for CI on that exact SHA: gh run list --commit {sha} --json name,status,conclusion",
        "  4. ask Dave for \"ship it\"; nothing ships before he says it",
        f"  5. then promote as usual: promote-gate.yml with dev_sha={sha} and snap_version=v{plan['version']}",
    ])


# --- --write -----------------------------------------------------------------------------------

def _commit_message(repo, plan):
    n, prev = plan["n"], plan["prev"]
    lines = []
    if plan["mode"] == "flag":
        names = ", ".join(f["flag"] for f in plan["flags"])
        lines.append(f"revert(release): undo {n} as v{plan['version']} ({names} off)")
        lines += ["", f"Undoes {n} with a forward release (Dave 2026-09-28: \"undo code, keep data\"). No",
                  "database is touched; it ships through the normal promote after \"ship it\".", ""]
        for f in plan["flags"]:
            lines.append(f"Switch off: {f['flag']} = false in {f['file']} (floor {f['floor']}, {f['ledger']}).")
        lines.append(f"The other changes that shipped in {n} stay ({plan['in_release']} commits since {prev}).")
    else:
        lines.append(f"revert(release): undo {n} as v{plan['version']} (back out {prev}..{n})")
        lines += ["", f"Undoes {n} with a forward release (Dave 2026-09-28: \"undo code, keep data\"). No",
                  "database is touched; it ships through the normal promote after \"ship it\".", "",
                  f"Reverted, newest first, along one parent path from {n} to {prev}:"]
        for c, m in plan["path"]:
            subj = out(repo, "log", "-1", "--format=%s", c)
            lines.append(f"  {c}" + (f" (merge, against parent {m})" if m else "") + f" {subj}")
        if plan["base"] == plan["main"]:
            lines.append(f"The tree is {prev}'s apart from {PACKAGE}'s version and the files kept from dev.")
    lines += ["", f"Release: {plan['version']} via {RELEASE_TOOL}: \"{plan['note']}\"",
              f"Kept as dev has them: {RELEASES} (plus the new entry) and {FLOORS_PATH} (a floor is",
              "never removed).", "",
              f"Built by scripts/forward-undo.py on dev {plan['base']}"
              + (" (= main)." if plan["base"] == plan["main"] else f" ({len(plan['ahead'])} ahead of main)."),
              "Not pushed."]
    return "\n".join(lines) + "\n"


def _verify_release_files(wt, repo, plan):
    base_rel = json.loads(show(repo, plan["base"], RELEASES))
    with open(os.path.join(wt, PACKAGE), encoding="utf-8") as fh:
        pkg = json.load(fh)
    with open(os.path.join(wt, RELEASES), encoding="utf-8") as fh:
        rel = json.load(fh)
    with open(os.path.join(wt, RELEASES_LATEST), encoding="utf-8") as fh:
        latest = json.load(fh)
    problems = []
    if pkg.get("version") != plan["version"]:
        problems.append(f"{PACKAGE} version {pkg.get('version')!r}")
    if not rel or rel[0].get("version") != plan["version"] or rel[0].get("highlights") != [plan["note"]]:
        problems.append(f"{RELEASES}[0] = {rel[0] if rel else None!r}")
    if rel[1:] != base_rel:
        problems.append(f"{RELEASES} lost or changed history ({len(rel) - 1} kept of {len(base_rel)})")
    if latest != (rel[0] if rel else None):
        problems.append(f"{RELEASES_LATEST} != {RELEASES}[0]")
    floors = None
    if os.path.exists(os.path.join(wt, FLOORS_PATH)):
        with open(os.path.join(wt, FLOORS_PATH), encoding="utf-8") as fh:
            floors = fh.read()
    if floors != show(repo, plan["base"], FLOORS_PATH):
        problems.append(f"{FLOORS_PATH} is not dev's")
    if plan["mode"] == "revert" and plan["base"] == plan["main"]:
        prev_pkg = json.loads(show(repo, plan["prev_commit"], PACKAGE))
        if {k: v for k, v in pkg.items() if k != "version"} != {k: v for k, v in prev_pkg.items() if k != "version"}:
            problems.append(f"{PACKAGE} differs from {plan['prev']}'s beyond the version")
    if problems:
        raise UndoError("the release files are not what the undo needs: " + "; ".join(problems))


def _resolve_release_conflicts(wt, plan, c, r):
    """Only with dev ahead of main can a revert conflict (on main itself the path's reverts apply
    cleanly by construction), and the usual collision is dev's own bump: package.json's version and the
    head of the release files. Those are re-derived anyway — kept from dev, then add-release — so such
    a conflict resolves to dev's side. package.json resolves only when the reverted commit changed
    nothing in it but the version. Any other conflict refuses."""
    conflicted = set(filter(None, out(wt, "diff", "--name-only", "--diff-filter=U").split("\n")))
    code = conflicted - set(KEPT_FROM_DEV) - {PACKAGE}
    if not conflicted or code:
        raise Refused(f"reverting {c} conflicts on dev {plan['base']} in {sorted(code) or 'no file git names'}: "
                      f"{(r.stdout + r.stderr).strip()[:400]}. Build this undo by hand")
    for f in sorted(conflicted & set(KEPT_FROM_DEV)):
        git(wt, "checkout", plan["base"], "--", f)
    if PACKAGE in conflicted:
        reverted, target = (json.loads(git(wt, "show", f":{n}:{PACKAGE}").stdout) for n in (1, 3))
        if {k: v for k, v in reverted.items() if k != "version"} != {k: v for k, v in target.items() if k != "version"}:
            raise Refused(f"reverting {c} changes {PACKAGE} beyond its version, and dev changed it too. "
                          "Build this undo by hand")
        git(wt, "checkout", "--ours", "--", PACKAGE)
        git(wt, "add", "--", PACKAGE)


def write_branch(repo, plan, branch=None, keep_worktree=False):
    branch = branch or f"undo-{plan['n']}-as-v{plan['version']}"
    if branch in PROTECTED_BRANCHES or git(repo, "check-ref-format", "--branch", branch, ok=(0, 1, 128)).returncode:
        raise Refused(f"{branch!r} cannot be the undo branch")
    if git(repo, "show-ref", "--verify", "--quiet", f"refs/heads/{branch}", ok=(0, 1)).returncode == 0:
        raise Refused(f"branch {branch} already exists; delete it or pass --branch")
    if shutil.which("node") is None:
        raise UndoError(f"node is not on PATH; {RELEASE_TOOL} needs it")
    tmp = tempfile.mkdtemp(prefix=f"forward-undo-{plan['n']}-")
    wt = os.path.join(tmp, "worktree")
    created = done = False
    try:
        created = True  # from here on the branch may exist, and it did not before: cleanup owns it
        git(repo, "worktree", "add", "--quiet", "-b", branch, wt, plan["base"])
        if plan["mode"] == "flag":
            touched = {PACKAGE, RELEASES, RELEASES_LATEST}
            for f in plan["flags"]:
                path = os.path.join(wt, f["file"])
                with open(path, encoding="utf-8") as fh:
                    text = fh.read()
                with open(path, "w", encoding="utf-8") as fh:
                    fh.write(flag_off(text, f["flag"], f["file"]))
                touched.add(f["file"])
        else:
            for c, m in plan["path"]:
                r = git(wt, "revert", "--no-commit", *(["-m", str(m)] if m else []), c, ok=(0, 1))
                if r.returncode:
                    _resolve_release_conflicts(wt, plan, c, r)
            if plan["base"] == plan["main"] and git(wt, "diff", "--cached", "--quiet", plan["prev_commit"],
                                                    ok=(0, 1)).returncode:
                raise UndoError(f"after the reverts the tree is not {plan['prev']}'s; refusing to commit it")
            for f in KEPT_FROM_DEV:
                if show(repo, plan["base"], f) is not None:
                    git(wt, "checkout", plan["base"], "--", f)
            touched = set(out(repo, "diff", "--name-only", "--no-renames", plan["prev_commit"], plan["main"]).split("\n"))
            touched |= {PACKAGE, RELEASES, RELEASES_LATEST}
        r = subprocess.run(["node", RELEASE_TOOL, plan["version"], plan["note"]], cwd=wt,
                           capture_output=True, text=True)
        if r.returncode:
            raise UndoError(f"{RELEASE_TOOL} exited {r.returncode}: {(r.stderr or r.stdout).strip()[:600]}")
        _verify_release_files(wt, repo, plan)
        git(wt, "add", "-A")
        staged = set(filter(None, out(wt, "diff", "--cached", "--name-only", "--no-renames", plan["base"]).split("\n")))
        if PACKAGE not in staged or not staged <= touched:
            raise UndoError(f"unexpected staged files: {sorted(staged - touched) or 'no ' + PACKAGE}")
        git(wt, "commit", "--quiet", "-F", "-", input=_commit_message(repo, plan))
        head = out(wt, "rev-parse", "HEAD")
        if out(wt, "rev-parse", "HEAD^") != plan["base"]:
            raise UndoError("the undo commit's parent is not dev's head")
        done = True
        return branch, head, (wt if keep_worktree else None)
    finally:
        if created and (not done or not keep_worktree):
            git(repo, "worktree", "remove", "--force", wt, ok=(0, 1, 128))
        if created and not done:
            git(repo, "branch", "-D", branch, ok=(0, 1))
        if not (done and keep_worktree):
            shutil.rmtree(tmp, ignore_errors=True)


def main(argv=None):
    p = argparse.ArgumentParser(description="Build a forward release that undoes the release prod runs. "
                                            "Dry run unless --write; never pushes, tags or dispatches.")
    p.add_argument("--release", help="the release to undo, vX.Y.Z; refuses unless main ships it (default: "
                                     "whatever main ships)")
    p.add_argument("--note", help="the plain-language rest of the release note after 'Undoes vN:'")
    p.add_argument("--version", help="the undo's version X.Y.Z (default: dev's version, patch + 1, past any tag)")
    p.add_argument("--allow-dev-ahead", action="store_true",
                   help="build on dev even though it carries unshipped commits (they are listed)")
    p.add_argument("--write", action="store_true", help="create the branch and commit (local only)")
    p.add_argument("--branch", help="name for the new branch (default undo-vN-as-vNEW)")
    p.add_argument("--keep-worktree", action="store_true", help="keep the throwaway worktree after --write")
    p.add_argument("--remote", default="origin")
    p.add_argument("--repo", help="the git repository (default: the one holding this script)")
    a = p.parse_args(argv)
    try:
        repo = os.path.abspath(a.repo) if a.repo else out(HERE, "rev-parse", "--show-toplevel")
        plan = build_plan(repo, a.remote, a.release, a.allow_dev_ahead, a.version, a.note)
        print_plan(repo, plan)
        if not a.write:
            branch = a.branch or f"undo-{plan['n']}-as-v{plan['version']}"
            if plan["ahead"]:
                say("with dev ahead of main, a revert conflict can only show up under --write")
            say(f"DRY RUN: nothing written. --write builds branch {branch} in a throwaway worktree.")
            print(next_steps(repo, plan, branch, None))
            return 0
        branch, head, kept = write_branch(repo, plan, a.branch, a.keep_worktree)
        say(f"WROTE branch {branch} at {head} (parent {plan['base']}); local only, not pushed")
        if kept:
            say(f"worktree kept at {kept}; remove it with: git -C {repo} worktree remove {kept}")
        print(next_steps(repo, plan, branch, head))
        return 0
    except Refused as e:
        print(f"[forward-undo] REFUSED: {e}", file=sys.stderr)
        return 1
    except (UndoError, revert_floors.FloorError) as e:
        print(f"[forward-undo] ERROR: {e}", file=sys.stderr)
        return 2
    except Exception as e:  # noqa: BLE001 — never exit 1 (= refused) on a crash
        print(f"[forward-undo] ERROR (unexpected): {type(e).__name__}: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
