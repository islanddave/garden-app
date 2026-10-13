"""The prod deploy jobs refuse unless main points at the commit they are about to deploy (OPS-MAINREFGUARD-001).

Run: python3 -m pytest -q scripts/test_deploy_main_guard.py

deploy.yml (the SPA) and deploy-lambda.yml (the 26-function matrix) each open with one guard step. It reads where
`main` points from the GitHub API and ends the job unless that is the commit the job's own checkout would build,
`inputs.ref || github.sha`. A late "Re-run failed jobs" on an old promote, or a hand dispatch on an old ref, then
cannot put an older commit over a newer one. An unreadable main is asked for six times; a main that is not the wanted
commit is read twice more; only the newest read decides, and only a read equal to the wanted commit passes.

Two halves, as in test_workflow_steps.py, whose harness this one mirrors:

  * STATIC: the guard is step 0 of every job with steps in both files, ahead of the checkout; neither it nor its job
    carries `if:`, `continue-on-error` or a shell override; it compares the checkout's own expression; neither file
    declares an input that could switch it off; and the two callers (promote-gate.yml, scripts/revert-to.py) still
    move main BEFORE they reach these jobs, which is why the guard needs no opt-out for a revert.
  * EXECUTED: the step body runs the runner's way (`bash -e {0}`) against an in-process stand-in for api.github.com
    that answers from a REAL git repository standing in for origin, so "main moved" is a commit, not a string. curl
    and jq are the real ones (a `curl` shim only swaps the API origin); `sleep` is a shim that returns at once and
    records its argument, so the body under test is the committed body, byte for byte, and no test waits 10 s.

Non-vacuity lives in the file: test_a_broken_guard_is_seen runs the same scenarios against mutated bodies and
requires a different verdict table from each.
"""
import ast
import json
import os
import re
import shlex
import shutil
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
RUNNER_SHELL = ["bash", "-e"]
REAL_CURL, REAL_JQ = shutil.which("curl"), shutil.which("jq")

GUARD = "Refuse unless main is at the commit this job deploys"
WANT_EXPR = "${{ inputs.ref || github.sha }}"
MAIN_REF_ROUTE = "GET /repos/owner/repo/git/ref/heads/main"
# (workflow, job) -> the inputs each trigger may declare. An input added to either file must be added here by hand,
# which is where a reviewer asks whether it can reach the guard.
DEPLOY_JOBS = {
    ("deploy.yml", "deploy"): {"workflow_call": {"skip_version_bump", "ref"}, "workflow_dispatch": {"skip_version_bump"}},
    ("deploy-lambda.yml", "deploy"): {"workflow_call": {"ref"}, "workflow_dispatch": set()},
}
BOTH = pytest.mark.parametrize("where", sorted(DEPLOY_JOBS), ids=lambda w: w[0])


def _workflow(name):
    with open(os.path.join(HERE, "..", ".github", "workflows", name)) as fh:
        return yaml.safe_load(fh)


def _triggers(wf):
    return wf.get("on") or wf[True]  # PyYAML reads the bare key `on` as the boolean True


def _guard_body(where=("deploy.yml", "deploy")):
    return _workflow(where[0])["jobs"][where[1]]["steps"][0]["run"]


# ── static: where the guard sits and what could skip it ───────────────────────────────────────────────────────────

@BOTH
def test_the_guard_is_the_first_step_and_nothing_can_skip_it(where):
    wf = _workflow(where[0])
    job = wf["jobs"][where[1]]
    step = job["steps"][0]
    assert step.get("name") == GUARD
    # name, env, run and nothing else: no `if:`, `continue-on-error`, `shell:`, `working-directory:` or `uses:`.
    assert set(step) == {"name", "env", "run"}
    assert step["env"] == {"GH_TOKEN": "${{ github.token }}", "REPO": "${{ github.repository }}", "WANT": WANT_EXPR}
    assert "if" not in job and "continue-on-error" not in job
    assert "defaults" not in job and "defaults" not in wf  # the body runs as the runner default, `bash -e {0}`
    assert [s.get("name") for s in job["steps"]].count(GUARD) == 1


