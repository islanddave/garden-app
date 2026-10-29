# new-file: new subject, the GUARD-marker registry (POLICY.md section D) has no test file
"""GUARD registry (POLICY.md section D, DEC-TESTPOLICY-001), DB-free and network-free.

Run: python3 -m pytest -q scripts/test_guard_registry.py   the checks
     python3 scripts/test_guard_registry.py                the registry: every marked file, every flag-off rehearsal

A file carrying `// GUARD: <tag>` (Python `# GUARD: <tag>`) in its first 5 lines is merge-only (POLICY.md rule A6).
A guard counts as running only if a runner collects it, it is in no EXCLUDE list, and no skip, continue-on-error or
warning-only exit can hide it. This file checks that for every marked file, against the same inputs CI uses: the
unit legs' `vitest run` steps and vitest.config.ts's exclude, and the pytest leg's glob, all in ci.yml.
SEED is section D's seed set: each must carry its marker, so deleting a marker is red too.

package.json's flag-off rehearsals (`test:flag-off`, `test:flag-off:*`) run in no workflow. NOT_RUNNING lists
them so that stays visible; wiring one into CI or retiring it with its flag is Dave's call per flag, and either
change is an edit to NOT_RUNNING.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

MARKER = re.compile(r"(//|#) GUARD: (security|ruling|gate-input|food-safety|fidelity)")
SECREVIEW = "OPS-SECREVIEW-001 do-not-remove list"

# path or glob -> (tag, the reason written on the marker line)
SEED = {
    "lambda/household-isolation.test.js": ("security", SECREVIEW),
    "lambda/authz-write-fk.test.js": ("security", SECREVIEW),
    "lambda/authz-parents-copies-sync.test.js": ("security", SECREVIEW),
    "lambda/household-copies-sync.test.js": ("security", SECREVIEW),
    "lambda/household-columns-sync.test.js": ("security", SECREVIEW),
    "lambda/**household-columns.test.js": ("security", SECREVIEW),
    "lambda/photo-access-copies-sync.test.js": ("security", SECREVIEW),
    "lambda/http-response-copies-sync.test.js": ("security", SECREVIEW),
    "lambda/imageMetadataStrip-copies-sync.test.js": ("security", SECREVIEW),
    "lambda/tenancy-*.static.test.js": ("security", SECREVIEW),
    "lambda/tenancy-classes.test.js": ("security", SECREVIEW),
    "lambda/public-repo-literals.static.test.js": ("security", SECREVIEW),
    "lambda/deploy-zip-excludes-tests.test.js": ("security", SECREVIEW),
    "lambda/set-featured-write-guards.test.js": ("security", SECREVIEW),
    "scripts/test_deploy_main_guard.py": ("security", SECREVIEW),
    "lambda/*/household-mode.test.js": ("security", "household isolation"),
    "lambda/events/status-advance-scope.test.js": ("security", "household ownership predicate, no integration twin yet"),
    "lambda/daily-plan/rain-roof-rule.test.js": (
        "ruling", "v4-rainbackfill-001 post_no_rain_backfilled_onto_a_covered_planting; the synthetic fixtures are load-bearing"),
    "lambda/daily-plan/rain-live-filter.test.js": (
        "ruling", "no rain on a deleted planting, so the events_to_deleted_plants census stays readable"),
    "lambda/preservation/batchbuilder-migration.static.test.js": ("ruling", "v5-batchbuilder-001 post_no_dead_pick_link"),
    "lambda/*/softdel-feed.test.js": ("ruling", "DEC-TESTPOLICY-001: merge-only until tests/integration has a twin"),
    "lambda/plants/variety-clear.test.js": ("ruling", "DEC-TESTPOLICY-001: merge-only until tests/integration has a twin"),
    "lambda/plants/archived-route.test.js": ("ruling", "DEC-TESTPOLICY-001: merge-only until tests/integration has a twin"),
    "src/__tests__/PutUpPhReading.test.jsx": ("food-safety", "PH_CHECK_DAYS"),
    "lambda/preservation/shelf-life-default-floor.test.js": ("food-safety", "shelf-life floors"),
    "lambda/preservation/shelfLife.test.js": ("food-safety", "shelf-life table"),
    "lambda/preservation/kitchen-ph-record.test.js": ("food-safety", "pH record"),
    "src/__tests__/pantryFakeCreates.test.js": ("fidelity", "keeps the pantry fake's creates honest"),
}

# PIN: each entry is a rehearsal no workflow runs; wiring or retiring one is Dave's call, recorded here.
NOT_RUNNING = ["test:flag-off", "test:flag-off:seed", "test:flag-off:seedadd", "test:flag-off:seedboth"]

JS_TEST = re.compile(r"\.(test|spec)\.[cm]?[jt]sx?$")
JS_SKIP = re.compile(r"\b(?:it|test|describe|suite|bench)\.(?:skip|skipIf|runIf|todo|only)\b|\bx(?:it|describe)\(")
PY_SKIP = re.compile(r"pytest\.skip\(|mark\.(?:skip|skipif|xfail)\b|unittest\.skip|\.skipTest\(|importorskip\(")
JS_COMMENT = re.compile(r"/\*.*?\*/|(^|[^:'\"`\\])//[^\n]*", re.S)
PY_COMMENT = re.compile(r"^\s*#[^\n]*", re.M)
# vitest's own configDefaults.exclude, which vitest.config.ts spreads into its exclude.
VITEST_DEFAULT_EXCLUDE = ["**/node_modules/**", "**/.git/**"]


def marker_line(tag, why):
    return f"GUARD: {tag} ({why})"


def glob_re(pattern):
    out, i = "", 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out, i = out + "(?:.*/)?", i + 3
        elif pattern.startswith("**", i):
            out, i = out + ".*", i + 2
        elif pattern[i] == "*":
            out, i = out + "[^/]*", i + 1
        else:
            out, i = out + re.escape(pattern[i]), i + 1
    return re.compile(out + "$")


def tracked(root):
    out = subprocess.run(
        ["git", "-C", str(root), "ls-files", "--cached", "--others", "--exclude-standard"],
        capture_output=True, text=True, check=True,
    ).stdout.split("\n")
    return sorted(p for p in out if p and (root / p).is_file())


def head(path, n=5):
    try:
        with open(path, encoding="utf-8") as fh:
            return [next(fh, "") for _ in range(n)]
    except (UnicodeDecodeError, OSError):
        return []


def marked_files(root, files):
    out = {}
    for f in files:
        for line in head(root / f):
            m = MARKER.search(line)
            if m:
                out[f] = m.group(2)
                break
    return out


def seed_files(root, files, seed=SEED):
    """{seed pattern: [matching files]}; a pattern matching nothing is itself a problem."""
    return {pat: [f for f in files if glob_re(pat).match(f)] for pat in seed}


def _vitest_excludes(root):
    src = (root / "vitest.config.ts").read_text()
    m = re.search(r"\n\s*exclude:\s*\[\s*\.\.\.configDefaults\.exclude\s*,([^\]]*)\]", src)
    if not m:
        return None
    return VITEST_DEFAULT_EXCLUDE + re.findall(r"""['"]([^'"]+)['"]""", m.group(1))


def _ci(root):
    return yaml.safe_load((root / ".github/workflows/ci.yml").read_text())


def _test_steps(ci):
    """(job, step) for every step whose run body runs vitest or pytest."""
    for jn, job in (ci.get("jobs") or {}).items():
        for st in job.get("steps") or []:
            run = st.get("run") or ""
            if re.search(r"\bvitest run\b|-m pytest\b", run):
                yield jn, job, st


def problems(root, seed=SEED, not_running=NOT_RUNNING):
    """[(kind, file or step, detail)]. Empty means every guard runs and every rehearsal is listed."""
    out = []
    files = tracked(root)
    marked = marked_files(root, files)

    for pat, hits in seed_files(root, files, seed).items():
        if not hits:
            out.append(("seed_missing", pat, "no file matches this seed entry"))
        for f in hits:
            if marked.get(f) != seed[pat][0]:
                out.append(("missing_marker", f, f"needs `GUARD: {seed[pat][0]}` in its first 5 lines"))

    excludes = _vitest_excludes(root)
    if excludes is None:
        out.append(("exclude_unreadable", "vitest.config.ts", "no `exclude: [...configDefaults.exclude, ...]`"))
        excludes = []
    ci = _ci(root)
    steps = list(_test_steps(ci))
    vitest_steps = [s for s in steps if re.search(r"\bvitest run\b(?!.*--merge-reports)", s[2]["run"])]
    pytest_globs = [g for s in steps for g in re.findall(r"-m pytest\s+(?:-\S+\s+)*([\w/*.-]+)", s[2]["run"])]
    if not vitest_steps:
        out.append(("no_runner", "ci.yml", "no step runs `vitest run`"))
    if not pytest_globs:
        out.append(("no_runner", "ci.yml", "no step runs `python3 -m pytest <glob>`"))

    for jn, job, st in steps:
        where = f"ci.yml {jn}: {st.get('name')}"
        for holder in (job, st):
            if holder.get("continue-on-error"):
                out.append(("continue_on_error", where, "a failure here reads as success"))
            if holder.get("if") is not None:
                out.append(("conditional_step", where, f"if: {holder.get('if')}"))
        for line in st["run"].split("\n"):
            if re.search(r"\bvitest run\b|-m pytest\b", line):
                if re.search(r"--exclude|--ignore|--deselect|\s-k\s|--dir\b|--project\b", line):
                    out.append(("cli_exclude", where, line.strip()))
                if re.search(r"\|\|\s*(true|:|echo|exit 0)", line):
                    out.append(("warning_exit", where, line.strip()))
        if re.search(r"^\s*set \+e\b", st["run"], re.M):
            out.append(("warning_exit", where, "set +e"))

    for f, tag in sorted(marked.items()):
        if f.endswith(".py"):
            if not any(glob_re(g).match(f) for g in pytest_globs):
                out.append(("not_collected", f, f"outside the pytest leg's {pytest_globs}"))
            body = PY_COMMENT.sub("", (root / f).read_text())
            skip = PY_SKIP.search(body)
        elif JS_TEST.search(f):
            hit = next((x for x in excludes if glob_re(x).match(f)), None)
            if hit:
                out.append(("excluded", f, f"vitest.config.ts exclude {hit}"))
            body = JS_COMMENT.sub(r"\1", (root / f).read_text())
            skip = JS_SKIP.search(body)
        else:
            out.append(("not_collected", f, "not a test file any CI runner collects"))
            continue
        if skip:
            out.append(("hidden_skip", f, skip.group(0)))

    scripts = json.loads((root / "package.json").read_text()).get("scripts", {})
    rehearsals = sorted(k for k in scripts if k == "test:flag-off" or k.startswith("test:flag-off:"))
    wired = set()
    for wf in sorted((root / ".github/workflows").glob("*.y*ml")):
        doc = yaml.safe_load(wf.read_text()) or {}
        for job in (doc.get("jobs") or {}).values():
            for st in job.get("steps") or []:
                for k in rehearsals:
                    if re.search(re.escape(k) + r"(?![\w:-])", st.get("run") or ""):
                        wired.add(k)
    for k in rehearsals:
        if k not in wired and k not in not_running:
            out.append(("unlisted_rehearsal", k, "runs in no workflow: add it to NOT_RUNNING"))
        if k in wired and k in not_running:
            out.append(("listed_but_running", k, "a workflow runs it now: take it out of NOT_RUNNING"))
    for k in not_running:
        if k not in scripts:
            out.append(("listed_but_gone", k, "no such package.json script: take it out of NOT_RUNNING"))
    return out


# ------------------------------------------------------------------------------------------------ the real tree

def test_every_guard_runs_and_every_rehearsal_is_listed():
    files = tracked(ROOT)
    marked = marked_files(ROOT, files)
    assert len(marked) >= len(SEED), f"only {len(marked)} marked files: the marker scan is broken"
    bad = problems(ROOT)
    assert bad == [], "\n".join(f"{k}: {f}: {d}" for k, f, d in bad)


# ------------------------------------------------------------------------- seeded violations, one per kind
# Skip spellings are joined at runtime so this file does not contain what it checks for.
_SKIP_JS = "it." + "skip('x', () => {})\n"
_SKIP_PY = "import pytest\n@pytest." + "mark.skip\ndef test_x():\n    pass\n"
_MARK_JS = "// " + marker_line("security", "fixture") + "\n"
_MARK_PY = "# " + marker_line("security", "fixture") + "\n"
_VITEST = "export default {\n  test: {\n    exclude: [...configDefaults.exclude, 'tests/integration/**'],\n  },\n}\n"
_UNIT = "      - name: unit\n        run: npx vitest run --shard=1/2\n"
_PYTEST = "      - name: py\n        run: python3 -m pytest -q scripts/test_*.py\n"


def _ci_yml(unit=_UNIT, pytest_step=_PYTEST, job_extra=""):
    return f"on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n{job_extra}    steps:\n{unit}{pytest_step}"


FIXTURE_SEED = {"lambda/guard.test.js": ("security", "fixture"), "scripts/test_guard.py": ("security", "fixture")}


def _repo(tmp_path, extra=None, ci=None, scripts=None):
    tree = {
        "vitest.config.ts": _VITEST,
        ".github/workflows/ci.yml": ci or _ci_yml(),
        "package.json": json.dumps({"scripts": scripts if scripts is not None else {"test:flag-off:a": "vitest"}}),
        "lambda/guard.test.js": _MARK_JS + "it('x', () => {})\n",
        "scripts/test_guard.py": _MARK_PY + "def test_x():\n    assert True\n",
    }
    tree.update(extra or {})
    for rel, body in tree.items():
        if body is None:
            continue
        p = tmp_path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(body)
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    return tmp_path


SEEDED = [
    ("missing_marker", {"lambda/guard.test.js": "it('x', () => {})\n"}, None),
    ("seed_missing", {"lambda/guard.test.js": None}, None),
    ("hidden_skip", {"lambda/other.test.js": _MARK_JS + _SKIP_JS}, None),
    ("hidden_skip", {"scripts/test_other.py": _MARK_PY + _SKIP_PY}, None),
    ("excluded", {"tests/integration/x.int.test.js": _MARK_JS + "it('x', () => {})\n"}, None),
    ("not_collected", {"src/lib/x.js": _MARK_JS + "export const x = 1\n"}, None),
    ("not_collected", {"tools/test_x.py": _MARK_PY + "def test_x():\n    pass\n"}, None),
    ("continue_on_error", {}, _ci_yml(unit=_UNIT + "        continue-on-error: true\n")),
    ("continue_on_error", {}, _ci_yml(job_extra="    continue-on-error: true\n")),
    ("conditional_step", {}, _ci_yml(unit=_UNIT + "        if: github.event_name == 'push'\n")),
    ("warning_exit", {}, _ci_yml(unit="      - name: unit\n        run: npx vitest run || true\n")),
    ("cli_exclude", {}, _ci_yml(unit="      - name: unit\n        run: npx vitest run --exclude 'lambda/**'\n")),
    ("no_runner", {}, _ci_yml(unit="")),
    ("exclude_unreadable", {"vitest.config.ts": "export default {}\n"}, None),
]


@pytest.mark.parametrize("kind,extra,ci", SEEDED, ids=[k for k, _, _ in SEEDED])
def test_a_seeded_violation_is_caught(tmp_path, kind, extra, ci):
    root = _repo(tmp_path, extra, ci)
    assert kind in [k for k, _, _ in problems(root, FIXTURE_SEED, ["test:flag-off:a"])]


def test_a_clean_tree_passes(tmp_path):
    root = _repo(tmp_path)
    assert problems(root, FIXTURE_SEED, ["test:flag-off:a"]) == []


def test_rehearsals_are_listed_exactly(tmp_path):
    root = _repo(tmp_path, scripts={"test:flag-off:a": "vitest", "test:flag-off:b": "vitest"})
    assert ("unlisted_rehearsal", "test:flag-off:b") in [(k, f) for k, f, _ in problems(root, FIXTURE_SEED, ["test:flag-off:a"])]
    wired = _ci_yml(unit=_UNIT + "      - name: rehearse\n        run: npm run test:flag-off:a\n")
    root2 = _repo(tmp_path / "w", ci=wired)
    assert ("listed_but_running", "test:flag-off:a") in [(k, f) for k, f, _ in problems(root2, FIXTURE_SEED, ["test:flag-off:a"])]
    root3 = _repo(tmp_path / "g", scripts={})
    assert ("listed_but_gone", "test:flag-off:a") in [(k, f) for k, f, _ in problems(root3, FIXTURE_SEED, ["test:flag-off:a"])]


def main():
    files = tracked(ROOT)
    marked = marked_files(ROOT, files)
    bad = problems(ROOT)
    by_file = {}
    for k, f, d in bad:
        by_file.setdefault(f, []).append(f"{k}: {d}")
    print(f"GUARD-marked files: {len(marked)}")
    for f, tag in sorted(marked.items()):
        print(f"  {'RUNNING' if f not in by_file else 'NOT RUNNING'}  {tag:<12} {f}  {'; '.join(by_file.get(f, []))}")
    scripts = json.loads((ROOT / "package.json").read_text()).get("scripts", {})
    rehearsals = sorted(k for k in scripts if k == "test:flag-off" or k.startswith("test:flag-off:"))
    print(f"flag-off rehearsals: {len(rehearsals)}")
    for k in rehearsals:
        print(f"  {'NOT RUNNING' if k in NOT_RUNNING else 'RUNNING'}  {k}")
    for k, f, d in bad:
        if f not in marked:
            print(f"PROBLEM {k}: {f}: {d}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
