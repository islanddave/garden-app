#!/usr/bin/env python3
"""
checksum.py — the C-HARNESS instrument: business-column checksums of one
database, the A/B comparison, the row-level diff, and the stray-write
self-test.

WHAT IS COMPARED. Every base table in the compared schemas except the volatile
tables (app_events, ux_events, rate_limit_buckets: written by traffic, not by
the change under test). Per table, the business columns only: a column is
volatile, and left out, when it is named created_at or updated_at, or when the
use names it (`volatile_columns`, an explicit list the verdict prints). A
DEFAULT of now() or gen_random_uuid() is NOT a reason: the code writes such
columns explicitly too (event_log.event_date), and a fork carries equal values
in them, so they are compared like any other. jsonb keys a use names
(daily_plan's prior_runs by default) are stripped first. Every exclusion is
returned so the caller prints it.

ORDER. Each row's business columns form one text value (ROW(...)::text); a
table's checksum is the md5 of its row md5s ordered by that text in "C"
collation. The business key is the whole business row: two tables match only
when they hold the same multiset of business rows, whatever their uuids and
timestamps.

Connections are autocommit (psycopg v3, opened by harness.py); every
transaction here is an explicit BEGIN ... ROLLBACK, so nothing commits.
"""
from __future__ import annotations

import collections

VOLATILE_TABLES = ("app_events", "ux_events", "rate_limit_buckets")
VOLATILE_COLUMN_NAMES = ("created_at", "updated_at")
JSONB_VOLATILE_KEYS = {"public.daily_plan.plan": ("prior_runs",)}
SCHEMAS = ("public",)
TEXT_TYPES = ("text", "character varying")
STRAY_SUFFIX = " [space-harness stray write]"
ROW_TEXT_LIMIT = 300


def default_config():
    return {"schemas": list(SCHEMAS), "volatile_tables": list(VOLATILE_TABLES),
            "volatile_columns": {}, "jsonb_volatile_keys": {k: list(v) for k, v in JSONB_VOLATILE_KEYS.items()}}


def merge_config(cfg, use):
    """A use may add volatile columns ({"public.t": ["col"]}) and jsonb keys
    ({"public.t.col": ["key"]}). It cannot remove the named volatile tables."""
    out = {k: (dict(v) if isinstance(v, dict) else list(v)) for k, v in cfg.items()}
    for fq, cols in (use.get("volatile_columns") or {}).items():
        out["volatile_columns"][fq] = sorted(set(out["volatile_columns"].get(fq, [])) | set(cols))
    for fq, keys in (use.get("jsonb_volatile_keys") or {}).items():
        out["jsonb_volatile_keys"][fq] = sorted(set(out["jsonb_volatile_keys"].get(fq, [])) | set(keys))
    for s in use.get("schemas") or []:
        if s not in out["schemas"]:
            out["schemas"].append(s)
    return out


def qident(name):
    return '"' + str(name).replace('"', '""') + '"'


def qlit(text):
    return "'" + str(text).replace("'", "''") + "'"


def fq_sql(fq):
    schema, table = fq.split(".", 1)
    return f"{qident(schema)}.{qident(table)}"


def classify(fq, columns, cfg):
    """columns: [(name, type, default)]. Returns (kept [(name, type)], excluded {name: reason}).
    The DEFAULT is never a reason to leave a column out."""
    kept, excluded = [], {}
    named = set(cfg["volatile_columns"].get(fq, []))
    for name, typ, _default in columns:
        if name in VOLATILE_COLUMN_NAMES:
            excluded[name] = "volatile name"
        elif name in named:
            excluded[name] = "named by the use"
        else:
            kept.append((name, typ))
    return kept, excluded


def row_expr(fq, kept, cfg):
    """SQL text of one row's business value."""
    if not kept:
        return "'()'::text"
    parts = []
    for name, typ in kept:
        keys = cfg["jsonb_volatile_keys"].get(f"{fq}.{name}")
        if keys and typ in ("jsonb", "json"):
            arr = "ARRAY[" + ", ".join(qlit(k) for k in keys) + "]::text[]"
            parts.append(f"({qident(name)}::jsonb - {arr})")
        else:
            parts.append(qident(name))
    return "ROW(" + ", ".join(parts) + ")::text"


def checksum_sql(fq, expr):
    return (f'SELECT count(*)::bigint, md5(coalesce(string_agg(md5(r), \'\' ORDER BY r COLLATE "C"), \'\')) '
            f"FROM (SELECT {expr} AS r FROM {fq_sql(fq)}) s")


TABLES_SQL = """
SELECT n.nspname || '.' || c.relname
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = ANY(%(schemas)s) AND c.relkind IN ('r', 'p') AND NOT c.relispartition
ORDER BY 1"""

