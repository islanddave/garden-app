"""Tests for the Lambda config drift guard. Pure-core only — no AWS, no network."""
import importlib.util, json, os
spec = importlib.util.spec_from_file_location(
    "clc", os.path.join(os.path.dirname(__file__), "check-lambda-config.py"))
clc = importlib.util.module_from_spec(spec); spec.loader.exec_module(clc)


def live(mem=256, timeout=30, **env):
    return {"MemorySize": mem, "Timeout": timeout, "Environment": {"Variables": dict(env)}}


# --- memory / timeout --------------------------------------------------------

def test_memory_match_is_clean():
    assert clc.check_function("garden-plants", {"memory": 1024}, live(mem=1024)) == []

def test_memory_drift_is_reported():
    v = clc.check_function("garden-plants", {"memory": 1024}, live(mem=256))
    assert len(v) == 1 and "MemorySize is 256" in v[0] and "declares 1024" in v[0]

def test_timeout_drift_is_reported():
    v = clc.check_function("garden-daily-plan", {"timeout": 120}, live(timeout=30))
    assert len(v) == 1 and "Timeout is 30" in v[0]

def test_unstated_memory_is_not_asserted():
    assert clc.check_function("x", {"env": {}}, live(mem=9999)) == []


# --- the absent-vs-false distinction (the bug this file exists for) ----------

def test_absent_flag_when_a_value_is_declared_fails():
    """CARE_WATER_LEDGER_ENABLED-class: declared on, live map simply has no such key."""
    v = clc.check_function("garden-daily-plan",
                           {"env": {"CARE_WATER_LEDGER_ENABLED": "true"}}, live())
    assert len(v) == 1
    assert "is ABSENT" in v[0] and "Absent is NOT false" in v[0]

def test_false_is_not_absent():
    """A flag explicitly set to 'false' must NOT satisfy an expectation of absent."""
    v = clc.check_function("f", {"env": {"FLAG": None}}, live(FLAG="false"))
    assert len(v) == 1 and "is PRESENT" in v[0] and "declares it ABSENT" in v[0]

def test_absent_satisfies_an_absent_expectation():
    assert clc.check_function("f", {"env": {"FLAG": None}}, live()) == []

def test_wrong_value_is_reported():
    v = clc.check_function("f", {"env": {"FLAG": "true"}}, live(FLAG="false"))
    assert len(v) == 1 and "is 'false'" in v[0] and "declares 'true'" in v[0]


# --- present-any-value sentinel ---------------------------------------------

def test_present_any_value_satisfied():
    assert clc.check_function("f", {"env": {"GARDEN_HOUSEHOLD_IDS": True}},
                              live(GARDEN_HOUSEHOLD_IDS="user_a,user_b")) == []

def test_present_any_value_fails_when_wiped():
    """The set-not-merge wipe: the key is gone, so household scope fail-closes to [caller]."""
    v = clc.check_function("garden-harvests", {"env": {"GARDEN_HOUSEHOLD_IDS": True}}, live())
    assert len(v) == 1 and "requires it PRESENT" in v[0]

def test_present_any_value_accepts_empty_string():
    assert clc.check_function("f", {"env": {"K": True}}, live(K="")) == []


# --- degenerate live shapes --------------------------------------------------

def test_missing_function_is_a_violation_not_a_skip():
    v = clc.check_function("garden-gone", {"memory": 256}, None)
    assert len(v) == 1 and "DOES NOT EXIST" in v[0]

def test_null_environment_block_reads_as_empty_not_a_crash():
    """A function with zero env vars has Environment absent entirely, not {'Variables': {}}."""
    v = clc.check_function("f", {"env": {"K": True}}, {"MemorySize": 256, "Environment": None})
    assert len(v) == 1 and "is ABSENT" in v[0]

def test_violations_accumulate_across_dimensions():
    v = clc.check_function("f", {"memory": 512, "timeout": 60, "env": {"A": True, "B": None}},
                           live(mem=256, timeout=30, B="true"))
    assert len(v) == 4


# --- the shipped manifest itself --------------------------------------------

def test_manifest_parses_and_drops_doc_keys():
    m = clc.load_manifest()
    assert "_README" not in m
    assert all(not k.startswith("_") for spec in m.values() for k in spec)

def test_manifest_covers_every_function_in_the_deploy_matrix():
    """A function deployed but undeclared is exactly the gap this track closed."""
    wf = os.path.join(os.path.dirname(__file__), "..", ".github", "workflows", "deploy-lambda.yml")
    with open(wf) as fh:
        line = next(l for l in fh if l.strip().startswith("function: ["))
    matrix = [f.strip() for f in line.split("[", 1)[1].rsplit("]", 1)[0].split(",")]
    declared = clc.load_manifest()
    missing = ["garden-" + f for f in matrix if "garden-" + f not in declared]
    assert missing == [], "deployed but undeclared: %s" % missing

