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
import re
import subprocess
import sys
import urllib.parse

import pytest

# SPACE_HARNESS_DIR points the tests at another copy of the harness (a mutation or an older commit).
HERE = os.environ.get("SPACE_HARNESS_DIR") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "space-harness")
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
        if method == "GET" and path.startswith("branches/"):
            hit = [b for b in self.branches if b["id"] == path.split("/", 1)[1]]
            return (200, {"branch": dict(hit[0])}) if hit else (404, {"message": "not found"})
        if method == "GET" and path.startswith("endpoints/"):
            ep = self.endpoints.get(path.split("/", 1)[1])
            return (200, {"endpoint": dict(ep)}) if ep else (404, {"message": "not found"})
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

def test_fleet_budget_holds_a_slot_for_the_sitting_copy(neon):
    """integrity-weekly alerts above NEON_MAX_EXPIRING (6) self-cleaning branches: 3 + 2 + 1 fits, 4 does not."""
    neon(temps=3)
    c = npair.fleet_check(ENV)
    assert (c["expiring"], c["reserved_for_sitting_copy"], c["limit"]) == (3, 1, 6)
    fake = neon(temps=4)
    with pytest.raises(npair.Refused, match="4 self-cleaning branches"):
        npair.fleet_check(ENV)
    assert not fake.writes()


def test_fleet_budget_once_the_sitting_copy_exists(neon):
    fake = neon(temps=3)
    fake.branches.append(br("sitting-ms1-prod-preapply-20261016"))
    assert npair.fleet_check(ENV)["reserved_for_sitting_copy"] == 0       # 4 + 2 = 6 fits
    fake.branches.append(br("sitting-other-prod-preapply-20261016"))
    with pytest.raises(npair.Refused, match="5 self-cleaning"):
        npair.fleet_check(ENV)
    assert npair.fleet_check(dict(ENV, NEON_MAX_EXPIRING="7"))["limit"] == 7


def test_fleet_counts_only_self_cleaning_branches(neon):
    fake = neon(temps=3)
    fake.branches += [br(f"stray{i}", expires_at=None) for i in range(4)]   # no expiry: the branch cap's business
    assert npair.fleet_check(ENV)["expiring"] == 3


def test_fleet_zero_reads_the_tools_empty_line(neon):
    neon(temps=0)
    assert npair.fleet_check(ENV)["temporary"] == []


def test_fleet_tool_failure_is_a_fault(monkeypatch):
    monkeypatch.setattr(nsb, "api", lambda *a, **k: (500, "boom"))
    with pytest.raises(npair.HarnessFault, match="list exited 1"):
        npair.fleet_check(ENV)


def counted_fleet(fake, counted):
    """production + staging (from FakeNeon) + 6 retention-owned snaps, then no-expiry
    strays up to `counted` counted branches. The fake's self-cleaning temps are not counted."""
    fake.branches += [br(f"snap-v5.3.{i}", expires_at=None, created=f"2026-10-0{i + 1}T10:00:00Z")
                      for i in range(6)]
    fake.branches += [br(f"revert-stage-v0.0.9{i}", expires_at=None) for i in range(counted - 8)]
    return fake


def test_fleet_second_cap_refuses_eleven_counted_passes_ten(neon):
    """R24 / 2.0d positive control: integrity-weekly also caps all branches minus self-cleaning
    strays at SNAP_KEEP + 4 (repo var SNAP_RETENTION = 6, so 10): 10 passes, 11 refuses."""
    assert npair.FLEET_SNAP_KEEP + 4 == 10
    fake = counted_fleet(neon(temps=3), 10)
    c = npair.fleet_check(ENV)
    assert (c["counted"], c["branch_limit"], c["expiring"]) == (10, 10, 3)
    alerts, _ = nbs.hygiene_alerts(fake.branches, 6, 10, 7, set(), now=NOW)
    assert not [a for a in alerts if "count" in a]
    fake = counted_fleet(neon(temps=3), 11)
    with pytest.raises(npair.Refused, match=r"cap 2: 14 branches - 3 self-cleaning strays = 11 > 10"):
        npair.fleet_check(ENV)
    alerts, _ = nbs.hygiene_alerts(fake.branches, 6, 10, 7, set(), now=NOW)
    assert [a for a in alerts if a.startswith("neon-branches: count 11 > max 10")]
    assert not fake.writes()


