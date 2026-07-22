#!/usr/bin/env python3
"""Deterministic unit tests for dev-main-schema-audit.py Phase 1 parser
(parse_test_file) + the empty-relation exit-2 guard. No DB connection needed.
Run: python3 scripts/test-schema-audit-phase1.py

Guards the BUG-VARVIEW-001 class (2026-07-22): the old parser reverse-parsed the
JS extractSelectBlocks regex with `FROM\\s\\+(\\w+)`, capturing "public" from
`FROM\\s+public\\.cultivar` (-> 0-column relation -> false "all columns missing"
FAIL) and silently WARN-skipping alternation forms entirely (Phase 1 verified
ZERO files). Fix: declared `const AUDIT_TABLES = [...]` contract first,
schema-qualification-aware literal fallback second, and zero-column relation ->
exit 2 (inconclusive), never a FAIL.
"""
import importlib.util
import os
import sys
import tempfile
import types
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "audit", str(Path(__file__).parent / "dev-main-schema-audit.py")
)
audit = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(audit)

REPO_ROOT = Path(__file__).parent.parent

FAILURES = []


def check(name, cond):
    if cond:
        print(f"ok   - {name}")
    else:
        print(f"FAIL - {name}")
        FAILURES.append(name)


def parse(src: str):
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
        f.write(src)
        path = Path(f.name)
    try:
        return audit.parse_test_file(path)
    finally:
        path.unlink()


# 1. Schema-qualified FROM literal (the BUG-VARVIEW-001 mis-capture): table must
#    be `cultivar`, never `public`.
res = parse(r"""
function extractSelectBlocks(src) {
  const re = /SELECT\s+((?:(?!\bFROM\b)[\s\S])*?)\s+FROM\s+public\.cultivar/g;
}
const SEEDINV_COLUMNS = ['determinacy', 'sow_notes'];
""")
check("schema-qual fallback: table is cultivar (not 'public')",
      res and res[0][0] == "cultivar")
check("schema-qual fallback: cols parsed", res and res[0][1] == ["determinacy", "sow_notes"])

# 2. Unqualified FROM literal still works.
res = parse(r"""
const re = /SELECT\s+([\s\S]*?)\s+FROM\s+plants/g;
const X_COLUMNS = ['sown_at'];
""")
check("unqualified fallback: table is plants", res and res[0][0] == "plants")

# 3. Declared AUDIT_TABLES wins over a conflicting FROM literal.
res = parse(r"""
const AUDIT_TABLES = ['garden_node'];
const re = /SELECT\s+([\s\S]*?)\s+FROM\s+public\.cultivar/g;
const X_COLUMNS = ['sown_at'];
""")
check("declared priority: AUDIT_TABLES beats FROM literal",
      res and res[0][0] == "garden_node")

# 4. Alternation form (unparseable literal) + declaration -> parsed.
res = parse(r"""
const AUDIT_TABLES = ['garden_node'];
const re = /SELECT\s+((?:(?!\bFROM\b)[\s\S])*?)\s+FROM\s+(?:plants|public\.garden_node)\s+p/g;
const PROJ_COLUMNS = ['sown_at', 'qty_initial'];
""")
check("alternation + declaration: parsed", res and res[0][0] == "garden_node")

# 5. Alternation form WITHOUT declaration -> [] (skip; counted loudly by main).
res = parse(r"""
const re = /SELECT\s+([\s\S]*?)\s+FROM\s+(?:plant_projects|public\.container)(?:\s+pp)?/g;
const P_COLUMNS = ['kind'];
""")
check("alternation without declaration: skipped (empty result)", res == [])

# 6. Multi-table declaration: each array audited against EACH table.
res = parse(r"""
const AUDIT_TABLES = ['a_table', 'b_table'];
const X_COLUMNS = ['c1'];
""")
check("multi-table declaration: cross product",
      [(t, c) for t, c in res] == [("a_table", ["c1"]), ("b_table", ["c1"])])