def test_manifest_env_values_are_only_the_three_legal_shapes():
    for fn, spec in clc.load_manifest().items():
        for k, want in (spec.get("env") or {}).items():
            assert want is None or want is True or isinstance(want, str), \
                "%s.%s: %r is not null / true / string" % (fn, k, want)

def test_plants_memory_bump_is_declared():
    """OPS-PLANTSLAMBDACPU-001 — the live 1024MB must stay codified, not drift back to a comment."""
    assert clc.load_manifest()["garden-plants"]["memory"] == 1024

def test_daily_plan_water_ledger_flags_are_declared_absent():
    """Their absence is INTENTIONAL. Declaring it is what makes an accidental flip visible."""
    env = clc.load_manifest()["garden-daily-plan"]["env"]
    assert env["CARE_WATER_LEDGER_ENABLED"] is None
    assert env["CARE_RAIN_MAXDAYS_ENABLED"] is None
    assert env["CARE_RAIN_CREDIT_ENABLED"] == "true"

def test_rain_autolog_flag_is_declared_present_and_explicit():
    """BUG-RAINAUTOLOGCLIFF-001 — the inverse of the test above, and the harder case.

    logRainEvents is armed by the ABSENCE of RAIN_AUTOLOG_ENABLED, and has been authoring the latest
    water event for 217 of 239 live plantings that way. Absence-arming is invisible to recon: you
    cannot grep for a variable nobody set, so every prior investigation of this writer went to
    CARE_WATER_LEDGER_ENABLED instead. Declaring the exact value prod already behaves as makes the
    switch auditable without changing what it does — and a `null` here would put it straight back.
    """
    env = clc.load_manifest()["garden-daily-plan"]["env"]
    assert env["RAIN_AUTOLOG_ENABLED"] == "true", \
        "the arming state must be readable from a VALUE; null re-creates the absence-armed defect"


def test_deploy_workflow_sets_the_rain_autolog_key_the_manifest_declares():
    """The two config surfaces have to agree, and only one of them can WRITE.

    check-lambda-config.py ignores a live key the manifest omits but hard-reds a declared key the
    live account lacks, so a declaration with no setter behind it reds every promote — which is what
    AWN_STATIONS_JSON did on 2026-08-27. This asserts the deploy job's daily-plan env merge actually
    adds the key, on the executable lines only: a mention in a comment is not a setter.
    """
    wf = os.path.join(os.path.dirname(__file__), "..", ".github", "workflows", "deploy-lambda.yml")
    with open(wf) as fh:
        code = "\n".join(l for l in fh.read().splitlines() if not l.strip().startswith("#"))
    assert 'RAIN_AUTOLOG_ENABLED:"true"' in code.replace(" ", ""), \
        "manifest declares RAIN_AUTOLOG_ENABLED but no deploy step ensures it — every promote reds"
    # ADD-IF-MISSING, not overwrite: a deliberate live 'false' is the incident kill switch.
    assert 'ifhas("RAIN_AUTOLOG_ENABLED")then.else' in code.replace(" ", ""), \
        "the merge must preserve an existing value — a deploy that re-arms a kill switch is not one"


def test_manifest_declares_every_env_var_daily_plan_reads():
    """The daily-plan flag set is declared EXHAUSTIVELY — a read-but-undeclared var is how
    CARE_WATER_LEDGER_ENABLED stayed invisible. Adding a process.env read must add a declaration."""
    root = os.path.join(os.path.dirname(__file__), "..", "lambda", "daily-plan")
    import re
    found = set()
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d != "node_modules"]
        for name in filenames:
            if name.endswith((".js", ".mjs")):
                with open(os.path.join(dirpath, name)) as fh:
                    found |= set(re.findall(r"process\.env\.([A-Z][A-Z0-9_]*)", fh.read()))
    declared = set(clc.load_manifest()["garden-daily-plan"]["env"])
    assert found - declared == set(), "daily-plan reads undeclared env: %s" % sorted(found - declared)


# --- Function URL / CORS (OPS-DEPLOYCOESILENT-001) ----------------------------

def url_cfg(*origins):
    return {"FunctionUrl": "https://x.lambda-url.us-east-1.on.aws/",
            "Cors": {"AllowOrigins": list(origins)}}

PROD = "https://garden.futureishere.net"

def test_url_not_declared_asserts_nothing():
    """Same non-exhaustive rule as env: a spec with no "url" key must not start failing."""
    assert clc.check_function_url("garden-plants", {"memory": 1024}, url_cfg(PROD)) == []
    assert clc.check_function_url("garden-plants", {"memory": 1024}, None) == []

def test_url_matching_cors_is_clean():
    assert clc.check_function_url("garden-plants", {"url": {"cors_origins": [PROD]}}, url_cfg(PROD)) == []

