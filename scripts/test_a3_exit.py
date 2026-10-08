"""scripts/ci-telemetry/a3-exit.py, the comparers of the A3 trial's two exit checks.

Run: python3 -m pytest -q scripts/test_a3_exit.py

e1 reads the tests.jsonl of scripts/ci-telemetry/a3-exit-recorder.mjs; e2 reads istanbul coverage-final.json files.
Most inputs below are built in the test from the smallest thing that has the shape, then changed the way a second
environment or a second run could differ from it, and what the command prints and exits with is held.

REAL OUTPUT. scripts/fixtures/a3-exit/ is cut from one real invocation of a3-exit.sh (commit 41e6eddc, Node
v26.4.0, vitest 4.1.11, vite 8.2.2; runs e2-jsdom-a and e2-node-a), paths re-rooted at /repo and nothing else
changed, because the real maps hold shapes a built one would not think of:
  coverage-jsdom.json, coverage-node.json   three files of each run:
    scripts/ci-telemetry/vitest-test-ids-reporter.mjs   whole. 47 statements against 46: jsdom's extra one is the
                                                        generated import glue of its one named node: binding
    lambda/findings/engine/assertion.js                 whole. Every statement ends in a null column, and three of
                                                        its six branch arms have no location of their own
    lambda/preservation/batchBuilderRoutes.js           CUT to the one statement on its line 79: the same call in
                                                        both maps, open-ended in jsdom's and closed in node's
  node-imports.json                                     the `import … from 'node:…'` lines those sources had
The wrapper is held in scripts/test_a3_exit_sh.py; the counter, recorder and config in
scripts/ci-telemetry/a3-exit-fixture.test.js.
"""
import copy
import importlib.util
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "ci-telemetry", "a3-exit.py")
FIXTURES = os.path.join(HERE, "fixtures", "a3-exit")

_spec = importlib.util.spec_from_file_location("a3_exit", SCRIPT)
a3 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(a3)


# ---------------------------------------------------------------------------------------------------------- e1

TESTS = [("lambda/a.test.js", "adds", "passed", 3), ("lambda/a.test.js", "adds again", "passed", 0),
         ("lambda/b.test.js", "group > later", "skipped", None), ("scripts/c.test.js", "holds", "passed", 12)]


def _jsonl(env, tests, header=None, uncollected=(), dom=None):
    """A tests.jsonl. `dom`: what every test that ran read of the environment (default: what `env` gives)."""
    head = {"a3_exit": 2, "env": env, "files": len({t[0] for t in tests}), "tests": len(tests), "left_out": [],
            "notes": ["a test that asserts only with node:assert reads 0"]}
    head.update(header or {})
    saw = (env == "jsdom") if dom is None else dom
    rows = [head] + [{"file": f, "name": n, "state": s, "assertionCalls": c, "dom": saw if s in a3.RAN else None}
                     for f, n, s, c in tests]
    rows += [{"file": f, "name": None, "state": "failed", "assertionCalls": None, "dom": None} for f in uncollected]
    return "".join(json.dumps(row) + "\n" for row in rows)


def _e1(tmp_path, capsys, jsdom, node):
    paths = []
    for name, text in (("jsdom.jsonl", jsdom), ("node.jsonl", node)):
        path = tmp_path / name
        if text is None:
            path.unlink(missing_ok=True)
        else:
            path.write_text(text, encoding="utf-8")
        paths.append(str(path))
    code = a3.main(["a3-exit.py", "e1"] + paths)
    out = capsys.readouterr().out
    return code, out, out.rstrip("\n").split("\n")[-1]


def test_e1_same_tests_same_counts_is_same(tmp_path, capsys):
    left = {"left_out": ["scripts/ci-telemetry/vitest-projects.test.js"]}
    code, out, last = _e1(tmp_path, capsys, _jsonl("jsdom", TESTS, header=left), _jsonl("node", TESTS, header=left))
    assert (code, last) == (0, "E1-SAME (4 tests, 15 assertions each side)")
    assert "jsdom 4 tests in 3 files; 15 assertions; 1 zero-assertion tests; 1 never ran" in out
    assert "node  4 tests in 3 files; 15 assertions; 1 zero-assertion tests; 1 never ran" in out
    assert "zero-assertion tests: the same 1 on both sides" in out and "lambda/a.test.js :: adds again" in out
    assert "note: a test that asserts only with node:assert reads 0" in out
    assert out.count("        left out by the config: scripts/ci-telemetry/vitest-projects.test.js\n") == 2
    assert "two environments: every test that ran had a document on the jsdom side, and none on the node side" in out


def test_e1_a_different_count_differs_and_names_the_test(tmp_path, capsys):
    node = [TESTS[0][:3] + (2,)] + TESTS[1:]
    code, out, last = _e1(tmp_path, capsys, _jsonl("jsdom", TESTS), _jsonl("node", node))
    assert (code, last) == (1, "E1-DIFFER (1 tests differ or are on one side only, 0 files collected no test)")
    assert "differs: lambda/a.test.js :: adds\n    jsdom: passed, 3 assertions\n    node:  passed, 2 assertions" in out
    assert out.count("differs:") == 1


def test_e1_a_different_state_with_the_same_count_differs(tmp_path, capsys):
    node = [TESTS[0][:2] + ("failed", 3)] + TESTS[1:]
    code, out, last = _e1(tmp_path, capsys, _jsonl("jsdom", TESTS), _jsonl("node", node))
    assert code == 1 and last.startswith("E1-DIFFER (1 tests")
    assert "jsdom: passed, 3 assertions\n    node:  failed, 3 assertions" in out


def test_e1_a_failed_test_is_a_test_that_ran(tmp_path, capsys):
    failed = [TESTS[0], TESTS[1][:2] + ("failed", 0)] + TESTS[2:]
    code, out, last = _e1(tmp_path, capsys, _jsonl("jsdom", failed), _jsonl("node", failed))
    assert (code, last) == (0, "E1-SAME (4 tests, 15 assertions each side)")  # the wrapper adds RUNS-RED
    assert "jsdom 4 tests in 3 files; 15 assertions; 1 zero-assertion tests; 1 never ran (skipped, todo); 1 failed" in out
    assert "zero-assertion tests: the same 1 on both sides\n    lambda/a.test.js :: adds again" in out


def test_e1_a_test_on_one_side_only_differs_from_either_side(tmp_path, capsys):
    for jsdom, node, said in ((TESTS, TESTS[:-1], "jsdom: passed, 12 assertions\n    node:  not there"),
                              (TESTS[:-1], TESTS, "jsdom: not there\n    node:  passed, 12 assertions")):
        code, out, last = _e1(tmp_path, capsys, _jsonl("jsdom", jsdom), _jsonl("node", node))
        assert code == 1 and last.startswith("E1-DIFFER (1 tests"), out
        assert "differs: scripts/c.test.js :: holds\n    " + said in out


def test_e1_a_name_used_twice_in_a_file_is_matched_by_its_place(tmp_path, capsys):
    twice = TESTS + [("lambda/a.test.js", "adds", "passed", 7)]
    code, _, last = _e1(tmp_path, capsys, _jsonl("jsdom", twice), _jsonl("node", twice))
    assert (code, last) == (0, "E1-SAME (5 tests, 22 assertions each side)")
    node = TESTS + [("lambda/a.test.js", "adds", "passed", 6)]
    code, out, _ = _e1(tmp_path, capsys, _jsonl("jsdom", twice), _jsonl("node", node))
    assert code == 1 and "differs: lambda/a.test.js :: adds (#2 of that name)" in out and out.count("differs:") == 1


def test_e1_zero_assertion_tests_that_are_not_the_same_tests_are_said(tmp_path, capsys):
    node = [TESTS[0][:3] + (0,), TESTS[1][:3] + (3,)] + TESTS[2:]
    code, out, _ = _e1(tmp_path, capsys, _jsonl("jsdom", TESTS), _jsonl("node", node))
    assert code == 1 and "zero-assertion tests: NOT the same tests on the two sides" in out


