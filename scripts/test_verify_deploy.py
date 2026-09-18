import importlib.util, os, sys
import pytest
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
    vd.check_lambda_fresh = lambda repo, token, sha, **kw: (True, "ok")
    assert vd.verify("r", "t", "S")["verified"] is True
    vd.check_lambda_fresh = lambda repo, token, sha, **kw: (False, "stale")
    assert vd.verify("r", "t", "S")["verified"] is False
    vd.check_lambda_fresh = lambda repo, token, sha, **kw: (None, "unknown")
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

def test_lambda_job_state_matches_called_workflow_jobs():
    jobs = [{"name": "deploy-lambdas / deploy (events)", "conclusion": "success"},
            {"name": "deploy-lambdas / deploy (plants)", "conclusion": "success"}]
    assert vd._lambda_job_state(jobs) == vd.LAMBDA_DEPLOYED

def test_lambda_job_state_unverified_when_a_leg_failed():
    # fail-fast:false means one red leg among 26 is reachable — it must NOT read as deployed.
    jobs = [{"name": "deploy-lambdas / deploy (events)", "conclusion": "success"},
            {"name": "deploy-lambdas / deploy (photos)", "conclusion": "failure"}]
    assert vd._lambda_job_state(jobs) == vd.LAMBDA_UNVERIFIED

def test_lambda_job_state_ignores_unrelated_jobs():
    # 'deploy / deploy' is the SPA. It must not be mistaken for the Lambda deploy.
    assert vd._lambda_job_state([{"name": "deploy / deploy", "conclusion": "success"}]) == vd.LAMBDA_UNVERIFIED


# ── OPS-LAMCHANGEDBLIND-002: the three states must stay separable ──────────────────────────────
# Once the SPA-only skip is reachable, `deploy-lambdas` is legitimately skipped on promotes that
# touch no Lambda input. Reporting NOT VERIFIED for that would be a permanent false alarm; reporting
# VERIFIED for *any* absence would be a blind spot. These pin the boundary between the two.
#
# Job shapes below are the REAL ones, not invented: a skipped `uses:` caller job appears under its
# BARE name with conclusion='skipped' (live API, promote-gate run 34175616568), and when it runs
# there is no bare entry at all, only 'deploy-lambdas / ...' children.

# OPS-LAMSKIPVSMAIN-001: a skip is only "not applicable" when the promote job ran the marker-based
# decision step. The two state-2 fixtures below used to carry a bare `promote` job with no steps and
# expect NOT_APPLICABLE — i.e. "skip + promote success" alone meant current. That is the claim the
# ledger row shows false (a skip decided against `main`), so they now carry the step that proves it.
_PROVEN = {"name": "promote", "status": "completed", "conclusion": "success",
           "steps": [{"name": vd.LAMBDA_DECISION_STEP, "status": "completed", "conclusion": "success"}]}


def test_state2_skipped_with_successful_promote_is_not_applicable():
    # THE SPA-ONLY PROMOTE. Must NOT report unverified.
    jobs = [_PROVEN,
            {"name": "deploy-lambdas", "status": "completed", "conclusion": "skipped"},
            {"name": "deploy / deploy", "status": "completed", "conclusion": "success"}]
    assert vd._lambda_job_state(jobs) == vd.LAMBDA_NOT_APPLICABLE

def test_state3_skipped_because_the_PROMOTE_failed_is_unverified():
    # The discriminator that matters. Real shape, promote-gate run 34175616568: the promote collapsed
    # and took deploy-lambdas down with it via its bare `needs:`. Identical 'skipped' conclusion to
    # the case above, opposite meaning. Keying off the skip ALONE would report this as verified.
    jobs = [{"name": "promote", "status": "completed", "conclusion": "failure"},
            {"name": "deploy-lambdas", "status": "completed", "conclusion": "skipped"},
            {"name": "deploy", "status": "completed", "conclusion": "skipped"}]
    assert vd._lambda_job_state(jobs) == vd.LAMBDA_UNVERIFIED

def test_state3_no_lambda_jobs_at_all_is_unverified():
    # Absence is NOT a skip. No bare caller entry, no children -> nothing was determined.
    jobs = [{"name": "promote", "status": "completed", "conclusion": "success"},
            {"name": "deploy / deploy", "status": "completed", "conclusion": "success"}]
    assert vd._lambda_job_state(jobs) == vd.LAMBDA_UNVERIFIED

