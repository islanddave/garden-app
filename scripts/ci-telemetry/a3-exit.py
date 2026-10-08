#!/usr/bin/env python3
"""The A3 trial's two exit checks, as comparers: do the node project's tests do the same thing under jsdom and node?

Run: python3 scripts/ci-telemetry/a3-exit.py e1 JSDOM.jsonl NODE.jsonl
     python3 scripts/ci-telemetry/a3-exit.py e2 JSDOM_A JSDOM_B NODE_A NODE_B --setup-loads CONTROL [--root DIR]
     (scripts/ci-telemetry/a3-exit.sh makes every input at the current checkout and runs both)

The trial (THE A3 TRIAL in .github/workflows/ci-next.yml) compares the two shapes by test ID: file, name, state.
That cannot see a test that passes in both and takes a different path. These two checks stand in for it.

e1, ASSERTION PARITY. Each input is the tests.jsonl a3-exit-recorder.mjs writes: a header line, then one line per
test with its state, the number of assertions it made through vitest's expect, and whether its file had a `document`
when a3-exit-count.mjs loaded. A test is the same on both sides when it is on both, in the same state, with the same
count. Tests are matched by file, full name and, for a name a file uses twice, its place among those. Printed: tests,
assertions, zero-assertion tests and never-run tests each side, then every test that differs or is on one side only,
and every file that collected no test (such a file is a difference even when both sides have it: nothing in it was
measured).
A side is not read at all (E1-UNREADABLE) when a test that ran carries no count or no `document` reading, or when
the side's assertions add up to 0: the counter did not run, and equal nothing is not parity.
The two sides have to be two environments, shown and not assumed: every test that ran had a `document` on the jsdom
side and none had one on the node side, or the last line is E1-VACUOUS.
Last line E1-SAME (exit 0) or E1-DIFFER (exit 1).

e2, LOADED-MODULE COVERAGE PARITY. Each input is an istanbul coverage-final.json of a run with coverage on and no
`include`, so it holds every module the tests loaded. An item is a statement, a function or a branch arm; it is
covered when its hit count is above 0.
WHY TWO RUNS PER ENVIRONMENT. One tree can give one file two whole readings. lambda/daily-plan/engine.js came back
with 1,214 or with 1,257 of its 1,374 items covered across 12 runs of one tree, in both environments, and each
reading was the same in jsdom and in node hit for hit (BUG-ENGINECOVERAGETWOREADINGS-001: the file runs in two source
forms under one URL and the provider merges them). That is one two-valued reading of a whole file, not noise in
single items, so the unit of comparison for such a file is the reading:
  - a file whose two runs AGREE inside each environment (the same items, the same covered / not covered) has one
    reading per environment, and those are compared item by item. A difference found there counts;
  - a file whose runs DISAGREE inside an environment is compared reading to reading: each jsdom run against each
    node run, whole. When one pair agrees item for item the file is `same under a shared reading`: printed with its
    readings, and nothing of it counts or is left out. When no pair agrees the file is `not compared`: every item of
    it is left out, and the closest pair's differences are printed so they can be found.
LIMIT of two runs: when both runs of each environment give the same reading and the two environments' readings are
not the same one, four files cannot tell that from code that ran differently, and it reads E2-DIFFER. engine.js did
that in one of the first three invocations on one tree (jsdom twice 1,214, node twice 1,257: 235 items).
HOW ITEMS ARE MATCHED: by source location, never by the index the map gives them. The key is the item's whole
extent (start line and column, end line and column; for a branch arm the branch's extent, the arm's place in it and
the arm's own extent). The two environments transform a module differently (vitest's web and ssr modes), and the
same piece of source can come back with different extents. So what the exact key leaves unmatched is paired a
second time, per kind and START LINE, when that line has the same number of unmatched items on each side: the two
sides are put in the order of their extents, as numbers, and paired first with first:
  - a pair that agrees on covered / not covered is EXTENT-ONLY: printed with a count, not a difference;
  - a pair that does not agree is a difference, marked `extents differ`.
What is still unmatched exists in one environment's map only. It cannot be compared, so it is not waved through:
when it is covered where it exists it counts as a difference, marked `in <env>'s map only`; when it is not covered
there it is counted and printed as a class of its own.
GENERATED IMPORT GLUE, decided before anything else is compared. vite's client transform (the one jsdom gets)
turns `import { a, b } from 'node:x'` into one generated assignment per binding, and the coverage converter keeps
each as a statement on line 1 that node's map does not have. Line-1 statements only jsdom's map holds are glue, and
are printed and not counted, only when all of this holds for the file; otherwise each counts like any other item:
  1. node's map has no line-1 statement that jsdom's has not;
  2. each jsdom run has exactly as many of them as the file's source (read under --root) imports named bindings
     from node: builtins;
  3. every one of them with an end is one line long and as long as the generated `__vite__cjsImport<N>_<module>
     ["<name>"]` of a binding of its own;
  4. the two jsdom runs cover the same number of them (their extents reorder run to run, so they are counted, not
     matched).
A real statement on line 1 is in both maps and is compared as usual.
FILES IN ONE ENVIRONMENT ONLY. Every item of such a file that both runs cover is a difference, with one exception
that has to be shown, not assumed: under jsdom the repo setup file loads modules no test loads. --setup-loads names
the coverage file of the control run (one test that imports nothing, under jsdom). In a jsdom-only file the control
holds, an item the control covered is not counted; an item both runs cover that the control did not is `covered
beyond the control` and counts: a test reached into that module.
The control is also what shows the four inputs are two environments: every file in it has to be in both jsdom runs
and in neither node run, or the last line is E2-VACUOUS.
NOT COMPARED. Nothing is dropped unseen: the items of a file with no shared reading, of a file that only one of an
environment's two runs holds, and of a one-environment file covered in one run only are counted, and the verdict
line carries the count. With no difference and anything not compared the verdict is E2-INCONCLUSIVE, never E2-SAME.
Also printed, and not counted: `hit count differs, covered-ness the same` (an item whose count is the same in both
runs of each environment and not the same between them).
Last line E2-SAME (exit 0), E2-DIFFER (exit 1) or E2-INCONCLUSIVE (exit 3).

Both: exit 2, and a last line E1-UNREADABLE / E2-UNREADABLE (or -VACUOUS, above), when an input is missing, is not
what the recorder or the json reporter writes, or is empty; never a traceback. An empty side never reads SAME.
Stdlib only. Tested in scripts/test_a3_exit.py.
"""
import argparse
import itertools
import json
import os
import re
import sys

