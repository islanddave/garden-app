#!/usr/bin/env python3
"""check-lambda-current.py — are the RUNNING prod Lambdas already built from DEV_SHA's Lambda inputs?

OPS-LAMSKIPVSMAIN-001. promote-gate's `lam` step runs this before the fast-forward to decide whether a
promote may skip deploy-lambdas (the SPA-only promote). Only a clean exit 0 permits the skip.

WHY NOT "DID dev_sha DIFFER FROM main?" (what the step asked until 2026-09-18)
------------------------------------------------------------------------------
`main` means APPROVED, not DEPLOYED. promote-gate fast-forwards main BEFORE the Lambda matrix runs, so
every way the matrix can fall short leaves main describing code that is not running:
  * a plain re-dispatch after a failed leg: main == dev_sha, all seven inputs compare equal, the step
    reported "SPA-only" and shipped the SPA onto the stale legs (reproduced by executing the old step
    body with DEV_SHA=main: `changed=false`);
  * a later SPA-only promote after a partial failure nobody re-ran;
  * a promote that died after its fast-forward (snap.py, the pg17 fetch), so deploy-lambdas never ran;
  * revert-to.py's rollback, which restores code with update_function_code and no workflow;
  * a hand-dispatched deploy-lambda.yml from another ref, or a console upload.
None of those is visible from git. They are all visible from the functions.

WHAT IT READS INSTEAD
---------------------
deploy-lambda.yml's last step on every leg writes a marker into the function's Description:

    garden-app lambda-deploy v1 src=<commit built> recipe=<commit whose deploy-lambda.yml ran>
                                code=<CodeSha256 of the zip that leg built> run=<run id>.<attempt>

and writes it only once the LIVE CodeSha256 equals the sha256 of that zip. This script proves CURRENT
only when, for EVERY release function (lambda_fleet.release_functions(), pinned equal to the matrix):
  1. the function exists, is not mid-update, and its Description is a well-formed marker;
  2. the marker's `code=` equals the function's live CodeSha256 — so nothing has replaced the code
     since the marker was written (a rollback or a console upload breaks this and forces a deploy);
  3. the marker's Lambda inputs equal dev_sha's: the same seven identities promote-gate always
     compared (tree of lambda/, blobs of the recipe/manifest/checker/event-type inputs, and the
     root package.json digest that ignores `version`). The recipe blob is read at `recipe=`, every
     other input at `src=`, because that is where each one came from when the zip was built.
Anything else — no marker, a mismatch, a function that does not exist yet, an unreadable function,
an input that cannot be resolved on either side — is NOT a proof, and the promote deploys all 26.
That is the pre-v4.137 behaviour, costs about six minutes, and is idempotent.

EXIT CODES
  0  CURRENT       — proven as above; the promote may skip deploy-lambdas.
  1  NOT CURRENT   — a positive finding that something is unmarked, replaced or different.
  2  UNKNOWN       — a read failed or input was malformed. Deploys, exactly like 1.
The caller must treat every non-zero status the same way (and a crash is non-zero).

USAGE
  GH_TOKEN=... python3 scripts/check-lambda-current.py --dev-sha <40-hex> [--repo o/r] [--region r]
  python3 scripts/check-lambda-current.py --dev-sha <sha> --live-json f.json   # configs from a file
Needs lambda:GetFunctionConfiguration on each release function (promote-gate uses the snap role,
which snap.py and preflight-revert-iam.py already require to hold it) and a token that can read
the repository contents. Never prints a function's Environment.
"""
import argparse
import base64
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lambda_fleet  # noqa: E402

DEFAULT_REPO = "islanddave/garden-app"
API = "https://api.github.com"
GH_TIMEOUT_S = 30
AWS_TIMEOUT_S = 45
# Whole-run budget. Each call is bounded by its own timeout, and no new call starts after this, so a
# hung network costs the promote at most ~5 minutes and then deploys — it can never fail the step.
DEADLINE_S = 240

CURRENT, NOT_CURRENT, UNKNOWN = 0, 1, 2

