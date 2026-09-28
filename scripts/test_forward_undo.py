#!/usr/bin/env python3
"""Tests for scripts/forward-undo.py (OPS-REVERTRESTORE-001 A2) against throwaway git repositories:
a local bare "origin" and a working clone, no network. The real scripts/add-release.mjs runs inside
them, so node is required (the CI pytest step uses the runner image's node). Every scenario checks the
bare origin's refs afterwards: the script never pushes, tags or dispatches anything."""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "forward-undo.py")
ADD_RELEASE = os.path.join(HERE, "add-release.mjs")
NODE = shutil.which("node")


def _load():
    spec = importlib.util.spec_from_file_location("forward_undo", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


fu = _load()

LEAKY_GIT_ENV = ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
                 "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE")
RELEASE_FILES = {"package.json", "public/releases.json", "public/releases-latest.json"}


@pytest.fixture(autouse=True)
def scratch(monkeypatch, tmp_path):
    """No user or system git config (signing, hooks, credential helpers), a fixed identity, no leaked
    GIT_DIR, and the script's throwaway worktrees under this test's own directory -> that directory."""
    for k in LEAKY_GIT_ENV:
        monkeypatch.delenv(k, raising=False)
    cfg = tmp_path / "gitconfig"
    cfg.write_text("")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(cfg))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    for who in ("AUTHOR", "COMMITTER"):
        monkeypatch.setenv(f"GIT_{who}_NAME", "Test Operator")
        monkeypatch.setenv(f"GIT_{who}_EMAIL", "operator@example.invalid")
    d = tmp_path / "scratch"
    d.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(d))
    monkeypatch.setenv("TMPDIR", str(d))
    return str(d)


def g(repo, *args):
    r = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True)
    if r.returncode:
        raise AssertionError(f"git {' '.join(args)} failed: {r.stderr}")
    return r.stdout


def refs(repo):
    return set(g(repo, "for-each-ref", "--format=%(refname) %(objectname)").splitlines())


class World:
    """origin.git (bare) and work (its clone). ship() tags HEAD the way snap.py does (annotated vX.Y.Z)
    and pushes main, dev and the tag: the HARNESS pushes; the script under test never may."""

    def __init__(self, tmp):
        assert NODE, "node is required: forward-undo.py bumps the version with scripts/add-release.mjs"
        os.makedirs(tmp, exist_ok=True)
        self.bare = str(tmp / "origin.git")
        self.work = str(tmp / "work")
        g(tmp, "init", "--quiet", "--bare", "-b", "main", self.bare)
        g(tmp, "init", "--quiet", "-b", "main", self.work)
        g(self.work, "remote", "add", "origin", self.bare)
        os.makedirs(os.path.join(self.work, "scripts"))
        os.makedirs(os.path.join(self.work, "public"))  # add-release writes into it, never creates it
        shutil.copy(ADD_RELEASE, os.path.join(self.work, "scripts", "add-release.mjs"))
        self.write("package.json", json.dumps({"name": "garden-app", "private": True, "version": "1.0.0"},
                                              indent=2) + "\n")
        self.floors([{"floor": "v0.1.0", "since": "v0.1.0", "reason": "fixture floor, always in force",
                      "ledger": "OPS-FIXTURE-001", "undo_instead": None}])
        self.write("src/app.js", "export const app = 1\n")
        self.write("src/old.js", "export const old = 1\n")
        self.release("1.0.0", "First release")
        self.ship("v1.0.0")

    def write(self, rel, text):
        path = os.path.join(self.work, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)

    def floors(self, entries):
        self.write("scripts/revert-floors.json", json.dumps({"floors": entries}, indent=2) + "\n")

    def add_floor(self, entry):
        with open(os.path.join(self.work, "scripts/revert-floors.json"), encoding="utf-8") as fh:
            entries = json.load(fh)["floors"]
        self.floors([entry] + entries)

    def rm(self, rel):
        g(self.work, "rm", "-q", rel)

    def commit(self, msg):
        g(self.work, "add", "-A")
        g(self.work, "commit", "-q", "-m", msg)
        return self.sha()

    def release(self, version, note):
        r = subprocess.run(["node", "scripts/add-release.mjs", version, note], cwd=self.work,
                           capture_output=True, text=True)
        assert r.returncode == 0, r.stderr
        return self.commit(f"chore(release): v{version}")

    def sha(self, ref="HEAD"):
        return g(self.work, "rev-parse", f"{ref}^{{commit}}").strip()

    def show(self, ref, rel):
        return g(self.work, "show", f"{ref}:{rel}")

    def exists(self, ref, rel):
        return subprocess.run(["git", "-C", self.work, "cat-file", "-e", f"{ref}:{rel}"]).returncode == 0

    def ship(self, tag):
        g(self.work, "tag", "-a", tag, "-m", f"snap {tag}")
        g(self.work, "push", "-q", "origin", "HEAD:refs/heads/main", "HEAD:refs/heads/dev", f"refs/tags/{tag}")

    def push_dev(self):
        g(self.work, "push", "-q", "origin", "HEAD:refs/heads/dev")

    def changed(self, a, b):
        return set(g(self.work, "diff", "--name-only", a, b).split())


