#!/usr/bin/env python3
"""verify-deploy.py — OPS-VERIFY-001 (per L-147 / L-161 / L-141)

Mechanizes the manual post-promote check: confirm a prod SHA actually DEPLOYED
successfully, not merely that the promote run reported success.

Two ground-truth checks against the GitHub Actions API for a target SHA
(default: live `main` HEAD):

  1. SPA deploy job (L-161). The SPA build+deploy runs as the nested `deploy`
     job of the `promote-gate` run (deploy.yml via workflow_call). A run-level
     "success" can MASK a failed deploy job — e.g. the CloudFront invalidation
     step timing out — because the no-cache index keeps revalidating and the
     stale shell still serves 200. So we read the DEPLOY JOB conclusion, not the
     run conclusion. Fallback: a deploy.yml workflow_dispatch run on the SHA.

  2. Lambda freshness / stranded guard (L-141). `deploy-lambda.yml` fires on
     push:main for lambda/** under its OWN production approval gate and a
     `concurrency: lambda-deploy` group. The trap: main advances but the Lambda
     deploy is stranded at the unapproved gate or serial-cancelled, leaving prod
     on STALE Lambda code while the frontend looks shipped. We take the newest
     SUCCESSFUL deploy-lambda run and require that main is not ahead of it with
     any lambda/** change.

Read-only. Exit 0 = verified; exit 1 = a deploy did not succeed or prod is stale;
exit 2 = could not determine (treat as not-verified).

Usage:
  GH_PAT_OPS=... python3 verify-deploy.py [--sha <prod_sha>] [--repo owner/name] [--json]

Auth: --pat, else $GH_PAT_OPS, else $GITHUB_PAT, else $GH_TOKEN.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from urllib.parse import urlencode

DEFAULT_REPO = "islanddave/garden-app"
API = "https://api.github.com"


def _token():
    for k in ("GH_PAT_OPS", "GITHUB_PAT", "GH_TOKEN"):
        v = os.environ.get(k)
        if v:
            return v
    return None


def gh(path, token, params=None):
    url = f"{API}{path}"
    if params:
        url += "?" + urlencode(params)
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "verify-deploy-ops",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def resolve_main(repo, token):
    return gh(f"/repos/{repo}/git/refs/heads/main", token)["object"]["sha"]


def _runs(repo, token, workflow, **params):
    p = {"per_page": 40}
    p.update(params)
    return gh(f"/repos/{repo}/actions/workflows/{workflow}/runs", token, p).get("workflow_runs", [])


JOBS_PER_PAGE = 100
JOBS_MAX_PAGES = 10


class IncompleteJobList(Exception):
    """The jobs API answered with fewer jobs than its own total_count."""


def _jobs(repo, token, run_id):
    """EVERY job of a run, following pages (OPS-VERIFYINRUNSTALE-001).

    This read one page of 50. The v4.136.0 promote had 32 jobs, so ~17 more matrix legs would have
    silently truncated the list — and a truncated list changes the answer: a missing
    'deploy-lambdas / ...' child reads as "no Lambda deploy", a missing failed leg reads as green. A
    short read therefore raises rather than answering; callers treat it like an unreadable run."""
    jobs, total = [], None
    for page in range(1, JOBS_MAX_PAGES + 1):
        body = gh(f"/repos/{repo}/actions/runs/{run_id}/jobs", token,
                  {"per_page": JOBS_PER_PAGE, "page": page})
        batch = body.get("jobs") or []
        total = body.get("total_count")
        jobs.extend(batch)
        if not batch or not isinstance(total, int) or len(jobs) >= total:
            break
    if not isinstance(total, int) or len(jobs) != total:
        raise IncompleteJobList(f"run {run_id}: read {len(jobs)} job(s) but the API reports total_count={total!r}")
    return jobs


def _deploy_job_ok(jobs):
    """A deploy job = name ends with 'deploy' (covers nested 'deploy / deploy'
    and a top-level 'deploy'); ignore 'promote'. Require >=1 completed+success
    deploy job and NO deploy job that failed/cancelled/timed_out."""
    dep = [j for j in jobs
           if j.get("name", "").strip().lower().endswith("deploy")
           and j.get("name", "").strip().lower() != "promote"]
    if not dep:
        return None
    bad = [j for j in dep if j.get("conclusion") in ("failure", "cancelled", "timed_out", "startup_failure")]
    if bad:
        return False
    good = [j for j in dep if j.get("status") == "completed" and j.get("conclusion") == "success"]
    return True if good else None


def check_spa(repo, token, sha):
    try:
        return _check_spa(repo, token, sha)
    except IncompleteJobList as e:
        return None, f"job list unreadable ({e}); SPA deploy unverified"


def _check_spa(repo, token, sha):
    pg_runs = sorted(_runs(repo, token, "promote-gate.yml"), key=lambda r: r["created_at"], reverse=True)
    # 1) exact head_sha match — a promote-gate run whose head IS sha (rare; covers a
    #    promote-gate run dispatched on a ref that already equals sha).
    for r in pg_runs:
        if r.get("head_sha") == sha:
            res = _deploy_job_ok(_jobs(repo, token, r["id"]))
            if res is True:
                return True, f"promote-gate run {r['id']}: SPA deploy job success"
            if res is False:
                return False, f"promote-gate run {r['id']}: SPA deploy job FAILED (L-161 — check CloudFront invalidation step)"
            break
    # 2) promote path (OPS-VERIFY-002): a promote-gate run's head_sha is the PRE-FF main,
    #    NOT the promoted dev_sha, so step 1 cannot match it on a normal promote. main
    #    advances ONLY via promote-gate fast-forward, so when sha == current main HEAD the
    #    newest deploy-bearing promote-gate run is the one that promoted it. Read that run's
    #    deploy job. Skip runs that never reached deploy (e.g. preflight-failed promotes that
    #    left main unchanged) so they don't mask the real deploy.
    try:
        main_head = resolve_main(repo, token)
    except Exception:
        main_head = None
    if main_head == sha:
        for r in pg_runs:
            res = _deploy_job_ok(_jobs(repo, token, r["id"]))
            if res is None:
                continue
            if res is True:
                return True, f"promote-gate run {r['id']} (promoted current main {sha[:10]}): SPA deploy job success"
            return False, f"promote-gate run {r['id']} (promoted current main {sha[:10]}): SPA deploy job FAILED (L-161 — check CloudFront invalidation step)"
    # 3) deploy.yml fallback (push / workflow_dispatch deploy path).
    for r in sorted(_runs(repo, token, "deploy.yml"), key=lambda r: r["created_at"], reverse=True):
        if r.get("head_sha") == sha:
            res = _deploy_job_ok(_jobs(repo, token, r["id"]))
            if res is True:
                return True, f"deploy.yml run {r['id']}: SPA deploy job success"
            if res is False:
                return False, f"deploy.yml run {r['id']}: SPA deploy job FAILED"
            return None, f"deploy.yml run {r['id']}: deploy job indeterminate"
    return None, f"no promote-gate/deploy run found for {sha[:10]} (SPA deploy unverified)"


def _compare(repo, token, base, head):
    return gh(f"/repos/{repo}/compare/{base}...{head}", token)


LAMBDA_DEPLOYED = "deployed"
LAMBDA_NOT_APPLICABLE = "not-applicable"
LAMBDA_UNVERIFIED = "unverified"

# The promote-gate step that decides the Lambda skip FROM THE RUNNING FUNCTIONS (OPS-LAMSKIPVSMAIN-001).
# Its name is the only thing in the jobs API that says HOW a skip was decided, so it must match
# promote-gate.yml exactly — test_verify_deploy.py pins the two equal. The step it replaced,
# "Detect lambda changes (pre-FF; ...)", compared dev_sha with `main` (approved, not deployed), so a
# skip it decided proves nothing about the running Lambdas and must never read as NOT_APPLICABLE.
LAMBDA_DECISION_STEP = "Decide Lambda deploy from deploy markers on the running functions (pre-FF; fail-closed)"


def _skip_was_proven(promote_job):
    """True only when the promote job ran the marker-based decision step to success."""
    return any(s.get("name") == LAMBDA_DECISION_STEP and s.get("conclusion") == "success"
               for s in (promote_job.get("steps") or []))


def _lambda_job_state(jobs):
    """Which of three states a promote-gate run's Lambda deploy is in. THREE, not two.

    OPS-PROMOTERACE-001: the Lambda deploy is a CALLED workflow inside promote-gate, so when it RUNS
    it produces jobs named 'deploy-lambdas / deploy (<function>)' rather than a standalone run.

    OPS-LAMCHANGEDBLIND-002 made a second state reachable. Once the SPA-only skip works, a promote
    where lambda/ did not move skips `deploy-lambdas` entirely, and there are then ZERO
    'deploy-lambdas / ...' jobs. The previous version of this function returned False for that, which
    would have reported NOT VERIFIED on every SPA-only promote — reviving, by a different route, the
    exact permanent-false-alarm failure described in check_lambda_fresh below.

    The fix deliberately does NOT key off "zero nested jobs". A zero count is ambiguous: it reads the
    same for "correctly skipped", "the job never existed", and "the API answer was truncated or
    partial". Instead it keys off the SKIPPED CONCLUSION, which is unambiguous and which GitHub really
    does report: a `uses:` caller job that is skipped appears under its BARE name with
    conclusion='skipped' (verified against the live API 2026-09-17, promote-gate run 34175616568:
    {"name": "deploy-lambdas", "status": "completed", "conclusion": "skipped"}). When it RUNS there is
    no bare entry at all, only the prefixed children.

    `promote` must ALSO have succeeded. That is load-bearing, not belt-and-braces: `deploy-lambdas`
    has a bare `needs: [resolve, promote]`, so it is skipped when the PROMOTE FAILED too — run
    34175616568 is exactly that (promote=failure, deploy-lambdas=skipped). Treating that as "not
    applicable" would report a collapsed promote as verified. Since the job's only other condition is
    `needs.promote.outputs.lambda_changed != 'false'`, promote=success AND deploy-lambdas=skipped
    means lambda_changed was exactly 'false'.

    OPS-LAMSKIPVSMAIN-001 (2026-09-18): and 'false' must have been decided by the marker-based step
    (LAMBDA_DECISION_STEP). Until then lambda_changed=false meant only "dev_sha's Lambda inputs equal
    main's" — and main is APPROVED, not DEPLOYED, so after a failed leg or a re-dispatch that "not
    applicable" answer called stale Lambdas current. A skip decided any other way is UNVERIFIED.
    """
    lam = [j for j in jobs if j.get("name", "").startswith("deploy-lambdas /")]
    if lam:
        if any(j.get("conclusion") not in ("success", "skipped") for j in lam):
            return LAMBDA_UNVERIFIED
        if any(j.get("conclusion") == "success" for j in lam):
            return LAMBDA_DEPLOYED
        return LAMBDA_UNVERIFIED
    caller = next((j for j in jobs if j.get("name", "").strip() == "deploy-lambdas"), None)
    promote = next((j for j in jobs if j.get("name", "").strip() == "promote"), None)
    if (caller is not None and caller.get("conclusion") == "skipped"
            and promote is not None and promote.get("conclusion") == "success"
            and _skip_was_proven(promote)):
        return LAMBDA_NOT_APPLICABLE
    return LAMBDA_UNVERIFIED


def _not_green_lambda_jobs(jobs):
    """'name=conclusion' for every Lambda child job that did not finish green — for messages only."""
    return [f"{j.get('name')}={j.get('conclusion') or j.get('status')}" for j in jobs
            if j.get("name", "").startswith("deploy-lambdas /")
            and j.get("conclusion") not in ("success", "skipped")]


def check_lambda_fresh(repo, token, sha, run_id=None):
    # OPS-PROMOTERACE-001 (2026-08-14): deploy-lambda.yml lost its `push: main` trigger and is now
    # invoked by promote-gate via `workflow_call`. A called workflow does NOT create its own workflow
    # run — its jobs appear inside the CALLER's run. So polling deploy-lambda.yml's runs alone would
    # only ever see pre-change (and workflow_dispatch) runs, conclude main is ahead of the last one
    # with lambda/ changes, and report STALE LAMBDA on every promote, forever. A permanent false
    # alarm in a report-only check is worse than no check: it teaches the reader to ignore it.
    #
    # So: look for the Lambda deploy in BOTH places — a standalone run (workflow_dispatch, or any
    # historical push-triggered run) and a promote-gate run carrying successful deploy-lambdas jobs.
    #
    # UPDATE 2026-09-17 (OPS-LAMCHANGEDBLIND-002) — the paragraph above is no longer only a warning
    # about the past. Once the SPA-only skip is live, a promote that touches no Lambda input skips
    # `deploy-lambdas` on purpose, and reporting NOT VERIFIED for that would have been the same
    # permanent false alarm in a new place: guaranteed on every SPA-only promote, i.e. the common and
    # cheap case, which is precisely how a report-only check teaches its reader to ignore it.
    #
    # `_lambda_job_state` therefore answers three ways, and the two non-deployed answers are kept
    # apart on purpose. `not-applicable` is a POSITIVE determination — promote succeeded, the job was
    # explicitly skipped, and the skip was decided by LAMBDA_DECISION_STEP, which proves every release
    # function runs a marked build whose Lambda inputs equal this SHA's. So they ARE current.
    # `unverified` still falls through to the standalone-run path exactly as before. Collapsing those
    # two would turn a false alarm into a blind spot, which is worse. (Until OPS-LAMSKIPVSMAIN-001 the
    # skip only meant "inputs equal main's", and main is approved, not deployed — see _lambda_job_state.)
    #
    # OPS-VERIFYINRUNSTALE-001 (2026-09-18): `run_id` is the promote-gate run this check is running
    # INSIDE. The list below holds COMPLETED runs only, and a run is never completed while its own
    # verify job executes, so without run_id the in-promote check never saw its own Lambda legs, fell
    # through to the last standalone deploy-lambda.yml run (2026-08-13) and reported STALE LAMBDA on
    # every promote. The current run is read first and without the head_sha filter: it promotes `sha`
    # by construction, even when dispatched from main (whose head_sha is the pre-FF commit).
    candidates = [("this promote-gate run", run_id)] if run_id else []
    for r in _runs(repo, token, "promote-gate.yml", status="completed"):
        if r.get("head_sha") == sha and str(r.get("id")) != str(run_id):
            candidates.append(("promote-gate run", r["id"]))
    current_not_green = None
    for label, rid in candidates:
        try:
            jobs = _jobs(repo, token, rid)
        except (urllib.error.HTTPError, IncompleteJobList):
            continue  # fall through to the standalone-run path rather than failing the check
        state = _lambda_job_state(jobs)
        if state == LAMBDA_DEPLOYED:
            return True, f"lambda deployed in {label} {rid} on {sha[:10]} (current)"
        if state == LAMBDA_NOT_APPLICABLE:
            return True, (f"lambda deploy correctly SKIPPED in {label} {rid} on {sha[:10]}: its decision "
                          f"step found every release function running a marked build whose Lambda inputs "
                          f"equal this SHA's (SPA-only promote). NOT a deploy — the running Lambdas are "
                          f"current because nothing they are built from moved.")
        if rid == run_id:
            current_not_green = _not_green_lambda_jobs(jobs)
    if current_not_green:
        # This promote's own Lambda deploy did not finish green and no other run for this SHA did. That
        # is decisive, and it names the real legs instead of an unrelated standalone run's history.
        return False, (f"Lambda jobs NOT green in this promote-gate run {run_id} on {sha[:10]}: "
                       f"{', '.join(current_not_green)} — the running Lambdas are not all this SHA's")

    runs = _runs(repo, token, "deploy-lambda.yml", status="completed")
    succ = [r for r in runs if r.get("conclusion") == "success"]
    if not succ:
        return None, "no successful deploy-lambda run found (lambda freshness unverifiable)"
    last = max(succ, key=lambda r: r["created_at"])
    last_sha = last["head_sha"]
    if last_sha == sha:
        return True, f"lambda deploy run {last['id']} ran on {sha[:10]} (current)"
    try:
        cmp = _compare(repo, token, last_sha, sha)
    except urllib.error.HTTPError as e:
        return None, f"could not compare {last_sha[:10]}...{sha[:10]} (HTTP {e.code} — sha not found?); lambda freshness unverifiable"
    status = cmp.get("status")
    if status in ("identical", "behind"):
        return True, f"last lambda deploy {last_sha[:10]} is at/ahead of main (status={status})"
    lam = [f["filename"] for f in cmp.get("files", []) if f["filename"].startswith("lambda/")]
    if lam:
        return False, (f"STALE LAMBDA (L-141): main is {status} last lambda deploy "
                       f"{last_sha[:10]} by {cmp.get('ahead_by')} commit(s) touching lambda/** "
                       f"({len(lam)} file(s), e.g. {lam[0]}) — lambda deploy stranded/cancelled")
    return True, (f"main is {status} last lambda deploy {last_sha[:10]} by "
                  f"{cmp.get('ahead_by')} commit(s), none touching lambda/** (lambda current)")


def verify(repo, token, sha, run_id=None):
    spa_ok, spa_msg = check_spa(repo, token, sha)
    lam_ok, lam_msg = check_lambda_fresh(repo, token, sha, run_id=run_id)
    verified = (spa_ok is True) and (lam_ok is True)
    return {
        "repo": repo,
        "sha": sha,
        "spa_deploy": {"ok": spa_ok, "detail": spa_msg},
        "lambda_fresh": {"ok": lam_ok, "detail": lam_msg},
        "verified": verified,
    }


def _mark(ok):
    return "PASS" if ok is True else ("FAIL" if ok is False else "????")


def main(argv=None):
    ap = argparse.ArgumentParser(description="OPS-VERIFY-001 deploy-success check")
    ap.add_argument("--sha", help="prod SHA to verify (default: live main HEAD)")
    ap.add_argument("--repo", default=DEFAULT_REPO)
    ap.add_argument("--pat")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--run-id", help="the promote-gate run this check runs INSIDE (in-progress, so absent "
                                     "from the completed-run list); promote-gate's verify job passes it")
    args = ap.parse_args(argv)
    token = args.pat or _token()
    if not token:
        print("ERROR: no token (--pat / GH_PAT_OPS / GITHUB_PAT / GH_TOKEN)", file=sys.stderr)
        return 2
    sha = args.sha or resolve_main(args.repo, token)
    res = verify(args.repo, token, sha, run_id=args.run_id)
    if args.json:
        print(json.dumps(res, indent=2))
    else:
        print(f"verify-deploy {args.repo} @ {sha[:10]}")
        for k in ("spa_deploy", "lambda_fresh"):
            print(f"  [{_mark(res[k]['ok'])}] {k}: {res[k]['detail']}")
        print(f"  => {'VERIFIED' if res['verified'] else 'NOT VERIFIED'}")
    if res["verified"]:
        return 0
    if res["spa_deploy"]["ok"] is False or res["lambda_fresh"]["ok"] is False:
        return 1
    return 2


if __name__ == "__main__":
    sys.exit(main())
