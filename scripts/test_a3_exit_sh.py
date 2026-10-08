"""scripts/ci-telemetry/a3-exit.sh, the wrapper of the A3 trial's two exit checks, run against stand-ins.

Run: python3 -m pytest -q scripts/test_a3_exit_sh.py

The wrapper decides the one thing the trial's header rests on: the last line and the exit code. So it is run here,
whole, in a small checkout made for the test: its own git repository, an .nvmrc, the real a3-exit.sh and a3-exit.py
copied in, and three stand-ins it finds where it finds the real ones:
  node_modules/.bin/vitest   writes what the scenario laid out for the run it is asked for (tests.jsonl, coverage)
                             and exits as the scenario says; every call is written down, with its environment
  node (on PATH)             prints the version the scenario says
  python3 (on PATH)          the interpreter running these tests; or, when the scenario gives a comparer a line to
                             say, that line and that exit code, to hold what the wrapper does with a comparer's answer
Seven vitest runs are seven `cp`, so a scenario is some sixty short processes and no more; the scenarios are kept few.
"""
import json
import os
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
TELEMETRY = os.path.join(HERE, "ci-telemetry")
RUNS = (("e1-jsdom", "jsdom"), ("e1-node", "node"), ("e2-jsdom-a", "jsdom"), ("e2-jsdom-b", "jsdom"),
        ("e2-node-a", "node"), ("e2-node-b", "node"), ("e2-setup", "jsdom"))
NODE = "v20.19.0"

VITEST = """#!/bin/sh
name="${A3_EXIT_OUT##*/}"
echo "${name} env=${A3_EXIT_ENV:-} wide=${A3_EXIT_WIDE:-} control=${A3_EXIT_CONTROL:-} tz=${TZ:-} cwd=${PWD} $*" \\
  >> "${STUB}/calls.log"
[ -d "${STUB}/${name}" ] && cp -R "${STUB}/${name}" "${A3_EXIT_OUT}"
echo "stub vitest: ${name}"
code=0
[ -f "${STUB}/${name}.exit" ] && read -r code < "${STUB}/${name}.exit"
exit "${code}"
"""
NODE_SHIM = """#!/bin/sh
read -r version < "${STUB}/node.version"
echo "${version}"
"""
PYTHON_SHIM = """#!/bin/sh
if [ -f "${STUB}/$2.says" ]; then
  read -r said < "${STUB}/$2.says"
  read -r code < "${STUB}/$2.exit"
  echo "${said}"
  exit "${code}"
fi
exec "%s" "$@"
"""


def _executable(path, text):
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.chmod(path, 0o755)