def state(w, scratch):
    return {"bare": refs(w.bare), "work": refs(w.work), "head": w.sha(),
            "worktrees": g(w.work, "worktree", "list", "--porcelain"),
            "status": g(w.work, "status", "--porcelain", "--ignored"), "scratch": sorted(os.listdir(scratch))}


def undo(capsys, w, *args):
    code = fu.main(["--repo", w.work, *args])
    cap = capsys.readouterr()
    return code, cap.out, cap.err


def assert_only_new_branch(w, before, branch):
    """After --write: origin untouched, and locally exactly one new ref, the branch; no tag, no worktree."""
    after = state_refs = refs(w.work)
    assert refs(w.bare) == before["bare"], "the bare origin changed: something was pushed"
    assert before["work"] <= after
    assert after - before["work"] == {f"refs/heads/{branch} {w.sha(branch)}"}, state_refs - before["work"]
    assert g(w.work, "worktree", "list", "--porcelain") == before["worktrees"]


# --- scenarios -----------------------------------------------------------------------------------

def ship_flagged(w, flag_value="true"):
    """v1.1.0: the scroll-manager shape — a switch, its floor entry with undo_instead, and another
    change in the same release."""
    w.write("src/lib/featureFlags.js", "// ROLLBACK RUNBOOK: set this to false and promote\n"
            f"export const SCROLL_MANAGER_ENABLED = {flag_value}\nexport const OTHER_ENABLED = true\n")
    w.add_floor({"floor": "v1.1.0", "since": "v1.1.0", "reason": "scroll manager", "ledger": "BUG-FIXTURE-001",
                 "undo_instead": {"flag": "SCROLL_MANAGER_ENABLED", "file": "src/lib/featureFlags.js"}})
    w.commit("feat(scroll): the page-scroll manager behind SCROLL_MANAGER_ENABLED")
    w.write("src/other.js", "export const other = 2\n")
    w.commit("feat: something else in the same release")
    w.release("1.1.0", "Pages open at the top")
    w.ship("v1.1.0")


def ship_plain(w, version="1.1.0"):
    """A release that modifies, adds and deletes files."""
    w.write("src/app.js", "export const app = 2\n")
    w.write("src/new.js", "export const fresh = 1\n")
    w.rm("src/old.js")
    w.commit(f"feat: app 2, new.js, old.js gone ({version})")
    w.release(version, "Plain changes")
    w.ship(f"v{version}")


# --- the flag path -------------------------------------------------------------------------------

def test_flag_path_dry_run_plans_the_switch_and_writes_nothing(tmp_path, scratch, capsys):
    w = World(tmp_path)
    ship_flagged(w)
    before = state(w, scratch)
    code, out, err = undo(capsys, w)
    assert code == 0, err
    assert "prod runs v1.1.0" in out and "dev = main" in out
    assert "undo = FLAG OFF: SCROLL_MANAGER_ENABLED true -> false in src/lib/featureFlags.js" in out
    assert 'new release 1.1.1: "Undoes v1.1.0: turns the change it made back off."' in out
    assert "DRY RUN: nothing written" in out
    assert "python3 scripts/staged-promote.py check" in out and "undo-v1.1.0-as-v1.1.1:dev" in out
    assert state(w, scratch) == before


def test_flag_path_write_switches_off_bumps_and_pushes_nothing(tmp_path, scratch, capsys):
    w = World(tmp_path)
    ship_flagged(w)
    v110 = w.sha()
    before = state(w, scratch)
    code, out, err = undo(capsys, w, "--write", "--note", "pages scroll the way they did before.")
    assert code == 0, err
    branch = "undo-v1.1.0-as-v1.1.1"
    head = w.sha(branch)
    assert f"WROTE branch {branch} at {head} (parent {v110})" in out and len(head) == 40
    assert w.sha(f"{branch}^") == v110
    assert w.changed(v110, branch) == RELEASE_FILES | {"src/lib/featureFlags.js"}
    flags = w.show(branch, "src/lib/featureFlags.js")
    assert "export const SCROLL_MANAGER_ENABLED = false\n" in flags and "export const OTHER_ENABLED = true\n" in flags
    assert json.loads(w.show(branch, "package.json"))["version"] == "1.1.1"
    rel = json.loads(w.show(branch, "public/releases.json"))
    assert rel[0]["version"] == "1.1.1"
    assert rel[0]["highlights"] == ["Undoes v1.1.0: pages scroll the way they did before."]
    assert rel[1:] == json.loads(w.show(v110, "public/releases.json"))
    assert json.loads(w.show(branch, "public/releases-latest.json")) == rel[0]
    msg = g(w.work, "log", "-1", "--format=%B", branch)
    assert msg.startswith("revert(release): undo v1.1.0 as v1.1.1 (SCROLL_MANAGER_ENABLED off)") and "Not pushed." in msg
    assert f"dev_sha={head}" in out and "snap_version=v1.1.1" in out
    assert_only_new_branch(w, before, branch)
    assert os.listdir(scratch) == []  # the throwaway worktree is gone


