#!/usr/bin/env python3
"""The A3 trial's two exit checks, as comparers: do the node project's tests do the same thing under jsdom and node?

Run: python3 scripts/ci-telemetry/a3-exit.py e1 JSDOM.jsonl NODE.jsonl
     python3 scripts/ci-telemetry/a3-exit.py e2 JSDOM_A JSDOM_B NODE_A NODE_B [--setup-loads CONTROL] [--root DIR]
     (scripts/ci-telemetry/a3-exit.sh makes every input at the current checkout and runs both)

The trial (THE A3 TRIAL in .github/workflows/ci-next.yml) compares the two shapes by test ID: file, name, state.
That cannot see a test that passes in both and takes a different path. These two checks stand in for it.

e1, ASSERTION PARITY. Each input is the tests.jsonl a3-exit-recorder.mjs writes: a header line, then one line per
test with its state and the number of assertions it made through vitest's expect. A test is the same on both sides
when it is on both, in the same state, with the same count. Tests are matched by file, full name and, for a name a
file uses twice, its place among those. Printed: tests, assertions, zero-assertion tests and never-run tests each
side, then every test that differs or is on one side only, and every file that collected no test (such a file is a
difference even when both sides have it: nothing in it was measured).
Last line E1-SAME (exit 0) or E1-DIFFER (exit 1).

e2, LOADED-MODULE COVERAGE PARITY. Each input is an istanbul coverage-final.json of a run with coverage on and no
`include`, so it holds every module the tests loaded. Two per environment, because v8 does not count every file the
same twice. For each statement, function and branch arm of each file:
  - it is STABLE in an environment when both of that environment's runs have it and agree on covered / not covered;
  - it is a DIFFERENCE only when it is stable in both environments and covered in one and not in the other.
HOW ITEMS ARE MATCHED: by source location, never by the index the map gives them. The key is the item's whole
extent (start line and column, end line and column; for a branch arm the branch's extent, the arm's place in it and
the arm's own extent). The two environments transform a module differently (vitest's web and ssr modes), and the
same piece of source can come back with different extents. So what the exact key leaves unmatched is paired a
second time by kind and START LINE, when that line has the same number of unmatched items on each side:
  - a pair that agrees on covered / not covered is EXTENT-ONLY: printed with a count, not a difference;
  - a pair that does not agree is a difference, marked `extents differ`.
What is still unmatched exists in one environment's map only. It cannot be compared, so it is not waved through:
when it is covered where it exists it counts as a difference, marked `in <env>'s map only`; when it is not covered
there it is counted and printed as a class of its own.
FILES IN ONE ENVIRONMENT ONLY. Every covered item of such a file is a difference, with one exception that has to be
shown, not assumed: under jsdom the repo setup file loads modules no test loads. --setup-loads names the coverage
file of the control run (one test that imports nothing, under jsdom); a jsdom-only file that is in it is printed as
`loaded by the setup file` and not counted. Without the option every jsdom-only file counts.
Last line E2-SAME (exit 0) or E2-DIFFER (n stable differences in m files) (exit 1).

Both: exit 2, and a last line E1-UNREADABLE / E2-UNREADABLE, when an input is missing, is not what the recorder or
the json reporter writes, or is empty. An empty side never reads SAME. Stdlib only. Tested in
scripts/test_a3_exit.py.
"""
import argparse
import json
import os
import sys

RAN = ("passed", "failed")
SHOWN = 5  # files named under a "top few" heading
KINDS = ("statement", "function", "branch arm")
UNSTABLE = "unstable"


class Unreadable(Exception):
    pass


# ---------------------------------------------------------------------------------------------------------- e1

