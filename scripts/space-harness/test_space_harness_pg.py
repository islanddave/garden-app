#!/usr/bin/env python3
"""The C-HARNESS self-tests on two REAL local Postgres clusters standing in for
A and B. Skipped unless both are given (loopback only; each test drops and
recreates its own database, space_harness_pytest, on both):

    SPACE_HARNESS_PG_A=postgresql://postgres@127.0.0.1:55445/postgres \\
    SPACE_HARNESS_PG_B=postgresql://postgres@127.0.0.1:55455/postgres \\
    python3 -m pytest -q scripts/space-harness/test_space_harness_pg.py

The arm test also needs the Lambda driver: SPACE_HARNESS_DRIVER (an installed
@neondatabase/serverless directory) and SPACE_HARNESS_WS (a ws package directory).
"""
import json
import os
import sys
import urllib.parse
import uuid

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import checksum as ck  # noqa: E402
import harness  # noqa: E402

psycopg = pytest.importorskip("psycopg")
ADMIN = {"a": os.environ.get("SPACE_HARNESS_PG_A"), "b": os.environ.get("SPACE_HARNESS_PG_B")}
pytestmark = pytest.mark.skipif(not (ADMIN["a"] and ADMIN["b"]),
                                reason="SPACE_HARNESS_PG_A / SPACE_HARNESS_PG_B not set")
DB = "space_harness_pytest"
OWNER = "user_pytestowner"

SCHEMA = """
CREATE SCHEMA gv;
CREATE FUNCTION gv.sentinel_workspace() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT %(sentinel)s::uuid $$;
CREATE TABLE public.spaces (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, created_by text,
                            created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.plants (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
                            workspace_id uuid NOT NULL, version integer NOT NULL DEFAULT 0,
                            updated_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION public.bump() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.version := OLD.version + 1; RETURN NEW; END $$;
CREATE TRIGGER plants_bump BEFORE UPDATE ON public.plants FOR EACH ROW EXECUTE FUNCTION public.bump();
CREATE TABLE public.app_events (id bigserial PRIMARY KEY, kind text NOT NULL);
CREATE TABLE public.daily_plan (user_id text NOT NULL, plan_date date NOT NULL, plan jsonb NOT NULL,
                                PRIMARY KEY (user_id, plan_date));
"""


def _dsn(admin, db):
    u = urllib.parse.urlsplit(admin)
    return urllib.parse.urlunsplit((u.scheme, u.netloc, "/" + db, u.query, u.fragment))


@pytest.fixture
def pair(monkeypatch):
    """A and B: the same schema and the same rows (same ids), like a fork."""
    sentinel = str(uuid.uuid4())
    space, plants = str(uuid.uuid4()), [(str(uuid.uuid4()), n) for n in ("Tomato", "Basil", "Kale")]
    out = {}
    for side in ("a", "b"):
        with psycopg.connect(ADMIN[side], autocommit=True) as c:
            c.execute(f"DROP DATABASE IF EXISTS {DB} WITH (FORCE)")
            c.execute(f"CREATE DATABASE {DB}")
        out[side] = _dsn(ADMIN[side], DB)
        with psycopg.connect(out[side], autocommit=True) as c:
            c.execute(SCHEMA.replace("%(sentinel)s", ck.qlit(sentinel)))
            c.execute("INSERT INTO public.spaces (id, name, created_by) VALUES (gv.sentinel_workspace(), 'Garden', %s)",
                      (OWNER,))
            for pid, name in plants:
                c.execute("INSERT INTO public.plants (id, name, workspace_id) VALUES (%s, %s, gv.sentinel_workspace())",
                          (pid, name))
            c.execute("INSERT INTO public.daily_plan VALUES (%s, '2026-10-16', %s)",
                      (OWNER, json.dumps({"water": ["Tomato"], "prior_runs": [{"side": side}]})))
            # traffic, different on each side: a volatile table the comparison leaves out
            c.execute("INSERT INTO public.app_events (kind) SELECT 'view' FROM generate_series(1, %s)",
                      (2 if side == "a" else 5,))
    monkeypatch.setenv("SH_A", out["a"])
    monkeypatch.setenv("SH_B", out["b"])
    out.update(sentinel=sentinel, space=space)
    return out