def test_a_promote_that_carried_the_flagged_version_untagged_still_takes_the_flag_path(tmp_path, capsys):
    """v4.156.0's promote carried v4.154.0 and v4.155.0 untagged. A floor put in force by a version
    between the previous tag and N counts as N's."""
    w = World(tmp_path)
    w.write("src/lib/featureFlags.js", "export const SCROLL_MANAGER_ENABLED = true\n")
    w.add_floor({"floor": "v1.1.0", "since": "v1.1.0", "reason": "scroll manager", "ledger": "BUG-FIXTURE-001",
                 "undo_instead": {"flag": "SCROLL_MANAGER_ENABLED", "file": "src/lib/featureFlags.js"}})
    w.commit("feat(scroll): manager")
    w.release("1.1.0", "Scroll")          # never tagged: it ships inside v1.2.0's promote
    w.write("src/other.js", "export const other = 1\n")
    w.commit("feat: other")
    w.release("1.2.0", "Other")
    w.ship("v1.2.0")
    code, out, err = undo(capsys, w)
    assert code == 0, err
    assert "undo = FLAG OFF: SCROLL_MANAGER_ENABLED" in out and "previous release: v1.0.0" in out


def test_a_switch_that_is_already_off_refuses(tmp_path, scratch, capsys):
    w = World(tmp_path)
    ship_flagged(w, flag_value="false")
    before = state(w, scratch)
    code, out, err = undo(capsys, w, "--write")
    assert code == 1 and "SCROLL_MANAGER_ENABLED is already false" in err
    assert state(w, scratch) == before


# --- the revert path -----------------------------------------------------------------------------

def test_revert_path_backs_out_a_release_with_a_merge(tmp_path, scratch, capsys):
    w = World(tmp_path)
    ship_plain(w, "1.1.0")
    v110 = w.sha()
    g(w.work, "checkout", "-q", "-b", "lane")
    w.write("src/lane.js", "lane 1\n")
    w.commit("feat: lane part 1")
    w.write("src/lane.js", "lane 2\n")
    w.commit("feat: lane part 2")
    g(w.work, "checkout", "-q", "main")
    w.write("src/app.js", "export const app = 3\n")
    w.rm("src/new.js")
    app3 = w.commit("feat: app 3, new.js gone")
    g(w.work, "merge", "-q", "--no-ff", "-m", "merge lane", "lane")
    merge = w.sha()
    rel = w.release("1.2.0", "Lane things")
    w.ship("v1.2.0")
    plan = fu.build_plan(w.work)
    # the lane commits are not reverted one by one: the merge, against dev's side, carries them
    assert plan["mode"] == "revert" and plan["prev"] == "v1.1.0"
    assert plan["path"] == [(rel, None), (merge, 1), (app3, None)]
    before = state(w, scratch)
    code, out, err = undo(capsys, w, "--write")
    assert code == 0, err
    branch = "undo-v1.2.0-as-v1.2.1"
    assert f"{merge} (merge, against parent 1) merge lane" in out
    assert w.changed(v110, branch) == RELEASE_FILES   # the code is v1.1.0's again
    assert json.loads(w.show(branch, "package.json"))["version"] == "1.2.1"
    rel_list = json.loads(w.show(branch, "public/releases.json"))
    assert [r["version"] for r in rel_list] == ["1.2.1", "1.2.0", "1.1.0", "1.0.0"]
    assert rel_list[0]["highlights"] == ["Undoes v1.2.0: backs out 1.2.0, so the app works the way it did in v1.1.0 again."]
    msg = g(w.work, "log", "-1", "--format=%B", branch)
    assert f"  {merge} (merge, against parent 1) merge lane" in msg
    assert_only_new_branch(w, before, branch)
    assert os.listdir(scratch) == []


def test_revert_path_when_the_previous_release_is_a_merges_second_parent(tmp_path, capsys):
    """5 of 68 release pairs since v4.45.0 look like this: a lane merged dev INTO itself and dev then
    fast-forwarded to the lane, so vPREV is the merge's SECOND parent and the lane's older commits sit
    on vN's first-parent line. A first-parent walk would revert those AND, through the merge, vPREV's
    own changes. The parent path reverts the merge against vPREV instead."""
    w = World(tmp_path)
    g(w.work, "checkout", "-q", "-b", "lane")
    w.write("src/lane.js", "lane 1\n")
    l1 = w.commit("feat: lane part 1")
    g(w.work, "checkout", "-q", "main")
    w.write("src/b.js", "b\n")
    w.commit("feat: b")
    w.release("1.1.0", "B")
    w.ship("v1.1.0")
    v110 = w.sha()
    g(w.work, "checkout", "-q", "lane")
    g(w.work, "merge", "-q", "--no-ff", "-m", "merge main (v1.1.0) into lane", "main")
    merge = w.sha()
    w.write("src/lane.js", "lane 2\n")
    l2 = w.commit("feat: lane part 2")
    rel = w.release("1.2.0", "Lane")
    w.ship("v1.2.0")
    # the fixture really has that shape
    assert l1 in g(w.work, "rev-list", "--first-parent", "v1.1.0..v1.2.0").split()
    assert w.sha(f"{merge}^2") == v110
    plan = fu.build_plan(w.work)
    assert plan["path"] == [(rel, None), (l2, None), (merge, 2)]
    code, out, err = undo(capsys, w, "--write")
    assert code == 0, err
    branch = "undo-v1.2.0-as-v1.2.1"
    assert w.changed(v110, branch) == RELEASE_FILES
    assert w.show(branch, "src/b.js") == "b\n"          # v1.1.0's own change survives
    assert not w.exists(branch, "src/lane.js")           # v1.2.0's is gone


