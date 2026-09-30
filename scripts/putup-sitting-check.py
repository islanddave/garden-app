#!/usr/bin/env python3
"""putup-sitting-check.py — the Put-Up F sitting's executable checks (review-F-prepromote-early B2, B3, I5).

Release F (Put-Up 1b + the ferment path) ships one-way DDL. Three of its sitting steps were prose that nothing
ran; this script is their executable form. It reads GitHub (through `gh`), AWS Lambda (boto3) and the public
site (HTTPS). It never touches a database and never writes anything.

  --precondition   B3, BEFORE any 1b or F DDL reaches staging or prod. 1b's `remaining_count <= package_count`
                   and UNIQUE(user_id, kind, lower(label)) were proven only against the 1a writer, so 1a must be
                   the live writer first:
                     main-contains      origin/main contains dev 421a1f94 (1a) — GitHub compare, not a clone
                     lambda-fresh:<fn>  garden-preservation and garden-storage-location were deployed AFTER the
                                        promote (--promoted-after, an ISO time with a zone)
                     1a-count-rule      the deployed garden-preservation zip's jarRules.js carries 1a's count
                                        rule (count_below_used)
  --f-deployed     I5, AFTER F's promote. The promote run's conclusion is not proof that F is what serves:
                     bundle:<release>   the live entry chunk (index-*.js, falling back to the chunks it names)
                                        carries each release's UI marker
                     lambda:<fn>        the deployed zips carry F's code: pantryUses.js, lineRoutes.js and
                                        shuEstimate.js in garden-preservation; kitchen_batch_input in garden-plants
                                        merge.js; the label trim in garden-storage-location index.js
                     sw-cache-version   sw.js CACHE_VERSION is not the pre-promote one (--prev-cache-version)
                   `--f-deployed --only lambdas` is the executable form of 1b's manual gate
                   mid_backfill_b_lambda_is_live: run it before ANY 0p backfill (0p under the 1a Lambda turns a
                   date clear into a 23514).
  --floor          B2 (review-F-prepromote-final), before the dev push: no revert can put 1a code back over F data.
                   The landing adds {floor: v<F>, since: v<F>, undo_instead: null} (a floor may not sit above its
                   own since, so the planned {floor: v<F>, since: v<1b>} is refused by revert_floors.py itself):
                     file               scripts/revert-floors.json loads through revert_floors.load (an
                                        unparseable or invalid file is a FAIL, never "no floor")
                     governing          revert_floors.governing_entry(entries, v<F>) exists, its floor IS v<F>
                                        and its undo_instead is null
                     pre-f-refused      revert-to.py's own require_target_above_floor, asked "prod runs v<F>,
                                        revert to v<pre-F>?", refuses (default v4.162.0, the pre-F prod version)
                     f-allowed          the same function allows v<F> itself (so the refusal is the floor's)
                   revert-to.py is imported (it needs boto3 and requests installed) but reads nothing: the prod
                   version it would fetch from GitHub is supplied as v<F>, the state the floor exists for.
                   Add the floor entry at mint time; before that this mode FAILs by design.
  --self-test      every check above against in-memory fixtures (passing and failing ones); no network.

Every check prints one line, `PASS [<mode>:<check>] …` or `FAIL [<mode>:<check>] …`. A check that cannot be
performed (gh or boto3 missing, a network error, an unreadable zip) is a FAIL, never a skip. Exit 0 only when
every check passed; 1 when any failed; 2 when the arguments are wrong.

Usage:
  python3 scripts/putup-sitting-check.py --precondition --promoted-after 2026-09-30T02:15:00Z
  python3 scripts/putup-sitting-check.py --f-deployed --prev-cache-version v4.161.0-421a1f9
  python3 scripts/putup-sitting-check.py --f-deployed --only lambdas          # mid_backfill_b_lambda_is_live
  python3 scripts/putup-sitting-check.py --floor --f-version v4.164.0 [--pre-f-version v4.162.0]
  python3 scripts/putup-sitting-check.py --self-test

Auth: `gh` uses its own login (no token is read here); boto3 uses the ambient AWS credentials and --region.
"""
import argparse
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from datetime import datetime
from html.parser import HTMLParser
from urllib.parse import urljoin

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import revert_floors  # noqa: E402 — the one loader of scripts/revert-floors.json (its header: never a local copy)

DEFAULT_REPO = "islanddave/garden-app"
DEFAULT_SITE = "https://garden.futureishere.net"
DEFAULT_REGION = "us-east-1"
ONE_A_DEV_SHA = "421a1f943f61fd762f7ac1087f65cb602458e45b"
FN_PRESERVATION = "garden-preservation"
FN_STORAGE = "garden-storage-location"
FN_PLANTS = "garden-plants"

