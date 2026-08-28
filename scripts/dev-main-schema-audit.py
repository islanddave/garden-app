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
    column list across `lambda/**/*.js` (excluding node_modules and *.test.js)
    must exist in prod. Widened from index.js-only 2026-08-19. This is the
    write-path blind spot Phase 1 missed: PATCH/POST handlers that INSERT into
    a column the prod schema lacks would 500 (or violate a constraint) with no
    select-columns.test.js coverage. Scope is deliberately limited to the
    parenthesized column list immediately preceding VALUES/SELECT - the
    unambiguous, regex-tractable subset of inline SQL. Column refs buried in
    SELECT/WHERE/SET/jsonb_build_object/RETURNING are NOT audited here (full
    SQL parse is a separate, fragility-prone effort - intentionally deferred).

Pre-flight gate. Run before any dev->main promote on garden-app.
Returns PASS / FAIL with specific (file, table, column) tuples on FAIL.
Wired into `.github/workflows/schema-audit.yml`, which runs on pushes to dev
(path-filtered to the audited sources; advisory -- trigger re-homed 2026-07-22,
OPS-GUARDINTEG-001, after the original pull_request->main trigger went
structurally dead under OPS-GATE-001).

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
import json
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


# Phase 1 discovery pattern. A module constant, not an inline literal, so a test can assert
# against the pattern this auditor will actually use. It was `select-columns.test.js` until
# 2026-08-28, which made lambda/inventory-items/garden-node-columns.test.js -- written that
# same day precisely to guard a JOINed relation -- invisible: the guard guarded nothing.
PHASE1_GLOB = "*columns.test.js"

# Declared audit contract: `const AUDIT_TABLES = ['table1', ...]` in the test file.
_AUDIT_TABLES_DECL = re.compile(r"const\s+AUDIT_TABLES\s*=\s*\[(.*?)\]", re.DOTALL)
# Keyed contract (added 2026-08-28, BUG-SEEDDETAIL500-001 class):
# `const AUDIT_COLUMNS = { table: ['a', 'b'], other_table: ['c'] };`
# Binds each column array to ONE named relation, so a handler that JOINs can declare
# every relation it touches without the AUDIT_TABLES cross-product demanding that all
# columns exist on all tables. That cross-product is the structural reason every file
# in this repo declared exactly one table -- and therefore why joined relations were
# audited by nothing. See the Phase 4 census.
_AUDIT_COLUMNS_DECL = re.compile(r"const\s+AUDIT_COLUMNS\s*=\s*\{(.*?)\};", re.DOTALL)
# One `table: [ ... ]` pair inside that object. A column array never nests brackets,
# so `[^\]]*` is a safe body match.
_AUDIT_COLUMNS_PAIR = re.compile(r"['\"]?([a-zA-Z_]\w*)['\"]?\s*:\s*\[([^\]]*)\]")
# Fallback: JS regex literal text `FROM\s+<table>` / `FROM\s+public\.<table>`.
# The JS source characters are: F R O M \ s + [p u b l i c \ .] table_name
_FROM_LITERAL = re.compile(r"FROM\\s\+(?:public\\\.)?(\w+)")


