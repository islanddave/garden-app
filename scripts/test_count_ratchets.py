"""Count ratchets (A8, small form): scripts/count-ratchets.json enforced on the REAL tree, DB-free and network-free.

Run: python3 -m pytest -q scripts/test_count_ratchets.py

Two hard checks and one proof:

  1. *columns.test.js contract files per lambda directory may not grow past the directory's ceiling. A new JOIN is
     a new KEY in a keyed contract file the directory already has, not a new file. A deliberate raise is a number
     plus a `raises` row in the same commit; a bare bump is red. A count below its ceiling is red too, with the
     number to lower it to, so a deletion never leaves headroom for an unrecorded file. (That could make two lanes
     fight only if both delete a contract file from the same directory at once; no contract file has ever been
     deleted or renamed in this repo's history, so the strict form costs nothing today.)
  2. Every scripts/layout-gate/*.mjs that imports cdp-socket.mjs imports exit-watchdog.mjs, or is one of the ten
     that did not when this landed. That list may shrink, never grow.
  3. The fold the first message recommends is one the schema audit can see: the tests at the bottom run the
     audit's own parse_test_file and main() over a contract folded in that shape. If they go red, the cap is
     pushing sessions into contracts the prod schema gate cannot read: fix the message or the parser before
     anything else.

Files are listed with `git ls-files` (tracked plus untracked-not-ignored), never a directory walk: a local checkout
can hold whole copies of the repo under .claude/worktrees/, and node_modules can carry test files of its own.
"""
import copy
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
RATCHETS = os.path.join(HERE, "count-ratchets.json")
GATE_DIR = "scripts/layout-gate"
HOUSEHOLD = "household-columns.test.js"

# sha256 of the `_start` block (sorted keys, compact separators). `_start` is what every raise is checked against,
# so it is history: editing it is the same act as a bare bump with one more step.
START_SHA256 = "ae67eff2b4569d70d2f7041fa5a14a51773c95880b767b9faa452f1e1c08880f"

RAISE_KEYS = ("what", "from", "to", "why", "work_item")

_spec = importlib.util.spec_from_file_location("schema_audit", os.path.join(HERE, "dev-main-schema-audit.py"))
audit = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(audit)

_KEYED = re.compile(r"const\s+AUDIT_COLUMNS\s*=\s*\{")
_PINNED = re.compile(r"\"(lambda/[^\"]*columns\.test\.js)\"")


def _imports(src, module):
    """True when a non-comment line imports ./<module>.mjs, statically or with import()."""
    code = "\n".join(l for l in src.split("\n") if not l.lstrip().startswith("//"))
    return bool(re.search(r"(?:\bfrom|\bimport)\s*\(?\s*['\"]\./%s\.mjs['\"]" % re.escape(module), code))


def _ls(*pathspecs):
    out = subprocess.run(
        ["git", "-C", REPO, "ls-files", "--cached", "--others", "--exclude-standard", "--", *pathspecs],
        check=True, capture_output=True, text=True,
    ).stdout
    # --cached still lists a tracked file deleted from the working tree but not yet staged.
    return sorted(p for p in out.splitlines() if os.path.exists(os.path.join(REPO, p)))


def _read(rel):
    with open(os.path.join(REPO, rel), encoding="utf-8") as f:
        return f.read()


def load_config():
    with open(RATCHETS, encoding="utf-8") as f:
        return json.load(f)


def real_columns_files():
    return [p for p in _ls("lambda") if p.endswith("columns.test.js")]


def real_gate_sources():
    return {
        os.path.basename(p): _read(p)
        for p in _ls(GATE_DIR)
        if p.endswith(".mjs") and os.path.dirname(p) == GATE_DIR
    }


def pinned_by_phase1():
    """Contract files whose exact audited column set scripts/test-schema-audit-phase1.py pins."""
    return set(_PINNED.findall(_read("scripts/test-schema-audit-phase1.py")))


def by_dir(files):
    out = {}
    for p in files:
        out.setdefault(os.path.dirname(p), []).append(os.path.basename(p))
    return {d: sorted(v) for d, v in out.items()}