def test_fleet_second_cap_counts_the_way_the_weekly_check_does(neon):
    """A kept snap that carries an expiry is not a stray, so it is counted (cap 1 still sees it
    as self-cleaning); a seventh, over-retention snap is counted too."""
    fake = counted_fleet(neon(temps=0), 10)
    fake.branches[2]["expires_at"] = "2026-10-20T10:00:00Z"
    c = npair.fleet_check(ENV)
    assert (c["counted"], c["expiring"]) == (10, 1)
    fake.branches.append(br("snap-v5.3.9", expires_at=None, created="2026-10-09T10:00:00Z"))
    with pytest.raises(npair.Refused, match="= 11 > 10"):
        npair.fleet_check(ENV)
    _, state = nbs.hygiene_alerts(fake.branches, 6, 10, 7, set(), now=NOW)
    assert state["branch_count"] - len(state["expiring_ids"]) == 11


def test_fleet_second_cap_reads_snap_keep_and_the_override(neon):
    counted_fleet(neon(temps=0), 11)
    assert npair.fleet_check(dict(ENV, SNAP_KEEP="7"))["branch_limit"] == 11
    assert npair.fleet_check(dict(ENV, NEON_MAX_BRANCHES="12"))["branch_limit"] == 12
    with pytest.raises(npair.Refused, match="cap 2"):
        npair.fleet_check(dict(ENV, NEON_MAX_BRANCHES="10"))


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


def test_fleet_cli_prints_both_caps(neon, capsys):
    """Both caps, each with its count, limit and verdict, pass or refuse; either one over refuses."""
    counted_fleet(neon(temps=3), 10)
    assert harness.main(["fleet"], env=ENV) == 0
    out = capsys.readouterr().out
    assert re.search(r"cap 1: 3 self-cleaning branches .* = 6 <= 6 \(NEON_MAX_EXPIRING\) PASS", out)
    assert re.search(r"cap 2: 13 branches - 3 self-cleaning strays = 10 <= 10 \(SNAP_KEEP 6 \+ 4\) PASS", out)
    counted_fleet(neon(temps=3), 11)
    assert harness.main(["fleet"], env=ENV) == harness.EXIT["REFUSED"]
    cap = capsys.readouterr()
    assert re.search(r"cap 1: .* PASS", cap.out) and re.search(r"cap 2: .* = 11 > 10 .* REFUSE", cap.out)
    assert "REFUSED: fleet: cap 2" in cap.err
    counted_fleet(neon(temps=4), 10)
    assert harness.main(["fleet"], env=ENV) == harness.EXIT["REFUSED"]
    cap = capsys.readouterr()
    assert re.search(r"cap 1: 4 .* = 7 > 6 .* REFUSE", cap.out) and re.search(r"cap 2: .* PASS", cap.out)


# ------------------------------------------------------------ the instrument (pure)

CFG = ck.default_config()


def test_volatile_tables_are_the_named_three():
    assert set(CFG["volatile_tables"]) == {"app_events", "ux_events", "rate_limit_buckets"}
    merged = ck.merge_config(CFG, {"volatile_columns": {"public.t": ["seen_at"]}, "volatile_tables": []})
    assert set(merged["volatile_tables"]) == set(CFG["volatile_tables"])
    assert merged["volatile_columns"] == {"public.t": ["seen_at"]}


