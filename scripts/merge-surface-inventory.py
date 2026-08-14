#!/usr/bin/env python3
"""V4-PLANTMERGE-001 — derive the planting-merge surface inventory from LIVE schema.

The merge repoints, supersedes, deletes or deliberately leaves every surface that references a
planting. That list must never be maintained from memory: the first draft of this work was
hand-written and missed nine surfaces, including evidence.garden_node_id (FK RESTRICT, live rows),
and wrongly INCLUDED entity.planting_ref_id, whose unique index would have aborted every group.

This script is the tripwire. It reads pg_constraint plus every plant-id-bearing column, compares
the result against the SURFACES policy map in lambda/plants/merge.js, and exits non-zero when they
disagree — so a new table that references plants fails the check instead of being silently skipped
by a merge that then strands its rows on a soft-deleted planting.

Usage:
    NEON_DATABASE_URL=... python3 scripts/merge-surface-inventory.py            # check (exit 1 on drift)
    NEON_DATABASE_URL=... python3 scripts/merge-surface-inventory.py --json     # emit the inventory
    NEON_DATABASE_URL=... python3 scripts/merge-surface-inventory.py --group-ids a,b,c   # + row counts

Exit codes: 0 = map matches live schema; 1 = drift (unclassified or stale entry); 2 = usage/conn error.
"""
import argparse
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MERGE_JS = os.path.join(ROOT, "lambda", "plants", "merge.js")

# Tables that are snapshots/CTAS scratch, not live surfaces. These are created by one-off migrations
# and are never read by the app, so a merge neither repoints nor reports them. Matched as prefixes.
IGNORE_PREFIXES = ("ctas_", "snap_", "tmp_", "bak_")

FK_SQL = """
SELECT c.conrelid::regclass::text AS tbl,
       (SELECT string_agg(a.attname, ',')
          FROM unnest(c.conkey) k
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k) AS col,
       CASE c.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
                          WHEN 'c' THEN 'CASCADE'   WHEN 'n' THEN 'SET NULL'
                          WHEN 'd' THEN 'SET DEFAULT' END AS del
  FROM pg_constraint c
 WHERE c.contype = 'f' AND c.confrelid = 'plants'::regclass
 ORDER BY 1, 2;
"""

# Un-FK'd columns that still hold a plants.id. Name-shaped detection is deliberate: these carry no
# constraint, so the only signal is the column name plus a uuid type.
SOFT_REF_SQL = """
SELECT c.table_name, c.column_name
  FROM information_schema.columns c
  JOIN information_schema.tables t
    ON t.table_name = c.table_name AND t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
 WHERE c.table_schema = 'public'
   AND c.data_type = 'uuid'
   AND c.column_name ~ '(plant|target_id|subject_id|entity_id|node_id|leaf_id)'
   AND NOT EXISTS (
        SELECT 1 FROM pg_constraint k
         WHERE k.contype = 'f' AND k.conrelid = (quote_ident(c.table_name))::regclass
           AND (SELECT string_agg(a.attname, ',')
                  FROM unnest(k.conkey) kk
                  JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = kk) = c.column_name)
 ORDER BY 1, 2;
"""

UNIQUE_SQL = """
SELECT tablename, indexname, indexdef
  FROM pg_indexes
 WHERE schemaname = 'public' AND indexdef LIKE 'CREATE UNIQUE%'
 ORDER BY 1, 2;
"""


def psql(dsn, sql):
    p = subprocess.run(["psql", dsn, "-At", "-F", "|", "-c", sql],
                       capture_output=True, text=True)
    if p.returncode != 0:
        sys.stderr.write(f"psql failed: {p.stderr.strip()}\n")
        sys.exit(2)
    return [ln.split("|") for ln in p.stdout.strip().splitlines() if ln]