def fold_advice(d, names, new, read, pinned):
    """What to do instead of a new contract file in directory d. Names the files that can take the key."""
    hosts, tables_only = [], []
    for n in names:
        if n in new or n == HOUSEHOLD:
            continue
        (hosts if _KEYED.search(read(f"{d}/{n}")) else tables_only).append(n)
    lines = [
        "  Do not add a contract FILE. Add the relation as a new KEY of the one `const AUDIT_COLUMNS = { ... };`",
        "  object in a keyed contract file this directory already has, and put its assertions in that file:",
    ]
    if hosts:
        for n in hosts:
            pin = (
                "   (scripts/test-schema-audit-phase1.py pins this file's exact column set: extend that pin in "
                "the same commit)" if f"{d}/{n}" in pinned else ""
            )
            lines.append(f"      {d}/{n}{pin}")
    else:
        lines.append(f"      (none: {d} has no keyed contract file of its own, so this one needs a raise, below)")
    lines += [
        "  The shape is decided by the schema audit's parser (scripts/dev-main-schema-audit.py, parse_test_file),",
        "  which the promote gate runs against prod:",
        "    - ONE object per file. Only the first `const AUDIT_COLUMNS = {...};` is read. A second object, or one",
        "      under another name, is audited by nothing. So: `new_table: ['col', ...],` inside the existing braces,",
        "      a plain string-literal array, the object still closed by `};`.",
        "    - The SAME lambda directory. Phase 4 credits a contract only to the directory its file is in.",
        "    - Never a file that declares AUDIT_TABLES"
        + (f" (here: {', '.join(tables_only)})" if tables_only else "")
        + ". A keyed block there silently drops that",
        "      file's existing columns from the audit.",
        f"    - Never {HOUSEHOLD}. It is 19 byte-identical copies under lambda/household-columns-sync.test.js.",
        "    - Never by import. The literal has to be in the contract file's own text.",
        "  A file header that says \"Always a new file\" predates this cap. It is right that a keyed block must not",
        "  go into an AUDIT_TABLES file and wrong that the answer is another file.",
        "  Model of one file carrying several relations with assertions looped over Object.keys(AUDIT_COLUMNS):",
        "  lambda/preservation/pantryitemamount-columns.test.js.",
        "  To raise instead (no keyed file here, or the contract truly cannot share one): see _how_to_raise in",
        "  scripts/count-ratchets.json. It is the number, the file name and a `raises` row, in one commit.",
    ]
    return "\n".join(lines)


def columns_problems(cfg, files, read=lambda _rel: "", pinned=frozenset()):
    ceilings = cfg["columns_tests_per_dir"]
    recorded = cfg["columns_test_files"]
    actual = by_dir(files)
    problems = []
    for d in sorted(set(ceilings) | set(recorded) | set(actual)):
        names = actual.get(d, [])
        ceiling = ceilings.get(d, 0)
        listed = recorded.get(d, [])
        new = sorted(set(names) - set(listed))
        gone = sorted(set(listed) - set(names))
        if len(names) > ceiling:
            named = ", ".join(new) if new else (
                "none (columns_test_files was extended but the ceiling was not raised)"
            )
            unlisted = "" if d in ceilings else " (a directory not listed has ceiling 0)"
            problems.append(
                f"{d}: {len(names)} *columns.test.js file(s), ceiling {ceiling}{unlisted} in "
                f"scripts/count-ratchets.json.\n  New here: {named}\n" + fold_advice(d, names, set(new), read, pinned)
            )
        elif len(names) < ceiling:
            problems.append(
                f"{d}: {len(names)} *columns.test.js file(s), ceiling {ceiling}. The ceiling ratchets DOWN: set "
                f"columns_tests_per_dir[\"{d}\"] to {len(names)} in scripts/count-ratchets.json"
                + (f" and remove {', '.join(gone)} from columns_test_files" if gone else "")
                + ". No `raises` row is needed to lower."
            )
        elif new or gone:
            problems.append(
                f"{d}: the count matches its ceiling ({ceiling}) but columns_test_files is stale. In "
                f"scripts/count-ratchets.json add {new} and remove {gone} for this directory (a rename; the list "
                "is what lets the over-ceiling message name the new file)."
            )
    return problems


