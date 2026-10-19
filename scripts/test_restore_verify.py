#!/usr/bin/env python3
"""Mocked unit tests for restore-verify.py (spec §3 B3; Gate 0.2/0.3 rework:
restore into an EMPTY container, structural inventory vs prod, scope probe,
snap-bucket parameterization). All S3/psql/pg_restore I/O mocked."""
import datetime as dt
import importlib.util
import io
import json
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
    def __init__(self, pages=None, objects=None, denied=()):
        self._pages = pages or []
        self.objects = objects or {}
        self.denied = set(denied)
        self.downloads = []
        self.gets = []

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

    def get_object(self, Bucket, Key):
        self.gets.append((Bucket, Key))
        if Key in self.denied:
            raise ClientError({"Error": {"Code": "AccessDenied"}}, "GetObject")
        if (Bucket, Key) not in self.objects:
            raise ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObject")
        return {"Body": io.BytesIO(self.objects[(Bucket, Key)])}


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
    # any v0.0.<n> set is a rehearsal set, whatever REHEARSAL_VERSION says (v0.0.900 since 2026-10-09)
    assert rv._is_rehearsal_key("db/snap-v0.0.900.dump", "v0.0.0")
    assert rv._is_rehearsal_key("db/snap-v0.0.900.globals.sql", "v0.0.0")
    assert rv._is_rehearsal_key("db/snap-v0.0.7.dump", "v0.0.0")
    assert not rv._is_rehearsal_key("db/snap-v0.1.0.dump", "v0.0.0")
    assert not rv._is_rehearsal_key("db/snap-v4.0.0.900.dump", "v0.0.0")
    assert not rv._is_rehearsal_key("db/snap-v4.178.0.dump", "v0.0.0")
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
    monkeypatch.setattr(rv, "assess", lambda cfg2, uri, full_scope, tablelist=None, catalog=None: assess_result)
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


# --- dump-time table list (OPS-RESTOREVERIFYRED-001) --------------------------

BUCKET = "garden-backups-prod"
DUMP = "db/garden-20261008.dump"
LIST = "db/garden-20261008.tables.json"


def _list_body(names, dump_key=DUMP, **over):
    doc = {"format": 1, "dump_key": dump_key, "taken_at": "2026-10-08T14:13:20Z",
           "tables": sorted(names)}
    doc.update(over)
    return json.dumps(doc).encode()


def _pub(names):
    return {f"public.{n}" for n in names}


def _s3_with_list(body=None, denied=(), list_at=None):
    """One dump under the prefix; body=None means no list object beside it."""
    contents = [{"Key": DUMP, "LastModified": D(2026, 10, 8), "Size": 7901527}]
    objects = {(BUCKET, DUMP): b"D"}
    if body is not None:
        contents.append({"Key": LIST, "LastModified": list_at or D(2026, 10, 8), "Size": len(body)})
        objects[(BUCKET, LIST)] = body
    return FakeS3([{"Contents": contents}], objects, denied=denied)


def test_tablelist_key_sits_beside_the_dump_like_globals():
    assert rv.tablelist_key_for("db/garden-20261008.dump") == "db/garden-20261008.tables.json"
    assert rv.tablelist_key_for("db/snap-v4.172.0.dump") == "db/snap-v4.172.0.tables.json"


def test_load_tablelist_absent_is_none_and_never_fetched():
    s3 = _s3_with_list()
    assert rv.load_tablelist(s3, rv.Config(env=env()), DUMP) is None
    assert s3.gets == []  # presence comes from the listing, not from a failed GET


def test_load_tablelist_present():
    s3 = _s3_with_list(_list_body(_pub(CORE) | {"gv.audit"}))
    tl = rv.load_tablelist(s3, rv.Config(env=env()), DUMP)
    assert tl["key"] == LIST and tl["taken_at"] == "2026-10-08T14:13:20Z"
    assert tl["tables"] == _pub(CORE) | {"gv.audit"}


def test_load_tablelist_unreadable_is_red_not_absent():
    # Listed but GetObject is denied: _s3_exists would call that "absent" and the
    # check would fall back without a word. It must red.
    s3 = _s3_with_list(_list_body(_pub(CORE)), denied={LIST})
    with pytest.raises(rv.VerifyError) as e:
        rv.load_tablelist(s3, rv.Config(env=env()), DUMP)
    assert "cannot be read" in str(e.value)


def test_load_tablelist_older_than_its_dump_is_not_used(capsys):
    # I2: the daily key is per-day, so an earlier run's list can sit beside a
    # re-run's dump with the right dump_key. Fall back to live, loudly.
    s3 = _s3_with_list(_list_body(_pub(CORE)), list_at=D(2026, 10, 8) - dt.timedelta(seconds=1))
    assert rv.load_tablelist(s3, rv.Config(env=env()), DUMP) is None
    out = capsys.readouterr().out
    assert out.startswith("::warning::") and "is OLDER than its dump" in out and LIST in out
    assert s3.gets == []


@pytest.mark.parametrize("delta", [0, 1, 3600], ids=["same-second", "1s-later", "1h-later"])
def test_load_tablelist_not_older_than_its_dump_is_used(delta):
    s3 = _s3_with_list(_list_body(_pub(CORE)), list_at=D(2026, 10, 8) + dt.timedelta(seconds=delta))
    assert rv.load_tablelist(s3, rv.Config(env=env()), DUMP)["tables"] == _pub(CORE)


@pytest.mark.parametrize("list_stamp, dump_stamp", [
    ({}, {"LastModified": D(2026, 10, 8)}),
    ({"LastModified": None}, {"LastModified": D(2026, 10, 8)}),
    ({"LastModified": D(2026, 10, 9)}, {}),
], ids=["list-LastModified-missing", "list-LastModified-None", "dump-LastModified-missing"])
def test_load_tablelist_that_cannot_be_dated_against_its_dump_is_not_used(list_stamp, dump_stamp, capsys):
    # RC-M1: not comparable is not "fresh". Fall back to live, loudly.
    body = _list_body(_pub(CORE))
    s3 = FakeS3([{"Contents": [{"Key": DUMP, "Size": 7901527, **dump_stamp},
                               {"Key": LIST, "Size": len(body), **list_stamp}]}],
                {(BUCKET, DUMP): b"D", (BUCKET, LIST): body})
    assert rv.load_tablelist(s3, rv.Config(env=env()), DUMP) is None
    out = capsys.readouterr().out
    assert out.startswith("::warning::") and LIST in out and "NOT used" in out
    assert "cannot be shown to be newer than its dump" in out
    assert s3.gets == []


def test_tablelist_missing_any_one_core_table_is_malformed():
    assert CORE == set(rv.SANITY_TABLES)
    for t in rv.SANITY_TABLES:
        doc = json.loads(_list_body(_pub(CORE - {t}) | {"public.seed_lots"}))
        assert f"public.{t}" in rv._tablelist_problem(doc, DUMP)


@pytest.mark.parametrize("body", [
    b"", b"not json", b"[]", b"null",
    _list_body([]),                                  # empty is never "prod had no tables"
    _list_body(_pub(CORE), tables="public.plants"),  # not a list
    _list_body(_pub(CORE), format=2),
    _list_body(_pub(CORE), dump_key="db/garden-20261007.dump"),  # another dump's list
    _list_body(_pub(CORE), taken_at=""),
    _list_body(CORE),                                # not schema-qualified
    _list_body({"gv.audit"}),                        # no public table at all
    _list_body({"public.plants"}),                   # M7: every other table would read "prod is ahead"
], ids=["empty-file", "not-json", "array", "null", "no-tables", "tables-not-list", "format",
        "other-dump", "no-taken-at", "unqualified", "no-public", "one-table"])