COLUMNS_SQL = """
SELECT n.nspname || '.' || c.relname, a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod),
       pg_catalog.pg_get_expr(d.adbin, d.adrelid)
FROM pg_catalog.pg_attribute a
JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE n.nspname = ANY(%(schemas)s) AND c.relkind IN ('r', 'p') AND NOT c.relispartition
  AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY 1, a.attnum"""


def _exec(conn, sql):
    with conn.cursor() as cur:
        cur.execute(sql)


def _rows(conn, sql, params=None):
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchall()


def plan(conn, cfg):
    """Per compared table: its business columns and row expression."""
    tables = [r[0] for r in _rows(conn, TABLES_SQL, {"schemas": cfg["schemas"]})]
    cols = collections.defaultdict(list)
    for fq, name, typ, default in _rows(conn, COLUMNS_SQL, {"schemas": cfg["schemas"]}):
        cols[fq].append((name, typ, default))
    out, skipped = {}, []
    for fq in tables:
        if fq.split(".", 1)[1] in cfg["volatile_tables"]:
            skipped.append(fq)
            continue
        kept, excluded = classify(fq, cols[fq], cfg)
        out[fq] = {"kept": kept, "excluded": excluded, "expr": row_expr(fq, kept, cfg),
                   "all": [(n, t) for n, t, _ in cols[fq]]}
    return out, skipped