def test_url_cors_drift_is_reported():
    v = clc.check_function_url("garden-plants", {"url": {"cors_origins": [PROD]}},
                               url_cfg("https://evil.example"))
    assert len(v) == 1 and "evil.example" in v[0] and "L-097" in v[0]

def test_url_cors_order_does_not_matter():
    """Origin order is not semantic; a reorder must not red a deploy."""
    a, b = PROD, "https://staging.example"
    assert clc.check_function_url("f", {"url": {"cors_origins": [a, b]}}, url_cfg(b, a)) == []

def test_url_required_but_absent_is_reported():
    v = clc.check_function_url("garden-plants", {"url": {"cors_origins": [PROD]}}, None)
    assert len(v) == 1 and "has NO Function URL" in v[0]

def test_url_forbidden_but_present_is_reported():
    """The event-driven functions must not silently gain a public HTTP entry point."""
    v = clc.check_function_url("garden-daily-plan", {"url": None}, url_cfg(PROD))
    assert len(v) == 1 and "must have NONE" in v[0]

def test_url_forbidden_and_absent_is_clean():
    assert clc.check_function_url("garden-daily-plan", {"url": None}, None) == []

def test_url_declared_without_cors_origins_asserts_existence_only():
    assert clc.check_function_url("f", {"url": {}}, url_cfg("https://anything")) == []
    assert len(clc.check_function_url("f", {"url": {}}, None)) == 1

def test_url_missing_cors_block_reads_as_empty_not_a_crash():
    v = clc.check_function_url("f", {"url": {"cors_origins": [PROD]}}, {"FunctionUrl": "x"})
    assert len(v) == 1 and "[]" in v[0]


# --- EventBridge rules (OPS-DEPLOYCOESILENT-001) ------------------------------

def test_rules_all_present_is_clean():
    exp = [{"name": "r1", "state": "ENABLED", "targets": 1}]
    assert clc.check_event_rules(exp, {"r1": {"State": "ENABLED", "Targets": 1}}) == []

def test_missing_rule_is_reported():
    v = clc.check_event_rules([{"name": "r1"}], {})
    assert len(v) == 1 and "DOES NOT EXIST" in v[0]

def test_disabled_rule_is_reported():
    v = clc.check_event_rules([{"name": "r1", "state": "ENABLED"}],
                              {"r1": {"State": "DISABLED", "Targets": 1}})
    assert len(v) == 1 and "dark schedule" in v[0]

def test_zero_targets_is_reported():
    """A rule that exists and fires into nothing is the state describe-rule alone cannot show."""
    v = clc.check_event_rules([{"name": "r1", "targets": 1}], {"r1": {"State": "ENABLED", "Targets": 0}})
    assert len(v) == 1 and "fires into nothing" in v[0]

def test_double_target_is_reported():
    v = clc.check_event_rules([{"name": "r1", "targets": 1}], {"r1": {"State": "ENABLED", "Targets": 2}})
    assert len(v) == 1 and "double-fires" in v[0]

def test_rule_violations_accumulate():
    v = clc.check_event_rules([{"name": "r1", "state": "ENABLED", "targets": 1}],
                              {"r1": {"State": "DISABLED", "Targets": 3}})
    assert len(v) == 2

def test_unstated_rule_dimensions_are_not_asserted():
    assert clc.check_event_rules([{"name": "r1"}], {"r1": {"State": "DISABLED", "Targets": 9}}) == []


# --- manifest shape -----------------------------------------------------------

def test_manifest_url_values_are_only_the_two_legal_shapes():
    for fn, spec in clc.load_manifest().items():
        if "url" not in spec:
            continue
        want = spec["url"]
        assert want is None or isinstance(want, dict), "%s.url: %r is not null / object" % (fn, want)

def test_every_declared_function_declares_a_url_expectation():
    """Silence is the defect this closed; an undeclared URL asserts nothing at all."""
    missing = [fn for fn, spec in clc.load_manifest().items() if "url" not in spec]
    assert missing == [], "no url expectation declared for: %s" % missing

def test_eventbridge_block_is_loaded_and_well_formed():
    rules = clc.load_eventbridge()
    assert len(rules) >= 4, "expected the four live schedules to be declared"
    for r in rules:
        assert isinstance(r.get("name"), str) and r["name"]
        assert r.get("state") in (None, "ENABLED", "DISABLED")
        assert r.get("targets") is None or isinstance(r["targets"], int)

def test_eventbridge_is_not_returned_as_a_function():
    """load_manifest() must stay FUNCTIONS ONLY — --function and three other tests rely on it."""
    assert "eventbridge" not in clc.load_manifest()

def test_intraday_rules_are_declared():
    """A0.3 verifies only garden-daily-plan-nightly; these two were verified by nothing."""
    names = {r["name"] for r in clc.load_eventbridge()}
    assert {"garden-daily-plan-intraday-am", "garden-daily-plan-intraday-pm"} <= names
