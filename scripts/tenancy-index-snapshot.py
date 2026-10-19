#!/usr/bin/env python3
"""Unique-index snapshot for the keys instruments (V5-SPACETENANCYKEY-001, multi-space plan V204 step 2.0e, §2.4).

WHY THIS EXISTS
---------------
lambda/tenancy-keys.static.test.js checks two things CI cannot read from a database: that every ON CONFLICT
target the SQL census finds resolves to a unique index (an ON CONSTRAINT name through the constraint map), and
that every unique index on an S, D or base-capable C table carries the tenancy key or is in
scripts/tenancy-index-exemptions.json. The live half is the gate post_s_unique_indexes_carry_workspace
(migrations/v5-tenancykeys-001). The test reads this script's output instead of a database:
tests/tenancy-unique-indexes.prod.json, a committed read of prod's catalog.

WHAT IT RECORDS
---------------
For every relation in a non-system schema that has a unique index (copy tables, the anchored regexes in
lambda/tenancy-classes.json copyPatterns, excepted), keyed schema.relname: each unique index's name, the
constraint it backs (primary key, unique or exclusion; null for a bare CREATE UNIQUE INDEX), whether it is the
primary key, its key columns in order (a column name, or {"expr": <text>} for an expression; INCLUDE columns
are not keys), its predicate (pg_get_expr; null when not partial) and NULLS NOT DISTINCT; and, for each column
that leads one of those indexes, the targets of the single-column foreign keys on it. Names and booleans only:
no rows, no data.

REGENERATING (read-only; the URL comes from the environment by key name, never the command line, L-067):
  NEON_DATABASE_URL=... python3 scripts/tenancy-index-snapshot.py            # rewrites tests/tenancy-unique-indexes.prod.json
  NEON_STAGING_URL=...  python3 scripts/tenancy-index-snapshot.py --env staging --check
      # exit 1 and print the differences if staging's catalog differs from the committed prod snapshot
The connection is opened read_only (PostgreSQL refuses any write) and the transaction is rolled back.
Regenerate after any migration that adds, drops or rebuilds a unique index, in the push that applies it.
"""
import argparse
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLASSES = ROOT / "lambda" / "tenancy-classes.json"
SNAPSHOT = ROOT / "tests" / "tenancy-unique-indexes.prod.json"

INDEXES = """
SELECT n.nspname::text, c.relname::text, ic.relname::text,
       (SELECT con.conname::text FROM pg_constraint con
         WHERE con.conindid = i.indexrelid AND con.conrelid = c.oid AND con.contype IN ('p', 'u', 'x')
         ORDER BY 1 LIMIT 1),
       i.indisprimary, i.indnullsnotdistinct,
       (SELECT json_agg(CASE WHEN k.attnum > 0 THEN to_json(a.attname::text)
                             ELSE json_build_object('expr', pg_get_indexdef(i.indexrelid, k.ord::int, true)) END
                        ORDER BY k.ord)
          FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
          LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
         WHERE k.ord <= i.indnkeyatts),
       pg_get_expr(i.indpred, i.indrelid)
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_class ic ON ic.oid = i.indexrelid
 WHERE i.indisunique
   AND n.nspname NOT IN ('pg_catalog', 'information_schema')
   AND n.nspname !~ '^pg_(toast|temp_)'
 ORDER BY 1, 2, 3
"""

# Single-column foreign keys: (schema, relation, column, target schema.relation).
FKS = """
SELECT n.nspname::text, c.relname::text, a.attname::text, tn.nspname || '.' || t.relname
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = con.conkey[1]
  JOIN pg_class t ON t.oid = con.confrelid
  JOIN pg_namespace tn ON tn.oid = t.relnamespace
 WHERE con.contype = 'f' AND array_length(con.conkey, 1) = 1
 ORDER BY 1, 2, 3, 4
"""


def read_catalog(env, classes):
    import psycopg

    var = "NEON_DATABASE_URL" if env == "prod" else "NEON_STAGING_URL"
    url = os.environ.get(var)
    if not url:
        raise SystemExit(f"FATAL: {var} is not set (needed for --env {env}). Never pass a URL on the command line.")
    copies = [re.compile(p) for p in classes["copyPatterns"]]
    with psycopg.connect(url) as conn:
        conn.read_only = True
        with conn.cursor() as cur:
            # The pooler hands over other clients' session state (OPS-GATEINVARIANTSFLAKE-001).
            cur.execute("SET LOCAL search_path TO DEFAULT")
            cur.execute(INDEXES, prepare=False)
            idx_rows = cur.fetchall()
            cur.execute(FKS, prepare=False)
            fk_rows = cur.fetchall()
        conn.rollback()
    rels = {}
    for nsp, rel, name, con, primary, nnd, keys, pred in idx_rows:
        if any(p.search(rel) for p in copies):
            continue
        r = rels.setdefault(f"{nsp}.{rel}", {"fk": {}, "indexes": []})
        r["indexes"].append({"name": name, "constraint": con, "primary": primary, "keys": keys,
                             "predicate": pred, "nullsNotDistinct": nnd})
    leading = {k: {i["keys"][0] for i in r["indexes"] if isinstance(i["keys"][0], str)} for k, r in rels.items()}
    for nsp, rel, col, target in fk_rows:
        k = f"{nsp}.{rel}"
        if k in rels and col in leading[k]:
            rels[k]["fk"].setdefault(col, []).append(target)
    return rels


def render(env, rels):
    doc = [
        "Generated by scripts/tenancy-index-snapshot.py from a read-only read of the " + env + " catalog. Do not hand-edit.",
        "Read by lambda/tenancy-keys.static.test.js (ON CONFLICT arbiters, the exemption file's closed world). "
        "Regenerate in the push that applies a migration adding, dropping or rebuilding a unique index.",
    ]
    lines = ["{"]
    lines.append('  "_doc": [\n' + ",\n".join("    " + json.dumps(s) for s in doc) + "\n  ],")
    lines.append(f'  "env": {json.dumps(env)},')
    lines.append('  "relations": {')
    lines.append(",\n".join(f"    {json.dumps(k)}: {json.dumps(rels[k])}" for k in sorted(rels)))
    lines.append("  }")
    lines.append("}")
    return "\n".join(lines) + "\n"


def diff(want, have):
    out = []
    for k in sorted(set(want) | set(have)):
        if k not in have:
            out.append(f"only in the snapshot: {k}")
        elif k not in want:
            out.append(f"only in the database: {k}")
        elif want[k] != have[k]:
            out.append(f"differs: {k}: snapshot {json.dumps(want[k])} database {json.dumps(have[k])}")
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--env", choices=("prod", "staging"), default="prod")
    ap.add_argument("--check", action="store_true", help="compare with the committed snapshot instead of writing it")
    args = ap.parse_args()
    classes = json.loads(CLASSES.read_text())
    rels = read_catalog(args.env, classes)
    n = sum(len(r["indexes"]) for r in rels.values())
    if args.check:
        problems = diff(json.loads(SNAPSHOT.read_text())["relations"], rels)
        for p in problems:
            print(p)
        print(f"{args.env}: {len(rels)} relations, {n} unique indexes, {len(problems)} difference(s) from {SNAPSHOT.relative_to(ROOT)}")
        return 1 if problems else 0
    if args.env != "prod":
        raise SystemExit("FATAL: the committed snapshot is prod's; use --check for staging.")
    SNAPSHOT.write_text(render(args.env, rels))
    print(f"wrote {SNAPSHOT.relative_to(ROOT)}: {len(rels)} relations, {n} unique indexes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