FORMAT = 2  # of tests.jsonl: 2 added `dom` to every test line
RAN = ("passed", "failed")
SHOWN = 5  # files named under a "top few" heading
RUNS = ("jsdom A", "jsdom B", "node A", "node B")
# `import { a, b as c } from 'node:x'`, also after a default binding. The clause holds no quote, so one match
# never runs over two imports.
IMPORT_NODE = re.compile(r"^[ \t]*import\s*([\w$*\s,{}]+?)\s*from\s*['\"](node:[^'\"]+)['\"]", re.M)
GLUE_NAME = len("__vite__cjsImport")


class Unreadable(Exception):
    pass


def _whole(value):
    return isinstance(value, int) and not isinstance(value, bool)


# ---------------------------------------------------------------------------------------------------------- e1

def read_tests(path, want_env):
    """(header, {(file, name, nth): (state, assertionCalls)}, {the same key: dom}, [files that collected no test])
    of one tests.jsonl."""
    try:
        with open(path, encoding="utf-8") as fh:
            lines = [line for line in fh.read().split("\n") if line.strip()]
    except (OSError, UnicodeDecodeError) as err:
        raise Unreadable("%s: %s" % (path, err))
    try:
        rows = [json.loads(line) for line in lines]
    except ValueError as err:
        raise Unreadable("%s: a line is not JSON (%s)" % (path, err))
    if not rows or not isinstance(rows[0], dict) or rows[0].get("a3_exit") != FORMAT:
        raise Unreadable("%s: no header line of format %d: not a tests.jsonl of a3-exit-recorder.mjs, or empty"
                         % (path, FORMAT))
    header = rows[0]
    if header.get("env") != want_env:
        raise Unreadable("%s: its header says env %r, want %r here" % (path, header.get("env"), want_env))
    tests, doms, uncollected, seen = {}, {}, [], {}
    for row in rows[1:]:
        if not isinstance(row, dict) or not isinstance(row.get("file"), str) or not isinstance(row.get("state"), str) \
                or "name" not in row or "assertionCalls" not in row or "dom" not in row:
            raise Unreadable("%s: a test line without file, name, state, assertionCalls and dom: %r" % (path, row))
        calls, dom = row["assertionCalls"], row["dom"]
        if calls is not None and not _whole(calls):
            raise Unreadable("%s: assertionCalls is neither a whole number nor null: %r" % (path, row))
        if dom is not None and not isinstance(dom, bool):
            raise Unreadable("%s: dom is neither true, false nor null: %r" % (path, row))
        if row["name"] is None:
            uncollected.append(row["file"])
            continue
        if not isinstance(row["name"], str):
            raise Unreadable("%s: a test name that is not text: %r" % (path, row))
        if row["state"] in RAN and (calls is None or dom is None):
            raise Unreadable("%s: a test that ran carries no %s: a3-exit-count.mjs did not run for it: %r"
                             % (path, "count" if calls is None else "reading of the environment", row))
        named = (row["file"], row["name"])
        seen[named] = seen.get(named, 0) + 1
        tests[named + (seen[named],)] = (row["state"], calls)
        doms[named + (seen[named],)] = dom
    if not tests:
        raise Unreadable("%s: no test in it" % path)
    if header.get("tests") != len(tests):
        raise Unreadable("%s: its header counts %r tests and it holds %d: cut short" % (path, header.get("tests"),
                                                                                       len(tests)))
    if not sum(value[1] or 0 for value in tests.values()):
        raise Unreadable("%s: its %d tests made 0 assertions in all: nothing was counted" % (path, len(tests)))
    return header, tests, doms, sorted(uncollected)


