#!/usr/bin/env python3
# OPS-SMOKESCRIPT-001 — post-deploy verification for a prod promote.
#
# Every promote has been verified by hand, re-deriving the same checks each time. Two things go
# wrong with that, and only the second is obvious:
#   1. The pre-deploy baseline gets captured inconsistently, or not at all — and the "did the bundle
#      actually change" check is worthless without one taken BEFORE the deploy.
#   2. A check that was skipped looks exactly like a check that passed. There is no artifact
#      afterwards saying which ran.
# So this is two modes with a file between them, and it exits non-zero on any mismatch.
#
#   BEFORE the promote:  python3 scripts/smoke-prod.py baseline --out /tmp/smoke-base.json
#   AFTER  the promote:  python3 scripts/smoke-prod.py verify --version 4.45.0 --sha <dev SHA> \
#                            --baseline /tmp/smoke-base.json --promote-run <promote-gate run id>
#
# --promote-run (BUG-SMOKEPRODLAMBDAWINDOWSKIP-001). promote-gate skips its Lambda deploy when the
# running functions are already proven current for the promoted SHA, which is every client-only
# release. Without the run, "lambda redeploy window" cannot tell that skip from a missed deploy and
# fails 26 of 26 (v4.181.0, run 38077462266). With it, the check reads the run's own jobs to learn
# whether the deploy ran or was skipped, says which, and still checks AWS against that answer.
# Omitted, the check is unchanged: it demands every function redeployed since the baseline.
#
# COULD NOT READ is not FAIL (BUG-SMOKEPRODJOBSPAGE-001). On promote 38467019027 (v4.187.1) GitHub
# answered 502 to the run's jobs at per_page=100 for over ten minutes while per_page=30 read all 33,
# and the check called that a FAIL of the release. The jobs are now read 30 to a page, and a GitHub
# read that did not answer marks the check [COULD NOT READ]: exit 3 when nothing else failed (run
# verify again), exit 1 as before when any check really failed. Still never exit 0.
#
# WHAT IT DOES NOT DO: it does not sign in. Check 6 asserts that an unauthenticated request to an
# authed Lambda is REJECTED, which proves the auth path is live and enforcing. Proving a real login
# works needs a browser and a credential, and a smoke script that carries a credential is a worse
# problem than the one it solves.
#
# Requires: curl-free (urllib only) for the CDN surface, the `aws` CLI for the Lambda checks, and
# the `gh` CLI (signed in) for --promote-run.
# --skip-aws runs the four CDN checks alone, for a machine with no AWS credentials.

import argparse
import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

PROD_ORIGIN = 'https://garden.futureishere.net'
REPO_ROOT = Path(__file__).resolve().parent.parent
DEPLOY_LAMBDA_WF = REPO_ROOT / '.github' / 'workflows' / 'deploy-lambda.yml'
DEFAULT_REPO = 'islanddave/garden-app'
PROMOTE_WF_PATH = '.github/workflows/promote-gate.yml'

# The promote-gate step that decides the Lambda skip from the deploy markers on the RUNNING
# functions. Its name is the only thing in the jobs API that says how a skip was decided, so it must
# equal promote-gate.yml's (and verify-deploy.py's LAMBDA_DECISION_STEP) exactly —
# test_smoke_prod.py pins it against the workflow. Rename all three together.
LAMBDA_DECISION_STEP = 'Decide Lambda deploy from deploy markers on the running functions (pre-FF; fail-closed)'

LAMBDAS_DEPLOYED = 'deployed'
LAMBDAS_SKIPPED = 'skipped'
JOBS_PER_PAGE = 30      # 100 is the size GitHub 502'd on; a promote run has 33 jobs or so
JOBS_MAX_PAGES = 34

# do_verify's third verdict beside True (PASS), False (FAIL) and None (SKIP).
UNREAD = 'could-not-read'

# Network calls are short and this runs right after a deploy — a hung probe reported as a failure is
# better than a smoke run that never returns.
TIMEOUT_S = 20


class CheckFailed(Exception):
    pass


class CheckUnreadable(CheckFailed):
    """The evidence could not be read, so the check has no verdict. Never a pass, and not a FAIL of
    the release either: an outage at GitHub says nothing about what was deployed."""