def parse_test_file(path: Path) -> list[tuple[str, list[str]]]:
    """Phase 1. Returns [(table, [columns]), ...] tuples from a
    *columns.test.js file.

    Table resolution, in priority order:
      0. Keyed contract: `const AUDIT_COLUMNS = { table: [...], ... }` (2026-08-28).
         Per-table, NO cross-product -- the only form that lets one file cover a
         handler's joined relations. When present it is used INSTEAD of 1/2, and
         the loose `*COLUMNS` collector is skipped for this file so a helper array
         cannot leak into every declared table.
      1. Declared contract: `const AUDIT_TABLES = ['t', ...]` in the test file.
         Explicit, robust to any extractSelectBlocks regex shape (alternations,
         schema qualification, aliases). Each *COLUMNS array is audited against
         EVERY declared table -- which is why a file using this form should name
         exactly one table.
      2. Fallback (files without a declaration): the first `FROM\\s+<table>`
         JS-regex literal, schema-qualification-aware (`public\\.` is consumed,
         not captured -- the old parser captured "public" as the table).
         Alternation forms (`FROM\\s+(?:a|b)`) are NOT parseable this way;
         such files MUST declare AUDIT_TABLES or they are skipped (counted
         loudly in the run summary).

    Column arrays: every `const *COLUMN[S] = ['...', ...]` array of string
    literals. Note `AUDIT_TABLES` itself does not match that collector, and
    neither do absence-assertion arrays like LEGACY_COLUMNS_REMOVED_IN_2_0_5
    (identifier must END in COLUMN/COLUMNS).
    """
    src = path.read_text()

    # --- Form 0: keyed, per-table. Takes precedence and returns directly. ---
    keyed = _AUDIT_COLUMNS_DECL.search(src)
    if keyed:
        out: list[tuple[str, list[str]]] = []
        for table, body in _AUDIT_COLUMNS_PAIR.findall(keyed.group(1)):
            cols = re.findall(r"['\"]([a-zA-Z_][a-zA-Z0-9_]*)['\"]", body)
            if cols:
                out.append((table, cols))
        if out:
            return out

    tables: list[str] = []
    decl = _AUDIT_TABLES_DECL.search(src)
    if decl:
        tables = re.findall(r"['\"](\w+)['\"]", decl.group(1))
    if not tables:
        m = _FROM_LITERAL.search(src)
        if m:
            tables = [m.group(1)]
    if not tables:
        return []

    results = []
    # Match `const ANYTHING_COLUMNS = [ ... ];` -- DOTALL so multi-line arrays work.
    for arr_match in re.finditer(
        r"const\s+\w*COLUMNS?\s*=\s*\[(.*?)\];", src, re.DOTALL
    ):
        cols_text = arr_match.group(1)
        # Extract every quoted string literal (single or double quote).
        cols = re.findall(r"['\"]([a-zA-Z_][a-zA-Z0-9_]*)['\"]", cols_text)
        if cols:
            for table in tables:
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


# Phase 4 (added 2026-08-28, BUG-SEEDDETAIL500-001 class).
#
# Phases 1-3 all answer "does this declared column exist?". None of them asks the prior
# question: "which relations does this handler actually touch, and is any of them declared
# at all?" Because Phase 1 cross-products every column array against every declared table,
# each file in this repo declares exactly ONE table -- so every relation a handler JOINs to
# was audited by NOTHING. That is how `p.name` on garden_node passed a green audit, a green
# unit suite and a green integration run while 500-ing every seed packet page in prod.
#
# MEASURED at introduction against origin/dev 74d6170 + live prod: 21 Lambdas touch 98
# distinct relation refs, of which 78 have no column contract. All 31 distinct relation
# names verified present in prod, so the extractor below produces no phantoms.
_SQL_TEMPLATE = re.compile(r"sql`([\s\S]*?)`")
# `IS [NOT] DISTINCT FROM x.col` contains the literal token FROM. Removed before scanning,
# or the operator's right-hand alias is captured as a relation — it produced two of the five
# false FAILs this check reported on its first run (`l` from `IS NOT DISTINCT FROM l.entity_id`).
_DISTINCT_FROM = re.compile(r"\bIS\s+(?:NOT\s+)?DISTINCT\s+FROM\b", re.IGNORECASE)
# The trailing (?!\s*\.) rejects `FROM alias.column`: a real relation reference is never
# immediately followed by a dot once the optional `public.` prefix has been consumed.
_SQL_RELATION = re.compile(
    r"\b(?:FROM|JOIN)\s+(?:public\.)?([a-z_][a-z0-9_]*)(?!\s*\.)", re.IGNORECASE
)
# `WITH x AS (`, `WITH RECURSIVE x AS (`, `, x AS (`, and the MATERIALIZED variants.
# A CTE is a query-local name, not a prod relation.
_CTE_DECL = re.compile(
    r"(?:\bWITH\s+(?:RECURSIVE\s+)?|,)\s*([a-z_][a-z0-9_]*)\s+AS\s*(?:NOT\s+)?(?:MATERIALIZED\s*)?\(",
    re.IGNORECASE,
)
# Keywords/table-functions that can legally follow FROM/JOIN and are not relations.
_NOT_A_RELATION = {
    "select", "lateral", "unnest", "generate_series", "jsonb_array_elements",
    "jsonb_array_elements_text", "json_array_elements", "values", "rows",
}


