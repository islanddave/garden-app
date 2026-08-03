"""Unit tests for snap.py. All AWS/Neon/GitHub/subprocess calls are mocked.

Run: pytest -q test_snap.py
"""
import json
from unittest import mock

import pytest

import snap


BASE_ENV = {
    "GH_TOKEN": "ghs_xxx",
    "GITHUB_REPOSITORY": "owner/garden-app",
    "MAIN_SHA": "a" * 40,
    "SNAP_VERSION": "v1.2.3",
    "NEON_API_KEY": "neon_xxx",
    "NEON_PROJECT_ID": "proj-123",
    "NEON_BACKUP_URL": "postgres://u:p@direct.host/db",
    "PHOTOS_BUCKET": "garden-photos-prod-test",
    "APP_VERSION": "1.2.3",
}


def make_cfg(**overrides):
    env = dict(BASE_ENV)
    env.update(overrides)
    return snap.Config(env=env)


# --- version validation ------------------------------------------------------

@pytest.mark.parametrize("good", ["v1", "v1.2", "v1.2.3", "v0", "v10.20.30"])
def test_validate_good(good):
    assert snap.validate(good) == good


@pytest.mark.parametrize(
    "bad",
    ["1.2.3", "v", "vx", "v1.", "v1.2.3.4", "V1", "v1.2.3-rc1", "v1 ; rm -rf /", ""],
)
def test_validate_bad(bad):
    with pytest.raises(snap.SnapError):
        snap.validate(bad)


def test_config_requires_photos_bucket():
    env = dict(BASE_ENV)
    del env["PHOTOS_BUCKET"]
    with pytest.raises(snap.SnapError):
        snap.Config(env=env)


def test_config_defaults():
    cfg = make_cfg()
    assert cfg.snap_bucket == "garden-snapshots-prod"
    assert cfg.branch_prefix == "snap-"
    assert cfg.cf_dist == "E3FAJTXAORQYDT"
    assert cfg.neon_prod_branch_id == "br-delicate-sea-amum92c2"
    assert cfg.retention == 5


def test_config_retention_empty_string_uses_default():
    # GHA renders an unset ${{ vars.SNAP_RETENTION }} as "" — int("") ValueError before.
    assert make_cfg(SNAP_RETENTION="").retention == 5
    assert make_cfg(SNAP_RETENTION="  ").retention == 5


def test_config_retention_clamped_to_one():
    assert make_cfg(SNAP_RETENTION="0").retention == 1
    assert make_cfg(SNAP_RETENTION="-3").retention == 1


def test_config_retention_garbage_raises():
    with pytest.raises(snap.SnapError):
        make_cfg(SNAP_RETENTION="five")


def test_config_snap_bucket_empty_string_uses_default():
    assert make_cfg(SNAP_BUCKET="").snap_bucket == "garden-snapshots-prod"


def test_config_branch_prefix_override():
    assert make_cfg(SNAP_BRANCH_PREFIX="rehearsal-snap-").branch_prefix == "rehearsal-snap-"
    assert make_cfg(SNAP_BRANCH_PREFIX="").branch_prefix == "snap-"


# --- idempotent tag skip -----------------------------------------------------

def _resp(status, payload=None, text=""):
    m = mock.Mock()
    m.status_code = status
    m.json.return_value = payload or {}
    m.text = text
    return m


def test_ensure_tag_idempotent_skip(monkeypatch):
    cfg = make_cfg()
    # ref GET 200 (annotated tag object), then tag-object GET resolving to MAIN_SHA
    def fake_get(url, **kw):
        if "/git/ref/tags/" in url:
            return _resp(200, {"object": {"sha": "tagobj"}})
        if "/git/tags/tagobj" in url:
            return _resp(200, {"object": {"sha": cfg.main_sha}})
        raise AssertionError(url)
    post = mock.Mock()
    monkeypatch.setattr(snap.requests, "get", fake_get)
    monkeypatch.setattr(snap.requests, "post", post)
    assert snap.ensure_tag(cfg) == "v1.2.3"
    post.assert_not_called()  # idempotent: no create