# The seven Lambda inputs — the exact list the old main-vs-dev step in promote-gate.yml iterated, moved
# here so there is one copy. If deploy-lambda.yml starts reading another file from outside lambda/, it
# belongs here too; adding an input is one line.
#   lambda                                the functions' source (a TREE sha: one exact identity per side)
#   .github/workflows/deploy-lambda.yml   the recipe: build, zip and every config-ensure step
#   scripts/lambda-config-expected.json   read BY the recipe (facebook-share timeout/memory) and asserted
#   scripts/check-lambda-config.py          after it — OPS-LAMCHANGEDBLIND-001
#   src/lib/eventTypes.js                 `npm run gen:event-types` generates lambda/events/
#   scripts/gen-lambda-event-types.mjs      eventTypes.generated.js from these before zipping
#   digest:package.json                   the recipe resolves gen:/check:event-types in its `scripts`.
#                                         Compared by CONTENT DIGEST minus `version`: the bump rides in
#                                         every feature commit (225 of the last 250 commits touching it
#                                         were version-only, measured 2026-09-17), so its blob would pin
#                                         every promote to "changed" while the skip still LOOKED enabled.
PATHS = (
    "lambda",
    ".github/workflows/deploy-lambda.yml",
    "scripts/lambda-config-expected.json",
    "scripts/check-lambda-config.py",
    "src/lib/eventTypes.js",
    "scripts/gen-lambda-event-types.mjs",
    "digest:package.json",
)
# The one input that is read from the commit the WORKFLOW came from rather than the commit it built.
# A promote dispatched from main runs the pre-fast-forward recipe against the promoted tree
# (deploy-lambda.yml's DISPATCH-REF TRAP), so the two can differ.
RECIPE_PATH = ".github/workflows/deploy-lambda.yml"

MARKER_RE = re.compile(
    r"garden-app lambda-deploy v1 src=([0-9a-f]{40}) recipe=([0-9a-f]{40}) "
    r"code=([A-Za-z0-9+/]{43}=) run=([0-9]+)\.([0-9]+)")


def parse_marker(desc):
    """{'src','recipe','code','run'} for a well-formed marker, else None. Whole-string match only:
    a marker with anything appended or prepended is not the marker deploy-lambda.yml writes."""
    m = MARKER_RE.fullmatch(desc or "")
    if not m:
        return None
    return {"src": m.group(1), "recipe": m.group(2), "code": m.group(3), "run": f"{m.group(4)}.{m.group(5)}"}


# ── GitHub side: the identity of one input at one ref ─────────────────────────────────────────────

def _gh_get(repo, path, token, params=None):
    """Parsed JSON for a GET, or None when the object is absent/unaddressable (404, 422). Anything
    else raises — a throttled or failed read must never look like a comparison result."""
    url = f"{API}/repos/{repo}/{path}"
    if params:
        url += "?" + "&".join(f"{k}={v}" for k, v in params.items())
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
        "User-Agent": "check-lambda-current"})
    try:
        return _urlopen_json(req)
    except urllib.error.HTTPError as e:
        if e.code in (404, 422):
            return None
        if e.code < 500:
            raise
    except urllib.error.URLError:
        pass
    return _urlopen_json(req)  # one retry for a 5xx or a transport blip; a second failure raises


def _urlopen_json(req):
    try:
        with urllib.request.urlopen(req, timeout=GH_TIMEOUT_S) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        if e.code in (404, 422):
            return None
        raise


def _digest(doc):
    """sha256 of a package.json-shaped object minus its top-level `version`, canonicalised. The
    version bump rides in every feature commit, so the blob of package.json moves on essentially
    every release; the digest moves only when something that can change a build does."""
    if not isinstance(doc, dict):
        return None
    body = {k: v for k, v in doc.items() if k != "version"}
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def gh_ident(repo, token, ref, path):
    """Blob sha of a file / tree sha of a directory / content digest (`digest:` prefix) at `ref`, or
    None when it cannot be resolved. Both sides of every comparison come through here."""
    if not ref or not path:
        return None  # `?ref=` with an empty value silently means the DEFAULT BRANCH to the contents API
    if path.startswith("digest:"):
        body = _gh_get(repo, f"contents/{path[len('digest:'):]}", token, {"ref": ref})
        if not isinstance(body, dict) or body.get("encoding") != "base64":
            return None
        try:
            return _digest(json.loads(base64.b64decode(body.get("content") or "")))
        except ValueError:
            return None
    body = _gh_get(repo, f"contents/{path}", token, {"ref": ref})
    if isinstance(body, dict) and body.get("sha"):
        return body["sha"]
    # A DIRECTORY answers the contents call with a JSON array that has no sha of its own
    # (OPS-LAMCHANGEDBLIND-002). The Trees API addresses <ref>:<path> directly.
    body = _gh_get(repo, f"git/trees/{ref}:{path}", token)
    if isinstance(body, dict) and body.get("sha"):
        return body["sha"]
    return None