def _test_said(key):
    file, name, nth = key
    return "%s :: %s%s" % (file, name, "" if nth == 1 else " (#%d of that name)" % nth)


def _side_said(value):
    return "not there" if value is None else "%s, %s assertions" % (value[0], "no count" if value[1] is None
                                                                    else value[1])


def e1_differences(jsdom, node):
    """[(key, jsdom value or None, node value or None)] for every test not the same on both sides, sorted."""
    return [(key, jsdom.get(key), node.get(key)) for key in sorted(set(jsdom) | set(node))
            if jsdom.get(key) != node.get(key)]


def e1(args):
    sides = []
    for path, env in ((args.jsdom, "jsdom"), (args.node, "node")):
        try:
            sides.append(read_tests(path, env))
        except Unreadable as err:
            print("E1-UNREADABLE: %s" % err)
            return 2
    for env, (_, _, doms, _), want in zip(("jsdom", "node"), sides, (True, False)):
        wrong = sorted(key for key, dom in doms.items() if dom is not None and dom is not want)
        if wrong:
            print("E1-VACUOUS: %d tests on the %s side ran %s a document (first: %s): the two sides are not shown "
                  "to be two environments" % (len(wrong), env, "without" if want else "with", _test_said(wrong[0])))
            return 2
    print("E1 assertion parity: the node project's tests under jsdom and under node")
    for env, (header, tests, _, _) in zip(("jsdom", "node"), sides):
        ran = [value for value in tests.values() if value[0] in RAN]
        print("  %-5s %d tests in %d files; %d assertions; %d zero-assertion tests; %d never ran (skipped, todo); "
              "%d failed" % (env, len(tests), len({key[0] for key in tests}),
                             sum(value[1] or 0 for value in tests.values()),
                             sum(1 for value in ran if value[1] == 0),
                             sum(1 for value in tests.values() if value[0] not in RAN),
                             sum(1 for value in tests.values() if value[0] == "failed")))
        if header.get("left_out"):
            print("        left out by the config: %s" % ", ".join(header["left_out"]))
    (header, jsdom, _, jsdom_uncollected), (_, node, _, node_uncollected) = sides
    print("  two environments: every test that ran had a document on the jsdom side, and none on the node side")
    for note in header.get("notes") or []:
        print("  note: %s" % note)
    zero = [sorted(key for key, value in tests.items() if value[0] in RAN and value[1] == 0) for tests in (jsdom, node)]
    if zero[0] or zero[1]:
        print("  zero-assertion tests: %s" % ("the same %d on both sides" % len(zero[0]) if zero[0] == zero[1]
                                              else "NOT the same tests on the two sides"))
        for key in sorted(set(zero[0]) | set(zero[1])):
            print("    %s" % _test_said(key))
    differ = e1_differences(jsdom, node)
    uncollected = sorted(set(jsdom_uncollected) | set(node_uncollected))
    for file in uncollected:
        print("  collected no test: %s (jsdom %s, node %s)" % (
            file, "yes" if file in jsdom_uncollected else "no", "yes" if file in node_uncollected else "no"))
    for key, a, b in differ:
        print("  differs: %s\n    jsdom: %s\n    node:  %s" % (_test_said(key), _side_said(a), _side_said(b)))
    if differ or uncollected:
        print("E1-DIFFER (%d tests differ or are on one side only, %d files collected no test)"
              % (len(differ), len(uncollected)))
        return 1
    print("E1-SAME (%d tests, %d assertions each side)" % (len(jsdom), sum(v[1] or 0 for v in jsdom.values())))
    return 0


