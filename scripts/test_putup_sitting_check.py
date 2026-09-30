"""Tests for putup-sitting-check.py (review-F-prepromote-early B3, I5; review-F-prepromote-final B2). No network,
no AWS, no database. --floor's refusal questions go to scripts/revert-to.py's real require_target_above_floor.

The fixtures in the script's --self-test prove each check passes and fails on the right input. These tests add
what fixtures cannot: the markers the script looks for are really in THIS tree (so a rename of pantryUses.js or
the label trim cannot turn the sitting's check into a false FAIL after the point of no return), the CLI's
argument errors, and the exit codes.
"""
import importlib.util
import io
import json
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


# ── --floor (review-F-prepromote-final B2) ─────────────────────────────────────────────────────────────
F_VERSION = "v4.164.0"
LANDING_ENTRY = {"floor": F_VERSION, "since": F_VERSION, "reason": "1a code over F data (stale-count PUTs, taken-out "
                 "lines returned, 23503 on drawn-line deletes, no PATCH or use route)", "ledger": "V5-PUTUPMAKETRUE-001",
                 "undo_instead": None}


def _floors_copy(tmp_path, *extra, raw=None):
    """This tree's revert-floors.json as it stood BEFORE the landing (any entry at F_VERSION removed) with `extra`
    entries appended (or `raw` text), in tmp_path — never the tree's. Removing the landed entry keeps every mutant
    case judging the mutant, not the real floor the landing commit added."""
    path = tmp_path / "revert-floors.json"
    if raw is not None:
        path.write_text(raw, encoding="utf-8")
    else:
        with open(psc.revert_floors.FLOORS, encoding="utf-8") as fh:
            data = json.load(fh)
        data["floors"] = [e for e in data["floors"] if F_VERSION not in (e.get("floor"), e.get("since"))]
        data["floors"] += list(extra)
        path.write_text(json.dumps(data), encoding="utf-8")
    return str(path)


def _floor(argv_tail, capsys):
    code = psc.main(["--floor", "--f-version", F_VERSION, *argv_tail])
    return code, capsys.readouterr().out


def test_floor_this_tree_carries_the_landing_floor(capsys):
    """Landed with 4.164.0: the committed floors file itself must pass all four (review-F-prepromote-final B2)."""
    code, out = _floor([], capsys)
    assert code == 0, out
    for k in ("file", "governing", "pre-f-refused", "f-allowed"):
        assert f"PASS [floor:{k}]" in out


def test_floor_the_tree_without_the_landing_entry_fails(tmp_path, capsys):
    code, out = _floor(["--floors-file", _floors_copy(tmp_path)], capsys)
    assert code == 1
    assert "PASS [floor:file]" in out
    assert "FAIL [floor:governing]" in out and "FAIL [floor:pre-f-refused]" in out


def test_floor_with_the_landing_entry_passes_all_four(tmp_path, capsys):
    code, out = _floor(["--floors-file", _floors_copy(tmp_path, LANDING_ENTRY)], capsys)
    assert code == 0, out
    for k in ("file", "governing", "pre-f-refused", "f-allowed"):
        assert f"PASS [floor:{k}]" in out
    assert "REFUSED (target v4.162.0 is below the revert floor v4.164.0" in out


def test_floor_mutant_entry_floor_at_pre_f_fails(tmp_path, capsys):
    code, out = _floor(["--floors-file", _floors_copy(tmp_path, {**LANDING_ENTRY, "floor": "v4.162.0"})], capsys)
    assert code == 1
    assert "FAIL [floor:governing]" in out and "its floor is v4.162.0, not v4.164.0" in out
    assert "FAIL [floor:pre-f-refused]" in out


def test_floor_mutant_unparseable_file_fails(tmp_path, capsys):
    code, out = _floor(["--floors-file", _floors_copy(tmp_path, raw='{"floors": [')], capsys)
    assert code == 1
    assert "FAIL [floor:file]" in out and "is not valid JSON" in out
    assert out.count("not judged: the floors file does not load") == 3


def test_floor_the_planned_entry_is_refused_by_revert_floors_itself(tmp_path, capsys):
    code, out = _floor(["--floors-file", _floors_copy(tmp_path, {**LANDING_ENTRY, "since": "v4.163.0"})], capsys)
    assert code == 1
    assert "FAIL [floor:file]" in out and "is above since" in out


def test_floor_asks_revert_to_not_a_copy(tmp_path, capsys, monkeypatch):
    """The refusal is revert-to.py's: with its function stubbed to allow everything, the check goes red."""
    class Stub:
        class RevertError(Exception):
            pass

        @staticmethod
        def current_prod_version(cfg):
            raise AssertionError("must be replaced by the caller")

        @staticmethod
        def require_target_above_floor(cfg, floors_path=None):
            return None

    monkeypatch.setattr(psc, "_revert_to_module", lambda: Stub)
    code, out = _floor(["--floors-file", _floors_copy(tmp_path, LANDING_ENTRY)], capsys)
    assert code == 1 and "FAIL [floor:pre-f-refused]" in out and "PASS [floor:governing]" in out


def test_floor_a_refusal_for_another_reason_is_not_the_floors(tmp_path, capsys, monkeypatch):
    """revert-to refusing because it could not read the file is not "v4.162.0 is below the F floor"."""
    class Stub:
        class RevertError(Exception):
            pass

        current_prod_version = staticmethod(lambda cfg: None)

        @classmethod
        def require_target_above_floor(cls, cfg, floors_path=None):
            raise cls.RevertError("revert floor unreadable (disk); refusing")

    monkeypatch.setattr(psc, "_revert_to_module", lambda: Stub)
    code, out = _floor(["--floors-file", _floors_copy(tmp_path, LANDING_ENTRY)], capsys)
    assert code == 1 and "FAIL [floor:pre-f-refused]" in out and "FAIL [floor:f-allowed]" in out


def test_floor_leaves_revert_to_as_it_found_it(tmp_path):
    mod = psc._revert_to_module()
    before = mod.current_prod_version
    refused, words = psc.revert_to_verdict("v4.162.0", F_VERSION, _floors_copy(tmp_path, LANDING_ENTRY))
    assert refused and "is below the revert floor v4.164.0" in words
    assert mod.current_prod_version is before


@pytest.mark.parametrize("argv", [
    ["--floor", "--since", "v4.163.0"],
    ["--floor", "--f-version", F_VERSION, "--since", "v4.163.0"],
    ["--floor", "--f-version", "4.164.0"],
    ["--floor", "--f-version", F_VERSION, "--pre-f-version", "v4.164.0"],
    ["--floor", "--f-version", F_VERSION, "--pre-f-version", "4.162"],
])
def test_floor_argument_errors_exit_2(argv, capsys):
    with pytest.raises(SystemExit) as e:
        psc.main(argv)
    assert e.value.code == 2
    if "--since" in argv:
        assert "--since is gone" in capsys.readouterr().err


@pytest.mark.parametrize("argv", [
    ["--precondition"],
    ["--precondition", "--promoted-after", "2026-09-30T02:00:00"],
    ["--precondition", "--promoted-after", "tonight"],
    ["--f-deployed"],
    ["--f-deployed", "--only", "bundle,dns"],
    ["--floor"],
    ["--floor", "--f-version", "4.163"],
    ["--precondition", "--floor", "--f-version", "v4.164.0"],
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