def test_load_tablelist_malformed_is_red_never_empty(body):
    with pytest.raises(rv.VerifyError) as e:
        rv.load_tablelist(_s3_with_list(body), rv.Config(env=env()), DUMP)
    assert "refusing to treat it as absent or empty" in str(e.value)


def _tl(names, extra=()):
    return {"key": LIST, "taken_at": "2026-10-08T14:13:20Z", "tables": _pub(names) | set(extra)}


def test_assess_list_present_restore_complete_ok(monkeypatch):
    cfg = rv.Config(env=env())
    counts = {t: 100 for t in CORE}
    _patch_introspect(monkeypatch, CORE, CORE, counts, dict(counts))
    ok, rep = rv.assess(cfg, "postgresql://scratch", full_scope=True, tablelist=_tl(CORE))
    assert ok and not rep["hard_failures"] and not rep["info"] and not rep["warnings"]
    assert rep["facts"]["table_source"] == "list"


def test_assess_list_present_listed_table_missing_fails_as_tables_lost(monkeypatch):
    cfg = rv.Config(env=env())
    counts = {t: 100 for t in CORE}
    listed = CORE | {"seed_lots"}
    # prod has since DROPPED seed_lots: the live comparison would not see the loss.
    _patch_introspect(monkeypatch, CORE, CORE, counts, dict(counts))
    ok, rep = rv.assess(cfg, "postgresql://scratch", full_scope=True, tablelist=_tl(listed))
    assert not ok and len(rep["hard_failures"]) == 1
    assert "MISSING from restore: ['seed_lots']" in rep["hard_failures"][0]
    klass, detail = rv.classify_failure(rep)
    assert klass == "TABLES LOST BY RESTORE" and "seed_lots" in detail


def test_assess_list_present_prod_ahead_is_information_not_failure(monkeypatch):
    # 2026-10-08: prod gained seed_lot_addition after the dump. With the list, green.
    cfg = rv.Config(env=env())
    counts = {t: 100 for t in CORE}
    _patch_introspect(monkeypatch, CORE | {"seed_lot_addition"}, CORE, counts, dict(counts))
    ok, rep = rv.assess(cfg, "postgresql://scratch", full_scope=True, tablelist=_tl(CORE))
    assert ok and not rep["hard_failures"]
    assert rep["info"] == [
        "prod is ahead of this dump by: ['seed_lot_addition'] "
        "(tables added to prod after the dump was taken; not a failure)"]


def test_assess_no_list_prod_ahead_still_reds_and_is_classified(monkeypatch):
    cfg = rv.Config(env=env())
    counts = {t: 100 for t in CORE}
    _patch_introspect(monkeypatch, CORE | {"seed_lot_addition"}, CORE, counts, dict(counts))
    ok, rep = rv.assess(cfg, "postgresql://scratch", full_scope=True)
    assert not ok and rep["facts"]["table_source"] == "live"
    assert "tables in prod but MISSING from restore: ['seed_lot_addition']" in rep["hard_failures"][0]
    klass, detail = rv.classify_failure(rep)
    assert klass == "PROD AHEAD OF DUMP" and "seed_lot_addition" in detail
    assert "no usable table list for the dump" in detail


def test_assess_list_restore_only_table_warns(monkeypatch):
    cfg = rv.Config(env=env())
    counts = {t: 100 for t in CORE}
    rest = CORE | {"made_mid_dump"}
    _patch_introspect(monkeypatch, rest, rest, counts, dict(counts))
    ok, rep = rv.assess(cfg, "postgresql://scratch", full_scope=True, tablelist=_tl(CORE))
    assert ok and any("not in the dump's table list" in w for w in rep["warnings"])


def test_assess_list_non_public_missing_warns_only(monkeypatch):
    cfg = rv.Config(env=env())
    counts = {t: 100 for t in CORE}
    _patch_introspect(monkeypatch, CORE, CORE, counts, dict(counts))
    monkeypatch.setattr(rv, "qualified_table_set", lambda url: _pub(CORE))
    ok, rep = rv.assess(cfg, "postgresql://scratch", full_scope=True,
                        tablelist=_tl(CORE, extra={"gv.audit"}))
    assert ok and any("gv.audit" in w for w in rep["warnings"])


def test_classify_row_counts_far_below_floor_is_wrong_dump(monkeypatch):
    # 2026-10-09: a staging dump compared with prod. Missing tables AND row ratios.
    cfg = rv.Config(env=env())
    counts = {t: 100 for t in CORE}
    rest = set(CORE)
    _patch_introspect(monkeypatch, CORE | {"ctas_x"}, rest, counts, {t: 4 for t in CORE})
    ok, rep = rv.assess(cfg, "postgresql://scratch", full_scope=True)
    assert not ok
    klass, detail = rv.classify_failure(rep)
    assert klass == "ROW COUNTS FAR BELOW FLOOR (wrong dump?)" and "plants 4/100" in detail


def test_classify_other(monkeypatch):
    cfg = rv.Config(env=env())
    counts = {t: 100 for t in CORE}
    _patch_introspect(monkeypatch, CORE, CORE, counts, dict(counts),
                      rest_schemas={"public", "extensions"})
    ok, rep = rv.assess(cfg, "postgresql://scratch", full_scope=True, tablelist=_tl(CORE))
    assert not ok and rv.classify_failure(rep)[0] == "OTHER"


def _prod_trg(monkeypatch, extra):
    monkeypatch.setattr(rv, "trigger_set", lambda url: TRG | extra if "prod" in url else TRG)


def test_trigger_on_a_table_prod_gained_after_the_dump_is_information_with_a_list(monkeypatch):
    # I1 / R2: a new prod table WITH a trigger (the usual additive-DDL shape). The
    # list proves the table was not there at dump time, so its trigger was not either.
    cfg = rv.Config(env=env())
    counts = {t: 100 for t in CORE}
    _patch_introspect(monkeypatch, CORE | {"pantry_item"}, CORE, counts, dict(counts))
    _prod_trg(monkeypatch, {"pantry_item:set_updated_at:set_updated_at"})
    ok, rep = rv.assess(cfg, "postgresql://scratch", full_scope=True, tablelist=_tl(CORE))
    assert ok and not rep["hard_failures"]
    assert rep["info"][1] == (
        "triggers on tables added to prod after the dump was taken: "
        "['pantry_item:set_updated_at:set_updated_at'] (not a failure)")


def test_trigger_on_a_table_prod_gained_still_reds_without_a_list(monkeypatch):
    cfg = rv.Config(env=env())
    counts = {t: 100 for t in CORE}
    _patch_introspect(monkeypatch, CORE | {"pantry_item"}, CORE, counts, dict(counts))
    _prod_trg(monkeypatch, {"pantry_item:set_updated_at:set_updated_at"})
    ok, rep = rv.assess(cfg, "postgresql://scratch", full_scope=True)
    assert not ok and len(rep["hard_failures"]) == 2 and not rep["info"]
    assert rv.classify_failure(rep)[0] == "PROD AHEAD OF DUMP"


