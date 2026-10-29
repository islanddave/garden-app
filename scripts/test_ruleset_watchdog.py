# new-file: new subject, scripts/ruleset-watchdog.py (lifted out of ruleset-watchdog.yml's inline Python).
"""ruleset-watchdog.py verdicts: OK / DRIFT (exit 1) / UNVERIFIED (warning, exit 0) and the streak escalation.
F5 (OPS-CODEREVIEW-001). Trap: an App token reads bypass_actors as [] - that alone is never DRIFT; only the
updated_at fingerprint (an instant, not a string) or a visible rogue actor is."""
import copy
import importlib.util
import io
import json
import os
import urllib.error
from pathlib import Path

import pytest
import yaml

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("ruleset_watchdog", HERE / "ruleset-watchdog.py")
wd = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(wd)

WORKFLOW = HERE.parent / ".github" / "workflows" / "ruleset-watchdog.yml"
PIN = "2026-10-02T12:20:11.554-04:00"
ENV = {"REPO": "o/r", "RULESET_ID": "17227141", "BYPASS_APP_ID": "3951762", "EXPECT_UPDATED_AT": PIN,
       "REQUIRED_RULES": "pull_request non_fast_forward deletion update", "BOT_TOKEN": "bot",
       "HISTORY_TOKEN": "hist", "RUN_ID": "500"}
INTACT = {"id": 17227141, "enforcement": "active",
          "rules": [{"type": t} for t in ("pull_request", "non_fast_forward", "deletion", "update")],
          "conditions": {"ref_name": {"include": ["refs/heads/main"]}},
          "bypass_actors": [], "updated_at": PIN}


def fake(ruleset=None, list_ids=(17227141,), history=None, fail=()):
    """A GitHub API stand-in keyed by path. `history`: one flag per prior run, newest first, True = marker."""
    calls = []
    ruleset = INTACT if ruleset is None else ruleset

    def fetch(path, tok):
        calls.append((path, tok))
        if any(path.startswith(f) for f in fail):
            raise wd.Unverifiable("HTTP 401 on %s" % path)
        if path == "/rulesets":
            return [{"id": i} for i in list_ids]
        if path == "/rulesets/17227141":
            return copy.deepcopy(ruleset)
        if path == "/actions/runs/500":
            return {"workflow_id": 9}
        if path.startswith("/actions/workflows/9/runs"):
            return {"workflow_runs": [{"id": 500}] + [{"id": 600 + i} for i in range(len(history or []))]}
        if path.startswith("/actions/runs/6"):
            return {"jobs": [{"id": int(path.split("/")[3])}]}
        if path.startswith("/check-runs/6"):
            marked = (history or [])[int(path.split("/")[2]) - 600]
            return [{"message": wd.MARKER + " ..."}] if marked else [{"message": "other"}]
        raise AssertionError("unexpected path " + path)
    fetch.calls = calls
    return fetch


def run(capsys, fetch, **env):
    rc = wd.main({**ENV, **env}, fetch)
    return rc, capsys.readouterr().out


def test_intact_with_fingerprint_is_ok(capsys):
    rc, out = run(capsys, fake())
    assert rc == 0 and "OK: main-capability-gate intact (id 17227141)" in out and "::" not in out


def test_fingerprint_compares_instants_not_strings(capsys):
    rc, out = run(capsys, fake({**INTACT, "updated_at": "2026-10-02T16:20:11.554Z"}))
    assert rc == 0 and "OK:" in out


def test_visible_expected_bypass_actor_is_ok(capsys):
    rs = {**INTACT, "bypass_actors": [{"actor_id": 3951762, "actor_type": "Integration"}]}
    rc, out = run(capsys, fake(rs))
    assert rc == 0 and "bypass=garden-bot 3951762" in out


def test_rogue_bypass_actor_is_drift(capsys):
    rs = {**INTACT, "bypass_actors": [{"actor_id": 3951762, "actor_type": "Integration"},
                                      {"actor_id": 1, "actor_type": "User"}]}
    rc, out = run(capsys, fake(rs))
    assert rc == 1 and "::error::main-capability-gate RULESET DRIFT" in out and "bypass_actors drifted" in out


def test_missing_rule_type_is_drift(capsys):
    rs = {**INTACT, "rules": [r for r in INTACT["rules"] if r["type"] != "update"]}
    rc, out = run(capsys, fake(rs))
    assert rc == 1 and "missing rule: update" in out


def test_required_rules_come_from_the_env(capsys):
    rc, out = run(capsys, fake(), REQUIRED_RULES="pull_request required_signatures")
    assert rc == 1 and "missing rule: required_signatures" in out


def test_unexpected_updated_at_is_drift(capsys):
    rc, out = run(capsys, fake({**INTACT, "updated_at": "2026-10-20T09:00:00Z"}))
    assert rc == 1 and "ruleset MUTATED since pinned fingerprint" in out