def test_ensure_tag_conflict_different_sha(monkeypatch):
    cfg = make_cfg()
    def fake_get(url, **kw):
        if "/git/ref/tags/" in url:
            return _resp(200, {"object": {"sha": "tagobj"}})
        if "/git/tags/tagobj" in url:
            return _resp(200, {"object": {"sha": "b" * 40}})
        raise AssertionError(url)
    monkeypatch.setattr(snap.requests, "get", fake_get)
    monkeypatch.setattr(snap.requests, "post", mock.Mock())
    with pytest.raises(snap.SnapError):
        snap.ensure_tag(cfg)


def test_ensure_tag_creates_when_absent(monkeypatch):
    cfg = make_cfg()
    monkeypatch.setattr(snap.requests, "get", lambda url, **kw: _resp(404))
    posts = []
    def fake_post(url, **kw):
        posts.append(url)
        if url.endswith("/git/tags"):
            return _resp(201, {"sha": "newtagobj"})
        if url.endswith("/git/refs"):
            return _resp(201, {})
        raise AssertionError(url)
    monkeypatch.setattr(snap.requests, "post", fake_post)
    assert snap.ensure_tag(cfg) == "v1.2.3"
    assert any(u.endswith("/git/tags") for u in posts)
    assert any(u.endswith("/git/refs") for u in posts)


# --- idempotent Neon branch skip ---------------------------------------------

def test_ensure_neon_branch_idempotent(monkeypatch):
    cfg = make_cfg()
    monkeypatch.setattr(
        snap, "_neon_list_branches",
        lambda c: [{"id": "br-existing", "name": "snap-v1.2.3",
                    "current_state_lsn": "0/ABC"}],
    )
    post = mock.Mock()
    monkeypatch.setattr(snap.requests, "post", post)
    bid, lsn = snap.ensure_neon_branch(cfg)
    assert bid == "br-existing"
    assert lsn == "0/ABC"
    post.assert_not_called()


def test_ensure_neon_branch_creates(monkeypatch):
    cfg = make_cfg()
    monkeypatch.setattr(snap, "_neon_list_branches", lambda c: [])
    monkeypatch.setattr(
        snap.requests, "post",
        lambda url, **kw: _resp(201, {"branch": {"id": "br-new",
                                                  "current_state_lsn": "0/DEF"}}),
    )
    bid, lsn = snap.ensure_neon_branch(cfg)
    assert bid == "br-new"
    assert lsn == "0/DEF"


def test_ensure_neon_branch_uses_prefix(monkeypatch):
    cfg = make_cfg(SNAP_BRANCH_PREFIX="rehearsal-snap-")
    monkeypatch.setattr(snap, "_neon_list_branches", lambda c: [])
    payloads = []
    def fake_post(url, json=None, **kw):
        payloads.append(json)
        return _resp(201, {"branch": {"id": "br-r", "current_state_lsn": "0/1"}})
    monkeypatch.setattr(snap.requests, "post", fake_post)
    bid, _ = snap.ensure_neon_branch(cfg)
    assert bid == "br-r"
    assert payloads[0]["branch"]["name"] == "rehearsal-snap-v1.2.3"


# --- dump idempotent skip ----------------------------------------------------

def test_dump_to_s3_skip_if_exists(monkeypatch):
    cfg = make_cfg()
    s3 = mock.Mock()
    monkeypatch.setattr(snap, "s3_object_exists", lambda *a, **k: True)
    sub = mock.Mock()
    monkeypatch.setattr(snap.subprocess, "run", sub)
    key = snap.dump_to_s3(s3, cfg)
    assert key == "db/snap-v1.2.3.dump"
    sub.assert_not_called()  # no pg_dump on skip
    s3.upload_file.assert_not_called()


def test_dump_to_s3_runs_pg_dump(monkeypatch, tmp_path):
    cfg = make_cfg()
    s3 = mock.Mock()
    monkeypatch.setattr(snap, "s3_object_exists", lambda *a, **k: False)
    cmds = []

    def fake_run(cmd, **kw):
        # pg_dump is passed args (no shell); write a non-empty file at -f path
        cmds.append(cmd)
        fpath = cmd[cmd.index("-f") + 1]
        with open(fpath, "wb") as fh:
            fh.write(b"PGDMP\x00data")
        r = mock.Mock(); r.returncode = 0; r.stderr = ""
        return r

    monkeypatch.setattr(snap.subprocess, "run", fake_run)
    key = snap.dump_to_s3(s3, cfg)
    assert key == "db/snap-v1.2.3.dump"
    s3.upload_file.assert_called_once()
    # Gate 0.1: FULL-database dump — any schema filter would silently drop the
    # extensions + gv schemas the restore-from-empty path needs.
    assert not any("--schema" in arg or arg == "-n" for arg in cmds[0])


