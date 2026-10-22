"""Tests for scripts/tenancykey-apply.py (V5-SPACETENANCYKEY-001, multi-space step 2.1: migrations/v5-tenancykey-001).

Run: python3 -m pytest -q scripts/test_tenancykey_apply.py

No database: psql is replaced by a fake that keeps a schema_version set and fails on a chosen file, so the order,
the stop at the first refusal, the resume at the first missing stamp, the DDL windows, the prod refusal and the
scrubbing of connection details are held here. The real files against a real PostgreSQL 17 are rehearsed by
migrations/v5-tenancykey-001/rehearse_local.py (README.md "Rehearsal").
"""
import datetime as dt
import importlib.util
import json
import os
import re

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("tenancykey_apply", os.path.join(HERE, "tenancykey-apply.py"))
tk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tk)

OWNER_CLASSES = json.load(open(os.path.join(tk.MIGRATION, "owner-classes.json")))
PW = "s3cret-pw-not-for-printing"
HOST = "ep-quiet-lake-a1b2c3-pooler.us-east-2.aws.neon.tech"
URL = f"postgresql://neondb_owner:{PW}@{HOST}/neondb?sslmode=require&channel_binding=require"


def at(h, m):
    return lambda: dt.datetime(2026, 10, 20, h, m, 30, tzinfo=dt.timezone.utc)


def env_file(tmp_path, url=URL, key="NEON_STAGING_URL"):
    p = tmp_path / ".env.local"
    p.write_text(f"# x\n{key}={url}\n")
    return str(p)


# ── the DDL windows (plan V204 §2.8: :00 ±2 min and 07:00-08:00 UTC) ───────────────────────────────────

@pytest.mark.parametrize("h,m,inside", [
    (10, 57, False), (10, 58, True), (10, 59, True), (11, 0, True), (11, 1, True), (11, 2, False),
    (6, 57, False), (6, 58, True), (7, 0, True), (7, 30, True), (7, 59, True), (8, 1, True), (8, 2, False),
    (23, 59, True), (0, 0, True), (14, 30, False),
])
def test_ddl_window(h, m, inside):
    assert (tk.ddl_window(at(h, m)()) is not None) is inside


# ── refusals before anything is read or run ─────────────────────────────────────────────────────────────

def boom(*a, **k):
    raise AssertionError("nothing may be read or run")


def test_prod_apply_refused_without_daves_ok(monkeypatch, capsys):
    monkeypatch.setattr(tk.subprocess, "run", boom)
    monkeypatch.setattr(tk, "read_key", boom)
    assert tk.main(["--env", "prod", "--env-file", "/nonexistent"], clock=at(14, 30)) == 1
    assert "REFUSED" in capsys.readouterr().err


def test_window_refused_before_anything(monkeypatch, capsys):
    monkeypatch.setattr(tk.subprocess, "run", boom)
    monkeypatch.setattr(tk, "read_key", boom)
    assert tk.main(["--env", "staging", "--env-file", "/nonexistent"], clock=at(7, 15)) == 1
    assert "DDL window" in capsys.readouterr().err