def test_the_floor_file_is_never_reverted(tmp_path, capsys):
    """A release that added a floor entry (here one that does not block this revert: floor v1.0.0,
    in force from v1.1.0) is backed out, but the entry stays: a floor is never removed."""
    w = World(tmp_path)
    w.add_floor({"floor": "v1.0.0", "since": "v1.1.0", "reason": "a CHECK armed in v1.1.0",
                 "ledger": "OPS-FIXTURE-002", "undo_instead": None})
    w.write("src/app.js", "export const app = 2\n")
    w.commit("feat: app 2 and a floor")
    w.release("1.1.0", "Two")
    w.ship("v1.1.0")
    v110, v100 = w.sha(), w.sha("v1.0.0")
    code, out, err = undo(capsys, w, "--write")
    assert code == 0, err
    branch = "undo-v1.1.0-as-v1.1.1"
    assert w.show(branch, "src/app.js") == "export const app = 1\n"
    assert w.show(branch, "scripts/revert-floors.json") == w.show(v110, "scripts/revert-floors.json")
    assert w.changed(v100, branch) == RELEASE_FILES | {"scripts/revert-floors.json"}


FLOORLESS = "# stand-in for revert-to.py before the floor\ndef run(cfg):\n    return 'rewind'\n"
WITH_FLOOR = ("# stand-in for revert-to.py WITH the A1 floor check\nimport revert_floors\n"
              "def run(cfg):\n    require_target_above_floor(cfg)\n    return 'rewind'\n")
TOOLS = ("scripts/forward-undo.py", "scripts/revert_floors.py", "scripts/test_forward_undo.py",
         "scripts/test_revert_floors.py", "scripts/revert-to.py", "scripts/test_revert_to.py",
         ".github/workflows/revert-gate.yml")


def test_undoing_the_promote_that_shipped_the_undo_tools_keeps_them(tmp_path, capsys):
    """QA v4.158.0's probe (test_zzqa_forward_undo_probe.py), adopted with its assertions flipped. The
    v4.158.0 shape: one promote SHIPS the undo tool, the floor parser, the floor check in revert-to.py,
    their tests and revert-gate's text, alongside an app change. If that promote is the bad one, its
    undo takes the revert path: no floor entry was put in force by it. The app change must go, every
    tool must stay as dev has it, and the dry run must say so."""
    w = World(tmp_path)
    w.write("scripts/revert-to.py", FLOORLESS)
    w.write("scripts/test_revert_to.py", "# tests for the floorless rewind\n")
    w.commit("chore: revert-to.py as it was")
    w.release("1.0.1", "Before the floor")
    w.ship("v1.0.1")
    v101 = w.sha()
    for rel in TOOLS[:4]:
        shutil.copy(os.path.join(HERE, os.path.basename(rel)), os.path.join(w.work, rel))
    w.write("scripts/revert-to.py", WITH_FLOOR)
    w.write("scripts/test_revert_to.py", "# tests for the floor check\n")
    w.write(".github/workflows/revert-gate.yml", "name: revert-gate\n")
    w.write("src/app.js", "export const app = 2\n")
    w.commit("feat: tooling and an app change")
    w.release("1.1.0", "Tooling")
    w.ship("v1.1.0")
    v110 = w.sha()
    code, dry, err = undo(capsys, w)
    assert code == 0, err
    assert "undo = REVERT" in dry and "kept as dev has them" in dry
    for rel in TOOLS:
        assert f"    {rel}\n" in dry, rel          # named, not silent
    code, out, err = undo(capsys, w, "--write")
    assert code == 0, err
    branch = "undo-v1.1.0-as-v1.1.1"
    for rel in (*TOOLS, "scripts/revert-floors.json"):
        assert w.exists(branch, rel) and w.show(branch, rel) == w.show(v110, rel), rel
    assert "require_target_above_floor" in w.show(branch, "scripts/revert-to.py")
    assert w.show(branch, "src/app.js") == "export const app = 1\n"   # the app change IS backed out
    assert w.changed(v101, branch) == RELEASE_FILES | set(TOOLS)


