#!/usr/bin/env python3
"""
snap.py — garden-app "version-snap" primitive (spec §3 B1).

Captures a point-in-time, COUPLED code+DB+assets bundle keyed by one version
string (vX), so any shipped prod version is revertible. Runs as the LAST gate
of `promote-gate.yml` (the `promote` job, inside `environment: production`),
BEFORE the fast-forward of `main` (BUG-PROMOTEFFORDER-001, 2026-10-15; until
then it ran after the FF, and a snap failure left main advanced with nothing
deployed). After the FF that job runs `snap.py --prune-only`, the retention
prune this run no longer does (`--no-prune`), so an old revert point is never
deleted for a version that might not ship.

This is the commit-marker of a prod promote: if snap fails, the SHIP fails
(non-zero exit) with main untouched, because a green promote with a
silently-absent snapshot is the exact trap this primitive closes.

ORPHAN TAG. The tag is created last of the artifacts, just before the manifest
(precheck_tag refuses a taken tag up front, read-only). A failure between the
tag and the fast-forward, or a failed FF, leaves tag vX + manifest + Neon branch
for a commit main never reached. While dev is unmoved, "Re-run failed jobs"
completes it (every artifact is create-if-missing). Once dev moves, vX is burnt:
release-tag-integrity forbids moving or deleting the tag, the skew gate refuses
it, and revert-to.py refuses it as a target ("never reached main").
forward-undo.py's previous_release (highest tag below vN whose commit is an
ancestor of vN) does NOT know this and can pick such a burnt vX as vPREV.

------------------------------------------------------------------------------
ENV CONTRACT (read at runtime; no secrets are hardcoded):
  GH_TOKEN            garden-bot GitHub App installation token (tag creation is
                      ruleset-restricted to garden-bot; the job runs as the bot).
  GITHUB_REPOSITORY   "owner/repo" (provided by GitHub Actions).
  MAIN_SHA            the commit to tag and pin the snap to: inside promote-gate
                      the dev SHA main is about to be fast-forwarded to (main
                      has not moved yet); in revert-to.py, main's current head.
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
pg_dumpall (pg17 client) via subprocess. psql (same pg17 bin directory) is used
ONLY for the table list beside the dump, and that write can never fail the ship
(see write_table_list_or_warn), so promote-gate's pre-FF tooling proof does not
cover it.

Idempotency: every artifact is create-if-missing. If it already exists it is
SKIPPED, not errored, so a partial snap completes cleanly on re-run. BUT if a
target artifact for vX already exists pinned to a DIFFERENT main_sha, we ABORT
(guards a vX reuse with new content).

MODES (argv):
  (none)              the full snap above, then the retention prune.
  --no-prune          the full snap without the prune (promote-gate, pre-FF).
  --phase P           the full snap, stamping manifest.lambda_versions_phase = P
                      (promote-gate passes pre-deploy; revert-to.py's pre-revert
                      snap passes pre-revert through run(); without it the key is
                      absent).
  --lambdas-only      after promote-gate's deploy-lambdas (job snap-lambdas):
                      re-publish the release functions and rewrite vX's manifest
                      with the versions that shipped (OPS-SNAPCAPTUREORDER-001).
                      Reads only MAIN_SHA, SNAP_VERSION, SNAP_BUCKET and AWS
                      credentials. Refuses a manifest pinned to another MAIN_SHA.
                      The first run keeps the pre-deploy map as
                      lambda_versions_pre_deploy / lambda_uncaptured_pre_deploy;
                      a re-run (phase already post-deploy) never touches them.
  --prune-only        the retention prune alone (promote-gate, post-FF). Reads
                      only NEON_API_KEY, NEON_PROJECT_ID, NEON_PROD_BRANCH_ID,
                      SNAP_BRANCH_PREFIX, SNAP_RETENTION; with SNAP_VERSION and
                      MAIN_SHA set it also records the report in that version's
                      manifest (SNAP_BUCKET, AWS), best-effort. NEVER fails: it
                      runs after main has moved, and exits 0 on every outcome.
------------------------------------------------------------------------------
"""
from __future__ import annotations

import argparse
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

import lambda_fleet