def test_e1_a_file_that_collected_no_test_differs_even_on_both_sides(tmp_path, capsys):
    both = _e1(tmp_path, capsys, _jsonl("jsdom", TESTS, uncollected=["lambda/x.test.js"]),
               _jsonl("node", TESTS, uncollected=["lambda/x.test.js"]))
    assert both[0] == 1 and both[2] == "E1-DIFFER (0 tests differ or are on one side only, 1 files collected no test)"
    assert "collected no test: lambda/x.test.js (jsdom yes, node yes)" in both[1]
    one = _e1(tmp_path, capsys, _jsonl("jsdom", TESTS), _jsonl("node", TESTS, uncollected=["lambda/x.test.js"]))
    assert one[0] == 1 and "collected no test: lambda/x.test.js (jsdom no, node yes)" in one[1]


def test_e1_an_empty_side_is_unreadable_never_same(tmp_path, capsys):
    for jsdom, node in (("", _jsonl("node", TESTS)), (_jsonl("jsdom", TESTS), ""), ("", ""),
                        (_jsonl("jsdom", []), _jsonl("node", [])), (_jsonl("jsdom", TESTS), _jsonl("node", [])),
                        ("\n\n", "\n\n")):
        code, out, last = _e1(tmp_path, capsys, jsdom, node)
        assert code == 2 and last.startswith("E1-UNREADABLE: "), (jsdom[:40], node[:40], out)
        assert "E1-SAME" not in out
    code, out, last = _e1(tmp_path, capsys, _jsonl("jsdom", TESTS), _jsonl("node", []))
    assert code == 2 and last.endswith("node.jsonl: no test in it")


def test_e1_a_side_the_counter_did_not_count_is_unreadable_never_same(tmp_path, capsys):
    """A test that ran and carries no count, or a whole side that adds up to 0: the counter was not there."""
    uncounted = [test[:3] + (None,) for test in TESTS]
    one_null = [TESTS[0][:3] + (None,)] + TESTS[1:]
    failed_null = [TESTS[0][:2] + ("failed", None)] + TESTS[1:]
    for tests in (uncounted, one_null, failed_null):
        code, out, last = _e1(tmp_path, capsys, _jsonl("jsdom", tests), _jsonl("node", tests))
        assert code == 2 and last.startswith("E1-UNREADABLE: ") and "a test that ran carries no count" in last, out
        code, out, last = _e1(tmp_path, capsys, _jsonl("jsdom", TESTS), _jsonl("node", tests))
        assert code == 2 and "node.jsonl: a test that ran carries no count" in last
    zeros = [test[:3] + (None if test[3] is None else 0,) for test in TESTS]
    for jsdom, node, where in ((zeros, zeros, "jsdom.jsonl"), (TESTS, zeros, "node.jsonl")):
        code, out, last = _e1(tmp_path, capsys, _jsonl("jsdom", jsdom), _jsonl("node", node))
        assert code == 2 and last.startswith("E1-UNREADABLE: ") and where in last, out
        assert "its 4 tests made 0 assertions in all: nothing was counted" in last and "E1-SAME" not in out


def test_e1_the_two_sides_have_to_be_shown_to_be_two_environments(tmp_path, capsys):
    """jsdom against jsdom under two labels would read SAME: every test that ran says whether it had a document."""
    code, out, last = _e1(tmp_path, capsys, _jsonl("jsdom", TESTS), _jsonl("node", TESTS, dom=True))
    assert code == 2 and last == ("E1-VACUOUS: 3 tests on the node side ran with a document (first: "
                                  "lambda/a.test.js :: adds): the two sides are not shown to be two environments")
    assert "E1-SAME" not in out
    code, out, last = _e1(tmp_path, capsys, _jsonl("jsdom", TESTS, dom=False), _jsonl("node", TESTS))
    assert code == 2 and last.startswith("E1-VACUOUS: 3 tests on the jsdom side ran without a document (first: ")
    # one test is enough
    one = _jsonl("node", TESTS).replace('"assertionCalls": 12, "dom": false', '"assertionCalls": 12, "dom": true')
    code, out, last = _e1(tmp_path, capsys, _jsonl("jsdom", TESTS), one)
    assert code == 2 and last.startswith("E1-VACUOUS: 1 tests on the node side ran with a document (first: "
                                         "scripts/c.test.js :: holds)")
    # a test that ran and carries no reading was not read at all
    none = _jsonl("node", TESTS).replace('"assertionCalls": 12, "dom": false', '"assertionCalls": 12, "dom": null')
    code, out, last = _e1(tmp_path, capsys, _jsonl("jsdom", TESTS), none)
    assert code == 2 and last.startswith("E1-UNREADABLE: ") and "carries no reading of the environment" in last


def test_e1_a_missing_or_malformed_file_is_unreadable(tmp_path, capsys):
    good = _jsonl("jsdom", TESTS)
    code, out, last = _e1(tmp_path, capsys, good, None)
    assert code == 2 and last.startswith("E1-UNREADABLE: ") and "node.jsonl" in last
    for bad in ("not json\n", _jsonl("node", TESTS) + "{cut", json.dumps({"file": "a", "name": "b"}) + "\n",
                _jsonl("node", TESTS).replace('"assertionCalls": 12', '"assertionCalls": "12"'),
                _jsonl("node", TESTS).replace('"assertionCalls": 12', '"assertionCalls": true'),
                _jsonl("node", TESTS).replace('"state": "skipped", ', ""),
                _jsonl("node", TESTS).replace(', "assertionCalls": 12', ""),
                _jsonl("node", TESTS).replace('"name": "holds", ', ""),
                _jsonl("node", TESTS).replace('"name": "holds"', '"name": ["holds"]'),
                _jsonl("node", TESTS).replace(', "dom": false}', "}", 1),
                _jsonl("node", TESTS).replace('"dom": false', '"dom": "no"', 1)):
        code, out, last = _e1(tmp_path, capsys, good, bad)
        assert code == 2 and last.startswith("E1-UNREADABLE: ") and "Error" not in last, bad[-80:]
    headless = "".join(line + "\n" for line in _jsonl("node", TESTS).split("\n")[1:-1])
    code, out, last = _e1(tmp_path, capsys, good, headless)
    assert code == 2 and "no header line" in last
    # the format before `dom` was added
    code, out, last = _e1(tmp_path, capsys, good, _jsonl("node", TESTS, header={"a3_exit": 1}))
    assert code == 2 and "no header line of format 2" in last


def test_e1_a_file_cut_short_is_unreadable(tmp_path, capsys):
    cut = "".join(line + "\n" for line in _jsonl("node", TESTS).split("\n")[:-2])
    code, _, last = _e1(tmp_path, capsys, _jsonl("jsdom", TESTS), cut)
    assert code == 2 and "its header counts 4 tests and it holds 3" in last


def test_e1_the_two_sides_must_be_the_environments_they_are_given_as(tmp_path, capsys):
    code, _, last = _e1(tmp_path, capsys, _jsonl("node", TESTS), _jsonl("jsdom", TESTS))
    assert code == 2 and "its header says env 'node', want 'jsdom' here" in last
    code, _, last = _e1(tmp_path, capsys, _jsonl("jsdom", TESTS), _jsonl("jsdom", TESTS))
    assert code == 2 and "its header says env 'jsdom', want 'node' here" in last


# ---------------------------------------------------------------------------------------------------------- e2

ROOT = "/repo"


def _loc(line, col=0, end_line=None, end_col=20):
    return {"start": {"line": line, "column": col}, "end": {"line": end_line or line, "column": end_col}}


def _line(loc):
    return ((loc or {}).get("start") or {}).get("line")