# 1a's count rule (release 1a's legacy PUT refusal) — absent from the pre-1a main (22e7db7c), present on dev 421a1f94.
ONE_A_COUNT_RULE = ("jarRules.js", "count_below_used")
# The UI markers per release: string literals in the train's src, absent from dev's (non-test) src, and — in a
# real `vite build` of a4491acc — every one of them in the entry chunk (PutUp is imported statically, App.jsx).
BUNDLE_MARKERS = (
    ("1b", "Undo that put-up"),
    ("F", "Following a recipe?"),
    ("F", "Topped up brine"),
    ("F", "/api/pantry/uses"),
    ("F", "Salted then rinsed"),
)
# What F's deployed Lambda zips must carry. The zips are the raw lambda/<fn> directories (deploy-lambda.yml:
# `zip -r ../<fn>.zip .`), so these are exact source substrings. Each is absent from dev 421a1f94.
F_LAMBDA_FILES = ("pantryUses.js", "lineRoutes.js", "shuEstimate.js")
F_PLANTS_MARKER = ("merge.js", "kitchen_batch_input")
F_STORAGE_MARKER = ("index.js", "String(body.label).trim()")
CACHE_VERSION_RE = re.compile(r"""const\s+CACHE_VERSION\s*=\s*['"]([^'"]*)['"]""")
RELEASE_RE = re.compile(r"^v\d+\.\d+\.\d+$")
MAX_EXTRA_CHUNKS = 60
HTTP_TIMEOUT = 30


class CheckError(Exception):
    """A source could not be read. The check that asked becomes a FAIL."""


class Result:
    __slots__ = ("mode", "check", "ok", "detail")

    def __init__(self, mode, check, ok, detail):
        self.mode, self.check, self.ok, self.detail = mode, check, bool(ok), detail

    @property
    def key(self):
        return f"{self.mode}:{self.check}"

    def line(self):
        return f"{'PASS' if self.ok else 'FAIL'} [{self.key}] {self.detail}"


# ── sources ─────────────────────────────────────────────────────────────────────────────────────────────
class LiveSources:
    """GitHub through `gh`, Lambda through boto3, the site and Code.Location through urllib."""

    def __init__(self, region=DEFAULT_REGION):
        self.region = region
        self._lambda = None

    def _client(self):
        if self._lambda is None:
            try:
                import boto3  # noqa: PLC0415 — only --precondition / --f-deployed need it
            except ImportError as e:
                raise CheckError(f"boto3 is not installed ({e}); pip install boto3")
            self._lambda = boto3.client("lambda", region_name=self.region)
        return self._lambda

    def compare_status(self, repo, base, head):
        cmd = ["gh", "api", f"repos/{repo}/compare/{base}...{head}", "--jq", ".status"]
        try:
            p = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
        except FileNotFoundError:
            raise CheckError("gh is not installed")
        except subprocess.TimeoutExpired:
            raise CheckError("gh api compare timed out")
        if p.returncode != 0:
            raise CheckError(f"gh api compare failed (exit {p.returncode}): {p.stderr.strip()[:300]}")
        return p.stdout.strip()

    def lambda_config(self, fn):
        try:
            c = self._client().get_function_configuration(FunctionName=fn)
        except CheckError:
            raise
        except Exception as e:  # botocore raises many classes; each is "could not read"
            raise CheckError(f"get_function_configuration({fn}) failed: {e}")
        return {"LastModified": c.get("LastModified"), "CodeSha256": c.get("CodeSha256")}

    def lambda_zip(self, fn):
        try:
            meta = self._client().get_function(FunctionName=fn)
            url = meta["Code"]["Location"]
        except CheckError:
            raise
        except Exception as e:
            raise CheckError(f"get_function({fn}) failed: {e}")
        return self.http_bytes(url)

    def http_bytes(self, url):
        req = urllib.request.Request(url, headers={"User-Agent": "putup-sitting-check/1", "Cache-Control": "no-cache"})
        try:
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
                return r.read()
        except (urllib.error.URLError, OSError, ValueError) as e:
            raise CheckError(f"GET {url.split('?')[0]} failed: {e}")

    def http_text(self, url):
        return self.http_bytes(url).decode("utf-8", errors="replace")