@BOTH
def test_the_guard_compares_the_commit_the_checkout_builds(where):
    steps = _workflow(where[0])["jobs"][where[1]]["steps"]
    checkouts = [i for i, s in enumerate(steps) if str(s.get("uses", "")).startswith("actions/checkout@")]
    assert checkouts == [1], "one checkout, straight after the guard"
    assert steps[1]["with"]["ref"] == WANT_EXPR == steps[0]["env"]["WANT"]


def test_every_job_with_steps_in_both_files_is_guarded():
    seen = {}
    for name in sorted({w for w, _ in DEPLOY_JOBS}):
        for job_id, job in _workflow(name)["jobs"].items():
            seen[(name, job_id)] = "steps" if "steps" in job else job.get("uses")
            if "steps" in job:
                assert job["steps"][0].get("name") == GUARD, f"{name}:{job_id} has steps and no guard first"
    assert seen == {
        ("deploy.yml", "deploy"): "steps",
        ("deploy-lambda.yml", "deploy"): "steps",
        # read-only invariant checks; it needs `deploy`, so a refused matrix skips it
        ("deploy-lambda.yml", "verify-daily-plan"): "./.github/workflows/verify-lambda-invariants.yml",
    }
    assert _workflow("deploy-lambda.yml")["jobs"]["verify-daily-plan"]["needs"] == "deploy"


def test_the_two_files_carry_the_same_guard():
    spa, lam = (_workflow(w)["jobs"][j]["steps"][0] for w, j in sorted(DEPLOY_JOBS, reverse=True))
    assert spa == lam


@BOTH
def test_no_input_can_switch_the_guard_off(where):
    triggers = _triggers(_workflow(where[0]))
    assert set(triggers) == {"workflow_call", "workflow_dispatch"}
    for trigger, allowed in DEPLOY_JOBS[where].items():
        assert set((triggers[trigger] or {}).get("inputs") or {}) == allowed
    body = _guard_body(where)
    assert "${{" not in body, "the body reads its three env values and no expression of its own"
    read = set(re.findall(r"\$\{?([A-Za-z_][A-Za-z0-9_]*)", body))
    assert read == {"WANT", "GH_TOKEN", "REPO", "NOTHING", "HEX40", "OUT", "MAIN", "CODE", "FAILS", "DIFFS"}


@BOTH
def test_every_read_of_main_is_bounded_and_the_waits_are_ten_seconds(where):
    """Without `--max-time` a hung read runs to the job limit and the leg reads `cancelled`, not a refusal."""
    body = _guard_body(where)
    assert re.findall(r"\$\(curl [-\w ]*?-o ", body) == ["$(curl -sS --max-time 20 -o "]
    assert body.count("curl ") == 1, "one read command, and it is the bounded one"
    assert re.findall(r"\bsleep\b.*", body) == ["sleep 10"]


def test_promote_gate_reaches_both_jobs_after_its_fast_forward_with_the_promoted_sha():
    jobs = _workflow("promote-gate.yml")["jobs"]
    dev_sha = "${{ needs.resolve.outputs.dev_sha }}"
    ff = next(s for s in jobs["promote"]["steps"] if s.get("name") == "Fast-forward main -> dev SHA")
    assert ff["env"]["DEV_SHA"] == dev_sha and "if" not in ff and "continue-on-error" not in ff
    assert '\\"sha\\":\\"$DEV_SHA\\"' in ff["run"] and "/git/refs/heads/main" in ff["run"]
    for job_id, called in (("deploy-lambdas", "deploy-lambda.yml"), ("deploy", "deploy.yml")):
        job = jobs[job_id]
        assert job["uses"] == f"./.github/workflows/{called}"
        assert job["with"]["ref"] == dev_sha and "promote" in job["needs"]
    assert "needs.promote.result == 'success'" in jobs["deploy"]["if"]