class Tree:
    def __init__(self, root):
        self.root = os.path.realpath(str(root))
        self.repo = os.path.join(self.root, "repo")
        self.bin = os.path.join(self.root, "bin")
        self.count = 0
        os.makedirs(os.path.join(self.repo, "scripts", "ci-telemetry"))
        os.makedirs(os.path.join(self.repo, "node_modules", ".bin"))
        os.makedirs(self.bin)
        for name in ("a3-exit.sh", "a3-exit.py"):
            shutil.copy(os.path.join(TELEMETRY, name), os.path.join(self.repo, "scripts", "ci-telemetry", name))
        os.chmod(self.script, 0o755)
        _executable(os.path.join(self.repo, "node_modules", ".bin", "vitest"), VITEST)
        _executable(os.path.join(self.bin, "node"), NODE_SHIM)
        _executable(os.path.join(self.bin, "python3"), PYTHON_SHIM % sys.executable)
        for name, text in ((".nvmrc", NODE[1:] + "\n"), (".gitignore", "node_modules/\n")):
            with open(os.path.join(self.repo, name), "w", encoding="utf-8") as fh:
                fh.write(text)
        for command in (["init", "-q"], ["add", "-A"],
                        ["-c", "user.name=a3", "-c", "user.email=a3@example.invalid", "commit", "-q", "-m", "tree"]):
            subprocess.run(["git", "-C", self.repo] + command, check=True, capture_output=True)
        self.sha = subprocess.run(["git", "-C", self.repo, "rev-parse", "HEAD"], check=True, capture_output=True,
                                  text=True).stdout.strip()

    @property
    def script(self):
        return os.path.join(self.repo, "scripts", "ci-telemetry", "a3-exit.sh")

    def scenario(self, node=NODE, **changes):
        """A new scenario directory, every run laid out so that both checks read SAME; then `changes`:
        RUN=None (the run writes nothing), RUN_exit=N, RUN_tests=[…], RUN_coverage={…}, e1_says / e2_says (text,
        exit code): the comparer is a stand-in for that check."""
        self.count += 1
        stub = os.path.join(self.root, "scenario-%d" % self.count)
        os.makedirs(stub)
        with open(os.path.join(stub, "node.version"), "w", encoding="utf-8") as fh:
            fh.write(node + "\n")
        for run, env in RUNS:
            key = run.replace("-", "_")
            if key in changes and changes[key] is None:
                continue
            os.makedirs(os.path.join(stub, run, "coverage"))
            with open(os.path.join(stub, run, "tests.jsonl"), "w", encoding="utf-8") as fh:
                fh.write(_jsonl(env, changes.get(key + "_tests", TESTS)))
            if run.startswith("e2"):
                with open(os.path.join(stub, run, "coverage", "coverage-final.json"), "w", encoding="utf-8") as fh:
                    json.dump(changes.get(key + "_coverage", self.coverage(run)), fh)
            if key + "_exit" in changes:
                with open(os.path.join(stub, run + ".exit"), "w", encoding="utf-8") as fh:
                    fh.write("%d\n" % changes[key + "_exit"])
        for check in ("e1", "e2"):
            if check + "_says" in changes:
                said, code = changes[check + "_says"]
                with open(os.path.join(stub, check + ".says"), "w", encoding="utf-8") as fh:
                    fh.write(said + "\n")
                with open(os.path.join(stub, check + ".exit"), "w", encoding="utf-8") as fh:
                    fh.write("%d\n" % code)
        return stub

    def coverage(self, run, b_hits=1):
        """Two modules under lambda/ in every run; under jsdom also the one the setup file loads, which is the whole
        of the control. All under lambda/, so that their names are right only when the wrapper passes --root."""
        if run == "e2-setup":
            return {self.repo + "/lambda/_setup/loaded.js": _statements(4, 1)}
        files = {self.repo + "/lambda/a.js": _statements(5, 1), self.repo + "/lambda/b.js": _statements(3, b_hits)}
        if "jsdom" in run:
            files[self.repo + "/lambda/_setup/loaded.js"] = _statements(4, 1)
        return files

    def run(self, stub, out="out", cwd=None, args=None, **env):
        """Runs a3-exit.sh. Returns (exit code, stdout, stderr, OUT_DIR)."""
        where = out if os.path.isabs(out) else os.path.join(stub, out)
        environment = {"PATH": self.bin + os.pathsep + os.environ["PATH"], "HOME": os.environ.get("HOME", self.root),
                       "STUB": stub}
        environment.update(env)
        done = subprocess.run([self.script] + ([where] if args is None else args), cwd=cwd or stub, env=environment,
                              capture_output=True, text=True, timeout=120)
        return done.returncode, done.stdout, done.stderr, where


TESTS = [("lambda/a.test.js", "adds", "passed", 3), ("lambda/b.test.js", "holds", "passed", 2)]


def _jsonl(env, tests, dom=None):
    saw = (env == "jsdom") if dom is None else dom
    rows = [{"a3_exit": 2, "env": env, "files": 2, "tests": len(tests), "left_out": [], "notes": []}]
    rows += [{"file": f, "name": n, "state": s, "assertionCalls": c, "dom": saw} for f, n, s, c in tests]
    return "".join(json.dumps(row) + "\n" for row in rows)


