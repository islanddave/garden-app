"""scripts/ci-telemetry/coverage-rows.py, the A3 trial's coverage comparison, against a real runner log.

Run: python3 -m pytest -q scripts/test_coverage_rows.py

The fixture is the coverage table of a real `build-and-test` job log (job 109410936277, 2026-09-29), as
`gh api .../actions/jobs/<id>/logs` returns it: the runner's timestamps, every directory row, and the first two file
rows under each directory. Nothing else of the log is kept. Each case below changes that text the way a second log
could differ from it and holds what the command prints and exits with.
"""
import importlib.util
import os
import re

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "ci-telemetry", "coverage-rows.py")
FIXTURE = os.path.join(HERE, "fixtures", "coverage-rows", "build-and-test-job-109410936277-coverage.txt")

_spec = importlib.util.spec_from_file_location("coverage_rows", SCRIPT)
cov = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cov)

with open(FIXTURE, encoding="utf-8") as _fh:
    LOG = _fh.read()

HARVESTS = " lambda/harvests   |   83.09 |     75.9 |   89.67 |   85.01 |"
DAILY_PLAN = " lambda/daily-plan |   85.96 |    78.26 |   86.15 |   86.18 |"
ALL_FILES = "All files          |   88.99 |    82.95 |   91.39 |   92.19 |"
A_FILE = "  altText.js       |   96.05 |    93.33 |     100 |   98.33 |"


def _changed(old, new):
    assert LOG.count(old) == 1, old
    return LOG.replace(old, new)


def _without(row):
    kept = [line for line in LOG.split("\n") if row not in line]
    assert len(kept) == len(LOG.split("\n")) - 1, row
    return "\n".join(kept)


def _run(tmp_path, capsys, serial, shadow):
    paths = []
    for name, text in (("serial.txt", serial), ("shadow.txt", shadow)):
        path = tmp_path / name
        path.write_text(text, encoding="utf-8")
        paths.append(str(path))
    code = cov.main(["coverage-rows.py"] + paths)
    return code, capsys.readouterr().out


def test_the_runner_log_reads_as_its_fifteen_directory_rows_and_no_file_row():
    read = cov.rows(LOG)
    assert sorted(read) == sorted([
        "...facebook-share", "lambda/harvests", "src/components", "...nents/findings", "...mponents/forms",
        "...onents/kitchen", "...mponents/photo", "...nents/planting", "...mponents/putup", "...omponents/seed",
        "...mponents/today", "...nents/today/v2", "src/context", "src/hooks", "src/lib"])
    assert read["lambda/harvests"] == ("89.67", "85.01")       # % Funcs, % Lines: the fourth and fifth columns
    assert read["...nents/findings"] == ("100", "100")
    assert len(re.findall(r"\.(?:jsx?|json) +\|", LOG)) > 20   # the fixture does hold file rows to leave out


def test_only_the_total_and_lambda_daily_plan_are_left_out():
    assert cov.EXCLUDED == ("All files", "lambda/daily-plan")


def test_a_log_against_itself_is_the_same(tmp_path, capsys):
    assert _run(tmp_path, capsys, LOG, LOG) == (
        0, "COVERAGE-SAME: 15 directory rows outside lambda/daily-plan, % Funcs and % Lines equal\n")


def test_a_local_log_without_timestamps_or_with_colour_reads_the_same(tmp_path, capsys):
    local = re.sub(r"(?m)^\S+Z ", "", LOG)
    assert local != LOG and cov.rows(local) == cov.rows(LOG)
    coloured = "\n".join("\x1b[2m%s\x1b[22m" % line for line in local.split("\n"))
    assert cov.rows(coloured) == cov.rows(LOG)
    assert _run(tmp_path, capsys, LOG, local)[0] == 0


