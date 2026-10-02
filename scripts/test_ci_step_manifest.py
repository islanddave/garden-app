"""ci.yml's `build-and-test` job against its frozen step manifest (scripts/ci-step-manifest.json).

Run: python3 -m pytest -q scripts/test_ci_step_manifest.py

The manifest is the conservation instrument for splitting the job into parallel legs: every step's whole mapping,
in order. It moves with CI: a commit that adds or edits a step regenerates it (scripts/gen-ci-step-manifest.py)
in the same commit, and this test fails until it does.

Two things are asserted straight from ci.yml as well, independent of the manifest, because either would let a
gate stop gating while every step is still present: no step carries `if:` or `continue-on-error`, and the job
carries no `continue-on-error`.

The job's `timeout-minutes` is recorded but not compared.
"""
import copy
import importlib.util
import json
import os

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("gen_ci_step_manifest", os.path.join(HERE, "gen-ci-step-manifest.py"))
gen = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gen)

MANIFEST = os.path.join(gen.ROOT, gen.MANIFEST)


def _committed():
    with open(MANIFEST, encoding="utf-8") as fh:
        return json.load(fh)


def _job(workflow):
    return workflow["jobs"]["build-and-test"]


def _unconditional(workflow):
    """(step number, name, key) for every step that can be skipped or made advisory, plus the job itself."""
    job = _job(workflow)
    found = [(n, step.get("name") or step.get("uses"), key) for n, step in enumerate(job["steps"], 1)
             for key in ("if", "continue-on-error") if key in step]
    return found + [(0, "the job", "continue-on-error")] * ("continue-on-error" in job)


def test_ci_yml_matches_the_manifest():
    found = gen.differences(_committed(), gen.build(gen.load_workflow()))
    assert not found, gen.CHANGED + "\n  " + "\n  ".join(found)


def test_the_message_names_the_remedy():
    assert gen.CHANGED == ("ci.yml build-and-test changed: run scripts/gen-ci-step-manifest.py and commit the "
                           "manifest in the same commit")


def test_no_step_has_an_if_or_continue_on_error_and_neither_has_the_job():
    assert _unconditional(gen.load_workflow()) == []


def test_the_manifest_file_is_in_the_generators_one_byte_form():
    """Sorted keys, LF, trailing newline: two lanes that regenerate it produce the same bytes for the same ci.yml."""
    with open(MANIFEST, "rb") as fh:
        raw = fh.read()
    assert b"\r" not in raw and raw.decode("utf-8") == gen.render(_committed())
    assert gen.render(gen.build(gen.load_workflow())) == gen.render(gen.build(gen.load_workflow()))


def test_the_manifest_holds_every_step_whole_and_in_order():
    workflow, manifest = gen.load_workflow(), _committed()
    steps = _job(workflow)["steps"]
    assert (manifest["workflow"], manifest["job"]) == (".github/workflows/ci.yml", "build-and-test")
    assert len(manifest["steps"]) == len(steps) > 0
    for recorded, step in zip(manifest["steps"], steps):
        assert set(recorded) == set(gen.STEP_KEYS) | {"other"}
        for key in gen.STEP_KEYS:
            want = step.get(key)
            assert recorded[key] == (want.split("\n") if key == "run" and want is not None else want)
        assert "\n".join(recorded["run"]) == step["run"] if "run" in step else recorded["run"] is None
        assert recorded["other"] == {k: v for k, v in step.items() if k not in gen.STEP_KEYS}
    assert manifest["job_keys"]["runs-on"] == _job(workflow)["runs-on"]
    assert set(manifest["job_keys"]) == {"runs-on", "env", "other"}
    assert set(manifest["informational"]) == {"timeout-minutes"}


@pytest.mark.parametrize("value", [None, 60, 90])
def test_a_job_timeout_is_recorded_and_not_compared(value):
    workflow = gen.load_workflow()
    _job(workflow).pop("timeout-minutes", None)
    if value is not None:
        _job(workflow)["timeout-minutes"] = value
    current = gen.build(workflow)
    assert current["informational"] == {"timeout-minutes": value}
    assert gen.differences(_committed(), current) == []
    assert "timeout-minutes" not in current["job_keys"]["other"]


