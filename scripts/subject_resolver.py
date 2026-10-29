#!/usr/bin/env python3
"""The subject of a test file: the one module or script it imports or executes (POLICY.md rule A1).

Shared by scripts/test_test_economy.py (a second file for an existing subject needs a line-1
`new-file:` reason) and the monthly over-test card, so both count subjects the same way.

  python3 scripts/subject_resolver.py --list-tests      every test file in the tree, one per line
  python3 scripts/subject_resolver.py --filter-tests    the test files among the paths on stdin
  python3 scripts/subject_resolver.py PATH...           PATH<TAB>subject (or -) for each test file

Resolution, first hit wins, in source order within each step:
  1. a relative import (`import ... from`, `import()`, `require()`); Python: a local module or a
     `spec_from_file_location` path;
  2. a source file the test reads or executes, named by a path literal (`readFileSync(resolve(__dirname,
     'index.js'))`, `'src/lib/x.js'`, `HERE / "x.sh"`).
Helpers, fixtures, stubs, setup files, JSON and other test files are never a subject. A file with no
hit has no subject (None) and is not counted. Lambda route modules are not split yet: a static test of
a handler resolves to that directory's index.js.
"""
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

JS_TEST = re.compile(r"\.(test|spec)\.[cm]?[jt]sx?$")
PY_TEST = re.compile(r"^scripts/test_[^/]*\.py$")
SKIP_DIRS = {"node_modules", ".git", "dist", ".claude", "coverage"}

SOURCE_EXT = (".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".py", ".sh", ".sql", ".yml", ".yaml")
JS_RESOLVE_EXT = ("", ".js", ".jsx", ".ts", ".tsx", ".mjs", "/index.js", "/index.jsx", "/index.ts")
NOT_A_SUBJECT = re.compile(
    r"(^|/)(__tests__/(helpers|fixtures)|_test-stubs|fixtures|test-stubs|__mocks__)/"
    r"|(^|/)setup\.[jt]s$|(^|/)_[^/]*\.[cm]?[jt]sx?$|\.(test|spec)\.|(^|/)test_[^/]*\.py$|(^|/)conftest\.py$|\.json$"
)

JS_IMPORT = re.compile(
    r"""(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"](\.{1,2}/[^'"]+)['"]""", re.M
)
PATH_LITERAL = re.compile(r"""['"`]([\w./-]+\.(?:js|jsx|mjs|cjs|ts|tsx|py|sh|sql|ya?ml))['"`]""")
PY_IMPORT = re.compile(r"^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))", re.M)
JS_LINE_COMMENT = re.compile(r"(^|[^:'\"`\\])//[^\n]*")
JS_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.S)
PY_COMMENT = re.compile(r"^\s*#[^\n]*", re.M)


def is_test_file(rel):
    rel = rel.replace(os.sep, "/")
    if any(part in SKIP_DIRS for part in rel.split("/")):
        return False
    return bool(JS_TEST.search(rel) or PY_TEST.match(rel))


def list_tests(root=ROOT):
    """Every test file under root, repo-relative and sorted. Tracked plus untracked-not-ignored when
    root is a git checkout (a new file is caught before it is committed); a plain walk otherwise."""
    try:
        out = subprocess.run(
            ["git", "-C", str(root), "ls-files", "--cached", "--others", "--exclude-standard"],
            capture_output=True, text=True, check=True,
        ).stdout.split("\n")
        paths = [p for p in out if p and (root / p).is_file()]
    except (OSError, subprocess.CalledProcessError):
        paths = []
        for d, dirs, files in os.walk(root):
            dirs[:] = [x for x in dirs if x not in SKIP_DIRS]
            for f in files:
                paths.append(os.path.relpath(os.path.join(d, f), root).replace(os.sep, "/"))
    return sorted({p for p in paths if is_test_file(p)})


def _strip_comments(text, py):
    if py:
        return PY_COMMENT.sub("", text)
    return JS_LINE_COMMENT.sub(r"\1", JS_BLOCK_COMMENT.sub("", text))


def _candidate(root, base_dir, spec, js):
    """Repo-relative path for an import or path literal, or None if it is not a subject on disk."""
    spec = spec.split("?")[0]
    if spec.startswith("."):
        bases = [base_dir]
    else:
        # A bare literal is repo-relative ('src/lib/x.js') or a sibling of the test ('index.js').
        bases = [root, base_dir]
    for b in bases:
        for ext in (JS_RESOLVE_EXT if js else ("",)):
            p = Path(os.path.normpath(b / (spec + ext)))
            if p.is_file():
                try:
                    rel = p.relative_to(root).as_posix()
                except ValueError:
                    return None
                return None if NOT_A_SUBJECT.search(rel) else rel
    return None


def subject_of(rel, root=ROOT):
    """The subject of one test file (repo-relative path), or None."""
    path = root / rel
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    py = rel.endswith(".py")
    code = _strip_comments(text, py)
    base = path.parent
    hits = []
    if py:
        for m in PY_IMPORT.finditer(code):
            mod = (m.group(1) or m.group(2)).split(".")[0]
            hits.append((m.start(), mod + ".py"))
    else:
        for m in JS_IMPORT.finditer(code):
            hits.append((m.start(), m.group(1)))
    for _, spec in sorted(hits):
        s = _candidate(root, base, spec, js=not py)
        if s:
            return s
    for m in PATH_LITERAL.finditer(code):
        s = _candidate(root, base, m.group(1), js=False)
        if s and s.endswith(SOURCE_EXT) and s != rel:
            return s
    return None


def subjects(files, root=ROOT):
    return {f: subject_of(f, root) for f in files}


def main(argv):
    if argv[:1] == ["--list-tests"]:
        print("\n".join(list_tests()))
        return 0
    if argv[:1] == ["--filter-tests"]:
        print("\n".join(sorted({p.strip() for p in sys.stdin if is_test_file(p.strip())})))
        return 0
    if not argv:
        print(__doc__, file=sys.stderr)
        return 2
    for f in argv:
        print(f"{f}\t{subject_of(f) or '-'}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
