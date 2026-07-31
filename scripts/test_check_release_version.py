"""Tests for the release-version guard. Pure-core only — no git, no network."""
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location(
    "crv", os.path.join(os.path.dirname(__file__), "check-release-version.py"))
crv = importlib.util.module_from_spec(spec); spec.loader.exec_module(crv)


def rules(violations):
    return sorted(v.rule for v in violations)


# --- parse_semver ------------------------------------------------------------

def test_parse_semver_three_part():
    assert crv.parse_semver("3.81.1") == (3, 81, 1)

def test_parse_semver_two_part_pads():
    assert crv.parse_semver("3.81") == (3, 81, 0)

def test_parse_semver_rejects_v_prefix():
    assert crv.parse_semver("v3.81.1") is None

def test_parse_semver_rejects_prerelease_and_junk():
    for bad in ["3.81.1-rc1", "3", "", "3.81.1.2", None, 3.81, "x.y.z"]:
        assert crv.parse_semver(bad) is None


# --- A. shape ----------------------------------------------------------------

def test_shape_ok():
    assert crv.check_shape("3.81.1") == []

def test_shape_two_part_ok():
    assert crv.check_shape("3.81") == []

def test_shape_rejects_non_semver():
    assert rules(crv.check_shape("3.81.1-rc1")) == ["package.json version shape"]

def test_shape_rejects_missing_version():
    assert rules(crv.check_shape(None)) == ["package.json version shape"]

def test_shape_every_valid_pkg_version_is_snap_compatible():
    # The two regexes must not drift apart; anything add-release accepts must
    # be promotable. Guards the check_shape second branch's premise.
    for v in ["0.0.1", "3.81", "3.81.1", "10.100.1000"]:
        assert crv.SNAP_TAG_RE.match("v" + v)


# --- B. releases.json --------------------------------------------------------

def rel(*versions):
    return [{"version": v, "date": "2026-01-01", "highlights": ["x"]} for v in versions]

def test_releases_ok():
    assert crv.check_releases(rel("3.81.1", "3.81.0", "3.80.0"), "3.81.1") == []

def test_releases_not_an_array():
    assert rules(crv.check_releases({"version": "3.81.1"}, "3.81.1")) == ["releases.json integrity"]

def test_releases_empty():
    assert rules(crv.check_releases([], "3.81.1")) == ["releases.json integrity"]

def test_releases_out_of_order():
    assert "releases.json ordering" in rules(crv.check_releases(rel("3.80.0", "3.81.0"), "3.80.0"))

def test_releases_duplicate_version():
    out = crv.check_releases(rel("3.81.1", "3.81.1", "3.80.0"), "3.81.1")
    assert "releases.json ordering" in rules(out)
    assert any("duplicate" in v.detail for v in out)

def test_releases_head_mismatch_is_the_v3_81_0_shape():
    # 00558fe: package.json 3.80.0 AND releases.json[0] 3.80.0 — internally
    # consistent, so this assertion (like the vitest one) correctly stays quiet.
    assert crv.check_releases(rel("3.80.0", "3.79.0"), "3.80.0") == []
    # ...but a lockstep failure is caught the moment they diverge.
    assert "releases.json head vs package.json" in rules(
        crv.check_releases(rel("3.80.0", "3.79.0"), "3.81.0"))

def test_releases_entry_missing_highlights():
    bad = [{"version": "3.81.1", "highlights": []}]
    assert "releases.json integrity" in rules(crv.check_releases(bad, "3.81.1"))

def test_releases_entry_bad_version():
    bad = [{"version": "banana", "highlights": ["x"]}]
    assert "releases.json integrity" in rules(crv.check_releases(bad, "3.81.1"))

def test_releases_entry_not_an_object():
    assert "releases.json integrity" in rules(crv.check_releases(["3.81.1"], "3.81.1"))


# --- C. vs origin/main -------------------------------------------------------

TAGS = {"v3.80.0", "v3.81.0", "v3.81.1"}

def test_equal_disarms_tag_check_even_though_tag_exists():
    # The steady state after every promote. Must be green, or the guard is red
    # on every commit until the next bump.
    state, out = crv.check_vs_main("3.81.1", "3.81.1", TAGS)
    assert state == "equal" and out == []

def test_advanced_to_free_version_passes():
    state, out = crv.check_vs_main("3.82.0", "3.81.1", TAGS)
    assert state == "advanced" and out == []

def test_advanced_onto_consumed_tag_fails():
    state, out = crv.check_vs_main("3.81.0", "3.80.0", TAGS)
    assert state == "advanced" and rules(out) == ["tag collision"]

