"""scripts/ci-telemetry/a3-exit.py, the comparers of the A3 trial's two exit checks, on inputs made here.

Run: python3 -m pytest -q scripts/test_a3_exit.py

e1 reads the tests.jsonl of scripts/ci-telemetry/a3-exit-recorder.mjs; e2 reads istanbul coverage-final.json files.
Every input below is built in the test from the smallest thing that has the shape, then changed the way a second
environment or a second run could differ from it, and what the command prints and exits with is held. The real
inputs are large and belong to one tree at one time; scripts/ci-telemetry/a3-exit.sh makes them.
"""
import importlib.util
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "ci-telemetry", "a3-exit.py")

_spec = importlib.util.spec_from_file_location("a3_exit", SCRIPT)
a3 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(a3)


# ---------------------------------------------------------------------------------------------------------- e1

TESTS = [("lambda/a.test.js", "adds", "passed", 3), ("lambda/a.test.js", "adds again", "passed", 0),
         ("lambda/b.test.js", "group > later", "skipped", None), ("scripts/c.test.js", "holds", "passed", 12)]


def _jsonl(env, tests, header=None, uncollected=()):
    head = {"a3_exit": 1, "env": env, "files": len({t[0] for t in tests}), "tests": len(tests), "left_out": [],
            "notes": ["a test that asserts only with node:assert reads 0"]}
    head.update(header or {})
    rows = [head] + [{"file": f, "name": n, "state": s, "assertionCalls": c} for f, n, s, c in tests]
    rows += [{"file": f, "name": None, "state": "failed", "assertionCalls": None} for f in uncollected]
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
    code, out, last = _e1(tmp_path, capsys, _jsonl("jsdom", TESTS), _jsonl("node", TESTS))
    assert (code, last) == (0, "E1-SAME (4 tests, 15 assertions each side)")
    assert "jsdom 4 tests in 3 files; 15 assertions; 1 zero-assertion tests; 1 never ran" in out
    assert "node  4 tests in 3 files; 15 assertions; 1 zero-assertion tests; 1 never ran" in out
    assert "zero-assertion tests: the same 1 on both sides" in out and "lambda/a.test.js :: adds again" in out
    assert "note: a test that asserts only with node:assert reads 0" in out


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


def test_e1_a_missing_or_malformed_file_is_unreadable(tmp_path, capsys):
    good = _jsonl("jsdom", TESTS)
    code, out, last = _e1(tmp_path, capsys, good, None)
    assert code == 2 and last.startswith("E1-UNREADABLE: ") and "node.jsonl" in last
    for bad in ("not json\n", _jsonl("node", TESTS) + "{cut", json.dumps({"file": "a", "name": "b"}) + "\n",
                _jsonl("node", TESTS).replace('"assertionCalls": 12', '"assertionCalls": "12"'),
                _jsonl("node", TESTS).replace('"state": "skipped", ', ""),
                _jsonl("node", TESTS).replace(', "assertionCalls": 12', ""),
                _jsonl("node", TESTS).replace('"name": "holds", ', "")):
        code, out, last = _e1(tmp_path, capsys, good, bad)
        assert code == 2 and last.startswith("E1-UNREADABLE: "), bad[-80:]
    headless = "".join(line + "\n" for line in _jsonl("node", TESTS).split("\n")[1:-1])
    code, out, last = _e1(tmp_path, capsys, good, headless)
    assert code == 2 and "no header line" in last


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


