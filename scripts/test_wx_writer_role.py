"""Tests for scripts/wx-writer-role.py (V5-WXCOLDBAND-001, the cold-range writer's own login).

Run: python3 -m pytest -q scripts/test_wx_writer_role.py

The unit tests need no database: they hold the parts that keep a URL or a password out of argv and out
of the output, the env-file rewrite, and the prod refusal. The last test runs
migrations/v5-wxcoldband-001/rehearse_writer_role.py (a throwaway local cluster: 1a, 1r and this script,
every verb) when initdb, pg_ctl, psql and pg_dump are all on PATH, and is skipped otherwise.
"""
import importlib.util
import os
import shutil
import stat
import subprocess
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
REHEARSAL = os.path.join(HERE, "..", "migrations", "v5-wxcoldband-001", "rehearse_writer_role.py")
spec = importlib.util.spec_from_file_location("wx_writer_role", os.path.join(HERE, "wx-writer-role.py"))
wx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wx)

OWNER_PW = "Own3r-pw_value-not-for-printing"
OWNER_URL = (f"postgresql://neondb_owner:{OWNER_PW}@ep-quiet-lake-a1b2c3-pooler.us-east-2.aws.neon.tech/neondb"
             "?sslmode=require&channel_binding=require")


def env_file(tmp_path, text, mode=0o600):
    p = tmp_path / ".env.local"
    p.write_text(text)
    p.chmod(mode)
    return p


# ── prod refusal ─────────────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("verb", ["apply", "verify", "rollback"])
def test_prod_refused_without_daves_ok_before_anything_is_read_or_run(verb, monkeypatch, capsys):
    def boom(*a, **k):
        raise AssertionError("nothing may run")
    monkeypatch.setattr(wx.subprocess, "run", boom)
    monkeypatch.setattr(wx, "read_key", boom)
    assert wx.main([verb, "--env", "prod", "--env-file", "/nonexistent/.env.local"]) == 1
    assert "REFUSED" in capsys.readouterr().err


def test_env_must_be_named():
    with pytest.raises(SystemExit) as e:
        wx.main(["apply"])
    assert e.value.code == 2


# ── the env file ─────────────────────────────────────────────────────────────────────────────────

def test_read_key_by_name_first_wins_quotes_stripped(tmp_path):
    p = env_file(tmp_path, "# c\nNEON_STAGING_URL='postgresql://a'\nNEON_STAGING_URL=postgresql://b\nX=1\n")
    assert wx.read_key(p, "NEON_STAGING_URL") == "postgresql://a"
    assert wx.read_key(p, "NEON_DATABASE_URL") is None


def test_rewrite_replaces_one_line_dedupes_and_keeps_the_rest_and_the_mode(tmp_path):
    p = env_file(tmp_path, "A=1\nWX_WRITER_DATABASE_URL_STAGING=old\nB=2\n WX_WRITER_DATABASE_URL_STAGING = older\nC='3'",
                 mode=0o640)
    assert wx.rewrite_key(p, "WX_WRITER_DATABASE_URL_STAGING", "new") is True
    assert p.read_text() == "A=1\nWX_WRITER_DATABASE_URL_STAGING=new\nB=2\nC='3'"
    assert stat.S_IMODE(p.stat().st_mode) == 0o640
    assert not [f for f in os.listdir(tmp_path) if f != ".env.local"], "no temporary file left behind"


def test_rewrite_appends_after_an_unterminated_last_line(tmp_path):
    p = env_file(tmp_path, "A=1")
    assert wx.rewrite_key(p, "WX_WRITER_DATABASE_URL_PROD", "v") is False
    assert p.read_text() == "A=1\nWX_WRITER_DATABASE_URL_PROD=v\n"


def test_rewrite_removes_and_leaves_an_absent_key_alone(tmp_path):
    p = env_file(tmp_path, "A=1\nWX_WRITER_DATABASE_URL_PROD=v\nB=2\n")
    assert wx.rewrite_key(p, "WX_WRITER_DATABASE_URL_PROD", None) is True
    assert p.read_text() == "A=1\nB=2\n"
    inode = p.stat().st_ino
    assert wx.rewrite_key(p, "WX_WRITER_DATABASE_URL_PROD", None) is False
    assert p.stat().st_ino == inode, "nothing to remove: the file is not rewritten"