def test_classify_leaves_out_only_the_named_columns_never_by_default():
    cols = [("id", "uuid", "gen_random_uuid()"), ("seq", "bigint", "nextval('t_seq_seq'::regclass)"),
            ("name", "text", None), ("created_at", "timestamp with time zone", "now()"),
            ("updated_at", "timestamp with time zone", None), ("seen_at", "timestamp with time zone", None),
            ("workspace_id", "uuid", "gv.sentinel_workspace()"), ("on_at", "timestamptz", "CURRENT_TIMESTAMP"),
            ("generated_at", "timestamp with time zone", "now()")]
    cfg = ck.merge_config(CFG, {"volatile_columns": {"public.t": ["seen_at"]}})
    kept, excluded = ck.classify("public.t", cols, cfg)
    assert [k for k, _ in kept] == ["id", "seq", "name", "workspace_id", "on_at", "generated_at"]
    assert excluded == {"created_at": "volatile name", "updated_at": "volatile name", "seen_at": "named by the use"}


def test_event_log_event_date_is_checksummed():
    """event_log.event_date has DEFAULT now() and run() writes it explicitly (rain rows): it is compared."""
    kept, _ = ck.classify("public.event_log", [("id", "uuid", "extensions.uuid_generate_v4()"),
                                               ("event_date", "timestamp with time zone", "now()")], CFG)
    assert [k for k, _ in kept] == ["id", "event_date"]


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


def test_stray_candidates_cover_every_measured_table():
    snap = _snap(**{"public.a": (0, "x"), "public.b": (3, "y"), "public.c": (2, "z")})
    plans = {"public.b": {"kept": [("n", "integer"), ("label", "text"), ("blob", "bytea")],
                          "all": [("n", "integer"), ("label", "text"), ("blob", "bytea")]},
             "public.c": {"kept": [("note", "character varying(40)")], "all": [("note", "character varying(40)")]}}
    assert ck.stray_candidates(snap, plans) == {"public.b": [("label", "text")]}            # no use: one table
    assert ck.stray_candidates(snap, plans, tables=["public.b", "public.c"]) == {
        "public.b": [("label", "text"), ("n", "integer")], "public.c": [("note", "character varying(40)")]}
    assert ck.stray_candidates(snap, plans, "public.b.n", ["public.b"]) == {"public.b": [("n", "integer")]}
    assert ck.stray_set("n", "integer") == '"n" + 1' and ck.stray_set("blob", "bytea") is None


def test_measured_tables_are_the_ones_the_use_names():
    use = {"positive_control": {"kind": "row", "table": "public.spaces"},
           "allowed_diffs": [{"table": "public.audit_events"}], "volatile_columns": {"public.plants": ["name"]},
           "jsonb_volatile_keys": {"public.daily_plan.items": ["k"]},
           "needles_absent": [{"surfaces": ["console", "rows:public.event_log"]}]}
    assert harness.measured_tables(use, arms=False) == ["public.audit_events", "public.daily_plan",
                                                        "public.event_log", "public.plants", "public.spaces"]
    assert "public.daily_plan" in harness.measured_tables({}, arms=True)


# ------------------------------------------------------------ the use and its positive control

LOG_USE = {"name": "u", "positive_control": {"name": "space-wx for the new Space", "kind": "log",
                                             "match": {"msg": "space-wx", "space": "$indoor"}}}


def arm(console=(), calls=()):
    return {"console": [{"json": c} for c in console], "calls": list(calls)}


def test_an_alert_body_is_part_of_the_call():
    """Same topic and subject, different body (B's plantings in Dave's alert): a DIFF, not equal calls."""
    dave = {"stub": "publishAlert", "destination": "sns:frost", "subject": "Frost tonight", "message": "Tomato"}
    leak = dict(dave, message="Tomato, Indoor Basil")
    calls = harness.compare_calls(arm(calls=[dave]), arm(calls=[leak]))
    assert not calls["equal"] and calls["unexpected_only_b"] and calls["unexpected_only_a"]
    assert harness.compare_calls(arm(calls=[dave]), arm(calls=[dict(dave)]))["equal"]


