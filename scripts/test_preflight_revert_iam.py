"""Tests for the revert IAM preflight. Pure core + injected simulator — no AWS.

The guard's whole value is that it can tell `allowed` from a denial, so both directions are
proven end-to-end through main(): an all-allowed simulator must exit 0, and denying ONE
(action, resource) pair must exit 1 AND name exactly that pair. Everything else is fail-closed
coverage — a pair the simulator never returned, an empty response, a simulator that blew up,
bad config — plus the OPS-REVERTRESTORE-001 scope: every release function, the qualified package
read, no CloudFront, and parity with the AWS calls the revert actually makes.
"""
import importlib.util
import os
import re

import lambda_fleet

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("pri", os.path.join(HERE, "preflight-revert-iam.py"))
pri = importlib.util.module_from_spec(spec); spec.loader.exec_module(pri)

ROLE = "arn:aws:iam::769788341849:role/garden-app-github-snap"
ENV = {
    "SNAP_AWS_ROLE_ARN": ROLE,
    "SNAP_BUCKET": "garden-snapshots-prod",
    "TARGET_VERSION": "v4.127.0",
    "AWS_REGION": "us-east-1",
    # main's revert-gate.yml still passes CF_DIST until the next promote; it must be ignored
    "CF_DIST": "E3FAJTXAORQYDT",
}
FN = "arn:aws:lambda:us-east-1:769788341849:function:"
OLD11 = ["garden-dashboard", "garden-events", "garden-favorites", "garden-inventory-items",
         "garden-locations", "garden-photos", "garden-plants", "garden-projects",
         "garden-varieties", "garden-app-events", "garden-achievements"]


def fake_simulator(overrides=None, drop=None):
    """Simulator that answers `allowed` for everything except `overrides`/`drop`.

    overrides: {action | (action, resource): decision} — a pair key beats an action key.
    drop: set of actions to omit from the response entirely.
    """
    overrides, drop = overrides or {}, drop or set()

    def _sim(role_arn, actions, resources):
        assert role_arn == ROLE, "preflight must simulate the snap role itself"
        results = []
        for action in actions:
            if action in drop:
                continue
            specific = [{"EvalResourceName": r,
                         "EvalResourceDecision": overrides.get((action, r), overrides.get(action, "allowed"))}
                        for r in resources]
            results.append({
                "EvalActionName": action,
                "EvalResourceName": resources[0],
                "EvalDecision": specific[0]["EvalResourceDecision"],
                "ResourceSpecificResults": specific,
            })
        return {"EvaluationResults": results}
    return _sim


def exact_match_simulator(granted):
    """IAM resource matching for grants written WITHOUT wildcards: allowed iff the exact
    (action, resource) pair is granted. Enough to model the gap proven live on 2026-09-11 —
    an unqualified function grant does not cover the qualified ARN a version read uses."""
    def _sim(role_arn, actions, resources):
        return {"EvaluationResults": [{
            "EvalActionName": a, "EvalResourceName": resources[0], "EvalDecision": "n/a",
            "ResourceSpecificResults": [
                {"EvalResourceName": r,
                 "EvalResourceDecision": "allowed" if (a, r) in granted else "implicitDeny"}
                for r in resources]} for a in actions]}
    return _sim


def groups():
    return pri.required_grants(ROLE, "garden-snapshots-prod", "v4.127.0", "us-east-1")


def checked_pairs():
    _, checked = pri.evaluate([fake_simulator()(ROLE, a, r) for a, r in groups()], groups())
    return {(a, r) for a, r, _ in checked}


# --- the required set is the real one (a guard that checks nothing is vacuous) ---

def test_required_set_is_106_pairs():
    """2 snapshot objects + 3 unqualified actions x 26 functions + 1 qualified read x 26."""
    assert len(checked_pairs()) == 106


def test_snapshot_objects_are_required():
    pairs = checked_pairs()
    assert ("s3:GetObject", "arn:aws:s3:::garden-snapshots-prod/snapshots/v4.127.0.json") in pairs
    assert ("s3:GetObject", "arn:aws:s3:::garden-snapshots-prod/db/snap-v4.127.0.dump") in pairs


def test_every_release_function_is_probed_for_every_snap_role_action():
    pairs = checked_pairs()
    for fn in lambda_fleet.release_functions():
        for action in ("lambda:PublishVersion", "lambda:GetFunctionConfiguration",
                       "lambda:UpdateFunctionCode"):
            assert (action, FN + fn) in pairs, (action, fn)
        assert ("lambda:GetFunction", FN + fn + ":1") in pairs, fn
    # literal spot checks: one of the 15 the old one-function scope never probed, and the old one
    assert ("lambda:UpdateFunctionCode", FN + "garden-harvests") in pairs
    assert ("lambda:GetFunction", FN + "garden-plants:1") in pairs