def test_migrations_stay_applied_and_the_write_needs_them_checked(tmp_path, scratch, capsys):
    """Nothing rewinds the database, so a migration the undone promote shipped stays applied: its file
    stays in the repo as dev has it (added, edited or deleted), the plan lists it, and --write refuses
    until --migrations-checked says the code going back runs on that schema."""
    w = World(tmp_path)
    w.write("migrations/000_base.sql", "create table t (id int);\n")
    w.write("migrations/obsolete.sql", "-- superseded\n")
    w.commit("feat: base schema")
    w.release("1.0.1", "Schema")
    w.ship("v1.0.1")
    w.write("migrations/001_add_col.sql", "alter table t add column c int;\n")
    w.write("migrations/000_base.sql", "create table t (id int primary key);\n")
    w.rm("migrations/obsolete.sql")
    w.write("src/app.js", "export const app = 2\n")
    w.commit("feat: column c, and the app reads it")
    w.release("1.1.0", "Column c")
    w.ship("v1.1.0")
    v110 = w.sha()
    code, dry, err = undo(capsys, w)
    assert code == 0, err
    assert "MIGRATIONS: v1.1.0's promote shipped these" in dry and "--migrations-checked" in dry
    for p in ("migrations/000_base.sql", "migrations/001_add_col.sql", "migrations/obsolete.sql"):
        assert f"    {p}\n" in dry, p
    before = state(w, scratch)
    code, out, err = undo(capsys, w, "--write")
    assert code == 1 and "--migrations-checked" in err and "migrations/001_add_col.sql" in err
    assert state(w, scratch) == before
    code, out, err = undo(capsys, w, "--write", "--migrations-checked")
    assert code == 0, err
    branch = "undo-v1.1.0-as-v1.1.1"
    assert w.show(branch, "src/app.js") == "export const app = 1\n"        # the code goes back ...
    for p in ("migrations/000_base.sql", "migrations/001_add_col.sql"):    # ... the schema history stays
        assert w.show(branch, p) == w.show(v110, p), p
    assert not w.exists(branch, "migrations/obsolete.sql")                  # as dev has it: gone
    assert "Migrations v1.1.0 shipped stay applied" in g(w.work, "log", "-1", "--format=%B", branch)


def test_the_undo_names_every_release_it_backs_out(tmp_path, capsys):
    """One promote can carry several releases (v4.158.0's carries 4.157.0). The plan and the release
    note name every one of them, from public/releases.json: Dave loses all of them on "ship it"."""
    w = World(tmp_path)
    w.write("src/water.js", "export const beds = 'wait'\n")
    w.commit("feat: beds wait")
    w.release("1.1.0", "Watering: beds wait after rain")    # untagged: carried by v1.2.0's promote
    w.write("src/garden.js", "export const fixed = true\n")
    w.commit("fix: garden")
    w.release("1.2.0", "Garden fix")
    w.ship("v1.2.0")
    code, out, err = undo(capsys, w)
    assert code == 0, err
    assert "this undo backs out 2 release(s), everything shipped after v1.0.0:" in out
    assert "    1.1.0  Watering: beds wait after rain\n" in out and "    1.2.0  Garden fix\n" in out
    assert ('new release 1.2.1: "Undoes v1.2.0: backs out 1.1.0 and 1.2.0, so the app works the way it did '
            'in v1.0.0 again."') in out
    code, out, err = undo(capsys, w, "--write", "--note", "beds water on schedule again")
    assert code == 0, err
    branch = "undo-v1.2.0-as-v1.2.1"
    rel = json.loads(w.show(branch, "public/releases.json"))
    assert rel[0]["highlights"] == ["Undoes v1.2.0: beds water on schedule again. Backs out 1.1.0 and 1.2.0."]
    assert "Backs out: 1.1.0 and 1.2.0." in g(w.work, "log", "-1", "--format=%B", branch)


# --- refusals ------------------------------------------------------------------------------------

def test_a_floor_with_no_switch_refuses_the_revert(tmp_path, scratch, capsys):
    w = World(tmp_path)
    w.add_floor({"floor": "v1.1.0", "since": "v1.1.0", "reason": "hourly schedule", "ledger": "OPS-FIXTURE-003",
                 "undo_instead": None})
    w.write("src/app.js", "export const app = 2\n")
    w.commit("feat: a one-way step")
    w.release("1.1.0", "One way")
    w.ship("v1.1.0")
    before = state(w, scratch)
    code, out, err = undo(capsys, w, "--write")
    assert code == 1
    assert "would put v1.0.0's code back, below the revert floor v1.1.0" in err
    assert "shipped a floor with no switch to turn off: OPS-FIXTURE-003" in err
    assert state(w, scratch) == before


def test_a_floor_at_or_below_the_previous_release_allows_the_revert(tmp_path, capsys):
    w = World(tmp_path)
    w.add_floor({"floor": "v1.0.0", "since": "v1.1.0", "reason": "writer compatible from v1.0.0",
                 "ledger": "OPS-FIXTURE-004", "undo_instead": None})
    w.write("src/app.js", "export const app = 2\n")
    w.commit("feat: arms something v1.0.0 already handles")
    w.release("1.1.0", "Armed")
    w.ship("v1.1.0")
    code, out, err = undo(capsys, w)
    assert code == 0, err
    assert "undo = REVERT 2 commit(s)" in out


def _one_way_then_other(w, tag_the_one_way):
    w.add_floor({"floor": "v1.1.0", "since": "v1.1.0", "reason": "one-way", "ledger": "OPS-FIXTURE-005",
                 "undo_instead": None})
    w.write("src/app.js", "export const app = 2\n")
    w.commit("feat: one-way")
    w.release("1.1.0", "One way")
    if tag_the_one_way:
        w.ship("v1.1.0")
    w.write("src/other.js", "export const other = 1\n")
    w.commit("feat: other")
    w.release("1.2.0", "Other")
    w.ship("v1.2.0")