def fetch(path, want_text=True, with_headers=False):
    """(status, body), or (status, body, {lowercased header name: value}) when with_headers is set."""
    url = path if path.startswith('http') else PROD_ORIGIN + path
    req = urllib.request.Request(url, headers={'Cache-Control': 'no-cache', 'Pragma': 'no-cache'})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
        body = r.read()
        out = (r.status, (body.decode('utf-8', 'replace') if want_text else body))
        if with_headers:
            return out + ({k.lower(): v for k, v in r.headers.items()},)
        return out


# SEC-06a: response headers policy garden-app-security-headers-v1 on the prod distribution. HSTS is
# asserted as a floor, never an exact value: it is 300 s now and is to be raised to a year. The camera
# and microphone must stay allowed for self (photo capture, voice harvest).
HSTS_MIN_MAX_AGE = 300
REQUIRED_HEADERS = (
    ('x-content-type-options', 'nosniff'),
    ('x-frame-options', 'DENY'),
    ('referrer-policy', 'strict-origin-when-cross-origin'),
)
REQUIRED_PERMISSIONS = ('camera=(self)', 'microphone=(self)')
FORBIDDEN_HEADERS = ('x-amz-version-id', 'x-amz-server-side-encryption')


def check_security_headers(headers):
    """Failures (a list of strings, empty when every header holds) for one response's headers."""
    h = {k.lower(): v.strip() for k, v in headers.items()}
    fails = []
    hsts = h.get('strict-transport-security')
    if hsts is None:
        fails.append('strict-transport-security missing')
    else:
        m = re.search(r'(?:^|;)\s*max-age\s*=\s*"?(\d+)"?', hsts, re.I)
        if not m or int(m.group(1)) < HSTS_MIN_MAX_AGE:
            fails.append(f'strict-transport-security {hsts!r}: max-age must be at least {HSTS_MIN_MAX_AGE}')
    for name, want in REQUIRED_HEADERS:
        got = h.get(name)
        if got is None:
            fails.append(f'{name} missing')
        elif got.lower() != want.lower():
            fails.append(f'{name} is {got!r}, expected {want!r}')
    perms = h.get('permissions-policy')
    if perms is None:
        fails.append('permissions-policy missing')
    else:
        directives = {d.strip().replace(' ', '') for d in perms.split(',')}
        lost = [p for p in REQUIRED_PERMISSIONS if p not in directives]
        if lost:
            fails.append(f'permissions-policy {perms!r} lacks {", ".join(lost)}')
    fails += [f'{name} present (an S3 header that should be stripped)' for name in FORBIDDEN_HEADERS if name in h]
    return fails


def bundle_hash(index_html):
    """The hashed main bundle filename. Vite renames it on every content change, so it is the
    cheapest honest answer to 'did new code actually reach the CDN'."""
    m = re.search(r'assets/index-([A-Za-z0-9_-]+)\.js', index_html)
    if not m:
        raise CheckFailed('no assets/index-<hash>.js reference in index.html')
    return m.group(1)


def cache_version(sw_js):
    """sw.js CACHE_VERSION, which deploy.yml rewrites to v{version}-{short sha} per deploy.
    Anchored to a line start so the explanatory comment naming the same token cannot match."""
    m = re.search(r"^const CACHE_VERSION\s*=\s*'([^']+)'", sw_js, re.M)
    if not m:
        raise CheckFailed('no `const CACHE_VERSION = ...` line in sw.js')
    return m.group(1)


def head_release_version(releases_json):
    data = json.loads(releases_json)
    if not isinstance(data, list) or not data:
        raise CheckFailed('releases.json is not a non-empty array')
    v = data[0].get('version')
    if not v:
        raise CheckFailed('releases.json head entry has no version')
    return v


def latest_release_version(latest_json):
    """V4-PERFTHEMEA-001. /releases-latest.json is releases.json[0] alone — the object
    useAppUpdate.js's version probe reads instead of re-downloading 141 KB of history.

    This check has to exist because its failure mode is invisible from the app: CloudFront maps
    404 to 200 /index.html on this distribution, so an object that never reached S3 answers the
    probe with the HTML shell at HTTP 200. r.json() throws, the hook swallows it by design, and
    the client silently stops learning about updates forever — BUG-STALECLIENT-002 with no
    symptom. json.loads on HTML raises here, which is the point."""
    try:
        data = json.loads(latest_json)
    except json.JSONDecodeError:
        raise CheckFailed('releases-latest.json is not JSON (a 404 served as the SPA shell '
                          'looks exactly like this — check the object reached S3)')
    if not isinstance(data, dict):
        raise CheckFailed(f'releases-latest.json is a {type(data).__name__}, not an object')
    v = data.get('version')
    if not v:
        raise CheckFailed('releases-latest.json has no version')
    return v