@pytest.mark.parametrize("old, new", [
    (DAILY_PLAN, " lambda/daily-plan |   87.95 |    80.53 |   87.38 |   88.46 |"),
    (ALL_FILES, "All files          |   89.12 |    83.03 |   91.43 |   92.33 |"),
    (HARVESTS, " lambda/harvests   |   83.19 |     76.1 |   89.67 |   85.01 |"),    # statements and branches only
    (A_FILE, "  altText.js       |   96.05 |    93.33 |      50 |      50 |"),      # a file row is not a directory's
], ids=["lambda/daily-plan", "All files", "statements and branches", "a file row"])
def test_what_is_not_compared_does_not_differ(tmp_path, capsys, old, new):
    code, out = _run(tmp_path, capsys, LOG, _changed(old, new))
    assert (code, out[:14]) == (0, "COVERAGE-SAME:")


@pytest.mark.parametrize("new, said", [
    (" lambda/harvests   |   83.09 |     75.9 |   89.67 |   85.02 |", "% Funcs 89.67, % Lines 85.02"),
    (" lambda/harvests   |   83.09 |     75.9 |   89.66 |   85.01 |", "% Funcs 89.66, % Lines 85.01"),
], ids=["lines", "functions"])
def test_a_directory_outside_lambda_daily_plan_that_moves_differs(tmp_path, capsys, new, said):
    code, out = _run(tmp_path, capsys, LOG, _changed(HARVESTS, new))
    assert code == 1
    assert out == ("COVERAGE-DIFFERS: 1 of 15 directory rows outside lambda/daily-plan\n"
                   "  lambda/harvests: serial % Funcs 89.67, % Lines 85.01; shadow " + said + "\n")


@pytest.mark.parametrize("shadow_lacks_it", [True, False], ids=["gone from the shadow", "gone from the serial"])
def test_a_row_in_one_log_only_differs(tmp_path, capsys, shadow_lacks_it):
    short = _without(" src/hooks ")
    code, out = _run(tmp_path, capsys, *((LOG, short) if shadow_lacks_it else (short, LOG)))
    assert code == 1
    assert "COVERAGE-DIFFERS: 1 of 15 directory rows" in out
    there, gone = "% Funcs 93.25, % Lines 94.4", "no such row"
    assert ("  src/hooks: serial %s; shadow %s\n" % ((there, gone) if shadow_lacks_it else (gone, there))) in out


@pytest.mark.parametrize("text, why", [
    ("npm test\nno table in this log\n", "no row 'All files' / 'lambda/daily-plan'"),
    (_without(" lambda/daily-plan "), "no row 'lambda/daily-plan'"),
    (LOG + LOG, "the row 'All files' is there twice"),
    ("\n".join(LOG.split("\n")[:20]), "directory rows besides All files and lambda/daily-plan, want at least 10"),
], ids=["no table", "no lambda/daily-plan row", "two tables", "cut short"])
def test_a_log_that_does_not_hold_one_whole_table_is_unreadable_never_the_same(tmp_path, capsys, text, why):
    for serial, shadow in ((text, LOG), (LOG, text), (text, text)):
        code, out = _run(tmp_path, capsys, serial, shadow)
        assert code == 2 and out.startswith("COVERAGE-UNREADABLE: ") and why in out, out


def test_a_missing_file_or_a_wrong_argument_count_exits_2(tmp_path, capsys):
    path = tmp_path / "serial.txt"
    path.write_text(LOG, encoding="utf-8")
    assert cov.main(["coverage-rows.py", str(path), str(tmp_path / "absent.txt")]) == 2
    assert "COVERAGE-UNREADABLE: " in capsys.readouterr().out
    assert cov.main(["coverage-rows.py", str(path)]) == 2


def test_the_fixture_is_the_table_and_nothing_else_of_the_log():
    lines = LOG.split("\n")
    assert lines[-1] == "" and len(lines) == 53
    shape = re.compile(r"2026-09-29T13:23:54\.\d{7}Z [ A-Za-z0-9_./|%#,-]+")
    assert [line for line in lines[:-1] if not shape.fullmatch(line)] == []
