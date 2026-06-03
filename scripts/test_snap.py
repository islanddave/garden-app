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
    assert cfg.snap_bucket == "garden-backups-prod"
    assert cfg.cf_dist == "E3FAJTXAORQYDT"
    assert cfg.neon_prod_branch_id == "br-delicate-sea-amum92c2"
    assert cfg.retention == 5


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

    def fake_run(cmd, **kw):
        # pg_dump is passed args (no shell); write a non-empty file at -f path
        fpath = cmd[cmd.index("-f") + 1]
        with open(fpath, "wb") as fh:
            fh.write(b"PGDMP\x00data")
        r = mock.Mock(); r.returncode = 0; r.stderr = ""
        return r

    monkeypatch.setattr(snap.subprocess, "run", fake_run)
    key = snap.dump_to_s3(s3, cfg)
    assert key == "db/snap-v1.2.3.dump"
    s3.upload_file.assert_called_once()


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
        snap.self_verify(s3, cfg, "db/x.dump", "photos/x.json", "br-1", "v1.2.3")


# --- retention prune ---------------------------------------------------------

def _branch(name, t):
    return {"id": f"br-{name}-{t}", "name": name, "created_at": t}


def test_prune_keeps_k_newest(monkeypatch):
    cfg = make_cfg(SNAP_RETENTION="2")
    branches = [
        {"id": "br-prod", "name": "production", "created_at": "2026-01-01"},
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
    pruned = snap.prune_old_branches(cfg)
    # 4 snaps, keep 2 newest (v3,v4) -> prune v1,v2. prod never touched.
    assert len(pruned) == 2
    assert "br-snap-v1-2026-01-02" in pruned
    assert "br-snap-v2-2026-01-03" in pruned
    assert all("prod" not in d for d in deleted)


def test_prune_noop_under_k(monkeypatch):
    cfg = make_cfg(SNAP_RETENTION="5")
    branches = [_branch("snap-v1", "2026-01-02"), _branch("snap-v2", "2026-01-03")]
    monkeypatch.setattr(snap, "_neon_list_branches", lambda c: branches)
    delete = mock.Mock()
    monkeypatch.setattr(snap.requests, "delete", delete)
    assert snap.prune_old_branches(cfg) == []
    delete.assert_not_called()


# --- manifest written LAST ---------------------------------------------------

def test_run_writes_manifest_last(monkeypatch):
    cfg = make_cfg()
    s3 = mock.Mock()
    order = []

    monkeypatch.setattr(snap, "precheck_existing_manifest", lambda s, c: None)
    monkeypatch.setattr(snap, "ensure_tag",
                        lambda c: order.append("tag") or "v1.2.3")
    monkeypatch.setattr(snap, "ensure_neon_branch",
                        lambda c: order.append("neon") or ("br-1", "0/ABC"))
    monkeypatch.setattr(snap, "dump_to_s3",
                        lambda s, c: order.append("dump") or "db/snap-v1.2.3.dump")
    monkeypatch.setattr(snap, "capture_photo_versions",
                        lambda s, c: order.append("photos") or "photos/snap-v1.2.3.versionids.json")
    monkeypatch.setattr(snap, "publish_lambda_versions",
                        lambda c, lambda_client=None: order.append("lambda") or {"garden-plants": "3"})
    monkeypatch.setattr(snap, "self_verify",
                        lambda *a, **k: order.append("verify"))
    monkeypatch.setattr(snap, "write_manifest",
                        lambda s, c, m: order.append("manifest") or "snapshots/v1.2.3.json")
    monkeypatch.setattr(snap, "prune_old_branches",
                        lambda c: order.append("prune") or [])

    result = snap.run(cfg, s3=s3, lambda_client=mock.Mock())
    # manifest must come AFTER every artifact + self-verify
    mi = order.index("manifest")
    for step in ("tag", "neon", "dump", "photos", "lambda", "verify"):
        assert order.index(step) < mi, f"{step} must precede manifest"
    # prune is the only thing after manifest
    assert order.index("prune") > mi
    assert result["manifest"]["git_tag"] == "v1.2.3"
    assert result["manifest"]["cf_dist"] == "E3FAJTXAORQYDT"


def test_run_aborts_if_self_verify_fails(monkeypatch):
    cfg = make_cfg()
    s3 = mock.Mock()
    monkeypatch.setattr(snap, "precheck_existing_manifest", lambda s, c: None)
    monkeypatch.setattr(snap, "ensure_tag", lambda c: "v1.2.3")
    monkeypatch.setattr(snap, "ensure_neon_branch", lambda c: ("br-1", "0/ABC"))
    monkeypatch.setattr(snap, "dump_to_s3", lambda s, c: "db/x.dump")
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
                     "manifest": {"git_tag": "v1"}, "pruned": []},
    )
    assert snap.main([]) == 0
