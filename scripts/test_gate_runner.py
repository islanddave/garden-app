#!/usr/bin/env python3
"""Tests for scripts/gate_runner.py (OPS-GATERUNNER-001).

The runner exists because 400 correct assertions sat unexecuted. Its own
failure mode would be subtler and worse: reporting green over gates it quietly
did not run. So the bulk of these tests are about the LOUD-vs-SILENT contract --
every malformed input must raise, and no code path may ever turn a gate into a
silent pass.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gate_runner as gr  # noqa: E402


def write(tmp_path, text, name="gates.yml"):
    p = tmp_path / name
    p.write_text(text)
    return p


VALID = """
pre:
  - name: pre_a
    sql: SELECT 1
    expect: rowcount_eq
    value: 1
post:
  - name: post_a
    sql: |
      SELECT data_type FROM information_schema.columns
       WHERE table_name='t'
    expect: scalar_eq
    value: text
"""


# ---------------------------------------------------------------- parsing ----

def test_valid_file_parses_both_phases(tmp_path):
    gates = gr.load_gate_file(write(tmp_path, VALID))
    assert [g["name"] for g in gates] == ["pre_a", "post_a"]
    assert [g["phase"] for g in gates] == ["pre", "post"]
    assert gates[0]["env"] == "both"          # default
    assert gates[0]["retired"] is None


def test_sweep_phase_and_empty_sections(tmp_path):
    p = write(tmp_path, "pre: []\nsweep: []\npost:\n  - {name: p, sql: SELECT 1, expect: rowcount_eq, value: 0}\n")
    assert len(gr.load_gate_file(p)) == 1


@pytest.mark.parametrize("body,fragment", [
    ("pre_gates:\n  - {name: a, sql: SELECT 1, expect: rowcount_eq, value: 1}\n", "unknown top-level key"),
    ("mid:\n  - {name: a, sql: SELECT 1, expect: rowcount_eq, value: 1}\n", "unknown top-level key"),
    ("pre:\n  - {name: a, sql: SELECT 1, expects: rowcount_eq, value: 1}\n", "unknown key"),
    ("pre:\n  - {name: a, sql: SELECT 1, expect: bogus_kind, value: 1}\n", "expect must be one of"),
    ("pre:\n  - {name: a, sql: SELECT 1, expect: rowcount_eq}\n", "missing 'value'"),
    ("pre:\n  - {name: a, expect: rowcount_eq, value: 1}\n", "missing 'sql'"),
    ("pre:\n  - {sql: SELECT 1, expect: rowcount_eq, value: 1}\n", "missing or non-string 'name'"),
    ("pre:\n  - {name: a, sql: SELECT 1, expect: rowcount_eq, value: 1, env: dev}\n", "env must be one of"),
    ("pre:\n  - {name: a, sql: SELECT 1, expect: rowcount_eq, value: notanint}\n", "requires an integer"),
    ("pre: {not: a list}\n", "must be a list"),
    ("- just\n- a list\n", "top level must be a mapping"),
    ("", "file is empty"),
])
def test_schema_violations_raise_loudly(tmp_path, body, fragment):
    """Every malformed shape must RAISE. None may be skipped."""
    with pytest.raises(gr.GateSchemaError) as e:
        gr.load_gate_file(write(tmp_path, body))
    assert fragment in str(e.value)


def test_unparseable_yaml_raises(tmp_path):
    with pytest.raises(gr.GateSchemaError) as e:
        gr.load_gate_file(write(tmp_path, "pre:\n  - name: a\n   bad indent: [\n"))
    assert "YAML parse failed" in str(e.value)


def test_duplicate_gate_name_in_phase_raises(tmp_path):
    body = ("pre:\n"
            "  - {name: dup, sql: SELECT 1, expect: rowcount_eq, value: 1}\n"
            "  - {name: dup, sql: SELECT 2, expect: rowcount_eq, value: 1}\n")
    with pytest.raises(gr.GateSchemaError, match="duplicate gate name"):
        gr.load_gate_file(write(tmp_path, body))


# --------------------------------------------------- read-only enforcement ----

@pytest.mark.parametrize("sql", [
    "UPDATE t SET x=1",
    "DELETE FROM t",
    "INSERT INTO t VALUES (1)",
    "DROP TABLE t",
    "ALTER TABLE t ADD COLUMN x int",
    "TRUNCATE t",
    "CREATE TABLE t (x int)",
    "GRANT ALL ON t TO public",
])
def test_layer1_rejects_writes(sql):
    with pytest.raises(gr.GateSchemaError, match="must begin with SELECT or WITH"):
        gr.validate_sql_readonly(sql, "w")


def test_layer1_rejects_multi_statement():
    with pytest.raises(gr.GateSchemaError, match="single read-only statement"):
        gr.validate_sql_readonly("SELECT 1; DROP TABLE t", "w")


def test_layer1_allows_select_with_and_parenthesised():
    for sql in ["SELECT 1", "  select 1 ", "WITH a AS (SELECT 1) SELECT * FROM a", "(SELECT 1)"]:
        assert gr.validate_sql_readonly(sql, "w")


def test_layer1_allows_trailing_semicolon_and_comments():
    assert gr.validate_sql_readonly("-- lead comment\nSELECT 1;\n", "w")
    assert gr.validate_sql_readonly("/* block */ SELECT 1", "w")


def test_layer1_not_fooled_by_a_comment_before_a_write():
    """A DELETE hidden behind a comment must still be rejected."""
    with pytest.raises(gr.GateSchemaError):
        gr.validate_sql_readonly("-- SELECT 1\nDELETE FROM t", "w")


def test_empty_sql_rejected():
    with pytest.raises(gr.GateSchemaError, match="sql is empty"):
        gr.validate_sql_readonly("-- only a comment", "w")


# ------------------------------------------------------------- comparison ----

def test_rowcount_eq():
    assert gr.compare("rowcount_eq", 0, 0, None)[0] is True
    assert gr.compare("rowcount_eq", 0, 3, None)[0] is False
    assert gr.compare("rowcount_eq", 2, 2, None)[0] is True


def test_rowcount_gte():
    assert gr.compare("rowcount_gte", 21, 21, None)[0] is True
    assert gr.compare("rowcount_gte", 21, 99, None)[0] is True
    assert gr.compare("rowcount_gte", 21, 8, None)[0] is False


def test_scalar_eq_zero_rows_is_a_failure_not_a_pass():
    """THE keystone case.

    `SELECT convalidated FROM pg_constraint WHERE conname='x'` returns ZERO rows
    when the constraint is missing -- the exact shape of a real regression. If
    absence were treated as anything but a failure, the runner would report
    green on a dropped constraint.
    """
    ok, detail = gr.compare("scalar_eq", True, 0, None)
    assert ok is False
    assert "no rows" in detail


def test_scalar_eq_multiple_rows_is_a_failure():
    ok, detail = gr.compare("scalar_eq", "text", 2, "text")
    assert ok is False
    assert "needs exactly 1" in detail


def test_scalar_eq_boolean_roundtrip():
    assert gr.compare("scalar_eq", True, 1, True)[0] is True
    assert gr.compare("scalar_eq", True, 1, False)[0] is False


def test_scalar_eq_string_and_numeric_coercion():
    assert gr.compare("scalar_eq", "timestamp with time zone", 1, "timestamp with time zone")[0]
    assert gr.compare("scalar_eq", 30, 1, 30)[0] is True
    assert gr.compare("scalar_eq", 30, 1, 31)[0] is False
    # column_default is text 'false' in the corpus, not a bool.
    assert gr.compare("scalar_eq", "false", 1, "false")[0] is True


def test_scalar_eq_null_scalar_does_not_equal_expected():
    assert gr.compare("scalar_eq", 0, 1, None)[0] is False


def test_unknown_expect_kind_raises_rather_than_passing():
    with pytest.raises(gr.GateSchemaError):
        gr.compare("rowcount_approximately", 1, 1, None)


# ------------------------------------------------- manual / retired / env ----

def test_manual_gate_loads_and_is_never_a_pass(tmp_path):
    p = write(tmp_path, "post:\n  - name: m\n    manual: true\n    note: diff the rows by hand\n")
    g = gr.load_gate_file(p)[0]
    assert g["manual"] is True
    res = gr.run_gates(None, [g], "prod", strict_env=False)[0]
    assert res["status"] == "MANUAL"          # never PASS


def test_manual_gate_requires_a_note(tmp_path):
    with pytest.raises(gr.GateSchemaError, match="requires a 'note'"):
        gr.load_gate_file(write(tmp_path, "post:\n  - {name: m, manual: true}\n"))


def test_manual_gate_may_not_carry_sql(tmp_path):
    body = "post:\n  - {name: m, manual: true, note: x, sql: SELECT 1}\n"
    with pytest.raises(gr.GateSchemaError, match="must not carry 'sql'"):
        gr.load_gate_file(write(tmp_path, body))


def test_retired_gate_is_reported_and_not_executed(tmp_path):
    body = ("post:\n  - name: r\n    sql: SELECT 1\n    expect: rowcount_eq\n    value: 0\n"
            "    retired: superseded by v4-cal1-sampleconf-001\n")
    g = gr.load_gate_file(write(tmp_path, body))[0]
    # conn=None proves it is never executed -- a query would raise on None.
    res = gr.run_gates(None, [g], "prod", strict_env=False)[0]
    assert res["status"] == "RETIRED"
    assert "superseded" in res["detail"]


def test_retired_must_carry_a_reason(tmp_path):
    body = "post:\n  - {name: r, sql: SELECT 1, expect: rowcount_eq, value: 0, retired: true}\n"
    with pytest.raises(gr.GateSchemaError, match="non-empty string"):
        gr.load_gate_file(write(tmp_path, body))


def test_env_scoped_gate_skipped_on_other_env_and_marked(tmp_path):
    body = "post:\n  - {name: p, sql: SELECT 1, expect: rowcount_eq, value: 0, env: prod}\n"
    g = gr.load_gate_file(write(tmp_path, body))[0]
    res = gr.run_gates(None, [g], "staging", strict_env=False)[0]
    assert res["status"] == "NOT_APPLICABLE"   # reported, and not a PASS
    assert "declared env=prod" in res["detail"]


def test_strict_env_turns_inapplicable_into_failure(tmp_path):
    body = "post:\n  - {name: p, sql: SELECT 1, expect: rowcount_eq, value: 0, env: prod}\n"
    g = gr.load_gate_file(write(tmp_path, body))[0]
    assert gr.run_gates(None, [g], "staging", strict_env=True)[0]["status"] == "FAIL"


def test_env_both_runs_everywhere(tmp_path):
    g = gr.load_gate_file(write(tmp_path, VALID))[0]
    assert g["env"] == "both"


# ----------------------------------------------------------- integration ----

class FakeCursor:
    def __init__(self, outcome):
        self.outcome = outcome
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False
    def execute(self, sql):
        if isinstance(self.outcome, Exception):
            raise self.outcome
    def fetchall(self):
        return self.outcome


class FakeConn:
    """Records rollbacks so the transaction-isolation contract is testable."""
    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.rollbacks = 0
    def cursor(self):
        return FakeCursor(self.outcomes.pop(0))
    def rollback(self):
        self.rollbacks += 1


def _gate(name, expect="rowcount_eq", value=0):
    return {"phase": "post", "name": name, "manual": False, "sql": "SELECT 1",
            "expect": expect, "value": value, "note": None, "env": "both",
            "retired": None, "path": "p/gates.yml"}


def test_run_gates_pass_and_fail():
    conn = FakeConn([[], [(1,)]])
    res = gr.run_gates(conn, [_gate("a"), _gate("b")], "prod", False)
    assert [r["status"] for r in res] == ["PASS", "FAIL"]


def test_query_error_is_a_failure_status_not_an_exception():
    """A missing table is the regression these gates catch -- report, don't crash."""
    boom = RuntimeError("relation \"public.event_log_archive\" does not exist")
    res = gr.run_gates(FakeConn([boom]), [_gate("a")], "prod", False)
    assert res[0]["status"] == "ERROR"
    assert "does not exist" in res[0]["detail"]