def test_needles_absent_finds_a_leak_on_the_side_it_must_not_reach():
    use = {"name": "u", "positive_control": LOG_USE["positive_control"],
           "needles_absent": [{"needle": "$indoor", "sides": ["a"], "surfaces": ["console", "calls"]}]}
    assert harness.validate_use(use) == []
    binds = {"indoor": "space-b-id"}
    a = {"console": [{"line": "plan for space-b-id"}], "calls": [{"stub": "publishAlert", "message": "x space-b-id"}]}
    hits = harness.needle_hits(use["needles_absent"], binds, {"a": a, "b": arm()}, {})
    assert [(h["side"], h["surface"], h["hits"]) for h in hits] == [("a", "console", 1), ("a", "calls", 1)]
    assert harness.needle_hits(use["needles_absent"], binds, {"a": arm(), "b": a}, {}) == []
    dave = [{"needle": "$indoor", "sides": ["b"], "surfaces": ["calls"], "destination": "sns:frost"}]
    b = arm(calls=[{"stub": "publishAlert", "destination": "sns:frost", "message": "Tomato"},
                   {"stub": "publishAlert", "destination": "sns:indoor", "message": "space-b-id"}])
    assert harness.needle_hits(dave, binds, {"a": arm(), "b": b}, {}) == []
    b["calls"][0]["message"] = "Tomato, space-b-id"
    assert len(harness.needle_hits(dave, binds, {"a": arm(), "b": b}, {})) == 1
    assert harness.validate_use(dict(use, needles_absent=[{"needle": "x", "sides": ["a"], "surfaces": ["mail"]}]))


def test_b_equals_a_cannot_be_switched_off_by_a_use():
    """absent_on null (or the same side) would let a control seen on both sides pass: refused."""
    for absent in (None, "b"):
        pc = dict(LOG_USE["positive_control"], absent_on=absent)
        assert any("B = A must fault" in e for e in harness.validate_use({"name": "u", "positive_control": pc}))
    pc = dict(LOG_USE["positive_control"], absent_on=None)
    line = {"msg": "space-wx", "space": "x"}
    both = harness.evaluate_control(pc, {"indoor": "x"}, {"a": arm([line]), "b": arm([line])})
    assert not both["ok"]                                             # even if a caller skipped validate_use


def test_b_equals_a_when_nothing_tells_them_apart():
    same = {"diffs": [], "allowed_diffs": [], "calls": {"equal": True},
            "arms": {"a": {"log_msgs": {"x": 1}}, "b": {"log_msgs": {"x": 1}}},
            "positive_control": {"counts": {"a": 1, "b": 1}}}
    arms = {"a": arm(), "b": arm()}
    assert harness.b_equals_a(same, arms)
    assert not harness.b_equals_a(dict(same, positive_control={"counts": {"a": 0, "b": 1}}), arms)
    assert not harness.b_equals_a(dict(same, allowed_diffs=[{"only_b": 1}]), arms)
    assert not harness.b_equals_a(dict(same, arms={"a": {"log_msgs": {}}, "b": {"log_msgs": {"x": 1}}}), arms)


def test_unknown_use_keys_are_refused():
    assert harness.validate_use(dict(LOG_USE, stray_targett="public.t.c"))


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
    assert calls["alerts"]["b"] == [["publishAlert", "sns:ops", "s", ""]]
    graph = {"stub": "graph", "destination": "graph:123/feed"}
    stray = harness.compare_calls(a, arm(calls=[fetch, alert, graph]), pc, {})
    assert stray["unexpected_only_b"] == [["graph", "graph:123/feed", "", ""]]
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


