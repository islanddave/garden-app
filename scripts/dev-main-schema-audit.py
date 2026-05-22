#!/usr/bin/env python3
"""
dev-main-schema-audit.py - L-081 enforcement (canonical home: garden-app/scripts/)

Verifies that lambda code's column references resolve against prod Neon's
information_schema.columns. Catches the L-081 bug class (local_3f62f153
2026-05-19 prod incident E-local_3f62f153-001): code references columns that
exist in staging but not prod, deploy succeeds, every endpoint 500s.

Two phases (both run; failure in either fails the audit):

  Phase 1 - select-columns.test.js assertions.
    Every column asserted in `lambda/**/select-columns.test.js` arrays must
    exist in prod. Covers SELECT/RETURNING response-shape columns that have a
    static-source contract test.

  Phase 3 - soft-delete column presence (added 2026-05-22, L-096).\n    Every table soft-deleted via `UPDATE <table> SET ... deleted_at` must have a\n    deleted_at column in prod. Catches the project_types.deleted_at class that\n    Phases 1/2 miss (SET/WHERE refs). Narrow by design (UPDATE write target only).\n\n  Phase 2 - INSERT column lists (added 2026-05-19, local_ba595ceb).
    Every column named in an `INSERT INTO <table> ( ... ) VALUES|SELECT`
    column list across `lambda/**/index.js` must exist in prod. This is the
    write-path blind spot Phase 1 missed: PATCH/POST handlers that INSERT into
    a column the prod schema lacks would 500 (or violate a constraint) with no
    select-columns.test.js coverage. Scope is deliberately limited to the
    parenthesized column list immediately preceding VALUES/SELECT - the
    unambiguous, regex-tractable subset of inline SQL. Column refs buried in
    SELECT/WHERE/SET/jsonb_build_object/RETURNING are NOT audited here (full
    SQL parse is a separate, fragility-prone effort - intentionally deferred).

Pre-flight gate. Run before any dev->main squash-merge on garden-app.
Returns PASS / FAIL with specific (file, table, column) tuples on FAIL.
Wired into `.github/workflows/schema-audit.yml` as an advisory PR check.

Usage:
    python3 scripts/dev-main-schema-audit.py [--repo-root PATH] [--env-file PATH] [--verbose]

Default repo-root: current directory (when invoked from CI checkout)
                  or /Users/davenichols/AI/Claude/Projects/Gardening/garden-app (local dev)
Default env-file:  {repo-root}/.env.local  (reads NEON_DATABASE_URL per L-067)
Env var:          NEON_DATABASE_URL takes precedence over .env.local (CI path)

Exit codes:
    0 = PASS  (all referenced columns present in prod)
    1 = FAIL  (one or more columns missing in prod -- halt squash-merge)
    2 = error (config / connection / parse failure -- inconclusive)

Related: L-081 in /Users/davenichols/AI/Claude/learning/lessons.md
Canonical home: garden-app/scripts/ (CI + local invocation against garden-app).
"""
import argparse
import glob
import os
import re
import sys
from pathlib import Path