def test_every_gate_is_rolled_back_so_one_error_cannot_poison_the_rest():
    """Regression test for the 25P02 cascade.

    Without a rollback after each gate, one failing query aborted the
    transaction and every later gate reported a bogus error -- turning a single
    real finding into a wall of fake ones.
    """
    boom = RuntimeError("boom")
    conn = FakeConn([boom, []])
    res = gr.run_gates(conn, [_gate("a"), _gate("b")], "prod", False)
    assert [r["status"] for r in res] == ["ERROR", "PASS"]
    assert conn.rollbacks == 2


def test_results_never_contain_an_unknown_status():
    conn = FakeConn([[], [(1,)], RuntimeError("x")])
    gates = [_gate("a"), _gate("b"), _gate("c"),
             {**_gate("d"), "manual": True, "note": "by hand"},
             {**_gate("e"), "retired": "superseded"},
             {**_gate("f"), "env": "staging"}]
    res = gr.run_gates(conn, gates, "prod", False)
    allowed = {"PASS", "FAIL", "ERROR", "MANUAL", "RETIRED", "NOT_APPLICABLE"}
    assert {r["status"] for r in res} <= allowed
    assert len(res) == len(gates)          # nothing silently dropped


# --------------------------------------------- the real corpus still loads ----

def test_every_tracked_corpus_gate_file_is_schema_valid():
    """Guard against a new migration reintroducing an unrunnable gate file.

    Scoped to GIT-TRACKED files, which is exactly what CI checks out. Untracked
    work-in-progress from a concurrent session must not red this suite -- but it
    is caught the moment it is committed, which is the point at which it becomes
    everyone's problem.
    """
    import subprocess
    try:
        out = subprocess.run(
            ["git", "ls-files", "migrations/*/gates.yml"],
            cwd=gr.REPO_ROOT, capture_output=True, text=True, timeout=30,
        )
        tracked = [gr.REPO_ROOT / line for line in out.stdout.split() if line]
    except Exception:  # pragma: no cover - git absent
        tracked = []
    repo_files = tracked or sorted(gr.MIGRATIONS_DIR.glob("*/gates.yml"))
    if not repo_files:
        pytest.skip("no migrations checked out")
    errors = []
    for p in repo_files:
        try:
            gr.load_gate_file(p)
        except gr.GateSchemaError as exc:
            errors.append(str(exc))
    assert not errors, "unrunnable gate file(s):\n" + "\n".join(errors)
