"""Tests for the revert IAM preflight. Pure core + injected simulator — no AWS.

The guard's whole value is that it can tell `allowed` from `implicitDeny`, so
both directions are proven end-to-end through main(): an all-allowed simulator
must exit 0, and flipping ONE action to implicitDeny must exit 1 AND name that
action on its resource. Everything else here is fail-closed coverage — a pair
the simulator never returned, an empty response, a simulator that blew up, and
bad config all have to read as DENIED, never as a pass.
"""
import importlib.util, os

spec = importlib.util.spec_from_file_location(
    "pri", os.path.join(os.path.dirname(__file__), "preflight-revert-iam.py"))
pri = importlib.util.module_from_spec(spec); spec.loader.exec_module(pri)

ROLE = "arn:aws:iam::769788341849:role/garden-app-github-snap"
ENV = {
    "SNAP_AWS_ROLE_ARN": ROLE,
    "SNAP_BUCKET": "garden-snapshots-prod",
    "TARGET_VERSION": "v4.127.0",
    "AWS_REGION": "us-east-1",
    "CF_DIST": "E3FAJTXAORQYDT",
}

# The six (action, resource) pairs the revert can perform, per OPS-REVERTPREFLIGHT.
EXPECTED = [
    ("s3:GetObject", "arn:aws:s3:::garden-snapshots-prod/snapshots/v4.127.0.json"),
    ("s3:GetObject", "arn:aws:s3:::garden-snapshots-prod/db/snap-v4.127.0.dump"),
    ("lambda:GetFunction", "arn:aws:lambda:us-east-1:769788341849:function:garden-plants"),
    ("lambda:PublishVersion", "arn:aws:lambda:us-east-1:769788341849:function:garden-plants"),
    ("lambda:UpdateFunctionCode", "arn:aws:lambda:us-east-1:769788341849:function:garden-plants"),
    ("cloudfront:CreateInvalidation",
     "arn:aws:cloudfront::769788341849:distribution/E3FAJTXAORQYDT"),
]


def fake_simulator(overrides=None, drop=None):
    """Simulator that answers `allowed` for everything except `overrides`/`drop`.

    overrides: {action: decision}. drop: set of actions to omit entirely.
    """
    overrides, drop = overrides or {}, drop or set()

    def _sim(role_arn, actions, resources):
        assert role_arn == ROLE, "preflight must simulate the snap role itself"
        results = []
        for action in actions:
            if action in drop:
                continue
            decision = overrides.get(action, "allowed")
            results.append({
                "EvalActionName": action,
                "EvalResourceName": resources[0],
                "EvalDecision": decision,
                "ResourceSpecificResults": [
                    {"EvalResourceName": r, "EvalResourceDecision": decision}
                    for r in resources
                ],
            })
        return {"EvaluationResults": results}
    return _sim


def groups():
    return pri.required_grants(ROLE, "garden-snapshots-prod", "v4.127.0",
                               "us-east-1", "E3FAJTXAORQYDT")


# --- the required set is the real one (a guard that checks nothing is vacuous) ---

def test_required_grants_cover_exactly_the_six_revert_actions():
    _, checked = pri.evaluate([fake_simulator()(ROLE, a, r) for a, r in groups()], groups())
    assert sorted((a, r) for a, r, _ in checked) == sorted(EXPECTED)


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
    assert "preflight OK — all 6 required actions allowed" in capsys.readouterr().out


# --- direction 2: one action denied -> FAIL, naming it ---

def test_single_implicit_deny_fails_and_names_the_action(capsys):
    rc = pri.main(env=dict(ENV),
                  simulate_fn=fake_simulator({"lambda:UpdateFunctionCode": "implicitDeny"}))
    out = capsys.readouterr().out
    assert rc == 1
    assert ("::error::DENIED (implicitDeny): lambda:UpdateFunctionCode on "
            "arn:aws:lambda:us-east-1:769788341849:function:garden-plants") in out
    assert "1 of 6 required action(s) not allowed" in out
    # the five that ARE allowed must not be reported as denied
    assert out.count("::error::DENIED") == 1


def test_live_deny_pair_is_reported_together(capsys):
    """Today's real state: UpdateFunctionCode + CreateInvalidation both implicitDeny."""
    rc = pri.main(env=dict(ENV), simulate_fn=fake_simulator({
        "lambda:UpdateFunctionCode": "implicitDeny",
        "cloudfront:CreateInvalidation": "implicitDeny",
    }))
    out = capsys.readouterr().out
    assert rc == 1
    assert "2 of 6 required action(s) not allowed" in out
    assert "lambda:UpdateFunctionCode" in out and "cloudfront:CreateInvalidation" in out


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


def test_empty_response_denies_everything():
    denials, checked = pri.evaluate([{}, {}, {}], groups())
    assert len(denials) == len(checked) == 6
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


def test_account_id_comes_from_the_role_arn():
    gs = pri.required_grants("arn:aws:iam::111122223333:role/other", "b", "v1",
                             "us-west-2", "DIST")
    flat = [r for _, rs in gs for r in rs]
    assert "arn:aws:lambda:us-west-2:111122223333:function:garden-plants" in flat
    assert "arn:aws:cloudfront::111122223333:distribution/DIST" in flat


def test_lambda_probe_set_is_not_empty():
    # Emptying LAMBDA_FUNCTIONS would silently skip the Lambda leg entirely.
    assert pri.LAMBDA_FUNCTIONS
    assert "garden-plants" in pri.LAMBDA_FUNCTIONS
