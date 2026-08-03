#!/usr/bin/env python3
"""Mocked unit tests for restore-verify.py (spec §3 B3; Gate 0.2/0.3 rework:
restore into an EMPTY container, structural inventory vs prod, scope probe,
snap-bucket parameterization). All S3/psql/pg_restore I/O mocked."""
import datetime as dt
import importlib.util
import os
import sys

import pytest
from botocore.exceptions import ClientError

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)


def _load():
    spec = importlib.util.spec_from_file_location("restore_verify", os.path.join(HERE, "restore-verify.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


rv = _load()


class FakeS3:
    def __init__(self, pages=None, objects=None):
        self._pages = pages or []
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

    def head_object(self, Bucket, Key):
        if (Bucket, Key) in self.objects:
            return {}
        raise ClientError({"Error": {"Code": "404"}}, "HeadObject")


def env(**over):
    e = {
        "SCRATCH_DATABASE_URL": "postgresql://scratch",
        "NEON_BACKUP_URL": "postgresql://prod",
    }
    e.update(over)
    return e


def D(y, m, d):
    return dt.datetime(y, m, d, tzinfo=dt.timezone.utc)


# --- config / module shape ---------------------------------------------------

def test_config_requires_scratch_url():
    with pytest.raises(rv.VerifyError):
        rv.Config(env={"NEON_BACKUP_URL": "postgresql://prod"})


def test_no_neon_api_dependency():
    # Gate 0.2: the empty-container design makes ZERO Neon API calls.
    assert not hasattr(rv, "requests")
    assert not hasattr(rv, "neon_create_scratch")
    assert not hasattr(rv, "neon_delete_branch")


def test_config_bucket_prefix_parameterized():
    cfg = rv.Config(env=env(BACKUP_BUCKET="garden-snapshots-prod", DUMP_PREFIX="db/snap-"))
    assert cfg.backup_bucket == "garden-snapshots-prod" and cfg.dump_prefix == "db/snap-"


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


def test_latest_dump_excludes_rehearsal_even_when_newest():
    # RIA-3: snap-rehearsal dumps STAGING into the same bucket/prefix; if its
    # object is recreated it is the newest by LastModified — verifying it
    # against prod inventory would be a false red. Must be skipped.
    cfg = rv.Config(env=env(BACKUP_BUCKET="garden-snapshots-prod", DUMP_PREFIX="db/snap-"))
    pages = [{"Contents": [
        {"Key": "db/snap-v3.90.0.dump", "LastModified": D(2026, 8, 1), "Size": 100},
        {"Key": "db/snap-v0.0.0.dump", "LastModified": D(2026, 8, 3), "Size": 90},
    ]}]
    key, _, _ = rv.latest_dump_key(FakeS3(pages), cfg)
    assert key == "db/snap-v3.90.0.dump"


def test_latest_dump_only_rehearsal_raises():
    cfg = rv.Config(env=env(DUMP_PREFIX="db/snap-"))
    pages = [{"Contents": [
        {"Key": "db/snap-v0.0.0.dump", "LastModified": D(2026, 8, 3), "Size": 90}]}]
    with pytest.raises(rv.VerifyError):
        rv.latest_dump_key(FakeS3(pages), cfg)


def test_rehearsal_key_pattern_anchored():
    # Anchored to the whole version token, not a bare substring match.
    assert rv._is_rehearsal_key("db/snap-v0.0.0.dump", "v0.0.0")
    assert rv._is_rehearsal_key("db/snap-v0.0.0.globals.sql", "v0.0.0")
    assert not rv._is_rehearsal_key("db/snap-v0.0.01.dump", "v0.0.0")
    assert not rv._is_rehearsal_key("db/snap-v10.0.0.dump", "v0.0.0")
    assert not rv._is_rehearsal_key("db/garden-20260803.dump", "v0.0.0")


# --- scope probe -------------------------------------------------------------

FULL_TOC = """;
; Archive created at 2026-08-03
;
5; 2615 16386 SCHEMA - gv neondb_owner
6; 2615 16387 SCHEMA - extensions neondb_owner
217; 1259 24577 TABLE public plants neondb_owner
"""

LEGACY_TOC = """;
; Archive created at 2026-08-03
;
217; 1259 24577 TABLE public plants neondb_owner
"""

PARTIAL_TOC = """;
; Archive created at 2026-08-03
;
5; 2615 16386 SCHEMA - gv neondb_owner
217; 1259 24577 TABLE public plants neondb_owner
"""


def _proc(rc=0, out="", err=""):
    class P:
        returncode = rc
        stdout = out
        stderr = err
    return P()


def test_probe_full_scope(monkeypatch):
    monkeypatch.setattr(rv.subprocess, "run", lambda *a, **k: _proc(out=FULL_TOC))
    full, schemas = rv.probe_dump_scope("/x.dump")
    assert full and {"gv", "extensions"} <= schemas


def test_probe_legacy_scope(monkeypatch):
    monkeypatch.setattr(rv.subprocess, "run", lambda *a, **k: _proc(out=LEGACY_TOC))
    full, schemas = rv.probe_dump_scope("/x.dump")
    assert not full and "gv" not in schemas


def test_probe_partial_scope_is_legacy(monkeypatch):
    # gv present but extensions absent (half-scoped dump) -> NOT full scope.
    # Pinned: misclassify-to-legacy is the SAFE direction — legacy path warns
    # (or reds via REQUIRE_FULL_SCOPE) instead of running structural
    # assertions a half-scoped dump could never satisfy (QA-G4).
    monkeypatch.setattr(rv.subprocess, "run", lambda *a, **k: _proc(out=PARTIAL_TOC))
    full, schemas = rv.probe_dump_scope("/x.dump")
    assert not full and "gv" in schemas and "extensions" not in schemas


def test_probe_unreadable_dump_raises(monkeypatch):
    monkeypatch.setattr(rv.subprocess, "run", lambda *a, **k: _proc(rc=1, err="not an archive"))
    with pytest.raises(rv.VerifyError):
        rv.probe_dump_scope("/x.dump")


# --- empty-target guard ------------------------------------------------------

def test_empty_target_ok(monkeypatch):
    monkeypatch.setattr(rv, "_psql_scalar", lambda url, sql: "0")
    rv.ensure_empty_target("postgresql://scratch")  # no raise


def test_dirty_target_refused(monkeypatch):
    monkeypatch.setattr(
        rv, "_psql_scalar", lambda url, sql: "62" if "pg_class" in sql else "0")
    with pytest.raises(rv.VerifyError) as e:
        rv.ensure_empty_target("postgresql://scratch")
    assert "NOT empty" in str(e.value)


def test_target_with_app_schemas_refused(monkeypatch):
    # Zero tables but gv/extensions schemas present = reused target -> refuse.
    # Mock keys on pg_class (only the TABLES query has it) — the tables query
    # ALSO joins pg_namespace, so keying on pg_namespace returned "2" for BOTH
    # queries and the schemas branch was never exercised (QA-G1 vacuous test;
    # kill verified: deleting the schemas check makes THIS test fail).
    monkeypatch.setattr(
        rv, "_psql_scalar", lambda url, sql: "0" if "pg_class" in sql else "2")
    with pytest.raises(rv.VerifyError):
        rv.ensure_empty_target("postgresql://scratch")


# --- restore (strict — empty target has no benign errors) --------------------

def test_restore_nonzero_rc_raises(monkeypatch):
    cfg = rv.Config(env=env())
    monkeypatch.setattr(rv.subprocess, "run", lambda *a, **k: _proc(rc=1, err="pg_restore: error: boom"))
    with pytest.raises(rv.VerifyError):
        rv.restore_dump(cfg, "/x.dump", "postgresql://scratch")


def test_restore_error_line_raises_even_rc0(monkeypatch):
    cfg = rv.Config(env=env())
    monkeypatch.setattr(rv.subprocess, "run", lambda *a, **k: _proc(rc=0, err="pg_restore: error: partial"))
    with pytest.raises(rv.VerifyError):
        rv.restore_dump(cfg, "/x.dump", "postgresql://scratch")


def test_restore_clean_ok(monkeypatch):
    cfg = rv.Config(env=env())
    monkeypatch.setattr(rv.subprocess, "run", lambda *a, **k: _proc(rc=0))
    rv.restore_dump(cfg, "/x.dump", "postgresql://scratch")  # no raise


# --- globals -----------------------------------------------------------------

def test_globals_error_classification():
    stderr = "\n".join([
        'psql:globals.sql:3: ERROR:  role "neon_superuser" does not exist',
        'psql:globals.sql:5: ERROR:  role "app_rw" already exists',
        "psql:globals.sql:7: ERROR:  permission denied to set parameter",
        "psql:globals.sql:9: ERROR:  syntax error at or near garbage",
    ])
    tolerated, unexpected = rv._classify_globals_errors(stderr)
    assert len(tolerated) == 3
    assert len(unexpected) == 1 and "syntax error" in unexpected[0]


def test_find_globals_key_derived():
    cfg = rv.Config(env=env())
    s3 = FakeS3(objects={("garden-backups-prod", "db/garden-20260803.globals.sql"): b"G"})
    assert rv.find_globals_key(s3, cfg, "db/garden-20260803.dump") == "db/garden-20260803.globals.sql"


def test_find_globals_key_absent():
    cfg = rv.Config(env=env())
    assert rv.find_globals_key(FakeS3(), cfg, "db/garden-20260803.dump") is None


def test_find_globals_key_explicit_override():
    cfg = rv.Config(env=env(GLOBALS_KEY="custom/globals.sql"))
    s3 = FakeS3(objects={("garden-backups-prod", "custom/globals.sql"): b"G"})
    assert rv.find_globals_key(s3, cfg, "db/garden-x.dump") == "custom/globals.sql"


# --- assess ------------------------------------------------------------------

CORE = {"plant_projects", "plants", "event_log", "locations", "inventory_items", "plant_varieties"}
FNS = {"extensions": {"uuid_generate_v4", "uuid_nil"}, "gv": {"bump_version", "slugify"}}
TRG = {"plants:set_updated_at:set_updated_at", "event_log:prevent_ownership_transfer:prevent_ownership_transfer"}


def _patch_introspect(monkeypatch, prod_tables, rest_tables, prod_counts, rest_counts,
                      rest_schemas=None, rest_fns=None, rest_trg=None):
    rest_schemas = {"public", "gv", "extensions"} if rest_schemas is None else rest_schemas
    rest_fns = FNS if rest_fns is None else rest_fns
    rest_trg = TRG if rest_trg is None else rest_trg
    monkeypatch.setattr(rv, "table_set", lambda url: prod_tables if "prod" in url else rest_tables)
    monkeypatch.setattr(rv, "row_counts", lambda url, tables: {
        t: (prod_counts if "prod" in url else rest_counts).get(t) for t in tables})
    monkeypatch.setattr(rv, "schema_set", lambda url: (
        {"public", "gv", "extensions"} if "prod" in url else rest_schemas))
    monkeypatch.setattr(rv, "func_set", lambda url, schema: (
        FNS if "prod" in url else rest_fns).get(schema, set()))
    monkeypatch.setattr(rv, "trigger_set", lambda url: TRG if "prod" in url else rest_trg)


def test_assess_full_scope_coherent_ok(monkeypatch):
    cfg = rv.Config(env=env())
    counts = {t: 100 for t in CORE}
    _patch_introspect(monkeypatch, CORE, CORE, counts, {t: 98 for t in CORE})
    ok, rep = rv.assess(cfg, "postgresql://scratch", full_scope=True)
    assert ok and not rep["hard_failures"]


def test_assess_missing_table_fails(monkeypatch):
    cfg = rv.Config(env=env())
    counts = {t: 100 for t in CORE}
    rest = set(CORE); rest.discard("event_log")
    _patch_introspect(monkeypatch, CORE, rest, counts, {t: 100 for t in rest})
    ok, rep = rv.assess(cfg, "postgresql://scratch", full_scope=True)
    assert not ok and any("MISSING" in f for f in rep["hard_failures"])


def test_assess_extra_table_is_warning(monkeypatch):
    cfg = rv.Config(env=env())
    rest = set(CORE) | {"new_feature"}
    counts = {t: 100 for t in CORE}
    _patch_introspect(monkeypatch, CORE, rest, counts, {t: 100 for t in CORE})
    ok, rep = rv.assess(cfg, "postgresql://scratch", full_scope=True)
    assert ok and any("post-date" in w for w in rep["warnings"])


def test_assess_empty_restore_fails(monkeypatch):
    cfg = rv.Config(env=env())
    counts = {t: 100 for t in CORE}
    _patch_introspect(monkeypatch, CORE, CORE, counts, {t: 0 for t in CORE})
    ok, rep = rv.assess(cfg, "postgresql://scratch", full_scope=True)
    assert not ok and any("EMPTY" in f for f in rep["hard_failures"])


def test_assess_truncated_table_fails(monkeypatch):
    cfg = rv.Config(env=env())
    counts = {t: 100 for t in CORE}
    rest = {t: 100 for t in CORE}; rest["event_log"] = 5  # 0.05 < floor 0.5
    _patch_introspect(monkeypatch, CORE, CORE, counts, rest)
    ok, rep = rv.assess(cfg, "postgresql://scratch", full_scope=True)
    assert not ok and any("event_log" in f and "<<" in f for f in rep["hard_failures"])


def test_assess_small_table_drift_tolerated(monkeypatch):
    cfg = rv.Config(env=env())
    counts = {t: 100 for t in CORE}; counts["locations"] = 5  # < DRIFT_MIN_ROWS
    rest = {t: 100 for t in CORE}; rest["locations"] = 1
    _patch_introspect(monkeypatch, CORE, CORE, counts, rest)
    ok, rep = rv.assess(cfg, "postgresql://scratch", full_scope=True)
    assert ok


def test_assess_missing_schema_fails(monkeypatch):
    cfg = rv.Config(env=env())
    counts = {t: 100 for t in CORE}
    _patch_introspect(monkeypatch, CORE, CORE, counts, dict(counts),
                      rest_schemas={"public", "extensions"})  # gv missing
    ok, rep = rv.assess(cfg, "postgresql://scratch", full_scope=True)
    assert not ok and any("schemas missing" in f for f in rep["hard_failures"])


def test_assess_missing_gv_function_fails(monkeypatch):
    cfg = rv.Config(env=env())
    counts = {t: 100 for t in CORE}
    rest_fns = {"extensions": FNS["extensions"], "gv": {"bump_version"}}  # slugify lost
    _patch_introspect(monkeypatch, CORE, CORE, counts, dict(counts), rest_fns=rest_fns)
    ok, rep = rv.assess(cfg, "postgresql://scratch", full_scope=True)
    assert not ok and any("gv.*" in f and "slugify" in f for f in rep["hard_failures"])


def test_assess_extra_extensions_function_warns(monkeypatch):
    cfg = rv.Config(env=env())
    counts = {t: 100 for t in CORE}
    rest_fns = {"extensions": FNS["extensions"] | {"uuid_extra"}, "gv": FNS["gv"]}
    _patch_introspect(monkeypatch, CORE, CORE, counts, dict(counts), rest_fns=rest_fns)
    ok, rep = rv.assess(cfg, "postgresql://scratch", full_scope=True)
    assert ok and any("uuid_extra" in w for w in rep["warnings"])


def test_assess_missing_trigger_fails(monkeypatch):
    cfg = rv.Config(env=env())
    counts = {t: 100 for t in CORE}
    rest_trg = {"plants:set_updated_at:set_updated_at"}  # ownership trigger lost
    _patch_introspect(monkeypatch, CORE, CORE, counts, dict(counts), rest_trg=rest_trg)
    ok, rep = rv.assess(cfg, "postgresql://scratch", full_scope=True)
    assert not ok and any("prevent_ownership_transfer" in f for f in rep["hard_failures"])


def test_assess_legacy_dump_warns_not_fails(monkeypatch):
    cfg = rv.Config(env=env())
    counts = {t: 100 for t in CORE}
    _patch_introspect(monkeypatch, CORE, CORE, counts, dict(counts))
    ok, rep = rv.assess(cfg, "postgresql://scratch", full_scope=False)
    assert ok and any("LEGACY public-only" in w for w in rep["warnings"])


def test_assess_legacy_dump_hard_fails_when_required(monkeypatch):
    cfg = rv.Config(env=env(REQUIRE_FULL_SCOPE="1"))
    counts = {t: 100 for t in CORE}
    _patch_introspect(monkeypatch, CORE, CORE, counts, dict(counts))
    ok, rep = rv.assess(cfg, "postgresql://scratch", full_scope=False)
    assert not ok and any("REQUIRE_FULL_SCOPE" in f for f in rep["hard_failures"])


# --- run / main --------------------------------------------------------------

def _run_fixture(monkeypatch, assess_result):
    cfg = rv.Config(env=env())
    pages = [{"Contents": [{"Key": "db/garden-20260803.dump", "LastModified": D(2026, 8, 3), "Size": 100}]}]
    s3 = FakeS3(pages, {("garden-backups-prod", "db/garden-20260803.dump"): b"D"})
    monkeypatch.setattr(rv, "ensure_empty_target", lambda url: None)
    monkeypatch.setattr(rv, "probe_dump_scope", lambda p: (True, {"gv", "extensions"}))
    monkeypatch.setattr(rv, "find_globals_key", lambda *a: None)
    monkeypatch.setattr(rv, "restore_dump", lambda *a, **k: None)
    monkeypatch.setattr(rv, "assess", lambda cfg2, uri, full_scope: assess_result)
    return cfg, s3


def test_run_happy(monkeypatch):
    cfg, s3 = _run_fixture(monkeypatch, (True, {"hard_failures": [], "warnings": [], "restored_counts": {}}))
    rep = rv.run(cfg, s3=s3)
    assert not rep["hard_failures"]
    assert s3.downloads  # the dump actually got fetched


def test_run_incoherent_raises(monkeypatch):
    cfg, s3 = _run_fixture(monkeypatch, (False, {"hard_failures": ["x"], "warnings": []}))
    with pytest.raises(rv.VerifyError):
        rv.run(cfg, s3=s3)


def test_run_refuses_dirty_target_before_restore(monkeypatch):
    cfg = rv.Config(env=env())
    pages = [{"Contents": [{"Key": "db/garden-x.dump", "LastModified": D(2026, 8, 3), "Size": 100}]}]
    s3 = FakeS3(pages, {("garden-backups-prod", "db/garden-x.dump"): b"D"})
    monkeypatch.setattr(rv, "ensure_empty_target",
                        lambda url: (_ for _ in ()).throw(rv.VerifyError("NOT empty")))
    restored = {"n": 0}
    monkeypatch.setattr(rv, "restore_dump", lambda *a, **k: restored.__setitem__("n", 1))
    with pytest.raises(rv.VerifyError):
        rv.run(cfg, s3=s3)
    assert restored["n"] == 0  # never restored into a dirty target


def test_main_exit_code(monkeypatch):
    monkeypatch.setattr(rv, "Config", lambda: (_ for _ in ()).throw(rv.VerifyError("x")))
    assert rv.main() == 1