def _file(statements=(), functions=(), branches=()):
    """statements / functions: [(location, hits)]; branches: [(location, [(arm location, hits)])]."""
    cov = {"path": "x", "statementMap": {}, "s": {}, "fnMap": {}, "f": {}, "branchMap": {}, "b": {}}
    for index, (loc, hits) in enumerate(statements):
        cov["statementMap"][str(index)], cov["s"][str(index)] = loc, hits
    for index, (loc, hits) in enumerate(functions):
        cov["fnMap"][str(index)] = {"name": "(anonymous_%d)" % index, "decl": loc, "loc": loc, "line": _line(loc)}
        cov["f"][str(index)] = hits
    for index, (loc, arms) in enumerate(branches):
        cov["branchMap"][str(index)] = {"type": "if", "loc": loc, "line": _line(loc),
                                        "locations": [arm for arm, _ in arms]}
        cov["b"][str(index)] = [hits for _, hits in arms]
    return cov


def _engine(arm_hits=(4, 0), statement_hits=(1, 2, 0), function_hits=(1,)):
    return _file(statements=[(_loc(1), statement_hits[0]), (_loc(2), statement_hits[1]), (_loc(3), statement_hits[2])],
                 functions=[(_loc(2, 0, 9, 1), function_hits[0])],
                 branches=[(_loc(5, 2, 7, 3), [(_loc(5, 10, 6, 3), arm_hits[0]), (_loc(7, 2, 7, 3), arm_hits[1])])])


def _run(**files):
    """A coverage-final.json: {absolute path: file coverage}. Keyword `lambda_x` is the file lambda/x.js."""
    return {"%s/%s.js" % (ROOT, name.replace("_", "/")): cov for name, cov in files.items()}


BASE = _run(lambda_engine=_engine(), scripts_tool=_file(statements=[(_loc(1), 1)]))
# The control: what the setup file alone loads under jsdom. One module, its first statement covered.
LOADED = ROOT + "/src/lib/pageScroll.js"
CONTROL = {LOADED: _file(statements=[(_loc(1), 1), (_loc(2), 0), (_loc(3), 0)])}


def _e2(tmp_path, capsys, jsdom_a, jsdom_b, node_a, node_b, control=CONTROL, extra=(), loads=True):
    """Runs e2. `loads`: the two jsdom runs also hold what the control holds, as two real jsdom runs do."""
    paths = []
    for name, data in (("jsdom-a", jsdom_a), ("jsdom-b", jsdom_b), ("node-a", node_a), ("node-b", node_b),
                       ("setup", control)):
        if loads and name.startswith("jsdom") and isinstance(data, dict) and data and isinstance(control, dict):
            data = dict(control, **data)
        path = tmp_path / (name + ".json")
        if data is None:
            path.unlink(missing_ok=True)
        else:
            path.write_text(data if isinstance(data, str) else json.dumps(data), encoding="utf-8")
        paths.append(str(path))
    code = a3.main(["a3-exit.py", "e2"] + paths[:4] + ["--setup-loads", paths[4]] + list(extra))
    out = capsys.readouterr().out
    return code, out, out.rstrip("\n").split("\n")[-1]


def _with(**files):
    return dict(BASE, **_run(**files))


def _same(items, files=2, shared=0, glue=0):
    return "E2-SAME (%d items in %d files; 0 not compared; %d files under a shared reading; %d generated import " \
           "glue)" % (items, files, shared, glue)


def _differ(count, files=1, items=0, left=0):
    return "E2-DIFFER (%d differences in %d files; %d items in %d files not compared)" % (count, files, items, left)


def test_e2_four_equal_runs_are_same(tmp_path, capsys):
    code, out, last = _e2(tmp_path, capsys, BASE, BASE, BASE, BASE)
    assert (code, last) == (0, _same(7))  # 3 statements, 1 function, 2 arms; 1 statement
    assert "  runs: jsdom A 3 files; jsdom B 3 files; node A 2 files; node B 2 files\n" in out
    assert "files: 2 in all four runs, 1 in one environment only, 0 in 1 of an environment's 2 runs" in out
    assert "same under a shared reading (the runs of an environment disagree on the file; one jsdom run and one " \
           "node run agree item for item): 0 files" in out
    assert "  not compared: 0 items in 0 files\n  items: 7 compared in 2 files\n" in out
    assert "  differences: 0 in 0 files\n" in out


def test_e2_hit_counts_do_not_decide_and_a_count_that_moves_with_the_environment_is_printed(tmp_path, capsys):
    busier = _with(lambda_engine=_engine(arm_hits=(900, 0), statement_hits=(7, 7, 0), function_hits=(3,)))
    code, out, last = _e2(tmp_path, capsys, BASE, BASE, busier, busier)
    assert (code, last) == (0, _same(7))
    assert "  hit count differs, covered-ness the same (the same count in both runs of each environment, not the " \
           "same between them; not counted): 4 items in 1 files: lambda/engine.js 4\n" in out
    # a count that also moves inside an environment is not that class: it moves by itself
    moving = _with(lambda_engine=_engine(arm_hits=(901, 0), statement_hits=(7, 7, 0), function_hits=(3,)))
    for runs in ((BASE, BASE, busier, moving), (busier, moving, BASE, BASE)):
        code, out, last = _e2(tmp_path, capsys, *runs)
        assert (code, last) == (0, _same(7)) and "not counted): 3 items in 1 files: lambda/engine.js 3\n" in out
    code, out, last = _e2(tmp_path, capsys, BASE, BASE, BASE, BASE)
    assert "not counted): 0 items in 0 files\n" in out


def test_e2_a_difference_counts_for_each_kind_with_its_line(tmp_path, capsys):
    for changed, said in ((_engine(arm_hits=(4, 1)), "line 7, branch arm: jsdom not covered, node covered"),
                          (_engine(arm_hits=(0, 0)), "line 5, branch arm: jsdom covered, node not covered"),
                          (_engine(statement_hits=(1, 2, 5)), "line 3, statement: jsdom not covered, node covered"),
                          (_engine(function_hits=(0,)), "line 2, function: jsdom covered, node not covered")):
        node = _with(lambda_engine=changed)
        code, out, last = _e2(tmp_path, capsys, BASE, BASE, node, node)
        assert (code, last) == (1, _differ(1)), out
        assert "  differences: 1 in 1 files\n    lambda/engine.js: 1\n      " + said in out


def test_e2_both_runs_of_each_environment_agreeing_and_the_environments_not_is_a_difference(tmp_path, capsys):
    """The limit of two runs, held as the rule it is: a file with two readings from one tree that gives one to
    both jsdom runs and the other to both node runs cannot be told from code that ran differently."""
    other = _with(lambda_engine=_engine(arm_hits=(0, 3), statement_hits=(1, 2, 4)))
    code, out, last = _e2(tmp_path, capsys, BASE, BASE, other, other)
    assert (code, last) == (1, _differ(3)), out
    assert "same under a shared reading" in out and "): 0 files" in out


def test_e2_a_file_whose_runs_disagree_is_compared_reading_to_reading(tmp_path, capsys):
    flipped = _with(lambda_engine=_engine(arm_hits=(4, 1)))
    for runs, pair, readings in (
            ((BASE, BASE, BASE, flipped), "jsdom A and node A",
             "jsdom A 4 of 6 covered, B 4 of 6 (its runs agree); node A 4 of 6 covered, B 5 of 6 (its runs DISAGREE)"),
            ((BASE, BASE, flipped, BASE), "jsdom A and node B",
             "jsdom A 4 of 6 covered, B 4 of 6 (its runs agree); node A 5 of 6 covered, B 4 of 6 (its runs DISAGREE)"),
            ((flipped, BASE, BASE, BASE), "jsdom B and node A",
             "jsdom A 5 of 6 covered, B 4 of 6 (its runs DISAGREE); node A 4 of 6 covered, B 4 of 6 (its runs agree)"),
            ((BASE, flipped, flipped, BASE), "jsdom A and node B",
             "jsdom A 4 of 6 covered, B 5 of 6 (its runs DISAGREE); node A 5 of 6 covered, B 4 of 6 (its runs "
             "DISAGREE)")):
        code, out, last = _e2(tmp_path, capsys, *runs)
        assert (code, last) == (0, _same(7, shared=1)), out
        assert "run agree item for item): 1 files\n    lambda/engine.js: %s; %s agree on all 6 items compared, " \
               "identical hit for hit\n" % (readings, pair) in out
        assert "  not compared: 0 items in 0 files\n  items: 7 compared in 2 files\n" in out


