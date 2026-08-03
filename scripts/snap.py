#!/usr/bin/env python3
"""
snap.py — garden-app "version-snap" primitive (spec §3 B1).

Captures a point-in-time, COUPLED code+DB+assets bundle keyed by one version
string (vX), so any shipped prod version is revertible. Designed to run as the
FINAL gated step of `promote-gate.yml` (the `promote` job, inside
`environment: production`), AFTER a successful fast-forward of `main`.

This is the commit-marker of a prod promote: if snap fails, the SHIP fails
(non-zero exit), because a green promote with a silently-absent snapshot is the
exact trap this primitive closes.

------------------------------------------------------------------------------
ENV CONTRACT (read at runtime; no secrets are hardcoded):
  GH_TOKEN            garden-bot GitHub App installation token (tag creation is
                      ruleset-restricted to garden-bot; the job runs as the bot).
  GITHUB_REPOSITORY   "owner/repo" (provided by GitHub Actions).
  MAIN_SHA            the promoted main commit SHA to tag and pin the snap to.
  SNAP_VERSION        the version string vX, e.g. "v1", "v1.2", "v1.2.3".
                      Validated against ^v\\d+(\\.\\d+){0,2}$.
  NEON_API_KEY        Neon API key (Authorization: Bearer).
  NEON_PROJECT_ID     Neon project id.
  NEON_PROD_BRANCH_ID prod Neon branch id (default br-delicate-sea-amum92c2).
  NEON_BACKUP_URL     DIRECT (non-pooler) Postgres connection string for pg_dump.
  SNAP_BUCKET         snapshot S3 bucket (default garden-snapshots-prod — NOT the
                      daily-backup bucket garden-backups-prod).
  SNAP_BRANCH_PREFIX  Neon snap-branch name prefix (default "snap-"). Rehearsals
                      set a distinct prefix so rehearsal branches can never
                      collide with (or be pruned as) production snapshots.
  PHOTOS_BUCKET       REQUIRED, UNKNOWN at author time — the versioned photos
                      bucket whose current version-id list we snapshot.
  SNAP_RETENTION      keep last K Neon snap branches (default 5, clamped >= 1;
                      empty string falls back to default). FLAG: confirm real
                      Neon tier branch cap and set K below it.
  CF_DIST             CloudFront distribution id (default E3FAJTXAORQYDT).
  APP_VERSION         human/app version label recorded in the manifest.

Dependencies: boto3 (S3/Lambda), requests (Neon + GitHub REST), pg_dump +
pg_dumpall (pg17 client) via subprocess.

Idempotency: every artifact is create-if-missing. If it already exists it is
SKIPPED, not errored, so a partial snap completes cleanly on re-run. BUT if a
target artifact for vX already exists pinned to a DIFFERENT main_sha, we ABORT
(guards a vX reuse with new content).
------------------------------------------------------------------------------
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone

import boto3
import requests
from botocore.exceptions import ClientError

# --- constants ---------------------------------------------------------------

VERSION_RE = re.compile(r"^v\d+(\.\d+){0,2}$")
NEON_API = "https://console.neon.tech/api/v2"
GITHUB_API = "https://api.github.com"
HTTP_TIMEOUT = 60

# The 11 Lambda functions whose deployed version is part of the coupled snap.
LAMBDA_FUNCTIONS = [
    "garden-dashboard",
    "garden-events",
    "garden-favorites",
    "garden-inventory-items",
    "garden-locations",
    "garden-photos",
    "garden-plants",
    "garden-projects",
    "garden-varieties",
    "garden-app-events",
    "garden-achievements",
]


class SnapError(Exception):
    """Unrecoverable snap failure — must fail the ship (non-zero exit)."""


# --- config ------------------------------------------------------------------

class Config:
    """Resolved env contract. Missing-required vars raise SnapError early."""

    def __init__(self, env=None):
        env = os.environ if env is None else env
        self.gh_token = self._req(env, "GH_TOKEN")
        self.repo = self._req(env, "GITHUB_REPOSITORY")
        self.main_sha = self._req(env, "MAIN_SHA")
        self.version = self._req(env, "SNAP_VERSION")
        self.neon_api_key = self._req(env, "NEON_API_KEY")
        self.neon_project_id = self._req(env, "NEON_PROJECT_ID")
        self.neon_prod_branch_id = env.get(
            "NEON_PROD_BRANCH_ID", "br-delicate-sea-amum92c2"
        )
        self.neon_backup_url = self._req(env, "NEON_BACKUP_URL")
        # `or` (not a get() default): GHA renders an UNSET repo var as "", which
        # get() would return verbatim — an empty bucket name / int("") ValueError.
        self.snap_bucket = env.get("SNAP_BUCKET") or "garden-snapshots-prod"
        self.branch_prefix = env.get("SNAP_BRANCH_PREFIX") or "snap-"
        # PHOTOS_BUCKET is required and UNKNOWN at author time — fail loud.
        self.photos_bucket = self._req(env, "PHOTOS_BUCKET")
        self.retention = self._int_env(env, "SNAP_RETENTION", 5, minimum=1)
        self.cf_dist = env.get("CF_DIST", "E3FAJTXAORQYDT")
        self.app_version = env.get("APP_VERSION", "")

    @staticmethod
    def _req(env, key):
        val = env.get(key)
        if not val:
            raise SnapError(f"required env var {key} is missing or empty")
        return val

    @staticmethod
    def _int_env(env, key, default, minimum):
        raw = (env.get(key) or str(default)).strip() or str(default)
        try:
            val = int(raw)
        except ValueError:
            raise SnapError(f"{key} must be an integer, got {raw!r}")
        return max(minimum, val)


# --- helpers -----------------------------------------------------------------

def utc_now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


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


def s3_key_for(kind, cfg):
    """Canonical S3 keys keyed by version."""
    v = cfg.version
    return {
        "dump": f"db/snap-{v}.dump",
        "globals": f"db/snap-{v}.globals.sql",
        "photo_versionids": f"photos/snap-{v}.versionids.json",
        "manifest": f"snapshots/{v}.json",
    }[kind]


def gha_warning(msg):
    sys.stdout.write(f"::warning::{msg}\n")


def gha_step_summary(lines):
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not path:
        return
    try:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
    except OSError:
        pass


def s3_object_exists(s3, bucket, key):
    try:
        s3.head_object(Bucket=bucket, Key=key)
        return True
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        if code in ("404", "NoSuchKey", "NotFound"):
            return False
        if code in ("403", "Forbidden", "AccessDenied"):
            # S3 returns 403 (not 404) for HeadObject on a MISSING key when the
            # caller lacks an effective s3:ListBucket. The snap role intentionally
            # has only object-level Get/Put on snap-* keys (no bucket listing), so
            # treat 403 here as "object absent". Fail-closed is preserved: writes
            # (PutObject) raise their own errors, and self_verify re-checks after
            # writing (an existing object HEADs 200 via GetObject), so a genuine
            # permission gap still surfaces downstream rather than being masked.
            return False
        raise


def s3_get_json(s3, bucket, key):
    obj = s3.get_object(Bucket=bucket, Key=key)
    return json.loads(obj["Body"].read())


# --- validate ----------------------------------------------------------------

def validate(version):
    """Validate vX. Reject anything not matching ^v\\d+(\\.\\d+){0,2}$.

    The version is used ONLY as a python value (arg/env), never interpolated
    raw into a shell `run:` string.
    """
    if not isinstance(version, str) or not VERSION_RE.match(version):
        raise SnapError(
            f"invalid SNAP_VERSION {version!r}; must match ^v\\d+(\\.\\d+){{0,2}}$"
        )
    return version


def precheck_existing_manifest(s3, cfg):
    """If a manifest for vX already exists pinned to a DIFFERENT main_sha,
    ABORT — guards a vX reuse with new content. Returns the existing manifest
    dict if one exists for THIS sha (so the run is a clean idempotent re-run),
    else None.
    """
    key = s3_key_for("manifest", cfg)
    if not s3_object_exists(s3, cfg.snap_bucket, key):
        return None
    existing = s3_get_json(s3, cfg.snap_bucket, key)
    prev_sha = existing.get("main_sha")
    if prev_sha and prev_sha != cfg.main_sha:
        raise SnapError(
            f"manifest for {cfg.version} already exists pinned to main_sha "
            f"{prev_sha} != current {cfg.main_sha}; refusing to reuse version "
            f"string with different content"
        )
    return existing


# --- (a) git annotated tag ---------------------------------------------------

def ensure_tag(cfg):
    """Create annotated tag vX on MAIN_SHA via GitHub API. Idempotent:
    if the ref already exists it must point at MAIN_SHA (else abort).
    """
    owner_repo = cfg.repo
    tag = cfg.version
    ref = f"tags/{tag}"
    # Does the ref already exist?
    r = requests.get(
        f"{GITHUB_API}/repos/{owner_repo}/git/ref/{ref}",
        headers=gh_headers(cfg),
        timeout=HTTP_TIMEOUT,
    )
    if r.status_code == 200:
        existing_sha = r.json().get("object", {}).get("sha")
        # Tag object dereferences to the commit; compare against MAIN_SHA via
        # the tag object if it's an annotated tag.
        target = _resolve_ref_commit(cfg, existing_sha)
        if target != cfg.main_sha:
            raise SnapError(
                f"tag {tag} already exists pointing at {target} != "
                f"{cfg.main_sha}; refusing to move tag"
            )
        return tag  # idempotent skip
    if r.status_code != 404:
        raise SnapError(f"GitHub ref lookup failed {r.status_code}: {r.text}")

    # Create the annotated tag object, then the ref.
    rt = requests.post(
        f"{GITHUB_API}/repos/{owner_repo}/git/tags",
        headers=gh_headers(cfg),
        json={
            "tag": tag,
            "message": f"snap {tag}",
            "object": cfg.main_sha,
            "type": "commit",
            "tagger": {
                "name": "garden-bot",
                "email": "garden-bot@users.noreply.github.com",
                "date": utc_now_iso(),
            },
        },
        timeout=HTTP_TIMEOUT,
    )
    if rt.status_code not in (200, 201):
        raise SnapError(f"create tag object failed {rt.status_code}: {rt.text}")
    tag_obj_sha = rt.json()["sha"]

    rr = requests.post(
        f"{GITHUB_API}/repos/{owner_repo}/git/refs",
        headers=gh_headers(cfg),
        json={"ref": f"refs/tags/{tag}", "sha": tag_obj_sha},
        timeout=HTTP_TIMEOUT,
    )
    if rr.status_code == 422:
        # Race: ref created between our GET and POST. Re-verify idempotently.
        target = _resolve_ref_commit(
            cfg, _get_ref_sha(cfg, ref)
        )
        if target != cfg.main_sha:
            raise SnapError(
                f"tag {tag} raced to {target} != {cfg.main_sha}"
            )
        return tag
    if rr.status_code not in (200, 201):
        raise SnapError(f"create tag ref failed {rr.status_code}: {rr.text}")
    return tag


def _get_ref_sha(cfg, ref):
    r = requests.get(
        f"{GITHUB_API}/repos/{cfg.repo}/git/ref/{ref}",
        headers=gh_headers(cfg),
        timeout=HTTP_TIMEOUT,
    )
    if r.status_code != 200:
        raise SnapError(f"ref re-lookup failed {r.status_code}: {r.text}")
    return r.json().get("object", {}).get("sha")


def _resolve_ref_commit(cfg, obj_sha):
    """Given a ref's object sha (which for an annotated tag is the tag object),
    resolve to the underlying commit sha. Lightweight tags point straight at a
    commit; annotated tags need one more hop.
    """
    r = requests.get(
        f"{GITHUB_API}/repos/{cfg.repo}/git/tags/{obj_sha}",
        headers=gh_headers(cfg),
        timeout=HTTP_TIMEOUT,
    )
    if r.status_code == 200:
        return r.json().get("object", {}).get("sha")
    # Not a tag object → assume it's already a commit sha.
    return obj_sha


# --- (b) Neon branch ---------------------------------------------------------

def _neon_list_branches(cfg):
    r = requests.get(
        f"{NEON_API}/projects/{cfg.neon_project_id}/branches",
        headers=neon_headers(cfg),
        timeout=HTTP_TIMEOUT,
    )
    if r.status_code != 200:
        raise SnapError(f"Neon list branches failed {r.status_code}: {r.text}")
    return r.json().get("branches", [])


def ensure_neon_branch(cfg):
    """Create copy-on-write branch {prefix}vX from prod branch HEAD. Idempotent:
    if a branch with that name already exists, reuse it. Returns (branch_id, lsn).
    """
    name = f"{cfg.branch_prefix}{cfg.version}"
    branches = _neon_list_branches(cfg)
    for b in branches:
        if b.get("name") == name:
            lsn = _branch_lsn(cfg, b)
            return b["id"], lsn  # idempotent skip

    payload = {"branch": {"name": name, "parent_id": cfg.neon_prod_branch_id}}
    r = requests.post(
        f"{NEON_API}/projects/{cfg.neon_project_id}/branches",
        headers=neon_headers(cfg),
        json=payload,
        timeout=HTTP_TIMEOUT,
    )
    if r.status_code not in (200, 201):
        raise SnapError(f"Neon create branch failed {r.status_code}: {r.text}")
    branch = r.json().get("branch", {})
    branch_id = branch.get("id")
    if not branch_id:
        raise SnapError(f"Neon create branch returned no id: {r.text}")
    lsn = _branch_lsn(cfg, branch)
    return branch_id, lsn


def _branch_lsn(cfg, branch):
    """Pin the LSN. Prefer the value the API returns; fall back to a fresh GET."""
    lsn = branch.get("current_state_lsn") or branch.get("parent_lsn")
    if lsn:
        return lsn
    bid = branch.get("id")
    if not bid:
        return None
    r = requests.get(
        f"{NEON_API}/projects/{cfg.neon_project_id}/branches/{bid}",
        headers=neon_headers(cfg),
        timeout=HTTP_TIMEOUT,
    )
    if r.status_code == 200:
        b = r.json().get("branch", {})
        return b.get("current_state_lsn") or b.get("parent_lsn")
    return None


# --- (c) durable pg_dump → S3 ------------------------------------------------

def dump_to_s3(s3, cfg):
    """Fresh pg_dump (pg17, DIRECT endpoint, -Fc) at snap time → S3. Idempotent:
    skip if the dump object already exists. Returns the S3 key.
    Does NOT reuse the daily dump.

    FULL-DATABASE scope (no -n/--schema): prod has THREE schemas — public,
    extensions (relocated uuid-ossp functions; 14 columns default to
    extensions.uuid_generate_v4()), and gv (11 functions backing 11 triggers on
    6 core tables). The old --schema=public dumps could not rebuild the DB from
    empty (Gate 0.1, verified live 2026-08-03).
    """
    key = s3_key_for("dump", cfg)
    if s3_object_exists(s3, cfg.snap_bucket, key):
        return key  # idempotent skip

    with tempfile.TemporaryDirectory() as td:
        dump_path = os.path.join(td, f"snap-{cfg.version}.dump")
        cmd = [
            "pg_dump",
            cfg.neon_backup_url,  # DIRECT endpoint; passed as a value, not shell
            "--no-owner",
            "--no-privileges",
            "-Fc",
            "-f",
            dump_path,
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            raise SnapError(
                f"pg_dump failed (rc={proc.returncode}): {proc.stderr.strip()}"
            )
        if not os.path.exists(dump_path) or os.path.getsize(dump_path) == 0:
            raise SnapError("pg_dump produced no output / empty dump")
        s3.upload_file(dump_path, cfg.snap_bucket, key)
    return key


def dump_globals_to_s3(s3, cfg):
    """pg_dumpall --globals-only companion (roles; cluster-level state pg_dump
    never captures) → same S3 prefix as the dump. Idempotent: skip if present.

    --no-role-passwords: keeps SCRAM hashes out of S3; Neon manages role
    credentials via its own API, so hashes are useless on restore anyway
    (pg_dumpall 17 vs Neon 17.10 verified working 2026-08-03).
    """
    key = s3_key_for("globals", cfg)
    if s3_object_exists(s3, cfg.snap_bucket, key):
        return key  # idempotent skip

    with tempfile.TemporaryDirectory() as td:
        path = os.path.join(td, f"snap-{cfg.version}.globals.sql")
        cmd = [
            "pg_dumpall",
            "--dbname",
            cfg.neon_backup_url,
            "--globals-only",
            "--no-role-passwords",
            "-f",
            path,
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            raise SnapError(
                f"pg_dumpall --globals-only failed (rc={proc.returncode}): {proc.stderr.strip()}"
            )
        if not os.path.exists(path) or os.path.getsize(path) == 0:
            raise SnapError("pg_dumpall produced no output / empty globals dump")
        s3.upload_file(path, cfg.snap_bucket, key)
    return key


# --- (d)(i) photos version-id list ------------------------------------------

def capture_photo_versions(s3, cfg):
    """Snapshot the current version-id of every object in the (versioned)
    photos bucket → JSON in SNAP_BUCKET. Idempotent: skip if already present.
    Returns the S3 key.
    """
    key = s3_key_for("photo_versionids", cfg)
    if s3_object_exists(s3, cfg.snap_bucket, key):
        return key  # idempotent skip

    versions = {}
    paginator = s3.get_paginator("list_object_versions")
    for page in paginator.paginate(Bucket=cfg.photos_bucket):
        for v in page.get("Versions", []):
            # Record only the CURRENT (latest) version-id per key.
            if v.get("IsLatest"):
                versions[v["Key"]] = v["VersionId"]
    body = json.dumps(
        {
            "photos_bucket": cfg.photos_bucket,
            "captured_at": utc_now_iso(),
            "count": len(versions),
            "versions": versions,
        },
        sort_keys=True,
    ).encode()
    s3.put_object(
        Bucket=cfg.snap_bucket, Key=key, Body=body, ContentType="application/json"
    )
    return key


# --- (d)(ii) Lambda versions -------------------------------------------------

def _wait_lambda_idle(client, fn, timeout=120, interval=3):
    """Best-effort wait until a function has no in-progress update.

    Returns LastUpdateStatus (or None if it can't be read — e.g. the snap role lacks
    GetFunctionConfiguration; in that case we just fall through to the publish retry).
    """
    waited = 0
    while waited < timeout:
        try:
            st = client.get_function_configuration(FunctionName=fn).get("LastUpdateStatus")
        except ClientError:
            return None
        if st != "InProgress":
            return st
        time.sleep(interval)
        waited += interval
    return "InProgress"


def publish_lambda_versions(cfg, lambda_client=None):
    """Publish a new version for each function and record the returned Version.

    publish-version is idempotent at the AWS layer: if there are no unpublished
    changes, Lambda returns the existing latest published version rather than
    erroring, so re-running is safe. Returns {fn: version}.

    Race-hardened (L-221): the promote FF triggers a push:main Lambda deploy, which can
    leave a function with LastUpdateStatus=InProgress when snap runs — PublishVersion
    then raises ResourceConflictException and reds the whole promote. We wait for each
    function to go idle, then publish with bounded backoff retry on ResourceConflictException.
    """
    client = lambda_client or boto3.client("lambda")
    out = {}
    for fn in LAMBDA_FUNCTIONS:
        _wait_lambda_idle(client, fn)
        ver = None
        last_err = None
        for attempt in range(6):
            try:
                resp = client.publish_version(FunctionName=fn)
                ver = resp.get("Version")
                break
            except ClientError as e:
                code = e.response.get("Error", {}).get("Code")
                if code == "ResourceConflictException":
                    last_err = e
                    _wait_lambda_idle(client, fn)
                    time.sleep(min(2 ** attempt, 20))
                    continue
                raise SnapError(f"publish_version failed for {fn}: {e}")
        if not ver:
            raise SnapError(f"publish_version for {fn} failed after retries: {last_err or 'no Version returned'}")
        out[fn] = ver
    return out


# --- self-verify -------------------------------------------------------------

def self_verify(s3, cfg, dump_key, globals_key, photo_key, neon_branch_id, tag):
    """Confirm every artifact actually exists before the manifest is written.
    Any miss aborts (fails the ship).
    """
    if not s3_object_exists(s3, cfg.snap_bucket, dump_key):
        raise SnapError(f"self-verify: dump object missing s3://{cfg.snap_bucket}/{dump_key}")
    if not s3_object_exists(s3, cfg.snap_bucket, globals_key):
        raise SnapError(f"self-verify: globals object missing s3://{cfg.snap_bucket}/{globals_key}")
    if not s3_object_exists(s3, cfg.snap_bucket, photo_key):
        raise SnapError(f"self-verify: photo versionids missing s3://{cfg.snap_bucket}/{photo_key}")
    # Neon branch present?
    branches = _neon_list_branches(cfg)
    if not any(b.get("id") == neon_branch_id for b in branches):
        raise SnapError(f"self-verify: Neon branch {neon_branch_id} not found")
    # Tag present and on MAIN_SHA?
    sha = _get_ref_sha(cfg, f"tags/{tag}")
    target = _resolve_ref_commit(cfg, sha)
    if target != cfg.main_sha:
        raise SnapError(
            f"self-verify: tag {tag} resolves to {target} != {cfg.main_sha}"
        )


# --- (e) manifest (written LAST) --------------------------------------------

def write_manifest(s3, cfg, manifest):
    """Write the manifest LAST as the commit-marker. Idempotent on identical sha
    (precheck already guarded a different-sha collision)."""
    key = s3_key_for("manifest", cfg)
    body = json.dumps(manifest, sort_keys=True, indent=2).encode()
    s3.put_object(
        Bucket=cfg.snap_bucket, Key=key, Body=body, ContentType="application/json"
    )
    return key


# --- retention prune ---------------------------------------------------------

PRUNE_DENY_NAMES = {"production", "staging", "main"}
PRUNE_MIN_AGE_HOURS = 24


def _prune_deny_reason(cfg, b):
    if b.get("id") == cfg.neon_prod_branch_id:
        return "prod branch id"
    if b.get("default"):
        return "default branch"
    if b.get("protected"):
        return "protected branch"
    if str(b.get("name", "")).lower() in PRUNE_DENY_NAMES:
        return "deny-listed name"
    return None


def _branch_age_hours(b, now=None):
    raw = str(b.get("created_at") or "")
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return ((now or datetime.now(timezone.utc)) - dt).total_seconds() / 3600.0


def prune_old_branches(cfg):
    """Keep the last K Neon {prefix}* snapshot branches; delete oldest beyond K.

    Candidates are scoped to name-prefix AND parent_id == the configured prod
    branch id — a rehearsal run (whose NEON_PROD_BRANCH_ID is the staging
    branch) can therefore never select production snapshots (Gate 4 §14; the
    old name-prefix-only filter could).

    Delete-time guards, each skip-and-report (never fatal — pruning OLD
    snapshots is hygiene and must NEVER fail an already-complete, self-verified
    snapshot; cf. snap-prune incident 2026-06-04, orphan staging child blocked
    retention with a 422):
      - hard deny-list: prod branch id, default/protected branches,
        names {production, staging, main}
      - 24h age floor (unparseable created_at counts as too young)
      - HTTP semantics: 200/201/202 deleted; 404 already absent (success);
        422/423 (has children / locked) and everything else skip-and-report.

    Returns {"pruned": [{id,name}], "skipped": [{id,name,reason}]}. Skips are
    surfaced as ::warning:: annotations + GITHUB_STEP_SUMMARY (Gate 2 §8 — they
    previously went to stderr inside a green job and branch count silently
    never converged).
    """
    k = max(1, cfg.retention)
    branches = _neon_list_branches(cfg)
    snaps = [
        b for b in branches
        if str(b.get("name", "")).startswith(cfg.branch_prefix)
        and b.get("parent_id") == cfg.neon_prod_branch_id
    ]
    snaps.sort(key=lambda b: b.get("created_at") or "")  # oldest first
    report = {"pruned": [], "skipped": []}
    to_delete = snaps[: len(snaps) - k] if len(snaps) > k else []
    for b in to_delete:
        bid = b["id"]
        name = str(b.get("name", ""))
        deny = _prune_deny_reason(cfg, b)
        if deny:
            report["skipped"].append({"id": bid, "name": name, "reason": deny})
            continue
        age = _branch_age_hours(b)
        if age is None:
            report["skipped"].append(
                {"id": bid, "name": name, "reason": "age floor (unparseable created_at)"}
            )
            continue
        if age < PRUNE_MIN_AGE_HOURS:
            report["skipped"].append(
                {"id": bid, "name": name,
                 "reason": f"age floor ({age:.1f}h < {PRUNE_MIN_AGE_HOURS}h)"}
            )
            continue
        try:
            r = requests.delete(
                f"{NEON_API}/projects/{cfg.neon_project_id}/branches/{bid}",
                headers=neon_headers(cfg),
                timeout=HTTP_TIMEOUT,
            )
        except requests.RequestException as e:  # noqa: BLE001 — never fatal
            report["skipped"].append({"id": bid, "name": name, "reason": f"request error: {e}"})
            continue
        if r.status_code in (200, 201, 202):
            report["pruned"].append({"id": bid, "name": name})
        elif r.status_code == 404:
            report["pruned"].append({"id": bid, "name": name, "note": "already absent (404)"})
        else:
            report["skipped"].append(
                {"id": bid, "name": name,
                 "reason": f"HTTP {r.status_code}: {r.text[:200]}"}
            )
    for s in report["skipped"]:
        gha_warning(f"snap prune skipped branch {s['name']} ({s['id']}): {s['reason']}")
    if report["pruned"] or report["skipped"]:
        gha_step_summary(
            ["### snap prune"]
            + [f"- pruned: {p['name']} ({p['id']})" for p in report["pruned"]]
            + [f"- skipped: {s['name']} ({s['id']}) — {s['reason']}" for s in report["skipped"]]
        )
    return report


# --- orchestration -----------------------------------------------------------

def run(cfg, s3=None, lambda_client=None, prune=True):
    """prune=False is the revert-flow contract: revert-to.py's pre-revert snap
    must not prune (it could delete the very snapshot being restored)."""
    s3 = s3 or boto3.client("s3")

    validate(cfg.version)

    # Guard vX reuse with different content before doing any work.
    precheck_existing_manifest(s3, cfg)

    # (a) tag
    tag = ensure_tag(cfg)
    # (b) Neon branch + LSN
    neon_branch_id, neon_lsn = ensure_neon_branch(cfg)
    # (c) fresh durable dump (full database) + cluster globals companion
    dump_key = dump_to_s3(s3, cfg)
    globals_key = dump_globals_to_s3(s3, cfg)
    # (d)(i) photos version ids
    photo_key = capture_photo_versions(s3, cfg)
    # (d)(ii) lambda versions
    lambda_versions = publish_lambda_versions(cfg, lambda_client=lambda_client)

    # self-verify EVERY artifact before the manifest commit-marker
    self_verify(s3, cfg, dump_key, globals_key, photo_key, neon_branch_id, tag)

    manifest = {
        "git_tag": tag,
        "main_sha": cfg.main_sha,
        "neon_branch": f"{cfg.branch_prefix}{cfg.version}",
        "neon_branch_id": neon_branch_id,
        "neon_lsn": neon_lsn,
        "dump_s3_key": dump_key,
        "globals_s3_key": globals_key,
        "photo_versionids_key": photo_key,
        "lambda_versions": lambda_versions,
        "cf_dist": cfg.cf_dist,
        "app_version": cfg.app_version,
        "timestamp": utc_now_iso(),
    }
    manifest_key = write_manifest(s3, cfg, manifest)

    # Retention prune AFTER a successful, fully-verified snap.
    prune_report = prune_old_branches(cfg) if prune else {"pruned": [], "skipped": []}
    if prune:
        # Best-effort manifest enrichment with the prune outcome (Gate 2 §8).
        # The commit-marker manifest is already durable; a failed rewrite must
        # not fail the ship.
        manifest["prune"] = prune_report
        try:
            write_manifest(s3, cfg, manifest)
        except Exception as e:  # noqa: BLE001 — never fatal post-commit-marker
            gha_warning(f"snap: could not record prune report in manifest: {e}")

    return {
        "manifest_key": manifest_key,
        "manifest": manifest,
        "pruned": prune_report["pruned"],
        "skipped": prune_report["skipped"],
    }


def main(argv=None):
    try:
        cfg = Config()
        result = run(cfg)
    except SnapError as e:
        # Unrecoverable -> FAIL THE SHIP.
        sys.stderr.write(f"[snap] FAIL: {e}\n")
        return 1
    except Exception as e:  # noqa: BLE001 — defensive: any unexpected error fails the ship
        sys.stderr.write(f"[snap] FAIL (unexpected): {type(e).__name__}: {e}\n")
        return 1
    sys.stdout.write(
        f"[snap] OK {result['manifest']['git_tag']} -> "
        f"s3://{cfg.snap_bucket}/{result['manifest_key']} "
        f"(pruned {len(result['pruned'])}, skipped {len(result['skipped'])} old branches)\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