def test_listed_table_lost_with_its_trigger_stays_red_with_a_list(monkeypatch):
    # R4: seed_lots was in prod at dump time and is not in the restore. Neither the
    # table nor its trigger is excused.
    cfg = rv.Config(env=env())
    counts = {t: 100 for t in CORE}
    listed = CORE | {"seed_lots"}
    _patch_introspect(monkeypatch, listed, CORE, counts, dict(counts))
    _prod_trg(monkeypatch, {"seed_lots:set_updated_at:set_updated_at"})
    ok, rep = rv.assess(cfg, "postgresql://scratch", full_scope=True, tablelist=_tl(listed))
    assert not ok and len(rep["hard_failures"]) == 2 and not rep["info"]
    assert "MISSING from restore: ['seed_lots']" in rep["hard_failures"][0]
    assert "seed_lots:set_updated_at:set_updated_at" in rep["hard_failures"][1]
    assert rv.classify_failure(rep)[0] == "TABLES LOST BY RESTORE"


def test_new_trigger_on_an_existing_table_stays_red_with_a_list(monkeypatch):
    # R3: the list says nothing about triggers on tables the dump did hold.
    cfg = rv.Config(env=env())
    counts = {t: 100 for t in CORE}
    _patch_introspect(monkeypatch, CORE | {"pantry_item"}, CORE, counts, dict(counts))
    _prod_trg(monkeypatch, {"plants:audit_stmt_update:audit_stmt_update",
                            "pantry_item:set_updated_at:set_updated_at"})
    ok, rep = rv.assess(cfg, "postgresql://scratch", full_scope=True, tablelist=_tl(CORE))
    assert not ok and len(rep["hard_failures"]) == 1
    assert "['plants:audit_stmt_update:audit_stmt_update']" in rep["hard_failures"][0]
    assert rv.classify_failure(rep)[0] == "OTHER"


def test_trigger_on_an_unlisted_table_that_IS_restored_is_not_excused(monkeypatch):
    # In the dump (created between the list read and pg_dump), so its trigger must restore.
    cfg = rv.Config(env=env())
    counts = {t: 100 for t in CORE}
    both = CORE | {"made_mid_dump"}
    _patch_introspect(monkeypatch, both, both, counts, dict(counts))
    _prod_trg(monkeypatch, {"made_mid_dump:set_updated_at:set_updated_at"})
    ok, rep = rv.assess(cfg, "postgresql://scratch", full_scope=True, tablelist=_tl(CORE))
    assert not ok and len(rep["hard_failures"]) == 1
    # RC-M3: classed as prod ahead, in words that are true when the table IS restored
    klass, detail = rv.classify_failure(rep)
    assert klass == "PROD AHEAD OF DUMP" and "['made_mid_dump']" in detail
    assert "a trigger missing from the restore on a table that is in prod and not in" in detail
    assert "applied after the list was read" in detail
    assert "not in the restore" not in detail and "no usable table list" not in detail


def test_trigger_lost_on_a_dumped_table_is_not_excused_as_prod_ahead(monkeypatch):
    cfg = rv.Config(env=env())
    counts = {t: 100 for t in CORE}
    _patch_introspect(monkeypatch, CORE | {"seed_lot_addition"}, CORE, counts, dict(counts),
                      rest_trg={"plants:set_updated_at:set_updated_at"})
    ok, rep = rv.assess(cfg, "postgresql://scratch", full_scope=True, tablelist=_tl(CORE))
    assert not ok and rv.classify_failure(rep)[0] == "OTHER"


# --- run(): which list was used, and the one verdict line ---------------------

def _run_real(monkeypatch, s3, prod_tables, rest_tables, rest_counts=None):
    """run() with the real assess(); only I/O and introspection are faked."""
    counts = {t: 100 for t in CORE}
    _patch_introspect(monkeypatch, prod_tables, rest_tables, counts,
                      dict(counts) if rest_counts is None else rest_counts)
    monkeypatch.setattr(rv, "ensure_empty_target", lambda url: None)
    monkeypatch.setattr(rv, "probe_dump_scope", lambda p: (True, {"gv", "extensions"}))
    monkeypatch.setattr(rv, "find_globals_key", lambda *a: None)
    monkeypatch.setattr(rv, "restore_dump", lambda *a, **k: None)
    return rv.Config(env=env())


def _verdicts(err):
    return [ln for ln in err.splitlines() if ln.startswith("::error::")]


def test_run_with_list_prod_ahead_is_green_and_reported(monkeypatch, capsys):
    s3 = _s3_with_list(_list_body(_pub(CORE)))
    cfg = _run_real(monkeypatch, s3, CORE | {"seed_lot_addition"}, CORE)
    rep = rv.run(cfg, s3=s3)
    out, err = capsys.readouterr()
    assert not rep["hard_failures"] and not _verdicts(err)
    assert f"table list {LIST} (6 tables, taken 2026-10-08T14:13:20Z)" in out
    assert "INFO: prod is ahead of this dump by: ['seed_lot_addition']" in out
    assert "FELL BACK" not in out


def test_run_with_list_new_table_and_its_trigger_is_green_with_info(monkeypatch, capsys):
    s3 = _s3_with_list(_list_body(_pub(CORE)))
    cfg = _run_real(monkeypatch, s3, CORE | {"pantry_item"}, CORE)
    _prod_trg(monkeypatch, {"pantry_item:set_updated_at:set_updated_at"})
    rep = rv.run(cfg, s3=s3)
    out, err = capsys.readouterr()
    assert not rep["hard_failures"] and not _verdicts(err)
    assert ("INFO: triggers on tables added to prod after the dump was taken: "
            "['pantry_item:set_updated_at:set_updated_at']") in out


def test_run_without_list_says_it_fell_back(monkeypatch, capsys):
    s3 = _s3_with_list()
    cfg = _run_real(monkeypatch, s3, CORE, CORE)
    rv.run(cfg, s3=s3)
    out, err = capsys.readouterr()
    assert out.count("FELL BACK to live prod's table list") == 1
    assert f"{LIST} absent" in out and not _verdicts(err)
    # M6: an annotation on a GREEN run too, not one plain log line
    (line,) = [ln for ln in out.splitlines() if "FELL BACK" in ln]
    assert line.startswith("::notice::[restore-verify] ")


def test_run_with_a_stale_list_reds_a_table_the_newer_dump_lost(monkeypatch, capsys):
    # I2 / R5: the list was taken before seed_lots existed; the newer dump beside it
    # lost seed_lots. Used, the list would call that "prod is ahead" and pass.
    s3 = _s3_with_list(_list_body(_pub(CORE)), list_at=D(2026, 10, 7))
    cfg = _run_real(monkeypatch, s3, CORE | {"seed_lots"}, CORE)
    with pytest.raises(rv.VerifyError):
        rv.run(cfg, s3=s3)
    out, err = capsys.readouterr()
    assert "is OLDER than its dump" in out and out.count("FELL BACK") == 1
    v = _verdicts(err)
    assert len(v) == 1 and "seed_lots" in v[0] and "LIVE prod (fallback" in v[0]
    # RC-M4: there IS a list beside this dump; the verdict must not say there is none
    assert "LIVE prod (fallback: no usable list for the dump)" in v[0]
    assert "no usable table list for the dump" in v[0]


