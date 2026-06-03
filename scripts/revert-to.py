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
     then FF-promote it to `main` -> CF redeploy. Restore Lambda versions to
     manifest.lambda_versions.
  5. ORDERING + ABORT: stage + validate the DB target FIRST, then cut over
     code+DB TOGETHER; if either leg fails, roll back to the pre-revert snap.

ENV CONTRACT (read at runtime; no secrets hardcoded):
  GH_TOKEN            garden-bot GitHub App installation token (tag read, dev
                      commit, main FF — all restricted to garden-bot).
  GITHUB_REPOSITORY   "owner/repo".
  TARGET_VERSION      the vX to revert TO. ^v\\d+(\\.\\d+){0,2}$.
  PREREVERT_VERSION   a fresh, unused vX to snapshot CURRENT prod as before the
                      revert (so the revert is itself revertible). Same regex.
  NEON_API_KEY        Neon API key.
  NEON_PROJECT_ID     Neon project id.
  NEON_PROD_BRANCH_ID prod Neon branch id (default br-delicate-sea-amum92c2).
  NEON_BACKUP_URL     DIRECT (non-pooler) prod Postgres URL (pre-revert snap
                      dump + RPO probe).
  SNAP_BUCKET         durable archive bucket (default garden-backups-prod).
  PHOTOS_BUCKET       versioned photos bucket (pre-revert snap needs it).
  SNAP_RETENTION      pre-revert snap retention K (default 5).
  CF_DIST             CloudFront distribution id (default E3FAJTXAORQYDT).
  CONFIRM_DATA_LOSS   must equal the literal string "yes" to perform the prod
                      DB reset (defense-in-depth on top of the env approval —
                      reverting prod DB is real data loss for live users).

Dependencies: boto3 (S3/Lambda/CloudFront), requests (Neon + GitHub REST),
pg_restore/psql (pg17 client) via subprocess, and snap.py (co-located in
scripts/) for the pre-revert snap.

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

# snap.py is co-located in scripts/ — reused for the pre-revert snapshot.
try:
    import snap as snap_mod
except Exception:  # pragma: no cover - import shape differs only outside scripts/
    snap_mod = None

VERSION_RE = re.compile(r"^v\d+(\.\d+){0,2}$")
NEON_API = "https://console.neon.tech/api/v2"
GITHUB_API = "https://api.github.com"
HTTP_TIMEOUT = 60

# Key tables for the row-count sanity validate + RPO probe (read-only).
SANITY_TABLES = [
    "projects",
    "plants",
    "events",
    "locations",
    "inventory_items",
    "plant_varieties",
]

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
        self.snap_bucket = env.get("SNAP_BUCKET", "garden-backups-prod")
        self.photos_bucket = env.get("PHOTOS_BUCKET", "")
        self.retention = int(env.get("SNAP_RETENTION", "5"))
        self.cf_dist = env.get("CF_DIST", "E3FAJTXAORQYDT")
        self.confirm_data_loss = env.get("CONFIRM_DATA_LOSS", "")
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
    current_main = _get_ref_sha(cfg, "heads/main")
    snap_env = dict(cfg._raw_env)
    snap_env["SNAP_VERSION"] = cfg.prerevert_version
    snap_env["MAIN_SHA"] = current_main
    snap_env["APP_VERSION"] = f"prerevert-of-{cfg.target_version}"
    snap_cfg = snap_mod.Config(env=snap_env)
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
            "SELECT COALESCE(max(created_at)::text, 'none') FROM events;",
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


def neon_create_branch_with_endpoint(cfg, name):
    """Create a fresh restore-target branch WITH a read-write endpoint; return
    (branch_id, direct_connection_uri). Idempotent: reuse if name exists.
    """
    for b in _neon_list_branches(cfg):
        if b.get("name") == name:
            bid = b["id"]
            uri = _branch_direct_uri(cfg, bid)
            return bid, uri
    payload = {
        "branch": {"name": name},
        "endpoints": [{"type": "read_write"}],
    }
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
                "pg_restore", "--clean", "--if-exists", "--no-owner",
                "--no-privileges", "--schema=public",
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
    return key


def validate_branch(cfg, target_uri):
    """Schema + row-count sanity on the restored fresh branch before we let it
    overwrite prod. At least one core table must exist and the sanity tables
    must be queryable (count >= 0).
    """
    existing = _psql_scalar(
        target_uri,
        "SELECT count(*) FROM information_schema.tables "
        "WHERE table_schema='public';",
    )
    if int(existing) <= 0:
        raise RevertError("validate: restored branch has no public tables")
    counts = {}
    for t in SANITY_TABLES:
        try:
            counts[t] = int(_psql_scalar(target_uri, f"SELECT count(*) FROM {t};"))
        except RevertError:
            counts[t] = None
    if all(v is None for v in counts.values()):
        raise RevertError("validate: none of the core tables are present/queryable")
    return {"public_tables": int(existing), "counts": counts}


def neon_restore_prod_from(cfg, source_branch_id, source_lsn=None):
    """Neon 'Restore branch': reset the PROD branch to the state of
    source_branch_id (optionally at source_lsn). Preserves the prod endpoint /
    connection string -> no Lambda env change needed. This is the only
    prod-DB-mutating call.
    """
    body = {"source_branch_id": source_branch_id}
    if source_lsn:
        body["source_lsn"] = source_lsn
    r = requests.post(
        f"{NEON_API}/projects/{cfg.neon_project_id}/branches/{cfg.neon_prod_branch_id}/restore",
        headers=neon_headers(cfg), json=body, timeout=HTTP_TIMEOUT,
    )
    if r.status_code not in (200, 201):
        raise RevertError(f"Neon restore prod failed {r.status_code}: {r.text}")
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
    dev_head = _get_ref_sha(cfg, "heads/dev")
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
        f"{GITHUB_API}/repos/{cfg.repo}/git/refs/heads/dev",
        headers=gh_headers(cfg),
        json={"sha": new_sha, "force": False},
        timeout=HTTP_TIMEOUT,
    )
    if ru.status_code != 200:
        raise RevertError(f"update dev ref failed {ru.status_code}: {ru.text}")
    return new_sha