def matrix_functions(workflow_text):
    """The 26 function names deploy-lambda.yml actually deploys.

    Parsed from the workflow rather than from `ls lambda/`, because the matrix is what runs. Those
    two sets disagreeing is itself a defect — a lambda/ directory with no matrix entry never
    deploys, silently — so check_matrix_covers_dirs asserts they match."""
    m = re.search(r'^\s*function:\s*\[([^\]]*)\]', workflow_text, re.M)
    if not m:
        raise CheckFailed('no `function: [...]` matrix in deploy-lambda.yml')
    return [x.strip() for x in m.group(1).split(',') if x.strip()]


def aws_lambda_last_modified(names):
    """{name: datetime} for garden-<name>. One list-functions call, not N get-function calls."""
    out = subprocess.run(
        ['aws', 'lambda', 'list-functions', '--region', 'us-east-1',
         '--query', 'Functions[].{n:FunctionName,m:LastModified}', '--output', 'json'],
        capture_output=True, text=True, timeout=120,
    )
    if out.returncode != 0:
        raise CheckFailed('aws lambda list-functions failed: ' + (out.stderr or '').strip()[:200])
    live = {f['n']: f['m'] for f in json.loads(out.stdout)}
    found = {}
    for n in names:
        key = 'garden-' + n
        if key not in live:
            raise CheckFailed(f'{key} does not exist in us-east-1')
        found[key] = datetime.strptime(live[key], '%Y-%m-%dT%H:%M:%S.%f%z')
    return found


def parse_iso(s):
    return datetime.fromisoformat(s.replace('Z', '+00:00'))


def gh_api(path):
    """GET one GitHub API path through the `gh` CLI, so the operator's own sign-in is the auth and
    this script still carries no credential."""
    try:
        out = subprocess.run(['gh', 'api', path], capture_output=True, text=True, timeout=60)
    except FileNotFoundError:
        raise CheckFailed('the `gh` CLI is not installed, so the promote run cannot be read')
    except subprocess.TimeoutExpired:
        raise CheckUnreadable(f'gh api {path} did not answer in 60 s')
    if out.returncode != 0:
        why = f'gh api {path} failed: ' + (out.stderr or out.stdout or '').strip()[:200]
        # 404 is an answer (no such run: the operator's id is wrong). Anything else is GitHub or
        # the network not answering, which is not a verdict on the release.
        raise (CheckFailed if 'HTTP 404' in why else CheckUnreadable)(why)
    try:
        return json.loads(out.stdout)
    except json.JSONDecodeError:
        raise CheckUnreadable(f'gh api {path} answered with something that is not JSON')


