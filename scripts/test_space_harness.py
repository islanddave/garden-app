#!/usr/bin/env python3
"""Unit tests for the C-HARNESS (scripts/space-harness). No network and no
database: neon_safety_branch.api is replaced by a fake Neon that both the tool
and the harness call, and the instrument's pure parts are tested directly.
The real-PG self-tests are test_space_harness_pg.py (skipped without clusters).

    python3 -m pytest -q scripts/test_space_harness.py
"""
import datetime as dt
import json
import os
import sys
import urllib.parse

import pytest

HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "space-harness")
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import checksum as ck  # noqa: E402
import harness  # noqa: E402
import neon_pair as npair  # noqa: E402

nsb, nbs = npair.nsb, npair.nbs
NOW = dt.datetime(2026, 10, 16, 14, 25, tzinfo=dt.timezone.utc)
PROD = nbs.DEFAULT_PROD_BRANCH
ENV = {"NEON_API_KEY": "k", "NEON_PROJECT_ID": "p"}
LSN = "0/1A2B3C4"
TS = "2026-10-16T14:25:03Z"
PROTECTED = ["ep-prod-endpoint", "ep-staging-endpoint"]


def br(name, bid=None, parent=PROD, created="2026-10-15T10:00:00Z", **extra):
    b = {"name": name, "id": bid or f"br-{name}", "parent_id": parent, "created_at": created,
         "expires_at": "2026-10-20T10:00:00Z"}
    b.update(extra)
    return b


class FakeNeon:
    """Branches, endpoints, operations and connection_uri, in memory."""

    def __init__(self, temps=0, report=("parent_lsn", "parent_timestamp"), b_expiry=True,
                 op_status="finished", uri_host=None):
        self.branches = [br("production", bid=PROD, parent=None, default=True, expires_at=None),
                         br("staging", expires_at=None)]
        self.branches += [br(f"sitting-old{i}-prod-preapply-20261015") for i in range(temps)]
        self.report, self.b_expiry, self.op_status, self.uri_host = report, b_expiry, op_status, uri_host
        self.endpoints, self.calls = {}, []

    def __call__(self, env, method, path, body=None, timeout=60):
        self.calls.append((method, path, body))
        if method == "GET" and path == "branches":
            return 200, {"branches": [dict(b) for b in self.branches]}
        if method == "POST" and path == "branches":
            b = dict(body["branch"], id=f"br-new-{len(self.branches)}", created_at=TS)
            if "parent_lsn" not in b and "parent_timestamp" not in b:
                if "parent_lsn" in self.report:
                    b["parent_lsn"] = LSN
                if "parent_timestamp" in self.report:
                    b["parent_timestamp"] = TS
            elif not self.b_expiry:
                b.pop("expires_at", None)
            self.branches.append(b)
            return 201, {"branch": b, "operations": [{"id": f"op-{b['id']}", "status": "running"}]}
        if method == "POST" and path == "endpoints":
            n = len(self.endpoints)
            ep = {"id": f"ep-harness-{n}", "host": f"ep-harness-{n}.c-2.us-east-1.aws.neon.tech",
                  "branch_id": body["endpoint"]["branch_id"], "type": body["endpoint"]["type"]}
            self.endpoints[ep["id"]] = ep
            return 201, {"endpoint": ep, "operations": [{"id": f"op-{ep['id']}", "status": "running"}]}
        if method == "GET" and path.startswith("operations/"):
            return 200, {"operation": {"id": path.split("/")[1], "status": self.op_status}}
        if method == "GET" and path.startswith("connection_uri?"):
            q = dict(urllib.parse.parse_qsl(path.split("?", 1)[1]))
            host = self.uri_host or self.endpoints[q["endpoint_id"]]["host"]
            return 200, {"uri": f"postgresql://{q['role_name']}:secret-pw@{host}/{q['database_name']}?sslmode=require"}
        raise AssertionError(f"unexpected {method} {path}")

    def writes(self):
        return [c for c in self.calls if c[0] != "GET"]


@pytest.fixture
def neon(monkeypatch):
    monkeypatch.setattr(nsb, "_utcnow", lambda: NOW)

    def install(**kw):
        fake = FakeNeon(**kw)
        monkeypatch.setattr(nsb, "api", fake)
        return fake
    return install


