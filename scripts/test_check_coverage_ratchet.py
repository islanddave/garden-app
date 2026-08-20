"""Tests for the coverage-ratchet gate. Pure-core only — no git, no network, no npm.

OPS-COVRATCHETREGEX-001. Everything runs against a temp REPO_ROOT, so the real
vitest.config.ts is never read: a parser test that passed only because the live config
happens to be shaped agreeably would prove nothing about the parser.

The pairing that matters is decoy-vs-violation. `test_decoy_*` proves the gate stops
misreading a comment as config; `test_gate_fails_*` proves it can still FAIL — a guard
whose matcher is broader than its intent can never pass, and a guard that can never fail
is equally useless (cf. the unanchored `.test.js` zip guard that failed all 26 Lambda
deploys while blaming an innocent exclude).
"""
import importlib.util, json, os, sys
import pytest

spec = importlib.util.spec_from_file_location(
    "ccr", os.path.join(os.path.dirname(__file__), "check-coverage-ratchet.py"))
ccr = importlib.util.module_from_spec(spec); spec.loader.exec_module(ccr)


# Real shape: keys indented inside `thresholds:`, column-aligned values, trailing commas.
def config(lines=82, functions=75, branches=73, statements=82, preamble="", suffix=""):
    return f"""\
import {{ defineConfig }} from 'vitest/config'
export default defineConfig({{
  test: {{
    coverage: {{
      thresholds: {{
{preamble}        lines:      {lines},
        functions:  {functions},
        branches:   {branches},
        statements: {statements},
      }},
{suffix}    }},
  }},
}})
"""


@pytest.fixture
def repo(tmp_path, monkeypatch):
    """A throwaway REPO_ROOT. Returns a writer for the two files the gate reads."""
    monkeypatch.setattr(ccr, "REPO_ROOT", tmp_path)

    def write(config_text, active_target=73):
        (tmp_path / "vitest.config.ts").write_text(config_text)
        (tmp_path / "coverage-ratchet.json").write_text(json.dumps({
            "active_target": active_target,
            "milestones": [{"name": "Wave 0", "target": active_target, "status": "reached"}],
        }))
    return write


def run_gate(argv=("check-coverage-ratchet.py",)):
    """Run main() and return its exit code (0 for a clean return)."""
    saved = sys.argv
    sys.argv = list(argv)
    try:
        ccr.main()
        return 0
    except SystemExit as e:
        return e.code
    finally:
        sys.argv = saved


# --- vitest_min_threshold parsing --------------------------------------------

def test_parses_the_real_threshold_block(repo):
    repo(config())
    assert ccr.vitest_min_threshold() == (
        73, {"lines": 82, "functions": 75, "branches": 73, "statements": 82})


def test_decoy_comment_above_the_block_is_not_read(repo):
    # THE regression. `// target lines: 999` is a completely natural way to jot a goal in
    # the comment block that already sits above these thresholds — and an unanchored
    # re.search over the whole file returns it INSTEAD of the real value, silently.
    repo(config(preamble=(
        "        // Goal for the next milestone: lines: 999, functions: 999,\n"
        "        // branches: 999, statements: 999 — raise in lockstep with active_target.\n")))
    assert ccr.vitest_min_threshold()[1] == {
        "lines": 82, "functions": 75, "branches": 73, "statements": 82}


def test_decoy_below_the_block_is_not_read_either(repo):
    # Anchoring must not degrade into "first line-start match wins by luck of ordering".
    repo(config(suffix="      // was branches: 1 before the Wave 0 bump\n"))
    assert ccr.vitest_min_threshold()[0] == 73


def test_trailing_inline_comment_on_a_real_line_still_parses(repo):
    repo(config().replace("branches:   73,", "branches:   73,  // lowest of the four"))
    assert ccr.vitest_min_threshold()[1]["branches"] == 73


def test_longer_key_ending_in_a_real_key_is_not_matched(repo):
    # 'sublines:'/'nonfunctions:' end with a real key name; only the standalone key counts.
    repo(config(preamble="        sublines: 5,\n        nonfunctions: 5,\n"))
    assert ccr.vitest_min_threshold()[1] == {
        "lines": 82, "functions": 75, "branches": 73, "statements": 82}


def test_missing_key_is_fatal_exit_2(repo):
    # The FATAL branch must survive the anchoring — a config the parser cannot read is a
    # hard stop, never a silent zero.
    repo(config().replace("branches:   73,\n", ""))
    with pytest.raises(SystemExit) as e:
        ccr.vitest_min_threshold()
    assert e.value.code == 2


# --- gate end-to-end: it must still be able to FAIL ---------------------------

def test_gate_passes_when_thresholds_meet_target(repo):
    repo(config(), active_target=73)
    assert run_gate() == 0


def test_gate_fails_when_a_threshold_is_below_target(repo):
    # POSITIVE CONTROL: the plain violation still reds. Anchoring made the matcher
    # strictly narrower, so this is the assertion that proves it did not narrow to nothing.
    repo(config(branches=50), active_target=73)
    assert run_gate() == 1


def test_gate_fails_on_a_violation_hidden_behind_a_flattering_decoy(repo):
    # The two halves together: a REAL 50 in the config, a decoy 99 in the comment above it.
    # Unanchored, the gate reads 99 and exits 0 — a false green on a genuine coverage
    # regression, which is the whole reason this row exists.
    repo(config(branches=50, preamble="        // aiming for branches: 99 next milestone\n"),
         active_target=73)
    assert run_gate() == 1


def test_measured_mode_is_unaffected_by_the_config_parser(repo, tmp_path):
    # --measured reads coverage-summary.json, not vitest.config.ts. Guards the blast radius
    # claim: the regex change cannot reach ci.yml:178.
    repo(config(branches=1))          # config is garbage-low and must be ignored here
    (tmp_path / "coverage").mkdir()
    (tmp_path / "coverage" / "coverage-summary.json").write_text(json.dumps({
        "total": {k: {"pct": 90.5} for k in ["lines", "functions", "branches", "statements"]}}))
    assert run_gate(("check-coverage-ratchet.py", "--measured")) == 0
