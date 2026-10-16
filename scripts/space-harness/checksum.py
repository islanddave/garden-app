#!/usr/bin/env python3
"""
checksum.py — the C-HARNESS instrument: business-column checksums of one
database, the A/B comparison, the row-level diff, and the stray-write
self-test.

WHAT IS COMPARED. Every base table in the compared schemas except the volatile
tables (app_events, ux_events, rate_limit_buckets: written by traffic, not by
the change under test). Per table, the business columns only: a column is
volatile, and left out, when its name is created_at / updated_at /
generated_at, when its DEFAULT draws a fresh value (gen_random_uuid(), now(),
nextval(), ...), or when the use names it. jsonb keys a use names (daily_plan's
prior_runs by default) are stripped first. Every exclusion is returned so the
caller prints it.

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
import re

VOLATILE_TABLES = ("app_events", "ux_events", "rate_limit_buckets")
VOLATILE_COLUMN_NAMES = ("created_at", "updated_at", "generated_at")
VOLATILE_DEFAULT_RE = re.compile(
    r"gen_random_uuid|uuid_generate_v\d|\bnow\(\)|current_timestamp|clock_timestamp|statement_timestamp"
    r"|transaction_timestamp|localtimestamp|nextval\(", re.I)
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
    """columns: [(name, type, default)]. Returns (kept [(name, type)], excluded {name: reason})."""
    kept, excluded = [], {}
    named = set(cfg["volatile_columns"].get(fq, []))
    for name, typ, default in columns:
        if name in VOLATILE_COLUMN_NAMES:
            excluded[name] = "volatile name"
        elif default and VOLATILE_DEFAULT_RE.search(default):
            excluded[name] = f"volatile default {default}"
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
        out[fq] = {"kept": kept, "excluded": excluded, "expr": row_expr(fq, kept, cfg)}
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


def stray_candidates(snap, plan_tables, target=None):
    """(fq, column) pairs a stray write may touch: a named target first, then every
    populated table's first text business column."""
    if target:
        fq, col = target.rsplit(".", 1)
        return [(fq, col)]
    out = []
    for fq in sorted(snap["tables"]):
        if snap["tables"][fq]["rows"] <= 0 or fq not in plan_tables:
            continue
        for name, typ in plan_tables[fq]["kept"]:
            if typ in TEXT_TYPES or typ.startswith("character varying"):
                out.append((fq, name))
                break
    return out


def stray_write_selftest(conn_b, snap_a, cfg, target=None, attempts=25):
    """Write one stray change on B inside a transaction, read B's checksums inside
    it, roll back. The instrument passes only if that one change shows as a diff,
    and B reads equal to A again once it is rolled back."""
    plan_tables, _ = plan(conn_b, cfg)
    tried = []
    hit = None
    _exec(conn_b, "BEGIN")
    try:
        for fq, col in stray_candidates(snap_a, plan_tables, target)[:attempts]:
            with conn_b.cursor() as cur:
                cur.execute("SAVEPOINT stray")
                try:
                    cur.execute(f"UPDATE {fq_sql(fq)} SET {qident(col)} = {qident(col)} || %(s)s "
                                f"WHERE ctid = (SELECT ctid FROM {fq_sql(fq)} WHERE {qident(col)} IS NOT NULL LIMIT 1)",
                                {"s": STRAY_SUFFIX})
                    n = cur.rowcount
                except Exception as ex:  # a guard trigger or constraint said no: try the next table
                    cur.execute("ROLLBACK TO SAVEPOINT stray")
                    tried.append({"target": f"{fq}.{col}", "refused": str(ex).splitlines()[0][:160]})
                    continue
                if n != 1:
                    cur.execute("ROLLBACK TO SAVEPOINT stray")
                    tried.append({"target": f"{fq}.{col}", "refused": f"updated {n} rows"})
                    continue
            hit = (fq, col)
            break
        if not hit:
            return {"ok": False, "reason": "no stray write could be made", "tried": tried}
        during = snapshot(conn_b, cfg, own_txn=False)
    finally:
        _exec(conn_b, "ROLLBACK")
    diffs = diff_snapshots(snap_a, during)
    seen = any(d["table"] == hit[0] for d in diffs)
    after = snapshot(conn_b, cfg)
    residue = diff_snapshots(snap_a, after)
    return {"ok": seen and not residue, "target": f"{hit[0]}.{hit[1]}", "diff_during": diffs,
            "residue_after_rollback": residue, "tried": tried,
            "reason": None if seen and not residue else
            ("the stray write did not diff" if not seen else "B differs from A after the rollback")}