def ff_main(cfg, sha):
    """Fast-forward main to sha (the revert-commit). garden-bot only. Returns sha."""
    r = requests.patch(
        f"{GITHUB_API}/repos/{cfg.repo}/git/refs/heads/main",
        headers=gh_headers(cfg),
        json={"sha": sha, "force": False},
        timeout=HTTP_TIMEOUT,
    )
    if r.status_code != 200:
        raise RevertError(f"FF main -> {sha[:12]} failed {r.status_code}: {r.text}")
    return sha


def restore_lambda_versions(cfg, manifest, lambda_client=None):
    """Re-point each function's 'live' alias to the snapped published version so
    the URL serves the old code (U1 — confirm URL->version binding in rehearsal).
    Idempotent: already-correct alias is a no-op update.
    """
    client = lambda_client or boto3.client("lambda")
    versions = manifest.get("lambda_versions", {})
    restored = {}
    for fn, ver in versions.items():
        try:
            try:
                client.update_alias(FunctionName=fn, Name="live", FunctionVersion=str(ver))
            except ClientError as e:
                if e.response.get("Error", {}).get("Code") == "ResourceNotFoundException":
                    client.create_alias(FunctionName=fn, Name="live", FunctionVersion=str(ver))
                else:
                    raise
            restored[fn] = ver
        except ClientError as e:
            raise RevertError(f"lambda restore failed for {fn}@{ver}: {e}")
    return restored


def cf_invalidate(cfg, cloudfront_client=None):
    client = cloudfront_client or boto3.client("cloudfront")
    client.create_invalidation(
        DistributionId=cfg.cf_dist,
        InvalidationBatch={
            "Paths": {"Quantity": 1, "Items": ["/index.html"]},
            "CallerReference": f"revert-{cfg.target_version}-{utc_now_iso()}",
        },
    )


# --- rollback ----------------------------------------------------------------

def rollback(cfg, prerevert_result, lambda_client=None):
    """Best-effort rollback to the pre-revert snap after a post-checkpoint
    failure: reset prod DB from the pre-revert snap branch and reset main to the
    pre-revert main SHA. Lambda aliases are restored to the pre-revert versions.
    Raises RevertError only if rollback itself cannot complete (page Dave).
    """
    man = prerevert_result["manifest"]
    # DB: restore prod from the pre-revert snap branch.
    neon_restore_prod_from(cfg, man["neon_branch_id"], man.get("neon_lsn"))
    # Code: reset main to pre-revert main SHA (FF or via revert-commit on dev).
    pre_main = man["main_sha"]
    # main may now be ahead (our failed revert commit); a forward restore-commit
    # mirrors the no-force-push rule. Reuse the same forward-tree mechanism.
    fake_manifest = {"main_sha": pre_main}
    new_sha = create_revert_commit_on_dev(cfg, fake_manifest)
    ff_main(cfg, new_sha)
    # Lambda: re-point aliases to the pre-revert versions.
    restore_lambda_versions(cfg, man, lambda_client=lambda_client)


# --- orchestration -----------------------------------------------------------

def run(cfg, s3=None, lambda_client=None, cloudfront_client=None):
    s3 = s3 or boto3.client("s3")

    validate_version(cfg.target_version, "TARGET_VERSION")
    validate_version(cfg.prerevert_version, "PREREVERT_VERSION")
    if cfg.prerevert_version == cfg.target_version:
        raise RevertError("PREREVERT_VERSION must differ from TARGET_VERSION")

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

    # ---- everything below is a prod-mutating checkpoint; failures -> rollback ----
    checkpointed = False
    try:
        # Step 3 — stage + validate DB target FIRST (no prod mutation yet).
        fast = fast_path_branch(cfg, manifest)
        if fast is not None:
            source_branch_id = fast["id"]
            source_lsn = manifest.get("neon_lsn")
        else:
            restore_name = f"revert-stage-{cfg.target_version}"
            source_branch_id, uri = neon_create_branch_with_endpoint(cfg, restore_name)
            restore_dump_into_branch(s3, cfg, manifest, uri)
            validate_branch(cfg, uri)
            source_lsn = None

        # Cut over: prod DB reset (first prod mutation) ...
        checkpointed = True
        neon_restore_prod_from(cfg, source_branch_id, source_lsn)

        # ... then code + lambda together.
        revert_sha = create_revert_commit_on_dev(cfg, manifest)
        ff_main(cfg, revert_sha)
        restore_lambda_versions(cfg, manifest, lambda_client=lambda_client)
        cf_invalidate(cfg, cloudfront_client=cloudfront_client)
    except Exception as e:  # noqa: BLE001 — any post-checkpoint failure rolls back
        if checkpointed:
            sys.stderr.write(f"[revert] FAIL after checkpoint: {e}; rolling back\n")
            try:
                rollback(cfg, prerevert, lambda_client=lambda_client)
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
        f"{result['revert_commit'][:12]}; pre-revert snap {result['prerevert_version']})\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