def raises_problems(cfg):
    problems = []
    if not isinstance(cfg.get("raises"), list):
        return ["`raises` must be a list (empty when nothing has been raised)."]
    start = cfg["_start"]["columns_tests_per_dir"]
    ceilings = cfg["columns_tests_per_dir"]
    level = {d: start.get(d, 0) for d in set(start) | set(ceilings)}
    for i, row in enumerate(cfg["raises"]):
        where = f"raises[{i}]"
        if not isinstance(row, dict) or any(k not in row for k in RAISE_KEYS):
            problems.append(f"{where}: a raise row needs every one of {', '.join(RAISE_KEYS)}.")
            continue
        what, lo, hi = row["what"], row["from"], row["to"]
        if not (isinstance(row["why"], str) and row["why"].strip()
                and isinstance(row["work_item"], str) and row["work_item"].strip()):
            problems.append(f"{where}: `why` and `work_item` must say something.")
        if what not in ceilings:
            problems.append(
                f"{where}: `what` is {what!r}, which is not a directory in columns_tests_per_dir. Only a columns "
                "ceiling can be raised; watchdog_exempt cannot."
            )
            continue
        if type(lo) is not int or type(hi) is not int or hi <= lo:
            problems.append(f"{where}: `from` and `to` must be integers with to > from (got {lo!r} -> {hi!r}).")
            continue
        if lo > level[what]:
            problems.append(
                f"{where}: does not chain. It raises {what} from {lo}, but the ceiling the history accounts for "
                f"at that point is {level[what]} (the starting value plus the rows above). `from` is the ceiling "
                "before this raise."
            )
            continue
        level[what] = hi
    for d in sorted(ceilings):
        if type(ceilings[d]) is not int or ceilings[d] < 0:
            problems.append(f"columns_tests_per_dir[{d!r}] must be a non-negative integer.")
        elif ceilings[d] > level[d]:
            problems.append(
                f"{d}: ceiling {ceilings[d]} was raised with no reason. Its starting value plus the recorded "
                f"raises come to {level[d]}. Append a `raises` row ({', '.join(RAISE_KEYS)}) in the same commit, "
                "per _how_to_raise in scripts/count-ratchets.json, or fold the contract into an existing keyed "
                "file and put the number back."
            )
    return problems


def watchdog_problems(cfg, sources):
    exempt = cfg["watchdog_exempt"]
    started = set(cfg["_start"]["watchdog_exempt"])
    problems = []
    for name in sorted(sources):
        if name in ("cdp-socket.mjs", "exit-watchdog.mjs"):
            continue
        drives = _imports(sources[name], "cdp-socket")
        armed = _imports(sources[name], "exit-watchdog")
        if drives and not armed and name not in exempt:
            problems.append(
                f"{GATE_DIR}/{name} imports cdp-socket.mjs (it drives Chrome) without exit-watchdog.mjs. A gate "
                "that leaves a handle open after printing PASS hangs its CI step until the timeout. Add "
                "`import { armExitWatchdog } from './exit-watchdog.mjs'` and call it where the script is done, "
                f"as {GATE_DIR}/save-seed-sheet-clearance.mjs does. watchdog_exempt is the ten scripts that "
                "predate this rule and it does not take new names."
            )
        if name in exempt and (armed or not drives):
            problems.append(
                f"{GATE_DIR}/{name} is in watchdog_exempt but "
                + ("now imports exit-watchdog.mjs" if armed else "no longer imports cdp-socket.mjs")
                + ". Remove it from the list in scripts/count-ratchets.json: the list only shrinks."
            )
    for name in exempt:
        if name not in sources:
            problems.append(
                f"watchdog_exempt names {name}, which no longer exists in {GATE_DIR}. Remove it from the list in "
                "scripts/count-ratchets.json: the list only shrinks."
            )
        if name not in started:
            problems.append(
                f"watchdog_exempt gained {name}. The list is the scripts that lacked the watchdog when the rule "
                f"landed and it never grows: import armExitWatchdog in {GATE_DIR}/{name} instead."
            )
    if len(set(exempt)) != len(exempt):
        problems.append("watchdog_exempt lists a name twice.")
    return problems