def _statements(count, hits):
    cov = {"path": "x", "statementMap": {}, "s": {}, "fnMap": {}, "f": {}, "branchMap": {}, "b": {}}
    for index in range(count):
        cov["statementMap"][str(index)] = {"start": {"line": index + 1, "column": 0},
                                           "end": {"line": index + 1, "column": None}}
        cov["s"][str(index)] = hits
    return cov


@pytest.fixture(scope="module")
def tree(tmp_path_factory):
    return Tree(tmp_path_factory.mktemp("a3-exit-sh"))


def _last(text):
    return text.rstrip("\n").split("\n")[-1]


E1_SAME = "E1-SAME (2 tests, 5 assertions each side)"
E2_SAME = "E2-SAME (8 items in 2 files; 0 not compared; 0 files under a shared reading; 0 generated import glue)"
PASS = "A3-EXIT-PASS (e1=E1-SAME, e2=E2-SAME, red=0, node=v20.19.0, tree=clean)"


def _fail(e1="E1-SAME", e2="E2-SAME", red=0, node=NODE, tree="clean"):
    return "A3-EXIT-FAIL (e1=%s, e2=%s, red=%d, node=%s, tree=%s)" % (e1, e2, red, node, tree)


# ------------------------------------------------------------------------------------------------------ a pass

def test_seven_runs_two_same_verdicts_the_pinned_node_and_a_clean_tree_pass(tree):
    stub = tree.scenario()
    # OUT_DIR given relative, with a part that is not there yet and a trailing slash
    code, out, err, _ = tree.run(stub, args=["new/deeper/"], cwd=stub)
    where = os.path.join(stub, "new", "deeper")
    assert (code, _last(out), err) == (0, PASS, ""), out + err
    lines = out.rstrip("\n").split("\n")
    assert lines[:3] == ["sha " + tree.sha, "uncommitted 0 paths", "node v20.19.0, .nvmrc 20.19.0"]
    assert [line.split(":")[0] for line in lines[4:11]] == ["run " + run for run, _ in RUNS]
    assert all(": vitest exit 0, " in line for line in lines[4:11])
    assert lines[11:] == ["", "E1 (%s/e1.txt), exit 0:" % where, E1_SAME, "E2 (%s/e2.txt), exit 0:" % where, E2_SAME,
                          PASS]
    # every run was asked for once, in its environment, from the checkout, with this config and nothing else
    asked = " cwd=%s run --config scripts/ci-telemetry/a3-exit.config.mjs" % tree.repo
    with open(os.path.join(stub, "calls.log"), encoding="utf-8") as fh:
        assert fh.read().split("\n") == [
            "e1-jsdom env=jsdom wide= control= tz=UTC" + asked, "e1-node env=node wide= control= tz=UTC" + asked,
            "e2-jsdom-a env=jsdom wide=1 control= tz=UTC" + asked, "e2-jsdom-b env=jsdom wide=1 control= tz=UTC" + asked,
            "e2-node-a env=node wide=1 control= tz=UTC" + asked, "e2-node-b env=node wide=1 control= tz=UTC" + asked,
            "e2-setup env=jsdom wide=1 control=1 tz=UTC" + asked, ""]
    # what it leaves: each run's output and log, the two comparers' output, and the record with the result last
    assert sorted(os.listdir(where)) == sorted([run for run, _ in RUNS] + [run + ".log" for run, _ in RUNS]
                                               + ["e1.txt", "e2.txt", "meta.txt"])
    with open(os.path.join(where, "meta.txt"), encoding="utf-8") as fh:
        assert fh.read() == out
    with open(os.path.join(where, "e2-node-b.log"), encoding="utf-8") as fh:
        assert fh.read() == "stub vitest: e2-node-b\n"
    # the comparer was given the control and the checkout as the root: the file names are the checkout's
    with open(os.path.join(where, "e2.txt"), encoding="utf-8") as fh:
        assert "    lambda/_setup/loaded.js: jsdom only, loaded by the setup file (in --setup-loads): 4 covered " \
               "items, 0 covered beyond the control: not counted\n" in fh.read()
    # a second run into it is refused: the runs of two trees must not mix
    code, out, err, _ = tree.run(stub, out=where)
    assert (code, out) == (2, "") and err == "a3-exit.sh: OUT_DIR %s is not empty: runs of two trees must not mix\n" % where
    with open(os.path.join(stub, "calls.log"), encoding="utf-8") as fh:
        assert len(fh.read().rstrip("\n").split("\n")) == 7