def test_the_revert_tool_moves_main_first_and_dispatches_on_main_with_no_ref():
    """Why the guard has no opt-out: revert-to.py never deploys a commit main does not point at. It fast-forwards
    main to its revert (or restore) commit, then dispatches both workflows on main and passes no `ref`, so
    github.sha IS main's head. test_revert_to.py pins the same order by running the tool against a fake."""
    with open(os.path.join(HERE, "revert-to.py")) as fh:
        tree = ast.parse(fh.read())
    funcs = {n.name: n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)}

    def calls(func, name):
        return sorted((c.lineno, c) for c in ast.walk(funcs[func])
                      if isinstance(c, ast.Call) and getattr(c.func, "id", None) == name)

    dispatched = {}
    for leg in ("redeploy_lambdas", "redeploy_spa"):
        (_, call), = calls(leg, "dispatch_workflow")
        inputs = [k.value for kw in call.keywords if kw.arg == "inputs" for k in kw.value.keys]
        dispatched[call.args[1].id] = inputs
    assert dispatched == {"LAMBDA_DEPLOY_WORKFLOW": [], "SPA_DEPLOY_WORKFLOW": ["skip_version_bump"]}
    bodies = [ast.literal_eval(a.value) for a in ast.walk(funcs["dispatch_workflow"])
              if isinstance(a, ast.Assign) and getattr(a.targets[0], "id", None) == "body"]
    assert bodies == [{"ref": "main"}]
    for func in ("run", "rollback"):  # forward path and rollback: main moves before any leg is dispatched
        ff = calls(func, "ff_main")
        legs = calls(func, "redeploy_lambdas") + calls(func, "redeploy_spa")
        assert len(ff) == 1 and legs and all(ff[0][0] < line for line, _ in legs), func


# ── executed: the body, the runner's way, against a stand-in API backed by a real repository ──────────────────────