def snapshot(conn, cfg, own_txn=True):
    """Checksums of every compared table, read in one snapshot. own_txn=False
    reads inside the caller's open transaction (the stray-write self-test)."""
    if own_txn:
        _exec(conn, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
    try:
        tables, skipped = plan(conn, cfg)
        res = {}
        for fq, p in tables.items():
            n, h = _rows(conn, checksum_sql(fq, p["expr"]))[0]
            res[fq] = {"rows": int(n), "md5": h, "columns": [c for c, _ in p["kept"]]}
    finally:
        if own_txn:
            _exec(conn, "ROLLBACK")
    return {"tables": res, "excluded_tables": skipped,
            "excluded_columns": {fq: p["excluded"] for fq, p in tables.items() if p["excluded"]},
            "jsonb_stripped": {k: v for k, v in cfg["jsonb_volatile_keys"].items()
                               if k.rsplit(".", 1)[0] in tables}}


def diff_snapshots(a, b):
    """Tables whose presence, business columns or checksum differ."""
    out = []
    for fq in sorted(set(a["tables"]) | set(b["tables"])):
        ta, tb = a["tables"].get(fq), b["tables"].get(fq)
        if ta is None or tb is None:
            out.append({"table": fq, "kind": "missing_on_a" if ta is None else "missing_on_b"})
        elif ta["columns"] != tb["columns"]:
            out.append({"table": fq, "kind": "columns", "a": ta["columns"], "b": tb["columns"]})
        elif ta["md5"] != tb["md5"]:
            out.append({"table": fq, "kind": "rows", "a_rows": ta["rows"], "b_rows": tb["rows"]})
    return out


def row_hashes(conn, fq, expr, where=None, params=None):
    cond = f" WHERE {where}" if where else ""
    sql = f"SELECT md5(r), count(*) FROM (SELECT {expr} AS r FROM {fq_sql(fq)}{cond}) s GROUP BY 1"
    return collections.Counter({h: int(n) for h, n in _rows(conn, sql, params)})


def row_texts(conn, fq, expr, hashes, limit=10):
    if not hashes:
        return []
    sql = (f"SELECT r FROM (SELECT {expr} AS r FROM {fq_sql(fq)}) s "
           f"WHERE md5(r) = ANY(%(h)s) ORDER BY r COLLATE \"C\" LIMIT {int(limit)}")
    return [r[0][:ROW_TEXT_LIMIT] for r in _rows(conn, sql, {"h": list(hashes)})]


def multiset_diff(ha, hb):
    """(only_a, only_b): Counters of row hashes present more often on one side."""
    return ha - hb, hb - ha


def read_sentinel(conn):
    """The sentinel Space id, from gv.sentinel_workspace(): never a literal here."""
    have = _rows(conn, "SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n "
                       "ON n.oid = p.pronamespace WHERE n.nspname = 'gv' AND p.proname = 'sentinel_workspace'")
    if not have or not have[0][0]:
        return None
    return _rows(conn, "SELECT gv.sentinel_workspace()::text")[0][0]


def stray_set(col, typ):
    """SET expression that changes one value of `col` (type `typ`), or None."""
    q, t = qident(col), typ.lower()
    if t in TEXT_TYPES or t.startswith("character varying"):
        return f"{q} || %(s)s"
    if t in ("smallint", "integer", "bigint", "real", "double precision", "date") or t.startswith("numeric"):
        return f"{q} + 1"
    if t == "boolean":
        return f"NOT {q}"
    if t.startswith("timestamp"):
        return f"{q} + interval '1 day'"
    if t == "jsonb":
        return f"{q} || jsonb_build_object('space_harness_stray', true)"
    if t == "uuid":
        return f"md5({q}::text)::uuid"
    return None


def stray_candidates(snap, plan_tables, target=None, tables=None):
    """{table: [(column, type)]}: where a stray write may go. A named target
    (schema.table.column) is used as it is, kept or not. `tables` (the tables a use
    measures) each get every kept column that can be changed, text first. Without
    either, the first populated table with a text business column."""
    out = {}
    if target:
        fq, col = target.rsplit(".", 1)
        typ = dict(c[:2] for c in (plan_tables.get(fq) or {}).get("all", [])).get(col, "text")
        out[fq] = [(col, typ)]
    for fq in tables or []:
        if fq in out or fq not in plan_tables:
            continue
        kept = [(n, t) for n, t in plan_tables[fq]["kept"] if stray_set(n, t)]
        out[fq] = sorted(kept, key=lambda c: 0 if stray_set(*c).endswith("%(s)s") else 1)
    if out:
        return out
    for fq in sorted(snap["tables"]):
        if snap["tables"][fq]["rows"] <= 0 or fq not in plan_tables:
            continue
        for name, typ in plan_tables[fq]["kept"]:
            if typ in TEXT_TYPES or typ.startswith("character varying"):
                return {fq: [(name, typ)]}
    return out


def stray_write_selftest(conn_b, snap_a, cfg, target=None, tables=None):
    """Write one stray change on B in each measured table inside one transaction,
    read B's checksums inside it, roll back. The instrument passes only if every
    table written shows as a diff, and B reads equal to A again once it is rolled
    back. A measured table with no row or no column to change is a fault: the
    instrument could not show it can see that table."""
    plan_tables, _ = plan(conn_b, cfg)
    tables = sorted(set(tables or []))
    problems, absent = [], []
    for fq in tables:
        if fq not in snap_a["tables"]:
            absent.append(fq)            # created by the change: compared as missing_on_a, not stray-tested
        elif snap_a["tables"][fq]["rows"] <= 0:
            problems.append(f"{fq} has no row to write a stray change to")
        elif not any(stray_set(n, t) for n, t in plan_tables[fq]["kept"]):
            problems.append(f"{fq} has no compared column a stray write can change")
    cands = stray_candidates(snap_a, plan_tables, target, [t for t in tables if t not in absent])
    tried, hits = [], []
    _exec(conn_b, "BEGIN")
    try:
        for fq, cols in cands.items():
            for col, typ in cols:
                expr = stray_set(col, typ) or f"{qident(col)} || %(s)s"
                with conn_b.cursor() as cur:
                    cur.execute("SAVEPOINT stray")
                    try:
                        cur.execute(f"UPDATE {fq_sql(fq)} SET {qident(col)} = {expr} WHERE ctid = "
                                    f"(SELECT ctid FROM {fq_sql(fq)} WHERE {qident(col)} IS NOT NULL LIMIT 1)",
                                    {"s": STRAY_SUFFIX})
                        n = cur.rowcount
                    except Exception as ex:  # a guard trigger or constraint said no: try the next column
                        cur.execute("ROLLBACK TO SAVEPOINT stray")
                        tried.append({"target": f"{fq}.{col}", "refused": str(ex).splitlines()[0][:160]})
                        continue
                    if n != 1:
                        cur.execute("ROLLBACK TO SAVEPOINT stray")
                        tried.append({"target": f"{fq}.{col}", "refused": f"updated {n} rows"})
                        continue
                hits.append((fq, col))
                break
            else:
                if fq in tables or target:
                    problems.append(f"no stray write could be made on {fq}")
        if not hits:
            return {"ok": False, "reason": "; ".join(problems) or "no stray write could be made",
                    "tried": tried, "targets": [], "absent_before_change": absent}
        during = snapshot(conn_b, cfg, own_txn=False)
    finally:
        _exec(conn_b, "ROLLBACK")
    diffs = diff_snapshots(snap_a, during)
    unseen = [f"{fq}.{col}" for fq, col in hits if not any(d["table"] == fq for d in diffs)]
    after = snapshot(conn_b, cfg)
    residue = diff_snapshots(snap_a, after)
    reasons = list(problems)
    if unseen:
        reasons.insert(0, f"the stray write did not diff ({', '.join(unseen)})")
    if residue:
        reasons.append("B differs from A after the rollback")
    targets = [f"{fq}.{col}" for fq, col in hits]
    return {"ok": not reasons, "target": targets[0], "targets": targets, "diff_during": diffs,
            "residue_after_rollback": residue, "tried": tried, "absent_before_change": absent,
            "reason": "; ".join(reasons) or None}