# ---------------------------------------------------------------------------------------------------------- e2

def _check_location(loc, said):
    """A location is null, or {start, end}, each null or {line, column} of whole numbers or nulls."""
    if loc is None:
        return
    if not isinstance(loc, dict):
        raise Unreadable("%s: a location that is not an object: %r" % (said, loc))
    for end in ("start", "end"):
        point = loc.get(end)
        if point is not None and (not isinstance(point, dict) or any(
                point.get(part) is not None and not _whole(point.get(part)) for part in ("line", "column"))):
            raise Unreadable("%s: a location whose %s is not {line, column} in whole numbers: %r" % (said, end, loc))


def read_coverage(path):
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError) as err:
        raise Unreadable("%s: %s" % (path, err))
    if not isinstance(data, dict) or not data:
        raise Unreadable("%s: no file in it: not a coverage-final.json, or an empty one" % path)
    for file, cov in data.items():
        said = "%s: %s" % (path, file)
        if not isinstance(cov, dict) or any(not isinstance(cov.get(part), dict)
                                            for part in ("statementMap", "s", "fnMap", "f", "branchMap", "b")):
            raise Unreadable("%s has no statementMap / s / fnMap / f / branchMap / b" % said)
        for index, loc in cov["statementMap"].items():
            _check_location(loc, said)
            if not _whole(cov["s"].get(index)):
                raise Unreadable("%s: statement %s has no whole-number hit count" % (said, index))
        for index, fn in cov["fnMap"].items():
            if not isinstance(fn, dict):
                raise Unreadable("%s: function %s is not an object" % (said, index))
            _check_location(fn.get("loc"), said)
            _check_location(fn.get("decl"), said)
            if not _whole(cov["f"].get(index)):
                raise Unreadable("%s: function %s has no whole-number hit count" % (said, index))
        for index, branch in cov["branchMap"].items():
            arms = branch.get("locations") if isinstance(branch, dict) else None
            hits = cov["b"].get(index)
            if not isinstance(arms, list) or not isinstance(hits, list) or len(arms) != len(hits) \
                    or not all(_whole(hit) for hit in hits):
                raise Unreadable("%s: branch %s has not one whole-number hit count for each of its arms" % (said, index))
            for loc in [branch.get("loc")] + arms:
                _check_location(loc, said)
    return data


def _extent(loc):
    """(start line, start column, end line, end column); a location istanbul left empty reads as four Nones."""
    start, end = (loc or {}).get("start") or {}, (loc or {}).get("end") or {}
    return (start.get("line"), start.get("column"), end.get("line"), end.get("column"))


def items(cov):
    """{key: hits} for one file of one run. key = (kind, start line, the rest of the location, nth with that
    location): matched by where the item is in the source, never by its index in the map."""
    found = []
    for index, loc in cov["statementMap"].items():
        extent = _extent(loc)
        found.append(("statement", extent[0], extent[1:], cov["s"][index]))
    for index, fn in cov["fnMap"].items():
        extent = _extent(fn.get("loc") or fn.get("decl"))
        found.append(("function", extent[0], extent[1:], cov["f"][index]))
    for index, branch in cov["branchMap"].items():
        whole = _extent(branch.get("loc"))
        for place, arm in enumerate(branch["locations"]):
            own = _extent(arm)
            line = own[0] if own[0] is not None else whole[0]
            found.append(("branch arm", line, (whole, place, own), cov["b"][index][place]))
    out, seen = {}, {}
    for kind, line, rest, hits in found:
        where = (kind, line, rest)
        seen[where] = seen.get(where, 0) + 1
        out[where + (seen[where],)] = hits
    return out


