#!/usr/bin/env python3
# Unit coverage for scripts/smoke-prod.py's parsers. The network/AWS modes are exercised by running
# the script against real prod; these pin the parsing, which is where a silent wrong answer lives.
#
# The parsers matter more than they look. Each one turns a fetched document into a single value that
# a check then compares — so a parser that matches the WRONG thing produces a confident PASS against
# a surface that never changed. That is the failure this whole script exists to prevent, so it must
# not be reintroduced inside it.

import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import importlib.util

spec = importlib.util.spec_from_file_location(
    'smoke_prod', Path(__file__).resolve().parent / 'smoke-prod.py')
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class TestBundleHash:
    def test_extracts_the_vite_hash(self):
        html = '<script type="module" crossorigin src="/assets/index-D0sD3Xqs.js"></script>'
        assert smoke.bundle_hash(html) == 'D0sD3Xqs'

    def test_raises_when_absent_rather_than_returning_none(self):
        # A None here would compare unequal to the baseline and report a PASS for "bundle changed"
        # on a page that has no bundle at all.
        with pytest.raises(smoke.CheckFailed):
            smoke.bundle_hash('<html><body>nothing</body></html>')


class TestCacheVersion:
    # THE TRAP. prod sw.js carries a comment naming this same token two lines above the constant
    # ("// CACHE_VERSION should be updated with each deploy"), and the repo base default is itself a
    # quoted version string that comments have cited by example. A loose
    # r"CACHE_VERSION.*?\'([^\']+)\'" reads whichever quoted token comes FIRST and would return the
    # example — a confident wrong answer, which is exactly the class this whole script exists to
    # prevent and so must not be reintroduced inside it. Anchoring to `^const` is the fix.
    #
    # The fixture is deliberately adversarial. An earlier version put no quoted token in the comment
    # and the un-anchored mutant PASSED it; a trap test whose fixture springs no trap is decoration.
    def test_ignores_a_comment_that_quotes_a_version_before_the_constant(self):
        sw = (
            "// CACHE_VERSION should be updated per deploy; base default is \'v16-20260524\'.\n"
            "const CACHE_VERSION = \'v4.43.0-28a7f50\' // deploy workflows rewrite this per deploy\n"
            "const STATIC_CACHE  = `static-${CACHE_VERSION}`\n"
        )
        assert smoke.cache_version(sw) == "v4.43.0-28a7f50"

    def test_raises_when_the_constant_is_missing(self):
        with pytest.raises(smoke.CheckFailed):
            smoke.cache_version('// CACHE_VERSION should be updated with each deploy.\n')

    def test_matches_the_shape_deploy_writes(self):
        # v{version}-{short sha}: the exact string the verify check builds and compares against.
        got = smoke.cache_version("const CACHE_VERSION = 'v4.45.0-27364bd'\n")
        assert re.fullmatch(r'v\d+\.\d+\.\d+-[0-9a-f]{7}', got)


class TestReleaseVersion:
    def test_reads_the_head_entry(self):
        assert smoke.head_release_version('[{"version":"4.45.0"},{"version":"4.44.0"}]') == '4.45.0'

    def test_rejects_an_empty_array(self):
        with pytest.raises(smoke.CheckFailed):
            smoke.head_release_version('[]')

    def test_rejects_a_head_entry_with_no_version(self):
        with pytest.raises(smoke.CheckFailed):
            smoke.head_release_version('[{"date":"2026-08-22"}]')