class _Origin:
    """A git repository standing in for origin. `commit()` advances main and returns the new SHA."""

    def __init__(self, path):
        self.path = str(path)
        self._git("init", "-q", "-b", "main")
        self.n = 0

    def _git(self, *args):
        ident = ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"]
        return subprocess.run(["git", "-C", self.path, *ident, *args], check=True, capture_output=True,
                              text=True, env={**os.environ, "GIT_CONFIG_GLOBAL": os.devnull}).stdout.strip()

    def commit(self, tree_of=None):
        """A new commit on main; with `tree_of`, one that restores that commit's tree (what revert-to.py makes)."""
        self.n += 1
        if tree_of:
            sha = self._git("commit-tree", f"{tree_of}^{{tree}}", "-p", "HEAD", "-m", f"revert to {tree_of}")
            self._git("update-ref", "refs/heads/main", sha)
            return sha
        with open(os.path.join(self.path, "f"), "w") as fh:
            fh.write(f"{self.n}\n")
        self._git("add", "f")
        self._git("commit", "-q", "-m", f"c{self.n}")
        return self.main()

    def side_commit(self):
        """A commit main does not point at (a dev SHA nobody promoted)."""
        return self._git("commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "unpromoted")

    def main(self):
        return self._git("rev-parse", "refs/heads/main")

    def tree(self, sha):
        return self._git("rev-parse", f"{sha}^{{tree}}")


DROP = "drop"  # answer nothing and close: curl exits 52
LIVE = "live"  # 200 with origin's main, read at request time


def _at(sha):
    """A well-formed answer that puts main at `sha`, whatever origin says: a stale or a wrong read."""
    return (200, json.dumps({"ref": "refs/heads/main", "object": {"sha": sha, "type": "commit"}}))


def _last_char_changed(sha):
    return sha[:-1] + ("0" if sha[-1] != "0" else "1")


class _Api:
    """api.github.com for one test. `replies` are served in order and the last one repeats; each is LIVE, DROP or
    (status, body)."""

    def __init__(self, origin, replies):
        self.origin, self.replies, self.log, self.auth = origin, list(replies), [], []
        api = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_args):
                pass

            def do_GET(self):
                api.auth.append(self.headers.get("Authorization"))
                reply = api.replies[min(len(api.log), len(api.replies) - 1)]
                api.log.append(f"{self.command} {self.path}")
                self.close_connection = True
                if reply == DROP:
                    return
                if self.path != "/repos/owner/repo/git/ref/heads/main":
                    reply = (404, '{"message": "Not Found"}')
                elif reply == LIVE:
                    reply = (200, json.dumps({"ref": "refs/heads/main",
                                              "object": {"sha": api.origin.main(), "type": "commit"}}))
                body = reply[1].encode()
                self.send_response(reply[0])
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(body)

            do_POST = do_PATCH = do_PUT = do_DELETE = do_GET

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def world(tmp_path):
    """-> run(want, replies=(LIVE,), body=None, jq=None) -> (proc, api); plus .origin, the stand-in for origin."""
    assert REAL_CURL and REAL_JQ, "these step bodies need curl and jq on PATH, as the runner image has"
    (tmp_path / "origin").mkdir()
    origin = _Origin(tmp_path / "origin")
    apis, count = [], [0]

    def run(want, replies=(LIVE,), body=None, jq=None):
        count[0] += 1
        cwd = tmp_path / f"run{count[0]}"
        bindir = cwd / "bin"
        bindir.mkdir(parents=True)
        api = _Api(origin, replies)
        apis.append(api)
        port = api.server.server_address[1]
        shims = {  # curl: -q first (ignore any ~/.curlrc), then the body's own arguments with the API origin swapped
            "curl": f'a=()\nfor x in "$@"; do a+=("${{x/https:\\/\\/api.github.com\\//http://127.0.0.1:{port}/}}"); done\n'
                    f'for x in "${{a[@]}}"; do case "$x" in http://127.0.0.1:{port}/*) ;; http://*|https://*) '
                    f'echo "curl shim: refusing a URL outside the stand-in: $x" >&2; exit 97 ;; esac; done\n'
                    f'exec {shlex.quote(REAL_CURL)} -q "${{a[@]}}"',
            "sleep": 'echo "$@" >> "$SLEPT"',
        }
        if jq is not None:
            shims["jq"] = jq
        for shim, text in shims.items():
            (bindir / shim).write_text("#!/bin/bash\n" + text + "\n")
            (bindir / shim).chmod(0o755)
        env = {k: v for k, v in os.environ.items() if not k.lower().endswith("_proxy")}
        env.update(PATH=f"{bindir}:{os.environ['PATH']}", NO_PROXY="*", GH_TOKEN="test-token", REPO="owner/repo",
                   WANT=want, SLEPT=str(cwd / "slept"), TMPDIR=str(cwd))
        script = cwd / "step.sh"
        script.write_text(_guard_body() if body is None else body)
        proc = subprocess.run(RUNNER_SHELL + [str(script)], cwd=cwd, env=env, capture_output=True, text=True)
        proc.slept = (cwd / "slept").read_text().split() if (cwd / "slept").exists() else []
        return proc, api

    run.origin = origin
    yield run
    for api in apis:
        api.close()


def _want(inputs_ref, github_sha):
    """`${{ inputs.ref || github.sha }}`, as test_the_guard_compares_the_commit_the_checkout_builds pins it."""
    return inputs_ref or github_sha


def _errors(proc):
    """Workflow commands the runner would act on: it TrimStart()s every stdout AND stderr line, then looks for `::`."""
    return [ln.lstrip() for ln in (proc.stdout + "\n" + proc.stderr).splitlines() if ln.lstrip().startswith("::error")]


def _passed(proc, api):
    return proc.returncode == 0 and not _errors(proc) and api.log == [MAIN_REF_ROUTE]


MOVED = "main has moved: do NOT re-run this run"  # the rules text quotes this; it is printed only for a mismatch


def _refused(proc, *needles):
    errors = _errors(proc)
    return proc.returncode == 1 and len(errors) == 1 and all(n in errors[0] for n in needles) \
        and "proceeding" not in proc.stdout and "Nothing was built, uploaded or updated by this job." in errors[0]