def _numbers(value):
    """A sort key that puts extents in the order of their numbers (column 9 before column 100), a missing one last."""
    if isinstance(value, tuple):
        return tuple(_numbers(part) for part in value)
    return (value is None, value or 0)


def named_node_imports(source):
    """[(module as written, [imported name, …])]: each static import of named bindings from a node: builtin."""
    found = []
    for match in IMPORT_NODE.finditer(source):
        braces = re.search(r"\{([^}]*)\}", match.group(1))
        names = [part.split()[0] for part in braces.group(1).split(",") if part.strip()] if braces else []
        if names:
            found.append((match.group(2), names))
    return found


def _fit(lengths, imports):
    """Is each length that of `__vite__cjsImport<N>_<module>["<name>"]` for a binding of its own? N is the place of
    the import among the file's imports, which is not known here: one to three digits, one N per import."""
    plain = [[GLUE_NAME + 1 + len(module) + 4 + len(name) for name in names] for module, names in imports]
    for digits in itertools.product((1, 2, 3), repeat=len(plain)):
        rest = [length + more for lengths_of, more in zip(plain, digits) for length in lengths_of]
        try:
            for length in lengths:
                rest.remove(length)
        except ValueError:
            continue
        return True
    return False


def take_glue(tables, source):
    """The generated import glue of one file all four runs hold (see the module docstring), taken out of the two
    jsdom tables. Returns (statements taken per run, None); (0, why) when the file has line-1 statements only
    jsdom's map holds and they are not glue; (0, None) when it has none."""
    in_jsdom, in_node = set(tables[0]) | set(tables[1]), set(tables[2]) | set(tables[3])

    def first_line(key):
        return key[0] == "statement" and key[1] == 1

    only = [[key for key in table if first_line(key) and key not in in_node] for table in tables[:2]]
    if not only[0] and not only[1]:
        return 0, None
    said = "%d in jsdom A, %d in jsdom B; " % (len(only[0]), len(only[1]))
    if any(first_line(key) and key not in in_jsdom for key in in_node):
        return 0, said + "node's map has a line-1 statement jsdom's has not"
    try:
        with open(source, encoding="utf-8") as fh:
            imports = named_node_imports(fh.read())
    except (OSError, UnicodeDecodeError):
        return 0, said + "its source is not readable under --root"
    bindings = sum(len(names) for _, names in imports)
    if not bindings or len(only[0]) != bindings or len(only[1]) != bindings:
        return 0, said + "its source imports %d named bindings from node: builtins" % bindings
    for keys in only:
        ended = [key[2] for key in keys if key[2][2] is not None]
        if any(start is None or end_line != 1 for start, end_line, _ in ended) \
                or not _fit([end - start for start, _, end in ended], imports):
            return 0, said + "an extent is not one generated initializer of a binding long"
    if sorted(tables[0][key] > 0 for key in only[0]) != sorted(tables[1][key] > 0 for key in only[1]):
        return 0, said + "the two jsdom runs do not cover the same number of them"
    for table, keys in zip(tables, only):
        for key in keys:
            del table[key]
    return bindings, None


def _covered_said(hits):
    return "covered" if hits > 0 else "not covered"