class TestMatrixFunctions:
    def test_parses_the_workflow_matrix(self):
        wf = "    strategy:\n      matrix:\n        function: [projects, plants, events]\n"
        assert smoke.matrix_functions(wf) == ['projects', 'plants', 'events']

    def test_raises_when_the_matrix_is_gone(self):
        with pytest.raises(smoke.CheckFailed):
            smoke.matrix_functions('jobs:\n  deploy:\n    runs-on: ubuntu-latest\n')

    def test_reads_the_REAL_workflow_and_covers_every_lambda_dir(self):
        # Not a fixture: the live file. This is the same assertion check 5 makes at runtime, pinned
        # here so adding a lambda/ directory without a matrix entry fails in CI rather than at the
        # next promote — a lambda with no matrix entry never deploys, and nothing else notices.
        root = Path(__file__).resolve().parent.parent
        names = set(smoke.matrix_functions((root / '.github/workflows/deploy-lambda.yml').read_text()))
        dirs = {p.name for p in (root / 'lambda').iterdir()
                if p.is_dir() and (p / 'package.json').exists()}
        assert dirs - names == set(), f'lambda dirs never deployed: {sorted(dirs - names)}'
        assert len(names) >= 26


class TestParseIso:
    def test_handles_the_z_suffix_and_stays_tz_aware(self):
        # Naive-vs-aware is the whole game for the Lambda window check: comparing a naive local
        # timestamp against an aware AWS one raises, and comparing two naives silently passes or
        # fails by the UTC offset.
        d = smoke.parse_iso('2026-08-22T05:47:36.789634+00:00')
        assert d.tzinfo is not None
        z = smoke.parse_iso('2026-08-22T05:47:36Z')
        assert z.tzinfo is not None


# ── lambda redeploy window vs the promote run (BUG-SMOKEPRODLAMBDAWINDOWSKIP-001) ──────────────────
#
# Recorded, not invented: 38077462266 is the v4.181.0 promote (client-only, deploy-lambdas SKIPPED,
# the run this check called FAIL 26 of 26) and 38013419164 is v4.179.0 (all 26 legs ran). The whole
# verify mode runs here with its three outside surfaces replaced — the CDN, AWS and `gh api` — so
# what is pinned is the line an operator reads and the exit code, not a helper's return value.

import argparse
import json
import urllib.error
from datetime import datetime, timedelta, timezone

FIXTURES = Path(__file__).resolve().parent / 'fixtures'
ROOT = Path(__file__).resolve().parent.parent
SKIP_RUN, SKIP_SHA = '38077462266', 'fe89add37399f3d6d61ceabfb18cd6a753e93702'
DEPLOY_RUN, DEPLOY_SHA = '38013419164', '2dbe00f8ac4df9d6acf88a52c0c6c2c33db95d1b'
BASELINE_AT = datetime(2026, 10, 10, 18, 45, tzinfo=timezone.utc)
BEFORE, AFTER = BASELINE_AT - timedelta(days=1), BASELINE_AT + timedelta(minutes=9)


def recorded(run_id, mutate=None, seen=None):
    """A stand-in for smoke.gh_api that answers from one recorded promote run. The recording is
    one page of every job; it is served at whatever page size is asked for, as GitHub does, and
    `seen` collects the paths read."""
    rec = json.loads((FIXTURES / f'smoke-prod-promote-run-{run_id}.json').read_text())
    if mutate:
        mutate(rec)

    def gh_api(path):
        if seen is not None:
            seen.append(path)
        if path == f'repos/islanddave/garden-app/actions/runs/{run_id}':
            return rec['run']
        m = re.fullmatch(rf'repos/islanddave/garden-app/actions/runs/{run_id}/jobs\?per_page=(\d+)&page=(\d+)', path)
        assert m, f'unexpected GitHub read: {path}'
        jobs = [j for page in rec['jobs_pages'] for j in page['jobs']]
        size, n = int(m.group(1)), int(m.group(2))
        return {'total_count': rec['jobs_pages'][0]['total_count'], 'jobs': jobs[(n - 1) * size:n * size]}
    return gh_api


LAST = {}   # the whole of the last run_verify's output, for the tests that read the summary line