def test_state3_caller_job_failed_outright_is_unverified():
    # A `uses:` job can red without producing children (e.g. the called workflow fails to load).
    # Only 'skipped' means not-applicable; any other bare conclusion must not.
    jobs = [{"name": "promote", "status": "completed", "conclusion": "success"},
            {"name": "deploy-lambdas", "status": "completed", "conclusion": "failure"}]
    assert vd._lambda_job_state(jobs) == vd.LAMBDA_UNVERIFIED

def test_state3_cancelled_caller_is_unverified():
    jobs = [{"name": "promote", "status": "completed", "conclusion": "success"},
            {"name": "deploy-lambdas", "status": "completed", "conclusion": "cancelled"}]
    assert vd._lambda_job_state(jobs) == vd.LAMBDA_UNVERIFIED

def test_state2_does_not_fire_when_the_matrix_actually_ran():
    # Children present => the run/succeed path decides; a stray bare entry must not shortcut it.
    jobs = [{"name": "promote", "status": "completed", "conclusion": "success"},
            {"name": "deploy-lambdas", "status": "completed", "conclusion": "skipped"},
            {"name": "deploy-lambdas / deploy (photos)", "conclusion": "failure"}]
    assert vd._lambda_job_state(jobs) == vd.LAMBDA_UNVERIFIED

def test_state2_end_to_end_reports_verified_and_says_it_was_a_skip():
    # check_lambda_fresh must return True AND make it unmistakable that nothing deployed.
    vd._runs = lambda repo, token, wf, **kw: (
        [{"id": 77, "head_sha": "SHA", "conclusion": "success", "created_at": "2026-09-17T12:00:00Z"}]
        if wf == "promote-gate.yml" else []
    )
    vd._jobs = lambda repo, token, run_id: [
        _PROVEN,
        {"name": "deploy-lambdas", "status": "completed", "conclusion": "skipped"}]
    ok, msg = _REAL_CHECK_LAMBDA_FRESH("r", "t", "SHA")
    assert ok is True
    assert "SKIPPED" in msg and "promote-gate run 77" in msg
    assert "NOT a deploy" in msg

def test_state3_end_to_end_still_falls_through_and_can_report_stale():
    # The one that must not regress: a failed promote must NOT be excused by the skip branch. With no
    # usable standalone run either, freshness stays unverifiable rather than silently passing.
    vd._runs = lambda repo, token, wf, **kw: (
        [{"id": 78, "head_sha": "SHA", "conclusion": "failure", "created_at": "2026-09-17T12:00:00Z"}]
        if wf == "promote-gate.yml" else []
    )
    vd._jobs = lambda repo, token, run_id: [
        {"name": "promote", "status": "completed", "conclusion": "failure"},
        {"name": "deploy-lambdas", "status": "completed", "conclusion": "skipped"}]
    ok, msg = _REAL_CHECK_LAMBDA_FRESH("r", "t", "SHA")
    assert ok is None
    assert "promote-gate run 78" not in msg

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
    # A promote-gate run carrying NO deploy-lambdas entry of any kind — neither the bare caller job
    # nor any 'deploy-lambdas / ...' child. Freshness must fall through to the standalone-run path
    # rather than claiming the Lambdas just deployed.
    #
    # The comment here used to read "an SPA-only promote skips the lambda job entirely", which framed
    # this fixture as the SPA-only case. It is not: a skipped `uses:` job DOES appear, under its bare
    # name with conclusion='skipped' (live API, run 34175616568). That shape is covered by
    # test_state2_* below. This one is the genuine ABSENCE case, which stays unverified.
    vd._runs = lambda repo, token, wf, **kw: (
        [{"id": 43, "head_sha": "SHA", "conclusion": "success", "created_at": "2026-08-14T12:00:00Z"}]
        if wf == "promote-gate.yml"
        else [{"id": 9, "head_sha": "SHA", "conclusion": "success", "created_at": "2026-08-14T11:00:00Z"}]
    )
    vd._jobs = lambda repo, token, run_id: [{"name": "deploy / deploy", "conclusion": "success"}]
    ok, msg = _REAL_CHECK_LAMBDA_FRESH("r", "t", "SHA")
    assert ok is True
    assert "promote-gate" not in msg


# ── OPS-LAMSKIPVSMAIN-001: a skip proves "current" only when the marker-based step decided it ──────
# Module-level, so these run at import — before any test above has replaced a module attribute.
_REAL_JOBS = vd._jobs
_REAL_CHECK_SPA = vd.check_spa
_REAL_VERIFY = vd.verify
_REAL_LAMBDA_JOB_STATE = vd._lambda_job_state
HERE = os.path.dirname(os.path.abspath(__file__))
OLD_DECISION_STEP = "Detect lambda changes (pre-FF; compares every input listed in PATHS below)"