def test_rewrite_does_not_touch_a_key_that_merely_starts_the_same(tmp_path):
    p = env_file(tmp_path, "WX_WRITER_DATABASE_URL_STAGING_OLD=keep\n")
    wx.rewrite_key(p, "WX_WRITER_DATABASE_URL_STAGING", "v")
    assert p.read_text() == "WX_WRITER_DATABASE_URL_STAGING_OLD=keep\nWX_WRITER_DATABASE_URL_STAGING=v\n"


# ── URLs ─────────────────────────────────────────────────────────────────────────────────────────

def test_libpq_env_splits_a_neon_url():
    env = wx.libpq_env(OWNER_URL + "&options=endpoint%3Dep-quiet-lake-a1b2c3", "NEON_DATABASE_URL")
    assert env == {"PGHOST": "ep-quiet-lake-a1b2c3-pooler.us-east-2.aws.neon.tech", "PGUSER": "neondb_owner",
                   "PGPASSWORD": OWNER_PW, "PGDATABASE": "neondb", "PGSSLMODE": "require",
                   "PGCHANNELBINDING": "require", "PGOPTIONS": "endpoint=ep-quiet-lake-a1b2c3"}


def test_libpq_env_decodes_a_percent_encoded_password_and_keeps_a_port():
    env = wx.libpq_env("postgresql://u:p%40ss%2Fw@127.0.0.1:55498/db", "K")
    assert (env["PGPASSWORD"], env["PGPORT"], env["PGHOST"]) == ("p@ss/w", "55498", "127.0.0.1")


@pytest.mark.parametrize("url, said", [
    ("mysql://u:secretpw@h/db", "not a postgresql:// URL"),
    ("postgresql://u:secretpw@h1,h2/db", "more than one host"),
    ("postgresql://u:secretpw@h/db?sslmode=require&hostaddr=10.0.0.1", "does not pass on: hostaddr"),
    ("postgresql://h/db", "no host or no user"),
])
def test_libpq_env_refusals_name_the_key_never_a_value(url, said):
    with pytest.raises(ValueError) as e:
        wx.libpq_env(url, "NEON_STAGING_URL")
    msg = str(e.value)
    assert said in msg and "NEON_STAGING_URL" in msg and "secretpw" not in msg and "10.0.0.1" not in msg


def test_writer_url_keeps_host_database_and_parameters_and_swaps_the_login():
    pw = wx.new_password()
    url = wx.writer_url(OWNER_URL, pw)
    owner, writer = wx.libpq_env(OWNER_URL, "o"), wx.libpq_env(url, "w")
    assert writer["PGUSER"] == "garden_wx_writer" and writer["PGPASSWORD"] == pw
    assert {k: v for k, v in writer.items() if k not in ("PGUSER", "PGPASSWORD")} == \
           {k: v for k, v in owner.items() if k not in ("PGUSER", "PGPASSWORD")}
    assert OWNER_PW not in url and "neondb_owner" not in url


def test_password_shape_and_its_sql():
    pw = wx.new_password()
    assert len(pw) == 43 and set(pw) <= set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")
    assert wx.password_sql(pw) == f"ALTER ROLE garden_wx_writer PASSWORD '{pw}';\n"
    assert wx.new_password() != pw
    with pytest.raises(ValueError):
        wx.password_sql("x" * 42 + "'")


def test_scrub_replaces_host_password_database_and_addresses():
    pg = wx.libpq_env(OWNER_URL, "k")
    text = ('connection to server at "ep-quiet-lake-a1b2c3-pooler.us-east-2.aws.neon.tech" (3.5.140.2), port 5432 '
            f'failed: password {OWNER_PW} for database "neondb"; also (2600:1f18:2a::7), port 5432')
    out = wx.scrub(text, pg)
    for secret in ("ep-quiet-lake", OWNER_PW, '"neondb"', "3.5.140.2", "2600:1f18"):
        assert secret not in out
    assert "<host>" in out and "<password>" in out and "<ip>" in out