# --- constants ---------------------------------------------------------------

VERSION_RE = re.compile(r"^v\d+(\.\d+){0,2}$")
NEON_API = "https://console.neon.tech/api/v2"
GITHUB_API = "https://api.github.com"
HTTP_TIMEOUT = 60

# The Lambda functions in the coupled snap are NOT listed here any more. They are every function
# a release ships — lambda_fleet.release_functions(), derived from lambda-config-expected.json and
# pinned equal to deploy-lambda.yml's matrix (OPS-REVERTRESTORE-001). A hand-kept list of 11
# covered 11 of 26, so a revert left the other 15 at the newer code with no signal at all.

# Per-function capture failures that are RECORDED (manifest.lambda_uncaptured + ::warning::)
# instead of failing the ship. Everything else still fails it. See publish_lambda_versions().
UNCAPTURED_OK = ("ResourceNotFoundException", "AccessDeniedException")


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


class PruneConfig:
    """--prune-only: what prune_old_branches reads, and nothing else (no bot token, no DB URL, no
    photos bucket). Same defaults as Config. version/main_sha are optional: only the best-effort
    manifest record uses them."""

    def __init__(self, env=None):
        env = os.environ if env is None else env
        self.neon_api_key = Config._req(env, "NEON_API_KEY")
        self.neon_project_id = Config._req(env, "NEON_PROJECT_ID")
        self.neon_prod_branch_id = env.get("NEON_PROD_BRANCH_ID", "br-delicate-sea-amum92c2")
        self.branch_prefix = env.get("SNAP_BRANCH_PREFIX") or "snap-"
        self.retention = Config._int_env(env, "SNAP_RETENTION", 5, minimum=1)
        self.version = env.get("SNAP_VERSION") or ""
        self.main_sha = env.get("MAIN_SHA") or ""
        self.snap_bucket = env.get("SNAP_BUCKET") or "garden-snapshots-prod"


class LambdasOnlyConfig:
    """--lambdas-only (OPS-SNAPCAPTUREORDER-001): MAIN_SHA, SNAP_VERSION, SNAP_BUCKET, plus the AWS
    credentials boto3 finds itself. No bot token, Neon key or DB URL: the job that runs it has none."""

    def __init__(self, env=None):
        env = os.environ if env is None else env
        self.main_sha = Config._req(env, "MAIN_SHA")
        self.version = Config._req(env, "SNAP_VERSION")
        self.snap_bucket = env.get("SNAP_BUCKET") or "garden-snapshots-prod"


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
        "tables": f"db/snap-{v}.tables.json",
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

def precheck_tag(cfg):
    """Read-only half of ensure_tag, run before any capture: a tag vX that already exists on
    another commit refuses HERE, before a Neon branch or a dump is made for a version that can
    never be tagged. Creates nothing; ensure_tag (just before the manifest) creates the tag.
    Returns the commit an existing tag resolves to (== MAIN_SHA), or None when it is free."""
    r = requests.get(
        f"{GITHUB_API}/repos/{cfg.repo}/git/ref/tags/{cfg.version}",
        headers=gh_headers(cfg),
        timeout=HTTP_TIMEOUT,
    )
    if r.status_code == 404:
        return None
    if r.status_code != 200:
        raise SnapError(f"GitHub ref lookup failed {r.status_code}: {r.text}")
    target = _resolve_ref_commit(cfg, r.json().get("object", {}).get("sha"))
    if target != cfg.main_sha:
        raise SnapError(
            f"tag {cfg.version} already exists pointing at {target} != "
            f"{cfg.main_sha}; refusing to move tag"
        )
    return target


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
        # A 422 can also be a REFUSAL: since 2026-10-02 the release-tag-integrity ruleset lets only
        # garden-bot create a v* tag. Only the re-read tells the two apart, so when the ref is not
        # there, report GitHub's own body, which names the rule, not the bare lookup error.
        try:
            ref_sha = _get_ref_sha(cfg, ref)
        except SnapError as e:
            raise SnapError(
                f"create tag ref refused 422: {rr.text} (and the tag is not there: {e})"
            ) from e
        target = _resolve_ref_commit(cfg, ref_sha)
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