# ── helpers ─────────────────────────────────────────────────────────────────────────────────────────────
def parse_time(value, what):
    """An ISO-8601 instant WITH a zone ('Z', '+00:00' or AWS's '+0000'). A naive time is refused: 'after the
    promote' compared in the wrong zone is a precondition that passes by hours of accident."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{what}: no time given")
    s = value.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    s = re.sub(r"([+-]\d{2})(\d{2})$", r"\1:\2", s)
    try:
        t = datetime.fromisoformat(s)
    except ValueError:
        raise ValueError(f"{what}: {value!r} is not an ISO-8601 time")
    if t.tzinfo is None:
        raise ValueError(f"{what}: {value!r} has no zone — give Z or an offset")
    return t


def zip_members(blob):
    """{root-relative name: bytes} of a Lambda zip. Raises CheckError on anything that is not a zip."""
    try:
        with zipfile.ZipFile(io.BytesIO(blob)) as z:
            return {n[2:] if n.startswith("./") else n: z.read(n) for n in z.namelist() if not n.endswith("/")}
    except (zipfile.BadZipFile, ValueError, OSError) as e:
        raise CheckError(f"not a readable zip: {e}")


class _Scripts(HTMLParser):
    def __init__(self):
        super().__init__()
        self.entries, self.preloads = [], []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "script" and a.get("type") == "module" and a.get("src"):
            self.entries.append(a["src"])
        if tag == "link" and a.get("rel") == "modulepreload" and a.get("href"):
            self.preloads.append(a["href"])


def chunk_refs(text):
    """The .js chunk paths an entry chunk names (Vite writes ./Name-hash.js or /assets/Name-hash.js)."""
    return re.findall(r"""["'`]((?:\.{0,2}/)?(?:assets/)?[\w.\-]+\.js)["'`]""", text)


# ── checks ──────────────────────────────────────────────────────────────────────────────────────────────
def check_precondition(src, *, promoted_after, repo=DEFAULT_REPO, main_ref="main", main_contains=ONE_A_DEV_SHA,
                       preservation_fn=FN_PRESERVATION, storage_fn=FN_STORAGE):
    mode = "precondition"
    out = []
    try:
        status = src.compare_status(repo, main_contains, main_ref)
        ok = status in ("ahead", "identical")
        out.append(Result(mode, "main-contains", ok,
                          f"{repo} {main_ref} {'contains' if ok else 'does NOT contain'} {main_contains[:12]} "
                          f"(compare {main_contains[:12]}...{main_ref}: {status or 'no status'})"))
    except CheckError as e:
        out.append(Result(mode, "main-contains", False, str(e)))
    cutoff = parse_time(promoted_after, "--promoted-after")
    for fn in (preservation_fn, storage_fn):
        try:
            c = src.lambda_config(fn)
            lm = parse_time(c.get("LastModified"), f"{fn} LastModified")
            ok = lm > cutoff
            out.append(Result(mode, f"lambda-fresh:{fn}", ok,
                              f"LastModified {c.get('LastModified')} is {'after' if ok else 'NOT after'} the promote "
                              f"({promoted_after}); CodeSha256 {c.get('CodeSha256')}"))
        except (CheckError, ValueError) as e:
            out.append(Result(mode, f"lambda-fresh:{fn}", False, str(e)))
    name, marker = ONE_A_COUNT_RULE
    try:
        files = zip_members(src.lambda_zip(preservation_fn))
        body = files.get(name)
        if body is None:
            out.append(Result(mode, "1a-count-rule", False, f"{preservation_fn}'s zip has no {name}"))
        else:
            ok = marker.encode() in body
            out.append(Result(mode, "1a-count-rule", ok,
                              f"{preservation_fn} {name} {'carries' if ok else 'does NOT carry'} {marker!r}"))
    except CheckError as e:
        out.append(Result(mode, "1a-count-rule", False, f"{preservation_fn}: {e}"))
    return out


def _releases():
    rels = []
    for rel, _ in BUNDLE_MARKERS:
        if rel not in rels:
            rels.append(rel)
    return rels


def check_bundle(src, site):
    """One result per release: PASS only when every marker of that release is in the live bundle."""
    mode = "f-deployed"
    base = site.rstrip("/") + "/"
    fail_all = lambda why: [Result(mode, f"bundle:{rel}", False, why) for rel in _releases()]  # noqa: E731
    try:
        html = src.http_text(f"{base}?sitting-check={int(time.time())}")
    except CheckError as e:
        return fail_all(f"cannot read the site: {e}")
    p = _Scripts()
    p.feed(html)
    entries = [e for e in p.entries if re.search(r"/index-[\w-]+\.js$", e)] or p.entries
    if not entries:
        return fail_all(f"{base} names no module entry script")
    entry_url = urljoin(base, entries[0])
    try:
        texts = {entry_url: src.http_text(entry_url)}
    except CheckError as e:
        return fail_all(str(e))
    # A marker is looked for in the entry first; only a miss widens the search to the chunks the page preloads
    # and the entry names, so a future code split cannot turn a shipped marker into a false FAIL.
    queue = [urljoin(base, u) for u in p.preloads] + [urljoin(entry_url, u) for u in chunk_refs(texts[entry_url])]
    found = {}
    for _, marker in BUNDLE_MARKERS:
        where = next((u for u, t in texts.items() if marker in t), None)
        while where is None and queue and len(texts) <= MAX_EXTRA_CHUNKS:
            u = queue.pop(0)
            if u in texts:
                continue
            try:
                texts[u] = src.http_text(u)
            except CheckError:
                texts[u] = ""
                continue
            queue.extend(urljoin(u, r) for r in chunk_refs(texts[u]))
            if marker in texts[u]:
                where = u
        found[marker] = where.split("/")[-1] if where else None
    out = []
    for rel in _releases():
        marks = [m for r, m in BUNDLE_MARKERS if r == rel]
        missing = [m for m in marks if found[m] is None]
        shown = "; ".join(f"{m!r} in {found[m]}" if found[m] else f"{m!r} MISSING" for m in marks)
        tail = f" (searched {len(texts)} chunk(s) from entry {entry_url.split('/')[-1]})" if missing else ""
        out.append(Result(mode, f"bundle:{rel}", not missing, shown + tail))
    return out


def check_lambdas(src, *, preservation_fn=FN_PRESERVATION, plants_fn=FN_PLANTS, storage_fn=FN_STORAGE):
    mode = "f-deployed"
    out = []

    def members(fn):
        try:
            c = src.lambda_config(fn)
            sha = f"CodeSha256 {c.get('CodeSha256')}, LastModified {c.get('LastModified')}"
        except CheckError as e:
            sha = f"(config unread: {e})"
        return zip_members(src.lambda_zip(fn)), sha

    try:
        files, sha = members(preservation_fn)
        missing = [f for f in F_LAMBDA_FILES if f not in files]
        out.append(Result(mode, f"lambda:{preservation_fn}", not missing,
                          f"{'has' if not missing else 'MISSING'} {', '.join(missing or F_LAMBDA_FILES)}; {sha}"))
    except CheckError as e:
        out.append(Result(mode, f"lambda:{preservation_fn}", False, str(e)))
    for fn, (name, marker) in ((plants_fn, F_PLANTS_MARKER), (storage_fn, F_STORAGE_MARKER)):
        try:
            files, sha = members(fn)
            body = files.get(name)
            ok = body is not None and marker.encode() in body
            why = f"{name} {'carries' if ok else 'does NOT carry'} {marker!r}" if body is not None else f"no {name}"
            out.append(Result(mode, f"lambda:{fn}", ok, f"{why}; {sha}"))
        except CheckError as e:
            out.append(Result(mode, f"lambda:{fn}", False, str(e)))
    return out


def check_sw(src, site, prev):
    mode = "f-deployed"
    url = site.rstrip("/") + f"/sw.js?sitting-check={int(time.time())}"
    try:
        m = CACHE_VERSION_RE.search(src.http_text(url))
    except CheckError as e:
        return [Result(mode, "sw-cache-version", False, str(e))]
    if not m:
        return [Result(mode, "sw-cache-version", False, "sw.js carries no CACHE_VERSION")]
    now = m.group(1)
    ok = now != prev
    return [Result(mode, "sw-cache-version", ok,
                   f"CACHE_VERSION {now!r} {'differs from' if ok else 'is STILL'} the pre-promote {prev!r}")]


def check_f_deployed(src, *, site=DEFAULT_SITE, prev_cache_version=None, only=("bundle", "lambdas", "sw"), **fns):
    out = []
    if "bundle" in only:
        out += check_bundle(src, site)
    if "lambdas" in only:
        out += check_lambdas(src, **fns)
    if "sw" in only:
        out += check_sw(src, site, prev_cache_version)
    return out


PRE_F_VERSION = "v4.162.0"
_REVERT_TO = None


def _revert_to_module():
    """scripts/revert-to.py, loaded once under a private name. The refusal below is ITS function, never a copy:
    a copy would keep passing after revert-to's rule changed. It imports boto3 and requests at module level."""
    global _REVERT_TO
    if _REVERT_TO is None:
        import importlib.util  # noqa: PLC0415
        spec = importlib.util.spec_from_file_location("_putup_sitting_revert_to", os.path.join(HERE, "revert-to.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _REVERT_TO = mod
    return _REVERT_TO


def revert_to_verdict(target, prod, floors_path):
    """Ask revert-to.py's require_target_above_floor whether prod running `prod` may be reverted to `target`,
    judged on `floors_path`. Returns (refused, words). Only the prod version is supplied from here: the function
    reads it from GitHub (current_prod_version), and the question is the hypothetical "once prod runs F"."""
    import contextlib  # noqa: PLC0415
    import types  # noqa: PLC0415
    mod = _revert_to_module()
    real = mod.current_prod_version
    mod.current_prod_version = lambda cfg: prod
    said = io.StringIO()
    try:
        with contextlib.redirect_stdout(said):
            mod.require_target_above_floor(types.SimpleNamespace(rehearsal=False, target_version=target), floors_path)
        return False, said.getvalue().strip()
    except mod.RevertError as e:
        return True, str(e)
    finally:
        mod.current_prod_version = real


def check_floor(*, f_version, pre_f_version=PRE_F_VERSION, floors_file=None, verdict=None):
    mode = "floor"
    path = floors_file or revert_floors.FLOORS
    verdict = verdict or revert_to_verdict
    keys = ("file", "governing", "pre-f-refused", "f-allowed")
    try:
        entries = revert_floors.load(path)
    except revert_floors.FloorError as e:
        return [Result(mode, "file", False, f"{path}: {e}")] + \
               [Result(mode, k, False, "not judged: the floors file does not load") for k in keys[1:]]
    out = [Result(mode, "file", True, f"{os.path.basename(path)}: {len(entries)} valid entr{'y' if len(entries) == 1 else 'ies'}")]
    gov = revert_floors.governing_entry(entries, f_version)
    if gov is None:
        out.append(Result(mode, "governing", False, f"no entry is in force while prod runs {f_version}"))
    else:
        shown = f"{{floor: {gov['floor']}, since: {gov['since']}, ledger: {gov['ledger']}, undo_instead: {json.dumps(gov['undo_instead'])}}}"
        wrong = []
        if revert_floors.version_key(gov["floor"]) != revert_floors.version_key(f_version):
            wrong.append(f"its floor is {gov['floor']}, not {f_version}")
        if gov["undo_instead"] is not None:
            wrong.append("it names an undo_instead switch; F has none, so it must be null")
        out.append(Result(mode, "governing", not wrong,
                          f"governing entry at {f_version}: {shown}" + (f" — {'; '.join(wrong)}" if wrong else "")))
    for key, target, want_refused in (("pre-f-refused", pre_f_version, True), ("f-allowed", f_version, False)):
        try:
            refused, words = verdict(target, f_version, path)
            ok = refused == want_refused and (not refused or "is below the revert floor" in words)
            out.append(Result(mode, key, ok, f"revert-to.py, prod {f_version} → target {target}: "
                                             f"{'REFUSED' if refused else 'allowed'} ({words[:220]})"))
        except Exception as e:  # revert-to.py not importable (boto3/requests), or its signature moved
            out.append(Result(mode, key, False, f"could not ask revert-to.py: {type(e).__name__}: {e}"))
    return out


# ── self-test ───────────────────────────────────────────────────────────────────────────────────────────
def _zip(files):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, text in files.items():
            z.writestr(name, text)
    return buf.getvalue()


class FixtureSources:
    """compare: status or CheckError; configs/zips/pages: {name: value or CheckError}."""

    def __init__(self, compare="ahead", configs=None, zips=None, pages=None):
        self.compare, self.configs, self.zips, self.pages = compare, configs or {}, zips or {}, pages or {}

    @staticmethod
    def _get(d, k, what):
        v = d.get(k)
        if v is None:
            raise CheckError(f"{what} {k}: not found")
        if isinstance(v, Exception):
            raise v
        return v

    def compare_status(self, repo, base, head):
        if isinstance(self.compare, Exception):
            raise self.compare
        return self.compare

    def lambda_config(self, fn):
        return self._get(self.configs, fn, "function")

    def lambda_zip(self, fn):
        return self._get(self.zips, fn, "function")

    def http_text(self, url):
        return self._get(self.pages, url.split("?")[0], "url")


def _fixtures():
    site = "https://example.test"
    good_zips = {
        FN_PRESERVATION: _zip({"index.js": "//", "jarRules.js": "code('count_below_used')", "pantryUses.js": "",
                               "lineRoutes.js": "", "shuEstimate.js": ""}),
        FN_PLANTS: _zip({"index.js": "", "merge.js": "{ table: 'kitchen_batch_input', column: 'plant_id' }"}),
        FN_STORAGE: _zip({"index.js": "const label = body.label == null ? null : String(body.label).trim();"}),
    }
    configs = {fn: {"LastModified": "2026-09-30T03:00:00.000+0000", "CodeSha256": f"sha-{fn}"} for fn in good_zips}
    entry = "/assets/index-AbC123.js"
    html = f'<html><head><script type="module" crossorigin src="{entry}"></script>' \
           f'<link rel="modulepreload" crossorigin href="/assets/Button-x1.js"></head></html>'
    all_markers = " ".join(m for _, m in BUNDLE_MARKERS)
    pages = {
        f"{site}/": html,
        f"{site}{entry}": f'import("./Lazy-z9.js");{all_markers}',
        f"{site}/assets/Button-x1.js": "",
        f"{site}/assets/Lazy-z9.js": "",
        f"{site}/sw.js": "const CACHE_VERSION = 'v4.163.0-abc1234' // rewritten per deploy",
    }
    return site, good_zips, configs, pages


def _scenarios():
    """(name, thunk, {check key: expected ok}) — every check has a passing AND a failing case."""
    site, zips, configs, pages = _fixtures()
    pre = dict(promoted_after="2026-09-30T02:00:00Z")
    S = FixtureSources
    with_zip = lambda fn, files: {**zips, fn: _zip(files)}  # noqa: E731
    with_page = lambda url, text: {**pages, f"{site}{url}": text}  # noqa: E731
    lazy_split = {**pages,
                  f"{site}/assets/index-AbC123.js": 'import("./Lazy-z9.js");Undo that put-up',
                  f"{site}/assets/Lazy-z9.js": " ".join(m for r, m in BUNDLE_MARKERS if r == "F")}
    no_topped = {**pages, f"{site}/assets/index-AbC123.js": " ".join(m for _, m in BUNDLE_MARKERS if m != "Topped up brine")}
    pre_keys = ["precondition:main-contains", f"precondition:lambda-fresh:{FN_PRESERVATION}",
                f"precondition:lambda-fresh:{FN_STORAGE}", "precondition:1a-count-rule"]
    all_ok = lambda keys, **flip: {k: flip.get(k, True) for k in keys}  # noqa: E731
    f_keys = [f"f-deployed:bundle:{r}" for r in ("1b", "F")] + \
             [f"f-deployed:lambda:{fn}" for fn in (FN_PRESERVATION, FN_PLANTS, FN_STORAGE)] + ["f-deployed:sw-cache-version"]
    fdep = lambda src, prev="v4.161.0-421a1f9", only=("bundle", "lambdas", "sw"): (  # noqa: E731
        lambda: check_f_deployed(src, site=site, prev_cache_version=prev, only=only))
    stale = {**configs, FN_STORAGE: {"LastModified": "2026-09-28T20:47:17.000+0000", "CodeSha256": "old"}}
    return [
        ("precondition: all three hold", lambda: check_precondition(S("ahead", configs, zips), **pre), all_ok(pre_keys)),
        ("precondition: main identical to 1a's dev sha", lambda: check_precondition(S("identical", configs, zips), **pre),
         all_ok(pre_keys)),
        ("precondition: main behind (pre-1a)", lambda: check_precondition(S("behind", configs, zips), **pre),
         all_ok(pre_keys, **{"precondition:main-contains": False})),
        ("precondition: main diverged", lambda: check_precondition(S("diverged", configs, zips), **pre),
         all_ok(pre_keys, **{"precondition:main-contains": False})),
        ("precondition: gh unreadable", lambda: check_precondition(S(CheckError("gh missing"), configs, zips), **pre),
         all_ok(pre_keys, **{"precondition:main-contains": False})),
        ("precondition: storage-location not redeployed", lambda: check_precondition(S("ahead", stale, zips), **pre),
         all_ok(pre_keys, **{f"precondition:lambda-fresh:{FN_STORAGE}": False})),
        ("precondition: LastModified exactly at the promote is not after it",
         lambda: check_precondition(S("ahead", configs, zips), promoted_after="2026-09-30T03:00:00+00:00"),
         all_ok(pre_keys, **{f"precondition:lambda-fresh:{FN_PRESERVATION}": False,
                             f"precondition:lambda-fresh:{FN_STORAGE}": False})),
        ("precondition: the promote time in another zone", lambda: check_precondition(
            S("ahead", configs, zips), promoted_after="2026-09-29T22:30:00-04:00"), all_ok(pre_keys)),
        ("precondition: preservation still the pre-1a zip",
         lambda: check_precondition(S("ahead", configs, with_zip(FN_PRESERVATION, {"jarRules.js": "old rules"})), **pre),
         all_ok(pre_keys, **{"precondition:1a-count-rule": False})),
        ("precondition: zip without jarRules.js",
         lambda: check_precondition(S("ahead", configs, with_zip(FN_PRESERVATION, {"index.js": ""})), **pre),
         all_ok(pre_keys, **{"precondition:1a-count-rule": False})),
        ("precondition: zip download failed",
         lambda: check_precondition(S("ahead", configs, {**zips, FN_PRESERVATION: CheckError("403")}), **pre),
         all_ok(pre_keys, **{"precondition:1a-count-rule": False})),
        ("precondition: not a zip",
         lambda: check_precondition(S("ahead", configs, {**zips, FN_PRESERVATION: b"<Error/>"}), **pre),
         all_ok(pre_keys, **{"precondition:1a-count-rule": False})),
        ("f-deployed: F is what serves", fdep(S(configs=configs, zips=zips, pages=pages)), all_ok(f_keys)),
        ("f-deployed: F's markers in a lazy chunk the entry names",
         fdep(S(configs=configs, zips=zips, pages=lazy_split)), all_ok(f_keys)),
        ("f-deployed: one F marker missing", fdep(S(configs=configs, zips=zips, pages=no_topped)),
         all_ok(f_keys, **{"f-deployed:bundle:F": False})),
        ("f-deployed: the site still serves the 1a bundle",
         fdep(S(configs=configs, zips=zips, pages=with_page("/assets/index-AbC123.js", "count_below_used"))),
         all_ok(f_keys, **{"f-deployed:bundle:1b": False, "f-deployed:bundle:F": False})),
        ("f-deployed: no module entry in the page", fdep(S(configs=configs, zips=zips, pages=with_page("/", "<html></html>"))),
         all_ok(f_keys, **{"f-deployed:bundle:1b": False, "f-deployed:bundle:F": False})),
        ("f-deployed: preservation without shuEstimate.js",
         fdep(S(configs=configs, zips=with_zip(FN_PRESERVATION, {"pantryUses.js": "", "lineRoutes.js": ""}), pages=pages)),
         all_ok(f_keys, **{f"f-deployed:lambda:{FN_PRESERVATION}": False})),
        ("f-deployed: plants merge.js without kitchen_batch_input",
         fdep(S(configs=configs, zips=with_zip(FN_PLANTS, {"merge.js": "preservation_log"}), pages=pages)),
         all_ok(f_keys, **{f"f-deployed:lambda:{FN_PLANTS}": False})),
        ("f-deployed: storage-location without the trim",
         fdep(S(configs=configs, zips=with_zip(FN_STORAGE, {"index.js": "body.label.trim()"}), pages=pages)),
         all_ok(f_keys, **{f"f-deployed:lambda:{FN_STORAGE}": False})),
        ("f-deployed: sw.js CACHE_VERSION unchanged", fdep(S(configs=configs, zips=zips, pages=pages), prev="v4.163.0-abc1234"),
         all_ok(f_keys, **{"f-deployed:sw-cache-version": False})),
        ("f-deployed: sw.js without CACHE_VERSION",
         fdep(S(configs=configs, zips=zips, pages=with_page("/sw.js", "self.addEventListener('fetch', f)"))),
         all_ok(f_keys, **{"f-deployed:sw-cache-version": False})),
        ("f-deployed --only lambdas (mid_backfill_b_lambda_is_live)",
         fdep(S(configs=configs, zips=zips, pages={}), only=("lambdas",)),
         {k: True for k in f_keys if ":lambda:" in k}),
        ("f-deployed --only lambdas, preservation unreadable",
         fdep(S(configs=configs, zips={**zips, FN_PRESERVATION: CheckError("AccessDenied")}, pages={}), only=("lambdas",)),
         {k: (FN_PRESERVATION not in k) for k in f_keys if ":lambda:" in k}),
    ]


def _floor_scenarios(tmp):
    """The refusal questions go to revert-to.py's real require_target_above_floor (only the prod version is fed)."""
    F, PRE = "v4.164.0", PRE_F_VERSION
    base = [  # the tip's three floors, same shape
        {"floor": "v4.160.0", "since": "v4.160.0", "reason": "tokens", "ledger": "V5-LOSSTOKEN-001", "undo_instead": None},
        {"floor": "v4.156.0", "since": "v4.156.0", "reason": "scroll", "ledger": "BUG-DETAILPAGESCARRYSCROLL-001",
         "undo_instead": {"flag": "SCROLL_MANAGER_ENABLED", "file": "src/lib/featureFlags.js"}},
        {"floor": "v4.135.0", "since": "v4.135.0", "reason": "schedule", "ledger": "OPS-PLANHOURLY-001", "undo_instead": None},
    ]
    f_entry = {"floor": F, "since": F, "reason": "1a code over F data", "ledger": "V5-PUTUPMAKETRUE-001", "undo_instead": None}
    one_b = {**f_entry, "floor": "v4.163.0", "since": "v4.163.0"}

    def write(name, obj):
        path = os.path.join(tmp, name)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(obj if isinstance(obj, str) else json.dumps({"floors": obj}))
        return path

    ALL = ("floor:file", "floor:governing", "floor:pre-f-refused", "floor:f-allowed")
    want = lambda *fails: {k: k not in fails for k in ALL}  # noqa: E731
    run = lambda path, **kw: (lambda: check_floor(f_version=F, floors_file=path, **kw))  # noqa: E731
    return [
        ("floor: the F entry governs at v<F>; v4.162.0 refused, v<F> allowed", run(write("f.json", base + [f_entry])), want()),
        ("floor: the F entry plus the optional 1b entry", run(write("f1b.json", base + [one_b, f_entry])), want()),
        ("floor: no F entry yet (the tip before landing)", run(write("tip.json", base)),
         want("floor:governing", "floor:pre-f-refused")),
        ("floor: MUTANT the entry's floor is v4.162.0 (valid, useless)",
         run(write("useless.json", base + [{**f_entry, "floor": PRE}])), want("floor:governing", "floor:pre-f-refused")),
        ("floor: only the 1b entry (it refuses v4.162.0 but is not the F floor)", run(write("only1b.json", base + [one_b])),
         want("floor:governing")),
        ("floor: the F entry names an undo_instead switch",
         run(write("undo.json", base + [{**f_entry, "undo_instead": {"flag": "PUTUP_F", "file": "src/lib/featureFlags.js"}}])),
         want("floor:governing")),
        ("floor: an F entry not yet in force at v<F> (since above it)",
         run(write("later.json", base + [{**f_entry, "since": "v4.165.0"}])), want("floor:governing", "floor:pre-f-refused")),
        ("floor: the planned {floor: v<F>, since: v<1b>} — revert_floors refuses the whole file",
         run(write("planned.json", base + [{**f_entry, "since": "v4.163.0"}])), want(*ALL)),
        ("floor: MUTANT an unparseable file", run(write("broken.json", "{not json")), want(*ALL)),
        ("floor: a missing file", run(os.path.join(tmp, "nope.json")), want(*ALL)),
        ("floor: v<pre-F> is judged, not assumed (a pre-F target AT the floor is allowed)",
         run(write("f2.json", base + [f_entry]), pre_f_version=F), want("floor:pre-f-refused")),
    ]


def _time_scenarios():
    def refused(value):
        try:
            parse_time(value, "--promoted-after")
        except ValueError as e:
            return [Result("args", "time", True, f"refused: {e}")]
        return [Result("args", "time", False, f"{value!r} accepted")]

    def parsed(value, iso):
        try:
            return [Result("args", "time", parse_time(value, "t").isoformat() == iso, value)]
        except ValueError as e:
            return [Result("args", "time", False, str(e))]

    return [
        ("args: a --promoted-after with no zone is refused", lambda: refused("2026-09-30T02:00:00"), {"args:time": True}),
        ("args: not a time is refused", lambda: refused("tonight"), {"args:time": True}),
        ("args: AWS's +0000 form reads as UTC", lambda: parsed("2026-09-28T20:47:17.000+0000",
                                                             "2026-09-28T20:47:17+00:00"), {"args:time": True}),
    ]


def self_test(out=None):
    out = out or sys.stdout  # read at call time, so a captured stdout (pytest's capsys) sees the lines
    failures = 0
    with tempfile.TemporaryDirectory() as tmp:
        for name, thunk, expected in _scenarios() + _floor_scenarios(tmp) + _time_scenarios():
            try:
                got = {r.key: r.ok for r in thunk()}
            except Exception as e:  # a crash is a self-test failure, never a pass
                got = {"crash": f"{type(e).__name__}: {e}"}
            if got == expected:
                print(f"SELFTEST ok   {name}", file=out)
            else:
                failures += 1
                print(f"SELFTEST FAIL {name}: expected {expected}, got {got}", file=out)
    print(f"SELFTEST {'FAIL' if failures else 'ok'}: {failures} scenario(s) wrong", file=out)
    return 1 if failures else 0


# ── cli ─────────────────────────────────────────────────────────────────────────────────────────────────
def build_parser():
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    m = p.add_mutually_exclusive_group(required=True)
    m.add_argument("--precondition", action="store_true", help="B3: 1a is the live writer (before any 1b/F DDL)")
    m.add_argument("--f-deployed", action="store_true", help="I5: F is what serves (after the promote)")
    m.add_argument("--floor", action="store_true", help="B2: the v<F> revert floor governs and refuses v<pre-F> (before the dev push)")
    m.add_argument("--self-test", action="store_true", help="every check against fixtures; no network")
    p.add_argument("--promoted-after", help="--precondition: the promote-gate deploy time (ISO-8601 with a zone)")
    p.add_argument("--main-contains", default=ONE_A_DEV_SHA, help="--precondition: the sha main must contain")
    p.add_argument("--main-ref", default="main")
    p.add_argument("--repo", default=DEFAULT_REPO)
    p.add_argument("--region", default=DEFAULT_REGION)
    p.add_argument("--preservation-fn", default=FN_PRESERVATION)
    p.add_argument("--storage-fn", default=FN_STORAGE)
    p.add_argument("--plants-fn", default=FN_PLANTS)
    p.add_argument("--site", default=DEFAULT_SITE, help="--f-deployed: the site whose bundle and sw.js are read")
    p.add_argument("--prev-cache-version", help="--f-deployed: sw.js CACHE_VERSION before the promote")
    p.add_argument("--only", default="bundle,lambdas,sw", help="--f-deployed: any of bundle,lambdas,sw")
    p.add_argument("--f-version", help="--floor: the version F is minted as (vX.Y.Z)")
    p.add_argument("--pre-f-version", default=PRE_F_VERSION, help="--floor: the prod version before F (default %(default)s)")
    p.add_argument("--since", help=argparse.SUPPRESS)  # the old --floor question (the 1b version); refused below
    p.add_argument("--floors-file", help="--floor: default scripts/revert-floors.json of this tree")
    return p


def main(argv=None, sources=None):
    p = build_parser()
    a = p.parse_args(argv)
    if a.self_test:
        return self_test()
    try:
        if a.precondition:
            if not a.promoted_after:
                p.error("--precondition needs --promoted-after")
            parse_time(a.promoted_after, "--promoted-after")
            results = check_precondition(sources or LiveSources(a.region), promoted_after=a.promoted_after,
                                         repo=a.repo, main_ref=a.main_ref, main_contains=a.main_contains,
                                         preservation_fn=a.preservation_fn, storage_fn=a.storage_fn)
        elif a.f_deployed:
            only = tuple(x.strip() for x in a.only.split(",") if x.strip())
            if not only or set(only) - {"bundle", "lambdas", "sw"}:
                p.error("--only takes any of: bundle, lambdas, sw")
            if "sw" in only and not a.prev_cache_version:
                p.error("--f-deployed checks sw.js: give --prev-cache-version (or --only bundle,lambdas)")
            results = check_f_deployed(sources or LiveSources(a.region), site=a.site,
                                       prev_cache_version=a.prev_cache_version, only=only,
                                       preservation_fn=a.preservation_fn, plants_fn=a.plants_fn,
                                       storage_fn=a.storage_fn)
        else:
            if a.since is not None:
                # Not kept as an alias: --since named the 1b version, and a v<1b> floor would answer the new
                # question with a false PASS whenever the optional 1b entry is present.
                p.error("--since is gone: --floor now asks about the F version (--f-version vX.Y.Z); "
                        "see review-F-prepromote-final B2")
            if not a.f_version or not RELEASE_RE.match(a.f_version):
                p.error("--floor needs --f-version vX.Y.Z (the version F is minted as)")
            if not RELEASE_RE.match(a.pre_f_version):
                p.error("--pre-f-version must be vX.Y.Z")
            if revert_floors.version_key(a.pre_f_version) >= revert_floors.version_key(a.f_version):
                p.error("--pre-f-version must be below --f-version")
            results = check_floor(f_version=a.f_version, pre_f_version=a.pre_f_version, floors_file=a.floors_file)
    except ValueError as e:
        p.error(str(e))
    for r in results:
        print(r.line())
    bad = [r for r in results if not r.ok]
    print(f"{'FAIL' if bad else 'PASS'}: {len(results) - len(bad)}/{len(results)} checks passed")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