# ------------------------------------------------------------------------------------- what is never a pass

def test_a_red_run_is_said_and_fails_even_with_both_verdicts_same(tree):
    stub = tree.scenario(e2_node_b_exit=1, e1_jsdom_exit=7)
    os.makedirs(os.path.join(stub, "out"))   # an OUT_DIR that is there already, and empty, is fine
    code, out, _, where = tree.run(stub)
    assert (code, _last(out)) == (1, _fail(red=2)), out
    assert "run e2-node-b: vitest exit 1, " in out and "run e1-jsdom: vitest exit 7, " in out
    assert out.rstrip("\n").split("\n")[-4:] == [
        "E2 (%s/e2.txt), exit 0:" % where, E2_SAME,
        "RUNS-RED: 2 of the 7 vitest runs exited non-zero: read their .log files in %s" % where, _fail(red=2)]


def test_runs_that_wrote_nothing_make_their_checks_unreadable_and_fail(tree):
    code, out, _, _ = tree.run(tree.scenario(e1_node=None, e2_setup=None))
    assert (code, _last(out)) == (1, _fail(e1="E1-UNREADABLE", e2="E2-UNREADABLE")), out
    assert "/e1.txt), exit 2:\nE1-UNREADABLE: " in out and "/e2.txt), exit 2:\nE2-UNREADABLE: " in out


def test_a_difference_fails(tree):
    other = tree.coverage("e2-node-a", b_hits=0)
    fewer = [TESTS[0], TESTS[1][:3] + (1,)]
    code, out, _, _ = tree.run(tree.scenario(e2_node_a_coverage=other, e2_node_b_coverage=other, e1_node_tests=fewer))
    assert (code, _last(out)) == (1, _fail(e1="E1-DIFFER", e2="E2-DIFFER")), out
    assert "/e1.txt), exit 1:\nE1-DIFFER (1 tests differ or are on one side only, 0 files collected no test)\n" in out
    assert "/e2.txt), exit 1:\nE2-DIFFER (3 differences in 1 files; 0 items in 0 files not compared)\n" in out


def test_something_not_compared_is_inconclusive_and_fails(tree):
    """One module only the second node run loaded, another only the first jsdom run: each of the four coverage
    files reaches the comparer in its own place."""
    late = dict(tree.coverage("e2-node-b"), **{tree.repo + "/lambda/late.js": _statements(2, 1)})
    early = dict(tree.coverage("e2-jsdom-a"), **{tree.repo + "/lambda/early.js": _statements(3, 1)})
    code, out, _, where = tree.run(tree.scenario(e2_node_b_coverage=late, e2_jsdom_a_coverage=early))
    assert (code, _last(out)) == (1, _fail(e2="E2-INCONCLUSIVE")), out
    assert "/e2.txt), exit 3:\nE2-INCONCLUSIVE (5 items in 2 files not compared)\n" in out
    with open(os.path.join(where, "e2.txt"), encoding="utf-8") as fh:
        said = fh.read()
    assert "    in 1 of 2 runs: lambda/early.js: in 1 of 2 runs of jsdom (A) and in neither node run: 3 items\n" in said
    assert "    in 1 of 2 runs: lambda/late.js: in neither jsdom run and in 1 of 2 runs of node (B): 2 items\n" in said


