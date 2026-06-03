#!/usr/bin/env python3
"""
restore-verify.py — garden-app scheduled "restore is tested" primitive (spec §3 B3).

An untested backup is not a backup. This restores the LATEST durable daily dump
into a FRESH, isolated, root-parented Neon scratch branch, asserts the restore is
coherent (schema table-set + core row-counts vs live prod), then deletes the
scratch branch. A mismatch or restore failure exits non-zero -> the scheduled
GitHub Actions run goes red -> Dave is notified (the alert).

It NEVER touches prod, dev, main, or the staging branch: it only reads the dump
(S3) + prod schema (read-only), and creates/deletes its own scratch branch. The
scratch branch is created off the project DEFAULT branch and has NO children, so
(unlike the revert restore-with-preserve branches) it deletes cleanly.

------------------------------------------------------------------------------
ENV CONTRACT (read at runtime; no secrets hardcoded):
  NEON_API_KEY        Neon API key.
  NEON_PROJECT_ID     Neon project id.
  NEON_BACKUP_URL     DIRECT (non-pooler) prod Postgres URL — read-only baseline
                      for the schema/row-count comparison.
  BACKUP_BUCKET       durable daily-dump bucket (default garden-backups-prod).
  DUMP_PREFIX         key prefix for daily dumps (default "db/garden-").
  SCRATCH_PREFIX      scratch branch name prefix (default "restore-verify-").
  ROW_DRIFT_FLOOR     min restored/prod ratio tolerated for a populated table
                      (default 0.5) — catches truncated/partial restores while
                      tolerating ~1 day of normal drift.
  DRIFT_MIN_ROWS      only ratio-check tables whose prod count >= this (default 20).

Dependencies: boto3 (S3), requests (Neon REST), pg_restore/psql (pg17) via
subprocess.

Exit codes: 0 = restore verified coherent; 1 = restore failed or incoherent
(schema/row mismatch) -> ALERT.
------------------------------------------------------------------------------
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

import boto3
import requests
from botocore.exceptions import ClientError

NEON_API = "https://console.neon.tech/api/v2"
HTTP_TIMEOUT = 60

# Core tables that must exist + be populated for a restore to count as coherent.
SANITY_TABLES = [
    "projects",
    "plants",
    "events",
    "locations",
    "inventory_items",
    "plant_varieties",
]


class VerifyError(Exception):
    """Restore failed or is incoherent — non-zero exit (alert)."""


class Config:
    def __init__(self, env=None):
        env = os.environ if env is None else env
        self.neon_api_key = self._req(env, "NEON_API_KEY")
        self.neon_project_id = self._req(env, "NEON_PROJECT_ID")
        self.neon_backup_url = self._req(env, "NEON_BACKUP_URL")
        self.backup_bucket = env.get("BACKUP_BUCKET", "garden-backups-prod")
        self.dump_prefix = env.get("DUMP_PREFIX", "db/garden-")
        self.scratch_prefix = env.get("SCRATCH_PREFIX", "restore-verify-")
        self.row_drift_floor = float(env.get("ROW_DRIFT_FLOOR", "0.5"))
        self.drift_min_rows = int(env.get("DRIFT_MIN_ROWS", "20"))

    @staticmethod
    def _req(env, key):
        val = env.get(key)
        if not val:
            raise VerifyError(f"required env var {key} is missing or empty")
        return val


def utc_stamp():
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")


def neon_headers(cfg):
    return {
        "Authorization": f"Bearer {cfg.neon_api_key}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }


# --- S3: latest durable dump -------------------------------------------------

def latest_dump_key(s3, cfg):
    """Return the newest db/garden-*.dump key in the backup bucket (by LastModified)."""
    paginator = s3.get_paginator("list_objects_v2")
    newest = None
    for page in paginator.paginate(Bucket=cfg.backup_bucket, Prefix=cfg.dump_prefix):
        for obj in page.get("Contents", []):
            if not obj["Key"].endswith(".dump"):
                continue
            if newest is None or obj["LastModified"] > newest["LastModified"]:
                newest = obj
    if newest is None:
        raise VerifyError(
            f"no durable dump found under s3://{cfg.backup_bucket}/{cfg.dump_prefix}*"
        )
    if newest.get("Size", 0) <= 0:
        raise VerifyError(f"latest dump {newest['Key']} is empty (0 bytes)")
    return newest["Key"], newest["LastModified"], newest["Size"]


# --- Neon scratch branch -----------------------------------------------------

def neon_create_scratch(cfg):
    """Create a fresh root-parented scratch branch WITH a read-write endpoint.
    Returns (branch_id, direct_connection_uri). Default-parented so it has no
    lineage entanglement and deletes cleanly afterward.
    """
    name = f"{cfg.scratch_prefix}{utc_stamp()}"
    payload = {"branch": {"name": name}, "endpoints": [{"type": "read_write"}]}
    r = requests.post(
        f"{NEON_API}/projects/{cfg.neon_project_id}/branches",
        headers=neon_headers(cfg), json=payload, timeout=HTTP_TIMEOUT,
    )
    if r.status_code not in (200, 201):
        raise VerifyError(f"Neon create scratch branch failed {r.status_code}: {r.text}")
    body = r.json()
    bid = body.get("branch", {}).get("id")
    if not bid:
        raise VerifyError(f"Neon create scratch returned no id: {r.text}")
    uri = None
    for u in body.get("connection_uris", []) or []:
        uri = u.get("connection_uri")
        if uri:
            break
    if not uri:
        uri = _branch_direct_uri(cfg, bid)
    return bid, uri, name


def _branch_direct_uri(cfg, branch_id):
    r = requests.get(
        f"{NEON_API}/projects/{cfg.neon_project_id}/connection_uri"
        f"?branch_id={branch_id}&database_name=neondb&role_name=neondb_owner&pooled=false",
        headers=neon_headers(cfg), timeout=HTTP_TIMEOUT,
    )
    if r.status_code != 200:
        raise VerifyError(f"Neon connection_uri failed {r.status_code}: {r.text}")
    uri = r.json().get("uri")
    if not uri:
        raise VerifyError("Neon connection_uri returned no uri")
    return uri


def neon_delete_branch(cfg, branch_id):
    """Best-effort scratch cleanup. Returns True on success (never raises)."""
    try:
        r = requests.delete(
            f"{NEON_API}/projects/{cfg.neon_project_id}/branches/{branch_id}",
            headers=neon_headers(cfg), timeout=HTTP_TIMEOUT,
        )
        return r.status_code in (200, 201, 202)
    except Exception:  # noqa: BLE001 — cleanup must not mask the real result
        return False


# --- restore + introspect ----------------------------------------------------

def restore_dump(s3, cfg, dump_key, target_uri):
    """Download the dump and pg_restore it into the scratch branch."""
    with tempfile.TemporaryDirectory() as td:
        path = os.path.join(td, "verify.dump")
        s3.download_file(cfg.backup_bucket, dump_key, path)
        if not os.path.exists(path) or os.path.getsize(path) == 0:
            raise VerifyError(f"downloaded dump {dump_key} is empty")
        proc = subprocess.run(
            [
                "pg_restore", "--clean", "--if-exists", "--no-owner",
                "--no-privileges", "--schema=public", "-d", target_uri, path,
            ],
            capture_output=True, text=True,
        )
        if proc.returncode != 0 and "pg_restore: error:" in (proc.stderr or ""):
            raise VerifyError(f"pg_restore failed: {proc.stderr.strip()[:800]}")


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


def row_counts(url, tables):
    counts = {}
    for t in tables:
        try:
            counts[t] = int(_psql_scalar(url, f"SELECT count(*) FROM {t};"))
        except VerifyError:
            counts[t] = None
    return counts


# --- coherence check ---------------------------------------------------------

def assess(cfg, restored_uri):
    """Compare the restored scratch branch against live prod. Returns
    (ok: bool, report: dict). ok=False means a HARD incoherence (alert).
    """
    report = {"hard_failures": [], "warnings": []}

    prod_tables = table_set(cfg.neon_backup_url)
    restored_tables = table_set(restored_uri)
    if not restored_tables:
        report["hard_failures"].append("restored branch has NO public tables")
        return False, report

    missing = prod_tables - restored_tables
    extra = restored_tables - prod_tables
    # Table-set drift: a dropped table in the restore is serious (likely a stale
    # or partial dump). Added tables in PROD (not yet in a ~1-day-old dump) are a
    # WARNING (a migration may post-date the backup), not a hard failure.
    if missing:
        report["hard_failures"].append(
            f"tables in prod but MISSING from restore: {sorted(missing)} "
            f"(stale/partial dump, or a table was dropped after the backup)"
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

    # Per-table drift: a populated prod table that comes back far short signals a
    # truncated/partial restore. Tolerate normal ~1-day drift via ROW_DRIFT_FLOOR.
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
    branch_id, uri, name = neon_create_scratch(cfg)
    try:
        restore_dump(s3, cfg, dump_key, uri)
        ok, report = assess(cfg, uri)
    finally:
        deleted = neon_delete_branch(cfg, branch_id)
        sys.stdout.write(
            f"[restore-verify] scratch branch {name} ({branch_id}) "
            f"{'deleted' if deleted else 'DELETE FAILED — clean up manually'}\n"
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
        f"[restore-verify] OK {dump_key} restored coherent "
        f"(tables match prod; core rows {report.get('restored_counts')})\n"
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