def test_e2_a_shared_reading_is_the_pair_that_agrees_hit_for_hit_when_there_is_one(tmp_path, capsys):
    flipped = _with(lambda_engine=_engine(arm_hits=(4, 1)))
    busier = _with(lambda_engine=_engine(arm_hits=(900, 0)))   # BASE's reading, another count
    code, out, last = _e2(tmp_path, capsys, BASE, flipped, busier, flipped)
    assert (code, last) == (0, _same(7, shared=1)), out
    assert "; jsdom B and node B agree on all 6 items compared, identical hit for hit\n" in out
    # and when the only pair that agrees does so with other counts, that is said
    again = _with(lambda_engine=_engine(arm_hits=(4, 2)))      # flipped's reading, another count
    code, out, last = _e2(tmp_path, capsys, BASE, BASE, busier, again)
    assert (code, last) == (0, _same(7, shared=1)), out
    assert "; jsdom A and node A agree on all 6 items compared, 1 hit counts differ\n" in out


def test_e2_no_shared_reading_is_inconclusive_never_same_and_never_a_difference(tmp_path, capsys):
    one = _with(lambda_engine=_engine(arm_hits=(4, 1)))
    two = _with(lambda_engine=_engine(statement_hits=(1, 2, 9)))
    three = _with(lambda_engine=_engine(statement_hits=(0, 0, 0), function_hits=(0,)))
    code, out, last = _e2(tmp_path, capsys, BASE, one, two, three)
    assert (code, last) == (3, "E2-INCONCLUSIVE (6 items in 1 files not compared)"), out
    assert "E2-SAME" not in out and "  differences: 0 in 0 files\n" in out
    assert "  not compared: 6 items in 1 files\n    no shared reading: lambda/engine.js: jsdom A 4 of 6 covered, B 5 " \
           "of 6 (its runs DISAGREE); node A 5 of 6 covered, B 1 of 6 (its runs DISAGREE); closest are jsdom A and " \
           "node A, 1 items differ\n      line 3, statement: jsdom not covered, node covered\n" in out
    assert "  items: 1 compared in 1 files\n" in out
    # with a difference elsewhere the verdict is DIFFER, and the line still says what was not compared
    for run in (one, two, three):
        run[ROOT + "/scripts/tool.js"] = _file(statements=[(_loc(1), 0)])
    code, out, last = _e2(tmp_path, capsys, BASE, dict(one, **{ROOT + "/scripts/tool.js": BASE[ROOT + "/scripts/tool.js"]}),
                          two, three)
    assert (code, last) == (1, _differ(1, items=6, left=1)), out


def test_e2_matching_is_by_location_not_by_index(tmp_path, capsys):
    shuffled = _engine()
    shuffled["statementMap"] = {"7": _loc(3), "8": _loc(1), "9": _loc(2)}
    shuffled["s"] = {"7": 0, "8": 1, "9": 2}
    node = _with(lambda_engine=shuffled)
    code, out, last = _e2(tmp_path, capsys, BASE, BASE, node, node)
    assert (code, last) == (0, _same(7))
    assert "different extents; not a difference): 0 pairs in 0 files" in out


def test_e2_two_items_at_one_location_stay_two(tmp_path, capsys):
    twin = _engine()
    twin["statementMap"]["3"], twin["s"]["3"] = _loc(3), 1   # line 3 a second time, this one covered
    both = _with(lambda_engine=twin)
    code, _, last = _e2(tmp_path, capsys, both, both, both, both)
    assert (code, last) == (0, _same(8))


def test_e2_an_item_only_one_run_has_makes_the_file_a_file_whose_runs_disagree(tmp_path, capsys):
    extra = _engine()
    extra["statementMap"]["3"], extra["s"]["3"] = _loc(11), 1
    item = _with(lambda_engine=extra)
    for runs, pair in (((BASE, BASE, BASE, item), "jsdom A and node A"), ((BASE, BASE, item, BASE), "jsdom A and node B")):
        code, out, last = _e2(tmp_path, capsys, *runs)
        assert (code, last) == (0, _same(7, shared=1)), out
        assert "; %s agree on all 6 items compared, identical hit for hit\n" % pair in out
    # the same statement not covered: the runs still do not hold the same items, so it is still such a file, and
    # any pair agrees (an uncovered item one map holds is its own class)
    idle = copy.deepcopy(item)
    idle[ROOT + "/lambda/engine.js"]["s"]["3"] = 0
    for runs, alone in (((BASE, BASE, BASE, idle), 0), ((BASE, BASE, idle, BASE), 1), ((BASE, idle, BASE, BASE), 0),
                        ((idle, BASE, BASE, BASE), 1)):
        code, out, last = _e2(tmp_path, capsys, *runs)
        assert (code, last) == (0, _same(7, shared=1)), out
        assert "; jsdom A and node A agree on all 6 items compared, identical hit for hit\n" in out
        assert "(not a difference): %d items in %d files" % (alone, alone) in out


def test_e2_a_file_only_one_of_an_environments_two_runs_holds_is_not_compared(tmp_path, capsys):
    """A module one run loaded and its twin did not: nothing of it can be compared, and that is not SAME."""
    late = _with(lambda_late=_file(statements=[(_loc(1), 1), (_loc(2), 0)]))
    for runs, where in (((BASE, BASE, BASE, late), "in neither jsdom run and in 1 of 2 runs of node (B)"),
                        ((BASE, BASE, late, BASE), "in neither jsdom run and in 1 of 2 runs of node (A)"),
                        ((late, BASE, BASE, BASE), "in 1 of 2 runs of jsdom (A) and in neither node run"),
                        ((late, late, late, BASE), "in both jsdom runs and in 1 of 2 runs of node (A)"),
                        ((BASE, late, late, late), "in 1 of 2 runs of jsdom (B) and in both node runs")):
        code, out, last = _e2(tmp_path, capsys, *runs)
        assert (code, last) == (3, "E2-INCONCLUSIVE (2 items in 1 files not compared)"), out
        assert "files: 2 in all four runs, 1 in one environment only, 1 in 1 of an environment's 2 runs" in out
        assert "  not compared: 2 items in 1 files\n    in 1 of 2 runs: lambda/late.js: %s: 2 items\n" % where in out
        assert "E2-SAME" not in out


def test_e2_an_extent_only_mismatch_is_its_own_class_and_not_a_difference(tmp_path, capsys):
    wider = _engine()
    wider["statementMap"]["1"] = _loc(2, 0, 2, 45)   # line 2 again, ending further right
    wider["fnMap"]["0"]["loc"] = _loc(2, 4, 9, 1)    # the function, starting further right
    node = _with(lambda_engine=wider)
    code, out, last = _e2(tmp_path, capsys, BASE, BASE, node, node)
    assert (code, last) == (0, _same(7)), out
    assert "extent-only (same start line, same covered-ness, different extents; not a difference): 2 pairs in 1 " \
           "files: lambda/engine.js 2" in out


def test_e2_an_extent_only_pair_that_disagrees_is_a_difference(tmp_path, capsys):
    wider = _engine(statement_hits=(1, 0, 0))
    wider["statementMap"]["1"] = _loc(2, 0, 2, 45)
    node = _with(lambda_engine=wider)
    code, out, last = _e2(tmp_path, capsys, BASE, BASE, node, node)
    assert (code, last) == (1, _differ(1))
    assert "line 2, statement: jsdom covered, node not covered (extents differ)" in out
    assert "extent-only (same start line, same covered-ness, different extents; not a difference): 0 pairs" in out