def start_digest(cfg):
    return hashlib.sha256(
        json.dumps(cfg["_start"], sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def _report(problems):
    return f"{len(problems)} count-ratchet problem(s):\n\n" + "\n\n".join(problems)


# ── the real tree ─────────────────────────────────────────────────────────────────────────────────────────────

def test_columns_files_per_directory_hold_on_the_real_tree():
    files = real_columns_files()
    # Not vacuous: 139 files in 25 directories when this landed. A listing that came back empty would pass
    # every ceiling as "below" and name nothing.
    assert len(files) >= 100 and len(by_dir(files)) >= 20, f"only {len(files)} contract files listed"
    problems = columns_problems(load_config(), files, _read, pinned_by_phase1())
    assert not problems, _report(problems)


def test_every_ceiling_is_its_start_plus_recorded_raises():
    problems = raises_problems(load_config())
    assert not problems, _report(problems)


def test_the_starting_values_are_not_edited():
    cfg = load_config()
    assert start_digest(cfg) == START_SHA256, (
        "`_start` in scripts/count-ratchets.json changed. It is the history every raise is checked against, not a "
        "number to tune: put it back, and record the raise as a `raises` row (_how_to_raise in that file)."
    )
    assert sum(cfg["_start"]["columns_tests_per_dir"].values()) == 139
    assert len(cfg["_start"]["watchdog_exempt"]) == 10


def test_chrome_driving_gates_arm_the_exit_watchdog_on_the_real_tree():
    sources = real_gate_sources()
    drivers = [n for n in sources if _imports(sources[n], "cdp-socket")]
    assert len(drivers) >= 15, f"only {len(drivers)} cdp-socket importers found in {GATE_DIR}: the scan is blind"
    problems = watchdog_problems(load_config(), sources)
    assert not problems, _report(problems)


def test_nothing_in_the_file_is_gated_on_a_date_and_recorded_only_stays_ungated():
    cfg = load_config()
    assert set(cfg["recorded_only"]) >= {"read_at", "non_jsx_test_files_outside_src", "unit_test_files_total"}
    # The two recorded numbers are deliberately absent from every check above; this only keeps a later edit
    # from turning one into a ceiling by renaming it.
    assert not [k for k in cfg if "ceiling" in k or "deadline" in k or "due" in k]


# ── each rule goes red when broken ────────────────────────────────────────────────────────────────────────────
# On a small fixed fixture, not the live file: a legitimate raise in a real directory must not red these.

KEYED_SRC = "const AUDIT_COLUMNS = {\n  t: ['id'],\n};\n"
TABLES_SRC = "const AUDIT_TABLES = ['t'];\nconst T_COLUMNS = ['id'];\n"
FIX_SOURCES = {
    "lambda/alpha/select-columns.test.js": TABLES_SRC,
    "lambda/alpha/joined-columns.test.js": KEYED_SRC,
    "lambda/alpha/prefs-columns.test.js": KEYED_SRC,
    f"lambda/alpha/{HOUSEHOLD}": KEYED_SRC,
    "lambda/beta/select-columns.test.js": TABLES_SRC,
    f"lambda/beta/{HOUSEHOLD}": KEYED_SRC,
}
FIX_PINNED = {"lambda/alpha/prefs-columns.test.js"}
DRIVER = "import { resolveWebSocket } from './cdp-socket.mjs'\n"
ARMED = DRIVER + "import { armExitWatchdog } from './exit-watchdog.mjs'\n"
FIX_GATES = {
    "cdp-socket.mjs": "// cdp-socket.mjs\n", "exit-watchdog.mjs": "// exit-watchdog.mjs\n",
    "old-a.mjs": DRIVER, "old-b.mjs": DRIVER, "armed.mjs": ARMED, "no-chrome.mjs": "console.log(1)\n",
}


def _fixture():
    files = sorted(FIX_SOURCES)
    per = {d: len(v) for d, v in by_dir(files).items()}
    cfg = {
        "_start": {"columns_tests_per_dir": dict(per), "watchdog_exempt": ["old-a.mjs", "old-b.mjs"]},
        "columns_tests_per_dir": dict(per),
        "columns_test_files": by_dir(files),
        "watchdog_exempt": ["old-a.mjs", "old-b.mjs"],
        "raises": [],
    }
    return cfg, files, dict(FIX_GATES)


def _fix_read(rel):
    return FIX_SOURCES.get(rel, KEYED_SRC)


def _one(problems, *needles):
    hits = [p for p in problems if all(n in p for n in needles)]
    assert len(hits) == 1, f"expected one problem containing {needles}, got {len(hits)} of:\n" + "\n".join(problems)
    return hits[0]


def test_the_fixture_itself_is_green():
    cfg, files, gates = _fixture()
    assert not columns_problems(cfg, files, _fix_read, FIX_PINNED)
    assert not raises_problems(cfg) and not watchdog_problems(cfg, gates)


def test_red_a_new_columns_file_in_a_capped_directory_and_the_message_says_what_to_do():
    cfg, files, _ = _fixture()
    files.append("lambda/alpha/brand-new-join-columns.test.js")
    msg = _one(columns_problems(cfg, files, _fix_read, FIX_PINNED), "lambda/alpha:")
    assert "5 *columns.test.js file(s), ceiling 4 in scripts/count-ratchets.json" in msg
    assert "New here: brand-new-join-columns.test.js" in msg
    assert "new KEY of the one `const AUDIT_COLUMNS" in msg
    # It offers the keyed files of that directory and nothing else: not the AUDIT_TABLES file, not the
    # household copy, not the new file itself. The one the phase-1 self-test pins is flagged.
    hosts = [l.split()[0] for l in msg.split("\n") if l.startswith("      lambda/")]
    assert hosts == ["lambda/alpha/joined-columns.test.js", "lambda/alpha/prefs-columns.test.js"], hosts
    assert "lambda/alpha/prefs-columns.test.js   (scripts/test-schema-audit-phase1.py pins" in msg
    assert "lambda/alpha/joined-columns.test.js   (" not in msg
    assert "(here: select-columns.test.js)" in msg
    for constraint in ("ONE object per file", "The SAME lambda directory", f"Never {HOUSEHOLD}", "Never by import"):
        assert constraint in msg
    assert "_how_to_raise" in msg


def test_red_a_new_file_where_the_directory_has_no_keyed_file_and_in_a_new_directory():
    cfg, files, _ = _fixture()
    files += ["lambda/beta/joined-columns.test.js", "lambda/brand-new-lambda/select-columns.test.js"]
    problems = columns_problems(cfg, files, _fix_read, FIX_PINNED)
    msg = _one(problems, "lambda/beta:")
    assert "3 *columns.test.js file(s), ceiling 2" in msg
    assert "lambda/beta has no keyed contract file of its own, so this one needs a raise" in msg
    msg = _one(problems, "lambda/brand-new-lambda:")
    assert "1 *columns.test.js file(s), ceiling 0 (a directory not listed has ceiling 0)" in msg
    assert "New here: select-columns.test.js" in msg


def test_red_a_ceiling_bumped_with_no_raises_row_even_with_the_file_and_list_added():
    cfg, files, _ = _fixture()
    files.append("lambda/alpha/extra-columns.test.js")
    cfg["columns_tests_per_dir"]["lambda/alpha"] = 5
    cfg["columns_test_files"]["lambda/alpha"].append("extra-columns.test.js")
    assert not columns_problems(cfg, files, _fix_read)
    msg = _one(raises_problems(cfg), "lambda/alpha:")
    assert "ceiling 5 was raised with no reason" in msg and "come to 4" in msg
    # the list extended without the number is caught by the other check
    cfg["columns_tests_per_dir"]["lambda/alpha"] = 4
    assert "the ceiling was not raised" in _one(columns_problems(cfg, files, _fix_read), "lambda/alpha:")


def test_green_a_raise_made_the_documented_way_and_a_later_lowering_without_a_row():
    cfg, files, _ = _fixture()
    files += ["lambda/beta/joined-columns.test.js", "lambda/brand-new-lambda/select-columns.test.js"]
    cfg["columns_tests_per_dir"].update({"lambda/beta": 3, "lambda/brand-new-lambda": 1})
    cfg["columns_test_files"]["lambda/beta"].append("joined-columns.test.js")
    cfg["columns_test_files"]["lambda/brand-new-lambda"] = ["select-columns.test.js"]
    cfg["raises"] += [
        {"what": "lambda/beta", "from": 2, "to": 3, "why": "no keyed file here", "work_item": "X-1"},
        {"what": "lambda/brand-new-lambda", "from": 0, "to": 1, "why": "new lambda", "work_item": "X-2"},
    ]
    assert not columns_problems(cfg, files, _fix_read) and not raises_problems(cfg)
    # Lowered again with no row, then raised again from the lower number: still accounted for.
    cfg["columns_tests_per_dir"]["lambda/beta"] = 2
    assert not raises_problems(cfg)
    cfg["raises"].append({"what": "lambda/beta", "from": 2, "to": 3, "why": "again", "work_item": "X-3"})
    cfg["columns_tests_per_dir"]["lambda/beta"] = 3
    assert not raises_problems(cfg)


def test_red_a_raises_row_that_does_not_chain_or_is_incomplete():
    base, _, _ = _fixture()
    base["columns_tests_per_dir"]["lambda/alpha"] = 6

    cfg = copy.deepcopy(base)  # start 4, row claims to begin at 5: the step 4 -> 5 was never recorded
    cfg["raises"] = [{"what": "lambda/alpha", "from": 5, "to": 6, "why": "w", "work_item": "X-1"}]
    problems = raises_problems(cfg)
    assert "does not chain" in _one(problems, "raises[0]")
    _one(problems, "lambda/alpha:", "raised with no reason")

    cfg = copy.deepcopy(base)  # two rows with a gap between them
    cfg["raises"] = [
        {"what": "lambda/alpha", "from": 3, "to": 4, "why": "w", "work_item": "X-1"},
        {"what": "lambda/alpha", "from": 5, "to": 6, "why": "w", "work_item": "X-2"},
    ]
    assert "does not chain" in _one(raises_problems(cfg), "raises[1]")

    cfg = copy.deepcopy(base)  # rows that chain but stop short of the ceiling
    cfg["raises"] = [{"what": "lambda/alpha", "from": 4, "to": 5, "why": "w", "work_item": "X-1"}]
    assert "come to 5" in _one(raises_problems(cfg), "lambda/alpha:", "raised with no reason")

    cfg = copy.deepcopy(base)  # a row that goes nowhere, one with no reason, one for the wrong thing, one short
    cfg["raises"] = [
        {"what": "lambda/alpha", "from": 4, "to": 4, "why": "w", "work_item": "X-1"},
        {"what": "lambda/alpha", "from": 4, "to": 6, "why": " ", "work_item": "X-1"},
        {"what": "watchdog_exempt", "from": 2, "to": 3, "why": "w", "work_item": "X-1"},
        {"what": "lambda/alpha", "from": 4, "to": 6, "why": "w"},
    ]
    problems = raises_problems(cfg)
    assert "to > from" in _one(problems, "raises[0]")
    assert "must say something" in _one(problems, "raises[1]")
    assert "Only a columns ceiling can be raised" in _one(problems, "raises[2]")
    assert "needs every one of" in _one(problems, "raises[3]")


def test_red_a_count_below_its_ceiling_and_a_stale_file_list():
    cfg, files, _ = _fixture()
    files.remove("lambda/alpha/joined-columns.test.js")
    msg = _one(columns_problems(cfg, files, _fix_read), "lambda/alpha:")
    assert "set columns_tests_per_dir[\"lambda/alpha\"] to 3" in msg
    assert "remove joined-columns.test.js from columns_test_files" in msg
    # delete one, add one: the count holds, and the swap is still seen
    files.append("lambda/alpha/swapped-in-columns.test.js")
    msg = _one(columns_problems(cfg, files, _fix_read), "lambda/alpha:")
    assert "columns_test_files is stale" in msg and "swapped-in-columns.test.js" in msg


def test_red_editing_the_starting_values():
    cfg = load_config()
    d = sorted(cfg["_start"]["columns_tests_per_dir"])[0]
    cfg["_start"]["columns_tests_per_dir"][d] += 1
    assert start_digest(cfg) != START_SHA256
    cfg = load_config()
    cfg["_start"]["watchdog_exempt"].append("new-gate.mjs")
    assert start_digest(cfg) != START_SHA256


def test_red_a_new_layout_gate_that_drives_chrome_without_the_watchdog():
    cfg, _, gates = _fixture()
    gates["new-gate.mjs"] = DRIVER + "console.log('PASS')\n"
    msg = _one(watchdog_problems(cfg, gates), "new-gate.mjs")
    assert "without exit-watchdog.mjs" in msg and "does not take new names" in msg
    # adding it to the exempt list is not a way out
    cfg["watchdog_exempt"].append("new-gate.mjs")
    assert "never grows" in _one(watchdog_problems(cfg, gates), "new-gate.mjs")
    # a dynamic import and a multi-line import are still imports; a mention in a comment is not
    for src in ("const { resolveWebSocket } = await import('./cdp-socket.mjs')\n",
                "import {\n  resolveWebSocket,\n} from \"./cdp-socket.mjs\"\n"):
        gates["new-gate.mjs"] = src
        _one(watchdog_problems(cfg, gates), "new-gate.mjs", "never grows")
    cfg["watchdog_exempt"].remove("new-gate.mjs")
    gates["new-gate.mjs"] = "// transport: see cdp-socket.mjs, import { x } from './cdp-socket.mjs'\n"
    assert not watchdog_problems(cfg, gates)
    # with the watchdog it is green
    gates["new-gate.mjs"] = ARMED
    assert not watchdog_problems(cfg, gates)


def test_red_an_exempt_script_that_gained_the_watchdog_or_was_deleted_but_stayed_listed():
    cfg, _, gates = _fixture()
    gates["old-a.mjs"] = ARMED
    msg = _one(watchdog_problems(cfg, gates), "old-a.mjs")
    assert "now imports exit-watchdog.mjs" in msg and "Remove it from the list" in msg
    cfg["watchdog_exempt"].remove("old-a.mjs")
    assert not watchdog_problems(cfg, gates)

    cfg, _, gates = _fixture()
    del gates["old-b.mjs"]
    assert "no longer exists" in _one(watchdog_problems(cfg, gates), "old-b.mjs")

    cfg, _, gates = _fixture()
    gates["old-b.mjs"] = "console.log('no chrome any more')\n"
    assert "no longer imports cdp-socket.mjs" in _one(watchdog_problems(cfg, gates), "old-b.mjs")


# ── the fold is visible to the schema audit ───────────────────────────────────────────────────────────────────
# The cap message sends a new relation into an existing keyed file as a second key. These run the audit's own
# code (the parser, then main() as promote-gate invokes it) over exactly that edit.

ONE_RELATION = """\
// a keyed contract file as a lambda directory has it today
import { describe, it, expect } from 'vitest';
const AUDIT_COLUMNS = {
  seed_lot: ['id', 'created_by', 'deleted_at'],
};
describe('seed_lot', () => { it('x', () => { expect(Object.keys(AUDIT_COLUMNS)).toHaveLength(1); }); });
"""

FOLDED = ONE_RELATION.replace(
    "  seed_lot: ['id', 'created_by', 'deleted_at'],\n",
    "  seed_lot: ['id', 'created_by', 'deleted_at'],\n"
    "  // the JOIN this change adds, folded in as a second key\n"
    "  seed_parent: ['id', 'seed_lot_id',\n"
    "    'parent_lot_id'],\n",
)

HANDLER = """\
export async function handler(sql) {
  return sql`
    SELECT s.id, p.parent_lot_id
      FROM seed_lot s
      JOIN seed_parent p ON p.seed_lot_id = s.id
     WHERE s.deleted_at IS NULL`;
}
"""


def _parse(tmp_path, text, name="seed-lot-columns.test.js"):
    path = tmp_path / name
    path.write_text(text)
    return audit.parse_test_file(path)


def test_fold_a_second_key_in_an_existing_keyed_file_is_parsed_as_its_own_contract(tmp_path):
    assert FOLDED != ONE_RELATION
    assert _parse(tmp_path, ONE_RELATION) == [("seed_lot", ["id", "created_by", "deleted_at"])]
    # Its own relation with its own columns: no cross-product onto seed_lot, and seed_lot is untouched.
    assert _parse(tmp_path, FOLDED) == [
        ("seed_lot", ["id", "created_by", "deleted_at"]),
        ("seed_parent", ["id", "seed_lot_id", "parent_lot_id"]),
    ]


def test_fold_into_a_real_keyed_file_from_the_tree_keeps_every_existing_pair(tmp_path):
    # A fixture proves the regex; a real file proves the codebase. Every keyed, directory-specific contract file
    # in the tree gets one more key and must parse to exactly what it did plus that key.
    hosts = [
        p for p in real_columns_files()
        if os.path.basename(p) != HOUSEHOLD and _KEYED.search(_read(p))
    ]
    assert len(hosts) >= 80, f"only {len(hosts)} keyed host files found"
    unreadable = []
    for rel in hosts:
        src = _read(rel)
        before = _parse(tmp_path, src)
        m = _KEYED.search(src)
        folded = src[:m.end()] + "\n  zz_folded_relation: ['id', 'zz_col'],\n" + src[m.end():]
        after = _parse(tmp_path, folded)
        if not before or sorted(after) != sorted(before + [("zz_folded_relation", ["id", "zz_col"])]):
            unreadable.append(rel)
    assert not unreadable, f"a folded key is not read back from: {unreadable}"


def test_the_shapes_the_message_forbids_really_are_invisible_to_the_audit(tmp_path):
    # A second object under another name: audited by nothing.
    second = ONE_RELATION + "const AUDIT_COLUMNS_2 = {\n  seed_parent: ['id', 'seed_lot_id'],\n};\n"
    assert [t for t, _ in _parse(tmp_path, second)] == ["seed_lot"]
    # A keyed block in an AUDIT_TABLES file: the file's own table drops out of the audit.
    tables = "const AUDIT_TABLES = ['seed_lot'];\nconst SEED_LOT_COLUMNS = ['id', 'created_by'];\n"
    assert _parse(tmp_path, tables) == [("seed_lot", ["id", "created_by"])]
    dropped = tables + "const AUDIT_COLUMNS = {\n  seed_parent: ['id'],\n};\n"
    assert [t for t, _ in _parse(tmp_path, dropped)] == ["seed_parent"]
    # By import: nothing in the file's own text, nothing audited.
    assert _parse(tmp_path, "import { AUDIT_COLUMNS } from '../shared-contract.js';\n") == []


class _EveryColumn(frozenset):
    def __contains__(self, _col):
        return True

    def __bool__(self):
        return True


def _phase4_uncovered(repo, monkeypatch, capsys):
    fake_pg = types.ModuleType("psycopg2")
    fake_pg.connect = lambda _url: types.SimpleNamespace(close=lambda: None)
    monkeypatch.setitem(sys.modules, "psycopg2", fake_pg)
    monkeypatch.setattr(audit, "query_prod_columns", lambda _conn, _table: _EveryColumn())
    monkeypatch.setenv("NEON_DATABASE_URL", "postgresql://fake.invalid/db")
    monkeypatch.setattr(sys, "argv", ["dev-main-schema-audit.py", "--repo-root", str(repo), "--gate"])
    rc = audit.main()
    out, err = capsys.readouterr()
    m = re.search(r"^P4: 1 lambda\(s\), 2 relation ref\(s\) touched, (\d+) with NO column contract", out, re.M)
    assert m, f"no Phase 4 census for the fixture (exit {rc}):\n{out}\n{err}"
    return rc, int(m.group(1)), out


def test_fold_earns_phase4_credit_in_the_audit_main_the_promote_gate_runs(tmp_path, monkeypatch, capsys):
    d = tmp_path / "lambda" / "seeds"
    d.mkdir(parents=True)
    (tmp_path / "scripts").mkdir()
    (tmp_path / "scripts" / "schema-audit-join-baseline.json").write_text('{"uncovered_relations": 0}')
    (d / "index.js").write_text(HANDLER)

    (d / "seed-lot-columns.test.js").write_text(ONE_RELATION)
    rc, uncovered, out = _phase4_uncovered(tmp_path, monkeypatch, capsys)
    assert (rc, uncovered) == (1, 1), out  # the JOIN is uncovered and the ratchet reds: the state a lane starts in

    (d / "seed-lot-columns.test.js").write_text(FOLDED)
    rc, uncovered, out = _phase4_uncovered(tmp_path, monkeypatch, capsys)
    assert (rc, uncovered) == (0, 0), out  # one file, two keys: covered, with no new file
