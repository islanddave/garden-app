# new-file: new subject, the M2 test-economy check (POLICY.md section E) has no test file
"""M2 test-economy check (POLICY.md section E, DEC-TESTPOLICY-001), DB-free and network-free.

Run: python3 -m pytest -q scripts/test_test_economy.py

A test file NOT in the frozen legacy list fails on any of these (POLICY.md section A, rule numbers in brackets):
  name_token        a round, lane, phase or ticket token in its file name [1]
  false_import      a lambda test saying the handler "cannot be imported": lambda/_test-stubs make every ESM
                    handler importable [2] (a CommonJS index.js is exempt: the vitest aliases do not reach require)
  router_mock       vi.mock('react-router-dom') or a frozen useSearchParams tuple [3]
  second_file       a second test file for a subject that already has one, without `new-file:` on line 1 [1];
                    subject = scripts/subject_resolver.py, the resolver the monthly card shares
  presence_skip     a skip that turns on whether a module or file exists, so a move silently skips it [5]
  both_audit_forms  one file holding both AUDIT forms: the schema audit reads only the first [7]

The legacy list, scripts/test-economy-legacy.txt, is every test file at the freeze commit, made with
  git ls-tree -r --name-only <freeze-commit> | python3 scripts/subject_resolver.py --filter-tests \
    > scripts/test-economy-legacy.txt
It only shrinks: LEGACY_CEILING pins its length, so adding a file to it is a visible edit to this file too.
"""
import importlib.util
import os
import re
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
import subject_resolver  # noqa: E402

LEGACY = HERE / "test-economy-legacy.txt"
# PIN: a new line in the legacy list exempts a file from every check above; raising this is that decision.
LEGACY_CEILING = 1742

_spec = importlib.util.spec_from_file_location("schema_audit_m2", HERE / "dev-main-schema-audit.py")
_audit = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_audit)

FALSE_IMPORT = re.compile(
    r"cannot be imported|must never import this handler|CANNOT resolve in CI|per-dir node_modules do not exist"
    r"|cannot import the handler",
    re.I,
)
ROUTER_MOCK = re.compile(r"""vi\.mock\(\s*['"]react-router(?:-dom)?['"]|useSearchParams\s*:\s*\(\s*\)\s*=>\s*\[""")
JS_PRESENCE = re.compile(r"import\.meta\.glob\(|existsSync\(")
JS_CONDITIONAL_SKIP = re.compile(r"\.(?:skipIf|runIf)\(")
PY_PRESENCE_SKIP = re.compile(r"importorskip\(|skip(?:if|If|Unless)?\(.*(?:exists|is_file|isfile)\(")
ROUND_WORDS = {"round", "phase", "wave", "pickup", "pass"}


def load_legacy(path=LEGACY):
    return {ln.strip() for ln in path.read_text().splitlines() if ln.strip() and not ln.startswith("#")}


def name_tokens(rel):
    base = rel.rsplit("/", 1)[-1]
    stem = re.sub(r"\.(test|spec)\.[cm]?[jt]sx?$", "", base)
    stem = re.sub(r"^test_|\.py$", "", stem)
    out = []
    for part in re.split(r"[._-]+", stem):
        out += [t.lower() for t in re.findall(r"[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+", part)]
    return out


def bad_name(rel):
    """The offending token, or None. Ticket ids end in a zero-padded number (-001), so 404/500 pass."""
    t = name_tokens(rel)
    for i, tok in enumerate(t):
        nxt = t[i + 1] if i + 1 < len(t) else ""
        if tok == "lane":
            return tok + nxt
        if tok in ROUND_WORDS and (nxt.isdigit() or len(nxt) == 1):
            return tok + nxt
        if tok in {"r", "v", "w"} and nxt.isdigit():
            return tok + nxt
        if re.fullmatch(r"0\d\d", tok):
            return tok
    return None