def test_run_without_list_prod_ahead_reds_with_one_verdict_before_the_fail_lines(monkeypatch, capsys):
    s3 = _s3_with_list()
    cfg = _run_real(monkeypatch, s3, CORE | {"seed_lot_addition"}, CORE)
    with pytest.raises(rv.VerifyError):
        rv.run(cfg, s3=s3)
    err = capsys.readouterr().err
    lines = err.splitlines()
    assert len(_verdicts(err)) == 1 and lines[0].startswith("::error::")
    v = lines[0]
    assert "[PROD AHEAD OF DUMP]" in v and "seed_lot_addition" in v
    # the dump compared: key, size, age
    assert f"s3://{BUCKET}/{DUMP}" in v and "7901527 bytes" in v and " ago" in v
    assert "LIVE prod (fallback" in v
    assert any(ln.startswith("[restore-verify] FAIL:") for ln in lines[1:])


def test_run_with_list_lost_table_reds_classified(monkeypatch, capsys):
    s3 = _s3_with_list(_list_body(_pub(CORE | {"seed_lots"})))
    cfg = _run_real(monkeypatch, s3, CORE | {"seed_lots"}, CORE)
    with pytest.raises(rv.VerifyError):
        rv.run(cfg, s3=s3)
    v = _verdicts(capsys.readouterr().err)
    assert len(v) == 1 and "[TABLES LOST BY RESTORE]" in v[0] and "seed_lots" in v[0]
    assert f"the dump-time list {LIST}" in v[0]


def test_run_malformed_list_reds_before_any_restore(monkeypatch, capsys):
    s3 = _s3_with_list(_list_body([]))
    cfg = _run_real(monkeypatch, s3, CORE, CORE)
    restored = {"n": 0}
    monkeypatch.setattr(rv, "restore_dump", lambda *a, **k: restored.__setitem__("n", 1))
    with pytest.raises(rv.VerifyError):
        rv.run(cfg, s3=s3)
    v = _verdicts(capsys.readouterr().err)
    assert len(v) == 1 and "[OTHER]" in v[0] and "malformed" in v[0] and DUMP in v[0]
    assert restored["n"] == 0


def test_main_prints_exactly_one_verdict_for_every_failure_shape(monkeypatch, capsys):
    s3 = _s3_with_list()
    cfg = _run_real(monkeypatch, s3, CORE | {"seed_lot_addition"}, CORE)
    # (a) nothing selected yet
    monkeypatch.setattr(rv, "Config", lambda: (_ for _ in ()).throw(rv.VerifyError("no env")))
    assert rv.main() == 1
    v = _verdicts(capsys.readouterr().err)
    assert len(v) == 1 and "no dump selected" in v[0]
    # (b) a classified failure inside run(): main must not add a second line
    monkeypatch.setattr(rv, "Config", lambda: cfg)
    monkeypatch.setattr(rv.boto3, "client", lambda name: s3)
    assert rv.main() == 1
    assert len(_verdicts(capsys.readouterr().err)) == 1
    # (c) an unexpected exception after the dump is known
    monkeypatch.setattr(rv, "restore_dump", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("a\nb")))
    assert rv.main() == 1
    v = _verdicts(capsys.readouterr().err)
    assert len(v) == 1 and "RuntimeError: a b" in v[0] and DUMP in v[0]


def test_age_format():
    now = D(2026, 10, 8) + dt.timedelta(hours=1, minutes=2)
    assert rv._age(D(2026, 10, 8), now) == "1h02m"
    assert rv._age(D(2026, 10, 5), now) == "3d01h"
    assert rv._age(None, now) == "unknown age"


# --- dump-time catalog list (2.0c, RIA I2): triggers + gv/extensions functions --

CAT = "db/garden-20261008.catalog.json"
CAT_TRG = [["prevent_ownership_transfer", "public.event_log", 7, "public.prevent_ownership_transfer", "O"],
           ["set_updated_at", "public.plants", 19, "public.set_updated_at", "O"]]
CAT_GV = ["gv.bump_version()", "gv.slugify(text)"]
CAT_EXT = ["extensions.uuid_generate_v4()", "extensions.uuid_nil()"]


def _lists(trg=None, gv=None, ext=None):
    rows = {"triggers": CAT_TRG if trg is None else trg,
            "gv_functions": CAT_GV if gv is None else gv,
            "extensions_functions": CAT_EXT if ext is None else ext}
    return {n: {"count": len(r), "rows": r} for n, r in rows.items()}


def _cat_doc(dump_key=DUMP, **over):
    doc = {"format": 1, "dump_key": dump_key, "taken_at": "2026-10-08T14:13:21Z", **_lists()}
    doc.update(over)
    return doc


def _cat_body(dump_key=DUMP, **over):
    return json.dumps(_cat_doc(dump_key, **over)).encode()


def _cat(**lists):
    return {"key": CAT, "taken_at": "2026-10-08T14:13:21Z", **rv._catalog_sets(_lists(**lists))}


def _restored(monkeypatch, **lists):
    """What catalog_lists() reads from the restore."""
    monkeypatch.setattr(rv, "catalog_lists", lambda url: rv._catalog_sets(_lists(**lists)))


def _s3_cat(cat_body=None, cat_at=None, earlier=(), table_body=None):
    """The dump, optionally its table list, its catalog list (cat_body=None: none),
    and other catalog lists already under the prefix as (key, LastModified)."""
    contents = [{"Key": DUMP, "LastModified": D(2026, 10, 8), "Size": 7901527}]
    objects = {(BUCKET, DUMP): b"D"}
    if table_body is not None:
        contents.append({"Key": LIST, "LastModified": D(2026, 10, 8), "Size": len(table_body)})
        objects[(BUCKET, LIST)] = table_body
    if cat_body is not None:
        contents.append({"Key": CAT, "LastModified": cat_at or D(2026, 10, 8), "Size": len(cat_body)})
        objects[(BUCKET, CAT)] = cat_body
    for key, at in earlier:
        contents.append({"Key": key, "LastModified": at, "Size": 10})
    return FakeS3([{"Contents": contents}], objects)


YESTERDAY_CAT = ("db/garden-20261007.catalog.json", D(2026, 10, 7))


def test_one_catalog_sql_text_and_it_pins_nothing_but_the_catalog_columns():
    sql = rv.CATALOG_LIST_SQL
    for col in ("t.tgname", "t.tgrelid::regclass", "t.tgtype", "t.tgfoid::regproc", "t.tgenabled",
                "NOT t.tgisinternal", "n.nspname = 'gv'", "n.nspname = 'extensions'"):
        assert col in sql
    assert sql.count("'count', count(*)") == 3
    assert rv.CATALOG_LISTS == ("triggers", "gv_functions", "extensions_functions")


def test_cataloglist_key_sits_beside_the_dump():
    assert rv.cataloglist_key_for(DUMP) == CAT
    assert rv.cataloglist_key_for("db/snap-v5.3.6.dump") == "db/snap-v5.3.6.catalog.json"


def test_catalog_list_present_is_loaded_as_sets():
    cat = rv.load_cataloglist(_s3_cat(_cat_body()), rv.Config(env=env()), DUMP)
    assert cat["key"] == CAT and cat["taken_at"] == "2026-10-08T14:13:21Z"
    assert ("set_updated_at", "public.plants", 19, "public.set_updated_at", "O") in cat["triggers"]
    assert cat["gv_functions"] == set(CAT_GV) and cat["extensions_functions"] == set(CAT_EXT)


