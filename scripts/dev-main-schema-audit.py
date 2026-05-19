#!/usr/bin/env python3
"""
dev-main-schema-audit.py - L-081 enforcement (canonical home: garden-app/scripts/)

Verifies every column asserted in `lambda/**/select-columns.test.js` is present
in prod Neon's information_schema.columns. Catches the L-081 bug class
(local_3f62f153 2026-05-19 prod incident E-local_3f62f153-001): code references
columns that exist in staging but not prod, deploy succeeds, every endpoint 500s.

Pre-flight gate. Run before any dev->main squash-merge on garden-app.
Returns PASS / FAIL with specific missing (file, table, column) tuples on FAIL.
Wired into `.github/workflows/schema-audit.yml` as an advisory PR check.

Usage:
    python3 scripts/dev-main-schema-audit.py [--repo-root PATH] [--env-file PATH] [--verbose]

Default repo-root: current directory (when invoked from CI checkout)
                  or /Users/davenichols/AI/Claude/Projects/Gardening/garden-app (local dev)
Default env-file:  {repo-root}/.env.local  (reads NEON_DATABASE_URL per L-067)
Env var:          NEON_DATABASE_URL takes precedence over .env.local (CI path)

Exit codes:
    0 = PASS  (all expected columns present in prod)
    1 = FAIL  (one or more columns missing in prod -- halt squash-merge)
    2 = error (config / connection / parse failure -- inconclusive)

Related: L-081 in /Users/davenichols/AI/Claude/learning/lessons.md
Sync: a reference copy lives at ~/AI/Claude/claude-ops/scripts/. This garden-app
location is canonical for CI and local invocation against garden-app. Keep in sync
when modifying behavior.
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
    """Returns [(table, [columns]), ...] tuples from a select-columns.test.js file.

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
    if not test_files:
        print(
            f"FAIL: no select-columns.test.js files under {repo}/lambda",
            file=sys.stderr,
        )
        return 2

    if args.verbose:
        print(f"# repo: {repo}")
        print(f"# env:  {env_path}")
        print(f"# found {len(test_files)} test file(s):")
        for tf in test_files:
            print(f"#   - {Path(tf).relative_to(repo)}")
        print()

    conn = psycopg2.connect(neon_url)

    table_cache: dict[str, set[str]] = {}
    missing: list[tuple[str, str, str]] = []
    total_cols = 0
    asserted: list[tuple[str, str, str]] = []  # (rel_file, table, col)

    for tf in test_files:
        rel = str(Path(tf).relative_to(repo))
        parsed = parse_test_file(Path(tf))
        if not parsed:
            print(
                f"WARN: could not parse table/columns from {rel} -- skipping",
                file=sys.stderr,
            )
            continue
        for table, cols in parsed:
            if table not in table_cache:
                table_cache[table] = query_prod_columns(conn, table)
            prod_cols = table_cache[table]
            for col in cols:
                total_cols += 1
                asserted.append((rel, table, col))
                if col not in prod_cols:
                    missing.append((rel, table, col))

    conn.close()

    if args.verbose:
        for rel, table, col in asserted:
            status = "MISS" if col not in table_cache[table] else "OK"
            print(f"{status:4s}  {table}.{col}  ({rel})")
        print()

    if missing:
        print(
            f"FAIL: {len(missing)} of {total_cols} columns asserted in lambda tests "
            f"are MISSING in prod Neon:"
        )
        # Group by table for readability.
        by_table: dict[str, list[tuple[str, str]]] = {}
        for rel, table, col in missing:
            by_table.setdefault(table, []).append((col, rel))
        for table in sorted(by_table):
            print(f"  {table}:")
            for col, rel in by_table[table]:
                print(f"    - {col}  ({rel})")
        print()
        print(
            "L-081 enforcement: HALT before squash-merge. Apply the additive migration "
            "to prod Neon first per CLAUDE.md Migration Authoring Rule §1 exception."
        )
        return 1

    print(
        f"PASS: {total_cols} columns across {len(test_files)} test file(s) all present in prod Neon."
    )
    print(f"Tables verified: {', '.join(sorted(table_cache.keys()))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
