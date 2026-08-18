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
