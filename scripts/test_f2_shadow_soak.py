#!/usr/bin/env python3
"""Tests for scripts/f2-shadow-soak.sh + the --flag-overrides mode of scripts/rerun-daily-plan.sh
(V4-WATERMATH-001 F2 shadow-soak tooling).

Bash is exercised the only way bash can be: `bash -n` for syntax, then subprocess runs against a
hermetic PATH shim (fake `aws` + `curl`; real unzip/python3) so every refusal path and the full
soak diff run WITHOUT touching AWS. The invariants under test are the LOUD-vs-SILENT ones:
  * --flag-overrides is dry-only — --live/--ping/--diff combos refuse before anything is invoked;
  * malformed/non-whitelisted/non-boolean overrides refuse (the Lambda would drop them silently);
  * a deployed zip missing the A0.4-FLAG-OVERRIDES sentinel refuses BEFORE any invoke (older
    deploys silently ignore the key — the shadow leg would really be a plain flag-OFF run);
  * plain invocations produce the exact pre-change payloads (byte-for-byte preservation);
  * the soak report handles the due-rows-only ledger asymmetry honestly (absent = notdue).
"""
import json
import os
import stat
import subprocess
import zipfile
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
RERUN = HERE / "rerun-daily-plan.sh"
SOAK = HERE / "f2-shadow-soak.sh"

SENTINELS = {
    "a02": "// A0.2-EVENT-OVERRIDES sentinel",
    "a03": "// A0.3-DRY-PLANS sentinel",
    "a04": "// A0.4-FLAG-OVERRIDES sentinel",
}

FAKE_AWS = """#!/usr/bin/env python3
import json, os, shutil, sys
args = sys.argv[1:]
with open(os.environ["FAKE_AWS_LOG"], "a") as f:
    f.write(json.dumps(args) + "\\n")
if args[:2] == ["lambda", "get-function"]:
    print("https://fake.invalid/code.zip")
elif args[:2] == ["lambda", "invoke"]:
    payload = json.loads(args[args.index("--payload") + 1])
    src = os.environ["FAKE_RESP_LEDGER"] if "flagOverrides" in payload else os.environ["FAKE_RESP_PLAIN"]
    shutil.copy(src, args[-1])
    print(json.dumps({"StatusCode": 200, "ExecutedVersion": "$LATEST"}))
else:
    sys.exit("fake aws: unexpected args: " + " ".join(args))
"""

FAKE_CURL = """#!/usr/bin/env python3
import os, shutil, sys
args = sys.argv[1:]
shutil.copy(os.environ["FAKE_CODE_ZIP"], args[args.index("-o") + 1])
"""


# ---------------------------------------------------------------- fixtures ----

def make_zip(tmp_path, *, a02=True, a03=True, a04=True):
    body = "\n".join(v for k, v in SENTINELS.items() if {"a02": a02, "a03": a03, "a04": a04}[k])
    zpath = tmp_path / "code.zip"
    with zipfile.ZipFile(zpath, "w") as z:
        z.writestr("index.js", body + "\nexports.handler = async () => {};\n")
    return zpath


def make_shims(tmp_path):
    shim = tmp_path / "bin"
    shim.mkdir(exist_ok=True)
    for name, body in (("aws", FAKE_AWS), ("curl", FAKE_CURL)):
        p = shim / name
        p.write_text(body)
        p.chmod(p.stat().st_mode | stat.S_IEXEC)
    return shim


def write_resp(tmp_path, name, obj):
    p = tmp_path / name
    p.write_text(json.dumps(obj))
    return p


def run_script(script, args, tmp_path, *, zip_path=None, plain=None, ledger=None):
    shim = make_shims(tmp_path)
    log = tmp_path / "aws.log"
    env = dict(os.environ,
               PATH=f"{shim}:{os.environ['PATH']}",
               TMPDIR=str(tmp_path),
               FAKE_AWS_LOG=str(log),
               FAKE_CODE_ZIP=str(zip_path or make_zip(tmp_path)),
               FAKE_RESP_PLAIN=str(plain or tmp_path / "missing-plain.json"),
               FAKE_RESP_LEDGER=str(ledger or tmp_path / "missing-ledger.json"))
    r = subprocess.run(["bash", str(script)] + args, capture_output=True, text=True, env=env, timeout=60)
    invokes = []
    if log.exists():
        invokes = [json.loads(l) for l in log.read_text().splitlines() if '"invoke"' in l]
    return r, invokes