def _commonjs_handler(root, rel):
    parts = rel.split("/")
    if len(parts) < 3 or parts[0] != "lambda":
        return False
    idx = root / parts[0] / parts[1] / "index.js"
    return idx.is_file() and "require(" in idx.read_text(errors="replace")


def violations(root, legacy, files=None):
    """[(kind, file, detail)] over every test file under root that is not in legacy."""
    files = sorted(files) if files is not None else subject_resolver.list_tests(root)
    subj = subject_resolver.subjects(files, root)
    by_subject = {}
    for f, s in subj.items():
        if s:
            by_subject.setdefault(s, []).append(f)
    out = []
    for f in files:
        if f in legacy:
            continue
        text = (root / f).read_text(encoding="utf-8", errors="replace")
        py = f.endswith(".py")
        tok = bad_name(f)
        if tok:
            out.append(("name_token", f, tok))
        if f.startswith("lambda/") and FALSE_IMPORT.search(text) and not _commonjs_handler(root, f):
            out.append(("false_import", f, FALSE_IMPORT.search(text).group(0)))
        if not py and ROUTER_MOCK.search(text):
            out.append(("router_mock", f, ROUTER_MOCK.search(text).group(0)))
        s = subj[f]
        others = [g for g in by_subject.get(s, []) if g != f]
        if others and "new-file:" not in text.split("\n", 1)[0]:
            out.append(("second_file", f, f"{s} is already tested by {others[0]}"))
        if py:
            if PY_PRESENCE_SKIP.search(text):
                out.append(("presence_skip", f, PY_PRESENCE_SKIP.search(text).group(0)))
        elif JS_CONDITIONAL_SKIP.search(text) and JS_PRESENCE.search(text):
            out.append(("presence_skip", f, JS_CONDITIONAL_SKIP.search(text).group(0)))
        if _audit._AUDIT_COLUMNS_DECL.search(text) and _audit._AUDIT_TABLES_DECL.search(text):
            out.append(("both_audit_forms", f, "keyed AUDIT_COLUMNS and AUDIT_TABLES"))
    return out


# ------------------------------------------------------------------------------------------------ the real tree

def test_the_tree_has_no_violation_outside_the_legacy_list():
    legacy = load_legacy()
    files = subject_resolver.list_tests(ROOT)
    checked = [f for f in files if f not in legacy]
    assert len(files) > 1500, f"only {len(files)} test files found: the listing is broken"
    assert checked, "every test file is legacy: this check is checking nothing"
    bad = violations(ROOT, legacy, files)
    assert bad == [], "\n".join(f"{k}: {f}: {d}" for k, f, d in bad) + (
        "\nPOLICY.md section A: rename the file, add cases to the existing file, or put `new-file: <reason>` "
        "on line 1 (a new subject, a different module-level mock, or a split of a file over ~800 lines)."
    )


def test_the_legacy_list_does_not_grow():
    legacy = load_legacy()
    assert len(legacy) <= LEGACY_CEILING, (
        f"scripts/test-economy-legacy.txt has {len(legacy)} entries, ceiling {LEGACY_CEILING}: a file added to it "
        "is exempt from this check; take it back out"
    )
    assert all(subject_resolver.is_test_file(f) for f in legacy)


# ------------------------------------------------------------------------- seeded violations, one per kind
# Forbidden spellings are joined at runtime so this file does not contain what it checks for.
_IMPORTORSKIP = "pytest." + "importorskip"
_AUDIT_BOTH = "const AUDIT_" + "COLUMNS = { t: ['a'] };\nconst AUDIT_" + "TABLES = ['t'];\n"
_ROUTER = "vi.mock('react-router" + "-dom', () => ({}))\n"
_FROZEN = "vi.mock('../x', () => ({ useSearchParams: " + "() => [new URLSearchParams(), vi.fn()] }))\n"

