#!/usr/bin/env python3
"""Deterministic unit tests for dev-main-schema-audit.py Phase 4 (joined-relation
coverage) + the Phase 1 keyed `AUDIT_COLUMNS` contract. No DB connection needed.
Run: python3 scripts/test-schema-audit-phase4.py

Guards the BUG-SEEDDETAIL500-001 class (2026-08-28): Phase 1 cross-products every
collected *COLUMNS array against every declared table, so every file in this repo
declared exactly ONE table -- and every relation a handler JOINed to was therefore
audited by NOTHING. `p.name` on garden_node passed a green audit, a green unit suite
and a green integration run while 500-ing every seed packet detail page in prod.

Two of these tests pin extractor bugs that were REAL and were caught only because the
first live run reported five FAILs that were all false:
  * a BARE `--` separator line survived comment-stripping (the pattern demanded `--\\s`),
    leaving a literal `--` between a CTE chain's comma and the next CTE name, which hid
    three CTE declarations in lambda/harvests/watch-route.js;
  * `IS NOT DISTINCT FROM l.entity_id` contains the token FROM, so the operator's
    right-hand ALIAS was captured as a relation.
Both are asserted below against the real files, not only against fixtures -- a fixture
proves the regex, the real file proves the codebase.
"""
import importlib.util
import tempfile
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


def rels(src: str):
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
        f.write(src)
        path = Path(f.name)
    try:
        return audit.parse_sql_relations(path)
    finally:
        path.unlink()


# ── 1. Keyed AUDIT_COLUMNS: per-table, NO cross-product ───────────────────────────────
# This is the whole point. Under AUDIT_TABLES both arrays would be asserted against BOTH
# tables, which is why nobody could declare a second relation without inventing failures.
res = parse("""
const AUDIT_COLUMNS = {
  inventory_items: ['id', 'quantity_on_hand'],
  garden_node: ['id', 'display_name'],
};
""")
by_table = {t: c for t, c in res}
check("keyed: both relations declared", set(by_table) == {"inventory_items", "garden_node"})
check("keyed: inventory_items keeps its own columns",
      by_table.get("inventory_items") == ["id", "quantity_on_hand"])
check("keyed: garden_node keeps its own columns",
      by_table.get("garden_node") == ["id", "display_name"])
check("keyed: NO cross-product -- quantity_on_hand is not asserted onto garden_node",
      "quantity_on_hand" not in (by_table.get("garden_node") or []))
check("keyed: NO cross-product -- display_name is not asserted onto inventory_items",
      "display_name" not in (by_table.get("inventory_items") or []))

# ── 2. Keyed form wins, and suppresses the loose *COLUMNS collector ───────────────────
# A helper array in a keyed file must not leak onto every declared table.
res = parse("""
const AUDIT_TABLES = ['legacy_table'];
const AUDIT_COLUMNS = { garden_node: ['id'] };
const NOT_ON_GARDEN_NODE_COLUMNS = ['name', 'category'];
""")
check("keyed: takes precedence over AUDIT_TABLES", [t for t, _ in res] == ["garden_node"])
check("keyed: loose *COLUMNS helper array does not leak in",
      all("name" not in cols for _, cols in res))

# ── 3. Backwards compatibility: the AUDIT_TABLES form is unchanged ────────────────────
res = parse("""
const AUDIT_TABLES = ['inventory_items'];
const INVENTORY_ITEMS_COLUMNS = ['id', 'user_id'];
""")
check("AUDIT_TABLES form still parses", res == [("inventory_items", ["id", "user_id"])])

# ── 4. Bare `--` separator must not hide the CTE that follows it ──────────────────────
# The exact shape from lambda/harvests/watch-route.js:159-163.
src = """
const q = sql`
    WITH bounds AS (SELECT 1),
    -- a comment with text
    --
    -- Season-scoped: last year's status must not open this year's watch.
    fruiting AS (
      SELECT e.plant_id FROM event_log e
    )
    SELECT * FROM fruiting f JOIN bounds b ON true
`;
"""
r = rels(src)
check("bare `--` line: `fruiting` is recognised as a CTE, not a relation", "fruiting" not in r)
check("bare `--` line: `bounds` still recognised as a CTE", "bounds" not in r)
check("bare `--` line: the real relation event_log IS found", "event_log" in r)

# ── 5. `IS [NOT] DISTINCT FROM alias.col` must not yield a relation ───────────────────
r = rels("""
const q = sql`
  SELECT * FROM event_log e
   WHERE e.entity_id IS NOT DISTINCT FROM l.entity_id
     AND e.crop_type_slug IS DISTINCT FROM sl.crop_type_slug
`;
""")
check("DISTINCT FROM: alias `l` is not a relation", "l" not in r)
check("DISTINCT FROM: alias `sl` is not a relation", "sl" not in r)
check("DISTINCT FROM: the real relation event_log IS found", "event_log" in r)

# ── 6. Ordinary extraction behaviours ─────────────────────────────────────────────────
r = rels("""
const q = sql`
  SELECT * FROM public.garden_node p
    JOIN cultivar c ON c.id = p.cultivar_id
    CROSS JOIN LATERAL (SELECT 1) x
`;
""")
check("public. prefix is consumed, garden_node captured", "garden_node" in r)
check("public is never itself a relation", "public" not in r)
check("JOINed relation captured", "cultivar" in r)
check("LATERAL is not a relation", "lateral" not in r)

check("a relation named only in a comment is not touched",
      "secret_table" not in rels("// SELECT * FROM secret_table\nconst q = sql`SELECT 1`;"))

# ── 7. The real files that produced the five false FAILs ──────────────────────────────
wr = REPO_ROOT / "lambda" / "harvests" / "watch-route.js"
if wr.exists():
    r = audit.parse_sql_relations(wr)
    # Non-vacuity FIRST: if the file stopped containing SQL, every assertion below would
    # pass trivially. Pin that it still yields real relations.
    check("watch-route.js: extractor still yields relations (non-vacuous)", len(r) >= 3)
    check("watch-route.js: event_log IS found (non-vacuous)", "event_log" in r)
    for cte in ("fruiting", "fruiting_gap", "derived"):
        check(f"watch-route.js: CTE `{cte}` is not reported as a relation", cte not in r)

mg = REPO_ROOT / "lambda" / "plants" / "merge.js"
if mg.exists():
    r = audit.parse_sql_relations(mg)
    check("merge.js: extractor still yields relations (non-vacuous)", len(r) >= 1)
    check("merge.js: `l` from IS NOT DISTINCT FROM is not a relation", "l" not in r)

# ── 8. The instance this whole change exists to close ─────────────────────────────────
gn = REPO_ROOT / "lambda" / "inventory-items" / "garden-node-columns.test.js"
if gn.exists():
    res = audit.parse_test_file(gn)
    tables = {t for t, _ in res}
    check("garden-node guard is now PARSEABLE by the auditor", bool(res))
    check("garden-node guard declares garden_node", tables == {"garden_node"})
    cols = {c for _, cs in res for c in cs}
    check("garden-node guard declares display_name (the column the 500 was about)",
          "display_name" in cols)
    check("garden-node guard does NOT declare `name` (the column that did not exist)",
          "name" not in cols)
    # The widened Phase 1 glob is what makes the file visible at all.
    check("garden-node guard matches the Phase 1 discovery glob",
          gn.match("*columns.test.js"))

print()
if FAILURES:
    print(f"FAILED: {len(FAILURES)}")
    for f in FAILURES:
        print(f"  - {f}")
    raise SystemExit(1)
print("PASS: all Phase 4 / keyed-contract checks")