def water_row(pid, name, days_since=3, interval=2, ledger=None, never=False, skipped=False):
    row = {"id": pid, "name": name, "crop": name.lower(), "project": None, "project_id": None,
           "in_ground": False, "days_since": None if never else days_since, "interval": interval,
           "overdue_by": None if never else days_since - interval, "never": never}
    if skipped:
        row.update({"saturated": True, "sat_kind": "soak", "reason": "Skip — saturated"})
        row.pop("never")
        row.pop("overdue_by")
    if ledger:
        row["ledger"] = ledger
    return row


LG = lambda d: {"d": d, "due_at": "2026-08-13T22:00:00.000Z", "wi_eff": 2,
                "confidence": "high", "drivers": ["et0_demand"]}


def plan_entry(user_id, water_due=(), no_history=(), rain_skipped=()):
    return {"space_id": "s1", "user_id": user_id, "weather": None, "hydrology": None,
            "plan": {"counts": {}, "tasks": {"water_due": list(water_due), "no_history": list(no_history),
                                             "rain_skipped": list(rain_skipped)}}}


def soak_responses(tmp_path, today="2026-08-13", ledger_dry=True, ledger_today=None):
    # P1 due both | P2 due->notdue | P3 notdue->due | P4 never both | P5 skipped both | P6 due->skipped
    plain = {"ok": True, "today": today, "dryRun": True, "rows": 2, "plans": [
        plan_entry("uA", water_due=[water_row("P1", "Basil"), water_row("P2", "Kale", 4, 3)]),
        plan_entry("uB", water_due=[water_row("P6", "Mint", 5, 4)],
                   no_history=[water_row("P4", "Fig", never=True)],
                   rain_skipped=[water_row("P5", "Rose", 6, 5, skipped=True)]),
    ]}
    ledger = {"ok": True, "today": ledger_today or today, "dryRun": ledger_dry, "rows": 2, "plans": [
        plan_entry("uA", water_due=[water_row("P1", "Basil", ledger=LG(1.2)),
                                    water_row("P3", "Chard", 2, 2, ledger=LG(2.4))]),
        plan_entry("uB", no_history=[water_row("P4", "Fig", never=True)],
                   rain_skipped=[water_row("P5", "Rose", 6, 5, skipped=True, ledger=LG(0.8)),
                                 water_row("P6", "Mint", 5, 4, skipped=True, ledger=LG(1.9))]),
    ]}
    return (write_resp(tmp_path, "plain.json", plain), write_resp(tmp_path, "ledger.json", ledger))


FOVR = '{"CARE_WATER_LEDGER_ENABLED": true}'


# ------------------------------------------------------------------ syntax ----