def test_e2_two_unmatched_items_on_a_line_are_paired_in_the_order_of_their_extents_as_numbers(tmp_path, capsys):
    """Column 9 comes before column 100. As text it does not, and the pairs would cross."""
    def line_ten(first_col, first_hits, second_col, second_hits):
        return _with(lambda_engine=_file(statements=[(_loc(10, first_col, 10, first_col + 20), first_hits),
                                                    (_loc(10, second_col, 10, second_col + 20), second_hits)]))
    jsdom = line_ten(9, 1, 100, 0)
    code, out, last = _e2(tmp_path, capsys, jsdom, jsdom, line_ten(10, 1, 101, 0), line_ten(10, 1, 101, 0))
    assert (code, last) == (0, _same(3)), out
    assert "different extents; not a difference): 2 pairs in 1 files: lambda/engine.js 2" in out
    # the same two statements covered the other way round under node: two differences, not two crossed pairs
    code, out, last = _e2(tmp_path, capsys, jsdom, jsdom, line_ten(10, 0, 101, 1), line_ten(10, 0, 101, 1))
    assert (code, last) == (1, _differ(2)), out
    assert "      line 10, statement: jsdom covered, node not covered (extents differ)\n" in out
    assert "      line 10, statement: jsdom not covered, node covered (extents differ)\n" in out


def test_e2_an_item_in_one_map_only_counts_when_covered_and_is_its_own_class_when_not(tmp_path, capsys):
    extra = _engine()
    extra["statementMap"]["3"], extra["s"]["3"] = _loc(11), 1
    node = _with(lambda_engine=extra)
    code, out, last = _e2(tmp_path, capsys, BASE, BASE, node, node)
    assert (code, last) == (1, _differ(1))
    assert "line 11, statement: covered, in node's map only" in out
    code, out, last = _e2(tmp_path, capsys, node, node, BASE, BASE)
    assert code == 1 and "line 11, statement: covered, in jsdom's map only" in out
    extra["s"]["3"] = 0
    code, out, last = _e2(tmp_path, capsys, BASE, BASE, node, node)
    assert (code, last) == (0, _same(7))
    assert "not covered and in one environment's map only (not a difference): 1 items in 1 files: " \
           "lambda/engine.js 1" in out


def test_e2_a_line_with_a_different_number_of_unmatched_items_each_side_is_not_paired(tmp_path, capsys):
    two, one = _engine(), _engine()
    two["statementMap"]["3"], two["s"]["3"] = _loc(11, 0, 11, 8), 1
    two["statementMap"]["4"], two["s"]["4"] = _loc(11, 9, 11, 30), 1
    one["statementMap"]["3"], one["s"]["3"] = _loc(11, 0, 11, 30), 1
    jsdom, node = _with(lambda_engine=two), _with(lambda_engine=one)
    code, out, last = _e2(tmp_path, capsys, jsdom, jsdom, node, node)
    assert (code, last) == (1, _differ(3)), out
    assert out.count("line 11, statement: covered, in jsdom's map only") == 2
    assert out.count("line 11, statement: covered, in node's map only") == 1


def test_e2_a_file_in_one_environment_only_counts_what_both_its_runs_cover(tmp_path, capsys):
    more = _with(lambda_late=_file(statements=[(_loc(1), 1), (_loc(2), 0)], functions=[(_loc(4, 0, 6, 1), 2)]))
    for runs, env in (((BASE, BASE, more, more), "node"), ((more, more, BASE, BASE), "jsdom")):
        code, out, last = _e2(tmp_path, capsys, *runs)
        assert (code, last) == (1, _differ(2)), out
        assert "files: 2 in all four runs, 2 in one environment only" in out
        assert "    lambda/late.js: %s only, 2 covered items: counted\n" % env in out
        assert "line 1, statement: covered, the file is in %s only" % env in out
    # a file with nothing covered is still listed: a module one environment loaded and the other did not
    idle = _with(lambda_late=_file(statements=[(_loc(1), 0)]))
    code, out, last = _e2(tmp_path, capsys, BASE, BASE, idle, idle)
    assert (code, last) == (0, _same(7)) and "    lambda/late.js: node only, 0 covered items: counted\n" in out
    # an item one of its two runs covers and the other does not is not compared
    once = _with(lambda_late=_file(statements=[(_loc(1), 0), (_loc(2), 0)], functions=[(_loc(4, 0, 6, 1), 2)]))
    code, out, last = _e2(tmp_path, capsys, BASE, BASE, more, once)
    assert (code, last) == (1, _differ(1, items=1, left=1)), out
    assert "    lambda/late.js: node only, 1 covered items: counted; 1 covered in 1 of its 2 runs: not compared\n" in out
    code, out, last = _e2(tmp_path, capsys, BASE, BASE, idle, _with(lambda_late=_file(statements=[(_loc(1), 3)])))
    assert (code, last) == (3, "E2-INCONCLUSIVE (1 items in 1 files not compared)"), out


def test_e2_a_setup_loaded_file_is_excused_only_for_what_the_control_covered(tmp_path, capsys):
    """The control covers statement 1 of 3. A real jsdom run that covers more reached the module from a test."""
    code, out, last = _e2(tmp_path, capsys, BASE, BASE, BASE, BASE)
    assert (code, last) == (0, _same(7)), out
    assert "    src/lib/pageScroll.js: jsdom only, loaded by the setup file (in --setup-loads): 1 covered items, 0 " \
           "covered beyond the control: not counted\n" in out
    reached = dict(BASE, **{LOADED: _file(statements=[(_loc(1), 1), (_loc(2), 4), (_loc(3), 4)])})
    code, out, last = _e2(tmp_path, capsys, reached, reached, BASE, BASE)
    assert (code, last) == (1, _differ(2)), out
    assert "    src/lib/pageScroll.js: jsdom only, loaded by the setup file (in --setup-loads): 3 covered items, 2 " \
           "covered beyond the control: counted\n" in out
    assert out.count("statement: covered beyond the control (the setup file loads the file, under jsdom only)") == 2
    assert "      line 2, statement: covered beyond the control" in out and "      line 1, statement" not in out
    # beyond the control in one run only: not compared, so not SAME
    code, out, last = _e2(tmp_path, capsys, reached, BASE, BASE, BASE)
    assert (code, last) == (3, "E2-INCONCLUSIVE (2 items in 1 files not compared)"), out
    assert "0 covered beyond the control: not counted; 2 covered in 1 of its 2 runs: not compared\n" in out
    # a jsdom-only file the control does not hold is not excused at all
    other = dict(BASE, **{ROOT + "/src/lib/backNav.js": _file(statements=[(_loc(1), 1)])})
    code, out, last = _e2(tmp_path, capsys, other, other, BASE, BASE)
    assert (code, last) == (1, _differ(1)), out
    assert "    src/lib/backNav.js: jsdom only, 1 covered items: counted\n" in out


def test_e2_the_four_inputs_have_to_be_shown_to_be_two_environments(tmp_path, capsys):
    """One coverage file given four times reads SAME item for item. What the setup file loads is the proof: it is
    in a jsdom run and never in a node run."""
    code, out, last = _e2(tmp_path, capsys, BASE, BASE, BASE, BASE)
    assert "  two environments: the 1 files the setup file loads (--setup-loads) are in both jsdom runs and in " \
           "neither node run\n" in out
    said = "E2-VACUOUS: the setup file loads src/lib/pageScroll.js (it is in --setup-loads), so it belongs in both " \
           "jsdom runs and in neither node run, and it is %s: nothing shows the two sides are two environments"
    everywhere = dict(CONTROL, **BASE)
    for runs, loads, wrong in (((BASE, BASE, BASE, BASE), False, "not in jsdom A and not in jsdom B"),
                               ((everywhere, everywhere, everywhere, everywhere), True, "in node A and in node B"),
                               ((everywhere, BASE, BASE, BASE), False, "not in jsdom B"),
                               ((BASE, BASE, BASE, everywhere), True, "in node B")):
        code, out, last = _e2(tmp_path, capsys, *runs, loads=loads)
        assert (code, last) == (2, said % wrong), out
        assert "E2-SAME" not in out


