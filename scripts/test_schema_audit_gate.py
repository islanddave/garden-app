"""dev-main-schema-audit.py --gate: the mode promote-gate.yml's prod schema gate runs (OPS-PROMOTESCHEMAGATE-001).

Run: python3 -m pytest -q scripts/test_schema_audit_gate.py

Two differences from the advisory run, both pinned here in each direction, against a fixture tree and a stand-in
information_schema (no database):
  (a) a Phase-1 contract the parser cannot read is SKIPPED by the advisory run with a stderr WARN and exit 0. Under
      --gate it exits 2 ("cannot verify"), unless a definite FAIL already exits 1. Review IMPORTANT 1: wrapping a
      contract array in Object.freeze([...]) hid a missing column behind a passing gate, with Phase 4 unchanged.
  (b) a STALE waiver (the column now exists in prod) fails the advisory run. Under --gate it is a WARN: prod has the
      column, so nothing is unsafe to ship, and refusing would block every promote until a new dev commit deleted
      the entry (review IMPORTANT 3).
Everything else, a missing column or relation, a Phase-4 coverage regression, exits exactly as it does without the
flag. The last test holds the real tree to (a): every contract in lambda/ must parse, so a contract the gate would
refuse reds this suite on the dev push, before any promote.
"""
import glob
import importlib.util
import json
import os
import sys
import types

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("schema_audit", os.path.join(HERE, "dev-main-schema-audit.py"))
audit = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(audit)

PROD = {"t_prefs": ["created_by", "a", "b"], "t_other": ["id", "name"], "t_joined": ["id"]}
PREFS_CONTRACT = "const AUDIT_COLUMNS = {\n  t_prefs: ['created_by', 'a', 'b'],\n};\n"
OTHER_CONTRACT = "const AUDIT_TABLES = ['t_other'];\nconst OTHER_COLUMNS = ['id', 'name'];\n"
# The review's shape: the column array wrapped in a call, so `const X_COLUMNS = [ ... ];` no longer matches, the
# file resolves no columns, and the advisory run skips it -- zz_fake, which prod lacks, is never checked.
FROZEN_CONTRACT = "const AUDIT_TABLES = ['t_other'];\nconst OTHER_COLUMNS = Object.freeze(['id', 'name', 'zz_fake']);\n"
HANDLER = ("export const h = (sql) => sql`INSERT INTO t_prefs (created_by, a) VALUES (1, 2)`;\n"
           "export const g = (sql) => sql`SELECT id, name FROM t_other`;\n")
STALE = {"waived_refs": {"t_prefs.a": {"flag": "F"}}}  # t_prefs.a exists in PROD


def _tree(root, files, baseline=0):
    base = {"lambda/x/prefs-columns.test.js": PREFS_CONTRACT, "lambda/x/select-columns.test.js": OTHER_CONTRACT,
            "lambda/x/index.js": HANDLER}
    base.update(files)
    for rel, text in base.items():
        if text is None:
            continue
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text if isinstance(text, str) else json.dumps(text))
    (root / "scripts").mkdir(exist_ok=True)
    (root / "scripts" / "schema-audit-join-baseline.json").write_text(json.dumps({"uncovered_relations": baseline}))
    return root


@pytest.fixture
def run_audit(tmp_path, monkeypatch, capsys):
    """Run audit.main() on a fixture tree against PROD. Returns (exit code, stdout, stderr)."""
    fake_pg = types.ModuleType("psycopg2")
    fake_pg.connect = lambda _url: types.SimpleNamespace(close=lambda: None)
    monkeypatch.setitem(sys.modules, "psycopg2", fake_pg)
    monkeypatch.setattr(audit, "query_prod_columns", lambda _conn, table: set(PROD.get(table, [])))
    monkeypatch.setenv("NEON_DATABASE_URL", "postgresql://fake.invalid/db")

    def run(files, *flags, baseline=0):
        repo = _tree(tmp_path / "repo", files, baseline)
        monkeypatch.setattr(sys, "argv", ["dev-main-schema-audit.py", "--repo-root", str(repo), *flags])
        rc = audit.main()
        out = capsys.readouterr()
        return rc, out.out, out.err

    return run


def test_a_clean_tree_passes_with_and_without_gate(run_audit):
    for flags in ([], ["--gate"]):
        rc, out, _ = run_audit({}, *flags)
        assert rc == 0 and "PASS: 7 column refs" in out, out


