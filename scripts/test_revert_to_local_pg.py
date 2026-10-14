#!/usr/bin/env python3
"""revert-to.py's dump path against a real, throwaway PostgreSQL (BUG-REVERTREHEARSALSETUP-001).

The 2026-10-09 staging rehearsal (run 37956492157) failed safe in validate_branch with
"public.plants: archive 12 vs restored 324": the stage branch starts as a copy of today's prod,
and pg_restore --clean cannot drop a table that a newer, prod-only constraint depends on, so the
table kept prod's rows. Here a prod-shaped database (public, extensions holding uuid-ossp, gv
holding a trigger function) is dumped with 12 plants, then moves on to 324 plants with a prod-only
unique constraint, an FK onto it and a newer table: the 10-09 shape. The tests run the real
restore_dump_into_branch, validate_branch and empty_restore_target on copies of it; only the Neon
API that require_restore_target reads is a stand-in.

Needs initdb, pg_ctl, psql, pg_dump and pg_restore on PATH; skipped otherwise. The cluster listens on
127.0.0.1 only, on a free port, with no unix socket, and is stopped and deleted afterwards.
"""
import importlib.util
import json
import os
import shutil
import socket
import subprocess
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

BINARIES = ("initdb", "pg_ctl", "psql", "pg_dump", "pg_restore")
pytestmark = pytest.mark.skipif(not all(shutil.which(b) for b in BINARIES),
                                reason="initdb, pg_ctl, psql, pg_dump and pg_restore are not all on PATH")