# The tables that exist in prod when the dump is taken (OPS-RESTOREVERIFYRED-001).
# restore-verify.py compares its restore with THIS list, not with live prod, so a
# table prod gains after the snap no longer reads as "MISSING from restore". Same
# read as restore-verify.py qualified_table_set() and backup.yml's daily list.
TABLE_LIST_FORMAT = 1
TABLE_LIST_TIMEOUT = 60
TABLE_LIST_SQL = (
    "SELECT table_schema||'.'||table_name FROM information_schema.tables "
    "WHERE table_type='BASE TABLE' "
    "AND table_schema NOT IN ('pg_catalog','information_schema') "
    "AND table_schema NOT LIKE 'pg_%' ORDER BY 1;"
)


def read_table_list(cfg):
    """schema.table for every base table outside the system schemas, read over
    the same DIRECT connection string pg_dump uses. Raises SnapError; the
    message never carries the command line (it holds the connection string)."""
    try:
        proc = subprocess.run(
            ["psql", cfg.neon_backup_url, "-X", "-tA", "-v", "ON_ERROR_STOP=1",
             "-c", TABLE_LIST_SQL],
            capture_output=True, text=True, timeout=TABLE_LIST_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        raise SnapError(f"psql table-list read timed out after {TABLE_LIST_TIMEOUT}s")
    except OSError as e:
        raise SnapError(f"psql could not be run ({type(e).__name__}: {e.strerror})")
    if proc.returncode != 0:
        raise SnapError(f"psql table-list read failed (rc={proc.returncode}): {(proc.stderr or '').strip()[:300]}")
    tables = sorted({ln.strip() for ln in (proc.stdout or "").splitlines() if ln.strip()})
    if not any(t.startswith("public.") for t in tables):
        raise SnapError(f"table-list read returned no public.* table ({len(tables)} rows)")
    return tables


def _table_list_warn(cfg, why):
    """NEVER raises: it is called from the handlers that promise not to (an
    stdout that cannot encode the message must not fail the ship)."""
    try:
        key = s3_key_for("tables", cfg)
        msg = (f"snap: table list s3://{cfg.snap_bucket}/{key} NOT written ({why}) -- the snap "
               f"itself is complete; restore-verify will compare this dump with LIVE prod's table "
               f"list instead (its fallback, and it says so)")
        gha_warning(msg)
        gha_step_summary(["### snap: table list NOT written", f"- {msg}"])
    except Exception:  # noqa: BLE001 — see docstring
        pass


def read_table_list_or_warn(cfg):
    """(tables, taken_at) or (None, None). NEVER raises: see write_table_list_or_warn."""
    try:
        return read_table_list(cfg), utc_now_iso()
    except SnapError as e:
        _table_list_warn(cfg, str(e))
    except Exception as e:  # noqa: BLE001 — type only: an arbitrary message may carry the URL
        _table_list_warn(cfg, f"unexpected {type(e).__name__} reading it")
    return None, None


def write_table_list_or_warn(s3, cfg, dump_key, tables, taken_at):
    """Put the table list beside the dump it was read for. Returns the key, or
    None when nothing was written.

    WARNS, NEVER FAILS THE SHIP. This ran inside promote-gate AFTER main had
    fast-forwarded until 2026-10-15, where a raise stranded main advanced with
    nothing deployed; it now runs before the FF, where a raise still refuses the
    release (and burns vX once dev moves, see the module docstring). The list is
    not part of what a revert restores: its only reader is restore-verify, which
    falls back to the live comparison for a dump with no list and says so. So a
    lost list costs one possible false red there, announced here by a
    ::warning:: and by manifest.tables_s3_key = null; failing would cost a
    release. The daily backup, which has nothing downstream to strand, fails."""
    if tables is None:
        return None
    key = s3_key_for("tables", cfg)
    try:
        body = json.dumps(
            {"format": TABLE_LIST_FORMAT, "dump_key": dump_key, "taken_at": taken_at,
             "tables": tables},
            sort_keys=True,
        ).encode()
        s3.put_object(Bucket=cfg.snap_bucket, Key=key, Body=body, ContentType="application/json")
    except Exception as e:  # noqa: BLE001 — see docstring
        _table_list_warn(cfg, f"{type(e).__name__} writing it")
        return None
    return key


def table_list_key_if_present(s3, cfg):
    """The table-list key for the manifest, or None. Never raises (it never fails the ship)."""
    key = s3_key_for("tables", cfg)
    try:
        return key if s3_object_exists(s3, cfg.snap_bucket, key) else None
    except Exception:  # noqa: BLE001
        return None


def dump_to_s3(s3, cfg):
    """Fresh pg_dump (pg17, DIRECT endpoint, -Fc) at snap time → S3. Idempotent:
    skip if the dump object already exists. Returns the S3 key.
    Does NOT reuse the daily dump.

    Also writes the table list beside the dump (read_table_list): read
    IMMEDIATELY BEFORE pg_dump, on its own connection (pg_dump takes its own
    snapshot; sharing one would put a second session's lifetime on the dump's
    critical path). Before, not after, so a table created in the gap is in the
    dump but not the list (a restore-verify warning), never the reverse. Put
    AFTER the dump upload, and only when THIS call took the dump: an existing
    dump is never given a list read later than it.

    FULL-DATABASE scope (no -n/--schema): prod has THREE schemas — public,
    extensions (relocated uuid-ossp functions; 14 columns default to
    extensions.uuid_generate_v4()), and gv (11 functions backing 11 triggers on
    6 core tables). The old --schema=public dumps could not rebuild the DB from
    empty (Gate 0.1, verified live 2026-08-03).
    """
    key = s3_key_for("dump", cfg)
    if s3_object_exists(s3, cfg.snap_bucket, key):
        return key  # idempotent skip

    tables, tables_taken_at = read_table_list_or_warn(cfg)
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
    write_table_list_or_warn(s3, cfg, key, tables, tables_taken_at)
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


def release_lambda_functions():
    """Every Lambda a release ships (deploy-lambda.yml's matrix). Unreadable manifest = fail."""
    try:
        return lambda_fleet.release_functions()
    except lambda_fleet.FleetError as e:
        raise SnapError(str(e))


def _uncaptured_hint(why):
    if why.startswith("ResourceNotFoundException"):
        return "it does not exist yet (its first deploy runs after snap), so there is nothing to roll back"
    return ("a revert cannot roll it back, and revert-to.py refuses to start, until snap-ops grants "
            "lambda:PublishVersion + lambda:GetFunctionConfiguration on it "
            "(Projects/Gardening/iam-trust-rollback)")


def publish_lambda_versions(cfg, lambda_client=None, functions=None):
    """Publish a new version for each release function and record the returned Version.

    publish-version is idempotent at the AWS layer: if there are no unpublished
    changes, Lambda returns the existing latest published version rather than
    erroring, so re-running is safe. Returns ({fn: version}, {fn: why_uncaptured}).

    WHAT THE VERSIONS ARE (OPS-REVERTRESTORE-001, measured 2026-09-11). Each version is the code
    that was LIVE when this snap ran. Inside promote-gate that is the PREVIOUS release's code,
    not this one's: snap is a step of the `promote` job and `deploy-lambdas` needs that job, so
    it deploys after snap. Manifest v4.128.0 recorded garden-plants v175, whose code is the
    v4.127.0 deploy, while $LATEST carried v4.128.0's. Since OPS-SNAPCAPTUREORDER-001 the full
    snap stamps that as lambda_versions_phase "pre-deploy", and promote-gate's snap-lambdas job,
    after a successful deploy-lambdas, calls this again (--lambdas-only) and records the shipped
    versions as phase "post-deploy". Inside revert-to.py's PRE-REVERT snap the
    versions are exactly what prod is serving (phase "pre-revert"). So revert-to.py restores from these versions only
    in rollback(), from its own pre-revert snap; a forward revert rebuilds the target's Lambdas
    from the target's tree instead.

    Race-hardened (L-221): the promote FF used to trigger a push:main Lambda deploy (removed by
    OPS-PROMOTERACE-001; deploy-lambdas is now a graph successor of the promote job), which could
    leave a function with LastUpdateStatus=InProgress when snap ran — PublishVersion then raises
    ResourceConflictException. A console upload or a revert can still do that, so we wait for
    each function to go idle, then publish with bounded backoff retry on ResourceConflictException.

    UNCAPTURED IS RECORDED, NOT FATAL (OPS-REVERTRESTORE-001). This ran AFTER promote-gate's
    fast-forward until 2026-10-15 (BUG-PROMOTEFFORDER-001), where a raise stranded main advanced
    with nothing deployed; before the FF a raise refuses the release instead, and a function whose
    first deploy is this promote can still never be captured here. Two per-function
    outcomes are therefore returned in `uncaptured` (-> manifest.lambda_uncaptured) and warned:
      ResourceNotFoundException  a function whose FIRST deploy is this very promote.
      AccessDeniedException      a release function snap-ops does not grant yet.
    Until 2026-09-11 an AccessDenied here failed the ship. It now warns, and revert-to.py refuses
    to START while its pre-revert snap left any existing function uncaptured, so completeness is
    enforced where it is used. Capturing NOTHING is still fatal (a broken role, not a new
    function), and every other error still fails the ship exactly as before.
    """
    client = lambda_client or boto3.client("lambda")
    fns = release_lambda_functions() if functions is None else list(functions)
    out, uncaptured = {}, {}
    for fn in fns:
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
                if code in UNCAPTURED_OK:
                    uncaptured[fn] = f"{code}: {e.response.get('Error', {}).get('Message', '')}"[:300]
                    break
                raise SnapError(f"publish_version failed for {fn}: {e}")
        if fn in uncaptured:
            continue
        if not ver:
            raise SnapError(f"publish_version for {fn} failed after retries: {last_err or 'no Version returned'}")
        out[fn] = ver
    if not out:
        raise SnapError(
            f"publish_version captured ZERO of {len(fns)} functions — that is a broken snap role, "
            f"not a new function: {uncaptured}")
    for fn, why in sorted(uncaptured.items()):
        gha_warning(f"snap: {fn} NOT captured ({why}) — {_uncaptured_hint(why)}")
    if uncaptured:
        gha_step_summary(["### snap: Lambda functions NOT captured"]
                         + [f"- {fn}: {why}" for fn, why in sorted(uncaptured.items())])
    return out, uncaptured


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

def run(cfg, s3=None, lambda_client=None, prune=True, phase=None):
    """prune=False is the revert-flow contract: revert-to.py's pre-revert snap
    must not prune (it could delete the very snapshot being restored). The
    promote passes it too (--no-prune) and prunes after its fast-forward.

    phase labels what lambda_versions are (manifest.lambda_versions_phase):
    "pre-deploy" from promote-gate (the previous release's code; snap-lambdas
    moves it to "post-deploy"), "pre-revert" from revert-to.py (what prod
    serves). None leaves the key out (snap-rehearsal, older callers)."""
    s3 = s3 or boto3.client("s3")

    validate(cfg.version)

    # Guard vX reuse with different content before doing any work: the manifest,
    # and (read-only) the tag.
    precheck_existing_manifest(s3, cfg)
    precheck_tag(cfg)

    # (b) Neon branch + LSN
    neon_branch_id, neon_lsn = ensure_neon_branch(cfg)
    # (c) fresh durable dump (full database) + cluster globals companion
    dump_key = dump_to_s3(s3, cfg)
    globals_key = dump_globals_to_s3(s3, cfg)
    # (d)(i) photos version ids
    photo_key = capture_photo_versions(s3, cfg)
    # (d)(ii) lambda versions — every release function; uncaptured ones recorded, not fatal
    lambda_versions, lambda_uncaptured = publish_lambda_versions(cfg, lambda_client=lambda_client)
    # (a) tag, LAST of the artifacts (BUG-PROMOTEFFORDER-001): the tag is the one artifact that can
    # never be removed (release-tag-integrity), so every fallible capture runs before it. A failure
    # above leaves no tag, and a promote refused there burns no version.
    tag = ensure_tag(cfg)

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
        # null = no list beside this dump; restore-verify falls back to live prod
        "tables_s3_key": table_list_key_if_present(s3, cfg),
        "photo_versionids_key": photo_key,
        "lambda_versions": lambda_versions,
        "lambda_uncaptured": lambda_uncaptured,
        "cf_dist": cfg.cf_dist,
        "app_version": cfg.app_version,
        "timestamp": utc_now_iso(),
    }
    if phase:
        manifest["lambda_versions_phase"] = phase
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


