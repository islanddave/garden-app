#!/usr/bin/env python3
"""
revert-to.py — garden-app "version-revert" primitive (spec §3 B2).

Reverts prod to a previously-snapped version vX as a SINGLE Dave-approved,
`environment: production`-gated transaction, restoring code + DB + Lambda
versions as a COHERENT pair. Consumes the manifest written by snap.py (B1).

Runs as the gated step(s) of a `revert-gate.yml` workflow (the `revert` job,
inside `environment: production`), AS garden-bot (the sole actor permitted to
advance `main`). It is itself revertible: a pre-revert snap of CURRENT prod is
taken FIRST, so a bad revert can be rolled back.

------------------------------------------------------------------------------
SPEC B2 STEP MAP (repo-version-env-spec-V100-20260602.md §3 B2):
  1. load manifest (Object-Lock bucket) + cross-check live tag SHA ==
     manifest.main_sha; FAIL CLOSED on mismatch (forged/moved tag guard).
  2. PRE-REVERT snap of CURRENT prod (revert is revertible) + surface RPO to
     Dave ("discards all DB writes since vX — N rows / since TIMESTAMP").
  3. DB: restore the durable dump (authoritative) into a FRESH Neon branch;
     VALIDATE (schema + row-count sanity); then Neon "Restore branch" to reset
     the PROD branch to that validated state (preserves the prod endpoint, so
     no Lambda env change needed). FAST-PATH: reset prod from snap-vX directly
     IFF it still exists and its LSN/lineage matches the manifest, else dump.
     NEVER pg_restore in-place against live prod.
  4. CODE: create a FORWARD revert-commit on `dev` whose tree == tag vX's tree,
     then FF-promote it to `main`. Then REBUILD vX from that tree (OPS-REVERTRESTORE-001):
     dispatch deploy-lambda.yml on main and wait for every Lambda leg, THEN dispatch
     deploy.yml (the SPA) and wait — the promote's own order. Nothing else redeploys
     on a main move. manifest.lambda_versions is NOT restored forward: a promote snaps
     BEFORE its own Lambda deploy, so vX's manifest holds v(X-1)'s Lambda code
     (measured on v4.128.0, 2026-09-11). Snapshot versions are restored only by
     rollback(), from the PRE-REVERT snap, which records what prod is running.
  5. ORDERING + ABORT: stage + validate the DB target FIRST, then cut over
     code+DB TOGETHER; if either leg fails, roll back to the pre-revert snap
     (DB, code, every release Lambda, SPA rebuild — see rollback()).

ENV CONTRACT (read at runtime; no secrets hardcoded):
  GH_TOKEN            garden-bot GitHub App installation token (tag read, dev
                      commit, main FF — all restricted to garden-bot — plus
                      workflow dispatch, run read and run cancel for the
                      redeploy legs; promote-gate dispatches with the same token).
  GITHUB_REPOSITORY   "owner/repo".
  TARGET_VERSION      the vX to revert TO. ^v\\d+(\\.\\d+){0,2}$.
  PREREVERT_VERSION   a fresh, unused vX to snapshot CURRENT prod as before the
                      revert (so the revert is itself revertible). Same regex.
  NEON_API_KEY        Neon API key.
  NEON_PROJECT_ID     Neon project id.
  NEON_PROD_BRANCH_ID prod Neon branch id (default br-delicate-sea-amum92c2).
  NEON_BACKUP_URL     DIRECT (non-pooler) prod Postgres URL (pre-revert snap
                      dump + RPO probe).
  SNAP_BUCKET         durable archive bucket (default garden-snapshots-prod —
                      matches the live vars.SNAP_BUCKET; the old
                      garden-backups-prod default pointed at the DAILY bucket,
                      where snap manifests/dumps do not live).
  PHOTOS_BUCKET       versioned photos bucket (pre-revert snap needs it).
  SNAP_RETENTION      pre-revert snap retention K (default 5).
  REVERT_BRANCH_TTL_DAYS  Neon expires_at TTL (days, default 7) stamped on every
                      branch this script creates (revert-stage-*) or causes to
                      be created (prerestore-* via preserve_under_name). Without
                      it every real revert leaves two PERMANENT billable
                      branches nothing deletes (the abandoned-branch rent).
                      Expiry-stamping is best-effort: a Neon API that rejects
                      expires_at degrades to a loud WARN, never a failed revert;
                      integrity-weekly's out-of-band branch check is the backstop.
  CF_DIST             CloudFront distribution id (default E3FAJTXAORQYDT). Passed through
                      to the pre-revert snap's manifest only: this script makes NO
                      CloudFront call. The SPA leg's deploy.yml invalidates under the
                      deploy role, and the snap role is deliberately not granted
                      cloudfront:CreateInvalidation.
  CONFIRM_DATA_LOSS   must equal the literal string "yes" to perform the prod
                      DB reset (defense-in-depth on top of the env approval —
                      reverting prod DB is real data loss for live users).

REHEARSAL CONTRACT (staging dry-run; honored ONLY together):
  REHEARSAL_MODE      "1" enables the safe dry-run. Code legs are redirected to
                      throwaway revert-rehearsal-* refs, the Lambda/SPA redeploy
                      legs and the Lambda restore are skipped (a dispatch also
                      refuses any ref but main), and rehearsal_guard() fails
                      closed unless the redirects + a non-prod Neon target are
                      set. With it unset, DEV_BRANCH/MAIN_BRANCH overrides are REFUSED.
  DEV_BRANCH          rehearsal code-leg branch (must start 'revert-rehearsal-',
                      != dev/main). Default 'dev' (prod).
  MAIN_BRANCH         rehearsal promote-leg branch (same rules; != DEV_BRANCH).
                      Default 'main' (prod).
  FORCE_DUMP_PATH     "1" (rehearsal only) forces the dump+fresh-branch+validate
                      DB path even if a matching snap-vX branch exists (U2/U3).
  FORCE_ABORT         "1" (rehearsal only) raises after the DB checkpoint to
                      exercise the abort->rollback path.

Dependencies: boto3 (S3/Lambda), requests (Neon + GitHub REST, including Actions),
pg_restore/psql (pg17 client) via subprocess, snap.py (co-located in scripts/)
for the pre-revert snap, and lambda_fleet.py (co-located) for the release set.

UNKNOWNS to resolve in the staging rehearsal (flagged, not guessed):
  U1. Lambda restore mechanism. snap records PUBLISHED version numbers per fn.
      Function URLs here map to $LATEST (no alias observed). This script
      restores by `update_function_code` copying the recorded version's
      deployment package back to $LATEST via the published-version ARN
      (lambda does not expose pull-by-version code download directly, so we
      re-point a 'live' alias). CONFIRM the real URL->version binding in
      rehearsal and adjust restore_lambda_versions accordingly.
  U2. Neon "Restore branch" API shape: POST .../branches/{id}/restore with
      {source_branch_id, source_lsn?}. CONFIRM field names against the live
      Neon API version in rehearsal (mocked here).
  U3. Fresh-branch endpoint provisioning: branch create with endpoint to get a
      direct connection URI for pg_restore. CONFIRM connection_uris shape.
------------------------------------------------------------------------------
"""
from __future__ import annotations

import inspect
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone

import boto3
import requests
from botocore.exceptions import ClientError

# Co-located in scripts/: THE Lambda release set (stdlib only).
import lambda_fleet

# snap.py is co-located in scripts/ — reused for the pre-revert snapshot.
try:
    import snap as snap_mod
except Exception:  # pragma: no cover - import shape differs only outside scripts/
    snap_mod = None

VERSION_RE = re.compile(r"^v\d+(\.\d+){0,2}$")
NEON_API = "https://console.neon.tech/api/v2"
GITHUB_API = "https://api.github.com"
HTTP_TIMEOUT = 60