NOSLEEP = lambda s: None  # noqa: E731


# ------------------------------------------------------------ fleet

def test_fleet_counts_the_tools_list(neon):
    neon(temps=8)
    assert len(npair.fleet_check(ENV)) == 8


def test_fleet_refuses_at_nine(neon):
    fake = neon(temps=9)
    with pytest.raises(npair.Refused, match="9 temporary"):
        npair.fleet_check(ENV)
    assert not fake.writes()


def test_fleet_zero_reads_the_tools_empty_line(neon):
    neon(temps=0)
    assert npair.fleet_check(ENV) == []


def test_fleet_tool_failure_is_a_fault(monkeypatch):
    monkeypatch.setattr(nsb, "api", lambda *a, **k: (500, "boom"))
    with pytest.raises(npair.HarnessFault, match="list exited 1"):
        npair.fleet_check(ENV)


# ------------------------------------------------------------ the pair

def test_pair_forks_b_at_a_parent_lsn(neon):
    fake = neon(temps=3)
    rec = npair.create_pair(ENV, "1.12", now=NOW, sleep=NOSLEEP)
    posts = [c for c in fake.writes() if c[1] == "branches"]
    assert len(posts) == 2
    a_body, b_body = posts[0][2]["branch"], posts[1][2]["branch"]
    assert a_body["name"] == "sitting-harness-1-12-1425-a-prod-preapply-20261016"
    assert a_body["parent_id"] == PROD and "parent_lsn" not in a_body   # A is the tool's plain copy
    assert b_body["name"] == "sitting-harness-1-12-1425-b-prod-preapply-20261016"
    assert b_body["parent_id"] == PROD and b_body["parent_lsn"] == LSN
    assert "parent_timestamp" not in b_body                              # one fork field, never both
    for body in (a_body, b_body):
        assert body["expires_at"] == "2026-10-17T14:25:00Z"              # --days 1
    assert rec["fork"] == {"field": "parent_lsn", "value": LSN}
    eps = [c for c in fake.writes() if c[1] == "endpoints"]
    assert [c[2]["endpoint"]["branch_id"] for c in eps] == [rec["a"]["id"], rec["b"]["id"]]
    assert all(c[2]["endpoint"]["type"] == "read_write" for c in eps)
    assert "secret" not in json.dumps(rec)


def test_pair_falls_back_to_parent_timestamp(neon):
    fake = neon(report=("parent_timestamp",))
    rec = npair.create_pair(ENV, "1-12", now=NOW, sleep=NOSLEEP)
    b_body = [c for c in fake.writes() if c[1] == "branches"][1][2]["branch"]
    assert b_body["parent_timestamp"] == TS and "parent_lsn" not in b_body
    assert rec["fork"]["field"] == "parent_timestamp"


def test_pair_without_a_fork_point_faults_before_b(neon):
    fake = neon(report=())
    with pytest.raises(npair.HarnessFault, match="neither parent_lsn nor parent_timestamp"):
        npair.create_pair(ENV, "1-12", now=NOW, sleep=NOSLEEP)
    assert len([c for c in fake.writes() if c[1] == "branches"]) == 1


@pytest.mark.parametrize("minute", [0, 5, 55])
def test_pair_refuses_near_the_hourly_writers(neon, minute):
    fake = neon()
    with pytest.raises(npair.Refused, match="outside"):
        npair.create_pair(ENV, "1-12", now=NOW.replace(minute=minute), sleep=NOSLEEP)
    assert not fake.writes()


def test_pair_refuses_a_full_fleet_before_any_write(neon):
    fake = neon(temps=9)
    with pytest.raises(npair.Refused):
        npair.create_pair(ENV, "1-12", now=NOW, sleep=NOSLEEP)
    assert not fake.writes()


def test_pair_refuses_a_reused_name(neon):
    fake = neon()
    fake.branches.append(br("sitting-harness-1-12-1425-b-prod-preapply-20261016"))
    with pytest.raises(npair.Refused, match="already exists"):
        npair.create_pair(ENV, "1-12", now=NOW, sleep=NOSLEEP)
    assert not fake.writes()


