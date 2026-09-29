"""Tests for putup-sitting-check.py (review-F-prepromote-early B2, B3, I5). No network, no AWS, no database.

The fixtures in the script's --self-test prove each check passes and fails on the right input. These tests add
what fixtures cannot: the markers the script looks for are really in THIS tree (so a rename of pantryUses.js or
the label trim cannot turn the sitting's check into a false FAIL after the point of no return), the CLI's
argument errors, and the exit codes.
"""
import importlib.util
import io
import os
import subprocess
import zipfile

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)


def _load():
    spec = importlib.util.spec_from_file_location("putup_sitting_check", os.path.join(HERE, "putup-sitting-check.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


psc = _load()


def _tree_zip(fn_dir):
    """lambda/<fn_dir> zipped the way deploy-lambda.yml does (`zip -r . -x '*.test.js'`), minus node_modules."""
    root = os.path.join(REPO, "lambda", fn_dir)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d != "node_modules"]
            for f in filenames:
                if f.endswith(".test.js"):
                    continue
                full = os.path.join(dirpath, f)
                z.write(full, os.path.relpath(full, root))
    return buf.getvalue()


def _tree_sources(compare="ahead"):
    zips = {psc.FN_PRESERVATION: _tree_zip("preservation"), psc.FN_PLANTS: _tree_zip("plants"),
            psc.FN_STORAGE: _tree_zip("storage-location")}
    configs = {fn: {"LastModified": "2026-09-30T03:00:00.000+0000", "CodeSha256": "tree"} for fn in zips}
    return psc.FixtureSources(compare, configs, zips)


def test_self_test_is_green(capsys):
    assert psc.main(["--self-test"]) == 0
    out = capsys.readouterr().out
    assert "SELFTEST ok: 0 scenario(s) wrong" in out
    assert "SELFTEST FAIL" not in out


def test_this_trees_lambdas_carry_what_f_deployed_looks_for():
    results = psc.check_lambdas(_tree_sources())
    assert [r.check for r in results] == [f"lambda:{psc.FN_PRESERVATION}", f"lambda:{psc.FN_PLANTS}",
                                         f"lambda:{psc.FN_STORAGE}"]
    assert all(r.ok for r in results), [r.line() for r in results]


def test_this_trees_preservation_carries_1as_count_rule():
    results = psc.check_precondition(_tree_sources(), promoted_after="2026-09-30T02:00:00Z")
    rule = [r for r in results if r.check == "1a-count-rule"]
    assert len(rule) == 1 and rule[0].ok, rule[0].line()


@pytest.mark.parametrize("marker", [m for _, m in psc.BUNDLE_MARKERS])
def test_each_bundle_marker_is_in_this_trees_app_source(marker):
    hits = []
    for dirpath, dirnames, filenames in os.walk(os.path.join(REPO, "src")):
        dirnames[:] = [d for d in dirnames if d != "__tests__"]
        for f in filenames:
            if f.endswith((".js", ".jsx")) and ".test." not in f:
                with open(os.path.join(dirpath, f), encoding="utf-8") as fh:
                    if marker in fh.read():
                        hits.append(f)
    assert hits, f"{marker!r} is in no non-test file under src/ — the live-bundle check would FAIL on a good deploy"


def test_floor_against_this_trees_file(capsys):
    first = psc.revert_floors.load()[0]["since"]
    assert psc.main(["--floor", "--since", first]) == 0
    assert f"PASS [floor:since] entry since {first}" in capsys.readouterr().out
    assert psc.main(["--floor", "--since", "v999.0.0"]) == 1
    assert "FAIL [floor:since] no entry with since v999.0.0" in capsys.readouterr().out


@pytest.mark.parametrize("argv", [
    ["--precondition"],
    ["--precondition", "--promoted-after", "2026-09-30T02:00:00"],
    ["--precondition", "--promoted-after", "tonight"],
    ["--f-deployed"],
    ["--f-deployed", "--only", "bundle,dns"],
    ["--floor"],
    ["--floor", "--since", "4.163"],
    ["--precondition", "--floor", "--since", "v4.163.0"],
    [],
])
def test_argument_errors_exit_2(argv):
    with pytest.raises(SystemExit) as e:
        psc.main(argv, sources=psc.FixtureSources())
    assert e.value.code == 2


def test_exit_codes_and_lines_with_injected_sources(capsys):
    argv = ["--precondition", "--promoted-after", "2026-09-30T02:00:00Z"]
    assert psc.main(argv, sources=_tree_sources("ahead")) == 0
    out = capsys.readouterr().out
    assert out.count("PASS [precondition:") == 4 and "PASS: 4/4 checks passed" in out
    assert psc.main(argv, sources=_tree_sources("behind")) == 1
    out = capsys.readouterr().out
    assert "FAIL [precondition:main-contains]" in out and "FAIL: 3/4 checks passed" in out


def test_only_lambdas_needs_no_cache_version_and_reads_no_site(capsys):
    assert psc.main(["--f-deployed", "--only", "lambdas"], sources=_tree_sources()) == 0
    out = capsys.readouterr().out
    assert "bundle:" not in out and "sw-cache-version" not in out and out.count("PASS [f-deployed:lambda:") == 3


def test_a_missing_gh_is_a_fail_not_a_skip(monkeypatch):
    def boom(*a, **k):
        raise FileNotFoundError("gh")
    monkeypatch.setattr(subprocess, "run", boom)
    with pytest.raises(psc.CheckError, match="gh is not installed"):
        psc.LiveSources().compare_status(psc.DEFAULT_REPO, psc.ONE_A_DEV_SHA, "main")