def parse_policy():
    """Read the SURFACES map out of merge.js. Comment-tolerant: entries are matched on the object
    literal only, so a table named in a nearby comment cannot satisfy the parse."""
    if not os.path.exists(MERGE_JS):
        sys.stderr.write(f"missing {MERGE_JS}\n")
        sys.exit(2)
    src = open(MERGE_JS).read()
    m = re.search(r"export const SURFACES = Object\.freeze\(\[(.*?)\n\]\)", src, re.S)
    if not m:
        sys.stderr.write("could not locate SURFACES in merge.js\n")
        sys.exit(2)
    body = "\n".join(ln.split("//")[0] for ln in m.group(1).splitlines())
    out = {}
    for entry in re.finditer(
        r"\{\s*table:\s*'([^']+)'\s*,\s*column:\s*'([^']+)'\s*,\s*action:\s*'([^']+)'", body
    ):
        out[(entry.group(1), entry.group(2))] = entry.group(3)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true", help="emit the inventory as JSON")
    ap.add_argument("--group-ids", help="comma-separated planting ids; adds live row counts")
    args = ap.parse_args()

    dsn = os.environ.get("NEON_DATABASE_URL")
    if not dsn:
        sys.stderr.write("NEON_DATABASE_URL not set\n")
        sys.exit(2)

    policy = parse_policy()
    live = {}

    for tbl, col, deleterule in psql(dsn, FK_SQL):
        if tbl.startswith(IGNORE_PREFIXES):
            continue
        live[(tbl, col)] = {"table": tbl, "column": col, "kind": "fk", "on_delete": deleterule}

    for tbl, col in psql(dsn, SOFT_REF_SQL):
        if tbl.startswith(IGNORE_PREFIXES):
            continue
        live.setdefault((tbl, col), {"table": tbl, "column": col, "kind": "soft", "on_delete": None})

    uniques = {}
    for tbl, idx, ddl in psql(dsn, UNIQUE_SQL):
        uniques.setdefault(tbl, []).append({"name": idx, "def": ddl})

    rows = {}
    if args.group_ids:
        ids = [i.strip() for i in args.group_ids.split(",") if i.strip()]
        arr = "ARRAY[" + ",".join(f"'{i}'::uuid" for i in ids) + "]"
        for (tbl, col) in live:
            try:
                r = psql(dsn, f"SELECT count(*) FROM {tbl} WHERE {col} = ANY({arr});")
                rows[f"{tbl}.{col}"] = int(r[0][0])
            except SystemExit:
                rows[f"{tbl}.{col}"] = None

    inventory = []
    for key, info in sorted(live.items()):
        action = policy.get(key)
        inventory.append({
            **info,
            "action": action or "UNCLASSIFIED",
            "unique_indexes": [u["name"] for u in uniques.get(info["table"], [])
                               if info["column"] in u["def"]],
            "rows_in_group": rows.get(f"{info['table']}.{info['column']}"),
        })

    unclassified = [i for i in inventory if i["action"] == "UNCLASSIFIED"]
    stale = [f"{t}.{c}" for (t, c) in policy if (t, c) not in live]

    if args.json:
        print(json.dumps({"inventory": inventory, "unclassified": unclassified, "stale": stale},
                         indent=2, default=str))

    ok = True
    if unclassified:
        ok = False
        sys.stderr.write(
            "DRIFT — live surfaces absent from the SURFACES policy map in lambda/plants/merge.js:\n")
        for i in unclassified:
            note = " [UNIQUE: %s]" % ", ".join(i["unique_indexes"]) if i["unique_indexes"] else ""
            sys.stderr.write(f"  {i['table']}.{i['column']}  ({i['kind']}, {i['on_delete']}){note}\n")
        sys.stderr.write(
            "  -> Classify each as repoint / supersede / delete / leave before merging. A surface\n"
            "     the merge does not know about keeps pointing at a soft-deleted planting.\n")
    if stale:
        ok = False
        sys.stderr.write("DRIFT — policy entries with no matching live column (renamed or dropped):\n")
        for s in stale:
            sys.stderr.write(f"  {s}\n")

    if ok and not args.json:
        counts = {}
        for i in inventory:
            counts[i["action"]] = counts.get(i["action"], 0) + 1
        summary = ", ".join(f"{k}={v}" for k, v in sorted(counts.items()))
        print(f"OK — {len(inventory)} live surfaces, all classified ({summary})")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