def test_assess_with_catalog_coherent_ok(monkeypatch):
    cfg = rv.Config(env=env())
    counts = {t: 100 for t in CORE}
    _patch_introspect(monkeypatch, CORE, CORE, counts, dict(counts))
    _restored(monkeypatch)
    ok, rep = rv.assess(cfg, "postgresql://scratch", True, tablelist=_tl(CORE), catalog=_cat())
    assert ok and not rep["hard_failures"] and not rep["warnings"]
    assert rep["facts"]["struct_source"] == "list"


def test_control_trigger_added_after_the_dump_no_longer_reds(monkeypatch):
    # POSITIVE CONTROL (RIA I2): prod gains a trigger on a table the dump already
    # held, after the dump. Compared with live prod (today) that reds the day's
    # verify; compared with the dump's own catalog list it does not.
    cfg = rv.Config(env=env())
    counts = {t: 100 for t in CORE}
    _patch_introspect(monkeypatch, CORE, CORE, counts, dict(counts))
    _prod_trg(monkeypatch, {"plants:audit_stmt_update:audit_stmt_update"})
    ok_live, _ = rv.assess(cfg, "postgresql://scratch", True, tablelist=_tl(CORE))
    assert not ok_live  # the red this step removes
    _restored(monkeypatch)
    ok, rep = rv.assess(cfg, "postgresql://scratch", True, tablelist=_tl(CORE), catalog=_cat())
    assert ok and not rep["hard_failures"] and not rep["warnings"]


def test_control_trigger_dropped_from_the_restore_still_reds(monkeypatch):
    # POSITIVE CONTROL: a listed trigger the restore lacks reds, even when prod has
    # since dropped it too (the live comparison could not see that loss).
    cfg = rv.Config(env=env())
    counts = {t: 100 for t in CORE}
    _patch_introspect(monkeypatch, CORE, CORE, counts, dict(counts), rest_trg={TRG_KEEP})
    monkeypatch.setattr(rv, "trigger_set", lambda url: {TRG_KEEP})
    _restored(monkeypatch, trg=[CAT_TRG[1]])
    ok, rep = rv.assess(cfg, "postgresql://scratch", True, tablelist=_tl(CORE), catalog=_cat())
    assert not ok and len(rep["hard_failures"]) == 1
    assert "triggers in this dump's catalog list" in rep["hard_failures"][0]
    assert "prevent_ownership_transfer" in rep["hard_failures"][0]
    assert rv.classify_failure(rep)[0] == "OBJECTS LOST BY RESTORE"


TRG_KEEP = "plants:set_updated_at:set_updated_at"


def test_control_gv_function_added_after_the_dump_no_longer_reds(monkeypatch):
    cfg = rv.Config(env=env())
    counts = {t: 100 for t in CORE}
    _patch_introspect(monkeypatch, CORE, CORE, counts, dict(counts))
    prod_fns = {"extensions": FNS["extensions"], "gv": FNS["gv"] | {"entity_cultivar_ins"}}
    monkeypatch.setattr(rv, "func_set", lambda url, schema: (prod_fns if "prod" in url else FNS).get(schema, set()))
    ok_live, _ = rv.assess(cfg, "postgresql://scratch", True, tablelist=_tl(CORE))
    assert not ok_live
    _restored(monkeypatch)
    ok, rep = rv.assess(cfg, "postgresql://scratch", True, tablelist=_tl(CORE), catalog=_cat())
    assert ok and not rep["hard_failures"]


def test_control_gv_function_dropped_from_the_restore_still_reds(monkeypatch):
    cfg = rv.Config(env=env())
    counts = {t: 100 for t in CORE}
    _patch_introspect(monkeypatch, CORE, CORE, counts, dict(counts))
    _restored(monkeypatch, gv=["gv.bump_version()"])
    ok, rep = rv.assess(cfg, "postgresql://scratch", True, tablelist=_tl(CORE), catalog=_cat())
    assert not ok and len(rep["hard_failures"]) == 1
    assert "gv_functions" in rep["hard_failures"][0] and "gv.slugify(text)" in rep["hard_failures"][0]


def test_a_changed_trigger_is_lost_not_renamed(monkeypatch):
    # tgenabled / tgtype / function are part of the row: a trigger restored disabled reds.
    cfg = rv.Config(env=env())
    counts = {t: 100 for t in CORE}
    _patch_introspect(monkeypatch, CORE, CORE, counts, dict(counts))
    _restored(monkeypatch, trg=[CAT_TRG[0], CAT_TRG[1][:4] + ["D"]])
    ok, rep = rv.assess(cfg, "postgresql://scratch", True, tablelist=_tl(CORE), catalog=_cat())
    assert not ok and any("set_updated_at" in f for f in rep["hard_failures"])
    assert any("in restore but not in the dump's catalog list" in w for w in rep["warnings"])


def test_unlisted_object_in_the_restore_warns_only(monkeypatch):
    cfg = rv.Config(env=env())
    counts = {t: 100 for t in CORE}
    _patch_introspect(monkeypatch, CORE, CORE, counts, dict(counts))
    _restored(monkeypatch, ext=CAT_EXT + ["extensions.uuid_ns_dns()"])
    ok, rep = rv.assess(cfg, "postgresql://scratch", True, tablelist=_tl(CORE), catalog=_cat())
    assert ok and any("uuid_ns_dns" in w for w in rep["warnings"])


def test_control_no_catalog_list_when_one_is_expected_fails():
    # POSITIVE CONTROL: yesterday's dump on this leg already had a catalog list,
    # so the writer was live: today's dump without one is a FAIL, not a fallback.
    s3 = _s3_cat(earlier=[YESTERDAY_CAT])
    with pytest.raises(rv.VerifyError) as e:
        rv.load_cataloglist(s3, rv.Config(env=env()), DUMP)
    assert f"catalog list {CAT} for this dump is absent" in str(e.value)
    assert "refusing to fall back to live prod" in str(e.value)
    assert s3.gets == []


def test_a_stale_catalog_list_is_absent_and_reds_when_one_is_expected():
    # an earlier run's list beside a re-run's dump: it is its own precedent
    s3 = _s3_cat(_cat_body(), cat_at=D(2026, 10, 8) - dt.timedelta(seconds=1))
    with pytest.raises(rv.VerifyError) as e:
        rv.load_cataloglist(s3, rv.Config(env=env()), DUMP)
    assert "OLDER than its dump" in str(e.value)


def test_backward_compat_a_dump_older_than_the_writer_falls_back():
    # no catalog list for this dump and none written before it: the dump predates
    # the writer on this leg (every dump and snap made before 2.0c)
    assert rv.load_cataloglist(_s3_cat(), rv.Config(env=env()), DUMP) is None
    # a later dump's list is not a precedent for this one
    later = [("db/garden-20261009.catalog.json", D(2026, 10, 9))]
    assert rv.load_cataloglist(_s3_cat(earlier=later), rv.Config(env=env()), DUMP) is None