def compare_file(jsdom, node):
    """One file, one run of each environment: {key: hits} each. Returns `differences` [(line, kind, sentence)],
    `pairs` [(jsdom key, node key)] (every item compared: the exact matches, then the pairs by start line),
    `extent_only` and `uncovered_one_side` (counts)."""
    result = {"differences": [], "pairs": [], "extent_only": 0, "uncovered_one_side": 0}
    left = {"jsdom": {}, "node": {}}
    for key in set(jsdom) | set(node):
        if key not in jsdom:
            left["node"].setdefault(key[:2], []).append(key)
        elif key not in node:
            left["jsdom"].setdefault(key[:2], []).append(key)
        else:
            result["pairs"].append((key, key))
            if (jsdom[key] > 0) != (node[key] > 0):
                result["differences"].append((key[1], key[0], "jsdom %s, node %s" % (_covered_said(jsdom[key]),
                                                                                    _covered_said(node[key]))))
    for at in set(left["jsdom"]) | set(left["node"]):
        only_jsdom = sorted(left["jsdom"].get(at, []), key=_numbers)
        only_node = sorted(left["node"].get(at, []), key=_numbers)
        if len(only_jsdom) == len(only_node):
            for key_a, key_b in zip(only_jsdom, only_node):
                result["pairs"].append((key_a, key_b))
                if (jsdom[key_a] > 0) == (node[key_b] > 0):
                    result["extent_only"] += 1
                else:
                    result["differences"].append((at[1], at[0], "jsdom %s, node %s (extents differ)"
                                                  % (_covered_said(jsdom[key_a]), _covered_said(node[key_b]))))
            continue
        for env, keys, table in (("jsdom", only_jsdom, jsdom), ("node", only_node, node)):
            for key in keys:
                if table[key] > 0:
                    result["differences"].append((at[1], at[0], "covered, in %s's map only" % env))
                else:
                    result["uncovered_one_side"] += 1
    result["differences"].sort(key=lambda found: (found[0] if found[0] is not None else -1, found[1], found[2]))
    return result


def _same_reading(a, b):
    return set(a) == set(b) and all((a[key] > 0) == (b[key] > 0) for key in a)


def compare_readings(tables):
    """One file all four runs hold, glue already out: [jsdom A, jsdom B, node A, node B]. Returns `how` (`one
    reading`: the runs of each environment agree; `shared`: they do not and one jsdom run agrees with one node run
    item for item; `none`: no pair does), `found` (compare_file of the pair taken), `pair` (its name) and
    `hits_differ` (items of that pair whose counts differ; for `one reading`, only those whose count is the same in
    both runs of each environment)."""
    jsdom, node = tables[:2], tables[2:]
    if _same_reading(*jsdom) and _same_reading(*node):
        found = compare_file(jsdom[0], node[0])
        moved = sum(1 for a, b in found["pairs"]
                    if (jsdom[0][a] > 0) == (node[0][b] > 0) and jsdom[0][a] == jsdom[1][a]
                    and node[0][b] == node[1][b] and jsdom[0][a] != node[0][b])
        return {"how": "one reading", "found": found, "pair": "jsdom A and node A", "hits_differ": moved}
    tries = []
    for j in (0, 1):
        for n in (0, 1):
            found = compare_file(jsdom[j], node[n])
            moved = sum(1 for a, b in found["pairs"] if jsdom[j][a] != node[n][b])
            tries.append((len(found["differences"]), moved, "jsdom %s and node %s" % ("AB"[j], "AB"[n]), found))
    # the pair with the fewest differences, then the fewest moved counts; the first of equals
    differ, moved, pair, found = min(tries, key=lambda tried: tried[:2])
    return {"how": "none" if differ else "shared", "found": found, "pair": pair, "hits_differ": moved}


def _readings_said(tables):
    said = []
    for env, (a, b) in (("jsdom", tables[:2]), ("node", tables[2:])):
        said.append("%s A %d of %d covered, B %d of %d (%s)" % (
            env, sum(1 for hits in a.values() if hits > 0), len(a), sum(1 for hits in b.values() if hits > 0), len(b),
            "its runs agree" if _same_reading(a, b) else "its runs DISAGREE"))
    return "; ".join(said)


def _relative(path, root):
    under = root.rstrip("/") + "/"
    return path[len(under):] if root and path.startswith(under) else path


def _top(counts):
    ranked = sorted(counts.items(), key=lambda pair: (-pair[1], pair[0]))
    more = "" if len(ranked) <= SHOWN else "; and %d more files" % (len(ranked) - SHOWN)
    return "; ".join("%s %d" % pair for pair in ranked[:SHOWN]) + more


def _counted(counts, what):
    return "%d %s in %d files%s" % (sum(counts.values()), what, len(counts), ": " + _top(counts) if counts else "")