def read_tests(path, want_env):
    """(header, {(file, name, nth): (state, assertionCalls)}, [files that collected no test]) of one tests.jsonl."""
    try:
        with open(path, encoding="utf-8") as fh:
            lines = [line for line in fh.read().split("\n") if line.strip()]
    except (OSError, UnicodeDecodeError) as err:
        raise Unreadable("%s: %s" % (path, err))
    try:
        rows = [json.loads(line) for line in lines]
    except ValueError as err:
        raise Unreadable("%s: a line is not JSON (%s)" % (path, err))
    if not rows or not isinstance(rows[0], dict) or rows[0].get("a3_exit") != 1:
        raise Unreadable("%s: no header line: not a tests.jsonl of a3-exit-recorder.mjs, or empty" % path)
    header = rows[0]
    if header.get("env") != want_env:
        raise Unreadable("%s: its header says env %r, want %r here" % (path, header.get("env"), want_env))
    tests, uncollected, seen = {}, [], {}
    for row in rows[1:]:
        if not isinstance(row, dict) or not isinstance(row.get("file"), str) or not isinstance(row.get("state"), str) \
                or "name" not in row or "assertionCalls" not in row:
            raise Unreadable("%s: a test line without file, name, state and assertionCalls: %r" % (path, row))
        calls = row["assertionCalls"]
        if calls is not None and (isinstance(calls, bool) or not isinstance(calls, int)):
            raise Unreadable("%s: assertionCalls is neither a whole number nor null: %r" % (path, row))
        if row["name"] is None:
            uncollected.append(row["file"])
            continue
        named = (row["file"], row["name"])
        seen[named] = seen.get(named, 0) + 1
        tests[named + (seen[named],)] = (row["state"], calls)
    if not tests:
        raise Unreadable("%s: no test in it" % path)
    if header.get("tests") != len(tests):
        raise Unreadable("%s: its header counts %r tests and it holds %d: cut short" % (path, header.get("tests"),
                                                                                       len(tests)))
    return header, tests, sorted(uncollected)


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
    print("E1 assertion parity: the node project's tests under jsdom and under node")
    for env, (header, tests, uncollected) in zip(("jsdom", "node"), sides):
        ran = [value for value in tests.values() if value[0] in RAN]
        print("  %-5s %d tests in %d files; %d assertions; %d zero-assertion tests; %d never ran (skipped, todo); "
              "%d failed" % (env, len(tests), len({key[0] for key in tests}),
                             sum(value[1] or 0 for value in tests.values()),
                             sum(1 for value in ran if value[1] == 0),
                             sum(1 for value in tests.values() if value[0] not in RAN),
                             sum(1 for value in tests.values() if value[0] == "failed")))
        if header.get("left_out"):
            print("        left out by the config: %s" % ", ".join(header["left_out"]))
    (header, jsdom, jsdom_uncollected), (_, node, node_uncollected) = sides
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

def read_coverage(path):
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError) as err:
        raise Unreadable("%s: %s" % (path, err))
    if not isinstance(data, dict) or not data:
        raise Unreadable("%s: no file in it: not a coverage-final.json, or an empty one" % path)
    for file, cov in data.items():
        if not isinstance(cov, dict) or any(not isinstance(cov.get(part), dict)
                                            for part in ("statementMap", "s", "fnMap", "f", "branchMap", "b")):
            raise Unreadable("%s: %s has no statementMap / s / fnMap / f / branchMap / b" % (path, file))
    return data


def _extent(loc):
    """(start line, start column, end line, end column); a location istanbul left empty reads as four Nones."""
    start, end = (loc or {}).get("start") or {}, (loc or {}).get("end") or {}
    return (start.get("line"), start.get("column"), end.get("line"), end.get("column"))


def items(cov):
    """{key: covered} for one file of one run. key = (kind, start line, the rest of the location, nth with that
    location): matched by where the item is in the source, never by its index in the map."""
    found = []
    for index, loc in cov["statementMap"].items():
        extent = _extent(loc)
        found.append(("statement", extent[0], extent[1:], cov["s"].get(index, 0) > 0))
    for index, fn in cov["fnMap"].items():
        extent = _extent(fn.get("loc") or fn.get("decl"))
        found.append(("function", extent[0], extent[1:], cov["f"].get(index, 0) > 0))
    for index, branch in cov["branchMap"].items():
        whole = _extent(branch.get("loc"))
        hits = cov["b"].get(index) or []
        for place, arm in enumerate(branch.get("locations") or []):
            own = _extent(arm)
            line = own[0] if own[0] is not None else whole[0]
            found.append(("branch arm", line, (whole, place, own), place < len(hits) and hits[place] > 0))
    out, seen = {}, {}
    for kind, line, rest, covered in found:
        where = (kind, line, rest)
        seen[where] = seen.get(where, 0) + 1
        out[where + (seen[where],)] = covered
    return out