def promote_run_lambda_evidence(repo, run_id, sha, names):
    """(LAMBDAS_DEPLOYED | LAMBDAS_SKIPPED, the evidence in words) for one promote-gate run.

    Fails closed: anything short of a positive reading raises. A run that answered and is wrong
    (another workflow, another SHA, a failed leg, an unproven skip) raises CheckFailed, a FAIL; one
    GitHub did not hand over whole raises CheckUnreadable, which the caller reports as COULD NOT READ.
    The run must be a promote-gate run of `sha` — promote-gate's `resolve` job refuses unless the
    run's own commit is the dev_sha it promotes, so head_sha IS the promoted commit.

    The two positive readings are the ones GitHub reports unambiguously (same reading as
    verify-deploy.py's _lambda_job_state):
      deployed — the called workflow ran, so there are 'deploy-lambdas / deploy (<function>)' jobs.
                 Every matrix function must have one and every one must have succeeded.
      skipped  — a bare 'deploy-lambdas' job with conclusion 'skipped', AND `promote` succeeded
                 (deploy-lambdas is also skipped when promote FAILS), AND promote ran
                 LAMBDA_DECISION_STEP to success (a skip decided any other way proves nothing
                 about the running functions).
    A job list shorter than its own total_count is unreadable, not "no Lambda jobs"."""
    if len(sha) < 7:
        raise CheckFailed(f'--sha {sha!r} is too short to bind a promote run to (need 7+ characters)')
    try:
        run = gh_api(f'repos/{repo}/actions/runs/{run_id}')
        if run.get('path') != PROMOTE_WF_PATH:
            raise CheckFailed(f"it is a {run.get('path')!r} run, not {PROMOTE_WF_PATH}")
        head = run.get('head_sha') or ''
        if not head.lower().startswith(sha.lower()):
            raise CheckFailed(f'it promoted {head[:10] or "an unknown commit"}, not --sha {sha[:10]}')
        jobs, total = [], None
        for page in range(1, JOBS_MAX_PAGES + 1):
            body = gh_api(f'repos/{repo}/actions/runs/{run_id}/jobs?per_page={JOBS_PER_PAGE}&page={page}')
            batch = body.get('jobs') or []
            total = body.get('total_count')
            jobs.extend(batch)
            if not batch or not isinstance(total, int) or len(jobs) >= total:
                break
        if not isinstance(total, int) or len(jobs) != total:
            raise CheckUnreadable(f'read {len(jobs)} job(s) but the API reports total_count={total!r}')
    except CheckUnreadable as e:
        raise CheckUnreadable(f'promote run {run_id} could not be read (run verify again): {e}')
    except CheckFailed as e:
        raise CheckFailed(f'promote run {run_id} is not usable as evidence: {e}')
    except Exception as e:                          # noqa: BLE001 - a malformed answer is unreadable
        raise CheckUnreadable(
            f'promote run {run_id} could not be read (run verify again): {type(e).__name__}: {e}')

    def named(n):
        return next((j for j in jobs if (j.get('name') or '').strip() == n), None)

    legs = {}
    for j in jobs:
        m = re.fullmatch(r'deploy-lambdas / deploy \((.+)\)', (j.get('name') or '').strip())
        if m:
            legs[m.group(1)] = j.get('conclusion') or j.get('status')
    if legs:
        bad = sorted(f'{n}={c}' for n, c in legs.items() if c != 'success')
        missing = sorted(set(names) - set(legs))
        if bad or missing:
            raise CheckFailed(
                f'promote run {run_id} ran the Lambda deploy but not cleanly: '
                + '; '.join(x for x in (
                    'legs not successful: ' + ', '.join(bad[:6]) + ('...' if len(bad) > 6 else '') if bad else '',
                    'no leg for: ' + ', '.join(missing[:6]) + ('...' if len(missing) > 6 else '') if missing else '',
                ) if x))
        return LAMBDAS_DEPLOYED, f'promote run {run_id}: {len(legs)} deploy-lambdas legs succeeded'

    caller, promote = named('deploy-lambdas'), named('promote')
    c_caller = caller.get('conclusion') if caller else 'absent'
    c_promote = promote.get('conclusion') if promote else 'absent'
    decided = promote is not None and any(
        s.get('name') == LAMBDA_DECISION_STEP and s.get('conclusion') == 'success'
        for s in (promote.get('steps') or []))
    if c_caller == 'skipped' and c_promote == 'success' and decided:
        return LAMBDAS_SKIPPED, (f'promote run {run_id}: promote succeeded, deploy-lambdas job skipped, '
                                 f'decided by step "{LAMBDA_DECISION_STEP}"')
    raise CheckFailed(
        f'promote run {run_id} shows neither a Lambda deploy nor a proven skip: promote={c_promote}, '
        f'deploy-lambdas={c_caller}, marker decision step '
        + ('succeeded' if decided else 'did not succeed'))


def lambda_window_detail(mods, since, captured_at, evidence=None):
    """The 'lambda redeploy window' verdict, from {function: LastModified} and what the promote run
    said. Three cases, and the detail names which one it saw:
      no evidence, or the run DEPLOYED — every function must be redeployed since the baseline.
      the run SKIPPED the deploy       — pass, and hold the run to its word: NO function may have
                                         been modified since the baseline, because the promote did
                                         not deploy any, so one that moved was changed by something
                                         else."""
    state, why = evidence or (None, None)
    if state == LAMBDAS_SKIPPED:
        moved = sorted(n for n, t in mods.items() if t >= since)
        if moved:
            raise CheckFailed(
                f'{why} — but {len(moved)} of {len(mods)} were modified since baseline by something '
                'other than this promote: ' + ', '.join(moved[:6]) + ('...' if len(moved) > 6 else ''))
        return (f'Lambda deploy SKIPPED by the promote (nothing changed) — evidence: {why}; '
                f'verified none of {len(mods)} modified since {captured_at}')
    stale = sorted(n for n, t in mods.items() if t < since)
    if stale:
        # The failure that matters: a re-dispatched promote after main moved skips ALL Lambdas
        # unless force_lambda is set, and the SPA still updates — so the site looks deployed.
        raise CheckFailed(
            f'{len(stale)} of {len(mods)} not redeployed since baseline: ' + ', '.join(stale[:6])
            + ('...' if len(stale) > 6 else '')
            + (f' — although {why}' if why else
               ' (if this promote skipped its Lambda deploy, pass --promote-run <run id> to prove it)'))
    return (f'all {len(mods)} redeployed since {captured_at}'
            + (f' — evidence: {why}' if why else ''))