def test_a_promote_passes_after_its_fast_forward_and_so_does_its_rerun(world):
    promoted = world.origin.commit()
    caller_sha = "c" * 40  # under workflow_call github.sha is the caller's; here it is deliberately not main
    proc, api = world(_want(promoted, caller_sha))
    assert _passed(proc, api), proc.stdout + proc.stderr
    assert f"main is at {promoted}, the commit this job deploys: proceeding" in proc.stdout
    assert api.auth == ["Bearer test-token"] and proc.slept == []
    rerun, api2 = world(_want(promoted, caller_sha))  # "Re-run failed jobs": same commit, same ref input
    assert _passed(rerun, api2), rerun.stdout + rerun.stderr


def test_a_rerun_after_main_moved_on_is_refused_and_names_both_commits(world):
    old = world.origin.commit()
    new = world.origin.commit()
    proc, api = world(_want(old, old))
    assert _refused(proc, f"main is at {new}", f"would deploy {old}", MOVED, "promote-gate",
                    "scripts/revert-to.py"), proc.stdout + proc.stderr
    assert api.log == [MAIN_REF_ROUTE] * 3 and proc.slept == ["10", "10"], "read twice more, 10 s apart, then refuse"


def test_a_mismatch_then_a_match_on_a_re_read_passes(world):
    """A ref read can trail a fast-forward made seconds earlier: the older answer is not a verdict."""
    before = world.origin.commit()
    promoted = world.origin.commit()
    for stale in (1, 2):  # the first read, or the first two, still show main where it was
        proc, api = world(_want(promoted, promoted), replies=[_at(before)] * stale + [LIVE])
        assert proc.returncode == 0 and not _errors(proc), proc.stdout + proc.stderr
        assert f"main is at {promoted}, the commit this job deploys: proceeding" in proc.stdout
        assert api.log == [MAIN_REF_ROUTE] * (stale + 1) and proc.slept == ["10"] * stale


def test_a_mismatch_three_times_is_refused_and_the_newest_read_decides(world):
    old = world.origin.commit()
    new = world.origin.commit()
    other = world.origin.side_commit()
    proc, api = world(_want(old, old), replies=[_at(new)] * 3 + [_at(old)])  # a fourth read is never made
    assert _refused(proc, f"main is at {new}", f"would deploy {old}", MOVED), proc.stdout + proc.stderr
    assert api.log == [MAIN_REF_ROUTE] * 3 and proc.slept == ["10", "10"]
    # The refusal names the NEWEST read, not the first one that differed.
    proc, _ = world(_want(old, old), replies=[_at(other), _at(other), LIVE])
    assert _refused(proc, f"main is at {new}", f"would deploy {old}", MOVED), proc.stdout + proc.stderr
    assert other not in _errors(proc)[0]
    # A match is a verdict too: the body stops reading, so an earlier match cannot be overturned or re-rolled.
    proc, api = world(_want(new, new), replies=[LIVE, _at(old)])
    assert _passed(proc, api), proc.stdout + proc.stderr


def test_a_main_that_differs_only_in_its_last_character_is_refused(world):
    head = world.origin.commit()
    near = _last_char_changed(head)
    assert near != head and near[:39] == head[:39] and re.fullmatch("[0-9a-f]{40}", near)
    proc, api = world(_want(head, head), replies=[_at(near)])
    assert _refused(proc, f"main is at {near}", f"would deploy {head}", MOVED), proc.stdout + proc.stderr
    assert api.log == [MAIN_REF_ROUTE] * 3


def test_under_workflow_call_the_ref_input_is_compared_not_the_callers_commit(world):
    old = world.origin.commit()
    head = world.origin.commit()
    proc, _ = world(_want(old, head))  # the caller's commit is main's head; the commit to build is not
    assert _refused(proc, f"main is at {head}", f"would deploy {old}"), proc.stdout + proc.stderr