def _load():
    spec = importlib.util.spec_from_file_location("revert_to_local_pg", os.path.join(HERE, "revert-to.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


rt = _load()

SNAPSHOT_SQL = """
CREATE SCHEMA extensions;
CREATE EXTENSION "uuid-ossp" WITH SCHEMA extensions;
CREATE SCHEMA gv;
CREATE TABLE public.plant_projects (id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(), name text);
CREATE TABLE public.plants (id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
                            project_id uuid REFERENCES plant_projects(id), name text, updated_at timestamptz);
CREATE TABLE public.event_log (id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
                               plant_id uuid, project_id uuid, note text);
CREATE FUNCTION gv.touch() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.updated_at := now(); RETURN NEW; END$$;
CREATE TRIGGER plants_touch BEFORE UPDATE ON public.plants FOR EACH ROW EXECUTE FUNCTION gv.touch();
INSERT INTO plant_projects(name) VALUES ('p1');
INSERT INTO plants(project_id, name) SELECT (SELECT id FROM plant_projects), 'plant ' || g FROM generate_series(1, 12) g;
INSERT INTO event_log(plant_id, project_id, note) SELECT id, project_id, 'e' FROM plants;
"""
# After the snapshot: more rows, the 2026-08-21 hand-applied rule (a unique constraint and an FK onto
# it, on prod and not in the snapshot), a newer table, and a newer gv function.
PROD_LATER_SQL = """
INSERT INTO plants(project_id, name) SELECT (SELECT id FROM plant_projects), 'plant ' || g FROM generate_series(13, 324) g;
ALTER TABLE plants ADD CONSTRAINT plants_id_project_uq UNIQUE (id, project_id);
ALTER TABLE event_log ADD CONSTRAINT event_log_plant_project_fk
  FOREIGN KEY (plant_id, project_id) REFERENCES plants(id, project_id);
CREATE TABLE public.newer (id int PRIMARY KEY, plant_id uuid REFERENCES plants(id));
CREATE FUNCTION gv.newer_fn() RETURNS int LANGUAGE sql AS 'SELECT 1';
"""


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Cluster:
    def __init__(self, root):
        self.root, self.port = root, _free_port()
        self.env = {**os.environ, "LC_ALL": "C", "LANG": "C"}
        self.env.pop("PGPASSWORD", None)
        self.env.pop("PGSERVICE", None)

    def run(self, argv, **k):
        return subprocess.run(argv, env=self.env, capture_output=True, text=True, timeout=120, **k)

    def start(self):
        data = os.path.join(self.root, "data")
        p = self.run(["initdb", "-D", data, "-U", "postgres", "--auth=trust", "--locale=C", "-E", "UTF8"])
        assert p.returncode == 0, p.stderr
        p = self.run(["pg_ctl", "-D", data, "-l", os.path.join(self.root, "log"), "-w", "-o",
                      f"-c listen_addresses=127.0.0.1 -c port={self.port} -c unix_socket_directories=''", "start"])
        assert p.returncode == 0, p.stderr + open(os.path.join(self.root, "log")).read()[-2000:]

    def stop(self):
        self.run(["pg_ctl", "-D", os.path.join(self.root, "data"), "-m", "immediate", "stop"])

    def uri(self, db, user="neondb_owner"):
        return f"postgresql://{user}@127.0.0.1:{self.port}/{db}"

    def sql(self, db, sql, user="neondb_owner"):
        p = self.run(["psql", self.uri(db, user), "-X", "-q", "-tA", "-v", "ON_ERROR_STOP=1", "-c", sql])
        assert p.returncode == 0, p.stderr
        return p.stdout.strip()

    def copy_of_prod(self, db):
        """A fresh copy of today's prod under `db`, as Neon's stage branch starts."""
        self.sql("postgres", f"DROP DATABASE IF EXISTS {db}", user="postgres")
        self.sql("postgres", f"CREATE DATABASE {db} TEMPLATE prod_live OWNER neondb_owner", user="postgres")


@pytest.fixture(scope="module")
def pg(tmp_path_factory):
    root = str(tmp_path_factory.mktemp("revertpg"))
    c = Cluster(root)
    c.start()
    try:
        c.sql("postgres", "CREATE ROLE neondb_owner LOGIN CREATEDB", user="postgres")
        c.sql("postgres", "CREATE DATABASE prod_live OWNER neondb_owner", user="postgres")
        p = c.run(["psql", c.uri("prod_live"), "-X", "-q", "-v", "ON_ERROR_STOP=1"], input=SNAPSHOT_SQL)
        assert p.returncode == 0, p.stderr
        c.dump = os.path.join(root, "snap.dump")
        p = c.run(["pg_dump", "-Fc", "-f", c.dump, c.uri("prod_live")])
        assert p.returncode == 0, p.stderr
        p = c.run(["psql", c.uri("prod_live"), "-X", "-q", "-v", "ON_ERROR_STOP=1"], input=PROD_LATER_SQL)
        assert p.returncode == 0, p.stderr
        yield c
    finally:
        c.stop()


class _S3:
    def __init__(self, path):
        self.path = path

    def download_file(self, bucket, key, dest):
        shutil.copyfile(self.path, dest)


class _Resp:
    def __init__(self, payload):
        self.status_code, self._payload, self.text = 200, payload, json.dumps(payload)

    def json(self):
        return self._payload


class _Neon:
    """The two Neon reads require_restore_target makes; the stage database answers on 127.0.0.1."""
    def __init__(self, endpoint_branch="br-stage"):
        self.endpoint_branch = endpoint_branch

    def get(self, url, **k):
        if url.endswith("/branches"):
            return _Resp({"branches": [{"id": "br-stage", "name": "revert-stage-v2.5.0"}]})
        if url.endswith("/endpoints"):
            return _Resp({"endpoints": [{"host": "127.0.0.1", "branch_id": self.endpoint_branch}]})
        raise AssertionError(f"unexpected Neon read {url}")


def _cfg():
    return rt.Config(env={
        "GH_TOKEN": "t", "GITHUB_REPOSITORY": "islanddave/garden-app",
        "TARGET_VERSION": "v2.5.0", "PREREVERT_VERSION": "v2.5.1",
        "NEON_API_KEY": "k", "NEON_PROJECT_ID": "p",
        # the live database: a different host from the stage branch's
        "NEON_BACKUP_URL": "postgresql://neondb_owner@prod-live.invalid/neondb",
    })


MANIFEST = {"dump_s3_key": "db/snap-v2.5.0.dump"}


def test_the_10_09_failure_reproduces_when_the_stage_copy_is_not_emptied(pg):
    """Today's restore, unchanged, into a copy of prod: the old rows stay and validate refuses."""
    pg.copy_of_prod("stage_today")
    uri = pg.uri("stage_today")
    _key, expected = rt.restore_dump_into_branch(_S3(pg.dump), _cfg(), MANIFEST, uri)
    assert expected["public.plants"] == 12
    with pytest.raises(rt.RevertError, match="does NOT match the snapshot archive") as e:
        rt.validate_branch(_cfg(), uri, expected_counts=expected)
    assert "public.plants: archive 12 vs restored 324" in str(e.value)


def test_an_emptied_stage_copy_restores_to_exactly_the_snapshot(pg, monkeypatch, capsys):
    pg.copy_of_prod("neondb")
    uri = pg.uri("neondb")
    public_on_prod = pg.sql("prod_live", rt.PUBLIC_SCHEMA_STATE_SQL)
    monkeypatch.setattr(rt, "requests", _Neon())
    rt.empty_restore_target(_cfg(), "br-stage", uri)
    _key, expected = rt.restore_dump_into_branch(_S3(pg.dump), _cfg(), MANIFEST, uri)
    out = rt.validate_branch(_cfg(), uri, expected_counts=expected)
    assert out["archive_match"] == "verified" and out["counts"]["plants"] == 12
    log = capsys.readouterr().out
    assert "emptied: dropped schemas extensions,gv,public" in log
    assert "pg_restore: exit 0; 0 error line(s)" in log  # an empty target restores cleanly
    # nothing of today's prod survived, and the snapshot's schema works
    assert pg.sql("neondb", "SELECT count(*) FROM pg_constraint WHERE conname IN "
                            "('plants_id_project_uq', 'event_log_plant_project_fk')") == "0"
    assert pg.sql("neondb", "SELECT to_regclass('public.newer') IS NULL AND to_regproc('gv.newer_fn') IS NULL") == "t"
    assert pg.sql("neondb", "INSERT INTO plant_projects(name) VALUES ('uuid default works') RETURNING 1") == "1"
    assert pg.sql("neondb", "WITH u AS (UPDATE plants SET name = name RETURNING updated_at) "
                            "SELECT bool_and(updated_at IS NOT NULL) FROM u") == "t"  # the gv trigger fires
    assert pg.sql("neondb", rt.PUBLIC_SCHEMA_STATE_SQL) == public_on_prod


def test_a_guard_refusal_leaves_the_stage_copy_untouched(pg, monkeypatch):
    pg.copy_of_prod("neondb")
    monkeypatch.setattr(rt, "requests", _Neon(endpoint_branch="br-delicate-sea-amum92c2"))
    with pytest.raises(rt.RevertError, match="restore-target guard"):
        rt.empty_restore_target(_cfg(), "br-stage", pg.uri("neondb"))
    assert pg.sql("neondb", "SELECT count(*) FROM plants") == "324"
    assert pg.sql("neondb", "SELECT string_agg(nspname, ',' ORDER BY nspname) FROM pg_namespace "
                            "WHERE nspname IN ('extensions', 'gv', 'public')") == "extensions,gv,public"


def test_emptying_keeps_a_public_schema_that_is_not_the_default(pg, monkeypatch):
    """Neon's public need not be PostgreSQL's default (no USAGE for PUBLIC there, per the wx lane):
    owner, privileges and comment come back exactly as the target had them."""
    pg.copy_of_prod("neondb")
    pg.sql("postgres", "DO $$BEGIN CREATE ROLE garden_reader; EXCEPTION WHEN duplicate_object THEN NULL; END$$",
           user="postgres")
    pg.sql("neondb", "REVOKE USAGE ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO garden_reader "
                     "WITH GRANT OPTION; COMMENT ON SCHEMA public IS 'garden public'")
    before = pg.sql("neondb", rt.PUBLIC_SCHEMA_STATE_SQL)
    assert "garden_reader=USAGE*" in before and "PUBLIC=" not in before
    monkeypatch.setattr(rt, "requests", _Neon())
    rt.empty_restore_target(_cfg(), "br-stage", pg.uri("neondb"))
    assert pg.sql("neondb", rt.PUBLIC_SCHEMA_STATE_SQL) == before