def e2(args):
    paths = [args.jsdom_a, args.jsdom_b, args.node_a, args.node_b]
    try:
        raw = [read_coverage(path) for path in paths]
        control = read_coverage(args.setup_loads)
    except Unreadable as err:
        print("E2-UNREADABLE: %s" % err)
        return 2
    every = sorted(set().union(control, *raw))
    root = args.root if args.root is not None else (os.path.commonpath(every) if len(every) > 1 else "")
    runs = [{_relative(file, root): items(cov) for file, cov in run.items()} for run in raw]
    control = {_relative(file, root): items(cov) for file, cov in control.items()}
    for file in sorted(control):
        wrong = ["%s %s" % ("not in" if want else "in", name)
                 for name, run, want in zip(RUNS, runs, (True, True, False, False)) if (file in run) is not want]
        if wrong:
            print("E2-VACUOUS: the setup file loads %s (it is in --setup-loads), so it belongs in both jsdom runs and "
                  "in neither node run, and it is %s: nothing shows the two sides are two environments"
                  % (file, " and ".join(wrong)))
            return 2
    in_jsdom, in_node = set(runs[0]) | set(runs[1]), set(runs[2]) | set(runs[3])
    if not in_jsdom & in_node:
        print("E2-UNREADABLE: the two environments have no file in common: not runs of one tree (root %r)" % root)
        return 2

    compared, files_compared = 0, 0
    differences, extent_only, uncovered_one_side, glue, hits_differ, left_out = {}, {}, {}, {}, {}, {}
    not_glue, shared, unshared, partial, one_env = [], [], [], [], []
    for file in sorted(in_jsdom | in_node):
        held = [file in run for run in runs]
        tables = [run.get(file, {}) for run in runs]
        if all(held):
            taken, why = take_glue(tables, os.path.join(root, file))
            if taken:
                glue[file] = taken
            elif why:
                not_glue.append("%s: %s" % (file, why))
            got = compare_readings(tables)
            found = got["found"]
            if got["how"] == "none":
                left_out[file] = len(set().union(*tables))
                unshared.append(("%s: %s; closest are %s, %d items differ" % (
                    file, _readings_said(tables), got["pair"], len(found["differences"])), found["differences"]))
                continue
            compared += len(found["pairs"])
            files_compared += 1
            if found["differences"]:
                differences[file] = found["differences"]
            if found["extent_only"]:
                extent_only[file] = found["extent_only"]
            if found["uncovered_one_side"]:
                uncovered_one_side[file] = found["uncovered_one_side"]
            if got["how"] == "shared":
                shared.append("%s: %s; %s agree on all %d items compared, %s" % (
                    file, _readings_said(tables), got["pair"], len(found["pairs"]),
                    "%d hit counts differ" % got["hits_differ"] if got["hits_differ"] else "identical hit for hit"))
            elif got["hits_differ"]:
                hits_differ[file] = got["hits_differ"]
        elif held[0] == held[1] and held[2] == held[3]:
            env = "jsdom" if held[0] else "node"
            run_a, run_b = tables[:2] if held[0] else tables[2:]
            excused = control.get(file) if held[0] else None
            covered, counted, once = 0, [], 0
            for key in sorted(set(run_a) | set(run_b), key=_numbers):
                times = (run_a.get(key, 0) > 0) + (run_b.get(key, 0) > 0)
                covered += 1 if times else 0
                if not times or (excused is not None and excused.get(key, 0) > 0):
                    continue
                if times == 2:
                    counted.append(key)
                else:
                    once += 1
            if excused is not None:
                said = "%s: jsdom only, loaded by the setup file (in --setup-loads): %d covered items, %d covered " \
                       "beyond the control: %s" % (file, covered, len(counted), "counted" if counted else "not counted")
                marked = "covered beyond the control (the setup file loads the file, under jsdom only)"
            else:
                said = "%s: %s only, %d covered items: counted" % (file, env, len(counted))
                marked = "covered, the file is in %s only" % env
            if once:
                said += "; %d covered in 1 of its 2 runs: not compared" % once
                left_out[file] = once
            one_env.append(said)
            if counted:
                differences[file] = [(key[1], key[0], marked) for key in counted]
        else:
            left_out[file] = len(set().union(*tables))
            where = ["both %s runs" % env if all(pair) else "neither %s run" % env if not any(pair)
                     else "1 of 2 runs of %s (%s)" % (env, "A" if pair[0] else "B")
                     for env, pair in (("jsdom", held[:2]), ("node", held[2:]))]
            partial.append("%s: in %s and in %s: %d items" % (file, where[0], where[1], left_out[file]))

    count = sum(len(found) for found in differences.values())
    if not compared and not count and not left_out:
        print("E2-UNREADABLE: no item is in both environments' maps: nothing was compared")
        return 2

    print("E2 loaded-module coverage parity: statements, functions and branch arms, jsdom against node")
    print("  runs: " + "; ".join("%s %d files" % (name, len(run)) for name, run in zip(RUNS, runs)))
    print("  two environments: the %d files the setup file loads (--setup-loads) are in both jsdom runs and in neither "
          "node run" % len(control))
    print("  files: %d in all four runs, %d in one environment only, %d in 1 of an environment's 2 runs"
          % (files_compared + len(unshared), len(one_env), len(partial)))
    print("  generated import glue (line-1 statements only jsdom's map holds, as many as the file's named node: "
          "import bindings; not counted): %s" % _counted(glue, "statements"))
    if not_glue:
        print("  line-1 statements only jsdom's map holds that are NOT glue (compared like any other item): %d files"
              % len(not_glue))
        for line in not_glue:
            print("    %s" % line)
    print("  same under a shared reading (the runs of an environment disagree on the file; one jsdom run and one node "
          "run agree item for item): %d files" % len(shared))
    for line in shared:
        print("    %s" % line)
    print("  not compared: %d items in %d files" % (sum(left_out.values()), len(left_out)))
    for line, closest in unshared:
        print("    no shared reading: %s" % line)
        for at, kind, said in closest:
            print("      line %s, %s: %s" % ("?" if at is None else at, kind, said))
    for line in partial:
        print("    in 1 of 2 runs: %s" % line)
    print("  items: %d compared in %d files" % (compared, files_compared))
    print("  files in one environment only: %d" % len(one_env))
    for line in one_env:
        print("    %s" % line)
    print("  extent-only (same start line, same covered-ness, different extents; not a difference): %s"
          % _counted(extent_only, "pairs"))
    print("  not covered and in one environment's map only (not a difference): %s"
          % _counted(uncovered_one_side, "items"))
    print("  hit count differs, covered-ness the same (the same count in both runs of each environment, not the same "
          "between them; not counted): %s" % _counted(hits_differ, "items"))
    print("  differences: %d in %d files" % (count, len(differences)))
    for file in sorted(differences):
        print("    %s: %d" % (file, len(differences[file])))
        for at, kind, said in differences[file]:
            print("      line %s, %s: %s" % ("?" if at is None else at, kind, said))
    if count:
        print("E2-DIFFER (%d differences in %d files; %d items in %d files not compared)"
              % (count, len(differences), sum(left_out.values()), len(left_out)))
        return 1
    if left_out:
        print("E2-INCONCLUSIVE (%d items in %d files not compared)" % (sum(left_out.values()), len(left_out)))
        return 3
    print("E2-SAME (%d items in %d files; 0 not compared; %d files under a shared reading; %d generated import glue)"
          % (compared, files_compared, len(shared), sum(glue.values())))
    return 0


def main(argv):
    parser = argparse.ArgumentParser(prog="a3-exit.py", description="The A3 trial's exit checks E1 and E2.")
    commands = parser.add_subparsers(dest="command", required=True)
    one = commands.add_parser("e1", help="assertion parity of two tests.jsonl")
    one.add_argument("jsdom")
    one.add_argument("node")
    one.set_defaults(run=e1)
    two = commands.add_parser("e2", help="coverage parity of four coverage-final.json, two per environment")
    for name in ("jsdom_a", "jsdom_b", "node_a", "node_b"):
        two.add_argument(name)
    two.add_argument("--setup-loads", required=True,
                     help="coverage-final.json of the control run: the modules the setup file loads")
    two.add_argument("--root", help="the checkout the paths are under (default: what they all share)")
    two.set_defaults(run=e2)
    args = parser.parse_args(argv[1:])
    try:
        return args.run(args)
    except Exception as err:  # an input no check above foresaw: say so and exit 2, never a traceback and exit 1
        print("%s-UNREADABLE: %s: %s" % (args.command.upper(), type(err).__name__, err))
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