def load_neon_url(env_path: Path | None) -> str | None:
    """Resolve NEON_DATABASE_URL. Priority: env var (CI), then .env.local (local dev).
    L-067: never inline creds; never accept connection URL as a CLI argument.
    """
    env_val = os.getenv("NEON_DATABASE_URL")
    if env_val:
        return env_val
    if env_path and env_path.exists():
        for line in env_path.read_text().splitlines():
            if line.startswith("NEON_DATABASE_URL="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def parse_test_file(path: Path) -> list[tuple[str, list[str]]]:
    """Phase 1. Returns [(table, [columns]), ...] tuples from a
    select-columns.test.js file.

    Strategy: extract target table from the extractSelectBlocks regex pattern
    (e.g., FROM\\s+plants), then collect every `const X_COLUMNS = ['...', '...']`
    array of string literals in the file. Same table for all arrays in the file
    (current convention).
    """
    src = path.read_text()

    # Match the table name from a JS source regex `FROM\s+<table>`.
    # In the JS source the literal characters are: F R O M \ s + table_name
    table_match = re.search(r"FROM\\s\+(\w+)", src)
    if not table_match:
        return []
    table = table_match.group(1)

    results = []
    # Match `const ANYTHING_COLUMNS = [ ... ];` -- DOTALL so multi-line arrays work.
    for arr_match in re.finditer(
        r"const\s+\w*COLUMNS?\s*=\s*\[(.*?)\];", src, re.DOTALL
    ):
        cols_text = arr_match.group(1)
        # Extract every quoted string literal (single or double quote).
        cols = re.findall(r"['\"]([a-zA-Z_][a-zA-Z0-9_]*)['\"]", cols_text)
        if cols:
            results.append((table, cols))
    return results


# Identifiers that appear inside INSERT column-list parens but are NOT columns.
# Defensive guard; column lists are normally bare identifiers only.
_INSERT_NONCOL = set()


def parse_insert_blocks(path: Path) -> list[tuple[str, list[str], int]]:
    """Phase 2. Returns [(table, [columns], approx_line), ...] from
    `INSERT INTO [public.]<table> ( <cols> ) VALUES|SELECT` statements in a
    Lambda handler .js file.

    Only the parenthesized column list immediately preceding VALUES or SELECT
    is parsed. `[^)]*` for the column body is safe because a column list never
    contains nested parens (function calls / VALUES tuples live AFTER the list).
    ON CONFLICT (...) clauses are not matched (they follow VALUES, not precede).
    """
    src = path.read_text()
    results = []
    pattern = re.compile(
        r"INSERT\s+INTO\s+(?:public\.)?(\w+)\s*\(([^)]*)\)\s*(?:VALUES|SELECT)\b",
        re.IGNORECASE,
    )
    for m in pattern.finditer(src):
        table = m.group(1)
        cols_text = m.group(2)
        # Bare identifiers only. A column list is comma-separated identifiers;
        # anything with a non-identifier char (a SQL expr) wouldn't be valid
        # here, so plain \b token extraction is correct + low-false-positive.
        raw = re.findall(r"\b([a-zA-Z_][a-zA-Z0-9_]*)\b", cols_text)
        cols = [c for c in raw if c.lower() not in _INSERT_NONCOL]
        approx_line = src[: m.start()].count("\n") + 1
        if cols:
            results.append((table, cols, approx_line))
    return results


# Phase 3 (added 2026-05-22, L-096 project_types.deleted_at prod incident).
# A handler that soft-deletes a table (`UPDATE <table> SET ... deleted_at ...`) requires
# <table>.deleted_at to exist in prod, or the write 500s. This is the SET/WHERE blind spot
# the module docstring flags as deferred: Phase 1 (select-columns) + Phase 2 (INSERT lists)
# never see it. Scope is deliberately narrow + low-false-positive: only the UPDATE...SET...
# deleted_at write target (UPDATE names exactly one table; unambiguous). Read-only
# `WHERE deleted_at` filters with JOINs/aliases are NOT parsed here (same join-fragility
# rationale as the SELECT/WHERE deferral above) — but a table that is soft-delete-WRITTEN
# is invariably also filtered, so this catches the whole class in practice (it would have
# caught project_types: `UPDATE project_types SET deleted_at = NOW()`).
_SOFT_DELETE_UPDATE = re.compile(
    r"UPDATE\s+(?:public\.)?(\w+)\s+SET\b[^;`]*?\bdeleted_at\b",
    re.IGNORECASE | re.DOTALL,
)


def parse_soft_delete_tables(path: Path) -> list[tuple[str, int]]:
    """Phase 3. Returns [(table, approx_line), ...] for tables the handler
    soft-deletes via `UPDATE <table> SET ... deleted_at ...`. Each MUST have a
    deleted_at column in prod."""
    src = path.read_text()
    out = []
    for m in _SOFT_DELETE_UPDATE.finditer(src):
        out.append((m.group(1), src[: m.start()].count("\n") + 1))
    return out


def query_prod_columns(conn, table: str) -> set[str]:
    cur = conn.cursor()
    cur.execute(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_schema = 'public' AND table_name = %s",
        (table,),
    )
    cols = {row[0] for row in cur.fetchall()}
    cur.close()
    return cols


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repo-root",
        default=".",
        help="garden-app repo root (default: current directory)",
    )
    parser.add_argument(
        "--env-file",
        default=None,
        help="env file with NEON_DATABASE_URL (default: {repo-root}/.env.local)",
    )
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    repo = Path(args.repo_root).resolve()
    env_path = Path(args.env_file) if args.env_file else repo / ".env.local"

    neon_url = load_neon_url(env_path)
    if not neon_url:
        print(
            f"FAIL: NEON_DATABASE_URL not found in env var or {env_path}",
            file=sys.stderr,
        )
        return 2

    try:
        import psycopg2
    except ImportError:
        print(
            "FAIL: psycopg2 not installed. Install: pip install psycopg2-binary --break-system-packages",
            file=sys.stderr,
        )
        return 2

    test_files = sorted(
        glob.glob(str(repo / "lambda" / "**" / "select-columns.test.js"), recursive=True)
    )
    handler_files = sorted(
        glob.glob(str(repo / "lambda" / "**" / "index.js"), recursive=True)
    )
    if not test_files and not handler_files:
        print(
            f"FAIL: no select-columns.test.js or index.js files under {repo}/lambda",
            file=sys.stderr,
        )
        return 2

    if args.verbose:
        print(f"# repo: {repo}")
        print(f"# env:  {env_path}")
        print(f"# Phase 1: {len(test_files)} select-columns.test.js file(s)")
        print(f"# Phase 2: {len(handler_files)} handler index.js file(s)")
        print()

    conn = psycopg2.connect(neon_url)

    table_cache: dict[str, set[str]] = {}

    def cols_for(table: str) -> set[str]:
        if table not in table_cache:
            table_cache[table] = query_prod_columns(conn, table)
        return table_cache[table]

    # (phase, rel_file, table, col) for asserted + missing
    asserted: list[tuple[str, str, str, str]] = []
    missing: list[tuple[str, str, str, str]] = []

    # --- Phase 1: select-columns.test.js assertions ---
    for tf in test_files:
        rel = str(Path(tf).relative_to(repo))
        parsed = parse_test_file(Path(tf))
        if not parsed:
            print(f"WARN: could not parse table/columns from {rel} -- skipping", file=sys.stderr)
            continue
        for table, cols in parsed:
            prod_cols = cols_for(table)
            for col in cols:
                asserted.append(("P1", rel, table, col))
                if col not in prod_cols:
                    missing.append(("P1", rel, table, col))

    # --- Phase 2: INSERT column lists in handler files ---
    for hf in handler_files:
        rel = str(Path(hf).relative_to(repo))
        for table, cols, line in parse_insert_blocks(Path(hf)):
            prod_cols = cols_for(table)
            for col in cols:
                ref = f"{rel}:{line}"
                asserted.append(("P2", ref, table, col))
                if col not in prod_cols:
                    missing.append(("P2", ref, table, col))

    # --- Phase 3: soft-delete column presence (UPDATE ... SET deleted_at) ---
    seen_p3: set[tuple[str, str]] = set()
    for hf in handler_files:
        rel = str(Path(hf).relative_to(repo))
        for table, line in parse_soft_delete_tables(Path(hf)):
            key = (rel, table)
            if key in seen_p3:
                continue
            seen_p3.add(key)
            ref = f"{rel}:{line}"
            asserted.append(("P3", ref, table, "deleted_at"))
            if "deleted_at" not in cols_for(table):
                missing.append(("P3", ref, table, "deleted_at"))

    conn.close()

    if args.verbose:
        for phase, ref, table, col in asserted:
            status = "MISS" if col not in table_cache.get(table, set()) else "OK"
            print(f"{status:4s}  [{phase}] {table}.{col}  ({ref})")
        print()

    total = len(asserted)
    if missing:
        p1 = sum(1 for m in missing if m[0] == "P1")
        p2 = sum(1 for m in missing if m[0] == "P2")
        p3 = sum(1 for m in missing if m[0] == "P3")
        print(
            f"FAIL: {len(missing)} of {total} column refs are MISSING in prod Neon "
            f"(Phase 1: {p1}, Phase 2: {p2}, Phase 3 soft-delete: {p3}):"
        )
        by_table: dict[str, list[tuple[str, str, str]]] = {}
        for phase, ref, table, col in missing:
            by_table.setdefault(table, []).append((col, ref, phase))
        for table in sorted(by_table):
            print(f"  {table}:")
            for col, ref, phase in by_table[table]:
                print(f"    - {col}  [{phase}] ({ref})")
        print()
        print(
            "L-081 enforcement: HALT before squash-merge. Apply the additive migration "
            "to prod Neon first per CLAUDE.md Migration Authoring Rule §1 exception."
        )
        return 1

    print(
        f"PASS: {total} column refs "
        f"(Phase 1 select-columns + Phase 2 INSERT lists + Phase 3 soft-delete) all present in prod Neon."
    )
    print(f"Tables verified: {', '.join(sorted(table_cache.keys()))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