def test_no_cloudfront_and_nothing_outside_the_release_set():
    pairs = checked_pairs()
    assert not [p for p in pairs if p[0].startswith("cloudfront:")]
    assert not [p for p in pairs if "garden-library-favorites" in p[1] or "-staging" in p[1]]


def test_s3_and_lambda_are_not_cross_producted():
    for actions, resources in groups():
        svc = {a.split(":")[0] for a in actions}
        assert len(svc) == 1, f"{actions} mixes services into one simulate call"
        service = svc.pop()
        for r in resources:
            assert r.split(":")[2] == service, f"{service} actions asked against {r}"


# --- direction 1: every action allowed -> PASS ---

def test_all_allowed_passes(capsys):
    rc = pri.main(env=dict(ENV), simulate_fn=fake_simulator())
    assert rc == 0
    assert "preflight OK — all 106 required actions allowed" in capsys.readouterr().out


# --- direction 2: one pair denied -> FAIL, naming exactly it ---

def test_single_implicit_deny_fails_and_names_exactly_that_pair(capsys):
    rc = pri.main(env=dict(ENV), simulate_fn=fake_simulator(
        {("lambda:UpdateFunctionCode", FN + "garden-harvests"): "implicitDeny"}))
    out = capsys.readouterr().out
    assert rc == 1
    assert f"::error::DENIED (implicitDeny): lambda:UpdateFunctionCode on {FN}garden-harvests" in out
    assert "1 of 106 required action(s) not allowed" in out
    assert out.count("::error::DENIED") == 1  # the 105 allowed pairs are not smeared into it


def test_unqualified_only_grant_fails_the_qualified_package_read(capsys):
    """Premise P2: a role granted GetFunction on the UNQUALIFIED ARN only passes every other check
    yet cannot read a version's package. The preflight must refuse it and name the pair."""
    granted = {(a, r) for a, r in checked_pairs() if a != "lambda:GetFunction"}
    granted |= {("lambda:GetFunction", FN + fn) for fn in lambda_fleet.release_functions()}
    rc = pri.main(env=dict(ENV), simulate_fn=exact_match_simulator(granted))
    out = capsys.readouterr().out
    assert rc == 1
    assert f"::error::DENIED (implicitDeny): lambda:GetFunction on {FN}garden-plants:1" in out
    assert "26 of 106 required action(s) not allowed" in out


def test_todays_live_role_is_refused(capsys):
    """The live snap-ops (POST-PREFLIGHT): publish/read on the old 11 only, nothing else Lambda."""
    granted = {p for p in checked_pairs() if p[0] == "s3:GetObject"}
    for fn in OLD11:
        granted |= {("lambda:PublishVersion", FN + fn), ("lambda:GetFunctionConfiguration", FN + fn),
                    ("lambda:GetFunction", FN + fn)}  # unqualified, exactly as live
    rc = pri.main(env=dict(ENV), simulate_fn=exact_match_simulator(granted))
    out = capsys.readouterr().out
    assert rc == 1
    # 15 x (PublishVersion + GetFunctionConfiguration) + 26 UpdateFunctionCode + 26 qualified reads
    assert "82 of 106 required action(s) not allowed" in out


def test_explicit_deny_also_fails(capsys):
    rc = pri.main(env=dict(ENV),
                  simulate_fn=fake_simulator({"s3:GetObject": "explicitDeny"}))
    out = capsys.readouterr().out
    assert rc == 1
    # explicitDeny hits BOTH snapshot objects
    assert out.count("::error::DENIED (explicitDeny): s3:GetObject") == 2


# --- fail-closed: absence of a verdict is a denial, never a pass ---

def test_omitted_action_counts_as_missing(capsys):
    rc = pri.main(env=dict(ENV), simulate_fn=fake_simulator(drop={"lambda:PublishVersion"}))
    out = capsys.readouterr().out
    assert rc == 1
    assert "::error::DENIED (MISSING): lambda:PublishVersion" in out
    assert "26 of 106 required action(s) not allowed" in out


def test_empty_response_denies_everything():
    denials, checked = pri.evaluate([{}, {}, {}], groups())
    assert len(denials) == len(checked) == 106
    assert {d for _, _, d in denials} == {"MISSING"}


def test_simulator_failure_is_not_a_pass(capsys):
    def boom(*_a, **_k):
        raise pri.PreflightError("AccessDenied calling SimulatePrincipalPolicy")
    rc = pri.main(env=dict(ENV), simulate_fn=boom)
    assert rc == 2
    assert "could not complete" in capsys.readouterr().out


def test_blank_decision_is_missing():
    assert pri.decisions({"EvaluationResults": [
        {"EvalActionName": "s3:GetObject", "EvalResourceName": "arn:x",
         "ResourceSpecificResults": [{"EvalResourceName": "arn:x", "EvalResourceDecision": ""}]}
    ]}) == {("s3:getobject", "arn:x"): "MISSING"}


