"""dev-main-schema-audit.py Phase 4 ratchet, run DB-free on the REAL tree (review-F-prepromote-early B1).

Run: python3 -m pytest -q scripts/test_schema_audit_join_ratchet.py

The Phase 4 ratchet (uncovered_relations in scripts/schema-audit-join-baseline.json, may fall, never rise) is set
arithmetic over two parses of the source tree and needs no database. The audit only reaches it after Phase 4(a),
which asks prod whether every relation a handler queries exists, and returns early while one does not. So a
branch that brings its own DDL AND queries a relation with no column contract passes every pre-promote signal: the
dispatched audit stops at 4(a) on the not-yet-applied table, and the ratchet first fires inside promote-gate's prod
schema gate, after the prod DDL and the dev push. The Put-Up train did exactly that: merge.js queried four
relations nothing in lambda/plants declared, 51 uncovered against 47.

This runs the audit's own main() -- the code promote-gate runs, not a copy of its filter -- with only the database
stubbed: every relation exists and has every column. Phases 1-3 and 4(a) therefore pass by construction, and what
remains is the ratchet, computed by the auditor itself. --gate because that is the mode promote-gate passes, and
because under it a waiver the stub makes "stale" is a WARN rather than a FAIL. psycopg2 is replaced in sys.modules,
so no connection is ever attempted.
"""
import importlib.util
import json
import os
import re
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
_spec = importlib.util.spec_from_file_location("schema_audit", os.path.join(HERE, "dev-main-schema-audit.py"))
audit = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(audit)

P4_LINE = re.compile(
    r"^P4: (\d+) lambda\(s\), (\d+) relation ref\(s\) touched, (\d+) with NO column contract \(baseline (\d+)\)$",
    re.M,
)


class _EveryColumn(frozenset):
    """Stands in for prod information_schema: any relation exists, with any column."""

    def __contains__(self, _col):
        return True

    def __bool__(self):
        return True


def test_phase4_ratchet_holds_on_the_real_tree(monkeypatch, capsys):
    fake_pg = types.ModuleType("psycopg2")
    fake_pg.connect = lambda _url: types.SimpleNamespace(close=lambda: None)
    monkeypatch.setitem(sys.modules, "psycopg2", fake_pg)
    monkeypatch.setattr(audit, "query_prod_columns", lambda _conn, _table: _EveryColumn())
    monkeypatch.setenv("NEON_DATABASE_URL", "postgresql://fake.invalid/db")
    monkeypatch.setattr(sys, "argv", ["dev-main-schema-audit.py", "--repo-root", REPO, "--gate"])

    rc = audit.main()
    out, err = capsys.readouterr()

    m = P4_LINE.search(out)
    assert m, f"the audit never printed its Phase 4 census (exit {rc}):\n{out}\n{err}"
    lambdas, refs, uncovered, baseline = (int(g) for g in m.groups())
    # The baseline main() printed is the file's, read the same way the gate reads it.
    with open(os.path.join(HERE, "schema-audit-join-baseline.json")) as f:
        assert baseline == int(json.load(f)["uncovered_relations"])
    # Not vacuous: the census has to have seen the tree. 24 lambdas / 249 refs on the Put-Up train.
    assert lambdas >= 20 and refs >= 200, m.group(0)
    assert uncovered <= baseline, (
        f"Phase 4 join ratchet REGRESSED: {uncovered} relation(s) queried with no column contract in their own "
        f"lambda directory, baseline {baseline}. Add a keyed contract in that directory -- a NEW "
        f"*columns.test.js with `const AUDIT_COLUMNS = {{ <table>: ['col', ...] }};` -- never a raised "
        f"baseline.\n{out}"
    )
    assert rc == 0, f"exit {rc}:\n{out}\n{err}"