# Real prod identifiers the rehearsal guard must REFUSE to mutate.
PROD_NEON_BRANCH = "br-delicate-sea-amum92c2"
PROD_CF_DIST = "E3FAJTXAORQYDT"
REHEARSAL_BRANCH_PREFIX = "revert-rehearsal-"

# Key tables for the row-count sanity validate + RPO probe (read-only).
SANITY_TABLES = [
    "plant_projects",
    "plants",
    "event_log",
    "locations",
    "inventory_items",
    "plant_varieties",
]

# The Lambda release set is lambda_fleet.release_functions(): the list snap.py publishes,
# preflight-revert-iam.py checks and deploy-lambda.yml's matrix builds. The hand-kept list of 11
# that used to sit here was never read by anything — the restore iterates the manifest.

# OPS-REVERTRESTORE-001 — the redeploy legs (workflow_dispatch on main, polled to success).
LAMBDA_DEPLOY_WORKFLOW = "deploy-lambda.yml"
SPA_DEPLOY_WORKFLOW = "deploy.yml"
RUN_LOCATE_ATTEMPTS = 30        # x RUN_LOCATE_INTERVAL_S for the dispatched run to appear
RUN_LOCATE_INTERVAL_S = 10
RUN_CLOCK_SKEW_S = 60           # runner-vs-GitHub clock allowance when matching created_at
RUN_POLL_INTERVAL_S = 15
RUN_POLL_CEILING_S = 20 * 60    # queue + run, per leg; v4.128.0 measured ~70 s Lambda, 83 s SPA
CANCEL_WAIT_S = 120
LAMBDA_UPDATE_POLL_S = 3
LAMBDA_UPDATE_TIMEOUT_S = 90
# Worst case, forward + rollback: 2 x (5 min locate + 20 min poll) + 2 x 2 min cancel waits +
# 26 x 90 s restores + one more SPA leg (25 min) ~= 118 min, plus the pre-revert snap and the DB
# legs. revert-gate.yml's timeout-minutes is sized from this: a job killed mid-rollback is a
# durable split-brain, which is worse than any failure this script can report.


class RevertError(Exception):
    """Unrecoverable revert failure — non-zero exit, abort/rollback handled in run()."""


class RevertAbort(Exception):
    """Raised after a prod-mutating checkpoint to trigger rollback to the pre-revert snap."""


# --- config ------------------------------------------------------------------

class Config:
    def __init__(self, env=None):
        env = os.environ if env is None else env
        self.gh_token = self._req(env, "GH_TOKEN")
        self.repo = self._req(env, "GITHUB_REPOSITORY")
        self.target_version = self._req(env, "TARGET_VERSION")
        self.prerevert_version = self._req(env, "PREREVERT_VERSION")
        self.neon_api_key = self._req(env, "NEON_API_KEY")
        self.neon_project_id = self._req(env, "NEON_PROJECT_ID")
        self.neon_prod_branch_id = env.get("NEON_PROD_BRANCH_ID", "br-delicate-sea-amum92c2")
        self.neon_backup_url = self._req(env, "NEON_BACKUP_URL")
        self.snap_bucket = env.get("SNAP_BUCKET", "garden-snapshots-prod")
        self.photos_bucket = env.get("PHOTOS_BUCKET", "")
        self.retention = int(env.get("SNAP_RETENTION", "5"))
        self.branch_ttl_days = int(env.get("REVERT_BRANCH_TTL_DAYS", "7"))
        self.cf_dist = env.get("CF_DIST", "E3FAJTXAORQYDT")
        self.confirm_data_loss = env.get("CONFIRM_DATA_LOSS", "")
        # --- rehearsal redirect (REHEARSAL_MODE=1 only) ---------------------
        # Outside rehearsal the code legs MUST target the real dev/main refs.
        # In rehearsal they are redirected to throwaway revert-rehearsal-* refs
        # and the prod-mutating Lambda/CF legs are skipped, so a rehearsal can
        # NEVER touch dev, main, the prod Neon branch, or the prod CDN.
        self.rehearsal = env.get("REHEARSAL_MODE", "") == "1"
        self.dev_branch = env.get("DEV_BRANCH", "dev")
        self.main_branch = env.get("MAIN_BRANCH", "main")
        # rehearsal-only fault injection (honored ONLY when rehearsal is True):
        self.force_abort = env.get("FORCE_ABORT", "") == "1"
        self.force_dump_path = env.get("FORCE_DUMP_PATH", "") == "1"
        self._raw_env = env

    @staticmethod
    def _req(env, key):
        val = env.get(key)
        if not val:
            raise RevertError(f"required env var {key} is missing or empty")
        return val


# --- helpers -----------------------------------------------------------------