def test_tag_collision_fix_names_the_next_free_version():
    _, out = crv.check_vs_main("3.81.0", "3.80.0", TAGS)
    assert "3.81.2" in out[0].fix  # 3.81.1 is taken too

def test_waiver_honoured():
    state, out = crv.check_vs_main("3.81.0", "3.80.0", TAGS, waived=["3.81.0"])
    assert state == "advanced" and out == []

def test_waiver_for_a_different_version_does_not_help():
    _, out = crv.check_vs_main("3.81.0", "3.80.0", TAGS, waived=["3.79.0"])
    assert rules(out) == ["tag collision"]

def test_regression_fails():
    state, out = crv.check_vs_main("3.80.0", "3.81.1", TAGS)
    assert state == "regressed" and rules(out) == ["version regression vs main"]

def test_regression_beats_tag_check():
    # A regressed version's tag obviously exists; report the regression, not a collision.
    _, out = crv.check_vs_main("3.81.0", "3.81.1", TAGS)
    assert rules(out) == ["version regression vs main"]

def test_unparseable_main_signals_exit_2_path():
    state, out = crv.check_vs_main("3.81.1", "not-a-version", TAGS)
    assert state == "unparseable" and out == []

def test_unparseable_pkg_signals_exit_2_path():
    state, _ = crv.check_vs_main("nope", "3.81.1", TAGS)
    assert state == "unparseable"

def test_two_part_versions_compare_by_value_not_string():
    state, _ = crv.check_vs_main("3.81", "3.9.0", TAGS)
    assert state == "advanced"  # 3.81 > 3.9, not string-wise "3.81" < "3.9"


# --- next_free_version -------------------------------------------------------

def test_next_free_skips_taken_tags():
    assert crv.next_free_version("3.81.0", TAGS) == "3.81.2"

def test_next_free_from_untaken():
    assert crv.next_free_version("4.0.0", TAGS) == "4.0.1"

def test_next_free_pads_two_part():
    assert crv.next_free_version("3.81", set()) == "3.81.1"

def test_next_free_none_on_junk():
    assert crv.next_free_version("junk", set()) is None


# --- Tier 2 relevance --------------------------------------------------------

def test_relevant_defaults_true():
    for p in ["src/pages/Garden.jsx", "lambda/handler.mjs", "package.json",
              "vite.config.ts", "public/manifest.json", "scripts/snap.py",
              ".github/workflows/ci.yml"]:
        assert crv.is_release_relevant(p), p

def test_not_relevant_exclusions():
    for p in ["README.md", "docs/plan.md", "docs/img/a.png",
              ".github/ISSUE_TEMPLATE/bug.md", "public/releases.json",
              "src/__tests__/releaseNotes.test.js", "src/components/__tests__/X.jsx",
              "src/lib/foo.test.js", "src/lib/foo.test.tsx",
              "scripts/test_snap.py", "", "   "]:
        assert not crv.is_release_relevant(p), p

def test_test_suffix_outside_src_is_still_relevant():
    # Only src/** test files are excluded; a root-level harness still ships.
    assert crv.is_release_relevant("e2e/login.test.js")

def test_scripts_py_non_test_is_relevant():
    assert crv.is_release_relevant("scripts/check-release-version.py")

def test_relevant_paths_filters():
    assert crv.relevant_paths(["README.md", "src/App.jsx"]) == ["src/App.jsx"]


# --- Tier 2 advisory ---------------------------------------------------------

def test_advisory_none_when_only_docs_changed():
    assert crv.build_advisory("3.81.1", ["README.md", "public/releases.json"]) is None

def test_advisory_none_when_nothing_changed():
    assert crv.build_advisory("3.81.1", []) is None
    assert crv.build_advisory("3.81.1", None) is None

def test_advisory_fires_on_shipping_change():
    msg = crv.build_advisory("3.81.1", ["src/App.jsx"], commits=3)
    assert "3 unreleased commit(s)" in msg
    assert "snap_version MUST be v3.81.1" in msg
    assert "already consumed" in msg
    assert 'node scripts/add-release.mjs 3.81.2 "<highlight>"' in msg

def test_advisory_marks_shallow_count_as_a_lower_bound():
    msg = crv.build_advisory("3.81.1", ["src/App.jsx"], commits=1, commits_exact=False)
    assert "at least 1 unreleased commit(s)" in msg

def test_advisory_degrades_without_commit_count():
    msg = crv.build_advisory("3.81.1", ["src/App.jsx"])
    assert "1 release-relevant file(s)" in msg and "commit(s)" not in msg

def test_advisory_truncates_long_file_lists():
    msg = crv.build_advisory("3.81.1", [f"src/f{i}.jsx" for i in range(9)])
    assert "(+4 more)" in msg