def test_pair_b_without_expiry_faults(neon):
    neon(b_expiry=False)
    with pytest.raises(npair.HarnessFault, match="NO expiry"):
        npair.create_pair(ENV, "1-12", now=NOW, sleep=NOSLEEP)


def test_pair_failed_operation_faults(neon):
    neon(op_status="failed")
    with pytest.raises(npair.HarnessFault, match="ended failed"):
        npair.create_pair(ENV, "1-12", now=NOW, sleep=NOSLEEP)


def test_pair_slugs_fit_the_tool():
    assert npair.pair_slugs("1.12", NOW) == ("harness-1-12-1425-a", "harness-1-12-1425-b")
    with pytest.raises(npair.Refused, match="SLUG_RE"):
        npair.pair_slugs("x" * 40, NOW)
    with pytest.raises(npair.Refused):
        npair.pair_slugs("Bad Step", NOW)


def test_no_endpoint_on_prod(neon):
    fake = neon()
    with pytest.raises(npair.HarnessFault, match="prod"):
        npair.attach_endpoint(ENV, PROD, sleep=NOSLEEP)
    assert not fake.writes()


def test_branch_url_only_on_the_pairs_own_endpoint(neon):
    fake = neon()
    rec = npair.create_pair(ENV, "1-12", now=NOW, sleep=NOSLEEP)
    url = npair.branch_url(ENV, rec["b"], PROTECTED)
    assert urllib.parse.urlsplit(url).hostname == rec["b"]["host"]
    q = dict(urllib.parse.parse_qsl(fake.calls[-1][1].split("?", 1)[1]))
    assert q == {"branch_id": rec["b"]["id"], "endpoint_id": rec["b"]["endpoint_id"],
                 "database_name": "neondb", "role_name": "neondb_owner", "pooled": "false"}
    fake.uri_host = "ep-prod-endpoint.c-2.us-east-1.aws.neon.tech"
    with pytest.raises(npair.HarnessFault, match="PROTECTED"):
        npair.branch_url(ENV, rec["b"], PROTECTED)
    fake.uri_host = rec["a"]["host"]
    with pytest.raises(npair.HarnessFault, match="not this run's branch endpoint"):
        npair.branch_url(ENV, rec["b"], PROTECTED)
    with pytest.raises(npair.HarnessFault, match="prod"):
        npair.branch_url(ENV, {"id": PROD, "endpoint_id": "x", "host": "y"}, PROTECTED)


def test_protected_endpoints_come_from_the_cleanup_list():
    eps = npair.protected_endpoints()
    assert len(eps) >= 2 and all(e.startswith("ep-") for e in eps)


_REAL_CREATE = npair.create_pair


def test_pair_cli_writes_no_secret(neon, tmp_path, monkeypatch, capsys):
    neon()
    monkeypatch.setattr(npair, "create_pair",
                        lambda env, step, any_minute=False: _REAL_CREATE(env, step, now=NOW, sleep=NOSLEEP))
    out = tmp_path / "pair.json"
    assert harness.main(["pair", "--step", "1.12", "--out", str(out)], env=ENV) == 0
    rec = json.loads(out.read_text())
    assert rec["a"]["host"] and rec["b"]["host"] and "secret" not in out.read_text()
    assert "parent_lsn=" in capsys.readouterr().out


def test_fleet_cli_refuses_with_exit_4(neon):
    neon(temps=9)
    assert harness.main(["fleet"], env=ENV) == harness.EXIT["REFUSED"]


# ------------------------------------------------------------ the instrument (pure)

CFG = ck.default_config()


def test_volatile_tables_are_the_named_three():
    assert set(CFG["volatile_tables"]) == {"app_events", "ux_events", "rate_limit_buckets"}
    merged = ck.merge_config(CFG, {"volatile_columns": {"public.t": ["seen_at"]}, "volatile_tables": []})
    assert set(merged["volatile_tables"]) == set(CFG["volatile_tables"])
    assert merged["volatile_columns"] == {"public.t": ["seen_at"]}


