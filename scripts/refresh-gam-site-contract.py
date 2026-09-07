#!/usr/bin/env python3
"""
refresh-gam-site-contract.py - regenerate (or verify) the vendored gam-site column contract.

WHY THIS EXISTS
gam-site (the public website, private repo islanddave/gardens-at-mathews-rd) publishes
gardensatmathews.com from garden-app's PROD Neon. Its build gate 1 ("closed-world columns",
gam-site/tools/gates.py::gate1) reads pg_attribute for each published table and FAILs if any
live column sits in neither `columns:` nor `excluded:` of gam-site/public-export.yaml. That
manifest IS the contract.

The contract was unilateral: gam-site knows about garden-app, garden-app had no idea gam-site
existed. On 2026-09-03 seed-saving work added four plant_varieties columns and froze the public
site -- garden-app's CI was green throughout, because nothing in this repo had ever heard of
public-export.yaml. This script vendors the classified-column sets INTO garden-app so
scripts/gam-site-contract-check.py can warn at the moment the schema changes.

WHAT IS EXTRACTED (and why only this)
Only the closed-world inputs gate 1 actually compares against:
  - per source: the relation name (`table:` or `derive_from:`), expected `relkind:`, and
    `classified` = set(columns) | set(excluded.keys()) -- gate1's own expression, verbatim.
  - the event_type closed world: allowed_types + denied_types on the project_stats source.
Deliberately NOT vendored: exclusion *reasons*, `where:` filters, `emit:`, `group_by:`, notes.
Those govern what gam-site publishes; they cannot break a build when garden-app changes schema,
and copying them would enlarge a mirror that has to be kept honest for no gain.

DRIFT
This produces a second copy of another repo's data, which can go stale. Two guards:
  1. `source_digest` is a sha256 over the CANONICALIZED EXTRACT (sorted JSON of exactly the
     fields above) -- not over the raw file, so gam-site comment/reason edits do not register as
     drift and the signal stays meaningful.
  2. `--check` recomputes that digest from a live gam-site checkout and exits 1 on mismatch.
     This machine is the only place both repos exist, so this is where drift is detectable;
     CI additionally surfaces the contract's AGE on every run so a stale copy is visible in the
     run summary rather than only when someone thinks to look.
Direction of error matters more than its existence: if this copy lags gam-site (it classified a
column we do not know about) the checker reports an extra unclassified column -- a FALSE
POSITIVE, noisy and safe. The false-negative direction requires gam-site to REMOVE a
classification, which is not a normal edit. See gam-site-contract-check.py for the full argument.

Usage:
    python3 scripts/refresh-gam-site-contract.py                 # regenerate the vendored copy
    python3 scripts/refresh-gam-site-contract.py --check         # verify, write nothing
    python3 scripts/refresh-gam-site-contract.py --gam-site PATH # non-default gam-site checkout

Exit codes:
    0 = wrote the contract (default mode) / vendored copy matches gam-site (--check)
    1 = --check found drift (vendored copy is stale -- rerun without --check)
    2 = error (gam-site checkout or manifest unreadable, PyYAML missing, parse failure)

Requires PyYAML and a local gam-site checkout. NEITHER is needed by the CI checker, which
reads only the generated JSON -- that asymmetry is intentional: CI gains no new dependency
and no cross-repo access.
"""
import argparse
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_GAM_SITE = Path(
    "/Users/davenichols/AI/Claude/Projects/Gardening/gam-site"
)
CONTRACT_REL = "scripts/gam-site-column-contract.json"
SOURCE_REPO = "islanddave/gardens-at-mathews-rd"
SOURCE_PATH = "public-export.yaml"