def test_e2_differences_are_counted_across_files(tmp_path, capsys):
    node = _with(lambda_engine=_engine(arm_hits=(0, 1)), scripts_tool=_file(statements=[(_loc(1), 0)]))
    code, out, last = _e2(tmp_path, capsys, BASE, BASE, node, node)
    assert (code, last) == (1, _differ(3, files=2))
    assert "    lambda/engine.js: 2\n" in out and "    scripts/tool.js: 1\n" in out


def test_e2_an_empty_or_unreadable_input_is_unreadable_never_same(tmp_path, capsys):
    for place in range(4):
        for bad, why in (({}, "no file in it"), (None, "No such file"), ("not json", "Expecting value"),
                         ("[]", "no file in it"), ({ROOT + "/lambda/engine.js": {"s": {}}}, "has no statementMap")):
            runs = [BASE, BASE, BASE, BASE]
            runs[place] = bad
            code, out, last = _e2(tmp_path, capsys, *runs, loads=bad != {ROOT + "/lambda/engine.js": {"s": {}}})
            assert code == 2 and last.startswith("E2-UNREADABLE: ") and why in last, (place, bad, out)
            assert "E2-SAME" not in out
    for control in ("not json", {}, None):
        code, out, last = _e2(tmp_path, capsys, BASE, BASE, BASE, BASE, control=control)
        assert code == 2 and last.startswith("E2-UNREADABLE: ") and "setup.json" in last


def test_e2_json_that_is_not_the_reporters_shape_is_unreadable_and_never_a_traceback(tmp_path, capsys):
    def broken(change):
        cov = _engine()
        change(cov)
        return _with(lambda_engine=cov)

    def short_hits(cov):
        cov["b"]["0"] = [4]

    for change, why in ((lambda cov: cov["s"].update({"0": None}), "statement 0 has no whole-number hit count"),
                        (lambda cov: cov["s"].update({"0": True}), "statement 0 has no whole-number hit count"),
                        (lambda cov: cov["s"].pop("0"), "statement 0 has no whole-number hit count"),
                        (lambda cov: cov["f"].update({"0": "1"}), "function 0 has no whole-number hit count"),
                        (lambda cov: cov["fnMap"].update({"0": [1]}), "function 0 is not an object"),
                        (lambda cov: cov["statementMap"].update({"0": [1, 2]}), "a location that is not an object"),
                        (lambda cov: cov["statementMap"].update({"0": {"start": {"line": "1"}}}),
                         "a location whose start is not {line, column} in whole numbers"),
                        (lambda cov: cov["statementMap"].update({"0": {"start": {"line": 1}, "end": 4}}),
                         "a location whose end is not {line, column} in whole numbers"),
                        (short_hits, "branch 0 has not one whole-number hit count for each of its arms"),
                        (lambda cov: cov["b"].update({"0": [4, None]}), "branch 0 has not one whole-number hit count"),
                        (lambda cov: cov["b"].update({"0": 4}), "branch 0 has not one whole-number hit count"),
                        (lambda cov: cov["branchMap"]["0"].pop("locations"), "branch 0 has not one whole-number hit"),
                        (lambda cov: cov["branchMap"].update({"0": "if"}), "branch 0 has not one whole-number hit"),
                        (lambda cov: cov["branchMap"]["0"]["locations"].__setitem__(1, "else"),
                         "a location that is not an object")):
        bad = broken(change)
        for runs in ((BASE, BASE, BASE, bad), (bad, BASE, BASE, BASE)):
            code, out, last = _e2(tmp_path, capsys, *runs)
            assert code == 2 and last.startswith("E2-UNREADABLE: ") and why in last, (why, out)
            assert "lambda/engine.js" in last and "Error" not in last


def test_a_failure_no_check_foresaw_is_unreadable_exit_2_never_a_traceback(tmp_path, capsys, monkeypatch):
    def boom(cov):
        raise RuntimeError("not foreseen")
    monkeypatch.setattr(a3, "items", boom)
    code, out, last = _e2(tmp_path, capsys, BASE, BASE, BASE, BASE)
    assert (code, last) == (2, "E2-UNREADABLE: RuntimeError: not foreseen")
    monkeypatch.setattr(a3, "read_tests", boom)
    code, out, last = _e1(tmp_path, capsys, _jsonl("jsdom", TESTS), _jsonl("node", TESTS))
    assert (code, last) == (2, "E1-UNREADABLE: TypeError: test_a_failure_no_check_foresaw_is_unreadable_exit_2_never_"
                               "a_traceback.<locals>.boom() takes 1 positional argument but 2 were given")


def test_e2_a_location_istanbul_left_empty_is_read_and_its_arm_takes_the_branchs_line(tmp_path, capsys):
    """An implicit else has no location of its own ({"start": {}, "end": {}}): it is still an arm, on the line of
    its branch."""
    def implicit(else_hits, branch_loc=_loc(5, 2, 7, 3)):
        return _with(lambda_engine=_file(
            statements=[(_loc(1), 1)], functions=[({"start": {"line": 2, "column": 0}}, 1)],
            branches=[(branch_loc, [(_loc(5, 10, 6, 3), 4), ({"start": {}, "end": {}}, else_hits)])]))
    code, out, last = _e2(tmp_path, capsys, implicit(0), implicit(0), implicit(0), implicit(0))
    assert (code, last) == (0, _same(5)), out
    code, out, last = _e2(tmp_path, capsys, implicit(0), implicit(0), implicit(2), implicit(2))
    assert (code, last) == (1, _differ(1)) and "      line 5, branch arm: jsdom not covered, node covered\n" in out
    # no location at all, of the branch or the arm: still an item, on no line
    nowhere = _with(lambda_engine=_file(statements=[(_loc(1), 1)], branches=[(None, [(None, 1), ({}, 0)])]))
    there = _with(lambda_engine=_file(statements=[(_loc(1), 1)], branches=[(None, [(None, 0), ({}, 0)])]))
    code, out, last = _e2(tmp_path, capsys, nowhere, nowhere, there, there)
    assert (code, last) == (1, _differ(1)) and "      line ?, branch arm: jsdom covered, node not covered\n" in out


def test_e2_environments_with_nothing_to_compare_are_unreadable(tmp_path, capsys):
    other = _run(lambda_other=_engine(), scripts_more=_file(statements=[(_loc(1), 1)]))
    code, _, last = _e2(tmp_path, capsys, BASE, BASE, other, other)
    assert code == 2 and "no file in common" in last
    hollow = _run(lambda_engine=_file(), scripts_tool=_file())
    code, out, last = _e2(tmp_path, capsys, hollow, hollow, hollow, hollow)
    assert (code, last) == (2, "E2-UNREADABLE: no item is in both environments' maps: nothing was compared")
    assert "E2-SAME" not in out


def test_e2_root_is_what_the_paths_share_or_what_it_is_told(tmp_path, capsys):
    elsewhere = {path.replace(ROOT, "/other/checkout"): cov for path, cov in BASE.items()}
    code, _, last = _e2(tmp_path, capsys, BASE, BASE, elsewhere, elsewhere)
    assert code == 2 and "no file in common" in last
    code, _, last = _e2(tmp_path, capsys, BASE, BASE, BASE, BASE, extra=["--root", ROOT])
    assert (code, last) == (0, _same(7))
    node = _with(lambda_engine=_engine(arm_hits=(4, 1)))
    code, out, _ = _e2(tmp_path, capsys, BASE, BASE, node, node, extra=["--root", "/"])
    assert code == 1 and "    repo/lambda/engine.js: 1\n" in out
    # a root is a directory, not a prefix of text: /repo2 is not under /repo
    beside = dict(BASE, **{"/repo2/lambda/engine.js": _engine()})
    changed = dict(BASE, **{"/repo2/lambda/engine.js": _engine(arm_hits=(4, 1))})
    for root in (ROOT, ROOT + "/"):
        code, out, _ = _e2(tmp_path, capsys, beside, beside, changed, changed, extra=["--root", root])
        assert code == 1 and "    /repo2/lambda/engine.js: 1\n" in out, out