def test_cli_same_sha_twice_is_refused(tmp_path, monkeypatch):
    monkeypatch.setattr(harness, "connect", lambda dsn: pytest.fail("connected"))
    assert _run(tmp_path, LOG_USE, extra=("--base-sha", "abc", "--candidate-sha", "abc")) == harness.EXIT["USAGE"]


def test_cli_pair_and_local_pg_do_not_mix(tmp_path, monkeypatch):
    monkeypatch.setattr(harness, "connect", lambda dsn: pytest.fail("connected"))
    assert _run(tmp_path, LOG_USE, extra=("--pair", str(tmp_path / "pair.json"))) == harness.EXIT["USAGE"]


def test_cli_a_run_with_no_change_is_b_equals_a_and_faults(tmp_path, monkeypatch):
    monkeypatch.setattr(harness, "connect", lambda dsn: pytest.fail("connected"))
    out = tmp_path / "v.json"
    assert _run(tmp_path, LOG_USE, extra=("--out", str(out))) == harness.EXIT["FAULT"]
    assert "B = A" in json.loads(out.read_text())["faults"][0]


def test_cli_two_spellings_of_one_url_are_refused(tmp_path, monkeypatch):
    monkeypatch.setattr(harness, "connect", lambda dsn: pytest.fail("connected"))
    env = dict(LOCAL, B=LOCAL["A"] + "?sslmode=disable")
    assert _run(tmp_path, LOG_USE, env, ("--b-sql", "x.sql")) == harness.EXIT["REFUSED"]


def test_cli_crash_leaves_a_fault_verdict_file(tmp_path, monkeypatch):
    out = tmp_path / "v.json"
    out.write_text(json.dumps({"verdict": "PASS"}))                   # an earlier run's verdict
    monkeypatch.setattr(harness, "connect", lambda dsn: (_ for _ in ()).throw(RuntimeError("socket closed")))
    (tmp_path / "b.sql").write_text("SELECT 1")
    assert _run(tmp_path, LOG_USE, extra=("--b-sql", str(tmp_path / "b.sql"), "--out", str(out))) == 3
    v = json.loads(out.read_text())
    assert v["verdict"] == "FAULT" and "RuntimeError" in v["faults"][0]


class LockConn:
    """Session advisory locks of one fake database, shared by its connections."""

    def __init__(self, db, me):
        self.db, self.me = db, me

    def cursor(self):
        conn = self

        class Cur:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def execute(self, sql, params=None):
                k, held = params["k"], conn.db.get(params["k"])
                if "pg_try_advisory_lock" in sql:
                    self.row = held in (None, conn.me)
                    if self.row:
                        conn.db[k] = conn.me
                elif "pg_advisory_lock" in sql:
                    assert held in (None, conn.me)
                    conn.db[k], self.row = conn.me, None
                else:
                    conn.db.pop(k, None) if held == conn.me else None
                    self.row = True

            def fetchall(self):
                return [(self.row,)]
        return Cur()


def test_distinct_probe_tells_one_database_from_two():
    a, b = LockConn({}, "a"), LockConn({}, "b")
    harness.distinct_probe(a, b, key=7)
    shared = {}
    with pytest.raises(npair.HarnessFault, match="same database"):
        harness.distinct_probe(LockConn(shared, "a"), LockConn(shared, "b"), key=7)
    assert shared == {}                                                # B's lock is released either way


# ------------------------------------------------------------ the pair's identity (Neon GET, before any URL)

def _pair_file(tmp_path, rec):
    p = tmp_path / "pair.json"
    p.write_text(json.dumps(rec))
    return p


def _selftest_on_pair(tmp_path, monkeypatch, rec):
    monkeypatch.setattr(harness, "connect", lambda dsn: pytest.fail("connected"))
    monkeypatch.setattr(npair, "protected_endpoints", lambda path=None: PROTECTED)
    return harness.main(["selftest0", "--pair", str(_pair_file(tmp_path, rec))], env=ENV)