def test_a_hand_dispatch_passes_only_on_mains_head(world):
    old = world.origin.commit()
    head = world.origin.commit()
    unpromoted = world.origin.side_commit()
    on_main, api = world(_want("", head))
    assert _passed(on_main, api), on_main.stdout + on_main.stderr
    for github_sha in (unpromoted, old):  # dispatched on dev, or a re-run of a dispatch made before main moved
        proc, _ = world(_want("", github_sha))
        assert _refused(proc, f"main is at {head}", f"would deploy {github_sha}"), proc.stdout + proc.stderr


def test_the_revert_path_passes_with_no_opt_out_and_only_for_the_commit_main_was_moved_to(world):
    target = world.origin.commit()  # vX, the older release a revert restores
    world.origin.commit()           # what prod runs now
    before = world.origin.main()
    revert = world.origin.commit(tree_of=target)  # revert-to.py: forward commit carrying vX's tree, then FF main
    assert world.origin.tree(revert) == world.origin.tree(target) and revert != target
    proc, api = world(_want("", revert))  # dispatch_workflow: {"ref": "main"}, no `ref` input
    assert _passed(proc, api), proc.stdout + proc.stderr
    # The same OLD code under its own older SHA is not main's head and is refused: only the move of main admits it.
    assert _refused(world(_want("", target))[0], f"main is at {revert}", f"would deploy {target}")
    # Rollback: main moves on to the restore commit; a forward leg still queued for the revert commit refuses itself.
    restore = world.origin.commit(tree_of=before)
    assert _refused(world(_want("", revert))[0], f"main is at {restore}", f"would deploy {revert}")
    proc, api = world(_want("", restore))
    assert _passed(proc, api), proc.stdout + proc.stderr


UNREADABLE = {
    "http-500": [(500, '{"message": "Server Error"}')],
    "http-502-html": [(502, "<html><body><h1>502 Bad Gateway</h1></body></html>")],
    "http-401": [(401, '{"message": "Bad credentials"}')],
    "http-404": [(404, '{"message": "Not Found"}')],
    "no-answer": [DROP],
    "200-not-json": [(200, "<html>We had issues producing the response to your request.</html>")],
    "200-empty": [(200, "")],
    "200-null-sha": [(200, '{"ref": "refs/heads/main", "object": {"sha": null}}')],
    "200-short-sha": [(200, '{"ref": "refs/heads/main", "object": {"sha": "abc1234"}}')],
    "200-list": [(200, '[{"ref": "refs/heads/main", "object": {"sha": "%s"}}]')],
    "200-another-ref": [(200, '{"ref": "refs/heads/main-old", "object": {"sha": "%s"}}')],
    "200-a-tag": [(200, '{"ref": "refs/tags/main", "object": {"sha": "%s"}}')],
}


@pytest.mark.parametrize("case", sorted(UNREADABLE))
def test_an_unreadable_main_is_refused_never_passed(world, case):
    head = world.origin.commit()
    replies = [r if r == DROP else (r[0], r[1].replace("%s", head)) for r in UNREADABLE[case]]
    proc, api = world(_want(head, head), replies=replies)
    assert _refused(proc, "could not read where main points", "Re-run failed jobs", head), proc.stdout + proc.stderr
    assert api.log == [MAIN_REF_ROUTE] * 6 and proc.slept == ["10"] * 5, "six tries, 10 s apart, then refuse"
    assert MOVED not in _errors(proc)[0], "an unreadable main is not a moved main: this refusal may be re-run"


def test_a_missing_jq_is_refused_never_passed(world):
    head = world.origin.commit()
    proc, _ = world(_want(head, head), jq='echo "jq: command not found" >&2; exit 127')
    assert _refused(proc, "could not read where main points", "Re-run failed jobs"), proc.stdout + proc.stderr


