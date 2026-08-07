#!/usr/bin/env python3
# CI dependency-audit gate (WS-B M6). Fails the build on any prod (--omit=dev) advisory at
# severity moderate/high/critical EXCEPT GHSA IDs documented in scripts/audit-allowlist.json
# (each a justified, dated non-applicability waiver). Replaces the bare
# `npm audit --omit=dev --audit-level=moderate` so a single non-applicable advisory can be
# waived-with-justification without dropping the gate for everything else.
#
#   CI:         python3 scripts/audit-gate.py
#   Local test: npm audit --omit=dev --json --package-lock-only | python3 scripts/audit-gate.py --stdin
#
# LAMBDA SCOPE (added 2026-08-06, OPS-AUDITLAMBDA-001). Root package.json declares NO
# `workspaces`, so a root `npm audit` never reads lambda/*/package.json — for the gate's whole
# life it audited ZERO Lambda runtime dependencies while reporting PASS. It missed
# GHSA-f88m-g3jw-g9cj (high, libvips CVEs in sharp) in lambda/photocdn-derivative, which decodes
# user-uploaded photos. This gate now audits every lambda/*/package.json as its own project.
#
# WHAT SURFACE IS AUDITED, per lambda: whatever `deploy-lambda.yml` actually resolves. That
# workflow builds each function with `npm install --omit=dev` (NOT `npm ci`), so:
#   * lockfile present  -> `npm install` honours it, so the committed lockfile IS what ships:
#                          audit it in place (--package-lock-only; read-only, mutates nothing).
#   * lockfile absent   -> deploy floats within the semver ranges: reproduce that by resolving
#                          the manifest into a TEMP dir (`npm install --package-lock-only`) and
#                          auditing the result. The repo is never written to.
# A missing lockfile is therefore a LOUD resolved-from-manifest audit, never a skip. If the
# resolution or the audit fails, that target is UNAUDITED and the gate exits 2 — a gate that
# exits 0 while verifying nothing is worse than no gate (cf. OPS-DRIFTFAILLOUD-001).
#
# FAIL-CLOSED ON AN UNREACHABLE REGISTRY. `npm audit --json` against a dead registry emits
# {"message": ...} with NO "vulnerabilities"/"metadata" keys, which the pre-2026-08-06 gate
# parsed as "zero advisories" and reported PASS at exit 0. Every audit result is now shape-
# checked (`metadata` AND `vulnerabilities` must both be present) before it is trusted.
#
# Exit codes: 0 = audited clean (allowlisted waivers only) | 1 = non-allowlisted advisory
#             2 = COULD NOT VERIFY (unparseable output, registry unreachable, target unaudited)
import json, subprocess, sys, pathlib, hashlib, tempfile, shutil

BLOCK = {"moderate", "high", "critical"}
ROOT = pathlib.Path(__file__).resolve().parent.parent
NPM_TIMEOUT = 300  # per npm invocation; a hung registry must fail loud, not hang CI


class AuditUnavailable(Exception):
    """The audit did not run to a trustworthy result. NEVER downgrade this to 'no advisories'."""


def load_allow(path=None):
    p = pathlib.Path(path) if path else ROOT / "scripts" / "audit-allowlist.json"
    return json.loads(p.read_text()).get("allow", {})


def parse_audit(raw, scope):
    """Parse `npm audit --json` output, refusing any result that is not a real audit report."""
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        raise AuditUnavailable("%s: npm audit --json produced no parseable output — %s"
                               % (scope, (raw or "")[:300].replace("\n", " ")))
    if not isinstance(data, dict):
        raise AuditUnavailable("%s: npm audit --json did not return an object" % scope)
    # A completed audit ALWAYS carries both keys, even with zero findings. Their absence means
    # npm errored (ECONNREFUSED / ENOLOCK / EAI_AGAIN / 5xx) — the green-on-error trap.
    if "metadata" not in data or "vulnerabilities" not in data:
        err = data.get("message") or json.dumps(data.get("error", data))[:300]
        raise AuditUnavailable("%s: npm audit did not complete (registry unreachable or no "
                               "lockfile) — %s" % (scope, err))
    return data