def test_classify_drops_volatile_columns_and_says_why():
    cols = [("id", "uuid", "gen_random_uuid()"), ("seq", "bigint", "nextval('t_seq_seq'::regclass)"),
            ("name", "text", None), ("created_at", "timestamp with time zone", "now()"),
            ("updated_at", "timestamp with time zone", None), ("seen_at", "timestamp with time zone", None),
            ("workspace_id", "uuid", "gv.sentinel_workspace()"), ("on_at", "timestamptz", "CURRENT_TIMESTAMP")]
    cfg = ck.merge_config(CFG, {"volatile_columns": {"public.t": ["seen_at"]}})
    kept, excluded = ck.classify("public.t", cols, cfg)
    assert [k for k, _ in kept] == ["name", "workspace_id"]
    assert set(excluded) == {"id", "seq", "created_at", "updated_at", "seen_at", "on_at"}
    assert excluded["seen_at"] == "named by the use"


def test_row_expr_strips_named_jsonb_keys():
    expr = ck.row_expr("public.daily_plan", [("user_id", "text"), ("plan", "jsonb")], CFG)
    assert expr == "ROW(\"user_id\", (\"plan\"::jsonb - ARRAY['prior_runs']::text[]))::text"
    assert ck.row_expr("public.empty", [], CFG) == "'()'::text"


def test_checksum_sql_orders_by_the_business_row():
    sql = ck.checksum_sql("public.t", "ROW(\"a\")::text")
    assert 'ORDER BY r COLLATE "C"' in sql and 'FROM "public"."t"' in sql


def _snap(**tables):
    return {"tables": {k: {"rows": v[0], "md5": v[1], "columns": v[2] if len(v) > 2 else ["a"]}
                       for k, v in tables.items()}}


def test_diff_snapshots():
    a = _snap(**{"public.t": (1, "x"), "public.u": (2, "y")})
    assert ck.diff_snapshots(a, a) == []
    b = _snap(**{"public.t": (1, "z"), "public.v": (0, "e")})
    kinds = {d["table"]: d["kind"] for d in ck.diff_snapshots(a, b)}
    assert kinds == {"public.t": "rows", "public.u": "missing_on_b", "public.v": "missing_on_a"}
    c = _snap(**{"public.t": (1, "x", ["a", "b"]), "public.u": (2, "y")})
    assert ck.diff_snapshots(a, c)[0]["kind"] == "columns"


def test_stray_candidates():
    snap = _snap(**{"public.a": (0, "x"), "public.b": (3, "y"), "public.c": (2, "z")})
    plans = {"public.b": {"kept": [("n", "integer"), ("label", "text")]},
             "public.c": {"kept": [("note", "character varying(40)")]}}
    assert ck.stray_candidates(snap, plans) == [("public.b", "label"), ("public.c", "note")]
    assert ck.stray_candidates(snap, plans, "public.plants.name") == [("public.plants", "name")]


# ------------------------------------------------------------ the use and its positive control

LOG_USE = {"name": "u", "positive_control": {"name": "space-wx for the new Space", "kind": "log",
                                             "match": {"msg": "space-wx", "space": "$indoor"}}}


def arm(console=(), calls=()):
    return {"console": [{"json": c} for c in console], "calls": list(calls)}


def test_a_use_without_a_named_positive_control_is_a_fault():
    assert harness.validate_use({"name": "u"})
    assert harness.validate_use({"name": "u", "positive_control": {"kind": "log", "match": {}}})
    assert harness.validate_use(LOG_USE) == []
    assert harness.validate_use({"positive_control": {"name": "r", "kind": "row", "table": "public.t"}})


def test_log_control_present_on_b_absent_on_a():
    binds = {"indoor": "11111111-2222-3333-4444-555555555555"}
    line = {"msg": "space-wx", "space": binds["indoor"], "ms": 3}
    ok = harness.evaluate_control(LOG_USE["positive_control"], binds, {"a": arm(), "b": arm([line])})
    assert ok["ok"] and ok["counts"] == {"a": 0, "b": 1}
    same = harness.evaluate_control(LOG_USE["positive_control"], binds, {"a": arm(), "b": arm()})
    assert not same["ok"] and "not seen on b" in same["reason"]       # B = A: missing control
    both = harness.evaluate_control(LOG_USE["positive_control"], binds, {"a": arm([line]), "b": arm([line])})
    assert not both["ok"] and "also seen on a" in both["reason"]
    none = harness.evaluate_control(LOG_USE["positive_control"], binds, None)
    assert not none["ok"]