def test_a_floor_shipped_by_an_earlier_promote_allows_a_revert_that_lands_on_it(tmp_path, capsys):
    w = World(tmp_path)
    _one_way_then_other(w, tag_the_one_way=True)
    code, out, err = undo(capsys, w)
    assert code == 0, err
    assert "previous release: v1.1.0" in out and "undo = REVERT" in out


def test_a_floor_carried_untagged_in_the_undone_promote_refuses(tmp_path, capsys):
    """v1.1.0 never had its own promote: v1.2.0's carried it, so undoing v1.2.0 lands on v1.0.0,
    below the floor v1.1.0 put in force."""
    w = World(tmp_path)
    _one_way_then_other(w, tag_the_one_way=False)
    code, out, err = undo(capsys, w)
    assert code == 1 and "below the revert floor v1.1.0" in err and "OPS-FIXTURE-005" in err


def test_dev_ahead_of_main_refuses_and_lists_the_commits(tmp_path, scratch, capsys):
    w = World(tmp_path)
    ship_plain(w)
    w.write("src/x.js", "x\n")
    a = w.commit("feat: unshipped one")
    w.write("src/y.js", "y\n")
    b = w.commit("feat: unshipped two")
    w.push_dev()
    before = state(w, scratch)
    code, out, err = undo(capsys, w, "--write")
    assert code == 1
    assert "dev is 2 commit(s) ahead of main" in err and "--allow-dev-ahead" in err
    assert f"    {b} feat: unshipped two" in err and f"    {a} feat: unshipped one" in err
    assert state(w, scratch) == before


def _listed_ahead(out):
    lines = out.splitlines()
    i = next(i for i, line in enumerate(lines) if "ahead of main. These unshipped commits" in line)
    rows = []
    for line in lines[i + 1:]:
        if not line.startswith("    "):
            break
        rows.append(line.split()[0])
    return rows


def test_allow_dev_ahead_lists_exactly_the_unshipped_commits_and_builds_on_dev(tmp_path, scratch, capsys):
    w = World(tmp_path)
    ship_plain(w)
    v100 = w.sha("v1.0.0")
    w.write("src/x.js", "x\n")
    a = w.commit("feat: unshipped one")
    b = w.release("1.2.0", "Unshipped")
    w.push_dev()
    dev = w.sha()
    code, out, err = undo(capsys, w, "--allow-dev-ahead")
    assert code == 0, err
    assert _listed_ahead(out) == [b, a]
    assert "DRY RUN" in out and "new release 1.2.1" in out
    assert "a revert conflict can only show up under --write" in out
    before = state(w, scratch)
    code, out, err = undo(capsys, w, "--allow-dev-ahead", "--write")
    assert code == 0, err
    branch = "undo-v1.1.0-as-v1.2.1"
    assert w.sha(f"{branch}^") == dev
    assert w.show(branch, "src/app.js") == w.show(v100, "src/app.js")    # v1.1.0 backed out ...
    assert w.show(branch, "src/old.js") == w.show(v100, "src/old.js")
    assert not w.exists(branch, "src/new.js")
    assert w.show(branch, "src/x.js") == "x\n"                            # ... the unshipped work kept
    assert [r["version"] for r in json.loads(w.show(branch, "public/releases.json"))] == \
        ["1.2.1", "1.2.0", "1.1.0", "1.0.0"]
    assert_only_new_branch(w, before, branch)


def test_a_code_conflict_under_allow_dev_ahead_refuses_and_leaves_nothing_behind(tmp_path, scratch, capsys):
    w = World(tmp_path)
    ship_plain(w)
    w.write("src/app.js", "export const app = 99\n")    # the line v1.1.0 changed, changed again
    w.commit("feat: unshipped edit of the same line")
    w.push_dev()
    before = state(w, scratch)
    code, out, err = undo(capsys, w, "--allow-dev-ahead", "--write")
    assert code == 1 and "conflicts on dev" in err and "src/app.js" in err
    assert state(w, scratch) == before     # branch deleted, worktree removed, temp dir gone


def test_a_package_json_change_beyond_the_version_that_collides_with_dev_refuses(tmp_path, scratch, capsys):
    w = World(tmp_path)
    pkg = json.loads(w.show("HEAD", "package.json"))
    w.write("package.json", json.dumps({**pkg, "dependencies": {"left-pad": "1.0.0"}}, indent=2) + "\n")
    w.commit("feat: a dependency")
    w.release("1.1.0", "Dependency")
    w.ship("v1.1.0")
    w.release("1.2.0", "Unshipped bump")
    w.push_dev()
    before = state(w, scratch)
    code, out, err = undo(capsys, w, "--allow-dev-ahead", "--write")
    assert code == 1 and "beyond its version" in err
    assert state(w, scratch) == before


@pytest.mark.parametrize("release,ok", [("v1.1.0", True), ("1.1.0", True), ("v1.0.0", False), ("v1.1", False)])
def test_release_is_an_interlock_on_what_main_ships(tmp_path, capsys, release, ok):
    w = World(tmp_path)
    ship_plain(w)
    code, out, err = undo(capsys, w, "--release", release)
    assert (code == 0) is ok, err