def test_rehearsal_refused_on_a_real_host(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(tk.subprocess, "run", boom)
    monkeypatch.setattr(tk.shutil, "which", lambda _: "/usr/bin/psql")
    assert tk.main(["--env", "prod", "--rehearsal", "--env-file", env_file(tmp_path, key="NEON_DATABASE_URL")],
                   clock=at(7, 15)) == 1
    err = capsys.readouterr().err
    assert "loopback" in err and HOST not in err and PW not in err


def test_env_must_be_named():
    with pytest.raises(SystemExit) as e:
        tk.main([])
    assert e.value.code == 2


# ── the files ──────────────────────────────────────────────────────────────────────────────────────────────

def test_files_are_the_json_table_list_in_order_one_stamp_each():
    files = tk.migration_files()
    assert len(files) == len(OWNER_CLASSES["tables"]) == 25
    for (path, stamp), row in zip(files, OWNER_CLASSES["tables"]):
        assert path.name.startswith(f"{row['n']:02d}-")
        assert stamp.startswith(OWNER_CLASSES["stampPrefix"]) and stamp.endswith(row["table"].replace("_", "-"))


def test_a_gap_in_the_numbering_refuses(tmp_path):
    for n in (1, 3):
        (tmp_path / f"{n:02d}-x{n}.sql").write_text(
            f"INSERT INTO public.schema_version (version, description)\nVALUES ('s{n}', 'd');")
    with pytest.raises(ValueError, match="expected file number 02"):
        tk.migration_files(tmp_path)


@pytest.mark.parametrize("directory", sorted(tk.MIGRATIONS))
def test_the_dry_run_block_is_read_only_sql(directory):
    for path, _ in tk.migration_files(tk.REPO / "migrations" / directory):
        block = tk.pregate_block(path)
        assert block.startswith("DO $pregate$") and block.endswith("END $pregate$;")
        body = re.sub(r"'(?:[^']|'')*'", "''", block)  # string literals out: messages may say anything
        assert not re.search(r"\b(ALTER|CREATE|DROP|INSERT|UPDATE|DELETE|LOCK|TRUNCATE|GRANT|VALIDATE|COMMENT)\b",
                             body), path.name
        assert f"current_setting('{tk.MIGRATIONS[directory]}', true)" in block, path.name


# ── v5-tenancyvalidate-001 (step 2.3) through the same runner ──────────────────────────────────────────────

VALIDATE_DIR = tk.REPO / "migrations" / "v5-tenancyvalidate-001"


def test_validate_files_follow_the_key_files_one_for_one():
    keys, vals = tk.migration_files(), tk.migration_files(VALIDATE_DIR)
    assert len(vals) == len(keys) == 25
    for (kp, ks), (vp, vs) in zip(keys, vals):
        assert vp.name[:3] == kp.name[:3], "file NN validates the key file NN made"
        table = re.sub(r"^\d\d-(fk-)?", "", kp.name)[:-4]
        assert vs == f"5.3.14-tenancyvalidate-001-{table}" and f"'{ks}'" in vp.read_text()


def test_dir_must_be_known():
    with pytest.raises(SystemExit) as e:
        tk.main(["--env", "staging", "--dir", "v5-somethingelse-001"])
    assert e.value.code == 2


def test_validate_dry_run_sets_its_own_env_setting(monkeypatch, tmp_path, capsys):
    db = FakeDb()
    assert run(monkeypatch, tmp_path, db, "--dir", "v5-tenancyvalidate-001", "--dry-run") == 0
    guards = [s for s, ro in db.sql if "$pregate$" in s]
    assert len(guards) == 25 and all(ro for _, ro in db.sql) and db.ran == []
    assert all("set_config('tenancyvalidate.env', 'staging', true)" in s for s in guards)
    assert "v5-tenancyvalidate-001, --env staging" in capsys.readouterr().out


def test_validate_stops_at_the_refused_file_and_resumes_there(monkeypatch, tmp_path, capsys):
    files = [p.name for p, _ in tk.migration_files(VALIDATE_DIR)]
    db = FakeDb(refuse={files[6]})
    assert run(monkeypatch, tmp_path, db, "--dir", "v5-tenancyvalidate-001") == 1
    assert db.ran == files[:7]
    db.refuse.clear()
    db.ran.clear()
    assert run(monkeypatch, tmp_path, db, "--dir", "v5-tenancyvalidate-001") == 0
    assert db.ran == files[6:]
    assert f"resumes at {files[6]}" in capsys.readouterr().out


def test_validate_on_prod_needs_daves_ok(monkeypatch, capsys):
    monkeypatch.setattr(tk.subprocess, "run", boom)
    monkeypatch.setattr(tk, "read_key", boom)
    assert tk.main(["--env", "prod", "--dir", "v5-tenancyvalidate-001", "--env-file", "/nonexistent"],
                   clock=at(14, 30)) == 1
    assert "REFUSED" in capsys.readouterr().err


# ── the run: order, stop at the first refusal, resume at the first missing stamp ──────────────────────────

class FakeDb:
    """psql stand-in: a schema_version set; a file applies by adding its stamp unless it is in `refuse`."""

    def __init__(self, stamps=(), refuse=()):
        self.stamps = set(stamps)
        self.refuse = set(refuse)
        self.ran = []
        self.sql = []

    def __call__(self, pg, *, file=None, sql=None, variables=(), read_only=False):
        if file is not None:
            self.ran.append(file.name)
            assert dict(variables) == {"env": "staging"}
            if file.name in self.refuse:
                return 3, "", f"psql:{file}:90: ERROR:  v5-tenancykey-001 refused, nothing changed: host {HOST} pw {PW}"
            self.stamps.add(tk.STAMP_RE.findall(file.read_text())[0])
            return 0, "", ""
        self.sql.append((sql, read_only))
        if sql.startswith("SELECT version FROM public.schema_version"):
            assert read_only
            want = re.findall(r"'([^']+)'", sql)
            return 0, "\n".join(s for s in want if s in self.stamps), ""
        return 0, "", ""


def run(monkeypatch, tmp_path, db, *extra):
    monkeypatch.setattr(tk, "psql", db)
    monkeypatch.setattr(tk.shutil, "which", lambda _: "/usr/bin/psql")
    return tk.main(["--env", "staging", "--env-file", env_file(tmp_path), *extra], clock=at(14, 30))


def test_stops_at_the_refused_file_and_resumes_there(monkeypatch, tmp_path, capsys):
    files = [p.name for p, _ in tk.migration_files()]
    db = FakeDb(refuse={files[6]})
    assert run(monkeypatch, tmp_path, db) == 1
    assert db.ran == files[:7], "files 01-07 tried, nothing after the refusal"
    out = capsys.readouterr().out
    assert f"FAIL {files[6]}" in out and HOST not in out and PW not in out

    db.refuse.clear()
    db.ran.clear()
    assert run(monkeypatch, tmp_path, db) == 0
    assert db.ran == files[6:], "the re-run starts at file 07"
    out = capsys.readouterr().out
    assert f"resumes at {files[6]}" in out and out.count("SKIP ") == 6


def test_a_window_reached_mid_run_stops_before_the_next_file(monkeypatch, tmp_path, capsys):
    times = iter([at(14, 30)(), at(14, 30)(), at(14, 30)(), at(14, 58)()])
    db = FakeDb()
    monkeypatch.setattr(tk, "psql", db)
    monkeypatch.setattr(tk.shutil, "which", lambda _: "/usr/bin/psql")
    assert tk.main(["--env", "staging", "--env-file", env_file(tmp_path)], clock=lambda: next(times)) == 1
    assert len(db.ran) == 2
    assert "run again outside the window" in capsys.readouterr().out


def test_dry_run_reads_only_and_runs_no_file(monkeypatch, tmp_path, capsys):
    db = FakeDb(stamps={tk.migration_files()[0][1]})
    assert run(monkeypatch, tmp_path, db, "--dry-run") == 0
    assert db.ran == []
    guards = [s for s, ro in db.sql if "$pregate$" in s]
    assert len(guards) == 24 and all(ro for s, ro in db.sql)
    assert all(s.startswith("BEGIN TRANSACTION READ ONLY;") and s.rstrip().endswith("ROLLBACK;") for s in guards)
    assert "1 of 25 stamps present; resumes at 02-" in capsys.readouterr().out


def test_dry_run_on_prod_needs_no_ok_and_is_still_read_only(monkeypatch, tmp_path):
    db = FakeDb()
    monkeypatch.setattr(tk, "psql", db)
    monkeypatch.setattr(tk.shutil, "which", lambda _: "/usr/bin/psql")
    assert tk.main(["--env", "prod", "--dry-run", "--env-file", env_file(tmp_path, key="NEON_DATABASE_URL")],
                   clock=at(7, 15)) == 0
    assert db.ran == [] and all(ro for _, ro in db.sql)


def test_the_url_reaches_psql_only_through_the_environment(monkeypatch):
    seen = {}

    class R:
        returncode, stdout, stderr = 0, "", ""

    def fake_run(args, env, **kw):
        seen["args"], seen["env"] = args, env
        return R()

    monkeypatch.setattr(tk.subprocess, "run", fake_run)
    tk.psql(tk.libpq_env(URL, "NEON_STAGING_URL"), sql="SELECT 1", read_only=True)
    assert not any(PW in a or HOST in a for a in seen["args"])
    assert seen["env"]["PGPASSWORD"] == PW and seen["env"]["PGHOST"] == HOST
    assert "default_transaction_read_only=on" in seen["env"]["PGOPTIONS"]
