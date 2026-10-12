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
    monkeypatch.setattr(rv, "assess", lambda cfg2, uri, full_scope, tablelist=None: assess_result)
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


def _s3_with_list(body=None, denied=()):
    """One dump under the prefix; body=None means no list object beside it."""
    contents = [{"Key": DUMP, "LastModified": D(2026, 10, 8), "Size": 7901527}]
    objects = {(BUCKET, DUMP): b"D"}
    if body is not None:
        contents.append({"Key": LIST, "LastModified": D(2026, 10, 8), "Size": len(body)})
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


@pytest.mark.parametrize("body", [
    b"", b"not json", b"[]", b"null",
    _list_body([]),                                  # empty is never "prod had no tables"
    _list_body(_pub(CORE), tables="public.plants"),  # not a list
    _list_body(_pub(CORE), format=2),
    _list_body(_pub(CORE), dump_key="db/garden-20261007.dump"),  # another dump's list
    _list_body(_pub(CORE), taken_at=""),
    _list_body(CORE),                                # not schema-qualified
    _list_body({"gv.audit"}),                        # no public table at all
], ids=["empty-file", "not-json", "array", "null", "no-tables", "tables-not-list", "format",
        "other-dump", "no-taken-at", "unqualified", "no-public"])
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
    assert klass == "PROD AHEAD OF DUMP" and "seed_lot_addition" in detail and "no table list" in detail


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


def test_trigger_on_a_prod_ahead_table_still_reds_and_says_why(monkeypatch):
    # Triggers are still compared with LIVE prod (behaviour kept). The verdict names it.
    cfg = rv.Config(env=env())
    counts = {t: 100 for t in CORE}
    _patch_introspect(monkeypatch, CORE | {"seed_lot_addition"}, CORE, counts, dict(counts))
    monkeypatch.setattr(rv, "trigger_set", lambda url: (
        TRG | {"seed_lot_addition:bump:bump_version"} if "prod" in url else TRG))
    ok, rep = rv.assess(cfg, "postgresql://scratch", full_scope=True, tablelist=_tl(CORE))
    assert not ok and len(rep["hard_failures"]) == 1
    klass, detail = rv.classify_failure(rep)
    assert klass == "PROD AHEAD OF DUMP" and "triggers are still compared with live prod" in detail


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


def test_run_without_list_says_it_fell_back(monkeypatch, capsys):
    s3 = _s3_with_list()
    cfg = _run_real(monkeypatch, s3, CORE, CORE)
    rv.run(cfg, s3=s3)
    out, err = capsys.readouterr()
    assert out.count("FELL BACK to live prod's table list") == 1
    assert f"{LIST} absent" in out and not _verdicts(err)


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


# --- the daily writer: backup.yml's own run: bodies, pg/aws stubbed ----------
# backup.yml checks out nothing, so its table-list writer is inline bash. These
# run the three real step bodies (dump -> upload -> verify) against stub
# binaries and feed what lands in "S3" to the reader above.

BACKUP_YML = os.path.join(HERE, "..", ".github", "workflows", "backup.yml")
DUMP_STEP, UPLOAD_STEP, VERIFY_STEP = (
    "pg_dump from Neon (prod)", "Upload to S3", "Verify upload (restorability floor)")

STUBS = {
    "timeout": '#!/bin/bash\nshift\nexec "$@"\n',
    "psql": r'''#!/bin/bash
[ -n "$STUB_PSQL_FAIL" ] && { echo "psql: error: connection refused" >&2; exit 2; }
sql="${@: -1}"
key=$(printf '%s' "$sql" | sed -n "s/.*'dump_key', '\([^']*\)'.*/\1/p")
at=$(printf '%s' "$sql" | sed -n "s/.*'taken_at', '\([^']*\)'.*/\1/p")
printf '{"format" : 1, "dump_key" : "%s", "taken_at" : "%s", "tables" : %s}\n' "$key" "$at" "${STUB_TABLES:-[\"gv.audit\", \"public.plants\"]}"
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
    work.mkdir()

    def body(name):
        return (steps[name]["run"]
                .replace("${{ secrets.NEON_BACKUP_URL }}", "postgresql://stub")
                .replace("${{ vars.BACKUP_BUCKET_NAME }}", "bkt")
                .replace("/usr/lib/postgresql/17/bin", str(bindir))
                .replace("/tmp/", f"{work}/"))
    return body, bindir


def _run_backup(tmp_path, **stub_env):
    """Run dump, upload, verify in order the way Actions does (`bash -e`, a failed
    step skips the rest). Returns ([(step, rc, output)], s3 dir, today's stamp)."""
    import subprocess
    body, bindir = _backup_bodies(tmp_path)
    s3dir = tmp_path / "s3"
    s3dir.mkdir(exist_ok=True)
    e = dict(os.environ, PATH=f"{bindir}{os.pathsep}{os.environ['PATH']}", STUB_S3=str(s3dir),
             GITHUB_ENV=str(tmp_path / "github_env"), **stub_env)
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
    assert doc["tables"] == ["gv.audit", "public.plants"]
    assert _is_utc_stamp(doc["taken_at"])
    assert f"Table list verified: db/garden-{day}.tables.json" in results[2][2]
    # and through the reader's own S3 path
    pages = [{"Contents": [{"Key": dump_key, "LastModified": D(2026, 10, 12), "Size": 7998970},
                           {"Key": f"db/garden-{day}.tables.json", "LastModified": D(2026, 10, 12), "Size": 1}]}]
    s3 = FakeS3(pages, {(BUCKET, f"db/garden-{day}.tables.json"): listed.read_bytes()})
    assert rv.load_tablelist(s3, rv.Config(env=env()), dump_key)["tables"] == {"gv.audit", "public.plants"}


def _is_utc_stamp(s):
    import re
    return re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", s)


@pytest.mark.parametrize("stub_env, stale", [
    (dict(STUB_PSQL_FAIL="1"), False),
    (dict(STUB_PSQL_FAIL="1"), True),              # an earlier run's list is still in S3
    (dict(STUB_AWS_FAIL_SUFFIX=".tables.json"), False),
    (dict(STUB_AWS_FAIL_SUFFIX=".tables.json"), True),
    (dict(STUB_TABLES="[]"), False),
    (dict(STUB_TABLES='["gv.audit"]'), False),
], ids=["read-fails", "read-fails-stale-list", "upload-fails", "upload-fails-stale-list",
        "empty-list", "no-public-table"])
def test_daily_backup_without_a_good_list_is_red_but_the_dump_is_up_and_verified(tmp_path, stub_env, stale):
    day = dt.datetime.now().strftime("%Y%m%d")
    if stale:
        (tmp_path / "s3" / "db").mkdir(parents=True)
        (tmp_path / "s3" / "db" / f"garden-{day}.tables.json").write_text('{"older": "list"}')
    results, s3dir, day = _run_backup(tmp_path, **stub_env)
    # the dump and upload steps do NOT fail: tonight's dump is never lost to its list
    assert [(n, rc) for n, rc, _ in results] == [(DUMP_STEP, 0), (UPLOAD_STEP, 0), (VERIFY_STEP, 1)], results
    assert (s3dir / "db" / f"garden-{day}.dump").exists()
    assert (s3dir / "db" / f"garden-{day}.globals.sql").exists()
    out = results[2][2]
    # ...and it is verified BEFORE the list reds the job, loudly
    assert out.index("Upload verified: ") < out.index("::error::Table list FAILED")
    assert "Table list verified" not in out
    assert "is uploaded and verified; only its table list is not" in out