def utc_now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _expires_at(days):
    """RFC3339 expiry `days` from now for Neon branch.expires_at."""
    return (datetime.now(timezone.utc) + timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")


def gh_headers(cfg):
    return {
        "Authorization": f"Bearer {cfg.gh_token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


def neon_headers(cfg):
    return {
        "Authorization": f"Bearer {cfg.neon_api_key}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }


def validate_version(version, label):
    if not isinstance(version, str) or not VERSION_RE.match(version):
        raise RevertError(
            f"invalid {label} {version!r}; must match ^v\\d+(\\.\\d+){{0,2}}$"
        )
    return version


def rehearsal_guard(cfg):
    """Fail-closed safety gate run before ANY mutation.

    The single invariant that makes the rehearsal safe: it is structurally
    impossible to mutate the real dev/main refs, the prod Neon branch, or the
    prod CDN when REHEARSAL_MODE=1, AND impossible to redirect the code legs
    away from dev/main when REHEARSAL_MODE is off.

    OFF: dev_branch/main_branch MUST be exactly 'dev'/'main' (no silent
         redirect of a real revert).
    ON:  dev_branch/main_branch MUST be non-empty revert-rehearsal-* refs that
         are NOT 'dev'/'main'; the Neon target MUST NOT be the prod branch.
    """
    if not cfg.rehearsal:
        if cfg.dev_branch != "dev" or cfg.main_branch != "main":
            raise RevertError(
                "DEV_BRANCH/MAIN_BRANCH override requires REHEARSAL_MODE=1 "
                f"(got dev_branch={cfg.dev_branch!r}, main_branch={cfg.main_branch!r})"
            )
        return
    bad = []
    for label, ref in (("DEV_BRANCH", cfg.dev_branch), ("MAIN_BRANCH", cfg.main_branch)):
        if ref in ("", "dev", "main"):
            bad.append(f"{label}={ref!r} is empty or a protected ref")
        elif not ref.startswith(REHEARSAL_BRANCH_PREFIX):
            bad.append(f"{label}={ref!r} must start {REHEARSAL_BRANCH_PREFIX!r}")
    if cfg.dev_branch == cfg.main_branch and cfg.dev_branch not in ("", "dev", "main"):
        bad.append("DEV_BRANCH and MAIN_BRANCH must differ")
    if cfg.neon_prod_branch_id == PROD_NEON_BRANCH:
        bad.append(f"NEON_PROD_BRANCH_ID is the real prod branch {PROD_NEON_BRANCH}")
    if bad:
        raise RevertError("REHEARSAL_MODE safety guard tripped: " + "; ".join(bad))


# --- step 1: manifest load + tag cross-check ---------------------------------

def load_manifest(s3, cfg):
    """Read snapshots/<vX>.json from the durable bucket. Missing = fail closed."""
    key = f"snapshots/{cfg.target_version}.json"
    try:
        obj = s3.get_object(Bucket=cfg.snap_bucket, Key=key)
    except ClientError as e:
        raise RevertError(
            f"manifest s3://{cfg.snap_bucket}/{key} not readable: "
            f"{e.response.get('Error', {}).get('Code', '?')}"
        )
    manifest = json.loads(obj["Body"].read())
    required = [
        "git_tag", "main_sha", "neon_branch", "dump_s3_key",
        "lambda_versions", "cf_dist",
    ]
    missing = [k for k in required if k not in manifest]
    if missing:
        raise RevertError(f"manifest {key} missing fields: {missing}")
    if manifest["git_tag"] != cfg.target_version:
        raise RevertError(
            f"manifest git_tag {manifest['git_tag']} != target {cfg.target_version}"
        )
    return manifest


def _get_ref_sha(cfg, ref):
    r = requests.get(
        f"{GITHUB_API}/repos/{cfg.repo}/git/ref/{ref}",
        headers=gh_headers(cfg), timeout=HTTP_TIMEOUT,
    )
    if r.status_code != 200:
        raise RevertError(f"ref lookup {ref} failed {r.status_code}: {r.text}")
    return r.json().get("object", {}).get("sha")


def _resolve_ref_commit(cfg, obj_sha):
    r = requests.get(
        f"{GITHUB_API}/repos/{cfg.repo}/git/tags/{obj_sha}",
        headers=gh_headers(cfg), timeout=HTTP_TIMEOUT,
    )
    if r.status_code == 200:
        return r.json().get("object", {}).get("sha")
    return obj_sha


def verify_tag(cfg, manifest):
    """Cross-check: the LIVE tag vX must resolve to manifest.main_sha. Fail closed.

    Guards a forged/moved tag — the tag is the anchor for the code tree we will
    restore, so a tag that no longer matches the snapped commit is unsafe.
    """
    tag = cfg.target_version
    sha = _get_ref_sha(cfg, f"tags/{tag}")
    commit = _resolve_ref_commit(cfg, sha)
    if commit != manifest["main_sha"]:
        raise RevertError(
            f"tag {tag} resolves to {commit} != manifest.main_sha "
            f"{manifest['main_sha']}; refusing to revert (forged/moved tag)"
        )
    return commit


# --- step 2: pre-revert snap + RPO -------------------------------------------

def prerevert_snap(cfg):
    """Snapshot CURRENT prod as PREREVERT_VERSION before mutating anything.

    Reuses snap.py end-to-end. Requires the current main SHA (the FF target the
    snap tags). Returns the snap result dict.
    """
    if snap_mod is None:
        raise RevertError("snap module not importable; cannot take the pre-revert snap")
    current_main = _get_ref_sha(cfg, f"heads/{cfg.main_branch}")
    snap_env = dict(cfg._raw_env)
    snap_env["SNAP_VERSION"] = cfg.prerevert_version
    snap_env["MAIN_SHA"] = current_main
    snap_env["APP_VERSION"] = f"prerevert-of-{cfg.target_version}"
    snap_cfg = snap_mod.Config(env=snap_env)
    # prune=False is LOAD-BEARING: snap's own retention prune runs BEFORE this
    # revert reaches fast_path_branch, and with the snap fleet at/over K it can
    # DELETE snap-<TARGET_VERSION> — the very branch the revert is about to
    # restore from. The revert's snap must archive only, never prune.
    if "prune" in inspect.signature(snap_mod.run).parameters:
        return snap_mod.run(snap_cfg, prune=False)
    sys.stderr.write(
        "[revert] WARN: snap.run() has no prune parameter — retention prune may "
        "delete the revert target branch before the DB stage (transition hazard; "
        "update snap.py)\n"
    )
    return snap_mod.run(snap_cfg)


def _psql_scalar(url, sql):
    """Run a single read-only scalar query via psql. Returns the stripped value."""
    proc = subprocess.run(
        ["psql", url, "-tA", "-c", sql],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise RevertError(f"psql failed: {proc.stderr.strip()}")
    return proc.stdout.strip()


def _psql_query(url, sql):
    """Multi-ROW read-only query via psql. Returns a list of non-empty stripped lines.

    Sibling of _psql_scalar for the OPS-REVERTVALIDATE-001 count comparison, which needs
    every table in one round trip rather than one psql process per table (the restored
    database carries ~59 of them).
    """
    proc = subprocess.run(
        ["psql", url, "-tA", "-c", sql],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise RevertError(f"psql failed: {proc.stderr.strip()}")
    return [ln.strip() for ln in proc.stdout.split("\n") if ln.strip()]


def compute_rpo(cfg):
    """Surface the data-loss window to Dave: total live rows + latest event ts
    that the revert will DISCARD. Read-only against prod.
    """
    counts = {}
    for t in SANITY_TABLES:
        try:
            counts[t] = int(_psql_scalar(cfg.neon_backup_url, f"SELECT count(*) FROM {t};"))
        except RevertError:
            counts[t] = None
    try:
        latest = _psql_scalar(
            cfg.neon_backup_url,
            "SELECT COALESCE(max(created_at)::text, 'none') FROM event_log;",
        )
    except RevertError:
        latest = "unknown"
    total = sum(v for v in counts.values() if isinstance(v, int))
    return {"counts": counts, "total_live_rows": total, "latest_event": latest}


# --- step 3: DB restore ------------------------------------------------------

def _neon_list_branches(cfg):
    r = requests.get(
        f"{NEON_API}/projects/{cfg.neon_project_id}/branches",
        headers=neon_headers(cfg), timeout=HTTP_TIMEOUT,
    )
    if r.status_code != 200:
        raise RevertError(f"Neon list branches failed {r.status_code}: {r.text}")
    return r.json().get("branches", [])


def fast_path_branch(cfg, manifest):
    """Return snap-vX branch dict IFF it still exists AND its pinned LSN matches
    the manifest (lineage intact); else None -> fall through to the dump.
    """
    name = manifest.get("neon_branch") or f"snap-{cfg.target_version}"
    want_lsn = manifest.get("neon_lsn")
    for b in _neon_list_branches(cfg):
        if b.get("name") == name:
            have = b.get("current_state_lsn") or b.get("parent_lsn")
            if want_lsn and have and have != want_lsn:
                return None  # lineage drift — do not trust the fast path
            return b
    return None


def neon_create_branch_with_endpoint(cfg, name, ttl_days=None):
    """Create a fresh restore-target branch WITH a read-write endpoint; return
    (branch_id, direct_connection_uri). Idempotent: reuse if name exists.
    ttl_days stamps expires_at AT CREATION (abandoned-branch-rent fix); if the
    API rejects the field, retry WITHOUT it and warn loudly — a hygiene
    attribute must never fail the revert itself.
    """
    for b in _neon_list_branches(cfg):
        if b.get("name") == name:
            bid = b["id"]
            uri = _branch_direct_uri(cfg, bid)
            return bid, uri
    branch = {"name": name}
    if ttl_days:
        branch["expires_at"] = _expires_at(ttl_days)
    payload = {
        "branch": branch,
        "endpoints": [{"type": "read_write"}],
    }
    r = requests.post(
        f"{NEON_API}/projects/{cfg.neon_project_id}/branches",
        headers=neon_headers(cfg), json=payload, timeout=HTTP_TIMEOUT,
    )
    if ttl_days and r.status_code in (400, 422) and "expires_at" in (r.text or ""):
        sys.stderr.write(
            f"[revert] WARN: Neon rejected expires_at on branch create "
            f"({r.status_code}); retrying WITHOUT expiry — branch {name} will be "
            f"permanent until integrity-weekly flags it\n"
        )
        payload["branch"].pop("expires_at", None)
        r = requests.post(
            f"{NEON_API}/projects/{cfg.neon_project_id}/branches",
            headers=neon_headers(cfg), json=payload, timeout=HTTP_TIMEOUT,
        )
    if r.status_code not in (200, 201):
        raise RevertError(f"Neon create restore branch failed {r.status_code}: {r.text}")
    body = r.json()
    bid = body.get("branch", {}).get("id")
    if not bid:
        raise RevertError(f"Neon create branch returned no id: {r.text}")
    uri = None
    for u in body.get("connection_uris", []) or []:
        uri = u.get("connection_uri")
        if uri:
            break
    if not uri:
        uri = _branch_direct_uri(cfg, bid)
    return bid, uri


def _branch_direct_uri(cfg, branch_id):
    r = requests.get(
        f"{NEON_API}/projects/{cfg.neon_project_id}/connection_uri"
        f"?branch_id={branch_id}&database_name=neondb&role_name=neondb_owner&pooled=false",
        headers=neon_headers(cfg), timeout=HTTP_TIMEOUT,
    )
    if r.status_code != 200:
        raise RevertError(f"Neon connection_uri failed {r.status_code}: {r.text}")
    uri = r.json().get("uri")
    if not uri:
        raise RevertError("Neon connection_uri returned no uri")
    return uri


def restore_dump_into_branch(s3, cfg, manifest, target_uri):
    """Download the durable dump and pg_restore it into the fresh branch
    (NOT prod). --clean --if-exists so the fresh branch is overwritten cleanly.
    """
    key = manifest["dump_s3_key"]
    with tempfile.TemporaryDirectory() as td:
        dump_path = os.path.join(td, "snap.dump")
        s3.download_file(cfg.snap_bucket, key, dump_path)
        if not os.path.exists(dump_path) or os.path.getsize(dump_path) == 0:
            raise RevertError(f"downloaded dump {key} is empty")
        proc = subprocess.run(
            [
                # FULL-DATABASE scope (no --schema): snap.py has written full-DB
                # dumps since Gate 0.1, and prod has THREE schemas — public,
                # extensions (relocated uuid-ossp; 14 columns DEFAULT
                # extensions.uuid_generate_v4()), and gv (11 functions backing 11
                # triggers on 6 core tables). Restoring --schema=public left gv and
                # extensions at the fresh branch's inherited prod state, so a revert
                # silently did NOT roll those back — and validate_branch() only
                # counted public tables, so it certified the result as good.
                "pg_restore", "--clean", "--if-exists", "--no-owner",
                "--no-privileges",
                "-d", target_uri, dump_path,
            ],
            capture_output=True, text=True,
        )
        # pg_restore can emit benign warnings on --clean (DROP of absent objects);
        # only a non-zero exit with no relation-restored signal is fatal.
        if proc.returncode != 0 and "errors ignored on restore" not in (proc.stderr or ""):
            # Tolerate the standard "WARNING: errors ignored" tail; fail otherwise.
            if "pg_restore: error:" in (proc.stderr or ""):
                raise RevertError(f"pg_restore failed: {proc.stderr.strip()[:800]}")
        # OPS-REVERTVALIDATE-001: read the EXPECTED per-table row counts out of the archive
        # while the file is still on disk. Source is the dump, NOT the manifest — the manifest
        # (snapshots/vX.json) carries git_tag / main_sha / LSN / S3 keys / lambda versions and
        # NO counts at all, so the manifest cannot answer "did the data actually land". The
        # archive can, it needs no schema change, and it works retroactively on every dump
        # already in S3 rather than only on ones taken after some new field ships.
        expected = _expected_row_counts(dump_path)
    return key, expected


def _expected_row_counts(dump_path):
    """Per-table row counts as the ARCHIVE holds them: render it and count COPY data lines.

    Returns {"schema.table": n} or None if the archive could not be rendered (callers treat
    None as "unknown", never as "zero" — an unreadable archive must not silently look empty).
    """
    proc = subprocess.run(
        ["pg_restore", "-f", "-", dump_path], capture_output=True, text=True,
    )
    if proc.returncode != 0 or not proc.stdout:
        return None
    counts, table, n = {}, None, 0
    for line in proc.stdout.split("\n"):
        if table is None:
            if line.startswith("COPY ") and line.rstrip().endswith("FROM stdin;"):
                table = line.split()[1]
                n = 0
            continue
        if line == "\\.":
            counts[table] = n
            table = None
            continue
        n += 1
    return counts


def validate_branch(cfg, target_uri, expected_counts=None):
    """Schema + row-count sanity on the restored fresh branch before we let it
    overwrite prod. At least one core table must exist and the sanity tables
    must be queryable (count >= 0).

    expected_counts ({"schema.table": n}, from the ARCHIVE) upgrades this from
    "the branch looks plausible" to "the branch matches the snapshot we restored".
    Absolute readings cannot tell a real restore from a no-op, because the target
    branch is created off the DEFAULT branch (prod) and therefore ALREADY contains a
    full database before pg_restore runs — see OPS-REVERTVALIDATE-001. None means
    the archive was unreadable: that is UNKNOWN, and it is reported, never treated
    as agreement.
    """
    existing = _psql_scalar(
        target_uri,
        "SELECT count(*) FROM information_schema.tables "
        "WHERE table_schema='public';",
    )
    if int(existing) <= 0:
        raise RevertError("validate: restored branch has no public tables")
    # Non-public schemas are NOT decoration: gv holds the trigger functions and
    # extensions holds the uuid generators 14 column DEFAULTs call. A validation
    # scoped to public alone passes on a database that cannot take an INSERT,
    # which is exactly what the old --schema=public restore produced.
    nonpublic = {}
    for schema in ("gv", "extensions"):
        try:
            nonpublic[schema] = int(_psql_scalar(
                target_uri,
                "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace "
                f"WHERE n.nspname='{schema}';",
            ))
        except RevertError:
            nonpublic[schema] = None
        if not nonpublic[schema]:
            raise RevertError(
                f"validate: restored branch has no functions in schema '{schema}' "
                "— refusing to overwrite prod"
            )
    # HONEST LIMIT of the check above (do not read it as a scope verifier). The restore
    # target is created by neon_create_branch_with_endpoint with NO parent_id, so Neon
    # parents it off the DEFAULT branch (prod) and it INHERITS prod's gv + extensions
    # before pg_restore runs. A public-only restore therefore leaves those schemas
    # PRESENT-but-not-rolled-back, and a >0 presence test passes on exactly that state.
    # So this catches an empty/failed restore, NOT the --schema=public bug that motivated
    # it — the actual fix for that is dropping --schema=public in restore_dump_into_branch,
    # which scripts/test_revert_to.py pins directly. The scope check proper is the
    # expected_counts comparison below (OPS-REVERTVALIDATE-001).
    #
    # OPS-REVERTVALIDATE-001 — the check that can tell a real restore from a no-op.
    # Everything above reads ABSOLUTE state, and absolute state cannot distinguish "the dump
    # landed" from "nothing happened", because this branch was created off prod and already
    # held a full database before pg_restore ran. Comparing against the archive's own COPY
    # row counts is the difference between plausible and correct.
    # NOTE the source: the archive, not snapshots/vX.json. That manifest holds git_tag,
    # main_sha, LSN, S3 keys and lambda versions — NO counts — so it cannot answer this, and
    # adding counts to it would only help snapshots taken after the change. The archive works
    # on every dump already in the bucket.
    mismatches = []
    if expected_counts:
        q = ("SELECT n.nspname||'.'||c.relname||'='||"
             "(xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I',"
             "n.nspname,c.relname),false,true,'')))[1]::text "
             "FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
             "WHERE c.relkind='r' AND n.nspname NOT IN ('pg_catalog','information_schema');")
        actual = {}
        try:
            for row in (_psql_query(target_uri, q) or []):
                if "=" in row:
                    k, v = row.rsplit("=", 1)
                    actual[k.strip()] = int(v)
        except (RevertError, ValueError):
            actual = None
        if actual is None:
            raise RevertError(
                "validate: could not read row counts from the restored branch — refusing to "
                "overwrite prod on an unverified restore"
            )
        for tbl, want in expected_counts.items():
            got = actual.get(tbl)
            if got is None:
                mismatches.append(f"{tbl}: archive has {want} rows, restored branch has NO SUCH TABLE")
            elif got != want:
                mismatches.append(f"{tbl}: archive {want} vs restored {got}")
        if mismatches:
            raise RevertError(
                "validate: restored branch does NOT match the snapshot archive — refusing to "
                f"overwrite prod. {len(mismatches)} mismatch(es): {'; '.join(mismatches[:8])}"
            )
    counts = {}
    for t in SANITY_TABLES:
        try:
            counts[t] = int(_psql_scalar(target_uri, f"SELECT count(*) FROM {t};"))
        except RevertError:
            counts[t] = None
    if all(v is None for v in counts.values()):
        raise RevertError("validate: none of the core tables are present/queryable")
    return {
        "public_tables": int(existing),
        "counts": counts,
        "nonpublic_functions": nonpublic,
        # "verified" only when the archive was readable AND every table matched. UNKNOWN is
        # reported as UNKNOWN — an unreadable archive must never read as agreement.
        "archive_match": ("verified" if expected_counts else "unknown-archive-unreadable"),
        "archive_tables_compared": len(expected_counts or {}),
    }


def _expire_branch_by_name(cfg, name, ttl_days):
    """Best-effort: stamp expires_at on the branch named `name` (used for the
    prerestore-* branch Neon creates server-side via preserve_under_name, which
    the create-time expires_at cannot reach). NEVER raises — a failed hygiene
    PATCH must not fail (or roll back) a succeeded restore; integrity-weekly's
    out-of-band branch check is the backstop for a missed expiry.
    """
    try:
        for b in _neon_list_branches(cfg):
            if b.get("name") == name:
                r = requests.patch(
                    f"{NEON_API}/projects/{cfg.neon_project_id}/branches/{b['id']}",
                    headers=neon_headers(cfg),
                    json={"branch": {"expires_at": _expires_at(ttl_days)}},
                    timeout=HTTP_TIMEOUT,
                )
                if r.status_code == 200:
                    return True
                sys.stderr.write(
                    f"[revert] WARN: expires_at PATCH on {name} failed "
                    f"{r.status_code}: {r.text[:200]} — branch stays permanent "
                    f"until integrity-weekly flags it\n"
                )
                return False
        sys.stderr.write(
            f"[revert] WARN: preserve branch {name} not found for expiry stamping\n"
        )
    except Exception as e:  # noqa: BLE001 — hygiene must never break the revert
        sys.stderr.write(f"[revert] WARN: expiry stamping for {name} errored: {e}\n")
    return False


def neon_restore_prod_from(cfg, source_branch_id, source_lsn=None):
    """Neon 'Restore branch': reset the PROD branch to the state of
    source_branch_id (optionally at source_lsn). Preserves the prod endpoint /
    connection string -> no Lambda env change needed. This is the only
    prod-DB-mutating call.
    """
    # Neon REQUIRES preserve_under_name when the target branch has CHILDREN, else
    # 422 "Branch has children, preserve_under_name is required". The prod branch
    # ALWAYS has children (every snap-vX is a copy-on-write child of it), so this
    # is set unconditionally with a unique name; the pre-restore state is retained
    # as a backup branch rather than orphaning child lineage. (U2 RESOLVED in the
    # 2026-06-03 staging rehearsal — the live API rejected the no-preserve body.)
    preserve_name = (
        f"prerestore-{cfg.target_version}-"
        f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')}-{os.urandom(2).hex()}"
    )
    body = {
        "source_branch_id": source_branch_id,
        "preserve_under_name": preserve_name,
    }
    if source_lsn:
        body["source_lsn"] = source_lsn
    r = requests.post(
        f"{NEON_API}/projects/{cfg.neon_project_id}/branches/{cfg.neon_prod_branch_id}/restore",
        headers=neon_headers(cfg), json=body, timeout=HTTP_TIMEOUT,
    )
    if r.status_code not in (200, 201):
        raise RevertError(f"Neon restore prod failed {r.status_code}: {r.text}")
    # The preserve branch was just created server-side — stamp its TTL now
    # ("at creation" for a branch we cannot create ourselves). Best-effort.
    _expire_branch_by_name(cfg, preserve_name, cfg.branch_ttl_days)
    return r.json()


# --- step 4: code revert-commit + FF main + lambda ---------------------------

def create_revert_commit_on_dev(cfg, manifest):
    """Create a FORWARD commit on dev whose tree == tag vX's tree (restoring the
    old code without a backward/force rewind). Returns the new dev commit SHA.
    """
    target_commit = manifest["main_sha"]
    rc = requests.get(
        f"{GITHUB_API}/repos/{cfg.repo}/git/commits/{target_commit}",
        headers=gh_headers(cfg), timeout=HTTP_TIMEOUT,
    )
    if rc.status_code != 200:
        raise RevertError(f"get target commit failed {rc.status_code}: {rc.text}")
    target_tree = rc.json()["tree"]["sha"]
    dev_head = _get_ref_sha(cfg, f"heads/{cfg.dev_branch}")
    rn = requests.post(
        f"{GITHUB_API}/repos/{cfg.repo}/git/commits",
        headers=gh_headers(cfg),
        json={
            "message": f"revert: restore tree of {cfg.target_version} ({target_commit[:12]}) [revert-to]",
            "tree": target_tree,
            "parents": [dev_head],
        },
        timeout=HTTP_TIMEOUT,
    )
    if rn.status_code not in (200, 201):
        raise RevertError(f"create revert commit failed {rn.status_code}: {rn.text}")
    new_sha = rn.json()["sha"]
    ru = requests.patch(
        f"{GITHUB_API}/repos/{cfg.repo}/git/refs/heads/{cfg.dev_branch}",
        headers=gh_headers(cfg),
        json={"sha": new_sha, "force": False},
        timeout=HTTP_TIMEOUT,
    )
    if ru.status_code != 200:
        raise RevertError(f"update {cfg.dev_branch} ref failed {ru.status_code}: {ru.text}")
    return new_sha


def ff_main(cfg, sha):
    """Fast-forward the promote ref (main, or the rehearsal main ref) to sha
    (the revert-commit). garden-bot only in prod. Returns sha."""
    r = requests.patch(
        f"{GITHUB_API}/repos/{cfg.repo}/git/refs/heads/{cfg.main_branch}",
        headers=gh_headers(cfg),
        json={"sha": sha, "force": False},
        timeout=HTTP_TIMEOUT,
    )
    if r.status_code != 200:
        raise RevertError(f"FF {cfg.main_branch} -> {sha[:12]} failed {r.status_code}: {r.text}")
    return sha


def _sleep(seconds):
    time.sleep(seconds)


def _now():
    return time.time()


def _wait_lambda_updated(client, fn):
    """Poll until fn's code update settles; return its LastUpdateStatus.

    update_function_code returning 200 means the update was ACCEPTED. The swap is asynchronous
    and can still end 'Failed', so a restore that stops at the API call can report a function
    as rolled back while it never moved. Returns 'Successful', 'Failed', or 'InProgress' if the
    ceiling passed.
    """
    waited = 0
    while True:
        status = client.get_function_configuration(FunctionName=fn).get("LastUpdateStatus")
        if status != "InProgress" or waited >= LAMBDA_UPDATE_TIMEOUT_S:
            return status
        _sleep(LAMBDA_UPDATE_POLL_S)
        waited += LAMBDA_UPDATE_POLL_S


def restore_lambda_versions(cfg, manifest, lambda_client=None):
    """Restore each function's $LATEST code to the snapped published version. ROLLBACK ONLY.

    U1 (RESOLVED 2026-06-03): the garden-* Function URLs are UNQUALIFIED — they
    invoke $LATEST directly; there is NO 'live' alias and no URL qualifier
    (verified via get_function_url_config: Qualifier=none, $LATEST). So a revert
    cannot simply re-point an alias. Instead, for each fn it pulls the snapped
    version's IMMUTABLE deployment package (GetFunction at the version qualifier
    returns a presigned Code.Location) and pushes that same zip back onto
    $LATEST via update_function_code(Publish=True). The URL (→ $LATEST) then
    serves the old code. Re-running re-pushes identical code (harmless).

    WHICH SNAPSHOT (OPS-REVERTRESTORE-001). Only rollback() calls this, with the PRE-REVERT snap
    run() took minutes earlier: its versions are exactly the code prod was serving. Never point
    it at a revert TARGET's manifest. A promote snaps BEFORE its own Lambda deploy, so manifest
    vX holds v(X-1)'s code (measured 2026-09-11 on v4.128.0); the forward revert rebuilds the
    target from its own tree instead (redeploy_lambdas).

    PER-FUNCTION PROGRESS (L1 Gap E). Every function is attempted even after one fails — a
    compensation should put back all it can — and each update is waited on until Lambda says it
    settled. The raise names exactly which functions moved and which did not.

    IAM: lambda:GetFunction on the QUALIFIED ARN function:<fn>:<ver> (an unqualified grant does
    not cover a Qualifier read — proven with a federation-token probe 2026-09-11),
    lambda:UpdateFunctionCode and lambda:GetFunctionConfiguration on the function.
    preflight-revert-iam.py asserts all three for every release function before a revert starts.
    """
    if cfg.rehearsal:
        # Never mutate prod Lambda code during a rehearsal.
        return {}
    client = lambda_client or boto3.client("lambda")
    versions = manifest.get("lambda_versions", {})
    restored, failed = {}, {}
    for fn in sorted(versions):
        ver = versions[fn]
        try:
            meta = client.get_function(FunctionName=fn, Qualifier=str(ver))
            loc = meta.get("Code", {}).get("Location")
            if not loc:
                raise RevertError(f"no Code.Location for {fn}@{ver}")
            pkg = requests.get(loc, timeout=HTTP_TIMEOUT)
            if pkg.status_code != 200 or not pkg.content:
                raise RevertError(f"download {fn}@{ver} package failed {pkg.status_code}")
            client.update_function_code(FunctionName=fn, ZipFile=pkg.content, Publish=True)
            status = _wait_lambda_updated(client, fn)
            if status != "Successful":
                raise RevertError(f"code update for {fn} ended {status!r}, not 'Successful'")
            restored[fn] = ver
        except Exception as e:  # noqa: BLE001 — a compensation keeps going, then names the gaps
            failed[fn] = f"{ver}: {e}"
    if failed:
        raise RevertError(
            f"lambda restore incomplete: {len(restored)}/{len(versions)} restored "
            f"[{', '.join(sorted(restored)) or 'none'}]; NOT restored: "
            + "; ".join(f"{fn}@{why}" for fn, why in sorted(failed.items())))
    return restored


# --- step 4b: rebuild the target from its own tree (OPS-REVERTRESTORE-001) ----
# After ff_main, main's tree IS the target's tree, so dispatching the deploy workflows on main
# rebuilds the target with the target's OWN recipe (a dispatch loads the workflow file from the
# dispatched ref; all 262 release tags v2.5.4..v4.128.0 carry workflow_dispatch in both files).
# Nothing else redeploys on a main move: zero workflows trigger on push to main (L1 Gap A).
# Order is the promote's (promote-gate.yml deploy-lambdas -> deploy): Lambdas first, SPA only
# once every Lambda leg succeeded, because a new SPA on old Lambdas can silently drop fields.
# Both workflows run under the DEPLOY role, so the snap role needs no site-bucket or CloudFront
# grant; the old cf_invalidate() here only flushed /index.html of an unchanged bundle.

def _gh(cfg, path):
    return f"{GITHUB_API}/repos/{cfg.repo}{path}"


def _gh_time(ts):
    return datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()


def require_dispatchable(cfg):
    """Pre-checkpoint: both redeploy workflows must be readable and ACTIVE. A disabled or
    unreadable one would otherwise surface only AFTER the prod DB reset."""
    if cfg.rehearsal:
        return
    for wf in (LAMBDA_DEPLOY_WORKFLOW, SPA_DEPLOY_WORKFLOW):
        r = requests.get(_gh(cfg, f"/actions/workflows/{wf}"), headers=gh_headers(cfg),
                         timeout=HTTP_TIMEOUT)
        if r.status_code != 200:
            raise RevertError(f"cannot read workflow {wf} ({r.status_code}: {r.text[:300]}); "
                              "refusing to start a revert whose redeploy legs cannot be dispatched")
        state = r.json().get("state")
        if state != "active":
            raise RevertError(f"workflow {wf} is {state!r}, not 'active'; refusing to start a revert "
                              "that would reset prod's DB and then be unable to redeploy the code")


def dispatch_workflow(cfg, workflow, inputs=None):
    """workflow_dispatch `workflow` on main; return the epoch taken just before the call.

    Refuses in rehearsal and on any ref but main, structurally: these workflows deploy PROD, and
    the production environment admits only dev, main and promote-v*."""
    if cfg.rehearsal or cfg.main_branch != "main":
        raise RevertError(f"refusing to dispatch {workflow} (rehearsal={cfg.rehearsal}, "
                          f"main_branch={cfg.main_branch!r}): it deploys prod")
    since = _now()
    body = {"ref": "main"}
    if inputs:
        body["inputs"] = inputs
    r = requests.post(_gh(cfg, f"/actions/workflows/{workflow}/dispatches"),
                      headers=gh_headers(cfg), json=body, timeout=HTTP_TIMEOUT)
    if r.status_code != 204:
        raise RevertError(f"dispatch {workflow} on main failed {r.status_code}: {r.text[:400]}")
    return since


def _list_runs(cfg, workflow):
    r = requests.get(
        _gh(cfg, f"/actions/workflows/{workflow}/runs?event=workflow_dispatch&branch=main&per_page=30"),
        headers=gh_headers(cfg), timeout=HTTP_TIMEOUT)
    return r.json().get("workflow_runs", []) if r.status_code == 200 else None


def locate_run(cfg, workflow, sha, since):
    """The run our dispatch created: created at/after `since`, head_sha == sha.

    A dispatch names a BRANCH, so head_sha is the only proof the run builds the revert commit.
    A fresh run for any other commit means main moved underneath us; it is never accepted."""
    others = set()
    for _ in range(RUN_LOCATE_ATTEMPTS):
        runs = _list_runs(cfg, workflow)
        if runs is not None:
            fresh = [x for x in runs if _gh_time(x["created_at"]) >= since - RUN_CLOCK_SKEW_S]
            mine = [x for x in fresh if x.get("head_sha") == sha]
            if mine:
                return max(mine, key=lambda x: x["created_at"])
            others.update(x.get("head_sha") for x in fresh)
        _sleep(RUN_LOCATE_INTERVAL_S)
    raise RevertError(
        f"no {workflow} run for {sha} appeared after the dispatch"
        + (f"; fresh runs for OTHER commits did ({sorted(others)}), so main moved" if others else ""))


def _get_run(cfg, run_id):
    r = requests.get(_gh(cfg, f"/actions/runs/{run_id}"), headers=gh_headers(cfg),
                     timeout=HTTP_TIMEOUT)
    return r.json() if r.status_code == 200 else None


def _get_jobs(cfg, run_id):
    r = requests.get(_gh(cfg, f"/actions/runs/{run_id}/jobs?filter=latest&per_page=100"),
                     headers=gh_headers(cfg), timeout=HTTP_TIMEOUT)
    return r.json().get("jobs", []) if r.status_code == 200 else None


def _is_lambda_leg(job):
    name = job.get("name", "")
    return name == "deploy" or name.startswith("deploy (")


def wait_for_lambda_legs(cfg, run_id):
    """Every `deploy (<fn>)` leg must complete with success. Mirrors promote-gate's deploy_result:
    the matrix decides; verify-daily-plan (a post-deploy invariant on one function) does not.
    Zero legs is a failure — an environment-policy rejection looks exactly like that."""
    waited = 0
    while waited <= RUN_POLL_CEILING_S:
        jobs = _get_jobs(cfg, run_id)
        if jobs is not None:
            legs = [j for j in jobs if _is_lambda_leg(j)]
            if legs and all(j.get("status") == "completed" for j in legs):
                moved = sorted(j["name"] for j in legs if j.get("conclusion") == "success")
                bad = {j["name"]: j.get("conclusion") for j in legs if j.get("conclusion") != "success"}
                if bad:
                    raise RevertError(
                        f"Lambda redeploy run {run_id}: {len(bad)} of {len(legs)} legs failed {bad}; "
                        f"these DID move to the target code: {moved}")
                return legs
            if not legs:
                run = _get_run(cfg, run_id)
                if run and run.get("status") == "completed":
                    raise RevertError(f"Lambda redeploy run {run_id} completed with NO deploy legs "
                                      f"(conclusion {run.get('conclusion')!r}): nothing was deployed")
        _sleep(RUN_POLL_INTERVAL_S)
        waited += RUN_POLL_INTERVAL_S
    raise RevertError(f"Lambda redeploy run {run_id} unfinished after {RUN_POLL_CEILING_S // 60} min")


def wait_for_spa_run(cfg, run_id):
    """The deploy.yml run must complete with success AND contain a successful `deploy` job — a
    green run with no deploy job would be a vacuous pass."""
    waited = 0
    while waited <= RUN_POLL_CEILING_S:
        run = _get_run(cfg, run_id)
        if run and run.get("status") == "completed":
            if run.get("conclusion") != "success":
                raise RevertError(f"SPA redeploy run {run_id} concluded {run.get('conclusion')!r}")
            job = next((j for j in (_get_jobs(cfg, run_id) or []) if j.get("name") == "deploy"), None)
            if not job or job.get("conclusion") != "success":
                raise RevertError(f"SPA redeploy run {run_id} is green but has no successful 'deploy' job")
            return run
        _sleep(RUN_POLL_INTERVAL_S)
        waited += RUN_POLL_INTERVAL_S
    raise RevertError(f"SPA redeploy run {run_id} unfinished after {RUN_POLL_CEILING_S // 60} min")


def redeploy_lambdas(cfg, sha, progress):
    """Forward Lambda leg: rebuild every release function from `sha`'s tree via deploy-lambda.yml,
    the same path a Lambda-changing promote takes. Returns the run id."""
    if cfg.rehearsal:
        sys.stdout.write("[revert] REHEARSAL: Lambda redeploy skipped\n")
        return None
    progress["lambda_attempted"] = True
    since = dispatch_workflow(cfg, LAMBDA_DEPLOY_WORKFLOW)
    run = locate_run(cfg, LAMBDA_DEPLOY_WORKFLOW, sha, since)
    progress["lambda_run"] = run["id"]
    wait_for_lambda_legs(cfg, run["id"])
    return run["id"]


def redeploy_spa(cfg, sha, progress):
    """SPA leg: build, sync and invalidate `sha`'s tree via deploy.yml. skip_version_bump because a
    revert is not a release (the input exists in every release tag's deploy.yml). Returns run id."""
    if cfg.rehearsal:
        sys.stdout.write("[revert] REHEARSAL: SPA redeploy skipped\n")
        return None
    progress["spa_attempted"] = True
    since = dispatch_workflow(cfg, SPA_DEPLOY_WORKFLOW, inputs={"skip_version_bump": "true"})
    run = locate_run(cfg, SPA_DEPLOY_WORKFLOW, sha, since)
    progress["spa_run"] = run["id"]
    wait_for_spa_run(cfg, run["id"])
    return run["id"]


def cancel_stray_runs(cfg, sha):
    """Cancel every unfinished redeploy run for `sha` and wait for it to stop, so a forward deploy
    still queued or running cannot land AFTER rollback() put prod back. Returns the runs it could
    not confirm stopped; rollback() escalates them."""
    problems = []
    for wf in (LAMBDA_DEPLOY_WORKFLOW, SPA_DEPLOY_WORKFLOW):
        runs = _list_runs(cfg, wf)
        if runs is None:
            problems.append(f"could not list {wf} runs to stop strays for {sha}")
            continue
        for x in runs:
            if x.get("head_sha") != sha or x.get("status") == "completed":
                continue
            c = requests.post(_gh(cfg, f"/actions/runs/{x['id']}/cancel"), headers=gh_headers(cfg),
                              timeout=HTTP_TIMEOUT)
            if c.status_code not in (202, 409):
                problems.append(f"cancel {wf} run {x['id']} failed {c.status_code}: {c.text[:200]}")
                continue
            waited = 0
            while True:
                run = _get_run(cfg, x["id"])
                if run and run.get("status") == "completed":
                    break
                if waited >= CANCEL_WAIT_S:
                    problems.append(f"{wf} run {x['id']} for {sha} still running {CANCEL_WAIT_S}s after cancel")
                    break
                _sleep(RUN_POLL_INTERVAL_S)
                waited += RUN_POLL_INTERVAL_S
    return problems


# --- rollback ----------------------------------------------------------------

def rollback(cfg, prerevert_result, lambda_client=None, progress=None):
    """Best-effort rollback to the pre-revert snap after a post-checkpoint failure.

    1. Stop any forward redeploy still queued/running for the revert commit, so it cannot land
       on top of the rollback.
    2. DB: restore prod from the pre-revert snap branch. If THIS fails, raise at once: moving
       the code back to N on a DB still at vX would make things worse, not better.
    3. Code: forward restore-commit on dev with the pre-revert main tree, FF main (no force).
    4. Lambdas, only if the forward Lambda leg was attempted: every function back to the
       pre-revert snap's version (captured minutes ago, so it IS what prod was serving).
    5. SPA, only if the forward SPA leg was attempted: rebuild the restored tree via deploy.yml.
       Skipped when main could not be moved back (a dispatch would rebuild the revert tree).
    Steps 3-5 keep going past a failure; whatever did not complete is raised at the end, and
    the caller turns that into PAGE DAVE.
    """
    progress = progress or {}
    man = prerevert_result["manifest"]
    problems = []
    if progress.get("revert_sha") and (progress.get("lambda_attempted") or progress.get("spa_attempted")):
        problems += cancel_stray_runs(cfg, progress["revert_sha"])
    neon_restore_prod_from(cfg, man["neon_branch_id"], man.get("neon_lsn"))
    # main may now be ahead (our failed revert commit); a forward restore-commit
    # mirrors the no-force-push rule. Reuse the same forward-tree mechanism.
    try:
        restore_sha = create_revert_commit_on_dev(cfg, {"main_sha": man["main_sha"]})
        ff_main(cfg, restore_sha)
    except Exception as e:  # noqa: BLE001 — record it, keep restoring what does not need main
        problems.append(f"code not moved back: {e}")
        restore_sha = None
    if progress.get("lambda_attempted"):
        try:
            restore_lambda_versions(cfg, man, lambda_client=lambda_client)
        except Exception as e:  # noqa: BLE001
            problems.append(str(e))
    if progress.get("spa_attempted"):
        if restore_sha is None:
            problems.append("SPA NOT redeployed: main could not be moved back, so a dispatch "
                            "would rebuild the revert tree")
        else:
            try:
                redeploy_spa(cfg, restore_sha, {})
            except Exception as e:  # noqa: BLE001
                problems.append(f"SPA not redeployed: {e}")
    if problems:
        raise RevertError("rollback incomplete: " + " | ".join(problems))


# --- orchestration -----------------------------------------------------------

def require_complete_rollback_capture(cfg, prerevert_result):
    """Pre-checkpoint: rollback() can only put back the functions the pre-revert snap captured.

    Refuse to touch prod unless that snap captured every release function that EXISTS. A function
    it could not see because it does not exist yet (ResourceNotFoundException) has nothing to roll
    back. Anything else uncaptured — typically AccessDenied because snap-ops was not extended —
    would stay on the target code if the revert then had to roll back. A pre-revert manifest with
    no lambda_uncaptured field (an older snap.py) is judged against the release set directly.
    Prod only: a rehearsal never touches prod Lambdas.
    """
    if cfg.rehearsal:
        return
    try:
        release = lambda_fleet.release_functions()
    except lambda_fleet.FleetError as e:
        raise RevertError(str(e))
    man = (prerevert_result or {}).get("manifest") or {}
    captured = set(man.get("lambda_versions") or {})
    uncaptured = man.get("lambda_uncaptured")
    if uncaptured is None:
        uncaptured = {fn: "absent from the pre-revert snapshot (snap.py predates lambda_uncaptured)"
                      for fn in release if fn not in captured}
    blocking = {fn: why for fn, why in uncaptured.items()
                if not str(why).startswith("ResourceNotFoundException")}
    missing = [fn for fn in release if fn not in captured and fn not in uncaptured]
    if blocking or missing:
        raise RevertError(
            f"pre-revert snapshot {cfg.prerevert_version} cannot roll back every release function "
            f"(uncaptured: {blocking}; never attempted: {missing}); refusing to reset prod. Extend "
            f"snap-ops (Projects/Gardening/iam-trust-rollback), then re-run with a fresh PREREVERT_VERSION")


def run(cfg, s3=None, lambda_client=None):
    s3 = s3 or boto3.client("s3")

    validate_version(cfg.target_version, "TARGET_VERSION")
    validate_version(cfg.prerevert_version, "PREREVERT_VERSION")
    if cfg.prerevert_version == cfg.target_version:
        raise RevertError("PREREVERT_VERSION must differ from TARGET_VERSION")

    # Fail-closed BEFORE any mutation: rehearsal can't touch dev/main/prod-db.
    rehearsal_guard(cfg)
    if cfg.rehearsal:
        sys.stdout.write(
            f"[revert] REHEARSAL_MODE: code legs -> {cfg.dev_branch}/{cfg.main_branch}, "
            f"db target -> {cfg.neon_prod_branch_id}, Lambda/SPA redeploy + Lambda restore skipped"
            + (", FORCE_DUMP_PATH" if cfg.force_dump_path else "")
            + (", FORCE_ABORT" if cfg.force_abort else "")
            + "\n"
        )

    # Step 1 — manifest + tag cross-check (fail closed) BEFORE any mutation.
    manifest = load_manifest(s3, cfg)
    verify_tag(cfg, manifest)

    # Step 2 — RPO surface + explicit data-loss confirmation, THEN pre-revert snap.
    rpo = compute_rpo(cfg)
    sys.stdout.write(
        f"[revert] RPO: reverting to {cfg.target_version} discards writes since "
        f"snap — current live rows={rpo['total_live_rows']}, latest event="
        f"{rpo['latest_event']}\n"
    )
    if cfg.confirm_data_loss != "yes":
        raise RevertError(
            "CONFIRM_DATA_LOSS != 'yes' — refusing prod DB reset (data loss guard). "
            f"RPO: {rpo['total_live_rows']} live rows, latest event {rpo['latest_event']}"
        )
    prerevert = prerevert_snap(cfg)

    # OPS-REVERTRESTORE-001 — two more refusals while NOTHING in prod has changed yet: rollback()
    # must be able to put every release function back, and both redeploy workflows must be
    # dispatchable. Either failing after the checkpoint would mean a DB reset with no way forward.
    require_complete_rollback_capture(cfg, prerevert)
    require_dispatchable(cfg)

    # ---- everything below is a prod-mutating checkpoint; failures -> rollback ----
    checkpointed = False
    progress = {}
    lambda_run = spa_run = None
    try:
        # Step 3 — stage + validate DB target FIRST (no prod mutation yet).
        # Rehearsal may force the dump+fresh-branch+validate path to exercise it
        # (and resolve U2/U3) even when a matching snap-vX branch exists.
        fast = None if (cfg.rehearsal and cfg.force_dump_path) else fast_path_branch(cfg, manifest)
        if fast is not None:
            source_branch_id = fast["id"]
            source_lsn = manifest.get("neon_lsn")
        else:
            restore_name = f"revert-stage-{cfg.target_version}"
            source_branch_id, uri = neon_create_branch_with_endpoint(
                cfg, restore_name, ttl_days=cfg.branch_ttl_days
            )
            _key, expected_counts = restore_dump_into_branch(s3, cfg, manifest, uri)
            validate_branch(cfg, uri, expected_counts=expected_counts)
            source_lsn = None

        # Cut over: prod DB reset (first prod mutation) ...
        checkpointed = True
        neon_restore_prod_from(cfg, source_branch_id, source_lsn)

        # Rehearsal-only: inject a post-checkpoint failure to exercise rollback.
        if cfg.rehearsal and cfg.force_abort:
            raise RevertError(
                "FORCE_ABORT (rehearsal): injected post-checkpoint failure to exercise rollback"
            )

        # ... then the code: main to the target tree, then the target's OWN Lambdas, then its SPA
        # (the promote's order). manifest.lambda_versions is deliberately NOT used here: a promote
        # snaps before its own Lambda deploy, so the target's manifest holds the PREVIOUS release's
        # Lambda code (measured 2026-09-11). The target's tree is the authority for its code.
        revert_sha = create_revert_commit_on_dev(cfg, manifest)
        progress["revert_sha"] = revert_sha
        ff_main(cfg, revert_sha)
        lambda_run = redeploy_lambdas(cfg, revert_sha, progress)
        spa_run = redeploy_spa(cfg, revert_sha, progress)
    except Exception as e:  # noqa: BLE001 — any post-checkpoint failure rolls back
        if checkpointed:
            sys.stderr.write(f"[revert] FAIL after checkpoint: {e}; rolling back\n")
            try:
                rollback(cfg, prerevert, lambda_client=lambda_client, progress=progress)
            except Exception as re:  # noqa: BLE001
                raise RevertError(
                    f"revert FAILED ({e}) AND rollback FAILED ({re}) — prod may be "
                    f"inconsistent; pre-revert snap = {cfg.prerevert_version}; PAGE DAVE"
                )
            raise RevertError(f"revert aborted, rolled back to pre-revert snap: {e}")
        raise

    return {
        "reverted_to": cfg.target_version,
        "main_sha": manifest["main_sha"],
        "revert_commit": revert_sha,
        "prerevert_version": cfg.prerevert_version,
        "rpo": rpo,
        "lambda_run": lambda_run,
        "spa_run": spa_run,
    }


def main(argv=None):
    try:
        cfg = Config()
        result = run(cfg)
    except RevertError as e:
        sys.stderr.write(f"[revert] FAIL: {e}\n")
        return 1
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"[revert] FAIL (unexpected): {type(e).__name__}: {e}\n")
        return 1
    sys.stdout.write(
        f"[revert] OK reverted to {result['reverted_to']} "
        f"(main {result['main_sha'][:12]} via revert-commit "
        f"{result['revert_commit'][:12]}; Lambda redeploy run {result.get('lambda_run')}, "
        f"SPA redeploy run {result.get('spa_run')}; pre-revert snap {result['prerevert_version']})\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