# What revert-to.py's load_manifest requires (revert-to.py:414-417). --lambdas-only refuses to
# rewrite a manifest that lacks one, and never drops one.
REQUIRED_MANIFEST_KEYS = ("git_tag", "main_sha", "neon_branch", "dump_s3_key", "lambda_versions", "cf_dist")
LAMBDA_PHASES_BEFORE_DEPLOY = (None, "pre-deploy")  # None = a manifest from before the phase key


def read_manifest_strict(s3, cfg):
    """snapshots/<vX>.json via GetObject. Unlike s3_object_exists, a 403 is NEVER read as absent."""
    key = s3_key_for("manifest", cfg)
    where = f"s3://{cfg.snap_bucket}/{key}"
    try:
        return s3_get_json(s3, cfg.snap_bucket, key)
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        if code in ("AccessDenied", "403", "Forbidden"):
            raise SnapError(
                f"AccessDenied reading {where}: the snap role needs s3:GetObject on snapshots/* (snap-ops "
                f"SnapBucketWriteRead, Projects/Gardening/iam-trust-rollback). Not treated as absent; S3 also "
                f"answers a missing key with 403 to a role without s3:ListBucket, but the promote's own snap "
                f"wrote this key, so the grant is the first thing to check")
        if code in ("NoSuchKey", "404", "NotFound"):
            raise SnapError(f"no manifest at {where}: the promote's snap did not write one for {cfg.version}")
        raise SnapError(f"reading {where} failed: {code or type(e).__name__}: {e}")