def _fixture(name):
    import json
    with open(os.path.join(HERE, "fixtures", name)) as fh:
        return json.load(fh)


def _promote(step_name, conclusion="success"):
    steps = [] if step_name is None else [{"name": step_name, "status": "completed", "conclusion": conclusion}]
    return {"name": "promote", "status": "completed", "conclusion": "success", "steps": steps}


def _skipped_caller():
    return {"name": "deploy-lambdas", "status": "completed", "conclusion": "skipped"}


def test_skip_decided_by_the_old_main_comparison_is_unverified():
    # The ledger row's case. The v4.137 step compared dev_sha with main; after a failed leg a plain
    # re-dispatch (main == dev_sha) skipped every Lambda. That skip must NOT read as "current".
    assert _REAL_LAMBDA_JOB_STATE([_promote(OLD_DECISION_STEP), _skipped_caller()]) == vd.LAMBDA_UNVERIFIED


def test_skip_with_no_step_list_is_unverified():
    assert _REAL_LAMBDA_JOB_STATE([_promote(None), _skipped_caller()]) == vd.LAMBDA_UNVERIFIED
    bare = {"name": "promote", "status": "completed", "conclusion": "success"}
    assert _REAL_LAMBDA_JOB_STATE([bare, _skipped_caller()]) == vd.LAMBDA_UNVERIFIED


def test_skip_when_the_decision_step_did_not_succeed_is_unverified():
    for c in ("failure", "skipped", "cancelled", None):
        assert _REAL_LAMBDA_JOB_STATE([_promote(vd.LAMBDA_DECISION_STEP, c), _skipped_caller()]) \
            == vd.LAMBDA_UNVERIFIED


def test_skip_decided_by_the_marker_step_is_not_applicable():
    assert _REAL_LAMBDA_JOB_STATE([_promote(vd.LAMBDA_DECISION_STEP), _skipped_caller()]) \
        == vd.LAMBDA_NOT_APPLICABLE


def _workflow(name):
    import yaml
    with open(os.path.join(HERE, "..", ".github", "workflows", name)) as fh:
        return yaml.safe_load(fh)


def test_decision_step_name_is_the_one_promote_gate_runs():
    """verify-deploy keys on the step NAME; a rename on one side only would silently turn every proven
    skip into UNVERIFIED (a false alarm) — pin them equal."""
    steps = _workflow("promote-gate.yml")["jobs"]["promote"]["steps"]
    lam = [s for s in steps if s.get("id") == "lam"]
    assert len(lam) == 1 and lam[0]["name"] == vd.LAMBDA_DECISION_STEP


def test_deploy_lambdas_skips_only_on_an_explicit_false():
    """_lambda_job_state reads "promote success + deploy-lambdas skipped" as lambda_changed == 'false'.
    That is exact only while the job's condition is `!= 'false'`; with `== 'true'` an ABSENT output
    would also skip — silently, and read here as a decision."""
    job = _workflow("promote-gate.yml")["jobs"]["deploy-lambdas"]
    assert job["if"] == "${{ needs.promote.outputs.lambda_changed != 'false' }}"
    assert job["needs"] == ["resolve", "promote"]


def test_real_failed_promote_run_is_unverified():
    # promote-gate run 34175616568 as recorded: promote=failure, bare deploy-lambdas=skipped.
    jobs = _fixture("promote-gate-run-34175616568-jobs.json")["pages"][0]["jobs"]
    assert _REAL_LAMBDA_JOB_STATE(jobs) == vd.LAMBDA_UNVERIFIED


# ── OPS-VERIFYINRUNSTALE-001: _jobs paginates; the in-promote call reads its own run ───────────────

def _serve_pages(monkeypatch, pages_by_run, seen=None):
    def gh(path, token, params=None):
        rid = path.split("/runs/")[1].split("/")[0]
        params = params or {}
        if seen is not None:
            seen.append((rid, dict(params)))
        pages = pages_by_run[rid]
        page = int(params.get("page", 1))
        return pages[page - 1] if page <= len(pages) else {"total_count": pages[0]["total_count"], "jobs": []}
    monkeypatch.setattr(vd, "gh", gh)
    monkeypatch.setattr(vd, "_jobs", _REAL_JOBS)