def test_pair_urls_only_after_neon_confirms_the_pair(neon):
    fake = neon()
    rec = npair.create_pair(ENV, "1-12", now=NOW, sleep=NOSLEEP)
    fake.calls.clear()
    npair.verify_pair(ENV, rec, PROTECTED, now=NOW)
    gets = [c[1] for c in fake.calls]
    assert gets == [f"branches/{rec['a']['id']}", f"endpoints/{rec['a']['endpoint_id']}",
                    f"branches/{rec['b']['id']}", f"endpoints/{rec['b']['endpoint_id']}"]
    assert not fake.writes()


def _bad_records(fake, rec):
    preview = br("preview/pr-12", bid="br-preview")
    fake.branches.append(preview)
    fake.endpoints["ep-preview"] = {"id": "ep-preview", "host": "ep-preview.neon.tech", "branch_id": "br-preview"}
    staging = [b for b in fake.branches if b["name"] == "staging"][0]
    fake.endpoints["ep-staging-endpoint"] = {"id": "ep-staging-endpoint", "host": "ep-staging-endpoint.neon.tech",
                                             "branch_id": staging["id"]}
    a, b = rec["a"], rec["b"]
    late = br("sitting-harness-1-12-1425-b-prod-preapply-20261016", bid="br-late", expires_at="2026-10-30T00:00:00Z")
    fake.branches.append(late)
    return {
        "a non-harness branch": dict(rec, b={"name": "preview/pr-12", "id": "br-preview", "endpoint_id": "ep-preview",
                                             "host": "ep-preview.neon.tech"}),
        "staging": dict(rec, b={"name": "staging", "id": staging["id"], "endpoint_id": "ep-staging-endpoint",
                                "host": "ep-staging-endpoint.neon.tech"}),
        "prod": dict(rec, b=dict(b, id=PROD)),
        "A and B swapped": dict(rec, a=b, b=a),
        "one side twice": dict(rec, b=dict(a)),
        "B's id with A's endpoint": dict(rec, b=dict(b, endpoint_id=a["endpoint_id"], host=a["host"])),
        "an expiry far away": dict(rec, b=dict(b, id="br-late")),
        "a host edited in pair.json": dict(rec, b=dict(b, host="ep-other.neon.tech")),
    }


def test_only_the_pairs_own_branches_and_endpoints_are_accepted(neon, tmp_path, monkeypatch):
    fake = neon()
    rec = npair.create_pair(ENV, "1-12", now=NOW, sleep=NOSLEEP)
    for why, bad in _bad_records(fake, rec).items():
        fake.calls.clear()
        with pytest.raises(npair.Refused):
            npair.verify_pair(ENV, bad, PROTECTED, now=NOW)
        assert not any(c[1].startswith("connection_uri") for c in fake.calls), why
        assert _selftest_on_pair(tmp_path, monkeypatch, bad) == harness.EXIT["REFUSED"], why


# ------------------------------------------------------------ arms: environment, flags, output, exit

def test_arm_env_carries_no_operator_secret():
    op = {"PATH": "/bin", "HOME": "/h", "NEON_DATABASE_URL": "postgres://prod", "GARDEN_RO_DATABASE_URL": "x",
          "AWS_SECRET_ACCESS_KEY": "s", "AWS_PROFILE": "p", "NEON_API_KEY": "k", "PGPASSWORD": "pw", "GH_TOKEN": "t"}
    env = harness.arm_env("postgresql://u:p@ep-x/neondb", {"FROST_ALERT_ENABLED": "true"}, op)
    assert env == {"PATH": "/bin", "HOME": "/h", "FROST_ALERT_ENABLED": "true",
                   "HARNESS_DSN": "postgresql://u:p@ep-x/neondb", "AWS_EC2_METADATA_DISABLED": "true"}
    with pytest.raises(npair.HarnessFault):
        harness.arm_env("x", {"AWS_SECRET_ACCESS_KEY": "s"}, op)