def lambdas_only(cfg, s3=None, lambda_client=None):
    """--lambdas-only: record the Lambda versions that SHIPPED in vX's manifest.

    Runs after deploy-lambdas succeeded (promote-gate job snap-lambdas). publish_version on each
    release function now returns the version of the code just deployed. IDEMPOTENT: the
    pre-deploy map is copied to lambda_versions_pre_deploy / lambda_uncaptured_pre_deploy only
    while the phase is still pre-deploy (or absent); a re-run finds post-deploy and only
    refreshes lambda_versions / lambda_uncaptured, so "Re-run failed jobs" can never overwrite
    the real pre-deploy map with the post-deploy one. Every other key is kept as it was."""
    validate(cfg.version)
    s3 = s3 or boto3.client("s3")
    manifest = read_manifest_strict(s3, cfg)
    if manifest.get("main_sha") != cfg.main_sha:
        raise SnapError(
            f"manifest for {cfg.version} is pinned to main_sha {manifest.get('main_sha')} != "
            f"{cfg.main_sha}; refusing to record this promote's Lambda versions in it")
    missing = [k for k in REQUIRED_MANIFEST_KEYS if k not in manifest]
    if missing:
        raise SnapError(f"manifest for {cfg.version} lacks {missing}; refusing to rewrite a manifest "
                        f"revert-to.py cannot load")
    phase = manifest.get("lambda_versions_phase")
    if phase not in LAMBDA_PHASES_BEFORE_DEPLOY + ("post-deploy",):
        raise SnapError(f"manifest for {cfg.version} has lambda_versions_phase {phase!r}; only a "
                        f"promote's manifest (pre-deploy or post-deploy) is updated here")
    versions, uncaptured = publish_lambda_versions(cfg, lambda_client=lambda_client)
    updated = dict(manifest)
    if phase in LAMBDA_PHASES_BEFORE_DEPLOY:
        updated["lambda_versions_pre_deploy"] = manifest["lambda_versions"]
        updated["lambda_uncaptured_pre_deploy"] = manifest.get("lambda_uncaptured", {})
    updated["lambda_versions"] = versions
    updated["lambda_uncaptured"] = uncaptured
    updated["lambda_versions_phase"] = "post-deploy"
    updated["lambda_versions_captured_at"] = utc_now_iso()
    key = write_manifest(s3, cfg, updated)
    return {"manifest_key": key, "manifest": updated, "rerun": phase == "post-deploy"}


