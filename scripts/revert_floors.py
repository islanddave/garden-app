"""revert_floors.py — the revert FLOOR: the oldest release prod may be put back to (OPS-REVERTRESTORE-001 A1).

Some releases are one-way. Once prod has run one, code from before it must not run in prod again,
because something outside the code keeps the newer state and only newer code knows how to handle it:
  v4.156.0  the page-scroll manager sets history.scrollRestoration = 'manual'. Chrome keeps that mode
            per history entry across the service worker's update reload, and only a bundle that knows
            SCROLL_MANAGER_ENABLED (on or off) writes 'auto' back, so any older bundle — a revert-gate,
            a redeploy, a git revert — leaves open sessions losing their place on Back
            (src/lib/featureFlags.js, ROLLBACK RUNBOOK above the flag).
  v4.135.0  garden-daily-plan-hourly is live and the three older daily-plan rules are retired. An older
            deploy-lambda.yml re-creates the nightly rule (v4.134.0's second EventBridge step) or all
            three (v4.129.0 and before) and never deletes the hourly one: two schedules.

scripts/revert-floors.json lists them: {"floors": [entry, ...]}, every entry with exactly these keys:
  floor         the oldest version prod may run once the entry is in force (vX.Y.Z)
  since         the entry is in force once prod runs this version or later (vX.Y.Z, never below floor)
  reason        why, on one line
  ledger        the ledger row
  undo_instead  how to undo `since` without putting older code back: {"flag": NAME, "file": PATH},
                a compile-time boolean that a forward build sets to false, or null when there is no
                switch and only a forward fix can undo it

The effective floor is the highest `floor` among the entries whose `since` <= the version prod runs.
It is read from the CURRENT tree, never the target's: a target predates its own floor.

Consumers — keep them on this module, never on a local copy:
  revert-to.py     require_target_above_floor(): its first refusal, before any read of the target
  forward-undo.py  the entry for the release it undoes names the flag to switch off; a code revert
                   that would land below the floor refuses

Stdlib only. Anything unreadable or malformed raises FloorError: a floor that cannot be read must
refuse, never read as "no floor".
"""
import json
import os
import re

FLOORS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "revert-floors.json")
RELEASE_RE = re.compile(r"^v(\d+)\.(\d+)\.(\d+)$")
VERSION_RE = re.compile(r"^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$")
LEDGER_RE = re.compile(r"^[A-Z0-9]+(?:-[A-Z0-9]+)+$")
FLAG_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")
ENTRY_KEYS = frozenset({"floor", "since", "reason", "ledger", "undo_instead"})
UNDO_KEYS = frozenset({"flag", "file"})


class FloorError(Exception):
    """The floor could not be established. Fatal for every caller — never read it as "no floor"."""


def version_key(version):
    """'v4.156.0', '4.156.0', 'v4.156' or 'v4' -> (4, 156, 0). Raises FloorError on anything else."""
    m = VERSION_RE.match(version) if isinstance(version, str) else None
    if not m:
        raise FloorError(f"not a version: {version!r}")
    return tuple(int(g or 0) for g in m.groups())


def _check_entry(e, where):
    if not isinstance(e, dict) or set(e) != ENTRY_KEYS:
        got = sorted(e) if isinstance(e, dict) else type(e).__name__
        raise FloorError(f"{where} must have exactly the keys {sorted(ENTRY_KEYS)} (got {got})")
    for k in ("floor", "since"):
        if not isinstance(e[k], str) or not RELEASE_RE.match(e[k]):
            raise FloorError(f"{where}.{k} = {e[k]!r} is not a release version vX.Y.Z")
    if version_key(e["floor"]) > version_key(e["since"]):
        raise FloorError(f"{where}: floor {e['floor']} is above since {e['since']}; the floor would refuse "
                         "even the release that puts it in force")
    if not isinstance(e["reason"], str) or not e["reason"].strip() or "\n" in e["reason"]:
        raise FloorError(f"{where}.reason must be one non-empty line")
    if not isinstance(e["ledger"], str) or not LEDGER_RE.match(e["ledger"]):
        raise FloorError(f"{where}.ledger = {e['ledger']!r} is not a ledger id")
    u = e["undo_instead"]
    if u is None:
        return
    if not isinstance(u, dict) or set(u) != UNDO_KEYS:
        raise FloorError(f"{where}.undo_instead must be null or exactly {{'flag', 'file'}} (got {u!r:.120})")
    if not isinstance(u["flag"], str) or not FLAG_RE.match(u["flag"]):
        raise FloorError(f"{where}.undo_instead.flag = {u['flag']!r} is not a constant name")
    f = u["file"]
    if (not isinstance(f, str) or not f or f.startswith("/") or "\\" in f
            or any(part in ("", ".", "..") for part in f.split("/"))):
        raise FloorError(f"{where}.undo_instead.file = {f!r} is not a plain repo-relative path")


def parse(text, source="revert-floors.json"):
    """The entries of a floor file's text, validated. Raises FloorError, never returns []."""
    try:
        raw = json.loads(text)
    except (TypeError, ValueError) as e:
        raise FloorError(f"{source} is not valid JSON: {e}")
    if not isinstance(raw, dict) or set(raw) != {"floors"}:
        raise FloorError(f"{source} must be an object whose only key is 'floors'")
    entries = raw["floors"]
    if not isinstance(entries, list) or not entries:
        raise FloorError(f"{source}: 'floors' must be a non-empty list; a floor is never removed, "
                         "so an empty list is damage, not a decision")
    for i, e in enumerate(entries):
        _check_entry(e, f"{source} floors[{i}]")
    return entries


def load(path=None):
    """The entries of the floor file at `path` (default: this tree's scripts/revert-floors.json)."""
    path = FLOORS if path is None else path
    try:
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
    except (OSError, UnicodeDecodeError) as e:
        raise FloorError(f"cannot read {path}: {e}")
    return parse(text, source=path)


def in_force(entries, prod_version):
    """The entries in force while prod runs `prod_version`: those whose `since` <= it."""
    prod = version_key(prod_version)
    return [e for e in entries if version_key(e["since"]) <= prod]


def governing_entry(entries, prod_version):
    """The in-force entry with the highest floor (the first such in file order), or None."""
    best = None
    for e in in_force(entries, prod_version):
        if best is None or version_key(e["floor"]) > version_key(best["floor"]):
            best = e
    return best


def entries_since(entries, version):
    """The entries that `version` itself put in force (since == version)."""
    key = version_key(version)
    return [e for e in entries if version_key(e["since"]) == key]
