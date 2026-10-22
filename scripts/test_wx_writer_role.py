"""Tests for scripts/wx-writer-role.py (V5-WXCOLDBAND-001, the cold-range writer's own login).

Run: python3 -m pytest -q scripts/test_wx_writer_role.py

The unit tests need no database: they hold the parts that keep a URL or a password out of argv and out
of the output, the env-file rewrite, and the prod refusal. The last test runs
migrations/v5-wxcoldband-001/rehearse_writer_role.py (a throwaway local cluster: 1a, 1r and this script,
every verb) when initdb, pg_ctl, psql and pg_dump are all on PATH, and is skipped otherwise.
"""
import importlib.util
import os
import re
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

@pytest.mark.parametrize("verb", ["apply", "verify", "reassert", "grant", "ungrant", "rollback"])
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
    # identity, the job's eight-column INSERT, and the five negatives
    assert [c[1]["PGUSER"] for c in calls] == ["neondb_owner", "neondb_owner"] + ["garden_wx_writer"] * 7
    out = capsys.readouterr()
    assert not any(s in out.out + out.err for s in secrets)
    assert out.out.count("PASS ") == 10 and "FAIL" not in out.out
    # no WX_WRITER_PLOT_ID_STAGING in the file: the plot_id INSERT is reported, not required
    assert "INSERT naming plot_id" in out.out and "denied (42501) (until `grant`, 3.2c)" in out.out


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


# ── 3.2c: grant, reassert, ungrant, and the plot_id probe (psql replaced) ───────────────────────

SPACE = "aaaaaaaa-0000-4000-8000-00000000000a"
PLOT = "bbbbbbbb-0000-4000-8000-00000000000b"
WRITER_URL = "postgresql://garden_wx_writer:" + "w" * 43 + "@ep-quiet-lake-a1b2c3-pooler.us-east-2.aws.neon.tech/neondb"


def fake_psql(calls, *, plot_insert=0, space_rows=f"{SPACE}|1|1|{PLOT}", owner_file=0):
    """psql as the owner (-f / the Space query) and as the writer (identity, the probes)."""
    def run(args, env=None, input=None, capture_output=None, text=None):
        calls.append((list(args), dict(env or {}), input or ""))
        if "-f" in args:
            return subprocess.CompletedProcess(args, owner_file, "", "" if owner_file == 0 else "ERROR:  P0001 refused")
        sql = args[args.index("-c") + 1] if "-c" in args else None
        if sql == wx.IDENTITY:
            return subprocess.CompletedProcess(args, 0, wx.IDENTITY_OK, "")
        if sql == wx.SPACE_PLOT_SQL:
            return subprocess.CompletedProcess(args, 0, space_rows, "")
        if sql == wx.PLOT_PROBE and plot_insert == 0:
            return subprocess.CompletedProcess(args, 0, "", "")
        return subprocess.CompletedProcess(args, 1, "", "ERROR:  42501")
    return run


def files_run(calls):
    return [os.path.relpath(c[0][c[0].index("-f") + 1], wx.REPO) for c in calls if "-f" in c[0]]


def test_the_plot_probe_is_the_jobs_column_list_and_writes_no_row():
    assert wx.PLOT_PROBE.startswith(f"INSERT INTO {wx.TABLE} ({', '.join(wx.JOB_COLUMNS)}) SELECT ")
    assert wx.PLOT_PROBE.endswith(" WHERE false ON CONFLICT DO NOTHING")
    assert set(wx.JOB_COLUMNS) == set(wx.SEVEN) | {"plot_id"} and "created_at" not in wx.JOB_COLUMNS
    created = dict(wx.PROBES)[f"INSERT naming created_at on {wx.TABLE}"]
    assert "created_at" in created and created.endswith(" WHERE false")


def test_grant_runs_the_grant_file_writes_the_job_keys_and_requires_plot_id_allowed(tmp_path, monkeypatch, capsys):
    p = env_file(tmp_path, f"NEON_STAGING_URL={OWNER_URL}\nWX_WRITER_DATABASE_URL_STAGING={WRITER_URL}\n")
    calls = []
    monkeypatch.setattr(wx.subprocess, "run", fake_psql(calls))
    monkeypatch.setattr(wx.shutil, "which", lambda name: "/usr/bin/" + name)
    assert wx.main(["grant", "--env", "staging", "--env-file", str(p)]) == 0
    assert files_run(calls) == ["migrations/v5-wxwriterplot-001/0a-writer-plot-grant.sql"]
    assert wx.read_key(p, "WX_WRITER_SPACE_ID_STAGING") == SPACE and wx.read_key(p, "WX_WRITER_PLOT_ID_STAGING") == PLOT
    assert not [c for c in calls if "PASSWORD" in c[2]], "grant never sets a password"
    assert wx.read_key(p, "WX_WRITER_DATABASE_URL_STAGING") == WRITER_URL, "the job's login is untouched"
    out = capsys.readouterr().out
    assert f"PASS {wx.PLOT_LABEL} is allowed" in out and "FAIL" not in out


@pytest.mark.parametrize("rows, said", [
    (f"{SPACE}|2|1|{PLOT}\n{PLOT}|2|0|", "there are 2"),
    (f"{SPACE}|1|0|", "it has 0"),
    (f"{SPACE}|1|2|{PLOT}", "it has 2"),
    ("", "there are 0"),
])
def test_grant_writes_no_key_unless_one_space_with_one_live_default_plot(rows, said, tmp_path, monkeypatch, capsys):
    p = env_file(tmp_path, f"NEON_STAGING_URL={OWNER_URL}\nWX_WRITER_DATABASE_URL_STAGING={WRITER_URL}\n")
    monkeypatch.setattr(wx.subprocess, "run", fake_psql([], space_rows=rows))
    assert wx.cmd_grant("staging", str(p)) == 1
    assert wx.read_key(p, "WX_WRITER_SPACE_ID_STAGING") is None and wx.read_key(p, "WX_WRITER_PLOT_ID_STAGING") is None
    assert said in capsys.readouterr().out


