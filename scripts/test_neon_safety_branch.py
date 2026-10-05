#!/usr/bin/env python3
"""Unit tests for neon_safety_branch.py. No network: api() is replaced by a fake
Neon that records every call."""
import datetime as dt
import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import neon_branch_select as nbs
import neon_safety_branch as nsb

NOW = dt.datetime(2026, 10, 5, 19, 0, tzinfo=dt.timezone.utc)
PROD = nbs.DEFAULT_PROD_BRANCH
ENV = {"NEON_API_KEY": "k", "NEON_PROJECT_ID": "p"}


def B(name, bid=None, parent=PROD, created="2026-10-03T23:47:00Z", **extra):
    b = {"name": name, "id": bid or f"br-{name}", "parent_id": parent, "created_at": created}
    b.update(extra)
    return b


class FakeNeon:
    def __init__(self, branches, create=(201, None), patch=(200, None)):
        self.branches, self.create, self.patch, self.calls = list(branches), create, patch, []

    def __call__(self, env, method, path, body=None, timeout=60):
        self.calls.append((method, path, body))
        if method == "GET":
            return 200, {"branches": self.branches}
        if method == "POST":
            status, resp = self.create
            if resp is None:
                resp = {"branch": dict(body["branch"], id="br-new")}
            return status, resp
        if method == "PATCH":
            status, resp = self.patch
            if resp is None:
                resp = {"branch": {"expires_at": body["branch"]["expires_at"]}}
            return status, resp
        raise AssertionError(f"unexpected {method}")

    def writes(self):
        return [c for c in self.calls if c[0] != "GET"]


@pytest.fixture
def neon(monkeypatch):
    monkeypatch.setattr(nsb, "_utcnow", lambda: NOW)

    def install(branches=(), **kw):
        fake = FakeNeon([B("production", bid=PROD, parent=None, default=True),
                         B("staging")] + list(branches), **kw)
        monkeypatch.setattr(nsb, "api", fake)
        return fake
    return install


# --- create ------------------------------------------------------------------

def test_create_stamps_expiry_at_creation(neon, capsys):
    fake = neon()
    assert nsb.main(["create", "--slug", "r2a"], env=ENV) == 0
    (method, path, body), = fake.writes()
    assert (method, path) == ("POST", "branches")
    assert body == {"branch": {"parent_id": PROD, "name": "sitting-r2a-prod-preapply-20261005",
                               "expires_at": "2026-10-12T19:00:00Z"}}
    assert "endpoints" not in body
    assert "expires 2026-10-12T19:00:00Z" in capsys.readouterr().out


def test_create_days_and_prod_branch_override(neon):
    fake = neon()
    env = dict(ENV, NEON_PROD_BRANCH_ID="br-other")
    assert nsb.main(["create", "--slug", "x", "--days", "3"], env=env) == 0
    body = fake.writes()[0][2]["branch"]
    assert body["parent_id"] == "br-other" and body["expires_at"] == "2026-10-08T19:00:00Z"


@pytest.mark.parametrize("days", ["0", "-1", "15"])
def test_create_refuses_days_out_of_range(neon, days, capsys):
    fake = neon()
    assert nsb.main(["create", "--slug", "x", "--days", days], env=ENV) == 1
    assert fake.calls == [] and f"1..{nsb.MAX_DAYS}" in capsys.readouterr().err


def test_max_days_matches_what_the_weekly_check_accepts():
    # A copy made at the tool's longest expiry must read as self-cleaning there.
    b = B("x", created="2026-10-05T19:00:00Z",
          expires_at=nsb._ts(NOW + dt.timedelta(days=nsb.MAX_DAYS)))
    assert nbs.self_cleaning(b, NOW, max_ttl_days=14)


@pytest.mark.parametrize("slug", ["", "Has-Caps", "-lead", "sp ace", "a" * 41, "semi;colon"])
def test_create_refuses_bad_slug(neon, slug):
    fake = neon()
    assert nsb.main(["create", f"--slug={slug}"], env=ENV) == 1
    assert fake.calls == []


def test_create_is_idempotent_when_the_copy_has_an_expiry(neon, capsys):
    fake = neon([B("sitting-r2a-prod-preapply-20261005", expires_at="2026-10-12T00:00:00Z")])
    assert nsb.main(["create", "--slug", "r2a"], env=ENV) == 0
    assert fake.writes() == [] and "exists:" in capsys.readouterr().out


def test_create_refuses_an_existing_copy_with_no_expiry(neon, capsys):
    fake = neon([B("sitting-r2a-prod-preapply-20261005")])
    assert nsb.main(["create", "--slug", "r2a"], env=ENV) == 1
    assert fake.writes() == [] and "NO expiry" in capsys.readouterr().err


def test_create_never_retries_without_an_expiry(neon, capsys):
    fake = neon(create=(422, "expires_at is not supported"))
    assert nsb.main(["create", "--slug", "r2a"], env=ENV) == 1
    assert len(fake.writes()) == 1
    assert "nothing was created" in capsys.readouterr().err


def test_create_fails_when_neon_returns_a_copy_without_expiry(neon, capsys):
    fake = neon(create=(201, {"branch": {"id": "br-new", "name": "n"}}))
    assert nsb.main(["create", "--slug", "r2a"], env=ENV) == 1
    assert "carries NO expiry" in capsys.readouterr().err