def test_arm_flags_follow_the_lambda_manifest():
    op = {"SYSTEM_CLERK_SUB": "user_sys", "NEON_DATABASE_URL": "postgres://prod"}
    env, eff = harness.arm_flags({}, op)
    assert env["FROST_ALERT_ENABLED"] == "true" and env["SYSTEM_CLERK_SUB"] == "user_sys"
    assert eff["SYSTEM_CLERK_SUB"] == "set from the operator's environment"     # value never in the verdict
    assert eff["CARE_WATER_LEDGER_ENABLED"] is None and "CARE_WATER_LEDGER_ENABLED" not in env
    assert eff["SECRET_NAME"] == "withheld" and "NEON_DATABASE_URL" not in env
    env, eff = harness.arm_flags({"flags": {"FROST_ALERT_ENABLED": "false", "CARE_RAIN_SOON_ENABLED": "true"}}, {})
    assert env["FROST_ALERT_ENABLED"] == "false" and env["CARE_RAIN_SOON_ENABLED"] == "true"
    assert harness.flag_problems({"requires_flags": ["FROST_ALERT_ENABLED", "GARDEN_HOUSEHOLD_IDS"]}, eff) == [
        "requires flag FROST_ALERT_ENABLED, which is 'false' for the arms",
        "requires flag GARDEN_HOUSEHOLD_IDS, which is None for the arms"]
    assert harness.validate_use(dict(LOG_USE, flags={"NEON_DATABASE_URL": "x"}))


class Args:
    today, fixture, local_pg, driver, ws, echo, arm_timeout = "2026-10-16", None, True, None, None, False, 5


def _fake_node(monkeypatch, write):
    def run(cmd, env=None, **kw):
        out, nonce = cmd[cmd.index("--out") + 1], cmd[cmd.index("--nonce") + 1]
        rc = write(out, nonce, env)
        return subprocess.CompletedProcess(cmd, rc, "", "boom" if rc else "")
    monkeypatch.setattr(harness.subprocess, "run", run)


def test_run_arm_never_reads_an_earlier_runs_output(tmp_path, monkeypatch):
    stale = {"nonce": "old", "today": "2026-10-16", "console": [{"json": {"msg": "space-wx"}}], "env_keys": []}
    (tmp_path / "arm-a.json").write_text(json.dumps(stale))
    _fake_node(monkeypatch, lambda out, nonce, env: 1)                # the runner died before writing
    with pytest.raises(npair.HarnessFault, match="wrote no output"):
        harness.run_arm("a", "/t", "dsn", Args, str(tmp_path), {}, "n1")
    assert not (tmp_path / "arm-a.json").exists()

    def wrong_nonce(out, nonce, env):
        open(out, "w").write(json.dumps(dict(stale, nonce="other")))
        return 0
    _fake_node(monkeypatch, wrong_nonce)
    with pytest.raises(npair.HarnessFault, match="not this run's"):
        harness.run_arm("a", "/t", "dsn", Args, str(tmp_path), {}, "n1")


def test_any_arm_exit_other_than_success_faults(tmp_path, monkeypatch):
    def threw(out, nonce, env):
        open(out, "w").write(json.dumps({"nonce": nonce, "today": "2026-10-16", "error": "Error: boom",
                                         "handler_path": "/t/lambda/daily-plan/handler.js", "env_keys": sorted(env)}))
        return 1
    _fake_node(monkeypatch, threw)
    arms = {s: harness.run_arm(s, "/t", "dsn", Args, str(tmp_path), {"PATH": "/bin"}, "n1") for s in ("a", "b")}
    faults = harness.arm_faults(arms, {"a": "/t", "b": "/t"}, None)
    assert [f.split(":")[0] for f in faults] == ["arm a did not succeed (exit 1)", "arm b did not succeed (exit 1)"]
    ok = {s: dict(arms[s], exit=0, error=None) for s in arms}
    assert harness.arm_faults(ok, {"a": "/t", "b": "/t"}, None) == []
    assert harness.arm_faults(dict(ok, b=dict(ok["b"], exit=137)), {"a": "/t", "b": "/t"}, None)


