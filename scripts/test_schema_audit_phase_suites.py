"""The three hyphenated schema-audit self-tests, run in build-and-test (OPS-PROMOTESCHEMAGATE-001, review re-check).

Run: python3 -m pytest -q scripts/test_schema_audit_phase_suites.py

scripts/test-schema-audit-phase{1,2,4}.py pin REAL files: phase1 the exact column set of five contracts, phase4 the
garden-node guard's relations and facts about watch-route.js and merge.js. promote-gate.yml's prod schema gate runs
them before the audit and refuses the promote when one fails. Pytest cannot collect them (hyphenated names; ci.yml runs
`scripts/test_*.py`), and before this file only phase1 ran anywhere ahead of a promote, in the ADVISORY
schema-audit.yml. So a legitimate contract edit whose pin did not ride along passed every blocking check and was first
refused by the gate, at promote time, with prod fine (the re-check's `'slug'` on lambda/projects/select-columns.test.js).
Here each suite runs as a subprocess, the way the gate runs it (no NEON_DATABASE_URL in its environment), so that drift
reds the dev push and preflight's build-and-test check blocks the promote before the gate is reached.
"""
import glob
import os
import re
import subprocess
import sys

import pytest
import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
SUITES = ["test-schema-audit-phase1.py", "test-schema-audit-phase2.py", "test-schema-audit-phase4.py"]
GATE = "Prod schema gate — promoted Lambdas' column refs must exist in PROD (L-081; pre-FF, fail-closed)"


def _env():
    """The gate runs each suite under `env -u NEON_DATABASE_URL`: no DSN, so a suite can never reach a database."""
    env = dict(os.environ)
    env.pop("NEON_DATABASE_URL", None)
    return env


def _run(path):
    return subprocess.run([sys.executable, path], cwd=os.path.join(HERE, ".."), env=_env(), capture_output=True,
                          text=True, timeout=120)


def _assert_green(proc, name):
    assert proc.returncode == 0, f"{name} exited {proc.returncode}:\n{proc.stdout[-4000:]}\n{proc.stderr[-2000:]}"


@pytest.mark.parametrize("name", SUITES)
def test_phase_suite_is_green_against_the_real_tree(name):
    """A pin that did not ride along with its contract edit reds here, naming the file and column that moved."""
    _assert_green(_run(os.path.join(HERE, name)), name)


def test_every_hyphenated_phase_suite_on_disk_runs_here():
    """A new or renamed phase suite must be listed, or it goes back to running nowhere before a promote."""
    on_disk = sorted(os.path.basename(p) for p in glob.glob(os.path.join(HERE, "test-schema-audit-phase*.py")))
    assert on_disk == SUITES


def test_the_promote_gate_runs_the_same_suites():
    """This file stands in for the gate's self-tests at the dev push; the two lists must be the same list."""
    with open(os.path.join(HERE, "..", ".github", "workflows", "promote-gate.yml")) as fh:
        wf = yaml.safe_load(fh)
    body = next(s for s in wf["jobs"]["promote"]["steps"] if s.get("name") == GATE)["run"]
    loop = re.search(r"^\s*for t in ([\d ]+); do$", body, re.M)
    assert loop and 'scripts/test-schema-audit-phase$t.py' in body
    assert [f"test-schema-audit-phase{t}.py" for t in loop.group(1).split()] == SUITES


def test_the_suites_never_see_the_prod_dsn(monkeypatch):
    monkeypatch.setenv("NEON_DATABASE_URL", "postgresql://prod.invalid/db")
    assert "NEON_DATABASE_URL" not in _env()


@pytest.mark.parametrize("contract,want", [
    # A real `name` on ANOTHER relation: only the exact-relation-set pin reds (it is meant to: a new relation needs
    # its pin edit). The ban stays quiet; before 2026-09-24 it read every relation's columns and red here too.
    ("garden_node: ['id', 'display_name'],\n  container: ['id'],\n  source: ['id', 'name'],",
     ["garden-node guard declares garden_node and the container it joins"]),
    # `name` on garden_node itself, the column that did not exist (BUG-SEEDDETAIL500-001): the ban reds.
    ("garden_node: ['id', 'display_name', 'name'],\n  container: ['id'],",
     ["garden-node guard does NOT declare `name` on garden_node (the column that did not exist)"]),
], ids=["name-on-another-relation", "name-on-garden_node"])
def test_phase4_name_ban_reads_garden_node_alone(tmp_path, contract, want):
    """phase4 against a scratch tree: its own copy, the real auditor, and a synthetic garden-node guard. The
    watch-route.js and merge.js checks are skipped there by the suite's own `if exists()`; section 8 runs in full."""
    (tmp_path / "scripts").mkdir()
    for name in ("test-schema-audit-phase4.py", "dev-main-schema-audit.py"):
        with open(os.path.join(HERE, name)) as src, open(tmp_path / "scripts" / name, "w") as dst:
            dst.write(src.read())
    guard = tmp_path / "lambda" / "inventory-items" / "garden-node-columns.test.js"
    guard.parent.mkdir(parents=True)
    guard.write_text("const AUDIT_COLUMNS = {\n  " + contract + "\n};\n")
    proc = _run(str(tmp_path / "scripts" / "test-schema-audit-phase4.py"))
    assert proc.returncode == 1, proc.stdout + proc.stderr
    assert [ln[len("FAIL - "):] for ln in proc.stdout.splitlines() if ln.startswith("FAIL - ")] == want, proc.stdout


def test_a_red_suite_reads_red(tmp_path):
    """The runner and the assertion both carry the child's failure: an exit 1 is a red test, with its output."""
    red = tmp_path / "red.py"
    red.write_text("print('FAIL - planted pin drift')\nraise SystemExit(1)\n")
    proc = _run(str(red))
    assert proc.returncode == 1
    with pytest.raises(AssertionError, match="FAIL - planted pin drift"):
        _assert_green(proc, "red.py")