# ------------------------------------------------------------------------------------- generated import glue

CRYPTO = "// a module\nimport { createHash } from 'node:crypto'\nexport const f = () => createHash('sha256')\n"
GLUE_44 = _loc(1, 19, 1, 63)   # as long as __vite__cjsImport0_node:crypto["createHash"]: 44


def _tree(tmp_path, **sources):
    """A checkout under tmp_path holding lambda/<name>.js for each source; returns its root."""
    root = tmp_path / "tree"
    (root / "lambda").mkdir(parents=True, exist_ok=True)
    for name, text in sources.items():
        (root / "lambda" / (name + ".js")).write_text(text, encoding="utf-8")
    return str(root)


def _glue_runs(root, glue, node_extra=(), body_hits=1, real_first_line=None):
    """(jsdom run, node run) of lambda/glue.js and lambda/plain.js under `root`. jsdom's map of glue.js holds the
    statements `glue` [(location, hits)] on top of what both maps hold."""
    body = [(_loc(3, 0, 3, 40), body_hits)] + ([real_first_line] if real_first_line else [])
    plain = _file(statements=[(_loc(1), 1)])
    jsdom = {root + "/lambda/glue.js": _file(statements=body + list(glue)), root + "/lambda/plain.js": plain,
             root + "/src/lib/pageScroll.js": CONTROL[LOADED]}
    node = {root + "/lambda/glue.js": _file(statements=body + list(node_extra)), root + "/lambda/plain.js": plain}
    return jsdom, node


def _glue(tmp_path, capsys, root, jsdom_a, jsdom_b, node):
    control = {root + "/src/lib/pageScroll.js": CONTROL[LOADED]}
    return _e2(tmp_path, capsys, jsdom_a, jsdom_b, node, node, control=control, extra=["--root", root], loads=False)


GLUE_LINE = "  generated import glue (line-1 statements only jsdom's map holds, as many as the file's named node: " \
            "import bindings; not counted): %s\n"
NOT_GLUE = "  line-1 statements only jsdom's map holds that are NOT glue (compared like any other item): 1 files\n" \
           "    lambda/glue.js: %s\n"


def test_e2_generated_import_glue_is_its_own_class_printed_and_not_counted(tmp_path, capsys):
    root = _tree(tmp_path, glue=CRYPTO)
    jsdom, node = _glue_runs(root, [(GLUE_44, 5)])
    code, out, last = _glue(tmp_path, capsys, root, jsdom, jsdom, node)
    assert (code, last) == (0, _same(2, glue=1)), out
    assert GLUE_LINE % "1 statements in 1 files: lambda/glue.js 1" in out and "NOT glue" not in out
    # an extent with no end (the import itself on line 1) is glue by the count alone
    jsdom, node = _glue_runs(root, [({"start": {"line": 1, "column": 9}, "end": {"line": 1, "column": None}}, 5)])
    code, out, last = _glue(tmp_path, capsys, root, jsdom, jsdom, node)
    assert (code, last) == (0, _same(2, glue=1)), out
    # no file with such a statement: the class is printed as empty
    code, out, last = _e2(tmp_path, capsys, BASE, BASE, BASE, BASE)
    assert GLUE_LINE % "0 statements in 0 files" in out


def test_e2_glue_is_counted_not_matched_so_its_reordering_between_runs_is_not_a_disagreement(tmp_path, capsys):
    """Two bindings; the generated statements swap places between two jsdom runs of one tree."""
    root = _tree(tmp_path, glue="import { readFileSync, existsSync } from 'node:fs'\nexport const f = 1\n")
    first = [(_loc(1, 10, 1, 52), 1), (_loc(1, 60, 1, 100), 1)]    # 42 then 40
    second = [(_loc(1, 10, 1, 50), 1), (_loc(1, 58, 1, 100), 1)]   # 40 then 42
    (jsdom_a, node), (jsdom_b, _) = _glue_runs(root, first), _glue_runs(root, second)
    code, out, last = _glue(tmp_path, capsys, root, jsdom_a, jsdom_b, node)
    assert (code, last) == (0, _same(2, glue=2)), out
    assert GLUE_LINE % "2 statements in 1 files: lambda/glue.js 2" in out
    assert "run agree item for item): 0 files\n" in out
    # an import index of two digits makes each one column longer
    longer = [(_loc(1, 10, 1, 53), 1), (_loc(1, 60, 1, 101), 1)]
    jsdom, node = _glue_runs(root, longer)
    code, out, last = _glue(tmp_path, capsys, root, jsdom, jsdom, node)
    assert (code, last) == (0, _same(2, glue=2)), out


def test_e2_anything_else_on_line_1_still_counts(tmp_path, capsys):
    root = _tree(tmp_path, glue=CRYPTO)

    def tried(glue, why, verdict, node_extra=(), source=None, jsdom_b=None):
        if source is not None:
            _tree(tmp_path, glue=source)
        jsdom, node = _glue_runs(root, glue, node_extra=node_extra)
        other = jsdom if jsdom_b is None else _glue_runs(root, jsdom_b, node_extra=node_extra)[0]
        code, out, last = _glue(tmp_path, capsys, root, jsdom, other, node)
        assert NOT_GLUE % why in out and GLUE_LINE % "0 statements in 0 files" in out, out
        assert (code, last) == verdict, out
        _tree(tmp_path, glue=CRYPTO)
        return out

    # one more statement than the source has bindings: all of them count
    out = tried([(GLUE_44, 5), (_loc(1, 70, 1, 114), 5)], "2 in jsdom A, 2 in jsdom B; its source imports 1 named "
                "bindings from node: builtins", (1, _differ(2)))
    assert out.count("      line 1, statement: covered, in jsdom's map only\n") == 2
    # the count has to hold in each jsdom run by itself
    for glue_a, glue_b, counts in (([(GLUE_44, 5), (_loc(1, 70, 1, 114), 5)], [(GLUE_44, 5)], "2 in jsdom A, 1 in jsdom B"),
                                   ([(GLUE_44, 5)], [(GLUE_44, 5), (_loc(1, 70, 1, 114), 5)], "1 in jsdom A, 2 in jsdom B")):
        tried(glue_a, counts + "; its source imports 1 named bindings from node: builtins",
              (3, "E2-INCONCLUSIVE (3 items in 1 files not compared)"), jsdom_b=glue_b)
    # two statements as long as ONE of the source's two bindings: each binding answers for one statement
    two = "import { readFileSync, existsSync } from 'node:fs'\nexport const f = 1\n"
    tried([(_loc(1, 10, 1, 52), 1), (_loc(1, 60, 1, 102), 1)], "2 in jsdom A, 2 in jsdom B; an extent is not one "
          "generated initializer of a binding long", (1, _differ(2)), source=two)
    # a source with no such import
    tried([(GLUE_44, 5)], "1 in jsdom A, 1 in jsdom B; its source imports 0 named bindings from node: builtins",
          (1, _differ(1)), source="import crypto from 'node:crypto'\nimport { x } from './local.js'\n")
    # node's map has a line-1 statement of its own: a real statement whose extents differ would look like this
    out = tried([(GLUE_44, 5)], "1 in jsdom A, 1 in jsdom B; node's map has a line-1 statement jsdom's has not",
                (1, _differ(1)), node_extra=[(_loc(1, 19, 1, 30), 0)])
    assert "      line 1, statement: jsdom covered, node not covered (extents differ)\n" in out
    # an extent that is not the generated initializer's length (a vite that names it differently)
    tried([(_loc(1, 19, 1, 60), 5)], "1 in jsdom A, 1 in jsdom B; an extent is not one generated initializer of a "
          "binding long", (1, _differ(1)))
    # an extent that runs over more than line 1
    tried([(_loc(1, 19, 2, 63), 5)], "1 in jsdom A, 1 in jsdom B; an extent is not one generated initializer of a "
          "binding long", (1, _differ(1)))
    # the two jsdom runs do not cover the same number of them: then the file is one whose runs disagree
    out = tried([(GLUE_44, 5)], "1 in jsdom A, 1 in jsdom B; the two jsdom runs do not cover the same number of them",
                (0, _same(2, shared=1)), jsdom_b=[(GLUE_44, 0)])
    assert "    lambda/glue.js: jsdom A 2 of 2 covered, B 1 of 2 (its runs DISAGREE); node A 1 of 1 covered, B 1 of " \
           "1 (its runs agree); jsdom B and node A agree on all 1 items compared, identical hit for hit\n" in out
    # the source is not under --root
    os.remove(os.path.join(root, "lambda", "glue.js"))
    tried([(GLUE_44, 5)], "1 in jsdom A, 1 in jsdom B; its source is not readable under --root", (1, _differ(1)))