def run_verify(monkeypatch, tmp_path, capsys, *, sha, version, modified, promote_run=None, gh=None):
    """do_verify with every CDN check green, so the exit code is the Lambda window's alone.
    `modified` is {function: LastModified} overrides on top of 'everything predates the baseline'."""
    names = smoke.matrix_functions((ROOT / '.github/workflows/deploy-lambda.yml').read_text())
    base = tmp_path / 'base.json'
    base.write_text(json.dumps({'captured_at': BASELINE_AT.isoformat(), 'bundle_hash': 'OLDhash0',
                                'version': '0.0.0', 'cache_version': 'v0.0.0-0000000'}))

    def fetch(path, want_text=True):
        if path == '/':
            return 200, '<script src="/assets/index-NEWhash1.js"></script>'
        if path == '/releases.json':
            return 200, json.dumps([{'version': version}])
        if path == '/releases-latest.json':
            return 200, json.dumps({'version': version})
        if path == '/sw.js':
            return 200, f"const CACHE_VERSION = 'v{version}-{sha[:7]}'\n"
        raise urllib.error.HTTPError(path, 401, 'Unauthorized', None, None)

    def aws(wanted):
        mods = {'garden-' + n: BEFORE for n in wanted}
        mods.update(modified(wanted) if callable(modified) else modified)
        return mods

    class Done:
        returncode, stdout, stderr = 0, 'https://example.lambda-url.us-east-1.on.aws/\n', ''

    def no_gh(path):
        raise AssertionError(f'GitHub was read without --promote-run: {path}')

    monkeypatch.setattr(smoke, 'fetch', fetch)
    monkeypatch.setattr(smoke, 'aws_lambda_last_modified', aws)
    monkeypatch.setattr(smoke.subprocess, 'run', lambda *a, **k: Done())
    monkeypatch.setattr(smoke, 'gh_api', gh or no_gh, raising=False)
    args = argparse.Namespace(mode='verify', version=version, sha=sha, baseline=str(base),
                              skip_aws=False, promote_run=promote_run, repo='islanddave/garden-app')
    rc = smoke.do_verify(args)
    out = capsys.readouterr().out
    LAST['out'] = out
    line = next(l for l in out.splitlines() if 'lambda redeploy window' in l)
    return rc, line, len(names)


def all_redeployed(names):
    return {'garden-' + n: AFTER for n in names}