def test_an_arm_that_saw_an_ungiven_env_key_faults(tmp_path, monkeypatch):
    def leaky(out, nonce, env):
        open(out, "w").write(json.dumps({"nonce": nonce, "today": "2026-10-16", "env_keys": ["NEON_DATABASE_URL"]}))
        return 0
    _fake_node(monkeypatch, leaky)
    with pytest.raises(npair.HarnessFault, match="NEON_DATABASE_URL"):
        harness.run_arm("a", "/t", "dsn", Args, str(tmp_path), {"PATH": "/bin"}, "n1")


# ------------------------------------------------------------ two-worktree code mode

def _git(repo, *argv):
    return subprocess.run(["git", "-C", str(repo), *argv], check=True, capture_output=True, text=True).stdout.strip()


def test_code_mode_trees_are_pinned_clean_and_removed(tmp_path):
    repo = tmp_path / "repo"
    (repo / "lambda" / "daily-plan").mkdir(parents=True)
    _git(tmp_path, "init", "-q", str(repo))
    shas = []
    for label in ("base", "candidate"):
        (repo / "lambda" / "daily-plan" / "handler.js").write_text(f"// {label}\n")
        _git(repo, "add", "-A")
        _git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", label)
        shas.append(_git(repo, "rev-parse", "HEAD"))
    made, trees = [], {"a": str(tmp_path / "base"), "b": str(tmp_path / "cand")}
    heads = {"a": harness.prepare_tree(shas[0], trees["a"], made, repo=str(repo)),
             "b": harness.prepare_tree(shas[1], trees["b"], made, repo=str(repo))}
    assert heads == {"a": shas[0], "b": shas[1]}
    assert "// base" in open(os.path.join(trees["a"], "lambda", "daily-plan", "handler.js")).read()
    with pytest.raises(npair.HarnessFault, match=r"is at"):
        harness.prepare_tree(shas[1], trees["a"], made, repo=str(repo))
    arms = {s: {"exit": 0, "head": heads[s], "handler_path": os.path.join(trees[s], "lambda", "daily-plan", "handler.js")}
            for s in ("a", "b")}
    assert harness.arm_faults(arms, trees, heads) == []
    crossed = dict(arms, b=dict(arms["b"], handler_path=arms["a"]["handler_path"], head=heads["a"]))
    assert len(harness.arm_faults(crossed, trees, heads)) == 2
    with open(os.path.join(trees["b"], "lambda", "daily-plan", "handler.js"), "a") as fh:
        fh.write("// edited\n")
    with pytest.raises(npair.HarnessFault, match="uncommitted"):
        harness.prepare_tree(shas[1], trees["b"], [], repo=str(repo))
    _git(trees["b"], "checkout", "-q", "--", ".")
    assert harness.remove_trees(made, repo=str(repo)) == []
    assert not os.path.exists(trees["a"]) and not os.path.exists(trees["b"])


# ------------------------------------------------------------ public-repo literals

MAC_RE = re.compile(r"\b[0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5}\b")
PRECISE_RE = re.compile(r"-?\d+\.\d{4,}")


def test_no_device_id_or_precise_coordinate_in_the_harness_fixtures():
    """A recorded AWN payload carries the station MAC; a recorded fetch, a precise location. Neither belongs here."""
    for root, _, files in os.walk(os.path.join(HERE, "fixtures")):
        for name in files:
            text = open(os.path.join(root, name)).read()
            assert not MAC_RE.search(text), f"{name}: MAC-shaped literal"
            assert not PRECISE_RE.search(text), f"{name}: 4+ decimal literal"


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