def extract(manifest: dict) -> dict:
    """Reduce public-export.yaml to the closed-world inputs gate 1 compares.

    `classified` mirrors gates.py::gate1 exactly:
        set(src.get("columns") or []) | set((src.get("excluded") or {}).keys())
    The `or []` / `or {}` are load-bearing, not defensive noise -- project_stats carries
    `columns: None` (it emits derived aggregates, not passthrough columns) and harvest
    carries `columns: []`. A plain .get() would TypeError on the first and a naive
    `if "columns" in src` would treat both as absent.
    """
    sources = manifest.get("sources") or {}
    if not sources:
        raise ValueError("manifest has no `sources:` block")

    out: dict[str, dict] = {}
    for name, src in sources.items():
        table = src.get("table") or src.get("derive_from")
        if not table:
            raise ValueError(f"source {name!r} names neither `table:` nor `derive_from:`")
        classified = set(src.get("columns") or []) | set((src.get("excluded") or {}).keys())
        if not classified:
            raise ValueError(f"source {name!r} classifies zero columns -- refusing to vendor")
        out[name] = {
            "table": table,
            # gate1 defaults relkind to 'r' when the manifest omits it; a published relation
            # that becomes a view bypasses RLS, which is why gate1 checks this at all.
            "relkind": src.get("relkind", "r"),
            "classified": sorted(classified),
        }

    ps = sources.get("project_stats") or {}
    allowed = sorted(ps.get("allowed_types") or [])
    denied = sorted(ps.get("denied_types") or [])
    if not allowed:
        raise ValueError("project_stats declares no allowed_types -- refusing to vendor")

    return {
        "sources": out,
        # Second freeze vector, and the one easiest to trip without touching a migration at
        # all: gate 1 also closes the world over DISTINCT event_log.event_type. Shipping a
        # handler that writes a brand-new event_type freezes the site with no schema change.
        "event_types": {
            "relation": "event_log",
            "column": "event_type",
            "allowed": allowed,
            "denied": denied,
        },
    }