def _first(workflow, key):
    return next(i for i, step in enumerate(_job(workflow)["steps"]) if key in step)


MUTATIONS = {
    "a run body gains a line": lambda wf: _job(wf)["steps"][_first(wf, "run")].update(
        run=_job(wf)["steps"][_first(wf, "run")]["run"] + "true\n"),
    "a run body loses its last character": lambda wf: _job(wf)["steps"][_first(wf, "run")].update(
        run=_job(wf)["steps"][_first(wf, "run")]["run"][:-1]),
    "an env value changes": lambda wf: _job(wf)["steps"][_first(wf, "env")]["env"].update(ADDED_BY_TEST="1"),
    "a with value changes": lambda wf: _job(wf)["steps"][_first(wf, "with")]["with"].update(added_by_test=True),
    "an action is repinned": lambda wf: _job(wf)["steps"][_first(wf, "uses")].update(uses="actions/checkout@v0"),
    "a step is renamed": lambda wf: _job(wf)["steps"][_first(wf, "name")].update(name="renamed by the test"),
    "a step is removed": lambda wf: _job(wf)["steps"].pop(),
    "a step is added": lambda wf: _job(wf)["steps"].append({"name": "added by the test", "run": "true"}),
    "two steps swap places": lambda wf: _job(wf)["steps"].insert(0, _job(wf)["steps"].pop(1)),
    "a step gains an if": lambda wf: _job(wf)["steps"][0].update({"if": "always()"}),
    "a step gains continue-on-error": lambda wf: _job(wf)["steps"][0].update({"continue-on-error": True}),
    "a step gains a shell": lambda wf: _job(wf)["steps"][_first(wf, "run")].update(shell="bash"),
    "a step gains a working-directory": lambda wf: _job(wf)["steps"][_first(wf, "run")].update(
        {"working-directory": "lambda"}),
    "a step gains an id": lambda wf: _job(wf)["steps"][0].update(id="x"),
    "a step gains a timeout": lambda wf: _job(wf)["steps"][0].update({"timeout-minutes": 5}),
    "the runner changes": lambda wf: _job(wf).update({"runs-on": "ubuntu-22.04"}),
    "the job gains an env": lambda wf: _job(wf).update(env={"ADDED_BY_TEST": "1"}),
    "the job gains an if": lambda wf: _job(wf).update({"if": "false"}),
    "the job gains continue-on-error": lambda wf: _job(wf).update({"continue-on-error": True}),
    "the job gains needs": lambda wf: _job(wf).update(needs=["other"]),
    "the workflow gains an env": lambda wf: wf.update(env={"ADDED_BY_TEST": "1"}),
    "the workflow gains a default shell": lambda wf: wf.update(defaults={"run": {"shell": "sh"}}),
}


@pytest.mark.parametrize("mutate", list(MUTATIONS.values()), ids=list(MUTATIONS))
def test_every_kind_of_change_to_the_job_shows_as_a_difference(mutate):
    """The comparison is only worth having if it can fail: each of these, applied to today's ci.yml in memory, must
    be reported against the committed manifest."""
    workflow = copy.deepcopy(gen.load_workflow())
    mutate(workflow)
    assert gen.differences(_committed(), gen.build(workflow)) != []


@pytest.mark.parametrize("name", ["a step gains an if", "a step gains continue-on-error",
                                  "the job gains continue-on-error"])
def test_the_independent_check_catches_what_it_is_for(name):
    workflow = copy.deepcopy(gen.load_workflow())
    MUTATIONS[name](workflow)
    assert len(_unconditional(workflow)) == 1


def test_check_mode_passes_on_this_tree(capsys):
    assert gen.main(["--check"]) == 0
    assert "matches .github/workflows/ci.yml" in capsys.readouterr().out
