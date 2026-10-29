# new-file: new subject: third-party action pinning across all workflows
"""Every third-party action a workflow uses is pinned to a full commit SHA.

Run: python3 -m pytest -q scripts/test_action_pins.py

A tag (`@v4`) is a pointer its owner can move; a 40-hex commit SHA cannot be moved under us. Repo-local
`./...` references (reusable workflows, local actions) are ours and are exempt. This pins "no floating ref";
it does not yet require one SHA per action.
"""
import glob
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
WORKFLOWS = sorted(glob.glob(os.path.join(HERE, "..", ".github", "workflows", "*.y*ml")))

_USES = re.compile(r"^\s*(?:-\s+)?uses:\s*(?P<ref>[^\s#]+)")
_PINNED = re.compile(r"^[^@\s]+@[0-9a-f]{40}$")


def _unpinned(text):
    """(line number, ref) for every non-local `uses:` whose ref is not `<action>@<40-hex sha>`."""
    bad = []
    for n, line in enumerate(text.splitlines(), 1):
        m = _USES.match(line)
        if not m:
            continue
        ref = m.group("ref").strip("'\"")
        if ref.startswith("./"):
            continue
        if not _PINNED.match(ref):
            bad.append((n, ref))
    return bad


def test_a_floating_tag_is_flagged():
    text = "steps:\n  - uses: actions/checkout@v4\n  - uses: actions/setup-python@v5 # v5\n"
    assert _unpinned(text) == [(2, "actions/checkout@v4"), (3, "actions/setup-python@v5")]


def test_a_branch_ref_a_short_sha_and_a_bare_action_are_flagged():
    sha = "a" * 40
    text = (f"  - uses: owner/act@main\n  - uses: owner/act@{sha[:7]}\n  - uses: owner/act\n"
            f"  - uses: owner/act@{'A' * 40}\n  - uses: owner/act@{sha}x\n")
    assert [ref for _, ref in _unpinned(text)] == [
        "owner/act@main", f"owner/act@{sha[:7]}", "owner/act", f"owner/act@{'A' * 40}", f"owner/act@{sha}x"]


def test_a_full_sha_a_subpath_action_and_a_local_reference_pass():
    sha = "0123456789abcdef0123456789abcdef01234567"
    text = (f"  - uses: actions/checkout@{sha} # v6.0.2\n  - uses: actions/cache/restore@{sha}\n"
            f"    uses: ./.github/workflows/deploy.yml\n  - uses: \"actions/setup-node@{sha}\"  # v6\n")
    assert _unpinned(text) == []


def test_a_commented_out_uses_line_is_not_read():
    assert _unpinned("      # uses: actions/checkout@v4\n") == []


def test_every_workflow_action_is_pinned_to_a_full_sha():
    hits, seen = [], 0
    for path in WORKFLOWS:
        with open(path) as fh:
            text = fh.read()
        seen += sum(1 for line in text.splitlines() if _USES.match(line))
        hits += [f"{os.path.basename(path)}:{n} {ref}" for n, ref in _unpinned(text)]
    assert WORKFLOWS and seen, "scanned no `uses:` line: the workflow glob or pattern is broken"
    assert not hits, "action not pinned to a 40-hex commit SHA (resolve the tag, keep `# vX.Y.Z`):\n" + "\n".join(hits)