def environment(run_a, run_b):
    """{file: {key: True | False | UNSTABLE}} for one environment's two runs. An item, or a whole file, that only one
    run has is unstable: the two runs did not agree on it."""
    table = {}
    for file in set(run_a) | set(run_b):
        a = items(run_a[file]) if file in run_a else {}
        b = items(run_b[file]) if file in run_b else {}
        table[file] = {key: a[key] if key in a and key in b and a[key] == b[key] else UNSTABLE
                       for key in set(a) | set(b)}
    return table


def _covered_said(value):
    return "covered" if value else "not covered"


def compare_file(jsdom, node):
    """One file both environments loaded. Returns a dict of lists/counts: `differences` [(line, kind, sentence)],
    `compared`, `same`, `extent_only`, `uncovered_one_side`, `skipped_unstable`."""
    result = {"differences": [], "compared": 0, "same": 0, "extent_only": 0, "uncovered_one_side": 0,
              "skipped_unstable": 0}
    left = {"jsdom": {}, "node": {}}
    for key in set(jsdom) | set(node):
        a, b = jsdom.get(key), node.get(key)
        if a == UNSTABLE or b == UNSTABLE:
            result["skipped_unstable"] += 1
        elif a is None:
            left["node"].setdefault(key[:2], []).append(key)
        elif b is None:
            left["jsdom"].setdefault(key[:2], []).append(key)
        else:
            result["compared"] += 1
            if a == b:
                result["same"] += 1
            else:
                result["differences"].append((key[1], key[0], "jsdom %s, node %s" % (_covered_said(a),
                                                                                    _covered_said(b))))
    for at in set(left["jsdom"]) | set(left["node"]):
        only_jsdom = sorted(left["jsdom"].get(at, []), key=repr)
        only_node = sorted(left["node"].get(at, []), key=repr)
        if len(only_jsdom) == len(only_node):
            for key_a, key_b in zip(only_jsdom, only_node):
                result["compared"] += 1
                if jsdom[key_a] == node[key_b]:
                    result["extent_only"] += 1
                else:
                    result["differences"].append((at[1], at[0], "jsdom %s, node %s (extents differ)"
                                                  % (_covered_said(jsdom[key_a]), _covered_said(node[key_b]))))
            continue
        for env, keys, table in (("jsdom", only_jsdom, jsdom), ("node", only_node, node)):
            for key in keys:
                if table[key]:
                    result["differences"].append((at[1], at[0], "covered, in %s's map only" % env))
                else:
                    result["uncovered_one_side"] += 1
    result["differences"].sort(key=lambda found: (found[0] if found[0] is not None else -1, found[1], found[2]))
    return result


def _relative(path, root):
    return path[len(root):].lstrip("/") if root and path.startswith(root) else path


def _top(counts):
    ranked = sorted(counts.items(), key=lambda pair: (-pair[1], pair[0]))
    more = "" if len(ranked) <= SHOWN else "; and %d more files" % (len(ranked) - SHOWN)
    return "; ".join("%s %d" % pair for pair in ranked[:SHOWN]) + more