# 7. AUDIT_TABLES itself is never collected as a columns array.
res = parse(r"""
const AUDIT_TABLES = ['cultivar'];
const X_COLUMNS = ['c1'];
""")
check("AUDIT_TABLES not captured as a columns array",
      len(res) == 1 and res[0][1] == ["c1"])

# 8. Absence-assertion arrays (name not ending in COLUMN/COLUMNS) stay excluded.
res = parse(r"""
const AUDIT_TABLES = ['garden_node'];
const LEGACY_COLUMNS_REMOVED_IN_2_0_5 = ['genus', 'species', 'variety'];
const X_COLUMNS = ['sown_at'];
""")
check("LEGACY_COLUMNS_REMOVED_IN_2_0_5 excluded from audit",
      len(res) == 1 and res[0][1] == ["sown_at"])

# 9. Real repo files: all 3 select-columns.test.js must parse with the declared tables.
real = {
    "lambda/varieties/select-columns.test.js": ("cultivar", 14),
    "lambda/plants/select-columns.test.js": ("garden_node", 24),
    "lambda/projects/select-columns.test.js": ("plant_projects", 3),
}
for rel, (want_table, want_cols) in real.items():
    p = REPO_ROOT / rel
    parsed = audit.parse_test_file(p)
    tables = {t for t, _ in parsed}
    ncols = sum(len(c) for _, c in parsed)
    check(f"real file {rel}: parses to table {want_table}",
          parsed and tables == {want_table})
    check(f"real file {rel}: {want_cols} audited columns", ncols == want_cols)

# 10. Empty-relation guard: resolved table with ZERO information_schema columns
#     -> main() returns 2 (inconclusive), never 1 (false-FAIL). Uses a fake
#     psycopg2 + monkeypatched query_prod_columns; fixture repo has one Phase-1
#     file declaring a bogus table and no index.js (Phases 2/3 no-op).
def run_main_with_fixture(decl_table, prod_cols):
    fake_pg = types.ModuleType("psycopg2")

    class _FakeConn:
        def close(self):
            pass

    fake_pg.connect = lambda url: _FakeConn()
    with tempfile.TemporaryDirectory() as td:
        repo = Path(td)
        d = repo / "lambda" / "fixture"
        d.mkdir(parents=True)
        (d / "select-columns.test.js").write_text(
            f"const AUDIT_TABLES = ['{decl_table}'];\n"
            "const X_COLUMNS = ['c1', 'c2'];\n"
        )
        old_argv, old_env = sys.argv, os.environ.get("NEON_DATABASE_URL")
        old_query, old_pg = audit.query_prod_columns, sys.modules.get("psycopg2")
        try:
            sys.modules["psycopg2"] = fake_pg
            os.environ["NEON_DATABASE_URL"] = "postgres://fake"
            audit.query_prod_columns = lambda conn, table: set(prod_cols)
            sys.argv = ["dev-main-schema-audit.py", "--repo-root", str(repo)]
            return audit.main()
        finally:
            sys.argv = old_argv
            audit.query_prod_columns = old_query
            if old_pg is not None:
                sys.modules["psycopg2"] = old_pg
            else:
                sys.modules.pop("psycopg2", None)
            if old_env is None:
                os.environ.pop("NEON_DATABASE_URL", None)
            else:
                os.environ["NEON_DATABASE_URL"] = old_env


check("empty relation -> exit 2 (inconclusive), not FAIL",
      run_main_with_fixture("nonexistent_relation", []) == 2)
check("populated relation, cols present -> exit 0",
      run_main_with_fixture("real_relation", ["c1", "c2"]) == 0)
check("populated relation, col missing -> exit 1 (genuine FAIL preserved)",
      run_main_with_fixture("real_relation", ["c1"]) == 1)

print()
if FAILURES:
    print(f"{len(FAILURES)} FAILURE(S): {', '.join(FAILURES)}")
    sys.exit(1)
print("ALL PASS")
sys.exit(0)