def sql_b(pair, sql):
    with psycopg.connect(pair["b"], autocommit=True) as c:
        c.execute(sql)


SRC = ["--a-dsn-env", "SH_A", "--b-dsn-env", "SH_B", "--local-pg"]


def verb(name, tmp_path, *extra):
    out = tmp_path / f"{name}.json"
    rc = harness.main([name, *SRC, "--out", str(out), *extra])
    return rc, json.loads(out.read_text())


def run(tmp_path, use, b_sql=None, *extra):
    f = tmp_path / "use.json"
    f.write_text(json.dumps(use))
    args = ["run", *SRC, "--use", str(f), "--today", "2026-10-16", "--out", str(tmp_path / "v.json")]
    if b_sql:
        (tmp_path / "b.sql").write_text(b_sql)
        args += ["--b-sql", str(tmp_path / "b.sql")]
    rc = harness.main(args + list(extra))
    return rc, json.loads((tmp_path / "v.json").read_text())


INDOOR = "INSERT INTO public.spaces (name, created_by) VALUES ('Indoor', 'user_pytestowner');"
ROW_USE = {
    "name": "row control: the Indoor Space exists on B only",
    "binds": {"indoor": "SELECT id::text FROM public.spaces WHERE name = 'Indoor'"},
    "positive_control": {"name": "Indoor row on B only", "kind": "row", "table": "public.spaces",
                         "where": "id = %(indoor)s::uuid"},
    "allowed_diffs": [{"table": "public.spaces", "where": "name = 'Indoor'", "side": "b"}],
}


def test_selftest0_a_equals_b_despite_volatile_tables_and_keys(pair, tmp_path):
    rc, v = verb("selftest0", tmp_path)
    assert rc == 0 and v["verdict"] == "PASS"
    st0 = v["selftest0"]
    assert "public.app_events" in st0["excluded_tables"]
    assert st0["excluded_columns"]["public.plants"] == {"id": "volatile default gen_random_uuid()",
                                                        "updated_at": "volatile name"}
    assert st0["jsonb_stripped"] == {"public.daily_plan.plan": ["prior_runs"]}


def test_selftest0_planted_difference_faults(pair, tmp_path):
    sql_b(pair, "UPDATE public.plants SET name = 'Basil (planted)' WHERE name = 'Basil'")
    rc, v = verb("selftest0", tmp_path)
    assert rc == harness.EXIT["FAULT"]
    assert [d["table"] for d in v["selftest0"]["diffs"]] == ["public.plants"]


def test_stray_write_diffs_and_leaves_no_residue(pair, tmp_path):
    rc, v = verb("stray", tmp_path)
    assert rc == 0, v
    assert v["stray"]["target"] == "public.daily_plan.user_id"
    assert [d["table"] for d in v["stray"]["diff_during"]] == ["public.daily_plan"]
    assert v["stray"]["residue_after_rollback"] == []
    rc, _ = verb("selftest0", tmp_path)
    assert rc == 0


def test_stray_write_on_a_column_the_instrument_cannot_see_faults(pair, tmp_path):
    use = dict(ROW_USE, volatile_columns={"public.plants": ["name", "version"]}, stray_target="public.plants.name")
    rc, v = run(tmp_path, use, INDOOR, "--no-arms")
    assert rc == harness.EXIT["FAULT"]
    assert v["stray"]["reason"] == "the stray write did not diff"


def test_row_control_on_b_only_passes(pair, tmp_path):
    rc, v = run(tmp_path, ROW_USE, INDOOR, "--no-arms")
    assert rc == 0, v
    assert v["positive_control"]["counts"] == {"a": 0, "b": 1}
    assert [d["table"] for d in v["allowed_diffs"]] == ["public.spaces"] and v["diffs"] == []