def test_grant_refused_by_its_file_writes_nothing(tmp_path, monkeypatch, capsys):
    p = env_file(tmp_path, f"NEON_STAGING_URL={OWNER_URL}\nWX_WRITER_DATABASE_URL_STAGING={WRITER_URL}\n")
    calls = []
    monkeypatch.setattr(wx.subprocess, "run", fake_psql(calls, owner_file=3))
    assert wx.cmd_grant("staging", str(p)) == 1
    assert wx.read_key(p, "WX_WRITER_PLOT_ID_STAGING") is None and len(calls) == 1
    assert "FAIL 0a-writer-plot-grant.sql as the owner" in capsys.readouterr().out


def test_grant_with_the_plot_insert_still_denied_is_a_fail(tmp_path, monkeypatch, capsys):
    p = env_file(tmp_path, f"NEON_STAGING_URL={OWNER_URL}\nWX_WRITER_DATABASE_URL_STAGING={WRITER_URL}\n")
    monkeypatch.setattr(wx.subprocess, "run", fake_psql([], plot_insert=1))
    assert wx.cmd_grant("staging", str(p)) == 1
    assert f"FAIL {wx.PLOT_LABEL} is allowed: denied (42501)" in capsys.readouterr().out


def test_verify_requires_the_plot_insert_once_the_job_key_is_there(tmp_path, monkeypatch, capsys):
    p = env_file(tmp_path, f"WX_WRITER_DATABASE_URL_STAGING={WRITER_URL}\nWX_WRITER_PLOT_ID_STAGING={PLOT}\n")
    monkeypatch.setattr(wx.subprocess, "run", fake_psql([], plot_insert=1))
    assert wx.cmd_verify("staging", str(p)) == 1
    monkeypatch.setattr(wx.subprocess, "run", fake_psql([], plot_insert=0))
    assert wx.cmd_verify("staging", str(p)) == 0
    assert f"PASS {wx.PLOT_LABEL} is allowed" in capsys.readouterr().out


def test_reassert_runs_1a_and_never_sets_a_password(tmp_path, monkeypatch, capsys):
    p = env_file(tmp_path, f"NEON_STAGING_URL={OWNER_URL}\nWX_WRITER_DATABASE_URL_STAGING={WRITER_URL}\n")
    calls = []
    monkeypatch.setattr(wx.subprocess, "run", fake_psql(calls))
    assert wx.cmd_reassert("staging", str(p)) == 0
    assert files_run(calls) == ["migrations/v5-wxcoldband-001/1a-writer-role.sql"]
    assert not [c for c in calls if c[2]], "nothing on stdin: no ALTER ROLE ... PASSWORD"
    assert wx.read_key(p, "WX_WRITER_DATABASE_URL_STAGING") == WRITER_URL
    assert "(no new password)" in capsys.readouterr().out


def test_ungrant_revokes_removes_the_keys_and_requires_plot_id_denied(tmp_path, monkeypatch, capsys):
    p = env_file(tmp_path, f"NEON_STAGING_URL={OWNER_URL}\nWX_WRITER_DATABASE_URL_STAGING={WRITER_URL}\n"
                           f"WX_WRITER_SPACE_ID_STAGING={SPACE}\nWX_WRITER_PLOT_ID_STAGING={PLOT}\nOTHER=1\n")
    calls = []
    monkeypatch.setattr(wx.subprocess, "run", fake_psql(calls, plot_insert=1))
    assert wx.cmd_ungrant("staging", str(p)) == 0
    assert files_run(calls) == ["migrations/v5-wxwriterplot-001/0r-rollback.sql"]
    assert p.read_text() == f"NEON_STAGING_URL={OWNER_URL}\nWX_WRITER_DATABASE_URL_STAGING={WRITER_URL}\nOTHER=1\n"
    assert f"PASS {wx.PLOT_LABEL} is denied (42501)" in capsys.readouterr().out
    monkeypatch.setattr(wx.subprocess, "run", fake_psql([], plot_insert=0))
    assert wx.cmd_ungrant("staging", str(p)) == 1, "plot_id still allowed after the revoke is a FAIL"


def test_no_space_or_plot_literal_in_the_script():
    """N12: the job's Space and plot are read from the data by `grant`, never written into this file."""
    src = open(os.path.join(HERE, "wx-writer-role.py")).read()
    assert not re.search(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", src)


# ── the rehearsal, where a local PostgreSQL is installed ─────────────────────────────────────────

@pytest.mark.skipif(not all(shutil.which(b) for b in ("initdb", "pg_ctl", "psql", "pg_dump")),
                    reason="initdb, pg_ctl, psql and pg_dump are not all on PATH")
def test_rehearsal_on_a_throwaway_local_cluster():
    r = subprocess.run([sys.executable, REHEARSAL], capture_output=True, text=True, timeout=600)
    tail = "\n".join(r.stdout.splitlines()[-15:]) + r.stderr[-2000:]
    assert r.returncode == 0, tail
    assert "checks hold on PostgreSQL" in r.stdout and "MISMATCH" not in r.stdout, tail
