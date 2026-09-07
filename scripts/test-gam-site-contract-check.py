#!/usr/bin/env python3
"""Deterministic unit tests for gam-site-contract-check.py. No DB connection needed.
Run: python3 scripts/test-gam-site-contract-check.py

Guards the bilateral schema contract (2026-09-07). gam-site's gate 1 closed-world column check
froze gardensatmathews.com on 2026-09-03 when garden-app added four plant_varieties columns;
this repo had no idea gam-site existed. gam-site-contract-check.py mirrors that gate here.

A guard that cannot fail is not a guard, so every one of gate 1's four failure arms gets an
explicit MUST-FAIL case, not just a happy path:
    UNCLASSIFIED / PHANTOM / RELKIND / EVENT_TYPE.

Also pins digest parity between gam-site-contract-check.py::body_digest and
refresh-gam-site-contract.py::digest. Those two hash the same body in two files (CI must not
depend on the generator). If they diverge, the checker's self-consistency test inverts: every
contract looks tampered, or -- worse -- a tampered one looks clean. That is the single most
load-bearing assertion in this file.
"""
import importlib.util
import json
import sys
from pathlib import Path

SCRIPTS = Path(__file__).parent


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, str(SCRIPTS / filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


check_mod = _load("gam_contract_check", "gam-site-contract-check.py")
refresh_mod = _load("gam_contract_refresh", "refresh-gam-site-contract.py")

FAILURES = []


def check(name, cond):
    if cond:
        print(f"ok   - {name}")
    else:
        print(f"FAIL - {name}")
        FAILURES.append(name)


# A minimal source spec: 3 live columns, all classified, base table.
SPEC = {"table": "plant_varieties", "relkind": "r", "classified": ["id", "name", "notes"]}
LIVE = {"id", "name", "notes"}


# --- clean baseline: the guard must be quiet when nothing is wrong -----------------
check("clean source yields no findings",
      check_mod.compare_source("cultivars", SPEC, LIVE, "r") == [])

# --- arm 1: UNCLASSIFIED (the 2026-09-03 freeze) ----------------------------------
f = check_mod.compare_source("cultivars", SPEC, LIVE | {"seed_saved_from"}, "r")
check("UNCLASSIFIED: a live column absent from the contract is reported",
      len(f) == 1 and "UNCLASSIFIED" in f[0] and "seed_saved_from" in f[0])

f = check_mod.compare_source("cultivars", SPEC, LIVE | {"a", "b", "c", "d"}, "r")
check("UNCLASSIFIED: all four new columns named, not just the first",
      len(f) == 1 and all(c in f[0] for c in ("'a'", "'b'", "'c'", "'d'")) and "4 " in f[0])

# --- arm 2: PHANTOM (a DROP or RENAME in garden-app) ------------------------------
f = check_mod.compare_source("cultivars", SPEC, {"id", "name"}, "r")
check("PHANTOM: a contract column missing from prod is reported",
      len(f) == 1 and "no longer exist" in f[0] and "notes" in f[0])

# A rename is a drop plus an add -- it must trip BOTH arms, not be masked as one.
f = check_mod.compare_source("cultivars", SPEC, {"id", "name", "note_text"}, "r")
check("RENAME trips UNCLASSIFIED and PHANTOM together",
      len(f) == 2 and any("UNCLASSIFIED" in x for x in f)
      and any("no longer exist" in x for x in f))

# --- arm 3: RELKIND (base table replaced by a view -- bypasses RLS) ---------------
f = check_mod.compare_source("cultivars", SPEC, LIVE, "v")
check("RELKIND: table replaced by a view is reported",
      len(f) == 1 and "relkind=v" in f[0])

# --- missing relation entirely ----------------------------------------------------
f = check_mod.compare_source("cultivars", SPEC, set(), None)
check("MISSING TABLE: reported as a finding, and does not also emit phantom noise",
      len(f) == 1 and "does not exist in prod" in f[0])

# --- arm 4: EVENT_TYPE (freezes the site with NO schema change) -------------------
EV = {"allowed": ["watering", "harvest"], "denied": ["private_note"]}
check("event_type: fully classified set is quiet",
      check_mod.compare_event_types(EV, {"watering", "harvest", "private_note"}) == [])
f = check_mod.compare_event_types(EV, {"watering", "fermenting"})
check("EVENT_TYPE: an unclassified live event_type is reported",
      len(f) == 1 and "fermenting" in f[0])
check("event_type: a DENIED type is classified, not a finding",
      check_mod.compare_event_types(EV, {"private_note"}) == [])

# --- digest parity: the load-bearing one ------------------------------------------
sample = {
    "sources": {"x": {"table": "t", "relkind": "r", "classified": ["b", "a"]}},
    "event_types": {"relation": "event_log", "column": "event_type",
                    "allowed": ["z"], "denied": []},
}
check("digest parity: checker and refresher hash an identical body identically",
      check_mod.body_digest(sample) == refresh_mod.digest(sample))
check("digest is order-insensitive at the dict level",
      refresh_mod.digest({"event_types": sample["event_types"], "sources": sample["sources"]})
      == refresh_mod.digest(sample))
check("digest CHANGES when a classified column moves",
      refresh_mod.digest({**sample, "sources": {
          "x": {"table": "t", "relkind": "r", "classified": ["a"]}}}) != refresh_mod.digest(sample))

# --- extractor mirrors gate1's `or []` / `or {}` handling -------------------------
ex = refresh_mod.extract({"sources": {
    "project_stats": {"derive_from": "event_log", "columns": None,
                      "excluded": {"id": "r", "notes": "r"},
                      "allowed_types": ["watering"], "denied_types": []},
    "harvest": {"table": "harvest_log", "columns": [], "excluded": {"id": "r"}},
}})
check("extract: `columns: None` (project_stats) does not crash and uses excluded keys",
      ex["sources"]["project_stats"]["classified"] == ["id", "notes"])
check("extract: derive_from resolves the relation when `table:` is absent",
      ex["sources"]["project_stats"]["table"] == "event_log")
check("extract: `columns: []` (harvest) is handled",
      ex["sources"]["harvest"]["classified"] == ["id"])
check("extract: relkind defaults to 'r' like gate1",
      ex["sources"]["harvest"]["relkind"] == "r")

# A source that classifies nothing means a broken parse, not a permissive contract --
# vendoring it would make the checker silently blind to that whole table.
for bad, label in (
    ({"sources": {"s": {"table": "t", "columns": [], "excluded": {}}}}, "zero classified columns"),
    ({"sources": {"s": {"columns": ["a"]}}}, "no table/derive_from"),
    ({"sources": {}}, "no sources"),
):
    try:
        refresh_mod.extract(bad)
        check(f"extract: rejects {label}", False)
    except ValueError:
        check(f"extract: rejects {label}", True)

# --- the REAL vendored contract is well-formed and self-consistent ----------------
contract_path = SCRIPTS / "gam-site-column-contract.json"
if contract_path.exists():
    real = json.loads(contract_path.read_text())
    check("vendored contract: recorded digest matches its own body",
          real.get("source_digest") == check_mod.body_digest(real))
    check("vendored contract: all 8 gam-site sources present",
          len(real.get("sources") or {}) == 8)
    check("vendored contract: every source names a table and classifies columns",
          all(s.get("table") and s.get("classified") for s in real["sources"].values()))
    check("vendored contract: event_type closed world is populated",
          bool((real.get("event_types") or {}).get("allowed")))
    check("vendored contract: carries provenance for drift triage",
          all(real.get(k) for k in ("generated_at", "source_repo", "source_commit")))
    # The contract must never carry a credential -- it is committed to a repo.
    blob = contract_path.read_text()
    check("vendored contract: contains no connection string",
          "postgres://" not in blob and "postgresql://" not in blob and "neon.tech" not in blob)
else:
    check("vendored contract present", False)

print()
if FAILURES:
    print(f"{len(FAILURES)} FAILURE(S): {FAILURES}")
    sys.exit(1)
print("All gam-site contract checks passed.")
