"""Tests for audit-gate.py, focused on the Lambda scope extension (OPS-AUDITLAMBDA-001).

Run: pytest -q test_audit_gate.py

The classification loop is the easy part. What these guard is the two ways this gate went green
while verifying nothing: (1) root package.json declares no `workspaces`, so lambda/*/package.json
was never audited at all — GHSA-f88m-g3jw-g9cj (sharp/libvips, high) sat open in
lambda/photocdn-derivative behind a permanently green gate; (2) `npm audit --json` against an
unreachable registry returns {"message": ...} with no "vulnerabilities" key, which the old gate
read as "zero advisories" and reported PASS at exit 0 (cf. OPS-DRIFTFAILLOUD-001). Every
assertion below is written so that relaxing the corresponding guard turns it red.

No network and no npm: the npm boundary is injected (`_audit`) or fed as canned JSON.
"""
import importlib.util
import json
from pathlib import Path

import pytest

# House idiom for importing a hyphenated script (cf. test_check_staging_drift.py).
_spec = importlib.util.spec_from_file_location(
    'audit_gate', Path(__file__).resolve().parent / 'audit-gate.py')
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)

REPO = Path(__file__).resolve().parent.parent

# The real npm audit report shape, trimmed to the fields the gate reads.
SHARP_REPORT = {
    "vulnerabilities": {
        "sharp": {"name": "sharp", "severity": "high", "via": [
            {"source": 1109999, "name": "sharp", "severity": "high",
             "title": "sharp inherited vulnerabilities in libvips",
             "url": "https://github.com/advisories/GHSA-f88m-g3jw-g9cj", "range": "<0.35.0"}]}},
    "metadata": {"vulnerabilities": {"high": 1, "total": 1}},
}
CLEAN_REPORT = {"vulnerabilities": {}, "metadata": {"vulnerabilities": {"total": 0}}}
# What npm actually printed when pointed at a dead registry (captured 2026-08-06).
REGISTRY_DOWN = ('{"message":"request to https://registry.npmjs.org/-/npm/v1/security/advisories'
                 '/bulk failed, reason: connect ECONNREFUSED","error":{"summary":"","detail":""}}')
NO_LOCKFILE = ('{"error":{"code":"ENOLOCK","summary":"This command requires an existing lockfile.",'
               '"detail":"loadVirtual requires existing shrinkwrap file"}}')


def _mklambda(root, name, deps, lock=True):
    d = root / "lambda" / name
    d.mkdir(parents=True)
    (d / "package.json").write_text(json.dumps({"name": name, "dependencies": deps}))
    if lock:
        (d / "package-lock.json").write_text(json.dumps({"lockfileVersion": 3, "packages": {}}))
    (d / "index.mjs").write_text("export const handler = async () => {};")
    return d


# --- fail-closed on a registry that cannot answer -------------------------------------------

def test_registry_failure_is_unavailable_not_clean():
    """The green-on-error trap: npm's error payload parses as JSON but is NOT an audit report.
    Reading it as 'no vulnerabilities' is how a gate reports PASS having checked nothing."""
    with pytest.raises(mod.AuditUnavailable):
        mod.parse_audit(REGISTRY_DOWN, "root")


def test_missing_lockfile_error_payload_is_unavailable():
    """ENOLOCK likewise carries no findings — it means the audit never ran."""
    with pytest.raises(mod.AuditUnavailable):
        mod.parse_audit(NO_LOCKFILE, "lambda/photocdn-derivative")


def test_unparseable_output_is_unavailable():
    with pytest.raises(mod.AuditUnavailable):
        mod.parse_audit("npm error ECONNREFUSED\n", "root")


def test_clean_report_is_accepted():
    """A genuine zero-finding audit must still pass — the shape check must not block real PASSes."""
    assert mod.parse_audit(json.dumps(CLEAN_REPORT), "root")["metadata"]["vulnerabilities"]["total"] == 0


def test_main_exits_2_when_registry_is_down(monkeypatch, capsys):
    """End-to-end: registry down must exit 2 (COULD NOT VERIFY), never 0. The pre-fix gate
    printed '✅ ... PASS (0 waived, 0 blocking)' and exited 0 on exactly this input."""
    monkeypatch.setattr('sys.stdin', _Stdin(REGISTRY_DOWN))
    rc = mod.main(["--stdin", "--root-only"])
    out = capsys.readouterr().out
    assert rc == 2
    assert "UNAUDITED" in out
    assert "✅" not in out