def scan(data, allow, scope="root"):
    """Classify a parsed audit report into (waived, blocking, unidentified). `scope` labels
    each finding so a lambda advisory is never mistaken for a root one."""
    waived, blocking, unidentified = [], [], []
    for pkg, v in data.get("vulnerabilities", {}).items():
        label = pkg if scope == "root" else "%s:%s" % (scope, pkg)
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
                unidentified.append((label, sev, (via.get("title") or "")[:60]))
                continue
            (waived if ident in allow else blocking).append((label, sev, ident))
    return waived, blocking, unidentified


def run_npm(args, cwd, scope):
    try:
        r = subprocess.run(["npm"] + args, capture_output=True, text=True,
                           cwd=str(cwd), timeout=NPM_TIMEOUT)
    except subprocess.TimeoutExpired:
        raise AuditUnavailable("%s: `npm %s` timed out after %ds" % (scope, args[0], NPM_TIMEOUT))
    except OSError as e:
        raise AuditUnavailable("%s: could not exec npm — %s" % (scope, e))
    return r


def lambda_targets(root=None):
    """Every lambda/*/package.json, with the surface deploy-lambda.yml would resolve for it."""
    base = (pathlib.Path(root) if root else ROOT) / "lambda"
    targets, orphans = [], []
    if not base.is_dir():
        return targets, orphans
    for d in sorted(p for p in base.iterdir() if p.is_dir()):
        if (d / "package.json").is_file():
            has_lock = (d / "package-lock.json").is_file() or (d / "npm-shrinkwrap.json").is_file()
            targets.append((d.name, d, "lockfile" if has_lock else "manifest"))
        elif any(d.glob("*.mjs")) or any(d.glob("*.js")):
            orphans.append(d.name)  # code but no manifest: no deps to audit, still reported
    return targets, orphans


def signature(path, mode):
    """Dedupe key. 26 lambdas share 8 distinct dependency sets; auditing each separately would
    cost ~8x for byte-identical inputs."""
    h = hashlib.sha256()
    if mode == "manifest":
        # only the declared ranges drive resolution; name/version/scripts do not
        d = json.loads((path / "package.json").read_text())
        h.update(json.dumps({k: d.get(k, {}) for k in
                             ("dependencies", "optionalDependencies", "peerDependencies",
                              "overrides")}, sort_keys=True).encode())
    else:
        h.update((path / "package.json").read_bytes())
        for name in ("package-lock.json", "npm-shrinkwrap.json"):
            f = path / name
            if f.is_file():
                h.update(f.read_bytes())
    return mode + ":" + h.hexdigest()[:16]


def audit_target(path, mode, scope):
    """Return a parsed audit report for one lambda. Raises AuditUnavailable rather than ever
    returning an empty/again-green result."""
    if mode == "lockfile":
        r = run_npm(["audit", "--omit=dev", "--package-lock-only", "--json"], path, scope)
        return parse_audit(r.stdout, scope)
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="audit-gate-"))
    try:
        shutil.copy2(path / "package.json", tmp / "package.json")
        r = run_npm(["install", "--package-lock-only", "--omit=dev", "--no-audit", "--no-fund"],
                    tmp, scope)
        if not (tmp / "package-lock.json").is_file():
            raise AuditUnavailable("%s: has no lockfile and resolving package.json failed "
                                   "(rc=%d) — %s" % (scope, r.returncode,
                                                     (r.stderr or r.stdout)[-300:].replace("\n", " ")))
        r = run_npm(["audit", "--omit=dev", "--package-lock-only", "--json"], tmp, scope)
        return parse_audit(r.stdout, scope)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def audit_lambdas(allow, root=None, _audit=None):
    """Audit every lambda manifest. Returns (waived, blocking, unidentified, notes, unaudited)."""
    _audit = _audit or audit_target  # late-bound so the npm boundary stays patchable
    targets, orphans = lambda_targets(root)
    waived, blocking, unidentified, notes, unaudited = [], [], [], [], []
    for name in orphans:
        notes.append("::notice title=audit scope::lambda/%s has source but no package.json — "
                     "no declared dependencies to audit" % name)
    groups = {}
    for name, path, mode in targets:
        groups.setdefault(signature(path, mode), []).append((name, path, mode))
    for members in groups.values():
        name, path, mode = members[0]
        scope = "lambda/%s" % name
        peers = [m[0] for m in members[1:]]
        try:
            data = _audit(path, mode, scope)
        except AuditUnavailable as e:
            unaudited.append([m[0] for m in members])
            notes.append("::error title=audit UNAUDITED::%s" % e)
            continue
        w, b, u = scan(data, allow, scope)
        waived += w
        blocking += b
        unidentified += u
        src = ("lockfile (what `npm install` ships)" if mode == "lockfile"
               else "NO LOCKFILE — resolved from package.json, matching deploy-lambda.yml's "
                    "floating `npm install --omit=dev`")
        notes.append("::notice title=audit scope::%s audited from %s%s" %
                     (scope, src, (" [identical deps: %s]" % ", ".join(peers)) if peers else ""))
    return waived, blocking, unidentified, notes, unaudited