def main_lambdas_only(env=None):
    try:
        cfg = LambdasOnlyConfig(env=env)
        result = lambdas_only(cfg)
    except SnapError as e:
        sys.stderr.write(f"[snap] lambdas-only FAIL: {e}\n")
        return 1
    except Exception as e:  # noqa: BLE001 — any unexpected error is a red job, never a silent pass
        sys.stderr.write(f"[snap] lambdas-only FAIL (unexpected): {type(e).__name__}: {e}\n")
        return 1
    m = result["manifest"]
    sys.stdout.write(
        f"[snap] lambdas-only OK {cfg.version} -> s3://{cfg.snap_bucket}/{result['manifest_key']} phase "
        f"post-deploy ({len(m['lambda_versions'])} captured, {len(m['lambda_uncaptured'])} uncaptured"
        f"{'; re-run, pre-deploy map kept' if result['rerun'] else ''})\n")
    return 0


def record_prune_report(cfg, report):
    """Best-effort: add the --prune-only report to vX's manifest, as the full snap's post-prune
    rewrite does. Only with SNAP_VERSION and MAIN_SHA set, and only into a manifest pinned to
    MAIN_SHA. Never raises."""
    if not (cfg.version and cfg.main_sha):
        return
    try:
        s3 = boto3.client("s3")
        key = s3_key_for("manifest", cfg)
        manifest = s3_get_json(s3, cfg.snap_bucket, key)
        if manifest.get("main_sha") != cfg.main_sha:
            gha_warning(f"snap prune: prune report NOT recorded: s3://{cfg.snap_bucket}/{key} is pinned to "
                        f"{manifest.get('main_sha')}, not {cfg.main_sha}")
            return
        manifest["prune"] = report
        write_manifest(s3, cfg, manifest)
    except Exception as e:  # noqa: BLE001 — never fatal post-FF
        gha_warning(f"snap prune: could not record prune report in manifest: {type(e).__name__}: {e}")