def test_e2_a_real_statement_on_line_1_is_in_both_maps_and_is_compared_as_usual(tmp_path, capsys):
    root = _tree(tmp_path, glue=CRYPTO)
    jsdom, _ = _glue_runs(root, [(GLUE_44, 5)], real_first_line=(_loc(1, 0, 1, 12), 3))
    _, node = _glue_runs(root, [], real_first_line=(_loc(1, 0, 1, 12), 0))
    code, out, last = _glue(tmp_path, capsys, root, jsdom, jsdom, node)
    assert (code, last) == (1, _differ(1)), out
    assert GLUE_LINE % "1 statements in 1 files: lambda/glue.js 1" in out
    assert "    lambda/glue.js: 1\n      line 1, statement: jsdom covered, node not covered\n" in out


def test_named_node_imports_reads_the_named_bindings_of_node_builtins_and_nothing_else():
    read = a3.named_node_imports
    assert read("import { createHash } from 'node:crypto'\n") == [("node:crypto", ["createHash"])]
    assert read('import fs, { readFileSync as read, existsSync } from "node:fs";\n') \
        == [("node:fs", ["readFileSync", "existsSync"])]
    assert read("import {\n  mkdirSync,\n  writeFileSync,\n} from 'node:fs'\nimport { join } from 'node:path'\n") \
        == [("node:fs", ["mkdirSync", "writeFileSync"]), ("node:path", ["join"])]
    # a default or a namespace binding is not a named one; a package or a file is not a builtin
    assert read("import module from 'node:module'\nimport * as path from 'node:path'\n") == []
    assert read("import { x } from './local.js'\nimport { y } from 'crypto'\n") == []
    # with no semicolons a named import of a file sits right above a default import of a builtin: still none
    assert read("import { x } from './local.js'\nimport fs from 'node:fs'\n") == []
    assert read("const text = `\nimport notAnImport from 'elsewhere'`\n// import { no } from 'node:fs'\n") == []


# ----------------------------------------------------------------------------------------------- real output

def _real(tmp_path, sources=True):
    """(jsdom run, node run, control, root) of scripts/fixtures/a3-exit/ re-rooted at a checkout under tmp_path that
    holds the node: import lines of the three sources (or, sources=False, none of them)."""
    root = str(tmp_path / "checkout")
    runs = []
    for env in ("jsdom", "node"):
        with open(os.path.join(FIXTURES, "coverage-%s.json" % env), encoding="utf-8") as fh:
            runs.append(json.loads(fh.read().replace('"/repo/', '"%s/' % root)))
    with open(os.path.join(FIXTURES, "node-imports.json"), encoding="utf-8") as fh:
        imports = json.load(fh)
    for rel, lines in imports.items():
        path = os.path.join(root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if sources:
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("// the node: imports of %s\n%s\n" % (rel, "\n".join(lines)))
    control = {root + "/src/lib/pageScroll.js": CONTROL[LOADED]}
    runs[0].update(control)
    return runs[0], runs[1], control, root


def test_e2_real_output_reads_same_with_its_glue_and_its_extent_only_pair_named(tmp_path, capsys):
    jsdom, node, control, root = _real(tmp_path)
    assert len(jsdom[root + "/scripts/ci-telemetry/vitest-test-ids-reporter.mjs"]["statementMap"]) == 47
    assert len(node[root + "/scripts/ci-telemetry/vitest-test-ids-reporter.mjs"]["statementMap"]) == 46
    code, out, last = _e2(tmp_path, capsys, jsdom, jsdom, node, node, control=control, extra=["--root", root],
                          loads=False)
    # reporter 46 statements + 17 functions + 15 arms; assertion.js 7 + 1 + 6; batchBuilderRoutes.js line 79
    assert (code, last) == (0, _same(93, files=3, glue=1)), out
    assert GLUE_LINE % "1 statements in 1 files: scripts/ci-telemetry/vitest-test-ids-reporter.mjs 1" in out
    assert "different extents; not a difference): 1 pairs in 1 files: lambda/preservation/batchBuilderRoutes.js 1" in out
    assert "  differences: 0 in 0 files\n" in out and "NOT glue" not in out


def test_e2_real_output_without_the_source_counts_the_glue_as_the_first_run_of_this_check_did(tmp_path, capsys):
    jsdom, node, control, root = _real(tmp_path, sources=False)
    code, out, last = _e2(tmp_path, capsys, jsdom, jsdom, node, node, control=control, extra=["--root", root],
                          loads=False)
    assert (code, last) == (1, _differ(1)), out
    assert "    scripts/ci-telemetry/vitest-test-ids-reporter.mjs: 1\n      line 1, statement: covered, in jsdom's " \
           "map only\n" in out


def test_e2_real_output_a_null_end_column_and_an_arm_with_no_location_are_items_like_any_other(tmp_path, capsys):
    jsdom, node, control, root = _real(tmp_path)
    file = root + "/lambda/findings/engine/assertion.js"
    assert all(loc["end"]["column"] is None for loc in node[file]["statementMap"].values())
    branch = node[file]["branchMap"]["0"]
    assert branch["locations"][1] == {"start": {}, "end": {}} and branch["loc"]["start"]["line"] == 10
    changed = copy.deepcopy(node)
    changed[file]["b"]["0"][1] += 1 if changed[file]["b"]["0"][1] == 0 else -changed[file]["b"]["0"][1]
    changed[file]["s"]["0"] = 0 if changed[file]["s"]["0"] else 1
    code, out, last = _e2(tmp_path, capsys, jsdom, jsdom, changed, changed, control=control, extra=["--root", root],
                          loads=False)
    assert (code, last) == (1, _differ(2, items=0, left=0)), out
    assert "    lambda/findings/engine/assertion.js: 2\n      line 10, branch arm: jsdom " in out
    assert "\n      line 10, statement: jsdom " in out


# ------------------------------------------------------------------------------------------------- the command

def test_the_command_is_stdlib_only_and_names_no_machine_path():
    with open(SCRIPT, encoding="utf-8") as fh:
        source = fh.read()
    imported = set(re.findall(r"^(?:import|from) (\w+)", source, re.M))
    assert imported == {"argparse", "itertools", "json", "os", "re", "sys"}
    assert not re.search(r"/Users/|/home/|scratchpad|/private/tmp", source)
    for name in os.listdir(FIXTURES):
        with open(os.path.join(FIXTURES, name), encoding="utf-8") as fh:
            assert not re.search(r"/Users/|/home/|scratchpad|/private/tmp", fh.read()), name


def test_a_wrong_command_line_exits_2(capsys):
    for argv in ([], ["e1"], ["e1", "a"], ["e2", "a", "b", "c"], ["e3", "a", "b"], ["e2", "a", "b", "c", "d"]):
        try:
            a3.main(["a3-exit.py"] + argv)
        except SystemExit as stop:
            assert stop.code == 2, argv
        else:
            raise AssertionError("no exit for %r" % argv)
    capsys.readouterr()
