#!/usr/bin/env python3
"""Deterministic unit tests for dev-main-schema-audit.py Phase 2 parser
(parse_insert_blocks). No DB connection needed — exercises the regex against
fixture SQL strings. Run: python3 scripts/test-schema-audit-phase2.py

Covers the fragile part of Phase 2 (regex extraction of INSERT column lists).
The live-Neon end-to-end run is the integration test; this is the unit guard
against regex regressions (false positives / missed columns).
"""
import importlib.util
import sys
import tempfile
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "audit", str(Path(__file__).parent / "dev-main-schema-audit.py")
)
audit = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(audit)


def parse(src: str):
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
        f.write(src)
        path = Path(f.name)
    try:
        return audit.parse_insert_blocks(path)
    finally:
        path.unlink()


FAILURES = []


def check(name, cond):
    if cond:
        print(f"ok   - {name}")
    else:
        print(f"FAIL - {name}")
        FAILURES.append(name)


# 1. VALUES-style INSERT, single line.
res = parse("await sql`INSERT INTO plant_projects (name, slug, kind) VALUES (${a}, ${b}, ${c})`")
check("values insert: table parsed", res and res[0][0] == "plant_projects")
check("values insert: cols parsed", res and res[0][1] == ["name", "slug", "kind"])

# 2. public.-prefixed table, multi-line column list.
res = parse("""sql`
  INSERT INTO public.plant_varieties (
    name, species, genus,
    source_proj_rescope_project_id
  ) VALUES (${n}, ${s}, ${g}, ${p})`""")
check("public prefix stripped", res and res[0][0] == "plant_varieties")
check("multiline cols include source_proj_rescope_project_id",
      res and "source_proj_rescope_project_id" in res[0][1])

# 3. INSERT ... SELECT (CTE audit-row pattern) — column list before SELECT.
res = parse("""sql`
  INSERT INTO proj_rescope_events
    (project_id, action, pre_state, pre_state_schema_version, actor)
  SELECT id, 'admin_classify', jsonb_build_object('kind', kind), 1, ${u}
  FROM pre`""")
check("insert-select: table parsed", res and res[0][0] == "proj_rescope_events")
check("insert-select: 5 cols parsed",
      res and res[0][1] == ["project_id", "action", "pre_state", "pre_state_schema_version", "actor"])
check("insert-select: jsonb_build_object NOT captured as column",
      res and "jsonb_build_object" not in res[0][1] and "kind" not in res[0][1])

# 4. ON CONFLICT (...) parens after VALUES must NOT be captured as column list.
res = parse("""sql`
  INSERT INTO rate_limit_buckets (actor_clerk_sub, bucket_key, window_start, count)
  VALUES (${a}, ${b}, date_trunc('hour', NOW()), 1)
  ON CONFLICT (actor_clerk_sub, bucket_key, window_start)
  DO UPDATE SET count = count + 1`""")
check("on-conflict: only the leading column list captured",
      res and res[0][1] == ["actor_clerk_sub", "bucket_key", "window_start", "count"])
check("on-conflict: exactly one block matched", len(res) == 1)

# 5. Multiple INSERTs in one file → multiple blocks.
res = parse("""
  sql`INSERT INTO a (x, y) VALUES (1, 2)`;
  sql`INSERT INTO b (z) VALUES (3)`;
""")
check("multiple inserts: 2 blocks", len(res) == 2)
check("multiple inserts: tables a,b", [r[0] for r in res] == ["a", "b"])

# 6. No INSERT → empty.
check("no insert: empty result", parse("sql`SELECT id FROM plants WHERE x = ${y}`") == [])

# 7. Line number is approximate (1-based).
res = parse("line1\nline2\nsql`INSERT INTO t (c) VALUES (1)`")
check("line number approx >= 3", res and res[0][2] >= 3)

print()
if FAILURES:
    print(f"{len(FAILURES)} FAILURE(S): {', '.join(FAILURES)}")
    sys.exit(1)
print("ALL PASS")
sys.exit(0)