def _decomment_js(src: str) -> str:
    """Strip JS `//` and SQL `--` comments. A relation NAMED IN A COMMENT is not touched.

    The SQL arm matches a BARE `--` at end of line as well as `-- text`. That is not a nicety:
    a bare `--` separator line inside a CTE chain (lambda/harvests/watch-route.js:161) survived
    the `--\\s` form, left a literal `--` sitting between the previous CTE's comma and the next
    CTE's name, and so hid three CTE declarations from _CTE_DECL. Those three then read as
    undeclared relations and the Phase-4 existence check reported five false FAILs.
    """
    return "\n".join(
        re.sub(r"(^|\s)--(\s.*)?$", r"\1", re.sub(r"(^|[^:])//.*$", r"\1", line))
        for line in src.split("\n")
    )


def parse_sql_relations(path: Path) -> set[str]:
    """Phase 4. Relations a handler references in FROM/JOIN inside its sql`` templates,
    with CTE names and table-functions removed."""
    src = _decomment_js(path.read_text())
    rels: set[str] = set()
    ctes: set[str] = set()
    for tmpl in _SQL_TEMPLATE.findall(src):
        tmpl = _DISTINCT_FROM.sub(" ", tmpl)
        ctes |= {c.lower() for c in _CTE_DECL.findall(tmpl)}
        rels |= {r.lower() for r in _SQL_RELATION.findall(tmpl)}
    return {r for r in rels if r not in _NOT_A_RELATION and r not in ctes}


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
    parser.add_argument(
        "--allowlist",
        default=None,
        help="waived column refs (default: {repo-root}/scripts/schema-audit-allowlist.json)",
    )
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

    # Phase 1 globbed ONLY `select-columns.test.js` until 2026-08-28. That made
    # lambda/inventory-items/garden-node-columns.test.js -- written the same day
    # precisely to guard a JOINed relation -- invisible to this auditor, so the
    # guard existed and audited nothing. Widened to any `*columns.test.js`.
    test_files = sorted(
        glob.glob(str(repo / "lambda" / "**" / PHASE1_GLOB), recursive=True)
    )
    # Phase 2 globbed ONLY `index.js` until 2026-08-19, which made every INSERT in a non-index
    # handler module invisible to this audit — `lambda/harvests/watch-route.js` writes to
    # `watch_exclusion`, a table that does not exist in prod at all, and the audit reported GREEN.
    # A wholly missing table being invisible is the worst shape of blind spot, because the audit's
    # whole purpose is catching a write path that outruns the schema.
    # Widened to every non-test .js under lambda/, excluding node_modules (vendored code is not our
    # write path and would swamp the scan: 103 extra files, of which 12 carry an INSERT column list).
    # Blast radius MEASURED against live prod before widening, not assumed: the 12 newly-visible
    # files reference 19 tables, of which 18 verify clean and exactly 1 reports — `watch_exclusion`,
    # the true positive above. It clears when v4-watchexcluded-001 applies to prod.
    handler_files = sorted(
        f
        for f in glob.glob(str(repo / "lambda" / "**" / "*.js"), recursive=True)
        if "node_modules" not in f and not f.endswith((".test.js", ".spec.js"))
    )
    if not test_files and not handler_files:
        print(
            f"FAIL: no select-columns.test.js or handler .js files under {repo}/lambda",
            file=sys.stderr,
        )
        return 2

    if args.verbose:
        print(f"# repo: {repo}")
        print(f"# env:  {env_path}")
        print(f"# Phase 1: {len(test_files)} select-columns.test.js file(s)")
        print(f"# Phase 2: {len(handler_files)} handler .js file(s)")
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
    p1_parsed = 0
    p1_skipped: list[str] = []
    for tf in test_files:
        rel = str(Path(tf).relative_to(repo))
        parsed = parse_test_file(Path(tf))
        if not parsed:
            print(
                f"WARN: could not parse table/columns from {rel} -- NOT audited "
                f"(declare `const AUDIT_TABLES = [...]` in the test file)",
                file=sys.stderr,
            )
            p1_skipped.append(rel)
            continue
        p1_parsed += 1
        for table, cols in parsed:
            prod_cols = cols_for(table)
            if not prod_cols:
                # Empty-relation guard (BUG-VARVIEW-001): a resolved table with
                # ZERO columns in information_schema is a parse/config error
                # (mis-captured table name, bad AUDIT_TABLES declaration, or a
                # dropped relation) -- NEVER report it as "every column
                # missing". Inconclusive -> exit 2 (workflow UNVERIFIED path).
                # Scoped to Phase 1 only: Phase 2/3 tables come from real SQL,
                # where a missing relation is a genuine L-081 FAIL.
                conn.close()
                print(
                    f"ERROR: relation '{table}' (resolved from {rel}) has ZERO "
                    f"columns in prod information_schema -- Phase-1 parse/config "
                    f"error, audit inconclusive.",
                    file=sys.stderr,
                )
                return 2
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

    # --- Phase 4: joined-relation coverage census (+ existence check) ---
    # Grouped per Lambda directory, because a column contract declared in
    # lambda/foo/*columns.test.js covers the relations lambda/foo/*.js touches.
    declared_by_dir: dict[Path, set[str]] = {}
    for tf in test_files:
        d = Path(tf).parent
        declared_by_dir.setdefault(d, set())
        for table, _cols in parse_test_file(Path(tf)):
            declared_by_dir[d].add(table.lower())

    touched_by_dir: dict[Path, set[str]] = {}
    for hf in handler_files:
        h = Path(hf)
        rels = parse_sql_relations(h)
        if rels:
            touched_by_dir.setdefault(h.parent, set()).update(rels)

    # (a) HARD: a relation a handler queries must EXIST in prod. Zero violations at
    # introduction, so this is fail-closed from day one and carries no debt. This is the
    # `watch_exclusion` shape -- a wholly absent relation -- one altitude up from Phase 2,
    # which only sees it when it appears in an INSERT column list.
    absent_rels: list[tuple[str, str]] = []
    # (b) RATCHET: touched-but-undeclared. 78 at introduction; the count may fall, never rise.
    uncovered: dict[str, list[str]] = {}
    for d in sorted(touched_by_dir, key=lambda p: p.name):
        touched = touched_by_dir[d]
        declared = declared_by_dir.get(d, set())
        for r in sorted(touched):
            if not cols_for(r):
                absent_rels.append((d.name, r))
        gap = sorted(touched - declared)
        if gap:
            uncovered[d.name] = gap

    conn.close()

    if args.verbose:
        for phase, ref, table, col in asserted:
            status = "MISS" if col not in table_cache.get(table, set()) else "OK"
            print(f"{status:4s}  [{phase}] {table}.{col}  ({ref})")
        print()

    # Phase-1 parse visibility: a skipped file is an UNAUDITED column contract.
    p1_summary = (
        f"P1: {len(test_files)} select-columns file(s), "
        f"{p1_parsed} parsed, {len(p1_skipped)} skipped"
    )
    if p1_skipped:
        p1_summary += f" -- UNAUDITED: {', '.join(p1_skipped)}"
        print(f"WARN: {p1_summary}", file=sys.stderr)
    print(p1_summary)

    # ── Phase 4 report: existence (hard) then coverage (ratchet) ──────────────────────────────
    if absent_rels:
        print()
        print(f"FAIL: {len(absent_rels)} relation(s) queried by a handler do NOT exist in prod:")
        for lam, r in absent_rels:
            print(f"    - {r}  (queried by lambda/{lam})")
        print()
        print("A handler cannot SELECT from a relation prod does not have. Apply the migration first.")
        return 1

    n_uncovered = sum(len(v) for v in uncovered.values())
    baseline_path = repo / "scripts" / "schema-audit-join-baseline.json"
    baseline = None
    if baseline_path.exists():
        try:
            baseline = int((json.loads(baseline_path.read_text()) or {}).get("uncovered_relations"))
        except (json.JSONDecodeError, OSError, TypeError, ValueError) as exc:
            print(f"FAIL: could not read {baseline_path.name}: {exc}", file=sys.stderr)
            return 2

    print(
        f"P4: {len(touched_by_dir)} lambda(s), "
        f"{sum(len(v) for v in touched_by_dir.values())} relation ref(s) touched, "
        f"{n_uncovered} with NO column contract"
        + (f" (baseline {baseline})" if baseline is not None else "")
    )
    if uncovered and args.verbose:
        for lam in sorted(uncovered):
            print(f"    {lam}: {', '.join(uncovered[lam])}")

    if baseline is not None and n_uncovered > baseline:
        print()
        print(
            f"FAIL: joined-relation coverage REGRESSED -- {n_uncovered} uncovered, baseline {baseline}."
        )
        for lam in sorted(uncovered):
            print(f"    {lam}: {', '.join(uncovered[lam])}")
        print()
        print(
            "Declare the new relation's columns with the keyed form in that lambda's\n"
            "*columns.test.js:  const AUDIT_COLUMNS = { <table>: ['col', ...] };\n"
            "then lower uncovered_relations in scripts/schema-audit-join-baseline.json."
        )
        return 1
    if baseline is not None and n_uncovered < baseline:
        print(
            f"    coverage IMPROVED ({baseline} -> {n_uncovered}). Lower uncovered_relations in "
            f"{baseline_path.name} to lock it in."
        )

    # ── Flag-gated waivers (see scripts/schema-audit-allowlist.json) ──────────────────────────
    # A ref may be waived ONLY when it is unreachable in prod at runtime — gated behind a flag
    # that is off there — so the code can land on dev ahead of the prod DDL without the audit
    # going permanently red and eroding its own signal. Two properties keep this honest:
    #   1. a waiver suppresses a MISS, never a real ungated one (that is on the author to assert,
    #      and the flag-gate proof lives in the handler's own tests);
    #   2. it SELF-EXPIRES — once prod actually has the column the waiver is stale, and a stale
    #      waiver is a hard FAIL demanding its deletion. That is what stops this file rotting
    #      into a permanent silencer, which is how allowlists usually die.
    allow_path = Path(args.allowlist) if args.allowlist else repo / "scripts" / "schema-audit-allowlist.json"
    waived: dict = {}
    if allow_path.exists():
        try:
            waived = (json.loads(allow_path.read_text()) or {}).get("waived_refs", {}) or {}
        except (json.JSONDecodeError, OSError) as exc:
            print(f"FAIL: could not read {allow_path}: {exc}", file=sys.stderr)
            return 2

    stale = [
        key for key in waived
        if "." in key
        and key.split(".", 1)[1] in table_cache.get(key.split(".", 1)[0], set())
    ]
    if stale:
        print(f"FAIL: {len(stale)} STALE waiver(s) in {allow_path.name} — the column now exists in prod:")
        for key in sorted(stale):
            print(f"    - {key}  (remove this entry; the audit should be enforcing it again)")
        print()
        print("A waiver that outlives its need silently disables a real guard. Delete it.")
        return 1

    if waived:
        kept = [m for m in missing if f"{m[2]}.{m[3]}" not in waived]
        for phase, ref, table, col in missing:
            if f"{table}.{col}" in waived:
                entry = waived[f"{table}.{col}"]
                flag = entry.get("flag", "?") if isinstance(entry, dict) else "?"
                print(f"WAIVED [{phase}] {table}.{col}  ({ref}) — gated behind {flag}, absent in prod")
        missing = kept

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