def test_child_env_drops_every_inherited_connection_variable(monkeypatch):
    for k in ("PGPASSWORD", "PGHOST", "PGSERVICEFILE", "NEON_DATABASE_URL", "WX_WRITER_DATABASE_URL_PROD", "DATABASE_URL"):
        monkeypatch.setenv(k, "inherited")
    env = wx.child_env({"PGHOST": "h", "PGUSER": "u"})
    assert not [k for k, v in env.items() if v == "inherited"]
    assert env["PGHOST"] == "h" and env["PGCONNECT_TIMEOUT"] == "15"


# ── apply, with psql replaced: no secret on any command line or in the output ───────────────────

def test_apply_keeps_every_secret_off_argv_and_out_of_the_output(tmp_path, monkeypatch, capsys):
    p = env_file(tmp_path, f"NEON_STAGING_URL={OWNER_URL}\nOTHER=1\n")
    calls = []

    def fake_run(args, env=None, input=None, capture_output=None, text=None):
        calls.append((list(args), dict(env or {}), input or ""))
        if "-c" in args:
            sql = args[args.index("-c") + 1]
            if sql == wx.IDENTITY:
                return subprocess.CompletedProcess(args, 0, wx.IDENTITY_OK + "\n", "")
            return subprocess.CompletedProcess(args, 1, "", "ERROR:  42501\n")
        if "-f" in args:
            return subprocess.CompletedProcess(args, 0, "", f"psql:{args[-1]}:9: NOTICE:  garden_wx_writer created\n")
        return subprocess.CompletedProcess(args, 0, "", "")  # the password, on stdin

    monkeypatch.setattr(wx.subprocess, "run", fake_run)
    monkeypatch.setattr(wx.shutil, "which", lambda name: "/usr/bin/" + name)
    assert wx.main(["apply", "--env", "staging", "--env-file", str(p)]) == 0
    writer_pw = wx.libpq_env(wx.read_key(p, "WX_WRITER_DATABASE_URL_STAGING"), "w")["PGPASSWORD"]
    secrets = (OWNER_PW, writer_pw, "postgresql://", "ep-quiet-lake", "neondb")
    for args, env, stdin in calls:
        assert not any(s in a for a in args for s in secrets), args
        assert env["PGPASSWORD"] in (OWNER_PW, writer_pw)
    assert [c[2] for c in calls if writer_pw in c[2]] == [f"ALTER ROLE garden_wx_writer PASSWORD '{writer_pw}';\n"]
    assert [c[1]["PGUSER"] for c in calls] == ["neondb_owner", "neondb_owner"] + ["garden_wx_writer"] * 5
    out = capsys.readouterr()
    assert not any(s in out.out + out.err for s in secrets)
    assert out.out.count("PASS ") == 8 and "FAIL" not in out.out


def test_a_probe_that_succeeds_is_a_fail(monkeypatch, capsys):
    def fake_run(args, env=None, input=None, capture_output=None, text=None):
        sql = args[args.index("-c") + 1]
        if sql == wx.IDENTITY:
            return subprocess.CompletedProcess(args, 0, wx.IDENTITY_OK, "")
        if "plants" in sql:
            return subprocess.CompletedProcess(args, 0, "", "")  # SELECT on plants allowed: wrong
        return subprocess.CompletedProcess(args, 1, "", "ERROR:  42501")
    monkeypatch.setattr(wx.subprocess, "run", fake_run)
    assert wx.probe({"PGHOST": "h", "PGUSER": "garden_wx_writer", "PGPASSWORD": "p"}) is False
    assert "FAIL SELECT on public.plants is denied (42501): it SUCCEEDED" in capsys.readouterr().out


# ── the rehearsal, where a local PostgreSQL is installed ─────────────────────────────────────────

@pytest.mark.skipif(not all(shutil.which(b) for b in ("initdb", "pg_ctl", "psql", "pg_dump")),
                    reason="initdb, pg_ctl, psql and pg_dump are not all on PATH")
def test_rehearsal_on_a_throwaway_local_cluster():
    r = subprocess.run([sys.executable, REHEARSAL], capture_output=True, text=True, timeout=600)
    tail = "\n".join(r.stdout.splitlines()[-15:]) + r.stderr[-2000:]
    assert r.returncode == 0, tail
    assert "checks hold on PostgreSQL" in r.stdout and "MISMATCH" not in r.stdout, tail