# ── modes ────────────────────────────────────────────────────────────────────────────────────────

def do_baseline(args):
    _, index_html = fetch('/')
    _, releases = fetch('/releases.json')
    _, sw = fetch('/sw.js')
    base = {
        # UTC and explicit: check 5 compares Lambda LastModified against this instant, and a naive
        # local timestamp would silently pass or fail by the offset.
        'captured_at': datetime.now(timezone.utc).isoformat(),
        'bundle_hash': bundle_hash(index_html),
        'version': head_release_version(releases),
        'cache_version': cache_version(sw),
    }
    text = json.dumps(base, indent=2)
    if args.out:
        Path(args.out).write_text(text + '\n')
        print(f'baseline written to {args.out}')
    print(text)
    return 0


def do_verify(args):
    base = json.loads(Path(args.baseline).read_text())
    short_sha = args.sha[:7]
    results = []

    def check(name, fn):
        try:
            detail = fn()
            results.append((True, name, detail))
        except CheckUnreadable as e:
            results.append((UNREAD, name, str(e)))
        except Exception as e:                      # noqa: BLE001 - any failure is a failed check
            results.append((False, name, str(e)))

    def c_shell():
        status, html = fetch('/')
        if status != 200:
            raise CheckFailed(f'GET / returned {status}')
        return f'GET / 200, {len(html)} bytes'

    def c_headers():
        _, _, headers = fetch('/', with_headers=True)
        fails = check_security_headers(headers)
        if fails:
            raise CheckFailed('; '.join(fails) + ' (source: CloudFront response headers policy '
                              'garden-app-security-headers-v1 on E3FAJTXAORQYDT, live CDN config, not this '
                              'release; re-attach it, or change REQUIRED_* here in the same change as a '
                              'deliberate policy edit)')
        return f"{headers.get('strict-transport-security')}, {len(REQUIRED_HEADERS) + 1} more required, " \
               f'{len(FORBIDDEN_HEADERS)} S3 headers absent'

    def c_bundle():
        _, html = fetch('/')
        now = bundle_hash(html)
        if now == base['bundle_hash']:
            raise CheckFailed(
                f'bundle hash unchanged ({now}) — the deploy did not reach the CDN, or the '
                'invalidation has not landed')
        return f"{base['bundle_hash']} -> {now}"

    def c_release():
        _, releases = fetch('/releases.json')
        got = head_release_version(releases)
        if got != args.version:
            raise CheckFailed(f'releases.json head is {got}, expected {args.version}')
        return got

    def c_release_latest():
        _, latest = fetch('/releases-latest.json')
        got = latest_release_version(latest)
        if got != args.version:
            raise CheckFailed(f'releases-latest.json is {got}, expected {args.version} — the '
                              'version probe would report a different release than /releases')
        return got

    def c_sw():
        _, sw = fetch('/sw.js')
        got = cache_version(sw)
        want = f'v{args.version}-{short_sha}'
        if got != want:
            raise CheckFailed(f'CACHE_VERSION is {got}, expected {want}')
        return got

    def c_lambdas():
        names = matrix_functions(DEPLOY_LAMBDA_WF.read_text())
        since = parse_iso(base['captured_at'])
        # Read the run BEFORE AWS: a wrong run is the failure and an unreadable one leaves the
        # check without a verdict, whatever AWS says.
        evidence = (promote_run_lambda_evidence(args.repo, args.promote_run, args.sha, names)
                    if args.promote_run else None)
        mods = aws_lambda_last_modified(names)
        return lambda_window_detail(mods, since, base['captured_at'], evidence)

    def c_matrix_covers_dirs():
        names = set(matrix_functions(DEPLOY_LAMBDA_WF.read_text()))
        dirs = {p.name for p in (REPO_ROOT / 'lambda').iterdir()
                if p.is_dir() and (p / 'package.json').exists()}
        missing = sorted(dirs - names)
        if missing:
            raise CheckFailed('lambda dirs with NO deploy-matrix entry (they never ship): '
                              + ', '.join(missing))
        return f'{len(names)} matrix entries cover {len(dirs)} lambda dirs'

    def c_auth():
        """An authed Lambda must REJECT an unauthenticated request. A 200 here would mean the auth
        path is not enforcing, which is a far worse outcome than a failed deploy."""
        out = subprocess.run(
            ['aws', 'lambda', 'get-function-url-config', '--function-name', 'garden-plants',
             '--region', 'us-east-1', '--query', 'FunctionUrl', '--output', 'text'],
            capture_output=True, text=True, timeout=60)
        if out.returncode != 0:
            raise CheckFailed('could not resolve garden-plants function URL')
        url = out.stdout.strip().rstrip('/') + '/api/plants'
        try:
            status, _ = fetch(url)
        except urllib.error.HTTPError as e:
            status = e.code
        if status not in (401, 403):
            raise CheckFailed(f'unauthenticated GET returned {status}, expected 401/403')
        return f'unauthenticated GET -> {status}'

    check('shell 200', c_shell)
    check('security headers', c_headers)
    check('bundle hash changed', c_bundle)
    check('releases.json head version', c_release)
    check('releases-latest.json version', c_release_latest)
    check('sw.js CACHE_VERSION', c_sw)
    check('deploy matrix covers every lambda dir', c_matrix_covers_dirs)
    if args.skip_aws:
        results.append((None, 'lambda redeploy window', 'SKIPPED (--skip-aws)'))
        results.append((None, 'auth path enforcing', 'SKIPPED (--skip-aws)'))
    else:
        check('lambda redeploy window', c_lambdas)
        check('auth path enforcing', c_auth)

    print(f'\nsmoke-prod: expecting v{args.version} @ {short_sha}\n')
    for ok, name, detail in results:
        mark = ('SKIP' if ok is None else 'COULD NOT READ' if ok is UNREAD
                else 'PASS' if ok is True else 'FAIL')
        print(f'  [{mark}] {name}: {detail}')

    failed = [r for r in results if r[0] is False]
    skipped = [r for r in results if r[0] is None]
    unread = [r for r in results if r[0] is UNREAD]
    print()
    if failed:
        print(f'❌ smoke FAILED — {len(failed)} of {len(results)} checks'
              + (f' ({len(unread)} more could not be read)' if unread else ''))
        return 1
    if unread:
        # Not a pass and not a failure of the release: the evidence did not arrive. Its own exit
        # code, so a caller can tell "run it again" from "look at prod".
        print(f'⚠️  smoke INCOMPLETE — {len(unread)} of {len(results)} checks could not be read, '
              'none failed. Run verify again.')
        return 3
    # A skip is reported in the exit code's company, never silently: the whole point of this script
    # is that a check which did not run must not look like one that passed.
    print(f'✅ smoke PASSED — {len(results) - len(skipped)} checks'
          + (f', {len(skipped)} SKIPPED' if skipped else ''))
    return 0