def test_dump_globals_runs_pg_dumpall(monkeypatch):
    cfg = make_cfg()
    s3 = mock.Mock()
    monkeypatch.setattr(snap, "s3_object_exists", lambda *a, **k: False)
    cmds = []

    def fake_run(cmd, **kw):
        cmds.append(cmd)
        fpath = cmd[cmd.index("-f") + 1]
        with open(fpath, "w") as fh:
            fh.write("CREATE ROLE neondb_owner;\n")
        r = mock.Mock(); r.returncode = 0; r.stderr = ""
        return r

    monkeypatch.setattr(snap.subprocess, "run", fake_run)
    key = snap.dump_globals_to_s3(s3, cfg)
    assert key == "db/snap-v1.2.3.globals.sql"
    s3.upload_file.assert_called_once()
    assert cmds[0][0] == "pg_dumpall"
    assert "--globals-only" in cmds[0]
    # Neon manages role credentials; SCRAM hashes must not land in S3.
    assert "--no-role-passwords" in cmds[0]


def test_dump_globals_skip_if_exists(monkeypatch):
    cfg = make_cfg()
    s3 = mock.Mock()
    monkeypatch.setattr(snap, "s3_object_exists", lambda *a, **k: True)
    sub = mock.Mock()
    monkeypatch.setattr(snap.subprocess, "run", sub)
    assert snap.dump_globals_to_s3(s3, cfg) == "db/snap-v1.2.3.globals.sql"
    sub.assert_not_called()
    s3.upload_file.assert_not_called()


def test_dump_globals_fails_on_nonzero(monkeypatch):
    cfg = make_cfg()
    s3 = mock.Mock()
    monkeypatch.setattr(snap, "s3_object_exists", lambda *a, **k: False)
    r = mock.Mock(); r.returncode = 1; r.stderr = "pg_authid denied"
    monkeypatch.setattr(snap.subprocess, "run", lambda cmd, **kw: r)
    with pytest.raises(snap.SnapError):
        snap.dump_globals_to_s3(s3, cfg)


def test_dump_to_s3_fails_on_nonzero(monkeypatch):
    cfg = make_cfg()
    s3 = mock.Mock()
    monkeypatch.setattr(snap, "s3_object_exists", lambda *a, **k: False)
    r = mock.Mock(); r.returncode = 1; r.stderr = "boom"
    monkeypatch.setattr(snap.subprocess, "run", lambda cmd, **kw: r)
    with pytest.raises(snap.SnapError):
        snap.dump_to_s3(s3, cfg)


# --- photo versions ----------------------------------------------------------

def test_capture_photo_versions(monkeypatch):
    cfg = make_cfg()
    s3 = mock.Mock()
    monkeypatch.setattr(snap, "s3_object_exists", lambda *a, **k: False)
    pag = mock.Mock()
    pag.paginate.return_value = [
        {"Versions": [
            {"Key": "a.jpg", "VersionId": "v-a1", "IsLatest": True},
            {"Key": "a.jpg", "VersionId": "v-a0", "IsLatest": False},
            {"Key": "b.jpg", "VersionId": "v-b1", "IsLatest": True},
        ]},
    ]
    s3.get_paginator.return_value = pag
    key = snap.capture_photo_versions(s3, cfg)
    assert key == "photos/snap-v1.2.3.versionids.json"
    body = json.loads(s3.put_object.call_args.kwargs["Body"])
    assert body["versions"] == {"a.jpg": "v-a1", "b.jpg": "v-b1"}
    assert body["count"] == 2


def test_capture_photo_versions_skip(monkeypatch):
    cfg = make_cfg()
    s3 = mock.Mock()
    monkeypatch.setattr(snap, "s3_object_exists", lambda *a, **k: True)
    key = snap.capture_photo_versions(s3, cfg)
    assert key == "photos/snap-v1.2.3.versionids.json"
    s3.put_object.assert_not_called()


# --- lambda versions ---------------------------------------------------------