class TestLambdaWindowAgainstThePromoteRun:
    def test_case_1_the_promote_deployed_and_every_function_moved(self, monkeypatch, tmp_path, capsys):
        rc, line, n = run_verify(monkeypatch, tmp_path, capsys, sha=DEPLOY_SHA, version='4.179.0',
                                 modified=all_redeployed, promote_run=DEPLOY_RUN, gh=recorded(DEPLOY_RUN))
        assert rc == 0
        assert '[PASS]' in line and f'all {n} redeployed since' in line
        assert f'promote run {DEPLOY_RUN}: {n} deploy-lambdas legs succeeded' in line

    def test_case_2_the_promote_skipped_the_deploy_and_nothing_moved(self, monkeypatch, tmp_path, capsys):
        # THE DEFECT: v4.181.0 exactly. No function moved because the promote proved them current
        # and skipped the deploy. This read FAIL "26 of 26 not redeployed since baseline".
        rc, line, n = run_verify(monkeypatch, tmp_path, capsys, sha=SKIP_SHA, version='4.181.0',
                                 modified={}, promote_run=SKIP_RUN, gh=recorded(SKIP_RUN))
        assert rc == 0
        assert '[PASS]' in line and 'SKIPPED by the promote' in line
        # ...and it names its evidence, and says what it checked rather than what it was told.
        assert f'promote run {SKIP_RUN}' in line and 'deploy-lambdas job skipped' in line
        assert smoke.LAMBDA_DECISION_STEP in line
        assert f'verified none of {n} modified since' in line

    def test_case_2_is_held_to_its_word_a_function_that_moved_anyway_fails(self, monkeypatch, tmp_path, capsys):
        # The run says nothing was deployed, so a function modified in the window was changed by
        # something else. A skip must not turn the AWS half of the check off.
        rc, line, _ = run_verify(monkeypatch, tmp_path, capsys, sha=SKIP_SHA, version='4.181.0',
                                 modified={'garden-plants': AFTER}, promote_run=SKIP_RUN, gh=recorded(SKIP_RUN))
        assert rc == 1
        assert '[FAIL]' in line and 'garden-plants' in line and 'something other than this promote' in line

    def test_case_3_the_promote_deployed_but_a_function_did_not_move(self, monkeypatch, tmp_path, capsys):
        def one_stale(names):
            return {k: v for k, v in all_redeployed(names).items() if k != 'garden-plants'}
        rc, line, n = run_verify(monkeypatch, tmp_path, capsys, sha=DEPLOY_SHA, version='4.179.0',
                                 modified=one_stale, promote_run=DEPLOY_RUN, gh=recorded(DEPLOY_RUN))
        assert rc == 1
        assert '[FAIL]' in line and f'1 of {n} not redeployed since baseline: garden-plants' in line

    def test_case_3_without_a_run_nothing_moved_still_fails_as_before(self, monkeypatch, tmp_path, capsys):
        # No --promote-run = no evidence of a skip = the old demand. GitHub is not read at all.
        rc, line, n = run_verify(monkeypatch, tmp_path, capsys, sha=SKIP_SHA, version='4.181.0', modified={})
        assert rc == 1
        assert '[FAIL]' in line and f'{n} of {n} not redeployed since baseline' in line

    def test_without_a_run_everything_moved_still_passes_as_before(self, monkeypatch, tmp_path, capsys):
        rc, line, n = run_verify(monkeypatch, tmp_path, capsys, sha=DEPLOY_SHA, version='4.179.0',
                                 modified=all_redeployed)
        assert rc == 0
        assert '[PASS]' in line and f'all {n} redeployed since' in line and 'promote run' not in line

    def test_a_run_that_does_not_exist_fails_even_when_aws_would_pass(self, monkeypatch, tmp_path, capsys):
        def gh(path):
            raise smoke.CheckFailed(f'gh api {path} failed: HTTP 404: Not Found')
        rc, line, _ = run_verify(monkeypatch, tmp_path, capsys, sha=DEPLOY_SHA, version='4.179.0',
                                 modified=all_redeployed, promote_run='1', gh=gh)
        assert rc == 1
        assert '[FAIL]' in line and 'promote run 1 is not usable as evidence' in line and '404' in line

    def test_a_truncated_job_list_is_unreadable_not_a_run_with_no_lambda_jobs(self, monkeypatch, tmp_path, capsys):
        def drop_legs(rec):
            page = rec['jobs_pages'][0]
            page['jobs'] = [j for j in page['jobs'] if not j['name'].startswith('deploy-lambdas /')]
        rc, line, _ = run_verify(monkeypatch, tmp_path, capsys, sha=DEPLOY_SHA, version='4.179.0',
                                 modified=all_redeployed, promote_run=DEPLOY_RUN,
                                 gh=recorded(DEPLOY_RUN, drop_legs))
        assert rc == 3
        assert '[COULD NOT READ]' in line and 'total_count=33' in line

    def test_a_run_for_another_sha_fails_in_both_directions(self, monkeypatch, tmp_path, capsys):
        # The skipped run offered as evidence for a release it did not ship: nothing moved, and
        # trusting the run would pass a promote whose Lambdas were never deployed.
        rc, line, _ = run_verify(monkeypatch, tmp_path, capsys, sha=DEPLOY_SHA, version='4.179.0',
                                 modified={}, promote_run=SKIP_RUN, gh=recorded(SKIP_RUN))
        assert rc == 1
        assert '[FAIL]' in line and 'it promoted fe89add373, not --sha 2dbe00f8ac' in line
        # And it is the run's fault, not AWS's: the same wrong run fails a window AWS would pass.
        rc, line, _ = run_verify(monkeypatch, tmp_path, capsys, sha=SKIP_SHA, version='4.181.0',
                                 modified=all_redeployed, promote_run=DEPLOY_RUN, gh=recorded(DEPLOY_RUN))
        assert rc == 1
        assert '[FAIL]' in line and 'it promoted 2dbe00f8ac, not --sha fe89add373' in line

    def test_a_short_sha_binds_the_run_too(self, monkeypatch, tmp_path, capsys):
        rc, line, _ = run_verify(monkeypatch, tmp_path, capsys, sha=SKIP_SHA[:8], version='4.181.0',
                                 modified={}, promote_run=SKIP_RUN, gh=recorded(SKIP_RUN))
        assert rc == 0 and '[PASS]' in line

    def test_a_run_of_another_workflow_is_refused(self, monkeypatch, tmp_path, capsys):
        def other(rec):
            rec['run']['path'] = '.github/workflows/deploy-staging.yml'
        rc, line, _ = run_verify(monkeypatch, tmp_path, capsys, sha=SKIP_SHA, version='4.181.0',
                                 modified={}, promote_run=SKIP_RUN, gh=recorded(SKIP_RUN, other))
        assert rc == 1 and 'not .github/workflows/promote-gate.yml' in line

    def test_a_skip_that_followed_a_failed_promote_is_not_a_proven_skip(self, monkeypatch, tmp_path, capsys):
        # deploy-lambdas has a bare `needs: promote`, so it is ALSO skipped when promote fails.
        def fail_promote(rec):
            next(j for j in rec['jobs_pages'][0]['jobs'] if j['name'] == 'promote')['conclusion'] = 'failure'
        rc, line, _ = run_verify(monkeypatch, tmp_path, capsys, sha=SKIP_SHA, version='4.181.0',
                                 modified={}, promote_run=SKIP_RUN, gh=recorded(SKIP_RUN, fail_promote))
        assert rc == 1 and 'promote=failure, deploy-lambdas=skipped' in line

    def test_a_skip_not_decided_from_the_running_functions_is_not_a_proven_skip(self, monkeypatch, tmp_path, capsys):
        def drop_step(rec):
            p = next(j for j in rec['jobs_pages'][0]['jobs'] if j['name'] == 'promote')
            p['steps'] = [s for s in p['steps'] if s['name'] != smoke.LAMBDA_DECISION_STEP]
        rc, line, _ = run_verify(monkeypatch, tmp_path, capsys, sha=SKIP_SHA, version='4.181.0',
                                 modified={}, promote_run=SKIP_RUN, gh=recorded(SKIP_RUN, drop_step))
        assert rc == 1 and 'marker decision step did not succeed' in line

    def test_a_failed_leg_fails_whatever_aws_says(self, monkeypatch, tmp_path, capsys):
        def fail_leg(rec):
            next(j for j in rec['jobs_pages'][0]['jobs']
                 if j['name'] == 'deploy-lambdas / deploy (plants)')['conclusion'] = 'failure'
        rc, line, _ = run_verify(monkeypatch, tmp_path, capsys, sha=DEPLOY_SHA, version='4.179.0',
                                 modified=all_redeployed, promote_run=DEPLOY_RUN,
                                 gh=recorded(DEPLOY_RUN, fail_leg))
        assert rc == 1 and 'legs not successful: plants=failure' in line

    # BUG-SMOKEPRODJOBSPAGE-001. On promote 38467019027 (v4.187.1) GitHub answered 502 to
    # jobs?per_page=100 for over ten minutes while per_page=30 read all 33 jobs, and this check
    # called that a FAIL of a release that had deployed correctly.

    def test_the_jobs_are_read_in_small_pages_and_every_page_is_followed(self, monkeypatch, tmp_path, capsys):
        seen = []
        rc, line, n = run_verify(monkeypatch, tmp_path, capsys, sha=DEPLOY_SHA, version='4.179.0',
                                 modified=all_redeployed, promote_run=DEPLOY_RUN,
                                 gh=recorded(DEPLOY_RUN, seen=seen))
        assert rc == 0 and f'{n} deploy-lambdas legs succeeded' in line
        sizes = [int(x) for p in seen for x in re.findall(r'per_page=(\d+)', p)]
        assert sizes and max(sizes) <= 30
        # 33 jobs at 30 a page: the legs on page 2 are part of the verdict.
        assert [int(x) for p in seen for x in re.findall(r'&page=(\d+)', p)] == [1, 2]

    def test_a_github_read_that_did_not_answer_is_could_not_read_not_fail(self, monkeypatch, tmp_path, capsys):
        good = recorded(DEPLOY_RUN)

        def gh(path):
            if '/jobs?' in path:
                raise smoke.CheckUnreadable(f'gh api {path} failed: gh: Server Error (HTTP 502)')
            return good(path)
        rc, line, _ = run_verify(monkeypatch, tmp_path, capsys, sha=DEPLOY_SHA, version='4.179.0',
                                 modified=all_redeployed, promote_run=DEPLOY_RUN, gh=gh)
        assert rc == 3
        assert '[COULD NOT READ]' in line and 'HTTP 502' in line and 'run verify again' in line
        assert '[FAIL]' not in LAST['out'] and 'FAILED' not in LAST['out'] and 'PASSED' not in LAST['out']
        assert 'smoke INCOMPLETE — 1 of 8 checks could not be read, none failed' in LAST['out']

    def test_a_real_failure_beside_an_unreadable_check_is_still_exit_1(self, monkeypatch, tmp_path, capsys):
        def gh(path):
            raise smoke.CheckUnreadable(f'gh api {path} did not answer in 60 s')
        names = smoke.matrix_functions((ROOT / '.github/workflows/deploy-lambda.yml').read_text())
        monkeypatch.setattr(smoke, 'matrix_functions', lambda text: names[:-1])   # a dir with no matrix entry
        rc, line, _ = run_verify(monkeypatch, tmp_path, capsys, sha=DEPLOY_SHA, version='4.179.0',
                                 modified=all_redeployed, promote_run=DEPLOY_RUN, gh=gh)
        assert rc == 1 and '[COULD NOT READ]' in line
        assert 'smoke FAILED — 1 of 8 checks (1 more could not be read)' in LAST['out']

    @pytest.mark.parametrize('proc, exc', [
        (dict(returncode=1, stdout='', stderr='gh: Server Error (HTTP 502)'), 'unreadable'),
        (dict(returncode=1, stdout='', stderr='gh: Bad Gateway (HTTP 502)'), 'unreadable'),
        (dict(returncode=1, stdout='', stderr='error connecting to api.github.com'), 'unreadable'),
        (dict(returncode=1, stdout='', stderr='gh: API rate limit exceeded (HTTP 403)'), 'unreadable'),
        (dict(returncode=0, stdout='<html>502 Bad Gateway</html>', stderr=''), 'unreadable'),
        (dict(returncode=1, stdout='{"message":"Not Found"}', stderr='gh: Not Found (HTTP 404)'), 'failed'),
    ])
    def test_gh_api_tells_no_answer_from_a_wrong_answer(self, monkeypatch, proc, exc):
        class Proc:
            pass
        for k, v in proc.items():
            setattr(Proc, k, v)
        monkeypatch.setattr(smoke.subprocess, 'run', lambda *a, **k: Proc())
        with pytest.raises(smoke.CheckFailed) as e:
            smoke.gh_api('repos/o/r/actions/runs/1/jobs?per_page=30&page=1')
        assert isinstance(e.value, smoke.CheckUnreadable) == (exc == 'unreadable')

    def test_gh_api_timing_out_is_unreadable(self, monkeypatch):
        def hang(*a, **k):
            raise smoke.subprocess.TimeoutExpired(cmd='gh', timeout=60)
        monkeypatch.setattr(smoke.subprocess, 'run', hang)
        with pytest.raises(smoke.CheckUnreadable):
            smoke.gh_api('repos/o/r/actions/runs/1')

    def test_the_decision_step_name_is_the_one_promote_gate_runs(self):
        # The name is the evidence. If promote-gate.yml renames the step, every skip would read as
        # unproven (a false FAIL again), so the rename has to fail here first.
        wf = (ROOT / '.github/workflows/promote-gate.yml').read_text()
        assert f'      - name: {smoke.LAMBDA_DECISION_STEP}\n' in wf