def test_casing_echo_change_does_not_drop_a_pair():
    sim = fake_simulator()

    def shouty(role_arn, actions, resources):
        r = sim(role_arn, actions, resources)
        for res in r["EvaluationResults"]:
            res["EvalActionName"] = res["EvalActionName"].upper()
            for rsr in res["ResourceSpecificResults"]:
                rsr["EvalResourceName"] = rsr["EvalResourceName"].upper()
        return r
    denials, _ = pri.run(ROLE, groups(), simulate_fn=shouty)
    assert denials == []


# --- fail-closed: bad config aborts rather than skipping the check ---

def test_missing_role_arn_aborts(capsys):
    rc = pri.main(env={k: v for k, v in ENV.items() if k != "SNAP_AWS_ROLE_ARN"},
                  simulate_fn=fake_simulator())
    assert rc == 2
    assert "SNAP_AWS_ROLE_ARN is empty" in capsys.readouterr().out


def test_empty_bucket_aborts(capsys):
    rc = pri.main(env={**ENV, "SNAP_BUCKET": ""}, simulate_fn=fake_simulator())
    assert rc == 2
    assert "SNAP_BUCKET is empty" in capsys.readouterr().out


def test_bad_target_version_aborts(capsys):
    rc = pri.main(env={**ENV, "TARGET_VERSION": "4.127.0; rm -rf /"},
                  simulate_fn=fake_simulator())
    assert rc == 2
    assert "invalid" in capsys.readouterr().out


def test_non_role_arn_aborts(capsys):
    rc = pri.main(env={**ENV, "SNAP_AWS_ROLE_ARN": "garden-app-github-snap"},
                  simulate_fn=fake_simulator())
    assert rc == 2
    assert "not an IAM role ARN" in capsys.readouterr().out


def test_unreadable_release_set_aborts_rather_than_probing_nothing(monkeypatch, capsys):
    def boom():
        raise lambda_fleet.FleetError("cannot read the Lambda release set")
    monkeypatch.setattr(pri.lambda_fleet, "release_functions", boom)
    rc = pri.main(env=dict(ENV), simulate_fn=fake_simulator())
    assert rc == 2
    assert "cannot read the Lambda release set" in capsys.readouterr().out


def test_account_id_comes_from_the_role_arn():
    gs = pri.required_grants("arn:aws:iam::111122223333:role/other", "b", "v1", "us-west-2")
    flat = [r for _, rs in gs for r in rs]
    assert "arn:aws:lambda:us-west-2:111122223333:function:garden-plants" in flat
    assert "arn:aws:lambda:us-west-2:111122223333:function:garden-plants:1" in flat


# --- parity: the preflight asserts every AWS call the revert makes as the snap role ---

AWS_METHOD_ACTIONS = {
    # boto3 method                  IAM action                           preflight group
    "get_object": ("s3:GetObject", "s3"),
    "download_file": ("s3:GetObject", "s3"),
    "get_function": ("lambda:GetFunction", "qualified"),
    "get_function_configuration": ("lambda:GetFunctionConfiguration", "lambda"),
    "update_function_code": ("lambda:UpdateFunctionCode", "lambda"),
    "publish_version": ("lambda:PublishVersion", "lambda"),
}


def _aws_calls(filename, receivers):
    with open(os.path.join(HERE, filename)) as fh:
        src = fh.read()
    return set(re.findall(r"\b(?:%s)\.([a-z_]+)\(" % "|".join(receivers), src)), src


def test_every_aws_call_the_revert_makes_is_asserted_by_the_preflight():
    """L1's gap was an AWS call the role could not make; P2 was a call shape nobody simulated.
    Any boto3 call added to revert-to.py, or to snap.py's Lambda client, must be mapped here AND
    asserted by the preflight (AND granted in snap-ops), or this fails."""
    group_actions = {"s3": [pri.S3_READ], "lambda": pri.LAMBDA_ACTIONS, "qualified": pri.QUALIFIED_ACTIONS}
    rt_calls, rt_src = _aws_calls("revert-to.py", ["client", "s3"])
    snap_calls, _ = _aws_calls("snap.py", ["client"])
    assert {"get_object", "download_file", "get_function", "update_function_code",
            "get_function_configuration"} <= rt_calls, "the scan stopped seeing revert-to.py's AWS calls"
    assert {"publish_version", "get_function_configuration"} <= snap_calls
    for m in sorted(rt_calls | snap_calls):
        assert m in AWS_METHOD_ACTIONS, f"unmapped AWS call {m}(): map it AND add it to the preflight + snap-ops"
        action, grp = AWS_METHOD_ACTIONS[m]
        assert action in group_actions[grp], f"{m}() needs {action} ({grp}) but the preflight does not assert it"
    assert 'client("cloudfront")' not in rt_src, "revert-to.py grew a CloudFront client the snap role cannot use"
