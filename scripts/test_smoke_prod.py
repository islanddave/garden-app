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
