#!/usr/bin/env python3
"""Mocked unit tests for revert-to.py (spec §3 B2). All GitHub/Neon/AWS I/O mocked."""
import importlib.util
import json
import os
import sys
import types

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)


def _load():
    spec = importlib.util.spec_from_file_location("revert_to", os.path.join(HERE, "revert-to.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


rt = _load()


# --- fakes -------------------------------------------------------------------

class FakeResp:
    def __init__(self, status, payload=None, text=""):
        self.status_code = status
        self._payload = payload if payload is not None else {}
        self.text = text or json.dumps(self._payload)

    def json(self):
        return self._payload


class FakeRequests:
    """Programmable requests double. routes: list of (method, substr, FakeResp|callable)."""
    def __init__(self):
        self.routes = []
        self.calls = []

    def add(self, method, substr, resp):
        self.routes.append((method.upper(), substr, resp))

    def _match(self, method, url):
        for m, sub, resp in self.routes:
            if m == method and sub in url:
                return resp(url) if callable(resp) else resp
        raise AssertionError(f"no route for {method} {url}")

    def get(self, url, **k):
        self.calls.append(("GET", url))
        return self._match("GET", url)

    def post(self, url, **k):
        self.calls.append(("POST", url))
        return self._match("POST", url)

    def patch(self, url, **k):
        self.calls.append(("PATCH", url))
        return self._match("PATCH", url)

    def delete(self, url, **k):
        self.calls.append(("DELETE", url))
        return self._match("DELETE", url)


class FakeS3:
    def __init__(self, objects=None):
        self.objects = objects or {}  # (bucket,key) -> bytes
        self.downloads = []

    def get_object(self, Bucket, Key):
        if (Bucket, Key) not in self.objects:
            from botocore.exceptions import ClientError
            raise ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObject")
        return {"Body": types.SimpleNamespace(read=lambda: self.objects[(Bucket, Key)])}

    def download_file(self, Bucket, Key, path):
        self.downloads.append((Bucket, Key))
        with open(path, "wb") as f:
            f.write(self.objects.get((Bucket, Key), b"DUMPDATA"))


def base_env(**over):
    env = {
        "GH_TOKEN": "t", "GITHUB_REPOSITORY": "islanddave/garden-app",
        "TARGET_VERSION": "v2.5.0", "PREREVERT_VERSION": "v2.5.1",
        "NEON_API_KEY": "k", "NEON_PROJECT_ID": "p",
        "NEON_BACKUP_URL": "postgresql://x", "PHOTOS_BUCKET": "garden-photos-prod",
        "CONFIRM_DATA_LOSS": "yes",
    }
    env.update(over)
    return env


def good_manifest():
    return {
        "git_tag": "v2.5.0", "main_sha": "a" * 40, "neon_branch": "snap-v2.5.0",
        "neon_branch_id": "br-snap", "neon_lsn": "0/ABC", "dump_s3_key": "db/snap-v2.5.0.dump",
        "photo_versionids_key": "photos/snap-v2.5.0.versionids.json",
        "lambda_versions": {"garden-plants": "7"}, "cf_dist": "E3FAJTXAORQYDT",
        "app_version": "v2.5.0", "timestamp": "2026-06-03T00:00:00Z",
    }


# --- validation --------------------------------------------------------------

def test_version_validation_good():
    for v in ["v1", "v1.2", "v1.2.3", "v2.5.0"]:
        assert rt.validate_version(v, "X") == v


def test_version_validation_bad():
    for v in ["2.5", "v1.2.3.4", "vX", "v1;rm", ""]:
        with pytest.raises(rt.RevertError):
            rt.validate_version(v, "X")


def test_prerevert_equals_target_rejected(monkeypatch):
    cfg = rt.Config(env=base_env(PREREVERT_VERSION="v2.5.0"))
    with pytest.raises(rt.RevertError):
        rt.run(cfg, s3=FakeS3())


# --- step 1: manifest + tag --------------------------------------------------

def test_load_manifest_missing_fails_closed():
    cfg = rt.Config(env=base_env())
    with pytest.raises(rt.RevertError):
        rt.load_manifest(FakeS3(), cfg)


def test_load_manifest_missing_fields():
    cfg = rt.Config(env=base_env())
    bad = {"git_tag": "v2.5.0"}
    s3 = FakeS3({("garden-backups-prod", "snapshots/v2.5.0.json"): json.dumps(bad).encode()})
    with pytest.raises(rt.RevertError):
        rt.load_manifest(s3, cfg)


def test_load_manifest_tag_mismatch():
    cfg = rt.Config(env=base_env())
    m = good_manifest(); m["git_tag"] = "v9.9.9"
    s3 = FakeS3({("garden-backups-prod", "snapshots/v2.5.0.json"): json.dumps(m).encode()})
    with pytest.raises(rt.RevertError):
        rt.load_manifest(s3, cfg)


def test_load_manifest_ok():
    cfg = rt.Config(env=base_env())
    s3 = FakeS3({("garden-backups-prod", "snapshots/v2.5.0.json"): json.dumps(good_manifest()).encode()})
    m = rt.load_manifest(s3, cfg)
    assert m["main_sha"] == "a" * 40


def test_verify_tag_fail_closed(monkeypatch):
    cfg = rt.Config(env=base_env())
    fr = FakeRequests()
    # tag ref -> lightweight pointing at WRONG commit
    fr.add("GET", "/git/ref/tags/v2.5.0", FakeResp(200, {"object": {"sha": "b" * 40}}))
    fr.add("GET", "/git/tags/", FakeResp(404))  # not an annotated tag object
    monkeypatch.setattr(rt, "requests", fr)
    with pytest.raises(rt.RevertError):
        rt.verify_tag(cfg, good_manifest())


def test_verify_tag_ok_annotated(monkeypatch):
    cfg = rt.Config(env=base_env())
    fr = FakeRequests()
    fr.add("GET", "/git/ref/tags/v2.5.0", FakeResp(200, {"object": {"sha": "tagobj"}}))
    fr.add("GET", "/git/tags/tagobj", FakeResp(200, {"object": {"sha": "a" * 40}}))
    monkeypatch.setattr(rt, "requests", fr)
    assert rt.verify_tag(cfg, good_manifest()) == "a" * 40


# --- step 3: DB pieces -------------------------------------------------------

def test_fast_path_lsn_match(monkeypatch):
    cfg = rt.Config(env=base_env())
    fr = FakeRequests()
    fr.add("GET", "/branches", FakeResp(200, {"branches": [
        {"id": "br-snap", "name": "snap-v2.5.0", "current_state_lsn": "0/ABC"}]}))
    monkeypatch.setattr(rt, "requests", fr)
    b = rt.fast_path_branch(cfg, good_manifest())
    assert b["id"] == "br-snap"


def test_fast_path_lsn_drift_returns_none(monkeypatch):
    cfg = rt.Config(env=base_env())
    fr = FakeRequests()
    fr.add("GET", "/branches", FakeResp(200, {"branches": [
        {"id": "br-snap", "name": "snap-v2.5.0", "current_state_lsn": "0/DIFFERENT"}]}))
    monkeypatch.setattr(rt, "requests", fr)
    assert rt.fast_path_branch(cfg, good_manifest()) is None


def test_fast_path_absent_returns_none(monkeypatch):
    cfg = rt.Config(env=base_env())
    fr = FakeRequests()
    fr.add("GET", "/branches", FakeResp(200, {"branches": []}))
    monkeypatch.setattr(rt, "requests", fr)
    assert rt.fast_path_branch(cfg, good_manifest()) is None


def test_restore_dump_empty_fails(monkeypatch, tmp_path):
    cfg = rt.Config(env=base_env())
    s3 = FakeS3({("garden-backups-prod", "db/snap-v2.5.0.dump"): b""})
    with pytest.raises(rt.RevertError):
        rt.restore_dump_into_branch(s3, cfg, good_manifest(), "postgresql://stage")


def test_restore_dump_pg_restore_error(monkeypatch):
    cfg = rt.Config(env=base_env())
    s3 = FakeS3({("garden-backups-prod", "db/snap-v2.5.0.dump"): b"DUMP"})

    class P:
        returncode = 1
        stderr = "pg_restore: error: connection failed"
        stdout = ""
    monkeypatch.setattr(rt.subprocess, "run", lambda *a, **k: P())
    with pytest.raises(rt.RevertError):
        rt.restore_dump_into_branch(s3, cfg, good_manifest(), "postgresql://stage")


def test_restore_dump_tolerates_benign_warnings(monkeypatch):
    cfg = rt.Config(env=base_env())
    s3 = FakeS3({("garden-backups-prod", "db/snap-v2.5.0.dump"): b"DUMP"})

    class P:
        returncode = 1
        stderr = "pg_restore: warning: errors ignored on restore: 3"
        stdout = ""
    monkeypatch.setattr(rt.subprocess, "run", lambda *a, **k: P())
    # benign-warning tail with no "pg_restore: error:" -> no raise
    assert rt.restore_dump_into_branch(s3, cfg, good_manifest(), "postgresql://s") == "db/snap-v2.5.0.dump"


def test_validate_branch_no_tables(monkeypatch):
    cfg = rt.Config(env=base_env())
    monkeypatch.setattr(rt, "_psql_scalar", lambda url, sql: "0")
    with pytest.raises(rt.RevertError):
        rt.validate_branch(cfg, "postgresql://s")


def test_validate_branch_ok(monkeypatch):
    cfg = rt.Config(env=base_env())
    def fake(url, sql):
        if "information_schema" in sql:
            return "25"
        return "10"
    monkeypatch.setattr(rt, "_psql_scalar", fake)
    out = rt.validate_branch(cfg, "postgresql://s")
    assert out["public_tables"] == 25


def test_neon_restore_prod_calls_prod_branch(monkeypatch):
    cfg = rt.Config(env=base_env())
    fr = FakeRequests()
    seen = {}
    def cap(url):
        seen["url"] = url
        return FakeResp(200, {"ok": True})
    fr.add("POST", "/branches/br-delicate-sea-amum92c2/restore", cap)
    monkeypatch.setattr(rt, "requests", fr)
    rt.neon_restore_prod_from(cfg, "br-source", "0/ABC")
    assert "br-delicate-sea-amum92c2/restore" in seen["url"]


# --- step 4: code + lambda ---------------------------------------------------

def test_create_revert_commit(monkeypatch):
    cfg = rt.Config(env=base_env())
    fr = FakeRequests()
    fr.add("GET", f"/git/commits/{'a'*40}", FakeResp(200, {"tree": {"sha": "treeX"}}))
    fr.add("GET", "/git/ref/heads/dev", FakeResp(200, {"object": {"sha": "devHEAD"}}))
    fr.add("POST", "/git/commits", FakeResp(201, {"sha": "newcommit"}))
    fr.add("PATCH", "/git/refs/heads/dev", FakeResp(200, {"object": {"sha": "newcommit"}}))
    monkeypatch.setattr(rt, "requests", fr)
    assert rt.create_revert_commit_on_dev(cfg, good_manifest()) == "newcommit"


def test_ff_main_failure_raises(monkeypatch):
    cfg = rt.Config(env=base_env())
    fr = FakeRequests()
    fr.add("PATCH", "/git/refs/heads/main", FakeResp(422, text="not fast forward"))
    monkeypatch.setattr(rt, "requests", fr)
    with pytest.raises(rt.RevertError):
        rt.ff_main(cfg, "z" * 40)


class FakeLambda:
    def __init__(self, missing_alias=False):
        self.calls = []
        self.missing_alias = missing_alias

    def update_alias(self, **k):
        self.calls.append(("update", k))
        if self.missing_alias:
            from botocore.exceptions import ClientError
            raise ClientError({"Error": {"Code": "ResourceNotFoundException"}}, "UpdateAlias")

    def create_alias(self, **k):
        self.calls.append(("create", k))


def test_restore_lambda_updates_alias():
    cfg = rt.Config(env=base_env())
    lc = FakeLambda()
    out = rt.restore_lambda_versions(cfg, good_manifest(), lambda_client=lc)
    assert out == {"garden-plants": "7"}
    assert lc.calls[0][0] == "update"


def test_restore_lambda_creates_alias_when_missing():
    cfg = rt.Config(env=base_env())
    lc = FakeLambda(missing_alias=True)
    rt.restore_lambda_versions(cfg, good_manifest(), lambda_client=lc)
    assert any(c[0] == "create" for c in lc.calls)


# --- orchestration -----------------------------------------------------------

def test_run_data_loss_guard(monkeypatch):
    cfg = rt.Config(env=base_env(CONFIRM_DATA_LOSS="no"))
    s3 = FakeS3({("garden-backups-prod", "snapshots/v2.5.0.json"): json.dumps(good_manifest()).encode()})
    fr = FakeRequests()
    fr.add("GET", "/git/ref/tags/v2.5.0", FakeResp(200, {"object": {"sha": "tagobj"}}))
    fr.add("GET", "/git/tags/tagobj", FakeResp(200, {"object": {"sha": "a" * 40}}))
    monkeypatch.setattr(rt, "requests", fr)
    monkeypatch.setattr(rt, "compute_rpo", lambda cfg: {"total_live_rows": 5, "latest_event": "t"})
    with pytest.raises(rt.RevertError) as e:
        rt.run(cfg, s3=s3)
    assert "CONFIRM_DATA_LOSS" in str(e.value)


def test_run_happy_path_fastpath(monkeypatch):
    cfg = rt.Config(env=base_env())
    s3 = FakeS3({("garden-backups-prod", "snapshots/v2.5.0.json"): json.dumps(good_manifest()).encode()})
    fr = FakeRequests()
    fr.add("GET", "/git/ref/tags/v2.5.0", FakeResp(200, {"object": {"sha": "tagobj"}}))
    fr.add("GET", "/git/tags/tagobj", FakeResp(200, {"object": {"sha": "a" * 40}}))
    fr.add("GET", "/git/ref/heads/main", FakeResp(200, {"object": {"sha": "mainHEAD"}}))
    fr.add("GET", "/branches", FakeResp(200, {"branches": [
        {"id": "br-snap", "name": "snap-v2.5.0", "current_state_lsn": "0/ABC"}]}))
    fr.add("POST", "/restore", FakeResp(200, {"ok": True}))
    fr.add("GET", f"/git/commits/{'a'*40}", FakeResp(200, {"tree": {"sha": "treeX"}}))
    fr.add("GET", "/git/ref/heads/dev", FakeResp(200, {"object": {"sha": "devHEAD"}}))
    fr.add("POST", "/git/commits", FakeResp(201, {"sha": "revcommit"}))
    fr.add("PATCH", "/git/refs/heads/dev", FakeResp(200, {"object": {"sha": "revcommit"}}))
    fr.add("PATCH", "/git/refs/heads/main", FakeResp(200, {"object": {"sha": "revcommit"}}))
    monkeypatch.setattr(rt, "requests", fr)
    monkeypatch.setattr(rt, "compute_rpo", lambda cfg: {"total_live_rows": 5, "latest_event": "t"})
    # pre-revert snap mocked
    monkeypatch.setattr(rt, "prerevert_snap", lambda cfg: {"manifest": {
        "neon_branch_id": "br-pre", "neon_lsn": "0/PRE", "main_sha": "m" * 40,
        "lambda_versions": {}}})
    lc = FakeLambda(); cfc = types.SimpleNamespace(create_invalidation=lambda **k: None)
    out = rt.run(cfg, s3=s3, lambda_client=lc, cloudfront_client=cfc)
    assert out["reverted_to"] == "v2.5.0"
    assert out["revert_commit"] == "revcommit"
    # fast path used -> no revert-stage branch creation POST /branches
    assert not any(m == "POST" and url.endswith("/branches") for m, url in fr.calls)


def test_run_aborts_and_rolls_back(monkeypatch):
    """A failure AFTER the prod-DB checkpoint must trigger rollback()."""
    cfg = rt.Config(env=base_env())
    s3 = FakeS3({("garden-backups-prod", "snapshots/v2.5.0.json"): json.dumps(good_manifest()).encode()})
    fr = FakeRequests()
    fr.add("GET", "/git/ref/tags/v2.5.0", FakeResp(200, {"object": {"sha": "tagobj"}}))
    fr.add("GET", "/git/tags/tagobj", FakeResp(200, {"object": {"sha": "a" * 40}}))
    fr.add("GET", "/branches", FakeResp(200, {"branches": [
        {"id": "br-snap", "name": "snap-v2.5.0", "current_state_lsn": "0/ABC"}]}))
    fr.add("POST", "/restore", FakeResp(200, {"ok": True}))
    fr.add("GET", f"/git/commits/{'a'*40}", FakeResp(200, {"tree": {"sha": "treeX"}}))
    fr.add("GET", "/git/ref/heads/dev", FakeResp(200, {"object": {"sha": "devHEAD"}}))
    fr.add("POST", "/git/commits", FakeResp(201, {"sha": "revcommit"}))
    fr.add("PATCH", "/git/refs/heads/dev", FakeResp(200, {"object": {"sha": "revcommit"}}))
    # main FF FAILS -> abort -> rollback
    fr.add("PATCH", "/git/refs/heads/main", FakeResp(422, text="boom"))
    monkeypatch.setattr(rt, "requests", fr)
    monkeypatch.setattr(rt, "compute_rpo", lambda cfg: {"total_live_rows": 5, "latest_event": "t"})
    monkeypatch.setattr(rt, "prerevert_snap", lambda cfg: {"manifest": {
        "neon_branch_id": "br-pre", "neon_lsn": "0/PRE", "main_sha": "m" * 40,
        "lambda_versions": {}}})
    rollback_called = {"n": 0}
    real_rollback = rt.rollback
    def spy(cfg2, pre, lambda_client=None):
        rollback_called["n"] += 1
    monkeypatch.setattr(rt, "rollback", spy)
    lc = FakeLambda()
    with pytest.raises(rt.RevertError) as e:
        rt.run(cfg, s3=s3, lambda_client=lc)
    assert rollback_called["n"] == 1
    assert "rolled back" in str(e.value)


def test_run_failure_before_checkpoint_no_rollback(monkeypatch):
    """A failure BEFORE the prod-DB checkpoint must NOT roll back (nothing mutated)."""
    cfg = rt.Config(env=base_env())
    s3 = FakeS3({("garden-backups-prod", "snapshots/v2.5.0.json"): json.dumps(good_manifest()).encode()})
    fr = FakeRequests()
    fr.add("GET", "/git/ref/tags/v2.5.0", FakeResp(200, {"object": {"sha": "tagobj"}}))
    fr.add("GET", "/git/tags/tagobj", FakeResp(200, {"object": {"sha": "a" * 40}}))
    # fast path absent -> create stage branch path; make branch list raise to fail pre-checkpoint
    fr.add("GET", "/branches", FakeResp(500, text="neon down"))
    monkeypatch.setattr(rt, "requests", fr)
    monkeypatch.setattr(rt, "compute_rpo", lambda cfg: {"total_live_rows": 5, "latest_event": "t"})
    monkeypatch.setattr(rt, "prerevert_snap", lambda cfg: {"manifest": {
        "neon_branch_id": "br-pre", "neon_lsn": "0/PRE", "main_sha": "m" * 40, "lambda_versions": {}}})
    rolled = {"n": 0}
    monkeypatch.setattr(rt, "rollback", lambda *a, **k: rolled.__setitem__("n", rolled["n"] + 1))
    with pytest.raises(rt.RevertError):
        rt.run(cfg, s3=s3)
    assert rolled["n"] == 0


def test_main_exit_code_on_error(monkeypatch):
    monkeypatch.setattr(rt, "Config", lambda: (_ for _ in ()).throw(rt.RevertError("x")))
    assert rt.main() == 1