def test_two_sides_not_shown_to_be_two_environments_fail(tree):
    """What an ignored `environment` would look like: the node runs are jsdom runs."""
    as_jsdom = tree.coverage("e2-jsdom-a")
    stub = tree.scenario(e2_node_a_coverage=as_jsdom, e2_node_b_coverage=as_jsdom)
    with open(os.path.join(stub, "e1-node", "tests.jsonl"), "w", encoding="utf-8") as fh:
        fh.write(_jsonl("node", TESTS, dom=True))
    code, out, _, _ = tree.run(stub)
    assert (code, _last(out)) == (1, _fail(e1="E1-VACUOUS", e2="E2-VACUOUS")), out
    assert "/e1.txt), exit 2:\nE1-VACUOUS: 2 tests on the node side ran with a document" in out
    assert "/e2.txt), exit 2:\nE2-VACUOUS: the setup file loads lambda/_setup/loaded.js" in out


def test_a_pass_needs_the_comparers_exit_code_and_its_word_both(tree):
    """Either alone is not enough: a comparer that says SAME and exits 1, or exits 0 and says something else. In
    each case the other check is the real comparer reading SAME, so the one stand-in is the only reason to fail."""
    cases = (("e1", "E1-SAME (made up)", 1, _fail(e1="E1-SAME")),
             ("e2", "E2-SAME (made up)", 3, _fail(e2="E2-SAME")),
             ("e1", "E1-DIFFER: made up", 0, _fail(e1="E1-DIFFER")),
             ("e2", "E1-SAME (the other check's word)", 0, _fail(e2="E2-NO-VERDICT")))
    stubs = [tree.scenario(**{check + "_says": (said, code_given)}) for check, said, code_given, _ in cases]
    with ThreadPoolExecutor(len(stubs)) as pool:   # four scenarios that share nothing, side by side
        ran = list(pool.map(tree.run, stubs))
    for (check, said, code_given, want), (code, out, _, where) in zip(cases, ran):
        assert (code, _last(out)) == (1, want), (said, out)
        assert "%s (%s/%s.txt), exit %d:\n%s\n" % (check.upper(), where, check, code_given, said) in out


# ------------------------------------------------------------------------------ the Node pin and the clean tree

def test_another_node_is_refused_before_any_run(tree):
    stub = tree.scenario(node="v26.4.0")
    code, out, err, where = tree.run(stub)
    assert (code, out) == (2, ""), out + err
    assert err == ("a3-exit.sh: node is v26.4.0 and .nvmrc (CI) says v20.19.0: the exit checks are made on that Node. "
                   "A3_EXIT_ANY_NODE=1 runs them here anyway, and the result is then never a pass\n")
    assert not os.path.exists(where) and not os.path.exists(os.path.join(stub, "calls.log"))
    # a patch release apart is another Node too, and so is no node at all
    for version in ("v20.19.1", "v20.19.00", "20.19.0", ""):
        code, out, err, where = tree.run(tree.scenario(node=version))
        assert code == 2 and "and .nvmrc (CI) says v20.19.0" in err and not os.path.exists(where), version


def test_the_node_override_runs_it_and_the_result_is_never_a_pass(tree):
    stub = tree.scenario(node="v26.4.0")
    said = "v26.4.0 is not v20.19.0 of .nvmrc: A3_EXIT_ANY_NODE=1, never a pass"
    code, out, err, _ = tree.run(stub, A3_EXIT_ANY_NODE="1")
    assert (code, _last(out), err) == (1, _fail(node=said), ""), out + err
    assert E1_SAME in out and E2_SAME in out and "node v26.4.0, .nvmrc 20.19.0\n" in out
    # only the value 1 is the override, and only of the Node
    for given in ({"A3_EXIT_ANY_NODE": "0"}, {"A3_EXIT_ANY_NODE": "true"}, {"A3_EXIT_ANY_NODE": ""},
                  {"A3_EXIT_ANY_TREE": "1"}):
        code, out, err, _ = tree.run(tree.scenario(node="v26.4.0"), **given)
        assert (code, out) == (2, ""), given


