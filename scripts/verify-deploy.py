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


def _jobs(repo, token, run_id):
    return gh(f"/repos/{repo}/actions/runs/{run_id}/jobs", token, {"per_page": 50}).get("jobs", [])


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
    for r in sorted(_runs(repo, token, "promote-gate.yml"), key=lambda r: r["created_at"], reverse=True):
        if r.get("head_sha") == sha:
            res = _deploy_job_ok(_jobs(repo, token, r["id"]))
            if res is True:
                return True, f"promote-gate run {r['id']}: SPA deploy job success"
            if res is False:
                return False, f"promote-gate run {r['id']}: SPA deploy job FAILED (L-161 — check CloudFront invalidation step)"
            break
    for r in sorted(_runs(repo, token, "deploy.yml"), key=lambda r: r["created_at"], reverse=True):
        if r.get("head_sha") == sha:
            res = _deploy_job_ok(_jobs(repo, token, r["id"]))
            if res is True:
                return True, f"deploy.yml run {r['id']}: SPA deploy job success"
            if res is False:
                return False, f"deploy.yml run {r['id']}: SPA deploy job FAILED"
            return None, f"deploy.yml run {r['id']}: deploy job indeterminate"
    return None, f"no promote-gate/deploy run found with head_sha={sha[:10]} (SPA deploy unverified)"


def _compare(repo, token, base, head):
    return gh(f"/repos/{repo}/compare/{base}...{head}", token)


def check_lambda_fresh(repo, token, sha):
    runs = _runs(repo, token, "deploy-lambda.yml", status="completed")
    succ = [r for r in runs if r.get("conclusion") == "success"]
    if not succ:
        return None, "no successful deploy-lambda run found (lambda freshness unverifiable)"
    last = max(succ, key=lambda r: r["created_at"])
    last_sha = last["head_sha"]
    if last_sha == sha:
        return True, f"lambda deploy run {last['id']} ran on {sha[:10]} (current)"
    cmp = _compare(repo, token, last_sha, sha)
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


def verify(repo, token, sha):
    spa_ok, spa_msg = check_spa(repo, token, sha)
    lam_ok, lam_msg = check_lambda_fresh(repo, token, sha)
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
    args = ap.parse_args(argv)
    token = args.pat or _token()
    if not token:
        print("ERROR: no token (--pat / GH_PAT_OPS / GITHUB_PAT / GH_TOKEN)", file=sys.stderr)
        return 2
    sha = args.sha or resolve_main(args.repo, token)
    res = verify(args.repo, token, sha)
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
