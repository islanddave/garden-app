#!/usr/bin/env python3
"""Mocked unit tests for revert-to.py (spec §3 B2). All GitHub/Neon/AWS I/O mocked."""
import importlib.util
import json
import os
import sys
import types

import pytest
import requests as real_requests

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)


def _load():
    spec = importlib.util.spec_from_file_location("revert_to", os.path.join(HERE, "revert-to.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


rt = _load()


# --- fakes -------------------------------------------------------------------

class FakeResp:
    def __init__(self, status, payload=None, text="", content=b"", bad_json=False):
        self.status_code = status
        self._payload = payload if payload is not None else {}
        self.text = text or json.dumps(self._payload)
        self.content = content
        self.bad_json = bad_json  # a 200 whose body is not JSON (an HTML error page, a cut-off body)

    def json(self):
        if self.bad_json:
            raise ValueError("Expecting value: line 1 column 1 (char 0)")
        return self._payload


class FakeRequests:
    """Programmable requests double. routes: list of (method, substr, FakeResp|callable)."""
    def __init__(self):
        self.routes = []
        self.calls = []
        self.last_json = None

    def add(self, method, substr, resp):
        self.routes.append((method.upper(), substr, resp))

    def _match(self, method, url):
        for m, sub, resp in self.routes:
            if m == method and sub in url:
                return resp(url) if callable(resp) else resp
        raise AssertionError(f"no route for {method} {url}")

    def get(self, url, **k):
        self.calls.append(("GET", url))
        return self._match("GET", url)

    def post(self, url, **k):
        self.calls.append(("POST", url))
        self.last_json = k.get("json")
        return self._match("POST", url)

    def patch(self, url, **k):
        self.calls.append(("PATCH", url))
        self.last_json = k.get("json")
        return self._match("PATCH", url)

    def delete(self, url, **k):
        self.calls.append(("DELETE", url))
        return self._match("DELETE", url)


class FakeS3:
    def __init__(self, objects=None):
        self.objects = objects or {}  # (bucket,key) -> bytes
        self.downloads = []

    def get_object(self, Bucket, Key):
        if (Bucket, Key) not in self.objects:
            from botocore.exceptions import ClientError
            raise ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObject")
        return {"Body": types.SimpleNamespace(read=lambda: self.objects[(Bucket, Key)])}

    def download_file(self, Bucket, Key, path):
        self.downloads.append((Bucket, Key))
        with open(path, "wb") as f:
            f.write(self.objects.get((Bucket, Key), b"DUMPDATA"))


def base_env(**over):
    env = {
        "GH_TOKEN": "t", "GITHUB_REPOSITORY": "islanddave/garden-app",
        "TARGET_VERSION": "v2.5.0", "PREREVERT_VERSION": "v2.5.1",
        "NEON_API_KEY": "k", "NEON_PROJECT_ID": "p",
        "NEON_BACKUP_URL": "postgresql://x", "PHOTOS_BUCKET": "garden-photos-prod",
        "CONFIRM_DATA_LOSS": "yes",
    }
    env.update(over)
    return env


def good_manifest():
    return {
        "git_tag": "v2.5.0", "main_sha": "a" * 40, "neon_branch": "snap-v2.5.0",
        "neon_branch_id": "br-snap", "neon_lsn": "0/ABC", "dump_s3_key": "db/snap-v2.5.0.dump",
        "photo_versionids_key": "photos/snap-v2.5.0.versionids.json",
        "lambda_versions": {"garden-plants": "7"}, "cf_dist": "E3FAJTXAORQYDT",
        "app_version": "v2.5.0", "timestamp": "2026-06-03T00:00:00Z",
    }


# --- validation --------------------------------------------------------------

def test_version_validation_good():
    for v in ["v1", "v1.2", "v1.2.3", "v2.5.0"]:
        assert rt.validate_version(v, "X") == v


def test_version_validation_bad():
    for v in ["2.5", "v1.2.3.4", "vX", "v1;rm", ""]:
        with pytest.raises(rt.RevertError):
            rt.validate_version(v, "X")


def test_prerevert_equals_target_rejected(monkeypatch):
    cfg = rt.Config(env=base_env(PREREVERT_VERSION="v2.5.0"))
    with pytest.raises(rt.RevertError):
        rt.run(cfg, s3=FakeS3())


# --- step 1: manifest + tag --------------------------------------------------

def test_load_manifest_missing_fails_closed():
    cfg = rt.Config(env=base_env())
    with pytest.raises(rt.RevertError):
        rt.load_manifest(FakeS3(), cfg)


def test_load_manifest_missing_fields():
    cfg = rt.Config(env=base_env())
    bad = {"git_tag": "v2.5.0"}
    s3 = FakeS3({("garden-snapshots-prod", "snapshots/v2.5.0.json"): json.dumps(bad).encode()})
    with pytest.raises(rt.RevertError):
        rt.load_manifest(s3, cfg)


def test_load_manifest_tag_mismatch():
    cfg = rt.Config(env=base_env())
    m = good_manifest(); m["git_tag"] = "v9.9.9"
    s3 = FakeS3({("garden-snapshots-prod", "snapshots/v2.5.0.json"): json.dumps(m).encode()})
    with pytest.raises(rt.RevertError):
        rt.load_manifest(s3, cfg)


def test_load_manifest_ok():
    cfg = rt.Config(env=base_env())
    s3 = FakeS3({("garden-snapshots-prod", "snapshots/v2.5.0.json"): json.dumps(good_manifest()).encode()})
    m = rt.load_manifest(s3, cfg)
    assert m["main_sha"] == "a" * 40


def test_verify_tag_fail_closed(monkeypatch):
    cfg = rt.Config(env=base_env())
    fr = FakeRequests()
    # tag ref -> lightweight pointing at WRONG commit
    fr.add("GET", "/git/ref/tags/v2.5.0", FakeResp(200, {"object": {"sha": "b" * 40}}))
    fr.add("GET", "/git/tags/", FakeResp(404))  # not an annotated tag object
    monkeypatch.setattr(rt, "requests", fr)
    with pytest.raises(rt.RevertError):
        rt.verify_tag(cfg, good_manifest())


def test_verify_tag_ok_annotated(monkeypatch):
    cfg = rt.Config(env=base_env())
    fr = FakeRequests()
    fr.add("GET", "/git/ref/tags/v2.5.0", FakeResp(200, {"object": {"sha": "tagobj"}}))
    fr.add("GET", "/git/tags/tagobj", FakeResp(200, {"object": {"sha": "a" * 40}}))
    monkeypatch.setattr(rt, "requests", fr)
    assert rt.verify_tag(cfg, good_manifest()) == "a" * 40


# --- step 3: DB pieces -------------------------------------------------------

def test_fast_path_lsn_match(monkeypatch):
    cfg = rt.Config(env=base_env())
    fr = FakeRequests()
    fr.add("GET", "/branches", FakeResp(200, {"branches": [
        {"id": "br-snap", "name": "snap-v2.5.0", "current_state_lsn": "0/ABC"}]}))
    monkeypatch.setattr(rt, "requests", fr)
    b = rt.fast_path_branch(cfg, good_manifest())
    assert b["id"] == "br-snap"


def test_fast_path_lsn_drift_returns_none(monkeypatch):
    cfg = rt.Config(env=base_env())
    fr = FakeRequests()
    fr.add("GET", "/branches", FakeResp(200, {"branches": [
        {"id": "br-snap", "name": "snap-v2.5.0", "current_state_lsn": "0/DIFFERENT"}]}))
    monkeypatch.setattr(rt, "requests", fr)
    assert rt.fast_path_branch(cfg, good_manifest()) is None


def test_fast_path_absent_returns_none(monkeypatch):
    cfg = rt.Config(env=base_env())
    fr = FakeRequests()
    fr.add("GET", "/branches", FakeResp(200, {"branches": []}))
    monkeypatch.setattr(rt, "requests", fr)
    assert rt.fast_path_branch(cfg, good_manifest()) is None


def test_restore_dump_empty_fails(monkeypatch, tmp_path):
    cfg = rt.Config(env=base_env())
    s3 = FakeS3({("garden-snapshots-prod", "db/snap-v2.5.0.dump"): b""})
    with pytest.raises(rt.RevertError):
        rt.restore_dump_into_branch(s3, cfg, good_manifest(), "postgresql://stage")


def test_restore_dump_pg_restore_error(monkeypatch):
    cfg = rt.Config(env=base_env())
    s3 = FakeS3({("garden-snapshots-prod", "db/snap-v2.5.0.dump"): b"DUMP"})

    class P:
        returncode = 1
        stderr = "pg_restore: error: connection failed"
        stdout = ""
    monkeypatch.setattr(rt.subprocess, "run", lambda *a, **k: P())
    with pytest.raises(rt.RevertError):
        rt.restore_dump_into_branch(s3, cfg, good_manifest(), "postgresql://stage")


def test_restore_dump_tolerates_benign_warnings(monkeypatch):
    cfg = rt.Config(env=base_env())
    s3 = FakeS3({("garden-snapshots-prod", "db/snap-v2.5.0.dump"): b"DUMP"})

    class P:
        returncode = 1
        stderr = "pg_restore: warning: errors ignored on restore: 3"
        stdout = ""
    monkeypatch.setattr(rt.subprocess, "run", lambda *a, **k: P())
    # benign-warning tail with no "pg_restore: error:" -> no raise.
    # OPS-REVERTVALIDATE-001 changed the contract to (key, expected_counts); expected_counts is
    # None here because the stubbed pg_restore renders no archive, and None must mean UNKNOWN.
    key, expected = rt.restore_dump_into_branch(s3, cfg, good_manifest(), "postgresql://s")
    assert key == "db/snap-v2.5.0.dump"
    assert expected is None


def test_validate_branch_no_tables(monkeypatch):
    cfg = rt.Config(env=base_env())
    monkeypatch.setattr(rt, "_psql_scalar", lambda url, sql: "0")
    with pytest.raises(rt.RevertError):
        rt.validate_branch(cfg, "postgresql://s")


def test_validate_branch_ok(monkeypatch):
    cfg = rt.Config(env=base_env())
    def fake(url, sql):
        if "information_schema" in sql:
            return "25"
        return "10"
    monkeypatch.setattr(rt, "_psql_scalar", fake)
    out = rt.validate_branch(cfg, "postgresql://s")
    assert out["public_tables"] == 25


def test_neon_restore_prod_calls_prod_branch(monkeypatch):
    cfg = rt.Config(env=base_env())
    fr = FakeRequests()
    seen = {}
    def cap(url):
        seen["url"] = url
        return FakeResp(200, {"ok": True})
    fr.add("POST", "/branches/br-delicate-sea-amum92c2/restore", cap)
    monkeypatch.setattr(rt, "requests", fr)
    rt.neon_restore_prod_from(cfg, "br-source", "0/ABC")
    assert "br-delicate-sea-amum92c2/restore" in seen["url"]
    # U2: preserve_under_name is mandatory when the target branch has children
    assert fr.last_json.get("source_branch_id") == "br-source"
    assert fr.last_json.get("preserve_under_name", "").startswith("prerestore-")


# --- step 4: code + lambda ---------------------------------------------------

def test_create_revert_commit(monkeypatch):
    cfg = rt.Config(env=base_env())
    fr = FakeRequests()
    fr.add("GET", f"/git/commits/{'a'*40}", FakeResp(200, {"tree": {"sha": "treeX"}}))
    fr.add("GET", "/git/ref/heads/dev", FakeResp(200, {"object": {"sha": "devHEAD"}}))
    fr.add("POST", "/git/commits", FakeResp(201, {"sha": "newcommit"}))
    fr.add("PATCH", "/git/refs/heads/dev", FakeResp(200, {"object": {"sha": "newcommit"}}))
    monkeypatch.setattr(rt, "requests", fr)
    assert rt.create_revert_commit_on_dev(cfg, good_manifest()) == "newcommit"


def test_ff_main_failure_raises(monkeypatch):
    cfg = rt.Config(env=base_env())
    fr = FakeRequests()
    fr.add("PATCH", "/git/refs/heads/main", FakeResp(422, text="not fast forward"))
    monkeypatch.setattr(rt, "requests", fr)
    with pytest.raises(rt.RevertError):
        rt.ff_main(cfg, "z" * 40)


class FakeLambda:
    """U1-resolved mechanism: get_function(Qualifier) -> Code.Location, then
    update_function_code($LATEST), then get_function_configuration until the update
    settles. No aliases (Function URLs hit $LATEST).
    fail_update={fn}: update_function_code raises for those functions.
    settle={fn: [LastUpdateStatus, ...]}: status sequence per function (default Successful)."""
    def __init__(self, code_loc="https://s3/pkg.zip", fail_update=(), settle=None):
        self.calls = []
        self.code_loc = code_loc
        self.fail_update = set(fail_update)
        self.settle = {k: list(v) for k, v in (settle or {}).items()}

    def get_function(self, FunctionName, Qualifier=None):
        self.calls.append(("get", FunctionName, Qualifier))
        return {"Code": {"Location": self.code_loc}}

    def update_function_code(self, **k):
        self.calls.append(("update_code", k))
        if k["FunctionName"] in self.fail_update:
            from botocore.exceptions import ClientError
            raise ClientError({"Error": {"Code": "TooManyRequestsException",
                                         "Message": "Rate exceeded"}}, "UpdateFunctionCode")
        return {"Version": "99"}

    def get_function_configuration(self, FunctionName):
        seq = self.settle.get(FunctionName)
        status = seq.pop(0) if seq else "Successful"
        self.calls.append(("config", FunctionName, status))
        return {"LastUpdateStatus": status}

    def updated(self):
        return [c[1]["FunctionName"] for c in self.calls if c[0] == "update_code"]


def test_restore_lambda_pushes_code_to_latest(monkeypatch):
    cfg = rt.Config(env=base_env())
    lc = FakeLambda()
    fr = FakeRequests()
    fr.add("GET", "https://s3/pkg.zip", FakeResp(200, content=b"ZIPBYTES"))
    monkeypatch.setattr(rt, "requests", fr)
    out = rt.restore_lambda_versions(cfg, good_manifest(), lambda_client=lc)
    assert out == {"garden-plants": "7"}
    assert any(c[0] == "get" for c in lc.calls)
    assert any(c[0] == "update_code" for c in lc.calls)


def test_restore_lambda_download_failure_raises(monkeypatch):
    cfg = rt.Config(env=base_env())
    lc = FakeLambda()
    fr = FakeRequests()
    fr.add("GET", "https://s3/pkg.zip", FakeResp(403, content=b""))
    monkeypatch.setattr(rt, "requests", fr)
    with pytest.raises(rt.RevertError):
        rt.restore_lambda_versions(cfg, good_manifest(), lambda_client=lc)


# --- orchestration -----------------------------------------------------------

def test_run_data_loss_guard(monkeypatch):
    cfg = rt.Config(env=base_env(CONFIRM_DATA_LOSS="no"))
    s3 = FakeS3({("garden-snapshots-prod", "snapshots/v2.5.0.json"): json.dumps(good_manifest()).encode()})
    fr = FakeRequests()
    fr.add("GET", "/git/ref/tags/v2.5.0", FakeResp(200, {"object": {"sha": "tagobj"}}))
    fr.add("GET", "/git/tags/tagobj", FakeResp(200, {"object": {"sha": "a" * 40}}))
    monkeypatch.setattr(rt, "requests", fr)
    monkeypatch.setattr(rt, "compute_rpo", lambda cfg: {"total_live_rows": 5, "latest_event": "t"})
    with pytest.raises(rt.RevertError) as e:
        rt.run(cfg, s3=s3)
    assert "CONFIRM_DATA_LOSS" in str(e.value)


# --- OPS-REVERTRESTORE-001: the redeploy legs + a REAL rollback, end to end ----

RELEASE = rt.lambda_fleet.release_functions()
REVERT_SHA = "r" * 40
RESTORE_SHA = "s" * 40
CREATED = "2026-09-11T12:00:00Z"


def full_prerevert(**over):
    """A pre-revert snap that captured every release function — what rollback() needs."""
    man = {"neon_branch_id": "br-pre", "neon_lsn": "0/PRE", "main_sha": "m" * 40,
           "lambda_versions": {fn: "41" for fn in RELEASE}, "lambda_uncaptured": {}}
    man.update(over)
    return {"manifest": man}


class FakeActions:
    """Stateful GitHub Actions double for the redeploy legs. A dispatch creates a run that builds
    whatever main points at (a real workflow_dispatch on a branch does exactly that), runs expose
    jobs, and a cancel stops a run. `events` is shared with the world so tests can assert ORDER."""

    def __init__(self, fr, events, lambda_legs=None, spa_conclusions=("success",),
                 spa_completes=True, spa_job=True, run_sha=None, state="active",
                 env_rules=None, seed_runs=()):
        self.fr, self.events = fr, events
        self.main_sha = None
        self.dispatched, self.cancelled, self.runs = [], [], {}
        self.lambda_legs = lambda_legs
        self.spa_conclusions = list(spa_conclusions)
        self.spa_completes, self.spa_job, self.run_sha, self.state = spa_completes, spa_job, run_sha, state
        # the `production` environment's protection rules; live today = the branch policy only
        self.env_rules = [{"type": "branch_policy"}] if env_rules is None else env_rules
        # runs that exist before the revert starts (ids 900+): a promote in flight, a push run, ...
        for i, seed in enumerate(seed_runs):
            run = {"id": 900 + i, "event": "push", "head_branch": "main", "created_at": CREATED,
                   "status": "in_progress", "conclusion": None, "head_sha": "e" * 40}
            run.update(seed)
            self.runs[run["id"]] = run
        fr.add("POST", "/dispatches", self._dispatch)
        fr.add("POST", "/cancel", self._cancel)
        fr.add("GET", "/runs?", self._list)
        fr.add("GET", "/jobs?", self._jobs)
        fr.add("GET", "/actions/runs/", self._run)
        fr.add("GET", "/actions/workflows/", lambda url: FakeResp(200, {"state": self.state}))
        fr.add("GET", "/environments/production", lambda url: FakeResp(200, {"protection_rules": self.env_rules}))

    @staticmethod
    def _wf(url):
        return url.split("/actions/workflows/", 1)[1].split("/", 1)[0]

    @staticmethod
    def _id(url):
        return int(url.split("/actions/runs/", 1)[1].split("/", 1)[0].split("?", 1)[0])

    def ff(self, url):
        self.main_sha = self.fr.last_json["sha"]
        self.events.append(("ff_main", self.main_sha))
        return FakeResp(200, {"object": {"sha": self.main_sha}})

    def _dispatch(self, url):
        wf = self._wf(url)
        self.dispatched.append((wf, dict(self.fr.last_json)))
        self.events.append(("dispatch", wf, self.main_sha))
        rid = 99 + len(self.dispatched)
        run = {"id": rid, "workflow": wf, "head_sha": self.run_sha or self.main_sha,
               "event": "workflow_dispatch", "head_branch": "main",
               "created_at": CREATED, "status": "completed", "conclusion": "success"}
        if wf == "deploy.yml":
            run["conclusion"] = self.spa_conclusions.pop(0) if self.spa_conclusions else "success"
            if not self.spa_completes:
                run["status"], run["conclusion"] = "in_progress", None
                self.spa_completes = True  # only the FIRST (forward) SPA run hangs
        self.runs[rid] = run
        return FakeResp(204)

    def _list(self, url):
        """Honours the event= and branch= filters the way the Actions API does, so a query that
        filters by event really cannot see a push run."""
        wf = self._wf(url)
        q = dict(p.split("=", 1) for p in url.split("?", 1)[1].split("&") if "=" in p)
        runs = [dict(r) for r in self.runs.values() if r["workflow"] == wf
                and q.get("event", r.get("event")) == r.get("event")
                and q.get("branch", r.get("head_branch")) == r.get("head_branch")]
        return FakeResp(200, {"workflow_runs": runs})

    def _run(self, url):
        r = self.runs[self._id(url)]
        return FakeResp(200, {k: r.get(k) for k in ("id", "head_sha", "status", "conclusion")})

    def _jobs(self, url):
        r = self.runs[self._id(url)]
        if r["workflow"] == "deploy-lambda.yml":
            legs = self.lambda_legs if self.lambda_legs is not None else (
                [{"name": f"deploy ({f})", "status": "completed", "conclusion": "success"}
                 for f in ("plants", "events", "harvests")]
                # verify-daily-plan does NOT decide the revert, exactly as it does not hold the SPA
                + [{"name": "verify-daily-plan", "status": "completed", "conclusion": "failure"}])
            return FakeResp(200, {"jobs": legs})
        jobs = [{"name": "deploy", "status": r["status"], "conclusion": r["conclusion"]}] if self.spa_job else []
        return FakeResp(200, {"jobs": jobs})

    def _cancel(self, url):
        r = self.runs[self._id(url)]
        self.cancelled.append(r["id"])
        self.events.append(("cancel", r["id"]))
        r["status"], r["conclusion"] = "completed", "cancelled"
        return FakeResp(202)


def prod_world(monkeypatch, prerevert=None, **actions_kw):
    """Everything run() talks to, prod mode, fast path. -> (cfg, s3, fr, gh, events, lc)."""
    cfg = rt.Config(env=base_env())
    s3 = FakeS3({("garden-snapshots-prod", "snapshots/v2.5.0.json"): json.dumps(good_manifest()).encode()})
    fr = FakeRequests()
    events = []
    gh = FakeActions(fr, events, **actions_kw)
    fr.add("GET", "/git/ref/tags/v2.5.0", FakeResp(200, {"object": {"sha": "tagobj"}}))
    fr.add("GET", "/git/tags/tagobj", FakeResp(200, {"object": {"sha": "a" * 40}}))
    fr.add("GET", "/branches", FakeResp(200, {"branches": [
        {"id": "br-snap", "name": "snap-v2.5.0", "current_state_lsn": "0/ABC"}]}))

    def neon_restore(url):
        events.append(("neon_restore", fr.last_json["source_branch_id"]))
        return FakeResp(200, {"ok": True})
    fr.add("POST", "/restore", neon_restore)
    fr.add("GET", f"/git/commits/{'a' * 40}", FakeResp(200, {"tree": {"sha": "treeTARGET"}}))
    fr.add("GET", f"/git/commits/{'m' * 40}", FakeResp(200, {"tree": {"sha": "treePREREVERT"}}))
    fr.add("GET", "/git/ref/heads/dev", FakeResp(200, {"object": {"sha": "devHEAD"}}))
    shas = iter([REVERT_SHA, RESTORE_SHA])

    def commit(url):
        sha = next(shas)
        events.append(("commit", fr.last_json["tree"], sha))
        return FakeResp(201, {"sha": sha})
    fr.add("POST", "/git/commits", commit)
    fr.add("PATCH", "/git/refs/heads/dev", FakeResp(200, {}))
    fr.add("PATCH", "/git/refs/heads/main", gh.ff)
    fr.add("GET", "https://s3/pkg.zip", FakeResp(200, content=b"ZIP"))  # snapshot package download
    monkeypatch.setattr(rt, "requests", fr)
    monkeypatch.setattr(rt, "compute_rpo", lambda cfg: {"total_live_rows": 5, "latest_event": "t"})
    def snap(cfg):
        events.append(("snap",))  # a refusal that needs no snapshot must come before this
        return prerevert or full_prerevert()
    monkeypatch.setattr(rt, "prerevert_snap", snap)
    monkeypatch.setattr(rt, "_sleep", lambda s: None)
    monkeypatch.setattr(rt, "_now", lambda: rt._gh_time(CREATED))
    return cfg, s3, fr, gh, events, FakeLambda()


def test_run_happy_path_rebuilds_lambdas_then_spa_from_the_revert_commit(monkeypatch):
    cfg, s3, fr, gh, events, lc = prod_world(monkeypatch)
    out = rt.run(cfg, s3=s3, lambda_client=lc)
    assert out["reverted_to"] == "v2.5.0"
    assert out["revert_commit"] == REVERT_SHA
    # Lambdas first, SPA second, both dispatched on main only AFTER main points at the revert commit
    assert [(e[1], e[2]) for e in events if e[0] == "dispatch"] == [
        ("deploy-lambda.yml", REVERT_SHA), ("deploy.yml", REVERT_SHA)]
    assert events.index(("ff_main", REVERT_SHA)) < events.index(("dispatch", "deploy-lambda.yml", REVERT_SHA))
    assert [body for _, body in gh.dispatched] == [
        {"ref": "main"}, {"ref": "main", "inputs": {"skip_version_bump": "true"}}]
    assert (out["lambda_run"], out["spa_run"]) == (100, 101)
    # the forward leg rebuilds the target from its tree; it never restores snapshot versions
    assert lc.updated() == []
    assert [e for e in events if e[0] == "neon_restore"] == [("neon_restore", "br-snap")]
    assert gh.cancelled == []
    # fast path used -> no revert-stage branch creation POST /branches
    assert not any(m == "POST" and url.endswith("/branches") for m, url in fr.calls)


def test_run_aborts_and_rolls_back(monkeypatch):
    """A failure AFTER the prod-DB checkpoint must trigger rollback() (the orchestration contract;
    the REAL rollback is executed by the test_real_rollback_* tests below)."""
    cfg, s3, fr, gh, events, lc = prod_world(monkeypatch)
    fr.routes.insert(0, ("PATCH", "/git/refs/heads/main", FakeResp(422, text="boom")))  # main FF FAILS
    rollback_called = {"n": 0}

    def spy(cfg2, pre, lambda_client=None, progress=None):
        rollback_called["n"] += 1
    monkeypatch.setattr(rt, "rollback", spy)
    with pytest.raises(rt.RevertError) as e:
        rt.run(cfg, s3=s3, lambda_client=lc)
    assert rollback_called["n"] == 1
    assert "rolled back" in str(e.value)
    assert gh.dispatched == []  # nothing redeploys once the code leg has failed


def test_run_failure_before_checkpoint_no_rollback(monkeypatch):
    """A failure BEFORE the prod-DB checkpoint must NOT roll back (nothing mutated)."""
    cfg, s3, fr, gh, events, lc = prod_world(monkeypatch)
    fr.routes.insert(0, ("GET", "/branches", FakeResp(500, text="neon down")))
    rolled = {"n": 0}
    monkeypatch.setattr(rt, "rollback", lambda *a, **k: rolled.__setitem__("n", rolled["n"] + 1))
    with pytest.raises(rt.RevertError, match="Neon list branches failed 500"):
        rt.run(cfg, s3=s3)
    assert rolled["n"] == 0
    assert not [e for e in events if e[0] == "neon_restore"]


def test_real_rollback_after_a_failed_lambda_leg(monkeypatch):
    """L1 Gap D: rollback() had never executed anywhere. The REAL rollback runs here, against
    fakes: DB back to the pre-revert branch, a forward restore-commit carrying the pre-revert
    tree, main FF'd to it, every release function back to its PRE-REVERT version — and no SPA
    dispatch at all, because the SPA leg never started."""
    legs = [{"name": "deploy (plants)", "status": "completed", "conclusion": "failure"},
            {"name": "deploy (events)", "status": "completed", "conclusion": "success"}]
    cfg, s3, fr, gh, events, lc = prod_world(monkeypatch, lambda_legs=legs)
    with pytest.raises(rt.RevertError) as e:
        rt.run(cfg, s3=s3, lambda_client=lc)
    msg = str(e.value)
    assert "rolled back to pre-revert snap" in msg
    assert "'deploy (plants)': 'failure'" in msg and "DID move to the target code: ['deploy (events)']" in msg
    assert [e[1] for e in events if e[0] == "neon_restore"] == ["br-snap", "br-pre"]
    assert [(e[1], e[2]) for e in events if e[0] == "commit"] == [
        ("treeTARGET", REVERT_SHA), ("treePREREVERT", RESTORE_SHA)]
    assert [e[1] for e in events if e[0] == "ff_main"] == [REVERT_SHA, RESTORE_SHA]
    assert lc.updated() == sorted(RELEASE)
    assert {c[2] for c in lc.calls if c[0] == "get"} == {"41"}  # the PRE-REVERT versions, qualified
    assert [wf for wf, _ in gh.dispatched] == ["deploy-lambda.yml"]  # SPA held back, never started


def test_real_rollback_after_a_failed_spa_leg_rebuilds_the_restored_tree(monkeypatch):
    cfg, s3, fr, gh, events, lc = prod_world(monkeypatch, spa_conclusions=("failure", "success"))
    # name the REASON: the job-level check would also fail this run, so a looser match would let
    # the run-conclusion check be deleted with the suite still green
    with pytest.raises(rt.RevertError,
                       match=r"rolled back to pre-revert snap: SPA redeploy run 101 concluded 'failure'"):
        rt.run(cfg, s3=s3, lambda_client=lc)
    assert [(e[1], e[2]) for e in events if e[0] == "dispatch"] == [
        ("deploy-lambda.yml", REVERT_SHA), ("deploy.yml", REVERT_SHA), ("deploy.yml", RESTORE_SHA)]
    assert lc.updated() == sorted(RELEASE)
    # the rollback's SPA rebuild is dispatched only once main is back on the restore commit
    assert events.index(("ff_main", RESTORE_SHA)) < events.index(("dispatch", "deploy.yml", RESTORE_SHA))


def test_a_run_built_from_another_commit_is_never_accepted(monkeypatch):
    """A dispatch names a branch. If main moved, the run builds someone else's commit: that must
    fail the leg and roll back, never count as the revert's deploy."""
    cfg, s3, fr, gh, events, lc = prod_world(monkeypatch, run_sha="f" * 40)
    with pytest.raises(rt.RevertError) as e:
        rt.run(cfg, s3=s3, lambda_client=lc)
    assert "main moved" in str(e.value) and "rolled back" in str(e.value)
    assert [wf for wf, _ in gh.dispatched] == ["deploy-lambda.yml"]


def test_zero_lambda_legs_is_a_failure_not_a_pass(monkeypatch):
    cfg, s3, fr, gh, events, lc = prod_world(monkeypatch, lambda_legs=[])
    with pytest.raises(rt.RevertError, match="NO deploy legs"):
        rt.run(cfg, s3=s3, lambda_client=lc)
    assert [wf for wf, _ in gh.dispatched] == ["deploy-lambda.yml"]


def test_green_spa_run_without_a_deploy_job_is_a_failure(monkeypatch):
    cfg, s3, fr, gh, events, lc = prod_world(monkeypatch, spa_job=False)
    with pytest.raises(rt.RevertError, match="no successful 'deploy' job"):
        rt.run(cfg, s3=s3, lambda_client=lc)


def test_rollback_cancels_a_forward_deploy_still_in_flight_first(monkeypatch):
    """A forward SPA run that outlives the poll must be stopped BEFORE the rollback starts, or it
    could land on top of the restored prod."""
    cfg, s3, fr, gh, events, lc = prod_world(monkeypatch, spa_completes=False)
    with pytest.raises(rt.RevertError, match="rolled back to pre-revert snap"):
        rt.run(cfg, s3=s3, lambda_client=lc)
    assert gh.cancelled == [101]
    assert events.index(("cancel", 101)) < events.index(("neon_restore", "br-pre"))
    assert ("dispatch", "deploy.yml", RESTORE_SHA) in events


def test_rollback_that_cannot_restore_every_function_pages_dave_and_names_them(monkeypatch):
    legs = [{"name": "deploy (plants)", "status": "completed", "conclusion": "failure"}]
    cfg, s3, fr, gh, events, _ = prod_world(monkeypatch, lambda_legs=legs)
    lc = FakeLambda(fail_update={"garden-events"})
    with pytest.raises(rt.RevertError) as e:
        rt.run(cfg, s3=s3, lambda_client=lc)
    msg = str(e.value)
    assert "AND rollback FAILED" in msg and "PAGE DAVE" in msg
    assert f"{len(RELEASE) - 1}/{len(RELEASE)} restored" in msg
    assert "NOT restored: garden-events@41" in msg
    assert lc.updated() == sorted(RELEASE)  # every OTHER function was still attempted


def test_revert_refuses_before_touching_prod_if_the_prerevert_snap_missed_a_function(monkeypatch):
    pre = full_prerevert()
    pre["manifest"]["lambda_versions"].pop("garden-harvests")
    pre["manifest"]["lambda_uncaptured"] = {"garden-harvests": "AccessDeniedException: not authorized"}
    cfg, s3, fr, gh, events, lc = prod_world(monkeypatch, prerevert=pre)
    rolled = {"n": 0}
    monkeypatch.setattr(rt, "rollback", lambda *a, **k: rolled.__setitem__("n", 1))
    with pytest.raises(rt.RevertError, match="garden-harvests"):
        rt.run(cfg, s3=s3, lambda_client=lc)
    assert not [e for e in events if e[0] in ("neon_restore", "commit", "dispatch")]
    assert rolled["n"] == 0


def test_a_function_that_does_not_exist_yet_does_not_block_the_revert(monkeypatch):
    pre = full_prerevert()
    pre["manifest"]["lambda_versions"].pop("garden-harvests")
    pre["manifest"]["lambda_uncaptured"] = {"garden-harvests": "ResourceNotFoundException: Function not found"}
    cfg, s3, fr, gh, events, lc = prod_world(monkeypatch, prerevert=pre)
    assert rt.run(cfg, s3=s3, lambda_client=lc)["spa_run"] == 101


def test_legacy_prerevert_manifest_is_judged_against_the_release_set(monkeypatch):
    """A pre-revert snap from an older snap.py (no lambda_uncaptured) holding the old 11 must not
    pass for complete."""
    old11 = ["garden-dashboard", "garden-events", "garden-favorites", "garden-inventory-items",
             "garden-locations", "garden-photos", "garden-plants", "garden-projects",
             "garden-varieties", "garden-app-events", "garden-achievements"]
    pre = {"manifest": {"neon_branch_id": "br-pre", "neon_lsn": "0/PRE", "main_sha": "m" * 40,
                        "lambda_versions": {fn: "7" for fn in old11}}}
    cfg, s3, fr, gh, events, lc = prod_world(monkeypatch, prerevert=pre)
    with pytest.raises(rt.RevertError, match="garden-harvests"):
        rt.run(cfg, s3=s3, lambda_client=lc)
    assert not [e for e in events if e[0] == "neon_restore"]


def test_a_disabled_redeploy_workflow_refuses_before_touching_prod(monkeypatch):
    cfg, s3, fr, gh, events, lc = prod_world(monkeypatch, state="disabled_manually")
    with pytest.raises(rt.RevertError, match="not 'active'"):
        rt.run(cfg, s3=s3, lambda_client=lc)
    assert not [e for e in events if e[0] in ("neon_restore", "dispatch")]


def test_dispatch_refuses_rehearsal_and_any_ref_but_main(monkeypatch):
    fr = FakeRequests()
    monkeypatch.setattr(rt, "requests", fr)
    with pytest.raises(rt.RevertError, match="it deploys prod"):
        rt.dispatch_workflow(rt.Config(env=reh_env()), "deploy.yml")
    cfg = rt.Config(env=base_env())
    cfg.main_branch = "revert-rehearsal-main-1"
    with pytest.raises(rt.RevertError, match="it deploys prod"):
        rt.dispatch_workflow(cfg, "deploy.yml")
    assert fr.calls == []


def test_dispatch_that_is_not_accepted_is_a_failure(monkeypatch):
    fr = FakeRequests()
    fr.add("POST", "/dispatches", FakeResp(422, text="Unexpected inputs provided"))
    monkeypatch.setattr(rt, "requests", fr)
    with pytest.raises(rt.RevertError, match="failed 422"):
        rt.dispatch_workflow(rt.Config(env=base_env()), "deploy.yml", inputs={"skip_version_bump": "true"})


def test_restore_keeps_going_past_a_failed_function_and_names_exactly_what_moved(monkeypatch):
    """L1 Gap E: a mid-loop failure used to raise at once and discard which functions had moved."""
    cfg = rt.Config(env=base_env())
    fr = FakeRequests()
    fr.add("GET", "https://s3/pkg.zip", FakeResp(200, content=b"ZIP"))
    monkeypatch.setattr(rt, "requests", fr)
    lc = FakeLambda(fail_update={"garden-events"})
    man = {"lambda_versions": {"garden-plants": "7", "garden-events": "8", "garden-dashboard": "9"}}
    with pytest.raises(rt.RevertError) as e:
        rt.restore_lambda_versions(cfg, man, lambda_client=lc)
    msg = str(e.value)
    assert lc.updated() == ["garden-dashboard", "garden-events", "garden-plants"]
    assert "2/3 restored [garden-dashboard, garden-plants]" in msg
    assert "NOT restored: garden-events@8:" in msg


def test_restore_waits_for_the_update_to_settle_and_rejects_failed(monkeypatch):
    cfg = rt.Config(env=base_env())
    fr = FakeRequests()
    fr.add("GET", "https://s3/pkg.zip", FakeResp(200, content=b"ZIP"))
    monkeypatch.setattr(rt, "requests", fr)
    monkeypatch.setattr(rt, "_sleep", lambda s: None)
    lc = FakeLambda(settle={"garden-plants": ["InProgress", "Failed"]})
    with pytest.raises(rt.RevertError, match="garden-plants ended 'Failed'"):
        rt.restore_lambda_versions(cfg, {"lambda_versions": {"garden-plants": "7"}}, lambda_client=lc)
    assert [c for c in lc.calls if c[0] == "config"] == [
        ("config", "garden-plants", "InProgress"), ("config", "garden-plants", "Failed")]


def test_restore_waits_through_in_progress_to_successful(monkeypatch):
    cfg = rt.Config(env=base_env())
    fr = FakeRequests()
    fr.add("GET", "https://s3/pkg.zip", FakeResp(200, content=b"ZIP"))
    monkeypatch.setattr(rt, "requests", fr)
    monkeypatch.setattr(rt, "_sleep", lambda s: None)
    lc = FakeLambda(settle={"garden-plants": ["InProgress", "InProgress", "Successful"]})
    assert rt.restore_lambda_versions(
        cfg, {"lambda_versions": {"garden-plants": "7"}}, lambda_client=lc) == {"garden-plants": "7"}
    assert len([c for c in lc.calls if c[0] == "config"]) == 3


# --- R2 items 4 + 5: every refusal that needs no snapshot comes before it -----------------------

def _refused_before_the_snap(events, gh):
    assert ("snap",) not in events
    assert not [e for e in events if e[0] in ("neon_restore", "commit", "ff_main", "dispatch")]
    assert gh.dispatched == [] and gh.cancelled == []


def test_a_disabled_workflow_is_refused_before_the_prerevert_snap(monkeypatch):
    """A refusal after the snap strands a permanent PREREVERT tag, a Neon branch, a dump and up to
    26 published versions, and the retry needs a fresh PREREVERT_VERSION."""
    cfg, s3, fr, gh, events, lc = prod_world(monkeypatch, state="disabled_manually")
    with pytest.raises(rt.RevertError, match="'disabled_manually', not 'active'"):
        rt.run(cfg, s3=s3, lambda_client=lc)
    _refused_before_the_snap(events, gh)


@pytest.mark.parametrize("rule, named", [
    ({"type": "required_reviewers", "reviewers": [{"type": "User"}]}, "required_reviewers"),
    ({"type": "wait_timer", "wait_timer": 5}, "wait_timer 5"),
    ({"type": "custom"}, "custom"),  # any rule but the branch policy can hold a run
])
def test_a_production_environment_that_holds_runs_is_refused_before_the_snap(monkeypatch, rule, named):
    cfg, s3, fr, gh, events, lc = prod_world(monkeypatch, env_rules=[{"type": "branch_policy"}, rule])
    with pytest.raises(rt.RevertError, match=rf"holds runs \({named}\)"):
        rt.run(cfg, s3=s3, lambda_client=lc)
    _refused_before_the_snap(events, gh)


def test_a_zero_wait_timer_and_the_branch_policy_do_not_hold_runs(monkeypatch):
    cfg, s3, fr, gh, events, lc = prod_world(
        monkeypatch, env_rules=[{"type": "branch_policy"}, {"type": "wait_timer", "wait_timer": 0}])
    assert rt.run(cfg, s3=s3, lambda_client=lc)["spa_run"] == 101


def test_an_unreadable_production_environment_is_refused_before_the_snap(monkeypatch):
    cfg, s3, fr, gh, events, lc = prod_world(monkeypatch)
    fr.routes.insert(0, ("GET", "/environments/production", FakeResp(404, text="Not Found")))
    with pytest.raises(rt.RevertError, match="cannot read the production environment"):
        rt.run(cfg, s3=s3, lambda_client=lc)
    _refused_before_the_snap(events, gh)


@pytest.mark.parametrize("seed", [
    {"workflow": "promote-gate.yml", "event": "workflow_dispatch", "status": "in_progress"},
    {"workflow": "deploy-lambda.yml", "event": "push", "status": "queued"},
    {"workflow": "deploy.yml", "event": "workflow_dispatch", "status": "waiting", "head_branch": "dev"},
])
def test_a_promote_or_deploy_in_flight_is_refused_before_the_snap(monkeypatch, seed):
    """QA "assumption surfacing": the pre-revert snap is what prod runs only if nothing is
    mid-deploy. Any event, any branch — a push-event run and a dev-branch run count too."""
    cfg, s3, fr, gh, events, lc = prod_world(monkeypatch, seed_runs=[seed])
    with pytest.raises(rt.RevertError,
                       match=rf"in flight: {seed['workflow']} run 900 \({seed['event']}, {seed['status']}"):
        rt.run(cfg, s3=s3, lambda_client=lc)
    _refused_before_the_snap(events, gh)


def test_finished_runs_do_not_block_a_revert(monkeypatch):
    done = [{"workflow": wf, "status": "completed", "conclusion": c} for wf, c in (
        ("promote-gate.yml", "success"), ("deploy-lambda.yml", "failure"), ("deploy.yml", "cancelled"))]
    cfg, s3, fr, gh, events, lc = prod_world(monkeypatch, seed_runs=done)
    assert rt.run(cfg, s3=s3, lambda_client=lc)["spa_run"] == 101


def test_a_run_list_that_cannot_be_read_is_refused_before_the_snap(monkeypatch):
    cfg, s3, fr, gh, events, lc = prod_world(monkeypatch)
    fr.routes.insert(0, ("GET", "promote-gate.yml/runs?", FakeResp(502, text="Bad Gateway")))
    with pytest.raises(rt.RevertError, match="cannot list promote-gate.yml runs"):
        rt.run(cfg, s3=s3, lambda_client=lc)
    _refused_before_the_snap(events, gh)


# --- R2 item 1: a rollback that survives GitHub being unreachable ------------------------------

def test_rollback_still_restores_the_db_when_github_is_unreachable(monkeypatch):
    """QA probe 1 (review-R-qa-evidence/probe_rollback.py), committed with its assertion inverted.
    The forward SPA leg fails, then every GitHub read the rollback makes raises ConnectionError, as
    a GitHub incident would. Before R2 the first of them escaped rollback() and skipped the DB
    restore, the code restore and every Lambda. The DB restore must run whatever GitHub does."""
    cfg, s3, fr, gh, events, lc = prod_world(monkeypatch, spa_conclusions=("failure", "success"))
    n = {"list": 0}

    def flaky_list(url):
        n["list"] += 1
        if n["list"] >= 3:  # 1 = locate Lambda run, 2 = locate SPA run, 3+ = the rollback's reads
            raise real_requests.ConnectionError("github unreachable")
        return gh._list(url)
    fr.routes.insert(0, ("GET", "/runs?event=workflow_dispatch", flaky_list))
    with pytest.raises(rt.RevertError) as e:
        rt.run(cfg, s3=s3, lambda_client=lc)
    msg = str(e.value)
    assert ("neon_restore", "br-pre") in events
    assert "PAGE DAVE" in msg and "could not list deploy-lambda.yml runs" in msg
    assert lc.updated() == sorted(RELEASE)  # the rest of the compensation ran too


def test_rollback_step_one_failure_of_any_kind_does_not_skip_the_db_restore(monkeypatch):
    """The transport catch is one guard; rollback() also wraps step 1 whole, so an answer of an
    unexpected shape (a run with no id) cannot skip the DB restore either."""
    cfg, s3, fr, gh, events, lc = prod_world(monkeypatch, spa_conclusions=("failure", "success"))
    n = {"list": 0}

    def malformed_after_forward(url):
        n["list"] += 1
        if n["list"] >= 3:
            return FakeResp(200, {"workflow_runs": [{"head_sha": REVERT_SHA, "status": "in_progress"}]})
        return gh._list(url)
    fr.routes.insert(0, ("GET", "/runs?event=workflow_dispatch", malformed_after_forward))
    with pytest.raises(rt.RevertError) as e:
        rt.run(cfg, s3=s3, lambda_client=lc)
    assert ("neon_restore", "br-pre") in events
    assert "could not stop stray forward runs: KeyError" in str(e.value)


def test_a_github_read_retries_a_transport_blip_then_succeeds(monkeypatch):
    fr = FakeRequests()
    n = {"n": 0}

    def blip(url):
        n["n"] += 1
        if n["n"] == 1:
            raise real_requests.ReadTimeout("read timed out")
        return FakeResp(200, {"workflow_runs": [{"id": 7}]})
    fr.add("GET", "/runs?", blip)
    monkeypatch.setattr(rt, "requests", fr)
    monkeypatch.setattr(rt, "_sleep", lambda s: None)
    assert rt._list_runs(rt.Config(env=base_env()), "deploy.yml") == [{"id": 7}]
    assert n["n"] == 2


def test_github_reads_turn_transport_errors_and_non_json_into_none_after_bounded_retries(monkeypatch):
    fr = FakeRequests()
    n = {"n": 0}

    def down(url):
        n["n"] += 1
        raise real_requests.ConnectionError("connection refused")
    fr.add("GET", "/actions/runs/", down)
    fr.add("GET", "/runs?", FakeResp(200, bad_json=True))
    monkeypatch.setattr(rt, "requests", fr)
    monkeypatch.setattr(rt, "_sleep", lambda s: None)
    cfg = rt.Config(env=base_env())
    assert rt._get_run(cfg, 5) is None
    assert n["n"] == rt.GH_READ_ATTEMPTS  # bounded: never an endless retry
    assert rt._get_jobs(cfg, 5) is None
    assert rt._list_runs(cfg, "deploy.yml") is None


def test_a_cancel_that_cannot_reach_github_is_reported_and_the_rest_still_run(monkeypatch):
    fr = FakeRequests()
    runs = {"deploy-lambda.yml": [{"id": 1, "head_sha": REVERT_SHA, "status": "in_progress"}],
            "deploy.yml": [{"id": 2, "head_sha": REVERT_SHA, "status": "in_progress"}]}
    fr.add("GET", "/runs?", lambda url: FakeResp(200, {"workflow_runs": runs[FakeActions._wf(url)]}))

    def cancel(url):
        if "/runs/1/" in url:
            raise real_requests.ConnectionError("connection reset")
        runs["deploy.yml"][0]["status"] = "completed"
        return FakeResp(202)
    fr.add("POST", "/cancel", cancel)
    fr.add("GET", "/actions/runs/2", lambda url: FakeResp(200, runs["deploy.yml"][0]))
    monkeypatch.setattr(rt, "requests", fr)
    monkeypatch.setattr(rt, "_sleep", lambda s: None)
    problems = rt.cancel_stray_runs(rt.Config(env=base_env()), REVERT_SHA)
    assert problems == [f"cancel deploy-lambda.yml run 1 for {REVERT_SHA}: GitHub unreachable"]
    assert ("POST", f"{rt.GITHUB_API}/repos/islanddave/garden-app/actions/runs/2/cancel") in fr.calls


def test_a_rollback_whose_db_restore_fails_stops_before_moving_any_code(monkeypatch):
    """rollback()'s docstring: if the DB restore fails, raise at once — moving the code back on a
    DB still at vX makes things worse. What step 1 found is kept in the page."""
    legs = [{"name": "deploy (plants)", "status": "completed", "conclusion": "failure"}]
    cfg, s3, fr, gh, events, lc = prod_world(monkeypatch, lambda_legs=legs)

    def neon(url):
        src = fr.last_json["source_branch_id"]
        events.append(("neon_restore", src))
        return FakeResp(200, {"ok": True}) if src == "br-snap" else FakeResp(500, text="neon down")
    fr.routes.insert(0, ("POST", "/restore", neon))
    with pytest.raises(rt.RevertError) as e:
        rt.run(cfg, s3=s3, lambda_client=lc)
    msg = str(e.value)
    assert "PAGE DAVE" in msg and "DB NOT restored" in msg and "neon down" in msg
    assert [ev[2] for ev in events if ev[0] == "commit"] == [REVERT_SHA]  # no restore commit
    assert [ev[1] for ev in events if ev[0] == "ff_main"] == [REVERT_SHA]
    assert lc.updated() == []
    assert [wf for wf, _ in gh.dispatched] == ["deploy-lambda.yml"]


@pytest.mark.parametrize("loop", ["locate", "lambda_legs", "spa", "cancel", "lambda_settle"])
def test_every_poll_loop_also_stops_on_the_wall_clock(monkeypatch, loop):
    """A sleep count leaves each call's own latency (up to HTTP_TIMEOUT) outside revert-gate.yml's
    budget. With a clock that jumps past every ceiling, each loop must give up after at most one
    poll per run — not after the 9 to 81 polls its sleep count alone would allow."""
    cfg = rt.Config(env=base_env())
    fr = FakeRequests()
    stuck = {"id": 9, "head_sha": REVERT_SHA, "status": "in_progress", "conclusion": None,
             "created_at": CREATED}
    fr.add("GET", "/runs?", FakeResp(200, {"workflow_runs": [stuck]}))
    fr.add("GET", "/jobs?", FakeResp(200, {"jobs": [{"name": "deploy (plants)", "status": "in_progress"}]}))
    fr.add("GET", "/actions/runs/", FakeResp(200, stuck))
    fr.add("POST", "/cancel", FakeResp(202))
    monkeypatch.setattr(rt, "requests", fr)
    monkeypatch.setattr(rt, "_sleep", lambda s: None)
    clock = {"t": 0.0}

    def jump():
        clock["t"] += 10 ** 6
        return clock["t"]
    monkeypatch.setattr(rt, "_monotonic", jump)
    gets = lambda sub: len([c for c in fr.calls if c[0] == "GET" and sub in c[1]])
    if loop == "locate":
        with pytest.raises(rt.RevertError, match="appeared after the dispatch"):
            rt.locate_run(cfg, "deploy.yml", RESTORE_SHA, rt._gh_time(CREATED))
        assert gets("/runs?") <= 1
    elif loop == "lambda_legs":
        with pytest.raises(rt.RevertError, match="unfinished"):
            rt.wait_for_lambda_legs(cfg, 9)
        assert gets("/jobs?") <= 1
    elif loop == "spa":
        with pytest.raises(rt.RevertError, match="unfinished"):
            rt.wait_for_spa_run(cfg, 9)
        assert gets("/actions/runs/9") <= 1
    elif loop == "cancel":
        problems = rt.cancel_stray_runs(cfg, REVERT_SHA)
        assert len(problems) == 2 and all("still running" in p for p in problems)
        assert gets("/actions/runs/9") == 2  # one look per cancelled run
    else:
        lc = FakeLambda(settle={"garden-plants": ["InProgress"] * 100})
        assert rt._wait_lambda_updated(lc, "garden-plants") == "InProgress"
        assert len([c for c in lc.calls if c[0] == "config"]) == 1


def test_main_exit_code_on_error(monkeypatch):
    monkeypatch.setattr(rt, "Config", lambda: (_ for _ in ()).throw(rt.RevertError("x")))
    assert rt.main() == 1


# --- REHEARSAL_MODE: safety guard -------------------------------------------

def reh_env(**over):
    env = base_env(
        REHEARSAL_MODE="1",
        DEV_BRANCH="revert-rehearsal-dev-1",
        MAIN_BRANCH="revert-rehearsal-main-1",
        NEON_PROD_BRANCH_ID="br-polished-art-am12o4ue",
    )
    env.update(over)
    return env


def test_guard_off_ok_defaults():
    rt.rehearsal_guard(rt.Config(env=base_env()))  # dev/main defaults -> no raise


def test_guard_off_rejects_branch_override():
    cfg = rt.Config(env=base_env(DEV_BRANCH="revert-rehearsal-dev-1"))
    with pytest.raises(rt.RevertError):
        rt.rehearsal_guard(cfg)


def test_guard_on_ok():
    rt.rehearsal_guard(rt.Config(env=reh_env()))  # no raise


def test_guard_on_rejects_dev_main_refs():
    with pytest.raises(rt.RevertError):
        rt.rehearsal_guard(rt.Config(env=reh_env(DEV_BRANCH="dev", MAIN_BRANCH="main")))


def test_guard_on_rejects_non_prefix():
    with pytest.raises(rt.RevertError):
        rt.rehearsal_guard(rt.Config(env=reh_env(DEV_BRANCH="hotfix-x")))


def test_guard_on_rejects_equal_branches():
    with pytest.raises(rt.RevertError):
        rt.rehearsal_guard(rt.Config(env=reh_env(MAIN_BRANCH="revert-rehearsal-dev-1")))


def test_guard_on_rejects_prod_neon():
    with pytest.raises(rt.RevertError):
        rt.rehearsal_guard(rt.Config(env=reh_env(NEON_PROD_BRANCH_ID="br-delicate-sea-amum92c2")))


# --- REHEARSAL_MODE: leg redirection ----------------------------------------

def test_create_revert_commit_uses_rehearsal_dev(monkeypatch):
    cfg = rt.Config(env=reh_env())
    fr = FakeRequests()
    fr.add("GET", f"/git/commits/{'a'*40}", FakeResp(200, {"tree": {"sha": "treeX"}}))
    fr.add("GET", "/git/ref/heads/revert-rehearsal-dev-1", FakeResp(200, {"object": {"sha": "rdev"}}))
    fr.add("POST", "/git/commits", FakeResp(201, {"sha": "newc"}))
    fr.add("PATCH", "/git/refs/heads/revert-rehearsal-dev-1", FakeResp(200, {"object": {"sha": "newc"}}))
    monkeypatch.setattr(rt, "requests", fr)
    assert rt.create_revert_commit_on_dev(cfg, good_manifest()) == "newc"
    assert any(m == "PATCH" and "revert-rehearsal-dev-1" in u for m, u in fr.calls)
    assert not any("heads/dev" in u and "rehearsal" not in u for m, u in fr.calls)


def test_ff_main_uses_rehearsal_main(monkeypatch):
    cfg = rt.Config(env=reh_env())
    fr = FakeRequests()
    fr.add("PATCH", "/git/refs/heads/revert-rehearsal-main-1", FakeResp(200, {"object": {"sha": "x"}}))
    monkeypatch.setattr(rt, "requests", fr)
    rt.ff_main(cfg, "z" * 40)
    assert any("revert-rehearsal-main-1" in u for m, u in fr.calls)


def test_lambda_skipped_in_rehearsal():
    cfg = rt.Config(env=reh_env())
    lc = FakeLambda()
    assert rt.restore_lambda_versions(cfg, good_manifest(), lambda_client=lc) == {}
    assert lc.calls == []


def test_redeploy_legs_skipped_in_rehearsal(monkeypatch):
    """Both redeploy workflows deploy PROD; a rehearsal must never dispatch either one."""
    cfg = rt.Config(env=reh_env())
    fr = FakeRequests()
    monkeypatch.setattr(rt, "requests", fr)
    progress = {}
    assert rt.redeploy_lambdas(cfg, REVERT_SHA, progress) is None
    assert rt.redeploy_spa(cfg, REVERT_SHA, progress) is None
    assert fr.calls == [] and progress == {}


# --- REHEARSAL_MODE: full run paths -----------------------------------------

def test_run_rejects_override_without_rehearsal(monkeypatch):
    cfg = rt.Config(env=base_env(DEV_BRANCH="revert-rehearsal-dev-1"))
    s3 = FakeS3({("garden-snapshots-prod", "snapshots/v2.5.0.json"): json.dumps(good_manifest()).encode()})
    with pytest.raises(rt.RevertError) as e:
        rt.run(cfg, s3=s3)
    assert "REHEARSAL_MODE" in str(e.value)


def test_run_rehearsal_dump_path(monkeypatch):
    """Rehearsal + FORCE_DUMP_PATH: fresh-branch+restore+validate, DB reset to
    the STAGING branch, code legs to rehearsal refs, Lambda/CF untouched."""
    cfg = rt.Config(env=reh_env(FORCE_DUMP_PATH="1"))
    s3 = FakeS3({
        ("garden-snapshots-prod", "snapshots/v2.5.0.json"): json.dumps(good_manifest()).encode(),
        ("garden-snapshots-prod", "db/snap-v2.5.0.dump"): b"DUMP",
    })
    fr = FakeRequests()
    fr.add("GET", "/git/ref/tags/v2.5.0", FakeResp(200, {"object": {"sha": "tagobj"}}))
    fr.add("GET", "/git/tags/tagobj", FakeResp(200, {"object": {"sha": "a" * 40}}))
    fr.add("GET", "/branches", FakeResp(200, {"branches": []}))
    fr.add("POST", "/restore", FakeResp(200, {"ok": True}))
    fr.add("POST", "/branches", FakeResp(201, {"branch": {"id": "br-stage"},
           "connection_uris": [{"connection_uri": "postgresql://stage"}]}))
    fr.add("GET", f"/git/commits/{'a'*40}", FakeResp(200, {"tree": {"sha": "treeX"}}))
    fr.add("GET", "/git/ref/heads/revert-rehearsal-dev-1", FakeResp(200, {"object": {"sha": "rdev"}}))
    fr.add("POST", "/git/commits", FakeResp(201, {"sha": "revc"}))
    fr.add("PATCH", "/git/refs/heads/revert-rehearsal-dev-1", FakeResp(200, {"object": {"sha": "revc"}}))
    fr.add("PATCH", "/git/refs/heads/revert-rehearsal-main-1", FakeResp(200, {"object": {"sha": "revc"}}))
    monkeypatch.setattr(rt, "requests", fr)
    monkeypatch.setattr(rt, "compute_rpo", lambda cfg: {"total_live_rows": 5, "latest_event": "t"})
    monkeypatch.setattr(rt, "prerevert_snap", lambda cfg: {"manifest": {
        "neon_branch_id": "br-pre", "neon_lsn": "0/PRE", "main_sha": "m" * 40, "lambda_versions": {}}})

    class P:
        returncode = 0
        stderr = ""
        stdout = ""
    monkeypatch.setattr(rt.subprocess, "run", lambda *a, **k: P())
    monkeypatch.setattr(rt, "_psql_scalar", lambda url, sql: "25" if "information_schema" in sql else "10")
    lc = FakeLambda()
    out = rt.run(cfg, s3=s3, lambda_client=lc)
    assert out["reverted_to"] == "v2.5.0"
    assert lc.calls == []  # Lambda untouched in rehearsal
    assert (out["lambda_run"], out["spa_run"]) == (None, None)
    assert not any("/actions/" in u for m, u in fr.calls)  # no prod redeploy dispatched or polled
    assert any(m == "POST" and u.endswith("/branches") for m, u in fr.calls)  # dump path
    assert any("br-polished-art-am12o4ue/restore" in u for m, u in fr.calls)  # reset STAGING, not prod
    assert any("revert-rehearsal-main-1" in u for m, u in fr.calls)


def test_config_snap_bucket_default_is_snapshots():
    # The old default (garden-backups-prod) pointed at the DAILY bucket, where
    # snap manifests/dumps do not live — vars.SNAP_BUCKET is garden-snapshots-prod.
    assert rt.Config(env=base_env()).snap_bucket == "garden-snapshots-prod"


# --- branch hygiene: expires_at at creation + preserve-branch TTL ------------

def test_create_branch_sets_expires_at(monkeypatch):
    cfg = rt.Config(env=base_env())
    fr = FakeRequests()
    fr.add("GET", "/branches", FakeResp(200, {"branches": []}))
    fr.add("POST", "/branches", FakeResp(201, {"branch": {"id": "br-stage"},
           "connection_uris": [{"connection_uri": "postgresql://stage"}]}))
    monkeypatch.setattr(rt, "requests", fr)
    bid, _ = rt.neon_create_branch_with_endpoint(cfg, "revert-stage-v2.5.0", ttl_days=7)
    assert bid == "br-stage"
    assert fr.last_json["branch"]["name"] == "revert-stage-v2.5.0"
    assert fr.last_json["branch"].get("expires_at")  # TTL stamped AT CREATION


def test_create_branch_expiry_rejected_retries_without(monkeypatch):
    cfg = rt.Config(env=base_env())
    fr = FakeRequests()
    fr.add("GET", "/branches", FakeResp(200, {"branches": []}))
    calls = {"n": 0}
    def resp(url):
        calls["n"] += 1
        if calls["n"] == 1:
            return FakeResp(400, text='unknown field "expires_at"')
        return FakeResp(201, {"branch": {"id": "br-stage"},
                              "connection_uris": [{"connection_uri": "postgresql://stage"}]})
    fr.add("POST", "/branches", resp)
    monkeypatch.setattr(rt, "requests", fr)
    bid, _ = rt.neon_create_branch_with_endpoint(cfg, "revert-stage-v2.5.0", ttl_days=7)
    assert bid == "br-stage" and calls["n"] == 2  # hygiene degraded, revert not blocked
    assert "expires_at" not in fr.last_json["branch"]


def test_create_branch_no_ttl_omits_expiry(monkeypatch):
    cfg = rt.Config(env=base_env())
    fr = FakeRequests()
    fr.add("GET", "/branches", FakeResp(200, {"branches": []}))
    fr.add("POST", "/branches", FakeResp(201, {"branch": {"id": "br-x"},
           "connection_uris": [{"connection_uri": "postgresql://x"}]}))
    monkeypatch.setattr(rt, "requests", fr)
    rt.neon_create_branch_with_endpoint(cfg, "revert-stage-v2.5.0")
    assert "expires_at" not in fr.last_json["branch"]


def test_restore_prod_stamps_preserve_branch_ttl(monkeypatch):
    cfg = rt.Config(env=base_env())
    fr = FakeRequests()
    fr.add("POST", "/branches/br-delicate-sea-amum92c2/restore", FakeResp(200, {"ok": True}))
    monkeypatch.setattr(rt, "requests", fr)
    stamped = {}
    monkeypatch.setattr(rt, "_expire_branch_by_name",
                        lambda cfg2, name, days: stamped.update(name=name, days=days))
    rt.neon_restore_prod_from(cfg, "br-source", "0/ABC")
    assert stamped["name"].startswith("prerestore-v2.5.0-") and stamped["days"] == 7


def test_expire_branch_by_name_patches(monkeypatch):
    cfg = rt.Config(env=base_env())
    fr = FakeRequests()
    fr.add("GET", "/branches", FakeResp(200, {"branches": [{"id": "br-pre", "name": "prerestore-x"}]}))
    fr.add("PATCH", "/branches/br-pre", FakeResp(200, {"branch": {"id": "br-pre"}}))
    monkeypatch.setattr(rt, "requests", fr)
    assert rt._expire_branch_by_name(cfg, "prerestore-x", 7) is True
    assert fr.last_json["branch"]["expires_at"]


def test_expire_branch_by_name_never_raises(monkeypatch):
    cfg = rt.Config(env=base_env())
    fr = FakeRequests()
    fr.add("GET", "/branches", FakeResp(500, text="neon down"))
    monkeypatch.setattr(rt, "requests", fr)
    assert rt._expire_branch_by_name(cfg, "prerestore-x", 7) is False  # warn, no raise


# --- prune contract: the pre-revert snap must NOT prune ----------------------

def test_prerevert_snap_passes_prune_false(monkeypatch):
    cfg = rt.Config(env=base_env())
    fr = FakeRequests()
    fr.add("GET", "/git/ref/heads/main", FakeResp(200, {"object": {"sha": "mainHEAD"}}))
    monkeypatch.setattr(rt, "requests", fr)
    seen = {}
    def fake_run(snap_cfg, s3=None, lambda_client=None, prune=True):
        seen["prune"] = prune
        return {"manifest": {}}
    monkeypatch.setattr(rt, "snap_mod", types.SimpleNamespace(
        Config=lambda env=None: "SNAPCFG", run=fake_run))
    rt.prerevert_snap(cfg)
    # snap's own retention prune runs BEFORE fast_path_branch and could delete
    # the revert target — the pre-revert snap must archive only.
    assert seen["prune"] is False


def test_prerevert_snap_legacy_signature_fallback(monkeypatch, capsys):
    cfg = rt.Config(env=base_env())
    fr = FakeRequests()
    fr.add("GET", "/git/ref/heads/main", FakeResp(200, {"object": {"sha": "mainHEAD"}}))
    monkeypatch.setattr(rt, "requests", fr)
    called = {"n": 0}
    def old_run(snap_cfg, s3=None, lambda_client=None):  # no prune param yet
        called["n"] += 1
        return {"manifest": {}}
    monkeypatch.setattr(rt, "snap_mod", types.SimpleNamespace(
        Config=lambda env=None: "SNAPCFG", run=old_run))
    rt.prerevert_snap(cfg)
    assert called["n"] == 1
    assert "prune" in capsys.readouterr().err  # transition hazard warned, not hidden


def test_run_rehearsal_force_abort_rolls_back(monkeypatch):
    """Rehearsal + FORCE_ABORT: post-checkpoint failure triggers rollback()."""
    cfg = rt.Config(env=reh_env(FORCE_ABORT="1"))
    s3 = FakeS3({("garden-snapshots-prod", "snapshots/v2.5.0.json"): json.dumps(good_manifest()).encode()})
    fr = FakeRequests()
    fr.add("GET", "/git/ref/tags/v2.5.0", FakeResp(200, {"object": {"sha": "tagobj"}}))
    fr.add("GET", "/git/tags/tagobj", FakeResp(200, {"object": {"sha": "a" * 40}}))
    fr.add("GET", "/branches", FakeResp(200, {"branches": [
        {"id": "br-snap", "name": "snap-v2.5.0", "current_state_lsn": "0/ABC"}]}))
    fr.add("POST", "/restore", FakeResp(200, {"ok": True}))
    monkeypatch.setattr(rt, "requests", fr)
    monkeypatch.setattr(rt, "compute_rpo", lambda cfg: {"total_live_rows": 5, "latest_event": "t"})
    monkeypatch.setattr(rt, "prerevert_snap", lambda cfg: {"manifest": {
        "neon_branch_id": "br-pre", "neon_lsn": "0/PRE", "main_sha": "m" * 40, "lambda_versions": {}}})
    rolled = {"n": 0}
    monkeypatch.setattr(rt, "rollback", lambda *a, **k: rolled.__setitem__("n", rolled["n"] + 1))
    with pytest.raises(rt.RevertError) as e:
        rt.run(cfg, s3=s3)
    assert rolled["n"] == 1
    assert "rolled back" in str(e.value)


# --- OPS-REVERTALIGN-001: full-database restore scope -------------------------
# snap.py has written full-DB dumps since Gate 0.1, but the restore leg still
# passed --schema=public, so gv (11 trigger functions) and extensions (uuid
# generators behind 14 column DEFAULTs) were never rolled back, and validate_branch
# only counted public tables so it certified the result. These pin both halves.

def test_restore_dump_uses_full_database_scope(monkeypatch):
    """--schema=public must NOT be reintroduced: it silently drops gv + extensions."""
    cfg = rt.Config(env=base_env())
    s3 = FakeS3({("garden-snapshots-prod", "db/snap-v2.5.0.dump"): b"DUMP"})
    seen = {}

    class P:
        returncode = 0
        stderr = ""
        stdout = ""

    calls = []

    def capture(argv, *a, **k):
        calls.append(argv)
        return P()

    monkeypatch.setattr(rt.subprocess, "run", capture)
    rt.restore_dump_into_branch(s3, cfg, good_manifest(), "postgresql://s")
    # OPS-REVERTVALIDATE-001 added a SECOND pg_restore invocation (rendering the archive to
    # read its COPY counts), so "the last argv" is no longer the restore. Select the restore
    # call explicitly rather than by position — position is exactly what made this brittle.
    seen["argv"] = next(a for a in calls if "-d" in a)
    argv = seen["argv"]
    assert "pg_restore" in argv[0]
    assert not any(str(a).startswith("--schema") for a in argv), (
        f"restore must be full-database scope; got {argv}"
    )
    assert "--clean" in argv and "--if-exists" in argv
    # and the render call must NOT carry -d: it reads the archive, it must never touch a database
    render = next(a for a in calls if "-f" in a and "-d" not in a)
    assert render[:3] == ["pg_restore", "-f", "-"], render


def _validate_fake(gv, ext, tables="25"):
    def fake(url, sql):
        if "information_schema" in sql:
            return tables
        if "nspname='gv'" in sql:
            return gv
        if "nspname='extensions'" in sql:
            return ext
        return "10"
    return fake


def test_validate_branch_rejects_missing_gv(monkeypatch):
    cfg = rt.Config(env=base_env())
    monkeypatch.setattr(rt, "_psql_scalar", _validate_fake(gv="0", ext="9"))
    with pytest.raises(rt.RevertError, match="gv"):
        rt.validate_branch(cfg, "postgresql://s")


def test_validate_branch_rejects_missing_extensions(monkeypatch):
    cfg = rt.Config(env=base_env())
    monkeypatch.setattr(rt, "_psql_scalar", _validate_fake(gv="11", ext="0"))
    with pytest.raises(rt.RevertError, match="extensions"):
        rt.validate_branch(cfg, "postgresql://s")


def test_validate_branch_reports_nonpublic_functions(monkeypatch):
    cfg = rt.Config(env=base_env())
    monkeypatch.setattr(rt, "_psql_scalar", _validate_fake(gv="11", ext="9"))
    out = rt.validate_branch(cfg, "postgresql://s")
    assert out["nonpublic_functions"] == {"gv": 11, "extensions": 9}
    assert out["public_tables"] == 25


# --- OPS-REVERTVALIDATE-001: does the restore actually match the snapshot? ------------------
# Everything else validate_branch reads is ABSOLUTE state, and absolute state cannot tell a real
# restore from a no-op: the target branch is created with no parent_id, so Neon parents it off prod
# and it already holds a full database before pg_restore runs. The archive's own COPY counts are the
# only thing on hand that can falsify "the data landed".

RENDERED = """--
-- PostgreSQL database dump
--
CREATE TABLE public.plants (id uuid);
COPY public.plants (id, name) FROM stdin;
a\tBasil
b\tThyme
c\tSage
\\.
COPY public.event_log (id) FROM stdin;
x
y
\\.
COPY gv.lookup (k) FROM stdin;
\\.
"""


def test_expected_row_counts_reads_copy_blocks(monkeypatch):
    class P:
        returncode = 0
        stderr = ""
        stdout = RENDERED
    monkeypatch.setattr(rt.subprocess, "run", lambda *a, **k: P())
    assert rt._expected_row_counts("/tmp/x.dump") == {
        "public.plants": 3, "public.event_log": 2, "gv.lookup": 0,
    }


def test_expected_row_counts_unreadable_archive_is_None_not_zero(monkeypatch):
    """An unreadable archive must be UNKNOWN. Returning {} would read as 'every table has 0
    rows', which a no-op restore would then match perfectly."""
    class P:
        returncode = 1
        stderr = "pg_restore: error: could not open"
        stdout = ""
    monkeypatch.setattr(rt.subprocess, "run", lambda *a, **k: P())
    assert rt._expected_row_counts("/tmp/x.dump") is None


def _branch_counts(rows):
    """Fake _psql_query returning 'schema.table=n' lines like the real count query."""
    return lambda url, sql: [f"{k}={v}" for k, v in rows.items()]


def test_validate_branch_rejects_a_restore_that_does_not_match_the_archive(monkeypatch):
    cfg = rt.Config(env=base_env())
    monkeypatch.setattr(rt, "_psql_scalar", _validate_fake(gv="11", ext="9"))
    # the branch still holds PROD's data — the no-op restore this check exists to catch
    monkeypatch.setattr(rt, "_psql_query", _branch_counts({"public.plants": 307, "public.event_log": 13952}))
    with pytest.raises(rt.RevertError, match="does NOT match the snapshot archive"):
        rt.validate_branch(cfg, "postgresql://s",
                           expected_counts={"public.plants": 3, "public.event_log": 2})


def test_validate_branch_accepts_an_exact_match(monkeypatch):
    cfg = rt.Config(env=base_env())
    monkeypatch.setattr(rt, "_psql_scalar", _validate_fake(gv="11", ext="9"))
    monkeypatch.setattr(rt, "_psql_query", _branch_counts({"public.plants": 3, "public.event_log": 2}))
    out = rt.validate_branch(cfg, "postgresql://s",
                             expected_counts={"public.plants": 3, "public.event_log": 2})
    assert out["archive_match"] == "verified"
    assert out["archive_tables_compared"] == 2


def test_validate_branch_flags_a_table_the_restore_did_not_create(monkeypatch):
    cfg = rt.Config(env=base_env())
    monkeypatch.setattr(rt, "_psql_scalar", _validate_fake(gv="11", ext="9"))
    monkeypatch.setattr(rt, "_psql_query", _branch_counts({"public.plants": 3}))
    with pytest.raises(rt.RevertError, match="NO SUCH TABLE"):
        rt.validate_branch(cfg, "postgresql://s",
                           expected_counts={"public.plants": 3, "public.harvest_log": 7})


def test_validate_branch_reports_unknown_rather_than_claiming_verified(monkeypatch):
    """expected_counts=None (unreadable archive) must NOT raise — the other checks still run —
    but it must not report 'verified' either."""
    cfg = rt.Config(env=base_env())
    monkeypatch.setattr(rt, "_psql_scalar", _validate_fake(gv="11", ext="9"))
    out = rt.validate_branch(cfg, "postgresql://s", expected_counts=None)
    assert out["archive_match"] == "unknown-archive-unreadable"
    assert out["archive_tables_compared"] == 0


def test_validate_branch_refuses_when_branch_counts_cannot_be_read(monkeypatch):
    cfg = rt.Config(env=base_env())
    monkeypatch.setattr(rt, "_psql_scalar", _validate_fake(gv="11", ext="9"))
    def boom(url, sql): raise rt.RevertError("psql failed")
    monkeypatch.setattr(rt, "_psql_query", boom)
    with pytest.raises(rt.RevertError, match="unverified restore"):
        rt.validate_branch(cfg, "postgresql://s", expected_counts={"public.plants": 3})