def test_jobs_follows_pages_to_total_count(monkeypatch):
    # The real v4.136.0 promote, recorded as two pages of 20: 32 jobs. One page of 50 happened to hold
    # it; ~17 more matrix legs would not have, and nothing noticed truncation.
    pages = _fixture("promote-gate-run-35274928023-jobs.json")["pages"]
    seen = []
    _serve_pages(monkeypatch, {"35274928023": pages}, seen)
    jobs = vd._jobs("r", "t", "35274928023")
    assert len(jobs) == 32 == pages[0]["total_count"]
    assert sum(j["name"].startswith("deploy-lambdas / deploy (") for j in jobs) == 26
    assert [p["page"] for _, p in seen] == [1, 2]
    assert all(p["per_page"] == 100 for _, p in seen)


def test_jobs_short_read_raises_instead_of_answering(monkeypatch):
    pages = _fixture("promote-gate-run-35274928023-jobs.json")["pages"]
    _serve_pages(monkeypatch, {"35274928023": [pages[0], {"total_count": 32, "jobs": []}]})
    with pytest.raises(vd.IncompleteJobList):
        vd._jobs("r", "t", "35274928023")
    _serve_pages(monkeypatch, {"1": [{"jobs": [{"name": "promote"}]}]})  # no total_count at all
    with pytest.raises(vd.IncompleteJobList):
        vd._jobs("r", "t", "1")


def test_incomplete_job_list_is_indeterminate_not_a_crash(monkeypatch):
    def short(repo, token, rid):
        raise vd.IncompleteJobList("short")
    monkeypatch.setattr(vd, "_jobs", short)
    monkeypatch.setattr(vd, "_runs", lambda repo, token, wf, **kw: (
        [{"id": 5, "head_sha": "SHA", "created_at": "2026-09-18T12:00:00Z"}] if wf == "promote-gate.yml" else []))
    monkeypatch.setattr(vd, "resolve_main", lambda repo, token: "SHA")
    ok, msg = _REAL_CHECK_SPA("r", "t", "SHA")
    assert ok is None and "unreadable" in msg
    ok, msg = _REAL_CHECK_LAMBDA_FRESH("r", "t", "SHA", run_id="5")
    assert ok is None  # fell through to the (empty) standalone path, did not claim anything


def _standalone_history(monkeypatch, completed_promote_runs):
    """The live shape on 2026-09-18: the newest SUCCESSFUL standalone deploy-lambda.yml run is c509fff4ae
    from 2026-08-13, and main is 1191 commits ahead of it touching lambda/**."""
    def runs(repo, token, wf, **kw):
        if wf == "promote-gate.yml":
            return completed_promote_runs
        return [{"id": 9, "head_sha": "c509fff4ae" + "0" * 30, "conclusion": "success",
                 "created_at": "2026-08-13T00:00:00Z"}]
    monkeypatch.setattr(vd, "_runs", runs)
    monkeypatch.setattr(vd, "_compare", lambda repo, token, base, head: {
        "status": "ahead", "ahead_by": 1191, "files": [{"filename": "lambda/_test-stubs/aws-s3.js"}]})


SHA_4136 = "d80fed7abf3123200b2dedba116e8b1a4a99502b"


def test_in_run_call_reads_its_own_in_progress_run(monkeypatch):
    # THE FIX. The in-promote verify job runs inside run 35274928023, which is in_progress, so the
    # completed-run list does not contain it. With --run-id it reads its own 26 green legs.
    pages = _fixture("promote-gate-run-35274928023-jobs.json")["pages"]
    _serve_pages(monkeypatch, {"35274928023": pages})
    _standalone_history(monkeypatch, completed_promote_runs=[])
    ok, msg = _REAL_CHECK_LAMBDA_FRESH("r", "t", SHA_4136, run_id="35274928023")
    assert ok is True, msg
    assert "this promote-gate run 35274928023" in msg


def test_in_run_call_without_run_id_reproduces_the_false_alarm(monkeypatch):
    # What every promote printed until now (job 105386663819): same run, same history, no run id.
    pages = _fixture("promote-gate-run-35274928023-jobs.json")["pages"]
    _serve_pages(monkeypatch, {"35274928023": pages})
    _standalone_history(monkeypatch, completed_promote_runs=[])
    ok, msg = _REAL_CHECK_LAMBDA_FRESH("r", "t", SHA_4136)
    assert ok is False and "STALE LAMBDA" in msg and "c509fff4ae" in msg