def digest(extracted: dict) -> str:
    """sha256 over the canonicalized extract. Sorted keys + compact separators so the digest
    depends on contract CONTENT, never on dict ordering or gam-site's YAML formatting."""
    blob = json.dumps(extracted, sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(blob.encode("utf-8")).hexdigest()


def gam_site_commit(gam_site: Path) -> str:
    """Best-effort provenance. A missing/failed git call is recorded as 'unknown' rather than
    aborting -- the digest is the integrity mechanism; the commit is a human breadcrumb."""
    try:
        res = subprocess.run(
            ["git", "-C", str(gam_site), "rev-parse", "HEAD"],
            capture_output=True, text=True, timeout=10,
        )
        return res.stdout.strip() if res.returncode == 0 and res.stdout.strip() else "unknown"
    except (OSError, subprocess.SubprocessError):
        return "unknown"


def build(gam_site: Path) -> tuple[dict, dict]:
    try:
        import yaml
    except ImportError:
        print(
            "FAIL: PyYAML not installed. Install: pip install pyyaml --break-system-packages",
            file=sys.stderr,
        )
        raise SystemExit(2)

    manifest_path = gam_site / SOURCE_PATH
    if not manifest_path.exists():
        print(f"FAIL: {manifest_path} not found -- is --gam-site correct?", file=sys.stderr)
        raise SystemExit(2)

    try:
        manifest = yaml.safe_load(manifest_path.read_text())
    except yaml.YAMLError as exc:
        print(f"FAIL: could not parse {manifest_path}: {exc}", file=sys.stderr)
        raise SystemExit(2)

    try:
        extracted = extract(manifest)
    except ValueError as exc:
        print(f"FAIL: {manifest_path}: {exc}", file=sys.stderr)
        raise SystemExit(2)

    contract = {
        "_comment": (
            "VENDORED from gam-site (private repo). Generated by "
            "scripts/refresh-gam-site-contract.py -- do NOT hand-edit; rerun the refresher. "
            "Consumed by scripts/gam-site-contract-check.py. See either script for why a "
            "vendored copy was chosen over a cross-repo checkout."
        ),
        "source_repo": SOURCE_REPO,
        "source_path": SOURCE_PATH,
        "source_commit": gam_site_commit(gam_site),
        "source_digest": digest(extracted),
        "manifest_version": manifest.get("version"),
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        **extracted,
    }
    return contract, extracted


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--gam-site",
        default=str(DEFAULT_GAM_SITE),
        help=f"gam-site checkout root (default: {DEFAULT_GAM_SITE})",
    )
    parser.add_argument(
        "--repo-root",
        default=".",
        help="garden-app repo root (default: current directory)",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify the vendored copy against gam-site and exit 1 on drift; write nothing",
    )
    args = parser.parse_args()

    gam_site = Path(args.gam_site).resolve()
    out_path = Path(args.repo_root).resolve() / CONTRACT_REL

    contract, extracted = build(gam_site)
    fresh_digest = contract["source_digest"]

    if args.check:
        if not out_path.exists():
            print(f"FAIL: {out_path} does not exist -- run without --check to generate it")
            return 1
        try:
            vendored = json.loads(out_path.read_text())
        except (json.JSONDecodeError, OSError) as exc:
            print(f"FAIL: could not read {out_path}: {exc}", file=sys.stderr)
            return 2
        # Two INDEPENDENT questions, and conflating them is a real hole: the stored digest
        # lives in the same file as the data it certifies, so comparing only the stored field
        # to gam-site passes a contract whose BODY was hand-edited (caught in test, 2026-09-07).
        # 1. self-consistency: does the vendored body still hash to its own stored digest?
        vendored_body = {
            "sources": vendored.get("sources") or {},
            "event_types": vendored.get("event_types") or {},
        }
        recomputed = digest(vendored_body)
        if recomputed != vendored.get("source_digest"):
            print(f"FAIL: {out_path.name} is INTERNALLY INCONSISTENT -- its body does not hash "
                  f"to its own recorded source_digest. It was hand-edited or truncated.")
            print(f"    recorded:   {vendored.get('source_digest')}")
            print(f"    recomputed: {recomputed}")
            print()
            print("Do not hand-edit this file. Rerun without --check to regenerate it.")
            return 1

        # 2. drift: does that (now-trusted) body match gam-site's current manifest?
        if recomputed == fresh_digest:
            print(f"PASS: vendored contract matches gam-site ({fresh_digest[:23]}...).")
            print(f"      generated {vendored.get('generated_at')} from "
                  f"{vendored.get('source_commit', 'unknown')[:12]}")
            return 0
        print("FAIL: vendored contract has DRIFTED from gam-site/public-export.yaml.")
        print(f"    vendored: {recomputed}")
        print(f"    gam-site: {fresh_digest}")
        # Name the moved columns. "The digest changed" is not actionable; this is.
        old_srcs = vendored.get("sources") or {}
        for name, src in extracted["sources"].items():
            old = set((old_srcs.get(name) or {}).get("classified") or [])
            new = set(src["classified"])
            if old != new:
                added, removed = sorted(new - old), sorted(old - new)
                print(f"    {name}: +{added} -{removed}")
        for name in sorted(set(old_srcs) - set(extracted["sources"])):
            print(f"    {name}: source REMOVED from gam-site manifest")
        old_ev = vendored.get("event_types") or {}
        for key in ("allowed", "denied"):
            old, new = set(old_ev.get(key) or []), set(extracted["event_types"][key])
            if old != new:
                print(f"    event_types.{key}: +{sorted(new - old)} -{sorted(old - new)}")
        print()
        print("Rerun without --check to refresh, then commit the regenerated contract.")
        return 1

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(contract, indent=2, sort_keys=False) + "\n")
    n_cols = sum(len(s["classified"]) for s in extracted["sources"].values())
    print(f"Wrote {out_path}")
    print(f"  {len(extracted['sources'])} sources, {n_cols} classified columns, "
          f"{len(extracted['event_types']['allowed'])} allowed + "
          f"{len(extracted['event_types']['denied'])} denied event_types")
    print(f"  digest {fresh_digest}")
    print(f"  from {SOURCE_REPO}@{contract['source_commit'][:12]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