def test_one_bad_answer_is_asked_again_and_the_next_good_one_decides(world):
    head = world.origin.commit()
    proc, api = world(_want(head, head), replies=[(502, "<html>502</html>"), DROP, LIVE])
    assert proc.returncode == 0 and not _errors(proc), proc.stdout + proc.stderr
    assert api.log == [MAIN_REF_ROUTE] * 3 and proc.slept == ["10", "10"]
    old = world.origin.commit()
    world.origin.commit()
    proc, _ = world(_want(old, old), replies=[(502, "<html>502</html>"), LIVE])
    assert _refused(proc, MOVED), "a retry must not turn a moved main into a pass"


def test_five_failed_reads_then_a_good_matching_read_passes_and_six_are_refused(world):
    head = world.origin.commit()
    bad = [(502, "<html>502</html>"), DROP, (500, "{}"), (200, ""), (401, '{"message": "Bad credentials"}')]
    proc, api = world(_want(head, head), replies=bad + [LIVE])
    assert proc.returncode == 0 and not _errors(proc), proc.stdout + proc.stderr
    assert api.log == [MAIN_REF_ROUTE] * 6 and proc.slept == ["10"] * 5
    proc, api = world(_want(head, head), replies=bad + [DROP, LIVE])  # the good answer comes one read too late
    assert _refused(proc, "could not read where main points", "Re-run failed jobs"), proc.stdout + proc.stderr
    assert api.log == [MAIN_REF_ROUTE] * 6 and proc.slept == ["10"] * 5


def test_the_two_budgets_are_separate_and_an_unreadable_last_read_is_never_a_pass(world):
    old = world.origin.commit()
    new = world.origin.commit()
    # Two differing reads, then GitHub stops answering: the newest read is unreadable, so that is the refusal.
    proc, api = world(_want(old, old), replies=[_at(new), _at(new), DROP])
    assert _refused(proc, "could not read where main points"), proc.stdout + proc.stderr
    assert api.log == [MAIN_REF_ROUTE] * 8 and proc.slept == ["10"] * 7, "the longest run of reads there is"
    # Failed reads do not use up the re-reads of a mismatch, and differing reads do not use up the six tries.
    proc, api = world(_want(new, new), replies=[DROP, _at(old), DROP, _at(old), DROP, DROP, DROP, LIVE])
    assert proc.returncode == 0 and not _errors(proc) and api.log == [MAIN_REF_ROUTE] * 8, proc.stdout + proc.stderr


def test_each_budget_is_cumulative_so_the_other_kind_of_read_never_resets_it(world):
    """The "at most 8 reads, 7 waits" bound (230 s) holds only while both counts run for the whole step. A loop
    where a differing read resets the failed-read count, or a failed read resets the differing-read count, still
    refuses everything it should, but can run 18 reads (530 s of the Lambda leg's 600 s limit)."""
    old = world.origin.commit()
    new = world.origin.commit()
    # Five failed reads, one differing read, one more failed read: that is the sixth failure, so it ends there.
    proc, api = world(_want(old, old), replies=[DROP] * 5 + [_at(new), DROP])
    assert _refused(proc, "could not read where main points"), proc.stdout + proc.stderr
    assert api.log == [MAIN_REF_ROUTE] * 7 and proc.slept == ["10"] * 6, "a differing read must not reset the six tries"
    # Two differing reads, one failed read, one more differing read: that is the third mismatch, so it ends there.
    proc, api = world(_want(old, old), replies=[_at(new), _at(new), DROP, _at(new)])
    assert _refused(proc, MOVED), proc.stdout + proc.stderr
    assert api.log == [MAIN_REF_ROUTE] * 4 and proc.slept == ["10"] * 3, "a failed read must not reset the re-reads"


@pytest.mark.parametrize("want", ["", "main", "refs/heads/main", "abc1234", "A" * 40, "a" * 39, "a" * 41,
                                  "a" * 40 + "\n" + "b" * 40], ids=lambda w: repr(w)[:24])
def test_a_commit_that_is_not_a_full_sha_is_refused_before_anything_is_read(world, want):
    world.origin.commit()
    proc, api = world(want)
    errors = _errors(proc)
    assert proc.returncode == 1 and len(errors) == 1 and "must be a full 40-hex SHA" in errors[0], \
        proc.stdout + proc.stderr
    assert api.log == [] and "proceeding" not in proc.stdout