def test_backward_compat_snap_leg_made_before_the_change_falls_back():
    cfg = rv.Config(env=env(BACKUP_BUCKET="garden-snapshots-prod", DUMP_PREFIX="db/snap-"))
    snap_dump = "db/snap-v5.3.6.dump"
    s3 = FakeS3([{"Contents": [
        {"Key": snap_dump, "LastModified": D(2026, 10, 19), "Size": 9},
        {"Key": "db/snap-v5.3.6.tables.json", "LastModified": D(2026, 10, 19), "Size": 9},
        # a staging rehearsal (dev's snap.py) wrote a catalog list first: not this leg's writer
        {"Key": "db/snap-v0.0.900.catalog.json", "LastModified": D(2026, 10, 18), "Size": 9}]}])
    assert rv.load_cataloglist(s3, cfg, snap_dump) is None


def test_first_catalog_list_on_a_leg_is_used():
    s3 = _s3_cat(_cat_body(), cat_at=D(2026, 10, 8) + dt.timedelta(seconds=40))
    assert rv.load_cataloglist(s3, rv.Config(env=env()), DUMP)["key"] == CAT


@pytest.mark.parametrize("name", ["triggers", "gv_functions", "extensions_functions"])
def test_control_a_list_missing_its_count_line_fails(name):
    lst = dict(_lists()[name]); del lst["count"]
    with pytest.raises(rv.VerifyError) as e:
        rv.load_cataloglist(_s3_cat(_cat_body(**{name: lst})), rv.Config(env=env()), DUMP)
    assert f"{name} list has no count line" in str(e.value)


def _without(name):
    doc = _cat_doc(); del doc[name]
    return json.dumps(doc).encode()


@pytest.mark.parametrize("body, why", [
    (_without("triggers"), "triggers list absent"),
    (_without("gv_functions"), "gv_functions list absent"),
    (_without("extensions_functions"), "extensions_functions list absent"),
    (_cat_body(triggers={"count": 0, "rows": []}), "triggers list is empty"),
    (_cat_body(gv_functions={"count": 0, "rows": []}), "gv_functions list is empty"),
    (_cat_body(extensions_functions={"count": 0, "rows": []}), "extensions_functions list is empty"),
    (_cat_body(triggers={"count": 3, "rows": CAT_TRG}), "triggers count 3 != 2 rows"),
    (_cat_body(gv_functions={"count": "2", "rows": CAT_GV}), "gv_functions list has no count line"),
    (_cat_body(gv_functions={"count": True, "rows": ["gv.x()"]}), "gv_functions list has no count line"),
    (_cat_body(triggers={"count": 1, "rows": [["t", "public.plants", 7, "public.f"]]}), "wrong shape"),
    (_cat_body(gv_functions={"count": 1, "rows": [""]}), "wrong shape"),
    (_cat_body(format=2), "format"),
    (_cat_body(dump_key="db/garden-20261007.dump"), "written for dump"),
    (_cat_body(taken_at=""), "no taken_at"),
    (b"", "cannot be read"),
    (b"[]", "not a JSON object"),
], ids=["no-triggers", "no-gv", "no-extensions", "empty-triggers", "empty-gv", "empty-extensions",
        "count-mismatch", "count-not-int", "count-bool", "trigger-row-short", "fn-row-empty",
        "format", "other-dump", "no-taken-at", "empty-file", "array"])
def test_a_catalog_list_that_is_there_but_bad_fails_even_without_a_precedent(body, why):
    with pytest.raises(rv.VerifyError) as e:
        rv.load_cataloglist(_s3_cat(body), rv.Config(env=env()), DUMP)
    assert why in str(e.value)


def test_run_with_catalog_trigger_added_after_the_dump_is_green(monkeypatch, capsys):
    s3 = _s3_cat(_cat_body(), table_body=_list_body(_pub(CORE)), earlier=[YESTERDAY_CAT])
    cfg = _run_real(monkeypatch, s3, CORE, CORE)
    _prod_trg(monkeypatch, {"plants:audit_stmt_update:audit_stmt_update"})
    _restored(monkeypatch)
    rep = rv.run(cfg, s3=s3)
    out, err = capsys.readouterr()
    assert not rep["hard_failures"] and not _verdicts(err)
    assert (f"catalog list {CAT} (2 triggers, 2 gv_functions, 2 extensions_functions, "
            f"taken 2026-10-08T14:13:21Z)") in out
    assert "FELL BACK" not in out


def test_run_with_catalog_lost_trigger_reds_classified(monkeypatch, capsys):
    s3 = _s3_cat(_cat_body(), table_body=_list_body(_pub(CORE)))
    cfg = _run_real(monkeypatch, s3, CORE, CORE)
    _restored(monkeypatch, trg=[CAT_TRG[1]])
    with pytest.raises(rv.VerifyError):
        rv.run(cfg, s3=s3)
    v = _verdicts(capsys.readouterr().err)
    assert len(v) == 1 and "[OBJECTS LOST BY RESTORE]" in v[0] and "prevent_ownership_transfer" in v[0]
    assert f"triggers and functions with the dump-time list {CAT}" in v[0]


def test_run_without_an_expected_catalog_reds_before_any_restore(monkeypatch, capsys):
    s3 = _s3_cat(table_body=_list_body(_pub(CORE)), earlier=[YESTERDAY_CAT])
    cfg = _run_real(monkeypatch, s3, CORE, CORE)
    restored = {"n": 0}
    monkeypatch.setattr(rv, "restore_dump", lambda *a, **k: restored.__setitem__("n", 1))
    with pytest.raises(rv.VerifyError):
        rv.run(cfg, s3=s3)
    v = _verdicts(capsys.readouterr().err)
    assert len(v) == 1 and "[OTHER]" in v[0] and "absent" in v[0] and DUMP in v[0]
    assert restored["n"] == 0


def test_run_old_dump_says_it_fell_back_for_triggers(monkeypatch, capsys):
    s3 = _s3_cat(table_body=_list_body(_pub(CORE)))
    cfg = _run_real(monkeypatch, s3, CORE, CORE)
    monkeypatch.setattr(rv, "catalog_lists", lambda url: pytest.fail("no list: live comparison only"))
    rv.run(cfg, s3=s3)
    out, err = capsys.readouterr()
    (line,) = [ln for ln in out.splitlines() if "catalog list" in ln]
    assert line.startswith("::notice::[restore-verify] ") and "compared with LIVE prod instead" in line
    assert not _verdicts(err)


def test_catalog_lists_reads_the_restore_with_the_writers_pin(monkeypatch):
    seen = []

    def fake_run(cmd, **kw):
        seen.append(cmd)
        r = type("R", (), {})()
        r.returncode, r.stderr, r.stdout = 0, "", json.dumps(_lists())
        return r
    monkeypatch.setattr(rv.subprocess, "run", fake_run)
    got = rv.catalog_lists("postgresql://scratch")
    assert got == rv._catalog_sets(_lists())
    (cmd,) = seen
    assert cmd[-4:] == ["-c", "SET search_path TO pg_catalog", "-c", rv.CATALOG_LIST_SQL]


# --- the daily writer: backup.yml's own run: bodies, pg/aws stubbed ----------
# backup.yml checks out nothing, so its table-list writer is inline bash. These
# run the three real step bodies (dump -> upload -> verify) against stub
# binaries and feed what lands in "S3" to the reader above.

BACKUP_YML = os.path.join(HERE, "..", ".github", "workflows", "backup.yml")
DUMP_STEP, UPLOAD_STEP, VERIFY_STEP = (
    "pg_dump from Neon (prod)", "Upload to S3", "Verify upload (restorability floor)")
