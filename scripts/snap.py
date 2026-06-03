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
  SNAP_BUCKET         backup S3 bucket (default garden-backups-prod).
  PHOTOS_BUCKET       REQUIRED, UNKNOWN at author time — the versioned photos
                      bucket whose current version-id list we snapshot.
  SNAP_RETENTION      keep last K Neon snap-* branches (default 5). FLAG: confirm
                      real Neon tier branch cap and set K below it.
  CF_DIST             CloudFront distribution id (default E3FAJTXAORQYDT).
  APP_VERSION         human/app version label recorded in the manifest.

Dependencies: boto3 (S3/Lambda), requests (Neon + GitHub REST), pg_dump (pg17
client) via subprocess.

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
        self.snap_bucket = env.get("SNAP_BUCKET", "garden-backups-prod")
        # PHOTOS_BUCKET is required and UNKNOWN at author time — fail loud.
        self.photos_bucket = self._req(env, "PHOTOS_BUCKET")
        self.retention = int(env.get("SNAP_RETENTION", "5"))
        self.cf_dist = env.get("CF_DIST", "E3FAJTXAORQYDT")
        self.app_version = env.get("APP_VERSION", "")

    @staticmethod
    def _req(env, key):
        val = env.get(key)
        if not val:
            raise SnapError(f"required env var {key} is missing or empty")
        return val


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
        "photo_versionids": f"photos/snap-{v}.versionids.json",
        "manifest": f"snapshots/{v}.json",
    }[kind]


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
    """Create copy-on-write branch snap-vX from prod branch HEAD. Idempotent:
    if a branch named snap-vX already exists, reuse it. Returns (branch_id, lsn).
    """
    name = f"snap-{cfg.version}"
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
    """
    key = s3_key_for("dump", cfg)
    if s3_object_exists(s3, cfg.snap_bucket, key):
        return key  # idempotent skip

    with tempfile.TemporaryDirectory() as td:
        dump_path = os.path.join(td, f"snap-{cfg.version}.dump")
        cmd = [
            "pg_dump",
            cfg.neon_backup_url,  # DIRECT endpoint; passed as a value, not shell
            "--schema=public",
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

def publish_lambda_versions(cfg, lambda_client=None):
    """Publish a new version for each function and record the returned Version.

    publish-version is idempotent at the AWS layer: if there are no unpublished
    changes, Lambda returns the existing latest published version rather than
    erroring, so re-running is safe. Returns {fn: version}.
    """
    client = lambda_client or boto3.client("lambda")
    out = {}
    for fn in LAMBDA_FUNCTIONS:
        try:
            resp = client.publish_version(FunctionName=fn)
        except ClientError as e:
            raise SnapError(f"publish_version failed for {fn}: {e}")
        ver = resp.get("Version")
        if not ver:
            raise SnapError(f"publish_version for {fn} returned no Version")
        out[fn] = ver
    return out


# --- self-verify -------------------------------------------------------------

def self_verify(s3, cfg, dump_key, photo_key, neon_branch_id, tag):
    """Confirm every artifact actually exists before the manifest is written.
    Any miss aborts (fails the ship).
    """
    if not s3_object_exists(s3, cfg.snap_bucket, dump_key):
        raise SnapError(f"self-verify: dump object missing s3://{cfg.snap_bucket}/{dump_key}")
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

def prune_old_branches(cfg):
    """Keep the last K Neon snap-* branches; delete oldest beyond K.

    Ordering is by branch creation time (created_at) ascending; the K NEWEST are
    kept. Never deletes the prod branch (only names starting 'snap-' are
    candidates).
    """
    k = cfg.retention
    if k < 0:
        raise SnapError(f"SNAP_RETENTION must be >= 0, got {k}")
    branches = _neon_list_branches(cfg)
    snaps = [b for b in branches if str(b.get("name", "")).startswith("snap-")]

    def created_key(b):
        return b.get("created_at") or ""

    snaps.sort(key=created_key)  # oldest first
    if len(snaps) <= k:
        return []
    to_delete = snaps[: len(snaps) - k]
    deleted = []
    for b in to_delete:
        bid = b["id"]
        r = requests.delete(
            f"{NEON_API}/projects/{cfg.neon_project_id}/branches/{bid}",
            headers=neon_headers(cfg),
            timeout=HTTP_TIMEOUT,
        )
        if r.status_code not in (200, 201, 202):
            raise SnapError(
                f"prune: delete branch {bid} failed {r.status_code}: {r.text}"
            )
        deleted.append(bid)
    return deleted


# --- orchestration -----------------------------------------------------------

def run(cfg, s3=None, lambda_client=None):
    s3 = s3 or boto3.client("s3")

    validate(cfg.version)

    # Guard vX reuse with different content before doing any work.
    precheck_existing_manifest(s3, cfg)

    # (a) tag
    tag = ensure_tag(cfg)
    # (b) Neon branch + LSN
    neon_branch_id, neon_lsn = ensure_neon_branch(cfg)
    # (c) fresh durable dump
    dump_key = dump_to_s3(s3, cfg)
    # (d)(i) photos version ids
    photo_key = capture_photo_versions(s3, cfg)
    # (d)(ii) lambda versions
    lambda_versions = publish_lambda_versions(cfg, lambda_client=lambda_client)

    # self-verify EVERY artifact before the manifest commit-marker
    self_verify(s3, cfg, dump_key, photo_key, neon_branch_id, tag)

    manifest = {
        "git_tag": tag,
        "main_sha": cfg.main_sha,
        "neon_branch": f"snap-{cfg.version}",
        "neon_branch_id": neon_branch_id,
        "neon_lsn": neon_lsn,
        "dump_s3_key": dump_key,
        "photo_versionids_key": photo_key,
        "lambda_versions": lambda_versions,
        "cf_dist": cfg.cf_dist,
        "app_version": cfg.app_version,
        "timestamp": utc_now_iso(),
    }
    manifest_key = write_manifest(s3, cfg, manifest)

    # Retention prune AFTER a successful, fully-verified snap.
    pruned = prune_old_branches(cfg)

    return {"manifest_key": manifest_key, "manifest": manifest, "pruned": pruned}


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
        f"(pruned {len(result['pruned'])} old branches)\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