def main():
    ap = argparse.ArgumentParser(description='Post-deploy prod smoke verification (OPS-SMOKESCRIPT-001)')
    sub = ap.add_subparsers(dest='mode', required=True)

    b = sub.add_parser('baseline', help='capture pre-deploy state (run BEFORE the promote)')
    b.add_argument('--out', help='write the baseline JSON here')

    v = sub.add_parser('verify', help='verify post-deploy state (run AFTER the promote)')
    v.add_argument('--version', required=True, help='expected package.json version, e.g. 4.45.0')
    v.add_argument('--sha', required=True, help='promoted commit SHA (full or short)')
    v.add_argument('--baseline', required=True, help='baseline JSON from the baseline mode')
    v.add_argument('--skip-aws', action='store_true', help='skip the two checks needing AWS creds')
    v.add_argument('--promote-run', metavar='RUN_ID',
                   help='the promote-gate run id that shipped --sha. Lets "lambda redeploy window" '
                        'tell a Lambda deploy the promote SKIPPED (nothing changed: pass, verified '
                        'against AWS) from one it ran (all functions must be redeployed). Read with '
                        '`gh api`; a run for another SHA fails the check, and one GitHub will '
                        'not hand over reads COULD NOT READ (exit 3: run verify again). '
                        'Omitted: every function must be redeployed since the baseline.')
    v.add_argument('--repo', default=DEFAULT_REPO, help=f'owner/name for --promote-run (default {DEFAULT_REPO})')

    args = ap.parse_args()
    try:
        return do_baseline(args) if args.mode == 'baseline' else do_verify(args)
    except Exception as e:                          # noqa: BLE001
        print(f'❌ smoke could not run: {e}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