# ── (a) an unparseable contract ───────────────────────────────────────────────────────────────────────────────
# lambda/x/other2-columns.test.js keeps t_other declared in the handler's own directory, so the skip leaves Phase 4
# exactly where it was: the P4-blind case the review measured on 9 of 128 real contracts.
BLIND_SKIP = {"lambda/x/select-columns.test.js": FROZEN_CONTRACT, "lambda/x/other2-columns.test.js": OTHER_CONTRACT}


def test_advisory_run_still_only_warns_on_an_unparseable_contract(run_audit):
    rc, out, err = run_audit(BLIND_SKIP)
    assert rc == 0, out + err
    assert "1 skipped -- UNAUDITED: lambda/x/select-columns.test.js" in out
    assert "WARN: could not parse table/columns from lambda/x/select-columns.test.js" in err
    assert "--gate" not in out + err


def test_gate_refuses_an_unparseable_contract_it_would_otherwise_pass(run_audit):
    rc, out, _ = run_audit(BLIND_SKIP, "--gate")
    assert rc == 2, out
    assert ("ERROR: --gate: 1 Phase-1 contract file(s) could not be parsed, so their columns were NOT checked against "
            "prod (cannot verify): lambda/x/select-columns.test.js") in out
    assert "UNVERIFIED (--gate): exit 2" in out and "PASS:" not in out
    assert "P4: 1 lambda(s), 1 relation ref(s) touched, 0 with NO column contract (baseline 0)" in out  # P4-blind


def test_gate_a_definite_fail_still_exits_1_and_the_skip_is_still_reported(run_audit):
    files = dict(BLIND_SKIP, **{"lambda/x/index.js": HANDLER.replace("(created_by, a)", "(created_by, a, zz_new)")})
    rc, out, _ = run_audit(files, "--gate")
    assert rc == 1, out
    assert "FAIL: 1 of 8 column refs are MISSING in prod Neon" in out and "- zz_new  [P2]" in out
    assert "ERROR: --gate: 1 Phase-1 contract file(s) could not be parsed" in out
    assert "HALT before squash-merge" not in out and "L-081 (--gate): apply the additive migration" in out


def test_gate_skip_that_also_regresses_phase_4_exits_1_with_both_lines(run_audit):
    """Without a second contract in the directory, the skip un-declares t_other: Phase 4 regresses too."""
    rc, out, _ = run_audit({"lambda/x/select-columns.test.js": FROZEN_CONTRACT}, "--gate")
    assert rc == 1, out
    assert "FAIL: joined-relation coverage REGRESSED -- 1 uncovered, baseline 0." in out
    assert "ERROR: --gate: 1 Phase-1 contract file(s) could not be parsed" in out


# ── (b) a stale waiver ─────────────────────────────────────────────────────────────────────────────────────────
def test_advisory_run_still_fails_a_stale_waiver(run_audit):
    rc, out, _ = run_audit({"scripts/schema-audit-allowlist.json": STALE})
    assert rc == 1, out
    assert "FAIL: 1 STALE waiver(s) in schema-audit-allowlist.json" in out and "PASS:" not in out


def test_gate_warns_on_a_stale_waiver_and_passes(run_audit):
    rc, out, _ = run_audit({"scripts/schema-audit-allowlist.json": STALE}, "--gate")
    assert rc == 0, out
    assert ("WARN: 1 STALE waiver(s) in schema-audit-allowlist.json — the column now exists in prod "
            "(--gate: not a refusal, prod already has it):") in out
    assert "    - t_prefs.a  (delete this entry on dev" in out and "PASS: 7 column refs" in out
    assert "FAIL" not in out


def test_gate_stale_waiver_does_not_hide_a_real_missing_column(run_audit):
    files = {"scripts/schema-audit-allowlist.json": STALE,
             "lambda/x/index.js": HANDLER.replace("(created_by, a)", "(created_by, a, zz_new)")}
    rc, out, _ = run_audit(files, "--gate")
    assert rc == 1, out
    assert "WARN: 1 STALE waiver(s)" in out and "FAIL: 1 of 8 column refs are MISSING in prod Neon" in out


