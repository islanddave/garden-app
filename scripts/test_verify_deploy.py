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


# --- OPS-VERIFY-002: SPA promote-path detection (run head_sha is PRE-FF main) ---

def test_spa_promote_path_passes_when_head_sha_differs():
    # promote-gate run head is PRE-FF main; sha == current main HEAD -> read newest run's deploy job
    vd._runs = lambda repo, token, wf, **kw: [{"id": 555, "head_sha": "PREFF", "created_at": "2026-06-07T14:00:00Z"}] if wf == "promote-gate.yml" else []
    vd._jobs = lambda repo, token, rid: [{"name": "promote", "status": "completed", "conclusion": "success"}, {"name": "deploy / deploy", "status": "completed", "conclusion": "success"}]
    vd.resolve_main = lambda repo, token: "PROMOTED"
    ok, msg = vd.check_spa("r", "t", "PROMOTED")
    assert ok is True and "555" in msg

def test_spa_promote_path_fails_on_failed_deploy_job():
    vd._runs = lambda repo, token, wf, **kw: [{"id": 556, "head_sha": "PREFF", "created_at": "2026-06-07T14:00:00Z"}] if wf == "promote-gate.yml" else []
    vd._jobs = lambda repo, token, rid: [{"name": "deploy / deploy", "status": "completed", "conclusion": "failure"}]
    vd.resolve_main = lambda repo, token: "PROMOTED"
    ok, msg = vd.check_spa("r", "t", "PROMOTED")
    assert ok is False and "556" in msg

def test_spa_promote_path_skips_preflight_failed_run():
    # newest run never reached deploy (preflight fail, main unchanged); older run deployed current main
    runs = [{"id": 600, "head_sha": "X", "created_at": "2026-06-07T15:00:00Z"}, {"id": 555, "head_sha": "PREFF", "created_at": "2026-06-07T14:00:00Z"}]
    def jobs(repo, token, rid):
        return [{"name": "promote", "status": "completed", "conclusion": "failure"}] if rid == 600 else [{"name": "deploy / deploy", "status": "completed", "conclusion": "success"}]
    vd._runs = lambda repo, token, wf, **kw: runs if wf == "promote-gate.yml" else []
    vd._jobs = jobs
    vd.resolve_main = lambda repo, token: "PROMOTED"
    ok, msg = vd.check_spa("r", "t", "PROMOTED")
    assert ok is True and "555" in msg

def test_spa_exact_head_match_still_works():
    # sha != current main, but a promote-gate run head IS sha (step 1 path)
    vd._runs = lambda repo, token, wf, **kw: [{"id": 700, "head_sha": "SHA", "created_at": "2026-06-07T14:00:00Z"}] if wf == "promote-gate.yml" else []
    vd._jobs = lambda repo, token, rid: [{"name": "deploy / deploy", "status": "completed", "conclusion": "success"}]
    vd.resolve_main = lambda repo, token: "OTHER"
    ok, msg = vd.check_spa("r", "t", "SHA")
    assert ok is True and "700" in msg

def test_spa_indeterminate_when_not_main_and_no_match():
    # sha is neither current main nor any run head, no deploy.yml run -> indeterminate (None)
    vd._runs = lambda repo, token, wf, **kw: []
    vd._jobs = lambda repo, token, rid: []
    vd.resolve_main = lambda repo, token: "OTHER"
    ok, msg = vd.check_spa("r", "t", "GHOST")
    assert ok is None


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

def test_lambda_compare_404_is_indeterminate_not_crash():
    import urllib.error
    vd._runs = lambda repo, token, wf, **kw: [{"id": 90, "head_sha": "OLD", "conclusion": "success", "created_at": "2026-06-06T12:00:00Z"}]
    def boom(repo, token, base, head):
        raise urllib.error.HTTPError(head, 404, "Not Found", {}, None)
    vd._compare = boom
    ok, msg = vd.check_lambda_fresh("r", "t", "GHOST")
    assert ok is None and "404" in msg

