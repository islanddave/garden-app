"""lambda_fleet is the ONE release set. Pin it EQUAL to the drift guard and to the deploy matrix,
and pin the number itself, so a derived list cannot quietly shrink back to a hand-kept subset."""
import importlib.util
import json
import os

import pytest

import lambda_fleet

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("clc", os.path.join(HERE, "check-lambda-config.py"))
clc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(clc)


def _deploy_matrix():
    wf = os.path.join(HERE, "..", ".github", "workflows", "deploy-lambda.yml")
    with open(wf) as fh:
        line = next(l for l in fh if l.strip().startswith("function: ["))
    return sorted("garden-" + f.strip() for f in line.split("[", 1)[1].rsplit("]", 1)[0].split(","))


def test_release_set_equals_the_drift_guard_manifest():
    assert lambda_fleet.release_functions() == sorted(clc.load_manifest())


def test_release_set_equals_the_deploy_matrix():
    """test_check_lambda_config proves matrix <= manifest. This closes the other direction: a
    function declared but never deployed would be snapshotted and preflighted, yet a revert's
    rebuild (the target's own deploy-lambda.yml matrix) would never touch it."""
    assert lambda_fleet.release_functions() == _deploy_matrix()


def test_release_set_is_all_26_not_the_old_11():
    fns = lambda_fleet.release_functions()
    assert len(fns) == 26
    # four of the 15 the hand-kept snap list never covered, and one it did
    for fn in ("garden-harvests", "garden-daily-plan", "garden-photocdn-derivative",
               "garden-facebook-share", "garden-plants"):
        assert fn in fns


def test_library_favorites_is_not_a_release_function():
    """Live in prod, but it is the docs library's backend (OPS-ORPHANLAMBDA-001)."""
    assert "garden-library-favorites" not in lambda_fleet.release_functions()


def _write(tmp_path, obj):
    p = tmp_path / "m.json"
    p.write_text(obj if isinstance(obj, str) else json.dumps(obj))
    return str(p)


def test_doc_and_reserved_keys_are_not_functions(tmp_path):
    p = _write(tmp_path, {"_README": ["x"], "eventbridge": [{"name": "r"}],
                          "garden-b-c": {}, "garden-a": {}})
    assert lambda_fleet.release_functions(p) == ["garden-a", "garden-b-c"]


def test_empty_release_set_is_an_error_not_an_empty_list(tmp_path):
    with pytest.raises(lambda_fleet.FleetError, match="no garden-"):
        lambda_fleet.release_functions(_write(tmp_path, {"_README": [], "eventbridge": []}))


def test_unreadable_manifest_is_an_error(tmp_path):
    with pytest.raises(lambda_fleet.FleetError, match="cannot read"):
        lambda_fleet.release_functions(_write(tmp_path, "{not json"))
    with pytest.raises(lambda_fleet.FleetError, match="cannot read"):
        lambda_fleet.release_functions(str(tmp_path / "absent.json"))


def test_staging_or_malformed_names_are_rejected(tmp_path):
    for bad in ("garden-plants-staging", "garden-Plants", "garden-"):
        with pytest.raises(lambda_fleet.FleetError, match="not prod function names"):
            lambda_fleet.release_functions(_write(tmp_path, {bad: {}, "garden-ok": {}}))