# ── AWS side: what one function is running ───────────────────────────────────────────────────────

def fetch_config(name, region):
    """Live config of one function, None if it does not exist. Any other failure raises."""
    proc = subprocess.run(
        ["aws", "lambda", "get-function-configuration", "--function-name", name,
         "--region", region, "--output", "json"],
        capture_output=True, text=True, timeout=AWS_TIMEOUT_S)
    if proc.returncode != 0:
        if "ResourceNotFoundException" in proc.stderr:
            return None
        raise RuntimeError(f"live read failed for {name}: {proc.stderr.strip() or f'rc={proc.returncode}'}")
    return json.loads(proc.stdout)


# ── the decision ─────────────────────────────────────────────────────────────────────────────────

_NOT_READ = object()


def decide(dev_sha, functions, configs, ident):
    """(code, lines). `configs` maps every name in `functions` to its live config dict, or None for a
    function that does not exist. `ident(ref, path)` returns an identity string or None. Pure: all
    I/O is in the arguments, so every branch is testable against recorded responses."""
    lines, stale, unknown, groups = [], [], [], {}
    if not re.fullmatch(r"[0-9a-f]{40}", dev_sha or ""):
        return UNKNOWN, [f"dev_sha {dev_sha!r} is not a 40-hex commit sha"]
    if not functions:
        return UNKNOWN, ["no release functions to check (an empty set proves nothing)"]
    for fn in functions:
        cfg = configs.get(fn, _NOT_READ)
        if cfg is _NOT_READ:
            unknown.append(fn)
            lines.append(f"  {fn}: not read")
            continue
        if cfg is None:
            stale.append(fn)
            lines.append(f"  {fn}: DOES NOT EXIST yet (its first deploy creates it)")
            continue
        status = cfg.get("LastUpdateStatus")
        if status == "InProgress":
            unknown.append(fn)
            lines.append(f"  {fn}: an update is IN PROGRESS — cannot say what it runs")
            continue
        if status == "Failed":
            stale.append(fn)
            lines.append(f"  {fn}: last update FAILED")
            continue
        marker = parse_marker(cfg.get("Description"))
        if marker is None:
            stale.append(fn)
            lines.append(f"  {fn}: NO deploy marker (Description {str(cfg.get('Description') or '')[:60]!r})")
            continue
        if marker["code"] != cfg.get("CodeSha256"):
            stale.append(fn)
            lines.append(f"  {fn}: code REPLACED since the marker (marker code={marker['code']}, "
                         f"live CodeSha256={cfg.get('CodeSha256')}) — a rollback, a console upload, or a "
                         f"deploy that never stamped")
            continue
        groups.setdefault((marker["src"], marker["recipe"]), []).append(fn)
        lines.append(f"  {fn}: marker src={marker['src'][:10]} recipe={marker['recipe'][:10]} "
                     f"run={marker['run']}, code matches")

    moved = []
    for (src, recipe), fns in sorted(groups.items()):
        lines.append(f"running source {src} (recipe {recipe}) — {len(fns)} function(s):")
        if src == dev_sha and recipe == dev_sha:
            lines.append("  built from dev_sha itself, by dev_sha's own recipe — identical by construction")
            continue
        for path in PATHS:
            at = recipe if path == RECIPE_PATH else src
            if at == dev_sha:
                lines.append(f"  {path}: SAME (read at dev_sha itself)")
                continue
            running, wanted = ident(at, path), ident(dev_sha, path)
            if running is None or wanted is None:
                unknown.append(path)
                lines.append(f"  {path}: running={running or '<none>'} dev={wanted or '<none>'} UNRESOLVED")
            elif running != wanted:
                moved.append(path)
                lines.append(f"  {path}: running={running} dev={wanted} DIFFERENT")
            else:
                lines.append(f"  {path}: SAME")

    if stale or moved:
        why = []
        if stale:
            why.append(f"{len(stale)} function(s) not provably running a marked build: {', '.join(stale)}")
        if moved:
            why.append(f"Lambda inputs differ from dev_sha: {', '.join(sorted(set(moved)))}")
        lines.append("VERDICT: NOT CURRENT — deploy (" + "; ".join(why) + ")")
        return NOT_CURRENT, lines
    if unknown:
        lines.append("VERDICT: UNKNOWN — deploy (could not read: " + ", ".join(sorted(set(unknown))) + ")")
        return UNKNOWN, lines
    lines.append(f"VERDICT: CURRENT — all {len(functions)} release functions run code built from Lambda "
                 f"inputs identical to {dev_sha}")
    return CURRENT, lines