@pytest.mark.parametrize("change, fragment", [
    ({"enforcement": "evaluate"}, "enforcement=evaluate != active"),
    ({"conditions": {"ref_name": {"include": ["~ALL"]}}}, "ref scope drifted"),
])
def test_structural_drift(capsys, change, fragment):
    rc, out = run(capsys, fake({**INTACT, **change}))
    assert rc == 1 and fragment in out


def test_ruleset_absent_is_drift(capsys):
    rc, out = run(capsys, fake(list_ids=(1, 2)))
    assert rc == 1 and "ruleset 17227141 MISSING" in out


def test_read_failure_is_unverified_not_drift(capsys):
    rc, out = run(capsys, fake(fail=("/rulesets",)))
    assert rc == 0 and out.startswith("::warning::UNVERIFIED - could not read the ruleset (HTTP 401")


def test_no_credential_is_unverified_and_reads_nothing(capsys):
    f = fake()
    rc, out = run(capsys, f, BOT_TOKEN="")
    assert rc == 0 and out.startswith("::warning::UNVERIFIED - no usable credential") and f.calls == []


@pytest.mark.parametrize("history, rc_want, prefix", [
    ([True], 0, "::warning::" + "WATCHDOG_BYPASS_UNVERIFIED - "),
    ([True, True], 1, "::error::" + "WATCHDOG_BYPASS_UNVERIFIED for 3 consecutive runs"),
    ([True, False, True], 0, "::warning::"),
])
def test_blind_streak_escalates_at_the_threshold(capsys, history, rc_want, prefix):
    rs = {k: v for k, v in INTACT.items() if k != "updated_at"}
    f = fake(rs, history=history)
    rc, out = run(capsys, f)
    assert rc == rc_want and prefix in out
    assert all(tok == "hist" for path, tok in f.calls if not path.startswith("/rulesets"))


def test_history_read_failure_never_escalates(capsys):
    rs = {k: v for k, v in INTACT.items() if k != "updated_at"}
    rc, out = run(capsys, fake(rs, history=[True, True], fail=("/actions/",)))
    assert rc == 0 and "Consecutive unverified: 1/3" in out


@pytest.mark.parametrize("key", ["RULESET_ID", "BYPASS_APP_ID", "EXPECT_UPDATED_AT", "REQUIRED_RULES"])
def test_missing_pin_config_fails_without_reading(capsys, key):
    f = fake()
    rc, out = run(capsys, f, **{key: ""})
    assert rc == 1 and out.startswith("::error::") and key in out and f.calls == []


def test_default_fetch_is_a_get_and_maps_http_errors(monkeypatch):
    seen = []

    def urlopen(req, timeout):
        seen.append((req.get_method(), req.data, req.full_url, req.get_header("Authorization")))
        if req.full_url.endswith("/denied"):
            raise urllib.error.HTTPError(req.full_url, 403, "no", {}, None)
        return io.StringIO(json.dumps({"ok": 1}))
    monkeypatch.setattr(wd.urllib.request, "urlopen", urlopen)
    fetch = wd.github_get("o/r")
    assert fetch("/rulesets", "t") == {"ok": 1}
    with pytest.raises(wd.Unverifiable, match="HTTP 403 on /denied"):
        fetch("/denied", "t")
    assert seen[0] == ("GET", None, "https://api.github.com/repos/o/r/rulesets", "token t")
    assert {m for m, *_ in seen} == {"GET"}


def _job():
    return yaml.safe_load(WORKFLOW.read_text())


def test_workflow_triggers_and_token_scope():
    """Security review conditions: schedule from main (no new dispatch input), checkout before the mint with no
    persisted credentials, the bot token in the script step's env only, and no stored-PAT fallback."""
    wf = _job()
    assert wf[True] == {"schedule": [{"cron": "0 8 * * *"}], "workflow_dispatch": None}  # yaml reads `on:` as True
    steps = wf["jobs"]["assert-ruleset"]["steps"]
    co = next(i for i, s in enumerate(steps) if str(s.get("uses", "")).startswith("actions/checkout@"))
    mint = next(i for i, s in enumerate(steps) if s.get("id") == "bot")
    assert co < mint and len(steps[co]["uses"].split("@")[1]) == 40
    assert steps[co]["with"]["persist-credentials"] is False
    users = [s for s in steps if "steps.bot.outputs.token" in json.dumps(s)]
    assert len(users) == 1 and users[0]["run"].strip() == "python3 scripts/ruleset-watchdog.py"
    assert "RULESET_READ_PAT" not in WORKFLOW.read_text()


def test_workflow_env_carries_a_usable_pin():
    env = next(s for s in _job()["jobs"]["assert-ruleset"]["steps"] if "run" in s)["env"]
    assert wd.parse_ts(env["EXPECT_UPDATED_AT"]) is not None
    assert str(env["RULESET_ID"]) == "17227141" and str(env["BYPASS_APP_ID"]) == "3951762"
    # PIN: dropping a rule type here silently stops the watchdog checking it; review against ruleset 17227141.
    assert set(env["REQUIRED_RULES"].split()) == {"pull_request", "non_fast_forward", "deletion", "update"}