def test_b_equals_a_is_a_fault_never_a_pass(pair, tmp_path):
    rc, v = run(tmp_path, ROW_USE, None, "--no-arms")
    assert rc == harness.EXIT["FAULT"]
    assert "bind $indoor returned 0 rows" in v["positive_control"]["reason"]


def test_an_unexpected_change_is_a_diff(pair, tmp_path):
    rc, v = run(tmp_path, ROW_USE, INDOOR + " UPDATE public.plants SET name = 'Kale!' WHERE name = 'Kale';", "--no-arms")
    assert rc == harness.EXIT["DIFF"]
    d = v["diffs"][0]
    assert d["table"] == "public.plants" and d["only_a"] == 1 and d["only_b"] == 1
    assert any("Kale!" in r for r in d["sample_b"])


def test_a_use_without_a_positive_control_faults(pair, tmp_path):
    rc, v = run(tmp_path, {"name": "nothing named"}, INDOOR, "--no-arms")
    assert rc == harness.EXIT["FAULT"] and "names no positive control" in v["faults"][0]


def test_sentinel_comes_from_the_database(pair, tmp_path):
    with psycopg.connect(pair["a"], autocommit=True) as c:
        assert ck.read_sentinel(c) == pair["sentinel"]
    use = {"name": "sentinel row", "positive_control": {"name": "the sentinel Space", "kind": "row",
           "table": "public.spaces", "where": "id = %(sentinel)s::uuid", "absent_on": None}}
    rc, v = run(tmp_path, use, None, "--no-arms")
    assert rc == 0 and v["positive_control"]["counts"] == {"a": 1, "b": 1}
    for side in ("a", "b"):
        with psycopg.connect(pair[side], autocommit=True) as c:
            c.execute("DROP FUNCTION gv.sentinel_workspace()")
    rc, v = run(tmp_path, use, None, "--no-arms")
    assert rc == harness.EXIT["FAULT"] and "sentinel" in v["faults"][0]


ARM_HANDLER = """
module.exports = { async run(o) {
  const { rows } = await o.pg.query('select id::text as id from public.spaces order by name');
  for (const r of rows) console.log(JSON.stringify({ msg: 'space-wx', space: r.id }));
  await o.pg.query("insert into public.daily_plan values ('arm', $1, '{}'::jsonb)", [o.today]);
  if (rows.length > 1) await o.publishAlert({ topic: 'ops', subject: 'two spaces', message: 'm' });
  return { rows: rows.length, plans: [] };
} };"""


@pytest.mark.skipif(not (os.environ.get("SPACE_HARNESS_DRIVER") and os.environ.get("SPACE_HARNESS_WS")),
                    reason="SPACE_HARNESS_DRIVER / SPACE_HARNESS_WS not set")
def test_arms_reach_each_branch_through_the_lambda_driver(pair, tmp_path):
    tree = tmp_path / "tree"
    (tree / "lambda" / "daily-plan").mkdir(parents=True)
    (tree / "lambda" / "daily-plan" / "handler.js").write_text(ARM_HANDLER)
    use = {"name": "arm: space-wx for Indoor on B only",
           "binds": {"indoor": "SELECT id::text FROM public.spaces WHERE name = 'Indoor'"},
           "positive_control": {"name": "space-wx Indoor", "kind": "log", "match": {"msg": "space-wx", "space": "$indoor"}},
           "allowed_diffs": [{"table": "public.spaces", "where": "name = 'Indoor'", "side": "b"}],
           "allowed_call_diffs": [{"stub": "publishAlert", "destination": "sns:ops"}]}
    rc, v = run(tmp_path, use, INDOOR, "--tree", str(tree), "--driver", os.environ["SPACE_HARNESS_DRIVER"],
                "--ws", os.environ["SPACE_HARNESS_WS"])
    assert rc == 0, v
    assert v["positive_control"]["counts"] == {"a": 0, "b": 1}
    assert v["arms"]["a"]["rows"] == 1 and v["arms"]["b"]["rows"] == 2
    assert v["calls"]["alerts"] == {"a": [], "b": [["publishAlert", "sns:ops", "two spaces"]]}