def main(argv):
    argv = list(argv)
    allow = load_allow()
    waived, blocking, unidentified, notes, unaudited = [], [], [], [], []
    do_root = "--lambdas-only" not in argv
    do_lambdas = "--root-only" not in argv and "--stdin" not in argv

    if do_root:
        try:
            raw = sys.stdin.read() if "--stdin" in argv else run_npm(
                ["audit", "--omit=dev", "--json"], ROOT, "root").stdout
            w, b, u = scan(parse_audit(raw, "root"), allow, "root")
            waived += w
            blocking += b
            unidentified += u
            notes.append("::notice title=audit scope::root package.json audited "
                         "(declares no `workspaces` — lambda/* is NOT covered by this pass)")
        except AuditUnavailable as e:
            unaudited.append(["root"])
            notes.append("::error title=audit UNAUDITED::%s" % e)

    if do_lambdas:
        lw, lb, lu, ln, lun = audit_lambdas(allow)
        waived += lw
        blocking += lb
        unidentified += lu
        notes += ln
        unaudited += lun

    for line in notes:
        print(line)
    for pkg, sev, ident in waived:
        print("::notice title=audit waived::%s [%s] %s — allowlisted (scripts/audit-allowlist.json)"
              % (pkg, sev, ident))
    for pkg, sev, title in unidentified:
        print("::error title=audit BLOCK::%s [%s] advisory has no GHSA/source id to waive — %s"
              % (pkg, sev, title))
    for pkg, sev, ident in blocking:
        fix = ("remediate the dep or add a documented, dated waiver to scripts/audit-allowlist.json")
        if pkg.startswith("lambda/"):
            fix = ("bump the dependency range in %s/package.json and redeploy that function "
                   "(a caret on a 0.x version pins the minor, so no deploy-time `npm install` "
                   "will ever reach a fix in the next minor — the manifest MUST be edited); "
                   "waive only with a documented, dated non-applicability note in "
                   "scripts/audit-allowlist.json" % pkg.split(":")[0])
        print("::error title=audit BLOCK::%s [%s] %s — NOT allowlisted; %s" % (pkg, sev, ident, fix))

    if unaudited:
        flat = [n for g in unaudited for n in g]
        print("\n❌ dependency-audit gate COULD NOT VERIFY %d target(s): %s. Exiting 2 — the gate "
              "refuses to report PASS over an unaudited target." % (len(flat), ", ".join(flat)))
        return 2
    if blocking or unidentified:
        print("\n❌ dependency-audit gate FAIL: %d non-allowlisted moderate+ prod advisory(ies)."
              % (len(blocking) + len(unidentified)))
        return 1
    print("✅ dependency-audit gate PASS (%d waived, 0 blocking)." % len(waived))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