def test_publish_lambda_versions():
    cfg = make_cfg()
    client = mock.Mock()
    client.publish_version.side_effect = lambda FunctionName: {"Version": "7"}
    out = snap.publish_lambda_versions(cfg, lambda_client=client)
    assert set(out.keys()) == set(snap.LAMBDA_FUNCTIONS)
    assert len(out) == 11
    assert all(v == "7" for v in out.values())


def test_publish_lambda_versions_no_version_fails():
    cfg = make_cfg()
    client = mock.Mock()
    client.publish_version.return_value = {}
    with pytest.raises(snap.SnapError):
        snap.publish_lambda_versions(cfg, lambda_client=client)


# --- vX reuse with different sha rejection -----------------------------------

def test_precheck_rejects_different_sha(monkeypatch):
    cfg = make_cfg()
    s3 = mock.Mock()
    monkeypatch.setattr(snap, "s3_object_exists", lambda *a, **k: True)
    monkeypatch.setattr(
        snap, "s3_get_json", lambda *a, **k: {"main_sha": "b" * 40}
    )
    with pytest.raises(snap.SnapError):
        snap.precheck_existing_manifest(s3, cfg)


def test_precheck_allows_same_sha(monkeypatch):
    cfg = make_cfg()
    s3 = mock.Mock()
    monkeypatch.setattr(snap, "s3_object_exists", lambda *a, **k: True)
    monkeypatch.setattr(
        snap, "s3_get_json", lambda *a, **k: {"main_sha": cfg.main_sha}
    )
    out = snap.precheck_existing_manifest(s3, cfg)
    assert out["main_sha"] == cfg.main_sha


def test_precheck_none_when_absent(monkeypatch):
    cfg = make_cfg()
    s3 = mock.Mock()
    monkeypatch.setattr(snap, "s3_object_exists", lambda *a, **k: False)
    assert snap.precheck_existing_manifest(s3, cfg) is None


# --- self-verify aborts ------------------------------------------------------

def test_self_verify_fails_when_dump_missing(monkeypatch):
    cfg = make_cfg()
    s3 = mock.Mock()
    monkeypatch.setattr(snap, "s3_object_exists", lambda s, b, k: False)
    with pytest.raises(snap.SnapError):
        snap.self_verify(s3, cfg, "db/x.dump", "db/x.globals.sql",
                         "photos/x.json", "br-1", "v1.2.3")


def test_self_verify_fails_when_globals_missing(monkeypatch):
    cfg = make_cfg()
    s3 = mock.Mock()
    monkeypatch.setattr(
        snap, "s3_object_exists",
        lambda s, b, k: not k.endswith(".globals.sql"),
    )
    with pytest.raises(snap.SnapError, match="globals"):
        snap.self_verify(s3, cfg, "db/x.dump", "db/x.globals.sql",
                         "photos/x.json", "br-1", "v1.2.3")


# --- retention prune ---------------------------------------------------------

PROD_ID = "br-delicate-sea-amum92c2"  # matches Config default neon_prod_branch_id


def _branch(name, t, parent_id=PROD_ID, **extra):
    b = {"id": f"br-{name}-{t}", "name": name, "created_at": t, "parent_id": parent_id}
    b.update(extra)
    return b


def _pruned_ids(report):
    return [p["id"] for p in report["pruned"]]


def _skipped_ids(report):
    return [s["id"] for s in report["skipped"]]


def test_prune_keeps_k_newest(monkeypatch):
    cfg = make_cfg(SNAP_RETENTION="2")
    branches = [
        {"id": PROD_ID, "name": "production", "created_at": "2026-01-01"},
        _branch("snap-v1", "2026-01-02"),
        _branch("snap-v2", "2026-01-03"),
        _branch("snap-v3", "2026-01-04"),
        _branch("snap-v4", "2026-01-05"),
    ]
    monkeypatch.setattr(snap, "_neon_list_branches", lambda c: branches)
    deleted = []
    def fake_delete(url, **kw):
        deleted.append(url.rsplit("/", 1)[-1])
        return _resp(200)
    monkeypatch.setattr(snap.requests, "delete", fake_delete)
    report = snap.prune_old_branches(cfg)
    # 4 snaps, keep 2 newest (v3,v4) -> prune v1,v2. prod never touched.
    assert _pruned_ids(report) == ["br-snap-v1-2026-01-02", "br-snap-v2-2026-01-03"]
    assert report["skipped"] == []
    assert PROD_ID not in deleted