BASE_TREE = {
    "src/lib/foo.js": "export const foo = 1\n",
    "src/lib/bar.js": "export const bar = 1\n",
    "src/__tests__/foo.test.js": "import { foo } from '../lib/foo.js'\n",
    "lambda/fn/index.js": "export const handler = async () => ({})\n",
    "lambda/cjs/index.js": "const { S3 } = require('@aws-sdk/client-s3')\nexports.handler = async () => ({})\n",
    "scripts/tool.py": "X = 1\n",
}
LEGACY_FIXTURE = {"src/__tests__/foo.test.js"}

SEEDED = [
    ("name_token", "src/__tests__/Bar.laneB.test.js", "import { bar } from '../lib/bar.js'\n"),
    ("name_token", "src/__tests__/BarPhase2.test.js", "import { bar } from '../lib/bar.js'\n"),
    ("name_token", "src/__tests__/bar.r1.test.js", "import { bar } from '../lib/bar.js'\n"),
    ("name_token", "src/__tests__/bar-hide-002.test.js", "import { bar } from '../lib/bar.js'\n"),
    ("false_import", "lambda/fn/thing.test.js", "// index.js cannot be imported in the unit suite\n"),
    ("router_mock", "src/__tests__/bar.test.jsx", "import { bar } from '../lib/bar.js'\n" + _ROUTER),
    ("router_mock", "src/__tests__/bar.test.jsx", "import { bar } from '../lib/bar.js'\n" + _FROZEN),
    ("second_file", "src/__tests__/foo.more.test.js", "import { foo } from '../lib/foo.js'\n"),
    ("presence_skip", "src/__tests__/bar.test.js",
     "import { bar } from '../lib/bar.js'\nconst m = import.meta.glob('../lib/gone.js')\n"
     "describe.skipIf(!Object.keys(m).length)('x', () => {})\n"),
    ("presence_skip", "scripts/test_tool.py", f"import tool\n{_IMPORTORSKIP}('yaml')\n"),
    ("both_audit_forms", "lambda/fn/thing-columns.test.js", _AUDIT_BOTH),
]
CLEAN = [
    ("src/__tests__/qtyRoundTrip.test.js", "import { bar } from '../lib/bar.js'\n"),
    ("src/__tests__/foo.flagOff.test.js", "// new-file: a different module-level mock\nimport { foo } from '../lib/foo.js'\n"),
    ("lambda/cjs/thing.test.js", "// index.js cannot be imported: CommonJS require\n"),
    ("src/__tests__/error-404.test.js", "import { bar } from '../lib/bar.js'\n"),
    ("scripts/test_tool.py", "import tool\n"),
]


def _tree(tmp_path, extra):
    for rel, body in {**BASE_TREE, **extra}.items():
        p = tmp_path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(body)
    return [rel for rel in {**BASE_TREE, **extra} if subject_resolver.is_test_file(rel)]


@pytest.mark.parametrize("kind,rel,body", SEEDED, ids=[f"{k}:{r.rsplit('/', 1)[-1]}" for k, r, _ in SEEDED])
def test_a_seeded_violation_is_caught(tmp_path, kind, rel, body):
    files = _tree(tmp_path, {rel: body})
    assert kind in [k for k, f, _ in violations(tmp_path, LEGACY_FIXTURE, files) if f == rel]


@pytest.mark.parametrize("rel,body", CLEAN, ids=[r.rsplit("/", 1)[-1] for r, _ in CLEAN])
def test_a_clean_file_passes(tmp_path, rel, body):
    files = _tree(tmp_path, {rel: body})
    assert violations(tmp_path, LEGACY_FIXTURE, files) == []


def test_a_legacy_file_is_exempt(tmp_path):
    files = _tree(tmp_path, {"src/__tests__/Bar.laneB.test.js": _ROUTER})
    assert violations(tmp_path, LEGACY_FIXTURE | {"src/__tests__/Bar.laneB.test.js"}, files) == []