class _Stdin:
    def __init__(self, s):
        self._s = s

    def read(self):
        return self._s


# --- classification, with lambda scoping ----------------------------------------------------

def test_lambda_advisory_blocks_and_is_scope_labelled():
    """The advisory the gate was blind to. The label must name the lambda, or a Lambda finding
    is indistinguishable from a frontend one in the CI log."""
    waived, blocking, unident = mod.scan(SHARP_REPORT, {}, "lambda/photocdn-derivative")
    assert blocking == [("lambda/photocdn-derivative:sharp", "high", "GHSA-f88m-g3jw-g9cj")]
    assert waived == [] and unident == []


def test_allowlisted_lambda_advisory_is_waived_not_blocking():
    waived, blocking, _ = mod.scan(SHARP_REPORT, {"GHSA-f88m-g3jw-g9cj": "test"},
                                   "lambda/photocdn-derivative")
    assert blocking == [] and len(waived) == 1


def test_low_severity_does_not_block():
    rep = {"metadata": {}, "vulnerabilities": {"x": {"via": [
        {"severity": "low", "url": "https://github.com/advisories/GHSA-aaaa-bbbb-cccc"}]}}}
    assert mod.scan(rep, {}, "lambda/x") == ([], [], [])


def test_advisory_with_no_identifier_blocks_as_unidentified():
    """An advisory with nothing to key a waiver on must still fail the build."""
    rep = {"metadata": {}, "vulnerabilities": {"x": {"via": [
        {"severity": "critical", "title": "mystery"}]}}}
    _, blocking, unident = mod.scan(rep, {}, "lambda/x")
    assert blocking == [] and len(unident) == 1


# --- target discovery: a missing lockfile must never be a silent skip -----------------------

def test_lockfile_less_lambda_is_targeted_in_manifest_mode(tmp_path):
    """The whole point: no lockfile means resolve-from-manifest, NOT skip."""
    _mklambda(tmp_path, "photocdn-derivative", {"sharp": "^0.34.0"}, lock=False)
    targets, orphans = mod.lambda_targets(tmp_path)
    assert targets[0][0] == "photocdn-derivative" and targets[0][2] == "manifest"
    assert orphans == []


def test_lockfile_lambda_is_targeted_in_lockfile_mode(tmp_path):
    _mklambda(tmp_path, "critter", {"ws": "^8.18.0"}, lock=True)
    targets, _ = mod.lambda_targets(tmp_path)
    assert targets[0][2] == "lockfile"


def test_lambda_dir_without_manifest_is_reported_not_ignored(tmp_path):
    """A code directory with no package.json has nothing to audit — but the gate says so out
    loud rather than letting it vanish from the coverage story."""
    d = tmp_path / "lambda" / "nodeps"
    d.mkdir(parents=True)
    (d / "index.mjs").write_text("export const handler = async () => {};")
    targets, orphans = mod.lambda_targets(tmp_path)
    assert targets == [] and orphans == ["nodeps"]
    _, _, _, notes, _ = mod.audit_lambdas({}, tmp_path, _audit=lambda *a: CLEAN_REPORT)
    assert any("nodeps" in n and "no package.json" in n for n in notes)


def test_identical_dep_sets_are_audited_once(tmp_path):
    """26 lambdas share 8 dependency sets; auditing byte-identical inputs 26 times is pure cost."""
    for n in ("achievements", "app-events", "tags"):
        _mklambda(tmp_path, n, {"ws": "^8.18.0"}, lock=False)
    _mklambda(tmp_path, "other", {"blurhash": "^2.0.5"}, lock=False)
    calls = []

    def fake(path, mode, scope):
        calls.append(scope)
        return CLEAN_REPORT

    mod.audit_lambdas({}, tmp_path, _audit=fake)
    assert len(calls) == 2


def test_lockfile_and_manifest_modes_are_not_deduped_together(tmp_path):
    """Same declared deps but one has a lockfile: different audited surface, separate runs."""
    _mklambda(tmp_path, "a", {"ws": "^8.18.0"}, lock=True)
    _mklambda(tmp_path, "b", {"ws": "^8.18.0"}, lock=False)
    calls = []
    mod.audit_lambdas({}, tmp_path, _audit=lambda p, m, s: calls.append(s) or CLEAN_REPORT)
    assert len(calls) == 2


# --- an unauditable target must fail the gate, never pass it --------------------------------