# ── non-vacuity: the scenarios above, as one verdict table, must change when the guard is broken ──────────────────

def _verdicts(world, body):
    old = world.origin.commit()
    head = world.origin.commit()

    def rc(want, **kw):
        return world(want, body=body, **kw)[0].returncode

    return {
        "promote-after-ff": rc(_want(head, "c" * 40)),
        "rerun-main-moved": rc(_want(old, old)),
        "hand-dispatch-on-main": rc(_want("", head)),
        "hand-dispatch-elsewhere": rc(_want("", world.origin.side_commit())),
        "stale-then-fresh": rc(_want(head, head), replies=[_at(old), LIVE]),
        "differs-three-times": rc(_want(old, old), replies=[_at(head), _at(head), _at(head), _at(old)]),
        "last-character-differs": rc(_want(head, head), replies=[_at(_last_char_changed(head))]),
        "read-failed": rc(_want(head, head), replies=[(500, "{}")]),
        "read-garbage": rc(_want(head, head), replies=[(200, "<html></html>")]),
        "not-a-sha": rc("main"),
    }


EXPECTED = {"promote-after-ff": 0, "rerun-main-moved": 1, "hand-dispatch-on-main": 0, "hand-dispatch-elsewhere": 1,
            "stale-then-fresh": 0, "differs-three-times": 1, "last-character-differs": 1,
            "read-failed": 1, "read-garbage": 1, "not-a-sha": 1}
MISMATCH_TEST, READ_TEST = 'if [ "$MAIN" != "$WANT" ]; then', 'if [ -z "$MAIN" ]; then'
MATCH_TEST, DIFFS_SPENT = 'if [ "$MAIN" = "$WANT" ]; then break; fi', 'if [ "$DIFFS" = "3" ]; then break; fi'
MUTATIONS = {
    "deleted": lambda b: "set -euo pipefail\necho no guard\n",
    "comparison-inverted": lambda b: b.replace(MISMATCH_TEST, 'if [ "$MAIN" = "$WANT" ]; then'),
    "mismatch-or-true": lambda b: re.sub(r"(would deploy \$WANT\..*?\"); exit 1", r"\1 || true", b),
    "read-failure-passes": lambda b: b.replace(READ_TEST, 'if [ -z "$MAIN" ]; then MAIN="$WANT"; fi\nif false; then'),
    "main-never-read": lambda b: b.replace('MAIN=$(jq -r', 'MAIN="$WANT"; : $(jq -r'),
    "whole-body-or-true": lambda b: "(\n" + b + "\n) || true\n",
    "mismatch-not-re-read": lambda b: b.replace(DIFFS_SPENT, 'if [ "$DIFFS" = "1" ]; then break; fi'),
    "any-read-after-a-mismatch-passes": lambda b: b.replace(
        MATCH_TEST, MATCH_TEST + '\n  if [ -n "$MAIN" ] && [ "$DIFFS" != "0" ]; then MAIN="$WANT"; break; fi'),
    "first-seven-characters-compared": lambda b: b.replace(
        MATCH_TEST, 'if [ "${MAIN:0:7}" = "${WANT:0:7}" ]; then break; fi').replace(
        MISMATCH_TEST, 'if [ "${MAIN:0:7}" != "${WANT:0:7}" ]; then'),
}


def test_the_real_guard_gives_the_expected_verdicts(world):
    assert _verdicts(world, _guard_body()) == EXPECTED


@pytest.mark.parametrize("mutation", sorted(MUTATIONS))
def test_a_broken_guard_is_seen(world, mutation):
    body = _guard_body()
    broken = MUTATIONS[mutation](body)
    assert broken != body, "the mutation did not apply: the guard's text moved, update MUTATIONS"
    assert subprocess.run(["bash", "-n"], input=broken, text=True, capture_output=True).returncode == 0
    assert _verdicts(world, broken) != EXPECTED