def test_main_without_its_release_tag_refuses(tmp_path, capsys):
    w = World(tmp_path)
    ship_plain(w)
    w.release("1.2.0", "Never promoted")
    g(w.work, "push", "-q", "origin", "HEAD:refs/heads/main", "HEAD:refs/heads/dev")
    code, out, err = undo(capsys, w)
    assert code == 1 and "has no v1.2.0 release tag" in err


def test_main_past_its_tag_refuses(tmp_path, capsys):
    w = World(tmp_path)
    ship_plain(w)
    w.write("src/z.js", "z\n")
    w.commit("feat: shipped with no bump")
    g(w.work, "push", "-q", "origin", "HEAD:refs/heads/main", "HEAD:refs/heads/dev")
    code, out, err = undo(capsys, w)
    assert code == 1 and "main moved past its release" in err


@pytest.mark.parametrize("text", [None, "{", json.dumps({"floors": []})])
def test_an_unreadable_floor_file_refuses(tmp_path, capsys, text):
    w = World(tmp_path)
    if text is None:
        w.rm("scripts/revert-floors.json")
    else:
        w.write("scripts/revert-floors.json", text)
    w.write("src/app.js", "export const app = 2\n")
    w.commit("feat: two")
    w.release("1.1.0", "Two")
    w.ship("v1.1.0")
    code, out, err = undo(capsys, w)
    assert code == 1 and "revert-floors.json" in err


def test_a_remote_that_moved_between_fetch_and_listing_refuses(tmp_path, capsys, monkeypatch):
    w = World(tmp_path)
    ship_plain(w)
    stale = w.sha()
    w.write("src/x.js", "x\n")
    w.commit("feat: pushed meanwhile")
    w.push_dev()
    g(w.work, "update-ref", "refs/remotes/origin/dev", stale)   # the harness rewinds its own tracking ref
    monkeypatch.setattr(fu, "fetch", lambda repo, remote: None)
    code, out, err = undo(capsys, w)
    assert code == 1 and "origin/dev moved while this ran" in err


def test_an_existing_branch_is_never_reused(tmp_path, scratch, capsys):
    w = World(tmp_path)
    ship_plain(w)
    g(w.work, "branch", "undo-v1.1.0-as-v1.1.1", "v1.0.0")
    before = state(w, scratch)
    code, out, err = undo(capsys, w, "--write")
    assert code == 1 and "already exists" in err
    assert state(w, scratch) == before
    code, out, err = undo(capsys, w, "--write", "--branch", "dev")
    assert code == 1 and "cannot be the undo branch" in err


def test_the_version_skips_burned_tags_and_checks_a_requested_one(tmp_path, capsys):
    w = World(tmp_path)
    ship_plain(w)
    g(w.work, "tag", "v1.1.1", "v1.0.0")
    g(w.work, "push", "-q", "origin", "refs/tags/v1.1.1")
    code, out, err = undo(capsys, w)
    assert code == 0 and "new release 1.1.2" in out, err
    for bad in ("1.1.0", "1.1.1", "1.2"):
        code, out, err = undo(capsys, w, "--version", bad)
        assert code == 1, bad
    code, out, err = undo(capsys, w, "--version", "1.2.0")
    assert code == 0 and "new release 1.2.0" in out


# --- nothing but reads and local commits, ever ----------------------------------------------------

ALLOWED_GIT = {"fetch", "ls-remote", "rev-parse", "show", "cat-file", "merge-base", "rev-list", "log",
               "check-ref-format", "show-ref", "worktree", "revert", "checkout", "diff", "add", "commit",
               "ls-tree", "ls-files", "restore"}


def test_only_reads_and_local_commits_ever_run(tmp_path, capsys, monkeypatch):
    """Every command the script runs, across a dry run, a flag write and a revert write: git reads,
    a fetch into remote-tracking refs only, a throwaway worktree, local revert/commit — and node for
    the release tool. No push, tag, update-ref, reset, branch surgery or anything else."""
    real = subprocess.run
    seen, rec = [], {"on": False}

    def spy(argv, *a, **k):
        if rec["on"]:
            seen.append(list(argv))
        return real(argv, *a, **k)
    monkeypatch.setattr(subprocess, "run", spy)

    def recorded(w, *args):
        rec["on"] = True
        try:
            return undo(capsys, w, *args)[0]
        finally:
            rec["on"] = False

    w1 = World(tmp_path / "flag")
    ship_flagged(w1)
    assert recorded(w1) == 0 and recorded(w1, "--write") == 0
    w2 = World(tmp_path / "revert")
    ship_plain(w2)
    assert recorded(w2, "--write") == 0
    subs = set()
    for argv in seen:
        if argv[0] == "node":
            assert argv[1:2] == ["scripts/add-release.mjs"], argv
            continue
        assert argv[:2] == ["git", "-C"], argv
        sub = argv[3]
        subs.add(sub)
        assert sub in ALLOWED_GIT, argv
        if sub == "fetch":
            assert all(x.split(":", 1)[1].startswith("refs/remotes/") for x in argv if ":" in x), argv
        if sub == "worktree":
            assert argv[4] in ("add", "remove"), argv
        if sub == "checkout":
            assert "--" in argv, argv
        if sub == "restore":
            assert any(x.startswith("--source=") for x in argv), argv
    # the spy saw the script's real work, so the allowlist above was not checked against nothing
    assert {"fetch", "ls-remote", "worktree", "revert", "commit", "restore"} <= subs
    assert any(argv[0] == "node" for argv in seen)