def test_gate_still_honours_a_live_waiver(run_audit):
    files = {"scripts/schema-audit-allowlist.json": {"waived_refs": {"t_prefs.zz_new": {"flag": "F"}}},
             "lambda/x/index.js": HANDLER.replace("(created_by, a)", "(created_by, a, zz_new)")}
    rc, out, _ = run_audit(files, "--gate")
    assert rc == 0, out
    assert "WAIVED [P2] t_prefs.zz_new" in out


# ── (c) the hard fails are the same with and without the flag ─────────────────────────────────────────────────
@pytest.mark.parametrize("files,rc_want,line", [
    ({"lambda/x/index.js": HANDLER + "export const n = (sql) => sql`SELECT id FROM zz_new_table`;\n"}, 1,
     "FAIL: 1 relation(s) queried by a handler do NOT exist in prod:"),
    ({"lambda/x/index.js": HANDLER + "export const j = (sql) => sql`SELECT o.id FROM t_other o JOIN t_joined j ON true`;\n"},
     1, "FAIL: joined-relation coverage REGRESSED -- 1 uncovered, baseline 0."),
    ({"lambda/x/prefs-columns.test.js": PREFS_CONTRACT.replace("'b'", "'b', 'zz_new'")}, 1,
     "FAIL: 1 of 8 column refs are MISSING in prod Neon (Phase 1: 1, Phase 2: 0, Phase 3 soft-delete: 0):"),
    ({"lambda/x/prefs-columns.test.js": PREFS_CONTRACT.replace("t_prefs:", "t_nope:"),
      "lambda/x/select-columns.test.js": None}, 2, "has ZERO columns in prod information_schema"),
    # A relation a handler SELECTs cannot be waived: the waiver below covers every column the new handler reads,
    # and the gate still refuses, because Phase 4's existence check runs before waivers apply (review IMPORTANT 2).
    ({"lambda/x/index.js": HANDLER + "export const n = (sql) => sql`SELECT id FROM zz_new_table`;\n",
      "scripts/schema-audit-allowlist.json": {"waived_refs": {"zz_new_table.id": {"flag": "F"}}}}, 1,
     "FAIL: 1 relation(s) queried by a handler do NOT exist in prod:"),
], ids=["absent-relation", "coverage-regressed", "missing-column", "empty-relation", "relation-not-waivable"])
def test_hard_fails_exit_the_same_with_and_without_gate(run_audit, files, rc_want, line):
    for flags in ([], ["--gate"]):
        rc, out, err = run_audit(files, *flags)
        assert rc == rc_want, (flags, out, err)
        assert line in out + err, (flags, out, err)


def test_a_table_a_handler_only_inserts_into_is_waived_column_by_column(run_audit):
    """The other side of the waiver rule, pinned so the header and docstring stay true (review re-check MINOR):
    Phase 4 sees FROM/JOIN only, so a new table reached ONLY by an INSERT arrives as Phase-2 column misses, and a
    waiver for each column passes it, with and without --gate. Changing that is a design call, not a text fix."""
    files = {"lambda/x/log.js": "export const l = (sql) => sql`INSERT INTO zz_new_log (item_id, noted_at) VALUES (1, 2)`;\n",
             "scripts/schema-audit-allowlist.json": {"waived_refs": {"zz_new_log.item_id": {"flag": "F"},
                                                                     "zz_new_log.noted_at": {"flag": "F"}}}}
    for flags in ([], ["--gate"]):
        rc, out, err = run_audit(files, *flags)
        assert rc == 0, (flags, out, err)
        assert out.count("WAIVED [P2] zz_new_log.") == 2 and "do NOT exist in prod" not in out, (flags, out)


# ── the real tree: nothing the gate would refuse as unparseable ───────────────────────────────────────────────
def test_every_real_column_contract_parses():
    """(a) on the real repo, DB-free: a contract the parser cannot read would make the promote gate exit 2. This
    reds on the dev push instead, naming the file."""
    files = sorted(glob.glob(os.path.join(HERE, "..", "lambda", "**", audit.PHASE1_GLOB), recursive=True))
    files = [f for f in files if "node_modules" not in f]
    assert len(files) >= 100, f"only {len(files)} contracts found: the glob or the tree is wrong"
    unparsed = [os.path.relpath(f, os.path.join(HERE, "..")) for f in files if not audit.parse_test_file(
        audit.Path(f))]
    assert unparsed == [], f"the promote gate would refuse (exit 2) on these unparseable contracts: {unparsed}"
