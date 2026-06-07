import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("vd", os.path.join(os.path.dirname(__file__), "verify-deploy.py"))
vd = importlib.util.module_from_spec(spec); spec.loader.exec_module(vd)


def test_deploy_job_ok_success():
    assert vd._deploy_job_ok([{"name": "deploy / deploy", "status": "completed", "conclusion": "success"}]) is True

def test_deploy_job_ok_failure():
    assert vd._deploy_job_ok([{"name": "deploy / deploy", "status": "completed", "conclusion": "failure"}]) is False

def test_deploy_job_ok_ignores_promote():
    assert vd._deploy_job_ok([{"name": "promote", "status": "completed", "conclusion": "success"}]) is None

def test_deploy_job_ok_none_when_absent():
    assert vd._deploy_job_ok([{"name": "snapshot", "status": "completed", "conclusion": "success"}]) is None

def test_deploy_job_ok_inprogress_indeterminate():
    assert vd._deploy_job_ok([{"name": "deploy", "status": "in_progress", "conclusion": None}]) is None


def _patch(monkeypatch_runs, monkeypatch_cmp):
    vd._runs = monkeypatch_runs
    vd._compare = lambda repo, token, base, head: monkeypatch_cmp

def test_lambda_fresh_identical():
    vd._runs = lambda repo, token, wf, **kw: [{"id": 97, "head_sha": "ABC", "conclusion": "success", "created_at": "2026-06-07T12:00:00Z"}]
    ok, msg = vd.check_lambda_fresh("r", "t", "ABC")
    assert ok is True and "current" in msg

def test_lambda_stale_when_ahead_with_lambda_change():
    vd._runs = lambda repo, token, wf, **kw: [{"id": 90, "head_sha": "OLD", "conclusion": "success", "created_at": "2026-06-06T12:00:00Z"}]
    vd._compare = lambda repo, token, base, head: {"status": "ahead", "ahead_by": 2, "files": [{"filename": "lambda/events/index.js"}, {"filename": "src/App.jsx"}]}
    ok, msg = vd.check_lambda_fresh("r", "t", "NEW")
    assert ok is False and "STALE LAMBDA" in msg

def test_lambda_fresh_when_ahead_without_lambda_change():
    vd._runs = lambda repo, token, wf, **kw: [{"id": 90, "head_sha": "OLD", "conclusion": "success", "created_at": "2026-06-06T12:00:00Z"}]
    vd._compare = lambda repo, token, base, head: {"status": "ahead", "ahead_by": 1, "files": [{"filename": "src/App.jsx"}]}
    ok, msg = vd.check_lambda_fresh("r", "t", "NEW")
    assert ok is True and "none touching lambda" in msg

def test_lambda_behind_is_fresh():
    vd._runs = lambda repo, token, wf, **kw: [{"id": 90, "head_sha": "NEWER", "conclusion": "success", "created_at": "2026-06-06T12:00:00Z"}]
    vd._compare = lambda repo, token, base, head: {"status": "behind", "ahead_by": 0, "files": []}
    ok, msg = vd.check_lambda_fresh("r", "t", "OLD")
    assert ok is True

def test_lambda_none_when_no_success():
    vd._runs = lambda repo, token, wf, **kw: []
    ok, msg = vd.check_lambda_fresh("r", "t", "X")
    assert ok is None

def test_verify_combines():
    vd.check_spa = lambda repo, token, sha: (True, "ok")
    vd.check_lambda_fresh = lambda repo, token, sha: (True, "ok")
    assert vd.verify("r", "t", "S")["verified"] is True
    vd.check_lambda_fresh = lambda repo, token, sha: (False, "stale")
    assert vd.verify("r", "t", "S")["verified"] is False
    vd.check_lambda_fresh = lambda repo, token, sha: (None, "unknown")
    assert vd.verify("r", "t", "S")["verified"] is False