def _file(statements=(), functions=(), branches=()):
    """statements / functions: [(location, hits)]; branches: [(location, [(arm location, hits)])]."""
    cov = {"path": "x", "statementMap": {}, "s": {}, "fnMap": {}, "f": {}, "branchMap": {}, "b": {}}
    for index, (loc, hits) in enumerate(statements):
        cov["statementMap"][str(index)], cov["s"][str(index)] = loc, hits
    for index, (loc, hits) in enumerate(functions):
        cov["fnMap"][str(index)] = {"name": "(anonymous_%d)" % index, "decl": loc, "loc": loc, "line": loc["start"]["line"]}
        cov["f"][str(index)] = hits
    for index, (loc, arms) in enumerate(branches):
        cov["branchMap"][str(index)] = {"type": "if", "loc": loc, "line": loc["start"]["line"],
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


def _e2(tmp_path, capsys, jsdom_a, jsdom_b, node_a, node_b, setup=None, extra=()):
    paths = []
    for name, data in (("jsdom-a", jsdom_a), ("jsdom-b", jsdom_b), ("node-a", node_a), ("node-b", node_b),
                       ("setup", setup)):
        path = tmp_path / (name + ".json")
        if data is None:
            path.unlink(missing_ok=True)
        else:
            path.write_text(data if isinstance(data, str) else json.dumps(data), encoding="utf-8")
        paths.append(str(path))
    argv = ["a3-exit.py", "e2"] + paths[:4] + (["--setup-loads", paths[4]] if setup is not None else []) + list(extra)
    code = a3.main(argv)
    out = capsys.readouterr().out
    return code, out, out.rstrip("\n").split("\n")[-1]


def _with(**files):
    return dict(BASE, **_run(**files))


def test_e2_four_equal_runs_are_same(tmp_path, capsys):
    code, out, last = _e2(tmp_path, capsys, BASE, BASE, BASE, BASE)
    assert (code, last) == (0, "E2-SAME (7 items in 2 files)")  # 3 statements, 1 function, 2 arms; 1 statement
    assert "files: 2 in both environments, 0 in one only" in out
    assert "unstable within jsdom (its two runs disagree; left out of the comparison): 0 items in 0 files" in out
    assert "stable differences: 0 in 0 files" in out


def test_e2_hit_counts_do_not_matter_only_covered_or_not(tmp_path, capsys):
    busier = _with(lambda_engine=_engine(arm_hits=(900, 0), statement_hits=(7, 7, 0), function_hits=(3,)))
    code, _, last = _e2(tmp_path, capsys, BASE, BASE, busier, busier)
    assert (code, last) == (0, "E2-SAME (7 items in 2 files)")


def test_e2_a_stable_difference_counts_for_each_kind_with_its_line(tmp_path, capsys):
    for changed, said in ((_engine(arm_hits=(4, 1)), "line 7, branch arm: jsdom not covered, node covered"),
                          (_engine(arm_hits=(0, 0)), "line 5, branch arm: jsdom covered, node not covered"),
                          (_engine(statement_hits=(1, 2, 5)), "line 3, statement: jsdom not covered, node covered"),
                          (_engine(function_hits=(0,)), "line 2, function: jsdom covered, node not covered")):
        node = _with(lambda_engine=changed)
        code, out, last = _e2(tmp_path, capsys, BASE, BASE, node, node)
        assert (code, last) == (1, "E2-DIFFER (1 stable differences in 1 files)"), out
        assert "    lambda/engine.js: 1\n      " + said in out


def test_e2_an_item_unstable_within_one_environment_does_not_count(tmp_path, capsys):
    flipped = _with(lambda_engine=_engine(arm_hits=(4, 1)))
    for runs in ((BASE, BASE, BASE, flipped), (BASE, BASE, flipped, BASE), (flipped, BASE, BASE, BASE),
                 (BASE, flipped, flipped, flipped)):
        code, out, last = _e2(tmp_path, capsys, *runs)
        assert (code, last) == (0, "E2-SAME (6 items in 2 files)"), out
        env = "node" if runs[2] is not runs[3] else "jsdom"
        assert "unstable within %s (its two runs disagree; left out of the comparison): 1 items in 1 files: " \
               "lambda/engine.js 1" % env in out
        assert "6 compared in the files of both (stable in both environments); 1 left out as unstable" in out


def test_e2_matching_is_by_location_not_by_index(tmp_path, capsys):
    shuffled = _engine()
    shuffled["statementMap"] = {"7": _loc(3), "8": _loc(1), "9": _loc(2)}
    shuffled["s"] = {"7": 0, "8": 1, "9": 2}
    node = _with(lambda_engine=shuffled)
    code, out, last = _e2(tmp_path, capsys, BASE, BASE, node, node)
    assert (code, last) == (0, "E2-SAME (7 items in 2 files)")
    assert "different extents; not a difference): 0 pairs in 0 files" in out


def test_e2_two_items_at_one_location_stay_two(tmp_path, capsys):
    twin = _engine()
    twin["statementMap"]["3"], twin["s"]["3"] = _loc(3), 1   # line 3 a second time, this one covered
    both = _with(lambda_engine=twin)
    code, _, last = _e2(tmp_path, capsys, both, both, both, both)
    assert (code, last) == (0, "E2-SAME (8 items in 2 files)")


def test_e2_an_item_or_a_file_only_one_run_of_an_environment_has_is_unstable(tmp_path, capsys):
    extra = _engine()
    extra["statementMap"]["3"], extra["s"]["3"] = _loc(11), 1
    item = _with(lambda_engine=extra)
    late = _with(lambda_late=_file(statements=[(_loc(1), 1)]))
    for runs, count, where in (((BASE, BASE, BASE, item), 1, "lambda/engine.js 1"),
                               ((BASE, BASE, item, BASE), 1, "lambda/engine.js 1"),
                               ((BASE, BASE, BASE, late), 1, "lambda/late.js 1"),
                               ((BASE, BASE, late, BASE), 1, "lambda/late.js 1")):
        code, out, last = _e2(tmp_path, capsys, *runs)
        assert (code, last) == (0, "E2-SAME (7 items in 2 files)"), out
        assert "unstable within node (its two runs disagree; left out of the comparison): %d items in 1 files: %s" \
               % (count, where) in out


def test_e2_an_extent_only_mismatch_is_its_own_class_and_not_a_difference(tmp_path, capsys):
    wider = _engine()
    wider["statementMap"]["1"] = _loc(2, 0, 2, 45)   # line 2 again, ending further right
    wider["fnMap"]["0"]["loc"] = _loc(2, 4, 9, 1)    # the function, starting further right
    node = _with(lambda_engine=wider)
    code, out, last = _e2(tmp_path, capsys, BASE, BASE, node, node)
    assert (code, last) == (0, "E2-SAME (7 items in 2 files)"), out
    assert "extent-only (same start line, same covered-ness, different extents; not a difference): 2 pairs in 1 " \
           "files: lambda/engine.js 2" in out


def test_e2_an_extent_only_pair_that_disagrees_is_a_difference(tmp_path, capsys):
    wider = _engine(statement_hits=(1, 0, 0))
    wider["statementMap"]["1"] = _loc(2, 0, 2, 45)
    node = _with(lambda_engine=wider)
    code, out, last = _e2(tmp_path, capsys, BASE, BASE, node, node)
    assert (code, last) == (1, "E2-DIFFER (1 stable differences in 1 files)")
    assert "line 2, statement: jsdom covered, node not covered (extents differ)" in out
    assert "extent-only (same start line, same covered-ness, different extents; not a difference): 0 pairs" in out


def test_e2_an_item_in_one_map_only_counts_when_covered_and_is_its_own_class_when_not(tmp_path, capsys):
    extra = _engine()
    extra["statementMap"]["3"], extra["s"]["3"] = _loc(11), 1
    node = _with(lambda_engine=extra)
    code, out, last = _e2(tmp_path, capsys, BASE, BASE, node, node)
    assert (code, last) == (1, "E2-DIFFER (1 stable differences in 1 files)")
    assert "line 11, statement: covered, in node's map only" in out
    code, out, last = _e2(tmp_path, capsys, node, node, BASE, BASE)
    assert code == 1 and "line 11, statement: covered, in jsdom's map only" in out
    extra["s"]["3"] = 0
    code, out, last = _e2(tmp_path, capsys, BASE, BASE, node, node)
    assert (code, last) == (0, "E2-SAME (7 items in 2 files)")
    assert "not covered and in one environment's map only (not a difference): 1 items in 1 files: " \
           "lambda/engine.js 1" in out


def test_e2_a_line_with_a_different_number_of_unmatched_items_each_side_is_not_paired(tmp_path, capsys):
    two, one = _engine(), _engine()
    two["statementMap"]["3"], two["s"]["3"] = _loc(11, 0, 11, 8), 1
    two["statementMap"]["4"], two["s"]["4"] = _loc(11, 9, 11, 30), 1
    one["statementMap"]["3"], one["s"]["3"] = _loc(11, 0, 11, 30), 1
    jsdom, node = _with(lambda_engine=two), _with(lambda_engine=one)
    code, out, last = _e2(tmp_path, capsys, jsdom, jsdom, node, node)
    assert (code, last) == (1, "E2-DIFFER (3 stable differences in 1 files)"), out
    assert out.count("line 11, statement: covered, in jsdom's map only") == 2
    assert out.count("line 11, statement: covered, in node's map only") == 1


def test_e2_a_file_in_one_environment_only_counts_its_covered_items(tmp_path, capsys):
    more = _with(lambda_late=_file(statements=[(_loc(1), 1), (_loc(2), 0)], functions=[(_loc(4, 0, 6, 1), 2)]))
    for runs, env in (((BASE, BASE, more, more), "node"), ((more, more, BASE, BASE), "jsdom")):
        code, out, last = _e2(tmp_path, capsys, *runs)
        assert (code, last) == (1, "E2-DIFFER (2 stable differences in 1 files)"), out
        assert "files: 2 in both environments, 1 in one only" in out
        assert "lambda/late.js: %s only, 2 covered items: counted" % env in out
        assert "line 1, statement: covered, the file is in %s only" % env in out


def test_e2_a_jsdom_only_file_the_setup_file_loads_is_not_counted_and_nothing_else_is_excused(tmp_path, capsys):
    setup_module = _file(statements=[(_loc(1), 1)])
    jsdom = dict(BASE, **{ROOT + "/src/lib/pageScroll.js": setup_module})
    control = {ROOT + "/src/lib/pageScroll.js": setup_module, ROOT + "/src/lib/backNav.js": setup_module}
    code, out, last = _e2(tmp_path, capsys, jsdom, jsdom, BASE, BASE, setup=control)
    assert (code, last) == (0, "E2-SAME (7 items in 2 files)"), out
    assert "src/lib/pageScroll.js: jsdom only, loaded by the setup file (in --setup-loads): not counted" in out
    # without the control it counts
    code, out, last = _e2(tmp_path, capsys, jsdom, jsdom, BASE, BASE)
    assert (code, last) == (1, "E2-DIFFER (1 stable differences in 1 files)")
    # the control excuses a jsdom-only file, never a node-only one, and never a file both environments loaded
    code, out, last = _e2(tmp_path, capsys, BASE, BASE, jsdom, jsdom, setup=control)
    assert (code, last) == (1, "E2-DIFFER (1 stable differences in 1 files)")
    assert "src/lib/pageScroll.js: node only, 1 covered items: counted" in out
    node = _with(lambda_engine=_engine(arm_hits=(4, 1)))
    code, out, last = _e2(tmp_path, capsys, BASE, BASE, node, node, setup=dict(control, **BASE))
    assert (code, last) == (1, "E2-DIFFER (1 stable differences in 1 files)")


def test_e2_differences_are_counted_across_files(tmp_path, capsys):
    node = _with(lambda_engine=_engine(arm_hits=(0, 1)), scripts_tool=_file(statements=[(_loc(1), 0)]))
    code, out, last = _e2(tmp_path, capsys, BASE, BASE, node, node)
    assert (code, last) == (1, "E2-DIFFER (3 stable differences in 2 files)")
    assert "    lambda/engine.js: 2\n" in out and "    scripts/tool.js: 1\n" in out


def test_e2_an_empty_or_unreadable_input_is_unreadable_never_same(tmp_path, capsys):
    for place in range(4):
        for bad, why in (({}, "no file in it"), (None, "No such file"), ("not json", "Expecting value"),
                         ("[]", "no file in it"), ({ROOT + "/lambda/engine.js": {"s": {}}}, "has no statementMap")):
            runs = [BASE, BASE, BASE, BASE]
            runs[place] = bad
            code, out, last = _e2(tmp_path, capsys, *runs)
            assert code == 2 and last.startswith("E2-UNREADABLE: ") and why in last, (place, bad, out)
            assert "E2-SAME" not in out
    code, out, last = _e2(tmp_path, capsys, BASE, BASE, BASE, BASE, setup="not json")
    assert code == 2 and last.startswith("E2-UNREADABLE: ") and "setup.json" in last


def test_e2_environments_with_nothing_to_compare_are_unreadable(tmp_path, capsys):
    other = _run(lambda_other=_engine(), scripts_more=_file(statements=[(_loc(1), 1)]))
    code, _, last = _e2(tmp_path, capsys, BASE, BASE, other, other)
    assert code == 2 and "no file in common" in last
    # every item of the one shared file flips inside node: nothing is stable in both
    one = _run(lambda_engine=_file(statements=[(_loc(1), 1)]), scripts_tool=_file(statements=[(_loc(1), 1)]))
    flip = _run(lambda_engine=_file(statements=[(_loc(1), 0)]), scripts_tool=_file(statements=[(_loc(1), 0)]))
    code, _, last = _e2(tmp_path, capsys, one, one, one, flip)
    assert code == 2 and "nothing was compared" in last


def test_e2_root_is_what_the_paths_share_or_what_it_is_told(tmp_path, capsys):
    elsewhere = {path.replace(ROOT, "/other/checkout"): cov for path, cov in BASE.items()}
    code, _, last = _e2(tmp_path, capsys, BASE, BASE, elsewhere, elsewhere)
    assert code == 2 and "no file in common" in last
    code, _, last = _e2(tmp_path, capsys, BASE, BASE, BASE, BASE, extra=["--root", ROOT])
    assert (code, last) == (0, "E2-SAME (7 items in 2 files)")
    node = _with(lambda_engine=_engine(arm_hits=(4, 1)))
    code, out, _ = _e2(tmp_path, capsys, BASE, BASE, node, node, extra=["--root", "/"])
    assert code == 1 and "    repo/lambda/engine.js: 1\n" in out


# ------------------------------------------------------------------------------------------------- the command

def test_the_command_is_stdlib_only_and_names_no_machine_path():
    with open(SCRIPT, encoding="utf-8") as fh:
        source = fh.read()
    imported = set(re.findall(r"^(?:import|from) (\w+)", source, re.M))
    assert imported == {"argparse", "json", "os", "sys"}
    assert not re.search(r"/Users/|/home/|scratchpad|/private/tmp", source)


def test_a_wrong_command_line_exits_2(capsys):
    for argv in ([], ["e1"], ["e1", "a"], ["e2", "a", "b", "c"], ["e3", "a", "b"]):
        try:
            a3.main(["a3-exit.py"] + argv)
        except SystemExit as stop:
            assert stop.code == 2, argv
        else:
            raise AssertionError("no exit for %r" % argv)
    capsys.readouterr()