def test_unauditable_lambda_makes_main_exit_2(tmp_path, monkeypatch, capsys):
    """A lambda whose audit could not run is UNAUDITED. Reporting PASS over it recreates the
    exact blind spot this change closes, so it outranks even a clean result elsewhere."""
    _mklambda(tmp_path, "photocdn-derivative", {"sharp": "^0.34.0"}, lock=False)

    def boom(path, mode, scope):
        raise mod.AuditUnavailable("%s: registry unreachable" % scope)

    monkeypatch.setattr(mod, 'ROOT', tmp_path)
    monkeypatch.setattr(mod, 'audit_target', boom)
    monkeypatch.setattr(mod, 'load_allow', lambda *a, **k: {})
    rc = mod.main(["--lambdas-only"])
    out = capsys.readouterr().out
    assert rc == 2
    assert "photocdn-derivative" in out and "UNAUDITED" in out
    assert "✅" not in out


def test_unaudited_outranks_a_clean_pass(tmp_path, monkeypatch, capsys):
    """One good target must not launder a broken one into a green build."""
    _mklambda(tmp_path, "ok", {"ws": "^8.18.0"}, lock=True)
    _mklambda(tmp_path, "broken", {"blurhash": "^2.0.5"}, lock=True)

    def half(path, mode, scope):
        if "broken" in scope:
            raise mod.AuditUnavailable("%s: registry unreachable" % scope)
        return CLEAN_REPORT

    monkeypatch.setattr(mod, 'ROOT', tmp_path)
    monkeypatch.setattr(mod, 'audit_target', half)
    monkeypatch.setattr(mod, 'load_allow', lambda *a, **k: {})
    assert mod.main(["--lambdas-only"]) == 2
    assert "✅" not in capsys.readouterr().out


def test_blocking_lambda_advisory_makes_main_exit_1_with_actionable_message(
        tmp_path, monkeypatch, capsys):
    """The failure text must tell the reader that a caret on a 0.x pin cannot self-heal —
    otherwise the obvious 'just rerun the deploy' response silently does nothing."""
    _mklambda(tmp_path, "photocdn-derivative", {"sharp": "^0.34.0"}, lock=False)
    monkeypatch.setattr(mod, 'ROOT', tmp_path)
    monkeypatch.setattr(mod, 'audit_target', lambda p, m, s: SHARP_REPORT)
    monkeypatch.setattr(mod, 'load_allow', lambda *a, **k: {})
    rc = mod.main(["--lambdas-only"])
    out = capsys.readouterr().out
    assert rc == 1
    assert "lambda/photocdn-derivative:sharp" in out
    assert "GHSA-f88m-g3jw-g9cj" in out
    assert "package.json" in out and "pins the minor" in out


def test_clean_lambdas_pass(tmp_path, monkeypatch, capsys):
    _mklambda(tmp_path, "critter", {"ws": "^8.18.0"}, lock=True)
    monkeypatch.setattr(mod, 'ROOT', tmp_path)
    monkeypatch.setattr(mod, 'audit_target', lambda p, m, s: CLEAN_REPORT)
    monkeypatch.setattr(mod, 'load_allow', lambda *a, **k: {})
    assert mod.main(["--lambdas-only"]) == 0
    assert "PASS (0 waived, 0 blocking)" in capsys.readouterr().out


# --- guards on the real repo ----------------------------------------------------------------

def test_real_repo_photocdn_derivative_is_in_scope():
    """Regression guard for the blind spot itself: if this lambda ever drops out of the target
    list again, the sharp/libvips class of advisory goes unseen once more."""
    names = {t[0] for t in mod.lambda_targets(REPO)[0]}
    assert "photocdn-derivative" in names
    assert len(names) >= 20, "expected every lambda/*/package.json to be a target"


def test_real_repo_root_still_declares_no_workspaces():
    """If workspaces are ever added, root `npm audit` would cover lambda/* and the per-lambda
    pass would double-report — this test is the tripwire that says re-read the design."""
    assert "workspaces" not in json.loads((REPO / "package.json").read_text())


def test_sharp_advisory_is_not_waived_in_the_real_allowlist():
    """GHSA-f88m-g3jw-g9cj needs an upgrade (0.35.x, a manifest edit + arm64 repackaging), not a
    waiver. Silencing it here would restore the green-gate-over-a-live-CVE state exactly."""
    assert "GHSA-f88m-g3jw-g9cj" not in mod.load_allow()
