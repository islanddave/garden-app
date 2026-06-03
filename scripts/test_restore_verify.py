#!/usr/bin/env python3
"""Mocked unit tests for restore-verify.py (spec §3 B3). All S3/Neon/psql mocked."""
import datetime as dt
import importlib.util
import os
import sys
import types

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)


def _load():
    spec = importlib.util.spec_from_file_location("restore_verify", os.path.join(HERE, "restore-verify.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


rv = _load()


class FakeResp:
    def __init__(self, status, payload=None, text=""):
        self.status_code = status
        self._payload = payload or {}
        self.text = text or "{}"

    def json(self):
        return self._payload


class FakeRequests:
    def __init__(self):
        self.routes = []
        self.calls = []

    def add(self, method, sub, resp):
        self.routes.append((method.upper(), sub, resp))

    def _m(self, method, url):
        for mth, sub, resp in self.routes:
            if mth == method and sub in url:
                return resp(url) if callable(resp) else resp
        raise AssertionError(f"no route {method} {url}")

    def post(self, url, **k):
        self.calls.append(("POST", url)); return self._m("POST", url)

    def get(self, url, **k):
        self.calls.append(("GET", url)); return self._m("GET", url)

    def delete(self, url, **k):
        self.calls.append(("DELETE", url)); return self._m("DELETE", url)


class FakeS3:
    def __init__(self, pages, objects=None):
        self._pages = pages
        self.objects = objects or {}
        self.downloads = []

    def get_paginator(self, _):
        outer = self

        class P:
            def paginate(self, Bucket, Prefix):
                return outer._pages
        return P()

    def download_file(self, Bucket, Key, path):
        self.downloads.append((Bucket, Key))
        with open(path, "wb") as f:
            f.write(self.objects.get((Bucket, Key), b"DUMPDATA"))


def env(**over):
    e = {
        "NEON_API_KEY": "k", "NEON_PROJECT_ID": "p",
        "NEON_BACKUP_URL": "postgresql://prod",
    }
    e.update(over)
    return e


def D(y, m, d):
    return dt.datetime(y, m, d, tzinfo=dt.timezone.utc)


# --- latest_dump_key ---------------------------------------------------------

def test_latest_dump_picks_newest():
    cfg = rv.Config(env=env())
    pages = [{"Contents": [
        {"Key": "db/garden-20260601.dump", "LastModified": D(2026, 6, 1), "Size": 100},
        {"Key": "db/garden-20260603.dump", "LastModified": D(2026, 6, 3), "Size": 120},
        {"Key": "db/garden-20260602.dump", "LastModified": D(2026, 6, 2), "Size": 110},
        {"Key": "db/notes.txt", "LastModified": D(2026, 6, 9), "Size": 9},
    ]}]
    key, _, size = rv.latest_dump_key(FakeS3(pages), cfg)
    assert key == "db/garden-20260603.dump" and size == 120


def test_latest_dump_none_raises():
    cfg = rv.Config(env=env())
    with pytest.raises(rv.VerifyError):
        rv.latest_dump_key(FakeS3([{"Contents": []}]), cfg)


def test_latest_dump_empty_raises():
    cfg = rv.Config(env=env())
    pages = [{"Contents": [{"Key": "db/garden-x.dump", "LastModified": D(2026, 6, 3), "Size": 0}]}]
    with pytest.raises(rv.VerifyError):
        rv.latest_dump_key(FakeS3(pages), cfg)


# --- neon scratch branch -----------------------------------------------------

def test_create_scratch_uses_connection_uri(monkeypatch):
    cfg = rv.Config(env=env())
    fr = FakeRequests()
    fr.add("POST", "/branches", FakeResp(201, {"branch": {"id": "br-s"}, "connection_uris": [{"connection_uri": "postgresql://scratch"}]}))
    monkeypatch.setattr(rv, "requests", fr)
    bid, uri, name = rv.neon_create_scratch(cfg)
    assert bid == "br-s" and uri == "postgresql://scratch" and name.startswith("restore-verify-")


def test_create_scratch_fallback_uri(monkeypatch):
    cfg = rv.Config(env=env())
    fr = FakeRequests()
    fr.add("POST", "/branches", FakeResp(201, {"branch": {"id": "br-s"}}))
    fr.add("GET", "/connection_uri", FakeResp(200, {"uri": "postgresql://fallback"}))
    monkeypatch.setattr(rv, "requests", fr)
    _, uri, _ = rv.neon_create_scratch(cfg)
    assert uri == "postgresql://fallback"


def test_delete_branch_never_raises(monkeypatch):
    cfg = rv.Config(env=env())
    fr = FakeRequests()
    fr.add("DELETE", "/branches/", FakeResp(200))
    monkeypatch.setattr(rv, "requests", fr)
    assert rv.neon_delete_branch(cfg, "br-s") is True


# --- restore -----------------------------------------------------------------

def test_restore_pg_error_raises(monkeypatch):
    cfg = rv.Config(env=env())
    s3 = FakeS3([], {("garden-backups-prod", "db/garden-x.dump"): b"D"})

    class P:
        returncode = 1
        stderr = "pg_restore: error: connection refused"
        stdout = ""
    monkeypatch.setattr(rv.subprocess, "run", lambda *a, **k: P())
    with pytest.raises(rv.VerifyError):
        rv.restore_dump(s3, cfg, "db/garden-x.dump", "postgresql://scratch")


def test_restore_tolerates_benign(monkeypatch):
    cfg = rv.Config(env=env())
    s3 = FakeS3([], {("garden-backups-prod", "db/garden-x.dump"): b"D"})

    class P:
        returncode = 1
        stderr = "pg_restore: warning: errors ignored on restore: 2"
        stdout = ""
    monkeypatch.setattr(rv.subprocess, "run", lambda *a, **k: P())
    rv.restore_dump(s3, cfg, "db/garden-x.dump", "postgresql://scratch")  # no raise


# --- assess ------------------------------------------------------------------

def _patch_introspect(monkeypatch, prod_tables, rest_tables, prod_counts, rest_counts):
    def fake_table_set(url):
        return prod_tables if "prod" in url else rest_tables
    def fake_row_counts(url, tables):
        src = prod_counts if "prod" in url else rest_counts
        return {t: src.get(t) for t in tables}
    monkeypatch.setattr(rv, "table_set", fake_table_set)
    monkeypatch.setattr(rv, "row_counts", fake_row_counts)


CORE = {"projects", "plants", "events", "locations", "inventory_items", "plant_varieties"}


def test_assess_coherent_ok(monkeypatch):
    cfg = rv.Config(env=env())
    counts = {t: 100 for t in CORE}
    _patch_introspect(monkeypatch, CORE, CORE, counts, {t: 98 for t in CORE})
    ok, rep = rv.assess(cfg, "postgresql://scratch")
    assert ok and not rep["hard_failures"]


def test_assess_missing_table_fails(monkeypatch):
    cfg = rv.Config(env=env())
    counts = {t: 100 for t in CORE}
    rest = set(CORE); rest.discard("events")
    _patch_introspect(monkeypatch, CORE, rest, counts, {t: 100 for t in rest})
    ok, rep = rv.assess(cfg, "postgresql://scratch")
    assert not ok and any("MISSING" in f for f in rep["hard_failures"])


def test_assess_extra_table_is_warning(monkeypatch):
    cfg = rv.Config(env=env())
    rest = set(CORE) | {"new_feature"}
    counts = {t: 100 for t in CORE}
    _patch_introspect(monkeypatch, CORE, rest, counts, {t: 100 for t in CORE})
    ok, rep = rv.assess(cfg, "postgresql://scratch")
    assert ok and any("post-date" in w for w in rep["warnings"])


def test_assess_empty_restore_fails(monkeypatch):
    cfg = rv.Config(env=env())
    counts = {t: 100 for t in CORE}
    _patch_introspect(monkeypatch, CORE, CORE, counts, {t: 0 for t in CORE})
    ok, rep = rv.assess(cfg, "postgresql://scratch")
    assert not ok and any("EMPTY" in f for f in rep["hard_failures"])


def test_assess_truncated_table_fails(monkeypatch):
    cfg = rv.Config(env=env())
    counts = {t: 100 for t in CORE}
    rest = {t: 100 for t in CORE}; rest["events"] = 5  # 5/100 = 0.05 < floor 0.5
    _patch_introspect(monkeypatch, CORE, CORE, counts, rest)
    ok, rep = rv.assess(cfg, "postgresql://scratch")
    assert not ok and any("events" in f and "<<" in f for f in rep["hard_failures"])


def test_assess_small_table_drift_tolerated(monkeypatch):
    cfg = rv.Config(env=env())
    # prod below DRIFT_MIN_ROWS (20) -> ratio check skipped even if restored differs a lot
    counts = {t: 100 for t in CORE}; counts["locations"] = 5
    rest = {t: 100 for t in CORE}; rest["locations"] = 1
    _patch_introspect(monkeypatch, CORE, CORE, counts, rest)
    ok, rep = rv.assess(cfg, "postgresql://scratch")
    assert ok


# --- run / main --------------------------------------------------------------

def test_run_happy(monkeypatch):
    cfg = rv.Config(env=env())
    pages = [{"Contents": [{"Key": "db/garden-20260603.dump", "LastModified": D(2026, 6, 3), "Size": 100}]}]
    s3 = FakeS3(pages, {("garden-backups-prod", "db/garden-20260603.dump"): b"D"})
    fr = FakeRequests()
    fr.add("POST", "/branches", FakeResp(201, {"branch": {"id": "br-s"}, "connection_uris": [{"connection_uri": "postgresql://scratch"}]}))
    fr.add("DELETE", "/branches/", FakeResp(200))
    monkeypatch.setattr(rv, "requests", fr)
    monkeypatch.setattr(rv, "restore_dump", lambda *a, **k: None)
    counts = {t: 100 for t in CORE}
    _patch_introspect(monkeypatch, CORE, CORE, counts, {t: 99 for t in CORE})
    rep = rv.run(cfg, s3=s3)
    assert not rep["hard_failures"]
    assert any(m == "DELETE" for m, _ in fr.calls)  # scratch cleaned up


def test_run_incoherent_raises_and_cleans(monkeypatch):
    cfg = rv.Config(env=env())
    pages = [{"Contents": [{"Key": "db/garden-x.dump", "LastModified": D(2026, 6, 3), "Size": 100}]}]
    s3 = FakeS3(pages, {("garden-backups-prod", "db/garden-x.dump"): b"D"})
    fr = FakeRequests()
    fr.add("POST", "/branches", FakeResp(201, {"branch": {"id": "br-s"}, "connection_uris": [{"connection_uri": "postgresql://scratch"}]}))
    fr.add("DELETE", "/branches/", FakeResp(200))
    monkeypatch.setattr(rv, "requests", fr)
    monkeypatch.setattr(rv, "restore_dump", lambda *a, **k: None)
    counts = {t: 100 for t in CORE}
    _patch_introspect(monkeypatch, CORE, CORE, counts, {t: 0 for t in CORE})  # empty
    with pytest.raises(rv.VerifyError):
        rv.run(cfg, s3=s3)
    assert any(m == "DELETE" for m, _ in fr.calls)  # cleaned up even on failure


def test_main_exit_code(monkeypatch):
    monkeypatch.setattr(rv, "Config", lambda: (_ for _ in ()).throw(rv.VerifyError("x")))
    assert rv.main() == 1