def main_prune_only(env=None):
    """--prune-only. Exit 0 on EVERY outcome: it runs after promote-gate's fast-forward, where a red
    step would fail the promote job and skip both deploys with main already moved. A prune that
    does not happen leaves an old branch until the next promote's prune."""
    try:
        cfg = PruneConfig(env=env)
        report = prune_old_branches(cfg)
    except Exception as e:  # noqa: BLE001 — never fatal
        gha_warning(f"snap prune: old snapshot branches NOT pruned ({type(e).__name__}: {e}); never fatal, "
                    f"the next promote's prune retries")
        return 0
    record_prune_report(cfg, report)
    sys.stdout.write(f"[snap] prune-only OK (pruned {len(report['pruned'])}, "
                     f"skipped {len(report['skipped'])} old branches)\n")
    return 0


def parse_args(argv):
    p = argparse.ArgumentParser(prog="snap.py", description="garden-app version-snap (see the module docstring)")
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--prune-only", action="store_true",
                      help="the retention prune alone; never fails (promote-gate, after the fast-forward)")
    mode.add_argument("--lambdas-only", action="store_true",
                      help="record the shipped Lambda versions in vX's manifest (promote-gate, snap-lambdas)")
    p.add_argument("--no-prune", action="store_true",
                   help="the full snap without the retention prune (promote-gate, before the fast-forward)")
    p.add_argument("--phase", choices=("pre-deploy", "pre-revert"),
                   help="the full snap: stamp manifest.lambda_versions_phase")
    args = p.parse_args(argv)
    if (args.prune_only or args.lambdas_only) and (args.no_prune or args.phase):
        p.error("--no-prune and --phase apply to the full snap only")
    return args


def main(argv=None):
    """argv=None is the no-argument call: the full snap with its prune, as before argparse."""
    args = parse_args([] if argv is None else argv)
    if args.prune_only:
        return main_prune_only()
    if args.lambdas_only:
        return main_lambdas_only()
    try:
        cfg = Config()
        result = run(cfg, prune=not args.no_prune, phase=args.phase)
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
    sys.exit(main(sys.argv[1:]))
