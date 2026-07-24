#!/usr/bin/env python3
# CI dependency-audit gate (WS-B M6). Fails the build on any prod (--omit=dev) advisory at
# severity moderate/high/critical EXCEPT GHSA IDs documented in scripts/audit-allowlist.json
# (each a justified, dated non-applicability waiver). Replaces the bare
# `npm audit --omit=dev --audit-level=moderate` so a single non-applicable advisory can be
# waived-with-justification without dropping the gate for everything else.
#
#   CI:         python3 scripts/audit-gate.py
#   Local test: npm audit --omit=dev --json --package-lock-only | python3 scripts/audit-gate.py --stdin
import json, subprocess, sys, pathlib

BLOCK = {"moderate", "high", "critical"}
ROOT = pathlib.Path(__file__).resolve().parent.parent
allow = json.loads((ROOT / "scripts" / "audit-allowlist.json").read_text()).get("allow", {})

if "--stdin" in sys.argv:
    raw = sys.stdin.read()
else:
    raw = subprocess.run(["npm", "audit", "--omit=dev", "--json"], capture_output=True, text=True).stdout

try:
    data = json.loads(raw)
except json.JSONDecodeError:
    print("::error title=audit gate::npm audit --json produced no parseable output")
    print(raw[:2000])
    sys.exit(2)

waived, blocking, unidentified = [], [], []
for pkg, v in data.get("vulnerabilities", {}).items():
    for via in v.get("via", []):
        if not isinstance(via, dict):
            continue  # transitive package name (its advisory is counted on the source package)
        sev = via.get("severity", "")
        if sev not in BLOCK:
            continue
        url = via.get("url", "")
        if "GHSA-" in url:
            ident = url.rsplit("/", 1)[-1]
        elif via.get("source"):
            ident = "npm:%s" % via["source"]
        else:
            unidentified.append((pkg, sev, (via.get("title") or "")[:60]))
            continue
        (waived if ident in allow else blocking).append((pkg, sev, ident))

for pkg, sev, ident in waived:
    print("::notice title=audit waived::%s [%s] %s — allowlisted (scripts/audit-allowlist.json)" % (pkg, sev, ident))
for pkg, sev, title in unidentified:
    print("::error title=audit BLOCK::%s [%s] advisory has no GHSA/source id to waive — %s" % (pkg, sev, title))
for pkg, sev, ident in blocking:
    print("::error title=audit BLOCK::%s [%s] %s — NOT allowlisted; remediate the dep or add a documented, dated waiver to scripts/audit-allowlist.json" % (pkg, sev, ident))

if blocking or unidentified:
    print("\n❌ dependency-audit gate FAIL: %d non-allowlisted moderate+ prod advisory(ies)." % (len(blocking) + len(unidentified)))
    sys.exit(1)
print("✅ dependency-audit gate PASS (%d waived, 0 blocking)." % len(waived))