@pytest.mark.parametrize("script", [RERUN, SOAK], ids=["rerun-daily-plan", "f2-shadow-soak"])
def test_bash_syntax(script):
    r = subprocess.run(["bash", "-n", str(script)], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr


# ----------------------------------------- rerun --flag-overrides refusals ----

@pytest.mark.parametrize("combo,fragment", [
    (["--live"], "DRY-RUN ONLY"),
    (["--ping"], "no effect on a --ping"),
    (["--diff"], "cannot be combined with --diff"),
])
def test_flag_overrides_mode_combos_refuse_before_any_invoke(tmp_path, combo, fragment):
    r, invokes = run_script(RERUN, ["--flag-overrides", FOVR] + combo, tmp_path)
    assert r.returncode != 0
    assert fragment in r.stderr
    assert invokes == []


@pytest.mark.parametrize("bad,fragment", [
    ("{not json", "not valid JSON"),
    ("[true]", "non-empty JSON object"),
    ("{}", "non-empty JSON object"),
    ('{"NOT_A_REAL_FLAG": true}', "whitelist"),
    ('{"CARE_WATER_LEDGER_ENABLED": "true"}', "strict JSON booleans"),
    ('{"CARE_WATER_LEDGER_ENABLED": 1}', "strict JSON booleans"),
])
def test_flag_overrides_validation_refuses(tmp_path, bad, fragment):
    r, invokes = run_script(RERUN, ["--flag-overrides", bad], tmp_path)
    assert r.returncode != 0
    assert fragment in r.stderr
    assert invokes == []


def test_rerun_refuses_when_a04_sentinel_absent(tmp_path):
    zp = make_zip(tmp_path, a04=False)
    r, invokes = run_script(RERUN, ["--flag-overrides", FOVR], tmp_path, zip_path=zp)
    assert r.returncode != 0
    assert "A0.4-FLAG-OVERRIDES" in r.stderr
    assert invokes == [], "nothing may be invoked after a failed sentinel preflight"


def test_rerun_flag_overrides_happy_path_payload(tmp_path):
    plain, ledger = soak_responses(tmp_path)
    r, invokes = run_script(RERUN, ["--flag-overrides", FOVR], tmp_path, plain=plain, ledger=ledger)
    assert r.returncode == 0, r.stderr
    assert "[done] dry run complete" in r.stdout
    assert len(invokes) == 1
    payload = json.loads(invokes[0][invokes[0].index("--payload") + 1])
    assert payload == {"dryRun": True, "flagOverrides": {"CARE_WATER_LEDGER_ENABLED": True}}


def test_rerun_plain_invocation_payload_byte_identical(tmp_path):
    # Existing behavior preserved: no --flag-overrides -> the exact pre-change payload.
    plain, ledger = soak_responses(tmp_path)
    r, invokes = run_script(RERUN, [], tmp_path, plain=plain, ledger=ledger)
    assert r.returncode == 0, r.stderr
    raw = invokes[0][invokes[0].index("--payload") + 1]
    assert raw == '{"dryRun": true}'
    r, invokes = run_script(RERUN, ["--today", "2026-08-01"], tmp_path, plain=plain, ledger=ledger)
    assert r.returncode == 0, r.stderr
    assert invokes[-1][invokes[-1].index("--payload") + 1] == '{"dryRun": true, "today": "2026-08-01"}'


def test_rerun_help_documents_flag_overrides(tmp_path):
    r, _ = run_script(RERUN, ["--help"], tmp_path)
    assert r.returncode == 0
    assert "--flag-overrides" in r.stdout


# ------------------------------------------------------------ f2-shadow-soak ----

def test_soak_has_no_live_mode(tmp_path):
    r, invokes = run_script(SOAK, ["--live"], tmp_path)
    assert r.returncode != 0
    assert "unknown argument" in r.stderr
    assert invokes == []


def test_soak_refuses_when_a04_sentinel_absent(tmp_path):
    zp = make_zip(tmp_path, a04=False)
    r, invokes = run_script(SOAK, ["--out-dir", str(tmp_path / "out")], tmp_path, zip_path=zp)
    assert r.returncode != 0
    assert "A0.4-FLAG-OVERRIDES" in r.stderr
    assert invokes == []


def test_soak_refuses_when_a03_sentinel_absent(tmp_path):
    zp = make_zip(tmp_path, a03=False)
    r, invokes = run_script(SOAK, ["--out-dir", str(tmp_path / "out")], tmp_path, zip_path=zp)
    assert r.returncode != 0
    assert "A0.3-DRY-PLANS" in r.stderr
    assert invokes == []


def test_soak_happy_path_report(tmp_path):
    plain, ledger = soak_responses(tmp_path)
    out = tmp_path / "out"
    r, invokes = run_script(SOAK, ["--out-dir", str(out)], tmp_path, plain=plain, ledger=ledger)
    assert r.returncode == 0, r.stderr
    assert len(invokes) == 2
    p0 = json.loads(invokes[0][invokes[0].index("--payload") + 1])
    p1 = json.loads(invokes[1][invokes[1].index("--payload") + 1])
    assert p0 == {"dryRun": True}
    assert p1 == {"dryRun": True, "flagOverrides": {"CARE_WATER_LEDGER_ENABLED": True}}

    report = json.loads((out / "soak-20260813.json").read_text())
    assert report["schema"] == "f2-soak-v1"
    assert report["plan_date"] == "2026-08-13"
    assert report["summary"] == {"plantings": 6, "due_legacy": 3, "due_ledger": 2, "verdict_flips": 3,
                                 "skipped_legacy": 1, "skipped_ledger": 2, "never_both": 1}
    rows = {p["plant_id"]: p for p in report["plantings"]}
    assert rows["P1"]["delta_class"] == "same" and rows["P1"]["ledger"]["D"] == 1.2
    assert rows["P1"]["ledger"]["due_at"] and rows["P1"]["ledger"]["wi_eff"] == 2
    assert rows["P1"]["ledger"]["confidence"] == "high" and rows["P1"]["ledger"]["drivers"]
    assert rows["P2"]["delta_class"] == "due->notdue" and rows["P2"]["verdict_flip"]
    assert rows["P2"]["ledger"] == {"verdict": "notdue", "due": False}   # absent = not-due, honestly
    assert rows["P3"]["delta_class"] == "notdue->due" and rows["P3"]["verdict_flip"]
    assert rows["P3"]["legacy"] == {"verdict": "notdue", "due": False}
    assert rows["P4"]["delta_class"] == "same" and rows["P4"]["legacy"]["verdict"] == "never"
    assert rows["P5"]["delta_class"] == "same" and not rows["P5"]["verdict_flip"]
    assert rows["P6"]["delta_class"] == "due->skipped" and rows["P6"]["verdict_flip"]
    # legacy side never carries fold fields (flag off -> no ledger key on its rows)
    assert "D" not in rows["P1"]["legacy"]
    assert "3 due-legacy" in r.stdout and "2 due-ledger" in r.stdout and "3 verdict-flips" in r.stdout


def test_soak_idempotent_same_day_overwrite(tmp_path):
    plain, ledger = soak_responses(tmp_path)
    out = tmp_path / "out"
    for _ in range(2):
        r, _ = run_script(SOAK, ["--out-dir", str(out)], tmp_path, plain=plain, ledger=ledger)
        assert r.returncode == 0, r.stderr
    files = sorted(f.name for f in out.iterdir())
    assert files == ["soak-20260813.json"]
    json.loads((out / "soak-20260813.json").read_text())    # still valid after overwrite


def test_soak_dies_on_leg_plan_date_mismatch(tmp_path):
    plain, ledger = soak_responses(tmp_path, ledger_today="2026-08-14")
    out = tmp_path / "out"
    r, _ = run_script(SOAK, ["--out-dir", str(out)], tmp_path, plain=plain, ledger=ledger)
    assert r.returncode != 0
    assert "plan dates differ" in (r.stderr + r.stdout)
    assert not (out / "soak-20260813.json").exists()


def test_soak_dies_on_non_dry_response(tmp_path):
    plain, ledger = soak_responses(tmp_path, ledger_dry=False)
    r, _ = run_script(SOAK, ["--out-dir", str(tmp_path / "out")], tmp_path, plain=plain, ledger=ledger)
    assert r.returncode != 0
    assert "INVARIANT VIOLATION" in (r.stderr + r.stdout)


def test_soak_today_passthrough_and_warning(tmp_path):
    plain, ledger = soak_responses(tmp_path)
    r, invokes = run_script(SOAK, ["--today", "2026-08-13", "--out-dir", str(tmp_path / "out")],
                            tmp_path, plain=plain, ledger=ledger)
    assert r.returncode == 0, r.stderr
    assert "not a historical replay" in r.stderr           # loud --today caveat
    for inv in invokes:
        assert json.loads(inv[inv.index("--payload") + 1])["today"] == "2026-08-13"


def test_soak_rejects_bad_today(tmp_path):
    r, invokes = run_script(SOAK, ["--today", "08/13/2026"], tmp_path)
    assert r.returncode != 0
    assert "YYYY-MM-DD" in r.stderr
    assert invokes == []