def _with_failed_leg(pages, leg="deploy-lambdas / deploy (photos)"):
    import copy
    pages = copy.deepcopy(pages)
    for p in pages:
        for j in p["jobs"]:
            if j["name"] == leg:
                j["conclusion"] = "failure"
    return pages


def test_in_run_failed_leg_names_the_leg_not_old_history(monkeypatch):
    pages = _with_failed_leg(_fixture("promote-gate-run-35274928023-jobs.json")["pages"])
    _serve_pages(monkeypatch, {"35274928023": pages})
    _standalone_history(monkeypatch, completed_promote_runs=[])
    ok, msg = _REAL_CHECK_LAMBDA_FRESH("r", "t", SHA_4136, run_id="35274928023")
    assert ok is False
    assert "deploy-lambdas / deploy (photos)=failure" in msg and "c509fff4ae" not in msg


def test_in_run_failed_leg_is_excused_by_an_earlier_full_deploy_of_the_same_sha(monkeypatch):
    # e.g. a force_lambda re-dispatch whose leg failed, after an earlier run deployed all 26 of the SAME
    # sha: every function still runs this sha's code.
    real = _fixture("promote-gate-run-35274928023-jobs.json")["pages"]
    _serve_pages(monkeypatch, {"999": _with_failed_leg(real), "35274928023": real})
    _standalone_history(monkeypatch, completed_promote_runs=[
        {"id": 35274928023, "head_sha": SHA_4136, "conclusion": "success", "created_at": "2026-09-17T21:08:00Z"}])
    ok, msg = _REAL_CHECK_LAMBDA_FRESH("r", "t", SHA_4136, run_id="999")
    assert ok is True and "promote-gate run 35274928023" in msg


def test_in_run_failed_promote_says_the_lambdas_never_ran(monkeypatch):
    # The post-FF strand (snap.py or the pg17 fetch failing after the fast-forward): verify still runs
    # (if: always()), and must say THIS run never deployed, not cite the 2026-08-13 standalone run.
    # Real job list of promote-gate run 34175616568 (promote=failure, deploy-lambdas skipped).
    pages = _fixture("promote-gate-run-34175616568-jobs.json")["pages"]
    _serve_pages(monkeypatch, {"34175616568": pages})
    _standalone_history(monkeypatch, completed_promote_runs=[])
    ok, msg = _REAL_CHECK_LAMBDA_FRESH("r", "t", SHA_4136, run_id="34175616568")
    assert ok is False
    assert "promote=failure (deploy-lambdas never ran)" in msg and "c509fff4ae" not in msg


def test_in_run_proven_skip_is_not_applicable(monkeypatch):
    jobs = [{"name": "resolve", "status": "completed", "conclusion": "success"},
            _promote(vd.LAMBDA_DECISION_STEP), _skipped_caller(),
            {"name": "deploy / deploy", "status": "completed", "conclusion": "success"},
            {"name": "verify", "status": "in_progress", "conclusion": None}]
    _serve_pages(monkeypatch, {"1000": [{"total_count": len(jobs), "jobs": jobs}]})
    _standalone_history(monkeypatch, completed_promote_runs=[])
    ok, msg = _REAL_CHECK_LAMBDA_FRESH("r", "t", "SHA", run_id="1000")
    assert ok is True and "SKIPPED in this promote-gate run 1000" in msg


def test_in_run_skip_by_the_old_step_is_not_called_current(monkeypatch):
    jobs = [_promote(OLD_DECISION_STEP), _skipped_caller(),
            {"name": "deploy / deploy", "status": "completed", "conclusion": "success"}]
    _serve_pages(monkeypatch, {"1001": [{"total_count": len(jobs), "jobs": jobs}]})
    _standalone_history(monkeypatch, completed_promote_runs=[])
    ok, msg = _REAL_CHECK_LAMBDA_FRESH("r", "t", "SHA", run_id="1001")
    assert ok is not True and "SKIPPED" not in msg


def test_main_passes_run_id_through(monkeypatch):
    seen = {}

    def fake_verify(repo, token, sha, run_id=None):
        seen["run_id"] = run_id
        return {"verified": True, "spa_deploy": {"ok": True, "detail": ""},
                "lambda_fresh": {"ok": True, "detail": ""}}
    monkeypatch.setattr(vd, "verify", fake_verify)
    assert vd.main(["--sha", "S", "--pat", "t", "--run-id", "123"]) == 0
    assert seen["run_id"] == "123"
    assert vd.main(["--sha", "S", "--pat", "t"]) == 0
    assert seen["run_id"] is None