STUB_LISTED = ["gv.audit"] + sorted(f"public.{t}" for t in rv.SANITY_TABLES)

STUBS = {
    # Runs the command unbounded, but records what it was asked to bound it with.
    "timeout": r'''#!/bin/bash
k=none
[ "$1" = "-k" ] && { k="$2"; shift 2; }
printf 'k=%s duration=%s cmd=%s\n' "$k" "$1" "$2" >> "$STUB_TIMEOUT_LOG"
shift
exec "$@"
''',
    "psql": r'''#!/bin/bash
[ -n "$STUB_PSQL_FAIL" ] && { echo "psql: error: connection refused" >&2; exit 2; }
sql="${@: -1}"
case "$sql" in *pg_trigger*)
  [ -n "$STUB_CATALOG_FAIL" ] && { echo "psql: error: connection refused" >&2; exit 2; }
  printf '%s\n' "${STUB_CATALOG-$STUB_CATALOG_DEFAULT}"; exit 0;;
esac
key=$(printf '%s' "$sql" | sed -n "s/.*'dump_key', '\([^']*\)'.*/\1/p")
at=$(printf '%s' "$sql" | sed -n "s/.*'taken_at', '\([^']*\)'.*/\1/p")
printf '{"format" : 1, "dump_key" : "%s", "taken_at" : "%s", "tables" : %s}\n' "$key" "$at" "${STUB_TABLES:-$STUB_TABLES_DEFAULT}"
''',
    "pg_dump": '#!/bin/bash\nprintf "PGDMP-stub"\n',
    "pg_dumpall": '#!/bin/bash\nwhile [ "$1" != "-f" ]; do shift; done\necho "CREATE ROLE neondb_owner;" > "$2"\n',
    "pg_restore": '#!/bin/bash\nprintf "5; 2615 1 SCHEMA - extensions o\\n6; 2615 2 SCHEMA - gv o\\n"\n',
    "aws": r'''#!/bin/bash
if [ "$1 $2" = "s3 cp" ]; then
  key="${4#s3://bkt/}"
  case "$key" in *"$STUB_AWS_FAIL_SUFFIX") [ -n "$STUB_AWS_FAIL_SUFFIX" ] && { echo "upload failed: AccessDenied" >&2; exit 1; };; esac
  mkdir -p "$STUB_S3/$(dirname "$key")" && cp "$3" "$STUB_S3/$key"
  exit
fi
while [ "$1" != "--prefix" ]; do shift; done
f="$STUB_S3/$2"
[ -f "$f" ] || { echo None; exit 0; }
case "$2" in *.dump) echo 7998970;; *.globals.sql) echo 4096;; *) wc -c < "$f" | tr -d ' ';; esac
''',
}


def _backup_bodies(tmp_path):
    import yaml
    with open(BACKUP_YML) as fh:
        steps = {s.get("name"): s for s in yaml.safe_load(fh)["jobs"]["backup"]["steps"]}
    bindir = tmp_path / "bin"
    bindir.mkdir()
    for name, text in STUBS.items():
        (bindir / name).write_text(text)
        (bindir / name).chmod(0o755)
    work = tmp_path / "work"
    work.mkdir(exist_ok=True)

    def body(name):
        return (steps[name]["run"]
                .replace("${{ secrets.NEON_BACKUP_URL }}", "postgresql://stub")
                .replace("${{ vars.BACKUP_BUCKET_NAME }}", "bkt")
                .replace("/usr/lib/postgresql/17/bin", str(bindir)))
    return body, bindir


def _run_backup(tmp_path, **stub_env):
    """Run dump, upload, verify in order the way Actions does (`bash -e`, a failed
    step skips the rest). Returns ([(step, rc, output)], s3 dir, today's stamp)."""
    import subprocess
    body, bindir = _backup_bodies(tmp_path)
    s3dir = tmp_path / "s3"
    s3dir.mkdir(exist_ok=True)
    e = dict(os.environ, PATH=f"{bindir}{os.pathsep}{os.environ['PATH']}", STUB_S3=str(s3dir),
             GITHUB_ENV=str(tmp_path / "github_env"), STUB_TABLES_DEFAULT=json.dumps(STUB_LISTED),
             STUB_CATALOG_DEFAULT=json.dumps(_lists()),
             STUB_TIMEOUT_LOG=str(tmp_path / "timeout.log"), RUNNER_TEMP=str(tmp_path / "work"), **stub_env)
    results = []
    for name in (DUMP_STEP, UPLOAD_STEP, VERIFY_STEP):
        p = subprocess.run(["bash", "-e", "-c", body(name)], env=e, capture_output=True, text=True)
        results.append((name, p.returncode, p.stdout + p.stderr))
        if p.returncode != 0:
            break
    return results, s3dir, dt.datetime.now().strftime("%Y%m%d")


def test_daily_backup_writes_a_table_list_the_reader_accepts(tmp_path):
    results, s3dir, day = _run_backup(tmp_path)
    assert [rc for _, rc, _ in results] == [0, 0, 0], results
    dump_key = f"db/garden-{day}.dump"
    listed = s3dir / rv.tablelist_key_for(dump_key)
    doc = json.loads(listed.read_text())
    assert rv._tablelist_problem(doc, dump_key) is None
    assert doc["tables"] == STUB_LISTED
    assert _is_utc_stamp(doc["taken_at"])
    assert f"Table list verified: db/garden-{day}.tables.json" in results[2][2]
    # and through the reader's own S3 path
    pages = [{"Contents": [{"Key": dump_key, "LastModified": D(2026, 10, 12), "Size": 7998970},
                           {"Key": f"db/garden-{day}.tables.json", "LastModified": D(2026, 10, 12), "Size": 1}]}]
    s3 = FakeS3(pages, {(BUCKET, f"db/garden-{day}.tables.json"): listed.read_bytes()})
    assert rv.load_tablelist(s3, rv.Config(env=env()), dump_key)["tables"] == set(STUB_LISTED)


def test_daily_backup_writes_its_files_on_the_work_disk_not_tmp(tmp_path):
    # OPS-UBUNTU26MOVE-001: on ubuntu-26.04 /tmp is a RAM-backed tmpfs capped at
    # ~7.8G, so the prod dump goes to $RUNNER_TEMP, cleanup included.
    import yaml
    with open(BACKUP_YML) as fh:
        steps = yaml.safe_load(fh)["jobs"]["backup"]["steps"]
    assert [s["name"] for s in steps if "/tmp" in s.get("run", "")] == []
    results, _, day = _run_backup(tmp_path)
    assert [rc for _, rc, _ in results] == [0, 0, 0], results
    assert (tmp_path / "work" / f"garden-{day}.dump").exists()


def test_daily_backup_bounds_the_table_list_read(tmp_path):
    # I4 / M2: a hung psql must not hold the dump. The stub records the bound it was
    # given, so dropping `timeout`, its duration or its -k reds here.
    import re
    results, _, _ = _run_backup(tmp_path)
    assert [rc for _, rc, _ in results] == [0, 0, 0], results
    calls = (tmp_path / "timeout.log").read_text().splitlines()
    # the table list and the catalog list (2.0c), each bounded
    assert len(calls) == 2, calls
    assert all(re.fullmatch(r"k=[1-9]\d* duration=[1-9]\d* cmd=psql", c) for c in calls), calls