def test_unknown_bind_is_a_fault():
    with pytest.raises(npair.HarnessFault, match=r"\$indoor"):
        harness.evaluate_control(LOG_USE["positive_control"], {}, {"a": arm(), "b": arm()})


def test_destination_control_and_call_lists():
    pc = {"name": "ops alert", "kind": "destination", "stub": "publishAlert", "match": {"destination": "sns:ops"}}
    alert = {"stub": "publishAlert", "destination": "sns:ops", "subject": "s"}
    fetch = {"stub": "fetchNWS", "destination": "grid:42.5,-72.7"}
    a, b = arm(calls=[fetch]), arm(calls=[fetch, alert])
    assert harness.evaluate_control(pc, {}, {"a": a, "b": b})["ok"]
    calls = harness.compare_calls(a, b, pc, {})
    assert not calls["equal"] and not calls["unexpected_only_b"]      # the control's own diff is expected
    assert calls["alerts"]["b"] == [["publishAlert", "sns:ops", "s"]]
    graph = {"stub": "graph", "destination": "graph:123/feed"}
    stray = harness.compare_calls(a, arm(calls=[fetch, alert, graph]), pc, {})
    assert stray["unexpected_only_b"] == [["graph", "graph:123/feed", ""]]
    allowed = harness.compare_calls(a, arm(calls=[fetch, graph]), None, {}, [{"stub": "graph"}])
    assert not allowed["unexpected_only_b"]


# ------------------------------------------------------------ CLI guards (no database reached)

LOCAL = {"A": "postgresql://postgres@127.0.0.1:55445/h", "B": "postgresql://postgres@127.0.0.1:55455/h"}


def _run(tmp_path, use, env=LOCAL, extra=()):
    f = tmp_path / "use.json"
    f.write_text(json.dumps(use))
    return harness.main(["run", "--a-dsn-env", "A", "--b-dsn-env", "B", "--local-pg", "--use", str(f),
                         "--today", "2026-10-16", *extra], env=env)


def test_cli_missing_positive_control_faults_before_any_connection(tmp_path, monkeypatch):
    monkeypatch.setattr(harness, "connect", lambda dsn: pytest.fail("connected"))
    assert _run(tmp_path, {"name": "no control"}) == harness.EXIT["FAULT"]


def test_cli_offline_refuses_a_remote_url(tmp_path):
    env = dict(LOCAL, B="postgresql://u:p@ep-somewhere.aws.neon.tech/neondb")
    assert _run(tmp_path, LOG_USE, env) == harness.EXIT["REFUSED"]


def test_cli_refuses_a_equal_b(tmp_path):
    assert _run(tmp_path, LOG_USE, dict(LOCAL, B=LOCAL["A"])) == harness.EXIT["REFUSED"]


def test_cli_crash_is_a_fault_never_a_diff(tmp_path, monkeypatch):
    def boom(dsn):
        raise RuntimeError("socket closed")
    monkeypatch.setattr(harness, "connect", boom)
    assert _run(tmp_path, LOG_USE) == harness.EXIT["FAULT"]


def test_cli_code_mode_needs_both_shas(tmp_path):
    assert _run(tmp_path, LOG_USE, extra=("--base-sha", "abc")) == harness.EXIT["USAGE"]


def test_no_sentinel_literal_in_the_harness():
    """The sentinel Space id is read from gv.sentinel_workspace(); no file here spells it."""
    needle = "-".join(["0" * 8, "0" * 4, "0" * 4, "0" * 4, "0" * 11])
    for root, _, files in os.walk(HERE):
        for name in files:
            if name.endswith((".py", ".mjs", ".json", ".md")):
                assert needle not in open(os.path.join(root, name)).read(), name


def test_the_example_use_is_valid():
    with open(os.path.join(HERE, "fixtures", "use.example-d1.json")) as fh:
        use = json.load(fh)
    assert harness.validate_use(use) == []
    with open(harness.DEFAULT_FIXTURE) as fh:
        fx = json.load(fh)
    assert set(fx) >= {"geocode", "nws", "precip", "rainForecast", "station"}