def test_list_failure_is_a_refusal_not_a_traceback(neon, monkeypatch, capsys):
    neon()
    monkeypatch.setattr(nsb, "api", lambda *a, **k: (401, "unauthorized"))
    assert nsb.main(["create", "--slug", "r2a"], env=ENV) == 1
    assert "could not list branches (401)" in capsys.readouterr().err


# --- expire ------------------------------------------------------------------

def test_expire_counts_from_creation(neon, capsys):
    fake = neon([B("sitting-r2a", created="2026-10-03T23:47:00Z")])
    assert nsb.main(["expire", "--branch", "sitting-r2a"], env=ENV) == 0
    (method, path, body), = fake.writes()
    assert (method, path) == ("PATCH", "branches/br-sitting-r2a")
    assert body == {"branch": {"expires_at": "2026-10-10T23:47:00Z"}}
    assert "2026-10-10T23:47:00Z" in capsys.readouterr().out


def test_expire_by_id_and_from_now(neon):
    fake = neon([B("old", created="2026-08-01T00:00:00Z")])
    assert nsb.main(["expire", "--branch", "br-old", "--from-now", "--days", "2"], env=ENV) == 0
    assert fake.writes()[0][2] == {"branch": {"expires_at": "2026-10-07T19:00:00Z"}}


def test_expire_refuses_a_date_already_past(neon, capsys):
    fake = neon([B("old", created="2026-08-01T00:00:00Z")])
    assert nsb.main(["expire", "--branch", "old"], env=ENV) == 1
    assert fake.writes() == [] and "--from-now" in capsys.readouterr().err


@pytest.mark.parametrize("target", ["production", "staging", PROD, "snap-v4.169.2", "parent", "nope"])
def test_expire_refuses_what_it_must_not_touch(neon, target):
    fake = neon([B("snap-v4.169.2"), B("parent"), B("child", parent="br-parent"),
                 B("locked", protected=True)])
    assert nsb.main(["expire", "--branch", target, "--from-now"], env=ENV) == 1
    assert fake.writes() == []


def test_expire_refuses_a_protected_branch(neon):
    fake = neon([B("locked", protected=True)])
    assert nsb.main(["expire", "--branch", "locked", "--from-now"], env=ENV) == 1
    assert fake.writes() == []


def test_expire_allows_a_rehearsal_snapshot_not_parented_to_prod(neon):
    fake = neon([B("snap-v0.0.0", parent="br-staging")])
    assert nsb.main(["expire", "--branch", "snap-v0.0.0", "--from-now"], env=ENV) == 0
    assert len(fake.writes()) == 1


def test_expire_reports_a_rejected_patch(neon, capsys):
    neon([B("x")], patch=(422, "nope"))
    assert nsb.main(["expire", "--branch", "x", "--from-now"], env=ENV) == 1
    assert "did not set an expiry" in capsys.readouterr().err


# --- list, env, usage --------------------------------------------------------

def test_list_shows_only_temporary_branches(neon, capsys):
    fake = neon([B("snap-v4.169.2"), B("sitting-a", expires_at="2026-10-10T00:00:00Z"),
                 B("sitting-b")])
    assert nsb.main(["list"], env=ENV) == 0
    out = capsys.readouterr().out
    assert "sitting-a" in out and "expires 2026-10-10T00:00:00Z" in out
    assert "sitting-b" in out and "NEVER" in out
    assert "production" not in out and "staging" not in out and "snap-v4.169.2" not in out
    assert fake.writes() == []


def test_env_file_fills_named_keys_only_and_never_prints(neon, tmp_path, capsys):
    fake = neon()
    f = tmp_path / ".env.local"
    f.write_text('# c\nNEON_API_KEY="sekrit-value"\nNEON_PROJECT_ID=proj-9\nGITHUB_PAT=nope\n'
                 "NEON_DATABASE_URL=postgres://x\n")
    loaded = nsb.load_env_file(str(f), {})
    assert loaded == {"NEON_API_KEY": "sekrit-value", "NEON_PROJECT_ID": "proj-9"}
    assert nsb.load_env_file(str(f), {"NEON_PROJECT_ID": "from-env"})["NEON_PROJECT_ID"] == "from-env"
    assert nsb.main(["--env-file", str(f), "list"], env={}) == 0
    io = capsys.readouterr()
    assert "sekrit-value" not in io.out + io.err and fake.calls[0][0] == "GET"


def test_missing_credentials_and_unreadable_env_file(neon, capsys):
    fake = neon()
    assert nsb.main(["list"], env={}) == 1
    assert "NEON_API_KEY" in capsys.readouterr().err
    assert nsb.main(["--env-file", "/nonexistent/x", "list"], env={}) == 1
    assert fake.calls == []


def test_usage(neon):
    neon()
    assert nsb.main([], env=ENV) == 2
    assert nsb.main(["delete", "--branch", "x"], env=ENV) == 2


def test_tool_has_no_delete_path():
    src = open(os.path.join(HERE, "neon_safety_branch.py")).read()
    assert '"DELETE"' not in src and "'DELETE'" not in src