def test_the_command_line_entry_point(tmp_path, scratch):
    w = World(tmp_path)
    ship_flagged(w)
    before = refs(w.bare)
    r = subprocess.run([sys.executable, SCRIPT, "--repo", w.work], capture_output=True, text=True)
    assert r.returncode == 0 and "DRY RUN" in r.stdout, r.stderr
    r = subprocess.run([sys.executable, SCRIPT, "--repo", w.work, "--write", "--keep-worktree"],
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    kept = r.stdout.split("worktree kept at ", 1)[1].split(";", 1)[0]
    assert os.path.isdir(kept) and os.path.realpath(kept).startswith(os.path.realpath(scratch))
    assert g(kept, "rev-parse", "--abbrev-ref", "HEAD").strip() == "undo-v1.1.0-as-v1.1.1"
    g(w.work, "worktree", "remove", kept)
    r = subprocess.run([sys.executable, SCRIPT, "--repo", w.work, "--release", "v9.9.9"],
                       capture_output=True, text=True)
    assert r.returncode == 1 and "REFUSED" in r.stderr
    assert refs(w.bare) == before


# --- units ---------------------------------------------------------------------------------------

def test_flag_off():
    src = "// x\nexport const A_ENABLED = true // on\nexport const B_ENABLED = true\n"
    assert fu.flag_off(src, "A_ENABLED", "f") == "// x\nexport const A_ENABLED = false // on\nexport const B_ENABLED = true\n"
    with pytest.raises(fu.Refused, match="already false"):
        fu.flag_off("export const A_ENABLED = false\n", "A_ENABLED", "f")
    with pytest.raises(fu.Refused, match="found 0"):
        fu.flag_off("export const A_ENABLED = trueish\n", "A_ENABLED", "f")
    with pytest.raises(fu.Refused, match="found 2"):
        fu.flag_off("export const A_ENABLED = true\nexport const A_ENABLED = true\n", "A_ENABLED", "f")
    with pytest.raises(fu.Refused):
        fu.flag_off("export const A_ENABLED_TOO = true\n", "A_ENABLED", "f")


def test_compose_note():
    cn = fu.compose_note
    assert cn("v1.2.0", "v1.1.0", "flag") == "Undoes v1.2.0: turns the change it made back off."
    assert cn("v1.2.0", "v1.1.0", "flag", " pages scroll as before. ") == "Undoes v1.2.0: pages scroll as before."
    assert cn("v1.2.0", "v1.1.0", "flag", "Undoes v1.2.0: x") == "Undoes v1.2.0: x"
    # the revert path always names what it backs out
    assert cn("v1.2.0", "v1.1.0", "revert") == \
        "Undoes v1.2.0: backs out 1.2.0, so the app works the way it did in v1.1.0 again."
    assert cn("v1.2.0", "v1.0.0", "revert", backed_out=["1.1.0", "1.2.0"]) == \
        "Undoes v1.2.0: backs out 1.1.0 and 1.2.0, so the app works the way it did in v1.0.0 again."
    assert cn("v1.2.0", "v1.0.0", "revert", "beds water daily again", ["1.1.0", "1.2.0"]) == \
        "Undoes v1.2.0: beds water daily again. Backs out 1.1.0 and 1.2.0."
    assert cn("v1.2.0", "v1.0.0", "revert", "backs out 1.1.0 and 1.2.0.", ["1.1.0", "1.2.0"]) == \
        "Undoes v1.2.0: backs out 1.1.0 and 1.2.0."
    for bad in ("Undoes v1.1.0: x", "two\nlines", "   "):
        with pytest.raises(fu.Refused):
            cn("v1.2.0", "v1.1.0", "flag", bad)


def test_spoken_and_is_kept():
    assert fu.spoken(["4.158.0"]) == "4.158.0"
    assert fu.spoken(["4.157.0", "4.158.0"]) == "4.157.0 and 4.158.0"
    assert fu.spoken(["1", "2", "3"]) == "1, 2 and 3"
    for p in ("scripts/forward-undo.py", "scripts/revert-to.py", "scripts/test_revert_to.py",
              "migrations/2026/001.sql", "public/releases.json", "scripts/add-release.mjs"):
        assert fu.is_kept(p), p
    for p in ("src/app.js", "scripts/snap.py", "migrationsx.sql", "scripts/revert-to.py.bak", "package.json"):
        assert not fu.is_kept(p), p


def test_choose_version():
    tags = {"v1.2.0": "a", "v1.2.1": "b"}
    assert fu.choose_version("1.2.0", "v1.2.0", tags) == "1.2.2"
    assert fu.choose_version("1.3.0", "v1.2.0", tags) == "1.3.1"      # dev ahead with its own bump
    assert fu.choose_version("1.2.0", "v1.2.0", tags, "1.3.0") == "1.3.0"
    for bad in ("1.2.0", "1.1.9", "1.2.1", "v1.3.0", "1.3"):
        with pytest.raises(fu.Refused):
            fu.choose_version("1.2.0", "v1.2.0", tags, bad)
