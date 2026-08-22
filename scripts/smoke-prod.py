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
#                            --baseline /tmp/smoke-base.json
#
# WHAT IT DOES NOT DO: it does not sign in. Check 6 asserts that an unauthenticated request to an
# authed Lambda is REJECTED, which proves the auth path is live and enforcing. Proving a real login
# works needs a browser and a credential, and a smoke script that carries a credential is a worse
# problem than the one it solves.
#
# Requires: curl-free (urllib only) for the CDN surface, and the `aws` CLI for the Lambda checks.
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

# Network calls are short and this runs right after a deploy — a hung probe reported as a failure is
# better than a smoke run that never returns.
TIMEOUT_S = 20


class CheckFailed(Exception):
    pass


def fetch(path, want_text=True):
    url = path if path.startswith('http') else PROD_ORIGIN + path
    req = urllib.request.Request(url, headers={'Cache-Control': 'no-cache', 'Pragma': 'no-cache'})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
        body = r.read()
        return r.status, (body.decode('utf-8', 'replace') if want_text else body)


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
        except Exception as e:                      # noqa: BLE001 - any failure is a failed check
            results.append((False, name, str(e)))

    def c_shell():
        status, html = fetch('/')
        if status != 200:
            raise CheckFailed(f'GET / returned {status}')
        return f'GET / 200, {len(html)} bytes'

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
        mods = aws_lambda_last_modified(names)
        stale = sorted(n for n, t in mods.items() if t < since)
        if stale:
            # The failure that matters: a re-dispatched promote after main moved skips ALL Lambdas
            # unless force_lambda is set, and the SPA still updates — so the site looks deployed.
            raise CheckFailed(
                f'{len(stale)} of {len(mods)} not redeployed since baseline: ' + ', '.join(stale[:6])
                + ('...' if len(stale) > 6 else ''))
        return f'all {len(mods)} redeployed since {base["captured_at"]}'

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
    check('bundle hash changed', c_bundle)
    check('releases.json head version', c_release)
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
        mark = 'SKIP' if ok is None else ('PASS' if ok else 'FAIL')
        print(f'  [{mark}] {name}: {detail}')

    failed = [r for r in results if r[0] is False]
    skipped = [r for r in results if r[0] is None]
    print()
    if failed:
        print(f'❌ smoke FAILED — {len(failed)} of {len(results)} checks')
        return 1
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

    args = ap.parse_args()
    try:
        return do_baseline(args) if args.mode == 'baseline' else do_verify(args)
    except Exception as e:                          # noqa: BLE001
        print(f'❌ smoke could not run: {e}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