def test_daily_backup_still_dumps_when_the_failed_list_cannot_be_removed(tmp_path):
    # M1: under `bash -e` a failing `rm` in the failed-read branch would end the step
    # BEFORE pg_dump. A directory at the list's path makes both the read and the rm fail.
    day = dt.datetime.now().strftime("%Y%m%d")
    (tmp_path / "work" / f"garden-{day}.tables.json").mkdir(parents=True)
    results, s3dir, _ = _run_backup(tmp_path)
    assert [(n, rc) for n, rc, _ in results] == [(DUMP_STEP, 0), (UPLOAD_STEP, 0), (VERIFY_STEP, 1)], results
    assert (s3dir / "db" / f"garden-{day}.dump").exists()
    assert "::error::Table list FAILED" in results[2][2]


def test_daily_backup_requires_the_same_core_tables_as_the_reader(tmp_path):
    body, _ = _backup_bodies(tmp_path)
    for t in rv.SANITY_TABLES:
        assert f'"public.{t}"' in body(VERIFY_STEP)


def _is_utc_stamp(s):
    import re
    return re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", s)


@pytest.mark.parametrize("stub_env, stale", [
    (dict(STUB_PSQL_FAIL="1"), False),
    (dict(STUB_PSQL_FAIL="1"), True),              # an earlier run's list is still in S3
    (dict(STUB_AWS_FAIL_SUFFIX=".tables.json"), False),
    (dict(STUB_AWS_FAIL_SUFFIX=".tables.json"), True),
    # I2 / S5b: the earlier run's list differs in taken_at only, so it is the SAME LENGTH
    (dict(STUB_AWS_FAIL_SUFFIX=".tables.json"), "same-length"),
    (dict(STUB_TABLES="[]"), False),
    (dict(STUB_TABLES='["gv.audit"]'), False),
    (dict(STUB_TABLES='["public.plants"]'), False),  # M7
], ids=["read-fails", "read-fails-stale-list", "upload-fails", "upload-fails-stale-list",
        "upload-fails-stale-list-same-length", "empty-list", "no-public-table", "one-table"])
def test_daily_backup_without_a_good_list_is_red_but_the_dump_is_up_and_verified(tmp_path, stub_env, stale):
    day = dt.datetime.now().strftime("%Y%m%d")
    older = '{"older": "list"}'
    if stale == "same-length":
        older = ('{"format" : 1, "dump_key" : "db/garden-%s.dump", "taken_at" : "2026-01-01T00:00:00Z", '
                 '"tables" : %s}\n' % (day, json.dumps(STUB_LISTED)))
    if stale:
        (tmp_path / "s3" / "db").mkdir(parents=True)
        (tmp_path / "s3" / "db" / f"garden-{day}.tables.json").write_text(older)
    results, s3dir, day = _run_backup(tmp_path, **stub_env)
    if stale == "same-length":
        # the scenario is real: S3 still holds the older list, byte for byte as long as tonight's
        in_s3 = (s3dir / "db" / f"garden-{day}.tables.json").read_text()
        assert in_s3 == older and len(in_s3) == (tmp_path / "work" / f"garden-{day}.tables.json").stat().st_size
    # the dump and upload steps do NOT fail: tonight's dump is never lost to its list
    assert [(n, rc) for n, rc, _ in results] == [(DUMP_STEP, 0), (UPLOAD_STEP, 0), (VERIFY_STEP, 1)], results
    assert (s3dir / "db" / f"garden-{day}.dump").exists()
    assert (s3dir / "db" / f"garden-{day}.globals.sql").exists()
    out = results[2][2]
    # ...and it is verified BEFORE the list reds the job, loudly
    assert out.index("Upload verified: ") < out.index("::error::Table list FAILED")
    assert "Table list verified" not in out
    assert "is uploaded and verified; only its table list is not" in out


# --- the daily writer's catalog list (2.0c) -----------------------------------

def test_daily_backup_reads_the_catalog_with_the_one_sql_text_and_the_pin(tmp_path):
    body, _ = _backup_bodies(tmp_path)
    dump = body(DUMP_STEP)
    assert f'-c "{rv.CATALOG_LIST_SQL}"' in dump
    assert '-c "SET search_path TO pg_catalog"' in dump
    # read BEFORE pg_dump, like the table list
    assert dump.index(rv.CATALOG_LIST_SQL) < dump.index('pg_dump "postgresql://stub"')


def test_daily_backup_writes_a_catalog_list_the_reader_accepts(tmp_path):
    results, s3dir, day = _run_backup(tmp_path)
    assert [rc for _, rc, _ in results] == [0, 0, 0], results
    dump_key = f"db/garden-{day}.dump"
    cat_key = rv.cataloglist_key_for(dump_key)
    doc = json.loads((s3dir / cat_key).read_text())
    assert rv._cataloglist_problem(doc, dump_key) is None and _is_utc_stamp(doc["taken_at"])
    assert (f"Catalog list verified: {cat_key} " in results[2][2]
            and "2 triggers, 2 gv functions, 2 extensions functions" in results[2][2])
    pages = [{"Contents": [{"Key": dump_key, "LastModified": D(2026, 10, 12), "Size": 7998970},
                           {"Key": cat_key, "LastModified": D(2026, 10, 12), "Size": 1}]}]
    s3 = FakeS3(pages, {(BUCKET, cat_key): (s3dir / cat_key).read_bytes()})
    assert rv.load_cataloglist(s3, rv.Config(env=env()), dump_key)["gv_functions"] == set(CAT_GV)
    assert not list((tmp_path / "work").glob("*.raw"))


def _no_count(name):
    lists = _lists()
    del lists[name]["count"]
    return json.dumps(lists)


@pytest.mark.parametrize("stub_env", [
    dict(STUB_CATALOG_FAIL="1"),
    dict(STUB_CATALOG=""),
    dict(STUB_CATALOG="not json"),
    dict(STUB_AWS_FAIL_SUFFIX=".catalog.json"),
    dict(STUB_CATALOG=json.dumps({k: v for k, v in _lists().items() if k != "gv_functions"})),
    dict(STUB_CATALOG=json.dumps(_lists(trg=[]))),
    dict(STUB_CATALOG=_no_count("triggers")),
    dict(STUB_CATALOG=_no_count("gv_functions")),
    dict(STUB_CATALOG=_no_count("extensions_functions")),
], ids=["read-fails", "no-output", "not-json", "upload-fails", "gv-list-absent", "empty-triggers",
        "triggers-no-count", "gv-no-count", "extensions-no-count"])
def test_daily_backup_without_a_good_catalog_list_is_red_but_the_dump_is_up_and_verified(tmp_path, stub_env):
    results, s3dir, day = _run_backup(tmp_path, **stub_env)
    assert [(n, rc) for n, rc, _ in results] == [(DUMP_STEP, 0), (UPLOAD_STEP, 0), (VERIFY_STEP, 1)], results
    assert (s3dir / "db" / f"garden-{day}.dump").exists()
    out = results[2][2]
    assert out.index("Upload verified: ") < out.index("Table list verified") < out.index("::error::Catalog list FAILED")
    assert "Catalog list verified" not in out
    assert "is uploaded and verified; only its catalog list is not" in out