def test_verify_combines():
    vd.check_spa = lambda repo, token, sha: (True, "ok")
    vd.check_lambda_fresh = lambda repo, token, sha: (True, "ok")
    assert vd.verify("r", "t", "S")["verified"] is True
    vd.check_lambda_fresh = lambda repo, token, sha: (False, "stale")
    assert vd.verify("r", "t", "S")["verified"] is False
    vd.check_lambda_fresh = lambda repo, token, sha: (None, "unknown")
    assert vd.verify("r", "t", "S")["verified"] is False


# ── OPS-PROMOTERACE-001 ────────────────────────────────────────────────────────────────────────
# NOTE for anyone adding tests below: the verify() tests above (see the `vd.check_lambda_fresh = ...`
# stubs) replace module attributes and never restore them, so by the time later tests run,
# `vd.check_lambda_fresh` is whichever stub ran last. Capture the real callable HERE, at import time
# — this line executes before any test does. Calling `vd.check_lambda_fresh` directly from a test
# below would silently exercise a stub and pass or fail for the wrong reason.
_REAL_CHECK_LAMBDA_FRESH = vd.check_lambda_fresh

# deploy-lambda.yml lost its `push: main` trigger and is now invoked by promote-gate via
# `workflow_call`. A called workflow creates NO standalone run — its jobs live inside the caller's
# run. Without the promote-gate path below, check_lambda_fresh sees only stale standalone runs and
# reports STALE LAMBDA on every promote forever. These pin that it does not.

def test_lambda_job_ok_matches_called_workflow_jobs():
    jobs = [{"name": "deploy-lambdas / deploy (events)", "conclusion": "success"},
            {"name": "deploy-lambdas / deploy (plants)", "conclusion": "success"}]
    assert vd._lambda_job_ok(jobs) is True

def test_lambda_job_ok_false_when_a_leg_failed():
    # fail-fast:false means one red leg among 26 is reachable — it must NOT read as deployed.
    jobs = [{"name": "deploy-lambdas / deploy (events)", "conclusion": "success"},
            {"name": "deploy-lambdas / deploy (photos)", "conclusion": "failure"}]
    assert vd._lambda_job_ok(jobs) is False

def test_lambda_job_ok_ignores_unrelated_jobs():
    # 'deploy / deploy' is the SPA. It must not be mistaken for the Lambda deploy.
    assert vd._lambda_job_ok([{"name": "deploy / deploy", "conclusion": "success"}]) is False

def test_lambda_fresh_via_promote_gate_called_workflow():
    vd._runs = lambda repo, token, wf, **kw: (
        [{"id": 42, "head_sha": "SHA", "conclusion": "success", "created_at": "2026-08-14T12:00:00Z"}]
        if wf == "promote-gate.yml" else []
    )
    vd._jobs = lambda repo, token, run_id: [
        {"name": "deploy-lambdas / deploy (events)", "conclusion": "success"}]
    ok, msg = _REAL_CHECK_LAMBDA_FRESH("r", "t", "SHA")
    assert ok is True
    assert "promote-gate run 42" in msg

def test_lambda_fresh_falls_through_when_promote_run_has_no_lambda_jobs():
    # An SPA-only promote skips the lambda job entirely; freshness must fall through to the
    # standalone-run path rather than claiming the Lambdas just deployed.
    vd._runs = lambda repo, token, wf, **kw: (
        [{"id": 43, "head_sha": "SHA", "conclusion": "success", "created_at": "2026-08-14T12:00:00Z"}]
        if wf == "promote-gate.yml"
        else [{"id": 9, "head_sha": "SHA", "conclusion": "success", "created_at": "2026-08-14T11:00:00Z"}]
    )
    vd._jobs = lambda repo, token, run_id: [{"name": "deploy / deploy", "conclusion": "success"}]
    ok, msg = _REAL_CHECK_LAMBDA_FRESH("r", "t", "SHA")
    assert ok is True
    assert "promote-gate" not in msg
