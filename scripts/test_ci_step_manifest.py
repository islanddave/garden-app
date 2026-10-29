"""ci.yml's jobs against their frozen step manifest (scripts/ci-step-manifest.json).

Run: python3 -m pytest -q scripts/test_ci_step_manifest.py

The manifest is the conservation instrument for ci.yml's legs and its aggregator `build-and-test`: every job, and
every step's whole mapping, in order. It moves with CI: a commit that adds or edits a step regenerates it
(scripts/gen-ci-step-manifest.py) in the same commit, and this test fails until it does.

Two things are asserted straight from ci.yml as well, independent of the manifest, because either would let a
gate stop gating while every step is still present: no step carries `if:` or `continue-on-error`, and no job
carries `continue-on-error`. (The aggregator's job-level `if: always()` is in the manifest, and
scripts/test_ci_legs.py holds it to exactly that.)

A job's `timeout-minutes` is recorded but not compared.
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


LEG = "gates-a"  # the leg the mutations below are made in: it has a step with each of run, env, with, uses, name


def _job(workflow, job_id=LEG):
    return workflow["jobs"][job_id]


def _unconditional(workflow):
    """(job, step number, name, key) for every step that can be skipped or made advisory, plus each job itself."""
    found = []
    for job_id, job in workflow["jobs"].items():
        found += [(job_id, n, step.get("name") or step.get("uses"), key) for n, step in enumerate(job["steps"], 1)
                  for key in ("if", "continue-on-error") if key in step]
        found += [(job_id, 0, "the job", "continue-on-error")] * ("continue-on-error" in job)
    return found


def test_ci_yml_matches_the_manifest():
    found = gen.differences(_committed(), gen.build(gen.load_workflow()))
    assert not found, gen.CHANGED + "\n  " + "\n  ".join(found)


def test_the_message_names_the_remedy():
    assert gen.CHANGED == ("ci.yml's jobs changed: run scripts/gen-ci-step-manifest.py and commit the manifest in "
                           "the same commit")


def test_no_step_has_an_if_or_continue_on_error_and_no_job_has_continue_on_error():
    assert _unconditional(gen.load_workflow()) == []


def test_the_manifest_file_is_in_the_generators_one_byte_form():
    """Sorted keys, LF, trailing newline: two lanes that regenerate it produce the same bytes for the same ci.yml."""
    with open(MANIFEST, "rb") as fh:
        raw = fh.read()
    assert b"\r" not in raw and raw.decode("utf-8") == gen.render(_committed())
    assert gen.render(gen.build(gen.load_workflow())) == gen.render(gen.build(gen.load_workflow()))


def test_the_manifest_holds_every_job_and_every_step_whole_and_in_order():
    workflow, manifest = gen.load_workflow(), _committed()
    assert manifest["workflow"] == ".github/workflows/ci.yml"
    assert set(manifest) == {"_about", "workflow", "workflow_keys", "jobs"}
    assert [job["job"] for job in manifest["jobs"]] == list(workflow["jobs"])
    assert len(manifest["jobs"]) > 1 and manifest["jobs"][-1]["job"] == "build-and-test"
    for entry in manifest["jobs"]:
        job = workflow["jobs"][entry["job"]]
        steps = job["steps"]
        assert len(entry["steps"]) == len(steps) > 0
        for recorded, step in zip(entry["steps"], steps):
            assert set(recorded) == set(gen.STEP_KEYS) | {"other"}
            for key in gen.STEP_KEYS:
                want = step.get(key)
                assert recorded[key] == (want.split("\n") if key == "run" and want is not None else want)
            assert "\n".join(recorded["run"]) == step["run"] if "run" in step else recorded["run"] is None
            assert recorded["other"] == {k: v for k, v in step.items() if k not in gen.STEP_KEYS}
        assert entry["job_keys"]["runs-on"] == job["runs-on"]
        assert set(entry["job_keys"]) == {"runs-on", "env", "other"}
        assert set(entry["informational"]) == {"timeout-minutes"}
        assert entry["job_keys"]["other"] == {k: v for k, v in job.items()
                                              if k not in ("runs-on", "env", "timeout-minutes", "steps")}
    aggregator = manifest["jobs"][-1]["job_keys"]["other"]
    assert aggregator == {"needs": [job["job"] for job in manifest["jobs"][:-1]], "if": "always()"}


@pytest.mark.parametrize("job_id", ["static", "build-and-test"])
@pytest.mark.parametrize("value", [None, 60, 90])
def test_a_job_timeout_is_recorded_and_not_compared(value, job_id):
    workflow = gen.load_workflow()
    _job(workflow, job_id).pop("timeout-minutes", None)
    if value is not None:
        _job(workflow, job_id)["timeout-minutes"] = value
    current = gen.build(workflow)
    entry = next(job for job in current["jobs"] if job["job"] == job_id)
    assert entry["informational"] == {"timeout-minutes": value}
    assert gen.differences(_committed(), current) == []
    assert "timeout-minutes" not in entry["job_keys"]["other"]


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
    # the job graph: what one serial job could not get wrong
    "a leg is removed": lambda wf: wf["jobs"].pop("gates-c"),
    "a leg is added": lambda wf: wf["jobs"].update(extra={"runs-on": "ubuntu-26.04", "steps": [{"run": "true"}]}),
    "a leg is renamed": lambda wf: wf["jobs"].update({"gates-d": wf["jobs"].pop("gates-c")}),
    "two jobs swap places": lambda wf: wf["jobs"].update({"static": wf["jobs"].pop("static")}),
    "a step moves to another leg": lambda wf: _job(wf, "gates-b")["steps"].append(_job(wf)["steps"].pop()),
    "the aggregator drops a need": lambda wf: _job(wf, "build-and-test")["needs"].remove("gates-c"),
    "the aggregator loses always()": lambda wf: _job(wf, "build-and-test").pop("if"),
    "the aggregator's if changes": lambda wf: _job(wf, "build-and-test").update({"if": "success()"}),
    "the aggregator's pinned list loses a leg": lambda wf: _job(wf, "build-and-test")["steps"][0].update(
        run=_job(wf, "build-and-test")["steps"][0]["run"].replace(" gates-c", "", 1)),
    "the aggregator is renamed": lambda wf: wf["jobs"].update({"verdict": wf["jobs"].pop("build-and-test")}),
}


@pytest.mark.parametrize("mutate", list(MUTATIONS.values()), ids=list(MUTATIONS))
def test_every_kind_of_change_to_the_job_shows_as_a_difference(mutate):
    """The comparison is only worth having if it can fail: each of these, applied to today's ci.yml in memory, must
    be reported against the committed manifest."""
    workflow = copy.deepcopy(gen.load_workflow())
    before = gen.render(gen.build(workflow))
    mutate(workflow)
    assert gen.render(gen.build(workflow)) != before, "the mutation changed nothing: fix the mutation"
    assert gen.differences(_committed(), gen.build(workflow)) != []


@pytest.mark.parametrize("name", ["a step gains an if", "a step gains continue-on-error",
                                  "the job gains continue-on-error"])
def test_the_independent_check_catches_what_it_is_for(name):
    workflow = copy.deepcopy(gen.load_workflow())
    MUTATIONS[name](workflow)
    assert len(_unconditional(workflow)) == 1


def test_check_mode_passes_on_this_tree(capsys):
    assert gen.main(["--check"]) == 0
    assert "matches .github/workflows/ci.yml (13 jobs, " in capsys.readouterr().out