def test_prune_noop_under_k(monkeypatch):
    cfg = make_cfg(SNAP_RETENTION="5")
    branches = [_branch("snap-v1", "2026-01-02"), _branch("snap-v2", "2026-01-03")]
    monkeypatch.setattr(snap, "_neon_list_branches", lambda c: branches)
    delete = mock.Mock()
    monkeypatch.setattr(snap.requests, "delete", delete)
    assert snap.prune_old_branches(cfg) == {"pruned": [], "skipped": []}
    delete.assert_not_called()


def test_prune_scopes_to_prod_parent(monkeypatch):
    # Gate 4 §14: prefix-named branches under a DIFFERENT parent (e.g. prod
    # snapshots seen from a staging-pointed rehearsal) are not candidates.
    cfg = make_cfg(SNAP_RETENTION="1")
    branches = [
        _branch("snap-v1", "2026-01-02"),
        _branch("snap-v2", "2026-01-03"),
        _branch("snap-v8", "2026-01-04", parent_id="br-other-parent"),
        _branch("snap-v9", "2026-01-05", parent_id="br-other-parent"),
    ]
    monkeypatch.setattr(snap, "_neon_list_branches", lambda c: branches)
    deleted = []
    def fake_delete(url, **kw):
        deleted.append(url.rsplit("/", 1)[-1])
        return _resp(200)
    monkeypatch.setattr(snap.requests, "delete", fake_delete)
    report = snap.prune_old_branches(cfg)
    assert _pruned_ids(report) == ["br-snap-v1-2026-01-02"]
    assert all("other-parent" not in d for d in deleted)


def test_prune_respects_branch_prefix(monkeypatch):
    cfg = make_cfg(SNAP_RETENTION="1", SNAP_BRANCH_PREFIX="rehearsal-snap-")
    branches = [
        _branch("snap-v1", "2026-01-02"),
        _branch("rehearsal-snap-v0.0.0", "2026-01-03"),
        _branch("rehearsal-snap-v0.0.1", "2026-01-04"),
    ]
    monkeypatch.setattr(snap, "_neon_list_branches", lambda c: branches)
    monkeypatch.setattr(snap.requests, "delete", lambda url, **kw: _resp(200))
    report = snap.prune_old_branches(cfg)
    assert _pruned_ids(report) == ["br-rehearsal-snap-v0.0.0-2026-01-03"]


def test_prune_deny_list(monkeypatch):
    # Deny-list holds even for branches that pass the prefix+parent filter.
    cfg = make_cfg(SNAP_RETENTION="1")
    branches = [
        {"id": PROD_ID, "name": "snap-vprod", "created_at": "2026-01-01",
         "parent_id": PROD_ID},
        _branch("snap-v1", "2026-01-02", default=True),
        _branch("snap-v2", "2026-01-03", protected=True),
        _branch("snap-v3", "2026-01-04"),
        _branch("snap-v4", "2026-01-05"),
    ]
    monkeypatch.setattr(snap, "_neon_list_branches", lambda c: branches)
    deleted = []
    def fake_delete(url, **kw):
        deleted.append(url.rsplit("/", 1)[-1])
        return _resp(200)
    monkeypatch.setattr(snap.requests, "delete", fake_delete)
    report = snap.prune_old_branches(cfg)
    assert _pruned_ids(report) == ["br-snap-v3-2026-01-04"]
    reasons = {s["id"]: s["reason"] for s in report["skipped"]}
    assert reasons[PROD_ID] == "prod branch id"
    assert reasons["br-snap-v1-2026-01-02"] == "default branch"
    assert reasons["br-snap-v2-2026-01-03"] == "protected branch"
    assert PROD_ID not in deleted


