#!/usr/bin/env python3
"""Tests for the revert floor (OPS-REVERTRESTORE-001 A1): scripts/revert-floors.json's shape, the
revert_floors.py rules, and revert-to.py's require_target_above_floor() — run()'s first refusal."""
import base64
import importlib.util
import json
import os
import re
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import revert_floors as rf  # noqa: E402


def _load_revert_to():
    spec = importlib.util.spec_from_file_location("revert_to_for_floors", os.path.join(HERE, "revert-to.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


rt = _load_revert_to()


def entry(floor="v2.0.0", since="v2.0.0", undo=None, **over):
    e = {"floor": floor, "since": since, "reason": "one-way step", "ledger": "OPS-TEST-001", "undo_instead": undo}
    e.update(over)
    return e


def floors_text(*entries):
    return json.dumps({"floors": list(entries)})


# --- the real file ----------------------------------------------------------------------------

def test_the_real_file_parses_and_carries_the_seeded_floors():
    entries = rf.load()
    by_floor = {e["floor"]: e for e in entries}
    assert by_floor["v4.156.0"]["since"] == "v4.156.0"
    assert by_floor["v4.156.0"]["undo_instead"] == {"flag": "SCROLL_MANAGER_ENABLED", "file": "src/lib/featureFlags.js"}
    assert by_floor["v4.156.0"]["ledger"] == "BUG-DETAILPAGESCARRYSCROLL-001"
    # v4.134.0's own deploy-lambda.yml re-creates the retired nightly rule, so the floor is v4.135.0.
    assert by_floor["v4.135.0"]["since"] == "v4.135.0"
    assert by_floor["v4.135.0"]["undo_instead"] is None
    # V5-LOSSTOKEN-001: older code cannot read the renamed reduction tokens, and there is no switch.
    assert by_floor["v4.160.0"]["since"] == "v4.160.0"
    assert by_floor["v4.160.0"]["ledger"] == "V5-LOSSTOKEN-001"
    assert by_floor["v4.160.0"]["undo_instead"] is None


def test_every_flag_a_floor_names_is_one_live_switch_in_this_tree():
    """forward-undo.py flips `export const <FLAG> = true` to false in a forward build. A renamed flag
    or moved file would leave it nothing to flip, so the data and the code are pinned together."""
    flagged = [e for e in rf.load() if e["undo_instead"]]
    assert flagged, "no floor names a switch any more; the forward-undo flag path would be untested data"
    for e in flagged:
        path = os.path.join(REPO, e["undo_instead"]["file"])
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        pat = re.compile(rf"^export const {e['undo_instead']['flag']}\s*=\s*(true|false)\b", re.M)
        assert len(pat.findall(text)) == 1, f"{e['undo_instead']} must be declared exactly once"


def test_this_trees_version_is_governed_by_the_scroll_floor():
    with open(os.path.join(REPO, "package.json"), encoding="utf-8") as fh:
        version = "v" + json.load(fh)["version"]
    gov = rf.governing_entry(rf.load(), version)
    assert gov is not None and rf.version_key(gov["floor"]) >= (4, 156, 0)


def test_revert_to_reads_this_trees_file():
    assert rt.REVERT_FLOORS == os.path.join(HERE, "revert-floors.json") == rf.FLOORS


# --- revert_floors.py rules --------------------------------------------------------------------

@pytest.mark.parametrize("v,key", [("v4.156.0", (4, 156, 0)), ("4.156.0", (4, 156, 0)),
                                   ("v4.156", (4, 156, 0)), ("v4", (4, 0, 0)), ("v10.2.33", (10, 2, 33))])
def test_version_key(v, key):
    assert rf.version_key(v) == key


@pytest.mark.parametrize("v", ["", "x", "v1.2.3.4", "v1..2", "V1.2.3", "1.2.3-rc1", None, 4])
def test_version_key_rejects(v):
    with pytest.raises(rf.FloorError):
        rf.version_key(v)


BAD = {
    "not json": "{",
    "a list at the top": json.dumps([entry()]),
    "an extra top-level key": json.dumps({"floors": [entry()], "note": "x"}),
    "no floors key": json.dumps({"floor": [entry()]}),
    "an empty list": floors_text(),
    "floors not a list": json.dumps({"floors": entry()}),
    "an entry not an object": floors_text("v2.0.0"),
    "a missing key": floors_text({k: v for k, v in entry().items() if k != "since"}),
    "an extra key": floors_text(entry(note="x")),
    "a misspelt key": floors_text({**{k: v for k, v in entry().items() if k != "since"}, "sinse": "v2.0.0"}),
    "a two-part floor": floors_text(entry(floor="v2.0")),
    "an unprefixed since": floors_text(entry(since="2.0.0")),
    "floor above since": floors_text(entry(floor="v2.1.0", since="v2.0.0")),
    "an empty reason": floors_text(entry(reason="  ")),
    "a two-line reason": floors_text(entry(reason="a\nb")),
    "a bad ledger id": floors_text(entry(ledger="see the ledger")),
    "undo_instead a string": floors_text(entry(undo="flip the flag")),
    "undo_instead missing file": floors_text(entry(undo={"flag": "X_ENABLED"})),
    "undo_instead extra key": floors_text(entry(undo={"flag": "X_ENABLED", "file": "a.js", "to": "false"})),
    "a lower-case flag": floors_text(entry(undo={"flag": "xEnabled", "file": "a.js"})),
    "an absolute file": floors_text(entry(undo={"flag": "X_ENABLED", "file": "/etc/passwd"})),
    "a parent-relative file": floors_text(entry(undo={"flag": "X_ENABLED", "file": "src/../../x.js"})),
    "a backslash file": floors_text(entry(undo={"flag": "X_ENABLED", "file": "src\\x.js"})),
}


@pytest.mark.parametrize("name", sorted(BAD))
def test_parse_refuses_malformed(name):
    with pytest.raises(rf.FloorError):
        rf.parse(BAD[name])


def test_parse_accepts_both_undo_shapes():
    out = rf.parse(floors_text(entry(), entry("v3.0.0", "v3.1.0", {"flag": "X_ENABLED", "file": "src/lib/x.js"})))
    assert [e["floor"] for e in out] == ["v2.0.0", "v3.0.0"]


def test_load_missing_or_undecodable_file_refuses(tmp_path):
    with pytest.raises(rf.FloorError):
        rf.load(str(tmp_path / "absent.json"))
    bad = tmp_path / "bad.json"
    bad.write_bytes(b"\xff\xfe\x00")
    with pytest.raises(rf.FloorError):
        rf.load(str(bad))


def test_in_force_is_since_at_or_below_prod():
    es = [entry("v2.0.0", "v2.0.0"), entry("v3.0.0", "v3.1.0")]
    assert rf.in_force(es, "v1.9.9") == []
    assert rf.in_force(es, "v2.0.0") == es[:1]           # since == prod: in force
    assert rf.in_force(es, "v3.0.9") == es[:1]           # floor reached, since not yet
    assert rf.in_force(es, "v3.1.0") == es


def test_governing_entry_is_the_highest_floor_in_force():
    es = [entry("v3.0.0", "v3.1.0"), entry("v2.0.0", "v2.0.0"), entry("v3.0.0", "v3.2.0", ledger="OPS-TIE-001")]
    assert rf.governing_entry(es, "v1.0.0") is None
    assert rf.governing_entry(es, "v2.5.0")["floor"] == "v2.0.0"
    assert rf.governing_entry(es, "v3.1.0") is es[0]
    assert rf.governing_entry(es, "v9.0.0") is es[0]     # a tie keeps the first in file order


def test_entries_shipped_is_the_half_open_range_after_upto():
    es = [entry("v2.0.0", "v2.0.0"), entry("v1.0.0", "v2.0.0", ledger="OPS-OTHER-001"),
          entry("v2.1.0", "v2.1.0"), entry("v3.0.0", "v3.0.0")]
    assert rf.entries_shipped(es, "v1.9.0", "v2.0.0") == es[:2]
    assert rf.entries_shipped(es, "v2.0.0", "v2.0.0") == []          # prev itself is excluded
    assert rf.entries_shipped(es, "v1.9.0", "v2.2.0") == es[:3]      # an untagged version in between counts
    assert rf.entries_shipped(es, "v2.0.0", "3.0.0") == es[2:]
    assert rf.entries_shipped(es, "v3.0.0", "v3.0.1") == []


# --- revert-to.py: require_target_above_floor() -------------------------------------------------

class FakeResp:
    def __init__(self, status, payload=None):
        self.status_code = status
        self._payload = payload if payload is not None else {}
        self.text = json.dumps(self._payload)

    def json(self):
        return self._payload


class FakeRequests:
    """GET-only double: routes are (substring, FakeResp); an unrouted call fails the test."""
    def __init__(self, routes):
        self.routes = list(routes)
        self.calls = []

    def get(self, url, **k):
        self.calls.append(url)
        for sub, resp in self.routes:
            if sub in url:
                return resp
        raise AssertionError(f"unexpected GitHub read {url}")

    def post(self, url, **k):
        raise AssertionError(f"unexpected write POST {url}")

    patch = delete = post


MAIN = "d" * 40


def prod_routes(version="4.156.0", main_status=200, content=None, encoding="base64"):
    body = content if content is not None else json.dumps({"version": version})
    return [
        ("/git/ref/heads/main", FakeResp(main_status, {"object": {"sha": MAIN}})),
        (f"/contents/package.json?ref={MAIN}", FakeResp(200, {
            "encoding": encoding, "content": base64.b64encode(body.encode()).decode()})),
    ]


def cfg_for(target, **over):
    env = {"GH_TOKEN": "t", "GITHUB_REPOSITORY": "islanddave/garden-app", "TARGET_VERSION": target,
           "PREREVERT_VERSION": "v9.9.9", "NEON_API_KEY": "k", "NEON_PROJECT_ID": "p",
           "NEON_BACKUP_URL": "postgresql://x", "CONFIRM_DATA_LOSS": "yes"}
    env.update(over)
    return rt.Config(env=env)


class UntouchableS3:
    def __getattr__(self, name):
        raise AssertionError(f"S3 touched ({name}) before the floor refused")


def _forbid(monkeypatch, *names):
    for n in names:
        def boom(*a, _n=n, **k):
            raise AssertionError(f"{_n} ran before the floor refused")
        monkeypatch.setattr(rt, n, boom)


def test_run_refuses_a_target_below_the_real_floor_before_anything_else(monkeypatch):
    """Today's shape: prod runs v4.156.0 and the previous release is v4.153.0. The refusal comes
    first — no manifest, no tag, no RPO probe, no target workflows, no snapshot — and reads the
    floor from this tree: the only GitHub reads are main's head and its package.json."""
    fr = FakeRequests(prod_routes("4.156.0"))
    monkeypatch.setattr(rt, "requests", fr)
    _forbid(monkeypatch, "load_manifest", "verify_tag", "compute_rpo", "prerevert_snap",
            "require_revertible_target", "require_no_deploy_in_flight", "require_dispatchable")
    with pytest.raises(rt.RevertError) as e:
        rt.run(cfg_for("v4.153.0"), s3=UntouchableS3())
    msg = str(e.value)
    assert "below the revert floor v4.156.0" in msg and "prod runs v4.156.0" in msg
    assert "forward-undo.py" in msg and "switch SCROLL_MANAGER_ENABLED off in src/lib/featureFlags.js" in msg
    assert "BUG-DETAILPAGESCARRYSCROLL-001" in msg
    assert len(fr.calls) == 2
    assert fr.calls[0].endswith("/git/ref/heads/main")
    assert fr.calls[1].endswith(f"/contents/package.json?ref={MAIN}")


def test_a_target_at_the_floor_is_allowed(monkeypatch, capsys):
    monkeypatch.setattr(rt, "requests", FakeRequests(prod_routes("4.157.0")))
    assert rt.require_target_above_floor(cfg_for("v4.156.0")) is None
    assert "at or above v4.156.0" in capsys.readouterr().out


def test_a_target_above_the_floor_is_allowed(monkeypatch):
    # Prod was 4.160.0 here until that version became a real floor (V5-LOSSTOKEN-001); 4.159.0 keeps
    # the case it tests — a target above the governing (v4.156.0) floor passes.
    monkeypatch.setattr(rt, "requests", FakeRequests(prod_routes("4.159.0")))
    assert rt.require_target_above_floor(cfg_for("v4.158")) is None


def test_the_token_rename_floor_refuses_older_code_once_it_ships(monkeypatch):
    monkeypatch.setattr(rt, "requests", FakeRequests(prod_routes("4.160.0")))
    with pytest.raises(rt.RevertError) as e:
        rt.require_target_above_floor(cfg_for("v4.159.0"))
    assert "below the revert floor v4.160.0" in str(e.value)


def test_the_floor_in_force_follows_the_version_prod_runs(monkeypatch):
    """Before v4.156.0 shipped only the v4.135.0 floor was in force: v4.150.0 passes, v4.134.0 is
    refused, and its entry has no switch to name."""
    monkeypatch.setattr(rt, "requests", FakeRequests(prod_routes("4.155.0")))
    assert rt.require_target_above_floor(cfg_for("v4.150.0")) is None
    with pytest.raises(rt.RevertError) as e:
        rt.require_target_above_floor(cfg_for("v4.134.0"))
    assert "below the revert floor v4.135.0" in str(e.value) and "no switch exists" in str(e.value)


def test_no_floor_in_force_before_any_since(monkeypatch, capsys):
    monkeypatch.setattr(rt, "requests", FakeRequests(prod_routes("4.100.0")))
    assert rt.require_target_above_floor(cfg_for("v2.5.0")) is None
    assert "none in force" in capsys.readouterr().out


@pytest.mark.parametrize("text", ["{", json.dumps({"floors": []}), floors_text(entry(since="later"))])
def test_a_malformed_floor_file_refuses_before_any_read(monkeypatch, tmp_path, text):
    p = tmp_path / "revert-floors.json"
    p.write_text(text)
    fr = FakeRequests([])
    monkeypatch.setattr(rt, "requests", fr)
    with pytest.raises(rt.RevertError, match="revert floor unreadable"):
        rt.require_target_above_floor(cfg_for("v4.156.0"), floors_path=str(p))
    assert fr.calls == []


def test_a_missing_floor_file_refuses_through_run(monkeypatch, tmp_path):
    monkeypatch.setattr(rt, "REVERT_FLOORS", str(tmp_path / "absent.json"))
    monkeypatch.setattr(rt, "requests", FakeRequests(prod_routes("4.156.0")))
    with pytest.raises(rt.RevertError, match="revert floor unreadable"):
        rt.run(cfg_for("v4.156.0"), s3=UntouchableS3())


@pytest.mark.parametrize("routes", [
    prod_routes(main_status=404),
    [prod_routes()[0], ("/contents/package.json", FakeResp(404, {"message": "Not Found"}))],
    prod_routes(encoding="none"),
    prod_routes(content="{not json"),
    prod_routes(content=json.dumps({"name": "garden-app"})),
    prod_routes(version="4.156"),
    prod_routes(version="v4.156.0"),
])
def test_an_unreadable_prod_version_refuses(monkeypatch, routes):
    monkeypatch.setattr(rt, "requests", FakeRequests(routes))
    with pytest.raises(rt.RevertError):
        rt.require_target_above_floor(cfg_for("v4.156.0"))


def test_rehearsal_skips_the_floor_without_reading_anything(monkeypatch, tmp_path):
    fr = FakeRequests([])
    monkeypatch.setattr(rt, "requests", fr)
    monkeypatch.setattr(rt, "REVERT_FLOORS", str(tmp_path / "absent.json"))
    cfg = cfg_for("v0.0.0", REHEARSAL_MODE="1", DEV_BRANCH="revert-rehearsal-dev-1",
                  MAIN_BRANCH="revert-rehearsal-main-1", NEON_PROD_BRANCH_ID="br-polished-art-am12o4ue")
    assert rt.require_target_above_floor(cfg) is None
    assert fr.calls == []


def test_a_custom_floor_governs_by_its_own_numbers(monkeypatch, tmp_path):
    p = tmp_path / "revert-floors.json"
    p.write_text(floors_text(entry("v3.0.0", "v3.1.0", {"flag": "X_ENABLED", "file": "src/lib/x.js"})))
    monkeypatch.setattr(rt, "requests", FakeRequests(prod_routes("3.1.0")))
    with pytest.raises(rt.RevertError, match=r"below the revert floor v3\.0\.0.*switch X_ENABLED off"):
        rt.require_target_above_floor(cfg_for("v2.9.9"), floors_path=str(p))
    assert rt.require_target_above_floor(cfg_for("v3.0.0"), floors_path=str(p)) is None