def _annotation(code, functions, configs):
    """One workflow annotation where a reader needs to notice something, else None."""
    if code == UNKNOWN:
        return "::warning::check-lambda-current could not decide — failing CLOSED, deploying Lambdas"
    if code == NOT_CURRENT:
        marked = [f for f in functions
                  if isinstance(configs.get(f), dict) and parse_marker(configs[f].get("Description"))]
        if not marked:
            return ("::notice::no release function carries a deploy marker yet — the first deploy by a "
                    "deploy-lambda.yml that writes them (OPS-LAMSKIPVSMAIN-001) arms the SPA-only skip")
        if len(marked) < len(functions):
            return (f"::warning::only {len(marked)} of {len(functions)} release functions carry a deploy "
                    f"marker — a leg failed or its marker step did; deploying all of them")
    return None


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dev-sha", required=True)
    ap.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY") or DEFAULT_REPO)
    ap.add_argument("--region", default=os.environ.get("AWS_REGION", "us-east-1"))
    ap.add_argument("--live-json", help="read live configs from a JSON object {function: config|null}")
    args = ap.parse_args(argv)

    print(f"check-lambda-current: are the running Lambdas built from {args.dev_sha}'s Lambda inputs?")
    try:
        functions = lambda_fleet.release_functions()
    except lambda_fleet.FleetError as e:
        print(f"::warning::{e}")
        print("VERDICT: UNKNOWN — deploy (release set unreadable)")
        return UNKNOWN

    started = time.monotonic()

    def budget():
        if time.monotonic() - started > DEADLINE_S:
            raise RuntimeError(f"over the {DEADLINE_S}s budget")

    configs = {}
    try:
        if args.live_json:
            with open(args.live_json) as fh:
                live = json.load(fh)
            configs = {fn: live[fn] for fn in functions if fn in live}
        else:
            for fn in functions:
                budget()
                configs[fn] = fetch_config(fn, args.region)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as e:
        print(f"::warning::live Lambda read failed: {e}")
        print("VERDICT: UNKNOWN — deploy (the running functions could not be read)")
        return UNKNOWN

    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    cache = {}

    def ident(ref, path):
        if (ref, path) not in cache:
            if not token:
                raise RuntimeError("no GH_TOKEN/GITHUB_TOKEN to read the repository")
            budget()
            cache[(ref, path)] = gh_ident(args.repo, token, ref, path)
        return cache[(ref, path)]

    try:
        code, lines = decide(args.dev_sha, functions, configs, ident)
    except (urllib.error.URLError, OSError, ValueError, RuntimeError) as e:
        print(f"::warning::repository read failed: {e}")
        print("VERDICT: UNKNOWN — deploy (Lambda inputs could not be compared)")
        return UNKNOWN
    for line in lines:
        print(line)
    note = _annotation(code, functions, configs)
    if note:
        print(note)
    return code


if __name__ == "__main__":
    sys.exit(main())