def test_prune_deny_listed_names(monkeypatch):
    cfg = make_cfg(SNAP_RETENTION="1", SNAP_BRANCH_PREFIX="")
    branches = [
        _branch("main", "2026-01-01"),
        _branch("staging", "2026-01-02"),
        _branch("production", "2026-01-03"),
        _branch("snap-v1", "2026-01-04"),
        _branch("snap-v2", "2026-01-05"),
    ]
    monkeypatch.setattr(snap, "_neon_list_branches", lambda c: branches)
    monkeypatch.setattr(snap.requests, "delete", lambda url, **kw: _resp(200))
    # empty prefix in env falls back to "snap-" (Config), so force it directly
    # to prove the name deny-list is load-bearing even with no prefix guard.
    cfg.branch_prefix = ""
    report = snap.prune_old_branches(cfg)
    assert _pruned_ids(report) == ["br-snap-v1-2026-01-04"]
    assert {s["reason"] for s in report["skipped"][:3]} == {"deny-listed name"}


def test_prune_age_floor(monkeypatch):
    from datetime import datetime, timedelta, timezone
    cfg = make_cfg(SNAP_RETENTION="1")
    fresh = (datetime.now(timezone.utc) - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    branches = [
        _branch("snap-v1", fresh),
        _branch("snap-v2", "2026-01-03"),
        _branch("snap-v3", "2026-01-04"),
    ]
    monkeypatch.setattr(snap, "_neon_list_branches", lambda c: branches)
    monkeypatch.setattr(snap.requests, "delete", lambda url, **kw: _resp(200))
    report = snap.prune_old_branches(cfg)
    # fresh branch sorts LAST (newest) so k=1 keeps it; both old candidates
    # clear the 24h floor and are deleted.
    assert _pruned_ids(report) == ["br-snap-v2-2026-01-03", "br-snap-v3-2026-01-04"]
    assert report["skipped"] == []


def test_prune_age_floor_blocks_young_candidate(monkeypatch):
    from datetime import datetime, timedelta, timezone
    cfg = make_cfg(SNAP_RETENTION="1")
    t0 = (datetime.now(timezone.utc) - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
    t1 = (datetime.now(timezone.utc) - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    branches = [_branch("snap-v1", t0), _branch("snap-v2", t1)]
    monkeypatch.setattr(snap, "_neon_list_branches", lambda c: branches)
    delete = mock.Mock()
    monkeypatch.setattr(snap.requests, "delete", delete)
    report = snap.prune_old_branches(cfg)
    assert report["pruned"] == []
    assert len(report["skipped"]) == 1
    assert "age floor" in report["skipped"][0]["reason"]
    delete.assert_not_called()


def test_prune_unparseable_created_at_skipped(monkeypatch):
    cfg = make_cfg(SNAP_RETENTION="1")
    # "1999-junk" string-sorts before any real 2026 timestamp, so the
    # unparseable branch lands in the delete window and hits the age guard.
    branches = [
        _branch("snap-v1", "1999-junk"),
        _branch("snap-v2", "2026-01-03"),
    ]
    monkeypatch.setattr(snap, "_neon_list_branches", lambda c: branches)
    delete = mock.Mock()
    monkeypatch.setattr(snap.requests, "delete", delete)
    report = snap.prune_old_branches(cfg)
    assert report["pruned"] == []
    assert report["skipped"][0]["reason"] == "age floor (unparseable created_at)"
    delete.assert_not_called()


def test_prune_404_treated_as_success(monkeypatch):
    cfg = make_cfg(SNAP_RETENTION="1")
    branches = [_branch("snap-v1", "2026-01-02"), _branch("snap-v2", "2026-01-03")]
    monkeypatch.setattr(snap, "_neon_list_branches", lambda c: branches)
    monkeypatch.setattr(snap.requests, "delete", lambda url, **kw: _resp(404, text="not found"))
    report = snap.prune_old_branches(cfg)
    assert _pruned_ids(report) == ["br-snap-v1-2026-01-02"]
    assert report["pruned"][0]["note"] == "already absent (404)"
    assert report["skipped"] == []


@pytest.mark.parametrize("status", [422, 423])
def test_prune_422_423_skip_and_report(monkeypatch, status):
    cfg = make_cfg(SNAP_RETENTION="1")
    branches = [_branch("snap-v1", "2026-01-02"), _branch("snap-v2", "2026-01-03")]
    monkeypatch.setattr(snap, "_neon_list_branches", lambda c: branches)
    monkeypatch.setattr(
        snap.requests, "delete",
        lambda url, **kw: _resp(status, text="cannot delete branch that has children"),
    )
    report = snap.prune_old_branches(cfg)  # must NOT raise
    assert report["pruned"] == []
    assert len(report["skipped"]) == 1
    assert f"HTTP {status}" in report["skipped"][0]["reason"]
    assert report["skipped"][0]["name"] == "snap-v1"


def test_prune_partial_failure(monkeypatch):
    cfg = make_cfg(SNAP_RETENTION="1")
    branches = [
        _branch("snap-v1", "2026-01-02"),
        _branch("snap-v2", "2026-01-03"),
        _branch("snap-v3", "2026-01-04"),
    ]
    monkeypatch.setattr(snap, "_neon_list_branches", lambda c: branches)
    def fake_delete(url, **kw):
        if url.endswith("br-snap-v1-2026-01-02"):
            return _resp(422, text="has children")
        return _resp(200)
    monkeypatch.setattr(snap.requests, "delete", fake_delete)
    report = snap.prune_old_branches(cfg)
    assert _pruned_ids(report) == ["br-snap-v2-2026-01-03"]
    assert _skipped_ids(report) == ["br-snap-v1-2026-01-02"]


def test_prune_k_clamped_in_prune(monkeypatch):
    # Even a hand-built cfg with retention 0 must keep at least 1 snapshot.
    cfg = make_cfg(SNAP_RETENTION="1")
    cfg.retention = 0
    branches = [_branch("snap-v1", "2026-01-02"), _branch("snap-v2", "2026-01-03")]
    monkeypatch.setattr(snap, "_neon_list_branches", lambda c: branches)
    monkeypatch.setattr(snap.requests, "delete", lambda url, **kw: _resp(200))
    report = snap.prune_old_branches(cfg)
    assert _pruned_ids(report) == ["br-snap-v1-2026-01-02"]


def test_prune_emits_warnings_for_skips(monkeypatch, capsys):
    cfg = make_cfg(SNAP_RETENTION="1")
    branches = [_branch("snap-v1", "2026-01-02"), _branch("snap-v2", "2026-01-03")]
    monkeypatch.setattr(snap, "_neon_list_branches", lambda c: branches)
    monkeypatch.setattr(snap.requests, "delete", lambda url, **kw: _resp(423, text="locked"))
    snap.prune_old_branches(cfg)
    out = capsys.readouterr().out
    assert "::warning::" in out
    assert "snap-v1" in out  # branch NAME, not just id (Gate 2 §8)


def test_prune_writes_step_summary(monkeypatch, tmp_path):
    cfg = make_cfg(SNAP_RETENTION="1")
    summary = tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
    branches = [_branch("snap-v1", "2026-01-02"), _branch("snap-v2", "2026-01-03")]
    monkeypatch.setattr(snap, "_neon_list_branches", lambda c: branches)
    monkeypatch.setattr(snap.requests, "delete", lambda url, **kw: _resp(200))
    snap.prune_old_branches(cfg)
    text = summary.read_text()
    assert "snap prune" in text
    assert "snap-v1" in text


# --- manifest written LAST ---------------------------------------------------

def _patch_run_steps(monkeypatch, order):
    monkeypatch.setattr(snap, "precheck_existing_manifest", lambda s, c: None)
    monkeypatch.setattr(snap, "ensure_tag",
                        lambda c: order.append("tag") or "v1.2.3")
    monkeypatch.setattr(snap, "ensure_neon_branch",
                        lambda c: order.append("neon") or ("br-1", "0/ABC"))
    monkeypatch.setattr(snap, "dump_to_s3",
                        lambda s, c: order.append("dump") or "db/snap-v1.2.3.dump")
    monkeypatch.setattr(snap, "dump_globals_to_s3",
                        lambda s, c: order.append("globals") or "db/snap-v1.2.3.globals.sql")
    monkeypatch.setattr(snap, "capture_photo_versions",
                        lambda s, c: order.append("photos") or "photos/snap-v1.2.3.versionids.json")
    monkeypatch.setattr(snap, "publish_lambda_versions",
                        lambda c, lambda_client=None: order.append("lambda") or {"garden-plants": "3"})
    monkeypatch.setattr(snap, "self_verify",
                        lambda *a, **k: order.append("verify"))


def test_run_writes_manifest_last(monkeypatch):
    cfg = make_cfg()
    s3 = mock.Mock()
    order = []
    manifests = []
    _patch_run_steps(monkeypatch, order)
    def fake_write(s, c, m):
        order.append("manifest")
        manifests.append(json.loads(json.dumps(m)))
        return "snapshots/v1.2.3.json"
    monkeypatch.setattr(snap, "write_manifest", fake_write)
    monkeypatch.setattr(snap, "prune_old_branches",
                        lambda c: order.append("prune") or
                        {"pruned": [{"id": "br-old", "name": "snap-v0"}], "skipped": []})

    result = snap.run(cfg, s3=s3, lambda_client=mock.Mock())
    # manifest must come AFTER every artifact + self-verify
    mi = order.index("manifest")
    for step in ("tag", "neon", "dump", "globals", "photos", "lambda", "verify"):
        assert order.index(step) < mi, f"{step} must precede manifest"
    # prune runs after the commit-marker manifest
    assert order.index("prune") > mi
    assert result["manifest"]["git_tag"] == "v1.2.3"
    assert result["manifest"]["cf_dist"] == "E3FAJTXAORQYDT"
    assert result["manifest"]["globals_s3_key"] == "db/snap-v1.2.3.globals.sql"
    # commit-marker manifest has no prune report; the post-prune rewrite does
    assert "prune" not in manifests[0]
    assert manifests[1]["prune"]["pruned"][0]["name"] == "snap-v0"
    assert result["pruned"] == [{"id": "br-old", "name": "snap-v0"}]
    assert result["skipped"] == []


def test_run_prune_false_skips_prune(monkeypatch):
    # revert-to.py contract: the pre-revert snap must not prune (it could
    # delete the very snapshot being restored).
    cfg = make_cfg()
    s3 = mock.Mock()
    order = []
    _patch_run_steps(monkeypatch, order)
    monkeypatch.setattr(snap, "write_manifest", lambda s, c, m: "snapshots/v1.2.3.json")
    prune = mock.Mock()
    monkeypatch.setattr(snap, "prune_old_branches", prune)
    result = snap.run(cfg, s3=s3, lambda_client=mock.Mock(), prune=False)
    prune.assert_not_called()
    assert result["pruned"] == []
    assert result["skipped"] == []
    assert "prune" not in result["manifest"]


def test_run_aborts_if_self_verify_fails(monkeypatch):
    cfg = make_cfg()
    s3 = mock.Mock()
    monkeypatch.setattr(snap, "precheck_existing_manifest", lambda s, c: None)
    monkeypatch.setattr(snap, "ensure_tag", lambda c: "v1.2.3")
    monkeypatch.setattr(snap, "ensure_neon_branch", lambda c: ("br-1", "0/ABC"))
    monkeypatch.setattr(snap, "dump_to_s3", lambda s, c: "db/x.dump")
    monkeypatch.setattr(snap, "dump_globals_to_s3", lambda s, c: "db/x.globals.sql")
    monkeypatch.setattr(snap, "capture_photo_versions", lambda s, c: "photos/x.json")
    monkeypatch.setattr(snap, "publish_lambda_versions",
                        lambda c, lambda_client=None: {"garden-plants": "3"})
    def boom(*a, **k):
        raise snap.SnapError("artifact missing")
    monkeypatch.setattr(snap, "self_verify", boom)
    wm = mock.Mock()
    monkeypatch.setattr(snap, "write_manifest", wm)
    with pytest.raises(snap.SnapError):
        snap.run(cfg, s3=s3, lambda_client=mock.Mock())
    wm.assert_not_called()  # manifest never written when self-verify fails


# --- main() exit codes -------------------------------------------------------

def test_main_returns_nonzero_on_snaperror(monkeypatch):
    monkeypatch.setattr(snap.Config, "__init__",
                        lambda self, env=None: (_ for _ in ()).throw(snap.SnapError("x")))
    assert snap.main([]) == 1


def test_main_returns_zero_on_success(monkeypatch):
    monkeypatch.setattr(snap.Config, "__init__", lambda self, env=None: None)
    fake_cfg_attrs = {"snap_bucket": "b"}
    for k, v in fake_cfg_attrs.items():
        setattr(snap.Config, k, v)
    monkeypatch.setattr(
        snap, "run",
        lambda cfg: {"manifest_key": "snapshots/v1.json",
                     "manifest": {"git_tag": "v1"}, "pruned": [], "skipped": []},
    )
    assert snap.main([]) == 0
