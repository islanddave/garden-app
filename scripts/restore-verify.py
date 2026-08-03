#!/usr/bin/env python3
"""
restore-verify.py — garden-app scheduled "restore is tested" primitive (spec §3 B3; Gate 0.2/0.3).

An untested backup is not a backup — and a restore test that cannot fail is not
a test. The previous implementation restored into a Neon scratch branch created
WITHOUT parent_id, which Neon parents to the project DEFAULT branch (PRODUCTION):
the scratch branch already contained every object the dump might be missing, so
the check was TAUTOLOGICAL. Gate 0.2 fix: restore into a genuinely EMPTY
throwaway Postgres 17 (a service container in the CI runner). No Neon API calls,
no scratch-branch churn, no branch cost. The target is asserted empty BEFORE the
restore (refuses a dirty/reused container — keeps the invariant honest).

WHAT IS ASSERTED after the restore (expected inventory grounded at runtime by
read-only SELECTs against live prod — never hardcoded):
  - public table-set vs prod (missing from restore = HARD; extra = warn)
  - core tables present + populated; per-table row-count drift vs prod
    (ROW_DRIFT_FLOOR — the pre-existing freshness check, kept)
  - FULL-SCOPE dumps additionally: schemas {public, gv, extensions} all exist;
    the extensions-schema function inventory (uuid_generate_v4 etc — all PLAIN
    functions in prod, so pg_dump carries them), the gv.* function inventory
    (~11 fns), and the non-internal trigger inventory on public tables all
    match prod (missing = HARD; extra = warn).

TRANSITION BOUNDARY (full-scope dump rollout): dumps produced by the pre-fix
dumper are public-only (--schema=public). Scope is detected PER DUMP by probing
the archive TOC (pg_restore --list) for gv + extensions SCHEMA entries — no
manifest dependency, works for both buckets. Legacy public-only dumps get the
public-schema assertions plus a LOUD warning; set REQUIRE_FULL_SCOPE=1 once the
full-scope dumper has shipped and produced its first dumps to hard-fail legacy.

GLOBALS (optional): if the dumper uploaded a pg_dumpall --globals-only file
next to the dump (<key minus .dump>.globals.sql, or GLOBALS_KEY), it is applied
first via psql. Neon-specific role noise (cloud_admin / neon_superuser /
already-exists / permission denied) is DELIBERATELY tolerated by pattern — the
main restore runs --no-owner --no-privileges so globals are best-effort;
unexpected globals errors surface as warnings, never silently.

------------------------------------------------------------------------------
ENV CONTRACT (read at runtime; no secrets hardcoded):
  SCRATCH_DATABASE_URL  EMPTY throwaway Postgres 17 to restore into (the CI
                        service container). REFUSED if it already has tables.
  NEON_BACKUP_URL       DIRECT (non-pooler) prod Postgres URL — READ-ONLY
                        baseline for the inventory/row-count comparison.
  BACKUP_BUCKET         dump bucket (default garden-backups-prod).
  DUMP_PREFIX           dump key prefix (default "db/garden-"). The snap leg
                        passes garden-snapshots-prod / "db/snap-".
  ROW_DRIFT_FLOOR       min restored/prod ratio tolerated for a populated table
                        (default 0.5).
  DRIFT_MIN_ROWS        only ratio-check tables whose prod count >= this (default 20).
  REQUIRE_FULL_SCOPE    "1" -> a legacy public-only dump is a HARD failure
                        (default "0" during the transition).
  GLOBALS_KEY           explicit S3 key of the globals file (else derived from
                        the dump key; absent = skipped with an info line).
  REHEARSAL_VERSION     snap-rehearsal's version string (default "v0.0.0").
                        snap-rehearsal dumps STAGING into the SAME bucket/prefix
                        the snap leg scans (db/snap-v0.0.0.dump); if that object
                        is ever recreated it becomes the newest by LastModified
                        and the leg would verify a STAGING dump against PROD
                        inventory -> false red. latest_dump_key excludes keys
                        matching the rehearsal version (pattern-anchored).

Dependencies: boto3 (S3), pg_restore/psql (pg17 — must match the PG17 server;
ubuntu-latest ships a pg16 client, the workflow installs pg17 from PGDG).

Exit codes: 0 = restore verified coherent; 1 = restore failed or incoherent
(schema/object/row mismatch) -> ALERT.
------------------------------------------------------------------------------
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile

import boto3
from botocore.exceptions import ClientError

# Core tables that must exist + be populated for a restore to count as coherent.
SANITY_TABLES = [
    "plant_projects",
    "plants",
    "event_log",
    "locations",
    "inventory_items",
    "plant_varieties",
]

# Full-database scope = these schemas all present in the dump TOC (grounded
# against live prod 2026-08-03: public 62 tables, gv 11 fns/0 tables,
# extensions 8 uuid_* fns/0 tables).
STRUCT_SCHEMAS = ("public", "gv", "extensions")

# Globals restore (pg_dumpall output) hits Neon-managed roles/params that a
# vanilla container legitimately rejects. DELIBERATE tolerance list — pattern
# match, not a blanket ignore. Anything else surfaces as a warning.
TOLERATED_GLOBALS_PATTERNS = [
    r'role "(cloud_admin|neon_superuser|zenith_admin|web_access|neon_service_user)"',
    r"already exists",
    r"must be superuser",
    r"permission denied",
    r"unrecognized configuration parameter",
]


class VerifyError(Exception):
    """Restore failed or is incoherent — non-zero exit (alert)."""


class Config:
    def __init__(self, env=None):
        env = os.environ if env is None else env
        self.scratch_url = self._req(env, "SCRATCH_DATABASE_URL")
        self.neon_backup_url = self._req(env, "NEON_BACKUP_URL")
        self.backup_bucket = env.get("BACKUP_BUCKET", "garden-backups-prod")
        self.dump_prefix = env.get("DUMP_PREFIX", "db/garden-")
        self.row_drift_floor = float(env.get("ROW_DRIFT_FLOOR", "0.5"))
        self.drift_min_rows = int(env.get("DRIFT_MIN_ROWS", "20"))
        self.require_full_scope = env.get("REQUIRE_FULL_SCOPE", "0") == "1"
        self.globals_key = env.get("GLOBALS_KEY", "")
        self.rehearsal_version = env.get("REHEARSAL_VERSION", "v0.0.0")

    @staticmethod
    def _req(env, key):
        val = env.get(key)
        if not val:
            raise VerifyError(f"required env var {key} is missing or empty")
        return val


# --- S3: latest dump ---------------------------------------------------------

def _is_rehearsal_key(key, rehearsal_version):
    """True for snap-rehearsal artifacts (STAGING dumps co-located in the snap
    bucket): matches snap-<rehearsal_version> as a whole version token
    (anchored — snap-v0.0.0.dump yes, snap-v0.0.01.dump no)."""
    return re.search(rf"(^|/)snap-{re.escape(rehearsal_version)}\.", key) is not None


def latest_dump_key(s3, cfg):
    """Return the newest {DUMP_PREFIX}*.dump key in the bucket (by LastModified).
    Rehearsal dumps are EXCLUDED: they dump STAGING, and verifying one against
    prod inventory would be a false red (RIA-3)."""
    paginator = s3.get_paginator("list_objects_v2")
    newest = None
    for page in paginator.paginate(Bucket=cfg.backup_bucket, Prefix=cfg.dump_prefix):
        for obj in page.get("Contents", []):
            if not obj["Key"].endswith(".dump"):
                continue
            if _is_rehearsal_key(obj["Key"], cfg.rehearsal_version):
                continue
            if newest is None or obj["LastModified"] > newest["LastModified"]:
                newest = obj
    if newest is None:
        raise VerifyError(
            f"no dump found under s3://{cfg.backup_bucket}/{cfg.dump_prefix}*"
        )
    if newest.get("Size", 0) <= 0:
        raise VerifyError(f"latest dump {newest['Key']} is empty (0 bytes)")
    return newest["Key"], newest["LastModified"], newest["Size"]


def _s3_exists(s3, bucket, key):
    try:
        s3.head_object(Bucket=bucket, Key=key)
        return True
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        if code in ("404", "NoSuchKey", "NotFound", "403", "Forbidden", "AccessDenied"):
            return False
        raise


def find_globals_key(s3, cfg, dump_key):
    """Locate the sibling pg_dumpall globals file for this dump, if any.
    Contract with the dumper: <dump key minus .dump>.globals.sql (GLOBALS_KEY
    overrides). Absent = None (globals are optional — main restore is
    --no-owner --no-privileges)."""
    if cfg.globals_key:
        return cfg.globals_key if _s3_exists(s3, cfg.backup_bucket, cfg.globals_key) else None
    candidates = []
    if dump_key.endswith(".dump"):
        candidates.append(dump_key[: -len(".dump")] + ".globals.sql")
    candidates.append(dump_key + ".globals.sql")
    for k in candidates:
        if _s3_exists(s3, cfg.backup_bucket, k):
            return k
    return None


# --- psql introspection (used against BOTH the scratch target and prod) ------

def _psql_scalar(url, sql):
    proc = subprocess.run(["psql", url, "-tA", "-c", sql], capture_output=True, text=True)
    if proc.returncode != 0:
        raise VerifyError(f"psql failed: {proc.stderr.strip()}")
    return proc.stdout.strip()


def table_set(url):
    """Public BASE TABLE names as a set."""
    out = _psql_scalar(
        url,
        "SELECT string_agg(table_name, ',' ORDER BY table_name) "
        "FROM information_schema.tables "
        "WHERE table_schema='public' AND table_type='BASE TABLE';",
    )
    return set(t for t in out.split(",") if t)


def schema_set(url):
    """Which of the STRUCT_SCHEMAS exist."""
    out = _psql_scalar(
        url,
        "SELECT string_agg(nspname, ',' ORDER BY nspname) FROM pg_namespace "
        "WHERE nspname IN ('public','gv','extensions');",
    )
    return set(s for s in out.split(",") if s)


def func_set(url, schema):
    """Function names in a schema (prod: all PLAIN fns, so dump must carry them)."""
    out = _psql_scalar(
        url,
        "SELECT string_agg(p.proname, ',' ORDER BY p.proname) "
        "FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid "
        f"WHERE n.nspname='{schema}';",
    )
    return set(f for f in out.split(",") if f)


def trigger_set(url):
    """Non-internal triggers on public tables as table:trigger:function triples."""
    out = _psql_scalar(
        url,
        "SELECT string_agg(c.relname||':'||t.tgname||':'||pr.proname, ',' "
        "ORDER BY c.relname, t.tgname) "
        "FROM pg_trigger t JOIN pg_class c ON t.tgrelid=c.oid "
        "JOIN pg_namespace n ON c.relnamespace=n.oid "
        "JOIN pg_proc pr ON t.tgfoid=pr.oid "
        "WHERE NOT t.tgisinternal AND n.nspname='public';",
    )
    return set(t for t in out.split(",") if t)


def row_counts(url, tables):
    counts = {}
    for t in tables:
        try:
            counts[t] = int(_psql_scalar(url, f"SELECT count(*) FROM {t};"))
        except VerifyError:
            counts[t] = None
    return counts


# --- pre-restore guards ------------------------------------------------------

def ensure_empty_target(url):
    """The scratch target must be genuinely EMPTY (Gate 0.2 tautology guard —
    a reused/dirty target would mask missing objects exactly like the old
    prod-parented branch did)."""
    tables = _psql_scalar(
        url,
        "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid "
        "WHERE c.relkind IN ('r','p') AND n.nspname NOT IN "
        "('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_%';",
    )
    schemas = _psql_scalar(
        url, "SELECT count(*) FROM pg_namespace WHERE nspname IN ('gv','extensions');"
    )
    if int(tables) != 0 or int(schemas) != 0:
        raise VerifyError(
            f"scratch target is NOT empty ({tables} user tables, {schemas} app "
            f"schemas pre-restore) — refusing; a dirty target makes the verify tautological"
        )


def probe_dump_scope(dump_path):
    """Detect dump scope from the archive TOC (pg_restore --list): full-scope
    dumps carry SCHEMA entries for gv + extensions; legacy --schema=public
    dumps cannot. Returns (full_scope: bool, toc_schemas: set)."""
    proc = subprocess.run(
        ["pg_restore", "--list", dump_path], capture_output=True, text=True
    )
    if proc.returncode != 0:
        raise VerifyError(
            f"pg_restore --list cannot read the dump (not a valid archive?): "
            f"{proc.stderr.strip()[:400]}"
        )
    schemas = set()
    for line in (proc.stdout or "").splitlines():
        toks = line.split()
        if "SCHEMA" in toks:
            i = toks.index("SCHEMA")
            if len(toks) > i + 2 and toks[i + 1] == "-":
                schemas.add(toks[i + 2])
            elif len(toks) > i + 1:
                schemas.add(toks[i + 1])
    return ({"gv", "extensions"} <= schemas), schemas


# --- restore -----------------------------------------------------------------

def _classify_globals_errors(stderr):
    """Split psql globals-restore ERROR lines into (tolerated, unexpected)."""
    tolerated, unexpected = [], []
    for line in (stderr or "").splitlines():
        if "ERROR" not in line:
            continue
        if any(re.search(p, line) for p in TOLERATED_GLOBALS_PATTERNS):
            tolerated.append(line)
        else:
            unexpected.append(line)
    return tolerated, unexpected


def restore_globals(s3, cfg, globals_key, target_uri, tmpdir):
    """Apply the pg_dumpall globals file (roles etc). Best-effort: Neon-specific
    role noise is tolerated by pattern; unexpected errors become WARNINGS (the
    main restore is --no-owner --no-privileges, so globals never gate the
    verdict). Returns a report fragment."""
    path = os.path.join(tmpdir, "globals.sql")
    s3.download_file(cfg.backup_bucket, globals_key, path)
    proc = subprocess.run(
        ["psql", target_uri, "-X", "-q", "-v", "ON_ERROR_STOP=0", "-f", path],
        capture_output=True, text=True,
    )
    tolerated, unexpected = _classify_globals_errors(proc.stderr)
    return {"key": globals_key, "tolerated": len(tolerated), "unexpected": unexpected}


def restore_dump(cfg, dump_path, target_uri):
    """pg_restore the dump into the EMPTY scratch target. STRICT: into an empty
    database with only contrib extensions (uuid-ossp, pgcrypto — grounded
    against prod pg_extension), there are NO expected errors; any pg_restore
    error is a finding, not noise. (The old --clean/--if-exists benign-error
    tolerance existed only because the target was a populated prod clone.)"""
    proc = subprocess.run(
        ["pg_restore", "--no-owner", "--no-privileges", "-d", target_uri, dump_path],
        capture_output=True, text=True,
    )
    if proc.returncode != 0 or "pg_restore: error:" in (proc.stderr or ""):
        raise VerifyError(
            f"pg_restore failed (rc={proc.returncode}): {proc.stderr.strip()[:2000]}"
        )


# --- coherence check ---------------------------------------------------------

def assess(cfg, restored_uri, full_scope):
    """Compare the restored scratch database against live prod. Returns
    (ok: bool, report: dict). ok=False means a HARD incoherence (alert).
    Expected inventory is grounded from prod at runtime (read-only)."""
    report = {"hard_failures": [], "warnings": [], "full_scope": full_scope}

    prod_tables = table_set(cfg.neon_backup_url)
    restored_tables = table_set(restored_uri)
    if not restored_tables:
        report["hard_failures"].append("restored target has NO public tables")
        return False, report

    missing = prod_tables - restored_tables
    extra = restored_tables - prod_tables
    # Table-set drift: a table in prod but absent from the restore is serious
    # (stale/partial dump). A restore-only table means it was dropped in prod
    # after the dump — warning.
    if missing:
        report["hard_failures"].append(
            f"tables in prod but MISSING from restore: {sorted(missing)} "
            f"(stale/partial dump, or a table was added to prod after the backup)"
        )
    if extra:
        report["warnings"].append(
            f"tables in restore but not prod: {sorted(extra)} "
            f"(prod migration may post-date the backup)"
        )

    # Core tables must all be present + non-empty (an empty restore is a failure).
    core_missing = [t for t in SANITY_TABLES if t not in restored_tables]
    if core_missing:
        report["hard_failures"].append(f"core tables absent from restore: {core_missing}")

    prod_counts = row_counts(cfg.neon_backup_url, SANITY_TABLES)
    rest_counts = row_counts(restored_uri, [t for t in SANITY_TABLES if t in restored_tables])
    report["prod_counts"] = prod_counts
    report["restored_counts"] = rest_counts

    total_restored = sum(v for v in rest_counts.values() if isinstance(v, int))
    if total_restored == 0:
        report["hard_failures"].append("restore is EMPTY across all core tables")

    # Per-table drift vs prod (freshness check, kept from the original design).
    for t in SANITY_TABLES:
        p = prod_counts.get(t)
        r = rest_counts.get(t)
        if not isinstance(p, int) or not isinstance(r, int):
            continue
        if p >= cfg.drift_min_rows:
            if r == 0:
                report["hard_failures"].append(f"{t}: restored 0 rows but prod has {p}")
            elif r / p < cfg.row_drift_floor:
                report["hard_failures"].append(
                    f"{t}: restored {r} << prod {p} (ratio {r/p:.2f} < {cfg.row_drift_floor})"
                )

    # --- structural inventory (Gate 0.2 — the checks the tautology hid) ------
    if full_scope:
        restored_schemas = schema_set(restored_uri)
        missing_schemas = set(STRUCT_SCHEMAS) - restored_schemas
        if missing_schemas:
            report["hard_failures"].append(
                f"schemas missing from restore: {sorted(missing_schemas)}"
            )
        for schema in ("extensions", "gv"):
            prod_fns = func_set(cfg.neon_backup_url, schema)
            rest_fns = func_set(restored_uri, schema) if schema in restored_schemas else set()
            fn_missing = prod_fns - rest_fns
            fn_extra = rest_fns - prod_fns
            report[f"{schema}_fn_counts"] = {"prod": len(prod_fns), "restored": len(rest_fns)}
            if fn_missing:
                report["hard_failures"].append(
                    f"{schema}.* functions in prod but MISSING from restore: {sorted(fn_missing)}"
                )
            if fn_extra:
                report["warnings"].append(
                    f"{schema}.* functions in restore but not prod: {sorted(fn_extra)}"
                )
        prod_trg = trigger_set(cfg.neon_backup_url)
        rest_trg = trigger_set(restored_uri)
        trg_missing = prod_trg - rest_trg
        trg_extra = rest_trg - prod_trg
        report["trigger_counts"] = {"prod": len(prod_trg), "restored": len(rest_trg)}
        if trg_missing:
            report["hard_failures"].append(
                f"public triggers in prod but MISSING from restore: {sorted(trg_missing)}"
            )
        if trg_extra:
            report["warnings"].append(
                f"public triggers in restore but not prod: {sorted(trg_extra)}"
            )
    else:
        msg = (
            "LEGACY public-only dump (no gv/extensions in TOC) — full-scope "
            "structural assertions SKIPPED. Expected only until the full-scope "
            "dumper ships; then set REQUIRE_FULL_SCOPE=1."
        )
        if cfg.require_full_scope:
            report["hard_failures"].append(
                "dump is public-only but REQUIRE_FULL_SCOPE=1 — the dumper is "
                "not producing full-database dumps"
            )
        else:
            report["warnings"].append(msg)

    ok = not report["hard_failures"]
    return ok, report


# --- orchestration -----------------------------------------------------------

def run(cfg, s3=None):
    s3 = s3 or boto3.client("s3")
    dump_key, modified, size = latest_dump_key(s3, cfg)
    sys.stdout.write(
        f"[restore-verify] latest dump s3://{cfg.backup_bucket}/{dump_key} "
        f"({size} bytes, {modified})\n"
    )
    ensure_empty_target(cfg.scratch_url)
    with tempfile.TemporaryDirectory() as td:
        path = os.path.join(td, "verify.dump")
        s3.download_file(cfg.backup_bucket, dump_key, path)
        if not os.path.exists(path) or os.path.getsize(path) == 0:
            raise VerifyError(f"downloaded dump {dump_key} is empty")
        full_scope, toc_schemas = probe_dump_scope(path)
        sys.stdout.write(
            f"[restore-verify] dump scope: {'FULL' if full_scope else 'LEGACY public-only'} "
            f"(TOC schemas: {sorted(toc_schemas) or ['<none listed>']})\n"
        )
        globals_key = find_globals_key(s3, cfg, dump_key)
        globals_report = None
        if globals_key:
            globals_report = restore_globals(s3, cfg, globals_key, cfg.scratch_url, td)
            sys.stdout.write(
                f"[restore-verify] globals {globals_key}: "
                f"{globals_report['tolerated']} tolerated Neon-role error(s), "
                f"{len(globals_report['unexpected'])} unexpected\n"
            )
        else:
            sys.stdout.write("[restore-verify] no globals file for this dump (ok — restore is --no-owner)\n")
        restore_dump(cfg, path, cfg.scratch_url)
    ok, report = assess(cfg, cfg.scratch_url, full_scope)
    if globals_report and globals_report["unexpected"]:
        report["warnings"].append(
            f"globals restore: {len(globals_report['unexpected'])} unexpected error(s); "
            f"first: {globals_report['unexpected'][0][:200]}"
        )
    for w in report.get("warnings", []):
        sys.stdout.write(f"[restore-verify] WARN: {w}\n")
    if not ok:
        for f in report["hard_failures"]:
            sys.stderr.write(f"[restore-verify] FAIL: {f}\n")
        raise VerifyError(
            f"restore of {dump_key} is INCOHERENT ({len(report['hard_failures'])} failure(s))"
        )
    sys.stdout.write(
        f"[restore-verify] OK {dump_key} restored coherent into empty target "
        f"(scope={'full' if full_scope else 'legacy-public'}; "
        f"core rows {report.get('restored_counts')})\n"
    )
    return report


def main(argv=None):
    try:
        cfg = Config()
        run(cfg)
    except VerifyError as e:
        sys.stderr.write(f"[restore-verify] ALERT: {e}\n")
        return 1
    except Exception as e:  # noqa: BLE001 — any unexpected error must alert
        sys.stderr.write(f"[restore-verify] ALERT (unexpected): {type(e).__name__}: {e}\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