def test_an_uncommitted_path_is_refused_and_its_override_is_never_a_pass(tree):
    stray = os.path.join(tree.repo, "stray.txt")
    try:
        with open(stray, "w", encoding="utf-8") as fh:
            fh.write("not committed\n")
        with open(os.path.join(tree.repo, ".nvmrc"), "a", encoding="utf-8") as fh:
            fh.write("\n")
        stub = tree.scenario()
        code, out, err, where = tree.run(stub)
        assert (code, out) == (2, ""), out + err
        assert err == ("a3-exit.sh: 2 uncommitted paths in %s: %s is not the tree that would be measured. "
                       "A3_EXIT_ANY_TREE=1 runs it anyway, and the result is then never a pass\n" % (tree.repo, tree.sha))
        assert not os.path.exists(where) and not os.path.exists(os.path.join(stub, "calls.log"))
        code, out, err, _ = tree.run(stub, A3_EXIT_ANY_TREE="1")
        said = "2 uncommitted paths: A3_EXIT_ANY_TREE=1, never a pass"
        assert (code, _last(out), err) == (1, _fail(tree=said), ""), out + err
        assert "uncommitted 2 paths\n" in out and E1_SAME in out and E2_SAME in out
        for given in ({"A3_EXIT_ANY_TREE": "yes"}, {"A3_EXIT_ANY_NODE": "1"}):
            code, out, err, _ = tree.run(tree.scenario(), **given)
            assert (code, out) == (2, ""), given
    finally:
        os.remove(stray)
        subprocess.run(["git", "-C", tree.repo, "checkout", "-q", "--", ".nvmrc"], check=True)
    assert subprocess.run(["git", "-C", tree.repo, "status", "--porcelain"], check=True, capture_output=True,
                          text=True).stdout == ""


def test_a_checkout_git_cannot_read_is_refused(tree):
    stub = tree.scenario()
    code, out, err, where = tree.run(stub, GIT_DIR=os.path.join(stub, "no-such-git-dir"))
    assert (code, out) == (2, "") and "a3-exit.sh: git cannot read %s" % tree.repo in err
    assert not os.path.exists(where)


# ---------------------------------------------------------------------------------------------- OUT_DIR, usage

def test_out_dir_inside_the_checkout_is_refused_and_not_made(tree):
    stub = tree.scenario()
    for inside in (os.path.join(tree.repo, "inside", "out"), tree.repo,
                   os.path.join(tree.repo, "scripts", "ci-telemetry"),
                   os.path.join(stub, "..", "repo", "inside")):
        code, out, err, _ = tree.run(stub, out=inside)
        assert (code, out) == (2, ""), inside
        assert "is inside the checkout: give a directory outside it" in err
    assert not os.path.exists(os.path.join(tree.repo, "inside"))
    assert subprocess.run(["git", "-C", tree.repo, "status", "--porcelain"], check=True, capture_output=True,
                          text=True).stdout == ""
    # a path that climbs back down into the checkout through a part that is not there yet cannot be resolved here
    code, out, err, _ = tree.run(stub, out=os.path.join(stub, "new", "..", "..", "repo", "inside"))
    assert (code, out) == (2, "") and "has .. in a part that is not there yet" in err
    assert not os.path.exists(os.path.join(stub, "new")) and not os.path.exists(os.path.join(tree.repo, "inside"))
    assert not os.path.exists(os.path.join(stub, "calls.log"))


def test_a_wrong_command_line_or_no_vitest_is_refused(tree):
    stub = tree.scenario()
    for args in ([], ["a", "b"], [""]):
        code, out, err, _ = tree.run(stub, args=args)
        assert (code, out, err) == (2, "", "usage: a3-exit.sh OUT_DIR\n"), args
    vitest = os.path.join(tree.repo, "node_modules", ".bin", "vitest")
    os.rename(vitest, vitest + ".away")
    try:
        code, out, err, where = tree.run(stub)
        assert (code, out) == (2, "") and err == "a3-exit.sh: no %s: run npm ci first\n" % vitest
        assert not os.path.exists(where)
    finally:
        os.rename(vitest + ".away", vitest)