def e2(args):
    paths = [args.jsdom_a, args.jsdom_b, args.node_a, args.node_b]
    try:
        runs = [read_coverage(path) for path in paths]
        setup = read_coverage(args.setup_loads) if args.setup_loads else {}
    except Unreadable as err:
        print("E2-UNREADABLE: %s" % err)
        return 2
    every = sorted(set().union(*runs, setup))
    root = args.root if args.root is not None else (os.path.commonpath(every) if len(every) > 1 else "")
    runs = [{_relative(file, root): cov for file, cov in run.items()} for run in runs]
    setup_files = {_relative(file, root) for file in setup}
    jsdom, node = environment(runs[0], runs[1]), environment(runs[2], runs[3])
    both = sorted(set(jsdom) & set(node))
    if not both:
        print("E2-UNREADABLE: the two environments have no file in common: not runs of one tree (root %r)" % root)
        return 2

    print("E2 loaded-module coverage parity: statements, functions and branch arms, jsdom against node")
    print("  runs: " + "; ".join("%s %d files" % (name, len(run))
                                 for name, run in zip(("jsdom A", "jsdom B", "node A", "node B"), runs)))
    for name, table in (("jsdom", jsdom), ("node", node)):
        unstable = {file: sum(1 for value in found.values() if value == UNSTABLE) for file, found in table.items()}
        unstable = {file: count for file, count in unstable.items() if count}
        print("  unstable within %s (its two runs disagree; left out of the comparison): %d items in %d files%s"
              % (name, sum(unstable.values()), len(unstable), ": " + _top(unstable) if unstable else ""))

    differences, totals, extent_only, uncovered_one_side = {}, {"compared": 0, "skipped_unstable": 0}, {}, {}
    for file in both:
        found = compare_file(jsdom[file], node[file])
        totals["compared"] += found["compared"]
        totals["skipped_unstable"] += found["skipped_unstable"]
        if found["differences"]:
            differences[file] = found["differences"]
        if found["extent_only"]:
            extent_only[file] = found["extent_only"]
        if found["uncovered_one_side"]:
            uncovered_one_side[file] = found["uncovered_one_side"]
    one_env = []
    for env, table, other in (("jsdom", jsdom, node), ("node", node, jsdom)):
        for file in sorted(set(table) - set(other)):
            covered = sorted((key for key, value in table[file].items() if value is True), key=repr)
            if env == "jsdom" and file in setup_files:
                one_env.append("%s: %s only, loaded by the setup file (in --setup-loads): not counted" % (file, env))
                continue
            one_env.append("%s: %s only, %d covered items: counted" % (file, env, len(covered)))
            if covered:
                differences[file] = [(key[1], key[0], "covered, the file is in %s only" % env) for key in covered]
    if not totals["compared"]:
        print("E2-UNREADABLE: no item is stable in both environments and in both maps: nothing was compared")
        return 2

    print("  files: %d in both environments, %d in one only" % (len(both), len(one_env)))
    print("  items: %d compared in the files of both (stable in both environments); %d left out as unstable"
          % (totals["compared"], totals["skipped_unstable"]))
    print("  files in one environment only: %d" % len(one_env))
    for line in one_env:
        print("    %s" % line)
    print("  extent-only (same start line, same covered-ness, different extents; not a difference): %d pairs in %d "
          "files%s" % (sum(extent_only.values()), len(extent_only), ": " + _top(extent_only) if extent_only else ""))
    print("  not covered and in one environment's map only (not a difference): %d items in %d files%s"
          % (sum(uncovered_one_side.values()), len(uncovered_one_side),
             ": " + _top(uncovered_one_side) if uncovered_one_side else ""))
    count = sum(len(found) for found in differences.values())
    print("  stable differences: %d in %d files" % (count, len(differences)))
    for file in sorted(differences):
        print("    %s: %d" % (file, len(differences[file])))
        for line, kind, said in differences[file]:
            print("      line %s, %s: %s" % ("?" if line is None else line, kind, said))
    if count:
        print("E2-DIFFER (%d stable differences in %d files)" % (count, len(differences)))
        return 1
    print("E2-SAME (%d items in %d files)" % (totals["compared"], len(both)))
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
    two.add_argument("--setup-loads", help="coverage-final.json of the control run: the modules the setup file loads")
    two.add_argument("--root", help="the checkout the paths are under (default: what they all share)")
    two.set_defaults(run=e2)
    args = parser.parse_args(argv[1:])
    return args.run(args)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
