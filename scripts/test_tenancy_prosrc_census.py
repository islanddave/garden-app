"""Tests for scripts/tenancy-prosrc-census.py (V5-SPACETENANCYKEY-001, multi-space step 2.2).

The catalog read needs a database and is exercised by hand (read-only, the module docstring); these cover the parts
that decide what the committed census says: the analysis hand-off to tests/lib/prosrcCensus.mjs, the rendered file,
and the --check comparison.
"""
import importlib.util
import json
import shutil
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("prosrc_census", ROOT / "scripts" / "tenancy-prosrc-census.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

COMMITTED = json.loads((ROOT / "tests" / "tenancy-prosrc.prod.json").read_text())


def bodies_from_committed():
    """The committed census's bodies, back in the catalog-read shape (functions without an INSERT carry no body)."""
    out = []
    for f in COMMITTED["functions"]:
        if "src" not in f:
            continue
        name, args = f["function"].split("(", 1)
        schema, proname = name.split(".", 1)
        out.append({"schema": schema, "name": proname, "args": args[:-1], "lang": f["lang"], "md5": f["md5"],
                    "src": f["src"], "triggers": f["triggers"]})
    return out


@pytest.mark.skipif(shutil.which("node") is None, reason="node is needed for the analysis")
def test_analysis_of_the_committed_bodies_gives_the_committed_rows():
    census = mod.analyse(bodies_from_committed(), "prod")
    got = {f["function"]: (f.get("inserts"), f.get("dynamic")) for f in census["functions"]}
    want = {f["function"]: (f.get("inserts"), f.get("dynamic")) for f in COMMITTED["functions"] if "src" in f}
    assert got == want


@pytest.mark.skipif(shutil.which("node") is None, reason="node is needed for the analysis")
def test_render_round_trips_and_names_its_generator():
    census = mod.analyse(bodies_from_committed(), "prod")
    text = mod.render(census)
    back = json.loads(text)
    assert back["functions"] == census["functions"]
    assert "scripts/tenancy-prosrc-census.py" in back["_doc"][0]
    assert text.endswith("}\n")


def test_check_reports_a_changed_body_a_new_function_and_a_missing_one():
    want = {"functions": [{"function": "public.a()", "md5": "1" * 32, "triggers": []},
                          {"function": "public.b()", "md5": "2" * 32, "triggers": ["t:x"]}]}
    have = {"functions": [{"function": "public.a()", "md5": "9" * 32, "triggers": []},
                          {"function": "public.c()", "md5": "3" * 32, "triggers": []}]}
    assert mod.diff(want, have) == [
        f"body differs: public.a(): census md5 {'1' * 32}, database {'9' * 32}",
        "only in the committed census: public.b()",
        "only in the database: public.c()",
    ]
    assert mod.diff(want, want) == []


def test_check_reports_a_trigger_change():
    want = {"functions": [{"function": "gv.f()", "md5": "1" * 32, "triggers": ["plants:a"]}]}
    have = {"functions": [{"function": "gv.f()", "md5": "1" * 32, "triggers": ["plants:a", "plots:b"]}]}
    assert mod.diff(want, have) == ["triggers differ: gv.f(): census ['plants:a'], database ['plants:a', 'plots:b']"]


def test_the_url_is_read_from_the_environment_only(monkeypatch):
    monkeypatch.delenv("NEON_STAGING_URL", raising=False)
    with pytest.raises(SystemExit) as e:
        mod.read_functions("staging")
    assert "NEON_STAGING_URL is not set" in str(e.value)
    assert "Never pass a URL on the command line" in str(e.value)
